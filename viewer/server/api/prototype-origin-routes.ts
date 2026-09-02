import { Router } from "express"
import type { AppDeps } from "../create-app"
import { requireProjectReadWithPolicy } from "../auth/authorize"
import { buildHostAllowlist, isAllowedHost } from "../serve/host-allowlist"
import {
  LOOPBACK_HOSTS,
  loopbackBindHostFor,
  pairedLoopbackHost,
  prototypeAnonymouslyReadable,
  resolveOrigins,
  SHELL_ORIGIN_HEADER,
  type PrototypeOriginResponse,
} from "../serve/prototype-origin-resolve"
import { prototypeOriginFor } from "../serve/subdomain"

/**
 * `GET /api/v1/projects/:id/prototype-origin` — which origin the shell
 * should embed this prototype from, right now.
 *
 * Its own module rather than another route on `projects-routes.ts`: this is
 * the one route that can OPEN a socket as a side effect, and the reasoning
 * about which shell origin it is allowed to believe belongs next to the code
 * that acts on it.
 *
 * ## Why the caller sends its shell origin in a header
 *
 * The review page (`app/review/[slug]/page.tsx`) is a Next Server Component.
 * It cannot call the listener registry directly — under the custom server,
 * `app/**` is compiled by Next into its own module graph, so a singleton
 * imported from `server/**` there is a DIFFERENT instance from the one
 * `server/index.ts` holds. That is already why the page reads the project
 * list over an internal HTTP hop to `http://127.0.0.1:<config.port>`, and it
 * is why it will call this route the same way.
 *
 * That hop's `Host` is `127.0.0.1:<config.port>`. It never names the
 * spelling the reviewer typed. Pairing off it would put the prototype on
 * `[::1]` for a reviewer who is on `localhost` — or worse, hand back the
 * shell's OWN origin for a reviewer on `127.0.0.1`, which is the one
 * outcome the loopback host flip exists to prevent (cookies are not
 * isolated by port; see `serve/loopback-listeners.ts`).
 *
 * So the caller states its origin in `SHELL_ORIGIN_HEADER`
 * (`X-Viewer-Shell-Origin`, declared in `serve/prototype-origin-resolve.ts` so
 * the page can import the name without pulling this module's Express and
 * storage imports into the Next bundle graph), and this route refuses any
 * value outside a closed set built from config — the same discipline
 * `serve/host-allowlist.ts` applies to `Host`. Whatever reaches the registry
 * is then one of at most four fixed strings, none of which a request can
 * invent.
 *
 * ## The header can never change the MODE
 *
 * The mode comes from `resolveOrigins`, which carries the task 4b rule: a
 * deployed instance reached on its own loopback address is still the
 * deployed shell, and must not flip into loopback mode. The header is
 * consulted ONLY inside the loopback branch, and only to choose among the
 * three loopback spellings. In subdomain and fallback mode the shell origin
 * plays no part in the response at all, so an accepted header there has
 * nothing to change.
 */

/** Refusals are constants. Neither ever echoes what was rejected. */
const UNEXPECTED_SHELL_ORIGIN = { error: "Unexpected shell origin" }
const ORIGIN_UNAVAILABLE = { error: "Prototype origin unavailable" }

/**
 * `scheme://host[:port]` for a URL string, or `null` when it does not parse.
 *
 * Built from `protocol` + `host` rather than read off `URL.origin`, which
 * answers the string `"null"` for a non-special scheme — a value that would
 * then have to be special-cased on both sides of the comparison. `URL.host`
 * already drops a scheme-default port, so `http://localhost:80` and
 * `http://localhost` normalize to the same string, in the set and in the
 * header alike.
 */
function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * The closed set of shell origins this route will believe: the three
 * loopback spellings on the port this process listens on, plus the
 * configured public origin.
 *
 * The scheme is always `publicUrl`'s. There is no reliable scheme on the
 * request behind a proxy, and taking it from the header would let a caller
 * choose one — which matters, because `loopback-listeners.ts` refuses to
 * pair an `https:` shell with a listener (an http frame inside an https page
 * is blocked as mixed content, silently).
 *
 * Built once per app, from the same `config` the Host allowlist is built
 * from.
 */
function acceptableShellOrigins(config: { publicUrl: string; port: number }): ReadonlySet<string> {
  const set = new Set<string>()
  const publicUrl = normalizeOrigin(config.publicUrl)
  if (publicUrl) set.add(publicUrl)
  const scheme = new URL(config.publicUrl).protocol
  for (const spelling of LOOPBACK_HOSTS) {
    // `LOOPBACK_HOSTS` already spells IPv6 bracketed (`[::1]`), which is the
    // only form a URL parses.
    const candidate = normalizeOrigin(`${scheme}//${spelling}:${config.port}`)
    if (candidate) set.add(candidate)
  }
  return set
}

// No explicit `Request`/`Response` annotations on the handler below — see the
// same note in `projects-routes.ts`: typing the params that way widens
// `req.params` to Express 5's generic `ParamsDictionary`.
export function createPrototypeOriginRoutes(deps: AppDeps): Router {
  const router = Router()

  // The same two inputs `create-app.ts` builds its allowlist from, so the
  // verdict this route hands `resolveOrigins` agrees with the middleware that
  // already admitted the request. Built once, not per request.
  const allowlist = buildHostAllowlist(deps.config, {
    allowAnyLoopbackPort: deps.allowAnyLoopbackPort,
  })
  const acceptableOrigins = acceptableShellOrigins(deps.config)

  router.get("/projects/:id/prototype-origin", async (req, res) => {
    // On EVERY response, including the refusals below. The answer names a
    // listener port that is reaped when idle, so a cached one is a link to a
    // socket that no longer exists — and in subdomain mode it carries
    // `capabilityRequired`, which turns on an instance setting an admin can
    // flip at any moment.
    res.setHeader("Cache-Control", "no-store")

    // BEFORE the project lookup. A malformed or unrecognised header is a
    // statement about the REQUEST, identical for every project id, so it
    // discloses nothing — and refusing here means a bad header never reaches
    // storage.
    const stated = req.get(SHELL_ORIGIN_HEADER)
    let statedOrigin: string | null = null
    if (stated !== undefined) {
      statedOrigin = normalizeOrigin(stated)
      if (statedOrigin === null || !acceptableOrigins.has(statedOrigin)) {
        res.status(400).json(UNEXPECTED_SHELL_ORIGIN)
        return
      }
    }

    const access = await requireProjectReadWithPolicy(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, policy } = access

    const resolved = resolveOrigins({
      requestHost: req.headers.host,
      hostAllowed: isAllowedHost(allowlist, req.headers.host, deps.config.serveDomain),
      // A prototype host never reaches this route: `create-app.ts` mounts the
      // prototype-host scope and its API fence ahead of the API router, so a
      // request on a prototype origin is refused before routing. Stated as
      // `false` rather than recomputed, because there is nothing left here to
      // compute it from that the fences have not already answered.
      hostIsPrototype: false,
      publicUrl: deps.config.publicUrl,
      serveDomain: deps.config.serveDomain,
      loopbackAvailable: deps.config.loopbackAvailable,
      prototypeOrigin: deps.config.prototypeOrigin,
    })

    // `serveDomain` is what MADE the mode "subdomain" (see `resolveOrigins`),
    // so it is a non-empty string here. Read into a local and checked rather
    // than asserted, because the failure direction matters: a `null` slipping
    // through would build the malformed origin `https://acme.`, whereas
    // falling into the "fallback" branch below just means no isolated origin
    // is offered, which is always safe.
    const serveDomain = deps.config.serveDomain
    if (resolved.mode === "subdomain" && serveDomain) {
      const body: PrototypeOriginResponse = {
        mode: "subdomain",
        origin: prototypeOriginFor(project.slug, serveDomain, deps.config.publicUrl),
        // A subdomain prototype takes no capability when its assets need no
        // credential at all. Otherwise the caller must mint one: the session
        // cookie is host-only, so it is never sent to `{slug}.{serveDomain}`
        // and cannot authorize the prototype's own subresources.
        capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
      }
      res.json(body)
      return
    }

    // The single `VIEWER_PROTOTYPE_ORIGIN` host. Cross-origin from the shell
    // but path-namespaced, so it opens NO listener (unlike loopback) — the
    // origin is the configured one, echoed by `resolveOrigins`. Same capability
    // rule as subdomain: the session cookie is host-only and never reaches the
    // prototype origin, so a private prototype's subresources need a minted
    // capability, carried in the URL PATH (a `dsv_cap` cookie on the shared host
    // would leak between prototypes). `resolved.prototypeOrigin` is non-null
    // exactly when the mode is prototype-origin; the guard states it for the
    // type checker and, defensively, keeps a null from ever building a body.
    if (resolved.mode === "prototype-origin" && resolved.prototypeOrigin) {
      const body: PrototypeOriginResponse = {
        mode: "prototype-origin",
        origin: resolved.prototypeOrigin,
        capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
      }
      res.json(body)
      return
    }

    // The stated origin and the host paired with it are taken TOGETHER or not
    // at all. They are two halves of one decision — which loopback spelling
    // the shell is on, and therefore which one the prototype must not be on —
    // and a mismatched pair is precisely what would put the prototype back on
    // the shell's own origin.
    let shellOrigin = resolved.shellOrigin
    let prototypeHost = resolved.prototypeHost
    if (statedOrigin !== null) {
      const paired = pairedLoopbackHost(new URL(statedOrigin).hostname)
      if (paired !== null) {
        shellOrigin = statedOrigin
        prototypeHost = paired
      }
    }

    // `resolved.prototypeHost` is non-null exactly when the mode is
    // "loopback", so this branch is "fallback" plus the states that cannot
    // occur. Answering "fallback" for those is the safe direction: no
    // listener, no origin, and the shell keeps its path prefix.
    if (resolved.mode !== "loopback" || prototypeHost === null) {
      const body: PrototypeOriginResponse = {
        mode: "fallback",
        origin: null,
        capabilityRequired: true,
      }
      res.json(body)
      return
    }

    // A dangling `activeDeploymentId` reads as "nothing built", exactly as it
    // does in `projects-routes.ts`: the client cannot act on the difference,
    // and opening a listener for a deployment row that is gone would bind a
    // port that can only ever 404.
    const deployment = project.activeDeploymentId
      ? await deps.storage.getDeployment(project.activeDeploymentId)
      : null
    if (!deployment) {
      const body: PrototypeOriginResponse = {
        mode: "loopback",
        origin: null,
        capabilityRequired: false,
        reason: "no-deployment",
      }
      res.json(body)
      return
    }

    try {
      const listener = await deps.prototypeListeners.ensure(
        { id: deployment.id, slug: project.slug, projectId: project.id },
        { bindHost: loopbackBindHostFor(prototypeHost), shellOrigin },
      )
      const body: PrototypeOriginResponse = {
        mode: "loopback",
        origin: listener.origin,
        // Reaching an ephemeral loopback socket IS the credential, and this
        // route only opens one for a project the caller may already read.
        capabilityRequired: false,
      }
      res.json(body)
    } catch (error) {
      // A constant plus the error's CLASS, never its message.
      //
      // Logging the error object was wrong, and not by a little: every
      // failure `ensure` can produce interpolates something request-derived
      // into its message. The non-http and same-host refusals both name
      // `target.shellOrigin`; the bind-host mismatch names the deployment id;
      // and `assertIsolatedOrigins`, which runs AFTER the socket is bound,
      // names both origins — including the live ephemeral port, which is the
      // capability this whole mechanism rests on. A log file is exactly where
      // none of that belongs.
      //
      // The class is enough to tell the four cases apart in practice, and an
      // operator who needs more can read `loopback-listeners.ts`, where the
      // full message is thrown from.
      console.error(
        "[viewer] could not open a prototype origin listener:",
        error instanceof Error ? error.name : "unknown",
      )
      res.status(503).json(ORIGIN_UNAVAILABLE)
    }
  })

  return router
}

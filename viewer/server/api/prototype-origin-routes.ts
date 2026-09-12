import { Router, type Request } from "express"
import type { AppDeps } from "../create-app"
import {
  requireProjectReadWithPolicy,
  resolveProjectReadAccess,
  type ProjectReadPolicy,
} from "../auth/authorize"
import { buildHostAllowlist, isAllowedHost, type HostAllowlist } from "../serve/host-allowlist"
import { LoopbackPortsExhaustedError } from "../serve/loopback-listeners"
import {
  LOOPBACK_HOSTS,
  loopbackBindHostFor,
  pairedLoopbackHost,
  prototypeAnonymouslyReadable,
  resolveOrigins,
  SHELL_ORIGIN_HEADER,
  type PrototypeOriginResponse,
  type PrototypeProcessStatus,
} from "../serve/prototype-origin-resolve"
import type { ProcessStatus } from "../serve/prototype-processes"
import { bridgeAssetRelPath } from "../serve/serve-router"
import { prototypeOriginFor } from "../serve/subdomain"
import { clientKeyFor, createConcurrencyLimiter, MAX_CONCURRENT_STREAMS_PER_CLIENT } from "../rate-limit"
import type { DeploymentServe, Project } from "../storage/types"

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

/**
 * The plain route's 503 shapes. Both name `reason` and `serve`;
 * `ports-exhausted` additionally carries the configured `range`, the same
 * one the loopback success shape carries, so the page can count how many
 * ports there are.
 *
 * Both also name `deploymentId`, the way the 200 bodies do, and omit it when
 * there is none. The review page compares it against the deployment it was
 * rendered with and re-renders when they differ (a new deployment needs a
 * capability only the server can mint, and a new frame). Without it on these
 * bodies, a rebuild that landed while the origin was unavailable was invisible
 * to an open page, which went on believing the previous build was the live one
 * even after the origin came back.
 */
export type PrototypeOriginErrorBody =
  | {
      error: string
      reason: "ports-exhausted"
      serve: DeploymentServe
      range: { from: number; to: number } | null
      deploymentId?: string
      /** Whether the shell's same-host fallback needs the capability; carried on a 503 too (codex round 35). */
      capabilityRequired: boolean
    }
  | {
      error: string
      reason: "listener-failed"
      serve: DeploymentServe
      deploymentId?: string
      capabilityRequired: boolean
    }

/**
 * What `buildPrototypeOriginBody` hands back: the HTTP status the plain
 * route would answer with, the body itself, and the active deployment id
 * the body was computed against (or `null` when the project has none).
 *
 * `deploymentId` exists for the stream route: it is how a live connection
 * notices, on a later process-status callback, that the project's active
 * deployment has changed under it and a fresh resolution (not just a status
 * patch) is needed. A discriminated union on `status` rather than one
 * looser shape, so a caller narrowing on `status === 200` gets `body`
 * typed as `PrototypeOriginResponse`, not the error shape.
 *
 * A 200 body states the same id to the client (`PrototypeOriginResponse`'s
 * `deploymentId`), which is how the review page notices a rebuild it was not
 * rendered for. It stays here as well because a 503 body carries no such
 * field and the stream still has to follow the deployment behind it.
 */
export type PrototypeOriginResult =
  | { status: 200; body: PrototypeOriginResponse; deploymentId: string | null }
  | { status: 503; body: PrototypeOriginErrorBody; deploymentId: string | null }

interface BuildPrototypeOriginBodyParams {
  deps: AppDeps
  allowlist: HostAllowlist
  bridgeAssetPath: string
  project: Project
  policy: ProjectReadPolicy
  requestHost: string | undefined
  statedOrigin: string | null
}

/**
 * Decides which origin mode applies for one project, right now, and builds
 * the body both routes answer with.
 *
 * Extracted (task 6) so the plain route and the SSE stream can never
 * disagree about the shape of a body for the same project and deployment —
 * before this, the stream would have had to reimplement every branch below
 * by hand, one file away from silently drifting from it.
 *
 * For loopback mode this OPENS the listener (`prototypeListeners.ensure`) as
 * a side effect, exactly as the plain route always has. The stream route
 * calls this once at connect, for the same reason the plain route calls it
 * on every request: so the body it sends actually carries a live origin. It
 * must NOT call this again on every later event for the SAME deployment —
 * see the stream route's `handleProcessStatus` below, which patches the
 * `process` field into the body already in hand instead.
 */
async function buildPrototypeOriginBody(params: BuildPrototypeOriginBodyParams): Promise<PrototypeOriginResult> {
  const { deps, allowlist, bridgeAssetPath, project, policy, requestHost, statedOrigin } = params

  // Loaded ONCE, before any mode branch, so EVERY mode's answer can state
  // `serve` correctly — subdomain, prototype-origin and fallback used to
  // answer before ever looking at the deployment, which was fine while the
  // field did not exist. A dangling `activeDeploymentId` reads as "nothing
  // built" here too, same as everywhere else in this route: the client
  // cannot act on the difference, and a deployment row that is gone can
  // only ever 404.
  const deployment = project.activeDeploymentId
    ? await deps.storage.getDeployment(project.activeDeploymentId)
    : null
  const serve: DeploymentServe = deployment?.serve ?? "static"
  // Only when there IS a deployment and it is a server one — `deployment`
  // is re-checked rather than trusting `serve`, so a stale `serve` value
  // could never call `.status` with a null id.
  const processStatus =
    deployment && deployment.serve === "server" ? deps.prototypeProcesses.status(deployment.id) : undefined
  const deploymentId = deployment?.id ?? null

  const resolved = resolveOrigins({
    requestHost,
    hostAllowed: isAllowedHost(allowlist, requestHost, deps.config.serveDomain),
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
    // Read for one thing only: a genuinely detected container binds the
    // listener to the IPv4 wildcard, so the pairing must not choose
    // `[::1]`. NOT the same as "a port range is configured" — an operator
    // can set that by hand on a laptop, where the bind stays loopback and
    // `[::1]` is fine. See `pairedLoopbackHost`.
    loopbackBindAllInterfaces: deps.config.loopbackBindAllInterfaces,
  })

  // `serveDomain` is what MADE the mode "subdomain" (see `resolveOrigins`),
  // so it is a non-empty string here. Read into a local and checked rather
  // than asserted, because the failure direction matters: a `null` slipping
  // through would build the malformed origin `https://acme.`, whereas
  // falling into the "fallback" branch below just means no isolated origin
  // is offered, which is always safe.
  const serveDomain = deps.config.serveDomain
  if (resolved.mode === "subdomain" && serveDomain) {
    return {
      status: 200,
      deploymentId,
      body: {
        mode: "subdomain",
        origin: prototypeOriginFor(project.slug, serveDomain, deps.config.publicUrl),
        ...(deploymentId ? { deploymentId } : {}),
        // A subdomain prototype takes no capability when its assets need no
        // credential at all. Otherwise the caller must mint one: the session
        // cookie is host-only, so it is never sent to `{slug}.{serveDomain}`
        // and cannot authorize the prototype's own subresources.
        capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
        serve,
        ...(processStatus ? { process: processStatus } : {}),
      },
    }
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
    return {
      status: 200,
      deploymentId,
      body: {
        mode: "prototype-origin",
        origin: resolved.prototypeOrigin,
        ...(deploymentId ? { deploymentId } : {}),
        capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
        serve,
        ...(processStatus ? { process: processStatus } : {}),
      },
    }
  }

  // The stated origin and the host paired with it are taken TOGETHER or not
  // at all. They are two halves of one decision — which loopback spelling
  // the shell is on, and therefore which one the prototype must not be on —
  // and a mismatched pair is precisely what would put the prototype back on
  // the shell's own origin.
  let shellOrigin = resolved.shellOrigin
  let prototypeHost = resolved.prototypeHost
  if (statedOrigin !== null) {
    // Same bind-all-interfaces fact as the `resolveOrigins` call above, for
    // the same reason: the shell's stated origin decides the pairing here,
    // and the pairing must not name `[::1]` when the listener binds the
    // wildcard.
    const paired = pairedLoopbackHost(new URL(statedOrigin).hostname, {
      bindAllInterfaces: deps.config.loopbackBindAllInterfaces,
    })
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
    return {
      status: 200,
      deploymentId,
      body: {
        mode: "fallback",
        origin: null,
        capabilityRequired: true,
        ...(deploymentId ? { deploymentId } : {}),
        serve,
        ...(processStatus ? { process: processStatus } : {}),
      },
    }
  }

  if (!deployment) {
    return {
      status: 200,
      // No deployment at all: nothing for a later status callback to track.
      deploymentId: null,
      body: {
        mode: "loopback",
        origin: null,
        capabilityRequired: false,
        reason: "no-deployment",
        serve: "static",
        range: deps.config.loopbackPortRange,
        bridgeAssetPath,
      },
    }
  }

  try {
    const listener = await deps.prototypeListeners.ensure(
      // `serve` travels with the deployment because this route already has
      // the row in hand. A listener's write-method fence reads it once, at
      // open time, rather than asking storage on every request — see
      // `serve/loopback-listeners.ts`'s `LoopbackListenerAppContext.serve`.
      { id: deployment.id, slug: project.slug, projectId: project.id, serve: deployment.serve },
      { bindHost: loopbackBindHostFor(prototypeHost), shellOrigin },
    )
    return {
      status: 200,
      deploymentId,
      body: {
        mode: "loopback",
        origin: listener.origin,
        deploymentId: deployment.id,
        // Reaching an ephemeral loopback socket IS the credential, and this
        // route only opens one for a project the caller may already read.
        capabilityRequired: false,
        serve,
        range: deps.config.loopbackPortRange,
        bridgeAssetPath,
        ...(processStatus ? { process: processStatus } : {}),
      },
    }
  } catch (error) {
    if (error instanceof LoopbackPortsExhaustedError) {
      // `serve` and `range` ride along because the page decides what to do
      // with this from them: a STATIC prototype still loads from the shell's
      // own path prefix and must not be blanked, and the panel a server
      // prototype gets names how many ports there are.
      return {
        status: 503,
        deploymentId,
        body: {
          error: error.message,
          reason: "ports-exhausted",
          serve,
          range: deps.config.loopbackPortRange,
          ...(deploymentId ? { deploymentId } : {}),
          // A static prototype keeps loading from the shell's own path
          // prefix while the origin is unavailable, and THAT needs the
          // capability a private project requires; without this the shell
          // could not tell an access change apart from the 503 it already
          // had, and the fallback frame's assets 404ed (codex round 35).
          capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
        },
      }
    }
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
    // `serve` rides along for the same reason it does on the
    // ports-exhausted body above: a STATIC prototype still loads from the
    // shell's own path prefix and must not be blanked. Before `reason` and
    // `serve` were added here (codex round 6, Fix 2), this body was
    // `ORIGIN_UNAVAILABLE` alone, `readPrototypeOrigin` defaulted `serve`
    // to `"static"` on the client no matter what it actually was, and
    // `decidePrototypeEmbed` embedded `/p/:slug/` for a SERVER deployment
    // — which the serve router then answers 409 for, INSIDE the frame,
    // instead of showing a panel.
    return {
      status: 503,
      deploymentId,
      body: {
        ...ORIGIN_UNAVAILABLE,
        reason: "listener-failed",
        serve,
        ...(deploymentId ? { deploymentId } : {}),
        // Same reason as the ports-exhausted body above (codex round 35).
        capabilityRequired: !prototypeAnonymouslyReadable(project.access, policy.allowPublicLinks),
      },
    }
  }
}

/**
 * Parses and validates `X-Viewer-Shell-Origin` against the closed set, the
 * same way for both routes below. `ok: false` means "answer 400 with
 * `UNEXPECTED_SHELL_ORIGIN` and go no further" — the header is a statement
 * about the REQUEST, so this always runs before any project lookup.
 */
function readStatedShellOrigin(
  req: Pick<Request, "get">,
  acceptableOrigins: ReadonlySet<string>,
): { ok: true; origin: string | null } | { ok: false } {
  const stated = req.get(SHELL_ORIGIN_HEADER)
  if (stated === undefined) return { ok: true, origin: null }
  const normalized = normalizeOrigin(stated)
  if (normalized === null || !acceptableOrigins.has(normalized)) return { ok: false }
  return { ok: true, origin: normalized }
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
  // Where the bridge bundle sits on a prototype origin, for the shell's port
  // probe. The same `?? "dev"` default `create-app.ts` hands the serve
  // router, so the path this route names is the one that router answers.
  const bridgeAssetPath = bridgeAssetRelPath(deps.bridgeVersion ?? "dev")

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
    const stated = readStatedShellOrigin(req, acceptableOrigins)
    if (!stated.ok) {
      res.status(400).json(UNEXPECTED_SHELL_ORIGIN)
      return
    }

    const access = await requireProjectReadWithPolicy(deps, req, res, String(req.params.id))
    if (!access) return
    const { project, policy } = access

    const result = await buildPrototypeOriginBody({
      deps,
      allowlist,
      bridgeAssetPath,
      project,
      policy,
      requestHost: req.headers.host,
      statedOrigin: stated.origin,
    })
    res.status(result.status).json(result.body)
  })

  // One concurrency cap shared by every stream this router serves — there is
  // only one stream route in this file today, but the pattern (and the
  // shared instance) matches `comments-routes.ts` and `build-routes.ts`
  // exactly, so a second stream added here later would reuse it rather than
  // invent its own bucket.
  const streamSlots = createConcurrencyLimiter({ max: MAX_CONCURRENT_STREAMS_PER_CLIENT })
  // TESTS ONLY override for the heartbeat interval — see `AppDeps.prototypeOriginStreamPingMs`.
  const pingMs = deps.prototypeOriginStreamPingMs ?? 25_000

  /**
   * SSE stream of the same body `GET .../prototype-origin` answers: an
   * `origin` event on connect, another whenever the active deployment's
   * process status changes, and a `: ping\n\n` comment every `pingMs` so an
   * idle stream is not indistinguishable from a dead one to a proxy.
   *
   * Follows `comments-routes.ts`'s stream handler exactly for the connection
   * lifecycle (the `closed` flag registered before the first `await`, the
   * idempotent `cleanup`, the concurrency cap acquired only after the read
   * gate passes). The read gate runs again before every update this
   * connection sends, not only at connect — see `readableProjectNow`. What
   * is new here is what happens AFTER the stream opens:
   * `buildPrototypeOriginBody` runs once, at connect, and its `ensure` side
   * effect runs then and only then. Every later event either patches a
   * `process` status straight into the body already in hand (same
   * deployment) or re-runs the full resolution because the project's active
   * deployment changed under the stream (see `handleProcessStatus` below).
   */
  router.get("/projects/:id/prototype-origin/stream", async (req, res) => {
    res.setHeader("Cache-Control", "no-store")

    let closed = false
    let unsubscribeProcess: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let release: (() => void) | null = null
    const cleanup = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (unsubscribeProcess) {
        unsubscribeProcess()
        unsubscribeProcess = null
      }
      if (release) {
        release()
        release = null
      }
    }
    req.on("close", () => {
      closed = true
      cleanup()
    })
    // Defense-in-depth: a write to an already-torn-down socket (e.g. a
    // heartbeat racing the teardown) must not surface as an unhandled
    // "error" event and crash the process.
    res.on("error", () => {})

    const stated = readStatedShellOrigin(req, acceptableOrigins)
    if (!stated.ok) {
      res.status(400).json(UNEXPECTED_SHELL_ORIGIN)
      return
    }

    const access = await requireProjectReadWithPolicy(deps, req, res, String(req.params.id))
    if (closed) return
    if (!access) return
    const { project } = access
    /**
     * The policy the CURRENT body was built against, replaced on every
     * re-check below.
     *
     * It used to be the one captured at connect, reused for the life of the
     * connection — so a body sent an hour later could still be stating the
     * `capabilityRequired` that applied when the stream opened.
     */
    let policy: ProjectReadPolicy = access.policy

    // Bound how many of these one client may hold open — see `rate-limit.ts`.
    // Acquired here, after the read gate, so a refused read (404) never
    // consumes a slot, and released through the same `cleanup` the
    // subscription and heartbeat use, so every teardown path frees it.
    const releaseSlot = streamSlots.acquire(clientKeyFor(req))
    if (!releaseSlot) {
      res.setHeader("Retry-After", "5")
      res.status(429).json({ error: "Too many open connections from this client" })
      return
    }
    release = releaseSlot
    if (closed) {
      // The client hung up during the awaits above. `cleanup` already ran,
      // so nothing else will release this slot.
      release()
      return
    }

    const requestHost = req.headers.host

    res.status(200)
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()

    /**
     * The access-relevant facts the body in hand was built from: the
     * project's access, the instance-wide public-link switch, and the
     * capability verdict those two produced.
     *
     * Compared against the same three read FRESH on each tick, which is how
     * the connection notices an access change with no deployment change
     * behind it (codex round 14, Fix 3). The verdict is in the key as well as
     * its two inputs so the comparison states what it is actually about,
     * rather than leaving a reader to re-derive that `capabilityRequired`
     * comes from exactly those inputs.
     */
    const accessKey = (from: Project, against: ProjectReadPolicy, result: PrototypeOriginResult): string => {
      // A 503 body carries the verdict too (codex round 35), so an access
      // change during an outage is noticed like any other.
      const capabilityRequired = "capabilityRequired" in result.body ? result.body.capabilityRequired : null
      return `${from.access}|${against.allowPublicLinks}|${capabilityRequired}`
    }
    /** The key for the body this connection last sent. Set by `send`, and only there. */
    let sentAccessKey = ""

    const send = (result: PrototypeOriginResult, from: Project): void => {
      sentAccessKey = accessKey(from, policy, result)
      res.write(`event: origin\ndata: ${JSON.stringify(result.body)}\n\n`)
    }

    // The one and only `ensure` call this connection makes for the
    // deployment it connects against — see the doc comment above.
    let current = await buildPrototypeOriginBody({
      deps,
      allowlist,
      bridgeAssetPath,
      project,
      policy,
      requestHost,
      statedOrigin: stated.origin,
    })
    if (closed) return
    send(current, project)

    /**
     * One promise chain for everything this connection does after it has
     * opened: every status callback, and every heartbeat re-check.
     *
     * Two callbacks used to be free to interleave across a deployment
     * change. Both read the project, both saw the new active deployment, and
     * each subscribed to it — the second overwriting the first's
     * unsubscribe, which then never ran. Ordering them means the second one
     * sees what the first one did, and there is exactly one subscription at
     * a time.
     *
     * A task that throws is logged and swallowed: the chain has to survive
     * it, or one failed storage read would silently stop every later update
     * on this connection.
     */
    let queue: Promise<void> = Promise.resolve()
    const enqueue = (task: () => Promise<void>): void => {
      queue = queue.then(task).catch((error: unknown) => {
        console.error("[viewer] prototype-origin stream update failed:", error)
      })
    }

    // `current.body.serve` is on every shape `buildPrototypeOriginBody`
    // returns (success and 503 alike), so this is enough to decide whether
    // there is a process to subscribe to — no second deployment read needed.
    //
    // The previous subscription is always released first. There is never a
    // moment with two of them, whichever path got here.
    const subscribeToProcess = (deploymentId: string): void => {
      if (unsubscribeProcess) {
        unsubscribeProcess()
        unsubscribeProcess = null
      }
      unsubscribeProcess = deps.prototypeProcesses.subscribe(deploymentId, (status) => {
        enqueue(() => handleProcessStatus(deploymentId, status))
      })
    }

    /**
     * Re-resolves this stream against the project as it is now: a full
     * re-resolution (a genuinely new deployment can need a new listener, so
     * `ensure` runs again here — see the doc comment on
     * `buildPrototypeOriginBody` for why it must NOT run on the patch path),
     * a fresh `origin` event, and the process subscription pointed at
     * whatever deployment the answer names.
     *
     * Two callers, both from the tick. The active deployment changed under
     * the stream, which is what this was written for — and the project's
     * ACCESS changed, which produces a different body for the same
     * deployment (its `capabilityRequired`) and needs exactly the same work.
     *
     * The old subscription is released FIRST, before the await, so nothing
     * more arrives for a deployment this stream has left.
     */
    const refollowActiveDeployment = async (freshProject: Project): Promise<void> => {
      if (unsubscribeProcess) {
        unsubscribeProcess()
        unsubscribeProcess = null
      }
      current = await buildPrototypeOriginBody({
        deps,
        allowlist,
        bridgeAssetPath,
        project: freshProject,
        policy,
        requestHost,
        statedOrigin: stated.origin,
      })
      if (closed) return
      send(current, freshProject)
      if (current.deploymentId && current.body.serve === "server") {
        subscribeToProcess(current.deploymentId)
      }
    }

    /**
     * Ends this connection for good: no further bytes, no body, just the
     * close. Used by the read re-check below, which has no status line left
     * to refuse with.
     *
     * `closed` is set BEFORE `res.end()` so anything already queued behind an
     * await sees it and sends nothing.
     */
    const endStream = (): void => {
      if (closed) return
      closed = true
      cleanup()
      res.end()
    }

    /**
     * Re-runs the read gate against the CURRENT identity, and hands back the
     * project as it is right now — or `null`, having ended the stream,
     * when the caller may no longer read it.
     *
     * Every update path goes through this, and that is the whole fix. The
     * stream used to check the read policy once, at connect, and reuse that
     * verdict: a member removed from a project, or an anonymous public-link
     * visitor after an admin turned public links off, kept the connection,
     * and the next active deployment opened a fresh loopback listener for
     * them and sent its origin. A listener is the credential in loopback
     * mode, so that is a live prototype handed to someone who had just lost
     * access to it.
     *
     * It also replaces the two `getProject` reads the update paths used to
     * do: the gate loads the project anyway, so re-reading it separately
     * would be a second round trip AND a second answer to "what does the
     * project look like now".
     */
    const readableProjectNow = async (): Promise<Project | null> => {
      const outcome = await resolveProjectReadAccess(deps, req, project.id)
      if (!outcome.ok) {
        endStream()
        return null
      }
      policy = outcome.access.policy
      return outcome.access.project
    }

    /**
     * Runs on every process-status change for whichever deployment this
     * stream is currently subscribed to.
     *
     * Re-checks the read gate and re-reads the project FIRST, because the
     * subscription this callback fired from may no longer be the active
     * one — a build can have published a new deployment since connect. When
     * it has, `refollowActiveDeployment` above takes over. When the active
     * deployment is unchanged, this only patches `process` into the body
     * already in hand.
     */
    const handleProcessStatus = async (fromDeploymentId: string, status: ProcessStatus): Promise<void> => {
      if (closed) return
      const freshProject = await readableProjectNow()
      if (closed) return
      if (!freshProject) return
      if ((freshProject.activeDeploymentId ?? null) !== current.deploymentId) {
        await refollowActiveDeployment(freshProject)
        return
      }
      // A status for a deployment this stream has already moved off. It can
      // only be a callback that was queued before the change and ran after
      // it, and patching an old deployment's process into the new
      // deployment's body would be a lie the page acts on.
      if (fromDeploymentId !== current.deploymentId) return
      // The access may have changed under this same callback (a project
      // going private as the child crashes). Patching the old body would
      // send a stale `capabilityRequired` AND record an access key built
      // from it, leaving every later tick blind to the change (codex round
      // 24). Re-resolve instead; the fresh body carries the status too.
      if (accessKey(freshProject, policy, current) !== sentAccessKey) {
        await refollowActiveDeployment(freshProject)
        return
      }
      if (current.status === 200) {
        // The cast is safe: this branch only runs when `subscribeToProcess`
        // was called, which only happens for a body whose `serve` is
        // `"server"` — never the `no-deployment` variant, the one shape in
        // the union with no `process` field to patch.
        current = { ...current, body: { ...current.body, process: status } as PrototypeOriginResponse }
      }
      send(current, freshProject)
    }

    /**
     * Re-runs the whole resolution while the answer this stream last sent was
     * a 503, and sends the new one when it says something different.
     *
     * `ports-exhausted` and `listener-failed` both mean the resolution stopped
     * before any listener existed, so there is no process, nothing ever
     * transitions, and `resendIfProcessChanged` has no 200 body to read a
     * deployment off. The connection would therefore sit on the unavailable
     * panel for the rest of its life — including long after the port that was
     * in the way was released. The tick is the only clock it has, so the retry
     * belongs here, exactly as the `retryable` re-read does.
     *
     * `buildPrototypeOriginBody` is what opens a listener, and calling it
     * again is the point: a retry that did not try to bind would learn
     * nothing. A body that still fails the same way is NOT sent, so a
     * deployment stuck at ports-exhausted costs one bind attempt per tick and
     * no traffic at all.
     */
    const retryUnavailableOrigin = async (freshProject: Project): Promise<void> => {
      const previous = current
      const next = await buildPrototypeOriginBody({
        deps,
        allowlist,
        bridgeAssetPath,
        project: freshProject,
        policy,
        requestHost,
        statedOrigin: stated.origin,
      })
      if (closed) return
      if (
        next.status === 503 &&
        previous.status === 503 &&
        next.body.reason === previous.body.reason &&
        next.body.capabilityRequired === previous.body.capabilityRequired
      ) {
        return
      }
      current = next
      send(next, freshProject)
      // Same rule the connect path and `refollowActiveDeployment` follow. A
      // recovery that produced a server body has a child to follow now;
      // anything else must leave no subscription behind.
      if (next.deploymentId && next.body.serve === "server") {
        subscribeToProcess(next.deploymentId)
      } else if (unsubscribeProcess) {
        unsubscribeProcess()
        unsubscribeProcess = null
      }
    }

    /**
     * The process status the last body carried, or `undefined` when it
     * carried none.
     *
     * Read back off `current` rather than tracked in a second variable, so
     * there is one answer to "what does the page believe right now" however
     * the last body was built (a full resolve, or a patch).
     */
    const sentProcess = (): PrototypeProcessStatus | undefined =>
      current.status === 200 && "process" in current.body ? current.body.process : undefined

    /**
     * Re-reads the followed deployment's process status and sends a fresh
     * body when it differs from the one the page has.
     *
     * Subscribers fire on TRANSITIONS, and `retryable` is not a transition:
     * it is computed when the status is read, from the crash timestamps and
     * the clock (see `ProcessStatus.retryable`). So a crashed prototype whose
     * restart budget ages out of its five minute window becomes retryable
     * with no event to notify on, and the page would sit on the crashed panel
     * until someone reloaded it. This runs on the heartbeat tick, which is
     * the only clock this connection has.
     */
    const resendIfProcessChanged = (freshProject: Project): void => {
      if (closed || current.status !== 200) return
      const deploymentId = current.deploymentId
      if (deploymentId === null || current.body.serve !== "server") return
      const status = deps.prototypeProcesses.status(deploymentId)
      if (JSON.stringify(status) === JSON.stringify(sentProcess())) return
      current = { ...current, body: { ...current.body, process: status } as PrototypeOriginResponse }
      send(current, freshProject)
    }

    /**
     * The heartbeat tick's own work: has anything changed that no callback
     * would have told this connection about?
     *
     * Two things can. The active deployment can change under the stream — a
     * rebuild publishes a new one, and the build change bus is keyed by
     * DEPLOYMENT id, so there is no project-level subscription to receive.
     * The old deployment need never transition again either (a rebuild keeps
     * one previous checkout, so it is not even retired), which is why
     * `handleProcessStatus` cannot be the only place that notices. And the
     * process status can change with the clock alone — see
     * `resendIfProcessChanged`.
     *
     * Runs through the same queue the status callbacks do, so a tick and a
     * callback can never both be half way through a deployment change.
     *
     * A third thing can change, and it is checked before either of those:
     * whether the caller may still read this project at all. See
     * `readableProjectNow`.
     *
     * And a fourth, when the last answer was a 503: the resolution itself can
     * start succeeding, with nothing to announce it. See
     * `retryUnavailableOrigin`.
     *
     * And a fifth: the project's ACCESS can change while the caller still
     * passes the read gate. `readableProjectNow` refreshes the policy, and
     * the only thing this used to compare afterwards was the deployment id —
     * so a project made private under an authorised member kept a body
     * saying `capabilityRequired: false`, the page kept a frame with no
     * capability in its URL, and the prototype's subresources started 404ing
     * (codex round 14, Fix 3). The comparison is `accessKey`'s.
     */
    const pollForChanges = async (): Promise<void> => {
      if (closed) return
      // The read gate first, on every tick: a stream must not outlive the
      // access that opened it. See `readableProjectNow`.
      const freshProject = await readableProjectNow()
      if (closed || !freshProject) return
      if ((freshProject.activeDeploymentId ?? null) !== current.deploymentId) {
        await refollowActiveDeployment(freshProject)
        return
      }
      // Before the access check, so a 503 keeps its own "do not repeat the
      // same failure" rule. The retry re-resolves with the fresh project, so
      // an access change during the outage reaches the page through the
      // fresh 503 body's `capabilityRequired` (codex round 35), and the send
      // that ends the 503 sets the key from the fresh project anyway.
      if (current.status === 503) {
        await retryUnavailableOrigin(freshProject)
        return
      }
      if (accessKey(freshProject, policy, current) !== sentAccessKey) {
        await refollowActiveDeployment(freshProject)
        return
      }
      resendIfProcessChanged(freshProject)
      keepListenerAlive()
    }

    /**
     * An open review is use. The listener registry reaps a loopback port
     * that saw no prototype request for 30 minutes, and this stream checked
     * the deployment, the access and the process on every tick without ever
     * touching the listener, so a reader who sat on the page that long kept
     * an origin nothing answered on: the next click failed at the socket and
     * never reached `ensure` (codex round 16).
     */
    const keepListenerAlive = (): void => {
      if (current.status !== 200 || current.body.mode !== "loopback" || !current.body.origin) return
      // By origin, not port number: two loopback spellings can share a port
      // under a fixed range (codex round 27).
      deps.prototypeListeners.touchOrigin(current.body.origin)
    }

    if (current.deploymentId && current.body.serve === "server") {
      subscribeToProcess(current.deploymentId)
      // The first body sampled the status before the listener was set up
      // and before this subscription existed; a transition in that gap
      // notified nobody. Read once more now that the subscription is in
      // place, so the page never waits a heartbeat for it (codex round 19).
      resendIfProcessChanged(project)
    }

    heartbeat = setInterval(() => {
      if (closed) return
      res.write(": ping\n\n")
      enqueue(pollForChanges)
    }, pingMs)
  })

  return router
}

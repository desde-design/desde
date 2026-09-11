import { Router, type Request } from "express"
import type { AppDeps } from "../create-app"
import { requireProjectReadWithPolicy, type ProjectReadPolicy } from "../auth/authorize"
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
 */
export type PrototypeOriginErrorBody =
  | { error: string; reason: "ports-exhausted"; serve: DeploymentServe; range: { from: number; to: number } | null }
  | { error: string; reason: "listener-failed"; serve: DeploymentServe }

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
      body: { ...ORIGIN_UNAVAILABLE, reason: "listener-failed", serve },
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
   * gate passes). What is new here is what happens AFTER the stream opens:
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
    const { project, policy } = access

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

    const send = (result: PrototypeOriginResult): void => {
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
    send(current)

    // `current.body.serve` is on every shape `buildPrototypeOriginBody`
    // returns (success and 503 alike), so this is enough to decide whether
    // there is a process to subscribe to — no second deployment read needed.
    const subscribeToProcess = (deploymentId: string): void => {
      unsubscribeProcess = deps.prototypeProcesses.subscribe(deploymentId, (status) => {
        void handleProcessStatus(status)
      })
    }

    /**
     * Runs on every process-status change for whichever deployment this
     * stream is currently subscribed to.
     *
     * Re-reads the project's active deployment id FIRST, because the
     * subscription this callback fired from may no longer be the active
     * one — a build can have published a new deployment since connect. When
     * it has, this re-subscribes to the new one and fully re-resolves the
     * body (a genuinely new deployment can need a new listener, so `ensure`
     * runs again here — see the doc comment above for why it must NOT run
     * on the branch below). When the active deployment is unchanged, this
     * only patches `process` into the body already in hand.
     */
    const handleProcessStatus = async (status: ProcessStatus): Promise<void> => {
      if (closed) return
      const freshProject = await deps.storage.getProject(project.id)
      if (closed) return
      if (!freshProject) return
      const freshDeploymentId = freshProject.activeDeploymentId ?? null
      if (freshDeploymentId !== current.deploymentId) {
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
        send(current)
        if (current.deploymentId && current.body.serve === "server") {
          subscribeToProcess(current.deploymentId)
        }
        return
      }
      if (current.status === 200) {
        // The cast is safe: this branch only runs when `subscribeToProcess`
        // was called, which only happens for a body whose `serve` is
        // `"server"` — never the `no-deployment` variant, the one shape in
        // the union with no `process` field to patch.
        current = { ...current, body: { ...current.body, process: status } as PrototypeOriginResponse }
      }
      send(current)
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
    const resendIfProcessChanged = (): void => {
      if (closed || current.status !== 200) return
      const deploymentId = current.deploymentId
      if (deploymentId === null || current.body.serve !== "server") return
      const status = deps.prototypeProcesses.status(deploymentId)
      if (JSON.stringify(status) === JSON.stringify(sentProcess())) return
      current = { ...current, body: { ...current.body, process: status } as PrototypeOriginResponse }
      send(current)
    }

    if (current.deploymentId && current.body.serve === "server") {
      subscribeToProcess(current.deploymentId)
    }

    heartbeat = setInterval(() => {
      if (closed) return
      res.write(": ping\n\n")
      resendIfProcessChanged()
    }, pingMs)
  })

  return router
}

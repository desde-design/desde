import type express from "express"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { assertIsolatedOrigins } from "./prototype-origin-resolve"
import type { PrototypeHostRegistry } from "./prototype-host-scope"
import type { DeploymentServe } from "../storage/types"

/**
 * One `http.Server` per (deployment, shell origin), bound to a loopback
 * address on an ephemeral port, serving that one deployment at `/`.
 *
 * ## Why a listener per deployment, and not one per project
 *
 * A prototype needs its own ORIGIN, and on a laptop the only way to get one
 * without DNS is a different loopback name plus a different port (see
 * `docs/superpowers/research/2026-08-22-prototype-origin-origin-options.md`,
 * option 1). The name flip is what removes the reviewer's session cookie:
 * cookies are host-keyed and host-only, so a cookie set on `localhost` is
 * never sent to `127.0.0.1`. The port is what gives the prototype the ROOT of
 * its origin, so a root-absolute `/assets/app.css` resolves inside the
 * prototype and the server already knows which deployment it belongs to — no
 * Referer, no cookie, no capability token on the asset path.
 *
 * Cookies are NOT isolated by port (RFC 6265 §8.5, and measured: a viewer
 * session cookie on `localhost:3199` was delivered to an unrelated probe on
 * `localhost:45680`). The port alone would therefore be a downgrade, which is
 * why `ensure` refuses a bind host equal to the shell's own hostname.
 *
 * ## Why the key includes the shell origin
 *
 * A listener's `frame-ancestors` and the bridge's `data-shell-origin` are
 * fixed at construction — the whole point of a per-listener app is that
 * nothing about its responses is derived from a request. So a reviewer who
 * opens the shell as `127.0.0.1` and another who opens it as `localhost` need
 * two listeners for the same deployment, not one whose CSP names the wrong
 * shell.
 *
 * ## Why the key includes the deployment id and not the project
 *
 * A listener never consults `project.activeDeploymentId`. When a new build
 * goes live the API opens a listener for the NEW deployment and gets a new
 * port; the old one idles out and is reaped. A review in progress therefore
 * cannot have the bytes change underneath it.
 *
 * ## Scope, and the one case that binds every interface
 *
 * This is a local-machine facility. With no configured port range, `listen`
 * is only ever given `127.0.0.1` or `::1` — never `localhost`, which may
 * resolve to both families and so does not name one origin.
 *
 * `deps.bindAllInterfaces` is the CONTAINER case, and there the bind widens
 * to `0.0.0.0`. Docker forwards a published port to the container's EXTERNAL
 * interface and never to the container's own loopback, so a `127.0.0.1` bind
 * inside a container answers nothing from the host, whatever `-p` says
 * (MEASURED on Docker Desktop, 2026-09-11). What that costs, and what the
 * documented `-p 127.0.0.1:...` run line buys back, is written out at the
 * bind in `open()`.
 *
 * This flag is DELIBERATELY separate from `deps.portRange`: a configured
 * range only says which ports to try, and an operator can set
 * `VIEWER_LOOPBACK_PORT_RANGE` on a laptop that is not a container. Widening
 * the bind there — as this module used to do, keyed on the range alone —
 * would make a private prototype reachable from the LAN on a predictable
 * port. `bindAllInterfaces` is true only when the caller has actually
 * detected a container (`ViewerConfig.loopbackBindAllInterfaces`).
 *
 * The origin handed to the browser is never the bind address: it always
 * names the loopback spelling paired with the shell
 * (`pairedLoopbackHost`). With a range configured that pairing never
 * chooses `[::1]`, because an IPv4 wildcard cannot answer there.
 */

/**
 * What a listener may be told to bind.
 *
 * Two literal addresses, plus the NAME `localhost`, which occurs only in the
 * container case: with a port range configured the socket goes on the
 * wildcard, so the name is used for the display spelling and never passed to
 * `listen()`. `open()` refuses `localhost` without a range. Never `0.0.0.0`
 * from a caller — widening the bind is this module's own decision.
 */
export type LoopbackBindHost = "127.0.0.1" | "::1" | "localhost"

/** Default idle bound: a listener unused for this long is reaped. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000

/**
 * Default reaper period.
 *
 * Deliberately NOT the session sweep's tick, which runs every 6 hours and so
 * cannot implement a 30-minute idle bound at all.
 */
const DEFAULT_REAP_INTERVAL_MS = 5 * 60 * 1000

export interface LoopbackListener {
  deploymentId: string
  projectId: string
  slug: string
  /**
   * The `Host` and URL spelling: `127.0.0.1`, `[::1]` with brackets, or
   * `localhost` (the port-range pairing only).
   */
  host: "127.0.0.1" | "[::1]" | "localhost"
  port: number
  /** `http://127.0.0.1:45001`. Always `http` — a loopback shell is http. */
  origin: string
  /** The shell origin this listener was opened for. Half of its registry key. */
  shellOrigin: string
  /**
   * What `server.address().address` actually reported.
   *
   * Recorded so a test can prove the socket is on loopback rather than merely
   * that loopback was requested. "Never binds 0.0.0.0" is the property that
   * keeps this a local-machine facility, and it deserves to be asserted
   * against the socket, not against our own argument.
   */
  boundAddress: string
  /** Last time this listener served (or was `touch`ed), on the injected clock. */
  lastUsedAt: number
  close(): Promise<void>
}

/**
 * What the registry hands the app factory. Everything the listener's Express
 * app needs that only the registry can know — above all the port, which does
 * not exist until the socket is bound.
 */
export interface LoopbackListenerAppContext {
  deploymentId: string
  slug: string
  /**
   * How the pinned deployment is served, carried from the deployment row the
   * caller already had in hand (`api/prototype-origin-routes.ts`).
   *
   * A listener fronts exactly ONE deployment for its whole life, so this is
   * fixed at open time and no request on it ever needs a storage lookup to
   * learn it. The write-method fence is what reads it: it runs before the path
   * is rewritten, so it cannot ask whether a path is the prototype route —
   * every path on this origin is — and what it asks instead is whether the
   * deployment it fronts is a process that can take a write at all. See
   * `loopback-listener-app.ts`.
   *
   * Being a snapshot, it can in principle go stale, and it goes stale in the
   * SAFE direction. A build publishes `serve` on a NEW deployment row, and a
   * new row means a new registry key and therefore a new listener, so the
   * ordinary case never produces a stale value at all. The only way to produce
   * one is to flip an existing row in place: `static` → `server` leaves this
   * listener still refusing writes until it is reaped, which is a feature that
   * does not appear rather than a boundary that gives way. The other direction,
   * `server` → `static`, passes a write to a serve router that immediately
   * hands it back, and `createPrototypeHostTerminalFence` refuses it.
   */
  serve: DeploymentServe
  /** The one acceptable `Host` value: `127.0.0.1:45001` or `[::1]:45001`. */
  hostPort: string
  shellOrigin: string
  /**
   * This origin last served a DIFFERENT deployment (codex round 41). A
   * fixed port range recycles ports, and a browser origin outlives the
   * listener that answered on it: a still-open document of the previous
   * deployment is same-origin with this one, and whatever it stored
   * (localStorage, IndexedDB, a service worker, cached responses) is
   * inherited. The app clears the origin's storage and cache on its first
   * document response when this is set. Never set for the same deployment
   * coming back on the origin it had before, which the registry prefers.
   */
  recycledOrigin: boolean
  /** Called on every request the listener serves. */
  touch: () => void
  /**
   * Marks a request as in-flight against this listener, so the idle reaper
   * leaves it alone for as long as the response is still open.
   *
   * Call it right when a request starts and call the returned function when
   * the response ends (`res.once("close", release)` in
   * `loopback-listener-app.ts`). Mirrors `PrototypeProcesses.withLease`
   * (`prototype-processes.ts`) — without this, `touch()` at request-start
   * alone is not enough: a response that outlives the idle bound while it is
   * still being answered (an SSE stream, a large streamed download) would be
   * cut out from under the client by the reaper (codex round 7, Fix 3, the
   * same defect the process lease closed for the process itself in codex round
   * 2, item 3).
   *
   * The returned release function also touches the listener, so the idle
   * clock restarts from the moment the response actually ends rather than
   * from whenever it started.
   */
  beginRequest: () => () => void
}

export interface LoopbackListenerRegistry extends PrototypeHostRegistry {
  /**
   * The listener for this (deployment, shell origin), opening one on port 0
   * bound to `target.bindHost` ONLY if there is not one already.
   *
   * Idempotent per key, and safe to call concurrently: two callers racing on
   * one key await the same open rather than binding two ports.
   *
   * Throws when the shell origin is not `http:`, or when the bind host is the
   * shell's own hostname (which would put the reviewer's session cookie on
   * the prototype origin — see this module's header).
   */
  ensure(
    deployment: { id: string; slug: string; projectId: string; serve: DeploymentServe },
    target: { bindHost: LoopbackBindHost; shellOrigin: string },
  ): Promise<LoopbackListener>
  /** Marks the listener on this port as used just now. No-op for a dead port. */
  touch(port: number): void
  /** `touch`, keyed by the listener's full origin; the review stream's heartbeat uses this one. */
  touchOrigin(origin: string): void
  /** Closes every listener idle at `now`, and returns how many it closed. */
  reapIdle(now: number, idleMs?: number): Promise<number>
  /** Closes every listener. Idempotent. */
  closeAll(): Promise<void>
  /**
   * Closes every listener pinned to this deployment WITHOUT refusing later
   * opens (codex round 44): the next `ensure` binds a fresh port. The
   * listener is the credential in loopback mode, and a reader whose access
   * was revoked kept the port they already had, since a pinned request
   * skips the project's own read gate. Rotating the port ends that; every
   * reader still allowed gets the new origin from their stream.
   */
  rotateForDeployment(deploymentId: string): Promise<void>
  /**
   * `rotateForDeployment` for every deployment of a project (codex round
   * 46): called from the paths that change who may read the project (its
   * access setting, its member list), since a reader with no stream open,
   * or holding an older deployment's origin, is never seen by a stream's
   * own read gate.
   */
  rotateForProject(projectId: string): Promise<void>
  /**
   * `rotateForDeployment` for every listener there is (codex round 46):
   * called when the instance-wide facts that decide reading change (a
   * member removed or re-roled, public links turned off), where no project
   * can be singled out. Every open review gets its fresh port from its own
   * stream on the next tick.
   */
  rotateAll(): Promise<void>
  /** Whether a listener currently answers on this origin; a stream uses it to notice its origin was rotated away. */
  hasOrigin(origin: string): boolean
  /**
   * Closes every listener pinned to this deployment, on every shell origin.
   * A project delete calls it per deployment (codex round 23): a pinned
   * listener skips the project lookup and serves assets by deployment id,
   * so one left open kept a deleted prototype reachable to anyone who knew
   * the port, for as long as the idle reaper took, and for ever when the
   * asset delete had failed.
   */
  closeForDeployment(deploymentId: string): Promise<void>
  /** Starts the idle reaper on its own unref'd timer. Returns a stop function. */
  startReaper(options?: { intervalMs?: number; idleMs?: number }): () => void
}

export interface LoopbackListenerRegistryDeps {
  /** Builds the Express app for one listener. See `loopback-listener-app.ts`. */
  makeApp: (context: LoopbackListenerAppContext) => express.Express
  /** Idle bound for `reapIdle` and the reaper. Default 30 minutes. */
  idleMs?: number
  /** Injected clock, so idle reaping is testable without real time. */
  now?: () => number
  /**
   * When set, `open()` tries each port in `[from, to]` in order, skipping any
   * already in use, instead of asking the OS for an ephemeral one. `null` (or
   * omitted) keeps the old `listen(0, ...)` behaviour.
   */
  portRange?: { from: number; to: number } | null
  /**
   * Whether `open()` binds every interface (`0.0.0.0`) instead of
   * `target.bindHost`. Default `false`.
   *
   * This is INDEPENDENT of `portRange` being set — see the module header's
   * "Scope, and the one case that binds every interface". A caller passes
   * `true` only when the process is genuinely inside a container
   * (`ViewerConfig.loopbackBindAllInterfaces`); a port range configured by
   * hand on a laptop must not widen the bind, or a private prototype becomes
   * reachable from the LAN on a predictable port.
   */
  bindAllInterfaces?: boolean
}

/** Every port in `VIEWER_LOOPBACK_PORT_RANGE` is bound. Surfaced to the review page by name. */
export class LoopbackPortsExhaustedError extends Error {
  readonly name = "LoopbackPortsExhaustedError"
  constructor(range: { from: number; to: number }) {
    super(`All ${range.to - range.from + 1} loopback prototype ports (${range.from}-${range.to}) are in use`)
  }
}

/**
 * `[::1]` from `::1`; `127.0.0.1` and `localhost` unchanged.
 *
 * The display-spelling INVERSE of `loopbackBindHostFor`
 * (`prototype-origin-resolve.ts`), which strips the same brackets in the
 * other direction. They are not a second copy of the same decision: the
 * registry never decides WHICH loopback address to bind — that choice is
 * `pairedLoopbackHost`'s, made once by the caller before `ensure` is ever
 * called, and handed in as `target.bindHost`. This function only formats
 * whatever bind host it was given for the `Host` header and the origin
 * string; reconciling it with `loopbackBindHostFor` (task 4b) means their
 * outputs agree on the two loopback addresses that occur in practice, not
 * that one calls the other.
 */
function hostSpellingFor(bindHost: LoopbackBindHost): "127.0.0.1" | "[::1]" | "localhost" {
  return bindHost === "::1" ? "[::1]" : bindHost
}

/**
 * The registry key.
 *
 * A JSON array rather than a joined string: neither half is a controlled
 * charset (a deployment id is storage-generated, a shell origin is a URL),
 * and a separator that can appear inside either half is how two distinct keys
 * quietly become one.
 */
function keyFor(deploymentId: string, shellOrigin: string): string {
  return JSON.stringify([deploymentId, shellOrigin])
}

interface MutableListener extends LoopbackListener {
  server: Server
  key: string
  /**
   * How many requests `beginRequest` has opened against this listener that
   * have not yet called their release function. The reaper skips any
   * listener with `inFlight > 0`, whatever `lastUsedAt` says — see
   * `beginRequest` on `LoopbackListenerAppContext`.
   *
   * A counter, not a flag, for the same reason `prototype-processes.ts`'s
   * `Entry.inFlight` is one: more than one request can be open against a
   * listener at once, and it stays protected until the LAST one releases.
   */
  inFlight: number
}

export function createLoopbackListenerRegistry(
  deps: LoopbackListenerRegistryDeps,
): LoopbackListenerRegistry {
  const now = deps.now ?? Date.now
  const defaultIdleMs = deps.idleMs ?? DEFAULT_IDLE_MS

  const listeners = new Map<string, MutableListener>()
  /** In-flight opens, so concurrent `ensure` calls on one key share a socket. */
  const opening = new Map<string, Promise<LoopbackListener>>()
  /** Deployments a delete has closed for good; `ensure` refuses them. Ids are never reused. */
  const closedDeployments = new Set<string>()
  /**
   * What each origin served last and when it was released (codex round 41).
   * With a fixed range the same port comes back around, and a browser keeps
   * an origin's storage past the listener: ports are handed out
   * least-recently-released first, a deployment gets its previous origin
   * back when it is free, and an origin that changes deployment is told so
   * (`recycledOrigin`) so the app can clear what the last one left.
   */
  const originHistory = new Map<string, { deploymentId: string; releasedAt: number }>()
  const originFor = (host: string, port: number): string => `http://${host}:${port}`
  /**
   * Origins a deployment must never answer on again (codex round 45): the
   * ones `rotateForDeployment` closed. A rotation exists because a reader
   * whose access was revoked still knows that origin, so handing it back to
   * the same deployment on the next authorized open would restore exactly
   * the credential the rotation retired. With a fixed range this fails
   * closed once every port has been retired for a deployment.
   */
  const retired = new Map<string, Set<string>>()
  const isRetiredFor = (origin: string, deploymentId: string): boolean => retired.get(origin)?.has(deploymentId) ?? false
  const deploymentOfKey = (key: string): string => (JSON.parse(key) as [string, string])[0]

  /** Retires each listener's origin for its deployment, then closes it. See `rotateForDeployment`. */
  async function retireAndClose(mine: MutableListener[]): Promise<void> {
    for (const listener of mine) {
      // Retired BEFORE the close, so an open racing this rotation cannot
      // land on the origin being retired (codex round 45).
      let ids = retired.get(listener.origin)
      if (ids === undefined) retired.set(listener.origin, (ids = new Set()))
      ids.add(listener.deploymentId)
      await listener.close()
    }
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve())
      // Without this a keep-alive socket the browser is holding open keeps
      // `close()` pending indefinitely, so a reaped listener would linger and
      // a shutdown would hang. Everything a listener serves is a static file
      // the client can simply re-request.
      server.closeAllConnections()
    })
  }

  async function open(
    deployment: { id: string; slug: string; projectId: string; serve: DeploymentServe },
    target: { bindHost: LoopbackBindHost; shellOrigin: string },
    key: string,
  ): Promise<LoopbackListener> {
    const host = hostSpellingFor(target.bindHost)
    const shell = new URL(target.shellOrigin)

    if (shell.protocol !== "http:") {
      throw new Error(
        `A loopback prototype listener cannot be paired with the shell origin ` +
          `"${target.shellOrigin}": its scheme is "${shell.protocol}" and a listener is ` +
          `always http. A browser refuses an http frame inside an https page as mixed ` +
          `content, and it does so silently.`,
      )
    }
    if (shell.hostname.toLowerCase() === host) {
      throw new Error(
        `A loopback prototype listener cannot bind "${host}": that is the same host as the ` +
          `shell origin "${target.shellOrigin}". Cookies are not isolated by port, so the ` +
          `reviewer's session cookie would be sent to the prototype. Bind the other loopback ` +
          `name instead.`,
      )
    }

    // The app cannot be built until the port is known, and the port is not
    // known until the socket is bound — so the server starts with a
    // placeholder handler and adopts the real app the moment it exists. A
    // request cannot slip through the gap and reach the shell: there is no
    // shell here, and the placeholder answers 503 rather than falling
    // through to anything.
    const range = deps.portRange ?? null
    const bindAllInterfaces = deps.bindAllInterfaces ?? false
    if (!bindAllInterfaces && target.bindHost === "localhost") {
      // `localhost` is a NAME, and this branch would pass it to `listen()`.
      // It is only ever a legitimate listener host when the socket is on the
      // wildcard, which is exactly what `bindAllInterfaces` signals — see
      // `pairedLoopbackHost`, which only produces it when told the bind is
      // widened. Two modules reading the same config have to agree for that
      // to hold, so the contradiction is refused here rather than trusted.
      throw new Error(
        `A loopback prototype listener cannot bind "localhost" without bindAllInterfaces. ` +
          `"localhost" is a name a browser may resolve to either address family, so it does not ` +
          `name one origin unless the socket is on every interface, which is what bindAllInterfaces ` +
          `signals. This is a bug in the caller's pairing, not in config.`,
      )
    }
    /**
     * What the socket binds. The loopback address on a laptop; every
     * interface in a container.
     *
     * `bindAllInterfaces` is true exactly when this is a genuinely detected
     * container (see `config.ts`'s `loopbackBindAllInterfaces`), and inside a
     * container `127.0.0.1` is the container's own loopback, which a
     * published port never reaches: Docker DNATs a published port to the
     * container's external interface. So a loopback bind there is
     * unreachable from the host's browser with the range published and
     * without it alike (MEASURED, Task 14, 2026-09-11).
     *
     * This is deliberately NOT keyed on `range` alone any more (codex round 2,
     * item 1): an operator can set `VIEWER_LOOPBACK_PORT_RANGE` by hand on a
     * laptop that is not a container, and widening the bind there would make
     * a private prototype reachable from the LAN on a predictable port with
     * `Host: localhost:<port>` — the loopback boundary this whole mechanism
     * rests on would be gone. A range only ever says WHICH ports to try;
     * `bindAllInterfaces` is the separate, narrower question of which
     * interface, and it comes from the caller having actually detected a
     * container.
     *
     * ## What that costs, stated honestly
     *
     * Inside a container the socket is then on ALL of the container's
     * interfaces, and a listener carries no credential of its own — on a
     * laptop the port WAS the credential, because it was loopback-only and
     * ephemeral, and in a container it is neither.
     *
     * The one-entry Host allowlist (`loopback-listener-app.ts`) pins this
     * listener to exactly one `host:port`, which stops a browser-driven
     * cross-origin request: a browser always sends the `Host` of the URL it
     * was given, so it cannot reach this socket under some other name. It
     * does NOT stop a non-browser client that simply sends the right `Host`
     * itself.
     *
     * What keeps that out of reach is the published port: every documented
     * run line publishes the range to the DOCKER HOST'S LOOPBACK
     * (`-p 127.0.0.1:<from>-<to>:<from>-<to>`), so nothing off the machine
     * can connect at all. What remains is a peer on the same Docker network,
     * and that is the same trust a laptop already extends to another local
     * process — which is what the "loopback boundary" section of
     * `viewer/README.md` says out loud.
     *
     * The cookie-isolation argument at the top of this module is untouched
     * either way: it rests on the HOST SPELLING the browser uses, which is
     * still the paired loopback name, not on which interface the socket
     * listens on.
     */
    const bindAddress: string = bindAllInterfaces ? "0.0.0.0" : target.bindHost

    let app: express.Express | null = null
    const server = createServer((req, res) => {
      if (!app) {
        res.statusCode = 503
        res.end()
        return
      }
      app(req, res)
    })

    const listenOn = (port: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener("listening", onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.removeListener("error", onError)
          resolve()
        }
        server.once("error", onError)
        server.once("listening", onListening)
        server.listen(port, bindAddress)
      })

    if (range === null) {
      // The OS can hand back a port this deployment was rotated off; a few
      // more asks find another, and past that the open fails closed.
      for (let attempt = 0; ; attempt++) {
        await listenOn(0)
        const bound = server.address() as AddressInfo | null
        if (bound === null || typeof bound === "string" || !isRetiredFor(originFor(host, bound.port), deployment.id)) break
        await closeServer(server)
        if (attempt >= 8) throw new Error("Every ephemeral port offered was one this deployment was rotated off.")
      }
    } else {
      // Least-recently-released first, and this deployment's own previous
      // origin before anything else (codex round 41): the range is small,
      // and the longer an origin sits unused before another deployment
      // takes it, the less likely a document from the last one is still
      // open. A port that never served anything comes before every
      // released one.
      const ports: number[] = []
      for (let port = range.from; port <= range.to; port++) {
        if (!isRetiredFor(originFor(host, port), deployment.id)) ports.push(port)
      }
      const rank = (port: number): [number, number] => {
        const previous = originHistory.get(originFor(host, port))
        if (previous === undefined) return [1, port]
        if (previous.deploymentId === deployment.id) return [0, port]
        return [2, previous.releasedAt]
      }
      ports.sort((a, b) => {
        const [ra, ka] = rank(a)
        const [rb, kb] = rank(b)
        return ra - rb || ka - kb || a - b
      })
      let bound = false
      for (const port of ports) {
        try {
          await listenOn(port)
          bound = true
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
        }
      }
      if (!bound) throw new LoopbackPortsExhaustedError(range)
    }

    // A socket error AFTER a successful bind (an ECONNRESET storm, say) is an
    // `error` event with no listener, which Node turns into an uncaught
    // exception and a dead process. One listener that logs is enough.
    server.on("error", (error) => {
      console.error("[viewer] prototype listener error:", error)
    })

    const address = server.address() as AddressInfo | null
    if (!address || typeof address === "string") {
      await closeServer(server)
      throw new Error("A loopback prototype listener bound no address.")
    }

    const origin = `http://${host}:${address.port}`
    try {
      // The same two checks stated once, in the module Task 4 put them in, so
      // a concrete prototype origin can never quietly equal the shell's.
      assertIsolatedOrigins(target.shellOrigin, origin)
    } catch (error) {
      await closeServer(server)
      throw error
    }

    const record: MutableListener = {
      deploymentId: deployment.id,
      projectId: deployment.projectId,
      slug: deployment.slug,
      host,
      port: address.port,
      origin,
      shellOrigin: target.shellOrigin,
      boundAddress: address.address,
      lastUsedAt: now(),
      server,
      key,
      inFlight: 0,
      close: async () => {
        // Dropped from the map FIRST, so a concurrent `ensure` opens a fresh
        // listener rather than handing out one that is closing.
        if (listeners.get(key) === record) listeners.delete(key)
        originHistory.set(origin, { deploymentId: deployment.id, releasedAt: now() })
        await closeServer(server)
      },
    }
    // The browser's memory of this origin outlives the Viewer's own (codex
    // rounds 42 and 44): a port first used in THIS process may have served
    // another deployment before a restart, whether the range is fixed or
    // the OS handed `listen(0)` a number it handed out before. So the first
    // use of any origin in a process counts as recycled; only a deployment
    // coming back to the origin this process saw it on does not.
    const previous = originHistory.get(origin)
    const recycledOrigin = previous === undefined || previous.deploymentId !== deployment.id

    try {
      app = deps.makeApp({
        deploymentId: deployment.id,
        slug: deployment.slug,
        serve: deployment.serve,
        hostPort: `${host}:${address.port}`,
        shellOrigin: target.shellOrigin,
        recycledOrigin,
        touch: () => {
          record.lastUsedAt = now()
        },
        beginRequest: () => {
          record.inFlight++
          let released = false
          return () => {
            // Idempotent, same reason as `prototype-processes.ts`'s
            // `beginRequest`: `res.once("close", release)` fires at most
            // once, but a caller that also invokes the returned function
            // directly must not double-decrement.
            if (released) return
            released = true
            record.inFlight--
            record.lastUsedAt = now()
          }
        },
      })
    } catch (error) {
      // The socket is already bound at this point. Without this it would sit
      // there listening, answering 503 forever, owned by nobody.
      await closeServer(server)
      throw error
    }

    listeners.set(key, record)
    return record
  }

  /**
   * Declared as a plain function, not only as a method on the returned
   * object, because the reaper's timer callback calls it. A `this.reapIdle(…)`
   * there would depend on the caller never destructuring the registry, which
   * is a rule nothing enforces.
   */
  async function reapIdle(at: number, idleMs?: number): Promise<number> {
    const bound = idleMs ?? defaultIdleMs
    // `inFlight > 0` is checked here too, not only in the re-check below: a
    // listener with an open response (an SSE stream, say) must never be
    // scheduled for closing in the first place, whatever `lastUsedAt` says
    // (codex round 7, Fix 3 — mirrors `prototype-processes.ts`'s own
    // `startReaper`).
    const stale = [...listeners.values()].filter(
      (listener) => listener.inFlight === 0 && listener.lastUsedAt + bound <= at,
    )
    // Sequential, not `Promise.all`: `close()` mutates `listeners`, and there
    // are only ever a handful of these.
    //
    // A listener in this snapshot can still receive a request between the
    // filter above and its own turn in this loop — the `await` on the
    // previous iteration's `close()` is exactly the gap a request needs.
    // That request calls `touch()`, which bumps `lastUsedAt` on the SAME
    // record this loop is about to close, so re-reading `lastUsedAt` (and
    // `inFlight`) right before closing (rather than trusting the values
    // captured by the filter) is what keeps an active review from being
    // interrupted.
    let closed = 0
    for (const listener of stale) {
      if (listener.inFlight === 0 && listener.lastUsedAt + bound <= at) {
        await listener.close()
        closed++
      }
    }
    return closed
  }

  return {
    async ensure(deployment, target) {
      if (closedDeployments.has(deployment.id)) {
        throw new Error("This deployment was deleted; no listener will be opened for it.")
      }
      const key = keyFor(deployment.id, target.shellOrigin)

      const existing = listeners.get(key)
      if (existing) {
        // The bind host is NOT part of the key, because it is derived from
        // the shell origin (`pairedLoopbackHost`) and so cannot vary
        // independently of it. That is an assumption about a caller this
        // module does not control, so it is checked rather than trusted: a
        // silent mismatch would hand back an origin on a host the caller did
        // not ask for, which is precisely the host-flip property this whole
        // mechanism rests on.
        const wanted = hostSpellingFor(target.bindHost)
        if (existing.host !== wanted) {
          throw new Error(
            `A prototype listener for deployment ${deployment.id} and shell origin ` +
              `"${target.shellOrigin}" is already bound to ${existing.host}, but ${wanted} was ` +
              `asked for. The bind host must be a function of the shell origin.`,
          )
        }
        // Asking for the origin is itself use — the review page is about to
        // frame it.
        existing.lastUsedAt = now()
        return existing
      }

      const inFlight = opening.get(key)
      if (inFlight) return inFlight

      const pending = open(deployment, target, key).finally(() => {
        // Always cleared, including on rejection: a failed open must not be
        // remembered as the answer for this key forever.
        opening.delete(key)
      })
      opening.set(key, pending)
      return pending
    },

    touch(port) {
      for (const listener of listeners.values()) {
        if (listener.port === port) {
          listener.lastUsedAt = now()
          return
        }
      }
    },
    touchOrigin(origin) {
      // By the whole origin, not the port: with a fixed range on a laptop a
      // `127.0.0.1` listener and a `[::1]` listener can share a port number,
      // and touching by number kept the wrong one alive while the one the
      // page used was reaped (codex round 27).
      for (const listener of listeners.values()) {
        if (listener.origin === origin) {
          listener.lastUsedAt = now()
          return
        }
      }
    },

    reapIdle,

    async closeAll() {
      // Snapshot first: `close()` mutates the map it is iterating.
      const all = [...listeners.values()]
      for (const listener of all) await listener.close()
    },
    async rotateForDeployment(deploymentId) {
      const pending = [...opening].filter(([key]) => deploymentOfKey(key) === deploymentId).map(([, p]) => p)
      for (const p of pending) await p.catch(() => {})
      await retireAndClose([...listeners.values()].filter((listener) => listener.deploymentId === deploymentId))
    },
    async rotateForProject(projectId) {
      // Every open, not only this project's: a key names a deployment, not
      // a project, and the listener it produces says which project once it
      // exists.
      for (const p of [...opening.values()]) await p.catch(() => {})
      await retireAndClose([...listeners.values()].filter((listener) => listener.projectId === projectId))
    },
    async rotateAll() {
      for (const p of [...opening.values()]) await p.catch(() => {})
      await retireAndClose([...listeners.values()])
    },
    hasOrigin(origin) {
      for (const listener of listeners.values()) if (listener.origin === origin) return true
      return false
    },
    async closeForDeployment(deploymentId) {
      // Marked first, so an `ensure` that arrives from here on is refused
      // rather than opening a listener the delete has already swept. Then
      // any open still in flight for this deployment is awaited, so the
      // listener it produces is in the map by the time the sweep below
      // runs (codex round 24: the snapshot alone missed it, and a pinned
      // listener serves by deployment id with no project lookup).
      closedDeployments.add(deploymentId)
      const pending = [...opening].filter(([key]) => deploymentOfKey(key) === deploymentId).map(([, p]) => p)
      for (const p of pending) await p.catch(() => {})
      const mine = [...listeners.values()].filter((listener) => listener.deploymentId === deploymentId)
      for (const listener of mine) await listener.close()
    },

    startReaper(options = {}) {
      const intervalMs = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS
      const idleMs = options.idleMs ?? defaultIdleMs
      const timer = setInterval(() => {
        // Its own `.catch` as well as being an async function: an unhandled
        // rejection inside a `setInterval` callback takes the whole process
        // down on Node >= 15.
        void reapIdle(now(), idleMs).catch((error: unknown) => {
          console.error("[viewer] prototype listener reap failed:", error)
        })
      }, intervalMs)
      // Never a reason to keep the process alive. A viewer with nothing left
      // to do should exit.
      timer.unref()
      return () => clearInterval(timer)
    },

    isPrototypeHost(hostHeader) {
      for (const listener of listeners.values()) {
        if (`${listener.host}:${listener.port}` === hostHeader) return true
      }
      return false
    },
  }
}

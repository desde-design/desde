import type express from "express"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { assertIsolatedOrigins } from "./prototype-origin-resolve"
import type { PrototypeHostRegistry } from "./prototype-host-scope"

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
 * ## Scope
 *
 * This is a local-machine facility. `listen` is only ever given `127.0.0.1`
 * or `::1` — never `0.0.0.0`, and never `localhost`, which may resolve to
 * both families and so does not name one origin.
 */

/** The literal addresses a listener may bind. Never `0.0.0.0`, never a name. */
export type LoopbackBindHost = "127.0.0.1" | "::1"

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
  /** The `Host` and URL spelling: `127.0.0.1`, or `[::1]` with brackets. */
  host: "127.0.0.1" | "[::1]"
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
  /** The one acceptable `Host` value: `127.0.0.1:45001` or `[::1]:45001`. */
  hostPort: string
  shellOrigin: string
  /** Called on every request the listener serves. */
  touch: () => void
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
    deployment: { id: string; slug: string; projectId: string },
    target: { bindHost: LoopbackBindHost; shellOrigin: string },
  ): Promise<LoopbackListener>
  /** Marks the listener on this port as used just now. No-op for a dead port. */
  touch(port: number): void
  /** Closes every listener idle at `now`, and returns how many it closed. */
  reapIdle(now: number, idleMs?: number): Promise<number>
  /** Closes every listener. Idempotent. */
  closeAll(): Promise<void>
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
}

/**
 * `[::1]` from `::1`; `127.0.0.1` unchanged.
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
function hostSpellingFor(bindHost: LoopbackBindHost): "127.0.0.1" | "[::1]" {
  return bindHost === "::1" ? "[::1]" : "127.0.0.1"
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
}

export function createLoopbackListenerRegistry(
  deps: LoopbackListenerRegistryDeps,
): LoopbackListenerRegistry {
  const now = deps.now ?? Date.now
  const defaultIdleMs = deps.idleMs ?? DEFAULT_IDLE_MS

  const listeners = new Map<string, MutableListener>()
  /** In-flight opens, so concurrent `ensure` calls on one key share a socket. */
  const opening = new Map<string, Promise<LoopbackListener>>()

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
    deployment: { id: string; slug: string; projectId: string },
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
    let app: express.Express | null = null
    const server = createServer((req, res) => {
      if (!app) {
        res.statusCode = 503
        res.end()
        return
      }
      app(req, res)
    })

    await new Promise<void>((resolve, reject) => {
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
      server.listen(0, target.bindHost)
    })

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
      close: async () => {
        // Dropped from the map FIRST, so a concurrent `ensure` opens a fresh
        // listener rather than handing out one that is closing.
        if (listeners.get(key) === record) listeners.delete(key)
        await closeServer(server)
      },
    }

    try {
      app = deps.makeApp({
        deploymentId: deployment.id,
        slug: deployment.slug,
        hostPort: `${host}:${address.port}`,
        shellOrigin: target.shellOrigin,
        touch: () => {
          record.lastUsedAt = now()
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
    const stale = [...listeners.values()].filter((listener) => listener.lastUsedAt + bound <= at)
    // Sequential, not `Promise.all`: `close()` mutates `listeners`, and there
    // are only ever a handful of these.
    //
    // A listener in this snapshot can still receive a request between the
    // filter above and its own turn in this loop — the `await` on the
    // previous iteration's `close()` is exactly the gap a request needs.
    // That request calls `touch()`, which bumps `lastUsedAt` on the SAME
    // record this loop is about to close, so re-reading `lastUsedAt` right
    // before closing (rather than trusting the value captured by the
    // filter) is what keeps an active review from being interrupted.
    let closed = 0
    for (const listener of stale) {
      if (listener.lastUsedAt + bound <= at) {
        await listener.close()
        closed++
      }
    }
    return closed
  }

  return {
    async ensure(deployment, target) {
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

    reapIdle,

    async closeAll() {
      // Snapshot first: `close()` mutates the map it is iterating.
      const all = [...listeners.values()]
      for (const listener of all) await listener.close()
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

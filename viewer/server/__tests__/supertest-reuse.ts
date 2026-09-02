/**
 * Drop-in replacement for `supertest` that reuses ONE listening server per app.
 *
 * ## Why
 *
 * Stock `request(app)` binds a fresh ephemeral port, issues one request, and
 * tears the server down — every call. Across ~460 call sites that is thousands
 * of listeners per run, and port reuse racing with server teardown made the
 * suite fail roughly one run in six, always transport-level and never in
 * isolation: `socket hang up`, `Parse Error: Expected HTTP/`, a plain GET
 * answering 400, a body missing a field the route always sets. Instrumenting
 * the app's own error handler proved those 400s were never real responses —
 * the client had reached a different server than the one it meant to.
 *
 * Reusing one listening server per app removes the churn at its source. It is
 * also what supertest's own docs recommend for repeated requests.
 *
 * ## How
 *
 * `request(app)` is synchronous, but binding a port is not — and handing
 * supertest a not-yet-listening server makes it call `listen()` itself and then
 * CLOSE it after the response, which is the behaviour we're trying to avoid.
 * So the returned object records the chained calls (`.get(url).set(h).send(b)
 * .expect(200)`) and replays them against the real supertest Test once the
 * server is listening. Everything after the first `await` behaves exactly as
 * before, because it IS the real Test.
 *
 * Servers are memoized per app object and closed by `close-servers.ts` in an
 * `afterAll`, so each test file cleans up its own.
 */

// Imported by a path that does NOT match the `^supertest$` alias, or this
// module would resolve to itself.
import realRequest from "supertest/index.js"
import type { Server } from "node:http"

type AnyApp = Parameters<typeof realRequest>[0]

/** Listening server per app, plus the in-flight bind so concurrent callers share one. */
const servers = new WeakMap<object, Promise<Server>>()

/** Every server this worker opened, so the afterAll hook can close them. */
export const openServers = new Set<Server>()

function ensureListening(app: AnyApp): Promise<Server> {
  const key = app as unknown as object
  const existing = servers.get(key)
  if (existing) return existing

  const pending = new Promise<Server>((resolve, reject) => {
    // `app.listen` exists on an express app and on an http.Server alike.
    const server = (app as unknown as { listen: (p: number) => Server }).listen(0)
    openServers.add(server)
    server.once("listening", () => resolve(server))
    server.once("error", reject)
  })
  servers.set(key, pending)
  return pending
}

/** A chained call recorded before the server was ready. */
type Step = { method: string; args: unknown[] }

function deferredTest(
  serverPromise: Promise<Server>,
  first: Step,
): Record<string, unknown> {
  const steps: Step[] = [first]

  const run = async (): Promise<unknown> => {
    const server = await serverPromise
    const [head, ...rest] = steps
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let test: any = (realRequest(server) as any)[head.method](...head.args)
    for (const step of rest) test = test[step.method](...step.args)
    return await test
  }

  // Lazily started so a chain that is never awaited never fires a request —
  // matching stock supertest, where the request goes out on `.end()`/`await`.
  let started: Promise<unknown> | undefined
  const start = (): Promise<unknown> => (started ??= run())

  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (prop === "then") {
          return (onOk: unknown, onErr: unknown) =>
            (start() as Promise<unknown>).then(
              onOk as never,
              onErr as never,
            )
        }
        if (prop === "catch") {
          return (onErr: unknown) => (start() as Promise<unknown>).catch(onErr as never)
        }
        if (prop === "finally") {
          return (onEnd: unknown) => (start() as Promise<unknown>).finally(onEnd as never)
        }
        // `.end(cb)` is supertest's callback terminal.
        if (prop === "end") {
          return (cb: (err: unknown, res: unknown) => void) => {
            start().then(
              (res) => cb(null, res),
              (err) => cb(err, undefined),
            )
            return proxy
          }
        }
        // Any other property is a chainable builder (`get`, `set`, `send`,
        // `expect`, `query`, `attach`, `auth`, …) — record and keep chaining.
        return (...args: unknown[]) => {
          steps.push({ method: String(prop), args })
          return proxy
        }
      },
    },
  )
  return proxy
}

/**
 * Same signature as `supertest`'s default export. Returns a chainable object
 * that behaves like a `Test` from the first verb call onward.
 */
export default function request(app: AnyApp): Record<string, unknown> {
  const serverPromise = ensureListening(app)
  return new Proxy(
    {},
    {
      get(_target, verb: string | symbol) {
        return (...args: unknown[]) =>
          deferredTest(serverPromise, { method: String(verb), args })
      },
    },
  ) as Record<string, unknown>
}

/** Re-exported so `import { agent } from "supertest"` keeps working if used. */
export const agent = (realRequest as unknown as { agent: unknown }).agent

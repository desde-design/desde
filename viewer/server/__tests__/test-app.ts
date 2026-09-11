import type { Express } from "express"
import { createApp as createRealApp, type AppDeps as RealAppDeps } from "../create-app"
import { createLoopbackListenerApp } from "../serve/loopback-listener-app"
import {
  createLoopbackListenerRegistry,
  type LoopbackListenerRegistry,
} from "../serve/loopback-listeners"
import { PrototypeProcessError, type PrototypeProcesses } from "../serve/prototype-processes"

/**
 * `AppDeps` with `prototypeListeners` made OPTIONAL.
 *
 * The real field is required on purpose (see its doc comment in
 * `create-app.ts`): there must be one listener registry per process, and a
 * required field is what forces the real boot to pass the one it holds. A
 * test app has no such hazard — nearly every suite never touches a prototype
 * origin at all, and a registry that is never asked for a listener binds
 * nothing. So the factory below fills one in, and the ~20 suites that build
 * `AppDeps` need no edit.
 *
 * A test that DOES exercise the prototype-origin route should build its own
 * with `createTestPrototypeListeners` and pass it here, so it can close the
 * listeners it opened.
 */
export type AppDeps = Omit<RealAppDeps, "prototypeListeners" | "prototypeProcesses"> & {
  prototypeListeners?: LoopbackListenerRegistry
  prototypeProcesses?: PrototypeProcesses
}

/**
 * A `PrototypeProcesses` that starts nothing.
 *
 * The real field is required on `AppDeps` (see its doc comment in
 * `create-app.ts`) so the one boot path cannot forget to pass the process's
 * single manager. A test app has no such hazard: a suite that never serves a
 * `serve: "server"` deployment never reaches the fork at all, and one that
 * does should pass a fake of its own so it can assert on it.
 *
 * `ensure` REJECTS rather than returning a port. A fake that quietly succeeded
 * would let a router bug — forking on a static deployment — pass as a 502
 * somewhere unrelated instead of failing where it happened.
 */
export function nullPrototypeProcesses(): PrototypeProcesses {
  return {
    ensure: () =>
      Promise.reject(
        new PrototypeProcessError({ state: "stopped" }, "No prototype process manager in this test."),
      ),
    touch: () => {},
    beginRequest: () => () => {},
    stop: () => Promise.resolve(),
    forget: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    markUnreachable: () => Promise.resolve(),
    status: () => ({ state: "stopped" }),
    serverLog: () => "",
    startReaper: () => () => {},
    shutdown: () => Promise.resolve(),
  }
}

/**
 * A real listener registry over a test's own in-memory fixtures.
 *
 * Constructing one opens no socket — `ensure` is what binds, and only the
 * prototype-origin route calls it. **Every listener a test opens must be
 * closed** (`registry.closeAll()` in `afterEach`): a listener is a real
 * `http.Server` holding a real port, and one left open keeps a handle alive
 * and hangs the run.
 */
export function createTestPrototypeListeners(
  deps: Pick<
    AppDeps,
    "storage" | "assets" | "config" | "bridgeScript" | "bridgeVersion" | "prototypeProcesses"
  >,
): LoopbackListenerRegistry {
  return createLoopbackListenerRegistry({
    makeApp: (context) =>
      createLoopbackListenerApp({
        ...context,
        storage: deps.storage,
        assets: deps.assets,
        config: deps.config,
        bridgeScript: deps.bridgeScript,
        // Same default `createApp` uses for the shell's serve router.
        bridgeVersion: deps.bridgeVersion ?? "dev",
        prototypeCsp: deps.config.prototypeCsp,
        prototypeProcesses: deps.prototypeProcesses ?? nullPrototypeProcesses(),
      }),
  })
}

/**
 * `createApp` for tests. Same function, one relaxation.
 *
 * ## Why this exists
 *
 * `create-app.ts` now mounts a closed Host allowlist first (see
 * `server/serve/host-allowlist.ts`), and supertest binds an ephemeral port
 * per app — so every request it issues carries `Host: 127.0.0.1:<random>`.
 * No allowlist built from a config's `publicUrl` can contain that, and most
 * suites configure a `publicUrl` of `https://viewer.example.com` anyway. The
 * whole suite would 400 before reaching a single route.
 *
 * So the test factory sets `allowAnyLoopbackPort`, which accepts any
 * loopback name on any numeric port and NOTHING else. A test that sets an
 * explicit `Host` is still judged normally: `subdomain.test.ts` passes
 * because its hosts are real prototype subdomains, and
 * `host-allowlist.test.ts` can still prove `evil.com` is refused.
 *
 * ## Why it is exported under the production name
 *
 * Every suite imports `createApp`, and `no-per-test-app-construction.test.ts`
 * hunts for `createApp(` call sites to keep the suite to one listening server
 * per file. Renaming the call sites would have made that guard blind to all
 * of them. The import PATH is what tells a reader which one they are looking
 * at, and it is the first thing in the file.
 *
 * The production boot path is unaffected: `server/index.ts` imports the real
 * `create-app.ts` and asserts the relaxation is absent
 * (`assertNoTestHostRelaxation`).
 */
export function createApp(deps: AppDeps): Express {
  // Resolved ONCE and given to both the app and the listener registry it
  // builds, mirroring the real boot: one manager per process, so a deployment
  // opened on the shell and on its listener shares a single child.
  const prototypeProcesses = deps.prototypeProcesses ?? nullPrototypeProcesses()
  return createRealApp({
    ...deps,
    prototypeProcesses,
    prototypeListeners:
      deps.prototypeListeners ?? createTestPrototypeListeners({ ...deps, prototypeProcesses }),
    allowAnyLoopbackPort: true,
  })
}

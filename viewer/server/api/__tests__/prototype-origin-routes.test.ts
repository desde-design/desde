/**
 * `GET /api/v1/projects/:id/prototype-origin` — the route the review page
 * calls to learn which origin to embed a prototype from.
 *
 * ## Why these tests set `Host` and `X-Viewer-Shell-Origin` by hand
 *
 * Supertest binds an ephemeral port per app, so the `Host` it sends is
 * `127.0.0.1:<random>` — which is exactly the shape the REAL caller sends too
 * (the review page reaches this route over an internal hop to
 * `http://127.0.0.1:<config.port>`). That is the whole reason the route takes
 * the reviewer's own shell origin from a header instead of deriving it from
 * `Host`: the hop's Host never names the spelling the reviewer typed.
 *
 * ## Every listener opened here is closed in `afterEach`
 *
 * A listener is a real `http.Server` on a real ephemeral port. One left open
 * keeps a handle alive and hangs the run.
 */
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, createTestPrototypeListeners, type AppDeps } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { ALLOW_PUBLIC_LINKS_KEY, invalidateInstanceSettingsCache } from "../../instance-settings"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { AssetStore, StoredAsset } from "../../assets/types"
import type { ViewerConfig } from "../../config"
import { LoopbackPortsExhaustedError, type LoopbackListenerRegistry } from "../../serve/loopback-listeners"
import type { PrototypeProcesses, ProcessStatus } from "../../serve/prototype-processes"
import type { Project } from "../../storage/types"

const SHELL_ORIGIN_HEADER = "X-Viewer-Shell-Origin"

/** deploymentId → relPath → bytes. Enough for one `index.html`. */
function assetsFor(files: Record<string, Record<string, string>>): AssetStore {
  return {
    async put() {},
    async get(deploymentId: string, relPath: string): Promise<StoredAsset | null> {
      const body = files[deploymentId]?.[relPath]
      return body === undefined ? null : { body: Buffer.from(body), contentType: "text/html" }
    },
    async deleteDeployment() {},
  }
}

const baseConfig: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  dataDir: ".tmp",
  publicUrl: "http://localhost:3100",
  adminToken: "test-token",
  serveDomain: null,
  devBundler: "turbopack",
  email: null,
  emailSource: null,
  unsubscribeSecret: null,
  sessionSecret: "test-session-secret",
  githubAuth: null,
  githubApp: null,
  prototypeCsp: null,
  prototypeOrigin: null,
  allowedEmailDomains: null,
  seedDemoProject: false,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
  loopbackPortRange: null,
  loopbackBindAllInterfaces: false,
  loopbackBindNetworkUnrecognized: false,
  loopbackBind: "auto",
  loopbackInContainer: false,
}

/** A laptop: the shell is reached on a loopback name, no serve domain. */
const loopbackConfig = baseConfig

/**
 * A deployment with `VIEWER_LOOPBACK_LISTENERS=off`: same publicUrl as
 * `loopbackConfig`, but `loopbackAvailable: false` — the Docker/remote
 * follow-up this task adds.
 *
 * `auto` inside a container is NOT this case any more (task 4,
 * VIEWER_LOOPBACK_PORT_RANGE): a container now gets a default port range, so
 * `loopbackAvailable` is `true` there, not `false`. Only the explicit `off`
 * mode still forces it false, which is why `loopbackListeners` is set here
 * too, not just `loopbackAvailable` — the two must describe one real
 * configuration, not just happen to produce the same boolean.
 */
const containerConfig: ViewerConfig = {
  ...baseConfig,
  loopbackListeners: "off",
  loopbackAvailable: false,
}

/** A deployed instance with wildcard DNS. */
const subdomainConfig: ViewerConfig = {
  ...baseConfig,
  publicUrl: "https://viewer.example.com",
  serveDomain: "desde.test",
}

/** A deployed instance with no serve domain: shell and prototype share an origin. */
const fallbackConfig: ViewerConfig = {
  ...baseConfig,
  publicUrl: "https://viewer.example.com",
}

/**
 * A deployed instance with `VIEWER_PROTOTYPE_ORIGIN` set: one alternate origin
 * serves ALL prototypes, cross-origin from the shell. Cross-site with the
 * shell (`example.net` vs `example.com`), as the boot refusal requires.
 */
const prototypeOriginConfig: ViewerConfig = {
  ...baseConfig,
  publicUrl: "https://viewer.example.com",
  prototypeOrigin: "https://proto.example.net",
}

const auth = { Authorization: "Bearer test-token" }

/**
 * What the stand-in registry's `ensure` rejects with.
 *
 * Deliberately carries BOTH a shell origin and a live-looking ephemeral port,
 * because the real failures do: `loopback-listeners.ts` interpolates
 * `target.shellOrigin` into its non-http and same-host refusals, the deployment
 * id into its bind-host mismatch, and `assertIsolatedOrigins` — which runs
 * after the socket is bound — interpolates both origins, port included. The log
 * assertion below is only worth anything if the fixture contains the things the
 * rule forbids.
 */
const ENSURE_FAILURE = "bind failed for http://localhost:3100 on http://127.0.0.1:45001"

/**
 * A registry whose `ensure` always rejects.
 *
 * It does two jobs. It stands in for a listener that cannot be opened (the 503
 * case) — and, more usefully, it is what makes the "opens no listener" tests
 * capable of failing at all.
 *
 * The first version of those tests asserted `isPrototypeHost("127.0.0.1:0")`,
 * which proved nothing: an ephemeral bind never lands on port 0 or 1, so the
 * assertion held whether or not `ensure` had been called. With this registry
 * installed, reaching `ensure` turns the response into a 503, so the EXPECTED
 * STATUS is the assertion, and it fails the moment the route opens a listener
 * it should not have.
 */
function refusingListeners(): LoopbackListenerRegistry {
  return {
    ensure: () => Promise.reject(new Error(ENSURE_FAILURE)),
    touch: () => {},
    reapIdle: () => Promise.resolve(0),
    closeAll: () => Promise.resolve(),
    closeForDeployment: () => Promise.resolve(),
    startReaper: () => () => {},
    isPrototypeHost: () => false,
  }
}

/**
 * A `PrototypeProcesses` whose `subscribe` is real enough to drive from a
 * test: it keeps every live listener in a `Map<deploymentId, Set<listener>>`
 * and exposes `emit` to fire one by hand. `subscribers` is asserted on
 * directly (task 6, test (e)) rather than inferred from a callback count, so
 * "unsubscribed" means the set is actually empty, not just "stopped being
 * called yet".
 */
interface FakePrototypeProcesses extends PrototypeProcesses {
  subscribers: Map<string, Set<(status: ProcessStatus) => void>>
  emit(deploymentId: string, status: ProcessStatus): void
  /**
   * Changes what `status()` answers WITHOUT firing a subscriber, which is
   * the real manager's own behaviour for `retryable`: it is computed when
   * the status is read, so a spent restart budget ages back into a retryable
   * one with no event to notify on.
   */
  setStatus(deploymentId: string, status: ProcessStatus): void
}

function fakePrototypeProcesses(): FakePrototypeProcesses {
  const subscribers = new Map<string, Set<(status: ProcessStatus) => void>>()
  const statusFor = new Map<string, ProcessStatus>()
  return {
    ensure: () => Promise.reject(new Error("not used by this route")),
    touch: () => {},
    withLease: (_id, fn) => fn(),
    stop: () => Promise.resolve(),
    forget: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    markUnreachable: () => Promise.resolve(),
    status: (id) => statusFor.get(id) ?? { state: "stopped" },
    subscribe(id, listener) {
      let set = subscribers.get(id)
      if (!set) {
        set = new Set()
        subscribers.set(id, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
        if (set?.size === 0) subscribers.delete(id)
      }
    },
    serverLog: () => "",
    startReaper: () => () => {},
    recordCount: () => 0,
    shutdown: () => Promise.resolve(),
    subscribers,
    emit(id, status) {
      statusFor.set(id, status)
      for (const listener of subscribers.get(id) ?? []) listener(status)
    },
    setStatus(id, status) {
      statusFor.set(id, status)
    },
  }
}

/** A server deployment, which is what gives the stream a process to follow. */
async function makeServerDeployment(ctx: Ctx, project: Project): Promise<string> {
  const deploymentId = project.activeDeploymentId as string
  await ctx.storage.updateDeployment(deploymentId, {
    serve: "server",
    serverStart: ["node", "server.js"],
  })
  return deploymentId
}

/** ONE stable app object for this whole file — see `__tests__/swappable-app.ts`. */
const stable = createSwappableApp()

interface Ctx {
  storage: InMemoryStorage
  listeners: LoopbackListenerRegistry
  app: ReturnType<typeof createApp>
}

/** Every registry any test in this file created, closed in `afterEach`. */
const openRegistries: LoopbackListenerRegistry[] = []

function setup(
  overrides: Partial<AppDeps> = {},
  files: Record<string, Record<string, string>> = {},
): Ctx {
  const storage = new InMemoryStorage()
  const deps: AppDeps = {
    storage,
    assets: assetsFor(files),
    config: loopbackConfig,
    bridgeScript: "// bridge",
    bridgeVersion: "test-bridge",
    github: testGithubRuntime(),
    ...overrides,
  }
  const listeners = deps.prototypeListeners ?? createTestPrototypeListeners(deps)
  openRegistries.push(listeners)
  stable.use(createApp({ ...deps, prototypeListeners: listeners }))
  return { storage: deps.storage as InMemoryStorage, listeners, app: stable.app }
}

/** A project with a live active deployment. */
async function seedProject(
  storage: InMemoryStorage,
  opts: { slug?: string; access?: Project["access"]; withDeployment?: boolean } = {},
): Promise<Project> {
  const project = await storage.createProject({
    slug: opts.slug ?? "acme",
    name: "Acme",
    access: opts.access ?? "all-members",
  })
  if (opts.withDeployment === false) return project
  const deployment = await storage.createDeployment({ projectId: project.id, status: "deployed" })
  return await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
}

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) await registry.closeAll()
  vi.restoreAllMocks()
})

describe("GET /projects/:id/prototype-origin", () => {
  describe("loopback mode", () => {
    let ctx: Ctx

    beforeEach(() => {
      ctx = setup()
    })

    it("pairs a `localhost` shell with a prototype listener on 127.0.0.1", async () => {
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body.mode).toBe("loopback")
      expect(res.body.capabilityRequired).toBe(false)
      const origin = new URL(res.body.origin as string)
      expect(origin.protocol).toBe("http:")
      expect(origin.hostname).toBe("127.0.0.1")
      expect(Number(origin.port)).toBeGreaterThan(0)
      // The port names a listener this registry actually holds — not just a
      // plausible-looking string.
      expect(ctx.listeners.isPrototypeHost(`127.0.0.1:${origin.port}`)).toBe(true)
    })

    it("answers the same origin for the same project twice", async () => {
      const project = await seedProject(ctx.storage)
      const call = () =>
        request(ctx.app)
          .get(`/api/v1/projects/${project.id}/prototype-origin`)
          .set(auth)
          .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
          .expect(200)

      const first = await call()
      const second = await call()
      expect(second.body.origin).toBe(first.body.origin)
    })

    // NEEDS IPv6 LOOPBACK. Task 4b pairs the two numeric addresses with each
    // other, so a `127.0.0.1` shell means the listener binds `::1`. On a host
    // with IPv6 loopback disabled the bind fails and this comes back 503.
    it("pairs a `127.0.0.1` shell with a DIFFERENT listener, on [::1]", async () => {
      const project = await seedProject(ctx.storage)

      const onLocalhost = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      const onNumeric = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://127.0.0.1:3100")
        .expect(200)

      expect(new URL(onNumeric.body.origin as string).hostname).toBe("[::1]")
      expect(onNumeric.body.origin).not.toBe(onLocalhost.body.origin)
    })

    it("derives the shell origin from the request Host when the header is absent", async () => {
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set("Host", "localhost:3100")
        .expect(200)

      expect(res.body.mode).toBe("loopback")
      expect(new URL(res.body.origin as string).hostname).toBe("127.0.0.1")
    })

    it("answers origin: null with reason no-deployment when nothing is built yet", async () => {
      const project = await seedProject(ctx.storage, { withDeployment: false })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body).toEqual({
        mode: "loopback",
        origin: null,
        capabilityRequired: false,
        reason: "no-deployment",
        serve: "static",
        range: null,
        // Stated on both loopback shapes, so the field describes the MODE
        // rather than this one answer. Nothing probes it here: there is no
        // origin yet to probe.
        bridgeAssetPath: "__desde/bridge-test-bridge.js",
      })
    })

    it("carries serve: \"static\" and no process field for a static deployment", async () => {
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body.serve).toBe("static")
      expect(res.body.process).toBeUndefined()
    })

    it("carries serve: \"server\" and the process status for a server deployment", async () => {
      const project = await seedProject(ctx.storage)
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body.serve).toBe("server")
      // The fake process manager `test-app.ts` installs by default
      // (`nullPrototypeProcesses`) never started anything for this id, so
      // its `status` answers "stopped" — proving the field is really wired
      // to `deps.prototypeProcesses.status`, not a hardcoded value.
      expect(res.body.process).toEqual({ state: "stopped" })
    })

    it("names the active deployment the answer was computed against", async () => {
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      // The page compares this against the one the live stream sends, which
      // is how it notices a rebuild it has to re-render for.
      expect(res.body.deploymentId).toBe(project.activeDeploymentId)
    })

    it("carries the configured loopback port range", async () => {
      const withRange = setup({
        config: { ...loopbackConfig, loopbackPortRange: { from: 4100, to: 4110 } },
      })
      const project = await seedProject(withRange.storage)

      const res = await request(withRange.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body.range).toEqual({ from: 4100, to: 4110 })
    })

    it("opens no listener for a project with no active deployment", async () => {
      // A registry that refuses to open anything: if the route reached
      // `ensure` this would be a 503, so the 200 IS the assertion. See
      // `refusingListeners`.
      const refusing = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(refusing.storage, { withDeployment: false })
      const res = await request(refusing.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)
      expect(res.body.reason).toBe("no-deployment")
    })

    it("sets Cache-Control: no-store", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)
      expect(res.headers["cache-control"]).toBe("no-store")
    })
  })

  describe("the listener the route opens actually serves the prototype", () => {
    it("serves the pinned deployment at the returned origin", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const deployment = await storage.createDeployment({
        projectId: project.id,
        status: "deployed",
      })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      const ctx = setup(
        { storage },
        { [deployment.id]: { "index.html": "<!doctype html><title>acme</title>" } },
      )

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      const served = await fetch(`${res.body.origin as string}/`)
      expect(served.status).toBe(200)
      expect(await served.text()).toContain("<title>acme</title>")
    })
  })

  describe("the X-Viewer-Shell-Origin header is validated against a closed set", () => {
    let ctx: Ctx

    beforeEach(() => {
      ctx = setup()
    })

    it("refuses an origin outside the set with a constant body", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://evil.com:3100")
        .expect(400)
      expect(res.body).toEqual({ error: "Unexpected shell origin" })
    })

    it("never echoes the rejected value", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://evil.com:3100")
        .expect(400)
      expect(res.text).not.toContain("evil.com")
    })

    it("refuses an unparseable header with the same body", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "not a url")
        .expect(400)
      expect(res.body).toEqual({ error: "Unexpected shell origin" })
    })

    /**
     * The classic origin-confusion form: everything before the `@` is
     * USERINFO, so this names `evil.com`, not `localhost`. A comparison
     * written as a prefix or substring test would admit it; parsing and
     * comparing the origin is what does not.
     */
    it("refuses an acceptable origin smuggled into the userinfo half", async () => {
      const project = await seedProject(ctx.storage)
      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100@evil.com")
        .expect(400)
    })

    it("refuses a non-http scheme", async () => {
      const project = await seedProject(ctx.storage)
      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "javascript:alert(1)")
        .expect(400)
    })

    it("sets Cache-Control: no-store on the refusal too", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://evil.com:3100")
        .expect(400)
      expect(res.headers["cache-control"]).toBe("no-store")
    })

    it("refuses a loopback spelling on the wrong port", async () => {
      const project = await seedProject(ctx.storage)
      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:9999")
        .expect(400)
    })

    it("accepts the bracketed IPv6 loopback spelling", async () => {
      const project = await seedProject(ctx.storage)
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://[::1]:3100")
        .expect(200)
      expect(new URL(res.body.origin as string).hostname).toBe("127.0.0.1")
    })

    it("refuses before it looks the project up — a bad header on a missing id is still 400", async () => {
      await request(ctx.app)
        .get("/api/v1/projects/does-not-exist/prototype-origin")
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://evil.com:3100")
        .expect(400)
    })
  })

  describe("read authorization", () => {
    it("answers a byte-identical 404 for an unreadable project and a missing id", async () => {
      const ctx = setup()
      const project = await seedProject(ctx.storage, { access: "invited" })

      // Anonymous: `invited` with no access-list row is unreadable.
      const unreadable = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
      const missing = await request(ctx.app)
        .get("/api/v1/projects/no-such-project/prototype-origin")
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")

      expect(unreadable.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(unreadable.text).toBe(missing.text)
      // The header is set before the read gate runs, so the 404 carries it
      // too — and identically for both, which is what keeps them
      // indistinguishable.
      expect(unreadable.headers["cache-control"]).toBe("no-store")
      expect(missing.headers["cache-control"]).toBe("no-store")
    })

    it("opens no listener for a project the caller may not read", async () => {
      // A refused read must not have bound a socket. With a registry that
      // refuses to open anything, reaching `ensure` would answer 503 instead
      // of 404 — so the 404 is what proves the route never got there.
      const ctx = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage, { access: "invited" })
      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(404)
    })
  })

  describe("subdomain mode", () => {
    it("names the prototype's own subdomain, capability required for a private project", async () => {
      const ctx = setup({ config: subdomainConfig })
      const project = await seedProject(ctx.storage, { access: "all-members" })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "subdomain",
        origin: "https://acme.desde.test",
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })

    it("needs no capability for an anonymously readable prototype", async () => {
      const ctx = setup({ config: subdomainConfig })
      const project = await seedProject(ctx.storage, { access: "public-link" })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "subdomain",
        origin: "https://acme.desde.test",
        deploymentId: project.activeDeploymentId,
        capabilityRequired: false,
        serve: "static",
      })
    })

    it("carries serve: \"server\" and the process status too", async () => {
      const ctx = setup({ config: subdomainConfig })
      const project = await seedProject(ctx.storage, { access: "all-members" })
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body.serve).toBe("server")
      expect(res.body.process).toEqual({ state: "stopped" })
    })
  })

  describe("prototype-origin mode (VIEWER_PROTOTYPE_ORIGIN)", () => {
    it("names the single shared origin, capability required for a private project", async () => {
      const ctx = setup({ config: prototypeOriginConfig })
      const project = await seedProject(ctx.storage, { access: "all-members" })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "prototype-origin",
        origin: "https://proto.example.net",
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })

    it("needs no capability for an anonymously readable prototype", async () => {
      const ctx = setup({ config: prototypeOriginConfig })
      const project = await seedProject(ctx.storage, { access: "public-link" })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "prototype-origin",
        origin: "https://proto.example.net",
        deploymentId: project.activeDeploymentId,
        capabilityRequired: false,
        serve: "static",
      })
    })

    // The router 409s a request for the shared origin's own prototype path
    // when the pinned deployment is `serve: "server"` — this mode cannot
    // proxy one. The review page still needs to KNOW that, to show a
    // "this prototype needs an origin of its own" panel instead of a blank
    // frame, which is why this field is not skipped here the way the rest
    // of the response is unaffected by what this mode can serve.
    it("carries serve: \"server\" too, even though this mode cannot proxy one", async () => {
      const ctx = setup({ config: prototypeOriginConfig })
      const project = await seedProject(ctx.storage, { access: "all-members" })
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body.serve).toBe("server")
      expect(res.body.process).toEqual({ state: "stopped" })
    })

    it("opens no listener — the shared origin is not a loopback listener", async () => {
      // A refusing registry turns any `ensure` call into a 503. A 200 here
      // proves the prototype-origin branch answered before the loopback branch
      // could open a socket.
      const ctx = setup({ config: prototypeOriginConfig, prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "https://viewer.example.com")
        .expect(200)

      expect(res.body.mode).toBe("prototype-origin")
    })
  })

  describe("fallback mode", () => {
    it("has no isolated origin to offer", async () => {
      const ctx = setup({ config: fallbackConfig })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "fallback",
        origin: null,
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })

    // The whole reason this task loads the deployment for a mode that used
    // to answer without one: fallback mode has no isolated origin to proxy a
    // server deployment from, but the review page still needs to know
    // `serve: "server"` to show its needs-origin panel instead of a blank
    // frame.
    it("reports serve: \"server\" for a server deployment even with no isolated origin to offer", async () => {
      const ctx = setup({ config: fallbackConfig })
      const project = await seedProject(ctx.storage)
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "fallback",
        origin: null,
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "server",
        process: { state: "stopped" },
      })
    })

    it("opens no listener even when the header names a loopback shell", async () => {
      // A registry that refuses to open anything: a 503 here would mean the
      // header had flipped the mode and the route had called `ensure`.
      const ctx = setup({ config: fallbackConfig, prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      // `https://localhost:3100` IS in the accepted set (the scheme comes from
      // `publicUrl`), so this is not a 400 — but a deployed instance reached on
      // its own loopback address is still the deployed shell, and must not flip
      // into loopback mode. See `resolveOrigins`'s task 4b rule.
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "https://localhost:3100")
        .expect(200)

      expect(res.body.mode).toBe("fallback")
    })
  })

  /**
   * Hard requirement 7, the mixed-content rule. A loopback listener is always
   * http — it binds a raw ephemeral port with no certificate — so an https
   * shell framing one is mixed content, which a browser blocks silently. Worse
   * in practice: `ensure` refuses a non-http shell origin, so treating this as
   * loopback mode would make every review a permanent 503.
   */
  describe("an https loopback publicUrl", () => {
    it("resolves to fallback and never reaches the registry", async () => {
      const ctx = setup({
        config: { ...baseConfig, publicUrl: "https://localhost:3100" },
        // A 503 here would mean the route called `ensure` on a shell origin
        // the registry is bound to refuse.
        prototypeListeners: refusingListeners(),
      })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "https://localhost:3100")
        .expect(200)

      expect(res.body).toEqual({
        mode: "fallback",
        origin: null,
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })
  })

  /**
   * The Docker/remote follow-up (NEXT.md §17). A container reached through a
   * published port (`docker run -p 3100:3100`) with a default loopback
   * publicUrl looks, from the request's point of view, exactly like the
   * zero-config laptop case that loopback mode exists for. The difference
   * is `config.loopbackAvailable`, computed at boot from
   * `VIEWER_LOOPBACK_LISTENERS` (see `config.ts` / `container-detect.ts`),
   * and this is where it has to actually take effect: this route is the
   * ONE place a loopback listener gets opened, so this is the security
   * invariant the whole feature rests on — a downgraded config must never
   * reach `registry.ensure`.
   */
  describe("a container config (loopbackAvailable: false)", () => {
    it("returns mode: fallback, origin: null, and opens no listener", async () => {
      // A registry that refuses to open anything: if the route reached
      // `ensure` this would be a 503, so the 200 with mode: fallback IS the
      // assertion that no listener was opened.
      const ctx = setup({ config: containerConfig, prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(res.body).toEqual({
        mode: "fallback",
        origin: null,
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })

    it("downgrades even when the request Host itself is the loopback shell (no header)", async () => {
      const ctx = setup({ config: containerConfig, prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set("Host", "localhost:3100")
        .expect(200)

      expect(res.body).toEqual({
        mode: "fallback",
        origin: null,
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })

    it("never calls registry.ensure — asserted directly, not just inferred from the status code", async () => {
      const ensure = vi.fn(() => Promise.reject(new Error("should never be called")))
      const listeners: LoopbackListenerRegistry = {
        ensure,
        touch: () => {},
        reapIdle: () => Promise.resolve(0),
        closeAll: () => Promise.resolve(),
        closeForDeployment: () => Promise.resolve(),
        startReaper: () => () => {},
        isPrototypeHost: () => false,
      }
      const ctx = setup({ config: containerConfig, prototypeListeners: listeners })
      const project = await seedProject(ctx.storage)

      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(200)

      expect(ensure).not.toHaveBeenCalled()
    })

    it("a serveDomain still wins over a downgraded loopback shell — subdomain mode is unaffected", async () => {
      const ctx = setup({
        config: { ...containerConfig, serveDomain: "desde.test", publicUrl: "https://viewer.example.com" },
      })
      const project = await seedProject(ctx.storage, { access: "all-members" })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .expect(200)

      expect(res.body).toEqual({
        mode: "subdomain",
        origin: "https://acme.desde.test",
        deploymentId: project.activeDeploymentId,
        capabilityRequired: true,
        serve: "static",
      })
    })
  })

  describe("when a listener cannot be opened", () => {
    /**
     * Codex round 6, Fix 2. This used to be `{ error: "Prototype origin
     * unavailable" }` alone — no `reason`, no `serve`. `readPrototypeOrigin`
     * then defaulted `serve` to `"static"` on the client, the review page
     * embedded `/p/:slug/` for a SERVER deployment, and the serve router
     * answered 409 inside the frame. Naming `reason: "listener-failed"` is
     * what lets `decidePrototypeEmbed` show a panel instead, the same way it
     * already does for `reason: "ports-exhausted"`.
     */
    it("answers 503 with reason listener-failed and the serve mode, for a static deployment", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const ctx = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)

      expect(res.body).toEqual({
        error: "Prototype origin unavailable",
        reason: "listener-failed",
        serve: "static",
        deploymentId: project.activeDeploymentId,
      })
    })

    it("answers 503 with serve: \"server\" for a server deployment", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const ctx = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)

      expect(res.body).toEqual({
        error: "Prototype origin unavailable",
        reason: "listener-failed",
        serve: "server",
        deploymentId: project.activeDeploymentId,
      })
    })

    /**
     * The rule, not the fixture: the injected error's MESSAGE carries a shell
     * origin and a live-looking ephemeral port, exactly as the real failures
     * do (see `ENSURE_FAILURE`). An implementation that logs the error object
     * — or its message — fails this. Only one that logs a constant plus the
     * error's class passes.
     */
    it("logs a constant and the error class, never anything request-derived", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {})
      const ctx = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)

      expect(errors).toHaveBeenCalledTimes(1)
      const logged = errors.mock.calls[0]?.map((arg) => String(arg)).join(" ") ?? ""
      // The port, the shell origin, the prototype origin, the project id —
      // none of it reaches the log.
      expect(logged).not.toContain("45001")
      expect(logged).not.toContain("localhost:3100")
      expect(logged).not.toContain("127.0.0.1")
      expect(logged).not.toContain(project.id)
      // What DOES reach it: enough to tell one failure class from another.
      expect(logged).toContain("Error")
    })

    /**
     * The body carries `serve` and `range` as well as the reason, and the
     * page acts on both: a STATIC prototype still loads from the shell's own
     * path prefix when no listener can be opened, so only a server one gets
     * the panel, and the panel names the count from the range.
     */
    it("answers 503 with reason ports-exhausted, the serve mode and the range", async () => {
      const thrown = new LoopbackPortsExhaustedError({ from: 3101, to: 3120 })
      const exhausted: LoopbackListenerRegistry = {
        ensure: () => Promise.reject(thrown),
        touch: () => {},
        reapIdle: () => Promise.resolve(0),
        closeAll: () => Promise.resolve(),
        closeForDeployment: () => Promise.resolve(),
        startReaper: () => () => {},
        isPrototypeHost: () => false,
      }
      const ctx = setup({
        prototypeListeners: exhausted,
        config: { ...loopbackConfig, loopbackPortRange: { from: 3101, to: 3120 } },
      })
      const project = await seedProject(ctx.storage)
      await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
        serve: "server",
        serverStart: ["node", "server.js"],
      })

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)

      expect(res.body.reason).toBe("ports-exhausted")
      expect(res.body.error).toBe(thrown.message)
      expect(res.body.serve).toBe("server")
      expect(res.body.range).toEqual({ from: 3101, to: 3120 })
    })

    /**
     * A 503 names the deployment the same way a 200 does.
     *
     * The review page compares that id against the deployment it was rendered
     * with, and asks Next to re-render when they differ — a new deployment
     * needs a capability only the server can mint, and it has to remount the
     * frame. A rebuild that lands while the origin is unavailable used to say
     * nothing at all, so the page went on believing the previous build was
     * live and never re-rendered for the new one, even once the origin came
     * back.
     */
    it("names the deployment on both 503 bodies", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const range = { from: 3101, to: 3120 }
      const exhausted: LoopbackListenerRegistry = {
        ...refusingListeners(),
        ensure: () => Promise.reject(new LoopbackPortsExhaustedError(range)),
      }
      const withPorts = setup({
        prototypeListeners: exhausted,
        config: { ...loopbackConfig, loopbackPortRange: range },
      })
      const first = await seedProject(withPorts.storage)
      const portsBody = await request(withPorts.app)
        .get(`/api/v1/projects/${first.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)
      expect(portsBody.body.deploymentId).toBe(first.activeDeploymentId)

      const refusing = setup({ prototypeListeners: refusingListeners() })
      const second = await seedProject(refusing.storage)
      const failedBody = await request(refusing.app)
        .get(`/api/v1/projects/${second.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)
      expect(failedBody.body.deploymentId).toBe(second.activeDeploymentId)
    })

  })
})

/**
 * `GET /projects/:id/prototype-origin/stream` — the SSE follow to the plain
 * route above. It answers with the same body, in an `event: origin` frame,
 * once on connect and again whenever the active deployment's process status
 * changes (task 6, `docs/superpowers/specs/2026-09-11-server-prototypes-rework-design.md` § 3).
 *
 * A helper below (`readUntil`) reads raw SSE bytes off a real socket the
 * same way `comments-routes.test.ts`'s stream tests do: `supertest`
 * buffers nothing here (`.buffer(false)` + a custom `.parse`), because the
 * stream response never ends and a normal `await request(...)` would hang
 * forever waiting for a body.
 */
describe("GET /projects/:id/prototype-origin/stream", () => {
  const DISCONNECT_ERROR = /aborted|socket hang up|ECONNRESET/i

  /**
   * Connects to the stream and resolves once `predicate(receivedSoFar)` is
   * true, with a handle to close the connection. Rejects if the predicate
   * never becomes true within `timeoutMs` — a stuck predicate is a test bug
   * or a real regression, not a thing to hang the suite over.
   */
  function readUntil(
    app: ReturnType<typeof createApp>,
    project: Project,
    predicate: (received: string) => boolean,
    options: {
      onFirstByte?: () => void
      timeoutMs?: number
      anonymous?: boolean
      /**
       * The stated shell origin, or `null` to send no header at all — which
       * is what a subdomain-mode test needs: the closed set of acceptable
       * origins is built from `publicUrl`'s scheme, so the `http://` spelling
       * every loopback test sends is a 400 there.
       */
      shellOrigin?: string | null
    } = {},
  ): Promise<{ received: string; destroy: () => void }> {
    const { onFirstByte, timeoutMs = 3000, shellOrigin = "http://localhost:3100" } = options
    let sawFirstByte = false
    return new Promise((resolve, reject) => {
      const chunks: string[] = []
      let destroyed = false
      const timer = setTimeout(() => {
        if (!destroyed) reject(new Error(`predicate never matched; received: ${chunks.join("")}`))
      }, timeoutMs)
      const pending = request(app).get(`/api/v1/projects/${project.id}/prototype-origin/stream`)
      // The admin bearer reads every project, so a test about LOSING access
      // has to send no credential at all — see `streamUntilClosed`.
      if (!options.anonymous) pending.set(auth)
      if (shellOrigin !== null) pending.set(SHELL_ORIGIN_HEADER, shellOrigin)
      pending
        .buffer(false)
        .parse((res, cb) => {
          res.on("data", (chunk: Buffer) => {
            if (!sawFirstByte) {
              sawFirstByte = true
              onFirstByte?.()
            }
            chunks.push(chunk.toString("utf-8"))
            const received = chunks.join("")
            if (predicate(received)) {
              clearTimeout(timer)
              const rawRes = res as unknown as { destroy(): void }
              resolve({
                received,
                destroy: () => {
                  destroyed = true
                  rawRes.destroy()
                },
              })
            }
          })
          res.on("error", () => cb(null, Buffer.from("")))
        })
        .end((err) => {
          if (err && !destroyed && !DISCONNECT_ERROR.test(err.message)) reject(err)
        })
    })
  }

  /** Parses every `event: origin\ndata: <json>\n\n` frame, in order. */
  function originFrames(received: string): unknown[] {
    return [...received.matchAll(/event: origin\ndata: (.+)\n\n/g)].map((m) => JSON.parse(m[1] as string))
  }

  /**
   * Connects ANONYMOUSLY and resolves with everything received once the
   * SERVER closes the response.
   *
   * `readUntil` above cannot answer the question these tests ask. It resolves
   * on a predicate and then destroys the connection from the client side, so
   * it can prove a frame arrived but never that the server ended the stream
   * by itself. Here the whole assertion is that it did: the promise only
   * settles on the response's own `end`, so a stream that stays open fails
   * the test by timing out rather than passing quietly.
   *
   * Anonymous on purpose. The admin bearer every other test sends reads any
   * project by `hasAdminAuthority`, so a caller holding it can never lose
   * access.
   */
  function streamUntilClosed(
    app: ReturnType<typeof createApp>,
    project: Project,
    options: { onFirstByte?: () => void; timeoutMs?: number } = {},
  ): Promise<string> {
    const { onFirstByte, timeoutMs = 3000 } = options
    let sawFirstByte = false
    return new Promise((resolve, reject) => {
      const chunks: string[] = []
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) reject(new Error(`the server never closed the stream; received: ${chunks.join("")}`))
      }, timeoutMs)
      const settle = (): void => {
        settled = true
        clearTimeout(timer)
        resolve(chunks.join(""))
      }
      request(app)
        .get(`/api/v1/projects/${project.id}/prototype-origin/stream`)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .buffer(false)
        .parse((res, cb) => {
          res.on("data", (chunk: Buffer) => {
            if (!sawFirstByte) {
              sawFirstByte = true
              onFirstByte?.()
            }
            chunks.push(chunk.toString("utf-8"))
          })
          // The response's OWN end, which is the assertion. Superagent calls
          // the `.end()` callback below as soon as the parser is installed
          // when buffering is off, so that callback says nothing about
          // whether the stream is still open — only this does.
          res.on("end", () => {
            settle()
            cb(null, Buffer.from(""))
          })
          res.on("error", () => cb(null, Buffer.from("")))
        })
        .end((err) => {
          if (err && !settled && !DISCONNECT_ERROR.test(err.message)) reject(err)
        })
    })
  }

  /** Flips the instance-wide public-link kill switch and drops its cache. */
  async function setPublicLinks(storage: InMemoryStorage, allowed: boolean): Promise<void> {
    await storage.setInstanceSetting(ALLOW_PUBLIC_LINKS_KEY, String(allowed))
    // The settings cache is keyed by storage instance and only invalidated by
    // the route that writes it, so a test that writes directly must do this
    // itself — see `server/instance-settings.ts`.
    invalidateInstanceSettingsCache(storage)
  }

  it("sends one origin event on connect whose JSON equals the plain route's body", async () => {
    const ctx = setup()
    const project = await seedProject(ctx.storage)

    const plain = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/prototype-origin`)
      .set(auth)
      .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
      .expect(200)

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 1)
    destroy()

    expect(originFrames(received)).toEqual([plain.body])
  })

  it("sends a second origin event when a subscriber callback reports a changed status", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake })
    const project = await seedProject(ctx.storage)
    await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
      serve: "server",
      serverStart: ["node", "server.js"],
    })
    const deploymentId = project.activeDeploymentId as string
    const runningStatus: ProcessStatus = {
      state: "running",
      port: 4321,
      since: "2026-09-11T00:00:00.000Z",
      generation: 1,
    }

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      onFirstByte: () => {
        // Fired once the connect event's bytes have arrived, at which point
        // the route has already subscribed (no awaits happen between
        // `send(current)` and `subscribeToProcess` in the handler).
        fake.emit(deploymentId, runningStatus)
      },
    })
    destroy()

    const frames = originFrames(received) as { process?: ProcessStatus }[]
    expect(frames).toHaveLength(2)
    expect(frames[0]?.process).toEqual({ state: "stopped" })
    expect(frames[1]?.process).toEqual(runningStatus)
  })

  it("answers the byte-identical 404 the plain route sends for an unreadable project", async () => {
    const ctx = setup()
    const project = await seedProject(ctx.storage, { access: "invited" })

    const plain = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/prototype-origin`)
      .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
    const stream = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/prototype-origin/stream`)
      .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")

    expect(stream.status).toBe(404)
    expect(stream.text).toBe(plain.text)
  })

  it("refuses the 21st concurrent stream from one client with the same 429 the comment stream sends", async () => {
    const ctx = setup()
    const project = await seedProject(ctx.storage)
    const open: { destroy: () => void }[] = []
    try {
      for (let i = 0; i < 20; i++) {
        open.push(await readUntil(ctx.app, project, () => true))
      }
      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin/stream`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(429)
      expect(res.body).toEqual({ error: "Too many open connections from this client" })
      expect(res.headers["retry-after"]).toBe("5")
    } finally {
      for (const s of open) s.destroy()
    }
  })

  /**
   * The crashed panel has to give way on its own when the restart budget
   * ages out. `retryable` is computed when the status is READ, so the moment
   * the last crash falls out of the five minute window the manager would
   * answer `retryable: true` — but no event was applied, so no subscriber
   * fires and the page would sit on a dead end until a reload. The heartbeat
   * tick re-reads the status and sends a fresh body when it differs.
   */
  it("sends a fresh body when the process status changed with no transition to notify on", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake, prototypeOriginStreamPingMs: 20 })
    const project = await seedProject(ctx.storage)
    const deploymentId = await makeServerDeployment(ctx, project)
    const spent: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 4,
      reason: "The server kept exiting. See the server log.",
      retryable: false,
      generation: 1,
    }
    const agedOut: ProcessStatus = { ...spent, reason: "The server exited.", retryable: true }
    fake.setStatus(deploymentId, spent)

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      onFirstByte: () => {
        // No `emit`: the budget ageing out fires nothing, which is the whole
        // point of this test.
        fake.setStatus(deploymentId, agedOut)
      },
    })
    destroy()

    const frames = originFrames(received) as { process?: ProcessStatus }[]
    expect(frames[0]?.process).toEqual(spent)
    expect(frames[1]?.process).toEqual(agedOut)
  })

  /**
   * Codex round 19. The first body samples the status before the listener is
   * set up and before the subscription exists, so a transition in that gap
   * notified nobody and the page waited a whole heartbeat for it. The stream
   * now reads once more right after subscribing. The fake answers `starting`
   * until a subscriber exists and `running` after, which is exactly the gap.
   */
  it("re-reads the status once the subscription is in place, so a transition during setup is not lost", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake, prototypeOriginStreamPingMs: 60_000 })
    const project = await seedProject(ctx.storage)
    const deploymentId = await makeServerDeployment(ctx, project)
    const starting: ProcessStatus = { state: "starting", generation: 1 }
    const running: ProcessStatus = { state: "running", port: 4321, since: "2026-09-12T00:00:00.000Z", generation: 1 }
    fake.status = (id) => (id === deploymentId && fake.subscribers.has(id) ? running : starting)

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2)
    destroy()

    const frames = originFrames(received) as { process?: ProcessStatus }[]
    expect(frames[0]?.process).toEqual(starting)
    expect(frames[1]?.process).toEqual(running)
  })

  /**
   * Codex round 16. The listener registry reaps a loopback port after 30
   * quiet minutes, and the stream never touched it: a reader sitting on the
   * page kept an origin nothing answered on. Every heartbeat now counts as
   * use of the listener the body names.
   */
  it("touches the loopback listener on every heartbeat while the stream is open", async () => {
    const ctx = setup({ prototypeOriginStreamPingMs: 20 })
    const touch = vi.spyOn(ctx.listeners, "touch")
    const project = await seedProject(ctx.storage)
    await makeServerDeployment(ctx, project)

    const { received, destroy } = await readUntil(
      ctx.app,
      project,
      (r) => r.split(": ping").length >= 3 && touch.mock.calls.length >= 2,
    )
    destroy()

    const [first] = originFrames(received) as { origin: string }[]
    const port = Number(new URL(first!.origin).port)
    expect(port).toBeGreaterThan(0)
    expect(touch).toHaveBeenCalledWith(port)
  })

  /**
   * Two status callbacks in flight across a deployment change used to leave
   * a listener behind for ever. Both re-read the project, both saw the new
   * deployment, and each subscribed to it — the second overwriting the
   * first's unsubscribe, so `cleanup` could only ever release one of them.
   * The leaked listener held the response, the project and the body in its
   * closure and woke on every later transition.
   *
   * The callbacks run through one promise chain per connection now, so the
   * second sees what the first did.
   */
  it("keeps exactly one process subscription when two callbacks land across a deployment change", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake })
    const project = await seedProject(ctx.storage)
    const firstDeployment = await makeServerDeployment(ctx, project)
    const running: ProcessStatus = {
      state: "running",
      port: 4321,
      since: "2026-09-11T00:00:00.000Z",
      generation: 1,
    }
    const crashed: ProcessStatus = {
      state: "crashed",
      exitCode: 1,
      restarts: 1,
      reason: "The server exited.",
      retryable: true,
      generation: 1,
    }
    let secondDeployment = ""

    const { destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      onFirstByte: () => {
        void (async () => {
          const deployment = await ctx.storage.createDeployment({
            projectId: project.id,
            status: "deployed",
          })
          await ctx.storage.updateDeployment(deployment.id, {
            serve: "server",
            serverStart: ["node", "server.js"],
          })
          await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
          secondDeployment = deployment.id
          // Back to back, both for the OLD deployment, both after the active
          // one changed: the shape the leak needed.
          fake.emit(firstDeployment, running)
          fake.emit(firstDeployment, crashed)
        })()
      },
    })

    await vi.waitFor(() => {
      expect(secondDeployment).not.toBe("")
      expect(fake.subscribers.get(firstDeployment)?.size ?? 0).toBe(0)
      expect(fake.subscribers.get(secondDeployment)?.size ?? 0).toBe(1)
    })

    destroy()
    await vi.waitFor(() => {
      const total = [...fake.subscribers.values()].reduce((n, set) => n + set.size, 0)
      expect(total).toBe(0)
    })
  })

  /**
   * A rebuild has to reach an open page. The build change bus is keyed by
   * DEPLOYMENT id, so a stream following the old deployment has nothing
   * subscribed that a new one would fire — and the old deployment's process
   * need never transition again (a rebuild keeps one previous checkout, so
   * it is not even retired). Before this, only a full reload or a second
   * rebuild got the page off the old body. The heartbeat tick re-reads the
   * project, so the change is picked up with no event at all.
   */
  it("follows a rebuild: a new active deployment is picked up with no process event", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake, prototypeOriginStreamPingMs: 20 })
    const project = await seedProject(ctx.storage)
    const firstDeployment = await makeServerDeployment(ctx, project)
    const running: ProcessStatus = {
      state: "running",
      port: 4321,
      since: "2026-09-11T00:03:00.000Z",
      generation: 1,
    }
    let secondDeployment = ""

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      onFirstByte: () => {
        void (async () => {
          const deployment = await ctx.storage.createDeployment({
            projectId: project.id,
            status: "deployed",
          })
          await ctx.storage.updateDeployment(deployment.id, {
            serve: "server",
            serverStart: ["node", "server.js"],
          })
          fake.setStatus(deployment.id, running)
          await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
          secondDeployment = deployment.id
        })()
      },
    })

    await vi.waitFor(() => {
      expect(secondDeployment).not.toBe("")
      expect(fake.subscribers.get(firstDeployment)?.size ?? 0).toBe(0)
      expect(fake.subscribers.get(secondDeployment)?.size ?? 0).toBe(1)
    })
    destroy()

    const frames = originFrames(received) as { origin?: string; process?: ProcessStatus }[]
    expect(frames).toHaveLength(2)
    // The new deployment's own listener, and the new deployment's own
    // process — not a patch of the old body.
    expect(frames[1]?.origin).not.toBe(frames[0]?.origin)
    expect(frames[1]?.process).toEqual(running)
  })

  /**
   * The read check runs at CONNECT and again on every tick, and this is the
   * control for the three tests below it: an anonymous reader of a
   * `public-link` project keeps every update for as long as that stays true.
   * Without it, "the stream closed" would be evidence of nothing — a re-check
   * that refused everyone would pass the revocation tests too.
   */
  it("keeps streaming for an anonymous reader while the project is still readable", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake, prototypeOriginStreamPingMs: 20 })
    const project = await seedProject(ctx.storage, { access: "public-link" })
    const deploymentId = await makeServerDeployment(ctx, project)
    const running: ProcessStatus = {
      state: "running",
      port: 4321,
      since: "2026-09-11T00:00:00.000Z",
      generation: 1,
    }

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      anonymous: true,
      onFirstByte: () => fake.emit(deploymentId, running),
    })
    destroy()

    const frames = originFrames(received) as { process?: ProcessStatus }[]
    expect(frames[1]?.process).toEqual(running)
  })

  /**
   * The stream used to check the read policy once, at connect, and reuse that
   * verdict for the rest of the connection. So an anonymous visitor whose
   * access the admin had just withdrawn kept the stream — and the next active
   * deployment opened a fresh loopback listener for them and sent its origin.
   *
   * The tick re-runs the same check the plain route runs, against the same
   * request, and ends the response when it no longer passes.
   */
  it("ends the stream on the next tick once the caller may no longer read the project", async () => {
    const ctx = setup({ prototypeOriginStreamPingMs: 20 })
    const project = await seedProject(ctx.storage, { access: "public-link" })

    const received = await streamUntilClosed(ctx.app, project, {
      onFirstByte: () => {
        void (async () => {
          await setPublicLinks(ctx.storage, false)
          // A rebuild, which is exactly what the old code would have followed
          // into a new listener for a caller who may no longer read anything.
          const deployment = await ctx.storage.createDeployment({
            projectId: project.id,
            status: "deployed",
          })
          await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
        })()
      },
    })

    // The connect event, and nothing after it. A second frame would be the
    // new deployment's origin — a live listener handed to a caller who lost
    // access.
    expect(originFrames(received)).toHaveLength(1)
  })

  /**
   * The same check covers the callback path. A process transition can arrive
   * at any moment, so a revocation that only the heartbeat noticed would
   * leave a window in which a status callback still sent a body.
   */
  it("sends nothing for a process callback that lands after the caller lost access", async () => {
    const fake = fakePrototypeProcesses()
    // No ping override: the default heartbeat is 25s, so nothing but the
    // callback below can end this stream within the test's own timeout.
    const ctx = setup({ prototypeProcesses: fake })
    const project = await seedProject(ctx.storage, { access: "public-link" })
    const deploymentId = await makeServerDeployment(ctx, project)
    const running: ProcessStatus = {
      state: "running",
      port: 4321,
      since: "2026-09-11T00:00:00.000Z",
      generation: 1,
    }

    const received = await streamUntilClosed(ctx.app, project, {
      onFirstByte: () => {
        void (async () => {
          await setPublicLinks(ctx.storage, false)
          fake.emit(deploymentId, running)
        })()
      },
    })

    expect(originFrames(received)).toHaveLength(1)
  })

  /**
   * A 503 is the one answer nothing ever moves off.
   *
   * `ports-exhausted` and `listener-failed` both mean the resolution never
   * got as far as a listener, so no process exists and no process will ever
   * transition — and the tick's only other job is `resendIfProcessChanged`,
   * which needs a 200 body to read a deployment off. So the page sat on the
   * unavailable panel for ever, even after the port that was in the way was
   * released. The tick re-runs the whole resolution while the answer is a 503.
   */
  it("re-resolves on the heartbeat after a 503 and sends the origin once a port frees up", async () => {
    const range = { from: 3101, to: 3120 }
    let attempts = 0
    const freeingUp: LoopbackListenerRegistry = {
      ensure: (deployment, target) => {
        attempts += 1
        if (attempts === 1) return Promise.reject(new LoopbackPortsExhaustedError(range))
        return Promise.resolve({
          deploymentId: deployment.id,
          projectId: deployment.projectId,
          slug: deployment.slug,
          host: "127.0.0.1" as const,
          port: range.from,
          origin: `http://127.0.0.1:${range.from}`,
          shellOrigin: target.shellOrigin,
          boundAddress: "127.0.0.1",
          lastUsedAt: 0,
          close: () => Promise.resolve(),
        })
      },
      touch: () => {},
      reapIdle: () => Promise.resolve(0),
      closeAll: () => Promise.resolve(),
      closeForDeployment: () => Promise.resolve(),
      startReaper: () => () => {},
      isPrototypeHost: () => false,
    }
    const fake = fakePrototypeProcesses()
    const ctx = setup({
      prototypeListeners: freeingUp,
      prototypeProcesses: fake,
      prototypeOriginStreamPingMs: 20,
      config: { ...loopbackConfig, loopbackPortRange: range },
    })
    const project = await seedProject(ctx.storage)
    const deploymentId = await makeServerDeployment(ctx, project)

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2)
    destroy()

    const frames = originFrames(received) as { reason?: string; origin?: string }[]
    expect(frames[0]?.reason, "the first body was not the unavailable one").toBe("ports-exhausted")
    expect(frames[1]?.origin).toBe(`http://127.0.0.1:${range.from}`)
    expect(frames[1]?.reason).toBeUndefined()
    // And the recovered body's process is followed, the same as a body that
    // succeeded on connect.
    await vi.waitFor(() => {
      expect(fake.subscribers.get(deploymentId)?.size ?? 0).toBe(1)
    })
  })

  /**
   * The stream's 503 has to name the deployment too, for the same reason the
   * plain route's does: this is the body the page follows, and a rebuild that
   * lands while the origin is unavailable is otherwise invisible to it.
   */
  it("names the deployment on the 503 it sends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const ctx = setup({ prototypeListeners: refusingListeners() })
    const project = await seedProject(ctx.storage)

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 1)
    destroy()

    const frames = originFrames(received) as { reason?: string; deploymentId?: string }[]
    expect(frames[0]?.reason).toBe("listener-failed")
    expect(frames[0]?.deploymentId).toBe(project.activeDeploymentId)
  })

  /**
   * Codex round 14, Fix 3. An access change is a body change.
   *
   * The tick refreshes the read POLICY on every pass, but the only thing it
   * compared afterwards was the active deployment id. So a project that went
   * from anonymously readable to private — while the caller stayed
   * authorised, so the stream rightly survived — kept a body whose
   * `capabilityRequired` was still `false`. The page went on rendering a
   * frame with no capability in its URL, and the prototype's subresources
   * started 404ing one by one.
   *
   * Subdomain mode, because that is where `capabilityRequired` is computed
   * from the project's access rather than fixed by the mode.
   */
  it("sends a second origin event when the project's access changes under the stream", async () => {
    const ctx = setup({ config: subdomainConfig, prototypeOriginStreamPingMs: 20 })
    const project = await seedProject(ctx.storage, { access: "public-link" })

    const { received, destroy } = await readUntil(
      ctx.app,
      project,
      // Several ticks past the change, so a body re-sent on EVERY tick would
      // show up as more than the two frames asserted below.
      (r) => originFrames(r).length >= 2 && r.split(": ping").length > 5,
      {
        shellOrigin: null,
        onFirstByte: () => {
          void ctx.storage.updateProject(project.id, { access: "invited" })
        },
      },
    )
    destroy()

    const frames = originFrames(received) as { capabilityRequired?: boolean }[]
    expect(frames).toHaveLength(2)
    expect(frames[0]?.capabilityRequired, "the connect body already required a capability").toBe(false)
    expect(frames[1]?.capabilityRequired).toBe(true)
  })

  /**
   * Codex round 24. The access change used to be noticed only by the
   * heartbeat; a process callback landing in the same moment patched the
   * OLD body (still `capabilityRequired: false`) and recorded an access key
   * built from it, so every later tick thought nothing had changed and the
   * page stayed without a capability for good.
   */
  it("re-resolves the body when a process callback lands after the project's access changed", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ config: subdomainConfig, prototypeProcesses: fake, prototypeOriginStreamPingMs: 60_000 })
    const project = await seedProject(ctx.storage, { access: "public-link" })
    const deploymentId = await makeServerDeployment(ctx, project)
    const running: ProcessStatus = { state: "running", port: 4321, since: "2026-09-12T00:00:00.000Z", generation: 1 }

    const { received, destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 2, {
      shellOrigin: null,
      onFirstByte: () => {
        void ctx.storage.updateProject(project.id, { access: "invited" }).then(() => {
          fake.emit(deploymentId, running)
        })
      },
    })
    destroy()

    const frames = originFrames(received) as { capabilityRequired?: boolean; process?: ProcessStatus }[]
    expect(frames[0]?.capabilityRequired).toBe(false)
    expect(frames[1]?.capabilityRequired).toBe(true)
    expect(frames[1]?.process).toEqual(running)
  })

  /** A 503 that keeps saying the same thing sends nothing: the page already shows it. */
  it("sends no repeat body while the 503 reason is unchanged", async () => {
    const ctx = setup({
      prototypeListeners: refusingListeners(),
      prototypeOriginStreamPingMs: 20,
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const project = await seedProject(ctx.storage)
    await makeServerDeployment(ctx, project)

    // Three ticks' worth of pings, and still only the connect body.
    const { received, destroy } = await readUntil(ctx.app, project, (r) => r.split(": ping").length > 3)
    destroy()

    expect(originFrames(received)).toHaveLength(1)
  })

  it("unsubscribes from the process manager when the client disconnects", async () => {
    const fake = fakePrototypeProcesses()
    const ctx = setup({ prototypeProcesses: fake })
    const project = await seedProject(ctx.storage)
    await ctx.storage.updateDeployment(project.activeDeploymentId as string, {
      serve: "server",
      serverStart: ["node", "server.js"],
    })
    const deploymentId = project.activeDeploymentId as string

    const { destroy } = await readUntil(ctx.app, project, (r) => originFrames(r).length >= 1)
    expect(fake.subscribers.get(deploymentId)?.size).toBe(1)
    destroy()

    await vi.waitFor(() => {
      expect(fake.subscribers.get(deploymentId)?.size ?? 0).toBe(0)
    })
  })
})

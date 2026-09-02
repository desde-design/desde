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
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { AssetStore, StoredAsset } from "../../assets/types"
import type { ViewerConfig } from "../../config"
import type { LoopbackListenerRegistry } from "../../serve/loopback-listeners"
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
}

/** A laptop: the shell is reached on a loopback name, no serve domain. */
const loopbackConfig = baseConfig

/**
 * A container reached through a published port (`docker run -p
 * 3100:3100`), or any deployment where `VIEWER_LOOPBACK_LISTENERS=off` /
 * `auto` detected a container: same publicUrl as `loopbackConfig`, but
 * `loopbackAvailable: false` — the Docker/remote follow-up this task adds.
 */
const containerConfig: ViewerConfig = { ...baseConfig, loopbackAvailable: false }

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
    startReaper: () => () => {},
    isPrototypeHost: () => false,
  }
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
      })
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
        capabilityRequired: true,
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
        capabilityRequired: false,
      })
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
        capabilityRequired: true,
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
        capabilityRequired: false,
      })
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

      expect(res.body).toEqual({ mode: "fallback", origin: null, capabilityRequired: true })
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

      expect(res.body).toEqual({ mode: "fallback", origin: null, capabilityRequired: true })
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

      expect(res.body).toEqual({ mode: "fallback", origin: null, capabilityRequired: true })
    })

    it("downgrades even when the request Host itself is the loopback shell (no header)", async () => {
      const ctx = setup({ config: containerConfig, prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set("Host", "localhost:3100")
        .expect(200)

      expect(res.body).toEqual({ mode: "fallback", origin: null, capabilityRequired: true })
    })

    it("never calls registry.ensure — asserted directly, not just inferred from the status code", async () => {
      const ensure = vi.fn(() => Promise.reject(new Error("should never be called")))
      const listeners: LoopbackListenerRegistry = {
        ensure,
        touch: () => {},
        reapIdle: () => Promise.resolve(0),
        closeAll: () => Promise.resolve(),
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
        capabilityRequired: true,
      })
    })
  })

  describe("when a listener cannot be opened", () => {
    it("answers 503 with a constant body", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const ctx = setup({ prototypeListeners: refusingListeners() })
      const project = await seedProject(ctx.storage)

      const res = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/prototype-origin`)
        .set(auth)
        .set(SHELL_ORIGIN_HEADER, "http://localhost:3100")
        .expect(503)

      expect(res.body).toEqual({ error: "Prototype origin unavailable" })
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
  })
})

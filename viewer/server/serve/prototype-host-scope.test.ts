/**
 * Prototype-host route scoping — spec hard requirement 1.
 *
 * The claim under test is a ROUTING claim, not a policy one: a request that
 * arrives on a prototype origin can never reach the shell's routers, so no
 * session cookie can ever be issued on a prototype origin. Two sentinels
 * carry that through every assertion below — a header only the stub shell API
 * sets, and a `Set-Cookie` only the stub shell API emits. A test that merely
 * asserted a status code would pass against a shell route that answered 404
 * *after* setting a cookie.
 */
import express, { type Router } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createApiRouter } from "../api/api-router"
import type { AssetStore, StoredAsset } from "../assets/types"
import { loadConfig } from "../config"
// The REAL `AppDeps`, not the test factory's relaxed one. The route-table walk
// below hands this same object to `createApiRouter`, whose deps are the real
// shape — so building it as the real type is what keeps `prototypeListeners`
// genuinely present rather than merely assigned to an optional field.
import type { AppDeps } from "../create-app"
import { createApp, createTestPrototypeListeners } from "../__tests__/test-app"
import { createSwappableApp } from "../__tests__/swappable-app"
import { tmpViewerDataDir } from "../__tests__/test-config"
import { testGithubRuntime } from "../__tests__/test-github-runtime"
import { InMemoryStorage } from "../storage/in-memory-storage"
import {
  PROTOTYPE_NOT_FOUND_BODY,
  composePrototypeHostRegistries,
  createPrototypeHostApiFence,
  createPrototypeHostScope,
  createPrototypeHostTerminalFence,
  createPrototypeOriginRegistry,
  createServeDomainRegistry,
  prototypeOriginHostSpellings,
  type PrototypeHostRegistry,
} from "./prototype-host-scope"
import { createSubdomainRewrite } from "./subdomain"

const DOMAIN = "proto.test"
const SHELL_HOST = "localhost:3100"
const SUBDOMAIN_HOST = `acme.${DOMAIN}:3100`
/** A Task 5 loopback listener: a prototype host with NO rewrite behind it. */
const LOOPBACK_HOST = "127.0.0.1:45001"

/** The header only the stub shell API sets. Its absence is the invariant. */
const SENTINEL = "x-shell-api"

describe("createServeDomainRegistry", () => {
  it("reports a `{slug}.{serveDomain}` host as a prototype host", () => {
    const registry = createServeDomainRegistry(DOMAIN)
    expect(registry.isPrototypeHost(`acme.${DOMAIN}`)).toBe(true)
    expect(registry.isPrototypeHost(SUBDOMAIN_HOST)).toBe(true)
  })

  it("reports the shell host, the bare serve domain and a nested label as shell hosts", () => {
    const registry = createServeDomainRegistry(DOMAIN)
    expect(registry.isPrototypeHost(SHELL_HOST)).toBe(false)
    expect(registry.isPrototypeHost(DOMAIN)).toBe(false)
    expect(registry.isPrototypeHost(`a.b.${DOMAIN}`)).toBe(false)
    expect(registry.isPrototypeHost("")).toBe(false)
  })

  it("reports nothing when no serve domain is configured", () => {
    expect(createServeDomainRegistry(null).isPrototypeHost(SUBDOMAIN_HOST)).toBe(false)
  })
})

describe("prototypeOriginHostSpellings", () => {
  it("gives the bare host plus the explicit scheme-default port for a port-less origin", () => {
    expect(prototypeOriginHostSpellings("https://proto.example.net")).toEqual(
      new Set(["proto.example.net", "proto.example.net:443"]),
    )
    expect(prototypeOriginHostSpellings("http://proto.example.net")).toEqual(
      new Set(["proto.example.net", "proto.example.net:80"]),
    )
  })

  it("gives just the explicit host:port for an origin that names a non-default port", () => {
    expect(prototypeOriginHostSpellings("http://proto.example.net:3100")).toEqual(
      new Set(["proto.example.net:3100"]),
    )
  })
})

describe("createPrototypeOriginRegistry", () => {
  it("reports the configured origin's host (both spellings) as a prototype host", () => {
    const registry = createPrototypeOriginRegistry("https://proto.example.net")
    expect(registry.isPrototypeHost("proto.example.net")).toBe(true)
    expect(registry.isPrototypeHost("proto.example.net:443")).toBe(true)
    expect(registry.isPrototypeHost("PROTO.EXAMPLE.NET")).toBe(true)
  })

  it("reports the shell host and an unrelated host as non-prototype hosts", () => {
    const registry = createPrototypeOriginRegistry("https://proto.example.net")
    expect(registry.isPrototypeHost("app.example.com")).toBe(false)
    expect(registry.isPrototypeHost("proto.example.net:3100")).toBe(false)
    expect(registry.isPrototypeHost("")).toBe(false)
  })

  it("reports nothing when no prototype origin is configured", () => {
    expect(createPrototypeOriginRegistry(null).isPrototypeHost("proto.example.net")).toBe(false)
  })
})

describe("composePrototypeHostRegistries", () => {
  it("is the union of its members", () => {
    const composed = composePrototypeHostRegistries(
      createServeDomainRegistry(DOMAIN),
      { isPrototypeHost: (host) => host === LOOPBACK_HOST },
    )
    expect(composed.isPrototypeHost(SUBDOMAIN_HOST)).toBe(true)
    expect(composed.isPrototypeHost(LOOPBACK_HOST)).toBe(true)
    expect(composed.isPrototypeHost(SHELL_HOST)).toBe(false)
  })

  it("reports nothing when it has no members", () => {
    expect(composePrototypeHostRegistries().isPrototypeHost(SUBDOMAIN_HOST)).toBe(false)
  })
})

/**
 * The middleware chain in the order `create-app.ts` mounts it — scope →
 * subdomain rewrite → API fence → shell API → serve router → terminal fence —
 * plus the Next.js catch-all that `server/index.ts` mounts after `createApp`
 * returns. The catch-all is what the terminal fence exists to keep a
 * prototype-host request away from, so a chain without it could not show the
 * fence doing anything.
 *
 * The Host allowlist is deliberately absent — it is a separate boundary with
 * its own suite, and leaving it out proves the scoping holds on its own rather
 * than because the allowlist happened to refuse the host first.
 */
describe("createPrototypeHostScope + the two fences", () => {
  const registry: PrototypeHostRegistry = composePrototypeHostRegistries(
    createServeDomainRegistry(DOMAIN),
    { isPrototypeHost: (host) => host === LOOPBACK_HOST },
  )

  const stable = createSwappableApp()
  const inner = express()
  inner.use(createPrototypeHostScope({ registry }))
  inner.use(createSubdomainRewrite(DOMAIN))
  inner.use(createPrototypeHostApiFence())

  /** Stands in for every shell route: it sets a sentinel AND a session cookie. */
  const shellApi = (_req: express.Request, res: express.Response): void => {
    res.setHeader(SENTINEL, "1")
    res.setHeader("Set-Cookie", "viewer_session=s3cret; Path=/; HttpOnly")
    res.json({ shell: true })
  }
  inner.get("/api/v1/ping", shellApi)
  inner.post("/api/v1/auth/logout", shellApi)
  // Stands in for a Next shell PAGE. The requirement is about every shell
  // router, not only the JSON API — a sign-in page on a prototype origin is
  // the exact thing that must not exist.
  inner.get("/signin", shellApi)

  /**
   * Stands in for the serve router: echoes the path routing actually used.
   *
   * Matches what the real one matches — `/p/{slug}/…` with a NON-EMPTY slug,
   * since both real routes (`/p/:slug` and `/p/:slug/{*rest}`) require one.
   * `/p/` exactly falls through here, exactly as it does in the real app,
   * which is the gap the terminal fence closes.
   */
  inner.use((req, res, next) => {
    if (!/^\/p\/[^/]/.test(req.url)) return next()
    res.status(200).type("text/plain").send(req.url)
  })
  inner.use(createPrototypeHostTerminalFence())
  /**
   * Stands in for the Next.js catch-all `server/index.ts` mounts last. It
   * answers everything, with the shell sentinel and an HTML body — so any
   * assertion below that sees `Not found` in `text/plain` has proved the
   * terminal fence got there first.
   */
  inner.use((_req, res) => {
    res.setHeader(SENTINEL, "1")
    res.status(404).type("text/html").send("<!doctype html><h1>shell 404</h1>")
  })
  stable.use(inner)

  const app = stable.app

  describe("on the shell host", () => {
    it("routes the API exactly as before", async () => {
      const res = await request(app).get("/api/v1/ping").set("Host", SHELL_HOST).expect(200)
      expect(res.headers[SENTINEL]).toBe("1")
      expect(res.headers["set-cookie"]).toBeDefined()
    })

    it("routes /p/** exactly as before", async () => {
      const res = await request(app).get("/p/acme/").set("Host", SHELL_HOST).expect(200)
      expect(res.text).toBe("/p/acme/")
    })

    it("routes a shell page exactly as before", async () => {
      const res = await request(app).get("/signin").set("Host", SHELL_HOST).expect(200)
      expect(res.headers[SENTINEL]).toBe("1")
    })

    it("still falls through to the shell catch-all for an unmatched path", async () => {
      // The control for the terminal-fence tests below: on the shell host
      // `/p/` is Next's to answer, and it still is.
      const res = await request(app).get("/p/").set("Host", SHELL_HOST).expect(404)
      expect(res.headers[SENTINEL]).toBe("1")
      expect(res.headers["content-type"]).toMatch(/^text\/html/)
    })

    it("routes a non-GET method exactly as before", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Host", SHELL_HOST)
        .expect(200)
      expect(res.headers[SENTINEL]).toBe("1")
    })
  })

  describe("on a serve-domain prototype host", () => {
    it("resolves an API path as prototype content, never as the API", async () => {
      const res = await request(app).get("/api/v1/ping").set("Host", SUBDOMAIN_HOST).expect(200)
      expect(res.text).toBe("/p/acme/api/v1/ping")
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    /**
     * The prototype OWNS `/` on its origin, so a static export's own asset
     * path and its own SPA route must both be served, not blacklisted. This
     * is why the rule is "the shell's routers are unreachable" and not "these
     * paths are refused".
     */
    it("serves the prototype's own root-absolute asset path", async () => {
      const res = await request(app)
        .get("/_next/static/x.js")
        .set("Host", SUBDOMAIN_HOST)
        .expect(200)
      expect(res.text).toBe("/p/acme/_next/static/x.js")
    })

    it("serves the prototype's own SPA route", async () => {
      const res = await request(app).get("/settings").set("Host", SUBDOMAIN_HOST).expect(200)
      expect(res.text).toBe("/p/acme/settings")
    })

    it("cannot reach a shell page, sign-in included", async () => {
      const res = await request(app).get("/signin").set("Host", SUBDOMAIN_HOST).expect(200)
      expect(res.text).toBe("/p/acme/signin")
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("refuses a mutating method with the serve router's not-found body", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Host", SUBDOMAIN_HOST)
        .expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
      expect(res.headers["content-type"]).toMatch(/^text\/plain/)
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("refuses a mutating method even on a genuine prototype path", async () => {
      const res = await request(app).put("/p/acme/x").set("Host", SUBDOMAIN_HOST).expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
    })

    it("never falls through to the shell catch-all", async () => {
      // `/p/` is rewritten to `/p/acme/p/` here, so the stub serve router
      // answers it. Asserted anyway, because the property the requirement
      // states is about the catch-all being unreachable, not about which
      // layer happens to answer first.
      const res = await request(app).get("/p/").set("Host", SUBDOMAIN_HOST)
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["content-type"] ?? "").not.toMatch(/text\/html/)
    })

    it("passes HEAD, which a prototype asset fetch legitimately uses", async () => {
      const res = await request(app).head("/api/v1/ping").set("Host", SUBDOMAIN_HOST).expect(200)
      expect(res.headers[SENTINEL]).toBeUndefined()
    })
  })

  /**
   * A loopback listener port with no rewrite mounted — exactly the state
   * Task 5's per-deployment apps start in. The fence is what holds the
   * invariant there: without it, `/api/v1/ping` on that host would reach the
   * shell API with a full session cookie.
   */
  describe("on a loopback prototype host with no rewrite behind it", () => {
    it("fences the API off", async () => {
      const res = await request(app).get("/api/v1/ping").set("Host", LOOPBACK_HOST).expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("fences a shell page off too, sign-in included", async () => {
      const res = await request(app).get("/signin").set("Host", LOOPBACK_HOST).expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("lets /p/** through", async () => {
      const res = await request(app).get("/p/acme/").set("Host", LOOPBACK_HOST).expect(200)
      expect(res.text).toBe("/p/acme/")
    })

    /**
     * The case the prefix rule structurally cannot catch: `/p/` passes the
     * API fence, matches no serve route, and without the terminal fence lands
     * on the shell catch-all — shell HTML on a prototype origin.
     */
    it("refuses a /p/-prefixed path that no serve route matches", async () => {
      const res = await request(app).get("/p/").set("Host", LOOPBACK_HOST).expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
      expect(res.headers["content-type"]).toMatch(/^text\/plain/)
      expect(res.headers[SENTINEL]).toBeUndefined()
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("refuses a mutating method", async () => {
      const res = await request(app)
        .post("/api/v1/auth/logout")
        .set("Host", LOOPBACK_HOST)
        .expect(404)
      expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })
  })
})

/** One route the app registers, with the method it is registered for. */
interface ApiRoute {
  method: string
  path: string
}

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean> }
  handle?: { stack?: unknown[] }
}

function collectRoutes(stack: unknown[], prefix: string, out: ApiRoute[]): void {
  for (const layer of stack as RouteLayer[]) {
    if (layer.route) {
      const path = `${prefix}${String(layer.route.path)}`
      for (const method of Object.keys(layer.route.methods)) {
        if (method === "_all") continue
        out.push({ method: method.toUpperCase(), path })
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      // Every API sub-router is mounted at the API router's own root
      // (`api-router.ts` — `router.use(createXRoutes(...))`, no path), so the
      // prefix carries through unchanged. The known-route assertions below
      // are what would catch that ceasing to be true.
      collectRoutes(layer.handle.stack, prefix, out)
    }
  }
}

/**
 * Every route the API router registers, read off Express's own layer stack
 * rather than from a hand-written list — a hand-written list is exactly what
 * goes stale the day someone adds a route.
 *
 * Walks the router `create-app.ts` mounts rather than reaching into the app
 * object: Express 5 does not expose a mounted layer's path until a request
 * has matched it, so the mount prefix has to come from somewhere. It comes
 * from a live request instead (`GET /api/v1/health` answering on the shell
 * host, asserted in the test below), which is a stronger check than reading a
 * private field would have been.
 */
function apiRoutesOf(router: Router, prefix: string): ApiRoute[] {
  const out: ApiRoute[] = []
  collectRoutes((router as unknown as { stack: unknown[] }).stack, prefix, out)
  return out
}

/** `/projects/:id` → `/projects/probe`; throws on a shape it cannot fill in. */
function materialize(path: string): string {
  const filled = path
    .replace(/\{[^}]*\}/g, "")
    .replace(/:[A-Za-z_][\w]*/g, "probe")
    .replace(/\*[A-Za-z_][\w]*/g, "probe")
    .replace(/\*/g, "probe")
  if (/[:*{}]/.test(filled)) throw new Error(`unfillable route path: ${path}`)
  return filled
}

describe("prototype-host scoping in the real app", () => {
  let storage: InMemoryStorage
  let deps: AppDeps
  const stable = createSwappableApp()

  const html = (body: string): StoredAsset => ({
    body: Buffer.from(body),
    contentType: "text/html",
  })

  function assetsWith(files: Record<string, StoredAsset>): AssetStore {
    return {
      async put() {},
      async get(_deploymentId, relPath) {
        return files[relPath] ?? null
      },
      async deleteDeployment() {},
    }
  }

  beforeEach(async () => {
    storage = new InMemoryStorage()
    const project = await storage.createProject({
      slug: "acme",
      name: "acme",
      access: "public-link",
    })
    const deployment = await storage.createDeployment({
      projectId: project.id,
      status: "deployed",
    })
    await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    deps = {
      storage,
      assets: assetsWith({ "index.html": html("<!doctype html><h1>prototype</h1>") }),
      config: loadConfig({
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_SERVE_DOMAIN: DOMAIN,
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      }),
      bridgeScript: "// bridge",
      bridgeVersion: "test-1",
      github: testGithubRuntime(),
      // Built explicitly rather than left to the test factory's default,
      // because the route-table walk below hands this same `deps` to the REAL
      // `createApiRouter`, whose `AppDeps` requires the field. Nothing here
      // ever opens a listener — a serve domain is configured, so the
      // prototype-origin route answers "subdomain" and never calls `ensure`.
      prototypeListeners: createTestPrototypeListeners({
        storage,
        assets: assetsWith({}),
        config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
      }),
    }
    stable.use(createApp(deps))
  })

  afterEach(async () => {
    await deps.prototypeListeners.closeAll()
  })

  it("serves the prototype at the origin root", async () => {
    const res = await request(stable.app).get("/").set("Host", SUBDOMAIN_HOST).expect(200)
    expect(res.text).toContain("<h1>prototype</h1>")
  })

  it("answers the shell's own identity route with prototype content and no cookie", async () => {
    const onShell = await request(stable.app).get("/api/v1/me").set("Host", SHELL_HOST)
    expect(onShell.headers["content-type"]).toMatch(/application\/json/)

    const onPrototype = await request(stable.app).get("/api/v1/me").set("Host", SUBDOMAIN_HOST)
    expect(onPrototype.headers["content-type"] ?? "").not.toMatch(/application\/json/)
    expect(onPrototype.headers["set-cookie"]).toBeUndefined()
    // The SPA fallback: an extensionless miss is the prototype's own route.
    expect(onPrototype.text).toContain("<h1>prototype</h1>")
  })

  it("refuses a sign-out POST with the serve router's not-found body", async () => {
    const res = await request(stable.app)
      .post("/api/v1/auth/logout")
      .set("Host", SUBDOMAIN_HOST)
      .expect(404)
    expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  /**
   * `GET /p/` exactly — the path the API fence's prefix rule lets through and
   * no serve route matches. On the slug host the rewrite makes it
   * `/p/acme/p/`, so the serve router answers it and the terminal fence is
   * not what fires; the assertion is on the OBSERVABLE contract either way,
   * which is that it is a prototype 404 in `text/plain` and never Next's HTML
   * 404 page. The unit suite above is where the fence itself is shown to bite,
   * on a prototype host with no rewrite behind it.
   */
  it("answers GET /p/ with a plain-text prototype 404, never a shell page", async () => {
    const res = await request(stable.app).get("/p/").set("Host", SUBDOMAIN_HOST).expect(404)
    expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
    expect(res.headers["content-type"]).toMatch(/^text\/plain/)
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("uses the same not-found body the serve router already sends", async () => {
    // An extensioned miss under `/p/**` takes the serve router's generic
    // not-found branch, which is the body the scope and fence must match
    // byte for byte.
    const res = await request(stable.app)
      .get("/p/acme/missing.js")
      .set("Host", SHELL_HOST)
      .expect(404)
    expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
  })

  /**
   * The invariant, stated over the app's own route table rather than over a
   * list someone remembered to update: NO route registered under the API
   * mount answers on a prototype host, and none of them sets a cookie there.
   */
  it("reaches no API route at all on a prototype host", async () => {
    // Grounds the `/api/v1` prefix the walk assumes in observed behaviour:
    // the API really does answer there on the shell host.
    const health = await request(stable.app).get("/api/v1/health").set("Host", SHELL_HOST)
    expect(health.status).toBe(200)
    expect(health.body.status).toBe("ok")

    const routes = apiRoutesOf(createApiRouter(deps), "/api/v1")
    // A walker that silently found nothing would pass every assertion below.
    expect(routes.length).toBeGreaterThan(30)
    const signatures = routes.map((r) => `${r.method} ${r.path}`)
    expect(signatures).toContain("GET /api/v1/me")
    expect(signatures).toContain("GET /api/v1/health")
    expect(signatures).toContain("POST /api/v1/auth/logout")

    for (const route of routes) {
      const path = materialize(route.path)
      const res = await request(stable.app)
        [route.method.toLowerCase() as "get"](path)
        .set("Host", SUBDOMAIN_HOST)
      expect(res.headers["set-cookie"], `${route.method} ${path} set a cookie`).toBeUndefined()
      expect(
        res.headers["content-type"] ?? "",
        `${route.method} ${path} answered with JSON`,
      ).not.toMatch(/application\/json/)
      if (route.method !== "GET" && route.method !== "HEAD") {
        // Refused by the scope itself, not merely unrouted. Without the
        // scope these fall through to Express's default HTML 404, which is
        // also harmless but says nothing about the boundary holding.
        expect(res.status, `${route.method} ${path}`).toBe(404)
        expect(res.text, `${route.method} ${path}`).toBe(PROTOTYPE_NOT_FOUND_BODY)
      }
    }
  })

  it("leaves the byte-identical 404 for an unreadable project intact", async () => {
    const locked = await storage.createProject({ slug: "locked", name: "L", access: "invited" })
    const deployment = await storage.createDeployment({
      projectId: locked.id,
      status: "deployed",
    })
    await storage.updateProject(locked.id, { activeDeploymentId: deployment.id })

    const missing = await request(stable.app).get("/").set("Host", `nosuchslug.${DOMAIN}:3100`)
    const unreadable = await request(stable.app).get("/").set("Host", `locked.${DOMAIN}:3100`)
    expect(missing.status).toBe(404)
    expect(unreadable.status).toBe(404)
    expect(unreadable.text).toBe(missing.text)
  })
})

/**
 * The security invariant for `VIEWER_PROTOTYPE_ORIGIN`, over the REAL app: a
 * request on the single shared prototype origin serves prototype content, is
 * fenced from every shell router, and NO session cookie is ever issued there.
 * The prototype-origin host reaches the fences because `create-app.ts`
 * registers `createPrototypeOriginRegistry` in the composite that
 * `createPrototypeHostScope` reads — the same way subdomain mode reaches them.
 */
describe("prototype-origin host scoping in the real app (VIEWER_PROTOTYPE_ORIGIN)", () => {
  const PROTO_HOST = "proto.example.net"
  const SHELL = "app.example.com"
  let storage: InMemoryStorage
  let deps: AppDeps
  const stable = createSwappableApp()

  const html = (body: string): StoredAsset => ({ body: Buffer.from(body), contentType: "text/html" })
  function assetsWith(files: Record<string, StoredAsset>): AssetStore {
    return {
      async put() {},
      async get(_deploymentId, relPath) {
        return files[relPath] ?? null
      },
      async deleteDeployment() {},
    }
  }

  beforeEach(async () => {
    storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "acme", access: "public-link" })
    const deployment = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    deps = {
      storage,
      assets: assetsWith({ "index.html": html("<!doctype html><head></head><h1>prototype</h1>") }),
      config: loadConfig({
        VIEWER_PUBLIC_URL: "https://app.example.com",
        VIEWER_PROTOTYPE_ORIGIN: "https://proto.example.net",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      }),
      bridgeScript: "// bridge",
      bridgeVersion: "test-1",
      github: testGithubRuntime(),
      // Never opens a listener: prototype-origin mode answers without one.
      prototypeListeners: createTestPrototypeListeners({
        storage,
        assets: assetsWith({}),
        config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
      }),
    }
    stable.use(createApp(deps))
  })

  afterEach(async () => {
    await deps.prototypeListeners.closeAll()
  })

  it("serves the prototype under /p/{slug}/, path-namespaced with the isolated CSP and no cookie", async () => {
    const res = await request(stable.app).get("/p/acme/").set("Host", PROTO_HOST).expect(200)
    expect(res.text).toContain("<h1>prototype</h1>")
    // Isolated CSP (cross-origin), no ACAO, and crucially NO session cookie.
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'")
    expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    expect(res.headers["set-cookie"]).toBeUndefined()
    // Path-namespaced: the base href carries the /p/{slug}/ prefix.
    expect(res.text).toContain('<base href="/p/acme/">')
  })

  it("refuses a sign-out POST on the prototype origin and sets no cookie", async () => {
    const res = await request(stable.app).post("/api/v1/auth/logout").set("Host", PROTO_HOST).expect(404)
    expect(res.text).toBe(PROTOTYPE_NOT_FOUND_BODY)
    expect(res.headers["set-cookie"]).toBeUndefined()
  })

  it("does not route the shell API on the prototype origin (fenced before the shell routers)", async () => {
    // Grounds the claim: the API really does answer on the shell host.
    const onShell = await request(stable.app).get("/api/v1/health").set("Host", SHELL)
    expect(onShell.status).toBe(200)

    const onProto = await request(stable.app).get("/api/v1/me").set("Host", PROTO_HOST)
    expect(onProto.headers["content-type"] ?? "").not.toMatch(/application\/json/)
    expect(onProto.headers["set-cookie"]).toBeUndefined()
  })
})

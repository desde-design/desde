import express from "express"
import { createServer, request as nodeHttpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../../config"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { UnsafePathError, type AssetStore, type StoredAsset } from "../../assets/types"
import { readBridgeBundle } from "../html-inject"
import { contentTypeFor } from "../mime"
import { buildHostAllowlist, isAllowedHost } from "../host-allowlist"
import { resolveOrigins } from "../prototype-origin-resolve"
import { PrototypeProcessError, type PrototypeProcesses } from "../prototype-processes"
import { createServeRouter, type PinnedDeploymentRequest } from "../serve-router"
import { resolveIsolatedOriginServerCsp, type SubdomainRequest } from "../subdomain"
import type { PrototypeOriginHostRequest } from "../prototype-host-scope"
import { mintPrototypeCapability } from "../prototype-capability"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const openConfig = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
const authedConfig = loadConfig({
  VIEWER_GITHUB_CLIENT_ID: "client-id",
  VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
  VIEWER_SESSION_SECRET: "sesh-secret",
  VIEWER_PUBLIC_URL: "https://viewer.example.com",
  VIEWER_DATA_DIR: tmpViewerDataDir(),
})

class FakeAssetStore implements AssetStore {
  private files = new Map<string, Buffer>()
  async put(deploymentId: string, relPath: string, body: Buffer): Promise<void> {
    this.files.set(`${deploymentId}:${relPath}`, body)
  }
  async get(deploymentId: string, relPath: string): Promise<StoredAsset | null> {
    if (relPath.includes("..")) throw new UnsafePathError(`Invalid asset path: ${relPath}`)
    const body = this.files.get(`${deploymentId}:${relPath}`)
    return body ? { body, contentType: contentTypeFor(relPath) } : null
  }
  async deleteDeployment(): Promise<void> {}
}

/** Simulates a genuine I/O fault (e.g. EACCES) — NOT a path-safety violation. */
class FaultyAssetStore implements AssetStore {
  async put(): Promise<void> {}
  async get(): Promise<StoredAsset | null> {
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
    err.code = "EACCES"
    throw err
  }
  async deleteDeployment(): Promise<void> {}
}

const BRIDGE = "console.log('bridge')"
const BRIDGE_VERSION = "test-version"
const BRIDGE_URL = `/p/acme/__desde/bridge-${BRIDGE_VERSION}.js`

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 *
 * `setup()` is called both from `beforeEach` and directly inside 18 tests that
 * need a different `config` or `prototypeCsp`, and each call used to build a
 * fresh `express()`. That was 37 listening servers per run for this file alone.
 *
 * Sharing one object is safe here because every test uses EITHER the `ctx` from
 * `beforeEach` OR exactly one locally-built ctx, never both — checked test by
 * test. Note `servePage()` takes its ctx as a parameter, which is what keeps the
 * CSP tests that build their own (`offCtx`, `customCtx`) from touching `ctx`.
 */
const stable = createSwappableApp()

/**
 * The pinned-deployment marker a loopback listener sets on every request it
 * forwards to this router (`serve/loopback-listener-app.ts`).
 *
 * Held in a mutable module variable rather than passed to `setup()` because a
 * test only learns the deployment id AFTER it has created the deployment,
 * which is after the app is built. `setup()` clears it, so a test that does
 * not set it sees the ordinary path-mode behaviour.
 */
let pinnedMarker: { deploymentId: string; slug: string } | null = null

/**
 * The subdomain marker the `createSubdomainRewrite` middleware sets on a
 * `{slug}.{serveDomain}` request (`serve/subdomain.ts`). Set per test so the
 * router's `onSubdomain` branch — the only one that reads a `?~c=` query or a
 * `dsv_cap` cookie — can be exercised directly, the same way `pinnedMarker`
 * exercises the loopback branch. `setup()` clears it.
 */
let subdomainMarker: string | null = null

/**
 * The `onPrototypeOrigin` marker `createPrototypeOriginMark`
 * (`serve/prototype-host-scope.ts`) sets on a request to the single
 * `VIEWER_PROTOTYPE_ORIGIN` host. Set per test so the router's
 * `isIsolatedOrigin` branch can be exercised directly. Unlike `subdomainMarker`
 * / `pinnedMarker`, this mode is path-namespaced: the request still arrives as
 * `/p/{slug}/...` and the router STILL rewrites root-absolute assets and uses
 * the prefixed bridge path — it only takes the isolated CSP and drops ACAO.
 * `setup()` clears it.
 */
let prototypeOriginMarker = false

/**
 * A `PrototypeProcesses` (`serve/prototype-processes.ts`) that does nothing,
 * with any method replaceable per test.
 *
 * The default `ensure` REJECTS rather than returning a port: every test in
 * this file except the server-deployment block below serves a `static`
 * deployment, so an `ensure` that quietly succeeded would hide a router that
 * started forking on the wrong condition.
 */
function fakeProcesses(overrides: Partial<PrototypeProcesses> = {}): PrototypeProcesses {
  return {
    ensure: () =>
      Promise.reject(new PrototypeProcessError({ state: "stopped" }, "No process manager in this test.")),
    touch: () => {},
    withLease: (_id, fn) => fn(),
    stop: () => Promise.resolve(),
    forget: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    markUnreachable: () => Promise.resolve(),
    status: () => ({ state: "stopped" }),
    subscribe: () => () => {},
    serverLog: () => "",
    startReaper: () => () => {},
    shutdown: () => Promise.resolve(),
    ...overrides,
  }
}

async function setup(
  overrides: {
    prototypeCsp?: string | null
    config?: ReturnType<typeof loadConfig>
    prototypeProcesses?: PrototypeProcesses
  } = {},
) {
  pinnedMarker = null
  subdomainMarker = null
  prototypeOriginMarker = false
  const storage = new InMemoryStorage()
  const assets = new FakeAssetStore()
  const inner = express()
  inner.use((req, _res, next) => {
    if (pinnedMarker) (req as unknown as PinnedDeploymentRequest).pinnedDeployment = pinnedMarker
    if (subdomainMarker) (req as unknown as SubdomainRequest).prototypeSubdomain = subdomainMarker
    if (prototypeOriginMarker) (req as unknown as PrototypeOriginHostRequest).onPrototypeOrigin = true
    next()
  })
  inner.use(
    createServeRouter({
      storage,
      assets,
      config: overrides.config ?? openConfig,
      resolveShellOrigin: () => "https://viewer.example.com",
      bridgeScript: BRIDGE,
      bridgeVersion: BRIDGE_VERSION,
      prototypeCsp: overrides.prototypeCsp ?? null,
      prototypeProcesses: overrides.prototypeProcesses ?? fakeProcesses(),
    }),
  )
  stable.use(inner)
  return { storage, assets, app: stable.app }
}

describe("createServeRouter", () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  it("404s an unknown slug", async () => {
    await request(ctx.app).get("/p/nope/").expect(404)
  })

  it("404s a project with no active deployment", async () => {
    await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const res = await request(ctx.app).get("/p/acme/").expect(404)
    expect(res.text).toMatch(/no deployment/i)
  })

  it("redirects the bare slug to a trailing slash", async () => {
    await request(ctx.app).get("/p/acme").expect(301).expect("location", "/p/acme/")
  })

  it("serves index.html with base href and an external bridge <script src> — never inlined", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(
      deployment.id,
      "index.html",
      Buffer.from("<html><head></head><body><h1>hi</h1></body></html>"),
    )

    const res = await request(ctx.app).get("/p/acme/").expect(200)

    expect(res.headers["content-type"]).toMatch(/text\/html/)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.text).toContain('<base href="/p/acme/">')
    expect(res.text).toContain(`data-prototype-flow="bridge"`)
    expect(res.text).toContain(`src="${BRIDGE_URL}"`)
    // The bundle body itself is not inlined into the HTML.
    expect(res.text).not.toContain(BRIDGE)
    expect(res.text).toContain(
      'window.__DESDE_SHELL_ORIGIN__="https://viewer.example.com"',
    )
  })

  // CORS: the review shell's sandboxed iframe (no allow-same-origin) gives
  // the prototype document an opaque origin, so a Vite build's
  // `<script type="module" crossorigin>` entry is a CORS fetch sent with
  // `Origin: null`. See `prototype-cors.ts` for why `*` is safe here — a
  // credentialed response is never exposed under ACAO `*`, so this cannot
  // widen what a session cookie authorizes.
  //
  // Every test in this block is PATH MODE (no subdomain marker, no pinned
  // marker), which is the only mode that gets the header. The isolated modes
  // must NOT — see the pinned case below and `subdomain.test.ts`.
  describe("Access-Control-Allow-Origin", () => {
    it("sends ACAO * on served HTML", async () => {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>hi</body></html>"))

      const res = await request(ctx.app).get("/p/acme/").expect(200)
      expect(res.headers["access-control-allow-origin"]).toBe("*")
    })

    it("sends ACAO * on a static asset (the module script CORS blocks without it)", async () => {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(deployment.id, "assets/index.js", Buffer.from("export const a=1"))

      const res = await request(ctx.app).get("/p/acme/assets/index.js").expect(200)
      expect(res.headers["access-control-allow-origin"]).toBe("*")
    })

    it("sends ACAO * on the bridge bundle response", async () => {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>hi</body></html>"))

      const res = await request(ctx.app).get(BRIDGE_URL).expect(200)
      expect(res.headers["access-control-allow-origin"]).toBe("*")
    })

    // The byte-identical private-project 404 must stay byte-identical —
    // adding a header only to the 404 response for a real-but-unreadable
    // project would make it distinguishable from the unknown-slug 404,
    // reopening the existence-oracle hole `canReadProject` closes.
    it("does NOT add ACAO to the byte-identical private-project 404", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(deployment.id, "index.html", Buffer.from("<html><body>secret</body></html>"))

      const denied = await request(locked.app).get("/p/locked/").expect(404)
      const missing = await request(locked.app).get("/p/nope/").expect(404)
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined()
      expect(missing.headers["access-control-allow-origin"]).toBeUndefined()
      expect(denied.text).toBe(missing.text)
    })
  })

  it("serves a nested static asset untouched", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(deployment.id, "assets/app.js", Buffer.from("export const a=1"))

    const res = await request(ctx.app).get("/p/acme/assets/app.js").expect(200)
    expect(res.headers["content-type"]).toMatch(/text\/javascript/)
    expect(res.headers["cache-control"]).toBe("private, max-age=300")
    expect(res.text).toBe("export const a=1")
    expect(res.text).not.toContain(BRIDGE)
  })

  // Row 5 (narrow): a stylesheet's root-absolute url(/fonts/x.woff2) fetches
  // from the shell root and 404s in path mode, because unlike an HTML
  // <link>/<script> tag, the browser's CSS engine gives nothing a hook to
  // catch the fetch — see the doc comment on `rewriteCssRootRelativeUrls`
  // (viewer/server/serve/css-rewrite.ts) for why this has to be a serve-time
  // text rewrite.
  describe("CSS url() rewrite (path mode)", () => {
    it("rewrites a root-absolute url() in a standalone .css asset", async () => {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(
        deployment.id,
        "assets/app.css",
        Buffer.from("@font-face { src: url(/fonts/x.woff2); }"),
      )

      const res = await request(ctx.app).get("/p/acme/assets/app.css").expect(200)
      expect(res.headers["content-type"]).toMatch(/text\/css/)
      expect(res.text).toBe("@font-face { src: url(/p/acme/fonts/x.woff2); }")
    })

    it("rewrites under the capability-prefixed path too", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "owner-css",
        email: "owner-css@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(
        deployment.id,
        "assets/app.css",
        Buffer.from("background: url('/img/bg.png');"),
      )
      const token = mintPrototypeCapability({
        secret: authedConfig.sessionSecret,
        slug: "locked",
        deploymentId: deployment.id,
      })

      const res = await request(locked.app).get(`/p/locked/~c/${token}/assets/app.css`).expect(200)
      expect(res.text).toBe(`background: url('/p/locked/~c/${token}/img/bg.png');`)
    })

    it("leaves protocol-relative, absolute, data and relative url() references alone", async () => {
      const project = await ctx.storage.createProject({ slug: "acme2", name: "Acme2", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      const css = [
        "a{background:url(//cdn.example.com/x.png)}",
        "b{background:url(https://cdn.example.com/y.png)}",
        "c{background:url(data:image/png;base64,AAAA)}",
        "d{background:url(./rel.png)}",
      ].join("")
      await ctx.assets.put(deployment.id, "assets/other.css", Buffer.from(css))

      const res = await request(ctx.app).get("/p/acme2/assets/other.css").expect(200)
      expect(res.text).toBe(css)
    })

    // Documented limit, pinned here at the router level too: a url() value
    // assembled from a CSS custom property only exists at computed-style
    // time, not in the served text, so it passes through unrewritten.
    it("does NOT rewrite a url() built from a CSS custom property (documented limit)", async () => {
      const project = await ctx.storage.createProject({ slug: "acme3", name: "Acme3", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      const css = ":root{--u:/x;} .bg{background:url(var(--u));}"
      await ctx.assets.put(deployment.id, "assets/prop.css", Buffer.from(css))

      const res = await request(ctx.app).get("/p/acme3/assets/prop.css").expect(200)
      expect(res.text).toBe(css)
    })

    it("leaves a non-CSS asset byte-identical even if it contains url(/x)-shaped text", async () => {
      const project = await ctx.storage.createProject({ slug: "acme4", name: "Acme4", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      const js = `const css = "url(/fonts/x.woff2)"`
      await ctx.assets.put(deployment.id, "assets/app.js", Buffer.from(js))

      const res = await request(ctx.app).get("/p/acme4/assets/app.js").expect(200)
      expect(res.text).toBe(js)
    })
  })

  it("serves an asset whose filename contains a literal %", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(deployment.id, "100%.png", Buffer.from("fake-png-bytes"))

    // .png is a binary content type, so supertest parses the body into
    // `res.body` (a Buffer) rather than `res.text`.
    const res = await request(ctx.app).get("/p/acme/100%25.png").expect(200)
    expect(Buffer.from(res.body).toString()).toBe("fake-png-bytes")
  })

  it("falls back to index.html for extensionless SPA routes", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(
      deployment.id,
      "index.html",
      Buffer.from("<html><head></head><body>app</body></html>"),
    )

    const res = await request(ctx.app).get("/p/acme/settings/profile").expect(200)
    expect(res.text).toContain("app")
    expect(res.text).toContain(`data-prototype-flow="bridge"`)
    expect(res.text).toContain(`src="${BRIDGE_URL}"`)
  })

  it("404s a missing file that has an extension", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(deployment.id, "index.html", Buffer.from("<body>app</body>"))

    await request(ctx.app).get("/p/acme/missing.js").expect(404)
  })

  it("400s a traversal attempt", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })

    await request(ctx.app).get("/p/acme/..%2F..%2Fetc%2Fpasswd").expect(400)
  })

  it("does not mask a genuine I/O fault as a 400", async () => {
    const storage = new InMemoryStorage()
    const assets = new FaultyAssetStore()
    const inner = express()
    inner.use(
      createServeRouter({
        storage,
        assets,
        config: openConfig,
        resolveShellOrigin: () => "https://viewer.example.com",
        bridgeScript: BRIDGE,
        bridgeVersion: BRIDGE_VERSION,
        prototypeCsp: null,
        prototypeProcesses: fakeProcesses(),
      }),
    )
    // Built inline rather than via `setup()` (it needs the faulty asset store),
    // but still the file's one app object — this is the only app this test uses.
    stable.use(inner)
    const app = stable.app

    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await storage.createDeployment({ projectId: project.id })
    await storage.updateProject(project.id, { activeDeploymentId: deployment.id })

    const res = await request(app).get("/p/acme/index.html")
    expect(res.status).not.toBe(400)
    expect(res.status).toBe(500)
  })

  it("rewrites root-relative asset URLs in served HTML to the prototype prefix", async () => {
    const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await ctx.storage.createDeployment({ projectId: project.id })
    await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    await ctx.assets.put(
      deployment.id,
      "index2.html",
      Buffer.from(`<!doctype html><html><head><script src="/assets/app.js"></script></head><body></body></html>`),
    )
    const res = await request(ctx.app).get("/p/acme/index2.html")
    expect(res.status).toBe(200)
    expect(res.text).toContain(`src="/p/acme/assets/app.js"`)
    expect(res.text).not.toContain(`src="/assets/app.js"`)
  })

  describe("Content-Security-Policy", () => {
    async function servePage(pageCtx: Awaited<ReturnType<typeof setup>>, path: string) {
      const project = await pageCtx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await pageCtx.storage.createDeployment({ projectId: project.id })
      await pageCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pageCtx.assets.put(
        deployment.id,
        "index.html",
        Buffer.from("<html><head></head><body>app</body></html>"),
      )
      await pageCtx.assets.put(deployment.id, "assets/app.js", Buffer.from("export const a=1"))
      return request(pageCtx.app).get(path)
    }

    it("sets a CSP on served HTML, path-scoped to the prototype's own prefix, no bare 'self'", async () => {
      const res = await servePage(ctx, "/p/acme/")
      expect(res.status).toBe(200)
      const csp = res.headers["content-security-policy"]
      expect(csp).toBeDefined()
      expect(csp).toContain("connect-src https://viewer.example.com/p/acme/")
      expect(csp).not.toMatch(/connect-src[^;]*'self'/)
    })

    // Live-run finding (Phase 3b-1 acceptance): the strict resource policy
    // this default used to have blocked the bridge itself (injected as an
    // inline <script>), plus the prototype's own inline scripts, Google
    // Fonts, and inline styles. The resource directives now permit inline
    // content and https: origins so real prototypes — including the
    // bridge — actually work.
    it("permits inline scripts/styles and remote fonts/images so the bridge and prototype JS run", async () => {
      const res = await servePage(ctx, "/p/acme/")
      const csp = res.headers["content-security-policy"]
      expect(csp).toContain("script-src 'self' 'unsafe-inline'")
      expect(csp).toContain("style-src 'self' 'unsafe-inline' https:")
      expect(csp).toContain("font-src 'self' data: https:")
      expect(csp).toContain("img-src 'self' data: blob: https:")
      expect(csp).not.toContain("'unsafe-eval'")
    })

    // The security claim of this CSP is carried entirely by these four
    // directives, none of which the resource loosening above touches. A
    // future edit that widens the resource directives must not accidentally
    // touch these — this test exists to fail loudly if it does.
    it("keeps the API-reaching directives strict regardless of the resource policy", async () => {
      const res = await servePage(ctx, "/p/acme/")
      const csp = res.headers["content-security-policy"]
      expect(csp).toContain("connect-src https://viewer.example.com/p/acme/")
      expect(csp).not.toMatch(/connect-src[^;]*'self'/)
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("form-action 'none'")
    })

    // CRITICAL fix (whole-branch review): the CSP used to be set ONLY inside
    // the `isHtml` branch. `.svg` maps to `image/svg+xml` — a scriptable,
    // same-origin document type (see `mime.ts`) — so a hostile bundle could
    // ship a `payload.svg` with an inline `<script>`, self-navigate the
    // frame into it (`location.href = '/p/acme/payload.svg'`, a same-frame
    // navigation `frame-src`/`object-src` do not govern), and execute with
    // NO CSP at all: full read access to `/api/v1/**` via `fetch` with the
    // reviewer's session cookie. Every non-HTML asset must carry the same
    // policy — it's inert on JS/CSS/images and load-bearing on any
    // scriptable type.
    it("sets the CSP header on non-HTML assets too (inert on JS, load-bearing on scriptable types like SVG)", async () => {
      const res = await servePage(ctx, "/p/acme/assets/app.js")
      expect(res.status).toBe(200)
      const csp = res.headers["content-security-policy"]
      expect(csp).toBeDefined()
      expect(csp).toContain("connect-src https://viewer.example.com/p/acme/")
    })

    it("sets the CSP header AND X-Content-Type-Options: nosniff on a served .svg — the scriptable, same-origin bypass this policy must close", async () => {
      const project = await ctx.storage.createProject({ slug: "svgtest", name: "SvgTest", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(
        deployment.id,
        "payload.svg",
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
      )

      const res = await request(ctx.app).get("/p/svgtest/payload.svg").expect(200)
      expect(res.headers["content-type"]).toMatch(/image\/svg\+xml/)
      const csp = res.headers["content-security-policy"]
      expect(csp).toBeDefined()
      expect(csp).toContain("connect-src https://viewer.example.com/p/svgtest/")
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("object-src 'none'")
      expect(res.headers["x-content-type-options"]).toBe("nosniff")
    })

    it("sends no CSP header when prototypeCsp is the literal 'off'", async () => {
      const offCtx = await setup({ prototypeCsp: "off" })
      const res = await servePage(offCtx, "/p/acme/")
      expect(res.status).toBe(200)
      expect(res.headers["content-security-policy"]).toBeUndefined()
    })

    it("sends a custom CSP string verbatim when configured", async () => {
      const customCtx = await setup({ prototypeCsp: "default-src 'none'" })
      const res = await servePage(customCtx, "/p/acme/")
      expect(res.status).toBe(200)
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'")
    })

    // Regression coverage for the same-origin iframe bypass: with no
    // explicit frame-src, it falls back to `default-src 'self'`, which
    // permits a hosted prototype to `<iframe src="/api/v1/projects">` and
    // read `contentDocument` directly — connect-src doesn't govern framing
    // at all, so scoping it alone doesn't close this. object-src is closed
    // for the same reason: `<object>`/`<embed>` can achieve an equivalent
    // same-origin contentDocument read. form-action closes the sibling
    // exfiltration vector (a same-origin form auto-submitted to an
    // attacker-controlled action="https://evil.example").
    it("blocks framing and object/embed and form submission by default", async () => {
      const res = await servePage(ctx, "/p/acme/")
      const csp = res.headers["content-security-policy"]
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("form-action 'none'")
    })

    // A real origin (the alternate-loopback / per-deployment work this task
    // prepares for) makes service workers registrable — `isSecureContext` and
    // `navigator.serviceWorker` both go live on a non-opaque origin. With no
    // explicit `worker-src`, a service-worker script load falls through to
    // `child-src`, which falls through to `script-src`, so it would be
    // PERMITTED today. Denying it here is a deliberate design choice, not a
    // side effect of the capability token's TTL — so it must hold on every
    // content type this policy governs, not just HTML.
    it("denies worker-src on HTML, JS, CSS and SVG", async () => {
      const project = await ctx.storage.createProject({ slug: "workers", name: "Workers", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>app</body></html>"))
      await ctx.assets.put(deployment.id, "assets/app.js", Buffer.from("export const a=1"))
      await ctx.assets.put(deployment.id, "assets/app.css", Buffer.from("body{color:red}"))
      await ctx.assets.put(
        deployment.id,
        "payload.svg",
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
      )

      for (const path of [
        "/p/workers/",
        "/p/workers/assets/app.js",
        "/p/workers/assets/app.css",
        "/p/workers/payload.svg",
      ]) {
        const res = await request(ctx.app).get(path).expect(200)
        expect(res.headers["content-security-policy"]).toContain("worker-src 'none'")
      }
    })

    // Task 9 made the shell origin per-request instead of a fixed
    // `deps.shellOrigin` string. On the CANONICAL host (the one every other
    // test in this file uses) the output must be byte-for-byte what it was
    // before that change — this pins the exact string so a refactor of
    // `resolvePrototypeCsp` or `resolveShellOriginForRequest` cannot quietly
    // drift the fallback policy.
    it("PINNED: the exact default CSP string on the canonical host is byte-identical to before per-request resolution", async () => {
      const res = await servePage(ctx, "/p/acme/")
      const csp = res.headers["content-security-policy"]
      expect(csp).toBe(
        "default-src 'self' data: blob: https://viewer.example.com/p/acme/; " +
          "script-src 'self' 'unsafe-inline' data: blob: https://viewer.example.com/p/acme/; " +
          "style-src 'self' 'unsafe-inline' https: https://viewer.example.com/p/acme/; " +
          "font-src 'self' data: https: https://viewer.example.com/p/acme/; " +
          "img-src 'self' data: blob: https: https://viewer.example.com/p/acme/; " +
          "connect-src https://viewer.example.com/p/acme/; " +
          "frame-src 'none'; " +
          "object-src 'none'; " +
          "worker-src 'none'; " +
          "form-action 'none'; " +
          "frame-ancestors 'self'",
      )
    })
  })

  /**
   * Task 9: `ServeRouterDeps.shellOrigin` (a fixed string) became
   * `resolveShellOrigin: (req) => string`. These tests wire the router to a
   * resolver built the SAME way `create-app.ts` builds the real one —
   * `buildHostAllowlist` + `isAllowedHost` + `resolveOrigins` — so what is
   * under test is the actual production wiring pattern, not a stand-in.
   *
   * `openConfig`'s `publicUrl` is `http://localhost:3100` (no
   * `VIEWER_PUBLIC_URL` set), which is a loopback host — exactly the
   * condition `resolveOrigins` needs to trust the request's `Host` at all.
   */
  describe("per-request shell origin (task 9)", () => {
    function resolverFor(config: ReturnType<typeof loadConfig>) {
      const allowlist = buildHostAllowlist(config)
      return (req: { headers: { host?: string } }): string => {
        const host = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : undefined
        return resolveOrigins({
          requestHost: host,
          hostAllowed: isAllowedHost(allowlist, host, config.serveDomain),
          hostIsPrototype: false,
          publicUrl: config.publicUrl,
          serveDomain: config.serveDomain,
          loopbackAvailable: config.loopbackAvailable,
        }).shellOrigin
      }
    }

    async function buildApp() {
      const storage = new InMemoryStorage()
      const assets = new FakeAssetStore()
      const inner = express()
      inner.use(
        createServeRouter({
          storage,
          assets,
          config: openConfig,
          resolveShellOrigin: resolverFor(openConfig),
          bridgeScript: BRIDGE,
          bridgeVersion: BRIDGE_VERSION,
          prototypeCsp: null,
          prototypeProcesses: fakeProcesses(),
        }),
      )
      stable.use(inner)
      const app = stable.app
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await storage.createDeployment({ projectId: project.id })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await assets.put(deployment.id, "index.html", Buffer.from("<html><head></head><body>hi</body></html>"))
      return app
    }

    it("uses the Host the request arrived on for data-shell-origin and the CSP prefix, on the canonical spelling", async () => {
      const app = await buildApp()
      const res = await request(app).get("/p/acme/").set("Host", "localhost:3100").expect(200)
      expect(res.text).toContain('data-shell-origin="http://localhost:3100"')
      expect(res.headers["content-security-policy"]).toContain("connect-src http://localhost:3100/p/acme/")
    })

    // Research R2's "reverse case is a total bridge failure": a reviewer who
    // opened the shell on the OTHER loopback spelling must get a CSP and
    // bridge origin naming THAT spelling, not the canonical one — or the
    // bridge's `isTrustedMessageOrigin` rejects every shell message.
    it("flips to the twin loopback spelling when the request arrived on it", async () => {
      const app = await buildApp()
      const res = await request(app).get("/p/acme/").set("Host", "127.0.0.1:3100").expect(200)
      expect(res.text).toContain('data-shell-origin="http://127.0.0.1:3100"')
      expect(res.headers["content-security-policy"]).toContain("connect-src http://127.0.0.1:3100/p/acme/")
    })
  })

  describe("visibility enforcement", () => {
    async function seedLockedProject(storage: InMemoryStorage, assets: FakeAssetStore) {
      const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await storage.createDeployment({ projectId: project.id })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await assets.put(deployment.id, "index.html", Buffer.from("<html><body>secret</body></html>"))
      await assets.put(deployment.id, "assets/app.js", Buffer.from("console.log('private bundle')"))
      return { project, owner, deployment }
    }

    /**
     * The prototype read capability (audit B1).
     *
     * These exist because the OBVIOUS fix to B1 — sandbox the review iframe —
     * silently breaks exactly this case, and nothing caught it. A sandboxed
     * frame has an opaque origin, whose site-for-cookies is null, so the
     * `SameSite=Lax` session cookie stops attaching to SUBRESOURCE requests
     * while still attaching to the top-level document. The result is a
     * prototype whose HTML renders and whose JS, CSS and bridge all 404.
     *
     * So the subresource assertion below is the whole point. An HTML-only test
     * would pass against a build that is completely broken in a browser.
     */
    describe("read capability", () => {
      it("authorizes the HTML *and its subresources* with no session cookie at all", async () => {
        const locked = await setup({ config: authedConfig })
        const { deployment } = await seedLockedProject(locked.storage, locked.assets)
        const token = mintPrototypeCapability({
          secret: "sesh-secret",
          slug: "locked",
          deploymentId: deployment.id,
        })
        expect(token).not.toBeNull()
        const prefix = `/p/locked/~c/${token}`

        // No `Cookie` header anywhere below — that is the point.
        const html = await request(locked.app).get(`${prefix}/`).expect(200)
        expect(html.text).toContain("secret")

        const js = await request(locked.app).get(`${prefix}/assets/app.js`).expect(200)
        expect(js.text).toContain("private bundle")

        const bridge = await request(locked.app)
          .get(`${prefix}/__desde/bridge-${BRIDGE_VERSION}.js`)
          .expect(200)
        expect(bridge.text).toBe(BRIDGE)
      })

      it("rewrites the page's own URLs under the capability prefix", async () => {
        // If the injected <base>/rewritten URLs dropped the `~c` segment, the
        // browser would request every subresource WITHOUT the capability and
        // get the 404 this whole mechanism exists to avoid.
        const locked = await setup({ config: authedConfig })
        const { deployment } = await seedLockedProject(locked.storage, locked.assets)
        const token = mintPrototypeCapability({
          secret: "sesh-secret",
          slug: "locked",
          deploymentId: deployment.id,
        })
        const res = await request(locked.app).get(`/p/locked/~c/${token}/`).expect(200)
        expect(res.text).toContain(`/p/locked/~c/${token}/`)
      })

      it("still 404s — byte-identically — with no capability and no session", async () => {
        const locked = await setup({ config: authedConfig })
        await seedLockedProject(locked.storage, locked.assets)
        const denied = await request(locked.app).get("/p/locked/assets/app.js").expect(404)
        const missing = await request(locked.app).get("/p/nope/assets/app.js").expect(404)
        expect(denied.text).toBe(missing.text)
      })

      it("refuses a capability minted for a different project", async () => {
        const locked = await setup({ config: authedConfig })
        const { deployment } = await seedLockedProject(locked.storage, locked.assets)
        const foreign = mintPrototypeCapability({
          secret: "sesh-secret",
          slug: "some-other-project",
          deploymentId: deployment.id,
        })
        await request(locked.app).get(`/p/locked/~c/${foreign}/assets/app.js`).expect(404)
      })

      it("refuses a garbage capability exactly as it refuses none", async () => {
        const locked = await setup({ config: authedConfig })
        await seedLockedProject(locked.storage, locked.assets)
        const forged = await request(locked.app).get("/p/locked/~c/not-a-token/").expect(404)
        const none = await request(locked.app).get("/p/locked/").expect(404)
        expect(forged.text).toBe(none.text)
      })
    })

    it("a 'members' project with members is NOT fetchable — same 404 body as an unknown slug", async () => {
      const locked = await setup({ config: authedConfig })
      await seedLockedProject(locked.storage, locked.assets)

      const denied = await request(locked.app).get("/p/locked/").expect(404)
      const missing = await request(locked.app).get("/p/nope/").expect(404)
      expect(denied.text).toBe(missing.text)
      expect(denied.status).toBe(missing.status)
    })

    it("a signed-in member CAN fetch a locked prototype", async () => {
      const locked = await setup({ config: authedConfig })
      const { project } = await seedLockedProject(locked.storage, locked.assets)
      const member = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "member",
        email: "member@x.com",
        displayName: "Member",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: member.id })
      const session = await locked.storage.createSession({
        userId: member.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      // authedConfig is https, so the live cookie name carries the __Host- prefix.
      const cookie = `${sessionCookieName(true)}=${signSessionId(authedConfig.sessionSecret, session.id)}`

      const res = await request(locked.app).get("/p/locked/").set("Cookie", cookie).expect(200)
      expect(res.text).toContain("secret")
    })

    // Authorization v2 INVERTED this test. A project with the default access
    // (`all-members`) used to be fetchable by anyone, member rows or not —
    // the inherited zero-members migration rule. It now requires sign-in, and
    // the anonymous 404 must be byte-identical to an unknown slug's.
    it("a project with the default access ('all-members') is NOT fetchable anonymously — it is sign-in gated now", async () => {
      const openCtx = await setup({ config: authedConfig })
      const project = await openCtx.storage.createProject({ slug: "open", name: "Open" })
      const deployment = await openCtx.storage.createDeployment({ projectId: project.id })
      await openCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await openCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>open</body></html>"))

      const denied = await request(openCtx.app).get("/p/open/").expect(404)
      const missing = await request(openCtx.app).get("/p/nope/").expect(404)
      expect(denied.text).toBe(missing.text)

      // ...and any signed-in account reads it, with no membership row at all.
      const someone = await upsertTestUser(openCtx.storage, {
        provider: "github",
        providerUserId: "someone",
        email: "someone@x.com",
        displayName: "Someone",
        avatarUrl: "",
      })
      const session = await openCtx.storage.createSession({
        userId: someone.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      // authedConfig is https, so the live cookie name carries the __Host- prefix.
      const cookie = `${sessionCookieName(true)}=${signSessionId(authedConfig.sessionSecret, session.id)}`
      const res = await request(openCtx.app).get("/p/open/").set("Cookie", cookie).expect(200)
      expect(res.text).toContain("open")
    })

    it("an anonymous visitor can still fetch a 'public-link' project end to end, even with members", async () => {
      const pubCtx = await setup({ config: authedConfig })
      const project = await pubCtx.storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const owner = await upsertTestUser(pubCtx.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await pubCtx.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await pubCtx.storage.createDeployment({ projectId: project.id })
      await pubCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pubCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>public</body></html>"))

      const res = await request(pubCtx.app).get("/p/pub/").expect(200)
      expect(res.text).toContain("public")
    })

    // Phase 3b-2 fix wave (I3), REVERSING the strict-401 this test
    // originally asserted. Prototypes commonly stub an auth header against
    // a mocked API — `fetch('/api/models', { headers: { Authorization:
    // 'Bearer demo-token' } })`, rewritten by `rewriteRootRelativeUrls` to
    // `/p/{slug}/api/models`, permitted by the path-scoped `connect-src`,
    // and answered by a real JSON file in the build. 401ing that broke the
    // prototype with nothing on screen explaining why, and bought no
    // authorization: a bad bearer can never grant more than anonymous, so
    // rejecting it and treating it as anonymous have the same outcome. The
    // strict 401 stays in force everywhere under `/api/v1/**`.
    it("an unrecognized bearer is treated as anonymous — a 'public-link' prototype's HTML still serves", async () => {
      const pubCtx = await setup({ config: authedConfig })
      const project = await pubCtx.storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const deployment = await pubCtx.storage.createDeployment({ projectId: project.id })
      await pubCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pubCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>public</body></html>"))

      const res = await request(pubCtx.app)
        .get("/p/pub/")
        .set("Authorization", "Bearer not-a-real-token")
        .expect(200)
      expect(res.text).toContain("public")
    })

    // The concrete case I3 is about: a prototype's own mocked-API fetch,
    // carrying a stubbed bearer, answered by a real file in the build.
    it("serves a 'public-link' prototype's mock API asset requested with 'Authorization: Bearer demo-token'", async () => {
      const pubCtx = await setup({ config: authedConfig })
      const project = await pubCtx.storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const deployment = await pubCtx.storage.createDeployment({ projectId: project.id })
      await pubCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pubCtx.assets.put(deployment.id, "api/models.json", Buffer.from('{"models":["gpt-4"]}'))

      const res = await request(pubCtx.app)
        .get("/p/pub/api/models.json")
        .set("Authorization", "Bearer demo-token")
        .expect(200)
      expect(res.text).toContain("gpt-4")
    })

    // Leniency must not become access: an unreadable project stays
    // unreadable with a bad bearer, exactly as it is with none.
    it("an unrecognized bearer does NOT unlock an unreadable 'members' prototype", async () => {
      const lockedCtx = await setup({ config: authedConfig })
      const project = await lockedCtx.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(lockedCtx.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await lockedCtx.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await lockedCtx.storage.createDeployment({ projectId: project.id })
      await lockedCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await lockedCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>secret</body></html>"))

      const res = await request(lockedCtx.app)
        .get("/p/locked/")
        .set("Authorization", "Bearer not-a-real-token")
        .expect(404)
      expect(res.text).not.toContain("secret")
    })
  })

  describe("bridge bundle route (__desde/bridge-<version>.js)", () => {
    async function seedOpenProject(pageCtx: Awaited<ReturnType<typeof setup>>, slug: string) {
      const project = await pageCtx.storage.createProject({ slug, name: slug, access: "public-link" })
      const deployment = await pageCtx.storage.createDeployment({ projectId: project.id })
      await pageCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pageCtx.assets.put(
        deployment.id,
        "index.html",
        Buffer.from("<html><head></head><body>app</body></html>"),
      )
      return project
    }

    it("serves the bridge bundle as JS with immutable, PRIVATE caching", async () => {
      await seedOpenProject(ctx, "acme")

      const res = await request(ctx.app).get(BRIDGE_URL).expect(200)
      expect(res.headers["content-type"]).toBe("application/javascript; charset=utf-8")
      // `private`, not `public` (Important fix, whole-branch review): a
      // `public` cache-control lets a shared cache (CDN/corporate proxy)
      // store a member's 200 and later serve that SAME cached 200 to an
      // anonymous caller on a locked project — defeating the
      // `canReadProject` gate as a working existence oracle. The
      // per-version filename still makes it safe to mark `immutable`.
      expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable")
      expect(res.text).toBe(BRIDGE)
    })

    it("404s for an unknown version, same as any other missing asset under the prefix", async () => {
      await seedOpenProject(ctx, "acme")
      await request(ctx.app).get("/p/acme/__desde/bridge-some-other-version.js").expect(404)
    })

    it("is subject to the SAME canReadProject gate as the prototype HTML — 404 for a non-member on a 'members' project", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(deployment.id, "index.html", Buffer.from("<html><body>secret</body></html>"))

      const bridgeUrl = `/p/locked/__desde/bridge-${BRIDGE_VERSION}.js`
      const htmlRes = await request(locked.app).get("/p/locked/")
      const bridgeRes = await request(locked.app).get(bridgeUrl)
      expect(bridgeRes.status).toBe(404)
      expect(bridgeRes.status).toBe(htmlRes.status)
      expect(bridgeRes.text).toBe(htmlRes.text)
    })

    it("is served anonymously for a 'public-link' project", async () => {
      const pubCtx = await setup({ config: authedConfig })
      const project = await pubCtx.storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const owner = await upsertTestUser(pubCtx.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await pubCtx.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await pubCtx.storage.createDeployment({ projectId: project.id })
      await pubCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pubCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>public</body></html>"))

      const bridgeUrl = `/p/pub/__desde/bridge-${BRIDGE_VERSION}.js`
      const res = await request(pubCtx.app).get(bridgeUrl).expect(200)
      expect(res.text).toBe(BRIDGE)
    })

    it("does not shadow a project's own asset serving for an unrelated path", async () => {
      await seedOpenProject(ctx, "acme")
      await ctx.assets.put(
        (await ctx.storage.getProjectBySlug("acme"))!.activeDeploymentId!,
        "assets/app.js",
        Buffer.from("export const a=1"),
      )
      const res = await request(ctx.app).get("/p/acme/assets/app.js").expect(200)
      expect(res.text).toBe("export const a=1")
    })
  })

  // Regression coverage for the shipped bug this whole change fixes: the
  // built bridge bundle (dist/bridge-bundle.js) contains the
  // literal 3-character sequence `<!--` inside a bundled tokenizer's string
  // literal. Per the HTML spec, `<!--` inside a classic <script> element's
  // text content switches the tokenizer into script-data-escaped state and
  // corrupts parsing of the rest of the inline script — verified live in
  // Chrome as `Unexpected token '<'`, with `window.__DESDE_BRIDGE_VERSION__`
  // left undefined (bridge never initializes; commenting/inspection dead on
  // every hosted prototype). This test uses the REAL bundle (not the fake
  // `BRIDGE` fixture used above) so it fails if the bundle is ever inlined
  // again, regardless of whether some future build happens to be `<!--`-free.
  describe("regression: real bridge bundle contains an HTML-hostile `<!--` sequence", () => {
    it("is never inlined into the served HTML, only referenced by src", async () => {
      const { script: realBridgeScript, version: realVersion } = readBridgeBundle()
      // Sanity-check the precondition this regression test exists for. If
      // this ever fails because the bundle no longer contains `<!--`, the
      // test below (proving external-src-only serving) still holds — this
      // assertion just documents why it matters.
      expect(realBridgeScript).toContain("<!--")

      const storage = new InMemoryStorage()
      const assets = new FakeAssetStore()
      const inner = express()
      inner.use(
        createServeRouter({
          storage,
          assets,
          config: openConfig,
          resolveShellOrigin: () => "https://viewer.example.com",
          bridgeScript: realBridgeScript,
          bridgeVersion: realVersion,
          prototypeCsp: null,
          prototypeProcesses: fakeProcesses(),
        }),
      )
      // Built inline rather than via `setup()` (it needs the REAL bridge
      // bundle), but still the file's one app object.
      stable.use(inner)
      const app = stable.app
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await storage.createDeployment({ projectId: project.id })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await assets.put(
        deployment.id,
        "index.html",
        Buffer.from("<html><head></head><body><h1>hi</h1></body></html>"),
      )

      const htmlRes = await request(app).get("/p/acme/").expect(200)
      // The HTML must not carry the bundle body — including its `<!--` —
      // inline. It only references the bridge by an external src URL.
      expect(htmlRes.text).not.toContain("<!--")
      const bridgeUrl = `/p/acme/__desde/bridge-${realVersion}.js`
      expect(htmlRes.text).toContain(`data-prototype-flow="bridge"`)
      expect(htmlRes.text).toContain(`src="${bridgeUrl}"`)

      // The external route DOES serve the real bundle body, `<!--` intact —
      // proving the fix isn't just "delete the hazard", it's "serve it
      // somewhere `<!--` is harmless" (a standalone JS resource, not
      // embedded inside another document's <script> text content).
      const bridgeRes = await request(app).get(bridgeUrl).expect(200)
      expect(bridgeRes.headers["content-type"]).toBe("application/javascript; charset=utf-8")
      expect(bridgeRes.text).toContain("<!--")
      expect(bridgeRes.text).toBe(realBridgeScript)
    })
  })

  /**
   * The third serving mode: a per-deployment loopback listener rewrites every
   * request into `/p/{slug}/…` and marks it with the deployment it is pinned
   * to (`serve/loopback-listener-app.ts`). These tests drive the router
   * directly with that marker set, so the branch is pinned here rather than
   * only through a live socket in `loopback-listeners.test.ts`.
   */
  describe("pinned deployment", () => {
    const HTML = "<html><head></head><body><h1>pinned</h1></body></html>"

    /**
     * The listener's existence IS the authorization: the API that opened it
     * already required project read. So the router must not repeat the
     * lookup — proven here by pinning a deployment whose slug names no
     * project at all.
     */
    it("serves without any project record", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/").expect(200)
      expect(res.text).toContain("<h1>pinned</h1>")
    })

    it("serves a private project's deployment with no session and no capability", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "acme" }

      const res = await request(locked.app).get("/p/acme/").expect(200)
      expect(res.text).toContain("<h1>pinned</h1>")
    })

    /**
     * A listener is keyed on a deployment id, not on "the project's active
     * deployment". When a new build goes live the API opens a new listener;
     * the old one keeps serving the bytes it was opened for until it is
     * reaped, which is what stops a review session changing under the
     * reviewer mid-read.
     */
    it("reads assets by the pinned deployment, never the project's active one", async () => {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const older = await ctx.storage.createDeployment({ projectId: project.id })
      const newer = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: newer.id })
      await ctx.assets.put(older.id, "index.html", Buffer.from("<html><body>older</body></html>"))
      await ctx.assets.put(newer.id, "index.html", Buffer.from("<html><body>newer</body></html>"))
      pinnedMarker = { deploymentId: older.id, slug: "acme" }

      const res = await request(ctx.app).get("/p/acme/").expect(200)
      expect(res.text).toContain("older")
      expect(res.text).not.toContain("newer")
    })

    it("leaves root-relative URLs alone and injects no <base href>", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(
        deployment.id,
        "index.html",
        Buffer.from(`<html><head><script src="/assets/app.js"></script></head><body></body></html>`),
      )
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/").expect(200)
      expect(res.text).toContain(`src="/assets/app.js"`)
      expect(res.text).not.toContain("<base href")
      expect(res.text).not.toContain("/p/ghost/assets/app.js")
    })

    // Isolated modes (pinned loopback listener, or a subdomain — see
    // `subdomain.test.ts` for the equivalent) give the prototype the real
    // origin root, so a root-absolute url() already resolves correctly.
    // Rewriting it would be wrong, and the response must stay byte-identical
    // to what the asset store holds.
    it("leaves a .css asset's url() references byte-identical — the prototype owns the origin root here", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      const css = "@font-face { src: url(/fonts/x.woff2); }"
      await ctx.assets.put(deployment.id, "assets/app.css", Buffer.from(css))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/assets/app.css").expect(200)
      expect(res.text).toBe(css)
    })

    it("points the bridge <script src> at the origin root", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/").expect(200)
      expect(res.text).toContain(`src="/__desde/bridge-${BRIDGE_VERSION}.js"`)
    })

    it("serves the bridge bundle without consulting the project", async () => {
      pinnedMarker = { deploymentId: "no-such-deployment", slug: "ghost" }
      const res = await request(ctx.app)
        .get(`/p/ghost/__desde/bridge-${BRIDGE_VERSION}.js`)
        .expect(200)
      expect(res.text).toBe(BRIDGE)
    })

    it("sends the isolated-origin CSP, not the path-scoped one", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/").expect(200)
      const csp = res.headers["content-security-policy"]
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("frame-ancestors https://viewer.example.com")
      expect(csp).toContain("worker-src 'none'")
      expect(csp).not.toContain("/p/ghost/")
    })

    // Codex round 15, Fix 2. A STATIC document has no forms of its own worth
    // trusting with a same-origin post — it is a folder of files, not code
    // that runs on the server — so it keeps the stricter default. Only a
    // server document (below, in the "server deployments" describe) is
    // allowed to relax this one directive.
    it("keeps form-action 'none' on a static document on an isolated origin", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/").expect(200)
      expect(res.headers["content-security-policy"]).toContain("form-action 'none'")
    })

    it("404s a missing file with the shared not-found body", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      const res = await request(ctx.app).get("/p/ghost/missing.css").expect(404)
      expect(res.text).toBe("Not found")
    })

    /**
     * The path-mode block above sends `*` on all three response shapes. A
     * pinned response sends none of them, and that is a security property
     * rather than a tidy-up: a pinned request has skipped `canReadProject`
     * (the listener's reachability is its whole credential), so `*` would let
     * any page the reviewer visits read a private prototype's bytes
     * cross-origin. See `prototype-cors.ts`.
     */
    it("sends no Access-Control-Allow-Origin", async () => {
      const deployment = await ctx.storage.createDeployment({ projectId: "ghost-project" })
      await ctx.assets.put(deployment.id, "index.html", Buffer.from(HTML))
      await ctx.assets.put(deployment.id, "assets/app.js", Buffer.from("export const a=1"))
      pinnedMarker = { deploymentId: deployment.id, slug: "ghost" }

      for (const path of [
        "/p/ghost/",
        "/p/ghost/assets/app.js",
        `/p/ghost/__desde/bridge-${BRIDGE_VERSION}.js`,
      ]) {
        const res = await request(ctx.app).get(path).expect(200)
        expect(res.headers["access-control-allow-origin"], path).toBeUndefined()
      }
    })
  })

  /**
   * `VIEWER_PROTOTYPE_ORIGIN` — the single shared prototype origin. The crux
   * of the decoupling: this mode is CROSS-ORIGIN (isolated CSP, no ACAO) yet
   * PATH-NAMESPACED (all prototypes share one host, so none owns `/`). So it
   * must take the isolated CSP AND still rewrite root-absolute assets, inject
   * a `<base href>`, and use the prefixed bridge path — the opposite of what
   * the pinned/subdomain modes do for those three. Driven directly through the
   * `onPrototypeOrigin` marker, the same way the pinned/subdomain blocks drive
   * their markers.
   */
  describe("prototype-origin host (VIEWER_PROTOTYPE_ORIGIN)", () => {
    async function seedPublic() {
      const project = await ctx.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await ctx.storage.createDeployment({ projectId: project.id })
      await ctx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      return deployment
    }

    it("sends the isolated-origin CSP, not the path-scoped one", async () => {
      const deployment = await seedPublic()
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><head></head><body>hi</body></html>"))
      prototypeOriginMarker = true

      const res = await request(ctx.app).get("/p/acme/").expect(200)
      const csp = res.headers["content-security-policy"]
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("frame-ancestors https://viewer.example.com")
      expect(csp).toContain("worker-src 'none'")
      // The isolated CSP names no per-prototype path prefix.
      expect(csp).not.toContain("/p/acme/")
    })

    it("sends NO Access-Control-Allow-Origin (a real cross-origin needs none)", async () => {
      const deployment = await seedPublic()
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>hi</body></html>"))
      await ctx.assets.put(deployment.id, "assets/app.js", Buffer.from("export const a=1"))
      prototypeOriginMarker = true

      for (const path of [
        "/p/acme/",
        "/p/acme/assets/app.js",
        `/p/acme/__desde/bridge-${BRIDGE_VERSION}.js`,
      ]) {
        const res = await request(ctx.app).get(path).expect(200)
        expect(res.headers["access-control-allow-origin"], path).toBeUndefined()
      }
    })

    it("STILL rewrites root-absolute URLs and injects a <base href> (path-namespaced)", async () => {
      const deployment = await seedPublic()
      await ctx.assets.put(
        deployment.id,
        "index.html",
        Buffer.from(`<html><head><script src="/assets/app.js"></script></head><body></body></html>`),
      )
      prototypeOriginMarker = true

      const res = await request(ctx.app).get("/p/acme/").expect(200)
      expect(res.text).toContain('<base href="/p/acme/">')
      expect(res.text).toContain(`src="/p/acme/assets/app.js"`)
    })

    it("STILL points the bridge <script src> at the PREFIXED path, not the origin root", async () => {
      const deployment = await seedPublic()
      await ctx.assets.put(deployment.id, "index.html", Buffer.from("<html><head></head><body>hi</body></html>"))
      prototypeOriginMarker = true

      const res = await request(ctx.app).get("/p/acme/").expect(200)
      expect(res.text).toContain(`src="/p/acme/__desde/bridge-${BRIDGE_VERSION}.js"`)
      expect(res.text).not.toContain(`src="/__desde/bridge-${BRIDGE_VERSION}.js"`)
    })

    it("STILL rewrites a root-absolute url() in a standalone .css asset", async () => {
      const deployment = await seedPublic()
      await ctx.assets.put(
        deployment.id,
        "assets/app.css",
        Buffer.from("@font-face { src: url(/fonts/x.woff2); }"),
      )
      prototypeOriginMarker = true

      const res = await request(ctx.app).get("/p/acme/assets/app.css").expect(200)
      expect(res.text).toBe("@font-face { src: url(/p/acme/fonts/x.woff2); }")
    })

    // The spec's "a private prototype on the prototype origin serves its assets
    // (rewrite path)". The capability rides the PATH (`~c/{token}`), exactly as
    // in the shell's own path mode — never a cookie, which on the shared host
    // would leak between prototypes.
    it("serves a PRIVATE prototype's assets via a path capability, with the isolated CSP and no ACAO", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(deployment.id, "assets/app.js", Buffer.from("console.log('private')"))
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      prototypeOriginMarker = true

      const res = await request(locked.app).get(`/p/locked/~c/${token}/assets/app.js`).expect(200)
      expect(res.text).toContain("private")
      expect(res.headers["content-security-policy"]).toContain("connect-src 'self'")
      expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("does NOT set a dsv_cap cookie — the capability stays in the path on the shared host", async () => {
      const locked = await setup({ config: authedConfig })
      const project = await locked.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(locked.storage, {
        provider: "github",
        providerUserId: "owner2",
        email: "owner2@x.com",
        displayName: "Owner2",
        avatarUrl: "",
      })
      await locked.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await locked.storage.createDeployment({ projectId: project.id })
      await locked.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await locked.assets.put(
        deployment.id,
        "index.html",
        Buffer.from("<html><head></head><body>secret</body></html>"),
      )
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      prototypeOriginMarker = true

      const res = await request(locked.app).get(`/p/locked/~c/${token}/`).expect(200)
      expect(res.text).toContain("secret")
      expect(res.headers["set-cookie"]).toBeUndefined()
      // The base href carries the capability prefix (path-namespaced).
      expect(res.text).toContain(`<base href="/p/locked/~c/${token}/">`)
    })
  })

  /**
   * Task 11: on a prototype SUBDOMAIN the read capability arrives on the
   * document's `?~c=` query and is promoted to a host-only `dsv_cap` cookie the
   * frame's own same-site subresource requests then carry. These pins prove
   * the security-critical placement rules directly on the router: the cookie
   * is set ONLY on a subdomain HTML document whose capability came from the
   * QUERY and verified, and NEVER on the shell host or a pinned listener.
   */
  describe("subdomain capability cookie (task 11)", () => {
    async function seedLocked(pageCtx: Awaited<ReturnType<typeof setup>>) {
      const project = await pageCtx.storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(pageCtx.storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await pageCtx.storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await pageCtx.storage.createDeployment({ projectId: project.id })
      await pageCtx.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await pageCtx.assets.put(deployment.id, "index.html", Buffer.from("<html><body>secret</body></html>"))
      await pageCtx.assets.put(deployment.id, "assets/app.js", Buffer.from("console.log('private')"))
      return deployment
    }

    it("sets the __Host-dsv_cap cookie on the HTML document when a verified `?~c=` query arrives on a subdomain (https)", async () => {
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      subdomainMarker = "locked"

      const res = await request(locked.app).get(`/p/locked/?~c=${token}`).expect(200)
      expect(res.text).toContain("secret")
      // No <base> rewrite: a subdomain prototype owns the origin root.
      expect(res.text).not.toContain("<base ")
      const cookie = ((res.headers["set-cookie"] as unknown as string[]) ?? [])[0] ?? ""
      // authedConfig publicUrl is https → the cookie gains the __Host- prefix,
      // which the browser only accepts as host-only, Path=/, Secure. That is
      // what stops a sibling host tossing a `Domain=`-scoped dsv_cap in.
      expect(cookie.startsWith(`__Host-dsv_cap=${token}`)).toBe(true)
      expect(cookie).toContain("Path=/")
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("SameSite=Lax")
      expect(cookie).not.toMatch(/Domain=/i)
      expect(cookie).not.toMatch(/Max-Age/i)
      // authedConfig publicUrl is https → Secure.
      expect(cookie).toMatch(/Secure/i)
    })

    it("sets the plain dsv_cap cookie (no __Host-) on http", async () => {
      // An http deployment → insecure → no Secure, so the __Host- prefix is
      // dropped (a __Host- cookie without Secure is rejected by the browser).
      // Same "sesh-secret" as the minted token so the capability verifies; only
      // the publicUrl scheme differs from authedConfig.
      const httpConfig = loadConfig({
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
      const locked = await setup({ config: httpConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      subdomainMarker = "locked"

      const res = await request(locked.app).get(`/p/locked/?~c=${token}`).expect(200)
      const cookie = ((res.headers["set-cookie"] as unknown as string[]) ?? [])[0] ?? ""
      expect(cookie.startsWith(`dsv_cap=${token}`)).toBe(true)
      expect(cookie).not.toContain("__Host-")
      expect(cookie).not.toMatch(/Secure/i)
    })

    it("does NOT re-set the cookie when the capability arrived in the __Host-dsv_cap cookie (https)", async () => {
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      subdomainMarker = "locked"

      const res = await request(locked.app)
        .get("/p/locked/assets/app.js")
        .set("Cookie", `__Host-dsv_cap=${token}`)
        .expect(200)
      expect(res.text).toContain("private")
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("on https IGNORES a plain dsv_cap cookie — only __Host-dsv_cap is read (tossing closed)", async () => {
      // A validly-minted token under the WRONG name. On https the server reads
      // only __Host-dsv_cap, so this plain cookie is invisible and the private
      // project 404s exactly as it would with no capability at all.
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      subdomainMarker = "locked"

      const res = await request(locked.app)
        .get("/p/locked/assets/app.js")
        .set("Cookie", `dsv_cap=${token}`)
        .expect(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("sets no cookie and 404s a forged `?~c=` query on a subdomain", async () => {
      const locked = await setup({ config: authedConfig })
      await seedLocked(locked)
      subdomainMarker = "locked"

      const res = await request(locked.app).get("/p/locked/?~c=not-a-real-token").expect(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    // The core self-review proof: the shell host reads NEITHER the query nor a
    // cookie. `onSubdomain` is false with no marker, so a valid capability in
    // the query is invisible and the private project 404s with no Set-Cookie.
    it("ignores the `?~c=` query on the shell host — no marker, 404, no cookie", async () => {
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      // subdomainMarker stays null.

      const res = await request(locked.app).get(`/p/locked/?~c=${token}`).expect(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    it("ignores a `dsv_cap` cookie on the shell host — no marker, 404", async () => {
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })

      const res = await request(locked.app)
        .get("/p/locked/assets/app.js")
        .set("Cookie", `dsv_cap=${token}`)
        .expect(404)
      expect(res.headers["set-cookie"]).toBeUndefined()
    })

    // A pinned loopback listener has `onSubdomain` false, so it never reads the
    // query and never sets the cookie — even when a valid capability is present.
    it("never sets the cookie on a pinned loopback listener, even with a valid `?~c=` query", async () => {
      const locked = await setup({ config: authedConfig })
      const deployment = await seedLocked(locked)
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "locked", deploymentId: deployment.id })
      pinnedMarker = { deploymentId: deployment.id, slug: "locked" }

      const res = await request(locked.app).get(`/p/locked/?~c=${token}`).expect(200)
      // Served because the listener's reachability is the credential.
      expect(res.text).toContain("secret")
      expect(res.headers["set-cookie"]).toBeUndefined()
    })
  })

  /**
   * A `serve: "server"` deployment is a PROCESS, not a folder. The router
   * forks on it after the deployment id is known: it asks the process manager
   * for a port and proxies, instead of reading the asset store.
   *
   * The fork only runs on an ISOLATED origin, and the path-mode refusal below
   * is a security boundary rather than a convenience. `proxy-to-process.ts`
   * passes the child's `set-cookie` through untouched, so in path mode — where
   * the shell and the prototype share an origin — a prototype could write
   * cookies onto the shell's origin. The 409 lands BEFORE any `ensure`, which
   * is what keeps that from ever being reachable.
   */
  describe("server deployments", () => {
    const servers: Server[] = []
    afterEach(() => {
      for (const s of servers.splice(0)) s.close()
    })

    /** A stand-in for the prototype's own server, on a real loopback port. */
    async function child(handler: Parameters<typeof createServer>[1]): Promise<number> {
      const s = createServer(handler)
      servers.push(s)
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))
      return (s.address() as AddressInfo).port
    }

    /**
     * A promise this test controls the settlement of, to hold `ensure()` open
     * for as long as the test needs — standing in for a real cold start.
     */
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    /**
     * A `withLease` fake with the same scope shape as the real one in
     * `prototype-processes.ts`: the lease is taken before the body runs and
     * released in a `finally`, however the body settles. `count()` reads the
     * live in-flight number.
     */
    function trackedLease(): { withLease: PrototypeProcesses["withLease"]; count: () => number } {
      let inFlight = 0
      return {
        count: () => inFlight,
        withLease: async (_id, fn) => {
          inFlight++
          try {
            return await fn()
          } finally {
            inFlight--
          }
        },
      }
    }

    /**
     * A router whose storage holds ONE `serve: "server"` deployment at slug
     * `srv`, with the given process manager.
     *
     * `pinned` is what a per-deployment loopback listener sets
     * (`loopback-listener-app.ts`); leaving it false is ordinary path mode on
     * the shell host, which is what the 409 test wants.
     */
    async function loopbackAppWith(opts: {
      prototypeProcesses: PrototypeProcesses
      pinned?: boolean
      prototypeCsp?: string | null
    }) {
      const c = await setup({ prototypeProcesses: opts.prototypeProcesses, prototypeCsp: opts.prototypeCsp })
      const project = await c.storage.createProject({ slug: "srv", name: "Srv", access: "public-link" })
      const deployment = await c.storage.createDeployment({ projectId: project.id, status: "deployed" })
      await c.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await c.storage.updateDeployment(deployment.id, { serve: "server", serverStart: ["node", "x.js"] })
      if (opts.pinned !== false) pinnedMarker = { deploymentId: deployment.id, slug: "srv" }
      return { app: c.app, storage: c.storage, deployment }
    }

    it("proxies a pinned server deployment on an isolated origin and injects the bridge", async () => {
      const port = await child((_req, res) => {
        res.setHeader("content-type", "text/html")
        res.end("<html><body>srv</body></html>")
      })
      const ensured: string[] = []
      const { app, deployment } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          ensure: (d) => {
            ensured.push(d.id)
            return Promise.resolve({ port })
          },
        }),
      })

      const res = await request(app).get("/p/srv/")
      expect(res.status).toBe(200)
      expect(res.text).toContain("srv")
      expect(res.text).toContain("__DESDE_SHELL_ORIGIN__")
      expect(res.text).toContain(`src="/__desde/bridge-${BRIDGE_VERSION}.js"`)
      expect(ensured).toEqual([deployment.id])
      // A proxied response is contained by exactly the SERVER variant of the
      // isolated-origin policy — byte-for-byte, not merely "a CSP is
      // present". Any policy the CHILD sent is dropped on the way through
      // (`proxy-to-process.ts`), so this is the only one. Codex round 15,
      // Fix 2: this used to be `resolveIsolatedOriginCsp`, the STATIC
      // variant, whose `form-action 'none'` blocked an ordinary
      // `<form method="post">` before the request ever reached the proxy.
      expect(res.headers["content-security-policy"]).toBe(
        resolveIsolatedOriginServerCsp(null, "https://viewer.example.com"),
      )
      expect(res.headers["content-security-policy"]).toContain("form-action 'self'")
      expect(res.headers["x-content-type-options"]).toBe("nosniff")
    })

    // Codex round 15, Fix 2. The escape hatch (`VIEWER_PROTOTYPE_CSP`) must
    // win over the server-vs-static split too — it is a full override, not a
    // base policy the split layers onto.
    it("keeps the VIEWER_PROTOTYPE_CSP escape hatch in charge of a proxied server document", async () => {
      const off = await child((_req, res) => res.end("proxied"))
      const offApp = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port: off }) }),
        prototypeCsp: "off",
      })
      const offRes = await request(offApp.app).get("/p/srv/").expect(200)
      expect(offRes.headers["content-security-policy"]).toBeUndefined()

      const custom = await child((_req, res) => res.end("proxied"))
      const customApp = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port: custom }) }),
        prototypeCsp: "default-src 'none'",
      })
      const customRes = await request(customApp.app).get("/p/srv/").expect(200)
      expect(customRes.headers["content-security-policy"]).toBe("default-src 'none'")
    })

    /**
     * A PRIVATE server prototype on a subdomain, authorized by the `?~c=`
     * capability the review page mints.
     *
     * The promotion to a `dsv_cap` cookie is what makes the SECOND request
     * work. The token rides the query on the document load only; every asset
     * the app then asks for carries nothing but cookies, so a proxied document
     * that skipped the promotion would render once and then 404 everything it
     * referenced. The static HTML branch has done this since task 11 — this
     * proves the proxy branch does the same thing, through the same function.
     */
    it("promotes the `?~c=` capability to a cookie on a proxied document, and hides `~c` from the child", async () => {
      let seen: string | undefined
      const port = await child((req, res) => {
        seen = req.url
        res.setHeader("content-type", "text/html")
        // Two cookies from the child: one of its own, which must survive, and
        // one that TAKES OUR NAME, which must not. A prototype that could set
        // `__Host-dsv_cap` would be choosing the read capability the viewer
        // reads back on every later request.
        res.setHeader("set-cookie", ["app_sid=1; Path=/", "__Host-dsv_cap=evil; Path=/; Secure"])
        res.end("<html><body>private srv</body></html>")
      })
      const c = await setup({
        config: authedConfig,
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
      })
      const project = await c.storage.createProject({ slug: "srv", name: "Srv", access: "invited" })
      const dep = await c.storage.createDeployment({ projectId: project.id, status: "deployed" })
      await c.storage.updateProject(project.id, { activeDeploymentId: dep.id })
      await c.storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "srv", deploymentId: dep.id })
      subdomainMarker = "srv"

      const res = await request(c.app).get(`/p/srv/?~c=${token}`).expect(200)
      expect(res.text).toContain("private srv")

      const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? []
      // `authedConfig`'s publicUrl is https, so the name carries the `__Host-`
      // prefix — the same name, and the same attributes, the static HTML
      // branch sets for this config (see the capability-cookie block below).
      // Both branches call one function, so the http spelling is covered there.
      // Exactly one `dsv_cap` on the response, it is OURS, and it is LAST —
      // a jar keeps the last value for a name, so anything of ours that
      // preceded the child's would lose.
      const capCookies = cookies.filter((v) => v.includes("dsv_cap="))
      expect(capCookies).toHaveLength(1)
      const ours = capCookies[0]
      expect(ours?.startsWith(`__Host-dsv_cap=${token}`)).toBe(true)
      expect(cookies[cookies.length - 1]).toBe(ours)
      expect(ours).toContain("Path=/")
      expect(ours).toContain("HttpOnly")
      expect(ours).toContain("SameSite=Lax")
      expect(ours).toMatch(/Secure/i)
      // The child's same-named cookie is gone; its other one survives.
      expect(cookies.some((v) => v.includes("dsv_cap=evil"))).toBe(false)
      expect(cookies.some((v) => v.startsWith("app_sid=1"))).toBe(true)

      // The capability is the viewer's channel, dropped from what the child
      // sees. `childPathFor` no longer strips a `/p/{slug}/` prefix (codex
      // round 8, Fix 1) — this test harness sends the request AS the literal
      // `/p/srv/…` router-internal form (it never runs the real
      // `createSubdomainRewrite`/`createPinnedDeploymentRewrite` middleware,
      // which in production only ever touches `req.url`, not
      // `req.originalUrl` — see `childPathFor`'s doc comment), so the child
      // sees that same literal form back, minus `~c`.
      expect(seen).toBe("/p/srv/")
      expect(seen).not.toContain("~c")
    })

    it("keeps the child's own query parameters while dropping `~c`", async () => {
      let seen: string | undefined
      const port = await child((req, res) => {
        seen = req.url
        res.end("ok")
      })
      const c = await setup({
        config: authedConfig,
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
      })
      const project = await c.storage.createProject({ slug: "srv", name: "Srv", access: "invited" })
      const dep = await c.storage.createDeployment({ projectId: project.id, status: "deployed" })
      await c.storage.updateProject(project.id, { activeDeploymentId: dep.id })
      await c.storage.updateDeployment(dep.id, { serve: "server", serverStart: ["node", "x.js"] })
      const token = mintPrototypeCapability({ secret: "sesh-secret", slug: "srv", deploymentId: dep.id })
      subdomainMarker = "srv"

      await request(c.app).get(`/p/srv/?~c=${token}&page=2`).expect(200)
      expect(seen).toBe("/p/srv/?page=2")
    })

    /**
     * Codex round 8, Fix 1. In a root-serving mode (a pinned loopback
     * listener, or a subdomain) the browser's OWN path is the app's path —
     * `req.originalUrl` is never in the router's internal `/p/{slug}/…`
     * shape in production, because the rewrite that produces that shape
     * only ever touches `req.url` (see `createPinnedDeploymentRewrite`).
     * `childPathFor` used to strip a `/p/{slug}/` prefix from
     * `originalUrl` anyway, which was harmless when the browser's path
     * didn't happen to start with that text and silently wrong when it
     * did: a project slugged `acme` whose app has its own `/orders` route
     * would forward a browser request for `/p/acme/orders` to the child as
     * `/orders`. These two tests use slug `acme` and an app path that
     * collides with `/p/acme/` on purpose, to prove nothing is stripped.
     */
    it("passes the browser's own path straight through on a pinned loopback listener, even when it collides with the slug prefix", async () => {
      let seen: string | undefined
      const port = await child((req, res) => {
        seen = req.url
        res.setHeader("content-type", "text/plain")
        res.end("ok")
      })
      const c = await setup({
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
      })
      const project = await c.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await c.storage.createDeployment({ projectId: project.id, status: "deployed" })
      await c.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await c.storage.updateDeployment(deployment.id, { serve: "server", serverStart: ["node", "x.js"] })
      pinnedMarker = { deploymentId: deployment.id, slug: "acme" }

      await request(c.app).get("/p/acme/orders?x=1").expect(200)
      expect(seen).toBe("/p/acme/orders?x=1")
    })

    it("drops only `~c` from a browser path that collides with the slug prefix", async () => {
      let seen: string | undefined
      const port = await child((req, res) => {
        seen = req.url
        res.setHeader("content-type", "text/plain")
        res.end("ok")
      })
      const c = await setup({
        prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
      })
      const project = await c.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await c.storage.createDeployment({ projectId: project.id, status: "deployed" })
      await c.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await c.storage.updateDeployment(deployment.id, { serve: "server", serverStart: ["node", "x.js"] })
      pinnedMarker = { deploymentId: deployment.id, slug: "acme" }

      await request(c.app).get("/p/acme/orders?~c=some-token&x=1").expect(200)
      expect(seen).toBe("/p/acme/orders?x=1")
    })

    it("touches the deployment so an actively reviewed process is not reaped", async () => {
      const port = await child((_req, res) => res.end("ok"))
      const touched: string[] = []
      const { app, deployment } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          ensure: () => Promise.resolve({ port }),
          touch: (id) => {
            touched.push(id)
          },
        }),
      })

      await request(app).get("/p/srv/").expect(200)
      expect(touched).toEqual([deployment.id])
    })

    /**
     * Codex round 11, Fix 1. The lease used to be taken AFTER `ensure()`
     * resolved. That left a window, for as long as a cold start took, where
     * nothing marked the entry in use: a client that gave up during that
     * window ended the response before `res.once("close", ...)` was ever
     * registered, so the lease was never released, and a concurrent cold
     * start elsewhere could evict this entry's just-ready process before
     * this request got to reserve it. These three tests hold `ensure()` open
     * on a controllable promise and read the fake's own in-flight count, so
     * they can tell "lease held before the cold start finishes" apart from
     * "lease held only after".
     */
    describe("the in-flight lease is taken before the cold start, not after", () => {
      it("ends with zero open leases once ensure() resolves, and never reaches the child, when the client closes first", async () => {
        let childHits = 0
        const port = await child((_req, res) => {
          childHits += 1
          res.end("should not happen")
        })
        const gate = deferred<{ port: number }>()
        let ensureCalled = false
        const tracked = trackedLease()
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensureCalled = true
              return gate.promise
            },
            withLease: tracked.withLease,
          }),
        })

        // A direct http client on its OWN listener, bypassing both stock
        // supertest (which opens and closes a server per call) and this
        // file's `supertest-reuse` wrapper (whose `.abort()` is a no-op — it
        // records "abort" as just another chained builder call and replays
        // it against a Test that has, by then, already been read and sent;
        // see that file's `Step`/`Proxy` design). This test needs a REAL
        // client disconnect while the server is still mid-request, which
        // neither of those gives it.
        const direct = createServer(app)
        servers.push(direct)
        await new Promise<void>((r) => direct.listen(0, "127.0.0.1", () => r()))
        const directPort = (direct.address() as AddressInfo).port
        const clientReq = nodeHttpRequest({ host: "127.0.0.1", port: directPort, path: "/p/srv/", method: "GET" })
        clientReq.on("error", () => {
          /* expected once destroyed below */
        })
        clientReq.end()

        await vi.waitFor(() => expect(ensureCalled).toBe(true))
        // The lease is already held even though `ensure()` has not resolved —
        // this is the assertion that fails under the old "lease after ensure"
        // order, where the count would still read 0 here.
        expect(tracked.count()).toBe(1)

        clientReq.destroy()
        // Still held: the lease is a SCOPE, and the scope is the cold start
        // it is protecting. A client that gave up does not free the entry
        // for eviction while a start it asked for is still running.
        await new Promise((r) => setTimeout(r, 20))
        expect(tracked.count()).toBe(1)

        // Resolving late must not throw or double-release: the handler
        // resumes, sees `clientGone` already set, and returns without
        // proxying anywhere — which ends the scope and releases the lease.
        gate.resolve({ port })
        await vi.waitFor(() => expect(tracked.count()).toBe(0))
        // Give a stray proxy call a beat to have reached the child, if the
        // "return before proxying" check had been skipped.
        await new Promise((r) => setTimeout(r, 20))
        expect(childHits).toBe(0)
      })

      it("holds the lease from before ensure() resolves until the response closes, for a request that completes normally", async () => {
        const bodyGate = deferred<void>()
        const port = await child((_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" })
          res.write("start")
          void bodyGate.promise.then(() => res.end("end"))
        })
        const gate = deferred<{ port: number }>()
        let ensureCalled = false
        const tracked = trackedLease()
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensureCalled = true
              return gate.promise
            },
            withLease: tracked.withLease,
          }),
        })

        // A direct client, so the test can see the response mid-body (a
        // first chunk through, but not yet closed) instead of only its
        // final, fully-read state — see the comment on the previous test
        // for why supertest cannot give it that.
        const direct = createServer(app)
        servers.push(direct)
        await new Promise<void>((r) => direct.listen(0, "127.0.0.1", () => r()))
        const directPort = (direct.address() as AddressInfo).port

        let firstChunkSeen = false
        let finishedStatus: number | undefined
        const completion = new Promise<void>((resolve) => {
          const clientReq = nodeHttpRequest(
            { host: "127.0.0.1", port: directPort, path: "/p/srv/", method: "GET" },
            (up) => {
              finishedStatus = up.statusCode
              up.on("data", () => {
                firstChunkSeen = true
              })
              up.on("end", () => resolve())
            },
          )
          clientReq.end()
        })

        await vi.waitFor(() => expect(ensureCalled).toBe(true))
        expect(tracked.count()).toBe(1)

        gate.resolve({ port })
        await vi.waitFor(() => expect(firstChunkSeen).toBe(true))
        // ensure() has resolved and the child is answering, but its body is
        // still open — the lease must still be held.
        expect(tracked.count()).toBe(1)

        bodyGate.resolve()
        await completion
        expect(finishedStatus).toBe(200)
        expect(tracked.count()).toBe(0)
      })

      it("releases the lease when ensure() rejects", async () => {
        const gate = deferred<{ port: number }>()
        let ensureCalled = false
        const tracked = trackedLease()
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensureCalled = true
              return gate.promise
            },
            withLease: tracked.withLease,
          }),
        })

        let finished: { status: number } | undefined
        const completion = new Promise<void>((resolve, reject) => {
          request(app)
            .get("/p/srv/")
            .end((err, res) => {
              if (err && !res) {
                reject(err)
                return
              }
              finished = { status: res!.status }
              resolve()
            })
        })
        await vi.waitFor(() => expect(ensureCalled).toBe(true))
        expect(tracked.count()).toBe(1)

        gate.reject(new PrototypeProcessError({ state: "stopped" }, "boom"))
        await completion
        expect(finished?.status).toBe(503)
        expect(tracked.count()).toBe(0)
      })
    })

    it("marks the process unreachable when the child gives no answer at all", async () => {
      const markedUnreachable: string[] = []
      const { app, deployment } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          // Nothing listens on port 1, so the proxy's `onUnreachable` fires.
          ensure: () => Promise.resolve({ port: 1 }),
          markUnreachable: (id) => {
            markedUnreachable.push(id)
            return Promise.resolve()
          },
        }),
      })

      await request(app).get("/p/srv/").expect(502)
      expect(markedUnreachable).toEqual([deployment.id])
    })

    /**
     * Marking unreachable is best effort, and a `markUnreachable` that
     * rejects must not take the process down with an unhandled rejection.
     *
     * Vitest FAILS a run on an unhandled rejection, so this test passing IS
     * the assertion — there is nothing else to check beyond the response still
     * being the proxy's 502 page. Without the `.catch` on `onUnreachable`'s
     * promise the run reports the rejection and fails.
     */
    it("survives a markUnreachable() that rejects", async () => {
      const { app } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          ensure: () => Promise.resolve({ port: 1 }),
          markUnreachable: () => Promise.reject(new Error("boom")),
        }),
      })

      const res = await request(app).get("/p/srv/").expect(502)
      expect(res.text).toContain("not answering")
    })

    it("serves the bridge bundle itself, never proxying it to the child", async () => {
      let hits = 0
      const port = await child((_req, res) => {
        hits += 1
        res.end("child")
      })
      let ensures = 0
      const { app } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          ensure: () => {
            ensures += 1
            return Promise.resolve({ port })
          },
        }),
      })

      const res = await request(app).get(`/p/srv/__desde/bridge-${BRIDGE_VERSION}.js`).expect(200)
      expect(res.text).toBe(BRIDGE)
      expect(hits).toBe(0)
      expect(ensures).toBe(0)
    })

    it("refuses a server deployment in path mode with a page that names the fix", async () => {
      let ensures = 0
      const { app } = await loopbackAppWith({
        pinned: false,
        prototypeProcesses: fakeProcesses({
          ensure: () => {
            ensures += 1
            return Promise.resolve({ port: 1 })
          },
        }),
      })

      const res = await request(app).get("/p/srv/")
      expect(res.status).toBe(409)
      expect(res.text).toContain("origin of its own")
      // The refusal lands before the process manager is asked for anything —
      // nothing is ever proxied on the shell's own origin.
      expect(ensures).toBe(0)
      // HTML on a `/p/**` URL, so it carries the same CSP and nosniff as
      // every other response from this handler.
      expect(res.headers["content-security-policy"]).toContain("connect-src")
      expect(res.headers["x-content-type-options"]).toBe("nosniff")
    })

    /**
     * The shared `VIEWER_PROTOTYPE_ORIGIN` host is cross-origin from the shell
     * but PATH-NAMESPACED, so no prototype owns `/` on it and a proxied app's
     * root-absolute assets would 404 with nothing to rewrite them. It is
     * refused for that reason, not the cookie one — see the fork's comment in
     * `serve-router.ts`.
     */
    it("refuses a server deployment on the shared prototype origin too", async () => {
      let ensures = 0
      const { app } = await loopbackAppWith({
        pinned: false,
        prototypeProcesses: fakeProcesses({
          ensure: () => {
            ensures += 1
            return Promise.resolve({ port: 1 })
          },
        }),
      })
      prototypeOriginMarker = true

      const res = await request(app).get("/p/srv/")
      expect(res.status).toBe(409)
      expect(res.text).toContain("origin of its own")
      expect(ensures).toBe(0)
    })

    it("answers 503 with the crash reason when the process cannot start", async () => {
      const { app } = await loopbackAppWith({
        prototypeProcesses: fakeProcesses({
          ensure: () =>
            Promise.reject(
              new PrototypeProcessError(
                { state: "crashed", exitCode: 1, restarts: 3, reason: "The server kept exiting.", retryable: false, generation: 1 },
                "The server kept exiting.",
              ),
            ),
        }),
      })

      const res = await request(app).get("/p/srv/")
      expect(res.status).toBe(503)
      expect(res.text).toContain("kept exiting")
      expect(res.headers["content-security-policy"]).toContain("connect-src")
      expect(res.headers["x-content-type-options"]).toBe("nosniff")
    })

    it("still serves a static deployment from the asset store", async () => {
      const c = await setup({
        prototypeProcesses: fakeProcesses({
          ensure: () => Promise.reject(new Error("a static deployment must never start a process")),
        }),
      })
      const project = await c.storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const deployment = await c.storage.createDeployment({ projectId: project.id })
      await c.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      await c.assets.put(deployment.id, "index.html", Buffer.from("<html><body>files</body></html>"))

      const res = await request(c.app).get("/p/acme/").expect(200)
      expect(res.text).toContain("files")
    })

    /**
     * Every HTTP method, on both kinds of deployment (task 8b).
     *
     * A prototype that runs as a server takes form posts, server actions and
     * API writes. A folder of files never did, and a static deployment's
     * answer to a write must not move a single byte — see the doc comment on
     * `staticPinnedApp` below for what that answer is and how it was
     * measured.
     */
    describe("methods other than GET", () => {
      /**
       * A `serve: "static"` deployment at slug `acme`, on the shell host in
       * PATH MODE — no pin, no subdomain marker.
       */
      async function staticPathModeApp() {
        const c = await setup({
          prototypeProcesses: fakeProcesses({
            ensure: () =>
              Promise.reject(new Error("a static deployment must never start a process")),
          }),
        })
        const project = await c.storage.createProject({
          slug: "acme",
          name: "Acme",
          access: "public-link",
        })
        const deployment = await c.storage.createDeployment({ projectId: project.id })
        await c.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
        await c.assets.put(deployment.id, "index.html", Buffer.from("<html><body>files</body></html>"))
        return { ...c, deploymentId: deployment.id }
      }

      /**
       * The same deployment, behind a pinned loopback listener — an ISOLATED
       * origin, and the control for every server-deployment assertion in this
       * block.
       */
      async function staticPinnedApp() {
        const c = await staticPathModeApp()
        pinnedMarker = { deploymentId: c.deploymentId, slug: "acme" }
        return c
      }

      it("proxies a POST to the child with its method, body bytes and content-type", async () => {
        let seen: { method?: string; contentType?: string; body: string } | null = null
        const port = await child((req, res) => {
          const chunks: Buffer[] = []
          req.on("data", (chunk: Buffer) => chunks.push(chunk))
          req.on("end", () => {
            seen = {
              method: req.method,
              contentType: req.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf-8"),
            }
            res.statusCode = 201
            res.setHeader("content-type", "application/json")
            res.end('{"created":true}')
          })
        })
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
        })

        const res = await request(app)
          .post("/p/srv/orders")
          .set("content-type", "application/json")
          .send('{"qty":2}')

        expect(res.status).toBe(201)
        expect(res.text).toBe('{"created":true}')
        expect(seen).toEqual({
          method: "POST",
          contentType: "application/json",
          body: '{"qty":2}',
        })
      })

      /**
       * MEASURED against the pre-task-8b code, with a probe that drove this
       * exact harness: `POST /p/acme/` was not matched by the router at all
       * (the route was `router.get`), so it fell through to Express's own
       * default handler — 404, `text/html`, body `<pre>Cannot POST
       * /p/acme/</pre>` inside its boilerplate page. The router answering it
       * itself would be a change, and a visible one: a 404 the router emits
       * says "this prototype has no such thing", while a fall-through says
       * "no route here at all". Keeping the fall-through is also what keeps a
       * write from becoming an existence oracle, since an unknown slug and an
       * unreadable project fall through in exactly the same way.
       */
      it("does not answer a POST to a static deployment — it still falls through", async () => {
        const c = await staticPinnedApp()
        const res = await request(c.app).post("/p/acme/")
        expect(res.status).toBe(404)
        expect(res.headers["content-type"]).toMatch(/^text\/html/)
        expect(res.text).toContain("Cannot POST /p/acme/")
      })

      it("does not answer a PUT, PATCH or DELETE to a static deployment either", async () => {
        const c = await staticPinnedApp()
        for (const verb of ["put", "patch", "delete"] as const) {
          const res = await request(c.app)[verb]("/p/acme/")
          expect(res.status, verb).toBe(404)
          expect(res.text, verb).toContain(`Cannot ${verb.toUpperCase()} /p/acme/`)
        }
      })

      /**
       * MEASURED the same way, in PATH MODE: `OPTIONS /p/acme/` was answered
       * by Express's own automatic OPTIONS response — 200, `Allow: GET, HEAD`,
       * with that string as the body, `Content-Type: text/plain` with no
       * charset. It still is, but the handler writes it rather than the router,
       * because the route is now `router.all` and an `all` route never triggers
       * the automatic answer. See the OPTIONS branch in `serve-router.ts`.
       *
       * Every path under the route, including a slug that does not exist:
       * before this task the answer came from route matching and never ran the
       * handler, so it could not depend on what the storage held, and it still
       * must not.
       */
      it("answers OPTIONS in path mode exactly as Express used to", async () => {
        const c = await staticPathModeApp()
        for (const path of ["/p/acme/", "/p/acme/x", "/p/nosuchslug/"]) {
          const res = await request(c.app).options(path)
          expect(res.status, path).toBe(200)
          expect(res.headers["allow"], path).toBe("GET, HEAD")
          expect(res.headers["content-type"], path).toBe("text/plain")
          expect(res.text, path).toBe("GET, HEAD")
        }
      })

      /**
       * On an ISOLATED origin the same request must NOT get that answer. A
       * prototype origin answered `404 Not found` to OPTIONS before this task
       * — the write-method fence refused it — and the way it keeps doing so is
       * that the handler hands OPTIONS back like any other write, for
       * `createPrototypeHostTerminalFence` to end.
       *
       * This harness has no terminal fence, so what it can show is the
       * fall-through itself: Express's default 404, meaning this router
       * answered nothing. `prototype-host-scope.test.ts` carries the real-app
       * half, where the fence turns that into `404 Not found`.
       */
      it("hands OPTIONS back on an isolated origin instead of answering Allow", async () => {
        const c = await staticPinnedApp()
        const res = await request(c.app).options("/p/acme/")
        expect(res.status).toBe(404)
        expect(res.headers["allow"]).toBeUndefined()
        expect(res.text).toContain("Cannot OPTIONS /p/acme/")
      })

      it("still serves GET and HEAD on a static deployment", async () => {
        const c = await staticPinnedApp()
        await request(c.app).get("/p/acme/").expect(200)
        const head = await request(c.app).head("/p/acme/")
        expect(head.status).toBe(200)
        expect(head.headers["content-type"]).toMatch(/text\/html/)
      })

      /** A prototype's own CORS preflight is the child's to answer, not ours. */
      it("proxies OPTIONS to a server deployment", async () => {
        let seenMethod: string | undefined
        const port = await child((req, res) => {
          seenMethod = req.method
          res.statusCode = 204
          res.setHeader("access-control-allow-methods", "GET, POST")
          res.end()
        })
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
        })

        const res = await request(app).options("/p/srv/api/orders")
        expect(res.status).toBe(204)
        expect(seenMethod).toBe("OPTIONS")
        expect(res.headers["access-control-allow-methods"]).toBe("GET, POST")
      })

      it("proxies HEAD to a server deployment, like GET", async () => {
        let seenMethod: string | undefined
        const port = await child((req, res) => {
          seenMethod = req.method
          res.setHeader("content-type", "text/html")
          res.end("<html><body>srv</body></html>")
        })
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
        })

        const res = await request(app).head("/p/srv/")
        expect(res.status).toBe(200)
        expect(seenMethod).toBe("HEAD")
      })

      /**
       * Rule 4 of the task: the path-mode refusal is a security boundary and a
       * write must not be the way around it. `proxy-to-process.ts` passes the
       * child's `set-cookie` through untouched, and in path mode the shell and
       * the prototype share an origin.
       */
      it("refuses a POST to a server deployment in path mode with the same 409, before any ensure", async () => {
        let ensures = 0
        const { app } = await loopbackAppWith({
          pinned: false,
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensures += 1
              return Promise.resolve({ port: 1 })
            },
          }),
        })

        const res = await request(app).post("/p/srv/").send("x=1")
        expect(res.status).toBe(409)
        expect(res.text).toContain("origin of its own")
        expect(ensures).toBe(0)
      })

      /**
       * OPTIONS in path mode does NOT take the 409, and that is deliberate.
       * The 409 needs the deployment row, and reading it would make the
       * OPTIONS answer depend on what storage holds — which is exactly what it
       * never did before this task, when the router answered from route
       * matching alone. A path-mode `Allow: GET, HEAD` for a prototype that
       * path mode refuses to serve at all is a little untrue, but it is the
       * answer this URL has always given, and it gives it for every slug
       * alike. The 409 still lands on every method that carries a request
       * body, which is the one the boundary is about.
       */
      it("answers OPTIONS in path mode without reading the deployment, even for a server one", async () => {
        let ensures = 0
        const { app } = await loopbackAppWith({
          pinned: false,
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensures += 1
              return Promise.resolve({ port: 1 })
            },
          }),
        })

        const res = await request(app).options("/p/srv/")
        expect(res.status).toBe(200)
        expect(res.headers["allow"]).toBe("GET, HEAD")
        expect(ensures).toBe(0)
      })

      it("refuses a POST to a server deployment on the shared prototype origin too", async () => {
        let ensures = 0
        const { app } = await loopbackAppWith({
          pinned: false,
          prototypeProcesses: fakeProcesses({
            ensure: () => {
              ensures += 1
              return Promise.resolve({ port: 1 })
            },
          }),
        })
        prototypeOriginMarker = true

        const res = await request(app).post("/p/srv/").send("x=1")
        expect(res.status).toBe(409)
        expect(ensures).toBe(0)
      })

      /**
       * `__desde/` is the viewer's reserved namespace on the prototype's
       * origin. A GET there is answered with the bridge bundle; a write there
       * is nobody's — least of all the child's, which must never see the URL.
       */
      it("never hands a write on the bridge path to the child", async () => {
        let hits = 0
        const port = await child((_req, res) => {
          hits += 1
          res.end("child")
        })
        const { app } = await loopbackAppWith({
          prototypeProcesses: fakeProcesses({ ensure: () => Promise.resolve({ port }) }),
        })

        const res = await request(app).post(`/p/srv/__desde/bridge-${BRIDGE_VERSION}.js`)
        expect(res.status).toBe(404)
        expect(res.text).toContain("Cannot POST")
        expect(hits).toBe(0)
      })

      /**
       * A write against a slug that does not exist, or one the caller cannot
       * read, falls through exactly as a write against a readable static
       * prototype does. If it did not, the difference between the two answers
       * would be a working existence oracle for anybody willing to send a
       * POST.
       */
      it("falls through identically for an unknown slug and an unreadable project", async () => {
        const c = await setup({ config: authedConfig })
        const locked = await c.storage.createProject({ slug: "locked", name: "L", access: "invited" })
        const dep = await c.storage.createDeployment({ projectId: locked.id, status: "deployed" })
        await c.storage.updateProject(locked.id, { activeDeploymentId: dep.id })

        const unknown = await request(c.app).post("/p/nosuch/")
        const unreadable = await request(c.app).post("/p/locked/")
        expect(unknown.status).toBe(404)
        expect(unreadable.status).toBe(404)
        expect(unreadable.headers["content-type"]).toBe(unknown.headers["content-type"])
        // Only the path differs inside Express's own "Cannot POST <path>" body.
        expect(unreadable.text.replace("/p/locked/", "/p/nosuch/")).toBe(unknown.text)
      })
    })
  })
})

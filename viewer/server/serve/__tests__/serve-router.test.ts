import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { loadConfig } from "../../config"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { UnsafePathError, type AssetStore, type StoredAsset } from "../../assets/types"
import { readBridgeBundle } from "../html-inject"
import { contentTypeFor } from "../mime"
import { buildHostAllowlist, isAllowedHost } from "../host-allowlist"
import { resolveOrigins } from "../prototype-origin-resolve"
import { createServeRouter, type PinnedDeploymentRequest } from "../serve-router"
import type { SubdomainRequest } from "../subdomain"
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

async function setup(overrides: { prototypeCsp?: string | null; config?: ReturnType<typeof loadConfig> } = {}) {
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
})

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import express from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DiskAssetStore } from "../../assets/disk-asset-store"
import { loadConfig } from "../../config"
import { signSessionId } from "../../auth/session-cookie"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createRootAssetFallback } from "../root-asset-fallback"
import { mintPrototypeCapability } from "../prototype-capability"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const openConfig = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
const authedConfig = loadConfig({
  VIEWER_GITHUB_CLIENT_ID: "client-id",
  VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
  VIEWER_SESSION_SECRET: "sesh-secret",
  VIEWER_PUBLIC_URL: "http://localhost:3199",
  VIEWER_DATA_DIR: tmpViewerDataDir(),
})

describe("createRootAssetFallback", () => {
  let dir: string
  let storage: InMemoryStorage
  let assets: DiskAssetStore
  let app: express.Express

  /**
   * ONE stable app object for this file — see `__tests__/swappable-app.ts`.
   *
   * This file's app genuinely closes over per-test `storage` and `assets`, so
   * it cannot be memoized the way the stateless guard tests are; the swappable
   * app is exactly for this case. 19 listening servers per run became 1.
   *
   * Safe to share: the nine tests in the "visibility enforcement" describe each
   * build their own `lockedApp` / `openApp` and NONE of them touches the outer
   * `app` that `beforeEach` installs.
   */
  const stable = createSwappableApp()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "viewer-fallback-"))
    storage = new InMemoryStorage()
    assets = new DiskAssetStore(dir)
    const inner = express()
    inner.use(createRootAssetFallback({ storage, assets, config: openConfig }))
    stable.use(inner)
    app = stable.app
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedProject(slug: string, relPath: string, body: string) {
    const project = await storage.createProject({ slug, name: slug, repoUrl: null, access: "public-link" })
    const deployment = await storage.createDeployment({ projectId: project.id, commitSha: null })
    await assets.put(deployment.id, relPath, Buffer.from(body))
    await storage.updateDeployment(deployment.id, { status: "deployed" })
    await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    return project
  }

  it("redirects a root-level miss to the referring prototype when the file exists there", async () => {
    await seedProject("acme", "assets/pic.png", "png-bytes")
    const res = await request(app)
      .get("/assets/pic.png")
      .set("Referer", "http://localhost:3199/p/acme/")
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/p/acme/assets/pic.png")
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  // Same opaque-origin readers as `/p/**` itself (see `prototype-cors.ts`):
  // this redirect is how a root-absolute asset URL baked into a
  // prototype's own JS bundle resolves for the sandboxed review iframe.
  it("sends ACAO * on the redirect response", async () => {
    await seedProject("acme", "assets/pic.png", "png-bytes")
    const res = await request(app)
      .get("/assets/pic.png")
      .set("Referer", "http://localhost:3199/p/acme/")
    expect(res.status).toBe(302)
    expect(res.headers["access-control-allow-origin"]).toBe("*")
  })

  it("resolves via referer even when another project also matches", async () => {
    await seedProject("first", "assets/shared.js", "first-copy")
    await seedProject("second", "assets/shared.js", "second-copy")
    const res = await request(app)
      .get("/assets/shared.js")
      .set("Referer", "http://localhost:3199/p/second/nested/page")
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/p/second/assets/shared.js")
  })

  it("falls back to scanning active deployments when there is no referer", async () => {
    await seedProject("acme", "assets/index-HASH1234.js", "js-bytes")
    const res = await request(app).get("/assets/index-HASH1234.js")
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/p/acme/assets/index-HASH1234.js")
  })

  it("does not scan root-level paths with no referer (would shadow the shell's own root assets)", async () => {
    await seedProject("acme", "vite.svg", "svg-bytes")
    const res = await request(app).get("/vite.svg")
    expect(res.status).toBe(404) // Express default — middleware called next()
  })

  it("still resolves a root-level path via the Referer lane", async () => {
    await seedProject("acme", "vite.svg", "svg-bytes")
    const res = await request(app).get("/vite.svg").set("Referer", "http://localhost:3199/p/acme/")
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/p/acme/vite.svg")
  })

  it("passes through when no deployment has the file", async () => {
    await seedProject("acme", "assets/real.js", "x")
    const res = await request(app).get("/assets/missing.js")
    expect(res.status).toBe(404) // Express default — middleware called next()
  })

  it("ignores non-GET requests and extensionless paths", async () => {
    await seedProject("acme", "assets/pic.png", "x")
    expect((await request(app).post("/assets/pic.png")).status).toBe(404)
    expect((await request(app).get("/some/route")).status).toBe(404)
  })

  it("does not intercept reserved prefixes", async () => {
    await seedProject("acme", "api/v1/health.js", "x")
    expect((await request(app).get("/api/v1/health.js")).status).toBe(404)
  })

  it("treats an unsafe path as a pass-through, not an error", async () => {
    await seedProject("acme", "assets/pic.png", "x")
    const res = await request(app).get("/..%2Fescape.js")
    expect([404, 400]).toContain(res.status)
    expect(res.headers.location).toBeUndefined()
  })

  it("properly encodes special characters in filenames", async () => {
    await seedProject("acme", "assets/pic?v=1.png", "special-chars")
    const res = await request(app)
      .get("/assets/pic%3Fv%3D1.png")
      .set("Referer", "http://localhost:3199/p/acme/")
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/p/acme/assets/pic%3Fv%3D1.png")
  })

  describe("visibility enforcement (closes the TODO(phase-3) gap — both lanes)", () => {
    async function seedLockedProject(store: InMemoryStorage, assetStore: DiskAssetStore, relPath: string, body: string) {
      const project = await store.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(store, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await store.addProjectMember({ projectId: project.id, userId: owner.id })
      const deployment = await store.createDeployment({ projectId: project.id, commitSha: null })
      await assetStore.put(deployment.id, relPath, Buffer.from(body))
      await store.updateDeployment(deployment.id, { status: "deployed" })
      await store.updateProject(project.id, { activeDeploymentId: deployment.id })
      return { project, owner }
    }

    it("Referer lane: does NOT resolve an unreadable 'members' project's asset — falls through like a genuine miss", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")

      const res = await request(lockedApp).get("/assets/pic.png").set("Referer", "http://localhost:3199/p/locked/")
      expect(res.status).toBe(404) // Express default — middleware called next(), no redirect leaked
      expect(res.headers.location).toBeUndefined()
    })

    it("Referer lane: a signed-in member DOES resolve the asset", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      const { project } = await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")
      const member = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "member",
        email: "member@x.com",
        displayName: "Member",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: member.id })
      const session = await storage.createSession({
        userId: member.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(authedConfig.sessionSecret, session.id)}`

      const res = await request(lockedApp)
        .get("/assets/pic.png")
        .set("Referer", "http://localhost:3199/p/locked/")
        .set("Cookie", cookie)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/p/locked/assets/pic.png")
    })

    it("hashed-name scan lane: does NOT resolve an unreadable 'members' project's asset with no referer", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/index-HASH1234.js", "secret-js")

      const res = await request(lockedApp).get("/assets/index-HASH1234.js")
      expect(res.status).toBe(404)
      expect(res.headers.location).toBeUndefined()
    })

    it("hashed-name scan lane: the admin bearer still resolves the asset", async () => {
      const adminConfig = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: adminConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/index-HASH1234.js", "secret-js")

      const res = await request(lockedApp)
        .get("/assets/index-HASH1234.js")
        .set("Authorization", "Bearer secret")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/p/locked/assets/index-HASH1234.js")
    })

    // Authorization v2 INVERTED this test's premise. `all-members` used to be
    // world-readable (the inherited zero-members migration rule) and is now
    // sign-in gated — so BOTH lanes must now decline for an anonymous caller,
    // and both must resolve once a session is attached. `seedProject` above
    // seeds `public-link` (the anonymous-review shape every other test in this
    // file means), so this one builds its `all-members` fixtures by hand.
    it("a project with the default access ('all-members') resolves through both lanes only once SIGNED IN", async () => {
      const openInner = express()
      openInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(openInner)
      const openApp = stable.app

      for (const [slug, relPath, body] of [
        ["open-referer", "assets/a.png", "a"],
        ["open-scan", "assets/index-HASH999.js", "b"],
      ] as const) {
        const project = await storage.createProject({ slug, name: slug, access: "all-members" })
        const deployment = await storage.createDeployment({ projectId: project.id, commitSha: null })
        await assets.put(deployment.id, relPath, Buffer.from(body))
        await storage.updateDeployment(deployment.id, { status: "deployed" })
        await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      }

      const anonReferer = await request(openApp)
        .get("/assets/a.png")
        .set("Referer", "http://localhost:3199/p/open-referer/")
      expect(anonReferer.status).toBe(404)
      const anonScan = await request(openApp).get("/assets/index-HASH999.js")
      expect(anonScan.status).toBe(404)

      const someone = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "someone",
        email: "someone@x.com",
        displayName: "Someone",
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: someone.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(authedConfig.sessionSecret, session.id)}`

      const viaReferer = await request(openApp)
        .get("/assets/a.png")
        .set("Referer", "http://localhost:3199/p/open-referer/")
        .set("Cookie", cookie)
      expect(viaReferer.status).toBe(302)

      const viaScan = await request(openApp).get("/assets/index-HASH999.js").set("Cookie", cookie)
      expect(viaScan.status).toBe(302)
    })

    // Phase 3b-2 fix wave (I3), REVERSING the strict-401 these two tests
    // originally asserted. The serve path delivers prototype FILES, and a
    // prototype routinely stubs an auth header against its own mocked API
    // (`fetch('/api/models', { headers: { Authorization: 'Bearer
    // demo-token' } })`), so 401ing an unrecognized bearer broke real
    // prototypes for nothing: an invalid bearer can never grant more than
    // anonymous, so rejecting it and treating it as anonymous reach the
    // IDENTICAL authorization outcome. Both lanes therefore fall back to
    // the anonymous context — and the pair of tests below pins both halves
    // of that: readable assets still resolve, unreadable ones still don't.
    it("Referer lane: an unrecognized bearer is treated as anonymous — an unreadable project stays unresolvable", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")

      const res = await request(lockedApp)
        .get("/assets/pic.png")
        .set("Referer", "http://localhost:3199/p/locked/")
        .set("Authorization", "Bearer not-a-real-token")
      expect(res.status).toBe(404) // Express default — middleware called next()
      expect(res.headers.location).toBeUndefined()
    })

    it("Referer lane: an unrecognized bearer still resolves a readable project's asset (the stubbed-auth prototype case)", async () => {
      const openInner = express()
      openInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(openInner)
      const openApp = stable.app
      // NOT under `/api/` — that's a RESERVED_PREFIX this middleware never
      // touches (it belongs to the viewer's own API router).
      await seedProject("open-referer", "mock/models.json", '{"models":[]}')

      const res = await request(openApp)
        .get("/mock/models.json")
        .set("Referer", "http://localhost:3199/p/open-referer/")
        .set("Authorization", "Bearer demo-token")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/p/open-referer/mock/models.json")
    })

    it("hashed-name scan lane: an unrecognized bearer is treated as anonymous and still resolves a readable asset", async () => {
      const openInner = express()
      openInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(openInner)
      const openApp = stable.app
      await seedProject("open-scan", "assets/index-HASH999.js", "b")

      const res = await request(openApp)
        .get("/assets/index-HASH999.js")
        .set("Authorization", "Bearer demo-token")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/p/open-scan/assets/index-HASH999.js")
    })

    it("hashed-name scan lane: an unrecognized bearer does NOT unlock an unreadable project's asset", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/index-HASH1234.js", "secret-js")

      const res = await request(lockedApp)
        .get("/assets/index-HASH1234.js")
        .set("Authorization", "Bearer not-a-real-token")
      expect(res.status).toBe(404)
      expect(res.headers.location).toBeUndefined()
    })

    // Fix wave 11, item 1. The sandboxed review iframe (opaque origin) sends
    // NO session cookie on subresource requests, so a root-absolute asset
    // (`/assets/foo.png`) baked into an `all-members` or private bundle
    // arrives here anonymously. Its referer, however, carries the iframe's
    // own `~c/<token>` capability prefix — the SAME credential
    // `/p/{slug}/~c/{token}/` already accepts. This lane must honour it,
    // authorize the redirect, and carry the capability INTO the redirect so
    // the (still cookie-less) follow-up request authorizes identically.
    it("Referer capability lane: a cookie-less request with a valid ~c capability resolves and carries it into the redirect", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")
      const project = await storage.getProjectBySlug("locked")
      const token = mintPrototypeCapability({
        secret: authedConfig.sessionSecret,
        slug: project!.slug,
        deploymentId: project!.activeDeploymentId,
      })
      expect(token).not.toBeNull()

      const res = await request(lockedApp)
        .get("/assets/pic.png")
        .set("Referer", `http://localhost:3199/p/locked/~c/${token}/`)
      // No cookie, no bearer — authorized purely by the capability.
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(`/p/locked/~c/${token}/assets/pic.png`)
    })

    it("Referer capability lane: an all-members bundle's root-absolute asset resolves for a cookie-less sandboxed iframe", async () => {
      const openInner = express()
      openInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(openInner)
      const openApp = stable.app
      const project = await storage.createProject({ slug: "member-open", name: "member-open", access: "all-members" })
      const deployment = await storage.createDeployment({ projectId: project.id, commitSha: null })
      await assets.put(deployment.id, "assets/app.js", Buffer.from("js"))
      await storage.updateDeployment(deployment.id, { status: "deployed" })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })
      const token = mintPrototypeCapability({
        secret: authedConfig.sessionSecret,
        slug: project.slug,
        deploymentId: deployment.id,
      })

      const res = await request(openApp)
        .get("/assets/app.js")
        .set("Referer", `http://localhost:3199/p/member-open/~c/${token}/`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(`/p/member-open/~c/${token}/assets/app.js`)
    })

    it("Referer capability lane: a FORGED capability with no cookie stays unresolvable (no oracle)", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")

      const res = await request(lockedApp)
        .get("/assets/pic.png")
        .set("Referer", "http://localhost:3199/p/locked/~c/9999.forged-signature/")
      expect(res.status).toBe(404) // falls through exactly like no capability
      expect(res.headers.location).toBeUndefined()
    })

    it("Referer capability lane: a capability minted for another deployment does not authorize this one", async () => {
      const lockedInner = express()
      lockedInner.use(createRootAssetFallback({ storage, assets, config: authedConfig }))
      stable.use(lockedInner)
      const lockedApp = stable.app
      await seedLockedProject(storage, assets, "assets/pic.png", "secret-bytes")
      // A well-formed token, but bound to a DIFFERENT deployment id — the id
      // is a MAC input, so it cannot verify against the project's current one.
      const wrongToken = mintPrototypeCapability({
        secret: authedConfig.sessionSecret,
        slug: "locked",
        deploymentId: "some-other-deployment",
      })

      const res = await request(lockedApp)
        .get("/assets/pic.png")
        .set("Referer", `http://localhost:3199/p/locked/~c/${wrongToken}/`)
      expect(res.status).toBe(404)
      expect(res.headers.location).toBeUndefined()
    })
  })
})

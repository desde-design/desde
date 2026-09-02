import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tar from "tar"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { promises as fs } from "node:fs"
import { DiskAssetStore } from "../../assets/disk-asset-store"
import type { AssetStore, StoredAsset } from "../../assets/types"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { DeploymentUpdatePatch, StorageAdapter } from "../../storage/types"
import type { ViewerConfig } from "../../config"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { isSecurePublicUrl } from "../state-cookie"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const config: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  dataDir: ".tmp",
  publicUrl: "https://viewer.example.com",
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
  seedDemoProject: true,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
}

const auth = { Authorization: "Bearer test-token" }
const BRIDGE = "console.log('bridge')"

let workDir: string

/** Builds a .tar.gz of a tiny prototype bundle and returns its bytes. */
function makeBundle(files: Record<string, string>): Buffer {
  const src = join(workDir, `src-${Math.random().toString(36).slice(2)}`)
  for (const [relPath, contents] of Object.entries(files)) {
    const target = join(src, relPath)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, contents)
  }
  const archive = join(workDir, `bundle-${Math.random().toString(36).slice(2)}.tar.gz`)
  tar.c({ gzip: true, cwd: src, file: archive, sync: true }, ["."])
  return readFileSync(archive)
}

/**
 * Builds a .tar.gz containing a single zero-filled file of `fileSizeBytes`.
 * Zeros compress to almost nothing, so this fixture is small on the wire
 * (well under MAX_BUNDLE_BYTES) but expands back to `fileSizeBytes` once
 * gunzipped — the exact "zip bomb" shape the extracted-bytes cap guards
 * against.
 */
function makeZeroBombBundle(fileSizeBytes: number): Buffer {
  const src = join(workDir, `bomb-src-${Math.random().toString(36).slice(2)}`)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, "zeros.bin"), Buffer.alloc(fileSizeBytes))
  const archive = join(workDir, `bomb-${Math.random().toString(36).slice(2)}.tar.gz`)
  tar.c({ gzip: true, cwd: src, file: archive, sync: true }, ["."])
  return readFileSync(archive)
}

/**
 * Builds a .tar.gz containing `count` empty, flat, top-level files — the
 * "many tiny files" shape S4 bounds (as opposed to `makeZeroBombBundle`'s
 * "one huge file" shape, which the byte caps already cover). Content is
 * empty on purpose: the entry COUNT is what this fixture stresses, not size.
 */
function makeManyEntriesBundle(count: number): Buffer {
  const src = join(workDir, `many-src-${Math.random().toString(36).slice(2)}`)
  mkdirSync(src, { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(src, `f${i}`), "")
  }
  const archive = join(workDir, `many-${Math.random().toString(36).slice(2)}.tar.gz`)
  tar.c({ gzip: true, cwd: src, file: archive, sync: true }, ["."])
  return readFileSync(archive)
}

/**
 * Wraps a real AssetStore but fails the SECOND `put()` call — simulates a
 * disk error partway through writing an upload's files, so tests can prove
 * `fail()` cleans up the files that succeeded before the failure instead of
 * orphaning them.
 */
class FlakyAssetStore implements AssetStore {
  private putCount = 0
  constructor(private readonly inner: AssetStore) {}

  put(deploymentId: string, relPath: string, body: Buffer): Promise<void> {
    this.putCount += 1
    if (this.putCount === 2) {
      return Promise.reject(new Error("simulated disk failure"))
    }
    return this.inner.put(deploymentId, relPath, body)
  }

  get(deploymentId: string, relPath: string): Promise<StoredAsset | null> {
    return this.inner.get(deploymentId, relPath)
  }

  deleteDeployment(deploymentId: string): Promise<void> {
    return this.inner.deleteDeployment(deploymentId)
  }
}

/**
 * Wraps a real StorageAdapter but rejects the FIRST `updateDeployment` call
 * that marks a deployment `failed` — simulates `fail()`'s own storage write
 * throwing, so tests can prove the route responds exactly once (a 5xx via
 * Express's default error handling) instead of crashing on a second
 * `res.json()` after headers are already sent.
 */
function makeStorageThatFailsMarkingFailedOnce(inner: StorageAdapter): StorageAdapter {
  let thrown = false
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "updateDeployment") {
        return async (id: string, patch: DeploymentUpdatePatch) => {
          if (patch.status === "failed" && !thrown) {
            thrown = true
            throw new Error("simulated storage failure while marking deployment failed")
          }
          return target.updateDeployment(id, patch)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * `setup()` runs per test and four more apps are built inline: 21 listening
 * servers per run.
 *
 * Safe to share: every test uses either the `beforeEach` ctx or exactly one
 * locally-built app, never both.
 */
const stable = createSwappableApp()

function setup(): { app: ReturnType<typeof createApp>; deps: AppDeps } {
  const deps: AppDeps = {
    storage: new InMemoryStorage(),
    assets: new DiskAssetStore(join(workDir, "assets")),
    config,
    bridgeScript: BRIDGE,
    github: testGithubRuntime(),
  }
  stable.use(createApp(deps))
  return { app: stable.app, deps }
}

/** Same as `setup()`, but the AssetStore fails its second `put()` call. */
function setupFlaky(): { app: ReturnType<typeof createApp>; assets: DiskAssetStore } {
  const disk = new DiskAssetStore(join(workDir, "assets"))
  const deps: AppDeps = {
    storage: new InMemoryStorage(),
    assets: new FlakyAssetStore(disk),
    config,
    bridgeScript: BRIDGE,
    github: testGithubRuntime(),
  }
  stable.use(createApp(deps))
  return { app: stable.app, assets: disk }
}

async function createProject(app: ReturnType<typeof createApp>) {
  const res = await request(app)
    .post("/api/v1/projects")
    .set(auth)
    .send({ slug: "acme", name: "Acme", access: "public-link" })
    .expect(201)
  return res.body as { id: string; slug: string }
}

describe("deployments API", () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "viewer-deploy-"))
    ctx = setup()
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  // Authorization v2: the upload routes through `requireProjectManage`. On a
  // project the caller CAN read (this fixture is `public-link`) the refusal is
  // 403 — the existence of the project was already disclosed by the read gate,
  // so a 403 leaks nothing. It was 401 while `requireWrite` answered "no
  // credential" without ever consulting the project.
  it("refuses an anonymous upload with 403", async () => {
    const project = await createProject(ctx.app)
    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "index.html": "<body>hi</body>" }))
      .expect(403)
  })

  it("404s an unknown project", async () => {
    await request(ctx.app)
      .post("/api/v1/projects/unknown/deployments")
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "index.html": "<body>hi</body>" }))
      .expect(404)
  })

  it("uploads a bundle, activates it, and serves it with the bridge", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments?commitSha=abc123`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": "<html><head></head><body><h1>hello</h1></body></html>",
          "assets/app.js": "export const a = 1",
        }),
      )
      .expect(201)

    expect(res.body.status).toBe("deployed")
    expect(res.body.commitSha).toBe("abc123")
    expect(res.body.fileCount).toBe(2)

    const updated = await request(ctx.app).get(`/api/v1/projects/${project.id}`).expect(200)
    expect(updated.body.activeDeploymentId).toBe(res.body.id)

    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("<h1>hello</h1>")
    expect(page.text).toContain('<base href="/p/acme/">')
    // The bridge is referenced by an external <script src>, never inlined
    // (the built bundle contains `<!--`, which corrupts inline-script
    // parsing — see html-inject.ts's injectBridge doc comment).
    // Asserted as tag + src rather than one exact string: the tag also carries
    // `data-shell-origin` (the CSP-safe origin channel the bridge needs now
    // that it fails closed), and pinning the whole literal here would make
    // every future attribute a spurious failure in an unrelated suite.
    expect(page.text).toContain('data-prototype-flow="bridge"')
    expect(page.text).toContain('src="/p/acme/__desde/bridge-dev.js"')
    expect(page.text).not.toContain(BRIDGE)

    const bridge = await request(ctx.app).get("/p/acme/__desde/bridge-dev.js").expect(200)
    expect(bridge.text).toBe(BRIDGE)
    expect(bridge.headers["content-type"]).toBe("application/javascript; charset=utf-8")

    const asset = await request(ctx.app).get("/p/acme/assets/app.js").expect(200)
    expect(asset.text).toBe("export const a = 1")
  })

  it("replaces the active deployment on a second upload", async () => {
    const project = await createProject(ctx.app)

    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "index.html": "<body>first</body>" }))
      .expect(201)

    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "index.html": "<body>second</body>" }))
      .expect(201)

    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("second")
    expect(page.text).not.toContain("first")
  })

  it("S5: reclaims a superseded deployment's assets once it falls off the retention window", async () => {
    const project = await createProject(ctx.app)

    const ids: string[] = []
    // DEPLOYMENT_RETENTION_COUNT is 5 — the active deployment plus the 4
    // before it are kept; the 6th upload pushes the very first one out.
    for (let i = 0; i < 6; i++) {
      const res = await request(ctx.app)
        .post(`/api/v1/projects/${project.id}/deployments`)
        .set(auth)
        .set("Content-Type", "application/gzip")
        .send(makeBundle({ "index.html": `<body>${i}</body>` }))
        .expect(201)
      ids.push(res.body.id as string)
    }

    // The oldest deployment's assets are gone from disk...
    expect(await ctx.deps.assets.get(ids[0], "index.html")).toBeNull()
    // ...but its ROW survives (asset-only reclamation — see
    // `pruneSupersededDeploymentAssets`'s doc comment for why row pruning is
    // a separate follow-up).
    const list = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/deployments`)
      .expect(200)
    expect(list.body.deployments.map((d: { id: string }) => d.id)).toContain(ids[0])

    // The 4 before the active one, and the active one itself, are retained.
    for (const id of ids.slice(1)) {
      expect(await ctx.deps.assets.get(id, "index.html")).not.toBeNull()
    }

    // The currently active deployment still serves correctly.
    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("<body>5")
  })

  it("re-roots a tarred-the-folder bundle (dist/index.html) and serves it as if tarred correctly", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          // Finder junk beside the folder must not veto the re-root.
          ".DS_Store": "junk",
          "._index.html": "appledouble junk",
          "dist/index.html": "<body>re-rooted</body>",
          "dist/assets/app.js": "console.log(1)",
        }),
      )
      .expect(201)

    // Junk outside the root is not published; the count is the real files.
    expect(res.body.fileCount).toBe(2)

    // Served at the prototype root, prefix stripped — exactly as if the tar
    // had been made from inside dist/.
    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("re-rooted")
    expect(await ctx.deps.assets.get(res.body.id as string, "assets/app.js")).not.toBeNull()
    expect(await ctx.deps.assets.get(res.body.id as string, ".DS_Store")).toBeNull()
  })

  it("publishes the BUILT output from a whole-project tar, not the source entry beside it", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          // Vite-style: the ROOT index.html is the build ENTRY (source),
          // and node_modules rides along. The built output is dist/.
          "package.json": "{}",
          "index.html": "<body>source entry</body>",
          "src/main.js": "// source",
          "node_modules/somelib/index.js": "// dependency",
          "dist/index.html": "<body>built</body>",
          "dist/assets/app.js": "console.log(1)",
        }),
      )
      .expect(201)

    expect(res.body.fileCount).toBe(2)
    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("built")
    expect(page.text).not.toContain("source entry")
    // node_modules was never extracted, let alone published.
    expect(await ctx.deps.assets.get(res.body.id as string, "node_modules/somelib/index.js")).toBeNull()
  })

  it("prefers the build over CRA's public/ source template in a whole-project tar", async () => {
    const project = await createProject(ctx.app)

    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "package.json": "{}",
          "public/index.html": "<body>template</body>",
          "build/index.html": "<body>built</body>",
        }),
      )
      .expect(201)

    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("built")
  })

  it("refuses an UNBUILT whole-project tar with an instruction, not a shrug", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "package.json": "{}",
          "src/App.vue": "<template/>",
        }),
      )
      .expect(400)

    expect(res.body.error).toMatch(/whole project/i)
    expect(res.body.error).toMatch(/build/i)
  })

  it("still accepts a BUILD that ships its own package.json at the root (SSR-style outputs)", async () => {
    const project = await createProject(ctx.app)

    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "package.json": "{}",
          "index.html": "<body>ssr build</body>",
        }),
      )
      .expect(201)

    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("ssr build")
  })

  it("resolves `tar src dist` to dist by folder-name convention, no package.json needed", async () => {
    const project = await createProject(ctx.app)

    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "src/index.html": "<body>source</body>",
          "dist/index.html": "<body>built</body>",
        }),
      )
      .expect(201)

    const page = await request(ctx.app).get("/p/acme/").expect(200)
    expect(page.text).toContain("built")
    expect(page.text).not.toContain("source")
  })

  it("still rejects a bundle whose folders carry no known convention — a pick would be a guess", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "docs/index.html": "<body>docs</body>",
          "examples/index.html": "<body>examples</body>",
        }),
      )
      .expect(400)

    expect(res.body.error).toMatch(/index\.html/i)
  })

  it("rejects a bundle with no index.html and marks the deployment failed", async () => {
    const project = await createProject(ctx.app)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "readme.txt": "no entry point" }))
      .expect(400)

    expect(res.body.error).toMatch(/index\.html/i)

    const list = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/deployments`)
      .expect(200)
    expect(list.body.deployments[0].status).toBe("failed")

    const project2 = await request(ctx.app).get(`/api/v1/projects/${project.id}`).expect(200)
    expect(project2.body.activeDeploymentId).toBeNull()
  })

  it("rejects a corrupt archive", async () => {
    const project = await createProject(ctx.app)
    await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(Buffer.from("this is not a tarball"))
      .expect(400)
  })

  it("lists deployments newest first", async () => {
    const project = await createProject(ctx.app)
    for (const body of ["one", "two"]) {
      await request(ctx.app)
        .post(`/api/v1/projects/${project.id}/deployments`)
        .set(auth)
        .set("Content-Type", "application/gzip")
        .send(makeBundle({ "index.html": `<body>${body}</body>` }))
        .expect(201)
    }
    const res = await request(ctx.app)
      .get(`/api/v1/projects/${project.id}/deployments`)
      .expect(200)
    expect(res.body.deployments).toHaveLength(2)
    expect(res.body.deployments.every((d: { status: string }) => d.status === "deployed")).toBe(true)
  })

  it(
    "rejects a zip-bomb-shaped archive that exceeds the extracted-bytes cap, and marks the deployment failed",
    async () => {
      const project = await createProject(ctx.app)

      // 205 MiB of zeros compresses to a few KB on the wire (well under
      // MAX_BUNDLE_BYTES) but expands back to 205 MiB once gunzipped —
      // over the 200 MiB MAX_EXTRACTED_BYTES cap.
      const bomb = makeZeroBombBundle(205 * 1024 * 1024)
      expect(bomb.length).toBeLessThan(5 * 1024 * 1024)

      const res = await request(ctx.app)
        .post(`/api/v1/projects/${project.id}/deployments`)
        .set(auth)
        .set("Content-Type", "application/gzip")
        .send(bomb)
        .expect(400)

      expect(res.body.error).toMatch(/extracted contents too large/i)

      const list = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/deployments`)
        .expect(200)
      expect(list.body.deployments[0].status).toBe("failed")

      const project2 = await request(ctx.app).get(`/api/v1/projects/${project.id}`).expect(200)
      expect(project2.body.activeDeploymentId).toBeNull()
    },
    // Generating + gzipping a 205 MiB fixture is legitimately slower than
    // vitest's default per-test timeout.
    30_000,
  )

  it(
    "rejects a bundle with more entries than MAX_BUNDLE_ENTRIES (S4), and marks the deployment failed",
    async () => {
      const project = await createProject(ctx.app)

      // One entry over the 20,000 cap — every file is empty, so this is well
      // under both byte caps (S4's point: a huge COUNT of tiny files sails
      // under byte-based limits).
      const bundle = makeManyEntriesBundle(20_001)

      const res = await request(ctx.app)
        .post(`/api/v1/projects/${project.id}/deployments`)
        .set(auth)
        .set("Content-Type", "application/gzip")
        .send(bundle)
        .expect(400)

      expect(res.body.error).toMatch(/more than 20000 (entries|files)/i)

      const list = await request(ctx.app)
        .get(`/api/v1/projects/${project.id}/deployments`)
        .expect(200)
      expect(list.body.deployments[0].status).toBe("failed")

      const project2 = await request(ctx.app).get(`/api/v1/projects/${project.id}`).expect(200)
      expect(project2.body.activeDeploymentId).toBeNull()
    },
    30_000,
  )

  it("still accepts a large-but-legitimate bundle comfortably under MAX_BUNDLE_ENTRIES", async () => {
    const project = await createProject(ctx.app)
    // Well under the 20,000 cap — representative of a large real prototype
    // (many chunks/images/locale files), proving the cap doesn't punish
    // ordinary generous-sized output on the way to stopping the pathological
    // case above.
    const src = join(workDir, "large-legit-src")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "index.html"), "<body>ok</body>")
    for (let i = 0; i < 4_999; i++) {
      writeFileSync(join(src, `f${i}`), "")
    }
    const archive = join(workDir, "large-legit.tar.gz")
    tar.c({ gzip: true, cwd: src, file: archive, sync: true }, ["."])
    const bundle = readFileSync(archive)

    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(bundle)
      .expect(201)
    expect(res.body.fileCount).toBe(5_000)
  }, 30_000)

  it("cleans up orphaned assets when a later file's put() fails mid-upload", async () => {
    const { app, assets } = setupFlaky()
    const project = await createProject(app)

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": "<body>hi</body>",
          "assets/app.js": "export const a = 1",
        }),
      )
      .expect(400)

    expect(res.body.error).toMatch(/simulated disk failure/i)
    const deploymentId = res.body.deploymentId as string

    const list = await request(app)
      .get(`/api/v1/projects/${project.id}/deployments`)
      .expect(200)
    expect(list.body.deployments[0].status).toBe("failed")

    const project2 = await request(app).get(`/api/v1/projects/${project.id}`).expect(200)
    expect(project2.body.activeDeploymentId).toBeNull()

    // The first file's put() succeeded before the second failed — assert
    // fail()'s cleanup removed it instead of leaving it orphaned on disk.
    expect(await assets.get(deploymentId, "index.html")).toBeNull()
    expect(await assets.get(deploymentId, "assets/app.js")).toBeNull()
  })

  it("responds exactly once when fail() itself throws while marking a bad bundle failed", async () => {
    const storage = makeStorageThatFailsMarkingFailedOnce(new InMemoryStorage())
    const deps: AppDeps = {
      storage,
      assets: new DiskAssetStore(join(workDir, "assets")),
      config,
      bridgeScript: BRIDGE,
      github: testGithubRuntime(),
    }
    stable.use(createApp(deps))
    const app = stable.app
    const project = await createProject(app)

    // No index.html triggers the fail() call inside the try block; the
    // storage wrapper makes that fail() call's own updateDeployment throw,
    // which used to make the catch block re-run fail() and attempt a
    // second res.json() after the first had (partially) run.
    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(makeBundle({ "readme.txt": "no entry point" }))
      .expect(500)

    // A single, well-formed 5xx from Express's default error handling
    // (create-app.ts) — not a crash, and no internal detail leaked.
    expect(res.body).toEqual({ error: "Internal server error" })
  })

  it("records a warning when the uploaded HTML bakes a root-absolute <script src>", async () => {
    const project = await createProject(ctx.app)
    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": '<!doctype html><html><body><script src="/assets/app.js"></script></body></html>',
          "assets/app.js": "export default 1;",
        }),
      )
      .expect(201)
    expect(res.body.warnings).toEqual([
      {
        kind: "root-absolute-assets",
        summary: "1 root-absolute asset reference found in 1 file",
        findings: [{ file: "index.html", kind: "html-attr", sample: '<script src="/assets/app.js">' }],
      },
    ])
    expect(res.body.buildLog).toMatch(/Warning: 1 root-absolute asset reference/)
  })

  it("records a warning for a CSS url(/...) reference", async () => {
    const project = await createProject(ctx.app)
    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": "<!doctype html><html><body>ok</body></html>",
          "assets/index.css": "@font-face { src: url(/fonts/sans.woff2); }",
        }),
      )
      .expect(201)
    expect(res.body.warnings[0].findings).toEqual([
      { file: "assets/index.css", kind: "css-url", sample: "url(/fonts/sans.woff2)" },
    ])
  })

  it("records no warnings for a bundle with no root-absolute references", async () => {
    const project = await createProject(ctx.app)
    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": '<!doctype html><html><body><script src="./assets/app.js"></script></body></html>',
          "assets/app.js": `import x from "./other.js"; export default x;`,
          "assets/other.js": "export default 1;",
        }),
      )
      .expect(201)
    expect(res.body.warnings).toBeNull()
    expect(res.body.buildLog).not.toMatch(/Warning:/)
  })

  it("does not flag an ordinary same-origin API string as a warning", async () => {
    // The exact fixture the old ad hoc detector over-flagged (any string
    // that happened to contain one of the bundle's own top-level directory
    // names). The bundler-research-derived patterns intentionally do NOT
    // flag a generic string literal in app JS — see root-absolute-scan.ts.
    const project = await createProject(ctx.app)
    const res = await request(ctx.app)
      .post(`/api/v1/projects/${project.id}/deployments`)
      .set(auth)
      .set("Content-Type", "application/gzip")
      .send(
        makeBundle({
          "index.html": "<!doctype html><html><body>ok</body></html>",
          "assets/app.js": `const img = "/assets/pic.png"; export default img;`,
          "assets/pic.png": "png-bytes",
        }),
      )
      .expect(201)
    expect(res.body.warnings).toBeNull()
  })

  it("completes the upload successfully even if the reference scan fails", async () => {
    const project = await createProject(ctx.app)

    // Spy on fs.readFile to make it throw once asset publishing has
    // finished (each of the 3 files is read once as bytes during
    // `publishOutputDir`) and the root-absolute scan starts re-reading the
    // recognized-extension files as text.
    let readCount = 0
    const originalReadFile = fs.readFile
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      readCount += 1
      if (readCount > 3) {
        throw new Error("simulated scan failure")
      }
      return originalReadFile.apply(fs, args)
    })

    try {
      const res = await request(ctx.app)
        .post(`/api/v1/projects/${project.id}/deployments`)
        .set(auth)
        .set("Content-Type", "application/gzip")
        .send(
          makeBundle({
            "index.html": '<!doctype html><html><body><script src="/assets/app.js"></script></body></html>',
            "assets/app.js": "export default 1;",
            "assets/pic.png": "png-bytes",
          }),
        )
        .expect(201)

      // Upload succeeds despite scan failure
      expect(res.body.status).toBe("deployed")
      // No warnings recorded because the scan failed and degraded gracefully
      expect(res.body.warnings).toBeNull()
      expect(res.body.buildLog).not.toMatch(/Warning:/)
      // But still recorded the upload count
      expect(res.body.buildLog).toMatch(/Uploaded 3 files/)
    } finally {
      readFileSpy.mockRestore()
    }
  })

  describe("visibility enforcement", () => {
    const authedConfig: ViewerConfig = {
      ...config,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "secret" },
    }

    async function createLockedProject(storage: InMemoryStorage) {
      const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      return project
    }

    it("GET deployments: 404s a non-member on a locked project, byte-identical to an unknown project", async () => {
      const storage = new InMemoryStorage()
      const project = await createLockedProject(storage)
      stable.use(
        createApp({
          storage,
          assets: new DiskAssetStore(join(workDir, "assets")),
          config: authedConfig,
          bridgeScript: BRIDGE,
          github: testGithubRuntime(),
        }),
      )
      const lockedApp = stable.app

      const denied = await request(lockedApp).get(`/api/v1/projects/${project.id}/deployments`)
      const missing = await request(lockedApp).get(`/api/v1/projects/nope/deployments`)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("GET deployments: a signed-in member CAN read a locked project's deployment history", async () => {
      const storage = new InMemoryStorage()
      const project = await createLockedProject(storage)
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
      // https config → the live session cookie name carries the __Host- prefix.
      const cookieName = sessionCookieName(isSecurePublicUrl(authedConfig.publicUrl))
      const cookie = `${cookieName}=${signSessionId(authedConfig.sessionSecret, session.id)}`
      stable.use(
        createApp({
          storage,
          assets: new DiskAssetStore(join(workDir, "assets")),
          config: authedConfig,
          bridgeScript: BRIDGE,
          github: testGithubRuntime(),
        }),
      )
      const lockedApp = stable.app

      const res = await request(lockedApp).get(`/api/v1/projects/${project.id}/deployments`).set("Cookie", cookie)
      expect(res.status).toBe(200)
    })

    /**
     * S7, rewritten for Authorization v2.
     *
     * `includeBuildLog` is the MANAGE rule now, not a membership check — it
     * has to be, because the dedicated log-STREAM route is `requireProjectManage`
     * and a caller refused the stream while being handed the identical bytes
     * in this list has not been gated at all. So the boundary is a signed-in
     * `viewer` (list yes, log no) against a signed-in `editor` (both), and a
     * membership row is deliberately given to the VIEWER to prove a row grants
     * no authority.
     */
    it("S7: a signed-in VIEWER sees the deployment but NOT its buildLog — an EDITOR gets the content", async () => {
      const storage = new InMemoryStorage()
      // `all-members`: both callers can read the deployment list, so the
      // buildLog omission is the only thing under test.
      const project = await storage.createProject({ slug: "open", name: "Open" })
      const outsider = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "outsider",
        email: "outsider@x.com",
        displayName: "Outsider",
        avatarUrl: "",
        role: "viewer",
      })
      const member = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "member2",
        email: "member2@x.com",
        displayName: "Member",
        avatarUrl: "",
        role: "editor",
      })
      // Deliberately on the VIEWER, not the editor: an access-list row must
      // not carry authority.
      await storage.addProjectMember({ projectId: project.id, userId: outsider.id })
      const outsiderSession = await storage.createSession({
        userId: outsider.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const outsiderName = sessionCookieName(isSecurePublicUrl(authedConfig.publicUrl))
      const outsiderCookie = `${outsiderName}=${signSessionId(authedConfig.sessionSecret, outsiderSession.id)}`
      const dep = await storage.createDeployment({ projectId: project.id })
      await storage.updateDeployment(dep.id, {
        status: "deployed",
        buildLog: "Installing dependencies\nNPM_TOKEN=super-secret npm ci\n",
      })
      stable.use(
        createApp({
          storage,
          assets: new DiskAssetStore(join(workDir, "assets")),
          config: authedConfig,
          bridgeScript: BRIDGE,
          github: testGithubRuntime(),
        }),
      )
      const openApp = stable.app

      const asOutsider = await request(openApp)
        .get(`/api/v1/projects/${project.id}/deployments`)
        .set("Cookie", outsiderCookie)
      expect(asOutsider.status).toBe(200)
      expect(asOutsider.body.deployments).toHaveLength(1)
      // The deployment itself (status, id, createdAt) is visible...
      expect(asOutsider.body.deployments[0].id).toBe(dep.id)
      expect(asOutsider.body.deployments[0].status).toBe("deployed")
      // ...but buildLog is omitted entirely, not blanked, for a viewer.
      expect(asOutsider.body.deployments[0]).not.toHaveProperty("buildLog")

      // An EDITOR holding NO membership row sees the real content.
      const memberSession = await storage.createSession({
        userId: member.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const memberName = sessionCookieName(isSecurePublicUrl(authedConfig.publicUrl))
      const memberCookie = `${memberName}=${signSessionId(authedConfig.sessionSecret, memberSession.id)}`
      const asMember = await request(openApp)
        .get(`/api/v1/projects/${project.id}/deployments`)
        .set("Cookie", memberCookie)
      expect(asMember.body.deployments[0].buildLog).toContain("Installing dependencies")
    })

    // Authorization v2 INVERTED this. A zero-member `all-members` project is
    // no longer readable by anyone — the migration rule is deleted — so its
    // deployment history follows the project's own read gate down to the
    // byte-identical 404, and a `public-link` project is what stays open.
    it("a zero-member project's deployment history follows the project read gate: 404 anonymously, 200 on public-link", async () => {
      const storage = new InMemoryStorage()
      const gated = await storage.createProject({ slug: "open", name: "Open" })
      const open = await storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      stable.use(
        createApp({
          storage,
          assets: new DiskAssetStore(join(workDir, "assets")),
          config: authedConfig,
          bridgeScript: BRIDGE,
          github: testGithubRuntime(),
        }),
      )
      const openApp = stable.app
      const denied = await request(openApp).get(`/api/v1/projects/${gated.id}/deployments`)
      const missing = await request(openApp).get(`/api/v1/projects/nope/deployments`)
      expect(denied.status).toBe(404)
      expect(denied.body).toEqual(missing.body)
      expect((await request(openApp).get(`/api/v1/projects/${open.id}/deployments`)).status).toBe(200)
    })
  })
})

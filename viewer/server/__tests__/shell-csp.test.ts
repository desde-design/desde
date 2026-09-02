/**
 * The shell's own `frame-ancestors 'none'`.
 *
 * Before this, `http://localhost:PORT/` (the dashboard) carried no framing
 * protection at all — no `X-Frame-Options`, no `frame-ancestors` (grep-
 * confirmed absent; see the adversarial review, "The exact attribute set").
 * A hosted prototype could `<iframe src="/">` the shell as a clickjacking
 * surface inside the reviewer's own review page — `frame-src 'none'` on the
 * PROTOTYPE'S csp stops the prototype nesting a frame of its own, but that
 * is a property of the prototype's policy, not the shell's, and it costs
 * nothing to close the shell side directly rather than depend on
 * `frame-src` never being relaxed.
 *
 * Every response that is NOT a `/p/**` prototype response should carry it —
 * the dashboard, every API route, every sign-in route. The `/p/**` CSP is
 * the serve router's own (`frame-ancestors 'self'` in path mode, or the
 * shell's origin in subdomain mode) and must stay the only CSP on a
 * prototype response.
 */
import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import type { AssetStore, StoredAsset } from "../assets/types"
import { loadConfig } from "../config"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { createApp } from "./test-app"
import { createSwappableApp } from "./swappable-app"
import { tmpViewerDataDir } from "./test-config"
import { testGithubRuntime } from "./test-github-runtime"

function assetsWith(files: Record<string, StoredAsset>): AssetStore {
  return {
    async put() {},
    async get(_deploymentId, relPath) {
      return files[relPath] ?? null
    },
    async deleteDeployment() {},
  }
}

describe("shell frame-ancestors 'none'", () => {
  let storage: InMemoryStorage
  const stable = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    // Mirrors `server/index.ts`'s real mount shape: the Next.js handler is
    // OUTSIDE `createApp` and mounted last. `createApp` alone has nothing
    // registered for `GET /`, and Express's own `finalhandler` sets ITS OWN
    // `Content-Security-Policy: default-src 'none'` on the default 404 page
    // it generates — which would silently overwrite this middleware's
    // header and make the test pass or fail for the wrong reason. A stub
    // "Next" handler (200, no CSP of its own) is what a real shell page
    // response looks like, so this is what proves the header set upstream
    // actually reaches it.
    const withStubNext = express()
    withStubNext.use(
      createApp({
        storage,
        assets: assetsWith({
          "index.html": { body: Buffer.from("<!doctype html><h1>hi</h1>"), contentType: "text/html" },
        }),
        config: loadConfig({ VIEWER_PUBLIC_URL: "http://localhost:3100", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        bridgeVersion: "test-1",
        github: testGithubRuntime(),
      }),
    )
    withStubNext.use((_req, res) => res.status(200).send("shell page"))
    stable.use(withStubNext)
  })

  it("carries frame-ancestors 'none' on a shell page path (the dashboard)", async () => {
    const res = await request(stable.app).get("/")
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
  })

  it("carries frame-ancestors 'none' on an API response", async () => {
    const res = await request(stable.app).get("/api/v1/health").expect(200)
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
  })

  // The negative case matters as much as the two positives: a `/p/**`
  // response must keep the serve router's OWN CSP (`frame-ancestors 'self'`
  // in path mode today), never this middleware's stricter one — a prototype
  // reviewed through a same-origin `<iframe>` in path mode would otherwise
  // be unable to render inside its own review page.
  it("does NOT carry frame-ancestors 'none' on a /p/** prototype response", async () => {
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const deployment = await storage.createDeployment({ projectId: project.id })
    await storage.updateProject(project.id, { activeDeploymentId: deployment.id })

    const res = await request(stable.app).get("/p/acme/").expect(200)
    const csp = res.headers["content-security-policy"]
    expect(csp).toBeDefined()
    expect(csp).not.toContain("frame-ancestors 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
  })
})

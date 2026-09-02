import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { AssetStore, StoredAsset } from "../../assets/types"
import type { ViewerConfig } from "../../config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"

class NullAssetStore implements AssetStore {
  async put(): Promise<void> {}
  async get(): Promise<StoredAsset | null> {
    return null
  }
  async deleteDeployment(): Promise<void> {}
}

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

/** Storage whose every method rejects with a plain Error — no statusCode/status. */
class FaultyStorage extends InMemoryStorage {
  override async listProjects(): ReturnType<InMemoryStorage["listProjects"]> {
    throw new Error("simulated database outage")
  }
}

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * 4 listening servers per run before this. The one test building a second app
 * (`faulty`) uses only that app.
 */
const stable = createSwappableApp()

function setup(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    storage: new InMemoryStorage(),
    assets: new NullAssetStore(),
    config,
    bridgeScript: "// bridge",
    github: testGithubRuntime(),
    ...overrides,
  }
  stable.use(createApp(deps))
  return { deps, app: stable.app }
}

describe("createApp error handling", () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it("returns 400 (not 500) for a malformed JSON body", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .set("Content-Type", "application/json")
      .send('{"slug": "acme", "name": }')
      .expect(400)

    expect(res.body.error).toBeTruthy()
    expect(res.body.error).not.toMatch(/internal server error/i)
  })

  it("still returns the generic message (not the raw error) on a genuine 5xx fault", async () => {
    const faulty = setup({ storage: new FaultyStorage() })
    const res = await request(faulty.app).get("/api/v1/projects").expect(500)
    expect(res.body).toEqual({ error: "Internal server error" })
  })

  it("returns a JSON 404 for an unknown /api/v1/* path", async () => {
    const res = await request(ctx.app).get("/api/v1/does-not-exist").expect(404)
    expect(res.headers["content-type"]).toMatch(/json/)
    expect(res.body.error).toBeTruthy()
  })

  it("returns a JSON 404 for an unknown method on a known /api/v1 path", async () => {
    const res = await request(ctx.app).delete("/api/v1/health").expect(404)
    expect(res.headers["content-type"]).toMatch(/json/)
  })
})

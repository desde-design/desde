/**
 * GitHub push-webhook route.
 *
 * The signature check is the ENTIRE security boundary here — GitHub is not a
 * user, carries no session and no PAT, and the request is accepted on
 * cryptographic evidence alone. Everything downstream (which project, which
 * branch, whether to build) is derived from a payload already proven genuine.
 */
import { createHmac, generateKeyPairSync } from "node:crypto"
import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import type { AssetStore } from "../../assets/types"
import { loadConfig } from "../../config"
import { createApp } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * The `app()` factory below is called once per test (twice in a few), and the
 * build-log-stream describe builds two more: 22 listening servers per run.
 *
 * Declared at MODULE scope deliberately: "build log stream" is a SIBLING
 * describe, not a nested one, so a declaration inside the first describe is
 * out of scope there.
 *
 * Safe to share: the tests calling `app()` more than once await each request
 * before building the next, and no test uses an earlier app after a later one
 * exists.
 */
const stable = createSwappableApp()
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { BuildQueue } from "../../build/build-queue"
import { branchFromRef } from "../webhook-routes"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

const SECRET = "webhook-secret-value"

function configWith(secret?: string) {
  return loadConfig({
    VIEWER_PUBLIC_URL: "http://localhost:3100",
    VIEWER_GITHUB_APP_ID: "123",
    VIEWER_GITHUB_APP_SLUG: "test-app",
    // A real RSA key isn't needed to exercise the webhook, but config parses
    // the PEM at boot, so it has to be a genuine one.
    VIEWER_GITHUB_APP_PRIVATE_KEY: Buffer.from(TEST_PEM).toString("base64"),
    ...(secret ? { VIEWER_GITHUB_APP_WEBHOOK_SECRET: secret } : {}),
    VIEWER_DATA_DIR: tmpViewerDataDir(),
  })
}

const TEST_PEM = (() => {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey as string
})()

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`
}

function pushPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: "a".repeat(40),
    repository: { full_name: "acme/widget" },
    ...over,
  })
}

describe("GitHub push webhook (Phase 3c-3)", () => {
  let storage: InMemoryStorage
  let started: Array<{ projectId: string; commitSha: string | null }>
  let queue: BuildQueue

  beforeEach(() => {
    storage = new InMemoryStorage()
    started = []
    queue = {
      async start(projectId, commitSha) {
        started.push({ projectId, commitSha: commitSha ?? null })
        return `dep-${started.length}`
      },
      activeDeploymentFor: () => undefined,
      async shutdown() {},
    }
  })

  // NOT a defaulted parameter: `app(undefined)` would trigger the default
  // and silently test the CONFIGURED path — a passing test asserting the
  // opposite of its own name.
  function app(secret: string | null = SECRET) {
    const config = configWith(secret ?? undefined)
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config,
        bridgeScript: "// bridge",
        // The SAME config object the app gets: `webhook-routes.ts` reads the
        // webhook secret off `deps.github.config`, not the boot snapshot, so a
        // runtime built from a different config would 503 every delivery.
        github: testGithubRuntime({ config, overrides: { buildQueue: queue } }),
      }),
    )
    return stable.app
  }

  async function seedProject(over: Record<string, unknown> = {}) {
    const p = await storage.createProject({ slug: `s${Math.random().toString(36).slice(2, 8)}`, name: "S" })
    await storage.setProjectRepoConfig(p.id, {
      installationId: 1,
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: true,
      ...over,
    })
    return p
  }

  function post(built: express.Express, body: string, headers: Record<string, string>) {
    return request(built)
      .post("/api/v1/webhooks/github")
      .set("Content-Type", "application/json")
      .set(headers)
      .send(body)
  }

  /**
   * The regression that motivated this test existing at all: `express.json()`
   * is mounted at /api/v1 and consumes the stream before any route runs, so a
   * `raw()` parser on the route sees an already-parsed object. Verification
   * has to use the bytes captured by json's `verify` hook. Get this wrong and
   * EVERY delivery 401s — a total, silent failure of auto-deploy.
   */
  it("verifies against the exact bytes GitHub sent", async () => {
    const project = await seedProject()
    const body = pushPayload()
    await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) }).expect(200)
    expect(started).toEqual([{ projectId: project.id, commitSha: "a".repeat(40) }])
  })

  it("rejects a bad signature", async () => {
    await seedProject()
    const body = pushPayload()
    const res = await post(app(), body, {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(body, "wrong-secret"),
    })
    expect(res.status).toBe(401)
    expect(started).toEqual([])
  })

  it("rejects a missing signature", async () => {
    await seedProject()
    const res = await post(app(), pushPayload(), { "X-GitHub-Event": "push" })
    expect(res.status).toBe(401)
    expect(started).toEqual([])
  })

  /**
   * A signature over DIFFERENT bytes than the body — the exact failure a
   * re-serialize-and-hash implementation would let through if the payload
   * happened to round-trip, and the exact attack if it didn't.
   */
  it("rejects a signature computed over a different payload", async () => {
    await seedProject()
    const res = await post(app(), pushPayload(), {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(pushPayload({ after: "b".repeat(40) })),
    })
    expect(res.status).toBe(401)
    expect(started).toEqual([])
  })

  it("503s when no webhook secret is configured, rather than accepting unverified input", async () => {
    await seedProject()
    const body = pushPayload()
    const res = await post(app(null), body, {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(body),
    })
    expect(res.status).toBe(503)
    expect(started).toEqual([])
  })

  it("acknowledges ping and unhandled events without building", async () => {
    await seedProject()
    const body = pushPayload()
    const sig = { "X-Hub-Signature-256": sign(body) }
    await post(app(), body, { "X-GitHub-Event": "ping", ...sig }).expect(200)
    await post(app(), body, { "X-GitHub-Event": "issues", ...sig }).expect(200)
    expect(started).toEqual([])
  })

  it("ignores a tag push and a branch deletion", async () => {
    await seedProject()
    const tag = pushPayload({ ref: "refs/tags/v1" })
    await post(app(), tag, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(tag) }).expect(200)
    // A branch delete arrives as a push whose `after` is all zeroes; building
    // it would clone a ref that no longer exists.
    const del = pushPayload({ after: "0".repeat(40) })
    await post(app(), del, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(del) }).expect(200)
    expect(started).toEqual([])
  })

  it("does not build a project whose configured branch differs", async () => {
    await seedProject({ branch: "develop" })
    const body = pushPayload()
    await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) }).expect(200)
    expect(started).toEqual([])
  })

  it("does not build a project with autoDeploy off", async () => {
    await seedProject({ autoDeploy: false })
    const body = pushPayload()
    await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) }).expect(200)
    expect(started).toEqual([])
  })

  it("matches the repository case-insensitively", async () => {
    const project = await seedProject({ owner: "ACME", name: "Widget" })
    const body = pushPayload()
    await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) }).expect(200)
    expect(started.map((s) => s.projectId)).toEqual([project.id])
  })

  it("builds every project wired to the same repo and branch", async () => {
    const a = await seedProject()
    const b = await seedProject()
    const body = pushPayload()
    const res = await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) })
    expect(res.body).toMatchObject({ matched: 2, started: 2 })
    expect(started.map((s) => s.projectId).sort()).toEqual([a.id, b.id].sort())
  })

  /**
   * A 5xx makes GitHub retry the delivery, which would hammer a project that
   * is already mid-build. The in-flight build produces the same tip anyway.
   */
  it("still 200s when a build cannot start", async () => {
    await seedProject()
    queue.start = async () => {
      throw new Error("already building")
    }
    const body = pushPayload()
    const res = await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ matched: 1, started: 0 })
  })

  it("200s when no project matches, so GitHub does not show a failed delivery", async () => {
    const body = pushPayload()
    const res = await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ matched: 0 })
  })

  /**
   * K05 — a signed delivery replayed with the SAME `X-GitHub-Delivery` id
   * must not start a second build. Distinct from GitHub's own genuine retry
   * of a failed delivery (which reuses the id on purpose and is exactly what
   * this makes idempotent) versus an attacker resending a captured payload.
   */
  it("ignores a duplicate X-GitHub-Delivery id instead of building again", async () => {
    // Dedup state lives on the router instance (see `createWebhookRoutes`'s
    // comment on why it's scoped there, not module-level) — both requests
    // MUST hit the SAME app, unlike most other tests here which don't care.
    const built = app()
    const project = await seedProject()
    const body = pushPayload()
    const headers = {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sign(body),
      "X-GitHub-Delivery": "11111111-1111-1111-1111-111111111111",
    }

    const first = await post(built, body, headers)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ matched: 1, started: 1 })
    expect(started).toEqual([{ projectId: project.id, commitSha: "a".repeat(40) }])

    const replay = await post(built, body, headers)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ ok: true, ignored: "duplicate delivery" })
    // No second build — `started` did not grow.
    expect(started).toHaveLength(1)
  })

  it("does NOT dedup two different delivery ids for the same payload", async () => {
    const built = app()
    await seedProject()
    const body = pushPayload()
    const sig = sign(body)
    await post(built, body, {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    }).expect(200)
    await post(built, body, {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Delivery": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    }).expect(200)
    expect(started).toHaveLength(2)
  })

  it("ignores a push whose repository.pushed_at is far in the past (K05 staleness)", async () => {
    await seedProject()
    const stale = pushPayload({
      // 2 days old — over the 24h `MAX_PAYLOAD_AGE_MS` window.
      repository: { full_name: "acme/widget", pushed_at: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60 },
    })
    const res = await post(app(), stale, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(stale) })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, ignored: "stale delivery" })
    expect(started).toEqual([])
  })

  it("builds a push whose repository.pushed_at is recent", async () => {
    const project = await seedProject()
    const fresh = pushPayload({
      repository: { full_name: "acme/widget", pushed_at: Math.floor(Date.now() / 1000) - 5 },
    })
    const res = await post(app(), fresh, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(fresh) })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ matched: 1, started: 1 })
    expect(started.map((s) => s.projectId)).toEqual([project.id])
  })

  /**
   * K01 — the fan-out loop stops calling `buildQueue.start()` once global
   * capacity is exhausted, rather than trying (and failing) every remaining
   * matched project one at a time.
   */
  it("stops the fan-out once the build queue reports it is full (K01)", async () => {
    const { BuildQueueFullError: RealBuildQueueFullError } = await import("../../build/build-queue")
    await seedProject()
    await seedProject()
    await seedProject()
    let calls = 0
    queue.start = async (projectId, commitSha) => {
      calls += 1
      if (calls === 2) throw new RealBuildQueueFullError()
      started.push({ projectId, commitSha: commitSha ?? null })
      return `dep-${calls}`
    }
    const body = pushPayload()
    const res = await post(app(), body, { "X-GitHub-Event": "push", "X-Hub-Signature-256": sign(body) })
    expect(res.status).toBe(200)
    // 3 matched, but the loop stopped after the 2nd call hit capacity —
    // the 3rd project was never even attempted.
    expect(res.body.matched).toBe(3)
    expect(calls).toBe(2)
    expect(started).toHaveLength(1)
  })

  describe("branchFromRef", () => {
    it("extracts a branch and rejects everything else", () => {
      expect(branchFromRef("refs/heads/main")).toBe("main")
      expect(branchFromRef("refs/heads/release/v1.2")).toBe("release/v1.2")
      expect(branchFromRef("refs/tags/v1")).toBeNull()
      expect(branchFromRef("refs/heads/")).toBeNull()
      expect(branchFromRef(undefined)).toBeNull()
      expect(branchFromRef(42)).toBeNull()
    })
  })
})

/**
 * Build-log SSE. The delta protocol is the point: re-sending the whole log
 * on every tick makes a long build quadratic over the wire and forces the
 * client to diff it to render an append.
 */
describe("build log stream (Phase 3c-3)", () => {
  it("streams only new bytes, then a terminal done event", async () => {
    const { createBuildChangeBus } = await import("../../build/build-change-bus")
    const storage = new InMemoryStorage()
    const bus = createBuildChangeBus()
    const project = await storage.createProject({ slug: "logstream", name: "L" })
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.appendDeploymentLog(dep.id, "first\n", 10_000)

    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        // S7 raised the log stream's gate from project-read to owner/admin —
        // the admin bearer is the simplest way for this test (which is about
        // the SSE delta protocol, not authorization) to clear it.
        config: loadConfig({
          VIEWER_PUBLIC_URL: "http://localhost:3100",
          VIEWER_ADMIN_TOKEN: "admin-secret",
          VIEWER_DATA_DIR: tmpViewerDataDir(),
        }),
        bridgeScript: "// bridge",
        buildChangeBus: bus,
        github: testGithubRuntime(),
      }),
    )
    const built = stable.app

    const chunks: string[] = []
    await new Promise<void>((resolve, reject) => {
      const req = request(built)
        .get(`/api/v1/deployments/${dep.id}/log/stream`)
        .set("Authorization", "Bearer admin-secret")
        .buffer(false)
        .parse((res, done) => {
          res.on("data", (d: Buffer) => {
            chunks.push(d.toString("utf8"))
            const joined = chunks.join("")
            if (joined.includes("event: done")) {
              req.abort()
              resolve()
            }
          })
          res.on("end", () => done(null, null))
          res.on("error", () => done(null, null))
        })
        .end(() => {})
      setTimeout(async () => {
        await storage.appendDeploymentLog(dep.id, "second\n", 10_000)
        bus.emit(dep.id)
        await storage.updateDeployment(dep.id, { status: "deployed" })
        bus.emit(dep.id)
      }, 60)
      setTimeout(() => reject(new Error("timed out waiting for done")), 5_000)
    })

    const all = chunks.join("")
    expect(all).toContain("first")
    expect(all).toContain("second")
    expect(all).toContain("event: done")
    // "first" is sent once, in the initial catch-up — not re-sent alongside
    // "second" on the next emit.
    expect(all.match(/first/g)?.length).toBe(1)
  }, 10_000)

  it("404s a deployment on a project the caller cannot read", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "hidden", name: "H", access: "invited" })
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "owner",
      email: "o@x.com",
      displayName: "O",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const dep = await storage.createDeployment({ projectId: project.id })

    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_PUBLIC_URL: "http://localhost:3100", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    const built = stable.app
    // A build log can carry repo output, so it must never be more readable
    // than the project it belongs to.
    const res = await request(built).get(`/api/v1/deployments/${dep.id}/log/stream`)
    expect(res.status).toBe(404)
  })
})

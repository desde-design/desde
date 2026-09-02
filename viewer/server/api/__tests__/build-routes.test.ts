/**
 * `build-routes.ts`: the manual "trigger a build" route and the build-log
 * SSE stream. Previously untested at this layer (only exercised indirectly
 * through the runner/queue suites) — added alongside K01 (global build
 * concurrency) and S7 (build-log read gate raised to owner/admin).
 */
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import type { AssetStore, StoredAsset } from "../../assets/types"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { isSecurePublicUrl } from "../state-cookie"
import { generateMachineToken } from "../../auth/machine-token"
import { BuildInProgressError, BuildQueueFullError } from "../../build/build-queue"
import type { BuildQueue } from "../../build/build-queue"
import type { ViewerConfig } from "../../config"
import { createApp } from "../../__tests__/test-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { InstanceRole } from "../../storage/types"

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * 6 listening servers per run before this. Module scope, because the two
 * describes below are siblings. Every test uses exactly one app.
 */
const stable = createSwappableApp()

class NullAssetStore implements AssetStore {
  async put(): Promise<void> {}
  async get(): Promise<StoredAsset | null> {
    return null
  }
  async deleteDeployment(): Promise<void> {}
}

const authConfig: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  dataDir: ".tmp",
  publicUrl: "https://viewer.example.com",
  adminToken: "admin-secret",
  serveDomain: null,
  devBundler: "turbopack",
  email: null,
  emailSource: null,
  unsubscribeSecret: null,
  sessionSecret: "sesh-secret",
  githubAuth: { clientId: "id", clientSecret: "secret" },
  githubApp: null,
  prototypeCsp: null,
  prototypeOrigin: null,
  allowedEmailDomains: null,
  seedDemoProject: true,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
}

const admin = { Authorization: "Bearer admin-secret" }

async function signInAs(storage: InMemoryStorage, email: string, role: InstanceRole = "editor") {
  const user = await upsertTestUser(storage, {
    provider: "github",
    providerUserId: email,
    email,
    displayName: email,
    avatarUrl: "",
    role,
  })
  const session = await storage.createSession({
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  // https config → the live session cookie name carries the __Host- prefix.
  const name = sessionCookieName(isSecurePublicUrl(authConfig.publicUrl))
  const cookie = `${name}=${signSessionId(authConfig.sessionSecret, session.id)}`
  return { user, cookie }
}

/** Mints a live PAT for `userId` and returns its `Authorization` header value. */
async function patFor(
  storage: InMemoryStorage,
  userId: string,
  scopes: ("read" | "write")[],
): Promise<string> {
  const gen = generateMachineToken()
  await storage.createMachineToken({
    id: gen.id,
    userId,
    name: "t",
    scopes,
    tokenHash: gen.tokenHash,
    expiresAt: null,
  })
  return `Bearer ${gen.token}`
}

async function makeMembersProject(storage: InMemoryStorage) {
  // "invited" is what the old "members visibility with at least one member"
  // became. It has to be `invited` for the anonymous-caller-gets-404 test
  // below to exercise the read gate — under Authorization v2 an anonymous
  // caller 404s on `all-members` too, but for the caller's sake this fixture
  // says what it means.
  const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
  const owner = await signInAs(storage, "owner@x.com")
  await storage.addProjectMember({ projectId: project.id, userId: owner.user.id })
  const member = await signInAs(storage, "member@x.com")
  await storage.addProjectMember({ projectId: project.id, userId: member.user.id })
  return { project, owner, member }
}

describe("POST /projects/:id/deployments/build", () => {
  it("503s with a clear message when the global build queue is full (K01)", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p1", name: "P" })
    await storage.setProjectRepoConfig(project.id, {
      installationId: 1,
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: false,
    })
    const buildQueue: BuildQueue = {
      async start() {
        throw new BuildQueueFullError()
      },
      activeDeploymentFor: () => undefined,
      async shutdown() {},
    }
    stable.use(
      createApp({
        storage,
        assets: new NullAssetStore(),
        config: { ...authConfig, githubAuth: null },
        bridgeScript: "// bridge",
        github: testGithubRuntime({ overrides: { buildQueue } }),
      }),
    )
    const app = stable.app

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/deployments/build`)
      .set(admin)
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/no more than \d+ builds/i)
  })

  it("409s with the in-flight deploymentId on a same-project conflict (unchanged by K01)", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p2", name: "P" })
    await storage.setProjectRepoConfig(project.id, {
      installationId: 1,
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: false,
    })
    const buildQueue: BuildQueue = {
      async start() {
        throw new BuildInProgressError("dep-123")
      },
      activeDeploymentFor: () => undefined,
      async shutdown() {},
    }
    stable.use(
      createApp({
        storage,
        assets: new NullAssetStore(),
        config: { ...authConfig, githubAuth: null },
        bridgeScript: "// bridge",
        github: testGithubRuntime({ overrides: { buildQueue } }),
      }),
    )
    const app = stable.app

    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/deployments/build`)
      .set(admin)
    expect(res.status).toBe(409)
    expect(res.body.deploymentId).toBe("dep-123")
  })
})

describe("GET /deployments/:id/log/stream (S7 — manage authority only)", () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = new InMemoryStorage()
  })

  function app() {
    stable.use(
      createApp({
        storage,
        assets: new NullAssetStore(),
        config: authConfig,
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    return stable.app
  }

  it("404s an anonymous caller, same as an unreadable project", async () => {
    const { project } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "secret log\n" })

    const res = await request(app()).get(`/api/v1/deployments/${dep.id}/log/stream`)
    expect(res.status).toBe(404)
  })

  // Under Authorization v2 the log stream is `requireProjectManageRead`: the
  // caller must be able to READ the project (this one is `invited`, so a
  // membership row is what gets them in) AND hold a managing instance role.
  // No write scope — see the read-PAT test further down for why.
  // `signInAs` defaults to `editor`, so this member has both.
  it("succeeds for any signed-in EDITOR on the access list, owner or not", async () => {
    const { project, member } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "member-visible log\n" })

    const res = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Cookie", member.cookie)
    expect(res.status).toBe(200)
    expect(res.text).toContain("member-visible log")
  })

  // Authorization v2 MOVED this boundary from membership to instance role.
  // A signed-in VIEWER can read the project and is still refused the log,
  // while an EDITOR holding no membership row at all is admitted — the log
  // carries the install/build command line, which is a manager's concern.
  it("403s a signed-in VIEWER on a project they can read; an EDITOR with no membership row streams it", async () => {
    const project = await storage.createProject({ slug: "open", name: "Open" })
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "secret log\n" })
    const { cookie: viewerCookie } = await signInAs(storage, "reader@x.com", "viewer")
    const { cookie: editorCookie } = await signInAs(storage, "stranger@x.com", "editor")

    const refused = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Cookie", viewerCookie)
    expect(refused.status).toBe(403)

    const streamed = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Cookie", editorCookie)
    expect(streamed.status).toBe(200)
    expect(streamed.text).toContain("secret log")
  })

  /**
   * The scope half of the gate, and the reason this route uses
   * `requireProjectManageRead` rather than `requireProjectManage`.
   *
   * `GET /projects/:id/deployments` embeds the identical bytes as
   * `Deployment.buildLog` and is scope-blind, like every read path. While
   * this stream required `write` scope the two disagreed: a read-scoped PAT
   * was refused here and handed the same log there, so this gate gated
   * nothing. Both must admit exactly the same callers.
   *
   * The role check is unaffected — a viewer's PAT is still refused however it
   * is scoped, which is what stops "drop the scope check" from becoming
   * "drop the gate".
   */
  it("streams for an EDITOR's READ-scoped PAT — scope follows the verb, and this route mutates nothing", async () => {
    const { project, member } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "pat-visible log\n" })
    const editorPat = await patFor(storage, member.user.id, ["read"])

    const streamed = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Authorization", editorPat)
    expect(streamed.status).toBe(200)
    expect(streamed.text).toContain("pat-visible log")

    // The SAME caller, the SAME credential, against the list route that
    // serves the same bytes: both must admit them, or neither gates anything.
    const listed = await request(app())
      .get(`/api/v1/projects/${project.id}/deployments`)
      .set("Authorization", editorPat)
    expect(listed.status).toBe(200)
    expect(listed.body.deployments[0].buildLog).toContain("pat-visible log")
  })

  it("still refuses a VIEWER's write-scoped PAT — dropping the scope check did not drop the role check", async () => {
    const { project } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "secret log\n" })
    const reader = await signInAs(storage, "reader@x.com", "viewer")
    await storage.addProjectMember({ projectId: project.id, userId: reader.user.id })
    const readerPat = await patFor(storage, reader.user.id, ["read", "write"])

    const refused = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Authorization", readerPat)
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: "Only editors and admins may view the build log" })
  })

  it("streams for the project OWNER", async () => {
    const { project, owner } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    // Already terminal (not "building") — `send()`'s first tick writes the
    // `done` event and ends the response immediately, so a plain request
    // resolves instead of hanging on an open SSE connection.
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "owner-visible log\n" })

    const res = await request(app())
      .get(`/api/v1/deployments/${dep.id}/log/stream`)
      .set("Cookie", owner.cookie)
    expect(res.status).toBe(200)
    expect(res.text).toContain("owner-visible log")
    expect(res.text).toContain("event: done")
  })

  it("streams for the admin bearer", async () => {
    const { project } = await makeMembersProject(storage)
    const dep = await storage.createDeployment({ projectId: project.id })
    await storage.updateDeployment(dep.id, { status: "deployed", buildLog: "admin-visible log\n" })

    const res = await request(app()).get(`/api/v1/deployments/${dep.id}/log/stream`).set(admin)
    expect(res.status).toBe(200)
    expect(res.text).toContain("admin-visible log")
  })
})

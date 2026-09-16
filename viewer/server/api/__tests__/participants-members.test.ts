import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { signSessionId } from "../../auth/session-cookie"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const stable = createSwappableApp()

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

const SESSION_SECRET = "sesh-secret"

function authedConfig() {
  return loadConfig({
    VIEWER_ADMIN_TOKEN: "secret",
    VIEWER_GITHUB_CLIENT_ID: "client-id",
    VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    VIEWER_SESSION_SECRET: SESSION_SECRET,
    VIEWER_PUBLIC_URL: "http://localhost:3100",
    VIEWER_DATA_DIR: tmpViewerDataDir(),
  })
}

describe("mention directory includes instance members", () => {
  let storage: InMemoryStorage
  let app: express.Express

  beforeEach(async () => {
    storage = new InMemoryStorage()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: authedConfig(),
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
  })

  async function seedMembers() {
    const mo = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "mo",
      email: "mo@desde.design",
      displayName: "Mo",
      avatarUrl: "",
      role: "admin",
    })
    const designer = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "designer",
      email: "designer@desde.design",
      displayName: "desdedesigner",
      avatarUrl: "",
      role: "editor",
    })
    return { mo, designer }
  }

  async function sessionFor(userId: string) {
    const session = await storage.createSession({
      userId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    return `viewer_session=${signSessionId(SESSION_SECRET, session.id)}`
  }

  it("offers both instance members on an all-members project, before anyone has commented", async () => {
    const { mo } = await seedMembers()
    const project = await storage.createProject({
      slug: "northwind",
      name: "Northwind",
      repoUrl: null,
      access: "all-members",
    })

    const listed = await request(app)
      .get(`/api/v1/projects/${project.id}/participants`)
      .set("Cookie", await sessionFor(mo.id))

    expect(listed.status).toBe(200)
    const names = (listed.body.participants as { displayName: string }[]).map((p) => p.displayName).sort()
    expect(names).toEqual(["Mo", "desdedesigner"])
  })

  it("stores a mention of a member who has no participant row, and notifies them", async () => {
    const { mo, designer } = await seedMembers()
    const project = await storage.createProject({
      slug: "northwind",
      name: "Northwind",
      repoUrl: null,
      access: "all-members",
    })
    const cookie = await sessionFor(mo.id)

    const directory = (
      await request(app).get(`/api/v1/projects/${project.id}/participants`).set("Cookie", cookie)
    ).body.participants as { id: string; displayName: string }[]
    const target = directory.find((p) => p.displayName === "desdedesigner")!
    expect(target.id).toBe(`user:${designer.id}`)

    const posted = await request(app)
      .post(`/api/v1/projects/${project.id}/comments`)
      .set("Cookie", cookie)
      .send({
        position: { anchorSelector: "#x", page: "/" },
        body: `@[desdedesigner](${target.id}) take a look`,
        mentions: [target.id],
      })
    expect(posted.status).toBe(201)

    // The synthetic id is swapped for a REAL participant id on the way in —
    // everything downstream keys on participant ids.
    expect(posted.body.mentions).toHaveLength(1)
    expect(posted.body.mentions[0]).not.toContain("user:")

    const materialized = (await storage.listParticipants(project.id)).find(
      (p) => p.email === "designer@desde.design",
    )
    expect(materialized?.id).toBe(posted.body.mentions[0])

    const queued = await storage.listPendingNotifications(50)
    expect(queued.flatMap((n) => n.recipientIds)).toEqual([materialized!.id])
  })

  it("drops a member mention from an ANONYMOUS caller on a public-link project", async () => {
    const { designer } = await seedMembers()
    const project = await storage.createProject({
      slug: "open",
      name: "Open",
      repoUrl: null,
      access: "public-link",
    })

    const posted = await request(app)
      .post(`/api/v1/projects/${project.id}/comments`)
      .send({
        position: { anchorSelector: "#x", page: "/" },
        body: "hello",
        mentions: [`user:${designer.id}`],
        author: { uid: "viewer:anon", displayName: "Anon", email: "anon@x.com", photoURL: "" },
      })

    expect(posted.status).toBe(201)
    // An anonymous reviewer is never handed the instance roster, so they
    // cannot use it to aim the operator's SMTP identity at a member who has
    // nothing to do with this project (security audit B5).
    expect(posted.body.mentions).toEqual([])
    expect(await storage.listPendingNotifications(50)).toEqual([])
  })

  it("drops a member mention once that account is removed", async () => {
    const { mo, designer } = await seedMembers()
    const project = await storage.createProject({
      slug: "northwind",
      name: "Northwind",
      repoUrl: null,
      access: "all-members",
    })
    await storage.setUserStatus(designer.id, "removed")

    const posted = await request(app)
      .post(`/api/v1/projects/${project.id}/comments`)
      .set("Cookie", await sessionFor(mo.id))
      .send({
        position: { anchorSelector: "#x", page: "/" },
        body: "hi",
        mentions: [`user:${designer.id}`],
      })

    expect(posted.status).toBe(201)
    expect(posted.body.mentions).toEqual([])
  })

  it("does not list a member twice once they have commented", async () => {
    const { mo } = await seedMembers()
    const project = await storage.createProject({
      slug: "northwind",
      name: "Northwind",
      repoUrl: null,
      access: "all-members",
    })
    const cookie = await sessionFor(mo.id)

    await request(app)
      .post(`/api/v1/projects/${project.id}/comments`)
      .set("Cookie", cookie)
      .send({ position: { anchorSelector: "#x", page: "/" }, body: "first" })

    const listed = await request(app)
      .get(`/api/v1/projects/${project.id}/participants`)
      .set("Cookie", cookie)
    const rows = listed.body.participants as { id: string; displayName: string }[]
    expect(rows.filter((p) => p.displayName === "Mo")).toHaveLength(1)
    // …and it is the REAL row, not the synthetic one.
    expect(rows.find((p) => p.displayName === "Mo")!.id).not.toContain("user:")
  })

  it("offers only the access list on an invited project", async () => {
    const { mo } = await seedMembers()
    const project = await storage.createProject({
      slug: "locked",
      name: "Locked",
      repoUrl: null,
      access: "invited",
    })
    await storage.addProjectMember({ projectId: project.id, userId: mo.id })

    const listed = await request(app)
      .get(`/api/v1/projects/${project.id}/participants`)
      .set("Cookie", await sessionFor(mo.id))

    const names = (listed.body.participants as { displayName: string }[]).map((p) => p.displayName)
    // `desdedesigner` is an instance member but cannot read this project, so
    // mentioning them here would notify someone who cannot open the link.
    expect(names).toEqual(["Mo"])
  })
})

/**
 * The security matrix for Authorization v2 (viewer-membership Task 10).
 *
 * Every other authorization test in this repo pins ONE guard against ONE
 * route. This file pins the PRODUCT rule end to end, over the real Express
 * app, for each caller class the membership model defines: anonymous, the
 * three instance roles, the shared adminToken bearer, and a scoped PAT.
 *
 * It exists because the v2 rule is a matrix, not a list of clauses — "an
 * editor may manage an all-members project but 404s on an invited one they
 * are not listed on" is a statement about two axes at once, and a
 * per-guard unit test cannot express it. When this file and a unit test
 * disagree, this file is the specification.
 */

import request from "supertest"
import { describe, expect, it } from "vitest"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { AssetStore, StoredAsset } from "../../assets/types"
import type { ViewerConfig } from "../../config"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { isSecurePublicUrl } from "../state-cookie"
import { generateMachineToken } from "../../auth/machine-token"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { InstanceRole, Project, StorageAdapter, User } from "../../storage/types"

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
  adminToken: "admin-bearer-token",
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

const stable = createSwappableApp()

const ADMIN_BEARER = { Authorization: "Bearer admin-bearer-token" }

interface Fixture {
  storage: StorageAdapter
  app: ReturnType<typeof createSwappableApp>["app"]
  /** Session cookie headers, one per seeded instance role. */
  as: Record<"admin" | "editor" | "viewer" | "outsider", { Cookie: string }>
  users: Record<"admin" | "editor" | "viewer" | "outsider", User>
  projects: Record<"publicLink" | "allMembers" | "invited", Project>
}

async function seedUser(storage: StorageAdapter, id: string, role: InstanceRole): Promise<User> {
  return upsertTestUser(storage, {
    provider: "github",
    providerUserId: id,
    email: `${id}@example.com`,
    displayName: id,
    avatarUrl: "",
    role,
  })
}

async function cookieFor(storage: StorageAdapter, userId: string): Promise<{ Cookie: string }> {
  const session = await storage.createSession({
    userId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  // https config → the live session cookie name carries the __Host- prefix.
  const name = sessionCookieName(isSecurePublicUrl(config.publicUrl))
  return { Cookie: `${name}=${signSessionId(config.sessionSecret, session.id)}` }
}

/** A live PAT for `userId`, as an `Authorization` header object. */
async function patFor(
  storage: StorageAdapter,
  userId: string,
  scopes: ("read" | "write")[],
): Promise<{ Authorization: string }> {
  const gen = generateMachineToken()
  await storage.createMachineToken({
    id: gen.id,
    userId,
    name: "t",
    scopes,
    tokenHash: gen.tokenHash,
    expiresAt: null,
  })
  return { Authorization: `Bearer ${gen.token}` }
}

/**
 * One instance, three projects (one per `access` value), four accounts.
 *
 * `invited`'s access list holds the VIEWER and the EDITOR — deliberately not
 * the outsider, so "listed" and "not listed" are both exercised at the same
 * instance role.
 */
async function setup(opts: { allowPublicLinks?: boolean } = {}): Promise<Fixture> {
  const storage = new InMemoryStorage()
  const deps: AppDeps = {
    storage,
    assets: new NullAssetStore(),
    config,
    bridgeScript: "// bridge",
    github: testGithubRuntime(),
  }
  stable.use(createApp(deps))

  const users = {
    admin: await seedUser(storage, "boss", "admin"),
    editor: await seedUser(storage, "ed", "editor"),
    viewer: await seedUser(storage, "vw", "viewer"),
    outsider: await seedUser(storage, "outsider", "editor"),
  }

  const projects = {
    publicLink: await storage.createProject({ slug: "pub", name: "Public", access: "public-link" }),
    allMembers: await storage.createProject({ slug: "all", name: "All", access: "all-members" }),
    invited: await storage.createProject({ slug: "inv", name: "Invited", access: "invited" }),
  }
  await storage.addProjectMember({ projectId: projects.invited.id, userId: users.viewer.id })
  await storage.addProjectMember({ projectId: projects.invited.id, userId: users.editor.id })

  if (opts.allowPublicLinks !== undefined) {
    await storage.setInstanceSetting("allowPublicLinks", String(opts.allowPublicLinks))
  }

  return {
    storage,
    app: stable.app,
    users,
    projects,
    as: {
      admin: await cookieFor(storage, users.admin.id),
      editor: await cookieFor(storage, users.editor.id),
      viewer: await cookieFor(storage, users.viewer.id),
      outsider: await cookieFor(storage, users.outsider.id),
    },
  }
}

// ---------------------------------------------------------------------------
// Anonymous
// ---------------------------------------------------------------------------

describe("matrix — anonymous", () => {
  it("reads a public-link project", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.publicLink.id}`)
    expect(res.status).toBe(200)
  })

  it("404s an all-members project — v2 requires sign-in, the world-readable rule is DELETED", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.allMembers.id}`)
    expect(res.status).toBe(404)
  })

  it("404s an all-members project and an invited project BYTE-IDENTICALLY to a nonexistent one", async () => {
    const f = await setup()
    const all = await request(f.app).get(`/api/v1/projects/${f.projects.allMembers.id}`)
    const invited = await request(f.app).get(`/api/v1/projects/${f.projects.invited.id}`)
    const missing = await request(f.app).get(`/api/v1/projects/does-not-exist`)

    expect(all.status).toBe(404)
    expect(invited.status).toBe(missing.status)
    expect(all.body).toEqual(missing.body)
    expect(invited.body).toEqual(missing.body)
  })

  it("sees ONLY the public-link project in the list", async () => {
    const f = await setup()
    const res = await request(f.app).get("/api/v1/projects")
    expect(res.status).toBe(200)
    expect(res.body.projects.map((p: { slug: string }) => p.slug)).toEqual(["pub"])
  })

  it("404s a public-link project when the kill switch is OFF — it behaves as all-members", async () => {
    const f = await setup({ allowPublicLinks: false })
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.publicLink.id}`)
    expect(res.status).toBe(404)
    const missing = await request(f.app).get(`/api/v1/projects/does-not-exist`)
    expect(res.body).toEqual(missing.body)
  })

  it("still reads a public-link project when the kill switch is explicitly ON", async () => {
    const f = await setup({ allowPublicLinks: true })
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.publicLink.id}`)
    expect(res.status).toBe(200)
  })

  it("cannot create a project", async () => {
    const f = await setup()
    const res = await request(f.app).post("/api/v1/projects").send({ slug: "new", name: "New" })
    expect(res.status).toBe(403)
  })

  it("cannot manage a public-link project it CAN read — 403, not 404 (existence already revealed)", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.publicLink.id}`)
      .send({ name: "Renamed" })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Viewer role
// ---------------------------------------------------------------------------

describe("matrix — viewer role", () => {
  it("reads an all-members project", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.allMembers.id}`).set(f.as.viewer)
    expect(res.status).toBe(200)
  })

  it("reads an invited project it IS listed on", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.invited.id}`).set(f.as.viewer)
    expect(res.status).toBe(200)
  })

  it("404s an invited project it is NOT listed on, byte-identically to a nonexistent id", async () => {
    const f = await setup()
    const other = await f.storage.createProject({ slug: "other", name: "Other", access: "invited" })
    const res = await request(f.app).get(`/api/v1/projects/${other.id}`).set(f.as.viewer)
    const missing = await request(f.app).get(`/api/v1/projects/does-not-exist`).set(f.as.viewer)
    expect(res.status).toBe(404)
    expect(res.status).toBe(missing.status)
    expect(res.body).toEqual(missing.body)
  })

  it("cannot POST /projects — 403", async () => {
    const f = await setup()
    const res = await request(f.app)
      .post("/api/v1/projects")
      .set(f.as.viewer)
      .send({ slug: "mine", name: "Mine" })
    expect(res.status).toBe(403)
  })

  it("cannot PATCH a project it can read — 403", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.allMembers.id}`)
      .set(f.as.viewer)
      .send({ name: "Renamed" })
    expect(res.status).toBe(403)
  })

  it("cannot DELETE a project's repo connection — 403", async () => {
    const f = await setup()
    const res = await request(f.app)
      .delete(`/api/v1/projects/${f.projects.allMembers.id}/repo`)
      .set(f.as.viewer)
    expect(res.status).toBe(403)
  })

  it("cannot add a project member — 403", async () => {
    const f = await setup()
    const res = await request(f.app)
      .post(`/api/v1/projects/${f.projects.invited.id}/members`)
      .set(f.as.viewer)
      .send({ email: "outsider@example.com" })
    expect(res.status).toBe(403)
  })

  it("CAN comment on a project it can read — the comment model is unchanged", async () => {
    const f = await setup()
    const res = await request(f.app)
      .post(`/api/v1/projects/${f.projects.allMembers.id}/comments`)
      .set(f.as.viewer)
      .send({ position: { page: "/", anchorSelector: "#a" }, body: "hello" })
    expect(res.status).toBe(201)
  })

  it("does NOT see the private half (repoConfig/embeddedId) of a project it can read", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.allMembers.id}`).set(f.as.viewer)
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty("repoConfig")
    expect(res.body).not.toHaveProperty("embeddedId")
  })
})

// ---------------------------------------------------------------------------
// Editor role
// ---------------------------------------------------------------------------

describe("matrix — editor role", () => {
  it("creates a project", async () => {
    const f = await setup()
    const res = await request(f.app)
      .post("/api/v1/projects")
      .set(f.as.editor)
      .send({ slug: "fresh", name: "Fresh" })
    expect(res.status).toBe(201)
  })

  it("manages an all-members project it holds NO membership row on", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.allMembers.id}`)
      .set(f.as.editor)
      .send({ name: "Renamed" })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe("Renamed")
  })

  it("manages a public-link project it holds no membership row on", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.publicLink.id}`)
      .set(f.as.editor)
      .send({ name: "Renamed" })
    expect(res.status).toBe(200)
  })

  it("manages an invited project it IS listed on", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(f.as.editor)
      .send({ name: "Renamed" })
    expect(res.status).toBe(200)
  })

  it("gets 404 — NOT 403 — on an invited project it is not listed on", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(f.as.outsider)
      .send({ name: "Renamed" })
    expect(res.status).toBe(404)

    const missing = await request(f.app)
      .patch(`/api/v1/projects/no-such-project`)
      .set(f.as.outsider)
      .send({ name: "Renamed" })
    expect(res.body).toEqual(missing.body)
  })

  it("adds a project member on a project it manages", async () => {
    const f = await setup()
    const res = await request(f.app)
      .post(`/api/v1/projects/${f.projects.allMembers.id}/members`)
      .set(f.as.editor)
      .send({ email: "outsider@example.com" })
    expect(res.status).toBe(201)
  })

  it("sees the private half of a project it manages", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.allMembers.id}`).set(f.as.editor)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty("repoConfig")
    expect(res.body).toHaveProperty("embeddedId")
  })
})

// ---------------------------------------------------------------------------
// Admin (role) and adminToken bearer
// ---------------------------------------------------------------------------

describe("matrix — admin role and adminToken", () => {
  it("the admin ROLE reads an invited project it is not listed on", async () => {
    const f = await setup()
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.invited.id}`).set(f.as.admin)
    expect(res.status).toBe(200)
  })

  it("the admin ROLE manages an invited project it is not listed on", async () => {
    const f = await setup()
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(f.as.admin)
      .send({ name: "Renamed" })
    expect(res.status).toBe(200)
  })

  it("the admin ROLE reads a public-link project even with the kill switch OFF", async () => {
    const f = await setup({ allowPublicLinks: false })
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.publicLink.id}`).set(f.as.admin)
    expect(res.status).toBe(200)
  })

  it("the admin ROLE sees every project in the list", async () => {
    const f = await setup()
    const res = await request(f.app).get("/api/v1/projects").set(f.as.admin)
    expect(res.body.projects.map((p: { slug: string }) => p.slug).sort()).toEqual(["all", "inv", "pub"])
  })

  it("the adminToken bearer reads and manages an invited project", async () => {
    const f = await setup()
    const read = await request(f.app).get(`/api/v1/projects/${f.projects.invited.id}`).set(ADMIN_BEARER)
    expect(read.status).toBe(200)
    const write = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(ADMIN_BEARER)
      .send({ name: "Renamed" })
    expect(write.status).toBe(200)
  })

  it("the adminToken bearer and the admin ROLE agree on member-email disclosure", async () => {
    const f = await setup()
    const viaToken = await request(f.app)
      .get(`/api/v1/projects/${f.projects.invited.id}/members`)
      .set(ADMIN_BEARER)
    const viaRole = await request(f.app)
      .get(`/api/v1/projects/${f.projects.invited.id}/members`)
      .set(f.as.admin)
    expect(viaToken.status).toBe(200)
    expect(viaRole.status).toBe(200)
    expect(viaRole.body.members.every((m: { email?: string }) => typeof m.email === "string")).toBe(true)
    expect(viaRole.body).toEqual(viaToken.body)
  })
})

// ---------------------------------------------------------------------------
// Machine tokens
// ---------------------------------------------------------------------------

describe("matrix — PATs", () => {
  it("a READ-scoped PAT of an admin reads an invited project", async () => {
    const f = await setup()
    const pat = await patFor(f.storage, f.users.admin.id, ["read"])
    const res = await request(f.app).get(`/api/v1/projects/${f.projects.invited.id}`).set(pat)
    expect(res.status).toBe(200)
  })

  it("a READ-scoped PAT of an admin CANNOT manage — write scope is still required", async () => {
    const f = await setup()
    const pat = await patFor(f.storage, f.users.admin.id, ["read"])
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(pat)
      .send({ name: "Renamed" })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "This action requires a write-scoped token" })
  })

  it("a WRITE-scoped PAT of an admin manages", async () => {
    const f = await setup()
    const pat = await patFor(f.storage, f.users.admin.id, ["read", "write"])
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.invited.id}`)
      .set(pat)
      .send({ name: "Renamed" })
    expect(res.status).toBe(200)
  })

  it("a WRITE-scoped PAT of a VIEWER cannot manage — a scope is not a role", async () => {
    const f = await setup()
    const pat = await patFor(f.storage, f.users.viewer.id, ["read", "write"])
    const res = await request(f.app)
      .patch(`/api/v1/projects/${f.projects.allMembers.id}`)
      .set(pat)
      .send({ name: "Renamed" })
    expect(res.status).toBe(403)
  })

  it("a WRITE-scoped PAT of a VIEWER cannot create a project", async () => {
    const f = await setup()
    const pat = await patFor(f.storage, f.users.viewer.id, ["read", "write"])
    const res = await request(f.app).post("/api/v1/projects").set(pat).send({ slug: "x", name: "X" })
    expect(res.status).toBe(403)
  })
})

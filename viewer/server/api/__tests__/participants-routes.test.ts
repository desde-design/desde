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

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * 11 listening servers per run before this. Every test uses exactly one app.
 */
const stable = createSwappableApp()

const nullAssets: AssetStore = {
  async put() {},
  async get() { return null },
  async deleteDeployment() {},
}

describe("participants API", () => {
  let storage: InMemoryStorage
  let app: express.Express
  let projectId: string

  beforeEach(async () => {
    storage = new InMemoryStorage()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
    projectId = (await storage.createProject({ slug: "acme", name: "Acme", repoUrl: null, access: "public-link" })).id
  })

  /** The admin bearer is the cheapest IDENTIFIED caller — see B5 below. */
  const asAdmin = { Authorization: "Bearer secret" }

  it("lists participants and invites by email — pending status", async () => {
    const invited = await request(app)
      .post(`/api/v1/projects/${projectId}/participants`)
      .set(asAdmin)
      .send({ email: "invitee@x.com" })
    expect(invited.status).toBe(201)
    expect(invited.body.status).toBe("pending")
    expect(invited.body.displayName).toBe("invitee") // local-part default
    const listed = await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asAdmin)
    expect(listed.body.participants).toHaveLength(1)
  })

  it("validates the invite payload and 404s an unknown project", async () => {
    const post = (body: object) =>
      request(app).post(`/api/v1/projects/${projectId}/participants`).set(asAdmin).send(body)
    expect((await post({})).status).toBe(400)
    expect((await post({ email: "not-an-email" })).status).toBe(400)
    expect((await post({ email: "x".repeat(255) + "@x.com" })).status).toBe(400)
    expect((await request(app).get(`/api/v1/projects/nope/participants`)).status).toBe(404)
  })

  it("routes the email through normalizeEmailInput (viewer-membership post-review follow-up)", async () => {
    const post = (body: object) =>
      request(app).post(`/api/v1/projects/${projectId}/participants`).set(asAdmin).send(body)

    // An interior control character (the classic header-injection payload)
    // is rejected, not just a malformed shape.
    const controlChar = await post({ email: "victim@example.test\r\nBcc: attacker@evil.test" })
    expect(controlChar.status).toBe(400)
    expect(controlChar.body).toEqual({ error: "email is invalid" })

    // Whitespace-padded, mixed case, otherwise valid — accepted, and stored
    // trimmed + lowercased rather than verbatim.
    const padded = await post({ email: "  Mixed.Case@X.com  " })
    expect(padded.status).toBe(201)
    expect(padded.body.email).toBe("mixed.case@x.com")
  })

  it("promotes a pending invitee to active when they author a comment", async () => {
    await request(app)
      .post(`/api/v1/projects/${projectId}/participants`)
      .set(asAdmin)
      .send({ email: "later@x.com", displayName: "Later" })
    await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
      position: { anchorSelector: "#x", page: "/" }, body: "hi",
      author: { uid: "viewer:l", displayName: "Later L", email: "later@x.com", photoURL: "" },
    })
    const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asAdmin))
      .body.participants
    expect(listed).toHaveLength(1) // deduped, not a second row
    expect(listed[0].status).toBe("active")
  })

  describe("field scoping — email is member-only (security audit S3)", () => {
    it("an anonymous caller gets EXACTLY {id, displayName, status} — no email", async () => {
      await request(app)
        .post(`/api/v1/projects/${projectId}/participants`)
        .set(asAdmin)
        .send({ email: "alice.owner@corp-internal.example", displayName: "Alice Owner" })

      const listed = await request(app).get(`/api/v1/projects/${projectId}/participants`)
      expect(listed.status).toBe(200)
      expect(listed.body.participants).toHaveLength(1)
      // EXACT key set, not "does not contain email": the latter keeps
      // passing the day someone adds another identity-bearing field.
      expect(Object.keys(listed.body.participants[0]).sort()).toEqual(["displayName", "id", "status"])
      expect(JSON.stringify(listed.body)).not.toContain("corp-internal.example")
    })

    it("an insider still gets the email — the mention picker's disambiguator", async () => {
      await request(app)
        .post(`/api/v1/projects/${projectId}/participants`)
        .set(asAdmin)
        .send({ email: "alice.owner@corp-internal.example", displayName: "Alice Owner" })

      const listed = await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asAdmin)
      expect(Object.keys(listed.body.participants[0]).sort()).toEqual([
        "displayName",
        "email",
        "id",
        "status",
      ])
      expect(listed.body.participants[0].email).toBe("alice.owner@corp-internal.example")
    })
  })

  describe("K07 — an unverified author may not rename an existing participant row", () => {
    it("preserves the stored displayName when an anonymous comment claims that address", async () => {
      await request(app)
        .post(`/api/v1/projects/${projectId}/participants`)
        .set(asAdmin)
        .send({ email: "alice.owner@corp.example", displayName: "Alice Owner" })

      const posted = await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
        position: { anchorSelector: "#x", page: "/" },
        body: "hi",
        author: {
          uid: "viewer:impostor",
          displayName: "Alice (IT Support)",
          email: "alice.owner@corp.example",
          photoURL: "",
        },
      })
      expect(posted.status).toBe(201)

      const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asAdmin))
        .body.participants
      expect(listed).toHaveLength(1)
      expect(listed[0].displayName).toBe("Alice Owner")
      // Promotion to `active` still happens — that only records "this
      // address has been seen authoring here", which the comment proves.
      expect(listed[0].status).toBe("active")
    })

    it("still lets a brand-new anonymous author enter the directory under their own name", async () => {
      await request(app).post(`/api/v1/projects/${projectId}/comments`).send({
        position: { anchorSelector: "#x", page: "/" },
        body: "hi",
        author: { uid: "viewer:new", displayName: "New Reviewer", email: "new@x.com", photoURL: "" },
      })
      const listed = (await request(app).get(`/api/v1/projects/${projectId}/participants`).set(asAdmin))
        .body.participants
      expect(listed).toHaveLength(1)
      expect(listed[0].displayName).toBe("New Reviewer")
    })
  })

  describe("visibility enforcement", () => {
    function authedConfig() {
      return loadConfig({
        VIEWER_ADMIN_TOKEN: "secret",
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
    }

    async function createLockedProject(store: InMemoryStorage) {
      const project = await store.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(store, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await store.addProjectMember({ projectId: project.id, userId: owner.id })
      return project
    }

    it("GET participants: 404s a non-member on a locked project, byte-identical to an unknown project", async () => {
      const store = new InMemoryStorage()
      const project = await createLockedProject(store)
      stable.use(createApp({ storage: store, assets: nullAssets, config: authedConfig(), bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const denied = await request(lockedApp).get(`/api/v1/projects/${project.id}/participants`)
      const missing = await request(lockedApp).get(`/api/v1/projects/nope/participants`)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("POST participants (invite): 404s a non-member write on a locked project; a member can invite", async () => {
      const store = new InMemoryStorage()
      const config = authedConfig()
      const project = await createLockedProject(store)
      stable.use(createApp({ storage: store, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const lockedApp = stable.app

      const denied = await request(lockedApp)
        .post(`/api/v1/projects/${project.id}/participants`)
        .send({ email: "invitee@x.com" })
      expect(denied.status).toBe(404)
      expect(denied.body).toEqual({ error: "Project not found" })

      const member = await upsertTestUser(store, {
        provider: "github",
        providerUserId: "member",
        email: "member@x.com",
        displayName: "Member",
        avatarUrl: "",
      })
      await store.addProjectMember({ projectId: project.id, userId: member.id })
      const session = await store.createSession({
        userId: member.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`

      const allowed = await request(lockedApp)
        .post(`/api/v1/projects/${project.id}/participants`)
        .set("Cookie", cookie)
        .send({ email: "invitee@x.com" })
      expect(allowed.status).toBe(201)
    })

    /**
     * INVERTED DELIBERATELY (security audit B5).
     *
     * This test used to assert 201 for the anonymous POST — it PINNED the
     * unauthenticated mail relay. The chain it kept open: an anonymous
     * visitor on any public-link (or zero-member) project seeds an arbitrary
     * recipient address here, then @-mentions that participant id from an
     * equally anonymous comment, and the outbox drain delivers
     * attacker-authored content from the operator's own SMTP identity —
     * measured at 20 recipients per request, 100 emails from 5 repeats, with
     * no dedup and no throttle.
     *
     * READING the directory is still open to anyone who can read the
     * project: that is the anonymous-review product, and the participant
     * rows are now email-free for outsiders anyway (S3, above). Only the
     * WRITE is closed, because inviting a human by email is not part of that
     * product — `upsertAuthorParticipant` already covers the legitimate
     * anonymous case of a reviewer entering the directory under their own
     * address by authoring something.
     */
    it("GET stays open to anyone on an open project, but the anonymous INVITE is refused", async () => {
      const store = new InMemoryStorage()
      const config = authedConfig()
      // Both are anonymously readable under Authorization v2: `all-members`
      // is not, so the "open project" this test means is `public-link`. The
      // second fixture keeps the loop honest as two independent projects.
      const openProject = await store.createProject({ slug: "open", name: "Open", access: "public-link" })
      const pubProject = await store.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      stable.use(createApp({ storage: store, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const openApp = stable.app

      for (const id of [openProject.id, pubProject.id]) {
        expect((await request(openApp).get(`/api/v1/projects/${id}/participants`)).status).toBe(200)

        const refused = await request(openApp)
          .post(`/api/v1/projects/${id}/participants`)
          .send({ email: `victim-${id}@target.example` })
        // 401, not 404/403: a statement about the missing CREDENTIAL, which
        // is identical for every project id and so leaks nothing.
        expect(refused.status).toBe(401)
        expect(await store.listParticipants(id)).toHaveLength(0)

        // …and an IDENTIFIED caller on the same project still may.
        const allowed = await request(openApp)
          .post(`/api/v1/projects/${id}/participants`)
          .set("Authorization", "Bearer secret")
          .send({ email: `colleague-${id}@y.com` })
        expect(allowed.status).toBe(201)
      }
    })

    it("a signed-in non-member may still invite on an open project", async () => {
      // The gate is IDENTITY, not membership — a signed-in reviewer holding
      // a public link inviting a colleague is normal use, and is now
      // attributable rather than anonymous.
      const store = new InMemoryStorage()
      const config = authedConfig()
      const project = await store.createProject({ slug: "pub2", name: "Pub2", access: "public-link" })
      stable.use(createApp({ storage: store, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app2 = stable.app
      const user = await upsertTestUser(store, {
        provider: "github",
        providerUserId: "outsider",
        email: "outsider@x.com",
        displayName: "Outsider",
        avatarUrl: "",
      })
      const session = await store.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const res = await request(app2)
        .post(`/api/v1/projects/${project.id}/participants`)
        .set("Cookie", `viewer_session=${signSessionId(config.sessionSecret, session.id)}`)
        .send({ email: "colleague@x.com" })
      expect(res.status).toBe(201)
    })
  })
})

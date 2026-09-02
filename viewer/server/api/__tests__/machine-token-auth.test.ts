/**
 * Phase 3b-2 Tasks 3+4 — end-to-end coverage that doesn't fit cleanly under
 * an existing single-route test file: the bearer-precedence rules applied
 * across real routes, the write-gate relaxation (`requireWrite` replacing
 * `requireAdmin` on the three write routes), and read-scoped PATs riding
 * the existing project-visibility gate for free.
 */
import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { generateMachineToken } from "../../auth/machine-token"
import { signSessionId } from "../../auth/session-cookie"
import type { MachineTokenScope, User } from "../../storage/types"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { InstanceRole } from "../../storage/types"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

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

const adminAuth = { Authorization: "Bearer secret" }

describe("machine-token auth — cross-cutting bearer precedence + write-gate relaxation (Phase 3b-2)", () => {
  let storage: InMemoryStorage
  let app: express.Express
  const config = authedConfig()

  /**
   * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
   *
   * The app is built fresh per test (it closes over per-test `storage`), which
   * defeated `supertest-reuse`'s per-object memoization completely: this file
   * opened 54 listening servers per run, one per test. Only one app is ever in
   * play here, so there is no two-app hazard to audit.
   */
  const stable = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
  })

  async function signInAs(email: string, role: InstanceRole = "editor") {
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
    const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`
    return { user, cookie }
  }

  /** Mints a live machine token directly in storage and returns its bearer header value. */
  async function patFor(
    user: User,
    scopes: MachineTokenScope[],
    opts: { expiresAt?: string | null } = {},
  ): Promise<string> {
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "seeded",
      scopes,
      tokenHash: gen.tokenHash,
      expiresAt: opts.expiresAt ?? null,
    })
    return `Bearer ${gen.token}`
  }

  describe("bearer precedence (Task 3) exercised through a real route", () => {
    it("no bearer at all: anonymous behavior unchanged (public-link reads 200)", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      await request(app).get(`/api/v1/projects/${project.id}`).expect(200)
    })

    it("admin bearer reaches a locked project", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })
      await request(app).get(`/api/v1/projects/${project.id}`).set(adminAuth).expect(200)
    })

    it("/me reports the PAT's own scopes, so a client can tell read-only from read+write", async () => {
      // Without this a machine client cannot discover what its credential may
      // do: a read-only PAT is indistinguishable from a write-capable one
      // until the first write 403s. The Editor's connect flow accepted
      // exactly that and stored a token that could never post a comment —
      // and the token UI creates read-only tokens by DEFAULT, so it was the
      // normal path, not an edge case.
      const { user } = await signInAs("scoped@x.com")

      const readOnly = await request(app).get("/api/v1/me").set("Authorization", await patFor(user, ["read"]))
      expect(readOnly.body.scopes).toEqual(["read"])

      const readWrite = await request(app)
        .get("/api/v1/me")
        .set("Authorization", await patFor(user, ["read", "write"]))
      expect(readWrite.body.scopes).toEqual(["read", "write"])
    })

    it("/me reports null scopes for a browser session — not [], which would read as 'no permissions'", async () => {
      const { cookie, user } = await signInAs("sessioned@x.com")
      const res = await request(app).get("/api/v1/me").set("Cookie", cookie)
      // Assert the session actually resolved. Without this the test passes on
      // a BROKEN cookie: an unauthenticated /me also reports scopes null, so
      // "null" alone cannot distinguish "session, not scope-limited" from
      // "nobody at all" — which is exactly how the first draft of this test
      // passed while sending a malformed cookie.
      expect(res.body.user?.id).toBe(user.id)
      expect(res.body.scopes).toBeNull()
    })

    it("a valid read-scoped PAT reaches a locked project it's a MEMBER of (200)", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user } = await signInAs("member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })
      const bearer = await patFor(user, ["read"])

      await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", bearer).expect(200)
    })

    it("a valid read-scoped PAT is 404d on a locked project it is NOT a member of — same as any non-member", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: owner } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const { user: outsider } = await signInAs("outsider@x.com")
      const bearer = await patFor(outsider, ["read"])

      await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", bearer).expect(404)
    })

    it("a garbage bearer 401s a normally-anonymous-readable route — never silently treated as anonymous", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const res = await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Authorization", "Bearer definitely-not-a-real-token")
        .expect(401)
      expect(res.body).toEqual({ error: "Invalid credentials" })
    })

    it("a garbage bearer 401s EVEN WITH a valid session cookie attached — the whole point of step 4", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { user, cookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Authorization", "Bearer garbage")
        .set("Cookie", cookie)
        .expect(401)
      expect(res.body).toEqual({ error: "Invalid credentials" })
    })

    it("an expired PAT 401s, even with a valid session cookie attached", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const { user, cookie } = await signInAs("owner@x.com")
      const bearer = await patFor(user, ["read"], { expiresAt: new Date(Date.now() - 1_000).toISOString() })

      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Authorization", bearer)
        .set("Cookie", cookie)
        .expect(401)
    })

    it("a revoked PAT 401s on its very next use", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const { user, cookie } = await signInAs("owner@x.com")
      const gen = generateMachineToken()
      await storage.createMachineToken({
        id: gen.id,
        userId: user.id,
        name: "t",
        scopes: ["read"],
        tokenHash: gen.tokenHash,
        expiresAt: null,
      })
      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Authorization", `Bearer ${gen.token}`)
        .expect(200)

      await request(app).delete(`/api/v1/tokens/${gen.id}`).set("Cookie", cookie).expect(204)

      await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", `Bearer ${gen.token}`).expect(401)
    })

    it("a token passed as a `?token=` query parameter does NOT authenticate — header only", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: owner } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const gen = generateMachineToken()
      await storage.createMachineToken({
        id: gen.id,
        userId: owner.id,
        name: "t",
        scopes: ["read"],
        tokenHash: gen.tokenHash,
        expiresAt: null,
      })

      // Would be 200 if the token were honored via the query string; instead
      // it's treated as fully anonymous (no Authorization header at all) —
      // 404, the same byte-identical denial a non-member gets.
      await request(app).get(`/api/v1/projects/${project.id}?token=${gen.token}`).expect(404)
    })
  })

  describe("write-gate relaxation (Task 4): requireWrite replaces requireAdmin", () => {
    describe("POST /projects", () => {
      // Task 11: `POST /projects` no longer adds an owner-member row on
      // every create — only when `access: "invited"` would otherwise lock
      // the (non-admin) creator out. The default `access` here is
      // `"all-members"`, which stays readable to the creator without a
      // membership row, so this PAT's user is deliberately NOT added.
      it("a write-scoped PAT can create a project; the token's user is NOT added as a member on the default access", async () => {
        const { user } = await signInAs("creator@x.com")
        const bearer = await patFor(user, ["write"])

        const res = await request(app)
          .post("/api/v1/projects")
          .set("Authorization", bearer)
          .send({ slug: "acme", name: "Acme" })
          .expect(201)

        expect(await storage.getProjectMember(res.body.id, user.id)).toBeNull()
      })

      it("a write-scoped PAT creating with access: 'invited' DOES add the token's user — the lockout guard", async () => {
        const { user } = await signInAs("creator@x.com")
        const bearer = await patFor(user, ["write"])

        const res = await request(app)
          .post("/api/v1/projects")
          .set("Authorization", bearer)
          .send({ slug: "acme", name: "Acme", access: "invited" })
          .expect(201)

        const member = await storage.getProjectMember(res.body.id, user.id)
        expect(member?.userId).toBe(user.id)
      })

      it("a read-scoped PAT is refused with 403 — insufficient scope", async () => {
        const { user } = await signInAs("creator@x.com")
        const bearer = await patFor(user, ["read"])

        const res = await request(app)
          .post("/api/v1/projects")
          .set("Authorization", bearer)
          .send({ slug: "acme", name: "Acme" })
          .expect(403)
        expect(res.body.error).toMatch(/write-scoped/i)
      })

      /**
       * Changed 2026-08-19. This used to assert 401 on the reasoning that
       * "sessions carry no write authority in this phase" — which had already
       * stopped being true elsewhere: the project-manage guard accepts a
       * session and gates member management, repo connect and build
       * triggering. A signed-in person could start builds on a project but
       * not create one. See `requireWrite`'s doc comment.
       */
      // Task 11: same narrowing as the PAT test above — the default access
      // needs no access-list row, so a plain session creating on it stays
      // memberless too. Manage authority for it comes from the session's
      // instance role (`requireInstanceEditor` already required to reach
      // here), not from a `ProjectMember` row.
      it("a plain signed-in session creates a project without a membership row on the default access", async () => {
        const { user, cookie } = await signInAs("creator@x.com")

        const res = await request(app)
          .post("/api/v1/projects")
          .set("Cookie", cookie)
          .send({ slug: "acme", name: "Acme" })
          .expect(201)

        expect(await storage.getProjectMember(res.body.id, user.id)).toBeNull()
      })

      /**
       * The floor the change above must not drop through. Opening the guard
       * to SESSIONS must not open it to nobody.
       *
       * Authorization v2 changed the CODE, not the outcome: `POST /projects`
       * routes to `requireInstanceEditor`, which reserves 401 for a
       * credential that was presented and did not resolve, and answers 403
       * when nothing was presented at all. Still refused; different number.
       */
      it("an anonymous caller — no cookie, no bearer — is still refused, now with 403", async () => {
        await request(app)
          .post("/api/v1/projects")
          .send({ slug: "acme", name: "Acme" })
          .expect(403)
      })

      /**
       * The role half of the same floor, new in Authorization v2: a signed-in
       * `viewer` is a fully resolved identity and still may not create.
       */
      it("a signed-in VIEWER is refused with 403 — creating a project needs the editor role", async () => {
        const { cookie } = await signInAs("reader@x.com", "viewer")
        await request(app)
          .post("/api/v1/projects")
          .set("Cookie", cookie)
          .send({ slug: "acme", name: "Acme" })
          .expect(403)
      })

      it("the admin bearer still works exactly as before", async () => {
        await request(app).post("/api/v1/projects").set(adminAuth).send({ slug: "acme", name: "Acme" }).expect(201)
      })
    })

    describe("PATCH /projects/:id and POST /projects/:id/deployments — manage-scoped write PAT", () => {
      async function seedOwnedProject() {
        const project = await storage.createProject({ slug: "acme", name: "Acme" })
        const { user: owner } = await signInAs("owner@x.com")
        await storage.addProjectMember({ projectId: project.id, userId: owner.id })
        return { project, owner }
      }

      it("a write-scoped PAT owned by the project's OWNER can PATCH it", async () => {
        const { project, owner } = await seedOwnedProject()
        const bearer = await patFor(owner, ["write"])

        const res = await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Authorization", bearer)
          .send({ name: "Renamed" })
          .expect(200)
        expect(res.body.name).toBe("Renamed")
      })

      /**
       * `ProjectMember` carries no role, and under Authorization v2 it
       * carries no authority either — the access list decides READABILITY,
       * the instance role decides everything else. This used to assert 403
       * for a member added after the creator; that premise is gone twice
       * over, so it proves the positive: the creator is not privileged.
       */
      it("a write-scoped PAT owned by a SECOND member (not the project's creator) can also PATCH it", async () => {
        const { project } = await seedOwnedProject()
        const { user: plainMember } = await signInAs("member@x.com")
        await storage.addProjectMember({ projectId: project.id, userId: plainMember.id })
        const bearer = await patFor(plainMember, ["write"])

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Authorization", bearer)
          .send({ name: "Renamed" })
          .expect(200)
      })

      /**
       * The session half of the three PAT cases above. Opening `requireWrite`
       * to sessions (2026-08-19) must not skip the ownership check that makes
       * these routes safe — a signed-in stranger has to be refused exactly
       * like a write-scoped PAT belonging to a stranger.
       */
      it("a signed-in session belonging to the project's OWNER can PATCH it", async () => {
        const project = await storage.createProject({ slug: "acme", name: "Acme" })
        const { user: owner, cookie } = await signInAs("owner@x.com")
        await storage.addProjectMember({ projectId: project.id, userId: owner.id })

        const res = await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Cookie", cookie)
          .send({ name: "Renamed" })
          .expect(200)
        expect(res.body.name).toBe("Renamed")
      })

      /**
       * The session counterpart of the PAT case above: the project's creator
       * holds no privilege a second member does not.
       */
      it("a signed-in session belonging to a SECOND member (not the project's creator) can also PATCH it", async () => {
        const { project } = await seedOwnedProject()
        const { user: plainMember, cookie } = await signInAs("member@x.com")
        await storage.addProjectMember({ projectId: project.id, userId: plainMember.id })

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Cookie", cookie)
          .send({ name: "Renamed" })
          .expect(200)
      })

      /**
       * Authorization v2 MOVED this boundary, so both halves changed.
       *
       * "Outsider" used to mean "holds no membership row", and that is no
       * longer a refusal at all — an EDITOR manages any project they can
       * read, listed or not. The refusal that survives is the instance role,
       * so the outsider here is a `viewer`, and they are refused even though
       * they hold a row on the project.
       */
      it("a signed-in VIEWER is refused with 403, membership row or not", async () => {
        const { project } = await seedOwnedProject()
        const { user: reader, cookie } = await signInAs("reader@x.com", "viewer")
        await storage.addProjectMember({ projectId: project.id, userId: reader.id })

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Cookie", cookie)
          .send({ name: "Renamed" })
          .expect(403)
      })

      it("a write-scoped PAT owned by a VIEWER is refused with 403 — a scope is not a role", async () => {
        const { project } = await seedOwnedProject()
        const { user: reader } = await signInAs("reader@x.com", "viewer")
        const bearer = await patFor(reader, ["write"])

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Authorization", bearer)
          .send({ name: "Renamed" })
          .expect(403)
      })

      /**
       * The memberless-project rule this pair used to pin ("memberless means
       * world-READABLE, never world-WRITABLE") is gone with the migration
       * rule that created it: a memberless `all-members` project is not
       * world-readable any more. What replaces it is the same shape one level
       * up — a project nobody is listed on is still not writable by just
       * anyone, and the thing that decides is the instance role.
       */
      it("a memberless project is writable by an EDITOR and not by a VIEWER, session or PAT", async () => {
        const project = await storage.createProject({ slug: "legacy", name: "Legacy" }) // zero members
        const { user: reader, cookie: readerCookie } = await signInAs("reader@x.com", "viewer")
        const readerBearer = await patFor(reader, ["write"])
        const { cookie: editorCookie } = await signInAs("ed@x.com", "editor")

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Cookie", readerCookie)
          .send({ name: "Hijacked" })
          .expect(403)

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Authorization", readerBearer)
          .send({ name: "Hijacked" })
          .expect(403)

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Cookie", editorCookie)
          .send({ name: "Renamed by an editor" })
          .expect(200)

        const res = await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set(adminAuth)
          .send({ name: "Renamed by admin" })
          .expect(200)
        expect(res.body.name).toBe("Renamed by admin")
      })

      it("a read-scoped PAT (even the owner's own) is refused with 403 on a write route", async () => {
        const { project, owner } = await seedOwnedProject()
        const bearer = await patFor(owner, ["read"])

        await request(app)
          .patch(`/api/v1/projects/${project.id}`)
          .set("Authorization", bearer)
          .send({ name: "Renamed" })
          .expect(403)
      })

      it("POST /projects/:id/deployments: same manage rule — an editor's PAT passes the gate, a viewer's 403s", async () => {
        const { project, owner } = await seedOwnedProject()
        const ownerBearer = await patFor(owner, ["write"])
        const { user: outsider } = await signInAs("reader@x.com", "viewer")
        const outsiderBearer = await patFor(outsider, ["write"])

        // Both will fail bundle validation (no real tar body) — but the
        // AUTHORIZATION layer is what's under test: a 403 here would prove
        // the gate rejected before ever reaching the upload/parse logic,
        // whereas the owner's request must get PAST the gate (400, not 403,
        // since an empty/invalid body is a client bundle-format error).
        const denied = await request(app)
          .post(`/api/v1/projects/${project.id}/deployments`)
          .set("Authorization", outsiderBearer)
          .expect(403)
        expect(denied.body.error).toMatch(/editors and admins/i)

        const ownerAttempt = await request(app)
          .post(`/api/v1/projects/${project.id}/deployments`)
          .set("Authorization", ownerBearer)
          .send(Buffer.from("not a real tarball"))
        expect(ownerAttempt.status).not.toBe(403)
        expect(ownerAttempt.status).not.toBe(401)
      })
    })
  })

  /**
   * Fix wave C1. `requireWrite` guarded only the three routes above; every
   * OTHER mutating route went through `requireProjectRead` / the
   * project-manage guard, both scope-blind at the time. The concrete exploit
   * that closed: a leaked READ-scoped PAT belonging to a project owner
   * could `POST /projects/:id/members {"email":"attacker","role":"owner"}`
   * and make the attacker a permanent owner — a privilege that SURVIVES
   * revoking the token.
   *
   * Each test below pins one route with the same triple: read-PAT → 403,
   * write-PAT (with whatever other authority that route needs) → success,
   * anonymous → unchanged from before the fix.
   */
  describe("write-scope enforcement on the non-requireWrite mutating routes (fix wave C1)", () => {
    async function seedPublicProject() {
      return storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
    }

    async function seedOwnedPublicProject() {
      const project = await storage.createProject({ slug: "owned", name: "Owned", access: "public-link" })
      const { user: owner } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      return { project, owner }
    }

    const commentBody = {
      position: { anchorSelector: "#a", page: "/" },
      body: "hi",
      author: { uid: "viewer:1", displayName: "Anon", email: "", photoURL: "" },
    }

    describe("POST /projects/:id/members (the escalation C1 named)", () => {
      it("a READ-scoped PAT owned by the project owner is refused 403 — it cannot add an owner", async () => {
        const { project, owner } = await seedOwnedPublicProject()
        await signInAs("attacker@evil.com")
        const bearer = await patFor(owner, ["read"])

        const res = await request(app)
          .post(`/api/v1/projects/${project.id}/members`)
          .set("Authorization", bearer)
          .send({ email: "attacker@evil.com" })
          .expect(403)
        expect(res.body.error).toMatch(/write-scoped/i)
        expect(await storage.listProjectMembers(project.id)).toHaveLength(1)
      })

      it("a WRITE-scoped PAT owned by the project owner still works", async () => {
        const { project, owner } = await seedOwnedPublicProject()
        await signInAs("teammate@x.com")
        const bearer = await patFor(owner, ["write"])

        await request(app)
          .post(`/api/v1/projects/${project.id}/members`)
          .set("Authorization", bearer)
          .send({ email: "teammate@x.com" })
          .expect(201)
      })
    })

    it("DELETE /projects/:id/members/:userId refuses a READ-scoped PAT with 403", async () => {
      const { project, owner } = await seedOwnedPublicProject()
      const { user: other } = await signInAs("other@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: other.id })
      const bearer = await patFor(owner, ["read"])

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${other.id}`)
        .set("Authorization", bearer)
        .expect(403)
      expect(await storage.listProjectMembers(project.id)).toHaveLength(2)
    })

    it("POST /projects/:id/comments refuses a READ-scoped PAT with 403, but a WRITE-scoped one posts", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")

      const denied = await request(app)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Authorization", await patFor(user, ["read"]))
        .send(commentBody)
        .expect(403)
      expect(denied.body.error).toMatch(/write-scoped/i)
      expect(await storage.listComments(project.id)).toHaveLength(0)

      await request(app)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Authorization", await patFor(user, ["read", "write"]))
        .send(commentBody)
        .expect(201)
      expect(await storage.listComments(project.id)).toHaveLength(1)
    })

    it("PATCH /projects/:id/comments/:commentId refuses a READ-scoped PAT with 403", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")
      const comment = await storage.createComment(project.id, {
        position: { anchorSelector: "#a", page: "/" },
        body: "original",
        author: { uid: "viewer:1", displayName: "Anon", email: "", photoURL: "" },
      })

      await request(app)
        .patch(`/api/v1/projects/${project.id}/comments/${comment.id}`)
        .set("Authorization", await patFor(user, ["read"]))
        .send({ body: "edited" })
        .expect(403)
      expect((await storage.getComment(comment.id))?.body).toBe("original")
    })

    it("DELETE /projects/:id/comments/:commentId refuses a READ-scoped PAT with 403", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")
      const comment = await storage.createComment(project.id, {
        position: { anchorSelector: "#a", page: "/" },
        body: "keep me",
        author: { uid: "viewer:1", displayName: "Anon", email: "", photoURL: "" },
      })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/comments/${comment.id}`)
        .set("Authorization", await patFor(user, ["read"]))
        .expect(403)
      expect(await storage.getComment(comment.id)).not.toBeNull()
    })

    it("POST /projects/:id/comments/:commentId/replies refuses a READ-scoped PAT with 403", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")
      const comment = await storage.createComment(project.id, {
        position: { anchorSelector: "#a", page: "/" },
        body: "root",
        author: { uid: "viewer:1", displayName: "Anon", email: "", photoURL: "" },
      })

      await request(app)
        .post(`/api/v1/projects/${project.id}/comments/${comment.id}/replies`)
        .set("Authorization", await patFor(user, ["read"]))
        .send({ body: "reply", author: { uid: "viewer:2", displayName: "B", email: "", photoURL: "" } })
        .expect(403)
      expect((await storage.getComment(comment.id))?.replies).toHaveLength(0)
    })

    it("POST /projects/:id/participants refuses a READ-scoped PAT with 403, but a WRITE-scoped one invites", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")

      await request(app)
        .post(`/api/v1/projects/${project.id}/participants`)
        .set("Authorization", await patFor(user, ["read"]))
        .send({ email: "invitee@x.com" })
        .expect(403)
      expect(await storage.listParticipants(project.id)).toHaveLength(0)

      await request(app)
        .post(`/api/v1/projects/${project.id}/participants`)
        .set("Authorization", await patFor(user, ["write"]))
        .send({ email: "invitee@x.com" })
        .expect(201)
    })

    it("a READ-scoped PAT still READS everything it could before — the refusal is write-only", async () => {
      const project = await seedPublicProject()
      const { user } = await signInAs("pat@x.com")
      const bearer = await patFor(user, ["read"])

      await request(app).get(`/api/v1/projects/${project.id}/comments`).set("Authorization", bearer).expect(200)
      await request(app).get(`/api/v1/projects/${project.id}/participants`).set("Authorization", bearer).expect(200)
      await request(app).get(`/api/v1/projects/${project.id}/members`).set("Authorization", bearer).expect(200)
    })

    it("ANONYMOUS comment writes are unchanged — the public-write model is deliberately untouched", async () => {
      const project = await seedPublicProject()
      await request(app).post(`/api/v1/projects/${project.id}/comments`).send(commentBody).expect(201)
    })
  })

  /**
   * Fix wave I4. RFC 7235 §2.1 makes the auth SCHEME case-insensitive, and
   * the old `startsWith("Bearer ")` silently discarded anything else — so
   * `authorization: bearer <PAT>` took the NO-BEARER branch and the request
   * ran as anonymous. On a public-link project that's a 200 that LOOKS like
   * the token worked; on a revoked token it reads as anonymous instead of
   * 401, which is exactly what the strict-401 rule exists to prevent.
   */
  /**
   * Found by LIVE ACCEPTANCE, with 658 unit tests green. Node/Express strips
   * trailing optional whitespace, so `Authorization: Bearer ` — an unset
   * `$TOKEN` in a CI script, the single most common way to send a broken
   * credential — arrives as exactly `"Bearer"`. Against the old
   * `/^bearer /i` that failed to match and took the NO-BEARER branch, so the
   * request ran as anonymous: a silent 200 on any readable project. It also
   * flatly contradicted `extractBearerToken`'s own doc comment, which claims
   * an empty token counts as a bearer ATTEMPT.
   */
  describe("an empty bearer is an ATTEMPT, not an absent header", () => {
    for (const header of ["Bearer", "Bearer ", "bearer", "BEARER "]) {
      it(`${JSON.stringify(header)} 401s rather than running as anonymous`, async () => {
        const project = await storage.createProject({
          slug: `empty-${header.trim().toLowerCase()}${header.endsWith(" ") ? "-sp" : ""}`,
          name: "E",
          access: "public-link",
        })
        await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", header).expect(401)
      })
    }

    it("a non-bearer scheme still falls through to anonymous, unchanged", async () => {
      const project = await storage.createProject({ slug: "basic-ok", name: "B", access: "public-link" })
      await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", "Basic dXNlcjpwYXNz").expect(200)
    })

    // `Bearerfoo` is not the bearer scheme at all — the scheme token ends at
    // the delimiter. It must fall through, not be read as the token "foo".
    it("a scheme-prefixed word is not a bearer", async () => {
      const project = await storage.createProject({ slug: "bearerish", name: "B", access: "public-link" })
      await request(app).get(`/api/v1/projects/${project.id}`).set("Authorization", "Bearerfoo").expect(200)
    })
  })

  describe("bearer scheme is matched case-insensitively (fix wave I4)", () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      it(`"${scheme}" authenticates a PAT on a project only its owner can read`, async () => {
        const project = await storage.createProject({ slug: `s-${scheme}`, name: "S", access: "invited" })
        const { user } = await signInAs(`${scheme}@x.com`)
        await storage.addProjectMember({ projectId: project.id, userId: user.id })
        const bearer = await patFor(user, ["read"])
        const raw = bearer.slice("Bearer ".length)

        await request(app)
          .get(`/api/v1/projects/${project.id}`)
          .set("Authorization", `${scheme} ${raw}`)
          .expect(200)
      })

      it(`"${scheme} <garbage>" 401s instead of silently running as anonymous`, async () => {
        const project = await storage.createProject({ slug: `g-${scheme}`, name: "G", access: "public-link" })
        await request(app)
          .get(`/api/v1/projects/${project.id}`)
          .set("Authorization", `${scheme} not-a-real-token`)
          .expect(401)
      })

      it(`"${scheme} <adminToken>" is still recognized as the admin bearer`, async () => {
        const project = await storage.createProject({ slug: `a-${scheme}`, name: "A" })
        const { user } = await signInAs(`admin-${scheme}@x.com`)
        await storage.addProjectMember({ projectId: project.id, userId: user.id })

        await request(app)
          .get(`/api/v1/projects/${project.id}`)
          .set("Authorization", `${scheme} secret`)
          .expect(200)
      })
    }

    it("a non-bearer scheme (Basic) still falls through to anonymous, unchanged", async () => {
      const project = await storage.createProject({ slug: "basic", name: "Basic", access: "public-link" })
      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Authorization", "Basic dXNlcjpwYXNz")
        .expect(200)
    })
  })

  /**
   * Fix wave M2. `resolveWriteAuthor` used to resolve identity with its own
   * `getCurrentUser` call rather than the ALREADY-RESOLVED `ReadContext`.
   * With a PAT for user X and a cookie for user Y on the same request, the
   * write was AUTHORIZED as X but ATTRIBUTED to Y; with a PAT and no cookie
   * it fell through to the spoofable self-declared `viewer:` branch, making
   * every PAT-driven write unattributable.
   */
  describe("comment author attribution follows the authorized identity (fix wave M2)", () => {
    it("a PAT-authorized write is attributed to the TOKEN's owner, not to a cookie riding along", async () => {
      const project = await storage.createProject({ slug: "attr", name: "Attr", access: "public-link" })
      const { user: tokenOwner } = await signInAs("token-owner@x.com")
      const { cookie: otherCookie } = await signInAs("cookie-user@x.com")
      const bearer = await patFor(tokenOwner, ["write"])

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Authorization", bearer)
        .set("Cookie", otherCookie)
        .send({
          position: { anchorSelector: "#a", page: "/" },
          body: "who wrote this?",
          author: { uid: "viewer:spoof", displayName: "Spoof", email: "spoof@x.com", photoURL: "" },
        })
        .expect(201)

      expect(res.body.author.uid).toBe(`user:${tokenOwner.id}`)
      // The ATTRIBUTED identity is what this guards, so it is asserted
      // against storage. The echoed view omits `email` because the token's
      // owner is not a member of this public-link project — see
      // `field-visibility.ts` (security audit S3).
      expect((await storage.getComment(res.body.id))!.author.email).toBe("token-owner@x.com")
    })

    it("a PAT with NO cookie is still attributed to the token's owner, not the self-declared author", async () => {
      const project = await storage.createProject({ slug: "attr2", name: "Attr2", access: "public-link" })
      const { user: tokenOwner } = await signInAs("solo@x.com")
      const bearer = await patFor(tokenOwner, ["write"])

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Authorization", bearer)
        .send({
          position: { anchorSelector: "#a", page: "/" },
          body: "from CI",
          author: { uid: "viewer:anon", displayName: "Anon", email: "", photoURL: "" },
        })
        .expect(201)

      expect(res.body.author.uid).toBe(`user:${tokenOwner.id}`)
      expect((await storage.getComment(res.body.id))!.author.email).toBe("solo@x.com")
    })

    it("replies follow the same rule", async () => {
      const project = await storage.createProject({ slug: "attr3", name: "Attr3", access: "public-link" })
      const { user: tokenOwner } = await signInAs("replier@x.com")
      const bearer = await patFor(tokenOwner, ["write"])
      const comment = await storage.createComment(project.id, {
        position: { anchorSelector: "#a", page: "/" },
        body: "root",
        author: { uid: "viewer:1", displayName: "Anon", email: "", photoURL: "" },
      })

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/comments/${comment.id}/replies`)
        .set("Authorization", bearer)
        .send({ body: "reply", author: { uid: "viewer:2", displayName: "B", email: "", photoURL: "" } })
        .expect(200)

      expect(res.body.replies[0].author.uid).toBe(`user:${tokenOwner.id}`)
    })

    it("a plain signed-in session (no PAT) is still attributed to the session user — unchanged", async () => {
      const project = await storage.createProject({ slug: "attr4", name: "Attr4", access: "public-link" })
      const { user, cookie } = await signInAs("session-only@x.com")

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/comments`)
        .set("Cookie", cookie)
        .send({
          position: { anchorSelector: "#a", page: "/" },
          body: "browser comment",
          author: { uid: "viewer:x", displayName: "X", email: "x@x.com", photoURL: "" },
        })
        .expect(201)

      expect(res.body.author.uid).toBe(`user:${user.id}`)
    })
  })
})

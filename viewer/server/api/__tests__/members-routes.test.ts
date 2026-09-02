import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { signSessionId } from "../../auth/session-cookie"
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

describe("members API (Phase 3b-1 Task 4)", () => {
  let storage: InMemoryStorage
  let app: express.Express
  const config = authedConfig()

  /**
   * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
   *
   * The app is built fresh per test (it closes over per-test `storage`), which
   * defeated `supertest-reuse`'s per-object memoization completely: this file
   * opened 26 listening servers per run, one per test. Only one app is ever in
   * play here, so there is no two-app hazard to audit.
   */
  const stable = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
  })

  /** Seeds a user + live session in `storage`, returns a `Cookie` header value for it. */
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

  describe("GET /projects/:id/members — readable-project gated", () => {
    it("lists members joined with user identity, including email, for a caller who is themselves a member", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const { user, cookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", cookie)
        .expect(200)
      expect(res.body.members).toHaveLength(1)
      expect(res.body.members[0]).toMatchObject({
        userId: user.id,
        email: "owner@x.com",
        displayName: "owner@x.com",
      })
    })

    it("404s an unknown project", async () => {
      await request(app).get(`/api/v1/projects/nope/members`).expect(404)
    })

    it("404s a non-member on a locked ('invited', has members) project — byte-identical to unknown", async () => {
      const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const { user: owner } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      const denied = await request(app).get(`/api/v1/projects/${project.id}/members`)
      const missing = await request(app).get(`/api/v1/projects/nope/members`)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    // Authorization v2: the migration rule this test was written for is gone.
    // A zero-member `all-members` project is NOT anonymously readable, so the
    // member list follows the project's own read gate down to a 404. The
    // empty-list-is-a-valid-answer half of the assertion moves to the
    // `public-link` fixture, where an anonymous reader legitimately belongs.
    it("a zero-member project's member list follows the project's read gate: 404 anonymously on all-members, empty list on public-link", async () => {
      const gated = await storage.createProject({ slug: "open", name: "Open" })
      const denied = await request(app).get(`/api/v1/projects/${gated.id}/members`).expect(404)
      const missing = await request(app).get(`/api/v1/projects/nope/members`).expect(404)
      expect(denied.body).toEqual(missing.body)

      const open = await storage.createProject({ slug: "open2", name: "Open2", access: "public-link" })
      const res = await request(app).get(`/api/v1/projects/${open.id}/members`).expect(200)
      expect(res.body.members).toEqual([])
    })
  })

  // Important fix (whole-branch review): the route was gated on project
  // READABILITY only, so on a `public-link` project — the anonymous-review
  // product — any unauthenticated visitor could enumerate the team's real,
  // verified GitHub account emails. `email` must be ABSENT (not `""`) for a
  // caller who is not entitled to it.
  //
  // M2 review fix — WHO is entitled. Task 11 had widened it to "any signed-in
  // account on this instance" (`hasAdminAuthority(ctx) || ctx.user !== null`),
  // which on a `public-link` project means every signed-in stranger. It is now
  // `hasProjectManageAuthority(ctx) || callerIsListed`: someone who can MANAGE
  // this project's access list (admin or editor — they add people by email),
  // or someone who is ON that list. Signing in is not membership of anything.
  describe("GET /projects/:id/members — email is scoped to managers and listed members", () => {
    async function seedPublicProjectWithMembers() {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const { user: plainMember, cookie: memberCookie } = await signInAs("member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: plainMember.id })
      return { project, owner, ownerCookie, plainMember, memberCookie }
    }

    /** Asserts every returned row carries (or omits) `email`, and that rows were returned at all. */
    function expectEmails(body: { members: Record<string, unknown>[] }, present: boolean) {
      expect(body.members.length).toBeGreaterThan(0)
      for (const m of body.members) {
        if (present) expect(typeof m.email).toBe("string")
        else expect(m).not.toHaveProperty("email")
        expect(typeof m.displayName).toBe("string")
      }
    }

    it("an anonymous reader of a public-link project sees members WITHOUT emails", async () => {
      const { project } = await seedPublicProjectWithMembers()

      const res = await request(app).get(`/api/v1/projects/${project.id}/members`).expect(200)
      expect(res.body.members).toHaveLength(2)
      expectEmails(res.body, false)
    })

    it("an EDITOR who is not listed sees emails — they manage the list, and adding is by email", async () => {
      const { project } = await seedPublicProjectWithMembers()
      const { cookie: editorCookie } = await signInAs("editor@x.com", "editor")

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", editorCookie)
        .expect(200)
      expectEmails(res.body, true)
    })

    it("a listed VIEWER sees emails — they are on this project's roster", async () => {
      const { project } = await seedPublicProjectWithMembers()
      const { user: reader, cookie: readerCookie } = await signInAs("reader@x.com", "viewer")
      await storage.addProjectMember({ projectId: project.id, userId: reader.id })

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", readerCookie)
        .expect(200)
      expectEmails(res.body, true)
    })

    // THE regression this fix exists for. `all-members` (not `public-link`),
    // so the caller can genuinely read the project — this is not a 404 in
    // disguise, it is a 200 that withholds the addresses.
    it("an UNLISTED viewer on an all-members project sees members WITHOUT emails", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "all-members" })
      const { user: listed } = await signInAs("listed@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: listed.id })
      const { cookie: outsiderCookie } = await signInAs("outsider@x.com", "viewer")

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", outsiderCookie)
        .expect(200)
      expectEmails(res.body, false)
    })

    it("the ADMIN token sees emails", async () => {
      const { project } = await seedPublicProjectWithMembers()

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .expect(200)
      expectEmails(res.body, true)
    })

    // `hasProjectManageAuthority` folds in `hasAdminAuthority`, which covers
    // BOTH the shared bearer above and an `admin`-ROLE account. Asserted
    // separately so the two admin concepts cannot drift apart here.
    it("an admin-ROLE session that is not listed sees emails", async () => {
      const { project } = await seedPublicProjectWithMembers()
      const { cookie: bossCookie } = await signInAs("boss@x.com", "admin")

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", bossCookie)
        .expect(200)
      expectEmails(res.body, true)
    })
  })

  describe("POST /projects/:id/members — member-or-admin gated, invite by email", () => {
    it("admin token adds an existing user as a member", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const invitee = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "invitee",
        email: "invitee@x.com",
        displayName: "Invitee",
        avatarUrl: "",
      })

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "invitee@x.com" })
        .expect(201)

      expect(res.body).toMatchObject({ userId: invitee.id, email: "invitee@x.com" })
      expect(await storage.getProjectMember(project.id, invitee.id)).not.toBeNull()
    })

    // `ProjectMember` carries no `role`, and the POST body does not validate
    // one, so the old "explicit owner role" premise is gone. What remains to
    // pin: a `role` key in the body is accepted and silently ignored.
    it("a 'role' key in the request body is silently ignored, not rejected", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "invitee",
        email: "invitee@x.com",
        displayName: "Invitee",
        avatarUrl: "",
      })

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "invitee@x.com", role: "owner" })
        .expect(201)
      expect(res.body).not.toHaveProperty("role")
      expect(res.body.email).toBe("invitee@x.com")
    })

    it("case-insensitive email match resolves to the existing user", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "invitee",
        email: "invitee@x.com",
        displayName: "Invitee",
        avatarUrl: "",
      })

      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "InViTee@X.com" })
        .expect(201)
      expect(res.body.email).toBe("invitee@x.com")
    })

    // Authorization v2 MOVED this boundary from membership to instance role.
    // A membership row no longer grants anything on the write side — it is an
    // access list — so the two halves are now a `viewer` (refused, even though
    // they hold a row) and an `editor` (allowed, holding none).
    it("an EDITOR with no membership row can invite; a VIEWER holding a row is refused with 403", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { cookie: memberCookie } = await signInAs("member@x.com", "editor")
      const { user: reader, cookie: outsiderCookie } = await signInAs("reader@x.com", "viewer")
      await storage.addProjectMember({ projectId: project.id, userId: reader.id })
      await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "invitee",
        email: "invitee@x.com",
        displayName: "Invitee",
        avatarUrl: "",
      })

      await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", outsiderCookie)
        .send({ email: "invitee@x.com" })
        .expect(403)

      await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set("Cookie", memberCookie)
        .send({ email: "invitee@x.com" })
        .expect(201)
    })

    it("an anonymous caller on a readable (public-link) project is refused with 403, not silently allowed", async () => {
      const project = await storage.createProject({ slug: "open", name: "Open", access: "public-link" })
      await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "invitee",
        email: "invitee@x.com",
        displayName: "Invitee",
        avatarUrl: "",
      })
      await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .send({ email: "invitee@x.com" })
        .expect(403)
    })

    it("404s with the plain miss message when no user exists for the invited email yet", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const res = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "nobody@x.com" })
        .expect(404)
      expect(res.body).toEqual({
        error: "That email doesn't belong to a member of this viewer yet. Invite them from Settings first.",
      })
    })

    // Task 11: a removed account must not be addable, and the refusal must
    // be indistinguishable from "nobody with that email ever signed in" — no
    // oracle for "someone used to be here."
    it("refuses to add a REMOVED user's email — byte-identical to a never-existed email", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const removedUser = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "gone",
        email: "gone@x.com",
        displayName: "Gone",
        avatarUrl: "",
      })
      await storage.setUserStatus(removedUser.id, "removed")

      const missing = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "nobody@x.com" })
        .expect(404)
      const removed = await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "gone@x.com" })
        .expect(404)
      expect(removed.status).toBe(missing.status)
      expect(removed.body).toEqual(missing.body)
    })

    // The old "invalid role" half of this test is gone: the body no longer
    // validates a `role` key at all (the "silently ignored" test above
    // covers what happens when one is sent).
    it("400s an invalid email", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      await request(app)
        .post(`/api/v1/projects/${project.id}/members`)
        .set(adminAuth)
        .send({ email: "not-an-email" })
        .expect(400)
    })

    it("404s an unknown project, same shape whether or not the caller is admin", async () => {
      const res = await request(app)
        .post(`/api/v1/projects/nope/members`)
        .set(adminAuth)
        .send({ email: "x@y.com" })
        .expect(404)
      expect(res.body).toEqual({ error: "Project not found" })
    })
  })

  describe("DELETE /projects/:id/members/:userId — member-or-admin gated", () => {
    it("a member can remove another member", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const { user: plainMember } = await signInAs("member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: plainMember.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${plainMember.id}`)
        .set("Cookie", ownerCookie)
        .expect(204)
      expect(await storage.getProjectMember(project.id, plainMember.id)).toBeNull()
    })

    // The DELETE guard is scoped to `access === "invited"` only, with ONE
    /*
      The last member CAN be removed, as of 2026-08-29.

      A guard refused this from Phase 3b-1 Task 4: draining an `"invited"`
      roster to zero locks out everyone without admin authority, including the
      editor doing it, since their own read came from the row they were
      deleting. Mo removed it — "people can lock themselves out if they want to
      and then ask an Admin if they make a mistake."

      What this test pins now is that the removal succeeds AND that nothing is
      exposed by it. That second half is the part that matters: removal never
      touches `access`, so an emptied roster must leave an `"invited"` project
      unreadable to strangers, not reopened. With the guard gone that
      invariant has no backstop but this assertion.
    */
    it("allows removing the last member of an invite-only project, and it does NOT re-open", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${owner.id}`)
        .set("Cookie", ownerCookie)
        .expect(204)
      expect(await storage.getProjectMember(project.id, owner.id)).toBeNull()

      // Empty roster, still not public.
      await request(app).get(`/api/v1/projects/${project.id}`).expect(404)
    })

    // Kept on an `"invited"` project. It was written against the last-member
    // guard (removed 2026-08-29) and reads as ordinary coverage now: one of
    // two members comes off and the other stays.
    it("allows removing one of TWO members on an invite-only project (not the last one)", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: member1, cookie: member1Cookie } = await signInAs("member1@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: member1.id })
      const { user: member2 } = await signInAs("member2@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: member2.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${member2.id}`)
        .set("Cookie", member1Cookie)
        .expect(204)
      expect(await storage.getProjectMember(project.id, member2.id)).toBeNull()
      expect(await storage.getProjectMember(project.id, member1.id)).not.toBeNull()
    })

    // M2 review fix: the last-member guard is EXEMPT for admin authority. The
    // guard's justification is lockout — an editor who empties an "invited"
    // roster loses their own read of the project along with everyone else's.
    // An admin never had their read from the roster (`canReadProject` admits
    // admin authority outright), so refusing them was pure obstruction: the
    // operator could not dismantle a roster without first adding a throwaway
    // member to delete afterwards.
    it("the admin token CAN remove the last member of an invite-only project — it cannot lock itself out", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: listed } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: listed.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${listed.id}`)
        .set(adminAuth)
        .expect(204)
      expect(await storage.listProjectMembers(project.id)).toHaveLength(0)

      // The project did NOT re-open. `access` is untouched by a removal, so
      // an empty roster on an "invited" project is unreadable to everyone
      // without admin authority. Since the last-member guard came out
      // (2026-08-29) this invariant is the only thing standing here, which
      // makes it the assertion to keep.
      const after = await storage.getProject(project.id)
      expect(after?.access).toBe("invited")
      const { cookie: strangerCookie } = await signInAs("stranger@x.com", "viewer")
      await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", strangerCookie).expect(404)
      // And still reachable by the admin who emptied it.
      await request(app).get(`/api/v1/projects/${project.id}`).set(adminAuth).expect(200)
    })

    // The same exemption, through the OTHER way of holding admin authority.
    // `hasAdminAuthority` covers both, and this pins that they agree.
    it("an admin-ROLE session can also remove the last member", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user: listed } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: listed.id })
      const { cookie: bossCookie } = await signInAs("boss@x.com", "admin")

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${listed.id}`)
        .set("Cookie", bossCookie)
        .expect(204)
      expect(await storage.listProjectMembers(project.id)).toHaveLength(0)
    })

    // Same boundary move as the POST test above: a VIEWER is refused even
    // while holding a membership row on the project, because a row is access
    // and not authority.
    it("a signed-in VIEWER is refused with 403, membership row or not", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { user: owner } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      const { user: reader, cookie: readerCookie } = await signInAs("reader@x.com", "viewer")
      await storage.addProjectMember({ projectId: project.id, userId: reader.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/${owner.id}`)
        .set("Cookie", readerCookie)
        .expect(403)
    })

    it("removing a nonexistent member is idempotent (204), same as the underlying storage contract", async () => {
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      await request(app)
        .delete(`/api/v1/projects/${project.id}/members/no-such-user`)
        .set("Cookie", ownerCookie)
        .expect(204)
    })

    it("404s an unknown project", async () => {
      await request(app).delete(`/api/v1/projects/nope/members/whoever`).set(adminAuth).expect(404)
    })

    /*
      Was "an invite-only roster must not be drainable to zero". It is
      drainable now (Mo, 2026-08-29), so what these cases pin has changed
      from "the guard refuses" to "the removal happens and nothing reopens".

      Three of the old cases existed only to describe the guard's internals —
      that it counted ACTIVE members rather than rows, and that it skipped a
      target who was not active. Those had no behaviour left to assert once
      the guard went, so they are folded into the two below: an editor can
      drain the roster including themselves, and a stale row is just a row.
    */
    describe("an invite-only roster can be drained, and draining it reopens nothing", () => {
      it("lets a non-admin manager remove everyone including themselves", async () => {
        const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" }) // starts memberless
        const { user: u1, cookie: u1Cookie } = await signInAs("u1@x.com", "editor")
        const u2 = await upsertTestUser(storage, {
          provider: "github",
          providerUserId: "u2",
          email: "u2@x.com",
          displayName: "U2",
          avatarUrl: "",
        })

        // Seeded with the admin token: until u1 holds a row they cannot read
        // an `"invited"` project at all, so they cannot manage it either.
        await request(app).post(`/api/v1/projects/${project.id}/members`).set(adminAuth).send({ email: "u1@x.com" }).expect(201)
        await request(app).post(`/api/v1/projects/${project.id}/members`).set(adminAuth).send({ email: "u2@x.com" }).expect(201)
        await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", u1Cookie).expect(200)

        await request(app)
          .delete(`/api/v1/projects/${project.id}/members/${u2.id}`)
          .set("Cookie", u1Cookie)
          .expect(204)

        // Themselves, and last. This used to be a 400.
        await request(app)
          .delete(`/api/v1/projects/${project.id}/members/${u1.id}`)
          .set("Cookie", u1Cookie)
          .expect(204)
        expect(await storage.getProjectMember(project.id, u1.id)).toBeNull()

        // They have locked themselves out, which is the accepted cost — and
        // the project is NOT public as a result. An anonymous caller still
        // 404s, and u1 can no longer read it either.
        await request(app).get(`/api/v1/projects/${project.id}`).expect(404)
        await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", u1Cookie).expect(404)
      })

      /**
       * A removed user's access-list row is left in place by the instance
       * removal route, so an `"invited"` roster can hold rows belonging to
       * people who cannot read the project at all. That used to matter a great
       * deal — the guard counted ACTIVE users precisely so a stale row could
       * not pass as headroom. With no guard there is no count, and this now
       * just checks that such a row deletes like any other.
       */
      it("removes a stale row belonging to a removed user like any other", async () => {
        const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
        const { user: editor, cookie: editorCookie } = await signInAs("editor@x.com", "editor")
        await storage.addProjectMember({ projectId: project.id, userId: editor.id })
        const removed = await upsertTestUser(storage, {
          provider: "github",
          providerUserId: "removed-user",
          email: "removed@x.com",
          displayName: "Removed",
          avatarUrl: "",
        })
        await storage.addProjectMember({ projectId: project.id, userId: removed.id })
        await storage.setUserStatus(removed.id, "removed")

        await request(app)
          .delete(`/api/v1/projects/${project.id}/members/${removed.id}`)
          .set("Cookie", editorCookie)
          .expect(204)
        expect(await storage.getProjectMember(project.id, removed.id)).toBeNull()

        // And the editor can still remove themselves afterwards.
        await request(app)
          .delete(`/api/v1/projects/${project.id}/members/${editor.id}`)
          .set("Cookie", editorCookie)
          .expect(204)
      })

      it("removing a row whose user no longer exists at all still succeeds (orphaned membership row)", async () => {
        const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
        const { user: editor, cookie: editorCookie } = await signInAs("editor@x.com", "editor")
        await storage.addProjectMember({ projectId: project.id, userId: editor.id })
        await storage.addProjectMember({ projectId: project.id, userId: "ghost-user-id" })

        await request(app)
          .delete(`/api/v1/projects/${project.id}/members/ghost-user-id`)
          .set("Cookie", editorCookie)
          .expect(204)
        expect(await storage.getProjectMember(project.id, "ghost-user-id")).toBeNull()
      })

      it("a 'public-link' project's roster can be drained to zero, and stays public", async () => {
        const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
        const u1 = await upsertTestUser(storage, {
          provider: "github",
          providerUserId: "u1",
          email: "u1@x.com",
          displayName: "U1",
          avatarUrl: "",
        })
        const u2 = await upsertTestUser(storage, {
          provider: "github",
          providerUserId: "u2",
          email: "u2@x.com",
          displayName: "U2",
          avatarUrl: "",
        })
        await request(app).post(`/api/v1/projects/${project.id}/members`).set(adminAuth).send({ email: "u1@x.com" }).expect(201)
        await request(app).post(`/api/v1/projects/${project.id}/members`).set(adminAuth).send({ email: "u2@x.com" }).expect(201)

        // Both removals succeed — a public-link project is unconditionally
        // public regardless of membership, so blocking these would be a
        // pure usability regression, not a safety measure.
        await request(app).delete(`/api/v1/projects/${project.id}/members/${u1.id}`).set(adminAuth).expect(204)
        await request(app).delete(`/api/v1/projects/${project.id}/members/${u2.id}`).set(adminAuth).expect(204)
        expect(await storage.listProjectMembers(project.id)).toHaveLength(0)

        // And it was always readable anyway, throughout.
        await request(app).get(`/api/v1/projects/${project.id}`).expect(200)
      })
    })
  })
})

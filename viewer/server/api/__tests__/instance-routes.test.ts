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
import { generateOneTimeToken } from "../../auth/one-time-token"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { AuthProvider } from "../../auth/types"
import type { InstanceRole } from "../../storage/types"

/** Minimal fake — only its presence on `deps.github.authProvider` is exercised here. */
const fakeAuthProvider: AuthProvider = {
  authorizeUrl: () => "",
  async exchangeCode() {
    throw new Error("not used by these tests")
  },
}

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

/**
 * Redeem a one-time link the way a person does — fix wave 6.
 *
 * A link is two steps now: the GET renders an inert confirmation page and
 * touches no storage, and that page's form POSTs back to the SAME path to
 * redeem. Driving both halves here is what keeps the confirmation page on the
 * path a real click takes, and asserting the form's `action` is what stops the
 * page and the route from drifting apart.
 *
 * Returns the POST's response — the redemption — so every assertion these
 * tests already made about status, `Location` and `Set-Cookie` still reads the
 * same.
 *
 * `Sec-Fetch-Site: same-origin` on the POST — fix wave 7, item 3 — is what a
 * real browser sends submitting the confirmation page's own form. Without it
 * `requireDocumentNavigation` now refuses the redemption before it ever
 * reaches the token logic.
 */
async function redeem(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
) {
  const page = await request(app).get(path).set("Sec-Fetch-Dest", "document")
  expect(page.status, `GET ${path}`).toBe(200)
  expect(page.text, `GET ${path}`).toContain(`<form method="post" action="${path}">`)
  return request(app)
    .post(path)
    .set("Sec-Fetch-Dest", "document")
    .set("Sec-Fetch-Site", "same-origin")
    .set(headers)
}

describe("instance admin API (viewer-membership Task 6)", () => {
  let storage: InMemoryStorage
  let app: express.Express
  const config = authedConfig()

  // ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
  const stable = createSwappableApp()

  // A second stable app, used by exactly one test (the GitHub-configured
  // last-admin-floor case below) that needs a `github.authProvider` the
  // file's default `stable` app deliberately does not carry.
  const stableGithubConfigured = createSwappableApp()

  // A third stable app — the credential-revocation-atomicity tests below
  // (fix wave 10, item 3) build it on a storage PROXY that makes one
  // revocation call throw, so they cannot share `stable` (whose storage the
  // shared `beforeEach` below builds fresh, unwrapped, every test).
  const stableRevocationFailure = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
  })

  /** Seeds a user at `role` (default editor) + a live session, returns its `Cookie` header value. */
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

  describe("admin-only guard, spot-checked on every route", () => {
    it.each([
      ["GET", "/api/v1/instance/members"],
      ["PATCH", "/api/v1/instance/members/whoever"],
      ["DELETE", "/api/v1/instance/members/whoever"],
      ["POST", "/api/v1/instance/members/whoever/restore"],
      ["POST", "/api/v1/instance/invites"],
      ["GET", "/api/v1/instance/invites"],
      ["POST", "/api/v1/instance/invites/whoever/regenerate"],
      ["DELETE", "/api/v1/instance/invites/whoever"],
      ["GET", "/api/v1/instance/domain-rules"],
      ["PUT", "/api/v1/instance/domain-rules/example.com"],
      ["DELETE", "/api/v1/instance/domain-rules/example.com"],
      ["GET", "/api/v1/instance/settings"],
      ["PATCH", "/api/v1/instance/settings"],
    ] as const)("%s %s refuses an anonymous caller with 403 (no bearer, nothing to 401 about)", async (method, path) => {
      const res = await request(app)[method.toLowerCase() as "get"](path)
      expect(res.status).toBe(403)
    })

    it("refuses a signed-in VIEWER session with 403", async () => {
      const { cookie } = await signInAs("v@x.com", "viewer")
      await request(app).get("/api/v1/instance/members").set("Cookie", cookie).expect(403)
    })

    it("refuses a signed-in EDITOR session with 403", async () => {
      const { cookie } = await signInAs("e@x.com", "editor")
      await request(app).get("/api/v1/instance/members").set("Cookie", cookie).expect(403)
    })

    it("401s a garbage bearer rather than 403ing it", async () => {
      const res = await request(app).get("/api/v1/instance/members").set("Authorization", "Bearer nope")
      expect(res.status).toBe(401)
    })

    it("admits the admin token bearer", async () => {
      await request(app).get("/api/v1/instance/members").set(adminAuth).expect(200)
    })

    it("admits a signed-in ADMIN session", async () => {
      const { cookie } = await signInAs("a@x.com", "admin")
      await request(app).get("/api/v1/instance/members").set("Cookie", cookie).expect(200)
    })
  })

  describe("GET /instance/members", () => {
    it("lists members including removed ones, labeled", async () => {
      const { user: admin } = await signInAs("admin@x.com", "admin")
      const { user: gone } = await signInAs("gone@x.com", "editor")
      await storage.setUserStatus(gone.id, "removed")

      const res = await request(app).get("/api/v1/instance/members").set(adminAuth).expect(200)
      expect(res.body.members).toHaveLength(2)
      const view = res.body.members.find((m: { userId: string }) => m.userId === gone.id)
      expect(view).toMatchObject({
        userId: gone.id,
        email: "gone@x.com",
        displayName: "gone@x.com",
        role: "editor",
        status: "removed",
      })
      expect(typeof view.createdAt).toBe("string")
      const adminView = res.body.members.find((m: { userId: string }) => m.userId === admin.id)
      expect(adminView.status).toBe("active")
    })
  })

  describe("PATCH /instance/members/:userId", () => {
    it("updates a member's role", async () => {
      const { user } = await signInAs("e@x.com", "editor")
      const res = await request(app)
        .patch(`/api/v1/instance/members/${user.id}`)
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(200)
      expect(res.body.role).toBe("viewer")
      expect((await storage.getUser(user.id))?.role).toBe("viewer")
    })

    it("400s an invalid role", async () => {
      const { user } = await signInAs("e@x.com", "editor")
      const res = await request(app)
        .patch(`/api/v1/instance/members/${user.id}`)
        .set(adminAuth)
        .send({ role: "superadmin" })
        .expect(400)
      expect(res.body.error).toBeTruthy()
    })

    it("404s an unknown user", async () => {
      await request(app)
        .patch(`/api/v1/instance/members/nope`)
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(404)
    })

    it("409s demoting the ONLY active admin, with the exact spec message, and does not change the role", async () => {
      const { user: onlyAdmin } = await signInAs("boss@x.com", "admin")
      const res = await request(app)
        .patch(`/api/v1/instance/members/${onlyAdmin.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(409)
      expect(res.body).toEqual({ error: "There must be at least one admin." })
      expect((await storage.getUser(onlyAdmin.id))?.role).toBe("admin")
    })

    it("allows demoting one of TWO active admins", async () => {
      const { user: admin1 } = await signInAs("a1@x.com", "admin")
      await signInAs("a2@x.com", "admin")
      await request(app)
        .patch(`/api/v1/instance/members/${admin1.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(200)
      expect((await storage.getUser(admin1.id))?.role).toBe("editor")
    })

    it("allows patching the last admin's role to 'admin' (no-op, not a demotion)", async () => {
      const { user: onlyAdmin } = await signInAs("boss@x.com", "admin")
      await request(app)
        .patch(`/api/v1/instance/members/${onlyAdmin.id}`)
        .set(adminAuth)
        .send({ role: "admin" })
        .expect(200)
    })

    it("does not block demoting the last admin when a REMOVED admin also exists (removed admins don't count)", async () => {
      const { user: onlyActiveAdmin } = await signInAs("boss@x.com", "admin")
      const { user: removedAdmin } = await signInAs("gone@x.com", "admin")
      await storage.setUserStatus(removedAdmin.id, "removed")

      const res = await request(app)
        .patch(`/api/v1/instance/members/${onlyActiveAdmin.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(409)
      // Still refused — there is exactly one ACTIVE admin, and this removed
      // one does not count toward the guard's floor.
      expect(res.body.error).toBe("There must be at least one admin.")
    })

    /**
     * C2b: the local-operator row must not prop up the last-admin floor once
     * a real sign-in path exists to administer the instance through instead.
     * `operator@localhost` is unreachable the moment GitHub is configured —
     * counting it toward the floor would let the ONE reachable admin be
     * demoted, leaving an instance that LOOKS like it has an admin (the
     * operator row) but that nobody can sign in as any more.
     */
    it("ignores the local-operator row in the admin floor once GitHub sign-in is configured", async () => {
      const configuredStorage = new InMemoryStorage()
      stableGithubConfigured.use(
        createApp({
          storage: configuredStorage,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
        }),
      )

      await configuredStorage.createUser({
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      const githubAdmin = await upsertTestUser(configuredStorage, {
        provider: "github",
        providerUserId: "gh-1",
        email: "boss@x.com",
        displayName: "boss@x.com",
        avatarUrl: "",
        role: "admin",
      })

      const res = await request(stableGithubConfigured.app)
        .patch(`/api/v1/instance/members/${githubAdmin.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(409)
      expect(res.body).toEqual({ error: "There must be at least one admin." })
      expect((await configuredStorage.getUser(githubAdmin.id))?.role).toBe("admin")
    })

    it("counts the local-operator row when GitHub sign-in is NOT configured", async () => {
      // Same shape, but this file's default `beforeEach` app has no
      // `authProvider` — the state the very first boot is in. There the
      // operator row IS a reachable admin (the boot-printed URL), so it
      // legitimately counts toward the floor.
      await storage.createUser({
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      const { user: onlyOtherAdmin } = await signInAs("boss@x.com", "admin")

      await request(app)
        .patch(`/api/v1/instance/members/${onlyOtherAdmin.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(200)
      expect((await storage.getUser(onlyOtherAdmin.id))?.role).toBe("editor")
    })

    /**
     * Fix wave 7, item 1: the guard used to run for ANY active admin target,
     * even one `countActiveAdmins` already excludes from the count. Demoting
     * the operator itself is the sharpest case — the count is 1 (the human
     * admin) both BEFORE and AFTER this demotion, since the operator was
     * never in it, so refusing here was pure bug, not caution.
     */
    it("demotes the local-operator row itself once GitHub is configured — it never counted toward the floor", async () => {
      const configuredStorage = new InMemoryStorage()
      stableGithubConfigured.use(
        createApp({
          storage: configuredStorage,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
        }),
      )
      const operator = await configuredStorage.createUser({
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      await upsertTestUser(configuredStorage, {
        provider: "github",
        providerUserId: "gh-1",
        email: "boss@x.com",
        displayName: "boss@x.com",
        avatarUrl: "",
        role: "admin",
      })

      await request(stableGithubConfigured.app)
        .patch(`/api/v1/instance/members/${operator.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(200)
      expect((await configuredStorage.getUser(operator.id))?.role).toBe("editor")
    })

    /**
     * Fix wave 8, item 1: the exclusion above is only safe once some OTHER
     * admin exists to take over the floor. If GitHub gets configured (the
     * runtime Manifest flow) while the operator is still the ONLY admin,
     * excluding it unconditionally made this demotion succeed — deleting the
     * one live admin session with `/auth/local` already disabled and no
     * `role: "admin"` row left reachable. The operator must count toward the
     * floor here, the same as it does before GitHub is configured at all.
     */
    it("409s self-demoting the local-operator row when GitHub is configured but it is still the ONLY admin", async () => {
      const configuredStorage = new InMemoryStorage()
      stableGithubConfigured.use(
        createApp({
          storage: configuredStorage,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
        }),
      )
      const operator = await configuredStorage.createUser({
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })

      const res = await request(stableGithubConfigured.app)
        .patch(`/api/v1/instance/members/${operator.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(409)
      expect(res.body).toEqual({ error: "There must be at least one admin." })
      expect((await configuredStorage.getUser(operator.id))?.role).toBe("admin")
    })

    /**
     * The other half: once a human admin is added, the operator stops
     * counting again and its own demotion succeeds — same behaviour as the
     * two-admin case above, just reached by ADDING the second admin instead
     * of starting with it.
     */
    it("allows self-demoting the local-operator row once a human admin has been added", async () => {
      const configuredStorage = new InMemoryStorage()
      stableGithubConfigured.use(
        createApp({
          storage: configuredStorage,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
        }),
      )
      const operator = await configuredStorage.createUser({
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      await upsertTestUser(configuredStorage, {
        provider: "github",
        providerUserId: "gh-1",
        email: "boss@x.com",
        displayName: "boss@x.com",
        avatarUrl: "",
        role: "admin",
      })

      await request(stableGithubConfigured.app)
        .patch(`/api/v1/instance/members/${operator.id}`)
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(200)
      expect((await configuredStorage.getUser(operator.id))?.role).toBe("editor")
    })
  })

  describe("DELETE /instance/members/:userId", () => {
    it("soft-removes a member, kills their sessions and tokens immediately", async () => {
      await signInAs("boss@x.com", "admin")
      const { user: member, cookie: memberCookie } = await signInAs("m@x.com", "editor")

      await request(app).delete(`/api/v1/instance/members/${member.id}`).set(adminAuth).expect(204)

      expect((await storage.getUser(member.id))?.status).toBe("removed")
      const me = await request(app).get("/api/v1/me").set("Cookie", memberCookie)
      expect(me.body.user).toBeNull()
    })

    it("409s removing the ONLY active admin, and does not remove them", async () => {
      const { user: onlyAdmin } = await signInAs("boss@x.com", "admin")
      const res = await request(app)
        .delete(`/api/v1/instance/members/${onlyAdmin.id}`)
        .set(adminAuth)
        .expect(409)
      expect(res.body).toEqual({ error: "There must be at least one admin." })
      expect((await storage.getUser(onlyAdmin.id))?.status).toBe("active")
    })

    it("allows removing one of TWO active admins", async () => {
      const { user: admin1 } = await signInAs("a1@x.com", "admin")
      await signInAs("a2@x.com", "admin")
      await request(app).delete(`/api/v1/instance/members/${admin1.id}`).set(adminAuth).expect(204)
      expect((await storage.getUser(admin1.id))?.status).toBe("removed")
    })

    /**
     * Fix wave 7, item 1 — the DELETE sibling of the PATCH case above. Same
     * bug, same fix: the guard used to run for the operator target itself,
     * even though `countActiveAdmins` already excludes that row once GitHub
     * is configured, so removing it 409'd against a count it could never
     * change.
     */
    describe("with GitHub configured and an excluded local-operator row", () => {
      async function setup() {
        const configuredStorage = new InMemoryStorage()
        stableGithubConfigured.use(
          createApp({
            storage: configuredStorage,
            assets: nullAssets,
            config,
            bridgeScript: "// bridge",
            github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
          }),
        )
        const operator = await configuredStorage.createUser({
          provider: "github",
          providerUserId: "local-operator",
          email: "operator@localhost",
          displayName: "Local operator",
          avatarUrl: "",
          role: "admin",
        })
        const humanAdmin = await upsertTestUser(configuredStorage, {
          provider: "github",
          providerUserId: "gh-1",
          email: "boss@x.com",
          displayName: "boss@x.com",
          avatarUrl: "",
          role: "admin",
        })
        return { storage: configuredStorage, app: stableGithubConfigured.app, operator, humanAdmin }
      }

      it("removes the local-operator row itself — it never counted toward the floor", async () => {
        const { storage: configuredStorage, app: configuredApp, operator } = await setup()

        await request(configuredApp)
          .delete(`/api/v1/instance/members/${operator.id}`)
          .set(adminAuth)
          .expect(204)
        expect((await configuredStorage.getUser(operator.id))?.status).toBe("removed")
      })

      it("still 409s removing the human admin — they are the only counted admin left", async () => {
        const { storage: configuredStorage, app: configuredApp, humanAdmin } = await setup()

        const res = await request(configuredApp)
          .delete(`/api/v1/instance/members/${humanAdmin.id}`)
          .set(adminAuth)
          .expect(409)
        expect(res.body).toEqual({ error: "There must be at least one admin." })
        expect((await configuredStorage.getUser(humanAdmin.id))?.status).toBe("active")
      })
    })

    /**
     * Fix wave 8, item 1 — the DELETE sibling of the PATCH lockout case
     * above. Before this fix, GitHub-configured-but-operator-is-the-only-admin
     * removed itself successfully: the operator's own row was excluded from
     * the count unconditionally, so `isCountedActiveAdmin` skipped the guard
     * and the removal deleted the last reachable admin session, with
     * `/auth/local` already disabled by GitHub being configured.
     */
    describe("with GitHub configured and the local-operator row as the ONLY admin", () => {
      async function setup() {
        const configuredStorage = new InMemoryStorage()
        stableGithubConfigured.use(
          createApp({
            storage: configuredStorage,
            assets: nullAssets,
            config,
            bridgeScript: "// bridge",
            github: testGithubRuntime({ overrides: { authProvider: fakeAuthProvider } }),
          }),
        )
        const operator = await configuredStorage.createUser({
          provider: "github",
          providerUserId: "local-operator",
          email: "operator@localhost",
          displayName: "Local operator",
          avatarUrl: "",
          role: "admin",
        })
        return { storage: configuredStorage, app: stableGithubConfigured.app, operator }
      }

      it("409s self-removing the operator row — it is the only admin, counted or not", async () => {
        const { storage: configuredStorage, app: configuredApp, operator } = await setup()

        const res = await request(configuredApp)
          .delete(`/api/v1/instance/members/${operator.id}`)
          .set(adminAuth)
          .expect(409)
        expect(res.body).toEqual({ error: "There must be at least one admin." })
        expect((await configuredStorage.getUser(operator.id))?.status).toBe("active")
      })

      it("allows removing the operator row once a human admin has been added", async () => {
        const { storage: configuredStorage, app: configuredApp, operator } = await setup()
        await upsertTestUser(configuredStorage, {
          provider: "github",
          providerUserId: "gh-1",
          email: "boss@x.com",
          displayName: "boss@x.com",
          avatarUrl: "",
          role: "admin",
        })

        await request(configuredApp)
          .delete(`/api/v1/instance/members/${operator.id}`)
          .set(adminAuth)
          .expect(204)
        expect((await configuredStorage.getUser(operator.id))?.status).toBe("removed")
      })
    })

    it("is idempotent on an already-removed user", async () => {
      await signInAs("boss@x.com", "admin")
      const { user: member } = await signInAs("m@x.com", "editor")
      await request(app).delete(`/api/v1/instance/members/${member.id}`).set(adminAuth).expect(204)
      await request(app).delete(`/api/v1/instance/members/${member.id}`).set(adminAuth).expect(204)
      expect((await storage.getUser(member.id))?.status).toBe("removed")
    })

    it("404s an unknown user", async () => {
      await signInAs("boss@x.com", "admin")
      await request(app).delete(`/api/v1/instance/members/nope`).set(adminAuth).expect(404)
    })
  })

  describe("POST /instance/members/:userId/restore", () => {
    it("un-removes a member", async () => {
      await signInAs("boss@x.com", "admin")
      const { user: member } = await signInAs("m@x.com", "editor")
      await storage.setUserStatus(member.id, "removed")

      const res = await request(app)
        .post(`/api/v1/instance/members/${member.id}/restore`)
        .set(adminAuth)
        .expect(200)
      expect(res.body.status).toBe("active")
      expect((await storage.getUser(member.id))?.status).toBe("active")
    })

    it("404s an unknown user", async () => {
      await request(app).post(`/api/v1/instance/members/nope/restore`).set(adminAuth).expect(404)
    })

    /**
     * Fix wave 10, item 3. Restore now sweeps credentials again BEFORE
     * reactivating — insurance against a prior removal that itself only
     * partially revoked (see the DELETE describe block below). A stale
     * machine token left over from before the removal must not still work
     * once the account is active again.
     */
    it("sweeps credentials again before reactivating — the member comes back with zero", async () => {
      await signInAs("boss4@x.com", "admin")
      const { user: member } = await signInAs("m4@x.com", "editor")
      await storage.createMachineToken({
        id: "1234567890abcdef",
        userId: member.id,
        name: "stale",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })
      await storage.setUserStatus(member.id, "removed")

      const res = await request(app)
        .post(`/api/v1/instance/members/${member.id}/restore`)
        .set(adminAuth)
        .expect(200)
      expect(res.body.status).toBe("active")
      expect((await storage.getUser(member.id))?.status).toBe("active")
      expect(await storage.listMachineTokensForUser(member.id)).toHaveLength(0)
    })

    /**
     * Fix wave 11, item 3. Restoring an account that is ALREADY active must
     * be a no-op that does NOT sweep — the sweep above is destructive
     * (deletes every PAT and session), and running it on a live member wipes
     * their credentials for no reason. This fires on a direct call, or on a
     * stale members list where another admin already restored this person
     * and this admin clicks Restore again.
     */
    it("is a no-op on an already-active member and does NOT sweep their credentials", async () => {
      await signInAs("boss-noop@x.com", "admin")
      const { user: member, cookie: memberCookie } = await signInAs("active@x.com", "editor")
      // The member is ACTIVE (never removed) and holds a live PAT + a live
      // session (the cookie `signInAs` returned).
      await storage.createMachineToken({
        id: "feedface0000cafe",
        userId: member.id,
        name: "ci",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })

      const res = await request(app)
        .post(`/api/v1/instance/members/${member.id}/restore`)
        .set(adminAuth)
        .expect(200)
      expect(res.body.status).toBe("active")

      // Neither credential was swept.
      expect(await storage.listMachineTokensForUser(member.id)).toHaveLength(1)
      const me = await request(app).get("/api/v1/me").set("Cookie", memberCookie)
      expect(me.body.user).not.toBeNull()
    })
  })

  /**
   * Fix wave 10, item 3 — `credential-revocation.ts`. Both routes above now
   * run their four revocations via `Promise.allSettled` instead of a
   * sequential await chain, so one failing does not silently leave the
   * others un-attempted, and both surface the failure as a 500 rather than
   * reporting success on an account still not fully locked out.
   */
  describe("credential revocation is atomic (fix wave 10, item 3)", () => {
    /** Wraps a real StorageAdapter but makes ONE method always throw — same technique `gate.test.ts`'s `withMethod` uses. */
    function withThrowingMethod<K extends keyof InMemoryStorage>(
      inner: InMemoryStorage,
      method: K,
      error: Error,
    ): InMemoryStorage {
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === method) {
            return async () => {
              throw error
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }) as InMemoryStorage
    }

    it("DELETE 500s when one revocation fails, but leaves status removed and still revokes the rest", async () => {
      const { user: member, cookie: memberCookie } = await signInAs("m5@x.com", "editor")
      await signInAs("boss5@x.com", "admin")
      await storage.createMachineToken({
        id: "abcdef1234567890",
        userId: member.id,
        name: "ci",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })
      const userLinkedSignIn = await storage.createSignInToken({
        id: "sit-user-1",
        userId: member.id,
        email: null,
        tokenHash: "h1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const emailLinkedSignIn = await storage.createSignInToken({
        id: "sit-email-1",
        userId: null,
        email: member.email,
        tokenHash: "h2",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })

      const boom = new Error("simulated machine-token deletion failure")
      const failing = withThrowingMethod(storage, "deleteMachineTokensForUser", boom)
      stableRevocationFailure.use(
        createApp({
          storage: failing,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime(),
        }),
      )
      const failingApp = stableRevocationFailure.app

      const res = await request(failingApp)
        .delete(`/api/v1/instance/members/${member.id}`)
        .set(adminAuth)
        .expect(500)
      expect(res.body).toEqual({
        error: "Member was removed, but some credentials could not be revoked. Try again.",
      })

      // Removed regardless — a soft delete that could not fully revoke
      // credentials is still not rolled back to active.
      expect((await storage.getUser(member.id))?.status).toBe("removed")
      // Sessions ran and succeeded (a DIFFERENT step than the throwing one).
      const me = await request(failingApp).get("/api/v1/me").set("Cookie", memberCookie)
      expect(me.body.user).toBeNull()
      // Both sign-in-token deletions come AFTER the throwing machine-token
      // deletion in call order, and still ran — `Promise.allSettled`, not a
      // sequential chain that stops at the first throw.
      expect(await storage.getSignInToken(userLinkedSignIn.id)).toBeNull()
      expect(await storage.getSignInToken(emailLinkedSignIn.id)).toBeNull()
      // The one thing that actually failed to delete is still there.
      expect(await storage.listMachineTokensForUser(member.id)).toHaveLength(1)
    })

    it("restore 500s when a revocation fails and does not reactivate", async () => {
      const { user: member } = await signInAs("m6@x.com", "editor")
      await signInAs("boss6@x.com", "admin")
      await storage.setUserStatus(member.id, "removed")

      const boom = new Error("simulated session deletion failure")
      const failing = withThrowingMethod(storage, "deleteSessionsForUser", boom)
      stableRevocationFailure.use(
        createApp({
          storage: failing,
          assets: nullAssets,
          config,
          bridgeScript: "// bridge",
          github: testGithubRuntime(),
        }),
      )
      const failingApp = stableRevocationFailure.app

      const res = await request(failingApp)
        .post(`/api/v1/instance/members/${member.id}/restore`)
        .set(adminAuth)
        .expect(500)
      expect(res.body).toEqual({
        error: "Could not restore this member. Some credentials could not be revoked. Try again.",
      })
      expect((await storage.getUser(member.id))?.status).toBe("removed")
    })
  })

  describe("POST /instance/invites", () => {
    it("creates an invite and returns the plaintext URL exactly once", async () => {
      const res = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "new@x.com", role: "editor" })
        .expect(201)

      expect(res.body.invite).toMatchObject({ email: "new@x.com", role: "editor", state: "pending" })
      expect(res.body.invite).not.toHaveProperty("tokenHash")
      // `/api/v1` IS part of the route — the invite-acceptance handler is
      // registered like every other route in this router (mounted under
      // `/api/v1`), not at a bare `/auth/invite/*` Next path. A URL missing
      // that prefix looks plausible and 404s in the browser; see the
      // "closes the class" test below.
      expect(res.body.url).toMatch(
        /^http:\/\/localhost:3100\/api\/v1\/auth\/invite\/dsi_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/,
      )

      // The stored row never carries the plaintext.
      const stored = await storage.listInstanceInvites()
      expect(stored).toHaveLength(1)
      expect(stored[0].tokenHash).not.toBe(res.body.url)
    })

    /**
     * Fix (live boot smoke): the plan's URL template
     * (`${requestOrigin}/auth/invite/${token}`) disagreed with its own
     * wiring facts (the route mounts at `/api/v1/auth/invite/<token>`).
     * Earlier tests in this file extracted the TOKEN out of `url` via
     * `.split("/auth/invite/")` and built their own `/api/v1/...` request
     * path by hand — which exercises the real route, but can never catch a
     * bug in how `url` itself is constructed, because it never asks the
     * app to resolve `url` as a path. This test does exactly that: take
     * the returned `url` verbatim, keep only its path, and GET THAT PATH
     * on the same app. If the constructed URL and the registered route
     * ever drift apart again, this fails with a 404 instead of a green
     * suite hiding a link that 404s for a real user.
     */
    it("the returned url's PATH, hit directly as a document navigation, resolves to a real sign-in (closes the class, not just the instance)", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "resolvable@x.com", role: "editor" })
        .expect(201)

      const path = new URL(created.body.url).pathname
      // The url the response reveals is the CONFIRMATION PAGE's path, and the
      // page's own form posts back to it. `redeem` drives both halves, so a
      // url built against the wrong mount still fails here — now on the GET.
      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? []
      expect(setCookie.some((c) => c.startsWith("viewer_session="))).toBe(true)
    })

    it("stamps createdByUserId with the admin bearer's null identity, never an invented id", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "new@x.com", role: "editor" })
        .expect(201)
      const [invite] = await storage.listInstanceInvites()
      expect(invite.createdByUserId).toBeNull()
    })

    it("stamps createdByUserId with the signed-in admin's id", async () => {
      const { user: admin, cookie } = await signInAs("boss@x.com", "admin")
      await request(app)
        .post("/api/v1/instance/invites")
        .set("Cookie", cookie)
        .send({ email: "new@x.com", role: "editor" })
        .expect(201)
      const [invite] = await storage.listInstanceInvites()
      expect(invite.createdByUserId).toBe(admin.id)
    })

    it("400s an invalid email", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "not-an-email", role: "editor" })
        .expect(400)
    })

    it("400s a missing or invalid role", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "new@x.com" })
        .expect(400)
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "new@x.com", role: "superadmin" })
        .expect(400)
    })

    it("409s a second invite for the same (unexpired, unused) email", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "dup@x.com", role: "editor" })
        .expect(201)
      const res = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "dup@x.com", role: "viewer" })
        .expect(409)
      expect(res.body.error).toBeTruthy()
    })

    it("allows a new invite once the previous one for that email was revoked", async () => {
      const first = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "dup@x.com", role: "editor" })
        .expect(201)
      await request(app).delete(`/api/v1/instance/invites/${first.body.invite.id}`).set(adminAuth).expect(204)
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "dup@x.com", role: "viewer" })
        .expect(201)
    })

    it("email match for the 409 check is case-insensitive", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "Case@X.com", role: "editor" })
        .expect(201)
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "case@x.com", role: "viewer" })
        .expect(409)
    })

    /**
     * I1: inviting an email that already has an ACTIVE account creates a
     * pending invite that does nothing useful — `admitSignIn`'s rung 1
     * (existing account) matches before rung 2 (the invite) ever runs, so
     * the invite just sits there unclaimed while the person signs in at
     * their EXISTING role. Refusing at creation time points the admin at
     * the tool that actually does something for an existing member: a
     * sign-in link.
     */
    it("409s inviting an email that already belongs to an ACTIVE member", async () => {
      await signInAs("already@x.com", "editor")
      const res = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "already@x.com", role: "admin" })
        .expect(409)
      expect(res.body).toEqual({
        error: "That address already belongs to a member. Mint a sign-in link instead.",
      })
      expect(await storage.listInstanceInvites()).toHaveLength(0)
    })

    /**
     * I1: inviting a REMOVED member's email is a trap — `admitSignIn` rung 1
     * refuses a removed account unconditionally, before the invite is ever
     * consulted, so the mailed invite would be a dead link no matter what
     * the admin intended. Refusing at creation time points at restoring the
     * member instead of minting a link that can never work.
     */
    it("409s inviting an email that belongs to a REMOVED member", async () => {
      const { user } = await signInAs("gone@x.com", "editor")
      await storage.setUserStatus(user.id, "removed")
      const res = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "gone@x.com", role: "editor" })
        .expect(409)
      expect(res.body).toEqual({
        error: "That address belongs to a removed member. Restore them instead.",
      })
      expect(await storage.listInstanceInvites()).toHaveLength(0)
    })
  })

  describe("GET /instance/invites", () => {
    it("derives state: pending, used, revoked, expired — and never sends the hash", async () => {
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "pending@x.com", role: "editor" })
        .expect(201)

      const toRevoke = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "revoked@x.com", role: "editor" })
        .expect(201)
      await request(app).delete(`/api/v1/instance/invites/${toRevoke.body.invite.id}`).set(adminAuth).expect(204)

      const minted = generateOneTimeToken("dsi")
      await storage.createInstanceInvite({
        id: minted.id,
        email: "expired@x.com",
        role: "editor",
        tokenHash: minted.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })

      const used = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "used@x.com", role: "editor" })
        .expect(201)
      const usedToken = used.body.url.split("/auth/invite/")[1]
      expect((await redeem(app, `/api/v1/auth/invite/${usedToken}`)).status).toBe(302)

      const res = await request(app).get("/api/v1/instance/invites").set(adminAuth).expect(200)
      const byEmail = Object.fromEntries(
        res.body.invites.map((i: { email: string; state: string }) => [i.email, i.state]),
      )
      expect(byEmail["pending@x.com"]).toBe("pending")
      expect(byEmail["revoked@x.com"]).toBe("revoked")
      expect(byEmail["expired@x.com"]).toBe("expired")
      expect(byEmail["used@x.com"]).toBe("used")
      for (const invite of res.body.invites) {
        expect(invite).not.toHaveProperty("tokenHash")
      }
    })
  })

  describe("POST /instance/invites/:id/regenerate", () => {
    it("mints a new token that invalidates the old one", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "re@x.com", role: "editor" })
        .expect(201)
      const oldToken = created.body.url.split("/auth/invite/")[1]

      const regenerated = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(200)
      const newToken = regenerated.body.url.split("/auth/invite/")[1]
      expect(newToken).not.toBe(oldToken)
      // Same row id, per the storage contract (never mints a new id).
      expect(regenerated.body.invite.id).toBe(created.body.invite.id)

      // The OLD link 404s the row lookup effectively — the gate treats it as
      // invalid and redirects to /denied rather than admitting.
      const staleAttempt = await redeem(app, `/api/v1/auth/invite/${oldToken}`)
      expect(staleAttempt.status).toBe(302)
      expect(staleAttempt.headers.location).toBe("/denied?reason=invite-invalid")

      // The NEW link works.
      const freshAttempt = await redeem(app, `/api/v1/auth/invite/${newToken}`)
      expect(freshAttempt.status).toBe(302)
      expect(freshAttempt.headers.location).toBe("/")
    })

    it("revives a used/revoked invite so it becomes pending again", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "revive@x.com", role: "editor" })
        .expect(201)
      await request(app).delete(`/api/v1/instance/invites/${created.body.invite.id}`).set(adminAuth).expect(204)

      const res = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(200)
      expect(res.body.invite.state).toBe("pending")
    })

    it("404s an unknown invite id", async () => {
      await request(app).post(`/api/v1/instance/invites/nope/regenerate`).set(adminAuth).expect(404)
    })

    /**
     * I1: the same existing-account guard `POST /instance/invites` applies
     * here too — an invite whose email has since gained an ACTIVE account
     * (the person signed up some other way while the invite sat unused)
     * must not be handed a fresh 7-day token. Point at a sign-in link.
     */
    it("409s regenerating an invite whose email now belongs to an ACTIVE member", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "became-a-member@x.com", role: "editor" })
        .expect(201)
      await signInAs("became-a-member@x.com", "viewer")

      const res = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(409)
      expect(res.body).toEqual({
        error: "That address already belongs to a member. Mint a sign-in link instead.",
      })
    })

    it("409s regenerating an invite whose email now belongs to a REMOVED member", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "became-removed@x.com", role: "editor" })
        .expect(201)
      const { user } = await signInAs("became-removed@x.com", "viewer")
      await storage.setUserStatus(user.id, "removed")

      const res = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(409)
      expect(res.body).toEqual({
        error: "That address belongs to a removed member. Restore them instead.",
      })
    })
  })

  describe("DELETE /instance/invites/:id", () => {
    it("revokes, idempotently", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "rv@x.com", role: "editor" })
        .expect(201)
      await request(app).delete(`/api/v1/instance/invites/${created.body.invite.id}`).set(adminAuth).expect(204)
      await request(app).delete(`/api/v1/instance/invites/${created.body.invite.id}`).set(adminAuth).expect(204)
      expect((await storage.getInstanceInvite(created.body.invite.id))?.revokedAt).toBeTruthy()
    })

    it("is idempotent (204) on an unknown id too", async () => {
      await request(app).delete(`/api/v1/instance/invites/nope`).set(adminAuth).expect(204)
    })
  })

  describe("invite accept → sign-in round trip", () => {
    it("creates a NEW account at the invite's role and signs them in", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "brandnew@x.com", role: "viewer" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const res = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? []
      expect(setCookie.some((c) => c.startsWith("viewer_session="))).toBe(true)

      const user = await storage.getUserByEmail("brandnew@x.com")
      expect(user?.role).toBe("viewer")
      expect(user?.provider).toBe("email")
    })

    // Carried note from Task 4/5: an invite accepted for an email that
    // ALREADY has an account signs the caller in as that account via the
    // gate's rung 1, and the invite's role does NOT elevate the existing
    // account.
    //
    // I1: `POST /instance/invites` now refuses to CREATE an invite for an
    // email that already has an active account, so this scenario can only
    // arise the other way round — the invite is minted FIRST, while the
    // address has no account yet, and the person gets an account through
    // some other door (GitHub, a domain rule) before ever clicking it. The
    // invite is still UNUSED at that point, so clicking it still reaches the
    // gate exactly as before.
    it("an existing editor accepting an admin-role invite for their own email stays editor, same account, signed in", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "already@x.com", role: "admin" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]
      const { user: existing } = await signInAs("already@x.com", "editor")

      const res = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")

      const setCookie = (res.headers["set-cookie"] as unknown as string[]) ?? []
      const sessionCookie = setCookie.find((c) => c.startsWith("viewer_session="))!.split(";")[0]
      const me = await request(app).get("/api/v1/me").set("Cookie", sessionCookie)
      expect(me.body.user.id).toBe(existing.id)
      expect(me.body.user.role).toBe("editor")
      expect(await storage.countUsers()).toBe(1)
    })

    /**
     * I1: used invite links are SPENT. The second click no longer re-runs
     * the gate at all — it is intercepted the moment `usedAt` is set, and
     * the only thing it still does is recognise a caller who is ALREADY
     * signed in as the exact account the first click created. Carrying that
     * SAME session forward is a convenience (a stale tab, a double-click),
     * not a second admission.
     */
    it("double-accept with the SAME session still carried: redirects home, mints nothing new", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "twice@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const first = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(first.status).toBe(302)
      expect(first.headers.location).toBe("/")
      const setCookie = (first.headers["set-cookie"] as unknown as string[]) ?? []
      const sessionCookie = setCookie.find((c) => c.startsWith("viewer_session="))!.split(";")[0]

      const second = await redeem(app, `/api/v1/auth/invite/${token}`, { Cookie: sessionCookie })
      expect(second.status).toBe(302)
      expect(second.headers.location).toBe("/")

      expect(await storage.countUsers()).toBe(1)
    })

    it("a spent invite refuses a second click carrying no matching session", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "spent@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const first = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(first.status).toBe(302)
      expect(first.headers.location).toBe("/")

      // No cookie at all — a different browser (or the same one, signed
      // out) presenting the exact same link a second time.
      const second = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(second.status).toBe(302)
      expect(second.headers.location).toBe("/denied?reason=invite-invalid")

      expect(await storage.countUsers()).toBe(1)
    })

    it("a spent invite refuses a click carrying a DIFFERENT signed-in session too", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "spent2@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]
      expect((await redeem(app, `/api/v1/auth/invite/${token}`)).status).toBe(302)

      const { cookie: otherCookie } = await signInAs("someone-else@x.com", "viewer")

      const res = await redeem(app, `/api/v1/auth/invite/${token}`, { Cookie: otherCookie })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=invite-invalid")
    })

    it("expired invite redirects to /denied?reason=invite-invalid and creates no account", async () => {
      const minted = generateOneTimeToken("dsi")
      await storage.createInstanceInvite({
        id: minted.id,
        email: "stale@x.com",
        role: "editor",
        tokenHash: minted.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })

      const res = await redeem(app, `/api/v1/auth/invite/${minted.token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=invite-invalid")
      expect(await storage.getUserByEmail("stale@x.com")).toBeNull()
    })

    it("revoked invite redirects to /denied?reason=invite-invalid", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "revme@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]
      await request(app).delete(`/api/v1/instance/invites/${created.body.invite.id}`).set(adminAuth).expect(204)

      const res = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=invite-invalid")
    })

    it("a malformed token redirects to /denied?reason=invite-invalid rather than 404ing or 500ing", async () => {
      const res = await request(app)
        .post(`/api/v1/auth/invite/garbage-token`)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=invite-invalid")
    })

    /**
     * The GET's own answer to a malformed token: a 404 page, not the
     * confirmation form. That is not an oracle — `parseOneTimeToken` is a pure
     * function of the string the caller already holds, so it says nothing
     * about which links exist. What it must NOT do is offer a button that
     * could only ever fail.
     */
    it("the confirmation page 404s a token that is not even well-formed", async () => {
      const res = await request(app)
        .get(`/api/v1/auth/invite/garbage-token`)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(404)
      expect(res.text).not.toContain("<form")
    })

    /**
     * I1's account-existence guard means an invite can no longer be CREATED
     * for an email that already belongs to an account (active or removed).
     * So to reach the gate's own "removed" refusal through this door, the
     * invite has to predate the removal: minted while the address had no
     * account, left UNUSED while the person gets an account some other way,
     * then that account is removed before the (still-unused) invite is ever
     * clicked.
     */
    it("a REMOVED user's still-pending invite is refused via the gate — generic /denied, no reason leaked", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "removeme@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const { user } = await signInAs("removeme@x.com", "editor")
      await storage.setUserStatus(user.id, "removed")

      const res = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied")
    })

    /**
     * Fix wave M1 review. Audit K08's rule ("refusing the new sign-in is not
     * enough — outstanding credentials outlive the removal") was wired for the
     * GitHub callback's removed-refusal but not for this one, even though both
     * run through the identical gate rung. A removed account clicking an OLD
     * invite link kept its live session and PAT fully working, because
     * nothing on this path ever called the revocation. Still reachable after
     * I1: the invite here is UNUSED right up to this one click — see the
     * comment on the test above for why it has to be built that way now.
     */
    it("a REMOVED user's still-pending invite click also revokes their live session and PAT", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "revokeme@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const { user } = await signInAs("revokeme@x.com", "editor")
      // A live session distinct from the one an accept would mint, plus a
      // PAT — the two credential kinds audit K08 covers.
      const liveSession = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      await storage.createMachineToken({
        id: "fedcba9876543210",
        userId: user.id,
        name: "ci",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })
      await storage.setUserStatus(user.id, "removed")

      const res = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied")

      expect(await storage.getSession(liveSession.id)).toBeNull()
      expect(await storage.listMachineTokensForUser(user.id)).toHaveLength(0)
      // The row itself survives — `removed` is a soft delete.
      expect((await storage.getUser(user.id))?.status).toBe("removed")
    })

    it("survives the document-destination guard, which is how a pasted invite link arrives", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "pasted@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const page = await request(app)
        .get(`/api/v1/auth/invite/${token}`)
        .set("Sec-Fetch-Dest", "document")
      expect(page.status).toBe(200)

      const res = await request(app)
        .post(`/api/v1/auth/invite/${token}`)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
    })

    it("does not extend the document-guard exemption to a path nested one level under it", async () => {
      const res = await request(app)
        .get(`/api/v1/auth/invite/some-token/extra`)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
    })

    it("does not extend it for the POST half either", async () => {
      const res = await request(app)
        .post(`/api/v1/auth/invite/some-token/extra`)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
    })

    /**
     * Important fix (code review): a hostile/compromised same-origin
     * prototype (path mode) can embed `<iframe src="/api/v1/auth/invite/
     * <token>">` with no click and nothing visible. Before this fix the
     * guard exempted `/auth/invite/<token>` for ANY of
     * document/iframe/frame/object/embed, so that iframe would silently
     * claim the invite and swap the visitor's session cookie to the
     * invited account. The exemption is now `document`-only — a real
     * invite-link click is always a top-level navigation, never a nested
     * browsing context — so this must 403, mint no session, and leave the
     * invite unclaimed for the real recipient to use.
     */
    it.each(["iframe", "frame", "object", "embed"])(
      "refuses to claim the invite when it arrives framed as %s — no cookie, invite stays unclaimed",
      async (dest) => {
        const created = await request(app)
          .post("/api/v1/instance/invites")
          .set(adminAuth)
          .send({ email: `framed-${dest}@x.com`, role: "editor" })
          .expect(201)
        const token = created.body.url.split("/auth/invite/")[1]

        // Both halves. The GET is inert now, so the one that would actually
        // spend the invite is the POST — a framed page can submit a form as
        // easily as it can set a `src`, and the guard has to refuse both.
        for (const verb of ["get", "post"] as const) {
          const res = await request(app)
            [verb](`/api/v1/auth/invite/${token}`)
            .set("Sec-Fetch-Dest", dest)
          expect(res.status, verb).toBe(403)
          expect(res.headers["set-cookie"], verb).toBeUndefined()
        }
        expect(await storage.getUserByEmail(`framed-${dest}@x.com`)).toBeNull()
        expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
      },
    )

    it("the SAME token still works as a top-level document navigation after being refused as an iframe", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "still-works@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const framed = await request(app)
        .post(`/api/v1/auth/invite/${token}`)
        .set("Sec-Fetch-Dest", "iframe")
      expect(framed.status).toBe(403)

      const clicked = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(clicked.status).toBe(302)
      expect(clicked.headers.location).toBe("/")
      expect(await storage.getUserByEmail("still-works@x.com")).not.toBeNull()
    })

    /**
     * Fix wave 6 — the reason the GET/POST split exists.
     *
     * An invite URL sitting in a mailbox is fetched by things that are not the
     * recipient: Slack and iMessage unfurl it, Gmail/Outlook security scanners
     * fetch every link before delivery, corporate gateways rewrite-and-
     * prefetch. Each of those is a GET, and while the GET redeemed, each of
     * them burned the invite — the person then clicked a link that was already
     * spent, and every failure looks identical by design, so they could not
     * even tell why.
     */
    it("a bare GET does not claim the invite — the link is still usable afterwards", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "unfurled@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      // Three of them, as a preview bot and two scanners would.
      for (let i = 0; i < 3; i += 1) {
        const page = await request(app)
          .get(`/api/v1/auth/invite/${token}`)
          .set("Sec-Fetch-Dest", "document")
        expect(page.status).toBe(200)
      }
      expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
      expect(await storage.getUserByEmail("unfurled@x.com")).toBeNull()

      // …and the real click still works.
      const clicked = await redeem(app, `/api/v1/auth/invite/${token}`)
      expect(clicked.status).toBe(302)
      expect(clicked.headers.location).toBe("/")
      expect(await storage.getUserByEmail("unfurled@x.com")).not.toBeNull()
    })

    /**
     * The page must not become the membership oracle the `/denied` redirect is
     * careful not to be. A live invite and a random well-formed token differ
     * ONLY in the token itself — nothing about existence, expiry or revocation
     * reaches the body, because nothing about them is looked up.
     */
    it("renders the same page for a live invite and a random well-formed token", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "real@x.com", role: "editor" })
        .expect(201)
      const real = created.body.url.split("/auth/invite/")[1]
      const bogus = generateOneTimeToken("dsi").token

      const realPage = await request(app)
        .get(`/api/v1/auth/invite/${real}`)
        .set("Sec-Fetch-Dest", "document")
      const bogusPage = await request(app)
        .get(`/api/v1/auth/invite/${bogus}`)
        .set("Sec-Fetch-Dest", "document")

      expect(realPage.status).toBe(bogusPage.status)
      // Identical once each page's own token is normalized out — the form's
      // `action` is the only thing that can differ, because it is the only
      // place the token appears.
      expect(realPage.text.replaceAll(real, "TOKEN")).toBe(
        bogusPage.text.replaceAll(bogus, "TOKEN"),
      )
      // Nothing was spent proving it.
      expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
    })

    it("serves the confirmation page with no-store — the URL is a credential", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "nostore@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const page = await request(app)
        .get(`/api/v1/auth/invite/${token}`)
        .set("Sec-Fetch-Dest", "document")
      expect(page.headers["cache-control"]).toBe("no-store")
      expect(page.text).toContain(`<meta name="robots" content="noindex">`)
    })

    /**
     * The document-destination guard fails OPEN on an absent `Sec-Fetch-Dest`,
     * which is right for a read and wrong for the one request that spends a
     * credential — "no Sec-Fetch headers at all" is exactly what a scripted or
     * scanner-issued POST looks like. So the redemption route requires the
     * header itself, and refuses BEFORE claiming.
     */
    it("refuses a POST that carries no Sec-Fetch-Dest, and claims nothing", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "scripted@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const res = await request(app).post(`/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(403)
      expect(res.headers["set-cookie"]).toBeUndefined()
      expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
      expect(await storage.getUserByEmail("scripted@x.com")).toBeNull()

      // Still redeemable by the person it was for.
      expect((await redeem(app, `/api/v1/auth/invite/${token}`)).status).toBe(302)
    })

    /**
     * Fix wave 7, item 3. `Sec-Fetch-Dest: document` alone says the request
     * is a top-level navigation — it does not say WHERE FROM. A cross-site
     * page can carry a real `<a href>` or an auto-submitting form to this
     * exact path and produce `document` too; `Sec-Fetch-Site` is the header
     * that tells the two apart, and only the confirmation page's own form
     * submit is same-origin. Absent is refused the same as cross-site — same
     * reasoning as the dest check just above.
     */
    it("refuses a cross-site POST even with Sec-Fetch-Dest: document, and claims nothing", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "crosssite@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const res = await request(app)
        .post(`/api/v1/auth/invite/${token}`)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "cross-site")
      expect(res.status).toBe(403)
      expect(res.headers["set-cookie"]).toBeUndefined()
      expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
      expect(await storage.getUserByEmail("crosssite@x.com")).toBeNull()

      // Still redeemable by the person it was for.
      expect((await redeem(app, `/api/v1/auth/invite/${token}`)).status).toBe(302)
    })

    it("refuses a POST with Sec-Fetch-Dest: document but no Sec-Fetch-Site, and claims nothing", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "nositeheader@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const res = await request(app).post(`/api/v1/auth/invite/${token}`).set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
      expect(res.headers["set-cookie"]).toBeUndefined()
      expect((await storage.getInstanceInvite(created.body.invite.id))?.usedAt).toBeNull()
      expect(await storage.getUserByEmail("nositeheader@x.com")).toBeNull()
    })

    /**
     * Fix wave 7, item 4. A browser old enough to send no Fetch Metadata
     * headers at all (pre-16.4 Safari) hits this same refusal on a routine
     * click, not an attack — so it gets a readable page instead of a bare
     * JSON body, and the page names no token.
     */
    it("renders an HTML page, not JSON, when the navigation check refuses — no token echoed", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "oldbrowser@x.com", role: "editor" })
        .expect(201)
      const token = created.body.url.split("/auth/invite/")[1]

      const res = await request(app).post(`/api/v1/auth/invite/${token}`)
      expect(res.status).toBe(403)
      expect(res.headers["content-type"]).toContain("text/html")
      expect(res.text).toContain(
        "This browser didn't send the information needed to sign you in safely. Open the link in an up-to-date browser and try again.",
      )
      expect(res.text).not.toContain(token)
    })

    it("redeems exactly once — the second POST is refused", async () => {
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "onlyonce@x.com", role: "editor" })
        .expect(201)
      const path = `/api/v1/auth/invite/${created.body.url.split("/auth/invite/")[1]}`

      const first = await request(app)
        .post(path)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(first.headers.location).toBe("/")

      const second = await request(app)
        .post(path)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(second.headers.location).toBe("/denied?reason=invite-invalid")
      expect(await storage.countUsers()).toBe(1)
    })

    /**
     * Fix wave 10, item 1 — the duplicate-invite race `POST /instance/invites`
     * itself documents: two live invites for the same address (both created
     * while it had no account yet), the first click creates the account, the
     * second is clicked afterwards. Before this fix, `admitSignIn`'s rung 1
     * (existing account) admitted the second click without ever claiming that
     * invite — its `usedAt` stayed null and the link stayed a working
     * credential to the account for the rest of its 7-day TTL. Two invites are
     * seeded directly through storage (bypassing the creation route's own
     * "already has an unexpired invite" 409) to build exactly that race.
     */
    it("a second, still-live invite for an already-created account is consumed on the click, not left redeemable", async () => {
      const email = "raced@x.com"
      const genA = generateOneTimeToken("dsi")
      const inviteA = await storage.createInstanceInvite({
        id: genA.id,
        email,
        role: "editor",
        tokenHash: genA.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      const genB = generateOneTimeToken("dsi")
      const inviteB = await storage.createInstanceInvite({
        id: genB.id,
        email,
        role: "editor",
        tokenHash: genB.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const first = await redeem(app, `/api/v1/auth/invite/${genA.token}`)
      expect(first.headers.location).toBe("/")
      expect((await storage.getInstanceInvite(inviteA.id))?.usedAt).not.toBeNull()
      expect(await storage.countUsers()).toBe(1)

      // The second invite's own click: still admitted (it resolves to the
      // now-existing account), but it must have SPENT the invite, not merely
      // ridden along on rung 1.
      const second = await redeem(app, `/api/v1/auth/invite/${genB.token}`)
      expect(second.headers.location).toBe("/")
      expect((await storage.getInstanceInvite(inviteB.id))?.usedAt).not.toBeNull()
      expect(await storage.countUsers()).toBe(1)

      // A third click on the now-spent second invite hits the spent branch —
      // already covered by "redeems exactly once" above for the ordinary
      // case, re-asserted here because it is what makes the fix complete: a
      // consumed invite must behave exactly like any other used invite from
      // here on.
      const third = await redeem(app, `/api/v1/auth/invite/${genB.token}`)
      expect(third.headers.location).toBe("/denied?reason=invite-invalid")
    })
  })

  describe("GET/PUT/DELETE /instance/domain-rules", () => {
    it("upserts a domain rule", async () => {
      const res = await request(app)
        .put("/api/v1/instance/domain-rules/example.com")
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(200)
      expect(res.body).toMatchObject({ domain: "example.com", role: "viewer" })

      const list = await request(app).get("/api/v1/instance/domain-rules").set(adminAuth).expect(200)
      expect(list.body.domainRules).toHaveLength(1)
    })

    it("re-PUTting the same domain updates the role (upsert, not duplicate)", async () => {
      await request(app)
        .put("/api/v1/instance/domain-rules/example.com")
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(200)
      await request(app)
        .put("/api/v1/instance/domain-rules/example.com")
        .set(adminAuth)
        .send({ role: "editor" })
        .expect(200)
      const list = await request(app).get("/api/v1/instance/domain-rules").set(adminAuth).expect(200)
      expect(list.body.domainRules).toHaveLength(1)
      expect(list.body.domainRules[0].role).toBe("editor")
    })

    it("400s a malformed domain: uppercase, no dot, or containing @", async () => {
      await request(app)
        .put("/api/v1/instance/domain-rules/Example.com")
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(400)
      await request(app)
        .put("/api/v1/instance/domain-rules/nodothere")
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(400)
      await request(app)
        .put(`/api/v1/instance/domain-rules/${encodeURIComponent("a@example.com")}`)
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(400)
    })

    it("400s an invalid role", async () => {
      await request(app)
        .put("/api/v1/instance/domain-rules/example.com")
        .set(adminAuth)
        .send({ role: "superadmin" })
        .expect(400)
    })

    it("removes a domain rule, idempotently", async () => {
      await request(app)
        .put("/api/v1/instance/domain-rules/example.com")
        .set(adminAuth)
        .send({ role: "viewer" })
        .expect(200)
      await request(app).delete("/api/v1/instance/domain-rules/example.com").set(adminAuth).expect(204)
      await request(app).delete("/api/v1/instance/domain-rules/example.com").set(adminAuth).expect(204)
      const list = await request(app).get("/api/v1/instance/domain-rules").set(adminAuth).expect(200)
      expect(list.body.domainRules).toHaveLength(0)
    })
  })

  /**
   * Mail settings, editable from the settings page (Mo, 2026-08-26).
   *
   * The behaviour worth pinning is not "a PUT round-trips" — it is the three
   * properties that make accepting SMTP over HTTP safe at all.
   */
  describe("PUT/DELETE /instance/email", () => {
    it("stores settings, and never returns the password", async () => {
      const res = await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({
          host: "smtp.example.com",
          port: 587,
          user: "viewer@example.com",
          pass: "hunter2",
          from: "reviews@example.com",
        })
        .expect(200)

      expect(res.body.configured).toBe(true)
      expect(res.body.source).toBe("stored")
      expect(res.body.hasPassword).toBe(true)
      // The one property that matters most: there is no read path for the
      // credential, so a compromised session cannot lift it back out.
      expect(JSON.stringify(res.body)).not.toContain("hunter2")

      const after = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(JSON.stringify(after.body)).not.toContain("hunter2")
      expect(after.body.email.host).toBe("smtp.example.com")
    })

    it("keeps the stored password when the field is left blank", async () => {
      // The form cannot show the password, so it cannot send it back. Blank
      // has to mean "unchanged" or editing the From address would wipe the
      // credential every time.
      await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({ host: "a.example.com", port: 25, user: "u", pass: "secret", from: "f@example.com" })
        .expect(200)

      const res = await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({ host: "a.example.com", port: 25, user: "u", pass: "", from: "changed@example.com" })
        .expect(200)

      expect(res.body.hasPassword).toBe(true)
      expect(res.body.from).toBe("changed@example.com")
    })

    it("refuses a partial record rather than storing one", async () => {
      // `loadConfig` treats partial SMTP as a hard BOOT error, so storing one
      // would leave the next restart refusing to start. A settings form must
      // not be able to brick the server.
      const res = await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({ host: "smtp.example.com", port: 587, pass: "p" })
        .expect(400)
      expect(res.body.error).toMatch(/username/i)
    })

    it("rejects a nonsense port", async () => {
      await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({ host: "h", port: 70000, user: "u", pass: "p", from: "f@example.com" })
        .expect(400)
    })

    it("turns mail off", async () => {
      await request(app)
        .put("/api/v1/instance/email")
        .set(adminAuth)
        .send({ host: "h", port: 25, user: "u", pass: "p", from: "f@example.com" })
        .expect(200)

      const res = await request(app).delete("/api/v1/instance/email").set(adminAuth).expect(200)
      expect(res.body.configured).toBe(false)
      expect(res.body.source).toBeNull()
    })

    it("is admin-only", async () => {
      // 403, matching every other admin route in this file: the guard refuses
      // authority rather than distinguishing "who are you" from "not you".
      await request(app)
        .put("/api/v1/instance/email")
        .send({ host: "h", port: 25, user: "u", pass: "p", from: "f@example.com" })
        .expect(403)
    })
  })

  describe("GET/PATCH /instance/settings", () => {
    it("defaults allowPublicLinks to true when unset", async () => {
      const res = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(res.body).toEqual({
        allowPublicLinks: true,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })
    })

    it("round-trips a PATCH", async () => {
      await request(app)
        .patch("/api/v1/instance/settings")
        .set(adminAuth)
        .send({ allowPublicLinks: false })
        .expect(200)
      const res = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(res.body).toEqual({
        allowPublicLinks: false,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })
    })

    it("reports the configured SMTP from-address as emailFrom", async () => {
      // The Settings UI's "Mention emails" status line reads this — it is
      // boot-time env config surfaced for display, not a writable setting.
      // Rides `stableGithubConfigured` (the file's second stable app) rather
      // than building a fresh one — see `no-per-test-app-construction`.
      const smtpConfig = loadConfig({
        VIEWER_ADMIN_TOKEN: "secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_SMTP_HOST: "smtp.example.com",
        VIEWER_SMTP_USER: "viewer@example.com",
        VIEWER_SMTP_PASS: "hunter2",
        VIEWER_SMTP_FROM: "reviews@example.com",
      })
      stableGithubConfigured.use(
        createApp({
          storage: new InMemoryStorage(),
          assets: nullAssets,
          config: smtpConfig,
          bridgeScript: "// bridge",
          github: testGithubRuntime(),
        }),
      )
      const res = await request(stableGithubConfigured.app)
        .get("/api/v1/instance/settings")
        .set(adminAuth)
        .expect(200)
      expect(res.body).toEqual({
        allowPublicLinks: true,
        allowAnonymousComments: true,
        emailFrom: "reviews@example.com",
        email: {
          configured: true,
          // `env`, so the settings page shows it read-only rather than
          // offering an edit that `loadConfig` would ignore.
          source: "env",
          host: "smtp.example.com",
          port: 587,
          user: "viewer@example.com",
          from: "reviews@example.com",
          // The password is REPORTED, never returned. `hunter2` must not
          // appear anywhere in this response.
          hasPassword: true,
        },
      })
      expect(JSON.stringify(res.body)).not.toContain("hunter2")
    })

    it("400s a non-boolean value", async () => {
      await request(app)
        .patch("/api/v1/instance/settings")
        .set(adminAuth)
        .send({ allowPublicLinks: "nope" })
        .expect(400)
    })

    // M2 review fix. `getAllowPublicLinks` is cached now (it runs once per
    // prototype ASSET via `loadProjectReadPolicy`, not once per API call), so
    // the PATCH handler invalidates that cache immediately after the write.
    // This ordering is what proves it: the GET first WARMS the cache with
    // `true`, and without the invalidation call the PATCH's own response —
    // and every read path on the instance — would keep answering `true` for
    // the whole TTL, i.e. the admin's kill switch would appear not to work.
    it("a PATCH takes effect immediately even after a prior GET warmed the cached value", async () => {
      const warm = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(warm.body).toEqual({
        allowPublicLinks: true,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })

      const patched = await request(app)
        .patch("/api/v1/instance/settings")
        .set(adminAuth)
        .send({ allowPublicLinks: false })
        .expect(200)
      // The PATCH's OWN response is read back through the cached reader.
      expect(patched.body).toEqual({
        allowPublicLinks: false,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })

      const after = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(after.body).toEqual({
        allowPublicLinks: false,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })

      // And back on again, from a now-warm `false`.
      await request(app)
        .patch("/api/v1/instance/settings")
        .set(adminAuth)
        .send({ allowPublicLinks: true })
        .expect(200)
      const back = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(back.body).toEqual({
        allowPublicLinks: true,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })
    })

    it("an empty PATCH body leaves the setting unchanged", async () => {
      await request(app)
        .patch("/api/v1/instance/settings")
        .set(adminAuth)
        .send({ allowPublicLinks: false })
        .expect(200)
      await request(app).patch("/api/v1/instance/settings").set(adminAuth).send({}).expect(200)
      const res = await request(app).get("/api/v1/instance/settings").set(adminAuth).expect(200)
      expect(res.body).toEqual({
        allowPublicLinks: false,
        allowAnonymousComments: true,
        emailFrom: null,
        email: {
          configured: false,
          source: null,
          host: null,
          port: null,
          user: null,
          from: null,
          hasPassword: false,
        },
      })
    })
  })
})

import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { generateMachineToken, hashTokenSecret, parseMachineToken } from "../../auth/machine-token"
import { signSessionId } from "../../auth/session-cookie"
import type { InstanceRole, MachineTokenScope, User } from "../../storage/types"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

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

describe("tokens API — /api/v1/tokens (Phase 3b-2 Task 4)", () => {
  let storage: InMemoryStorage
  let app: express.Express
  const config = authedConfig()

  /**
   * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
   *
   * The app is built fresh per test (it closes over per-test `storage`), which
   * defeated `supertest-reuse`'s per-object memoization completely: this file
   * opened 37 listening servers per run, one per test. Only one app is ever in
   * play here, so there is no two-app hazard to audit.
   */
  const stable = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
  })

  /** Seeds a user (defaulting to `editor`) + live session in `storage`, returns a `Cookie` header value for it. */
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

  /** Mints a live machine token directly in storage (bypassing the API under test) and returns its bearer header value. */
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

  describe("POST /tokens — mint", () => {
    it("a signed-in user mints a token; the response carries the plaintext ONCE, plus metadata, and no hash", async () => {
      const { cookie } = await signInAs("mo@x.com")
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "editor-macbook", scopes: ["read", "write"] })
        .expect(201)

      expect(res.body.token).toMatch(/^dsv_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/)
      expect(res.body.name).toBe("editor-macbook")
      expect(res.body.scopes).toEqual(["read", "write"])
      expect(res.body.id).toMatch(/^[0-9a-f]{16}$/)
      expect(res.body.createdAt).toEqual(expect.any(String))
      expect(res.body.lastUsedAt).toBeNull()
      // Was `toBeNull()` until the 2026-08-09 security fix — inverted
      // deliberately, not relaxed. Omitting `expiresInDays` used to mint a
      // token that never expires, and with no operator revocation path that
      // made a leaked `dsv_` permanent (audit S17). Every token now gets a
      // horizon; this asserts the default one is applied and is in the future.
      expect(res.body.expiresAt).toEqual(expect.any(String))
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now())
      expect(res.body).not.toHaveProperty("tokenHash")
    })

    it("revokes every token for a user on an admin request (S17)", async () => {
      // `deleteMachineTokensForUser` existed in both storage impls with zero
      // callers, so an operator could not retire a compromised credential —
      // only its holder could, which is the wrong actor when it has leaked.
      const { cookie } = await signInAs("mo@x.com")
      await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "one", scopes: ["read"] })
        .expect(201)

      const before = await request(app).get("/api/v1/tokens").set("Cookie", cookie).expect(200)
      expect(before.body.tokens).toHaveLength(1)
      const userId = (await storage.getUserByEmail("mo@x.com"))!.id

      // Without the admin bearer it must be indistinguishable from a route
      // that does not exist — no existence oracle for user ids.
      await request(app).post(`/api/v1/admin/users/${userId}/tokens/revoke-all`).expect(404)

      await request(app)
        .post(`/api/v1/admin/users/${userId}/tokens/revoke-all`)
        .set("Authorization", "Bearer secret")
        .expect(204)

      const after = await request(app).get("/api/v1/tokens").set("Cookie", cookie).expect(200)
      expect(after.body.tokens).toHaveLength(0)
    })

    /**
     * Fix wave M1 review. `revoke-all` used to gate on `isAdminRequest` alone
     * — the raw `adminToken` bearer, nothing else — so an instance ADMIN (a
     * `role: "admin"` account, no shared token in hand) could not revoke a
     * compromised user's tokens without also holding the operator's bearer.
     * Now it goes through `requireInstanceAdmin`, which accepts either. The
     * byte-identical 404-for-non-admin contract above (this file's own
     * comment: "no existence oracle for user ids") must survive unchanged —
     * these three tests are its role-aware complement, not a replacement.
     */
    it("also admits an active ADMIN-role session, not just the adminToken bearer", async () => {
      const { cookie: targetCookie, user: target } = await signInAs("mo@x.com")
      await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", targetCookie)
        .send({ name: "one", scopes: ["read"] })
        .expect(201)

      const { cookie: adminCookie } = await signInAs("boss@x.com", "admin")
      await request(app)
        .post(`/api/v1/admin/users/${target.id}/tokens/revoke-all`)
        .set("Cookie", adminCookie)
        .expect(204)

      const after = await request(app).get("/api/v1/tokens").set("Cookie", targetCookie).expect(200)
      expect(after.body.tokens).toHaveLength(0)
    })

    it("refuses a signed-in EDITOR session — the same byte-identical 404 as an anonymous caller", async () => {
      const { user: target } = await signInAs("mo@x.com")
      const { cookie: editorCookie } = await signInAs("editor@x.com", "editor")

      const anonymous = await request(app)
        .post(`/api/v1/admin/users/${target.id}/tokens/revoke-all`)
        .expect(404)
      const editorRes = await request(app)
        .post(`/api/v1/admin/users/${target.id}/tokens/revoke-all`)
        .set("Cookie", editorCookie)
        .expect(404)
      expect(editorRes.body).toEqual(anonymous.body)
    })

    it("still admits the raw adminToken bearer with no session at all", async () => {
      const { user: target } = await signInAs("mo@x.com")
      await request(app)
        .post(`/api/v1/admin/users/${target.id}/tokens/revoke-all`)
        .set("Authorization", "Bearer secret")
        .expect(204)
    })

    it("persists the token so it verifies against the storage row it was seeded from", async () => {
      const { user, cookie } = await signInAs("mo@x.com")
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(201)

      const stored = await storage.getMachineToken(res.body.id)
      expect(stored?.userId).toBe(user.id)
      // Positive check, not just "isn't the raw plaintext": the stored value
      // must equal the real hash of the secret half. A handler that stored
      // the raw secret (or the full token, or anything else) as `tokenHash`
      // would fail `not.toBe(res.body.token)` too weakly — that assertion
      // alone is satisfied by storing the raw secret, which is still a
      // credential-leaking bug.
      const parsed = parseMachineToken(res.body.token)
      expect(parsed).not.toBeNull()
      expect(stored?.tokenHash).toBe(hashTokenSecret(parsed!.secret))
    })

    it("expiresInDays sets a future expiresAt", async () => {
      const { cookie } = await signInAs("mo@x.com")
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"], expiresInDays: 30 })
        .expect(201)

      expect(res.body.expiresAt).not.toBeNull()
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now())
    })

    it("401s an anonymous caller with no credential at all", async () => {
      const res = await request(app).post("/api/v1/tokens").send({ name: "t", scopes: ["read"] }).expect(401)
      expect(res.body.error).toBe("Sign in required")
    })

    it("401s the admin bearer alone (no session) — admin is not a session", async () => {
      const res = await request(app)
        .post("/api/v1/tokens")
        .set(adminAuth)
        .send({ name: "t", scopes: ["read"] })
        .expect(401)
      expect(res.body.error).toBe("Sign in required")
    })

    it("403s a PAT-bearing request — a PAT must never be able to mint a PAT", async () => {
      const { user } = await signInAs("mo@x.com")
      const bearer = await patFor(user, ["write"])
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Authorization", bearer)
        .send({ name: "self-renew", scopes: ["write"] })
        .expect(403)
      expect(res.body.error).toMatch(/personal access tokens/i)
    })

    it("403s a PAT even when a valid session cookie is ALSO attached — the PAT is what authenticated, and PATs are barred here", async () => {
      const { user, cookie } = await signInAs("mo@x.com")
      const bearer = await patFor(user, ["write"])
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Authorization", bearer)
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(403)
      expect(res.body.error).toMatch(/personal access tokens/i)
    })

    it("401s a garbage bearer, even with a valid session cookie attached — never falls through", async () => {
      const { cookie } = await signInAs("mo@x.com")
      const res = await request(app)
        .post("/api/v1/tokens")
        .set("Authorization", "Bearer not-a-real-token")
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(401)
      expect(res.body.error).toBe("Invalid credentials")
    })

    describe("validation table", () => {
      it.each<[string, Record<string, unknown>]>([
        ["missing name", { scopes: ["read"] }],
        ["empty name", { name: "", scopes: ["read"] }],
        ["whitespace-only name", { name: "   ", scopes: ["read"] }],
        ["name over 64 chars", { name: "x".repeat(65), scopes: ["read"] }],
        ["missing scopes", { name: "t" }],
        ["empty scopes array", { name: "t", scopes: [] }],
        ["unknown scope", { name: "t", scopes: ["read", "admin"] }],
        ["duplicate scopes", { name: "t", scopes: ["read", "read"] }],
        ["non-array scopes", { name: "t", scopes: "read" }],
        ["expiresInDays zero", { name: "t", scopes: ["read"], expiresInDays: 0 }],
        ["expiresInDays negative", { name: "t", scopes: ["read"], expiresInDays: -1 }],
        ["expiresInDays over 365", { name: "t", scopes: ["read"], expiresInDays: 366 }],
        ["expiresInDays non-integer", { name: "t", scopes: ["read"], expiresInDays: 1.5 }],
      ])("400s: %s", async (_label, body) => {
        const { cookie } = await signInAs("mo@x.com")
        const res = await request(app).post("/api/v1/tokens").set("Cookie", cookie).send(body).expect(400)
        expect(res.body.error).toEqual(expect.any(String))
      })

      it("accepts the boundary-valid shape (name at 64 chars, expiresInDays at 1 and 365)", async () => {
        const { cookie } = await signInAs("mo@x.com")
        await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "x".repeat(64), scopes: ["read"], expiresInDays: 1 })
          .expect(201)
        await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "y", scopes: ["write"], expiresInDays: 365 })
          .expect(201)
      })

      it("trims the name before storing", async () => {
        const { cookie } = await signInAs("mo@x.com")
        const res = await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "  padded  ", scopes: ["read"] })
          .expect(201)
        expect(res.body.name).toBe("padded")
      })
    })

    /**
     * Fix wave M4. There was no cap at all: a signed-in session could mint
     * unboundedly many live credentials, each one a real bearer the owner
     * then has to reason about in a list UI that renders every row.
     */
    describe("per-user cap", () => {
      async function mintN(cookie: string, n: number) {
        for (let i = 0; i < n; i++) {
          await request(app)
            .post("/api/v1/tokens")
            .set("Cookie", cookie)
            .send({ name: `t${i}`, scopes: ["read"] })
            .expect(201)
        }
      }

      it("refuses the 51st token with 400 and a message naming the limit", async () => {
        const { cookie } = await signInAs("prolific@x.com")
        await mintN(cookie, 50)

        const res = await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "one-too-many", scopes: ["read"] })
          .expect(400)
        expect(res.body.error).toMatch(/maximum of 50/i)
        expect(await storage.listMachineTokensForUser((await signInAs("prolific@x.com")).user.id)).toHaveLength(50)
      })

      it("the cap is per-user, not global — a second user is unaffected", async () => {
        const { cookie: aCookie } = await signInAs("capped@x.com")
        await mintN(aCookie, 50)
        const { cookie: bCookie } = await signInAs("fresh@x.com")

        await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", bCookie)
          .send({ name: "b1", scopes: ["read"] })
          .expect(201)
      })

      it("revoking frees a slot — the cap counts LIVE tokens, not lifetime mints", async () => {
        const { cookie } = await signInAs("recycler@x.com")
        await mintN(cookie, 50)
        const listed = await request(app).get("/api/v1/tokens").set("Cookie", cookie).expect(200)

        await request(app).delete(`/api/v1/tokens/${listed.body.tokens[0].id}`).set("Cookie", cookie).expect(204)
        await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "replacement", scopes: ["read"] })
          .expect(201)
      })

      // An expired token is a dead credential — `verifyMachineToken` already
      // 401s it. Counting it toward the cap would lock a user out of minting
      // a replacement at exactly the moment they need one, with the only
      // remedy being to hunt down and delete rows by hand.
      it("expired tokens do not consume a slot", async () => {
        const { user, cookie } = await signInAs("expiry@x.com")
        const past = new Date(Date.now() - 60_000).toISOString()
        for (let i = 0; i < 50; i++) {
          const gen = generateMachineToken()
          await storage.createMachineToken({
            id: gen.id,
            userId: user.id,
            name: `dead-${i}`,
            scopes: ["read"],
            tokenHash: gen.tokenHash,
            expiresAt: past,
          })
        }

        await request(app)
          .post("/api/v1/tokens")
          .set("Cookie", cookie)
          .send({ name: "live-replacement", scopes: ["read"] })
          .expect(201)
      })
    })
  })

  describe("GET /tokens — list own tokens", () => {
    it("lists only the caller's own tokens, never tokenHash or any secret material", async () => {
      const { cookie: aCookie } = await signInAs("a@x.com")
      const { cookie: bCookie } = await signInAs("b@x.com")
      await request(app).post("/api/v1/tokens").set("Cookie", aCookie).send({ name: "a1", scopes: ["read"] }).expect(201)
      await request(app).post("/api/v1/tokens").set("Cookie", aCookie).send({ name: "a2", scopes: ["write"] }).expect(201)
      await request(app).post("/api/v1/tokens").set("Cookie", bCookie).send({ name: "b1", scopes: ["read"] }).expect(201)

      const res = await request(app).get("/api/v1/tokens").set("Cookie", aCookie).expect(200)
      expect(res.body.tokens).toHaveLength(2)
      const names = res.body.tokens.map((t: { name: string }) => t.name)
      expect(names.sort()).toEqual(["a1", "a2"])
      for (const t of res.body.tokens) {
        expect(t).not.toHaveProperty("tokenHash")
        expect(t).not.toHaveProperty("token")
        expect(Object.keys(t).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "scopes"])
      }
    })

    it("401s an anonymous caller", async () => {
      await request(app).get("/api/v1/tokens").expect(401)
    })

    it("403s a PAT-bearing request", async () => {
      const { user } = await signInAs("mo@x.com")
      const bearer = await patFor(user, ["read"])
      await request(app).get("/api/v1/tokens").set("Authorization", bearer).expect(403)
    })

    it("an empty list for a user with no tokens is [], not an error", async () => {
      const { cookie } = await signInAs("nobody@x.com")
      const res = await request(app).get("/api/v1/tokens").set("Cookie", cookie).expect(200)
      expect(res.body.tokens).toEqual([])
    })
  })

  describe("DELETE /tokens/:id — revoke", () => {
    it("the owner revokes their own token", async () => {
      const { cookie } = await signInAs("mo@x.com")
      const created = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(201)

      await request(app).delete(`/api/v1/tokens/${created.body.id}`).set("Cookie", cookie).expect(204)
      expect(await storage.getMachineToken(created.body.id)).toBeNull()
    })

    it("404s (never 403) a token belonging to another user — no existence oracle", async () => {
      const { cookie: ownerCookie } = await signInAs("owner@x.com")
      const { cookie: outsiderCookie } = await signInAs("outsider@x.com")
      const created = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", ownerCookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(201)

      const stolen = await request(app)
        .delete(`/api/v1/tokens/${created.body.id}`)
        .set("Cookie", outsiderCookie)
        .expect(404)
      const missing = await request(app)
        .delete(`/api/v1/tokens/definitely-not-a-real-id`)
        .set("Cookie", outsiderCookie)
        .expect(404)
      expect(stolen.body).toEqual(missing.body)

      // Still there — the cross-user attempt did not revoke it.
      expect(await storage.getMachineToken(created.body.id)).not.toBeNull()
    })

    it("404s an already-revoked (or never-existed) id, idempotently", async () => {
      const { cookie } = await signInAs("mo@x.com")
      await request(app).delete("/api/v1/tokens/nope").set("Cookie", cookie).expect(404)
    })

    it("401s an anonymous caller", async () => {
      await request(app).delete("/api/v1/tokens/whatever").expect(401)
    })

    it("403s a PAT-bearing request, even one that owns the target token", async () => {
      const { user, cookie } = await signInAs("mo@x.com")
      const created = await request(app)
        .post("/api/v1/tokens")
        .set("Cookie", cookie)
        .send({ name: "t", scopes: ["read"] })
        .expect(201)
      const bearer = await patFor(user, ["write"])

      await request(app).delete(`/api/v1/tokens/${created.body.id}`).set("Authorization", bearer).expect(403)
      // Refused — the token must still exist.
      expect(await storage.getMachineToken(created.body.id)).not.toBeNull()
    })
  })
})

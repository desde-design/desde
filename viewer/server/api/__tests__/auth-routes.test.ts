import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import type { AssetStore } from "../../assets/types"
import { generateMachineToken } from "../../auth/machine-token"
import { signSessionId } from "../../auth/session-cookie"
import type { AuthProvider } from "../../auth/types"
import { loadConfig } from "../../config"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

/**
 * Fake `AuthProvider` — no network. `exchangeCode` only accepts the literal
 * "good-code", so tests can distinguish "the callback route works" from
 * "the callback route trusts an unverified code."
 */
const fakeProvider: AuthProvider = {
  authorizeUrl(state, redirectUri) {
    return `https://fake-provider.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  },
  async exchangeCode(code) {
    if (code !== "good-code") {
      throw new Error("simulated provider rejection: bad code")
    }
    return {
      provider: "github",
      providerUserId: "12345",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "https://avatars.example.com/mo.png",
    }
  },
}

/**
 * `@types/superagent` types `res.headers` as `{ [index: string]: string }`,
 * but Node's real response can (and here, does) carry MULTIPLE `Set-Cookie`
 * headers — superagent hands those back as a `string[]` at runtime despite
 * the narrower type. This normalizes to an array either way.
 */
function setCookies(res: { headers: Record<string, string> }): string[] {
  const raw = res.headers["set-cookie"] as unknown as string | string[] | undefined
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

/** Pulls one cookie's bare value (attributes stripped, percent-decoded) out of a Set-Cookie header list. */
function extractCookie(setCookie: string[], name: string): string | null {
  for (const raw of setCookie) {
    const pair = raw.split(";")[0]
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    if (pair.slice(0, eq) !== name) continue
    return decodeURIComponent(pair.slice(eq + 1))
  }
  return null
}

describe("auth routes", () => {
  let storage: InMemoryStorage
  let deps: AppDeps
  let app: express.Express

  /**
   * TWO stable app objects for this file — see `__tests__/swappable-app.ts`.
   * It opened 24 listening servers per run.
   *
   * `stable` carries the `beforeEach` app and every test that uses exactly one
   * app. `stableAlt` exists for the three tests that genuinely hold two at
   * once: the "previously recorded set is left untouched" round trip
   * (withIds / withoutIds) and the two `/me` tests that contrast a
   * fully-configured app with an auth-unconfigured one.
   *
   * Those three happen to build and use their apps in strict sequence today,
   * so a single shared object would pass — but only by accident of statement
   * order. A later edit hoisting the second construction above the first
   * request would make them exercise the wrong app and still go green. Two
   * objects is still a 12x reduction and removes that trap entirely.
   */
  const stable = createSwappableApp()
  const stableAlt = createSwappableApp()

  /**
   * `AppDeps` over the CURRENT `storage`, with GitHub sign-in deliberately
   * UNCONFIGURED by default — that is the state the local-operator route
   * exists for, and the state `loadConfig({})` produces.
   *
   * Pass env overrides to configure anything `loadConfig` reads; the
   * `beforeEach` below uses that to build the GitHub-configured deps every
   * other test in this file runs against. A fresh `tmpViewerDataDir()` per
   * call keeps each `loadConfig` off the shared on-disk config file (see
   * `__tests__/test-config.ts`).
   */
  function baseDeps(env: Partial<NodeJS.ProcessEnv> = {}): AppDeps {
    const config = loadConfig({
      VIEWER_SESSION_SECRET: "sesh-secret",
      VIEWER_PUBLIC_URL: "http://localhost:3100",
      VIEWER_DATA_DIR: tmpViewerDataDir(),
      ...env,
    })
    return {
      storage,
      assets: nullAssets,
      config,
      bridgeScript: "// bridge",
      // The fake provider is injected only when the config would have
      // produced a real one. That conditional is the whole point of this
      // suite now: since Task 9 every auth route registers unconditionally
      // and decides at REQUEST time on `deps.github.authProvider`, so the
      // presence of a provider — not `config.githubAuth` — is what makes
      // `/auth/github` answer and `/auth/local` 404. A runtime that always
      // carried the fake would silently turn `/auth/local` off in the very
      // tests that exist to exercise it.
      github: testGithubRuntime({
        config,
        ...(config.githubAuth ? { overrides: { authProvider: fakeProvider } } : {}),
      }),
    }
  }

  beforeEach(() => {
    storage = new InMemoryStorage()
    deps = baseDeps({
      VIEWER_GITHUB_CLIENT_ID: "client-id",
      VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    })
    stable.use(createApp(deps))
    app = stable.app
  })

  /**
   * Drives the full GitHub start → callback round trip against `app` (the
   * `beforeEach` app, which HAS GitHub sign-in configured), optionally
   * carrying an extra cookie alongside the OAuth state cookie the callback
   * requires.
   */
  async function signInWithGitHub(extraCookie?: string) {
    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const cookies = [`viewer_oauth_state=${stateCookie}`, ...(extraCookie ? [extraCookie] : [])]
    return await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", cookies.join("; "))
  }

  /**
   * An unrelated account, so `countUsers()` is nonzero.
   *
   * Necessary in any test about REFUSAL: on an empty instance the gate's
   * first-user bootstrap rung admits everybody, so a refusal test against a
   * fresh `InMemoryStorage` would be testing the wrong rung — and would go
   * green for the wrong reason if the refusal path broke.
   */
  async function seedExistingAccount() {
    return upsertTestUser(storage, {
      provider: "github",
      providerUserId: "already-here",
      email: "already@example.test",
      displayName: "Already Here",
      avatarUrl: "",
      role: "admin",
    })
  }

  /**
   * `?next=` (2026-08-29) lets a flow that starts inside the app resume where
   * it began — the repo wizard sends the reader back to the dialog they left
   * rather than to the dashboard.
   *
   * The open-redirect shapes themselves are covered exhaustively by
   * `return-path.test.ts` against the pure validator. What these two pin is
   * the WIRING: that the path survives a full round trip, and that a hostile
   * one cannot reach `Location` even when it arrives as a cookie on the
   * callback — the leg where "we set this ourselves" is the tempting and
   * wrong assumption.
   */
  it("carries ?next= through the round trip and lands there", async () => {
    const start = await request(app).get("/api/v1/auth/github?next=%2Fsettings%3Fsection%3Dgithub")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const returnCookie = extractCookie(setCookies(start), "viewer_oauth_return")
    expect(returnCookie).toBeTruthy()

    const res = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}; viewer_oauth_return=${returnCookie}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/settings?section=github")
  })

  /**
   * An ordinary sign-in EXPIRES the return cookie rather than leaving it
   * alone. Found by a codex review, 2026-08-29: a connect flow abandoned
   * before its callback left the cookie standing for its full ten minutes, so
   * someone who then pressed "Sign in" from the dashboard was redirected into
   * the repo dialog they had walked away from, and on to GitHub, because the
   * stale path still carried the flow's own marker.
   */
  it("expires any standing return cookie on an ordinary sign-in", async () => {
    const start = await request(app).get("/api/v1/auth/github")
    const header = setCookies(start).find((c) => c.startsWith("viewer_oauth_return="))
    expect(header).toBeDefined()
    expect(header).toContain("viewer_oauth_return=;")
    expect(header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/)
  })

  it("refuses an off-origin ?next=, and lands on the dashboard instead", async () => {
    const start = await request(app).get("/api/v1/auth/github?next=https%3A%2F%2Fevil.example")
    // Rejected before it could reach a cookie with a value in it: the header
    // is present, but it is the expiry, not the hostile path.
    const header = setCookies(start).find((c) => c.startsWith("viewer_oauth_return="))
    expect(header).toContain("viewer_oauth_return=;")
    expect(header).not.toContain("evil.example")

    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const res = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}`)
    expect(res.headers.location).toBe("/")
  })

  /**
   * The failure path, which used to leave the cookie behind. A callback that
   * 400s on a bad state must still burn the return cookie, or the next
   * sign-in consumes a path belonging to a flow that already failed.
   */
  it("expires the return cookie even when the callback rejects the state", async () => {
    const start = await request(app).get("/api/v1/auth/github?next=%2Fsettings%3Fsection%3Dgithub")
    const returnCookie = extractCookie(setCookies(start), "viewer_oauth_return")
    expect(returnCookie).toBeTruthy()

    const res = await request(app)
      .get("/api/v1/auth/github/callback?code=good-code&state=not-the-right-state")
      .set("Cookie", `viewer_oauth_state=whatever; viewer_oauth_return=${returnCookie}`)
    expect(res.status).toBe(400)
    const header = setCookies(res).find((c) => c.startsWith("viewer_oauth_return="))
    expect(header).toContain("viewer_oauth_return=;")
  })

  it("refuses a hostile return cookie forged onto the callback", async () => {
    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")

    // The cookie is client-supplied input. Planting one directly is the whole
    // attack the callback's re-validation exists to stop.
    const res = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set(
        "Cookie",
        `viewer_oauth_state=${stateCookie}; viewer_oauth_return=${encodeURIComponent("//evil.example")}`,
      )
    expect(res.headers.location).toBe("/")
  })

  it("redirects to the provider with a signed state when auth is configured", async () => {
    const res = await request(app).get("/api/v1/auth/github")
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain("https://fake-provider.test/authorize")
    expect(res.headers.location).toContain("state=")
    // the state must also be planted as a short-lived cookie for CSRF checking
    expect(setCookies(res).join(";")).toContain("viewer_oauth_state")
  })

  /**
   * `redirectUri` must stay `config.publicUrl`-derived, never request-Host-
   * derived (see the comment above it in `auth-routes.ts`). This is the one
   * thing that stops a hostile prototype from minting the reviewer's session
   * on a prototype host via a framed OAuth round trip (adversarial review,
   * Attack 1b: `/auth/github` is exempt from the document-navigation guard,
   * so a self-navigated iframe reaches it; only the callback returning to
   * `publicUrl` rather than the framing host stops the state cookie from
   * matching).
   *
   * `Host: 127.0.0.1:<port>` here is exactly the loopback twin the allowlist
   * accepts (`allowAnyLoopbackPort`, set by this file's `createApp` — see
   * `__tests__/test-app.ts`) — a real, admitted request, not a rejected one.
   * If `redirectUri` were ever generalised to the per-request shell origin
   * (the way the bridge's `data-shell-origin` and the prototype CSP's
   * `frame-ancestors` are), this test would start failing.
   */
  it("keeps redirect_uri pinned to publicUrl even when the request Host is a loopback twin", async () => {
    const res = await request(app).get("/api/v1/auth/github").set("Host", "127.0.0.1:59999")
    expect(res.status).toBe(302)
    const location = new URL(res.headers.location)
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3100/api/v1/auth/github/callback",
    )
  })

  /**
   * The route-registration conversion, exercised from the outside.
   *
   * `/auth/github` used to be registered only when `config.githubAuth` was
   * set — a decision taken ONCE, when the router was built. The App Manifest
   * flow produces a provider AFTER that, so under the old shape a
   * freshly-created App had a live provider that no registered route could
   * reach, and sign-in 404ed until a restart. This app is exactly that
   * situation: boot config with no GitHub at all, a provider present in the
   * runtime. A 302 is only possible if the handler reads the runtime per
   * request.
   */
  it("redirects when the runtime has a provider, even though the boot config had none", async () => {
    const unconfiguredBoot = baseDeps()
    expect(unconfiguredBoot.config.githubAuth).toBeNull()
    stable.use(
      createApp({
        ...unconfiguredBoot,
        github: testGithubRuntime({ overrides: { authProvider: fakeProvider } }),
      }),
    )
    const res = await request(stable.app).get("/api/v1/auth/github")
    expect(res.status).toBe(302)
    expect(res.headers.location).toContain("https://fake-provider.test/authorize")

    // And `/me` advertises it, for the same reason: the account menu asks
    // "can this visitor sign in right now", not "was GitHub configured at
    // boot", so it must not still be reporting the boot snapshot's answer.
    const me = await request(stable.app).get("/api/v1/me")
    expect(me.body.authEnabled).toBe(true)
    expect(me.body.signInUrl).toBe("/api/v1/auth/github")
  })

  it("completes the callback: admits the user, sets a signed session cookie, redirects home", async () => {
    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const res = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/")
    const session = extractCookie(setCookies(res), "viewer_session")
    expect(session).toBeTruthy()
    const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${session}`)
    expect(me.body.user.email).toBe("mo@example.com")
    expect(me.body.user.provider).toBe("github")
    expect(me.body.authEnabled).toBe(true)
    // This storage is empty (see `beforeEach`), so it is the first-user
    // bootstrap rung that admitted them — see the role tests below.
    expect(me.body.user.role).toBe("admin")
  })

  /**
   * What role a fresh sign-in gets is no longer a constant in this file — the
   * admission gate (`auth/gate.ts`) decides it, and which rung fires depends on
   * the state of the instance. These pin the answer through the real HTTP
   * route, because the gate's own unit tests cannot see whether the callback
   * passes it the right inputs.
   */
  describe("the role a completed sign-in receives", () => {
    it("makes the very first account an admin (first-user bootstrap)", async () => {
      expect(await storage.countUsers()).toBe(0)
      await signInWithGitHub()
      expect((await storage.getUserByEmail("mo@example.com"))?.role).toBe("admin")
    })

    it("uses a matching domain rule's role once the instance has accounts", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })

      const res = await signInWithGitHub()

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      expect((await storage.getUserByEmail("mo@example.com"))?.role).toBe("viewer")
    })

    /**
     * C3: a pending invite is honoured on EVERY sign-in door, not only the
     * emailed `/auth/invite/<token>` link. Nothing about GitHub sign-in ever
     * carries an invite token, so the gate has to look one up by email
     * itself — otherwise clicking "Sign in with GitHub" instead of the
     * invite email would silently give the DOMAIN RULE's (lower) role
     * instead of the one the admin actually chose.
     */
    it("uses a pending invite's role over a matching domain rule, on a plain GitHub sign-in", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
      const invite = await storage.createInstanceInvite({
        id: "c3githubinvite0",
        email: "mo@example.com",
        role: "editor",
        tokenHash: "unused-hash",
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const res = await signInWithGitHub()

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      expect((await storage.getUserByEmail("mo@example.com"))?.role).toBe("editor")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })

    it("admits a plain GitHub sign-in at the invite's role even with no domain rule at all", async () => {
      await seedExistingAccount()
      const invite = await storage.createInstanceInvite({
        id: "c3githubinvite1",
        email: "mo@example.com",
        role: "viewer",
        tokenHash: "unused-hash",
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const res = await signInWithGitHub()

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      expect((await storage.getUserByEmail("mo@example.com"))?.role).toBe("viewer")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })
  })

  /**
   * The claim-an-email-account branch, over HTTP. Someone is invited by email
   * and their account is created with NO provider identity; the first time
   * they sign in with GitHub, that identity attaches to the account they
   * already have. One row, and their existing role survives — a second row
   * would be an account with none of their memberships and none of their
   * history, and would recreate the audit-S18 duplicate-email state.
   */
  it("claims an email-created account on the first GitHub sign-in with the same address", async () => {
    const invited = await storage.createUser({
      provider: "email",
      providerUserId: null,
      email: "mo@example.com",
      displayName: "mo",
      avatarUrl: "",
      role: "editor",
    })

    const res = await signInWithGitHub()
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/")

    const session = extractCookie(setCookies(res), "viewer_session")
    const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${session}`)
    expect(me.body.user.id).toBe(invited.id)
    expect(me.body.user.provider).toBe("github")
    // Refreshed from the provider, and the invited role is untouched.
    expect(me.body.user.displayName).toBe("Mo")
    expect(me.body.user.role).toBe("editor")
    expect(await storage.countUsers()).toBe(1)
  })

  it("refuses the sign-in when that address's account belongs to a different GitHub identity", async () => {
    // Audit S18 at the sign-in door: a reassigned corporate address must not
    // inherit the previous holder's row. The gate reports `conflict`; the
    // person sees the same `/denied` as anyone else.
    const original = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "someone-else",
      email: "mo@example.com",
      displayName: "Original",
      avatarUrl: "",
    })

    const res = await signInWithGitHub()

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/denied")
    expect(setCookies(res).join(";")).not.toContain("viewer_session=")
    expect((await storage.getUser(original.id))?.providerUserId).toBe("someone-else")
    expect(await storage.countUsers()).toBe(1)
  })

  /**
   * Phase 3c-1b: the callback is the ONLY writer of a user's GitHub App
   * installation set — the server-derived authorization input the
   * connect-repo routes filter on. These pin the three states of
   * `ProviderProfile.installations`.
   */
  describe("installation capture on sign-in (Phase 3c-1b)", () => {
    /** Drives a full start→callback round trip against a provider of the test's choosing. */
    async function signInWith(provider: AuthProvider) {
      const localStorage = new InMemoryStorage()
      stable.use(
        createApp({
          ...deps,
          storage: localStorage,
          github: testGithubRuntime({ config: deps.config, overrides: { authProvider: provider } }),
        }),
      )
      const localApp = stable.app
      const start = await request(localApp).get("/api/v1/auth/github")
      const state = new URL(start.headers.location).searchParams.get("state")!
      const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
      const res = await request(localApp)
        .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
        .set("Cookie", `viewer_oauth_state=${stateCookie}`)
      return { storage: localStorage, res }
    }

    /** Builds a provider reporting the given installation ids, each paired with a plausible repo entitlement. */
    function providerReturning(installationIds: number[] | undefined): AuthProvider {
      return {
        authorizeUrl: fakeProvider.authorizeUrl,
        async exchangeCode(code, redirectUri) {
          const base = await fakeProvider.exchangeCode(code, redirectUri)
          if (installationIds === undefined) return base
          return {
            ...base,
            installations: installationIds.map((installationId) => ({
              installationId,
              repoFullNames: [`org-${installationId}/repo`],
            })),
          }
        },
      }
    }

    it("persists the ids the provider reported, stamped with a sync time", async () => {
      const { storage: s } = await signInWith(providerReturning([7, 9]))
      const user = await s.getUserByEmail("mo@example.com")
      const recorded = await s.getUserInstallations(user!.id)
      expect(
        recorded?.installations.map((i) => i.installationId).slice().sort((a, b) => a - b),
      ).toEqual([7, 9])
      expect(Date.parse(recorded!.syncedAt)).not.toBeNaN()
    })

    it("records an empty set as an empty set — 'can see none' is a real answer", async () => {
      const { storage: s } = await signInWith(providerReturning([]))
      const user = await s.getUserByEmail("mo@example.com")
      expect(await s.getUserInstallations(user!.id)).toMatchObject({ installations: [] })
    })

    it("leaves any previously recorded set UNTOUCHED when the provider omits the field", async () => {
      // Sign in once with a real set, then again with a provider that
      // reports nothing (a transient GitHub failure, or a non-GitHub
      // provider): the old set must survive rather than be wiped.
      const localStorage = new InMemoryStorage()
      stable.use(
        createApp({
          ...deps,
          storage: localStorage,
          github: testGithubRuntime({
            config: deps.config,
            overrides: { authProvider: providerReturning([3]) },
          }),
        }),
      )
      const withIds = stable.app
      const start = await request(withIds).get("/api/v1/auth/github")
      const state = new URL(start.headers.location).searchParams.get("state")!
      const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
      await request(withIds)
        .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
        .set("Cookie", `viewer_oauth_state=${stateCookie}`)

      // `stableAlt`, not `stable`: `withIds` above must stay reachable and
      // unswapped for the duration of this test.
      stableAlt.use(
        createApp({
          ...deps,
          storage: localStorage,
          github: testGithubRuntime({
            config: deps.config,
            overrides: { authProvider: providerReturning(undefined) },
          }),
        }),
      )
      const withoutIds = stableAlt.app
      const start2 = await request(withoutIds).get("/api/v1/auth/github")
      const state2 = new URL(start2.headers.location).searchParams.get("state")!
      const stateCookie2 = extractCookie(setCookies(start2), "viewer_oauth_state")
      await request(withoutIds)
        .get(`/api/v1/auth/github/callback?code=good-code&state=${state2}`)
        .set("Cookie", `viewer_oauth_state=${stateCookie2}`)

      const user = await localStorage.getUserByEmail("mo@example.com")
      expect(
        (await localStorage.getUserInstallations(user!.id))?.installations.map((i) => i.installationId),
      ).toEqual([3])
    })

    it("still signs the user in when recording the set fails", async () => {
      const localStorage = new InMemoryStorage()
      localStorage.setUserInstallations = async () => {
        throw new Error("simulated storage failure")
      }
      stable.use(
        createApp({
          ...deps,
          storage: localStorage,
          github: testGithubRuntime({
            config: deps.config,
            overrides: { authProvider: providerReturning([1]) },
          }),
        }),
      )
      const localApp = stable.app
      const start = await request(localApp).get("/api/v1/auth/github")
      const state = new URL(start.headers.location).searchParams.get("state")!
      const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
      const res = await request(localApp)
        .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
        .set("Cookie", `viewer_oauth_state=${stateCookie}`)

      // Degraded (the user is authorized for no installation until the next
      // successful sign-in), never locked out.
      expect(res.status).toBe(302)
      expect(extractCookie(setCookies(res), "viewer_session")).toBeTruthy()
    })
  })

  /**
   * The admission gate (`auth/gate.ts`) runs AFTER the provider exchange (a
   * verified email is the only one worth checking) and BEFORE any account
   * write, so a refused sign-in must leave no user row, no session, and
   * nothing a later membership invite could resolve against.
   *
   * These replace this file's `VIEWER_ALLOWED_EMAIL_DOMAINS` tests. That env
   * var is no longer an admission check at all — it is converted into stored
   * domain rules at boot (`seedDomainRulesFromEnv`), and the gate is what
   * decides.
   */
  describe("a refused sign-in", () => {
    it("sends a stranger to /denied with no session and no user row", async () => {
      // An account already exists, so the first-user bootstrap rung cannot
      // fire; nothing invites this person and no domain rule matches them.
      await seedExistingAccount()

      const res = await signInWithGitHub()

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied")
      expect(setCookies(res).join(";")).not.toContain("viewer_session=")
      expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
      expect(await storage.getUserByProviderIdentity("github", "12345")).toBeNull()
      expect(await storage.countUsers()).toBe(1)
    })

    it("still clears the OAuth state cookie", async () => {
      await seedExistingAccount()
      const res = await signInWithGitHub()
      expect(setCookies(res).join(";")).toContain("viewer_oauth_state=;")
    })

    it("refuses a REMOVED account, and revokes the credentials it still holds", async () => {
      // Audit K08's rule, carried onto the gate's `removed` reason. Refusing
      // the new sign-in is not enough on its own: sessions and machine tokens
      // this account minted while it was active authorize against the STORED
      // row, and the refusal writes nothing — so without this they would keep
      // working until they happened to expire.
      const existing = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "12345", // the identity the fake provider returns
        email: "mo@example.com",
        displayName: "Mo",
        avatarUrl: "",
      })
      await storage.setUserStatus(existing.id, "removed")
      const liveSession = await storage.createSession({
        userId: existing.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      await storage.createMachineToken({
        id: "0123456789abcdef",
        userId: existing.id,
        name: "ci",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })

      const res = await signInWithGitHub()

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied")
      expect(setCookies(res).join(";")).not.toContain("viewer_session=")
      // The credentials it already held are gone, not merely un-renewed.
      expect(await storage.getSession(liveSession.id)).toBeNull()
      expect(await storage.listMachineTokensForUser(existing.id)).toHaveLength(0)
      // The row itself survives — `removed` is a soft delete, so everything
      // stamped with this id still resolves to a name.
      expect((await storage.getUser(existing.id))?.status).toBe("removed")
    })

    /**
     * The refusal must not become a membership oracle. "Nobody invited you",
     * "your account was removed" and "that address belongs to a different
     * identity" are three very different facts about this instance, and an
     * anonymous visitor must not be able to tell them apart by signing in.
     */
    it("answers identically whatever the reason", async () => {
      await seedExistingAccount()
      const stranger = await signInWithGitHub()

      const removed = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "12345",
        email: "mo@example.com",
        displayName: "Mo",
        avatarUrl: "",
      })
      await storage.setUserStatus(removed.id, "removed")
      const removedRes = await signInWithGitHub()

      expect(removedRes.status).toBe(stranger.status)
      expect(removedRes.headers.location).toBe(stranger.headers.location)
      expect(removedRes.text).toBe(stranger.text)
    })

    it("admits nobody on an instance whose only account was removed", async () => {
      // `countUsers` counts removed rows deliberately: an instance whose only
      // account was removed must not read as empty, or removing the last admin
      // would bootstrap the next visitor straight to admin.
      const only = await seedExistingAccount()
      await storage.setUserStatus(only.id, "removed")

      const res = await signInWithGitHub()

      expect(res.headers.location).toBe("/denied")
      expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
    })
  })

  it("admits an address whose domain has a rule, and signs them in", async () => {
    await seedExistingAccount()
    await storage.setDomainRule({ domain: "example.com", role: "editor", createdByUserId: null })

    const res = await signInWithGitHub()

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("/")
    expect(extractCookie(setCookies(res), "viewer_session")).toBeTruthy()
    expect(await storage.getUserByEmail("mo@example.com")).not.toBeNull()
  })

  it("rejects a callback whose state does not match the cookie (CSRF)", async () => {
    const res = await request(app)
      .get("/api/v1/auth/github/callback?code=good-code&state=forged")
      .set("Cookie", "viewer_oauth_state=something-else")
    expect(res.status).toBe(400)
    expect(setCookies(res).join(";")).not.toContain("viewer_session=")
  })

  it("rejects a callback with no state cookie at all", async () => {
    const res = await request(app).get("/api/v1/auth/github/callback?code=good-code&state=whatever")
    expect(res.status).toBe(400)
    expect(setCookies(res).join(";")).not.toContain("viewer_session=")
  })

  it("clears the state cookie on the callback response regardless of outcome", async () => {
    const rejected = await request(app)
      .get("/api/v1/auth/github/callback?code=good-code&state=forged")
      .set("Cookie", "viewer_oauth_state=something-else")
    expect(setCookies(rejected).join(";")).toContain("viewer_oauth_state=;")

    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const accepted = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}`)
    expect(setCookies(accepted).join(";")).toContain("viewer_oauth_state=;")
  })

  /**
   * The `__Host-` cookie hardening, end to end on an https deployment. Both
   * the CSRF state cookie and the minted session cookie gain the `__Host-`
   * prefix there, and the callback reads ONLY the prefixed state name. The
   * negative case is the point: a validly-shaped but plain-named
   * `viewer_oauth_state` is ignored on https, so a sibling host cannot toss one
   * to satisfy the CSRF check.
   */
  describe("__Host- cookies on an https deployment", () => {
    function httpsApp(): express.Express {
      const httpsDeps = baseDeps({
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_PUBLIC_URL: "https://viewer.example.com",
      })
      stableAlt.use(createApp(httpsDeps))
      return stableAlt.app
    }

    it("names both the state and the session cookie __Host-* and completes the round trip", async () => {
      const secureApp = httpsApp()
      const start = await request(secureApp).get("/api/v1/auth/github")
      const state = new URL(start.headers.location).searchParams.get("state")!
      // The start response sets the PREFIXED state cookie, not the plain one.
      expect(extractCookie(setCookies(start), "__Host-viewer_oauth_state")).toBeTruthy()
      expect(extractCookie(setCookies(start), "viewer_oauth_state")).toBeNull()

      const stateCookie = extractCookie(setCookies(start), "__Host-viewer_oauth_state")
      const res = await request(secureApp)
        .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
        .set("Cookie", `__Host-viewer_oauth_state=${stateCookie}`)
      expect(res.status).toBe(302)
      // The minted session cookie is prefixed too.
      expect(extractCookie(setCookies(res), "__Host-viewer_session")).toBeTruthy()
      expect(extractCookie(setCookies(res), "viewer_session")).toBeNull()
    })

    it("IGNORES a plain-named viewer_oauth_state on https — CSRF check fails (tossing closed)", async () => {
      const secureApp = httpsApp()
      // A perfectly matching state value, but under the unprefixed name. On
      // https the callback reads only __Host-viewer_oauth_state, so this is
      // invisible and the state check 400s.
      const res = await request(secureApp)
        .get("/api/v1/auth/github/callback?code=good-code&state=matching")
        .set("Cookie", "viewer_oauth_state=matching")
      expect(res.status).toBe(400)
      expect(setCookies(res).join(";")).not.toContain("viewer_session=")
    })
  })

  it("502s (with no session cookie) when the provider rejects the code, without echoing the provider's raw error", async () => {
    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const res = await request(app)
      .get(`/api/v1/auth/github/callback?code=bad-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}`)
    expect(res.status).toBe(502)
    expect(res.body.error).not.toContain("simulated provider rejection")
    expect(setCookies(res).join(";")).not.toContain("viewer_session=")
  })

  it("returns { user: null } with no cookie, and 404s the auth routes when auth is unconfigured", async () => {
    expect((await request(app).get("/api/v1/me")).body.user).toBeNull()
    // `stableAlt`: both these tests also request against `app`, which lives on
    // `stable` and must not be swapped out from under them.
    // A runtime with NO provider is what makes this app unconfigured now —
    // `config.githubAuth: null` alone no longer unregisters anything, and
    // `deps`'s runtime carries the fake provider from `beforeEach`.
    stableAlt.use(
      createApp({
        ...deps,
        config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
        github: testGithubRuntime(),
      }),
    )
    const noAuthApp = stableAlt.app
    const res = await request(noAuthApp).get("/api/v1/auth/github")
    expect(res.status).toBe(404)
    // The ROUTER'S terminal 404, not one the handler wrote. The route is
    // registered now whether or not a provider exists, so a bespoke body
    // would advertise the difference between "registered but disabled" and
    // "no such path" — see the fingerprinting note in `auth-routes.ts`.
    expect(res.body).toEqual({ error: "Not found: GET /api/v1/auth/github" })
  })

  it("/me distinguishes 'signed out' from 'auth not configured' via authEnabled — user is null either way", async () => {
    // Auth IS configured on `app` (see beforeEach); no cookie sent → signed out.
    const signedOut = await request(app).get("/api/v1/me")
    // `scopes: null` = "not a machine token" — the same answer a browser
    // session gets, and deliberately not `[]` (which would read as "a token
    // with no permissions"). Kept in the exact-shape assertion rather than
    // loosened to `objectContaining`: this route's response is a contract a
    // machine client reads, and a field appearing unnoticed is exactly what
    // an exact match is for.
    expect(signedOut.body).toEqual({
      user: null,
      authEnabled: true,
      signInUrl: "/api/v1/auth/github",
      // No SMTP on `baseDeps` — see `magic-link-routes.test.ts` for the
      // SMTP-configured `true` case, which needs the SMTP-toggle deps this
      // file's `beforeEach` doesn't build.
      emailSignInEnabled: false,
      scopes: null,
    })

    // Auth is NOT configured at all on this second app.
    // `stableAlt`: both these tests also request against `app`, which lives on
    // `stable` and must not be swapped out from under them.
    // A runtime with NO provider is what makes this app unconfigured now —
    // `config.githubAuth: null` alone no longer unregisters anything, and
    // `deps`'s runtime carries the fake provider from `beforeEach`.
    stableAlt.use(
      createApp({
        ...deps,
        config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
        github: testGithubRuntime(),
      }),
    )
    const noAuthApp = stableAlt.app
    const unconfigured = await request(noAuthApp).get("/api/v1/me")
    expect(unconfigured.status).toBe(200)
    expect(unconfigured.body).toEqual({
      user: null,
      authEnabled: false,
      signInUrl: null,
      emailSignInEnabled: false,
      scopes: null,
    })
  })

  /**
   * `signInUrl` is the path a signed-out visitor should be sent to — GitHub
   * when it's configured, `null` when this deployment has no provider they
   * can use. The local-operator URL (`GET /auth/local`) is deliberately
   * never in this set: it carries a secret in its query string and reaches
   * its operator through stdout, never through a public endpoint.
   */
  it("advertises the GitHub sign-in URL when GitHub is configured", async () => {
    // Auth IS configured on `app` (see beforeEach).
    const res = await request(app).get("/api/v1/me")
    expect(res.body.signInUrl).toBe("/api/v1/auth/github")
  })

  it("advertises no sign-in URL when nothing is configured", async () => {
    // `stableAlt`: this test builds a second app, leaving `app` (on `stable`)
    // untouched for any test that runs after it.
    // A runtime with NO provider is what makes this app unconfigured now —
    // `config.githubAuth: null` alone no longer unregisters anything, and
    // `deps`'s runtime carries the fake provider from `beforeEach`.
    stableAlt.use(
      createApp({
        ...deps,
        config: loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }),
        github: testGithubRuntime(),
      }),
    )
    const noAuthApp = stableAlt.app
    const res = await request(noAuthApp).get("/api/v1/me")
    expect(res.body.signInUrl).toBeNull()
  })

  /**
   * THE load-bearing assertion for this refactor, exercised through the real
   * HTTP route rather than `getCurrentUser` directly (see
   * `current-user.test.ts` for the unit-level version). Before the
   * `sessionSecret`/`githubAuth` split, `config.auth` being null meant
   * `getCurrentUser` returned null unconditionally — a viewer with no GitHub
   * App configured could hold no sessions and could not service a single
   * write from its own UI. A signed cookie for a real session must now
   * resolve a real user through `/me` even with GitHub entirely unconfigured.
   */
  it("resolves a real session through /me when GitHub sign-in is not configured at all", async () => {
    const noAuthConfig = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
    expect(noAuthConfig.githubAuth).toBeNull()
    stableAlt.use(createApp({ ...deps, config: noAuthConfig, github: testGithubRuntime() }))
    const noAuthApp = stableAlt.app

    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "local-operator",
      email: "operator@localhost",
      displayName: "Local operator",
      avatarUrl: "",
      role: "admin",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(noAuthConfig.sessionSecret, session.id)

    const res = await request(noAuthApp).get("/api/v1/me").set("Cookie", `viewer_session=${signed}`)
    expect(res.status).toBe(200)
    expect(res.body.user?.id).toBe(user.id)
    // Distinct from `authEnabled` (which stays keyed on GitHub specifically,
    // per the "/me distinguishes" test above): a session can be live while
    // GitHub sign-in is unconfigured.
    expect(res.body.authEnabled).toBe(false)
  })

  /**
   * Task 7: `/me`'s `user` field is the whole `User` row (`res.json({ user,
   * ... })` in `auth-routes.ts` never projects it down), so `role` rides
   * along with no server change needed — this pins that rather than adding
   * a redundant projection. Uses `"viewer"`, a non-default role (the fixture
   * default is `"editor"`, and a fresh instance's first account gets
   * `"admin"` from the bootstrap rung), so the assertion can't pass by
   * coincidence with either default.
   */
  it("/me carries the signed-in user's instance role; the anonymous shape is unchanged", async () => {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "role-check",
      email: "role-check@example.test",
      displayName: "Role Check",
      avatarUrl: "",
      role: "viewer",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(deps.config.sessionSecret, session.id)

    const res = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${signed}`)
    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe("viewer")

    // The other half of this task's contract: an anonymous caller still gets
    // `user: null`, not an object with `role` merely absent — already pinned
    // exactly by the "/me distinguishes..." test above, restated here because
    // it's the other half of what this task changes.
    const anon = await request(app).get("/api/v1/me")
    expect(anon.body.user).toBeNull()
  })

  /**
   * Found by LIVE ACCEPTANCE, 658 unit tests green. `/me` resolved identity
   * from the cookie ONLY, which made it the single bearer-blind route under
   * `/api/v1/**` — and it is exactly the route a machine client points at to
   * ask "is my token alive?". A valid PAT returned `{user: null}`, so a live
   * token, a revoked token, and no credential at all were byte-identical:
   * the precise silent-failure mode the strict-401 rule exists to eliminate.
   */
  describe("/me obeys the same bearer rules as every other API route", () => {
    async function seedPat(email: string) {
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: email,
        email,
        displayName: email,
        avatarUrl: "",
      })
      const gen = generateMachineToken()
      await storage.createMachineToken({
        id: gen.id,
        userId: user.id,
        name: "t",
        scopes: ["read"],
        tokenHash: gen.tokenHash,
      })
      return { user, token: gen.token }
    }

    it("resolves the owning user for a valid PAT", async () => {
      const { user, token } = await seedPat("pat@x.com")
      const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(200)
      expect(res.body.user?.id).toBe(user.id)
      expect(res.body.authEnabled).toBe(true)
    })

    it("401s an unrecognized bearer even when a valid session cookie rides along", async () => {
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "cookie@x.com",
        email: "cookie@x.com",
        displayName: "C",
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(deps.config.sessionSecret, session.id)}`

      await request(app).get("/api/v1/me").set("Cookie", cookie).expect(200)
      await request(app)
        .get("/api/v1/me")
        .set("Cookie", cookie)
        .set("Authorization", "Bearer garbage")
        .expect(401)
    })

    it("401s a revoked PAT, so a machine client can tell a dead token from a live one", async () => {
      const { token } = await seedPat("revoked@x.com")
      await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(200)
      const id = token.slice("dsv_".length, token.indexOf("_", "dsv_".length))
      await storage.deleteMachineToken(id)
      await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`).expect(401)
    })
  })

  it("logout deletes the session so the cookie stops working", async () => {
    const start = await request(app).get("/api/v1/auth/github")
    const state = new URL(start.headers.location).searchParams.get("state")!
    const stateCookie = extractCookie(setCookies(start), "viewer_oauth_state")
    const callback = await request(app)
      .get(`/api/v1/auth/github/callback?code=good-code&state=${state}`)
      .set("Cookie", `viewer_oauth_state=${stateCookie}`)
    const session = extractCookie(setCookies(callback), "viewer_session")

    const logout = await request(app).post("/api/v1/auth/logout").set("Cookie", `viewer_session=${session}`)
    expect(logout.status).toBe(204)

    // Same cookie, reused deliberately — proves the storage row is gone
    // (not just that the client-side cookie got cleared).
    const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${session}`)
    expect(me.body.user).toBeNull()
    expect(me.body.authEnabled).toBe(true)
  })

  it("/me sets no-store + Vary on BOTH credential headers so a shared cache can't cross callers", async () => {
    const res = await request(app).get("/api/v1/me")
    expect(res.headers["cache-control"]).toBe("private, no-store")
    // `Authorization` belongs here as much as `Cookie`: this route resolves a
    // PAT too, and now reports that PAT's `scopes`. A cache that ignores
    // `no-store` but honours `Vary` — the exact cache this defends against —
    // would otherwise be free to hand one token holder's identity and scopes
    // to a different token, or to an anonymous caller.
    expect(res.headers["vary"]).toBe("Cookie, Authorization")
  })

  it("an expired session is rejected and swept", async () => {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "999",
      email: "expired@example.com",
      displayName: "Expired",
      avatarUrl: "https://avatars.example.com/e.png",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const signed = signSessionId(deps.config.sessionSecret, session.id)

    const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${signed}`)
    expect(me.body.user).toBeNull()
    expect(me.body.authEnabled).toBe(true)
    expect(await storage.getSession(session.id)).toBeNull()
  })

  /**
   * P1 from the pre-merge review: ownership stranding across the cutover.
   *
   * Projects created in local mode (the seeded demo included) are owned by
   * the synthetic `operator@localhost` row. Once GitHub sign-in is
   * configured, `/auth/local` self-disables, so nobody can ever BE that user
   * again — and the person's GitHub identity is a DIFFERENT row that owns
   * nothing. Recovery existed (admin bearer, POST members) but the default
   * flow shipped a silent trap.
   *
   * The handoff: possession of a live local-operator session at the moment of
   * GitHub sign-in IS proof of being the operator, because the token was
   * printed to the server's own stdout.
   */
  describe("local-operator ownership handoff at GitHub sign-in", () => {
    /** Seeds the operator, a project they own, a project they merely belong to, and a live session. */
    async function seedOperatorWithProjects() {
      const operator = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      const owned = await storage.createProject({ slug: "owned-demo", name: "Owned demo" })
      const joined = await storage.createProject({ slug: "joined", name: "Joined" })
      await storage.addProjectMember({ projectId: owned.id, userId: operator.id })
      await storage.addProjectMember({ projectId: joined.id, userId: operator.id })
      const session = await storage.createSession({
        userId: operator.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      return {
        operator,
        owned,
        joined,
        cookie: `viewer_session=${signSessionId(deps.config.sessionSecret, session.id)}`,
      }
    }

    /**
     * Admits the GitHub identity WITHOUT the handoff rung.
     *
     * The four "migrates nothing" tests below need the sign-in to succeed so
     * they can then show that nothing moved. Once the operator row exists,
     * `countUsers()` is nonzero, so the gate's bootstrap rung cannot admit and
     * a stranger would simply be refused — which would make those tests pass
     * for a reason that has nothing to do with the handoff. A domain rule is
     * the way in that does not involve an operator session at all, so it keeps
     * each test pointed at the property it names.
     */
    async function admitTheGitHubIdentityByDomainRule() {
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
    }

    // This used to assert the handoff preserved each row's `role` ("at the
    // same role"). `ProjectMember` carries no role, so what is left to
    // assert is that the membership rows exist for the GitHub identity.
    it("hands the operator's memberships to the GitHub identity", async () => {
      const { operator, owned, joined, cookie } = await seedOperatorWithProjects()
      const res = await signInWithGitHub(cookie)
      expect(res.status).toBe(302)

      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!
      expect(gitHubUser.id).not.toBe(operator.id)
      // A membership row is a membership row now — there is no role to carry
      // or flatten, so both of the operator's projects simply gain the
      // GitHub identity as a member.
      expect(await storage.getProjectMember(owned.id, gitHubUser.id)).not.toBeNull()
      expect(await storage.getProjectMember(joined.id, gitHubUser.id)).not.toBeNull()
    })

    /**
     * The gate's rung 4, from the outside. It exists because the operator's
     * own row makes `countUsers()` nonzero, so the first-user bootstrap can
     * never fire for them — without this rung the operator's first GitHub
     * sign-in would be refused on the deployment they own, and the handoff
     * below could never run.
     */
    it("admits the operator's GitHub identity as an admin, on an instance no other rung would let them into", async () => {
      const { cookie } = await seedOperatorWithProjects()
      expect(await storage.listDomainRules()).toEqual([])
      expect(await storage.countUsers()).toBe(1)

      const res = await signInWithGitHub(cookie)

      expect(res.headers.location).toBe("/")
      expect((await storage.getUserByEmail("mo@example.com"))?.role).toBe("admin")
    })

    // Formerly "last-owner guards". The owner role is gone; the surviving
    // guard is last-member.
    it("leaves the operator's own rows intact, so history and last-member guards are untouched", async () => {
      const { operator, owned, cookie } = await seedOperatorWithProjects()
      await signInWithGitHub(cookie)
      // Deliberately NOT a move. Removing the operator would trip the
      // last-member removal guard and orphan whatever their id is stamped on.
      expect(await storage.getProjectMember(owned.id, operator.id)).not.toBeNull()
      expect(await storage.getUser(operator.id)).not.toBeNull()
    })

    it("migrates nothing when the browser carries no operator session", async () => {
      // An arbitrary stranger signing in via GitHub. No operator cookie, so
      // there is nothing to prove possession of and nothing fires. This is
      // the property that makes the handoff safe rather than a land-grab.
      const { owned, joined } = await seedOperatorWithProjects()
      await admitTheGitHubIdentityByDomainRule()
      await signInWithGitHub()
      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!
      expect(await storage.getProjectMember(owned.id, gitHubUser.id)).toBeNull()
      expect(await storage.getProjectMember(joined.id, gitHubUser.id)).toBeNull()
    })

    it("migrates nothing when the carried session belongs to an ordinary user, not the operator", async () => {
      // The case that makes `isLocalOperatorUser` load-bearing rather than
      // decorative, and the one a "does it fire?" test set would miss.
      // Without that check this is a project-theft primitive: sign in as
      // yourself while holding a colleague's cookie — or one left behind on a
      // shared machine — and every project they belong to becomes yours.
      // The operator row is the ONLY identity nobody can sign in as any more,
      // which is the whole reason it gets this treatment and no one else does.
      const victim = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "99999",
        email: "victim@example.com",
        displayName: "Victim",
        avatarUrl: "",
      })
      const theirs = await storage.createProject({ slug: "theirs", name: "Theirs" })
      await storage.addProjectMember({ projectId: theirs.id, userId: victim.id })
      const session = await storage.createSession({
        userId: victim.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      await admitTheGitHubIdentityByDomainRule()

      await signInWithGitHub(`viewer_session=${signSessionId(deps.config.sessionSecret, session.id)}`)

      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!
      expect(gitHubUser.id).not.toBe(victim.id)
      expect(await storage.getProjectMember(theirs.id, gitHubUser.id)).toBeNull()
    })

    it("migrates nothing on an EXPIRED operator session — possession must be live", async () => {
      const operator = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "local-operator",
        email: "operator@localhost",
        displayName: "Local operator",
        avatarUrl: "",
        role: "admin",
      })
      const owned = await storage.createProject({ slug: "owned-demo", name: "Owned demo" })
      await storage.addProjectMember({ projectId: owned.id, userId: operator.id })
      const dead = await storage.createSession({
        userId: operator.id,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(deps.config.sessionSecret, dead.id)}`
      await admitTheGitHubIdentityByDomainRule()

      await signInWithGitHub(cookie)
      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!
      expect(await storage.getProjectMember(owned.id, gitHubUser.id)).toBeNull()
    })

    it("migrates nothing on a FORGED operator cookie", async () => {
      const { owned } = await seedOperatorWithProjects()
      await admitTheGitHubIdentityByDomainRule()
      await signInWithGitHub("viewer_session=not-a-real-signed-cookie")
      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!
      expect(await storage.getProjectMember(owned.id, gitHubUser.id)).toBeNull()
    })

    it("is idempotent — a second sign-in with the cookie still present changes nothing", async () => {
      const { owned, joined, cookie } = await seedOperatorWithProjects()
      await signInWithGitHub(cookie)
      const gitHubUser = (await storage.getUserByEmail("mo@example.com"))!

      // `addProjectMember` is a no-op for an existing (projectId, userId)
      // pair (there is no role to demote or re-promote any more), so a
      // second sign-in with the same cookie must not duplicate the row.
      const second = await signInWithGitHub(cookie)
      expect(second.status).toBe(302)
      expect(await storage.getProjectMember(owned.id, gitHubUser.id)).not.toBeNull()
      expect(await storage.getProjectMember(joined.id, gitHubUser.id)).not.toBeNull()
      expect(await storage.listProjectMembers(owned.id)).toHaveLength(2)
    })

    it("still signs the user in when the migration fails", async () => {
      // Same posture as the installations capture in this callback: the
      // migration is a convenience over paths that still exist manually, so a
      // storage hiccup must degrade rather than lock the person out of the
      // sign-in they just completed.
      const { cookie } = await seedOperatorWithProjects()
      storage.listProjectsForUser = async () => {
        throw new Error("simulated storage failure")
      }
      const res = await signInWithGitHub(cookie)
      expect(res.status).toBe(302)
      expect(extractCookie(setCookies(res), "viewer_session")).toBeTruthy()
    })

    /**
     * C2c. Without this, the boot-token session stays live in parallel with
     * the brand-new GitHub session — two working ways to act as an admin
     * where the person only meant to have the one they just switched to. The
     * operator token is a shared secret printed to stdout (see
     * `local-operator.ts`'s threat model); a session it minted should not go
     * on being usable once its holder has proven who they are some other way.
     */
    it("closes the operator's own session once the handoff completes", async () => {
      const { cookie } = await seedOperatorWithProjects()

      const res = await signInWithGitHub(cookie)
      expect(res.status).toBe(302)

      const me = await request(app).get("/api/v1/me").set("Cookie", cookie)
      expect(me.body.user).toBeNull()
    })

    it("does not touch the operator's session when there is no operator session to hand off from", async () => {
      // Control case: an ordinary GitHub sign-in with no operator cookie at
      // all must not go anywhere near this cleanup.
      const { operator, cookie: operatorCookie } = await seedOperatorWithProjects()
      await admitTheGitHubIdentityByDomainRule()

      await signInWithGitHub()

      const me = await request(app).get("/api/v1/me").set("Cookie", operatorCookie)
      expect(me.body.user?.id).toBe(operator.id)
    })
  })

  /**
   * Local-operator sign-in: the zero-configuration way to get a session when
   * no GitHub sign-in is configured. `auth/local-operator.ts` carries the
   * threat model — the short version is that the token is only ever offered
   * when no real identity provider exists, so it is never a SECOND way in
   * alongside one.
   */
  describe("GET /auth/local", () => {
    it("sets a session cookie and redirects home with the right token", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      const session = extractCookie(setCookies(res), "viewer_session")
      expect(session).toBeTruthy()

      // The point of the route: an ORDINARY session for an ORDINARY user row,
      // resolvable through the same `/me` every other caller uses. A 302 with
      // a cookie that resolves to nobody would satisfy the assertions above
      // and still leave every write 401ing.
      const me = await request(stable.app)
        .get("/api/v1/me")
        .set("Cookie", `viewer_session=${session}`)
      expect(me.status).toBe(200)
      expect(me.body.user?.email).toBe("operator@localhost")
      expect(me.body.authEnabled).toBe(false)
    })

    it("401s on a wrong token and sets no cookie", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app).get("/api/v1/auth/local?token=wrong")
      expect(res.status).toBe(401)
      expect(setCookies(res)).toEqual([])
    })

    it("401s with no token at all, rather than treating absent as empty-matches-empty", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app).get("/api/v1/auth/local")
      expect(res.status).toBe(401)
      expect(setCookies(res)).toEqual([])
    })

    it("404s when no local token is configured", async () => {
      stable.use(createApp(baseDeps()))
      const res = await request(stable.app).get("/api/v1/auth/local?token=anything")
      expect(res.status).toBe(404)
    })

    /**
     * Fix wave M1 review. Before this fix, `/auth/local` bypassed the
     * admission gate entirely (it isn't a provider sign-in), so an admin
     * removing the operator's row from the Members panel had no effect here
     * — the same boot token kept minting fresh sessions for it forever, the
     * one credential a removal is supposed to kill.
     */
    it("sends a REMOVED operator to /denied, minting no session and setting no cookie", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))

      // Establish the operator row first (an ordinary sign-in), then remove it.
      const first = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      const firstSession = extractCookie(setCookies(first), "viewer_session")
      expect(firstSession).toBeTruthy()
      const operator = await storage.getUserByEmail("operator@localhost")
      expect(operator).not.toBeNull()
      await storage.setUserStatus(operator!.id, "removed")

      const res = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied")
      expect(setCookies(res)).toEqual([])
    })

    it("an ACTIVE operator is unaffected by the removed-status check", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      expect(extractCookie(setCookies(res), "viewer_session")).toBeTruthy()
    })

    it("signs out a local-operator session", async () => {
      // Guards the logout relocation: `POST /auth/logout` used to sit BEHIND
      // the `if (!auth || !provider) return router` early return, so a
      // local-operator session had no way to end — the account menu's
      // sign-out would 404 on exactly the deployment that has no other way in.
      //
      // The plan specified a `request.agent` for the cookie jar. This suite's
      // `supertest` import is ALIASED to `__tests__/supertest-reuse.ts`
      // (see vitest.config.ts), whose default export is a bare function with
      // no `.agent` property — `request.agent(app)` throws there. Carrying the
      // cookie by hand is what the GitHub logout test above already does, and
      // it exercises the identical sequence.
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const signIn = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      const session = extractCookie(setCookies(signIn), "viewer_session")
      expect(session).toBeTruthy()

      const res = await request(stable.app)
        .post("/api/v1/auth/logout")
        .set("Cookie", `viewer_session=${session}`)
      expect(res.status).toBe(204)

      // Same cookie, reused deliberately — proves the storage row is gone,
      // not merely that this browser's copy was cleared.
      const me = await request(stable.app)
        .get("/api/v1/me")
        .set("Cookie", `viewer_session=${session}`)
      expect(me.body.user).toBeNull()
    })

    /**
     * THE point of this route is that an operator PASTES the printed URL into
     * a browser, which makes it a top-level navigation carrying
     * `Sec-Fetch-Dest: document`. `createDocumentDestinationGuard`
     * (api-router.ts) refuses those across all of `/api/v1/**` unless the path
     * is in `DOCUMENT_NAVIGATION_ROUTES`, so without the exemption the printed
     * URL 403s in every modern browser and the handler never runs.
     *
     * A curl transcript cannot catch this: the guard fails OPEN when the
     * header is absent, and curl sends none. These two tests go through the
     * REAL `createApp` mount, so they exercise the guard and the route
     * together — a guard-only unit test would pass against a stub handler.
     */
    it("survives the document-destination guard, which is how a pasted URL arrives", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app)
        .get("/api/v1/auth/local?token=correct-horse")
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(302)
      expect(extractCookie(setCookies(res), "viewer_session")).toBeTruthy()
    })

    it("still 401s a wrong token as a document navigation — the exemption is not an auth bypass", async () => {
      stable.use(createApp({ ...baseDeps(), localOperatorToken: "correct-horse" }))
      const res = await request(stable.app)
        .get("/api/v1/auth/local?token=wrong")
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(401)
      expect(setCookies(res)).toEqual([])
    })

    /**
     * The other half of the registration conversion, and the reason
     * `/auth/local`'s guard is INVERTED rather than absent.
     *
     * Boot config here has no GitHub sign-in — so under the old shape this
     * route registered, and would have kept accepting the stdout-printed
     * token for the whole life of the process. A provider that appears
     * mid-process (the manifest flow) has to switch it off AT ONCE: a
     * deployment with a real identity provider must never also carry a
     * master key that reaches its operator through a terminal scrollback.
     */
    it("404s the instant a provider appears in the runtime, token or no token", async () => {
      const unconfiguredBoot = baseDeps()
      expect(unconfiguredBoot.config.githubAuth).toBeNull()
      stable.use(
        createApp({
          ...unconfiguredBoot,
          localOperatorToken: "correct-horse",
          github: testGithubRuntime({ overrides: { authProvider: fakeProvider } }),
        }),
      )
      const disabled = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      expect(disabled.status).toBe(404)
      expect(setCookies(disabled)).toEqual([])

      // And it is INDISTINGUISHABLE from a deployment that never minted a
      // token at all. Compared against a real response rather than a literal:
      // the claim is that the two cases share one code path, and only two
      // actual responses can show that. A bespoke `{"error":"Not found"}`
      // would tell an anonymous caller that this deployment has a boot token
      // AND has since grown a real provider.
      stableAlt.use(createApp({ ...baseDeps(), github: testGithubRuntime() }))
      const neverMinted = await request(stableAlt.app).get("/api/v1/auth/local?token=correct-horse")
      expect(neverMinted.status).toBe(disabled.status)
      expect(neverMinted.body).toEqual(disabled.body)
    })

    it("404s when a GitHub provider is live, even with a token supplied", async () => {
      // Mutual exclusion by construction, not by precedence: a deployment
      // with a real identity provider must not ALSO carry a stdout-printed
      // master key, even if something upstream hands one down.
      //
      // Checked against the LIVE provider rather than the boot config, so it
      // also holds for a provider that appeared mid-process (the App Manifest
      // flow) — the case where a registration-time decision would have left
      // the printed token working until the next restart.
      stable.use(
        createApp({
          ...baseDeps({ VIEWER_GITHUB_CLIENT_ID: "id", VIEWER_GITHUB_CLIENT_SECRET: "secret" }),
          localOperatorToken: "correct-horse",
        }),
      )
      const res = await request(stable.app).get("/api/v1/auth/local?token=correct-horse")
      expect(res.status).toBe(404)
      // The router's terminal 404 — see the byte-identity test above.
      expect(res.body).toEqual({
        error: "Not found: GET /api/v1/auth/local?token=correct-horse",
      })
    })
  })
})

/**
 * Task 10 — the GitHub App Manifest start/callback routes.
 *
 * Every GitHub-facing constant asserted here was checked against a real
 * manifest run on github.com on 2026-08-20 (see the task report). Two things
 * a docs-only pass got wrong, and which these tests now pin:
 *
 * - the manifest endpoint wants the permission key `emails`, NOT the REST
 *   API's name for the same permission, `email_addresses`. Sending the REST
 *   name makes GitHub reject the whole manifest.
 * - a loopback `publicUrl` (localhost, 127.0.0.1, `*.localhost`, …) must omit
 *   `hook_attributes` and `default_events` entirely. GitHub rejects the whole
 *   manifest if a hook URL isn't reachable over the public Internet — a
 *   non-loopback `publicUrl` still gets both fields.
 * - the App-name limit is exactly 34 characters ("The name cannot be longer
 *   than 34 characters").
 *
 * The network call is injected (`AppDeps.exchangeManifestCode`), so nothing
 * in this file touches github.com.
 */
import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import express from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AssetStore } from "../../assets/types"
import { generateMachineToken } from "../../auth/machine-token"
import { ensureLocalOperatorUser } from "../../auth/local-operator"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { isSecurePublicUrl } from "../state-cookie"
import { loadConfig, type ViewerConfig } from "../../config"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import type { GithubRuntime } from "../../github-runtime"
import { updateRuntimeConfig, type RuntimeConfigFile } from "../../runtime-config"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { MachineTokenScope } from "../../storage/types"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { buildAppName, type ManifestConversion } from "../setup-routes"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

/**
 * A REAL key pair, generated once for the file. The callback validates the
 * PEM GitHub returns before persisting it (see `setup-routes.ts`), so a
 * placeholder string would fail for the right reason in the wrong test.
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

const CONVERSION: ManifestConversion = {
  id: 987654,
  slug: "desde-viewer-localhost-3100",
  pem: PEM,
  client_id: "Iv1.abc123",
  client_secret: "client-secret-value",
  webhook_secret: "webhook-secret-value",
}

/**
 * Every `VIEWER_*` variable this suite cares about, pinned on `process.env`.
 *
 * It has to be `process.env` and not just a config object: the callback
 * re-reads configuration with a bare `loadConfig()` after persisting (the
 * env-wins precedence lives in `loadConfig`, so patching the in-memory
 * config would duplicate it). A test that only passed `VIEWER_DATA_DIR`
 * through the config object would have that re-read look at the DEFAULT data
 * directory and never see what the callback just wrote.
 *
 * The GitHub variables are explicitly cleared so an ambient `.env` on a
 * developer's machine cannot configure an App out from under a test whose
 * whole subject is "no App is configured yet".
 */
function stubViewerEnv(dataDir: string, extra: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    VIEWER_DATA_DIR: dataDir,
    VIEWER_SESSION_SECRET: "sesh-secret",
    VIEWER_PUBLIC_URL: "http://localhost:3100",
    VIEWER_ADMIN_TOKEN: undefined,
    VIEWER_GITHUB_APP_ID: undefined,
    VIEWER_GITHUB_APP_PRIVATE_KEY: undefined,
    VIEWER_GITHUB_APP_SLUG: undefined,
    VIEWER_GITHUB_APP_WEBHOOK_SECRET: undefined,
    VIEWER_GITHUB_CLIENT_ID: undefined,
    VIEWER_GITHUB_CLIENT_SECRET: undefined,
    VIEWER_GITHUB_API_BASE_URL: undefined,
    VIEWER_SMTP_HOST: undefined,
    ...extra,
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
}

function setCookies(res: { headers: Record<string, string> }): string[] {
  const raw = res.headers["set-cookie"] as unknown as string | string[] | undefined
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

function findCookie(setCookie: string[], name: string): string | null {
  return setCookie.find((raw) => raw.split("=")[0] === name) ?? null
}

function cookieValue(setCookie: string[], name: string): string | null {
  const raw = findCookie(setCookie, name)
  if (raw === null) return null
  const pair = raw.split(";")[0]
  return decodeURIComponent(pair.slice(pair.indexOf("=") + 1))
}

/** The persisted runtime config, straight off disk — never through `loadConfig`. */
function persisted(dataDir: string): Partial<RuntimeConfigFile> {
  return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Partial<RuntimeConfigFile>
}

/**
 * The name rule at the unit, where the boundary is actually visible. The
 * HTTP tests can only show that SOME long host got clipped; these pin the
 * exact budget, which is what a future edit to the prefix would break.
 *
 * 34 is GitHub's documented hard limit ("The name cannot be longer than 34
 * characters"), so the interesting cases are 33/34/35 characters of output,
 * not a vaguely long domain.
 */
describe("buildAppName", () => {
  it("stamps the host, port included, when the whole name fits", () => {
    expect(buildAppName("http://localhost:3100")).toBe("Desde Viewer (localhost:3100)")
    expect(buildAppName("http://localhost:3100")).toHaveLength(29)
  })

  it("leaves a host alone at exactly the limit", () => {
    // "Desde Viewer (" is 14 and ")" is 1, so a 19-character host lands on 34.
    const host = "abcdefghijklmnopqrs"
    expect(host).toHaveLength(19)
    expect(buildAppName(`http://${host}`)).toBe(`Desde Viewer (${host})`)
    expect(buildAppName(`http://${host}`)).toHaveLength(34)
  })

  it("clips one character past the limit rather than letting GitHub reject it", () => {
    const name = buildAppName("http://abcdefghijklmnopqrst")
    expect(name).toBe("Desde Viewer (abcdefghijklmnopqrs)")
    expect(name).toHaveLength(34)
  })

  it("keeps the LEADING host labels, which are what distinguish deployments", () => {
    const name = buildAppName("https://viewer.prototypes.a-very-long-company-name.example.com")
    expect(name).toBe("Desde Viewer (viewer.prototypes.a)")
    expect(name).toHaveLength(34)
  })

  it("drops the port when the host alone exhausts the budget", () => {
    // A deliberate trade, recorded so it is not mistaken for a bug: the
    // subdomain identifies the deployment more often than the port does, and
    // the operator can retype the name on GitHub's confirmation page either
    // way.
    expect(buildAppName("http://staging.example.com:3100")).toBe("Desde Viewer (staging.example.com)")
  })
})

describe("setup routes — GitHub App Manifest flow", () => {
  let storage: InMemoryStorage
  let dataDir: string
  let config: ViewerConfig
  let github: GithubRuntime
  let reloaded: ViewerConfig[]
  let exchanged: string[]
  let exchange: (code: string) => Promise<ManifestConversion>
  let app: express.Express

  const stable = createSwappableApp()

  /**
   * Rebuilds every dependency against the CURRENT `dataDir`/`process.env`.
   * Called from `beforeEach`, and again by the tests that first have to put
   * a `githubApp` on disk.
   */
  function build(): void {
    config = loadConfig()
    github = testGithubRuntime({ config })
    reloaded = []
    // Replaced outright rather than spied: the real `reload` would build a
    // live `GitHubAppClient` and a live build queue from the credentials the
    // callback just persisted. What this suite is about is that reload is
    // CALLED, once, with a config that carries them — Task 9's own suite owns
    // what reload then does.
    github.reload = vi.fn((next: ViewerConfig) => {
      reloaded.push(next)
    })
    const deps: AppDeps = {
      storage,
      assets: nullAssets,
      config,
      bridgeScript: "// bridge",
      github,
      exchangeManifestCode: (code: string) => {
        exchanged.push(code)
        return exchange(code)
      },
    }
    stable.use(createApp(deps))
    app = stable.app
  }

  beforeEach(() => {
    storage = new InMemoryStorage()
    dataDir = tmpViewerDataDir()
    exchanged = []
    exchange = async () => CONVERSION
    stubViewerEnv(dataDir)
    build()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** Rebuilds the app with extra environment on top of the suite defaults. */
  function rebuildWith(extra: Record<string, string | undefined>): void {
    vi.unstubAllEnvs()
    stubViewerEnv(dataDir, extra)
    build()
  }

  async function sessionCookieFor(userId: string): Promise<string> {
    const session = await storage.createSession({
      userId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    // The cookie name tracks the transport: __Host-viewer_session on an https
    // deployment (the operator middleware reads only that name there), plain
    // viewer_session on http. Without this, an https `rebuildWith` test would
    // hand the server a name it no longer reads and every route would 403.
    const name = sessionCookieName(isSecurePublicUrl(config.publicUrl))
    return `${name}=${signSessionId(config.sessionSecret, session.id)}`
  }

  /**
   * The DEPLOYMENT OPERATOR — the identity the stdout boot token signs you in
   * as. Built through `ensureLocalOperatorUser`, the same function the real
   * `/auth/local` route uses, so the sentinel these routes authorize on can
   * never drift from the one that mints it.
   */
  async function signIn(): Promise<string> {
    const user = await ensureLocalOperatorUser(storage)
    return sessionCookieFor(user.id)
  }

  /**
   * An ordinary signed-in person — a reviewer who logged in with GitHub. The
   * P1 this suite guards: `requireWrite` passed exactly this caller, so any
   * reviewer on a sign-in-configured deployment could provision the whole
   * deployment's GitHub credentials under an App on their own account.
   */
  async function signInAsReviewer(): Promise<string> {
    const user = await upsertTestUser(storage, {
      provider: "github",
      // Numeric, as GitHub's real ids are — the shape that can never collide
      // with the `local-operator` sentinel.
      providerUserId: "4815162342",
      email: "reviewer@example.com",
      displayName: "Reviewer",
      avatarUrl: "",
    })
    return sessionCookieFor(user.id)
  }

  /**
   * An instance ADMIN, signed in the ordinary way (viewer-membership I2) —
   * not the operator's bearer/session, not the local-operator sentinel. An
   * `admin`-role account holds `hasAdminAuthority` the same way the bearer
   * does, and this suite proves the setup routes now honour that.
   */
  async function signInAsAdmin(): Promise<string> {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "112358",
      email: "admin@example.com",
      displayName: "Admin",
      avatarUrl: "",
      role: "admin",
    })
    return sessionCookieFor(user.id)
  }

  /**
   * A live machine token owned by the OPERATOR. Deliberately the operator and
   * not a bystander: the interesting refusal is the one where the identity
   * behind the token would otherwise pass, so the test proves the token LANE
   * is closed rather than merely that a stranger is refused.
   */
  async function operatorPat(scopes: MachineTokenScope[]): Promise<string> {
    const user = await ensureLocalOperatorUser(storage)
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "seeded",
      scopes,
      tokenHash: gen.tokenHash,
      expiresAt: null,
    })
    return `Bearer ${gen.token}`
  }

  /**
   * A live machine token owned by an instance ADMIN (viewer-membership I2).
   * `hasAdminAuthority` is true for this user's SESSION, so this proves the
   * `scopes !== null` PAT refusal is checked independently of it — an admin's
   * own PAT must be exactly as closed a lane as the operator's.
   */
  async function adminPat(scopes: MachineTokenScope[]): Promise<string> {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "271828",
      email: "admin-pat@example.com",
      displayName: "Admin",
      avatarUrl: "",
      role: "admin",
    })
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "seeded",
      scopes,
      tokenHash: gen.tokenHash,
      expiresAt: null,
    })
    return `Bearer ${gen.token}`
  }

  /** Persists a `githubApp` and rebuilds, so the deployment looks already-configured. */
  function configureApp(): void {
    updateRuntimeConfig(dataDir, {
      githubApp: {
        appId: "1",
        slug: "already-here",
        privateKeyPem: PEM,
        clientId: "Iv1.existing",
        clientSecret: "existing-secret",
      },
    })
    build()
  }

  /** Starts the flow and returns the minted state plus the cookie header to send back. */
  async function startFlow(cookie: string): Promise<{ state: string; cookieHeader: string }> {
    const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
    expect(res.status).toBe(200)
    const state = res.body.state as string
    return { state, cookieHeader: `${cookie}; viewer_setup_state=${encodeURIComponent(state)}` }
  }

  // --- GET /setup/github/manifest -----------------------------------------

  describe("GET /setup/github/manifest", () => {
    it("returns a manifest pointing every URL back at this deployment", async () => {
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(200)
      expect(res.body.manifest).toMatchObject({
        url: "http://localhost:3100",
        redirect_url: "http://localhost:3100/api/v1/setup/github/callback",
        callback_urls: ["http://localhost:3100/api/v1/auth/github/callback"],
        // `true`, and this is load-bearing rather than incidental. GitHub
        // uses this one flag for both "who may install this App" and "who
        // may authorize it to sign in", so `false` means only the creating
        // account can ever sign in. MEASURED 2026-09-01: a second GitHub
        // account got a bare 404 from `/login/oauth/authorize`. On a
        // multi-user viewer whose App IS the sign-in method, that is an
        // instance that can never admit a second person.
        public: true,
      })
      expect(typeof res.body.state).toBe("string")
      expect((res.body.state as string).length).toBeGreaterThan(16)
    })

    it("requests `emails`, the key the manifest endpoint accepts — NOT the REST name `email_addresses`", async () => {
      // MEASURED live against github.com, 2026-08-20: the manifest endpoint
      // rejects `email_addresses` (the REST API's name for this permission)
      // with "Default permission records resource is not included in the
      // list". `emails` is what it wants. `contents` is what the build
      // runner clones with; nothing here is write.
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.default_permissions).toEqual({
        contents: "read",
        emails: "read",
      })
    })

    // --- loopback vs. public hook_attributes --------------------------------
    //
    // MEASURED live against github.com, 2026-08-20: a loopback `publicUrl`
    // makes GitHub reject the WHOLE manifest with "Hook url is not supported
    // because it isn't reachable over the public Internet (localhost)". So a
    // loopback deployment must omit `hook_attributes` and `default_events`
    // entirely, not merely mark the hook inactive.

    it("omits hook_attributes and default_events for a localhost publicUrl", async () => {
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.hook_attributes).toBeUndefined()
      expect(res.body.manifest.default_events).toBeUndefined()
    })

    it("omits hook_attributes and default_events for a *.localhost publicUrl", async () => {
      rebuildWith({ VIEWER_PUBLIC_URL: "http://viewer.localhost:3100" })
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.hook_attributes).toBeUndefined()
      expect(res.body.manifest.default_events).toBeUndefined()
    })

    it("omits setup_url on a loopback publicUrl — same caution as hook_attributes", async () => {
      // A setup redirect happens in the operator's own browser, so loopback
      // SHOULD be fine — but the manifest endpoint provably validates some
      // URLs (the hook rejection is MEASURED) and documents none of it, and a
      // rejected manifest would break the zero-config first boot. See
      // buildAppManifest.
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.setup_url).toBeUndefined()
    })

    it("sets setup_url to the public URL on a non-loopback deployment, so installing the App returns the person here", async () => {
      rebuildWith({ VIEWER_PUBLIC_URL: "https://viewer.example.com" })
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.setup_url).toBe("https://viewer.example.com")
    })

    it("includes hook_attributes and default_events for a public, non-loopback publicUrl", async () => {
      rebuildWith({ VIEWER_PUBLIC_URL: "https://viewer.example.com" })
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.hook_attributes).toEqual({
        url: "https://viewer.example.com/api/v1/webhooks/github",
        active: true,
      })
      expect(res.body.manifest.default_events).toEqual(["push"])
    })

    it("sets a single-use state cookie that matches the returned state", async () => {
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      const raw = findCookie(setCookies(res), "viewer_setup_state")
      expect(raw).not.toBeNull()
      expect(raw).toContain("HttpOnly")
      expect(raw).toContain("SameSite=Lax")
      expect(raw).toContain("Max-Age=600")
      // publicUrl is http here, so the cookie must NOT be Secure or the
      // browser would never send it back on localhost.
      expect(raw).not.toContain("Secure")
      expect(cookieValue(setCookies(res), "viewer_setup_state")).toBe(res.body.state)
    })

    it("marks the response uncacheable — it carries a per-request nonce", async () => {
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.headers["cache-control"]).toBe("private, no-store")
    })

    it("names the App after the deployment host", async () => {
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)
      expect(res.body.manifest.name).toBe("Desde Viewer (localhost:3100)")
      expect((res.body.manifest.name as string).length).toBeLessThanOrEqual(34)
    })

    it("truncates the host so a long domain still fits GitHub's 34-character limit", async () => {
      rebuildWith({
        VIEWER_PUBLIC_URL: "https://viewer.prototypes.a-very-long-company-name.example.com",
      })
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(200)
      const name = res.body.manifest.name as string
      expect(name.length).toBeLessThanOrEqual(34)
      expect(name.startsWith("Desde Viewer (")).toBe(true)
      expect(name.endsWith(")")).toBe(true)
      // https deployment => the state cookie carries Secure AND the __Host-
      // prefix (host-only, Path=/, Secure) that closes the tossing vector.
      expect(findCookie(setCookies(res), "__Host-viewer_setup_state")).toContain("Secure")
      // And the unprefixed name is NOT set on https.
      expect(findCookie(setCookies(res), "viewer_setup_state")).toBeNull()
    })

    it("409s when a GitHub App is already configured — never a silent second App", async () => {
      configureApp()
      const cookie = await signIn()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(409)
      expect(setCookies(res)).toHaveLength(0)
    })

    it("401s an anonymous caller, and tells it nothing about the deployment", async () => {
      const res = await request(app).get("/api/v1/setup/github/manifest")
      expect(res.status).toBe(401)
      expect(res.body.manifest).toBeUndefined()
    })

    it("403s an ordinary signed-in reviewer — this is operator authority, not write authority", async () => {
      // THE P1. `requireWrite` passed this caller: with no `:id` in the path
      // it accepts anyone signed in. On a deployment with GitHub sign-in
      // configured and no App yet, that is every reviewer, and completing the
      // flow would install THEIR GitHub App as the whole deployment's
      // identity.
      const cookie = await signInAsReviewer()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: "Only an admin of this viewer can set up the GitHub App." })
      expect(res.body.manifest).toBeUndefined()
      expect(setCookies(res)).toHaveLength(0)
    })

    it("403s a machine token, read-only or write, even the operator's own", async () => {
      // A `dsv_` token is built to be handed to CI. Nothing about provisioning
      // a GitHub App is a CI operation, and the callback is a browser
      // navigation regardless — so the token lane is closed for both scopes.
      for (const scopes of [["read"], ["read", "write"]] as MachineTokenScope[][]) {
        const bearer = await operatorPat(scopes)
        const res = await request(app)
          .get("/api/v1/setup/github/manifest")
          .set("Authorization", bearer)
        expect(res.status).toBe(403)
      }
    })

    it("accepts the admin bearer — the README's operator credential", async () => {
      rebuildWith({ VIEWER_ADMIN_TOKEN: "operator-token" })
      const res = await request(app)
        .get("/api/v1/setup/github/manifest")
        .set("Authorization", "Bearer operator-token")

      expect(res.status).toBe(200)
      expect(res.body.manifest.name).toBe("Desde Viewer (localhost:3100)")
      expect(findCookie(setCookies(res), "viewer_setup_state")).not.toBeNull()
    })

    /**
     * I2: instance Admins can run the GitHub App setup flow, not only the
     * operator's own out-of-band bearer/session. An Admin already manages
     * every member and every project; provisioning the App the whole
     * instance builds through is the same kind of act.
     */
    it("admits a signed-in ADMIN session", async () => {
      const cookie = await signInAsAdmin()
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(200)
      expect(res.body.manifest.name).toBe("Desde Viewer (localhost:3100)")
      expect(findCookie(setCookies(res), "viewer_setup_state")).not.toBeNull()
    })

    it("still 403s a signed-in EDITOR — instance-admin authority only, not any member", async () => {
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "31415926",
        email: "editor@example.com",
        displayName: "Editor",
        avatarUrl: "",
        role: "editor",
      })
      const cookie = await sessionCookieFor(user.id)
      const res = await request(app).get("/api/v1/setup/github/manifest").set("Cookie", cookie)

      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: "Only an admin of this viewer can set up the GitHub App." })
    })

    it("403s an Admin's own machine token (PAT) — the token lane is closed regardless of role", async () => {
      for (const scopes of [["read"], ["read", "write"]] as MachineTokenScope[][]) {
        const bearer = await adminPat(scopes)
        const res = await request(app)
          .get("/api/v1/setup/github/manifest")
          .set("Authorization", bearer)
        expect(res.status).toBe(403)
      }
    })

    it("is NOT reachable as a document — it is fetched by page JS", async () => {
      const cookie = await signIn()
      const res = await request(app)
        .get("/api/v1/setup/github/manifest")
        .set("Cookie", cookie)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
    })
  })

  // --- GET /setup/github/callback -----------------------------------------

  describe("GET /setup/github/callback", () => {
    it("persists the App, reloads once, and sends the operator to install it", async () => {
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=good-code&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(
        "https://github.com/apps/desde-viewer-localhost-3100/installations/new",
      )
      expect(exchanged).toEqual(["good-code"])

      expect(persisted(dataDir).githubApp).toEqual({
        appId: "987654",
        slug: "desde-viewer-localhost-3100",
        privateKeyPem: PEM,
        clientId: "Iv1.abc123",
        clientSecret: "client-secret-value",
        webhookSecret: "webhook-secret-value",
      })

      expect(github.reload).toHaveBeenCalledTimes(1)
      // Re-read from source, so the reloaded config carries what was just
      // written — and carries it through the env-wins precedence rather than
      // around it.
      expect(reloaded[0]?.githubApp?.appId).toBe("987654")
      expect(reloaded[0]?.githubApp?.slug).toBe("desde-viewer-localhost-3100")
    })

    it("returns to a same-origin `next` path instead of the install page, when the flow supplied one", async () => {
      const cookie = await signIn()
      const next = "/?connect=p-1"
      const res0 = await request(app)
        .get(`/api/v1/setup/github/manifest?next=${encodeURIComponent(next)}`)
        .set("Cookie", cookie)
      expect(res0.status).toBe(200)
      // The path rides its own cookie, minted alongside the state.
      expect(cookieValue(setCookies(res0), "viewer_setup_return")).toBe(next)
      const state = res0.body.state as string

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=good-code&state=${encodeURIComponent(state)}`)
        .set(
          "Cookie",
          `${cookie}; viewer_setup_state=${encodeURIComponent(state)}; viewer_setup_return=${encodeURIComponent(next)}`,
        )

      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(next)
      // The App was still persisted — the destination changed, not the work.
      expect(persisted(dataDir).githubApp?.slug).toBe("desde-viewer-localhost-3100")
    })

    it("refuses a cross-origin `next`: the return cookie is cleared, and even a forged cookie cannot move the redirect off this origin", async () => {
      const cookie = await signIn()
      const res0 = await request(app)
        .get(`/api/v1/setup/github/manifest?next=${encodeURIComponent("https://evil.example/")}`)
        .set("Cookie", cookie)
      expect(res0.status).toBe(200)
      // A refused `next` clears the return cookie rather than storing it.
      expect(cookieValue(setCookies(res0), "viewer_setup_return")).toBe("")
      const state = res0.body.state as string

      // Belt and braces: `safeReturnPath` runs AGAIN on the cookie at the
      // callback, so a hostile value planted directly in the cookie still
      // degrades to the default install-page redirect.
      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=good-code&state=${encodeURIComponent(state)}`)
        .set(
          "Cookie",
          `${cookie}; viewer_setup_state=${encodeURIComponent(state)}; viewer_setup_return=${encodeURIComponent("https://evil.example/")}`,
        )

      expect(res.status).toBe(302)
      expect(res.headers.location).toContain("/installations/new")
    })

    it("omits webhookSecret when GitHub does not return one", async () => {
      exchange = async () => {
        const { webhook_secret: _drop, ...rest } = CONVERSION
        return rest
      }
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(302)
      expect(persisted(dataDir).githubApp).not.toHaveProperty("webhookSecret")
    })

    it("clears the state cookie on success", async () => {
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(findCookie(setCookies(res), "viewer_setup_state")).toContain("Max-Age=0")
    })

    it("400s a mismatched state, writes nothing, and never calls GitHub", async () => {
      const cookie = await signIn()
      const { cookieHeader } = await startFlow(cookie)

      const res = await request(app)
        .get("/api/v1/setup/github/callback?code=c&state=not-the-one")
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(400)
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      expect(findCookie(setCookies(res), "viewer_setup_state")).toContain("Max-Age=0")
    })

    it("400s when the state cookie is absent altogether", async () => {
      const cookie = await signIn()
      const { state } = await startFlow(cookie)
      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookie)

      expect(res.status).toBe(400)
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp).toBeUndefined()
    })

    it("400s when GitHub sends no code", async () => {
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const res = await request(app)
        .get(`/api/v1/setup/github/callback?state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(400)
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp).toBeUndefined()
    })

    it("502s a failed conversion without echoing GitHub's error, and persists nothing", async () => {
      exchange = async () => {
        throw new Error("simulated: manifest code expired (422)")
      }
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(502)
      expect(JSON.stringify(res.body)).not.toContain("422")
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it("502s a stalled GitHub connection, through the same generic error path", async () => {
      // `exchangeManifestCodeWithGitHub` passes `AbortSignal.timeout(15_000)`,
      // and a fetch aborted by it rejects with EXACTLY this value — measured
      // on Node 25.9 against a server that accepts and never answers. The
      // point of the test is that an abort is an ordinary rejection with no
      // special handling anywhere: it reaches the same catch, the same log,
      // and the same generic 502 as a 422 would, and it persists nothing.
      exchange = async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
      }
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(502)
      expect(res.body).toEqual({ error: "Failed to create the GitHub App" })
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it("502s a conversion whose shape is wrong, rather than persisting garbage", async () => {
      // A `pem` that is not a private key is the case that matters: the App
      // would look configured and fail on the first GitHub call instead.
      exchange = async () => ({ ...CONVERSION, pem: "not-a-pem" })
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(502)
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      error.mockRestore()
    })

    it("502s a conversion with a non-numeric app id", async () => {
      exchange = async () => ({ ...CONVERSION, id: "not-a-number" })
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(502)
      expect(persisted(dataDir).githubApp).toBeUndefined()
      error.mockRestore()
    })

    it("409s a replayed callback once an App exists, rather than overwriting it", async () => {
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      configureApp()

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(409)
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp?.slug).toBe("already-here")
    })

    it("409s rather than overwriting an App that got configured mid-conversion", async () => {
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)
      // The window the second check exists for: the deployment becomes
      // configured while this conversion is in flight, which is what two
      // setup tabs opened at the same time produce.
      exchange = async () => {
        github.config = {
          ...github.config,
          githubApp: { appId: "1", slug: "the-first-one", privateKeyPem: PEM },
        }
        return CONVERSION
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)

      expect(res.status).toBe(409)
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it("403s an ordinary signed-in reviewer, exchanges nothing, and still clears the state cookie", async () => {
      // The other half of the P1: refusing only the manifest route would leave
      // the callback open to a reviewer who had obtained a state some other
      // way. Both ends are gated.
      const cookie = await signIn()
      const { state } = await startFlow(cookie)
      const reviewer = await signInAsReviewer()

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", `${reviewer}; viewer_setup_state=${encodeURIComponent(state)}`)

      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: "Only an admin of this viewer can set up the GitHub App." })
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp).toBeUndefined()
      expect(github.reload).not.toHaveBeenCalled()
      // The clear rides the 403 too — it is set before the gate runs.
      expect(findCookie(setCookies(res), "viewer_setup_state")).toContain("Max-Age=0")
    })

    it("accepts the admin bearer at the gate, though a real redirect cannot carry one", async () => {
      // Asserting what the code does, with the caveat recorded rather than
      // implied: this request is reachable by curl, which can send both a
      // bearer and a cookie. GitHub's own redirect cannot — no browser
      // attaches `Authorization` to a top-level navigation. So on a
      // deployment whose only operator credential is the admin token, the
      // flow can be STARTED but not FINISHED, and the App gets registered by
      // hand instead. See this route's doc comment.
      rebuildWith({ VIEWER_ADMIN_TOKEN: "operator-token" })
      const start = await request(app)
        .get("/api/v1/setup/github/manifest")
        .set("Authorization", "Bearer operator-token")
      const state = start.body.state as string

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Authorization", "Bearer operator-token")
        .set("Cookie", `viewer_setup_state=${encodeURIComponent(state)}`)

      expect(res.status).toBe(302)
      expect(res.headers.location).toContain("/installations/new")
    })

    it("401s an anonymous caller, and still clears the state cookie", async () => {
      const res = await request(app).get("/api/v1/setup/github/callback?code=c&state=s")

      expect(res.status).toBe(401)
      expect(exchanged).toEqual([])
      expect(persisted(dataDir).githubApp).toBeUndefined()
      // The clear rides the refusal too: it is set before the auth guard, so
      // no response path can leave a live nonce behind.
      expect(findCookie(setCookies(res), "viewer_setup_state")).toContain("Max-Age=0")
    })

    it("IS reachable as a top-level document navigation — GitHub redirects the browser here", async () => {
      // The Task 4 lesson: without an entry in DOCUMENT_NAVIGATION_ROUTES the
      // whole flow 403s at its last step, and no non-browser test can see it
      // (the guard fails open when the header is absent).
      const cookie = await signIn()
      const { state, cookieHeader } = await startFlow(cookie)

      const res = await request(app)
        .get(`/api/v1/setup/github/callback?code=c&state=${encodeURIComponent(state)}`)
        .set("Cookie", cookieHeader)
        .set("Sec-Fetch-Dest", "document")

      expect(res.status).toBe(302)
      expect(res.headers.location).toContain("/installations/new")
    })
  })
})

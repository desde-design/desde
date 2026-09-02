/**
 * Colocated unit tests for `github-auth-provider.ts` — the one file in this
 * task that talks to an external service and parses untrusted-shaped JSON.
 * `auth-routes.test.ts` only ever drives a FAKE `AuthProvider`, so without
 * this file the real GitHub exchange logic (token → profile → conditional
 * emails fallback, and its three-branch error surface) was reached by
 * nothing. `fetchImpl` is injectable for exactly this — no network calls.
 */

import { describe, expect, it, vi } from "vitest"
import { createGitHubAuthProvider } from "./github-auth-provider"

const CLIENT_ID = "client-id"
const CLIENT_SECRET = "shh-super-secret"
const ACCESS_TOKEN = "gho_test_access_token_should_never_leak"
const REDIRECT_URI = "http://localhost:3100/api/v1/auth/github/callback"

const DEFAULT_USER = {
  id: 42,
  login: "mo",
  name: "Mo Chang",
  email: "mo@example.com",
  avatar_url: "https://avatars.example.com/mo.png",
}

const DEFAULT_EMAILS = [{ email: "mo@example.com", primary: true, verified: true }]

interface FetchStubConfig {
  tokenStatus?: number
  tokenBody?: unknown
  userStatus?: number
  userBody?: unknown
  emailsStatus?: number
  emailsBody?: unknown
  /** `GET /user/installations` — Phase 3c-1b's per-user installation capture. */
  installationsStatus?: number
  installationsBody?: unknown
  /**
   * `GET /user/installations/{id}/repositories` — security audit B4's
   * per-installation repo entitlement, fetched once per captured
   * installation id. Keyed by installation id; an id with no entry here
   * falls back to a single plausible repo (`acme/repo-<id>`) so tests that
   * only care about installation ids still get a non-null `repoFullNames`
   * instead of accidentally exercising the failure path.
   */
  reposStatus?: number
  reposBodyByInstallation?: Record<number, unknown>
  /** Per-id status override — the one lever to make ONE installation's repo lookup fail while others succeed. */
  reposStatusByInstallation?: Record<number, number>
}

/**
 * Routes by URL shape to the four endpoints `exchangeCode` can call, each
 * with an independently overridable status + body. Real GitHub base URLs are
 * used (the provider's default) purely as stable strings to route on —
 * nothing here makes a network call.
 */
function makeFetchStub(cfg: FetchStubConfig = {}): typeof fetch {
  const {
    tokenStatus = 200,
    tokenBody = { access_token: ACCESS_TOKEN },
    userStatus = 200,
    userBody = DEFAULT_USER,
    emailsStatus = 200,
    emailsBody = DEFAULT_EMAILS,
    installationsStatus = 200,
    installationsBody = { total_count: 2, installations: [{ id: 11 }, { id: 22 }] },
    reposStatus = 200,
    reposBodyByInstallation = {},
    reposStatusByInstallation = {},
  } = cfg

  const stub: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/access_token")) {
      return new Response(JSON.stringify(tokenBody), { status: tokenStatus })
    }
    if (url.endsWith("/user/emails")) {
      return new Response(JSON.stringify(emailsBody), { status: emailsStatus })
    }
    // MUST be checked before the plain `/user/installations` list route
    // below — this URL also contains that substring, and a per-id repos
    // request would otherwise be mis-answered with the installations LIST
    // shape (`{ installations: [...] }`, no `repositories` field), silently
    // producing `repoFullNames: []` for every installation.
    const reposMatch = url.match(/\/user\/installations\/(\d+)\/repositories/)
    if (reposMatch) {
      const installationId = Number(reposMatch[1])
      const body =
        reposBodyByInstallation[installationId] ??
        { repositories: [{ full_name: `acme/repo-${installationId}` }] }
      const status = reposStatusByInstallation[installationId] ?? reposStatus
      return new Response(JSON.stringify(body), { status })
    }
    // Query-string-bearing, so matched by `includes` rather than `endsWith`.
    if (url.includes("/user/installations")) {
      return new Response(JSON.stringify(installationsBody), { status: installationsStatus })
    }
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify(userBody), { status: userStatus })
    }
    throw new Error(`unexpected fetch to ${url}`)
  }
  return stub
}

function makeProvider(cfg: FetchStubConfig = {}, clientSecret = CLIENT_SECRET) {
  return createGitHubAuthProvider({
    clientId: CLIENT_ID,
    clientSecret,
    fetchImpl: makeFetchStub(cfg),
  })
}

describe("createGitHubAuthProvider / authorizeUrl", () => {
  it("embeds client_id, redirect_uri and state — and sends NO scope (Phase 3c-1b: GitHub App user-OAuth)", () => {
    const provider = makeProvider()
    const url = new URL(provider.authorizeUrl("the-state", REDIRECT_URI))
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI)
    expect(url.searchParams.get("state")).toBe("the-state")
    // A GitHub App's user token carries whatever the App's declared user
    // permissions and its installations grant; OAuth scopes are an
    // OAuth-App concept and are not requested. Asserted rather than merely
    // omitted, because re-adding one would silently change nothing at
    // runtime and quietly mislead the next reader.
    expect(url.searchParams.has("scope")).toBe(false)
  })
})

describe("createGitHubAuthProvider / exchangeCode", () => {
  it("returns a correctly-shaped ProviderProfile with the access token nowhere on it", async () => {
    const provider = makeProvider()
    const profile = await provider.exchangeCode("good-code", REDIRECT_URI)
    expect(profile).toEqual({
      provider: "github",
      providerUserId: "42",
      email: "mo@example.com",
      displayName: "Mo Chang",
      avatarUrl: "https://avatars.example.com/mo.png",
      installations: [
        { installationId: 11, repoFullNames: ["acme/repo-11"] },
        { installationId: 22, repoFullNames: ["acme/repo-22"] },
      ],
    })
    expect(JSON.stringify(profile)).not.toContain(ACCESS_TOKEN)
  })

  it("throws when the token response has no access_token", async () => {
    const provider = makeProvider({
      tokenBody: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      },
    })
    await expect(provider.exchangeCode("bad-code", REDIRECT_URI)).rejects.toThrow(/incorrect or expired/)
  })

  it("throws on a non-2xx token exchange response", async () => {
    const provider = makeProvider({ tokenStatus: 500, tokenBody: {} })
    await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toThrow(/status 500/)
  })

  it("throws on a non-2xx /user response", async () => {
    const provider = makeProvider({ userStatus: 403, userBody: {} })
    await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toThrow(/status 403/)
  })

  it("throws on a non-2xx /user/emails response (triggered when the profile email is null)", async () => {
    const provider = makeProvider({
      userBody: { id: 1, login: "mo", name: null, email: null, avatar_url: "https://x/y.png" },
      emailsStatus: 502,
      emailsBody: {},
    })
    await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toThrow(/status 502/)
  })

  it("falls back to /user/emails and picks the primary VERIFIED address when the profile email is null", async () => {
    const provider = makeProvider({
      userBody: { id: 7, login: "mo", name: null, email: null, avatar_url: "https://x/y.png" },
      emailsBody: [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "unverified-primary@example.com", primary: true, verified: false },
        { email: "primary-verified@example.com", primary: true, verified: true },
      ],
    })
    const profile = await provider.exchangeCode("code", REDIRECT_URI)
    expect(profile.email).toBe("primary-verified@example.com")
    // `name` was null — falls back to `login`.
    expect(profile.displayName).toBe("mo")
  })

  it("throws when no /user/emails entry is both primary and verified", async () => {
    const provider = makeProvider({
      userBody: { id: 7, login: "mo", name: null, email: null, avatar_url: "https://x/y.png" },
      emailsBody: [
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "unverified-primary@example.com", primary: true, verified: false },
      ],
    })
    await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toThrow(/no primary verified email/)
  })

  /**
   * Phase 3c-1b T2. `GET /user/installations` is the ONLY endpoint that can
   * say which installations a specific user sees, and it needs a USER token
   * — which is exactly why sign-in had to move onto the App. The captured
   * ids are the authorization input every connect-repo route filters on.
   */
  describe("installation capture", () => {
    it("paginates the user's installations and returns every id", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }))
      const calls: string[] = []
      const provider = createGitHubAuthProvider({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetchImpl: async (input) => {
          const url = input.toString()
          calls.push(url)
          if (url.includes("/access_token")) {
            return new Response(JSON.stringify({ access_token: ACCESS_TOKEN }), { status: 200 })
          }
          // Per-installation repo entitlement isn't this test's subject —
          // answer emptily for every one of the 101 installations so the
          // list-endpoint pagination count asserted below stays exact (this
          // URL also contains "/user/installations", so it MUST be checked
          // before that branch).
          if (url.includes("/repositories")) {
            return new Response(JSON.stringify({ repositories: [] }), { status: 200 })
          }
          if (url.includes("/user/installations")) {
            const page = new URL(url).searchParams.get("page")
            const installations = page === "1" ? page1 : [{ id: 999 }]
            return new Response(JSON.stringify({ installations }), { status: 200 })
          }
          return new Response(JSON.stringify(DEFAULT_USER), { status: 200 })
        },
      })

      const profile = await provider.exchangeCode("code", REDIRECT_URI)
      expect(profile.installations).toHaveLength(101)
      expect(profile.installations?.at(-1)?.installationId).toBe(999)
      expect(
        calls.filter((u) => u.includes("/user/installations") && !u.includes("/repositories")),
      ).toHaveLength(2)
    })

    it("records an EMPTY set (not `undefined`) for a user who can see no installations", async () => {
      const provider = makeProvider({ installationsBody: { total_count: 0, installations: [] } })
      const profile = await provider.exchangeCode("code", REDIRECT_URI)
      // Distinct from the failure case below: `[]` means "GitHub answered,
      // you have none" and CLEARS any previously recorded set.
      expect(profile.installations).toEqual([])
    })

    it("omits the field (rather than throwing or clearing) when the lookup fails — sign-in still succeeds", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const provider = makeProvider({ installationsStatus: 503, installationsBody: {} })
        const profile = await provider.exchangeCode("code", REDIRECT_URI)
        // Identity is intact…
        expect(profile.providerUserId).toBe("42")
        // …and the absent field tells the callback to leave the stored set
        // alone, so a GitHub blip can't silently wipe a user's access.
        expect(profile.installations).toBeUndefined()
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it("ignores malformed entries rather than throwing on them, and captures each survivor's repo entitlement", async () => {
      const provider = makeProvider({
        installationsBody: { installations: [{ id: 5 }, { id: "6" }, {}, { id: 7.5 }, { id: 8 }] },
      })
      const profile = await provider.exchangeCode("code", REDIRECT_URI)
      expect(profile.installations).toEqual([
        { installationId: 5, repoFullNames: ["acme/repo-5"] },
        { installationId: 8, repoFullNames: ["acme/repo-8"] },
      ])
    })

    /**
     * Security audit B4's own regression coverage: the per-installation repo
     * lookup is a SEPARATE fetch from the installations list, and its
     * failure must fail CLOSED (`repoFullNames: null`, which every consumer
     * — `filterReposForCaller` — reads as "authorizes nothing"), never fall
     * back to an empty-but-truthy `[]`, and it must not drop the
     * installation itself or fail the sign-in.
     */
    it("records repoFullNames: null for ONE installation whose repo lookup fails, while a sibling installation still succeeds", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        const provider = makeProvider({
          installationsBody: { installations: [{ id: 11 }, { id: 22 }] },
          reposBodyByInstallation: { 11: { repositories: [{ full_name: "acme/repo-11" }] } },
          // Only installation 22's repos lookup fails (a transient 503);
          // installation 11's uses the body override above via the shared
          // default reposStatus: 200.
          reposStatusByInstallation: { 22: 503 },
        })
        const profile = await provider.exchangeCode("code", REDIRECT_URI)
        expect(profile.installations).toEqual([
          { installationId: 11, repoFullNames: ["acme/repo-11"] },
          { installationId: 22, repoFullNames: null },
        ])
        expect(errorSpy).toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it("never puts the user access token on the returned profile even when installations are captured", async () => {
      const provider = makeProvider()
      const profile = await provider.exchangeCode("code", REDIRECT_URI)
      expect(JSON.stringify(profile)).not.toContain(ACCESS_TOKEN)
    })
  })

  it("never leaks the access token or the client secret in a thrown error message", async () => {
    // Exercise every throwing branch and check each caught message.
    const cases: FetchStubConfig[] = [
      { tokenStatus: 500, tokenBody: {} },
      { tokenBody: { error: "denied" } },
      { userStatus: 403, userBody: {} },
      {
        userBody: { id: 1, login: "mo", name: null, email: null, avatar_url: "https://x/y.png" },
        emailsStatus: 500,
        emailsBody: {},
      },
      {
        userBody: { id: 1, login: "mo", name: null, email: null, avatar_url: "https://x/y.png" },
        emailsBody: [],
      },
    ]
    for (const cfg of cases) {
      const provider = makeProvider(cfg)
      await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toSatisfy((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        expect(message).not.toContain(ACCESS_TOKEN)
        expect(message).not.toContain(CLIENT_SECRET)
        return true
      })
    }
  })
})

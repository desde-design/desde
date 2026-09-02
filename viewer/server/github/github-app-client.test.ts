/**
 * Colocated unit tests for `github-app-client.ts` — the real `GitHubAppClient`
 * impl. `fetchImpl` is injectable, so no network calls; follows
 * `github-auth-provider.test.ts`'s fetch-stub-by-URL-shape pattern.
 */

import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { createGitHubAppClient } from "./github-app-client"

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
})

const APP_ID = "123456"
const INSTALLATION_TOKEN = "ghs_installation_secret_should_never_leak"

function makeRawRepo(i: number) {
  return {
    id: i,
    name: `proto-${i}`,
    full_name: `acme/proto-${i}`,
    private: false,
    default_branch: "main",
    owner: { login: "acme" },
  }
}

function makeClient(fetchImpl: typeof fetch) {
  return createGitHubAppClient({ appId: APP_ID, privateKeyPem: privateKey, fetchImpl })
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.[name]
}

describe("createGitHubAppClient / listInstallations", () => {
  it("authenticates with a well-formed App JWT and maps the raw shape, including a null account", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input.toString()
      expect(url).toBe("https://api.github.com/app/installations?per_page=100&page=1")
      const auth = headerOf(init, "Authorization")
      expect(auth).toMatch(/^Bearer /)
      expect(auth?.split(" ")[1].split(".")).toHaveLength(3)
      return new Response(
        JSON.stringify([
          {
            id: 1,
            account: { login: "acme" },
            // An ORGANIZATION installation's page. Carried through verbatim
            // rather than assembled from the login, because a personal
            // installation's lives at `/settings/installations/<id>` instead
            // and the account type is not in this payload.
            html_url: "https://github.com/organizations/acme/settings/installations/1",
          },
          { id: 2, account: null },
        ]),
        { status: 200 },
      )
    }

    const installs = await makeClient(fetchImpl).listInstallations()
    expect(installs).toEqual([
      {
        id: 1,
        accountLogin: "acme",
        htmlUrl: "https://github.com/organizations/acme/settings/installations/1",
      },
      // No `html_url` in the payload is `null`, not a guessed URL.
      { id: 2, accountLogin: "", htmlUrl: null },
    ])
  })

  it("throws a generic error on a non-2xx response", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 503 })
    await expect(makeClient(fetchImpl).listInstallations()).rejects.toThrow(/503/)
  })
})

describe("createGitHubAppClient / createInstallationToken", () => {
  it("POSTs to the access_tokens endpoint using the App JWT, and returns token + expiresAt", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(input.toString()).toBe("https://api.github.com/app/installations/42/access_tokens")
      expect(init?.method).toBe("POST")
      expect(headerOf(init, "Authorization")).toMatch(/^Bearer /)
      return new Response(
        JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "2026-08-07T13:00:00Z" }),
        { status: 201 },
      )
    }

    const result = await makeClient(fetchImpl).createInstallationToken(42)
    expect(result).toEqual({ token: INSTALLATION_TOKEN, expiresAt: "2026-08-07T13:00:00Z" })
  })
})

describe("createGitHubAppClient / listInstallationRepos", () => {
  it("mints an installation token, then paginates across more than one page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRawRepo(i))
    const page2 = [makeRawRepo(100)]

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input.toString()
      if (url.includes("/access_tokens")) {
        expect(url).toBe("https://api.github.com/app/installations/7/access_tokens")
        return new Response(
          JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "2026-08-07T13:00:00Z" }),
          { status: 200 },
        )
      }
      expect(headerOf(init, "Authorization")).toBe(`Bearer ${INSTALLATION_TOKEN}`)
      // `new URLSearchParams` (not `.includes`) — "page=10" is a substring
      // match for "page=1" and would silently return page 1's data forever,
      // masking the pagination-termination logic under test.
      const page = new URL(url).searchParams.get("page")
      if (page === "1") {
        return new Response(JSON.stringify({ repositories: page1 }), { status: 200 })
      }
      if (page === "2") {
        return new Response(JSON.stringify({ repositories: page2 }), { status: 200 })
      }
      throw new Error(`unexpected fetch to ${url}`)
    }

    const repos = await makeClient(fetchImpl).listInstallationRepos(7)
    expect(repos).toHaveLength(101)
    expect(repos[0]).toEqual({
      id: 0,
      owner: "acme",
      name: "proto-0",
      fullName: "acme/proto-0",
      private: false,
      defaultBranch: "main",
    })
    expect(repos[100].id).toBe(100)
  })

  it("does not silently truncate at the page bound — warns instead of losing data with no signal", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchImpl: typeof fetch = async (input) => {
        const url = input.toString()
        if (url.includes("/access_tokens")) {
          return new Response(
            JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "2026-08-07T13:00:00Z" }),
            { status: 200 },
          )
        }
        // Always return a full page — pagination would never naturally terminate.
        return new Response(
          JSON.stringify({ repositories: Array.from({ length: 100 }, (_, i) => makeRawRepo(i)) }),
          { status: 200 },
        )
      }

      const repos = await makeClient(fetchImpl).listInstallationRepos(1)
      expect(repos).toHaveLength(50 * 100)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toMatch(/50-page bound/)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

/**
 * Phase 3c-1b T4. Before caching, one repo-list call minted a fresh
 * installation token and re-walked up to 50 sequential GitHub pages — with
 * sign-in open to any GitHub account, that is a rate-limit DoS against the
 * whole deployment. These tests pin BOTH halves of the contract: that a
 * repeat call is served from cache, and that expiry actually re-fetches
 * (a cache that never expires would pass a naive "only one fetch" test).
 */
describe("createGitHubAppClient / caching (T4)", () => {
  const TOKEN_EXPIRES_AT = "2026-08-07T13:00:00Z"
  const START_MS = Date.parse("2026-08-07T12:00:00Z")

  /** A client on a controllable clock. `clock.ms` is advanced by tests instead of sleeping. */
  function makeCachingClient(fetchImpl: typeof fetch) {
    const clock = { ms: START_MS }
    const client = createGitHubAppClient({
      appId: APP_ID,
      privateKeyPem: privateKey,
      fetchImpl,
      now: () => clock.ms,
      listCacheTtlMs: 60_000,
      tokenExpirySkewMs: 5 * 60_000,
    })
    return { client, clock }
  }

  function countingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = input.toString()
      calls.push(url)
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: TOKEN_EXPIRES_AT }),
          { status: 200 },
        )
      }
      if (url.includes("/app/installations")) {
        return new Response(JSON.stringify([{ id: 1, account: { login: "acme" } }]), { status: 200 })
      }
      // `/installation/repositories` — the repo list for whichever
      // installation minted the token most recently.
      return new Response(JSON.stringify({ repositories: [makeRawRepo(1)] }), { status: 200 })
    }
    return { fetchImpl, calls }
  }

  it("reuses a minted installation token until shortly before it expires, then mints a fresh one", async () => {
    const { fetchImpl, calls } = countingFetch()
    const { client, clock } = makeCachingClient(fetchImpl)

    await client.createInstallationToken(42)
    await client.createInstallationToken(42)
    expect(calls.filter((u) => u.includes("/access_tokens"))).toHaveLength(1)

    // 50 minutes in: still inside the 1h token, outside nothing.
    clock.ms = START_MS + 50 * 60_000
    await client.createInstallationToken(42)
    expect(calls.filter((u) => u.includes("/access_tokens"))).toHaveLength(1)

    // 56 minutes in: within the 5-minute skew of the 13:00 expiry, so the
    // cached token is retired BEFORE GitHub would reject it.
    clock.ms = START_MS + 56 * 60_000
    await client.createInstallationToken(42)
    expect(calls.filter((u) => u.includes("/access_tokens"))).toHaveLength(2)
  })

  it("caches the token per installation — a different installation never reuses another's token", async () => {
    const { fetchImpl, calls } = countingFetch()
    const { client } = makeCachingClient(fetchImpl)

    await client.createInstallationToken(1)
    await client.createInstallationToken(2)
    await client.createInstallationToken(1)

    const tokenCalls = calls.filter((u) => u.includes("/access_tokens"))
    expect(tokenCalls).toHaveLength(2)
    expect(tokenCalls[0]).toContain("/app/installations/1/access_tokens")
    expect(tokenCalls[1]).toContain("/app/installations/2/access_tokens")
  })

  it("short-TTL caches the App installations list and re-fetches after the TTL", async () => {
    const { fetchImpl, calls } = countingFetch()
    const { client, clock } = makeCachingClient(fetchImpl)

    expect(await client.listInstallations()).toEqual([
      { id: 1, accountLogin: "acme", htmlUrl: null },
    ])
    await client.listInstallations()
    expect(calls.filter((u) => u.includes("/app/installations?"))).toHaveLength(1)

    clock.ms = START_MS + 61_000
    await client.listInstallations()
    expect(calls.filter((u) => u.includes("/app/installations?"))).toHaveLength(2)
  })

  it("caches the repo list PER INSTALLATION — installation 2 never serves installation 1's entry", async () => {
    const { fetchImpl, calls } = countingFetch()
    const { client } = makeCachingClient(fetchImpl)

    await client.listInstallationRepos(1)
    await client.listInstallationRepos(1)
    expect(calls.filter((u) => u.includes("/installation/repositories"))).toHaveLength(1)

    await client.listInstallationRepos(2)
    expect(calls.filter((u) => u.includes("/installation/repositories"))).toHaveLength(2)
    // Installation 2 minted its OWN token rather than riding installation
    // 1's — the token cache key and the repo cache key must agree.
    expect(calls).toContain("https://api.github.com/app/installations/2/access_tokens")
  })

  it("hands out copies — mutating a returned list cannot corrupt what the next caller sees", async () => {
    const { fetchImpl } = countingFetch()
    const { client } = makeCachingClient(fetchImpl)

    const first = await client.listInstallationRepos(1)
    first.length = 0
    expect(await client.listInstallationRepos(1)).toHaveLength(1)

    const installs = await client.listInstallations()
    installs[0].accountLogin = "tampered"
    expect((await client.listInstallations())[0].accountLogin).toBe("acme")
  })

  it("does not cache a token whose expires_at is unparseable — used once, then re-minted", async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(input.toString())
      return new Response(JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "not-a-date" }), {
        status: 200,
      })
    }
    const { client } = makeCachingClient(fetchImpl)

    await client.createInstallationToken(9)
    await client.createInstallationToken(9)
    expect(calls).toHaveLength(2)
  })
})

describe("createGitHubAppClient / secret discipline", () => {
  it("a GitHub 5xx error message never echoes the raw response body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<html>server melted, internal-token=abcxyz123</html>", { status: 503 })
    await expect(makeClient(fetchImpl).listInstallations()).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain("internal-token=abcxyz123")
      return true
    })
  })

  it("never leaks the minted installation token in a thrown error message, in console output, or on the resolved value's JSON", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const fetchImpl: typeof fetch = async (input) => {
        const url = input.toString()
        if (url.includes("/access_tokens")) {
          return new Response(
            JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "2026-08-07T13:00:00Z" }),
            { status: 200 },
          )
        }
        // The repos call fails AFTER a real token was minted — the failure
        // path must still never mention it.
        return new Response("error body", { status: 500 })
      }

      let caught: unknown
      try {
        await makeClient(fetchImpl).listInstallationRepos(1)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).not.toContain(INSTALLATION_TOKEN)

      for (const call of errorSpy.mock.calls) {
        expect(call.join(" ")).not.toContain(INSTALLATION_TOKEN)
      }

      // The happy path's resolved value legitimately carries the token
      // (createInstallationToken's whole job) — but nothing else does.
      const token = await makeClient(fetchImpl).createInstallationToken(1)
      expect(token.token).toBe(INSTALLATION_TOKEN)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

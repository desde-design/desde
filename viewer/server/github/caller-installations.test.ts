/**
 * Colocated unit tests for `caller-installations.ts` — the module that
 * answers "which installations may THIS caller see". The route tests in
 * `api/__tests__/github-connect-routes.test.ts` cover the HTTP-visible
 * behaviour; these cover the branches a route test cannot reach cleanly
 * (an unparseable stamp, the max-age boundary, the "don't even call GitHub"
 * property).
 */

import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { createFakeGitHubAppClient } from "./fake-github-app-client"
import {
  INSTALLATION_SET_MAX_AGE_MS,
  callerCanSeeInstallation,
  resolveCallerInstallations,
} from "./caller-installations"
import type { GitHubAppClient, Installation, Repo } from "./types"
import type { User } from "../storage/types"
import { upsertTestUser } from "../__tests__/user-fixtures"

const APP_INSTALLATIONS: Installation[] = [
  { id: 1, accountLogin: "acme", htmlUrl: "https://github.com/settings/installations/1" },
  { id: 2, accountLogin: "globex", htmlUrl: "https://github.com/settings/installations/2" },
  { id: 3, accountLogin: "initech", htmlUrl: "https://github.com/settings/installations/3" },
]

const NOW_MS = Date.parse("2026-08-07T12:00:00Z")

async function seedUser(storage: InMemoryStorage, providerUserId: string): Promise<User> {
  return upsertTestUser(storage, {
    provider: "github",
    providerUserId,
    email: `${providerUserId}@example.com`,
    displayName: providerUserId,
    avatarUrl: "",
  })
}

/** Wraps the fake client so a test can assert it was NOT consulted. */
function countingClient(): { client: GitHubAppClient; calls: { listInstallations: number } } {
  const inner = createFakeGitHubAppClient({ installations: APP_INSTALLATIONS })
  const calls = { listInstallations: 0 }
  const client: GitHubAppClient = {
    async listInstallations(): Promise<Installation[]> {
      calls.listInstallations++
      return inner.listInstallations()
    },
    listInstallationRepos(installationId: number): Promise<Repo[]> {
      return inner.listInstallationRepos(installationId)
    },
    listBranches(...args: Parameters<GitHubAppClient["listBranches"]>) {
      return inner.listBranches(...args)
    },
    getRepoFile(...args: Parameters<GitHubAppClient["getRepoFile"]>) {
      return inner.getRepoFile(...args)
    },
    createInstallationToken(installationId: number) {
      return inner.createInstallationToken(installationId)
    },
  }
  return { client, calls }
}

describe("resolveCallerInstallations", () => {
  it("returns only the intersection of the caller's captured set with the App's inventory", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, "mo")
    // 2 is the caller's; 99 is in the caller's set but NOT in the App's
    // (the App lost that installation) and must not be invented into the
    // result just because the user's snapshot still mentions it.
    await storage.setUserInstallations(
      user.id,
      [
        { installationId: 2, repoFullNames: ["globex/repo"] },
        { installationId: 99, repoFullNames: ["ghost/repo"] },
      ],
      new Date(NOW_MS).toISOString(),
    )
    const { client } = countingClient()

    const result = await resolveCallerInstallations({ storage, githubApp: client }, user, NOW_MS)
    expect(result.installations).toEqual([{ id: 2, accountLogin: "globex", htmlUrl: "https://github.com/settings/installations/2" }])
    expect(result.stale).toBe(false)
  })

  it("authorizes NOTHING and reports stale when the user has never been captured — and does not call GitHub at all", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, "never-synced")
    const { client, calls } = countingClient()

    const result = await resolveCallerInstallations({ storage, githubApp: client }, user, NOW_MS)
    expect(result).toEqual({ installations: [], syncedAt: null, stale: true })
    // Fail-closed AND cheap: an uncaptured caller must not cost a GitHub
    // round-trip, or an unauthenticated flood becomes a rate-limit lever.
    expect(calls.listInstallations).toBe(0)
  })

  it("expires a set older than the max age, and honours one exactly at the boundary", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, "aging")
    const { client } = countingClient()
    const deps = { storage, githubApp: client }

    const atBoundary = new Date(NOW_MS - INSTALLATION_SET_MAX_AGE_MS).toISOString()
    await storage.setUserInstallations(user.id, [{ installationId: 1, repoFullNames: ["acme/repo"] }], atBoundary)
    const boundary = await resolveCallerInstallations(deps, user, NOW_MS)
    expect(boundary.stale).toBe(false)
    expect(boundary.installations).toHaveLength(1)

    const past = new Date(NOW_MS - INSTALLATION_SET_MAX_AGE_MS - 1).toISOString()
    await storage.setUserInstallations(user.id, [{ installationId: 1, repoFullNames: ["acme/repo"] }], past)
    const expired = await resolveCallerInstallations(deps, user, NOW_MS)
    expect(expired.stale).toBe(true)
    expect(expired.installations).toEqual([])
    // The stamp is still reported, so the UI can say how old it is.
    expect(expired.syncedAt).toBe(past)
  })

  it("treats an unparseable syncedAt as expired — an unreadable age is never the permissive branch", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, "garbage-stamp")
    await storage.setUserInstallations(user.id, [{ installationId: 1, repoFullNames: ["acme/repo"] }], "not-a-timestamp")
    const { client } = countingClient()

    const result = await resolveCallerInstallations({ storage, githubApp: client }, user, NOW_MS)
    expect(result.stale).toBe(true)
    expect(result.installations).toEqual([])
  })

  it("keeps two users' answers independent for the same App inventory", async () => {
    const storage = new InMemoryStorage()
    const a = await seedUser(storage, "a")
    const b = await seedUser(storage, "b")
    const syncedAt = new Date(NOW_MS).toISOString()
    await storage.setUserInstallations(a.id, [{ installationId: 1, repoFullNames: ["acme/repo"] }], syncedAt)
    await storage.setUserInstallations(b.id, [{ installationId: 3, repoFullNames: ["initech/repo"] }], syncedAt)
    const { client } = countingClient()
    const deps = { storage, githubApp: client }

    expect((await resolveCallerInstallations(deps, a, NOW_MS)).installations).toEqual([
      { id: 1, accountLogin: "acme", htmlUrl: "https://github.com/settings/installations/1" },
    ])
    expect((await resolveCallerInstallations(deps, b, NOW_MS)).installations).toEqual([
      { id: 3, accountLogin: "initech", htmlUrl: "https://github.com/settings/installations/3" },
    ])
  })
})

describe("callerCanSeeInstallation", () => {
  it("is true only for an installation in the caller's fresh set", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, "checker")
    await storage.setUserInstallations(
      user.id,
      [{ installationId: 2, repoFullNames: ["globex/repo"] }],
      new Date(NOW_MS).toISOString(),
    )
    const { client } = countingClient()
    const deps = { storage, githubApp: client }

    expect(await callerCanSeeInstallation(deps, user, 2, NOW_MS)).toBe(true)
    // 3 exists in the App but not in this caller's set…
    expect(await callerCanSeeInstallation(deps, user, 3, NOW_MS)).toBe(false)
    // …and 404 (an id nobody has) is the SAME answer, which is what makes
    // the route's single 404 non-oracular.
    expect(await callerCanSeeInstallation(deps, user, 404, NOW_MS)).toBe(false)
  })
})

/**
 * In-memory `GitHubAppClient` fake — no network. Follows
 * `github-auth-provider.test.ts`'s inline-fake pattern but exported as a
 * reusable module (rather than duplicated per test file), since T4/T5's
 * route and UI tests will also need to stand up a fake App without hitting
 * GitHub.
 */

import type { GitHubAppClient, Installation, Repo } from "./types"

export interface FakeGitHubAppClientConfig {
  /**
   * File contents keyed `owner/name:path` (owner/name lowercased). A missing
   * key reads as an absent file; an explicit `null` makes the read THROW, so
   * "absent" and "unreadable" stay distinguishable in tests.
   */
  filesByRepo?: Record<string, string | null>
  installations?: Installation[]
  /** Repos visible per installation id. Missing key ⇒ empty list, not an error. */
  reposByInstallation?: Record<number, Repo[]>
  /**
   * Branch names keyed by `owner/name`. A missing key falls back to just that
   * repo's default branch, which is the shape most tests want without having
   * to say so.
   */
  branchesByRepo?: Record<string, string[]>
  /** Prefix for minted fake tokens — defaults to a value that is obviously not a real GitHub token. */
  tokenPrefix?: string
}

export function createFakeGitHubAppClient(cfg: FakeGitHubAppClientConfig = {}): GitHubAppClient {
  const installations = cfg.installations ?? []
  const reposByInstallation = cfg.reposByInstallation ?? {}
  const tokenPrefix = cfg.tokenPrefix ?? "fake-installation-token"
  const filesByRepo = cfg.filesByRepo ?? {}
  const branchesByRepo = cfg.branchesByRepo ?? {}

  return {
    async listInstallations(): Promise<Installation[]> {
      return installations.map((i) => ({ ...i }))
    },

    async listInstallationRepos(installationId: number): Promise<Repo[]> {
      return (reposByInstallation[installationId] ?? []).map((r) => ({ ...r }))
    },

    async createInstallationToken(installationId: number): Promise<{ token: string; expiresAt: string }> {
      return {
        token: `${tokenPrefix}-${installationId}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }
    },

    async listBranches(installationId: number, owner: string, name: string): Promise<string[]> {
      // The fake answers from the repo inventory it already holds: whatever
      // `branchesByRepo` was seeded with, else just the repo's own default
      // branch. A repo the installation does not grant answers [], which is
      // what the route turns into a 404.
      const repo = (reposByInstallation[installationId] ?? []).find(
        (r) => r.owner === owner && r.name === name,
      )
      if (!repo) return []
      return branchesByRepo[repo.fullName] ?? [repo.defaultBranch]
    },

    async getRepoFile(
      _installationId: number,
      owner: string,
      name: string,
      path: string,
    ): Promise<string | null> {
      // Keyed `owner/name:path`, lowercased on owner/name to match the real
      // client's case-insensitive behaviour.
      const key = `${owner.toLowerCase()}/${name.toLowerCase()}:${path}`
      const value = filesByRepo[key]
      if (value === undefined) return null
      // An explicit `null` in the fixture models "the read THREW" (network,
      // 5xx) as distinct from "the file is absent", so tests can exercise both.
      if (value === null) throw new Error(`fake getRepoFile failure for ${key}`)
      return value
    },
  }
}

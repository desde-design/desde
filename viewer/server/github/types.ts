/**
 * GitHub App seam (Phase 3c-1). Follows `AuthProvider` (`../auth/types.ts`)
 * as the precedent: a named interface here, one real impl
 * (`github-app-client.ts`), one fake for tests (`fake-github-app-client.ts`).
 *
 * `Installation` and `Repo` are narrow, product-shaped types — deliberately
 * NOT GitHub's raw REST response shapes passed through. Callers (the
 * connect-repo routes, landing in a later task) should never need to know
 * GitHub's field names (`account.login`, `full_name`, `default_branch`, …).
 */

/** A GitHub App installation the caller can act as. */
export interface Installation {
  id: number
  /** The `login` of the installation's account (a user or an organization). */
  accountLogin: string
  /**
   * GitHub's own settings page for this installation, where repository access
   * is granted. `null` when GitHub did not supply one.
   *
   * Taken from the API rather than built here, because the path differs by
   * account type: a personal installation lives at
   * `/settings/installations/<id>` and an organization's at
   * `/organizations/<login>/settings/installations/<id>`. We know the login
   * but not whether it names a user or an org, so any URL we assembled would
   * be a 404 for half of them.
   */
  htmlUrl: string | null
}

/** A repo visible to a specific installation. */
export interface Repo {
  id: number
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
}

export interface GitHubAppClient {
  /**
   * Installations of this App the credentialed App can see — the App's
   * ENTIRE inventory, deliberately unfiltered. It is NOT an answer to "what
   * may this caller see": Phase 3c-1b makes every route intersect this with
   * the caller's own server-derived installation set
   * (`caller-installations.ts`) before anything reaches a response body.
   */
  listInstallations(): Promise<Installation[]>
  /**
   * Repos visible to a specific installation. Paginates internally — see
   * `github-app-client.ts`.
   *
   * This is ALSO the repo-membership oracle the connect-repo route uses.
   * There is deliberately no `getRepo(owner, name)` companion: GitHub grants
   * authenticated read of PUBLIC repo metadata regardless of installation,
   * so a per-repo fetch answers "does this repo exist" rather than "is this
   * repo in this installation," and a private repo outside the installation
   * answers 403 rather than 404. Membership in THIS list is the only
   * question worth asking; `getRepo` was removed in 3c-1b for exactly that
   * reason.
   */
  listInstallationRepos(installationId: number): Promise<Repo[]>
  /**
   * Mint a short-lived (~1h) installation access token for git/API
   * operations. The token is a SECRET: callers must never log it, put it in
   * an error message, or persist it — mint on demand, use, discard.
   */
  createInstallationToken(installationId: number): Promise<{ token: string; expiresAt: string }>
  /**
   * Read ONE file's decoded UTF-8 contents from a repo, or null when it is
   * absent, unreadable, or not a regular file.
   *
   * Deliberately does NOT throw for a missing file: a repo with no
   * `.desde/config.json` is the common case, not an error, and the
   * caller (connect-repo) must succeed regardless. It also must never be used
   * as an existence oracle for authorization — membership in
   * `listInstallationRepos` is the only question worth asking there.
   */
  getRepoFile(
    installationId: number,
    owner: string,
    name: string,
    path: string,
    ref?: string,
  ): Promise<string | null>

  /**
   * Branch names in one repo, for the branch picker on the connect form.
   *
   * `installationId` is NOT an authorization boundary here any more than it
   * is on `listInstallationRepos` — the route verifies the caller can see
   * that installation first, and must also verify the repo is IN it. A repo
   * the caller named but the installation does not grant would otherwise
   * answer branch names for something they cannot see.
   *
   * Returns names only. The picker shows names, and a branch object carries
   * commit shas and protection flags that no caller here has asked for.
   */
  listBranches(installationId: number, owner: string, name: string): Promise<string[]>
}

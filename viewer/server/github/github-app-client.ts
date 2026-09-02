/**
 * Real `GitHubAppClient` impl. No new npm dependency — raw `fetch` +
 * `node:crypto` (via `app-jwt.ts`), same discipline as
 * `../auth/github-auth-provider.ts`.
 *
 * Two auth modes, per GitHub's App model:
 * - The App JWT (`app-jwt.ts`) authenticates as the App itself — used for
 *   `GET /app/installations` and minting installation tokens.
 * - An installation access token (minted via the JWT) authenticates as a
 *   specific installation — used for everything that reads repos.
 *
 * The installation token is a SECRET. See the class-level note in
 * `types.ts`; enforced here by NEVER logging or including a response body
 * in a thrown error (`githubApiError` below reads only `res.status`).
 */

import type { GitHubAppClient, Installation, Repo } from "./types"
import { buildAppJwt } from "./app-jwt"
import { createTtlCache } from "./ttl-cache"

const DEFAULT_API_BASE_URL = "https://api.github.com"
const API_VERSION = "2022-11-28"

/**
 * Caching (Phase 3c-1b T4). Before this, every repo-list call minted a
 * fresh installation token and re-walked up to 50 sequential GitHub pages,
 * with zero reuse — combined with open sign-in that is a rate-limit DoS
 * against the whole deployment, not just against the caller.
 *
 * **What each cache is keyed on, and why cross-user bleed is impossible:**
 *
 * - `tokenCache` — keyed on `installationId`. An installation token is an
 *   APP-level credential scoped to that installation; it is not a function
 *   of who asked for it, so two callers who are both allowed to reach
 *   installation 7 are entitled to byte-identical results. A caller who may
 *   NOT see installation 7 never reaches this code at all — the route layer
 *   (`caller-installations.ts`) refuses first, and refusal happens before
 *   any client method is called.
 * - `installationsCache` — a single global entry (`INSTALLATIONS_CACHE_KEY`)
 *   because `listInstallations()` takes no caller input and returns the
 *   App's whole inventory. Per-caller filtering happens strictly AFTER,
 *   against per-user rows read live from storage, which are never cached.
 * - `reposCache` — keyed on `installationId`, same argument as `tokenCache`.
 *
 * The rule the keys follow: a cache key must fully determine the value.
 * None of these values depends on the caller, so no key exists under which
 * one user's entry could be served to another.
 *
 * TTLs are short on purpose. A repo removed from an installation stays
 * attachable for at most `listCacheTtlMs`; a minute of staleness on a
 * membership list is an acceptable trade for collapsing a 51-request
 * round trip into one, and the far more consequential per-user
 * authorization set is not cached at all.
 */
const DEFAULT_LIST_CACHE_TTL_MS = 60_000
/**
 * Retire a minted installation token this long BEFORE GitHub's own
 * `expires_at`, so a cached token can't be handed out moments before it
 * dies and fail mid-flight on a multi-page walk.
 */
const DEFAULT_TOKEN_EXPIRY_SKEW_MS = 5 * 60_000
const INSTALLATIONS_CACHE_KEY = "app-installations"

/**
 * GitHub's max page size is 100. An installation (or App) with more than
 * `MAX_PAGES * PER_PAGE` (5,000) repos/installations is not a realistic
 * self-host scenario. If the bound is ever hit, `paginate` logs a warning
 * naming exactly how many items were returned, so a truncation is visible
 * in the operator's logs rather than silently dropping data with no signal.
 */
const PER_PAGE = 100
const MAX_PAGES = 50

interface GitHubInstallationResponse {
  id: number
  account: { login: string } | null
  /** GitHub's own page for this installation. See `Installation.htmlUrl`. */
  html_url?: string
}

interface GitHubRepoResponse {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch: string
  owner: { login: string }
}

interface GitHubInstallationReposResponse {
  repositories: GitHubRepoResponse[]
}

interface GitHubAccessTokenResponse {
  token: string
  expires_at: string
}

function toInstallation(raw: GitHubInstallationResponse): Installation {
  return {
    id: raw.id,
    accountLogin: raw.account?.login ?? "",
    htmlUrl: typeof raw.html_url === "string" ? raw.html_url : null,
  }
}

function toRepo(raw: GitHubRepoResponse): Repo {
  return {
    id: raw.id,
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
  }
}

/**
 * Builds a generic error for a non-2xx GitHub response. Deliberately never
 * reads or logs the response body: the access-tokens endpoint's SUCCESS
 * body is the secret installation token, and treating every endpoint's
 * FAILURE body as safe-to-log is one exception away from that discipline
 * slipping. The status code is enough to diagnose from the operator side —
 * anything more specific means checking GitHub's status page or the App's
 * installation settings directly.
 */
function githubApiError(action: string, res: Response): Error {
  console.error(`[viewer] github app client: ${action} failed with status ${res.status}`)
  return new Error(`${action} failed (GitHub returned ${res.status})`)
}

export interface GitHubAppClientConfig {
  appId: string
  privateKeyPem: string
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Overridable base URL (GitHub Enterprise Server). Defaults to the real GitHub API. */
  apiBaseUrl?: string
  /** TTL for the installations/repos list caches. Injectable for tests; defaults to 60s. */
  listCacheTtlMs?: number
  /** How long before GitHub's `expires_at` a cached installation token is retired. Defaults to 5 minutes. */
  tokenExpirySkewMs?: number
  /** Injectable clock (ms). Defaults to `Date.now`; tests advance it instead of sleeping. */
  now?: () => number
}

export function createGitHubAppClient(cfg: GitHubAppClientConfig): GitHubAppClient {
  const doFetch = cfg.fetchImpl ?? fetch
  const apiBaseUrl = cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL
  const now = cfg.now ?? Date.now
  const listCacheTtlMs = cfg.listCacheTtlMs ?? DEFAULT_LIST_CACHE_TTL_MS
  const tokenExpirySkewMs = cfg.tokenExpirySkewMs ?? DEFAULT_TOKEN_EXPIRY_SKEW_MS

  // See the cache-keying note at the top of this file. The token cache
  // holds a SECRET, so it lives only here, in process memory, alongside the
  // code that already handles the plaintext — it is never handed to a
  // caller that doesn't already receive the token itself.
  const tokenCache = createTtlCache<number, { token: string; expiresAt: string }>(now)
  const installationsCache = createTtlCache<string, Installation[]>(now)
  const reposCache = createTtlCache<number, Repo[]>(now)

  function appJwtHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${buildAppJwt(cfg.appId, cfg.privateKeyPem)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    }
  }

  function installationHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    }
  }

  /**
   * Fetches every page of a paginated GitHub endpoint, bounded at
   * `MAX_PAGES`. `extractPage` pulls the array of raw items out of a page's
   * parsed JSON body — some endpoints return a bare array
   * (`/app/installations`), others wrap it in an object
   * (`/installation/repositories` → `{ repositories: [...] }`).
   */
  async function paginate<TRaw>(
    path: string,
    headers: Record<string, string>,
    action: string,
    extractPage: (body: unknown) => TRaw[],
  ): Promise<TRaw[]> {
    const items: TRaw[] = []
    const sep = path.includes("?") ? "&" : "?"
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await doFetch(`${apiBaseUrl}${path}${sep}per_page=${PER_PAGE}&page=${page}`, {
        headers,
      })
      if (!res.ok) throw githubApiError(action, res)
      const body: unknown = await res.json()
      const batch = extractPage(body)
      items.push(...batch)
      if (batch.length < PER_PAGE) return items
      if (page === MAX_PAGES) {
        console.warn(
          `[viewer] github app client: ${action} hit the ${MAX_PAGES}-page bound — ` +
            `returning ${items.length} items; more may exist`,
        )
      }
    }
    return items
  }

  async function createInstallationToken(
    installationId: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const cached = tokenCache.get(installationId)
    if (cached) return { ...cached }

    const res = await doFetch(`${apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: appJwtHeaders(),
    })
    if (!res.ok) throw githubApiError("Create installation token", res)
    const body = (await res.json()) as GitHubAccessTokenResponse
    const minted = { token: body.token, expiresAt: body.expires_at }

    // An unparseable `expires_at` means we don't know when this token dies,
    // so it is used once and not cached — the safe direction to fail.
    const expiresAtMs = Date.parse(minted.expiresAt)
    if (Number.isFinite(expiresAtMs)) {
      tokenCache.set(installationId, minted, expiresAtMs - tokenExpirySkewMs)
    }
    return minted
  }

  return {
    async listInstallations(): Promise<Installation[]> {
      const cached = installationsCache.get(INSTALLATIONS_CACHE_KEY)
      if (cached) return cached.map((i) => ({ ...i }))

      const raw = await paginate<GitHubInstallationResponse>(
        "/app/installations",
        appJwtHeaders(),
        "List installations",
        (body) => body as GitHubInstallationResponse[],
      )
      const installations = raw.map(toInstallation)
      installationsCache.set(INSTALLATIONS_CACHE_KEY, installations, now() + listCacheTtlMs)
      // Cloned on the way out (here and on every hit above) so a caller that
      // mutates the array it received can't corrupt what the next caller sees.
      return installations.map((i) => ({ ...i }))
    },

    async listInstallationRepos(installationId: number): Promise<Repo[]> {
      const cached = reposCache.get(installationId)
      if (cached) return cached.map((r) => ({ ...r }))

      const { token } = await createInstallationToken(installationId)
      const raw = await paginate<GitHubRepoResponse>(
        "/installation/repositories",
        installationHeaders(token),
        `List repos for installation ${installationId}`,
        (body) => (body as GitHubInstallationReposResponse).repositories ?? [],
      )
      const repos = raw.map(toRepo)
      reposCache.set(installationId, repos, now() + listCacheTtlMs)
      return repos.map((r) => ({ ...r }))
    },

    async listBranches(installationId: number, owner: string, name: string): Promise<string[]> {
      const { token } = await createInstallationToken(installationId)
      // Paginated like the repo list: a long-lived repo can carry hundreds of
      // branches, and a picker that silently shows the first thirty is worse
      // than one that is slow.
      //
      // Deliberately NOT cached. The repo and installation lists are
      // inventory that changes rarely; branches change whenever anyone
      // pushes one, and a picker offering a branch that was deleted an hour
      // ago sends a build at a ref that no longer resolves.
      const raw = await paginate<{ name?: unknown }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
        installationHeaders(token),
        `List branches for ${owner}/${name}`,
        (body) => (Array.isArray(body) ? (body as { name?: unknown }[]) : []),
      )
      return raw.map((b) => b.name).filter((n): n is string => typeof n === "string")
    },

    async getRepoFile(
      installationId: number,
      owner: string,
      name: string,
      path: string,
      ref?: string,
    ): Promise<string | null> {
      const { token } = await createInstallationToken(installationId)
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : ""
      const url =
        `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`

      const res = await doFetch(url, { headers: installationHeaders(token) })
      // 404 is the ordinary "no such file" answer and MUST NOT throw — a repo
      // without the file is the common case. 403 can mean the installation
      // lacks contents permission, which is likewise not this caller's
      // problem to escalate: it degrades to "no identity available".
      if (res.status === 404 || res.status === 403) return null
      if (!res.ok) throw githubApiError(`Read ${owner}/${name}:${path}`, res)

      const body = (await res.json()) as {
        type?: string
        encoding?: string
        content?: string
      }
      // A directory (or a submodule/symlink) is not a file we can decode.
      if (body.type !== "file" || typeof body.content !== "string") return null
      if (body.encoding !== "base64") return null
      try {
        return Buffer.from(body.content, "base64").toString("utf-8")
      } catch {
        return null
      }
    },

    createInstallationToken,
  }
}

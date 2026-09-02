/**
 * GitHub implementation of the `AuthProvider` seam. No OAuth library — the
 * exchange is plain `fetch` calls (token exchange, profile, a conditional
 * emails lookup, and the installations capture below), so there's no new
 * npm dependency to add.
 *
 * All three GitHub base URLs are constructor options that default to the
 * real GitHub endpoints. This is deliberate: Task 5's live acceptance test
 * points them at a local stub server so the OAuth flow can be exercised
 * end-to-end without real GitHub credentials.
 *
 * **Phase 3c-1b: this is the GITHUB APP's user-OAuth flow, not a standalone
 * OAuth App's.** The endpoints are identical (`github.com/login/oauth/*`)
 * and so is the code exchange; the two differences are that no `scope` is
 * requested (a GitHub App user token carries whatever the App's declared
 * user permissions and its installations grant — sending `scope` is
 * meaningless at best) and that the exchange also captures
 * `GET /user/installations`, which is the ONLY way to learn which
 * installations a specific user can see. `VIEWER_GITHUB_CLIENT_ID` /
 * `VIEWER_GITHUB_CLIENT_SECRET` keep their names and now come off the
 * App's own settings page — see the README's GitHub section.
 */

import type { AuthProvider, ProviderProfile } from "./types"

const DEFAULT_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
const DEFAULT_TOKEN_URL = "https://github.com/login/oauth/access_token"
const DEFAULT_API_BASE_URL = "https://api.github.com"

export interface GitHubAuthProviderConfig {
  clientId: string
  clientSecret: string
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Overridable base URLs — see file doc comment. Default to the real GitHub endpoints. */
  authorizeBaseUrl?: string
  tokenUrl?: string
  apiBaseUrl?: string
}

interface GitHubAccessTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GitHubUserResponse {
  id: number
  login: string
  name: string | null
  email: string | null
  avatar_url: string
}

interface GitHubEmailResponse {
  email: string
  primary: boolean
  verified: boolean
}

interface GitHubUserInstallationsResponse {
  installations?: { id: number }[]
}

interface GitHubInstallationReposResponse {
  repositories?: { full_name?: string }[]
}

/**
 * GitHub's max page size. An account that can see more than
 * `INSTALLATIONS_MAX_PAGES * INSTALLATIONS_PER_PAGE` (1,000) installations
 * of ONE App is not a real scenario; the bound exists so a malformed
 * response can't spin this loop forever during sign-in.
 */
const INSTALLATIONS_PER_PAGE = 100
const INSTALLATIONS_MAX_PAGES = 10

export function createGitHubAuthProvider(cfg: GitHubAuthProviderConfig): AuthProvider {
  const doFetch = cfg.fetchImpl ?? fetch
  const authorizeBaseUrl = cfg.authorizeBaseUrl ?? DEFAULT_AUTHORIZE_URL
  const tokenUrl = cfg.tokenUrl ?? DEFAULT_TOKEN_URL
  const apiBaseUrl = cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL

  /**
   * Best-effort capture of the installations THIS user can see. Never
   * throws: a failure here returns `undefined`, which the callback reads as
   * "don't touch what's already recorded" (see `ProviderProfile`). Sign-in
   * is identity; the installation set is authorization DATA layered on top,
   * and a GitHub blip must not lock a user out of signing in at all.
   */
  /**
   * The repos in ONE installation that THIS user can actually reach.
   *
   * `GET /user/installations/{id}/repositories` with the USER's token is the
   * only endpoint that answers the per-user question. The App-level
   * `listInstallationRepos` answers a different one — what the INSTALLATION
   * was granted — and conflating the two is audit finding B4: an ordinary org
   * member could connect, and therefore clone and read, a private repo GitHub
   * itself would refuse them.
   *
   * Returns `null` on any failure, which every consumer must read as
   * "authorizes nothing". An unknown entitlement must never take the
   * permissive branch.
   */
  async function fetchInstallationRepoFullNames(
    accessToken: string,
    installationId: number,
  ): Promise<string[] | null> {
    try {
      const names: string[] = []
      for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page++) {
        const res = await doFetch(
          `${apiBaseUrl}/user/installations/${installationId}/repositories` +
            `?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github+json",
            },
          },
        )
        if (!res.ok) {
          throw new Error(
            `GitHub installation repositories fetch failed with status ${res.status}`,
          )
        }
        const body = (await res.json()) as GitHubInstallationReposResponse
        const batch = Array.isArray(body.repositories) ? body.repositories : []
        for (const repo of batch) {
          // Lowercased here so every comparison downstream is a plain
          // equality check — GitHub owner/repo names are case-insensitive.
          if (typeof repo?.full_name === "string" && repo.full_name.length > 0) {
            names.push(repo.full_name.toLowerCase())
          }
        }
        if (batch.length < INSTALLATIONS_PER_PAGE) break
      }
      return names
    } catch (error) {
      console.error(
        `[viewer] GitHub per-user repository lookup failed for installation ${installationId}:`,
        error,
      )
      return null
    }
  }

  async function fetchUserInstallationIds(accessToken: string): Promise<number[] | undefined> {
    try {
      const ids: number[] = []
      for (let page = 1; page <= INSTALLATIONS_MAX_PAGES; page++) {
        const res = await doFetch(
          `${apiBaseUrl}/user/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github+json",
            },
          },
        )
        if (!res.ok) {
          throw new Error(`GitHub user installations fetch failed with status ${res.status}`)
        }
        const body = (await res.json()) as GitHubUserInstallationsResponse
        const batch = Array.isArray(body.installations) ? body.installations : []
        for (const installation of batch) {
          if (typeof installation?.id === "number" && Number.isInteger(installation.id)) {
            ids.push(installation.id)
          }
        }
        if (batch.length < INSTALLATIONS_PER_PAGE) break
      }
      return ids
    } catch (error) {
      // Logged, never surfaced: the caller (`auth-routes.ts`) turns a THROWN
      // exchange error into a 502 that blocks sign-in, which is the wrong
      // outcome for this lookup.
      console.error("[viewer] GitHub user installations lookup failed:", error)
      return undefined
    }
  }

  return {
    authorizeUrl(state: string, redirectUri: string): string {
      const url = new URL(authorizeBaseUrl)
      url.searchParams.set("client_id", cfg.clientId)
      url.searchParams.set("redirect_uri", redirectUri)
      // NO `scope` param, deliberately (Phase 3c-1b T1). This is a GitHub
      // App's user-authorization flow: a GitHub App user token carries
      // whatever the App's declared USER permissions grant plus whatever its
      // installations allow — OAuth scopes are an OAuth-App concept and are
      // ignored here. The App must therefore declare the "Email addresses:
      // Read-only" account permission for the `/user/emails` fallback below
      // to work for users with no public email; see the README.
      url.searchParams.set("state", state)
      return url.toString()
    },

    async exchangeCode(code: string, redirectUri: string): Promise<ProviderProfile> {
      const tokenRes = await doFetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      })
      if (!tokenRes.ok) {
        throw new Error(`GitHub token exchange failed with status ${tokenRes.status}`)
      }
      const tokenBody = (await tokenRes.json()) as GitHubAccessTokenResponse
      if (!tokenBody.access_token) {
        throw new Error(
          tokenBody.error_description ?? tokenBody.error ?? "GitHub token exchange returned no access_token",
        )
      }
      // The access token lives only in this function's scope, used to fetch
      // the profile and the installation ids below, then discarded when
      // `exchangeCode` returns — it is never included in `ProviderProfile`
      // and never reaches storage. Phase 3c-1b considered persisting it
      // (design (b): query installations live on every request) and chose
      // not to: the derived ids are a bounded, non-credential fact, whereas
      // a stored user token is a credential at rest in the same SQLite file
      // that today contains only token HASHES.
      const accessToken = tokenBody.access_token

      const userRes = await doFetch(`${apiBaseUrl}/user`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      })
      if (!userRes.ok) {
        throw new Error(`GitHub user fetch failed with status ${userRes.status}`)
      }
      const user = (await userRes.json()) as GitHubUserResponse

      let email = user.email
      if (!email) {
        const emailsRes = await doFetch(`${apiBaseUrl}/user/emails`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
          },
        })
        if (!emailsRes.ok) {
          // A 403/404 here is almost always ONE operator misconfiguration:
          // the GitHub App is missing the "Email addresses: Read-only"
          // account permission. Phase 3c-1b stopped sending an OAuth `scope`
          // param (a GitHub App's user token carries what the App was granted,
          // not what the URL asks for), so the old `user:email` scope no
          // longer covers this — the permission has to be set on the App.
          //
          // It presents as an INTERMITTENT failure, which is what makes it
          // worth a dedicated message: it only fires for users whose GitHub
          // profile has no public email, so the operator sees sign-in work
          // for themselves and break for a colleague. The client still gets
          // the generic 502 (never echo a provider error outward); this line
          // is for whoever is reading the server log.
          if (emailsRes.status === 403 || emailsRes.status === 404) {
            console.error(
              "[viewer] GitHub returned " +
                emailsRes.status +
                " for /user/emails. The GitHub App is likely missing the " +
                '"Email addresses: Read-only" account permission — without it, ' +
                "sign-in fails for any user whose GitHub profile has no public email. " +
                "See the GitHub App setup section of viewer/README.md.",
            )
          }
          throw new Error(`GitHub user emails fetch failed with status ${emailsRes.status}`)
        }
        const emails = (await emailsRes.json()) as GitHubEmailResponse[]
        const primary = emails.find((e) => e.primary && e.verified)
        if (!primary) {
          throw new Error("GitHub account has no primary verified email")
        }
        email = primary.email
      }

      const installationIds = await fetchUserInstallationIds(accessToken)
      // Capture the per-installation repo entitlement in the SAME sign-in, so
      // the id set and the repo sets can never come from different moments
      // (audit B4). Sequential rather than concurrent: a user sees a handful
      // of installations, and a burst of parallel requests against GitHub's
      // per-user rate limit during sign-in is a worse trade than a few extra
      // hundred milliseconds.
      let installations: { installationId: number; repoFullNames: string[] | null }[] | undefined
      if (installationIds !== undefined) {
        installations = []
        for (const installationId of installationIds) {
          installations.push({
            installationId,
            repoFullNames: await fetchInstallationRepoFullNames(accessToken, installationId),
          })
        }
      }

      return {
        provider: "github",
        providerUserId: String(user.id),
        email,
        displayName: user.name ?? user.login,
        avatarUrl: user.avatar_url,
        ...(installations !== undefined ? { installations } : {}),
      }
    },
  }
}

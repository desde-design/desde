/**
 * Provider-neutral identity seam. `github-auth-provider.ts` is today's only
 * implementation; a future provider (GitLab, Google, …) implements the same
 * two-method contract and plugs into `auth-routes.ts` without that file
 * changing.
 */

/** Identity fetched from the provider after a successful code exchange. */
export interface ProviderProfile {
  provider: "github"
  providerUserId: string
  email: string
  displayName: string
  avatarUrl: string
  /**
   * The GitHub App installations THIS user can see, captured during the code
   * exchange — each paired with the repos WITHIN it that this user can
   * actually reach. This is the server-derived authorization input the
   * connect-repo surface filters on; it never arrives from a client, and the
   * sign-in callback is the only writer.
   *
   * The per-installation repo set is what closes audit B4. Installation
   * visibility alone is the wrong subject: GitHub grants an installation a set
   * of repos, but an individual org member may be denied several of them, so
   * authorizing on visibility let any signed-in member connect — and therefore
   * clone, build and read — a repo GitHub itself would refuse them.
   *
   * Three distinct states at the top level, all meaningful:
   * - a non-empty array — the user can see these installations;
   * - `[]` — the provider answered, and the user can see NONE;
   * - `undefined` — the provider was not asked, or the lookup failed. The
   *   callback then leaves whatever was previously recorded UNTOUCHED, so a
   *   transient GitHub blip during sign-in can't silently wipe a user's
   *   installation set. A provider with no installation concept at all
   *   (a future GitLab/Google impl) simply always omits it.
   *
   * `repoFullNames: null` on an entry means the per-repo lookup failed and
   * that installation authorizes NOTHING — never "unrestricted".
   */
  installations?: { installationId: number; repoFullNames: string[] | null }[]
}

export interface AuthProvider {
  /** Build the URL to redirect the browser to, embedding the CSRF `state` and callback `redirectUri`. */
  authorizeUrl(state: string, redirectUri: string): string
  /**
   * Exchange the provider's authorization `code` for a profile. Implementations
   * fetch a provider access token to do this, but MUST NOT return or persist
   * it — this phase stores no provider token (see `github-auth-provider.ts`).
   * Throws a plain `Error` on any non-2xx response from the provider.
   */
  exchangeCode(code: string, redirectUri: string): Promise<ProviderProfile>
}

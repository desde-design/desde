"use client"

/**
 * The one action behind "Connect GitHub access".
 *
 * Mo, 2026-08-29: "can we combine Refresh and grant access into one action.
 * And when it is clicked it does the sign in, checks to see if there is repo
 * access and if not then takes them to the github access screen?"
 *
 * Two buttons stood there before — "Refresh GitHub access" and "Grant access
 * on GitHub" — and a reader had no way to know which one their situation
 * needed, because the screen cannot tell either. It is one button now, and
 * the FLOW does the deciding:
 *
 *     click → GitHub sign-in → back here → still no access? → GitHub install
 *
 * ## Why sign-in has to come first
 *
 * The set of accounts and repositories this viewer can see is captured during
 * the OAuth callback, and the provider token is never stored
 * (`server/auth/github-auth-provider.ts`). So there is no way to ask GitHub
 * "do they have access now?" without re-authenticating. Signing in IS the
 * check. Going to the install page first would be worse: someone who already
 * granted access weeks ago would be sent to grant it again, when all they
 * needed was a fresh read.
 *
 * ## The marker, and why it is a query parameter
 *
 * The return leg has to know it is a return leg, or landing on this screen
 * would bounce straight back out to GitHub on every visit. `?gh=check`
 * survives the round trip through the OAuth `next`, and
 * {@link clearGithubCheckMarker} takes it off the URL the moment it is read,
 * so a reload or a shared link is an ordinary visit again.
 */

/** The marker `?next=` carries so the return leg knows to continue. */
export const GITHUB_CHECK_PARAM = "gh"
const GITHUB_CHECK_VALUE = "check"

/**
 * Which account the flow was about, when it was about one.
 *
 * Carried because the two dead ends need different questions asked on return,
 * and the answer to the second one is not derivable from the refreshed list.
 * "No account has the App" is visible in a count. "THIS account has the App
 * but shares no repository with it" is not: after sign-in the wizard resets to
 * the account picker, so a flow that started on a specific account would come
 * back, see accounts exist, and stop. The reader picks the same account, gets
 * the same empty screen, and presses the same button forever.
 */
const GITHUB_CHECK_INSTALLATION_PARAM = "ghi"

/**
 * Where to send someone to start the flow: sign-in, with a `next` that comes
 * back to `returnPath` carrying the marker.
 *
 * `returnPath` must be an in-app path. The server validates it again
 * (`safeReturnPath`) and falls back to `/`, so a mistake here degrades to the
 * dashboard rather than to an open redirect.
 */
export function githubAccessFlowHref(
  returnPath: string,
  installationId?: number | null,
): string {
  const next = appendCheckMarker(returnPath, installationId)
  return `/api/v1/auth/github?next=${encodeURIComponent(next)}`
}

/** `path` with the return marker on it, preserving any query it already has. */
export function appendCheckMarker(path: string, installationId?: number | null): string {
  const [base, hash = ""] = path.split("#")
  const separator = base.includes("?") ? "&" : "?"
  let marked = `${base}${separator}${GITHUB_CHECK_PARAM}=${GITHUB_CHECK_VALUE}`
  if (typeof installationId === "number" && Number.isFinite(installationId)) {
    marked += `&${GITHUB_CHECK_INSTALLATION_PARAM}=${encodeURIComponent(String(installationId))}`
  }
  return hash ? `${marked}#${hash}` : marked
}

/** Is this page load the return leg of the flow? */
export function isGithubCheckReturn(search: string): boolean {
  return new URLSearchParams(search).get(GITHUB_CHECK_PARAM) === GITHUB_CHECK_VALUE
}

/**
 * The account the flow was about, or `null` when it was about none of them.
 *
 * `null` for anything that is not a positive integer, including a value some
 * other page put there: this reaches an API path, and a caller that treated a
 * junk value as an id would ask GitHub about it.
 */
export function githubCheckInstallationId(search: string): number | null {
  if (!isGithubCheckReturn(search)) return null
  const raw = new URLSearchParams(search).get(GITHUB_CHECK_INSTALLATION_PARAM)
  if (raw === null || !/^[0-9]+$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Takes the marker off the address bar without a navigation.
 *
 * `replaceState`, not a router push: the marker is a one-shot instruction to
 * this page load, and leaving it on the URL would make a refresh — or a
 * pasted link — start bouncing to GitHub again. Replacing rather than pushing
 * also keeps Back pointing where the reader came from instead of at a URL
 * that would re-arm the flow.
 */
export function clearGithubCheckMarker(): void {
  // Both halves, or the account id outlives the flow it belongs to and rides
  // along in every link copied off this page.
  clearUrlParams(GITHUB_CHECK_PARAM, GITHUB_CHECK_INSTALLATION_PARAM)
}

/**
 * Takes `names` off the address bar without a navigation, leaving everything
 * else in the query untouched.
 *
 * Used for the flow marker above, and by every dialog the flow can return to:
 * `?repo=1`, `?connect=<id>`, `?settings=<id>`. Those parameters exist to
 * REOPEN a dialog, so a dialog that closes has to drop its own, or a reload
 * reopens something the reader just dismissed and a copied link reopens it
 * for whoever they sent it to (found by a codex review, 2026-08-29).
 *
 * `replaceState` rather than a router push, for the same reason as the
 * marker: Back should point where the reader came from, not at a URL that
 * would put the dialog straight back up.
 */
export function clearUrlParams(...names: string[]): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (!names.some((name) => url.searchParams.has(name))) return
  for (const name of names) url.searchParams.delete(name)
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
}

/**
 * The page that INSTALLS this App on an account, or `null` when the slug is
 * unknown.
 *
 * Deliberately not `https://github.com/settings/installations`, which only
 * lists what is already installed — the thing a reader with nothing installed
 * needs is the page that installs it.
 */
export function githubInstallUrl(appSlug: string | null): string | null {
  if (!appSlug) return null
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`
}

/** What the wizard knows when the return leg has to decide what to do. */
export interface AccessFlowCheckState {
  /** The refreshed account list, or `null` while it is still in flight. */
  installations: readonly { id: number; htmlUrl?: string | null }[] | null
  /** True when the list is a snapshot because reading GitHub failed. */
  installationsStale: boolean
  /** The account the flow was about, from the marker. */
  pendingInstallationId: number | null
  /** The wizard's mode, or `null` while it is still resolving. */
  flowMode: "fresh" | "edit" | null
  /**
   * The panel's access state, NOT a boolean.
   *
   * "Still resolving" and "settled read-only" need opposite answers, and a
   * boolean collapses them. See the ordering note on the function below.
   */
  access: "loading" | "signed-out" | "read-only" | "can-manage"
  /** The account currently selected in the wizard. */
  selectedInstallationId: number | null
  /** The selected account's repositories, or `null` while in flight. */
  repos: readonly unknown[] | null
}

/** What the return leg should do next. */
export type AccessFlowCheckDecision =
  | { action: "wait" }
  | { action: "select"; installationId: number }
  | { action: "stop" }
  /**
   * Go to GitHub. `installationHtmlUrl` is that account's own settings page
   * when the flow was about one, and `null` when no account has the App at
   * all — the two cases need different pages, see `accessFlowDestination`.
   */
  | { action: "continueToGithub"; installationHtmlUrl: string | null }

/**
 * The return leg's decision, as a pure function.
 *
 * Pulled out of the effect that used to hold it because it has been wrong
 * twice, both times in a way every test passed through: once by asking only
 * whether the account list was empty (which is never true on the screen the
 * flow was most needed for), and once by reading a not-yet-resolved wizard
 * mode as a settled one. Both were found by review, not by a suite, because
 * an effect that does nothing looks exactly like an effect that correctly
 * decided to do nothing.
 *
 * The order of the checks is the argument:
 *
 * 0. **The reader's role, before anything else.** The account list is only
 *    fetched for someone who can manage, so a reader who comes back read-only
 *    would wait on a list that is never requested, and the marker would stay
 *    on their address bar for good (found by a codex review, 2026-08-29).
 *    "Still resolving" and "settled read-only" are opposite answers here,
 *    which is why this takes the access state rather than a boolean.
 * 1. **Still loading** the account list: nothing to decide yet.
 * 2. **Stale**: the list is a snapshot because reading GitHub failed, and a
 *    first-time signer-in has no snapshot, so it arrives empty AND stale.
 *    That is "we do not know", not "nothing is installed" — sending them to
 *    install an App they may already have, and burning the marker on the way,
 *    would take away the retry they actually needed.
 * 3. **Genuinely empty**: no account has the App. Go install it.
 * 4. **About a specific account**: the list came back non-empty because that
 *    account is IN it, so the count answers nothing. Ask about its
 *    repositories instead, waiting for the wizard's mode first.
 * 5. **Anything else**: there is something to pick, so the wizard takes over.
 */
export function decideAccessFlowCheck(state: AccessFlowCheckState): AccessFlowCheckDecision {
  const {
    installations,
    installationsStale,
    pendingInstallationId,
    flowMode,
    access,
    selectedInstallationId,
    repos,
  } = state

  // Role first: everything below waits on a fetch this reader may never make.
  if (access === "loading") return { action: "wait" }
  if (access !== "can-manage") return { action: "stop" }

  if (installations === null) return { action: "wait" }
  if (installationsStale) return { action: "stop" }
  // Nobody has the App: the install page, and no account to name.
  if (installations.length === 0) {
    return { action: "continueToGithub", installationHtmlUrl: null }
  }

  const pendingStillPresent =
    pendingInstallationId !== null && installations.some((i) => i.id === pendingInstallationId)
  if (!pendingStillPresent) return { action: "stop" }

  // The mode resolves from a different fetch than the account list, so the
  // two land in either order. Bounded above by the role check, so this can
  // only ever be waiting on a fetch that was actually made.
  if (flowMode === null) return { action: "wait" }
  if (flowMode !== "fresh") return { action: "stop" }

  if (selectedInstallationId !== pendingInstallationId) {
    return { action: "select", installationId: pendingInstallationId }
  }
  if (repos === null) return { action: "wait" }
  if (repos.length > 0) return { action: "stop" }
  // This account has the App and shares nothing. Its OWN settings page is
  // where repository access is granted; the install page would put an account
  // picker in front of someone who already told us which account they meant.
  const pending = installations.find((i) => i.id === pendingInstallationId)
  return { action: "continueToGithub", installationHtmlUrl: pending?.htmlUrl ?? null }
}

/**
 * Where "continue to GitHub" actually goes.
 *
 * Two pages, because the two dead ends are different problems:
 *
 * - **No account has the App**: `/apps/<slug>/installations/new`, which is the
 *   page that INSTALLS it. (Not `/settings/installations`, which only lists
 *   what is already installed.)
 * - **This account has it and shares no repository**: that installation's own
 *   settings page, where repository access lives. Sending them to the install
 *   page instead would show an account picker to someone who already said
 *   which account they meant, and add two clicks to the branch this whole
 *   flow exists for (found by a codex review, 2026-08-29).
 *
 * The installation URL comes from GitHub, never assembled here: a personal
 * installation's page is `/settings/installations/<id>` and an organization's
 * is `/organizations/<login>/settings/installations/<id>`, and the payload
 * carries the login but not the account TYPE. A URL built from the login
 * alone would 404 for every org.
 *
 * Falls back to the install page when GitHub sent no URL — an account picker
 * is a worse destination than a direct link, and a much better one than
 * nowhere.
 */
export function accessFlowDestination(
  decision: Extract<AccessFlowCheckDecision, { action: "continueToGithub" }>,
  appSlug: string | null,
): string | null {
  return decision.installationHtmlUrl ?? githubInstallUrl(appSlug)
}

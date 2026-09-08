/**
 * The block of lines the Viewer prints once it is listening, in the order it
 * prints them.
 *
 * Two things went wrong with printing these inline in `server/index.ts`, and
 * this module exists to fix both.
 *
 * ## The sign-in URL was not last, and under Docker it was not even in order
 *
 * The local sign-in URL is the only way into a fresh instance that has no
 * GitHub App configured, so it is the one line a reader has to find and copy.
 * It was printed in the middle of the banner, with warnings after it.
 *
 * Worse, the order on screen did not match the order in the source. The
 * warning lines went to stderr (`console.warn`) while everything else went to
 * stdout (`console.log`), and those are two separate pipes. Whoever is reading
 * the output, a terminal or `docker logs`, interleaves them by arrival, not by
 * the order the process wrote them. In a container the whole stderr group
 * landed after the whole stdout group, which pushed four warning lines below
 * the sign-in URL and buried it.
 *
 * So: every line here goes out on ONE stream, and the sign-in URL is the last
 * line printed. Warnings losing stderr is the deliberate trade. These are boot
 * diagnostics read by a person watching a terminal, not a log stream anything
 * greps by severity, and a banner that is reordered by the reader is worth less
 * than the severity split was.
 *
 * ## It was not testable
 *
 * Same reason `origin-mode-banner.ts` next door is its own function: assembling
 * the lines is pure, so ordering can be asserted without booting a server. This
 * module does not touch the console; `server/index.ts` prints what it returns.
 */

/** Every fact the banner needs. The caller has all of them by the time it listens. */
export interface BootBannerInputs {
  profile: string
  bridgeVersion: string
  publicUrl: string
  /** From `originModeBannerLines`. Already fully formatted, one or two lines. */
  originLines: string[]
  /** From `emailStatusLine`, without the `[viewer] ` prefix. */
  emailStatus: string
  /** False adds the admin-bearer notice. */
  adminTokenSet: boolean
  /**
   * The local sign-in URL when one was minted, else null. Minted only when no
   * GitHub sign-in is configured, which is exactly when a reader needs it.
   */
  signInUrl: string | null
}

/**
 * The banner, in print order. The sign-in URL, when there is one, is the final
 * line: `bootBannerLines(...).at(-1)` is what a reader copies.
 */
export function bootBannerLines(inputs: BootBannerInputs): string[] {
  const lines: string[] = [
    `[viewer] profile=${inputs.profile} bridge=${inputs.bridgeVersion} → ${inputs.publicUrl}`,
    ...inputs.originLines,
    `[viewer] ${inputs.emailStatus}`,
  ]

  if (!inputs.adminTokenSet) {
    // NOT "write endpoints are disabled" — that stopped being true in Phase
    // 3b-2. `requireWrite` (api/api-router.ts) accepts EITHER the admin bearer
    // OR a `write`-scoped personal access token, so with no admin token
    // configured a signed-in user can still mint a PAT at /settings and use it
    // to create/patch projects and upload deployments. What is actually
    // unavailable is the admin bearer itself: the unscoped, non-revocable
    // escape hatch that reaches every project regardless of membership.
    lines.push(
      "[viewer] VIEWER_ADMIN_TOKEN is unset. The admin bearer is unavailable; " +
        "write endpoints still accept write-scoped personal access tokens (see /settings)",
    )
  }

  if (inputs.signInUrl) {
    // Blank line above so the thing to copy is visually separated from the
    // diagnostics, and the note about the token comes BEFORE the URL so the
    // URL stays the last line.
    lines.push(
      "",
      "[viewer] No GitHub sign-in configured. Open the URL below to sign in. It is regenerated",
      "[viewer] on every restart, and a session you already have survives a restart either way.",
      "",
      `  ${inputs.signInUrl}`,
    )
  }

  return lines
}

/**
 * The block of lines the Viewer prints once it is listening, in the order it
 * prints them.
 *
 * Two things went wrong with printing these inline in `server/index.ts`, and
 * this module exists to fix both.
 *
 * ## The URL to open was not last, and under Docker it was not even in order
 *
 * The banner always ends on the address the reader is meant to open: the local
 * sign-in URL when one was minted, and the viewer's own URL otherwise. That is
 * the one line they have to find and copy, and it used to be printed in the
 * middle of the banner, with warnings after it.
 *
 * Worse, the order on screen did not match the order in the source. The
 * warning lines went to stderr (`console.warn`) while everything else went to
 * stdout (`console.log`), and those are two separate pipes. Whoever is reading
 * the output, a terminal or `docker logs`, interleaves them by arrival, not by
 * the order the process wrote them. In a container the whole stderr group
 * landed after the whole stdout group, which pushed four warning lines below
 * the sign-in URL and buried it.
 *
 * So: every line here goes out on ONE stream, and the URL to open is the last
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
 * The banner, in print order. `bootBannerLines(...).at(-1)` is always the URL
 * a reader copies: the sign-in URL when there is one, the viewer's own address
 * otherwise.
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
      "[viewer] No GitHub sign-in configured. Open the URL below in a browser to sign in. It is",
      "[viewer] regenerated on every restart, and a session you already have survives a restart",
      "[viewer] either way.",
      "",
      `  ${inputs.signInUrl}`,
    )
  } else {
    // With nothing to sign in through, the address of the viewer itself is
    // what a reader has to find and copy, so it gets the last line for the
    // same reason the sign-in URL does (Mo, 2026-09-14, reading `docker run`
    // output: "it doesn't clearly output the page to use to view in the
    // browser"). The first line already carries this URL, but it carries it
    // behind `profile=` and `bridge=`, where it reads as one more diagnostic
    // rather than as the way in. Ending on the admin-token warning instead
    // made the reader scroll back up past four lines to find it.
    lines.push("", "[viewer] Open this in a browser:", "", `  ${inputs.publicUrl}`)
  }

  return lines
}

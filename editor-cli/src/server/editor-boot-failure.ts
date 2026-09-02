/**
 * A spawned editor that died before it was ready, WITH whatever it said on the
 * way out.
 *
 * ── Why this exists, given the pre-check already landed ───────────────────
 *
 * `launcher-open-check.ts` answers every refusal it can predict from a static
 * read of the repo, so the framework/host/git-state cases never reach a spawn.
 * What it cannot predict is anything only booting reveals — and the largest
 * such class is the most ordinary situation there is: **the dependency is
 * declared but not installed.**
 *
 * MEASURED, on a real launcher, against a repo whose config had just been
 * given `{"hosts": {"astro": true}}` — the exact line the `host-not-enabled`
 * notice tells the user to add:
 *
 *     modal:  editor exited before it was ready (code 4)
 *
 *     child:  This project declares Astro but astro is not installed.
 *
 *             Attach mode does not use this seam and covers Astro fully:
 *             it runs this project's own dev server (npx astro dev) and
 *             connects to it.
 *
 *             To keep the in-process path and fail loudly instead, pass
 *             --host-mode=in-process.
 *
 * So the branch's own remediation led straight back into the defect the branch
 * exists to remove: follow the modal's instructions, and the next thing you see
 * is an exit code. The message was not missing — it was written to a terminal a
 * GUI user never sees, because `defaultSpawnEditor` spawned with stderr
 * `"inherit"` and rejected with nothing but the code.
 *
 * ── Why the exit code alone was never enough ──────────────────────────────
 *
 * `cli.ts` hands out FIVE distinct nonzero codes (3, 4, 5, 6, 7) and says why
 * in a comment at each one: *"so wrapping CLIs / IDE extensions can distinguish
 * 'framework mismatch' from generic boot failure and react accordingly."* The
 * launcher is precisely such a wrapper, and it distinguished none of them. Each
 * of those exits is a TYPED refusal that has already printed a complete,
 * remediable message — which is the definition of a failure that must not
 * surface as a number.
 *
 * ── What is deliberately NOT done here ────────────────────────────────────
 *
 * No parsing of the child's output, and no per-exit-code prose. Both were
 * considered and both re-create the two-voices problem `launcher-open-check.ts`
 * avoids by design: the CLI's message is the product artifact, so it is relayed
 * VERBATIM as the cause. Splitting a summary out of it would mean guessing
 * which line is the headline, and the failure text is the TAIL of stderr (the
 * `console.error` immediately before `process.exit`) with ordinary boot
 * warnings above it — so "first line" would reliably pick a warning.
 *
 * The residue this does NOT cover stays honest: a child that dies with an empty
 * stderr has genuinely said nothing, and it still gets
 * `editor exited before it was ready (code N)`.
 */

import type { LauncherOpenBlock, LauncherSupportedHost } from "../../../src/types/launcher.js"

/**
 * How much of the child's stderr to keep.
 *
 * Bounded because a chatty dev server can emit megabytes, and this string ends
 * up in an HTTP response and then in the DOM. The TAIL is kept rather than the
 * head: the typed refusals print immediately before exiting, so the last bytes
 * are the ones that explain the failure, and the earlier ones are boot noise.
 */
const STDERR_TAIL_LIMIT = 4000

export class EditorBootFailure extends Error {
  readonly exitCode: number | null
  /** The child's own words. Empty when it died silently. */
  readonly detail: string

  constructor(exitCode: number | null, detail: string) {
    // The message is UNCHANGED from what this path has always rejected with, so
    // the `reason` field every existing caller reads keeps its exact meaning
    // and the generic fallback keeps working when `detail` is empty.
    super(`editor exited before it was ready (code ${exitCode})`)
    this.name = "EditorBootFailure"
    this.exitCode = exitCode
    this.detail = detail
  }
}

export interface StderrTail {
  append: (chunk: string) => void
  /** The kept tail, trimmed. */
  text: () => string
}

export function createStderrTail(limit: number = STDERR_TAIL_LIMIT): StderrTail {
  let buffer = ""
  return {
    append(chunk: string) {
      // Slice after appending, not before: a single chunk larger than the limit
      // must still contribute its own tail rather than be dropped whole.
      buffer = (buffer + chunk).slice(-limit)
    },
    text() {
      return buffer.trim()
    },
  }
}

/**
 * A boot failure that DID explain itself, rendered as the same structured
 * notice every other refusal uses.
 *
 * The two remediation steps are the only prose added, and neither diagnoses:
 * step 1 names the overwhelmingly common cause (dependencies never installed),
 * step 2 is the escape hatch that applies to any in-process boot failure
 * whatever caused it. The child's own diagnosis is the `cause` above them.
 */
export function bootFailureBlock(
  failure: EditorBootFailure,
  repoPath: string,
  supported: LauncherSupportedHost[],
): LauncherOpenBlock {
  return {
    code: "boot-failed",
    summary: "Editor could not start this project.",
    cause: failure.detail,
    // Two remediations, neither of which is a command for OUR tool. This
    // block is read in the launcher, by someone who opened a folder in a GUI
    // and has never typed our binary's name; telling them to run it is
    // instructions for a surface they are not on. `npm install` and the
    // project's own dev command stay, because those are the USER's tools and
    // they would run them anyway.
    remediation: [
      `Install this project's dependencies in ${repoPath}, then open it again.`,
      `If they are already installed, start the project's own dev server by itself. Editor runs that same server, so whatever stops it there is what stopped it here.`,
    ],
    // True for the in-process boot failures this wraps — attach mode skips the
    // seam that just failed. Note it is NOT surfaced as a remediation: attach
    // mode has no launcher affordance today, so offering it here would name a
    // door the reader cannot open.
    attachCovers: true,
    supported,
  }
}

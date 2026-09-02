import { languageOfStampPath } from "./coverage.js"
import type { ModuleStampNotice, StampingCoverage } from "./types.js"

/**
 * The per-MODULE half of the boot report, joined against the per-LANGUAGE half.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * MEASURED, 2026-08-11 (`tasks/dev-server-hosts.md` § 12f): the boot smoke check
 * is EXISTENTIAL over modules. It asks whether ANY module carries a stamp, so
 * under `styled-jsx/babel` — where `src/App.tsx` refuses and `src/main.tsx` does
 * not — it printed `▸ Smoke check passed`, satisfied by a stamp from a different
 * file, six lines under the `[stamp]` warning that said the opposite. It catches
 * the total failure (all three files refused under `@emotion/babel-preset-css-
 * prop`, and it warned correctly) and cannot see the partial one, which is the
 * likelier shape and the one where a user's main component file is silently
 * inspect-only.
 *
 * The fix is not a cleverer inference. It is that the gate now reads the facts
 * the stampers already declared, from `plugins/transform-input.ts`, and names
 * the files.
 *
 * ── Why this is NOT part of `StampEvidence` ─────────────────────────────────
 *
 * `StampEvidence` was the obvious home and it is the wrong one, for three
 * reasons that each stand alone:
 *
 *  1. **It feeds the teardown gate.** `ladder.ts` turns an `unstamped` verdict
 *     into "shut the dev server down and re-run with `--attach`". A partial
 *     refusal must never take that path: most of the app still edits, and attach
 *     mode does not fix it — attach runs the SAME repo plugin pipeline, so the
 *     same file refuses in the same way, and we would have torn down a working
 *     session to land the user somewhere identical.
 *  2. **Different epistemics.** `StampEvidence` is three-valued because it
 *     INFERS from probed output, and `indeterminate` is the honest answer when a
 *     client-rendered app serves a stamp-free document. A module notice is a
 *     DECLARATION by the stamper, with a reason, about a file it just read.
 *     There is nothing to hedge. Folding a fact-with-a-source into a type built
 *     for hedged inference is how the hedging leaks onto the fact.
 *  3. **Different denominators.** `evidence.count` is "stamps seen in the
 *     documents we probed". A notice list is "files a stamper refused". One type
 *     answering both makes `count` mean two things depending on which field you
 *     read next.
 *
 * So this is a separate, additive signal. It never changes a verdict, and
 * `hosts/ladder.ts` is untouched — which is the claim stated as code rather than
 * as prose.
 *
 * ── The bound, stated because a report that overstates its reach is worse
 *    than no report ───────────────────────────────────────────────────────────
 *
 * A stamper only sees a module when something compiles it, so these notices can
 * only ever describe modules compiled by the time the gate renders. Two
 * consequences, both deliberate:
 *
 *  - On the Vite family, `hosts/vite/module-graph-evidence.ts` compiles the
 *    prototype's own source modules before the gate runs, so the boot report
 *    covers the app's source tree. That walk was changed FOR this — see its own
 *    comment for the measurement showing the previous walk compiled exactly one
 *    module.
 *  - On the Turbopack lane the stamper runs in a forked loader worker, and in
 *    attach mode it runs inside the user's own dev server. Both still print
 *    their `[stamp]` line to the terminal; neither can put a record in this
 *    process's ledger. The boot report is therefore silent there, and the
 *    closing sentence it prints ("a file compiled later prints its own [stamp]
 *    line") is the true statement in both cases.
 */

/**
 * Drop notices the boot log has ALREADY explained, and put the rest in a stable
 * order.
 *
 * **The dropping rule is the reuse `tasks/dev-server-hosts.md` § 9 asks for.**
 * `.astro` markup has no stamper (`coverage.ts`), the Astro host declares that
 * before boot, and `hosts/run.ts` prints the reason once. A per-module notice
 * for the same file would be a SECOND notion of "expected to be missing",
 * phrased differently, in a louder register, for a state that is working as
 * designed. So a language that coverage already declared uncovered is filtered
 * out here rather than re-explained.
 *
 * Today that filter removes nothing: neither stamper's `transform` accepts a
 * `.astro` id, so `.astro` can never reach the ledger in the first place. It is
 * written anyway because the day it stops being vacuous is the day someone adds
 * an `.astro` stamper that ships refusing — and on that day the alternative is
 * two contradicting explanations of one silence, discovered by a user.
 *
 * An unrecognised extension is KEPT (`languageOfStampPath` returns `null`): no
 * declaration covers it, so there is nothing to defer to.
 */
export function visibleStampNotices(
  notices: readonly ModuleStampNotice[],
  coverage: StampingCoverage | null,
): ModuleStampNotice[] {
  const declared = new Set((coverage?.uncovered ?? []).map((gap) => gap.language))
  const seen = new Set<string>()
  const out: ModuleStampNotice[] = []
  for (const notice of notices) {
    const language = languageOfStampPath(notice.file)
    if (language !== null && declared.has(language)) continue
    // The ledger dedupes on (module id × outcome) and a module id is absolute
    // while `file` is repo-relative; two ids cannot map to one relative path
    // under a single policy, but the report is a list a human reads and a
    // duplicated line in it is a bug report waiting to happen.
    const key = `${notice.file}\u0000${notice.outcome}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(notice)
  }
  // Alphabetical, so two boots of the same project print the same list and a
  // diff between them means something. Compile order does not.
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * The boot-log block, or `[]` when there is nothing to say.
 *
 * **Empty on a healthy boot, and that is a requirement rather than a
 * consequence.** The line this sits under (`▸ Smoke check passed …`) is already
 * printed on every successful boot; a second line saying "and nothing is wrong"
 * would be read a dozen times and then never again, which is the state the
 * `[stamp]` warning was already in when the gate contradicted it.
 *
 * Each file gets a name-and-consequence line and an indented cause line, in that
 * order. "Selectable but not editable" is the thing the user would otherwise
 * discover by clicking, which is the same rule `coverage.ts`'s reasons follow —
 * and the cause is the thing they need only once they believe the consequence.
 *
 * Two lines rather than one because the causes carry a parenthetical of their
 * own ("element 22 is `<style>` authored but `<_JSXStyle>` after"), and nesting
 * that inside a wrapper parenthesis produced a line no one would read to the
 * end. This block only appears when something is wrong, so it can afford them.
 *
 * **No denominator is claimed anywhere in it**, and the first draft got that
 * wrong: it opened "Stamping is PARTIAL" and closed "Every other compiled file
 * stamped normally", which read correctly against the `styled-jsx` fixture (1 of
 * 3) and was flatly false against `@emotion/babel-preset-css-prop`, where all
 * three files refused and the block still called it partial. The count of files
 * that DID stamp is not in this input and cannot be inferred from it — a file
 * with no notice may have stamped, or may simply contain no elements. So the
 * block reports what it knows ("these files, this problem") and defers the
 * partial-versus-total distinction to the smoke line above it, which is decided
 * on evidence and already says "passed" or "not found in any compiled source
 * module".
 */
/**
 * How many files get their own two-line entry before the list is summarised.
 *
 * MEASURED on a 302-module fixture where every file refused: the uncapped block
 * was 604 lines inside a 916-line boot log, and it pushed the line that actually
 * decides what to do — `▸ Smoke check warning: data-desde-src not found in any
 * compiled source module` — off the top of the terminal.
 *
 * Two lines per file is right for the 1-3 file case this format was designed
 * against, which is a per-file problem the user fixes per file. The total-failure
 * case is a SINGLE problem with one cause, where the per-file detail is noise and
 * the count is the signal. Twelve is enough to show the shape (which files, which
 * outcome, is it one cause or several) without burying the summary.
 */
const MAX_LISTED_NOTICES = 12

export function formatStampNoticeLines(notices: readonly ModuleStampNotice[]): string[] {
  if (notices.length === 0) return []
  const files = notices.length === 1 ? "1 file" : `${notices.length} files`
  const lines = [`▸ Stamping problem: ${files} did not stamp cleanly:`]
  for (const notice of notices.slice(0, MAX_LISTED_NOTICES)) {
    lines.push(`    ${notice.file}: ${consequenceOf(notice)}.`)
    lines.push(`      Cause: ${notice.detail}.`)
  }
  const hidden = notices.length - MAX_LISTED_NOTICES
  if (hidden > 0) {
    // The count, not the files: at this scale the user needs to know it is
    // everything rather than which everything.
    lines.push(
      `    …and ${hidden} more ${hidden === 1 ? "file" : "files"}. ` +
        "Every one prints its own [stamp] line above with its cause.",
    )
  }
  lines.push(
    "  Files not listed here reported no problem. A file compiled after this " +
      "point prints its own [stamp] line if it hits the same one.",
  )
  return lines
}

function consequenceOf(notice: ModuleStampNotice): string {
  switch (notice.outcome) {
    case "inspect-only":
      return "inspect-only: its elements are selectable, but every edit to them is refused"
    case "coordinates-suspect":
      // Deliberately NOT softened. This file stamps, so nothing else in the boot
      // report will hint at it, and the failure it can produce — an edit applied
      // to an element the user never clicked — is the worst one this product
      // has (`plugins/transform-input.ts` has the measurement).
      return "stamped, but from rewritten source, so an edit to it may land on the wrong element"
  }
}

import { readFileSync } from "node:fs"
import type { ModuleStampNotice } from "../hosts/types.js"

/**
 * What a stamper's `transform(code, id)` was actually handed.
 *
 * ── The failure this exists to name ─────────────────────────────────────────
 *
 * A `data-desde-src` stamp is a claim about the file ON DISK: the applicators in
 * `src/editor/edit-service/` re-read that file and splice at the coordinate.
 * The stampers, however, compute coordinates from the `code` Vite hands them —
 * which is the authored bytes only if no earlier plugin transformed the module.
 *
 * Both stampers declare `enforce: "pre"`, and that is NOT enough. Vite sorts
 * plugins into pre / normal / post buckets and preserves ARRAY ORDER within a
 * bucket; every host merges the repo's own plugins ahead of ours (plain Vite:
 * `mergeConfig(userConfig, injected)`; React Router / Astro / Nuxt: the
 * framework merges its inline config last). So any repo plugin that is ALSO
 * `enforce: "pre"` transforms the module before we see it.
 *
 * MEASURED, 2026-08-11, and this is not hypothetical. `@vitejs/plugin-react`
 * v4's `vite:react-babel` is `enforce: "pre"` and regenerates the module from a
 * Babel AST with the react-refresh preamble prepended. On a fixture whose only
 * non-default plugin was `react()`:
 *
 *   - every `data-desde-src` LINE was 19 too high (the preamble's height);
 *   - 18 of 20 stamps named no element at all;
 *   - 2 named a REAL BUT DIFFERENT element — `src/App.tsx:29:6` sat in the DOM
 *     on a `<p class="row">` while naming a `<div class="insert-host">`.
 *
 * The second row is the dangerous one: the applicator and any instrument that
 * re-reads the file from disk agree with each other while pointing at an
 * element the user never clicked. That is the signature of the detach defect
 * that broke 59 of 65 apparent successes with green unit tests throughout.
 *
 * The same root cause also poisons `data-desde-v`: `sourceVersionOf(code)` over
 * transformed bytes can never match the on-disk hash, and `edit-handler.ts`
 * turns that mismatch into a hard 409 "Stale target".
 *
 * ── Why detection, rather than fixing the plugin order ──────────────────────
 *
 * Because we cannot fix the order. Vite offers no bucket ahead of `pre`, and a
 * plugin's `config` hook runs AFTER `sortUserPlugins` has already frozen the
 * order, so a plugin cannot hoist itself. Of the five in-process hosts we
 * control the merged plugin array on exactly one. Hoisting where we can would
 * also make us run ahead of a repo plugin whose whole job is to strip syntax
 * our parser would choke on — trading one silent gap for another.
 *
 * So the stamper stops assuming and asks. `rewritten` is not fatal: the JSX
 * stamper realigns (see `realignJsxInsertions` in `jsx-source-tag-plugin.ts`) —
 * coordinates from the AUTHORED bytes, splice offsets from the rewritten ones.
 *
 * ── `unverifiable` is deliberately treated as `as-authored` ────────────────
 *
 * A module id that is not a readable file is a virtual/generated module
 * (Nuxt's `.nuxt/*` scaffolding, Astro's containers, any `load`-hook module
 * whose id happens to end `.vue`/`.tsx`). Those have no authored bytes to
 * disagree with, and refusing to stamp them would take away working coverage
 * on the strength of a check that cannot apply. Callers proceed exactly as
 * they did before this module existed.
 */
export type TransformInput =
  /** `code` is byte-identical to the file on disk. Coordinates are authored coordinates. */
  | { kind: "as-authored" }
  /** The id is not a readable file, so there is nothing to compare against. */
  | { kind: "unverifiable" }
  /** An earlier plugin transformed this module. Coordinates read off `code` are NOT authored. */
  | { kind: "rewritten"; authored: string }

/**
 * Compare a transform's input against the bytes on disk.
 *
 * `cleanId` must already have Vite's query suffix stripped (`?t=`,
 * `?vue&type=…`) — every caller does that before its extension check, and a
 * raw id would send `readFileSync` at a path that does not exist and silently
 * downgrade every module to `unverifiable`.
 */
export function classifyTransformInput(code: string, cleanId: string): TransformInput {
  let authored: string
  try {
    authored = readFileSync(cleanId, "utf8")
  } catch {
    return { kind: "unverifiable" }
  }
  if (authored === code) return { kind: "as-authored" }
  return { kind: "rewritten", authored }
}

/**
 * One line per module id, per process.
 *
 * `transform` runs again on every HMR round, so an un-deduplicated warning
 * becomes a scrolling wall the moment the developer starts typing — which is
 * how a real warning gets tuned out. Keyed on the id AND the outcome so a file
 * that changes failure mode still says so once.
 */
const said = new Set<string>()

/**
 * The same facts, in a form the boot report can read.
 *
 * ── Why the print and the record are ONE call ───────────────────────────
 *
 * MEASURED, 2026-08-11 (`tasks/dev-server-hosts.md` § 12f): under
 * `styled-jsx/babel`, `src/App.tsx` refused to stamp and printed its `[stamp]`
 * line — and the CLI then printed `▸ Smoke check passed` six lines below it. Two
 * facts on one screen contradicting each other, because the gate had no way to
 * consult the warning.
 *
 * The gate now reads {@link readModuleStampNotices}. The reason this is a single
 * entry point rather than a `warn(…)` beside a `record(…)` is the shape of the
 * bug it fixes: two renderings of one fact, kept in step by nothing. A caller
 * able to print without recording would reintroduce it one file away.
 */
const ledger: ModuleStampNotice[] = []

/**
 * Say it, and remember it.
 *
 * @param cleanId  Absolute module path, query stripped. The dedupe key.
 * @param notice   The structured fact. `file` is the repo-relative stamp path,
 *                 which is the thing a user can open; `cleanId` is not.
 * @param message  The full prose line, printed verbatim. It carries the fix
 *                 advice; `notice.detail` is the one-clause version for the boot
 *                 summary, which has room for one line per file and no more.
 */
export function reportStampProblem(
  cleanId: string,
  notice: ModuleStampNotice,
  message: string,
): void {
  // NUL as the separator so no `outcome` value can collide with a path that
  // happens to end in one. Written as an ESCAPE rather than the raw byte this
  // file used to carry — a control character in source is invisible to every
  // reviewer, and `git diff` calls the whole file binary because of it.
  const key = `${cleanId}\u0000${notice.outcome}`
  if (said.has(key)) return
  said.add(key)
  ledger.push(notice)
  console.warn(message)
}

/**
 * Every module problem recorded SO FAR, in the order they were found.
 *
 * "So far" is load-bearing, and the boot report says as much in its own words: a
 * stamper only sees a module when something compiles it, so this can only report
 * on modules that have been compiled. What makes it a boot signal rather than a
 * coin flip is `hosts/vite/module-graph-evidence.ts`, which compiles the
 * prototype's own source modules before the gate renders — see that walk's
 * comment for the measurement that forced it.
 *
 * It is also **in-process only**: the Turbopack lane runs this same stamper
 * inside a forked loader worker, and attach mode runs it inside the user's own
 * dev server. Both still print their `[stamp]` line; neither can reach this
 * array. `hosts/stamp-notices.ts` states that bound for the reader.
 */
export function readModuleStampNotices(): readonly ModuleStampNotice[] {
  return ledger
}

/** Test seam — the dedupe set and the ledger would otherwise leak between cases. */
export function resetTransformInputWarnings(): void {
  said.clear()
  ledger.length = 0
}

/**
 * The unique-text step: collect the project's searchable files, look for
 * one piece of page text in them, and produce the file's new contents when
 * that text appears EXACTLY ONCE.
 *
 * Spec: `docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`.
 * This is the one place the three pieces meet: `collect-search-files.ts`
 * (I/O), `find-unique-text.ts` and `apply-unique-text-edit.ts` (pure). It
 * does not write. The caller writes, so the write keeps going through the
 * handler's own path guards and the write broker.
 *
 * Two callers, one function (spec § "Where the step sits"): the
 * `unique-text` edit kind on the CLI dispatcher (a text edit the bridge
 * could not map to source at all), and the last rung of the llm-patch text
 * ladder (a stamped edit the ladder could not place). Neither is allowed a
 * second copy of these rules.
 *
 * Every refusal reason is a plain sentence, because it is shown to the
 * designer and then pasted into the chat hand-off prompt. No jargon, no
 * first person, no em dashes.
 */

import {
  collectSearchFiles,
  DEFAULT_COLLECT_LIMITS,
  type CollectLimits,
  type CollectResult,
} from "./collect-search-files.js"

export type UniqueTextStepResult =
  | {
      ok: true
      /** Repo-relative, POSIX-separated path of the file holding the text. */
      file: string
      /** The file's contents as the search read them. */
      source: string
      /** Those contents with the text replaced. */
      newSource: string
    }
  | { ok: false; reason: string }

/**
 * Test seams. `collect` swaps the filesystem walk for a fixed file list;
 * `limits` drives the real walk's file-count, file-size and wall-clock
 * bounds so a test can trip one without building a 5,000-file repo; `now`
 * drives the wall clock this function times itself against, so a test can
 * prove the SAME deadline reaches both the collection phase and the search
 * phase without a real sleep.
 */
export interface UniqueTextStepDeps {
  collect?: (rootReal: string, limits?: CollectLimits) => Promise<CollectResult>
  limits?: CollectLimits
  now?: () => number
}

/**
 * How many file names a "too many matches" refusal lists before it stops.
 *
 * The count is the fact that matters; the names are there so the designer
 * recognises the shape of the problem (eight translation files, say). Past
 * a handful the list stops informing and starts filling the chat prompt.
 */
const MAX_NAMED_PATHS = 3

function namePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_NAMED_PATHS)
  const rest = paths.length - shown.length
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ")
}

export async function runUniqueTextStep(
  rootReal: string,
  before: string,
  after: string,
  deps: UniqueTextStepDeps = {},
): Promise<UniqueTextStepResult> {
  if (before.trim().length === 0) {
    return { ok: false, reason: "There is no text to look for." }
  }
  if (before === after) {
    return { ok: false, reason: "The new text is the same as the old text." }
  }

  const now = deps.now ?? Date.now
  const limits = deps.limits ?? DEFAULT_COLLECT_LIMITS
  const start = now()

  // One deadline for the whole step, not one per phase: `at` is fixed from
  // this start time, so if collection alone eats most of the budget, the
  // search phase below sees that immediately instead of getting a fresh
  // `budgetMs` of its own.
  const deadline = { now, at: start + limits.budgetMs }

  const collected = deps.collect ? await deps.collect(rootReal, limits) : await collectSearchFiles(rootReal, limits, now)
  if (!collected.ok) {
    // Already a plain sentence, written for this audience by the collector.
    return { ok: false, reason: collected.reason }
  }

  // Dynamic imports for the same reason every other cross-package load in
  // this directory is dynamic: a static import of `src/editor/**` does not
  // resolve under `npx tsx src/cli.ts`, because Node's ESM resolver runs
  // before the tsx loader can transform the `.ts`. See `loadValidator` at
  // the top of `edit-handler.ts`.
  const { findUniqueText } = await import("../../../src/editor/edit-service/find-unique-text")
  const found = findUniqueText(collected.files, before, deadline)
  if (!found.ok) {
    if (found.code === "many-matches") {
      const count = found.count ?? 0
      const paths = found.paths ?? []
      return {
        ok: false,
        reason: `The text appears ${count} times in the project (${namePaths(paths)}).`,
      }
    }
    if (found.code === "no-match") {
      return {
        ok: false,
        reason: "That text was not found in any of the project's files.",
      }
    }
    if (found.code === "timeout") {
      return { ok: false, reason: found.reason }
    }
    return { ok: false, reason: "There is no text to look for." }
  }

  const { path: file, candidate } = found.occurrence
  // `findUniqueText` only returns a path it was given, so the lookup
  // cannot miss. Guarded anyway rather than asserted: this value decides
  // which file the caller writes.
  const match = collected.files.find((f) => f.path === file)
  if (!match) {
    return { ok: false, reason: "The file holding that text could not be read again." }
  }

  const { applyUniqueTextEdit } = await import(
    "../../../src/editor/edit-service/apply-unique-text-edit"
  )
  const applied = applyUniqueTextEdit({ source: match.content, candidate, before, after })
  if (!applied.ok) {
    return { ok: false, reason: applied.reason }
  }

  return { ok: true, file, source: match.content, newSource: applied.source }
}

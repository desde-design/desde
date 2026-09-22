/**
 * Search a set of files for exactly one occurrence of a piece of page text.
 * Part of the unique-text edit step
 * (`docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`): before a
 * text edit that the bridge can't map to source falls through to chat, the
 * Editor looks for the old text in the project's own source files. This is
 * "look," not "look and write" — `apply-unique-text-edit.ts` does the write.
 *
 * Pure and filesystem-free: `files` is already-read `{path, content}` pairs.
 * `editor-cli/src/server/collect-search-files.ts` is what walks the repo and
 * builds that list.
 */

import { collapseWhitespace, formatsForPath, scanCandidates, type TextCandidate } from "./text-encodings"

export interface SearchFile {
  path: string
  content: string
}

export interface TextOccurrence {
  path: string
  candidate: TextCandidate
}

export type FindUniqueTextResult =
  | { ok: true; occurrence: TextOccurrence }
  | {
      ok: false
      code: "empty-before" | "no-match" | "many-matches" | "timeout"
      reason: string
      count?: number
      paths?: string[]
    }

/**
 * A shared wall-clock deadline, passed in by a caller that also spent time
 * before this function ran (e.g. `collectSearchFiles` walking the repo) so
 * the whole unique-text step shares one budget instead of each phase
 * getting its own. `now` stays injectable so a test can simulate the clock
 * without a real sleep; kept optional because `findUniqueText`'s own tests
 * and callers that don't care about the deadline can omit it.
 */
export interface FindUniqueTextDeadline {
  now: () => number
  at: number
}

/**
 * `before` matches a candidate only when the candidate's decoded text equals
 * `before`, both whitespace-collapsed and trimmed. A candidate that merely
 * contains `before` as a substring does not count — "Role: May 2022 -
 * present" is not a match for "May 2022 - present".
 *
 * Success requires exactly one match across every file. Zero matches or two
 * or more (whether in one file or spread across several) both refuse, since
 * neither case can be replaced without guessing which occurrence — or
 * whether there is one at all — the user meant.
 */
export function findUniqueText(
  files: readonly SearchFile[],
  before: string,
  deadline?: FindUniqueTextDeadline,
): FindUniqueTextResult {
  const target = collapseWhitespace(before)
  if (target.length === 0) {
    return {
      ok: false,
      code: "empty-before",
      reason: "The text to find is empty or only whitespace.",
    }
  }

  const matches: TextOccurrence[] = []
  for (const file of files) {
    if (deadline && deadline.now() > deadline.at) {
      return {
        ok: false,
        code: "timeout",
        reason: "Searching the project took too long.",
      }
    }
    const formats = formatsForPath(file.path)
    if (formats.length === 0) continue
    for (const candidate of scanCandidates(file.content, formats)) {
      if (collapseWhitespace(candidate.decoded) === target) {
        matches.push({ path: file.path, candidate })
      }
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      code: "no-match",
      reason: "No file contains that text.",
    }
  }

  if (matches.length > 1) {
    const paths = Array.from(new Set(matches.map((match) => match.path))).sort()
    return {
      ok: false,
      code: "many-matches",
      reason: `The text appears ${matches.length} times, across ${paths.length} file${paths.length === 1 ? "" : "s"}.`,
      count: matches.length,
      paths,
    }
  }

  return { ok: true, occurrence: matches[0] }
}

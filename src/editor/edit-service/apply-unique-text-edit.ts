/**
 * Apply a unique-text edit to one file's content, given the occurrence
 * `find-unique-text.ts` already found. Part of the unique-text edit step
 * (`docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`).
 *
 * Before splicing, this re-scans `source` for the candidate's format and
 * requires the SAME byte range to still decode to `before`. That catches the
 * case where `source` isn't the exact bytes the search ran against anymore
 * (a concurrent edit, or a caller re-using a stale candidate) — the byte
 * range might now sit in the middle of different text, or the file's shape
 * around it might have changed, and re-scanning proves the candidate is
 * still exactly what it was found to be before anything is written.
 *
 * Pure and filesystem-free: no read, no write, just `string in, string out`.
 */

import { collapseWhitespace, encodeReplacement, scanCandidates, type TextCandidate } from "./text-encodings"

export type ApplyUniqueTextResult = { ok: true; source: string } | { ok: false; reason: string }

export interface ApplyUniqueTextEditInput {
  source: string
  candidate: TextCandidate
  before: string
  after: string
}

export function applyUniqueTextEdit(input: ApplyUniqueTextEditInput): ApplyUniqueTextResult {
  const { source, candidate, before, after } = input
  const { byteStart, byteEnd } = candidate

  if (byteStart < 0 || byteEnd > source.length || byteStart > byteEnd) {
    return { ok: false, reason: "The text position no longer fits inside the file." }
  }

  const rescanned = scanCandidates(source, [candidate.format])
  const current = rescanned.find((c) => c.byteStart === byteStart && c.byteEnd === byteEnd)
  if (!current || collapseWhitespace(current.decoded) !== collapseWhitespace(before)) {
    return {
      ok: false,
      reason: "The file no longer holds that text at the expected position, so the edit was not applied.",
    }
  }

  const encoded = encodeReplacement(after, current)
  if (!encoded.ok) {
    return { ok: false, reason: encoded.reason }
  }

  return { ok: true, source: source.slice(0, byteStart) + encoded.bytes + source.slice(byteEnd) }
}

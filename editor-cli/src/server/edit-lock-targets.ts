/**
 * Route-layer derivation of the FILES an edit request will touch, for
 * lock-key purposes only (Task 11).
 *
 * Why it lives at the route layer: `applyEdit` resolves paths internally
 * (realpath + containment + extension gates), but the per-file lock has to be
 * held ACROSS `applyEdit` — including the LLM mini-turn, which can run for up
 * to 90s. So the route needs a target list before dispatch. This module does
 * the minimum needed to name a mutex: it reads the same fields `applyEdit`
 * will resolve and returns their raw spellings; `session-lock.ts` normalizes
 * them into keys.
 *
 * It is DELIBERATELY not a security boundary and not a resolver — no
 * filesystem access, no path validation. `applyEdit`'s guards remain
 * authoritative for "may this path be written at all". A path listed here
 * that later fails those guards just means we briefly held a mutex nobody
 * else wanted.
 *
 * Returning an EMPTY list means "couldn't tell" — the caller must then fall
 * back to the exclusive tree lock (fail-safe: a future edit kind that writes
 * files without a recognizable `file` field degrades to over-serialization,
 * never to no serialization).
 */

import type { EditRequestBody } from "../../../src/editor/edit-service/validate-edit-request.js"

/**
 * `sourceLoc` is `"<file>:<line>:<column>"`. Mirrors `parseSourceLocFile` in
 * `edit-handler.ts` — a file path may itself contain colons (Windows drive
 * letters), so we strip exactly the last two colon-delimited segments.
 */
function parseSourceLocFile(sourceLoc: string): string | null {
  const lastColon = sourceLoc.lastIndexOf(":")
  if (lastColon < 0) return null
  const secondLast = sourceLoc.lastIndexOf(":", lastColon - 1)
  if (secondLast < 0) return null
  return sourceLoc.slice(0, secondLast) || null
}

/**
 * The file paths (request spellings, un-normalized) an edit may write or
 * read-as-part-of-the-edit. Empty when the shape is unrecognized or
 * malformed — see the module header for the fail-safe that implies.
 */
export function editLockTargets(body: EditRequestBody): string[] {
  const edit = (body as { edit?: unknown } | null | undefined)?.edit
  if (!edit || typeof edit !== "object") return []
  const e = edit as Record<string, unknown>
  const targets: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) targets.push(v)
  }

  if (e.kind === "llm-patch") {
    // Multi-file: one target per mutation, using the SAME cross-file rule
    // `handleLLMPatch` applies (a 'callsite + this-instance' mutation lands
    // in the callsite's file, not the sourceLoc's). A malformed loc yields
    // no target here; `applyEdit` refuses that request with a 400 anyway.
    const mutations = Array.isArray(e.mutations) ? e.mutations : []
    for (const m of mutations) {
      if (!m || typeof m !== "object") continue
      const mu = m as Record<string, unknown>
      const isCrossFile =
        mu.scope === "callsite" &&
        mu.disambiguationChoice === "this-instance" &&
        typeof mu.callsiteLoc === "string"
      const loc = isCrossFile ? mu.callsiteLoc : mu.sourceLoc
      if (typeof loc !== "string") continue
      const file = parseSourceLocFile(loc)
      if (file) targets.push(file)
    }
    return targets
  }

  // Every other kind carries an explicit `file`.
  push(e.file)
  if (e.kind === "detach") {
    // The component file is read (and its source feeds the patch) while the
    // consumer file is written — lock both so a concurrent edit to the
    // component can't be read half-written.
    push(e.componentFile)
  } else if (e.kind === "move") {
    // `destFile` must equal `file` today (cross-file moves are V2); listing
    // it keeps the derivation honest if that ever relaxes. De-duped
    // downstream.
    push(e.destFile)
  }
  return targets
}

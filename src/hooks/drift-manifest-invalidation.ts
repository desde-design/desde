"use client"

/**
 * Shared "apply an `invalidate` list" helper for the two drift hooks that
 * both receive one from `editor-cli/src/server/drift-handler.ts`'s
 * responses — `useDriftReporter` (from a successful `POST` flush) and
 * `useDriftEntries` (from `GET`/`DELETE`/`regenerate-hints` responses,
 * final review fix wave). Extracted so the two can't silently diverge on
 * the parsing/dedupe contract `drift-handler.ts`'s `invalidateList` doc
 * comment documents — before this module, `useDriftEntries` simply
 * ignored the field it received, so a server-side auto-repair (or a
 * user-initiated regenerate-hints run) never invalidated the shell's
 * `CachedManifestLookup` unless a LATER drift-reporting edit happened to
 * also flush one.
 */

/** One `(component, importPath)` pair to drop from the shell's manifest cache. */
export interface ManifestInvalidationEntry {
  name: string
  importPath?: string
}

/**
 * Dedupe key for "already invalidated" tracking — `(name, importPath,
 * attemptedAt)`, NOT just `(name, importPath)`. `attemptedAt` is the repair
 * ATTEMPT's own timestamp (`DriftEntry.repair.attemptedAt`) — unique per
 * distinct repair, stable across repeated responses reporting the SAME
 * settled repair. Load-bearing because `drift-handler.ts`'s `invalidate`
 * list is recomputed FRESH on every response (not a one-shot delta): a
 * dedupe key of `(name, importPath)` alone would treat a component that
 * drifts, gets dismissed, and drifts AGAIN later (a brand new repair,
 * legitimately re-listed) as already-seen forever, silently swallowing the
 * second invalidation.
 */
export function invalidationDedupeKey(
  entry: ManifestInvalidationEntry & { attemptedAt?: string },
): string {
  return `${entry.name}::${entry.importPath ?? ""}::${entry.attemptedAt ?? ""}`
}

/**
 * Parse a raw `invalidate` field from a drift-log response body, drop
 * entries already recorded in `seen` (mutated in place — same lifetime as
 * the caller's own dedupe ref), and call `invalidateManifest` with
 * whichever entries are left. No-ops when `invalidateManifest` is omitted
 * or `raw` isn't an array — never throws.
 */
export function applyInvalidateList(
  raw: unknown,
  seen: Set<string>,
  invalidateManifest: ((entries: ManifestInvalidationEntry[]) => void) | undefined,
): void {
  if (!invalidateManifest || !Array.isArray(raw)) return
  const fresh: ManifestInvalidationEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const name = (item as { name?: unknown }).name
    if (typeof name !== "string") continue
    const importPathRaw = (item as { importPath?: unknown }).importPath
    const importPath = typeof importPathRaw === "string" ? importPathRaw : undefined
    const attemptedAtRaw = (item as { attemptedAt?: unknown }).attemptedAt
    const attemptedAt = typeof attemptedAtRaw === "string" ? attemptedAtRaw : undefined
    const key = invalidationDedupeKey({ name, importPath, attemptedAt })
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(importPath !== undefined ? { name, importPath } : { name })
  }
  if (fresh.length > 0) invalidateManifest(fresh)
}

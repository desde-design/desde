"use client"

/**
 * Shell-side data hook for the Drift panel section (Phase 5 Task 5 of the
 * grounding rearchitecture — `.superpowers/sdd/2026-07-29-grounding-phase5-drift/task-5-brief.md`).
 *
 * Reads the live drift log from `GET /api/editor/drift`, and drives the
 * panel's per-row actions:
 *   - `dismiss(key)` — `DELETE /api/editor/drift/:key`
 *   - `clearAll()` — `DELETE /api/editor/drift`
 *   - `regenerateHints(key)` — `POST /api/editor/drift/:key/regenerate-hints`,
 *     streamed the same way `useDesignSystems.generateHints` streams the
 *     sibling Phase 4 whole-package route.
 *
 * A sibling of `useDesignSystems` rather than folded into it: drift entries
 * are a different resource with a different lifecycle (they accrue from
 * bridge-reported signals via `useDriftReporter`, not from an onboarding
 * action), so keeping this hook separate avoids conflating two independent
 * `busy`/`error` states behind one flag.
 *
 * **Manifest invalidation (final review fix wave).** Every response this
 * hook reads (`GET`/`DELETE`/`DELETE :key`/`regenerate-hints`) carries the
 * SAME `invalidate` list `useDriftReporter` consumes from its own `POST`
 * responses (see `drift-handler.ts`'s `invalidateList` doc comment) — before
 * this fix, this hook simply ignored it, so a repair settling between two
 * text-edit-driven POSTs (or a user-initiated "Regenerate hints" run) never
 * reached the shell's `CachedManifestLookup` until some LATER edit happened
 * to also flush a drift POST. Wired through the same shared
 * `applyInvalidateList`/`invalidationDedupeKey` helpers
 * (`./drift-manifest-invalidation`) `useDriftReporter` uses, with this
 * hook's OWN dedupe-keys ref (idempotent either way — `invalidateManifest`
 * is documented as safe to call again for an already-invalidated key).
 *
 * **`regenerateHints` invalidates from its OWN SSE result frame (codex P2,
 * 2026-07-30), not just the `reload()` that follows.** A regenerate never
 * sets `entry.repair`, so `reload()`'s GET response's `invalidate` list
 * (which only covers `repair?.outcome === 'repaired' | 'seeded'`) never
 * carries the regenerated component — before this fix, `regenerateHints`
 * only reloaded the drift log and dropped whatever the run itself reported.
 * The server now includes its own `invalidate` entry in the `result` SSE
 * frame (`regenerateInvalidateEntries` in `drift-handler.ts`), applied here
 * through the SAME shared helper/dedupe-ref as everything else in this hook.
 *
 * **`dismiss`/`clearAll` apply their OWN DELETE response's `invalidate`
 * BEFORE calling `reload()` (codex P2, 2026-07-30) — same shape of fix as
 * `regenerateHints` above.** A repair can settle (patch the on-disk manifest
 * cache) AFTER this hook's last drift-log load but BEFORE the user
 * dismisses that row (or clears all): `drift-handler.ts`'s DELETE routes
 * now capture the to-be-removed entry's (or entries') invalidation before
 * deleting it, since a `reload()`-only GET afterward can never report an
 * entry that dismiss/clear-all just removed from the log. Applied through
 * the SAME shared `applyInvalidateList` helper/dedupe-ref as everywhere
 * else in this hook — not a forked parsing path.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import { parseSseStream } from "@/lib/sse"
import type { DriftEntry } from "@/editor/core"
import {
  applyInvalidateList,
  type ManifestInvalidationEntry,
} from "./drift-manifest-invalidation"

const ROUTE = "/api/editor/drift"

/** Run summary for a single-component regenerate-hints call — subset of `HintGenerationResult` that's meaningful for one component. */
export interface DriftHintRegenResult {
  probed: number
  hinted: number
  verified: number
  skipped: Array<{ name: string; reason: string }>
}

/** Live progress while a regenerate-hints run streams (mirrors `HintGenerationProgress`). */
export interface DriftRegenerateProgress {
  component: string
  index: number
  total: number
}

export interface UseDriftEntries {
  entries: DriftEntry[]
  loading: boolean
  error: string | null
  /** A dismiss/clear/regenerate is in flight (disables further mutations). */
  busy: boolean
  /** Key of the entry whose regenerate-hints run is currently streaming, else null. */
  regeneratingKey: string | null
  /** Live probe progress while a regenerate-hints run streams, else null. */
  regenerateProgress: DriftRegenerateProgress | null
  /** Reload the live drift log from the server. */
  reload: () => Promise<void>
  /** Dismiss one entry. */
  dismiss: (key: string) => Promise<void>
  /** Dismiss every entry. */
  clearAll: () => Promise<void>
  /** Re-run probe/inference for exactly this entry's component. Returns the run summary, or null on failure. */
  regenerateHints: (key: string) => Promise<DriftHintRegenResult | null>
  /** Dismiss the current error banner. */
  clearError: () => void
}

export interface UseDriftEntriesOptions {
  /**
   * Called with newly-repaired `(component, importPath)` pairs whenever a
   * fresh drift-log response carries them in its `invalidate` field — wire
   * this to `CachedManifestLookup.invalidate(...)`, the SAME callback
   * `useEditorEditing` threads into `useDriftReporter`, so a repair that
   * settles here (via `reload`, which `dismiss`/`clearAll`/`regenerateHints`
   * all call) also drops the shell's stale cached manifest, not only when a
   * LATER text-edit-driven POST happens to carry the same list. Optional:
   * omitting it just means this hook never invalidates anything.
   */
  invalidateManifest?: (entries: ManifestInvalidationEntry[]) => void
}

export function useDriftEntries(options: UseDriftEntriesOptions = {}): UseDriftEntries {
  const [entries, setEntries] = useState<DriftEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null)
  const [regenerateProgress, setRegenerateProgress] = useState<DriftRegenerateProgress | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Read fresh on every reload rather than a `useCallback` dependency — the
  // caller doesn't need to memoize `invalidateManifest`. Mirrors
  // `useDriftReporter`'s identical ref pattern.
  const invalidateManifestRef = useRef(options.invalidateManifest)
  useEffect(() => {
    invalidateManifestRef.current = options.invalidateManifest
  })
  // Keys already acted on — see `drift-manifest-invalidation.ts`'s doc
  // comment for why `(name, importPath, attemptedAt)`, not just
  // `(name, importPath)`, is the correct dedupe key.
  const invalidatedKeysRef = useRef<Set<string>>(new Set())

  const reload = useCallback(async () => {
    try {
      const res = await editorFetch(ROUTE, { cache: "no-store" })
      if (!res.ok) {
        if (mounted.current) setError(await reasonOf(res, "load drift entries"))
        return
      }
      const j = await res.json().catch(() => null)
      if (mounted.current && Array.isArray(j?.entries)) setEntries(j.entries)
      // Every drift-log response (GET here, but also the DELETE/regenerate
      // responses that trigger THIS reload) carries the same `invalidate`
      // contract — see `drift-handler.ts`'s `invalidateList` doc comment.
      applyInvalidateList(j?.invalidate, invalidatedKeysRef.current, invalidateManifestRef.current)
    } catch (err) {
      if (mounted.current) setError(messageOf(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const dismiss = useCallback(
    async (key: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(key)}`, { method: "DELETE" })
        if (!res.ok) {
          if (mounted.current) setError(await reasonOf(res, "dismiss drift entry"))
          return
        }
        // Apply THIS response's own `invalidate` list before reloading
        // (codex P2 fix, 2026-07-30) — the server now computes a dismissed
        // entry's pending invalidation (from a repair that settled but was
        // never reported to a prior GET/POST) BEFORE deleting it, and
        // returns it here. `reload()`'s own GET afterward can't recover it:
        // the entry is already gone from the log by then. Same shared
        // helper `reload` itself uses, so the two can't diverge.
        const j = await res.json().catch(() => null)
        applyInvalidateList(j?.invalidate, invalidatedKeysRef.current, invalidateManifestRef.current)
        await reload()
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [busy, reload],
  )

  const clearAll = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await editorFetch(ROUTE, { method: "DELETE" })
      if (!res.ok) {
        if (mounted.current) setError(await reasonOf(res, "clear drift entries"))
        return
      }
      // Same reasoning as `dismiss` above, across every entry being
      // cleared — the server computes the full pre-clear invalidate list.
      const j = await res.json().catch(() => null)
      applyInvalidateList(j?.invalidate, invalidatedKeysRef.current, invalidateManifestRef.current)
      await reload()
    } catch (err) {
      if (mounted.current) setError(messageOf(err))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [busy, reload])

  const regenerateHints = useCallback(
    async (key: string): Promise<DriftHintRegenResult | null> => {
      if (busy) return null
      setBusy(true)
      setError(null)
      setRegeneratingKey(key)
      setRegenerateProgress(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(key)}/regenerate-hints`, {
          method: "POST",
          headers: { Accept: "text/event-stream" },
        })
        if (!res.ok || !res.body) {
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Regenerate hints failed (HTTP ${res.status}).`)
        }
        let result: DriftHintRegenResult | null = null
        for await (const ev of parseSseStream<RegenerateHintsSseEvent>(res.body)) {
          if (ev.type === "progress" && ev.progress) {
            if (mounted.current) setRegenerateProgress(ev.progress)
          } else if (ev.type === "result") {
            result = ev.result ?? null
            // Apply THIS run's own invalidate entry now — see the module doc
            // comment's "regenerateHints invalidates from its OWN SSE result
            // frame" section on why `reload()` below can't be relied on for
            // this (a regenerate never sets `entry.repair`, so the GET
            // response's `invalidate` list never carries it).
            applyInvalidateList(ev.invalidate, invalidatedKeysRef.current, invalidateManifestRef.current)
          } else if (ev.type === "error") {
            throw new Error(ev.message || "Regenerate hints failed.")
          }
        }
        if (!result) throw new Error("Regenerate hints ended without a result.")
        await reload()
        return result
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
        return null
      } finally {
        if (mounted.current) {
          setBusy(false)
          setRegeneratingKey(null)
          setRegenerateProgress(null)
        }
      }
    },
    [busy, reload],
  )

  return {
    entries,
    loading,
    error,
    busy,
    regeneratingKey,
    regenerateProgress,
    reload,
    dismiss,
    clearAll,
    regenerateHints,
    clearError: useCallback(() => setError(null), []),
  }
}

/** SSE frame from the `…/:key/regenerate-hints` POST — same envelope shape as the Phase 4 generate-hints route, plus (codex P2, 2026-07-30) this route's own `invalidate` list on the `result` frame. */
interface RegenerateHintsSseEvent {
  type: "progress" | "result" | "error"
  progress?: DriftRegenerateProgress
  result?: DriftHintRegenResult
  invalidate?: unknown
  message?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Best-effort reason from a non-OK JSON response, else an HTTP-status fallback. */
async function reasonOf(res: Response, what: string): Promise<string> {
  const reason = await res
    .json()
    .then((j) => (j && typeof j.reason === "string" ? j.reason : null))
    .catch(() => null)
  return reason ?? `Failed to ${what} (HTTP ${res.status}).`
}

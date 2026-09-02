"use client"

/**
 * Debounced client for `POST /api/editor/drift` (Phase 5 Task 2 of the
 * grounding rearchitecture). `detectDrift` (`src/editor/attribution/
 * detect-drift.ts`) can fire on every inspector click, so a naive "POST per
 * signal" would be chatty — this hook buffers, coalesces, and rate-limits
 * the actual network traffic while keeping `report()` itself synchronous
 * and side-effect-free from the caller's perspective (fire-and-forget).
 *
 * Advisory-first, same posture as the drift log itself: reporting is a
 * diagnostic nicety, never something that should surface an error to the
 * user or block the UI. Failures (including exhausting the one retry) are
 * swallowed silently.
 *
 * Behavior:
 *   - Buffer signals in memory; flush at most once per 3s via a single
 *     POST (and once more on unmount, for whatever's still buffered).
 *   - Coalesce within the buffer by `(kind, component, importPath, detail)`
 *     — a repeat signal for the same key replaces the buffered one rather
 *     than growing the batch; the key's position in the flush order is
 *     NOT reset by an update, only by first insertion (oldest-first
 *     eviction stays meaningful under continuous updates to the same key).
 *   - Cap the buffer at 50 distinct keys. Detection now runs on every
 *     inspection/click (not just text-edit commits), so selection churn
 *     (rapid clicking, Layers-panel navigation) can plausibly produce many
 *     distinct signal keys inside one 3s window. Silently evicting the
 *     oldest key to make room would drop real signals with no trace — the
 *     worst failure mode for a diagnostic feature. Instead, a brand-new key
 *     that brings the buffer to the cap triggers an IMMEDIATE flush of
 *     that full batch (cancelling the pending 3s timer), and buffering
 *     resumes fresh for whatever comes next. This aligns naturally with the
 *     server's own `MAX_SIGNALS_PER_REQUEST` batch limit (also 50, see
 *     `editor-cli/src/server/drift-handler.ts`) — a cap-triggered flush
 *     always sends a request-sized batch, never an oversized one. Net
 *     effect: no signal is ever dropped for being "too many at once"; the
 *     buffer just flushes more often under heavy churn.
 *   - On transport failure, retry once; a second failure drops the batch
 *     silently. (This is the one remaining silent-drop path, and it's
 *     unrelated to the cap — it's a transport/backend outage, not volume.)
 *
 * **Manifest invalidation (Phase 5 Task 5).** A successful POST's response
 * carries an `invalidate` list — `(component, importPath, attemptedAt)`
 * entries whose on-disk hint cache was just patched by a server-side
 * auto-repair (Task 4's `repairComponent`, triggered by an earlier signal in
 * the log; see `drift-handler.ts`'s `invalidateList` doc comment for the
 * full contract). When the caller supplies `invalidateManifest`, this hook
 * calls it with whatever entries in that list it hasn't already acted on —
 * tracked in a ref keyed by `(name, importPath, attemptedAt)` via the SHARED
 * `applyInvalidateList`/`invalidationDedupeKey` helpers in
 * `./drift-manifest-invalidation` (also used by `useDriftEntries`, so the
 * two hooks can't silently diverge on the parsing/dedupe contract — see
 * that module's doc comment for why `attemptedAt` is load-bearing, not just
 * `(name, importPath)`). `invalidateManifest` is read from a ref on every
 * flush (not a `useCallback` dependency), so the caller doesn't need to
 * memoize it.
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import type { DriftSignal } from "@/editor/core"
import {
  applyInvalidateList,
  type ManifestInvalidationEntry,
} from "./drift-manifest-invalidation"

export type { ManifestInvalidationEntry }

const ROUTE = "/api/editor/drift"
const FLUSH_INTERVAL_MS = 3000
/**
 * Also the server's `MAX_SIGNALS_PER_REQUEST` (`drift-handler.ts`) — kept
 * equal so a cap-triggered early flush (see `report()`) always sends a
 * request-sized batch, never one the server would 400 for being oversized.
 */
const MAX_BUFFERED_KEYS = 50
/** One initial attempt + this many retries before dropping the batch silently. */
const MAX_ATTEMPTS = 2

export interface UseDriftReporterOptions {
  /**
   * Called with newly-repaired `(component, importPath)` pairs after a
   * successful flush — wire this to `CachedManifestLookup.invalidate(...)`
   * (see `src/editor/attribution/manifest-lookup.ts`) so a component whose
   * hints were just re-extracted gets re-fetched on next attribution rather
   * than serving the stale cached manifest. Optional: omitting it just
   * means invalidation never happens (e.g. a caller with no live lookup
   * instance to invalidate).
   */
  invalidateManifest?: (entries: ManifestInvalidationEntry[]) => void
}

export interface UseDriftReporter {
  /** Buffer these signals for the next debounced flush. Fire-and-forget. */
  report(signals: DriftSignal[]): void
}

/** `(kind, component, importPath, detail)` — the within-buffer coalescing key. */
function coalesceKey(signal: DriftSignal): string {
  return `${signal.kind}::${signal.component}::${signal.importPath ?? ""}::${signal.detail ?? ""}`
}

export function useDriftReporter(options: UseDriftReporterOptions = {}): UseDriftReporter {
  // Map preserves insertion order. Re-`set`ting an EXISTING key does not
  // move it in iteration order — only inserting a genuinely new key appends
  // at the end. That ordering isn't used for eviction anymore (the cap
  // triggers an immediate flush of the WHOLE buffer instead — see the
  // module doc comment), but it's still what makes "oldest signal in the
  // batch" a meaningful, deterministic concept if this ever needs revisiting.
  const bufferRef = useRef<Map<string, DriftSignal>>(new Map())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read fresh on every flush rather than captured as a `useCallback`
  // dependency — the caller (`useEditorEditing`) doesn't need to memoize
  // `invalidateManifest` for this hook to always call the latest version.
  // Written in an effect, not directly during render — mutating a ref's
  // `.current` while rendering is itself a render-purity violation (flagged
  // by the `react-hooks/refs` lint rule) even though nothing here reads the
  // ref back during THIS render.
  const invalidateManifestRef = useRef(options.invalidateManifest)
  useEffect(() => {
    invalidateManifestRef.current = options.invalidateManifest
  })
  // Keys already acted on — the handler's `invalidate` list is recomputed
  // fresh on every response (not a delta), so this is what keeps a repeated
  // POST from re-invalidating (and re-fetching) the same manifest forever.
  const invalidatedKeysRef = useRef<Set<string>>(new Set())

  // Thin wrapper over the SHARED helper (`./drift-manifest-invalidation`) —
  // reads `invalidateManifestRef` fresh on every call rather than closing
  // over a snapshot, same as before this was extracted.
  const applyResponseInvalidateList = useCallback((raw: unknown): void => {
    applyInvalidateList(raw, invalidatedKeysRef.current, invalidateManifestRef.current)
  }, [])

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const buffer = bufferRef.current
    if (buffer.size === 0) return
    const batch = [...buffer.values()]
    buffer.clear()
    void postWithRetry(batch, applyResponseInvalidateList)
  }, [applyResponseInvalidateList])

  const report = useCallback(
    (signals: DriftSignal[]) => {
      if (signals.length === 0) return
      const buffer = bufferRef.current
      for (const signal of signals) {
        const key = coalesceKey(signal)
        const isNewKey = !buffer.has(key)
        buffer.set(key, signal)
        // Cap reached on a genuinely new key: flush the full batch NOW
        // instead of evicting the oldest to make room. Eviction would drop
        // a real signal silently; an early flush sends everything buffered
        // so far (exactly `MAX_BUFFERED_KEYS`, which is also the server's
        // per-request cap) and starts a fresh buffer for whatever's next in
        // this same `report()` call. `flush()` clears `timerRef` itself, so
        // the check below always schedules a fresh timer for the remainder.
        if (isNewKey && buffer.size >= MAX_BUFFERED_KEYS) {
          flush()
        }
      }
      // Rate-limit, don't debounce: the FIRST buffered signal starts a 3s
      // timer; subsequent signals within that window just add to the
      // buffer without pushing the timer back out. Under a steady stream
      // of drift this still flushes every 3s rather than never firing.
      if (timerRef.current === null && buffer.size > 0) {
        timerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS)
      }
    },
    [flush],
  )

  // Flush whatever's still buffered when the owning component unmounts —
  // best-effort, not awaited (there's nothing left to update once unmounted).
  useEffect(() => {
    return () => {
      flush()
    }
  }, [flush])

  // Stable identity across renders (both fields are themselves stable
  // useCallbacks) so callers can safely depend on the returned object in
  // their own hook dependency arrays without it re-triggering every render.
  return useMemo(() => ({ report }), [report])
}

async function postWithRetry(
  signals: DriftSignal[],
  applyResponseInvalidateList: (raw: unknown) => void,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await editorFetch(ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signals }),
      })
      if (res.ok) {
        // Best-effort: a body-parse failure here is no different from any
        // other advisory hiccup in this hook — never throws, never retries.
        const body = await res.json().catch(() => null)
        applyResponseInvalidateList((body as { invalidate?: unknown } | null)?.invalidate)
        return
      }
    } catch {
      // Transport failure — fall through to the next attempt (if any).
    }
  }
  // Every attempt failed — advisory-first: drop silently, never throw or
  // surface an error to the caller.
}

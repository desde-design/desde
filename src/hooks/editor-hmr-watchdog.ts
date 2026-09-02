/**
 * Prototype-reload + HMR-miss-telemetry watchdog for `useEditorEditing`.
 * Extracted verbatim (share-readiness Phase 3 Batch B) — already
 * React-free, so this is a pure move: no behavior change, the hook now
 * imports these instead of defining them inline.
 *
 * See tasks/share-readiness-plan.md.
 */

import { EDITOR_RELOAD_BACKSTOP } from "@/lib/editor-feature-flags"

/**
 * Whether the post-edit reload backstop is active.
 *
 * Primary source: `.desde/config.json` →
 *   { "editor": { "reloadBackstop": false } }
 * Surfaced to the shell via the CLI bootstrap script (see
 * {@link EDITOR_RELOAD_BACKSTOP} in lib/editor-feature-flags.ts).
 * Read once at module load; flipping requires a CLI restart.
 *
 * In-session override (no CLI restart needed):
 *   localStorage.setItem('editor:disable-reload-backstop', '1')
 *   // takes effect on the NEXT edit dispatch — no page reload needed,
 *   // this function reads localStorage on every call
 *
 * Precedence: when the config-level flag is OFF, localStorage cannot
 * re-enable the backstop (the config is the persistent decision).
 * When the config flag is ON or unset, localStorage can disable for
 * the current session.
 *
 * Default: true (reload after every successful edit). The backstop
 * exists because Vite HMR has historically missed editor file writes
 * for several reasons (chokidar races, stale ws across worktree
 * sessions, bridge DOM mutations pre-empting Vue's diff). Dropping it
 * keeps open panels, scroll position, and component state intact
 * across edits — but if HMR misses a write the user has to refresh
 * manually. Telemetry at `window.__EDITOR_HMR_STATS__` is exposed
 * so dogfooders can measure the miss rate before committing to OFF.
 *
 * Only affects the AUTOMATIC backstop. User-initiated reloads (e.g.,
 * the conflict-recovery Reload button) call requestPrototypeReload
 * with `mode: "force"` and ignore this flag.
 */
export function reloadBackstopEnabled(): boolean {
  if (typeof window === "undefined") return true
  if (!EDITOR_RELOAD_BACKSTOP) return false
  try {
    return (
      window.localStorage.getItem("editor:disable-reload-backstop") !== "1"
    )
  } catch {
    return true
  }
}

/**
 * Ask the bridge to reload the prototype iframe at its current SPA URL.
 *
 * Why postMessage instead of `iframe.src = …`: the `src` attribute
 * holds whatever the parent last assigned (usually the session-start
 * route) and does NOT track in-iframe SPA navigation — re-assigning it
 * bounces the user back to that initial URL. The bridge runs inside
 * the iframe, so its `window.location.reload()` reloads at the live
 * URL and preserves the route.
 *
 * Cross-origin safe: postMessage works across origins, and the bridge
 * listens for `data.type === "RELOAD_PROTOTYPE"` with no source
 * filter (see comment-bridge.ts).
 *
 * Two modes:
 *  - `backstop` (default) — automatic post-edit safety net. Gated by
 *    {@link reloadBackstopEnabled}; no-op when the user has flipped
 *    the flag off to dogfood without reloads.
 *  - `force` — explicit user-initiated reload (e.g., the Reload
 *    button after an edit conflict). Always fires regardless of the
 *    flag; the user clicked a button labeled "reload" and expects an
 *    actual reload.
 */
export function requestPrototypeReload(
  iframe: HTMLIFrameElement | null,
  reason: string,
  mode: "backstop" | "force" = "backstop",
): void {
  const hmrStats = ensureHmrStats()
  hmrStats.lastDispatch = { reason, at: Date.now() }
  if (mode === "backstop" && !reloadBackstopEnabled()) {
    console.info(
      `[Editor] reload-backstop disabled — relying on HMR for "${reason}"`,
    )
    hmrStats.skippedReloads++
    armHmrTimeoutCheck(reason)
    return
  }
  hmrStats.sentReloads++
  const win = iframe?.contentWindow
  if (!win) return
  win.postMessage({ type: "RELOAD_PROTOTYPE", payload: { reason } }, "*")
}

/**
 * Minimal HMR-fired telemetry. We can't directly observe Vite's HMR
 * client (it lives inside the iframe, behind cross-origin), but the
 * bridge already emits DOM_MUTATED on a trailing-debounced
 * MutationObserver — so "DOM mutated within N seconds of a editor
 * edit dispatch" is a usable proxy for "HMR fired and Vue re-rendered."
 *
 * Stats are exposed as `window.__EDITOR_HMR_STATS__` so dogfooders
 * can inspect them between edits. Console messages narrate each
 * dispatch + HIT/MISS so the timeline is also legible from the live
 * console.
 *
 * Caveat: for inspector text/attr edits the bridge ALREADY pre-mutated
 * the DOM for live preview, so DOM_MUTATED fires before HMR (the
 * "hit" is the bridge's own mutation, not HMR). The signal is cleanest
 * for chat-driven edits where the bridge hasn't pre-mutated. The
 * dispatch logs include the reason so misleading "hits" can be
 * filtered out in analysis.
 */
export interface EditorHmrStats {
  dispatches: number
  hits: number
  misses: number
  sentReloads: number
  skippedReloads: number
  lastDispatch: { reason: string; at: number } | null
  pending: Map<string, { reason: string; at: number; timer: ReturnType<typeof setTimeout> }>
}

const HMR_TIMEOUT_MS = 3000

export function ensureHmrStats(): EditorHmrStats {
  if (typeof window === "undefined") {
    return {
      dispatches: 0,
      hits: 0,
      misses: 0,
      sentReloads: 0,
      skippedReloads: 0,
      lastDispatch: null,
      pending: new Map(),
    }
  }
  const w = window as unknown as { __EDITOR_HMR_STATS__?: EditorHmrStats }
  if (!w.__EDITOR_HMR_STATS__) {
    w.__EDITOR_HMR_STATS__ = {
      dispatches: 0,
      hits: 0,
      misses: 0,
      sentReloads: 0,
      skippedReloads: 0,
      lastDispatch: null,
      pending: new Map(),
    }
  }
  return w.__EDITOR_HMR_STATS__
}

export function armHmrTimeoutCheck(reason: string): void {
  const stats = ensureHmrStats()
  stats.dispatches++
  const id = `${reason}-${stats.dispatches}`
  const at = Date.now()
  const timer = setTimeout(() => {
    if (stats.pending.delete(id)) {
      stats.misses++
      console.warn(
        `[Editor HMR] MISS — no DOM_MUTATED within ${HMR_TIMEOUT_MS}ms after ${reason}. HMR likely missed the file write.`,
      )
    }
  }, HMR_TIMEOUT_MS)
  stats.pending.set(id, { reason, at, timer })
  console.info(`[Editor HMR] dispatch=${reason} (waiting for DOM_MUTATED)`)
}

/**
 * Wired into the adapter's tree-update subscription (which fires on
 * DOM_MUTATED + ROUTE_CHANGED). Resolves the OLDEST pending dispatch
 * as a hit. If multiple dispatches are racing (e.g., rapid inspector
 * typing), each DOM_MUTATED clears one — over-counts hits slightly
 * but doesn't affect misses (the failing case we care about).
 */
export function recordHmrTreeUpdate(): void {
  const stats = ensureHmrStats()
  if (stats.pending.size === 0) return
  const [id, entry] = stats.pending.entries().next().value as [
    string,
    { reason: string; at: number; timer: ReturnType<typeof setTimeout> },
  ]
  clearTimeout(entry.timer)
  stats.pending.delete(id)
  stats.hits++
  const elapsed = Date.now() - entry.at
  console.info(
    `[Editor HMR] HIT — DOM_MUTATED ${elapsed}ms after ${entry.reason}`,
  )
}

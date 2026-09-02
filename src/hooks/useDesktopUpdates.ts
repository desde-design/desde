"use client"

/**
 * Desktop-only auto-update state — reads `window.desdeDesktop.updates`
 * (`desktop/preload.ts`) and returns `undefined` in a plain browser tab,
 * where that global is absent entirely. Every consumer follows the same
 * shape: `const updates = useDesktopUpdates(); if (!updates) return null`.
 * This is the ONLY gate — there is no separate feature flag — so the
 * badge, the settings-menu section, and the launcher nav button all vanish
 * together the moment this hook returns `undefined`, and the CLI-in-a-
 * browser flow is untouched by construction.
 *
 * See `tasks/electron-app.md` §3 (the preload API this wraps) and §4 (the
 * auto-update design this state machine implements).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { DesktopUpdateState } from "@/types/desktop-bridge"

export interface DesktopUpdatesApi {
  state: DesktopUpdateState
  /** `undefined` while the initial `getAutoDownload()` read is in flight. */
  autoDownload: boolean | undefined
  setAutoDownload: (value: boolean) => Promise<void>
  /** Manual download when autoDownload is off. No-op outside phase "available" (enforced main-process side). */
  download: () => Promise<void>
  /** Only valid in phase "ready" (enforced main-process side) — fire-and-forget, the app may quit before any reply. */
  restartAndInstall: () => void
  /** On-demand "Check for updates" — same effect as the periodic 4h timer firing once, right now. Fire-and-forget; the result arrives via the pushed `state` above. */
  checkForUpdates: () => void
}

const IDLE_STATE: DesktopUpdateState = { phase: "idle" }

/** Stable id so a second failed toggle updates the SAME toast in place instead of stacking a new one — matches `resolution-failure-notice.ts`'s toast-id pattern. */
export const AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID = "desktop-auto-download-write-failed"

/**
 * F3 (whole-branch review, Important; P2 fix on second pass). Same
 * stable-id pattern as `AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID` — a repeat
 * on-demand check result (whichever of the two messages below it is)
 * updates the same toast in place rather than stacking. Named for the
 * FEATURE ("the on-demand check's result"), not one specific message,
 * since F8 (whole-branch review, third pass, P2 fix) added a second,
 * different message this same id now also covers.
 */
export const UPDATE_CHECK_RESULT_TOAST_ID = "desktop-update-check-result"

function notifyAutoDownloadWriteFailed(err: unknown): void {
  toast.error("Couldn't save the update setting", {
    id: AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID,
    description: err instanceof Error ? err.message : String(err),
  })
}

export function useDesktopUpdates(): DesktopUpdatesApi | undefined {
  // Read once. `window.desdeDesktop` either exists for the whole
  // session (the desktop shell's preload script runs before any React code)
  // or never does (a browser tab) — it is not something that appears or
  // disappears mid-session, so there is no need to re-check it on every
  // render.
  const [bridge] = useState(() =>
    typeof window === "undefined" ? undefined : window.desdeDesktop,
  )
  const [state, setState] = useState<DesktopUpdateState>(IDLE_STATE)
  const [autoDownload, setAutoDownloadState] = useState<boolean | undefined>(undefined)
  // The last value we KNOW is actually persisted — the initial read, or the
  // value of whichever `setAutoDownload()` call most recently confirmed
  // successfully. A FAILED call rolls back to THIS, not to whatever
  // `autoDownload` happened to hold when it was called: if an earlier
  // in-flight toggle already confirmed a different value while this one was
  // still writing, rolling back to "the value before this call" would
  // reintroduce a value that was never actually saved. A ref (not state) —
  // reading it must never itself trigger a render.
  const lastConfirmedAutoDownload = useRef<boolean | undefined>(undefined)
  // The id of the call that most recently WON the right to update
  // `lastConfirmedAutoDownload` (see `lastConfirmedCallId` usage below) —
  // NOT the same thing as `autoDownloadCallSeq.current` (the highest id
  // ISSUED). A success only gets to update the confirmed value if its own
  // id is newer than whichever call last confirmed one; otherwise an OLDER
  // call's success settling AFTER a newer one's would silently overwrite
  // the confirmed ref with stale data — invisible until a LATER call fails
  // and rolls back to that corrupted value instead of the real one.
  const lastConfirmedCallId = useRef(0)
  // Monotonic call counter. Two rapid toggles are two independent in-flight
  // promises with no guaranteed settle order (the main-process side is
  // serialized — see auto-download-mutation-queue.ts's F6 fix — but nothing
  // here guarantees the RENDERER observes their resolutions in that same
  // order). Without this, an OLDER call's resolution — success OR failure —
  // arriving after a NEWER call has already confirmed something can stomp
  // the newer call's result: e.g. call A (false) fails and rolls the
  // checkbox back to `true` AFTER call B (false) already succeeded, leaving
  // the checkbox stuck showing `true` while the actually-persisted value is
  // `false`. Only the call whose id still matches the counter at settle time
  // — i.e. the MOST RECENTLY ISSUED call — is allowed to touch the displayed
  // state or toast; an older, superseded call's outcome is moot once a newer
  // one has already landed.
  const autoDownloadCallSeq = useRef(0)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge.updates.getState().then((s) => {
      if (!cancelled) setState(s)
    })
    void bridge.updates.getAutoDownload().then((v) => {
      if (cancelled) return
      // F13/F17 (second and third review passes): the toggle stays ENABLED
      // while this read is still in flight, so the user can click it
      // before it resolves. Gated on whether a mutation has actually
      // CONFIRMED something (`lastConfirmedCallId > 0`) — NOT merely
      // "was one issued" (autoDownloadCallSeq > 0, F13's original, too
      // strict gate). F17 found the gap that left: if a pre-hydration
      // toggle FAILS, nothing was ever confirmed, so `autoDownloadCallSeq`
      // is already nonzero but `lastConfirmedAutoDownload` is still
      // `undefined` — the failed call's own catch already rolled back to
      // that `undefined` (there was nothing better to roll back to yet),
      // and the old gate then threw away the ONLY real answer this read
      // was ever going to provide, leaving the checkbox permanently wrong
      // (`undefined ?? true` reads as checked forever, even with `false`
      // actually on disk). A mutation that has ALREADY succeeded is still
      // a strictly more current signal than this read, so this still steps
      // aside once one has — the gate on `lastConfirmedCallId` (not
      // `autoDownloadCallSeq`) is exactly that: succeeded-only, not
      // issued-only.
      if (lastConfirmedCallId.current > 0) return
      lastConfirmedAutoDownload.current = v
      setAutoDownloadState(v)
    })
    const unsubscribe = bridge.updates.onState((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge])

  const setAutoDownload = useCallback(
    async (value: boolean) => {
      if (!bridge) return
      const callId = ++autoDownloadCallSeq.current
      setAutoDownloadState(value) // optimistic — a checkbox should feel instant, not wait on an IPC round-trip
      try {
        await bridge.updates.setAutoDownload(value)
        // Record this success as the new "confirmed" truth ONLY if no
        // NEWER call has already recorded one — an older call's success
        // settling after a newer call's must not overwrite what the newer
        // call already confirmed. Unlike the display update below, this is
        // NOT gated on "is this the most recently ISSUED call" (that would
        // wrongly discard a genuine, still-only success from a call whose
        // successor hasn't resolved yet) — it's gated on "is this newer
        // than whatever we've already CONFIRMED", which is exactly what a
        // later failure's rollback needs to stay correct.
        if (callId > lastConfirmedCallId.current) {
          lastConfirmedCallId.current = callId
          lastConfirmedAutoDownload.current = value
        }
        // Only the MOST RECENTLY ISSUED call gets to assert the displayed
        // value on success. If a newer call has already started (and so
        // already set its own optimistic value) by the time this one
        // settles, re-asserting `value` here would stomp that newer call's
        // (still in-flight, still optimistic) display with a stale one.
        if (autoDownloadCallSeq.current === callId) {
          setAutoDownloadState(value)
        }
      } catch (err) {
        // The write failed (permissions, full disk, a failed atomic rename)
        // — the live updater's autoDownload flag never changed either, so
        // the UI must not keep showing the unpersisted value. Roll back and
        // say why, rather than leaving a checkbox that lies about what's
        // actually saved. Skipped entirely when a NEWER call has already
        // superseded this one: that call's own outcome (success or its own
        // failure) is what should be on screen, not this stale one rolling
        // it back over.
        if (autoDownloadCallSeq.current === callId) {
          setAutoDownloadState(lastConfirmedAutoDownload.current)
          notifyAutoDownloadWriteFailed(err)
        }
      }
    },
    [bridge],
  )

  const download = useCallback(async () => {
    if (!bridge) return
    await bridge.updates.download()
  }, [bridge])

  /**
   * F3 (whole-branch review, Important; P2 fix on second pass). The bridge's
   * `checkForUpdates()` now resolves once THIS call's own check has settled
   * (`updater.ts`'s `runCheck()` return value, threaded through IPC
   * `invoke`/`handle`) — so instead of guessing how long a check might take
   * (the original fix's 30s timeout raced electron-updater's own up-to-60s
   * HTTP layer and lost on slow networks), this awaits the real completion
   * signal, then reads the CURRENT state directly. No window to miss,
   * however long the request actually took. "idle" is the one conclusion
   * with nothing else on screen to say the click did anything — every other
   * outcome (available/downloading/ready/error) already has its own visible
   * row in `DesktopUpdateStatusRow`.
   *
   * F8 (whole-branch review, third pass, P2 fix): the P2 fix above closed
   * "no feedback" but opened "WRONG feedback" — `getState()` reading "idle"
   * does NOT mean a check ran and found nothing new. It's also what a
   * PACKAGED build with no publish provider configured shows (F1's guard
   * skips the real check and leaves state exactly where it was), and what
   * unpackaged DEV shows when nothing forces a real check either
   * (`electron-updater`'s own no-op). Toasting "up to date" in either case
   * tells the user their version was verified when nothing was checked —
   * worse than the original silence, because it's a confident lie instead
   * of an absence. `performed` is the bridge's own answer to "did a check
   * actually run" (see `Updater.checkForUpdates()`'s doc comment) and is
   * checked FIRST: only `performed && phase === "idle"` earns the "up to
   * date" toast. `performed === false` says so plainly instead.
   */
  const checkForUpdates = useCallback(() => {
    if (!bridge) return
    void (async () => {
      try {
        const { performed } = await bridge.updates.checkForUpdates()
        if (!performed) {
          toast.info("No update check was performed", {
            id: UPDATE_CHECK_RESULT_TOAST_ID,
            description: "Update checks aren't available in this copy of the app.",
          })
          return
        }
        const s = await bridge.updates.getState()
        if (s.phase === "idle") {
          toast.success("You're up to date", {
            id: UPDATE_CHECK_RESULT_TOAST_ID,
            description: `Running v${bridge.appVersion}`,
          })
        }
      } catch (err) {
        // An IPC-layer failure (the main-process handler itself threw) —
        // nothing to roll back (no optimistic UI here), just don't let this
        // become an unhandled rejection.
        console.error("[editor] checkForUpdates failed:", err)
      }
    })()
  }, [bridge])

  const restartAndInstall = useCallback(() => {
    bridge?.updates.restartAndInstall()
  }, [bridge])

  // Every hook above still ran unconditionally on every render (this is the
  // ONLY early return, and it's after all hook calls) — what changes is
  // just what gets handed back to the caller.
  if (!bridge) return undefined

  return { state, autoDownload, setAutoDownload, download, restartAndInstall, checkForUpdates }
}

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
  /** The running app's version, off the bridge. What "up to date" names. */
  appVersion: string
  state: DesktopUpdateState
  /** `undefined` while the initial `getAutoDownload()` read is in flight. */
  autoDownload: boolean | undefined
  setAutoDownload: (value: boolean) => Promise<void>
  /** Manual download when autoDownload is off. No-op outside phase "available" (enforced main-process side). */
  download: () => Promise<void>
  /**
   * Only valid in phase "ready" (enforced main-process side). Flips
   * `restarting` on for the caller; the app normally quits before the
   * bridge call ever settles. When it does settle with anything other than
   * `"installing"` (shutdown could not be confirmed, or nothing was ready
   * after all), `restarting` goes back off — the main process has already
   * shown its own native error box for the failure.
   */
  restartAndInstall: () => void
  /**
   * True from the moment "Restart to update" was clicked until the app
   * quits, or until the main process reports that nothing is restarting.
   * The check dialog shows its "Restarting to update" view on it, so the
   * seconds between the click and the window closing are not silence (Mo,
   * 2026-09-02: a wait with no visible state read as "it did nothing", and
   * a relaunch mid-install then aborted the install).
   */
  restarting: boolean
  /**
   * On-demand "Check for updates" — same effect as the periodic 4h timer
   * firing once, right now. Fire-and-forget: the click's own outcome lands
   * in `lastCheck` below, and the update's state keeps arriving through
   * `state` as before.
   */
  checkForUpdates: () => void
  /**
   * The most recent on-demand check's own outcome, or `undefined` before
   * the first click. `DesktopUpdateCheckDialog` reads this together with
   * `state`: `state` alone cannot tell "checked, nothing new" from "no
   * check ever ran" (both sit at "idle"), and it cannot say whether the
   * check the user just asked for is still in flight when a background
   * check happens to be running too.
   */
  lastCheck: DesktopUpdateCheckResult | undefined
}

/**
 * What ONE click of "Check for updates" produced, tracked separately from
 * the update state machine.
 *
 * - `checking`: the bridge call is still pending.
 * - `performed`: a real check ran and settled; `state` says what it found
 *   (`idle` means up to date, everything else has its own phase).
 * - `not-performed`: nothing was checked, so `state` says nothing about
 *   this click. A packaged build with no publish provider configured, or
 *   unpackaged dev's own no-op (see the bridge's `checkForUpdates()` doc).
 * - `failed`: the IPC call itself threw. The check may or may not have run;
 *   nothing more is known.
 */
export type DesktopUpdateCheckResult =
  | { status: "checking" }
  | { status: "performed" }
  | { status: "not-performed" }
  | { status: "failed"; error: string }

const IDLE_STATE: DesktopUpdateState = { phase: "idle" }

/** Stable id so a second failed toggle updates the SAME toast in place instead of stacking a new one — matches `resolution-failure-notice.ts`'s toast-id pattern. */
export const AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID = "desktop-auto-download-write-failed"

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
  const [lastCheck, setLastCheck] = useState<DesktopUpdateCheckResult | undefined>(undefined)
  const [restarting, setRestarting] = useState(false)
  /** Same job as `autoDownloadCallSeq`, for the on-demand check: only the newest click's settle may write `lastCheck`. */
  const checkCallSeq = useRef(0)

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
   * The click's own outcome, as state rather than a toast (Mo, 2026-09-02:
   * "we should use a modal and not a toast as this is an explicit action
   * from a user"). The toast it replaces also had nowhere to render on the
   * launcher, which mounts no toast host, so "Check for updates" there did
   * nothing visible at all.
   *
   * The bridge's `checkForUpdates()` resolves once THIS call's own check
   * has settled (`updater.ts`'s `runCheck()` return value, threaded through
   * IPC `invoke`/`handle`), so there is no timeout to guess against
   * electron-updater's own up-to-60s HTTP layer: `checking` holds until the
   * real completion signal, however long it takes.
   *
   * `performed` is checked FIRST (F8): `state` reading "idle" does NOT mean
   * a check ran and found nothing new. It is also what a packaged build
   * with no publish provider configured shows, and what unpackaged dev
   * shows when nothing forces a real check. Reporting "up to date" there
   * would claim a result that was never obtained.
   *
   * Two rapid clicks are two in-flight bridge calls with no guaranteed
   * settle order. Only the most recently issued call may write `lastCheck`
   * once it settles, the same discipline `setAutoDownload` uses above.
   */
  const checkForUpdates = useCallback(() => {
    if (!bridge) return
    const callId = ++checkCallSeq.current
    setLastCheck({ status: "checking" })
    void (async () => {
      let result: DesktopUpdateCheckResult
      try {
        const { performed } = await bridge.updates.checkForUpdates()
        result = performed ? { status: "performed" } : { status: "not-performed" }
      } catch (err) {
        // An IPC-layer failure (the main-process handler itself threw).
        // Nothing to roll back; it becomes a result rather than an
        // unhandled rejection.
        console.error("[editor] checkForUpdates failed:", err)
        result = { status: "failed", error: err instanceof Error ? err.message : String(err) }
      }
      if (checkCallSeq.current === callId) setLastCheck(result)
    })()
  }, [bridge])

  const restartAndInstall = useCallback(() => {
    if (!bridge) return
    setRestarting(true)
    void (async () => {
      try {
        const outcome = await bridge.updates.restartAndInstall()
        if (outcome !== "installing") setRestarting(false)
      } catch (err) {
        // An IPC-layer failure: the main-process handler itself threw.
        // Nothing is restarting, so the dialog must not keep saying it is.
        console.error("[editor] restartAndInstall failed:", err)
        setRestarting(false)
      }
    })()
  }, [bridge])

  // Every hook above still ran unconditionally on every render (this is the
  // ONLY early return, and it's after all hook calls) — what changes is
  // just what gets handed back to the caller.
  if (!bridge) return undefined

  return {
    appVersion: bridge.appVersion,
    state,
    autoDownload,
    setAutoDownload,
    download,
    restartAndInstall,
    restarting,
    checkForUpdates,
    lastCheck,
  }
}

"use client"

/**
 * Desktop-only: subscribes to `window.desdeDesktop.claudeRuntime` and
 * surfaces its state as a toast (`claude-runtime-notice.ts`). A no-op in a
 * plain browser tab, where that global is absent — same gate every other
 * desktop-only affordance uses (see `useDesktopUpdates.ts`'s own doc
 * comment on why the global's presence is the ONLY gate).
 *
 * Mounted alongside `useDesktopUpdates()` in the same two always-rendered
 * places (`EditorSettingsMenu`, `LauncherPage`) — the desktop shell's UI is
 * actually TWO separate page loads (launcher and editor are different
 * origins the window navigates BETWEEN, not a single persistent React
 * tree — see `editor-cli/ui-src/src/main.tsx`'s launcher-vs-editor branch),
 * so both entry points need their own subscription for toast continuity
 * across that navigation.
 *
 * Unlike `useDesktopUpdates`, this hook has no return value consumers need
 * — there is no badge/menu-section UI for this surface (a deliberate,
 * smaller scope than the update feature's: see this work's own
 * verification report). Its entire job is the toast side effect.
 */
import { useEffect, useState } from "react"
import type { DesktopClaudeRuntimeState } from "@/types/desktop-bridge"
import { notifyClaudeRuntimeState } from "./claude-runtime-notice"

/**
 * A `"downloading"` phase shorter than this never surfaces a toast at all —
 * avoids a flash-then-dismiss toast on a fast connection where the ~200MB
 * download completes in a couple of seconds. Long enough that a genuinely
 * slow install (the case the brief calls "a silent 30+ second hang is
 * unacceptable") is never missed; short enough that it doesn't read as a
 * hang itself.
 */
export const DOWNLOADING_TOAST_DELAY_MS = 800

export function useClaudeRuntimeStatus(): void {
  const [bridge] = useState(() =>
    typeof window === "undefined" ? undefined : window.desdeDesktop,
  )

  useEffect(() => {
    if (!bridge) return
    const claudeRuntime = bridge.claudeRuntime
    let cancelled = false
    let downloadingTimer: ReturnType<typeof setTimeout> | undefined

    const clearDownloadingTimer = () => {
      if (downloadingTimer !== undefined) {
        clearTimeout(downloadingTimer)
        downloadingTimer = undefined
      }
    }

    const handle = (state: DesktopClaudeRuntimeState) => {
      if (cancelled) return
      clearDownloadingTimer()
      if (state.phase === "downloading") {
        downloadingTimer = setTimeout(() => {
          if (!cancelled) notifyClaudeRuntimeState(state, claudeRuntime.retry)
        }, DOWNLOADING_TOAST_DELAY_MS)
        return
      }
      notifyClaudeRuntimeState(state, claudeRuntime.retry)
    }

    void claudeRuntime.getState().then(handle)
    const unsubscribe = claudeRuntime.onState(handle)
    return () => {
      cancelled = true
      clearDownloadingTimer()
      unsubscribe()
    }
  }, [bridge])
}

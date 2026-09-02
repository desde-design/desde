"use client"

import { toast } from "sonner"
import type { DesktopClaudeRuntimeState } from "@/types/desktop-bridge"

/**
 * Toast surfacing for the desktop app's on-demand `claude` binary install —
 * see `desktop/claude-runtime-controller.ts` and `tasks/electron-app.md`'s
 * "stop bundling the claude binary, fetch it on first run" work. Same
 * pattern as `resolution-failure-notice.ts`: a pure, stable-id toast
 * dispatch function, kept out of the subscribing hook so it's unit-testable
 * without standing up a real `window.desdeDesktop`.
 *
 * One stable id (`CLAUDE_RUNTIME_TOAST_ID`) across every phase — sonner
 * replaces the existing toast in place rather than stacking a new one,
 * matching the `BannerToasts`/`id: "app-update"` precedent
 * `tasks/electron-app.md` §4 documents for the (structurally identical)
 * update-download toast.
 *
 * Silent on `"checking"`/`"ready"` (a `toast.dismiss` closes whatever
 * loading/error toast might already be showing, but never OPENS a new one)
 * — a first-ever install's completion doesn't need a celebratory toast, and
 * every LATER app session hits `"ready"` on mount with nothing to
 * acknowledge. This is the "the brief said a silent 30+ second hang is
 * unacceptable" requirement being satisfied at the `"downloading"` case
 * specifically, not a blanket "always say something" rule.
 */
export const CLAUDE_RUNTIME_TOAST_ID = "claude-runtime-install"

export const CLAUDE_RUNTIME_DOWNLOADING_TITLE = "Setting up AI chat"
export const CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION =
  "Downloading the Claude Code runtime from Anthropic (about 200MB). This happens once."

export const CLAUDE_RUNTIME_ERROR_TITLE = "Couldn't set up AI chat"
export const CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION =
  "An unknown error occurred while installing the AI chat runtime."

export function notifyClaudeRuntimeState(
  state: DesktopClaudeRuntimeState,
  retry: () => void,
): void {
  switch (state.phase) {
    case "downloading":
      toast.loading(CLAUDE_RUNTIME_DOWNLOADING_TITLE, {
        id: CLAUDE_RUNTIME_TOAST_ID,
        description: CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION,
      })
      return
    case "error":
      toast.error(CLAUDE_RUNTIME_ERROR_TITLE, {
        id: CLAUDE_RUNTIME_TOAST_ID,
        description: state.error?.trim() || CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION,
        action: { label: "Retry", onClick: retry },
      })
      return
    case "checking":
    case "ready":
      toast.dismiss(CLAUDE_RUNTIME_TOAST_ID)
      return
  }
}

/**
 * The desktop shell's `window.desdeDesktop` bridge — the wire contract
 * between `desktop/preload.ts` (which builds an object matching this shape
 * and hands it to `contextBridge.exposeInMainWorld`) and the Editor UI (which
 * reads it as an optional global). Absent entirely in a plain browser tab —
 * every desktop-only affordance (native folder picker, update badge) checks
 * for this global first and falls back to the browser-tab behavior when it
 * is undefined.
 *
 * Lives here, not under `desktop/`, for the same reason `src/types/launcher.ts`
 * does: the direction of dependency is fixed (`desktop/` and `editor-cli/`
 * both import from root `src/`, never the reverse), and this type is read by
 * BOTH `desktop/preload.ts` (type-only — the preload script never imports
 * anything else from `src/`, since bundling the whole UI's dependency graph
 * into the preload script would be pointless) and the Editor UI's
 * `declare global` block (`editor-cli/ui-src/src/main.tsx`).
 *
 * See `tasks/electron-app.md` §3 "Desktop bridge API" — this file is that
 * interface, not a re-derivation of it.
 */

/** What one "Restart to update" click did — see `DesktopBridge.updates.restartAndInstall`. */
export type DesktopRestartOutcome = "installing" | "failed" | "ignored"

export interface DesktopUpdateState {
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "error"
  /** The update's version, once known. */
  version?: string
  /** 0-100, while `phase` is `"downloading"`. */
  progressPercent?: number
  error?: string
}

/**
 * State of the on-demand `claude` binary install — see
 * `desktop/claude-runtime-controller.ts` and `tasks/electron-app.md`'s
 * "stop bundling the claude binary, fetch it on first run" work. No
 * `"idle"` phase (unlike {@link DesktopUpdateState}): unlike update
 * checking, this starts working the moment the app boots, so there is no
 * meaningful "nothing happening yet" state to represent.
 */
export interface DesktopClaudeRuntimeState {
  phase: "checking" | "downloading" | "ready" | "error"
  error?: string
  /** Named cause for an `"error"` phase — lets the UI say WHY (offline, disk full, permissions, registry unreachable, a failed integrity check) rather than just showing the raw message. */
  errorReason?: "offline" | "registry-unreachable" | "disk-full" | "permissions" | "integrity" | "unknown"
}

export interface DesktopBridge {
  appVersion: string
  updates: {
    getState: () => Promise<DesktopUpdateState>
    /** Returns an unsubscribe function. */
    onState: (cb: (state: DesktopUpdateState) => void) => () => void
    /** Manual download when auto-download is off. */
    download: () => Promise<void>
    /**
     * Only valid in phase `"ready"`. Resolves with what the main process
     * did: `"installing"` once the payload child is confirmed down and the
     * native installer has been handed the update (the app quits right
     * after, so this resolution may never be observed); `"failed"` when the
     * child shutdown could not be confirmed (main shows a native error box
     * and the app stays open); `"ignored"` when nothing was ready to
     * install or a quit was already under way.
     */
    restartAndInstall: () => Promise<DesktopRestartOutcome>
    /**
     * On-demand check — the "Check for updates" settings-menu item. Same
     * effect as the periodic 4h timer firing once, right now; the resulting
     * state ALSO arrives via `onState`, same as every other check trigger.
     * Safe to call from any phase.
     *
     * Resolves once THIS call's own check has settled (F3, whole-branch
     * review, P2 fix) — never rejects. A caller that wants to know "did MY
     * click find nothing new" should await this, then read `getState()`,
     * rather than guessing a timeout window: electron-updater's own HTTP
     * layer allows a request up to ~60s.
     *
     * `performed` (F8, whole-branch review, P2 fix) is `false` when nothing
     * was actually checked — a packaged build with no publish provider
     * configured, or the unpackaged-dev no-op. Both leave `getState()` at
     * whatever it already was (typically `"idle"`), indistinguishable by
     * state alone from "checked, nothing new". Check `performed` BEFORE
     * treating an idle result as "up to date" — otherwise no check ever
     * ran, and saying so claims a result that was never obtained.
     */
    checkForUpdates: () => Promise<{ performed: boolean }>
    getAutoDownload: () => Promise<boolean>
    setAutoDownload: (value: boolean) => Promise<void>
  }
  /**
   * The on-demand `claude` binary install — see {@link DesktopClaudeRuntimeState}.
   * Present unconditionally alongside `updates` (both are desktop-only
   * surfaces gated the same way: absent entirely in a plain browser tab).
   */
  claudeRuntime: {
    getState: () => Promise<DesktopClaudeRuntimeState>
    /** Returns an unsubscribe function — same shape as `updates.onState`. */
    onState: (cb: (state: DesktopClaudeRuntimeState) => void) => () => void
    /** Re-triggers the install. Safe to call anytime — a no-op while one is already in flight, and the only way to recover from phase `"error"` without restarting the app. */
    retry: () => void
  }
  /**
   * Native folder chooser — `dialog.showOpenDialog` under the hood, replacing
   * the osascript-shelled, macOS-only picker a browser tab falls back to
   * (`editor-cli/src/server/folder-picker.ts`). Resolves the picked absolute
   * path, or `null` on cancel.
   */
  pickFolder: () => Promise<string | null>
  /**
   * INTERNAL — not a UI affordance. Vouches for a URL as safe to navigate
   * this window to before the UI actually navigates there (`window.location
   * = url`, in `useLauncherApi`'s `openPath`).
   *
   * Why this exists: the desktop shell's `will-navigate` guard
   * (`desktop/main.ts`) only allows navigating to origins it already knows
   * are one of ITS OWN spawned processes — the launcher's own origin is
   * known at boot, but a per-project editor's origin is picked by a FREE
   * PORT the launcher itself binds, which Electron main has no visibility
   * into until the UI's own `/api/launcher/open` response names it. This
   * closes that gap: the UI calls this the moment it learns a new origin
   * from a response IT already trusts (the authenticated launcher API),
   * and the main process adds it to the navigation allowlist before the
   * navigation the UI is about to perform.
   *
   * Returns a Promise the caller MUST await before navigating — an
   * `ipcRenderer.send` (fire-and-forget) let the navigation reach main's
   * `will-navigate` guard before the trust IPC had actually been processed,
   * a real race that intermittently blocked a just-opened editor's own
   * origin and sent it to the external browser instead.
   *
   * A no-op in a browser tab (the property is undefined there) and safe to
   * call unconditionally — `useLauncherApi` does exactly that.
   */
  __trustOrigin?: (url: string) => Promise<void>
}

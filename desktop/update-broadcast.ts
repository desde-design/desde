/**
 * Broadcasts a `DesktopUpdateState` to every live `BrowserWindow` —
 * `main.ts`'s `updater.onState(...)` subscription calls this once per state
 * change.
 *
 * Deliberately a tiny standalone function rather than main.ts registering a
 * PER-WINDOW listener (`ipcMain.on` keyed by window, or a Map the caller has
 * to remember to clean up on `closed`): with a per-window registry, a window
 * closing without its own explicit cleanup either (a) leaves a stale entry
 * pointing at a destroyed `webContents`, which THROWS the next time a
 * broadcast tries to `.send()` on it, or (b) is a second place — beyond the
 * `mainWindow`/`childHandle` bookkeeping `main.ts` already does — that has to
 * remember to unregister on `closed`. Reading `BrowserWindow.getAllWindows()`
 * fresh on every broadcast and filtering `!isDestroyed()` needs no registry
 * and therefore nothing to leak: a closed window simply stops appearing in
 * the list electron itself maintains.
 */

/** The minimal window shape this needs — not `BrowserWindow` itself, so a test double doesn't have to fake the whole class. */
export interface BroadcastTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export function broadcastUpdateState<T>(
  channel: string,
  state: T,
  windows: readonly BroadcastTarget[],
): void {
  for (const win of windows) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, state)
  }
}

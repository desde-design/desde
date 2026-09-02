/**
 * `contextBridge` seam: builds the `window.desdeDesktop` object the
 * Editor UI reads (`src/types/desktop-bridge.ts` is the shared shape; the UI
 * side is `editor-cli/ui-src/src/main.tsx`'s `declare global` block).
 *
 * Runs with `contextIsolation: true` and `sandbox: true` (see `main.ts`) —
 * this script has Node/Electron access, the PAGE it runs alongside does not,
 * and `contextBridge.exposeInMainWorld` is the only bridge between the two.
 * Every exposed method is a thin `ipcRenderer.invoke`/`.on` wrapper; no
 * business logic lives here — that's `main.ts`'s IPC handlers.
 *
 * `appVersion` is the one static (non-async) field on the exposed shape.
 * `app.getVersion()` is a MAIN-process-only API — not reachable from a
 * sandboxed preload script — so it is threaded in via
 * `webPreferences.additionalArguments` (`main.ts`'s `createWindow`) and read
 * back here off `process.argv`, which sandboxed preload scripts DO retain
 * (this is Electron's own documented mechanism for passing static
 * configuration into a sandboxed preload without IPC).
 */

import { contextBridge, ipcRenderer } from "electron"
import type { DesktopBridge, DesktopClaudeRuntimeState, DesktopUpdateState } from "../src/types/desktop-bridge.js"

const APP_VERSION_ARG_PREFIX = "--app-version="

function readAppVersion(argv: readonly string[]): string {
  const arg = argv.find((a) => a.startsWith(APP_VERSION_ARG_PREFIX))
  return arg ? arg.slice(APP_VERSION_ARG_PREFIX.length) : "0.0.0"
}

/** Must match main.ts's own `UPDATE_STATE_CHANNEL` constant — see that file's doc comment on it. */
const UPDATE_STATE_CHANNEL = "desktop:updates:state"
/** Must match main.ts's own `CLAUDE_RUNTIME_STATE_CHANNEL` constant. */
const CLAUDE_RUNTIME_STATE_CHANNEL = "desktop:claude-runtime:state"

/** The slice of `ipcRenderer` this bridge actually calls — narrow on purpose so a test double doesn't need to fake the whole module. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/**
 * Builds the `window.desdeDesktop` object. Pulled out of the module's
 * top-level side effect (`contextBridge.exposeInMainWorld` below) so it's a
 * plain, testable function of its two real inputs (`ipc`, `argv`) — a
 * sandboxed preload script can't be imported directly in a Node test
 * environment (it would try to execute `contextBridge.exposeInMainWorld` at
 * import time against a `contextBridge` that doesn't exist there), but this
 * function has no Electron dependency of its own beyond the narrow
 * `IpcRendererLike` shape above.
 *
 * In particular, this is what `onState`'s subscribe/unsubscribe pairing gets
 * tested against with a fake `ipcRenderer` — see
 * `__tests__/preload.test.ts`'s "two windows" case: two independent
 * `buildDesktopBridge` calls, each against its OWN fake `ipcRenderer`
 * (modeling two separate renderer processes, which is what two real
 * `BrowserWindow`s actually are), proving one window's unsubscribe never
 * touches the other's listener.
 */
export function buildDesktopBridge(ipc: IpcRendererLike, argv: readonly string[]): DesktopBridge {
  return {
    appVersion: readAppVersion(argv),
    updates: {
      getState: () => ipc.invoke("desktop:updates:get-state") as Promise<DesktopUpdateState>,
      onState: (cb) => {
        const listener = (_event: unknown, state: DesktopUpdateState) => cb(state)
        ipc.on(UPDATE_STATE_CHANNEL, listener as (event: unknown, ...args: unknown[]) => void)
        return () => ipc.removeListener(UPDATE_STATE_CHANNEL, listener as (event: unknown, ...args: unknown[]) => void)
      },
      download: () => ipc.invoke("desktop:updates:download") as Promise<void>,
      restartAndInstall: () => {
        ipc.send("desktop:updates:restart-and-install")
      },
      // `invoke`, not `send` (F3, whole-branch review, P2 fix): the caller
      // needs to know precisely when ITS OWN triggered check has settled —
      // see main.ts's handler and updater.ts's `checkForUpdates()`. The
      // resolved `{ performed }` (F8, P2 fix) is forwarded verbatim — it's
      // what the caller needs to tell "checked, nothing new" apart from
      // "nothing was actually checked".
      checkForUpdates: () => ipc.invoke("desktop:updates:check") as Promise<{ performed: boolean }>,
      getAutoDownload: () => ipc.invoke("desktop:settings:get-auto-download") as Promise<boolean>,
      setAutoDownload: (value) => ipc.invoke("desktop:settings:set-auto-download", value) as Promise<void>,
    },
    claudeRuntime: {
      getState: () =>
        ipc.invoke("desktop:claude-runtime:get-state") as Promise<DesktopClaudeRuntimeState>,
      onState: (cb) => {
        const listener = (_event: unknown, state: DesktopClaudeRuntimeState) => cb(state)
        ipc.on(CLAUDE_RUNTIME_STATE_CHANNEL, listener as (event: unknown, ...args: unknown[]) => void)
        return () =>
          ipc.removeListener(CLAUDE_RUNTIME_STATE_CHANNEL, listener as (event: unknown, ...args: unknown[]) => void)
      },
      retry: () => {
        ipc.send("desktop:claude-runtime:retry")
      },
    },
    pickFolder: () => ipc.invoke("desktop:pick-folder") as Promise<string | null>,
    // `invoke`, not `send` — the caller (useLauncherApi's openPath) awaits
    // this before navigating, so the trust IPC is guaranteed processed
    // before the navigation reaches main's will-navigate guard. `send` is
    // fire-and-forget with no such guarantee.
    __trustOrigin: (url) => ipc.invoke("desktop:trust-origin", url) as Promise<void>,
  }
}

contextBridge.exposeInMainWorld("desdeDesktop", buildDesktopBridge(ipcRenderer, process.argv))

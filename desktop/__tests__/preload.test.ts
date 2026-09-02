/**
 * `buildDesktopBridge` — the pure logic behind `preload.ts`'s
 * `contextBridge.exposeInMainWorld` call. Covers `appVersion` parsing off
 * `--app-version=…`, and the "no leaks on window close" contract for
 * `updates.onState` from `tasks/electron-app.md` Phase 4 task 3: modeled
 * with TWO independent fake `ipcRenderer`s (a real `BrowserWindow`'s preload
 * script runs in its OWN renderer process, so "two windows" means two
 * separate `IpcRendererLike` instances, not two listeners sharing one) —
 * one window's unsubscribe must never touch the other's listener.
 */
import { describe, expect, it, vi } from "vitest"
import type { DesktopClaudeRuntimeState, DesktopUpdateState } from "../../src/types/desktop-bridge.js"

// preload.ts's top-level module body calls
// `contextBridge.exposeInMainWorld(...)` as a real side effect (see its own
// doc comment — that's deliberately the ONLY side-effecting line in the
// file). Outside real Electron, `import "electron"` resolves to a plain
// path string, so destructuring `{ contextBridge, ipcRenderer }` from it and
// then calling a method on `contextBridge` would throw at IMPORT TIME,
// before any test in this file gets to run. Stub the module so importing
// preload.ts here only exercises the exported `buildDesktopBridge` function
// this file actually tests, not Electron's real bridge machinery (which
// needs a real renderer process to exist at all).
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

const { buildDesktopBridge } = await import("../preload.js")
type IpcRendererLike = Parameters<typeof buildDesktopBridge>[0]

/** A fake `ipcRenderer` with a real listener registry, so `.on`/`.removeListener`/emit are honest. */
function fakeIpc(): IpcRendererLike & { emit: (channel: string, ...args: unknown[]) => void; listenerCount: (channel: string) => number } {
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
  return {
    invoke: vi.fn(async () => undefined),
    send: vi.fn(),
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return undefined
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener)
      return undefined
    },
    emit: (channel, ...args) => {
      for (const listener of listeners.get(channel) ?? []) listener(undefined, ...args)
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  }
}

describe("buildDesktopBridge — appVersion", () => {
  it("reads --app-version= off argv", () => {
    const bridge = buildDesktopBridge(fakeIpc(), ["node", "main.js", "--app-version=1.2.3"])
    expect(bridge.appVersion).toBe("1.2.3")
  })

  it("falls back to 0.0.0 when the arg is absent", () => {
    const bridge = buildDesktopBridge(fakeIpc(), ["node", "main.js"])
    expect(bridge.appVersion).toBe("0.0.0")
  })
})

describe("buildDesktopBridge — updates.onState subscribe/unsubscribe, two windows", () => {
  it("each window's unsubscribe removes only its OWN listener, never the other window's", () => {
    const windowAIpc = fakeIpc()
    const windowBIpc = fakeIpc()
    const bridgeA = buildDesktopBridge(windowAIpc, [])
    const bridgeB = buildDesktopBridge(windowBIpc, [])

    const statesA: DesktopUpdateState[] = []
    const statesB: DesktopUpdateState[] = []
    const unsubA = bridgeA.updates.onState((s) => statesA.push(s))
    bridgeB.updates.onState((s) => statesB.push(s))

    expect(windowAIpc.listenerCount("desktop:updates:state")).toBe(1)
    expect(windowBIpc.listenerCount("desktop:updates:state")).toBe(1)

    // Window A closes — its effect cleanup calls the unsubscribe it got back.
    unsubA()
    expect(windowAIpc.listenerCount("desktop:updates:state")).toBe(0)
    // Window B's own registry is untouched — these are separate fake
    // ipcRenderers, modeling separate renderer processes.
    expect(windowBIpc.listenerCount("desktop:updates:state")).toBe(1)

    windowAIpc.emit("desktop:updates:state", { phase: "ready", version: "1.0.0" })
    windowBIpc.emit("desktop:updates:state", { phase: "ready", version: "1.0.0" })
    expect(statesA).toEqual([]) // closed window received nothing post-unsubscribe
    expect(statesB).toEqual([{ phase: "ready", version: "1.0.0" }])
  })

  it("two subscriptions in the SAME window each get their own listener, and unsubscribing one leaves the other receiving events", () => {
    const ipc = fakeIpc()
    const bridge = buildDesktopBridge(ipc, [])
    const first: DesktopUpdateState[] = []
    const second: DesktopUpdateState[] = []
    const unsubFirst = bridge.updates.onState((s) => first.push(s))
    bridge.updates.onState((s) => second.push(s))
    expect(ipc.listenerCount("desktop:updates:state")).toBe(2)

    unsubFirst()
    expect(ipc.listenerCount("desktop:updates:state")).toBe(1)

    ipc.emit("desktop:updates:state", { phase: "checking" })
    expect(first).toEqual([])
    expect(second).toEqual([{ phase: "checking" }])
  })

  it("calling the same unsubscribe twice is harmless (removing an already-removed listener is a no-op)", () => {
    const ipc = fakeIpc()
    const bridge = buildDesktopBridge(ipc, [])
    const unsub = bridge.updates.onState(() => {})
    unsub()
    expect(() => unsub()).not.toThrow()
    expect(ipc.listenerCount("desktop:updates:state")).toBe(0)
  })
})

describe("buildDesktopBridge — the rest of the updates API delegates to the right channel", () => {
  it("download() invokes desktop:updates:download", () => {
    const ipc = fakeIpc()
    void buildDesktopBridge(ipc, []).updates.download()
    expect(ipc.invoke).toHaveBeenCalledWith("desktop:updates:download")
  })

  it("restartAndInstall() sends (not invokes) desktop:updates:restart-and-install — fire-and-forget, since the app may quit before a reply", () => {
    const ipc = fakeIpc()
    buildDesktopBridge(ipc, []).updates.restartAndInstall()
    expect(ipc.send).toHaveBeenCalledWith("desktop:updates:restart-and-install")
  })

  it("checkForUpdates() invokes (not sends) desktop:updates:check — the caller awaits its own check settling (F3, P2 fix), not just the pushed state", () => {
    const ipc = fakeIpc()
    void buildDesktopBridge(ipc, []).updates.checkForUpdates()
    expect(ipc.invoke).toHaveBeenCalledWith("desktop:updates:check")
  })

  it("getAutoDownload()/setAutoDownload() hit the settings channels", () => {
    const ipc = fakeIpc()
    const bridge = buildDesktopBridge(ipc, [])
    void bridge.updates.getAutoDownload()
    expect(ipc.invoke).toHaveBeenCalledWith("desktop:settings:get-auto-download")
    void bridge.updates.setAutoDownload(false)
    expect(ipc.invoke).toHaveBeenCalledWith("desktop:settings:set-auto-download", false)
  })
})

describe("buildDesktopBridge — claudeRuntime", () => {
  it("getState() invokes desktop:claude-runtime:get-state", () => {
    const ipc = fakeIpc()
    void buildDesktopBridge(ipc, []).claudeRuntime.getState()
    expect(ipc.invoke).toHaveBeenCalledWith("desktop:claude-runtime:get-state")
  })

  it("retry() sends (not invokes) desktop:claude-runtime:retry — fire-and-forget", () => {
    const ipc = fakeIpc()
    buildDesktopBridge(ipc, []).claudeRuntime.retry()
    expect(ipc.send).toHaveBeenCalledWith("desktop:claude-runtime:retry")
  })

  it("onState subscribe/unsubscribe: each window's unsubscribe removes only its own listener", () => {
    const windowAIpc = fakeIpc()
    const windowBIpc = fakeIpc()
    const bridgeA = buildDesktopBridge(windowAIpc, [])
    const bridgeB = buildDesktopBridge(windowBIpc, [])

    const statesA: DesktopClaudeRuntimeState[] = []
    const statesB: DesktopClaudeRuntimeState[] = []
    const unsubA = bridgeA.claudeRuntime.onState((s) => statesA.push(s))
    bridgeB.claudeRuntime.onState((s) => statesB.push(s))

    expect(windowAIpc.listenerCount("desktop:claude-runtime:state")).toBe(1)
    expect(windowBIpc.listenerCount("desktop:claude-runtime:state")).toBe(1)

    unsubA()
    expect(windowAIpc.listenerCount("desktop:claude-runtime:state")).toBe(0)
    expect(windowBIpc.listenerCount("desktop:claude-runtime:state")).toBe(1)

    windowAIpc.emit("desktop:claude-runtime:state", { phase: "ready" })
    windowBIpc.emit("desktop:claude-runtime:state", { phase: "ready" })
    expect(statesA).toEqual([])
    expect(statesB).toEqual([{ phase: "ready" }])
  })
})

/**
 * `broadcastUpdateState` — the "no leaks on window close" contract from
 * `tasks/electron-app.md` Phase 4 task 3. Modeled with two fake windows (the
 * phase brief's own "test with two windows"): one alive, one already
 * destroyed — a destroyed window must be skipped silently, not throw, and a
 * broadcast must never reach it.
 */
import { describe, expect, it, vi } from "vitest"
import { broadcastUpdateState, type BroadcastTarget } from "../update-broadcast.js"

function fakeWindow(destroyed: boolean): BroadcastTarget & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return {
    isDestroyed: () => destroyed,
    webContents: { send },
    send,
  }
}

describe("broadcastUpdateState", () => {
  it("sends to every live window", () => {
    const a = fakeWindow(false)
    const b = fakeWindow(false)
    const state = { phase: "ready", version: "1.2.0" }

    broadcastUpdateState("desktop:updates:state", state, [a, b])

    expect(a.send).toHaveBeenCalledWith("desktop:updates:state", state)
    expect(b.send).toHaveBeenCalledWith("desktop:updates:state", state)
  })

  it("skips a destroyed window instead of sending to it — the actual 'leak' Electron throws on otherwise", () => {
    const alive = fakeWindow(false)
    const closed = fakeWindow(true)

    // Two windows: one the user closed (destroyed), one still open. The
    // closed one's `webContents.send` must never be called — calling it on
    // a REAL destroyed BrowserWindow throws "Object has been destroyed",
    // which is exactly the failure mode this function exists to avoid
    // (main.ts would have crashed broadcasting to a window that just closed).
    broadcastUpdateState("desktop:updates:state", { phase: "checking" }, [closed, alive])

    expect(closed.send).not.toHaveBeenCalled()
    expect(alive.send).toHaveBeenCalledTimes(1)
  })

  it("an empty window list is a no-op", () => {
    expect(() => broadcastUpdateState("desktop:updates:state", { phase: "idle" }, [])).not.toThrow()
  })

  it("checks isDestroyed() again for each broadcast — a window closed BETWEEN two broadcasts stops receiving the second one", () => {
    let destroyed = false
    const win: BroadcastTarget & { send: ReturnType<typeof vi.fn> } = {
      isDestroyed: () => destroyed,
      webContents: { send: vi.fn() },
      send: vi.fn(),
    }

    broadcastUpdateState("desktop:updates:state", { phase: "checking" }, [win])
    expect(win.webContents.send).toHaveBeenCalledTimes(1)

    destroyed = true
    broadcastUpdateState("desktop:updates:state", { phase: "available", version: "1.0.0" }, [win])
    expect(win.webContents.send).toHaveBeenCalledTimes(1) // still 1 — the second broadcast was skipped
  })
})

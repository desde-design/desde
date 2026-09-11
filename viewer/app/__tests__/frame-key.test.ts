import { describe, expect, it } from "vitest"
import { INITIAL_FRAME_KEY, nextFrameKey, type FrameKeyState } from "../review/frame-key"
import type { ProcessStatus } from "../../server/serve/prototype-processes"

const running = (generation: number): ProcessStatus => ({
  state: "running",
  port: 4321,
  since: "2026-09-11T00:00:00.000Z",
  generation,
})
const starting = (generation: number): ProcessStatus => ({ state: "starting", generation })
const crashed = (generation: number, retryable: boolean): ProcessStatus => ({
  state: "crashed",
  exitCode: 1,
  restarts: 1,
  reason: "The server exited.",
  retryable,
  generation,
})
const stopped: ProcessStatus = { state: "stopped" }

function run(states: ProcessStatus[], from: FrameKeyState = INITIAL_FRAME_KEY): FrameKeyState[] {
  const out: FrameKeyState[] = []
  let current = from
  for (const s of states) {
    current = nextFrameKey(current, "server", s)
    out.push(current)
  }
  return out
}

describe("nextFrameKey", () => {
  it("records the first generation it sees without changing the key", () => {
    expect(nextFrameKey(INITIAL_FRAME_KEY, "server", running(3))).toEqual({ key: "static", generation: 3 })
  })
  it("keeps the key through a cold start the frame itself asked for", () => {
    const keys = run([stopped, starting(1), running(1)]).map((s) => s.key)
    expect(keys).toEqual(["static", "static", "static"])
  })
  it("keeps the key when the idle reaper stops the child (a remount would restart it)", () => {
    const keys = run([running(2), stopped, stopped]).map((s) => s.key)
    expect(keys).toEqual(["static", "static", "static"])
  })
  it("changes the key once for a retryable crash and the restart that follows", () => {
    const keys = run([running(1), crashed(1, true), starting(2), running(2)]).map((s) => s.key)
    expect(keys).toEqual(["static", 2, 2, 2])
  })
  it("keeps the key for a crash past the budget (the panel shows instead)", () => {
    const keys = run([running(1), crashed(1, false)]).map((s) => s.key)
    expect(keys).toEqual(["static", "static"])
  })
  it("changes the key when another tab restarted the child under a newer generation", () => {
    const keys = run([running(1), running(2)]).map((s) => s.key)
    expect(keys).toEqual(["static", 2])
  })
  it("never changes for a static deployment or a body with no generation", () => {
    expect(nextFrameKey(INITIAL_FRAME_KEY, "static", running(9))).toBe(INITIAL_FRAME_KEY)
    expect(nextFrameKey(INITIAL_FRAME_KEY, "server", undefined)).toBe(INITIAL_FRAME_KEY)
  })
})

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

function run(
  states: ProcessStatus[],
  from: FrameKeyState = INITIAL_FRAME_KEY,
  deploymentId?: string,
): FrameKeyState[] {
  const out: FrameKeyState[] = []
  let current = from
  for (const s of states) {
    current = nextFrameKey(current, "server", s, deploymentId)
    out.push(current)
  }
  return out
}

describe("nextFrameKey", () => {
  it("records the first generation it sees without changing the key", () => {
    expect(nextFrameKey(INITIAL_FRAME_KEY, "server", running(3))).toEqual({
      key: "static",
      generation: 3,
      deployment: null,
    })
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

/**
 * A rebuild can leave the iframe's URL exactly as it was. A static prototype
 * is served from a path that never mentions the deployment, a subdomain is one
 * string for every build, and two server builds both start at generation 1. In
 * all three the generation rules above see nothing to act on, React keeps the
 * same DOM node through the page's `router.refresh()`, and the browser never
 * asks for the new build at all.
 */
describe("nextFrameKey — following the deployment", () => {
  const followingDeploymentOne: FrameKeyState = { key: "static", generation: 1, deployment: "dep-1" }

  it("records the first deployment it sees without changing the key", () => {
    expect(nextFrameKey(INITIAL_FRAME_KEY, "server", running(1), "dep-1")).toEqual(followingDeploymentOne)
  })

  it("changes the key when a new deployment reports the same generation", () => {
    expect(nextFrameKey(followingDeploymentOne, "server", running(1), "dep-2")).toEqual({
      key: "dep-2#1",
      generation: 1,
      deployment: "dep-2",
    })
  })

  it("keeps the new deployment's key for every later body of that deployment", () => {
    const changed = nextFrameKey(followingDeploymentOne, "server", running(1), "dep-2")
    expect(nextFrameKey(changed, "server", running(1), "dep-2")).toBe(changed)
    expect(nextFrameKey(changed, "server", starting(1), "dep-2")).toBe(changed)
  })

  it("keys a static deployment on its id alone, so a static rebuild remounts once", () => {
    const staticOne: FrameKeyState = { key: "static", generation: null, deployment: "dep-1" }
    const rebuilt = nextFrameKey(staticOne, "static", undefined, "dep-2")
    expect(rebuilt).toEqual({ key: "dep-2#static", generation: null, deployment: "dep-2" })
    expect(nextFrameKey(rebuilt, "static", undefined, "dep-2")).toBe(rebuilt)
  })

  /**
   * The followed generation belongs to the OLD child. Carrying it across would
   * make the new deployment's own generations look stale, and a later restart
   * under it would not remount at all.
   */
  it("resets the followed generation to the new deployment's own", () => {
    const late: FrameKeyState = { key: 5, generation: 5, deployment: "dep-1" }
    const moved = nextFrameKey(late, "server", running(1), "dep-2")
    expect(moved).toEqual({ key: "dep-2#1", generation: 1, deployment: "dep-2" })
    expect(nextFrameKey(moved, "server", running(2), "dep-2").key).toBe(2)
  })

  it("keeps the generation rules inside one deployment", () => {
    const keys = run([running(1), crashed(1, true), starting(2), running(2)], INITIAL_FRAME_KEY, "dep-1").map(
      (s) => s.key,
    )
    expect(keys).toEqual(["static", 2, 2, 2])
  })

  it("ignores a body that names no deployment at all", () => {
    expect(nextFrameKey(followingDeploymentOne, "server", running(1))).toBe(followingDeploymentOne)
  })
})

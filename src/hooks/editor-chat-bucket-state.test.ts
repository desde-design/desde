import { describe, expect, it } from "vitest"

import {
  appendPendingSteer,
  beginSweep,
  carryBucketState,
  createBucketKeyedState,
  endSweep,
  isSweeping,
  type PendingSteer,
} from "./editor-chat-bucket-state"

function steer(id: string, text: string): PendingSteer {
  return { id, text, rendered: true, state: "in-flight" }
}

describe("carryBucketState", () => {
  it("moves every field, so nothing is stranded under the old key", () => {
    const state = createBucketKeyedState()
    const controller = new AbortController()
    state.aborts.set("solo", controller)
    appendPendingSteer(state.pendingSteers, "solo", steer("a", "hello"))
    state.lastCloseMode.set("solo", "reconciled")
    state.serverSessionId.set("solo", "s1")
    state.steerSplit.add("solo")
    const sweep = beginSweep(state, "solo")

    carryBucketState(state, "solo", "s1")

    expect(state.aborts.get("s1")).toBe(controller)
    expect(state.aborts.has("solo")).toBe(false)
    expect(state.pendingSteers.get("s1")?.map((e) => e.text)).toEqual(["hello"])
    expect(state.pendingSteers.has("solo")).toBe(false)
    expect(state.lastCloseMode.get("s1")).toBe("reconciled")
    expect(state.lastCloseMode.has("solo")).toBe(false)
    expect(state.serverSessionId.get("s1")).toBe("s1")
    expect(state.steerSplit.has("s1")).toBe(true)
    expect(state.steerSplit.has("solo")).toBe(false)
    // The sweep followed the bucket rather than being left marking the old one.
    expect(sweep.bucketId).toBe("s1")
    expect(isSweeping(state, "s1")).toBe(true)
    expect(isSweeping(state, "solo")).toBe(false)
  })

  it("releases the key the sweep now holds, not the one it started on", () => {
    // The failure this pins: releasing the ORIGINAL key would leave the new one
    // marked forever, and a permanently marked bucket can never be swept again
    // — every steer filed under it after that is lost in silence.
    const state = createBucketKeyedState()
    const sweep = beginSweep(state, "solo")
    carryBucketState(state, "solo", "s1")
    endSweep(state, sweep)
    expect(isSweeping(state, "s1")).toBe(false)
    expect(state.sweeps.size).toBe(0)
  })

  it("appends carried steers after any already filed under the destination", () => {
    const state = createBucketKeyedState()
    appendPendingSteer(state.pendingSteers, "s1", steer("a", "already there"))
    appendPendingSteer(state.pendingSteers, "solo", steer("b", "carried"))

    carryBucketState(state, "solo", "s1")

    expect(state.pendingSteers.get("s1")?.map((e) => e.text)).toEqual([
      "already there",
      "carried",
    ])
  })

  it("aborts a submit already running on the destination bucket", () => {
    const state = createBucketKeyedState()
    const carried = new AbortController()
    const onDestination = new AbortController()
    state.aborts.set("solo", carried)
    state.aborts.set("s1", onDestination)

    carryBucketState(state, "solo", "s1")

    expect(onDestination.signal.aborted).toBe(true)
    expect(state.aborts.get("s1")).toBe(carried)
  })

  it("is a no-op when the key does not change", () => {
    const state = createBucketKeyedState()
    const controller = new AbortController()
    state.aborts.set("s1", controller)

    carryBucketState(state, "s1", "s1")

    expect(controller.signal.aborted).toBe(false)
    expect(state.aborts.get("s1")).toBe(controller)
  })
})

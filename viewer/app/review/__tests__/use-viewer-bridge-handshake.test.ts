// @vitest-environment jsdom

/**
 * The BRIDGE_READY handshake race, and the one message that closes it.
 *
 * MEASURED against the live viewer (2026-08-20, bridge
 * `2026-08-17b-iteration-scope-widen`, demo project on `/review/demo`): the
 * review page's `<iframe>` is part of the SERVER-rendered HTML, so the
 * browser starts fetching `/p/{slug}/` while the document is still parsing.
 * The bridge's IIFE runs at the end of that document's body and fires its
 * one-shot `BRIDGE_READY` at **+62ms**. `useViewerBridge` attaches its
 * `message` listener from a React effect, which cannot run until the shell
 * bundle has loaded and hydrated — **+600ms and later** in dev.
 *
 * `BRIDGE_READY` is emitted exactly once and postMessage has no replay, so
 * the shell never saw it: `bridgeReadyEpoch` stayed 0 forever, and every
 * outbound message in `review-shell.tsx` is gated on it (`if
 * (bridgeReadyEpoch === 0) return`). The visible symptom was "Add comment"
 * arming its button — pure shell state — while the bridge was never told to
 * enter placement mode, so clicking the prototype did nothing.
 *
 * The sandbox was NOT the cause and was ruled out by control: with
 * `allow-scripts allow-forms` (opaque origin) the bridge's `BRIDGE_READY`
 * still reached the top window at +62ms. Both origin gates hold across that
 * boundary exactly as they are documented to.
 *
 * The fix is the same one the Editor already ships
 * (`src/editor/adapters/bridge/index.ts` → `waitForBridgeReady`): once the
 * listener is attached, ask the possibly-already-loaded bridge to announce
 * itself again. `PING` is a non-navigating echo — `src/bridge/comment-bridge.ts`
 * answers it with a fresh `BRIDGE_READY` and does nothing else.
 *
 * One `PING` is sufficient, and that is worth stating because a retry loop
 * looks safer than it is. There are only three orderings, and the pair
 * covers all of them:
 *
 * | Bridge boots… | Caught by |
 * | --- | --- |
 * | before the listener attaches | the `PING` reply |
 * | after the listener attaches | the native `BRIDGE_READY` |
 * | after the `PING` but with the listener already attached | the native `BRIDGE_READY` |
 *
 * The only way to miss `BRIDGE_READY` is for it to fire before the listener
 * exists — and in exactly that case the bridge is fully booted, so the
 * `PING` that follows the attach always lands.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useViewerBridge } from "../use-viewer-bridge"
import { BRIDGE_READY, frameRef, LOOPBACK_EMBED, makeFakeFrame } from "./fake-bridge-frame"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const bridgeReady = BRIDGE_READY

describe("useViewerBridge — BRIDGE_READY handshake", () => {
  it("asks an already-loaded bridge to re-announce, by posting PING on mount", () => {
    const frame = makeFakeFrame()
    renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))

    expect(frame.posted.map((m) => m.type)).toContain("PING")
  })

  it("reaches bridgeReadyEpoch > 0 when the bridge only answers the PING", () => {
    const frame = makeFakeFrame()
    // The live ordering: the bridge fired its native BRIDGE_READY long before
    // this hook existed, so nothing arrives unless the shell asks.
    const { result } = renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))

    expect(result.current.bridgeReadyEpoch).toBe(0)

    act(() => {
      for (const message of frame.posted) {
        if (message.type === "PING") frame.emit(bridgeReady)
      }
    })

    expect(result.current.bridgeReadyEpoch).toBeGreaterThan(0)
  })

  it("posts the PING only after the listener is attached, never before", () => {
    // The whole point of the message is to be answerable. A PING sent before
    // `addEventListener` would be a no-op with a passing shape test, so the
    // ordering is asserted directly rather than assumed from source order.
    const order: string[] = []
    // Bound BEFORE the spy replaces it — jsdom's `addEventListener` rejects a
    // call whose `this` is not the EventTarget it was taken from, so
    // `EventTarget.prototype.addEventListener.call(window, …)` throws.
    const realAdd = window.addEventListener.bind(window)
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(((type: string, ...rest: unknown[]) => {
        if (type === "message") order.push("listen")
        return realAdd(type as never, ...(rest as [never]))
      }) as typeof window.addEventListener)

    const frame = makeFakeFrame()
    frame.contentWindow.postMessage = (m: unknown) => {
      if ((m as { type?: string }).type === "PING") order.push("ping")
    }
    renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))
    addSpy.mockRestore()

    expect(order).toContain("ping")
    expect(order.indexOf("listen")).toBeLessThan(order.indexOf("ping"))
  })

  it("still catches a bridge that boots LATER, with no PING answer at all", () => {
    // The other ordering: a slow prototype whose bridge announces itself
    // after hydration. Nothing answers the PING; the native BRIDGE_READY
    // must still be picked up.
    const frame = makeFakeFrame()
    const { result } = renderHook(() => useViewerBridge(frameRef(frame), LOOPBACK_EMBED))

    act(() => {
      frame.emit(bridgeReady)
    })

    expect(result.current.bridgeReadyEpoch).toBeGreaterThan(0)
  })
})

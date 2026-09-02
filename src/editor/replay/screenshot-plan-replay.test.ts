import { describe, expect, it, vi } from "vitest"
import type { ScreenshotPlan } from "../core/screenshot-plan"
import { buildRouteEnumerationPlan } from "../core/screenshot-plan-build"
import { runScreenshotPlanReplay } from "./screenshot-plan-replay"

const plan = (): ScreenshotPlan => ({
  id: "p1",
  createdAt: "2026-06-12T00:00:00.000Z",
  ...buildRouteEnumerationPlan({
    name: "All screens",
    baseUrl: "http://localhost:5173",
    routes: [{ path: "/" }, { path: "/about" }],
  }),
})

const okNavigate = vi.fn(async () => ({ ok: true }))
const shot = (n: number) =>
  ({ dataUrl: `data:image/png;base64,shot-${n}`, width: 100, height: 80 })

describe("runScreenshotPlanReplay", () => {
  it("navigates then captures per route, keyed by capture step index", async () => {
    let n = 0
    const navigate = vi.fn(async () => ({ ok: true }))
    const capture = vi.fn(async () => shot(n++))
    const res = await runScreenshotPlanReplay(plan(), { navigate, capture })

    expect(navigate).toHaveBeenCalledTimes(2)
    expect(navigate).toHaveBeenNthCalledWith(1, "/", expect.anything())
    expect(navigate).toHaveBeenNthCalledWith(2, "/about", expect.anything())
    expect(capture).toHaveBeenCalledTimes(2)
    // capture steps are plan indices 1 and 3
    expect(res.screenshots.map((s) => s.stepIndex)).toEqual([1, 3])
    expect(res.screenshots[0].dataUrl).toBe("data:image/png;base64,shot-0")
    expect(res.errors).toEqual([])
    expect(res.aborted).toBe(false)
  })

  it("forwards each capture step's spec (selector scope) to the capture fn", async () => {
    const selectorPlan: ScreenshotPlan = {
      id: "p2",
      name: "sel",
      baseUrl: "http://localhost:5173",
      source: "prompt",
      createdAt: "2026-06-12T00:00:00.000Z",
      steps: [
        { intent: "go", kind: "navigate", route: "/" },
        {
          intent: "snap the card",
          kind: "capture",
          capture: { scope: "selector", selector: "#card", label: "card" },
        },
      ],
    }
    const capture = vi.fn(async () => shot(0))
    await runScreenshotPlanReplay(selectorPlan, { navigate: okNavigate, capture })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(
      { scope: "selector", selector: "#card", label: "card" },
      expect.anything(),
    )
  })

  it("skips the capture when the preceding navigation fails", async () => {
    const navigate = vi.fn(async (route: string) =>
      route === "/about" ? { ok: false, error: "boom" } : { ok: true },
    )
    const capture = vi.fn(async () => shot(0))
    const res = await runScreenshotPlanReplay(plan(), { navigate, capture })

    // Only the first route captured; the second navigate failed → no capture.
    expect(capture).toHaveBeenCalledTimes(1)
    expect(res.screenshots.map((s) => s.stepIndex)).toEqual([1])
    expect(res.errors.some((e) => /boom/.test(e.message))).toBe(true)
    expect(res.errors.some((e) => /skipped capture/.test(e.message))).toBe(true)
  })

  it("records an error when capture returns null", async () => {
    const capture = vi.fn(async () => null)
    const res = await runScreenshotPlanReplay(plan(), {
      navigate: okNavigate,
      capture,
    })
    expect(res.screenshots).toEqual([])
    expect(res.errors.filter((e) => /capture failed/.test(e.message))).toHaveLength(2)
  })

  it("reports progress per capture step", async () => {
    const onProgress = vi.fn()
    await runScreenshotPlanReplay(plan(), {
      navigate: okNavigate,
      capture: async () => shot(0),
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2)
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2)
  })

  it("aborts cleanly before processing the next step", async () => {
    const controller = new AbortController()
    const navigate = vi.fn(async () => {
      controller.abort()
      return { ok: true }
    })
    const capture = vi.fn(async () => shot(0))
    const res = await runScreenshotPlanReplay(plan(), {
      navigate,
      capture,
      signal: controller.signal,
    })
    expect(res.aborted).toBe(true)
    // Aborted after the first navigate, before its capture.
    expect(capture).not.toHaveBeenCalled()
  })

  const interactPlan = (): ScreenshotPlan => ({
    id: "p2",
    name: "x",
    baseUrl: "u",
    source: "prompt",
    createdAt: "t",
    steps: [
      { intent: "go", kind: "navigate", route: "/" },
      {
        intent: "click create",
        kind: "interact",
        action: "click",
        target: { description: "the Create button", role: "button", name: "Create" },
      },
      { intent: "snap", kind: "capture", capture: { scope: "viewport", label: "x" } },
    ],
  })

  it("errors + skips the capture when an interact step has no resolver injected", async () => {
    const res = await runScreenshotPlanReplay(interactPlan(), {
      navigate: okNavigate,
      capture: async () => shot(0),
    })
    expect(res.errors.some((e) => /resolver/.test(e.message))).toBe(true)
    // capture after an un-performed interaction is unsafe → skipped.
    expect(res.screenshots).toEqual([])
  })

  it("performs the interaction then captures when the resolver succeeds", async () => {
    const interact = vi.fn(async () => ({ ok: true, resolvedSelector: "button.create" }))
    const res = await runScreenshotPlanReplay(interactPlan(), {
      navigate: okNavigate,
      capture: async () => shot(7),
      interact,
    })
    expect(interact).toHaveBeenCalledTimes(1)
    expect(res.screenshots.map((s) => s.stepIndex)).toEqual([2])
    expect(res.needsHeal).toBeUndefined()
    expect(res.errors).toEqual([])
  })

  it("stops + flags needsHeal when the interact target misses", async () => {
    const interact = vi.fn(async () => ({ ok: false, needsHeal: true }))
    const capture = vi.fn(async () => shot(0))
    const res = await runScreenshotPlanReplay(interactPlan(), {
      navigate: okNavigate,
      capture,
      interact,
    })
    expect(res.needsHeal).toEqual({ stepIndex: 1, intent: "click create" })
    // stopped before the capture.
    expect(capture).not.toHaveBeenCalled()
    expect(res.screenshots).toEqual([])
  })

  it("stops + records an error on a non-miss interaction failure", async () => {
    const interact = vi.fn(async () => ({ ok: false, error: "click threw" }))
    const capture = vi.fn(async () => shot(0))
    const res = await runScreenshotPlanReplay(interactPlan(), {
      navigate: okNavigate,
      capture,
      interact,
    })
    expect(res.needsHeal).toBeUndefined()
    expect(res.errors.some((e) => /click threw/.test(e.message))).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })
})

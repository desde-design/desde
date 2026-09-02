import { describe, expect, it } from "vitest"
import type { FlowScreenshot } from "@/types/bridge"
import type { ScreenshotPlan } from "@/editor/core/screenshot-plan"
import { buildScreenshotPlanCanvas, offsetGraph, screenshotPlanCanvasName } from "./canvas-screenshot-plan"

const plan: ScreenshotPlan = {
  id: "p1",
  name: "Create model flow",
  baseUrl: "http://localhost:5173",
  source: "prompt",
  prompt: "go create a model",
  createdAt: "2026-06-12T00:00:00.000Z",
  steps: [
    { intent: "go to models", kind: "navigate", route: "/models" },
    { intent: "snapshot list", kind: "capture", capture: { scope: "viewport", label: "Models list" } }, // step 1
    { intent: "click Create model", kind: "interact", action: "click", target: { description: "Create model button", role: "button", name: "Create model" } },
    { intent: "snapshot form", kind: "capture", capture: { scope: "viewport", label: "Create form" } }, // step 3
  ],
}

const shots: FlowScreenshot[] = [
  { stepIndex: 1, dataUrl: "data:image/png;base64,a", width: 1280, height: 800 },
  { stepIndex: 3, dataUrl: "data:image/png;base64,b", width: 1280, height: 800 },
]

const now = () => "2026-06-12T00:00:00.000Z"

describe("buildScreenshotPlanCanvas", () => {
  it("creates one frame per captured screen with its screenshot", () => {
    const { frames } = buildScreenshotPlanCanvas("cv1", plan, shots, now)
    expect(frames).toHaveLength(2)
    expect(frames.map((f) => f.label)).toEqual(["Models list", "Create form"])
    expect(frames[0].screenshot?.dataUrl).toBe("data:image/png;base64,a")
    expect(frames[1].screenshot?.dataUrl).toBe("data:image/png;base64,b")
    expect(frames[0].canvasId).toBe("cv1")
    expect(frames[0].capturedUrl).toBe("/models")
  })

  it("auto-generates sequential edges labelled with the transition between screens", () => {
    const { frames, edges } = buildScreenshotPlanCanvas("cv1", plan, shots, now)
    expect(edges).toHaveLength(1)
    expect(edges[0].sourceFrameId).toBe(frames[0].id)
    expect(edges[0].targetFrameId).toBe(frames[1].id)
    // The interact between the two captures becomes the arrow label.
    expect(edges[0].label).toBe("click Create model")
  })

  it("lays frames out left-to-right (dagre), not stacked at 0,0", () => {
    const { frames } = buildScreenshotPlanCanvas("cv1", plan, shots, now)
    expect(frames[1].layout.x).toBeGreaterThan(frames[0].layout.x)
  })

  it("skips capture steps that produced no screenshot (no blank frames)", () => {
    // Only the first capture has a screenshot; the second (step 3) is missing.
    const { frames, edges } = buildScreenshotPlanCanvas("cv1", plan, [shots[0]], now)
    expect(frames).toHaveLength(1)
    expect(frames[0].label).toBe("Models list")
    expect(frames[0].screenshot?.dataUrl).toBe("data:image/png;base64,a")
    // No second frame ⇒ no dangling edge.
    expect(edges).toHaveLength(0)
  })

  it("carries transitions forward across a skipped (no-screenshot) capture", () => {
    // Drop the first capture's screenshot so frame 0 is skipped; the second
    // frame's incoming edge label must still include the earlier transition.
    const { frames, edges } = buildScreenshotPlanCanvas("cv1", plan, [shots[1]], now)
    expect(frames).toHaveLength(1)
    expect(frames[0].label).toBe("Create form")
    // Only one frame ⇒ no edges, but its captured route reflects the live nav.
    expect(edges).toHaveLength(0)
    expect(frames[0].capturedUrl).toBe("/models")
  })

  it("offsetGraph shifts the whole graph to a new top-left", () => {
    const graph = buildScreenshotPlanCanvas("cv1", plan, shots, now)
    offsetGraph(graph, 2000, 500)
    const minX = Math.min(...graph.frames.map((f) => f.layout.x))
    const minY = Math.min(...graph.frames.map((f) => f.layout.y))
    expect(minX).toBe(2000)
    expect(minY).toBe(500)
  })

  it("names the canvas from the plan name (falling back to prompt)", () => {
    expect(screenshotPlanCanvasName(plan)).toBe("Create model flow")
    expect(screenshotPlanCanvasName({ ...plan, name: "" })).toBe("go create a model")
  })
})

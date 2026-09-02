/**
 * Convert a generated SCREENSHOT PLAN (navigate → interact → capture, with its
 * captured screenshots) into canvas frames + connecting edges. This is how
 * LLM-generated (and route-enumerated) screenshots land on the canvas board as
 * frames the user can rearrange, relabel, and re-wire. Edges are auto-generated
 * in flow order; an edge's label is the transition (the navigate/interact steps
 * between the two captured screens), so the arrows read like the flow.
 *
 * Pure: no I/O. The `useLocalCanvases` hook persists the returned frames/edges
 * via the CanvasStore (creating a new canvas, or appending to an existing one).
 */

import dagre from "@dagrejs/dagre"
import type { FlowScreenshot } from "@/types/bridge"
import type { ScreenshotPlan } from "@/editor/core/screenshot-plan"
import type { CanvasStore } from "@/editor/core"
import type { CanvasEdge, CanvasFrame, FrameLayout } from "@/types/canvas"

const NODE_WIDTH = 960
const DEFAULT_NODE_HEIGHT = 600

export interface BuiltCanvasGraph {
  frames: CanvasFrame[]
  edges: CanvasEdge[]
}

/**
 * Build dagre-laid-out frames + edges for a screenshot plan. One frame per
 * `capture` step that has a screenshot; an edge between consecutive frames
 * labelled with the navigate/interact steps that happened between them.
 *
 * `screenshots` are keyed by the capture step's index in `plan.steps` (the
 * `FlowScreenshot.stepIndex` convention the replay engine + store use).
 */
export function buildScreenshotPlanCanvas(
  canvasId: string,
  plan: ScreenshotPlan,
  screenshots: FlowScreenshot[],
  now: () => string = () => new Date().toISOString(),
): BuiltCanvasGraph {
  const createdAt = now()
  const shotByStepIndex = new Map(screenshots.map((s) => [s.stepIndex, s]))

  const frames: CanvasFrame[] = []
  // Edge label INTO each frame = the transitions accumulated since the prior
  // capture (e.g. "click Create model" / "go to /settings").
  const edgeLabelByFrameId = new Map<string, string>()
  let transitions: string[] = []
  let currentRoute = plan.baseUrl

  plan.steps.forEach((step, i) => {
    if (step.kind === "navigate") {
      if (step.route) currentRoute = step.route
      transitions.push(step.intent)
      return
    }
    if (step.kind === "interact") {
      transitions.push(step.intent)
      return
    }
    // capture
    const shot = shotByStepIndex.get(i)
    if (!shot) {
      // This capture step produced no screenshot (e.g. replay stopped or timed
      // out before reaching it). Skip it rather than materialize a blank frame
      // with a misleading edge — but KEEP the accumulated transitions so the
      // next captured frame's edge label still spans the gap.
      return
    }
    const id = crypto.randomUUID()
    const prevId = frames.length > 0 ? frames[frames.length - 1].id : null
    frames.push({
      id,
      canvasId,
      label: step.capture?.label || currentRoute,
      capturedUrl: currentRoute,
      baseUrl: plan.baseUrl,
      layout: { x: 0, y: 0, width: NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      crop: null,
      screenshot: { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, capturedAt: createdAt },
      parentFrameId: prevId,
      createdAt,
      updatedAt: createdAt,
    })
    edgeLabelByFrameId.set(id, transitions.join(" → "))
    transitions = []
  })

  const edges: CanvasEdge[] = []
  for (let i = 1; i < frames.length; i++) {
    const target = frames[i]
    const label = edgeLabelByFrameId.get(target.id) || null
    edges.push({
      id: crypto.randomUUID(),
      canvasId,
      sourceFrameId: frames[i - 1].id,
      targetFrameId: target.id,
      label,
      createdAt,
    })
  }

  applyDagreLayout(frames, edges)
  return { frames, edges }
}

/** A reasonable canvas name from a plan (its name, else its prompt/route). */
export function screenshotPlanCanvasName(plan: ScreenshotPlan): string {
  return plan.name?.trim() || plan.prompt?.trim() || "Screenshot flow"
}

/**
 * Build the plan's frames + edges and PERSIST them to `canvasId` via the store.
 * If the canvas already has frames, the new flow is offset below them (so an
 * append doesn't overlap existing content). Returns the created counts. Shared
 * by the `addScreenshotPlanToCanvas` hook and the smoke harness so both exercise
 * the same persistence path.
 */
export async function persistScreenshotPlanToCanvas(
  store: CanvasStore,
  canvasId: string,
  plan: ScreenshotPlan,
  screenshots: FlowScreenshot[],
): Promise<{ frameCount: number; edgeCount: number }> {
  const graph = buildScreenshotPlanCanvas(canvasId, plan, screenshots)

  // Append below whatever is already on the canvas.
  const existing = await store.listFrames(canvasId)
  if (existing.length > 0) {
    const maxBottom = Math.max(
      ...existing.map((f) => f.layout.y + f.layout.height),
    )
    offsetGraph(graph, 0, maxBottom + 120)
  }

  // Frames serially → local→server id map → wire edges (write order matters).
  const idMap = new Map<string, string>()
  for (const frame of graph.frames) {
    const serverFrame = await store.createFrame(canvasId, {
      label: frame.label,
      capturedUrl: frame.capturedUrl,
      baseUrl: frame.baseUrl,
      layout: frame.layout,
      crop: frame.crop,
      screenshot: frame.screenshot,
      parentFrameId: null,
    })
    idMap.set(frame.id, serverFrame.id)
  }
  for (const edge of graph.edges) {
    const source = idMap.get(edge.sourceFrameId)
    const target = idMap.get(edge.targetFrameId)
    if (!source || !target) continue
    await store.createEdge(canvasId, {
      sourceFrameId: source,
      targetFrameId: target,
      label: edge.label ?? null,
    })
  }
  return { frameCount: graph.frames.length, edgeCount: graph.edges.length }
}

function applyDagreLayout(frames: CanvasFrame[], edges: CanvasEdge[]): void {
  if (frames.length === 0) return
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 80, ranksep: 120 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const frame of frames) {
    g.setNode(frame.id, { width: NODE_WIDTH, height: computeNodeHeight(frame.screenshot) })
  }
  for (const edge of edges) {
    g.setEdge(edge.sourceFrameId, edge.targetFrameId)
  }
  dagre.layout(g)

  for (const frame of frames) {
    const pos = g.node(frame.id)
    const height = computeNodeHeight(frame.screenshot)
    const layout: FrameLayout = {
      x: pos.x - NODE_WIDTH / 2,
      y: pos.y - height / 2,
      width: NODE_WIDTH,
      height,
    }
    frame.layout = layout
  }
}

/**
 * Shift an already-laid-out graph so its top-left sits at `(offsetX, offsetY)`
 * — used when APPENDING a generated flow to a canvas that already has frames,
 * so the new flow doesn't land on top of existing ones.
 */
export function offsetGraph(graph: BuiltCanvasGraph, offsetX: number, offsetY: number): void {
  if (graph.frames.length === 0) return
  let minX = Infinity
  let minY = Infinity
  for (const f of graph.frames) {
    if (f.layout.x < minX) minX = f.layout.x
    if (f.layout.y < minY) minY = f.layout.y
  }
  const dx = offsetX - minX
  const dy = offsetY - minY
  for (const f of graph.frames) {
    f.layout = { ...f.layout, x: f.layout.x + dx, y: f.layout.y + dy }
  }
}

function computeNodeHeight(shot: CanvasFrame["screenshot"]): number {
  if (!shot || shot.width === 0) return DEFAULT_NODE_HEIGHT
  return Math.round(NODE_WIDTH * (shot.height / shot.width))
}

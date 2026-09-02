import type {
  Canvas,
  CanvasFrame,
  CanvasEdge,
  CanvasAnnotation,
  CanvasAnnotationKind,
  FrameCrop,
  FrameLayout,
  FrameScreenshot,
  TextStyle,
} from "../../../types/canvas"
import type { CommentAuthor } from "../../../types/bridge"

/**
 * Storage interface for the Canvas workspace.
 *
 * Each canvas owns four collections: the canvas record itself,
 * frames, edges, and annotations. The interface treats them as
 * separate operations so impls can choose their own persistence
 * granularity (one file per kind, one file per canvas, Firestore
 * subcollections, etc.).
 *
 * Shape fidelity: the input + return types match the Desde
 * canvas types verbatim (see `src/types/canvas.ts`) so the Phase 3
 * port can consume CLI-authored data with no translation.
 */
export interface CanvasStore {
  // ── Canvas records ─────────────────────────────────────────────
  listCanvases(): Promise<Canvas[]>
  getCanvas(canvasId: string): Promise<Canvas | null>
  createCanvas(input: CanvasCreateInput): Promise<Canvas>
  updateCanvas(canvasId: string, patch: CanvasUpdatePatch): Promise<Canvas>
  deleteCanvas(canvasId: string): Promise<void>

  // ── Frames ─────────────────────────────────────────────────────
  listFrames(canvasId: string): Promise<CanvasFrame[]>
  createFrame(canvasId: string, input: CanvasFrameCreateInput): Promise<CanvasFrame>
  updateFrame(canvasId: string, frameId: string, patch: CanvasFrameUpdatePatch): Promise<CanvasFrame>
  /** Deletes the frame AND cascades to any edges that reference it. */
  deleteFrame(canvasId: string, frameId: string): Promise<void>

  // ── Edges ──────────────────────────────────────────────────────
  listEdges(canvasId: string): Promise<CanvasEdge[]>
  createEdge(canvasId: string, input: CanvasEdgeCreateInput): Promise<CanvasEdge>
  updateEdge(canvasId: string, edgeId: string, patch: CanvasEdgeUpdatePatch): Promise<CanvasEdge>
  deleteEdge(canvasId: string, edgeId: string): Promise<void>

  // ── Annotations (coordinate-anchored: comments + text) ─────────
  listAnnotations(canvasId: string): Promise<CanvasAnnotation[]>
  createAnnotation(
    canvasId: string,
    input: CanvasAnnotationCreateInput,
  ): Promise<CanvasAnnotation>
  updateAnnotation(
    canvasId: string,
    annotationId: string,
    patch: CanvasAnnotationUpdatePatch,
  ): Promise<CanvasAnnotation>
  deleteAnnotation(canvasId: string, annotationId: string): Promise<void>
}

export interface CanvasCreateInput {
  name: string
}

export interface CanvasUpdatePatch {
  name?: string
}

/**
 * Frame create — `label`, `capturedUrl`, `baseUrl`, `layout` are
 * required; the others have sensible defaults applied by the store:
 *   crop           → null
 *   screenshot     → null
 *   parentFrameId  → null
 */
export interface CanvasFrameCreateInput {
  label: string
  capturedUrl: string
  baseUrl: string
  layout: FrameLayout
  crop?: FrameCrop | null
  screenshot?: FrameScreenshot | null
  parentFrameId?: string | null
}

export interface CanvasFrameUpdatePatch {
  label?: string
  capturedUrl?: string
  baseUrl?: string
  layout?: FrameLayout
  crop?: FrameCrop | null
  screenshot?: FrameScreenshot | null
  parentFrameId?: string | null
}

export interface CanvasEdgeCreateInput {
  sourceFrameId: string
  targetFrameId: string
  sourceHandleId?: string | null
  targetHandleId?: string | null
  label?: string | null
}

export interface CanvasEdgeUpdatePatch {
  label?: string | null
  sourceHandleId?: string | null
  targetHandleId?: string | null
}

/**
 * Annotation create — both kinds get `replies: []` + `resolved: false`
 * default-initialized (mirrors Desde — text annotations carry
 * those fields too even though the UI hides them).
 */
export interface CanvasAnnotationCreateInput {
  kind: CanvasAnnotationKind
  position: { x: number; y: number }
  size: { width: number; height: number }
  body: string
  /** null when the local CLI has no auth identity. */
  author?: CommentAuthor | null
  style?: TextStyle
}

export interface CanvasAnnotationUpdatePatch {
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  body?: string
  style?: TextStyle
  resolved?: boolean
  /**
   * Full replies list when adding a reply (write-the-whole-array
   * semantics). Phase 3 round-1 codex fix: without this field, canvas
   * annotation replies lived only in the Zustand slice and silently
   * disappeared on reload. AnnotationCard clears the draft as soon as
   * the handler returns, so a missing persistence path is invisible
   * data loss to the user. We don't expose a dedicated `addReply` —
   * the consumer holds the full updated annotation, so PATCH replies
   * with the new list is the simplest shape.
   */
  replies?: import("../../../types/annotation").AnnotationReply[]
}

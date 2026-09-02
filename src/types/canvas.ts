/**
 * Canvas types — mirrors `~/Documents/Prototypes/Desde/src/types/canvas.ts`
 * verbatim (field names, optionality, explicit `| null` vs optional)
 * so the local CLI's storage layer persists data in a shape the
 * Phase 3 canvas component port can consume without translation.
 *
 * Keep this file in sync with Desde when the canvas component
 * tree is ported. Any divergence here will surface as a runtime
 * type mismatch the first time Phase 3 reads a CLI-authored canvas.
 */

import type { CommentAuthor, CommentReply } from "./bridge"

export interface FrameLayout {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Rectangle in source-screenshot pixel coordinates describing which
 * portion of the screenshot should be shown in the frame. When null,
 * the full screenshot is displayed.
 */
export interface FrameCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameScreenshot {
  dataUrl: string
  width: number
  height: number
  capturedAt: string
}

export interface CanvasFrame {
  id: string
  canvasId: string
  label: string
  /** pathname + search + hash of the page where the screenshot was taken. */
  capturedUrl: string
  baseUrl: string
  layout: FrameLayout
  /** Source-pixel rect to show; null means "show the whole screenshot". */
  crop: FrameCrop | null
  screenshot: FrameScreenshot | null
  parentFrameId: string | null
  createdAt: string
  updatedAt: string
}

export interface CanvasEdge {
  id: string
  canvasId: string
  sourceFrameId: string
  targetFrameId: string
  /** Handle id on the source node (e.g. "right", "bottom"). null = unspecified. */
  sourceHandleId?: string | null
  /** Handle id on the target node (e.g. "left", "top"). null = unspecified. */
  targetHandleId?: string | null
  label: string | null
  createdAt: string
}

export type CanvasAnnotationKind = "comment" | "text"

export type TextSize = "xs" | "sm" | "md" | "lg" | "xl"
export type TextAlign = "left" | "center" | "right"
export type TextColor =
  | "default"
  | "muted"
  | "destructive"
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5"

export interface TextStyle {
  size: TextSize
  color: TextColor
  bold: boolean
  italic: boolean
  align: TextAlign
}

export interface CanvasAnnotation {
  id: string
  canvasId: string
  kind: CanvasAnnotationKind
  /** Free-floating coordinate in canvas space (Figma-style draggable). */
  position: { x: number; y: number }
  /** Visual size — 32x32 pins for comments, variable for text. */
  size: { width: number; height: number }
  body: string
  author: CommentAuthor | null
  replies: CommentReply[]
  resolved: boolean
  /** Only meaningful for `kind === "text"`. Comments ignore this field. */
  style?: TextStyle
  createdAt: string
  updatedAt: string
}

export interface Canvas {
  id: string
  projectId: string
  name: string
  createdAt: string
  updatedAt: string
}

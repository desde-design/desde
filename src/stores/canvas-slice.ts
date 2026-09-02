/**
 * Phase 3 — ported from `~/Documents/Prototypes/Desde/src/stores/canvas-slice.ts`
 * verbatim. Zero Firestore coupling in this file; the persistence
 * adapter lives one layer up (canvas-view + a hydration hook).
 */

import { type StateCreator } from "zustand"
import type {
  Canvas,
  CanvasFrame,
  CanvasEdge,
  CanvasAnnotation,
} from "@/types/canvas"

/**
 * Set when the user clicks "Open" on a frame in the canvas. Consumed
 * by the surface once the bridge is ready: navigates the iframe to
 * the captured URL. State doesn't follow — just gets the user to the
 * source view.
 */
export interface PendingNavigate {
  url: string
}

export interface CanvasSlice {
  canvases: Canvas[]
  canvasesLoading: boolean

  activeCanvasId: string | null
  frames: CanvasFrame[]
  edges: CanvasEdge[]
  annotations: CanvasAnnotation[]
  canvasLoading: boolean

  selectedFrameId: string | null
  setSelectedFrameId: (frameId: string | null) => void

  selectedAnnotationId: string | null
  setSelectedAnnotationId: (annotationId: string | null) => void

  pendingNavigate: PendingNavigate | null
  setPendingNavigate: (pending: PendingNavigate | null) => void

  setCanvases: (canvases: Canvas[]) => void
  setCanvasesLoading: (loading: boolean) => void
  addCanvas: (canvas: Canvas) => void
  removeCanvas: (canvasId: string) => void
  renameCanvas: (canvasId: string, name: string) => void

  loadActiveCanvas: (
    canvasId: string,
    frames: CanvasFrame[],
    edges: CanvasEdge[],
    annotations: CanvasAnnotation[]
  ) => void
  setActiveCanvasId: (canvasId: string | null) => void
  setCanvasLoading: (loading: boolean) => void
  clearActiveCanvas: () => void

  upsertFrame: (frame: CanvasFrame) => void
  removeFrame: (frameId: string) => void
  updateFrameLayout: (
    frameId: string,
    layout: CanvasFrame["layout"]
  ) => void
  updateFrameScreenshot: (
    frameId: string,
    screenshot: CanvasFrame["screenshot"]
  ) => void

  upsertEdge: (edge: CanvasEdge) => void
  removeEdge: (edgeId: string) => void

  upsertAnnotation: (annotation: CanvasAnnotation) => void
  removeAnnotation: (annotationId: string) => void
}

export const createCanvasSlice: StateCreator<CanvasSlice, [], [], CanvasSlice> = (set) => ({
  canvases: [],
  canvasesLoading: false,

  activeCanvasId: null,
  frames: [],
  edges: [],
  annotations: [],
  canvasLoading: false,

  selectedFrameId: null,
  setSelectedFrameId: (frameId) => set({ selectedFrameId: frameId }),

  selectedAnnotationId: null,
  setSelectedAnnotationId: (annotationId) =>
    set({ selectedAnnotationId: annotationId }),

  pendingNavigate: null,
  setPendingNavigate: (pending) => set({ pendingNavigate: pending }),

  setCanvases: (canvases) => set({ canvases }),
  setCanvasesLoading: (loading) => set({ canvasesLoading: loading }),
  addCanvas: (canvas) =>
    set((state) => ({ canvases: [canvas, ...state.canvases] })),
  removeCanvas: (canvasId) =>
    set((state) => ({
      canvases: state.canvases.filter((c) => c.id !== canvasId),
      ...(state.activeCanvasId === canvasId
        ? { activeCanvasId: null, frames: [], edges: [], annotations: [] }
        : {}),
    })),
  renameCanvas: (canvasId, name) =>
    set((state) => ({
      canvases: state.canvases.map((c) =>
        c.id === canvasId
          ? { ...c, name, updatedAt: new Date().toISOString() }
          : c
      ),
    })),

  loadActiveCanvas: (canvasId, frames, edges, annotations) =>
    set({
      activeCanvasId: canvasId,
      frames,
      edges,
      annotations,
      canvasLoading: false,
    }),
  setActiveCanvasId: (canvasId) => set({ activeCanvasId: canvasId }),
  setCanvasLoading: (loading) => set({ canvasLoading: loading }),
  clearActiveCanvas: () =>
    set({
      activeCanvasId: null,
      frames: [],
      edges: [],
      annotations: [],
      canvasLoading: false,
      selectedFrameId: null,
      selectedAnnotationId: null,
    }),

  upsertFrame: (frame) =>
    set((state) => {
      const idx = state.frames.findIndex((f) => f.id === frame.id)
      if (idx === -1) return { frames: [...state.frames, frame] }
      const next = state.frames.slice()
      next[idx] = frame
      return { frames: next }
    }),
  removeFrame: (frameId) =>
    set((state) => ({
      frames: state.frames.filter((f) => f.id !== frameId),
      edges: state.edges.filter(
        (e) => e.sourceFrameId !== frameId && e.targetFrameId !== frameId
      ),
      selectedFrameId:
        state.selectedFrameId === frameId ? null : state.selectedFrameId,
    })),
  updateFrameLayout: (frameId, layout) =>
    set((state) => ({
      frames: state.frames.map((f) =>
        f.id === frameId
          ? { ...f, layout, updatedAt: new Date().toISOString() }
          : f
      ),
    })),
  updateFrameScreenshot: (frameId, screenshot) =>
    set((state) => ({
      frames: state.frames.map((f) =>
        f.id === frameId
          ? { ...f, screenshot, updatedAt: new Date().toISOString() }
          : f
      ),
    })),

  upsertEdge: (edge) =>
    set((state) => {
      const idx = state.edges.findIndex((e) => e.id === edge.id)
      if (idx === -1) return { edges: [...state.edges, edge] }
      const next = state.edges.slice()
      next[idx] = edge
      return { edges: next }
    }),
  removeEdge: (edgeId) =>
    set((state) => ({ edges: state.edges.filter((e) => e.id !== edgeId) })),

  upsertAnnotation: (annotation) =>
    set((state) => {
      const idx = state.annotations.findIndex((a) => a.id === annotation.id)
      if (idx === -1) return { annotations: [...state.annotations, annotation] }
      const next = state.annotations.slice()
      next[idx] = annotation
      return { annotations: next }
    }),
  removeAnnotation: (annotationId) =>
    set((state) => ({
      annotations: state.annotations.filter((a) => a.id !== annotationId),
      selectedAnnotationId:
        state.selectedAnnotationId === annotationId
          ? null
          : state.selectedAnnotationId,
    })),
})

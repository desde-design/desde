/**
 * HTTP client for the CLI's `/api/editor/canvases` routes,
 * including the nested frames / edges / annotations sub-resources.
 */

import type {
  Canvas,
  CanvasAnnotation,
  CanvasEdge,
  CanvasFrame,
} from "@/types/canvas"
import type {
  CanvasAnnotationCreateInput,
  CanvasAnnotationUpdatePatch,
  CanvasCreateInput,
  CanvasEdgeCreateInput,
  CanvasEdgeUpdatePatch,
  CanvasFrameCreateInput,
  CanvasFrameUpdatePatch,
  CanvasStore,
  CanvasUpdatePatch,
} from "@/editor/core"
import {
  artifactFetch,
  assertSafeId,
  isArray,
  isMissingArtifactError,
  isObject,
  requireField,
} from "./shared"

const ROUTE = "/api/editor/canvases"

const enc = encodeURIComponent

const isCanvas = (v: unknown): v is Canvas => isObject(v)
const isCanvasArray = (v: unknown): v is Canvas[] =>
  isArray(v) && v.every(isCanvas)

const isFrame = (v: unknown): v is CanvasFrame => isObject(v)
const isFrameArray = (v: unknown): v is CanvasFrame[] =>
  isArray(v) && v.every(isFrame)

const isEdge = (v: unknown): v is CanvasEdge => isObject(v)
const isEdgeArray = (v: unknown): v is CanvasEdge[] =>
  isArray(v) && v.every(isEdge)

const isAnnotation = (v: unknown): v is CanvasAnnotation => isObject(v)
const isAnnotationArray = (v: unknown): v is CanvasAnnotation[] =>
  isArray(v) && v.every(isAnnotation)

export function createHttpCanvasStore(): CanvasStore {
  return {
    async listCanvases() {
      const resp = await artifactFetch<unknown>(ROUTE)
      return requireField<Canvas[]>(resp, "canvases", isCanvasArray)
    },
    async getCanvas(canvasId) {
      assertSafeId(canvasId, "canvasId")
      try {
        const resp = await artifactFetch<unknown>(`${ROUTE}/${enc(canvasId)}`)
        return requireField<Canvas>(resp, "canvas", isCanvas)
      } catch (err) {
        if (isMissingArtifactError(err)) return null
        throw err
      }
    },
    async createCanvas(input: CanvasCreateInput) {
      const resp = await artifactFetch<unknown>(ROUTE, {
        method: "POST",
        body: input,
      })
      return requireField<Canvas>(resp, "canvas", isCanvas)
    },
    async updateCanvas(canvasId: string, patch: CanvasUpdatePatch) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(`${ROUTE}/${enc(canvasId)}`, {
        method: "PATCH",
        body: patch,
      })
      return requireField<Canvas>(resp, "canvas", isCanvas)
    },
    async deleteCanvas(canvasId: string) {
      assertSafeId(canvasId, "canvasId")
      await artifactFetch(`${ROUTE}/${enc(canvasId)}`, { method: "DELETE" })
    },

    async listFrames(canvasId) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/frames`,
      )
      return requireField<CanvasFrame[]>(resp, "frames", isFrameArray)
    },
    async createFrame(canvasId: string, input: CanvasFrameCreateInput) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/frames`,
        { method: "POST", body: input },
      )
      return requireField<CanvasFrame>(resp, "frame", isFrame)
    },
    async updateFrame(
      canvasId: string,
      frameId: string,
      patch: CanvasFrameUpdatePatch,
    ) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(frameId, "frameId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/frames/${enc(frameId)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<CanvasFrame>(resp, "frame", isFrame)
    },
    async deleteFrame(canvasId: string, frameId: string) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(frameId, "frameId")
      await artifactFetch(
        `${ROUTE}/${enc(canvasId)}/frames/${enc(frameId)}`,
        { method: "DELETE" },
      )
    },

    async listEdges(canvasId) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/edges`,
      )
      return requireField<CanvasEdge[]>(resp, "edges", isEdgeArray)
    },
    async createEdge(canvasId: string, input: CanvasEdgeCreateInput) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/edges`,
        { method: "POST", body: input },
      )
      return requireField<CanvasEdge>(resp, "edge", isEdge)
    },
    async updateEdge(
      canvasId: string,
      edgeId: string,
      patch: CanvasEdgeUpdatePatch,
    ) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(edgeId, "edgeId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/edges/${enc(edgeId)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<CanvasEdge>(resp, "edge", isEdge)
    },
    async deleteEdge(canvasId: string, edgeId: string) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(edgeId, "edgeId")
      await artifactFetch(`${ROUTE}/${enc(canvasId)}/edges/${enc(edgeId)}`, {
        method: "DELETE",
      })
    },

    async listAnnotations(canvasId) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/annotations`,
      )
      return requireField<CanvasAnnotation[]>(
        resp,
        "annotations",
        isAnnotationArray,
      )
    },
    async createAnnotation(
      canvasId: string,
      input: CanvasAnnotationCreateInput,
    ) {
      assertSafeId(canvasId, "canvasId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/annotations`,
        { method: "POST", body: input },
      )
      return requireField<CanvasAnnotation>(resp, "annotation", isAnnotation)
    },
    async updateAnnotation(
      canvasId: string,
      annotationId: string,
      patch: CanvasAnnotationUpdatePatch,
    ) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(annotationId, "annotationId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${enc(canvasId)}/annotations/${enc(annotationId)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<CanvasAnnotation>(resp, "annotation", isAnnotation)
    },
    async deleteAnnotation(canvasId: string, annotationId: string) {
      assertSafeId(canvasId, "canvasId")
      assertSafeId(annotationId, "annotationId")
      await artifactFetch(
        `${ROUTE}/${enc(canvasId)}/annotations/${enc(annotationId)}`,
        { method: "DELETE" },
      )
    },
  }
}

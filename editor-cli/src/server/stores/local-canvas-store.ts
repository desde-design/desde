/**
 * Local-file CanvasStore.
 *
 * Layout:
 *   `<repoRoot>/.desde/canvases.json`                      — canvas metadata array
 *   `<repoRoot>/.desde/canvases/<canvasId>/frames.json`    — per-canvas frames
 *   `<repoRoot>/.desde/canvases/<canvasId>/edges.json`     — per-canvas edges
 *   `<repoRoot>/.desde/canvases/<canvasId>/annotations.json` — per-canvas annotations
 *
 * The per-canvas split keeps each file's size proportional to one
 * canvas's contents rather than scaling with the project's full
 * canvas count.
 */

import { rm } from "node:fs/promises"
import type {
  Canvas,
  CanvasAnnotation,
  CanvasEdge,
  CanvasFrame,
} from "../../../../src/types/canvas"
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
} from "../../../../src/editor/core"
import {
  mutate,
  newId,
  nowIso,
  readJsonFile,
  resolveStorePath,
  resolveStoreRemovalPath,
  writeJsonFile,
} from "./local-store-base.js"

const LOCAL_PROJECT_ID = "local"

function canvasesPath(repoRoot: string): string {
  return resolveStorePath(repoRoot, "canvases.json")
}

// Only ever `rm(..., { recursive: true })`'d — resolved through the
// removal-time guard rather than `resolveStorePath`.
function canvasDir(repoRoot: string, canvasId: string): string {
  return resolveStoreRemovalPath(repoRoot, "canvases", canvasId)
}

function framesPath(repoRoot: string, canvasId: string): string {
  return resolveStorePath(repoRoot, "canvases", canvasId, "frames.json")
}

function edgesPath(repoRoot: string, canvasId: string): string {
  return resolveStorePath(repoRoot, "canvases", canvasId, "edges.json")
}

function annotationsPath(repoRoot: string, canvasId: string): string {
  return resolveStorePath(repoRoot, "canvases", canvasId, "annotations.json")
}

async function readCanvases(repoRoot: string): Promise<Canvas[]> {
  return readJsonFile<Canvas[]>(canvasesPath(repoRoot), [])
}

async function writeCanvases(repoRoot: string, canvases: Canvas[]): Promise<void> {
  await writeJsonFile(canvasesPath(repoRoot), canvases)
}

async function assertCanvasExists(repoRoot: string, canvasId: string): Promise<void> {
  const all = await readCanvases(repoRoot)
  if (!all.some((c) => c.id === canvasId)) {
    throw new Error(`Canvas ${canvasId} not found`)
  }
}

export function createLocalCanvasStore(repoRoot: string): CanvasStore {
  const indexPath = canvasesPath(repoRoot)

  return {
    // ── Canvas records ───────────────────────────────────────────
    async listCanvases() {
      return readCanvases(repoRoot)
    },

    async getCanvas(canvasId) {
      const all = await readCanvases(repoRoot)
      return all.find((c) => c.id === canvasId) ?? null
    },

    async createCanvas(input: CanvasCreateInput) {
      return mutate(indexPath, async () => {
        const all = await readCanvases(repoRoot)
        const now = nowIso()
        const canvas: Canvas = {
          id: newId(),
          projectId: LOCAL_PROJECT_ID,
          name: input.name,
          createdAt: now,
          updatedAt: now,
        }
        all.push(canvas)
        await writeCanvases(repoRoot, all)
        return canvas
      })
    },

    async updateCanvas(canvasId: string, patch: CanvasUpdatePatch) {
      return mutate(indexPath, async () => {
        const all = await readCanvases(repoRoot)
        const idx = all.findIndex((c) => c.id === canvasId)
        if (idx === -1) throw new Error(`Canvas ${canvasId} not found`)
        const next: Canvas = {
          ...all[idx],
          name: patch.name ?? all[idx].name,
          updatedAt: nowIso(),
        }
        all[idx] = next
        await writeCanvases(repoRoot, all)
        return next
      })
    },

    async deleteCanvas(canvasId: string) {
      await mutate(indexPath, async () => {
        const all = await readCanvases(repoRoot)
        const filtered = all.filter((c) => c.id !== canvasId)
        if (filtered.length === all.length) {
          throw new Error(`Canvas ${canvasId} not found`)
        }
        await writeCanvases(repoRoot, filtered)
      })
      // Best-effort cleanup of the per-canvas directory.
      await rm(canvasDir(repoRoot, canvasId), { recursive: true, force: true }).catch(
        () => {},
      )
    },

    // ── Frames ───────────────────────────────────────────────────
    async listFrames(canvasId) {
      return readJsonFile<CanvasFrame[]>(framesPath(repoRoot, canvasId), [])
    },

    async createFrame(canvasId: string, input: CanvasFrameCreateInput) {
      await assertCanvasExists(repoRoot, canvasId)
      const path = framesPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasFrame[]>(path, [])
        const now = nowIso()
        const frame: CanvasFrame = {
          id: newId(),
          canvasId,
          label: input.label,
          capturedUrl: input.capturedUrl,
          baseUrl: input.baseUrl,
          layout: input.layout,
          crop: input.crop ?? null,
          screenshot: input.screenshot ?? null,
          parentFrameId: input.parentFrameId ?? null,
          createdAt: now,
          updatedAt: now,
        }
        all.push(frame)
        await writeJsonFile(path, all)
        return frame
      })
    },

    async updateFrame(canvasId: string, frameId: string, patch: CanvasFrameUpdatePatch) {
      const path = framesPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasFrame[]>(path, [])
        const idx = all.findIndex((f) => f.id === frameId)
        if (idx === -1) throw new Error(`Frame ${frameId} not found in canvas ${canvasId}`)
        const existing = all[idx]
        // Use `in` rather than `??` so callers can explicitly set
        // nullable fields back to null (e.g. clear the screenshot).
        const next: CanvasFrame = {
          ...existing,
          label: patch.label ?? existing.label,
          capturedUrl: patch.capturedUrl ?? existing.capturedUrl,
          baseUrl: patch.baseUrl ?? existing.baseUrl,
          layout: patch.layout ?? existing.layout,
          crop: "crop" in patch ? patch.crop ?? null : existing.crop,
          screenshot: "screenshot" in patch ? patch.screenshot ?? null : existing.screenshot,
          parentFrameId:
            "parentFrameId" in patch ? patch.parentFrameId ?? null : existing.parentFrameId,
          updatedAt: nowIso(),
        }
        all[idx] = next
        await writeJsonFile(path, all)
        return next
      })
    },

    async deleteFrame(canvasId: string, frameId: string) {
      const framesFile = framesPath(repoRoot, canvasId)
      const edgesFile = edgesPath(repoRoot, canvasId)
      // Codex round-1: deleting a frame must cascade to attached
      // edges. Without this, edges.json keeps orphan rows pointing
      // at a frame that no longer exists, which the Desde UI
      // does not handle gracefully on render.
      await mutate(framesFile, async () => {
        const all = await readJsonFile<CanvasFrame[]>(framesFile, [])
        const filtered = all.filter((f) => f.id !== frameId)
        if (filtered.length === all.length) {
          throw new Error(`Frame ${frameId} not found in canvas ${canvasId}`)
        }
        await writeJsonFile(framesFile, filtered)
      })
      await mutate(edgesFile, async () => {
        const edges = await readJsonFile<CanvasEdge[]>(edgesFile, [])
        const remaining = edges.filter(
          (e) => e.sourceFrameId !== frameId && e.targetFrameId !== frameId,
        )
        if (remaining.length !== edges.length) {
          await writeJsonFile(edgesFile, remaining)
        }
      })
    },

    // ── Edges ────────────────────────────────────────────────────
    async listEdges(canvasId) {
      return readJsonFile<CanvasEdge[]>(edgesPath(repoRoot, canvasId), [])
    },

    async createEdge(canvasId: string, input: CanvasEdgeCreateInput) {
      await assertCanvasExists(repoRoot, canvasId)
      const path = edgesPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasEdge[]>(path, [])
        const edge: CanvasEdge = {
          id: newId(),
          canvasId,
          sourceFrameId: input.sourceFrameId,
          targetFrameId: input.targetFrameId,
          sourceHandleId: input.sourceHandleId ?? null,
          targetHandleId: input.targetHandleId ?? null,
          label: input.label ?? null,
          createdAt: nowIso(),
        }
        all.push(edge)
        await writeJsonFile(path, all)
        return edge
      })
    },

    async updateEdge(canvasId: string, edgeId: string, patch: CanvasEdgeUpdatePatch) {
      const path = edgesPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasEdge[]>(path, [])
        const idx = all.findIndex((e) => e.id === edgeId)
        if (idx === -1) throw new Error(`Edge ${edgeId} not found in canvas ${canvasId}`)
        const existing = all[idx]
        const next: CanvasEdge = {
          ...existing,
          label: "label" in patch ? patch.label ?? null : existing.label,
          sourceHandleId:
            "sourceHandleId" in patch
              ? patch.sourceHandleId ?? null
              : existing.sourceHandleId,
          targetHandleId:
            "targetHandleId" in patch
              ? patch.targetHandleId ?? null
              : existing.targetHandleId,
        }
        all[idx] = next
        await writeJsonFile(path, all)
        return next
      })
    },

    async deleteEdge(canvasId: string, edgeId: string) {
      const path = edgesPath(repoRoot, canvasId)
      await mutate(path, async () => {
        const all = await readJsonFile<CanvasEdge[]>(path, [])
        const filtered = all.filter((e) => e.id !== edgeId)
        if (filtered.length === all.length) {
          throw new Error(`Edge ${edgeId} not found in canvas ${canvasId}`)
        }
        await writeJsonFile(path, filtered)
      })
    },

    // ── Annotations ──────────────────────────────────────────────
    async listAnnotations(canvasId) {
      return readJsonFile<CanvasAnnotation[]>(annotationsPath(repoRoot, canvasId), [])
    },

    async createAnnotation(canvasId: string, input: CanvasAnnotationCreateInput) {
      await assertCanvasExists(repoRoot, canvasId)
      const path = annotationsPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasAnnotation[]>(path, [])
        const now = nowIso()
        // Both kinds get replies + resolved default-initialized —
        // matches Desde, where text annotations carry the
        // fields even though the UI hides them. Style is optional
        // and only meaningful for kind="text".
        const annotation: CanvasAnnotation = {
          id: newId(),
          canvasId,
          kind: input.kind,
          position: input.position,
          size: input.size,
          body: input.body,
          author: input.author ?? null,
          replies: [],
          resolved: false,
          style: input.style,
          createdAt: now,
          updatedAt: now,
        }
        all.push(annotation)
        await writeJsonFile(path, all)
        return annotation
      })
    },

    async updateAnnotation(
      canvasId: string,
      annotationId: string,
      patch: CanvasAnnotationUpdatePatch,
    ) {
      const path = annotationsPath(repoRoot, canvasId)
      return mutate(path, async () => {
        const all = await readJsonFile<CanvasAnnotation[]>(path, [])
        const idx = all.findIndex((a) => a.id === annotationId)
        if (idx === -1) {
          throw new Error(`Annotation ${annotationId} not found in canvas ${canvasId}`)
        }
        const existing = all[idx]
        // `?? existing.resolved` would coerce `patch.resolved: false`
        // back to the prior value — toggling resolved OFF would never
        // persist. Codex round-1 must-fix; explicit undefined check.
        const next: CanvasAnnotation = {
          ...existing,
          position: patch.position ?? existing.position,
          size: patch.size ?? existing.size,
          body: patch.body ?? existing.body,
          style: patch.style ?? existing.style,
          resolved:
            patch.resolved !== undefined ? patch.resolved : existing.resolved,
          replies: patch.replies ?? existing.replies,
          updatedAt: nowIso(),
        }
        all[idx] = next
        await writeJsonFile(path, all)
        return next
      })
    },

    async deleteAnnotation(canvasId: string, annotationId: string) {
      const path = annotationsPath(repoRoot, canvasId)
      await mutate(path, async () => {
        const all = await readJsonFile<CanvasAnnotation[]>(path, [])
        const filtered = all.filter((a) => a.id !== annotationId)
        if (filtered.length === all.length) {
          throw new Error(`Annotation ${annotationId} not found in canvas ${canvasId}`)
        }
        await writeJsonFile(path, filtered)
      })
    },
  }
}

"use client"

/**
 * CLI-side canvas hook — HTTP-backed parallel to the viewer's
 * Firestore canvas flow.
 *
 * Owns:
 *  - canvases list load on mount
 *  - active canvas load (frames + edges + annotations) when
 *    `activeCanvasId` changes
 *  - create / delete / rename of canvases
 *  - screenshot-plan → canvas (`addScreenshotPlanToCanvas`, dagre layout) —
 *    lays out a replayed screenshot plan's screens as frames + auto-
 *    connecting edges via `canvas-screenshot-plan.ts` and persists them
 *    via the store
 *
 * Annotation creation is exposed via `createAnnotation` so an
 * eventual toolbar (or right-click menu) on the canvas surface can
 * persist a new pin / text block. v1 ships without a creation
 * toolbar — `addScreenshotPlanToCanvas` is the entry point.
 *
 * Returns the loaded store too, so the surface can hand it to
 * `<CanvasView store={store} />` for per-mutation persistence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/stores"
import { createHttpCanvasStore } from "@/services/artifact-stores"
import { isArtifactStoreError } from "@/services/artifact-stores/shared"
import {
  persistScreenshotPlanToCanvas,
  screenshotPlanCanvasName,
} from "@/utils/canvas-screenshot-plan"
import type { Canvas, CanvasAnnotation } from "@/types/canvas"
import type { FlowScreenshot } from "@/types/bridge"
import type { ScreenshotPlan } from "@/editor/core/screenshot-plan"
import type {
  CanvasAnnotationCreateInput,
  CanvasStore,
} from "@/editor/core"

export interface UseLocalCanvasesResult {
  loading: boolean
  error: string | null
  store: CanvasStore
  /** Refetch the canvases list. */
  refresh: () => Promise<void>
  /** Load a canvas (frames + edges + annotations) into the slice. */
  loadCanvas: (canvasId: string) => Promise<void>
  /** Create a blank canvas. */
  createCanvas: (name: string) => Promise<Canvas | null>
  /** Rename. Optimistic. */
  renameCanvas: (canvasId: string, name: string) => Promise<void>
  /** Delete. Optimistic; clears active canvas if it was active. */
  deleteCanvas: (canvasId: string) => Promise<void>
  /**
   * Drop a generated screenshot plan's screens onto the canvas as frames +
   * auto-connecting edges. With `canvasId` it APPENDS to that canvas (offset
   * below existing frames); without, it creates a new canvas. Returns the
   * target canvas id (the caller sets it active + reloads).
   */
  addScreenshotPlanToCanvas: (
    plan: ScreenshotPlan,
    screenshots: FlowScreenshot[],
    opts?: { canvasId?: string },
  ) => Promise<string | null>
  /** Create an annotation on the active canvas. */
  createAnnotation: (
    canvasId: string,
    input: CanvasAnnotationCreateInput,
  ) => Promise<CanvasAnnotation | null>
}

export interface UseLocalCanvasesOptions {
  store?: CanvasStore
  enabled?: boolean
}

export function useLocalCanvases(
  options: UseLocalCanvasesOptions = {},
): UseLocalCanvasesResult {
  const { enabled = true } = options
  const store = useMemo<CanvasStore>(
    () => options.store ?? createHttpCanvasStore(),
    [options.store],
  )

  const setCanvases = useAppStore((s) => s.setCanvases)
  const setCanvasesLoading = useAppStore((s) => s.setCanvasesLoading)
  const addCanvas = useAppStore((s) => s.addCanvas)
  const removeCanvasFromSlice = useAppStore((s) => s.removeCanvas)
  const renameCanvasInSlice = useAppStore((s) => s.renameCanvas)
  const loadActiveCanvas = useAppStore((s) => s.loadActiveCanvas)
  const setCanvasLoading = useAppStore((s) => s.setCanvasLoading)
  const upsertAnnotation = useAppStore((s) => s.upsertAnnotation)
  const [loading, setLoading] = useState<boolean>(enabled)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    setCanvasesLoading(true)
    try {
      const list = await store.listCanvases()
      if (!mountedRef.current) return
      setCanvases(list)
      setError(null)
    } catch (err) {
      if (!mountedRef.current) return
      setError(`Failed to load canvases: ${(err as Error).message}`)
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setCanvasesLoading(false)
      }
    }
  }, [enabled, store, setCanvases, setCanvasesLoading])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void refresh()
  }, [enabled, refresh])

  // Last-load generation token. Rapid A then B selection from the
  // surface used to let stale A's commit win whichever fetch
  // resolved last; codex round-1 should-fix. Each loadCanvas
  // increments the token and a commit only happens if the token
  // matches at resolve time.
  const loadGenerationRef = useRef(0)
  const loadCanvas = useCallback(
    async (canvasId: string): Promise<void> => {
      const generation = ++loadGenerationRef.current
      setCanvasLoading(true)
      try {
        const [frames, edges, annotations] = await Promise.all([
          store.listFrames(canvasId),
          store.listEdges(canvasId),
          store.listAnnotations(canvasId),
        ])
        if (!mountedRef.current) return
        if (loadGenerationRef.current !== generation) {
          // A later loadCanvas() superseded us. Drop the stale result.
          return
        }
        loadActiveCanvas(canvasId, frames, edges, annotations)
      } catch (err) {
        if (!mountedRef.current) return
        if (loadGenerationRef.current !== generation) return
        const message = surfaceError("Failed to load canvas", err)
        setError(message)
        setCanvasLoading(false)
      }
    },
    [store, loadActiveCanvas, setCanvasLoading],
  )

  const createCanvas = useCallback(
    async (name: string): Promise<Canvas | null> => {
      try {
        const created = await store.createCanvas({ name })
        addCanvas(created)
        return created
      } catch (err) {
        const message = surfaceError("Failed to create canvas", err)
        setError(message)
        return null
      }
    },
    [store, addCanvas],
  )

  const renameCanvas = useCallback(
    async (canvasId: string, name: string): Promise<void> => {
      const before = useAppStore
        .getState()
        .canvases.find((c) => c.id === canvasId)
      if (!before) return
      renameCanvasInSlice(canvasId, name)
      try {
        await store.updateCanvas(canvasId, { name })
      } catch (err) {
        renameCanvasInSlice(canvasId, before.name)
        const message = surfaceError("Failed to rename canvas", err)
        setError(message)
      }
    },
    [store, renameCanvasInSlice],
  )

  const deleteCanvas = useCallback(
    async (canvasId: string): Promise<void> => {
      const before = useAppStore
        .getState()
        .canvases.find((c) => c.id === canvasId)
      if (!before) return
      removeCanvasFromSlice(canvasId)
      try {
        await store.deleteCanvas(canvasId)
      } catch (err) {
        addCanvas(before)
        const message = surfaceError("Failed to delete canvas", err)
        setError(message)
      }
    },
    [store, removeCanvasFromSlice, addCanvas],
  )

  const addScreenshotPlanToCanvas = useCallback(
    async (
      plan: ScreenshotPlan,
      screenshots: FlowScreenshot[],
      opts?: { canvasId?: string },
    ): Promise<string | null> => {
      try {
        // Resolve the target canvas: append to the given one, or make a new one.
        let targetId = opts?.canvasId ?? null
        if (!targetId) {
          const created = await store.createCanvas({
            name: screenshotPlanCanvasName(plan),
          })
          addCanvas(created)
          targetId = created.id
        }

        // Build + persist the plan's frames + auto-edges (offsets below any
        // existing frames). Shared with the smoke harness.
        await persistScreenshotPlanToCanvas(store, targetId, plan, screenshots)
        return targetId
      } catch (err) {
        const message = surfaceError("Failed to add screenshots to canvas", err)
        setError(message)
        return null
      }
    },
    [store, addCanvas],
  )

  const createAnnotation = useCallback(
    async (
      canvasId: string,
      input: CanvasAnnotationCreateInput,
    ): Promise<CanvasAnnotation | null> => {
      try {
        const created = await store.createAnnotation(canvasId, input)
        upsertAnnotation(created)
        return created
      } catch (err) {
        const message = surfaceError("Failed to create annotation", err)
        setError(message)
        return null
      }
    },
    [store, upsertAnnotation],
  )

  return {
    loading,
    error,
    store,
    refresh,
    loadCanvas,
    createCanvas,
    renameCanvas,
    deleteCanvas,
    addScreenshotPlanToCanvas,
    createAnnotation,
  }
}

function surfaceError(prefix: string, err: unknown): string {
  let message = prefix
  if (isArtifactStoreError(err)) {
    message = `${prefix}: ${err.reason}`
  } else if (err instanceof Error) {
    message = `${prefix}: ${err.message}`
  }
  toast.error(message)
  return message
}

/**
 * Tests for useLocalCanvases — HTTP-backed canvas list + active-canvas
 * load + create / rename / delete + addScreenshotPlanToCanvas. The
 * canvas-view itself is exercised via integration testing.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useLocalCanvases } from "./useLocalCanvases"
import { useAppStore } from "@/stores"
import type {
  Canvas,
  CanvasAnnotation,
  CanvasEdge,
  CanvasFrame,
} from "@/types/canvas"
import type { CanvasStore } from "@/editor/core"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

function fakeCanvas(id: string, name: string): Canvas {
  return {
    id,
    projectId: "",
    name,
    createdAt: "2026-05-24T00:00:00Z",
    updatedAt: "2026-05-24T00:00:00Z",
  }
}

function makeMockStore(): CanvasStore {
  return {
    listCanvases: vi.fn(async (): Promise<Canvas[]> => []),
    getCanvas: vi.fn(async () => null),
    createCanvas: vi.fn(async () => fakeCanvas("c-new", "Untitled")),
    updateCanvas: vi.fn(async () => fakeCanvas("c1", "renamed")),
    deleteCanvas: vi.fn(async () => undefined),
    listFrames: vi.fn(async (): Promise<CanvasFrame[]> => []),
    createFrame: vi.fn(),
    updateFrame: vi.fn(),
    deleteFrame: vi.fn(),
    listEdges: vi.fn(async (): Promise<CanvasEdge[]> => []),
    createEdge: vi.fn(),
    updateEdge: vi.fn(),
    deleteEdge: vi.fn(),
    listAnnotations: vi.fn(async (): Promise<CanvasAnnotation[]> => []),
    createAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
  } as unknown as CanvasStore
}

beforeEach(() => {
  useAppStore.setState({
    canvases: [],
    canvasesLoading: false,
    activeCanvasId: null,
    frames: [],
    edges: [],
    annotations: [],
    canvasLoading: false,
  })
})

afterEach(() => {
  useAppStore.setState({
    canvases: [],
    canvasesLoading: false,
    activeCanvasId: null,
    frames: [],
    edges: [],
    annotations: [],
    canvasLoading: false,
  })
  vi.restoreAllMocks()
})

describe("useLocalCanvases", () => {
  it("loads via store.listCanvases on mount", async () => {
    const store = makeMockStore()
    ;(store.listCanvases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      fakeCanvas("c1", "First"),
      fakeCanvas("c2", "Second"),
    ])
    const { result } = renderHook(() => useLocalCanvases({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(useAppStore.getState().canvases.map((c) => c.id)).toEqual([
      "c1",
      "c2",
    ])
  })

  it("loadCanvas fetches frames + edges + annotations in parallel", async () => {
    const store = makeMockStore()
    const f: CanvasFrame = {
      id: "f1",
      canvasId: "c1",
      label: "Home",
      capturedUrl: "/",
      baseUrl: "/",
      layout: { x: 0, y: 0, width: 100, height: 100 },
      crop: null,
      screenshot: null,
      parentFrameId: null,
      createdAt: "2026-05-24T00:00:00Z",
      updatedAt: "2026-05-24T00:00:00Z",
    }
    ;(store.listFrames as ReturnType<typeof vi.fn>).mockResolvedValueOnce([f])
    ;(store.listEdges as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    ;(store.listAnnotations as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])

    const { result } = renderHook(() => useLocalCanvases({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.loadCanvas("c1")
    })

    expect(useAppStore.getState().activeCanvasId).toBe("c1")
    expect(useAppStore.getState().frames).toHaveLength(1)
  })

  it("createCanvas prepends to the slice via store.createCanvas", async () => {
    const store = makeMockStore()
    ;(store.listCanvases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])
    ;(store.createCanvas as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakeCanvas("c-new", "Fresh"),
    )
    const { result } = renderHook(() => useLocalCanvases({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.createCanvas("Fresh")
    })

    expect(store.createCanvas).toHaveBeenCalledWith({ name: "Fresh" })
    expect(useAppStore.getState().canvases.map((c) => c.id)).toEqual([
      "c-new",
    ])
  })

  it("renameCanvas optimistically renames and rolls back on failure", async () => {
    const store = makeMockStore()
    ;(store.listCanvases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      fakeCanvas("c1", "Original"),
    ])
    ;(store.updateCanvas as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("offline"),
    )
    const { result } = renderHook(() => useLocalCanvases({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.renameCanvas("c1", "Updated")
    })

    expect(useAppStore.getState().canvases[0].name).toBe("Original")
  })

  it("deleteCanvas removes locally and re-adds on failure", async () => {
    const store = makeMockStore()
    ;(store.listCanvases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      fakeCanvas("c1", "First"),
      fakeCanvas("c2", "Second"),
    ])
    ;(store.deleteCanvas as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("offline"),
    )
    const { result } = renderHook(() => useLocalCanvases({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteCanvas("c1")
    })

    // Restored after failure.
    expect(useAppStore.getState().canvases.map((c) => c.id).sort()).toEqual([
      "c1",
      "c2",
    ])
  })

  it("stays inert when enabled=false", async () => {
    const store = makeMockStore()
    renderHook(() => useLocalCanvases({ store, enabled: false }))
    await new Promise((r) => setTimeout(r, 0))
    expect(store.listCanvases).not.toHaveBeenCalled()
  })
})

/**
 * CRUD + nested-resource tests for the local-file CanvasStore.
 *
 * Behaviors that need pinning down:
 *  - Frames / edges / annotations refuse to create against an unknown
 *    canvas id (referential integrity at the API boundary).
 *  - Deleting a canvas cascades — the per-canvas directory and all
 *    its nested files are removed.
 *  - Deleting a frame cascades to its attached edges (codex round-1).
 *  - Optional nullable fields (crop, screenshot, parentFrameId,
 *    sourceHandleId, etc.) default to `null` (matching Desde)
 *    not `undefined`.
 *  - Both annotation kinds get `replies: []` + `resolved: false`
 *    default-initialized.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createLocalCanvasStore } from "../stores/local-canvas-store"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-canvas-store-test-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const sampleLayout = () => ({ x: 0, y: 0, width: 960, height: 540 })

const baseFrameInput = () => ({
  label: "Home",
  capturedUrl: "/",
  baseUrl: "http://localhost:5173",
  layout: sampleLayout(),
})

describe("createLocalCanvasStore — canvases", () => {
  it("creates and lists canvases", async () => {
    const store = createLocalCanvasStore(tmp)
    const c1 = await store.createCanvas({ name: "First" })
    await store.createCanvas({ name: "Second" })

    expect(c1.projectId).toBe("local")

    const list = await store.listCanvases()
    expect(list).toHaveLength(2)
  })

  it("updateCanvas bumps updatedAt and applies patches", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "Original" })
    await new Promise((r) => setTimeout(r, 2))
    const updated = await store.updateCanvas(c.id, { name: "Renamed" })
    expect(updated.name).toBe("Renamed")
    expect(updated.updatedAt > c.updatedAt).toBe(true)
  })

  it("deleteCanvas cascades to the per-canvas directory", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "X" })
    await store.createFrame(c.id, baseFrameInput())

    const dir = path.join(tmp, ".desde", "canvases", c.id)
    expect(existsSync(dir)).toBe(true)

    await store.deleteCanvas(c.id)

    expect(await store.getCanvas(c.id)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })
})

describe("createLocalCanvasStore — frames", () => {
  it("refuses to create a frame against an unknown canvas id", async () => {
    const store = createLocalCanvasStore(tmp)
    await expect(store.createFrame("nope", baseFrameInput())).rejects.toThrow(/not found/i)
  })

  it("defaults nullable fields to null (not undefined) on create", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const f = await store.createFrame(c.id, baseFrameInput())

    expect(f.crop).toBeNull()
    expect(f.screenshot).toBeNull()
    expect(f.parentFrameId).toBeNull()
  })

  it("persists provided nullable values explicitly", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const f = await store.createFrame(c.id, {
      ...baseFrameInput(),
      screenshot: {
        dataUrl: "data:image/png;base64,AAA",
        width: 1280,
        height: 720,
        capturedAt: new Date().toISOString(),
      },
      crop: { x: 0, y: 0, width: 1280, height: 720 },
      parentFrameId: "parent-x",
    })
    expect(f.screenshot?.dataUrl).toBe("data:image/png;base64,AAA")
    expect(f.crop?.width).toBe(1280)
    expect(f.parentFrameId).toBe("parent-x")
  })

  it("updateFrame can clear a nullable field by setting it to null", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const f = await store.createFrame(c.id, {
      ...baseFrameInput(),
      parentFrameId: "p1",
    })
    const updated = await store.updateFrame(c.id, f.id, { parentFrameId: null })
    expect(updated.parentFrameId).toBeNull()
  })

  it("deleteFrame cascades to attached edges", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const a = await store.createFrame(c.id, baseFrameInput())
    const b = await store.createFrame(c.id, { ...baseFrameInput(), label: "B" })
    const cFrame = await store.createFrame(c.id, { ...baseFrameInput(), label: "C-frame" })

    await store.createEdge(c.id, { sourceFrameId: a.id, targetFrameId: b.id })
    await store.createEdge(c.id, { sourceFrameId: b.id, targetFrameId: cFrame.id })
    await store.createEdge(c.id, { sourceFrameId: a.id, targetFrameId: cFrame.id })

    // Delete b — should remove the 2 edges referencing it; leave a→cFrame.
    await store.deleteFrame(c.id, b.id)

    const remainingEdges = await store.listEdges(c.id)
    expect(remainingEdges).toHaveLength(1)
    expect(remainingEdges[0].sourceFrameId).toBe(a.id)
    expect(remainingEdges[0].targetFrameId).toBe(cFrame.id)
  })

  it("listFrames returns [] for a canvas with no frames", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    expect(await store.listFrames(c.id)).toEqual([])
  })
})

describe("createLocalCanvasStore — edges", () => {
  it("refuses to create an edge against an unknown canvas id", async () => {
    const store = createLocalCanvasStore(tmp)
    await expect(
      store.createEdge("nope", { sourceFrameId: "a", targetFrameId: "b" }),
    ).rejects.toThrow(/not found/i)
  })

  it("defaults handle ids + label to null (not undefined)", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const e = await store.createEdge(c.id, {
      sourceFrameId: "frame-1",
      targetFrameId: "frame-2",
    })
    expect(e.sourceHandleId).toBeNull()
    expect(e.targetHandleId).toBeNull()
    expect(e.label).toBeNull()
  })

  it("create + update + delete with explicit label", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const e = await store.createEdge(c.id, {
      sourceFrameId: "frame-1",
      targetFrameId: "frame-2",
      label: "Submits",
    })
    expect(e.label).toBe("Submits")

    const updated = await store.updateEdge(c.id, e.id, { label: "Clicks Submit" })
    expect(updated.label).toBe("Clicks Submit")

    const cleared = await store.updateEdge(c.id, e.id, { label: null })
    expect(cleared.label).toBeNull()

    await store.deleteEdge(c.id, e.id)
    expect(await store.listEdges(c.id)).toEqual([])
  })
})

describe("createLocalCanvasStore — annotations", () => {
  it("comment annotations default-initialize replies + resolved + author", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const annotation = await store.createAnnotation(c.id, {
      kind: "comment",
      position: { x: 100, y: 200 },
      size: { width: 32, height: 32 },
      body: "looks off",
    })
    expect(annotation.kind).toBe("comment")
    expect(annotation.replies).toEqual([])
    expect(annotation.resolved).toBe(false)
    expect(annotation.author).toBeNull()
  })

  it("text annotations ALSO carry replies + resolved (Desde shape)", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const annotation = await store.createAnnotation(c.id, {
      kind: "text",
      position: { x: 50, y: 80 },
      size: { width: 200, height: 60 },
      body: "Note: refactor this",
      style: {
        size: "md",
        color: "default",
        bold: true,
        italic: false,
        align: "left",
      },
    })
    expect(annotation.kind).toBe("text")
    expect(annotation.replies).toEqual([])
    expect(annotation.resolved).toBe(false)
    expect(annotation.style?.bold).toBe(true)
  })

  it("update lets you reposition (drag) an annotation", async () => {
    const store = createLocalCanvasStore(tmp)
    const c = await store.createCanvas({ name: "C" })
    const a = await store.createAnnotation(c.id, {
      kind: "comment",
      position: { x: 0, y: 0 },
      size: { width: 32, height: 32 },
      body: "x",
    })
    const moved = await store.updateAnnotation(c.id, a.id, {
      position: { x: 500, y: 600 },
    })
    expect(moved.position).toEqual({ x: 500, y: 600 })
  })

  it("isolates frames/edges/annotations across canvases", async () => {
    const store = createLocalCanvasStore(tmp)
    const c1 = await store.createCanvas({ name: "C1" })
    const c2 = await store.createCanvas({ name: "C2" })

    await store.createFrame(c1.id, { ...baseFrameInput(), label: "in c1" })
    await store.createFrame(c2.id, { ...baseFrameInput(), label: "in c2" })

    const c1Frames = await store.listFrames(c1.id)
    const c2Frames = await store.listFrames(c2.id)
    expect(c1Frames).toHaveLength(1)
    expect(c2Frames).toHaveLength(1)
    expect(c1Frames[0].label).toBe("in c1")
    expect(c2Frames[0].label).toBe("in c2")
  })
})

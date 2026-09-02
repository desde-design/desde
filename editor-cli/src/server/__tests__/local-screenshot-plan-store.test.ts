/**
 * CRUD + screenshot persistence tests for the local-file
 * ScreenshotPlanStore. Mirrors local-flow-store.test.ts.
 *
 * Two non-obvious behaviors pinned here:
 *  - each plan is its own `<id>.json` file; list() reads them all and
 *    sorts newest-first by createdAt.
 *  - delete() removes the plan file AND its per-plan screenshots
 *    directory so we don't leak orphaned blobs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ScreenshotPlanCreateInput } from "../../../../src/editor/core"
import type { FlowScreenshot } from "../../../../src/types/bridge"
import { createLocalScreenshotPlanStore } from "../stores/local-screenshot-plan-store"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-plan-store-test-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const sampleInput = (
  overrides: Partial<ScreenshotPlanCreateInput> = {},
): ScreenshotPlanCreateInput => ({
  name: "Create model flow",
  baseUrl: "http://localhost:5173",
  source: "prompt",
  prompt: "go to model-create, fill the form, submit",
  steps: [
    { intent: "open model-create", kind: "navigate", route: "/models/new" },
    {
      intent: "submit",
      kind: "interact",
      action: "click",
      target: { description: "the Create button" },
    },
    {
      intent: "snapshot",
      kind: "capture",
      capture: { scope: "viewport", label: "created" },
    },
  ],
  ...overrides,
})

const sampleScreenshot = (stepIndex: number): FlowScreenshot => ({
  stepIndex,
  dataUrl: `data:image/png;base64,${"a".repeat(64)}`,
  width: 1280,
  height: 720,
})

describe("createLocalScreenshotPlanStore", () => {
  it("create assigns id + createdAt and round-trips via get", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const plan = await store.create(sampleInput())
    expect(plan.id).toBeTruthy()
    expect(plan.createdAt).toBeTruthy()
    expect(plan.source).toBe("prompt")
    expect(plan.steps).toHaveLength(3)

    const got = await store.get(plan.id)
    expect(got).toEqual(plan)
  })

  it("omits prompt when not provided", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const plan = await store.create(
      sampleInput({ source: "route-enumeration", prompt: undefined }),
    )
    expect("prompt" in plan).toBe(false)
  })

  it("get returns null for unknown ids", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    expect(await store.get("nope")).toBeNull()
  })

  it("list returns all plans newest-first by createdAt", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const a = await store.create(sampleInput({ name: "A" }))
    const b = await store.create(sampleInput({ name: "B" }))
    // Force a deterministic ordering independent of clock resolution.
    const aPath = path.join(tmp, ".desde", "screenshot-plans", `${a.id}.json`)
    const bPath = path.join(tmp, ".desde", "screenshot-plans", `${b.id}.json`)
    await fs.writeFile(
      aPath,
      JSON.stringify({ ...a, createdAt: "2026-06-12T00:00:00.000Z" }, null, 2),
    )
    await fs.writeFile(
      bPath,
      JSON.stringify({ ...b, createdAt: "2026-06-12T01:00:00.000Z" }, null, 2),
    )

    const listed = await store.list()
    expect(listed.map((p) => p.name)).toEqual(["B", "A"])
  })

  it("list returns [] when nothing has been persisted", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    expect(await store.list()).toEqual([])
  })

  it("update applies name/steps/prompt patches", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const plan = await store.create(sampleInput())
    const updated = await store.update(plan.id, {
      name: "Renamed",
      steps: [{ intent: "x", kind: "navigate", route: "/x" }],
      prompt: "new prompt",
    })
    expect(updated.name).toBe("Renamed")
    expect(updated.steps).toHaveLength(1)
    expect(updated.prompt).toBe("new prompt")
    // persisted, not just returned
    expect((await store.get(plan.id))?.name).toBe("Renamed")
  })

  it("update on a missing plan rejects with 'not found'", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    await expect(store.update("nope", { name: "x" })).rejects.toThrow(/not found/i)
  })

  it("saveScreenshots replaces (not appends); getScreenshots reads them", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const plan = await store.create(sampleInput())
    expect(await store.getScreenshots(plan.id)).toEqual([])

    await store.saveScreenshots(plan.id, [sampleScreenshot(2)])
    await store.saveScreenshots(plan.id, [sampleScreenshot(0), sampleScreenshot(2)])
    const all = await store.getScreenshots(plan.id)
    expect(all).toHaveLength(2)
    expect(all.map((s) => s.stepIndex)).toEqual([0, 2])
  })

  it("delete removes the plan file AND its screenshots directory", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    const plan = await store.create(sampleInput())
    await store.saveScreenshots(plan.id, [sampleScreenshot(2)])

    const planFile = path.join(
      tmp,
      ".desde",
      "screenshot-plans",
      `${plan.id}.json`,
    )
    const shotsDir = path.join(
      tmp,
      ".desde",
      "screenshot-plans",
      plan.id,
    )
    expect(existsSync(planFile)).toBe(true)
    expect(existsSync(shotsDir)).toBe(true)

    await store.delete(plan.id)

    expect(await store.get(plan.id)).toBeNull()
    expect(existsSync(planFile)).toBe(false)
    expect(existsSync(shotsDir)).toBe(false)
  })

  it("delete on a missing plan rejects with 'not found'", async () => {
    const store = createLocalScreenshotPlanStore(tmp)
    await expect(store.delete("nope")).rejects.toThrow(/not found/i)
  })
})

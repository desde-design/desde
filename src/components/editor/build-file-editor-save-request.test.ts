/**
 * `buildFileEditorSaveRequest` — Task 4b, round 2. Pins that the file
 * editor's hand-built `POST /api/editor/edit` body ALWAYS carries a
 * `correlationId`, and that it never omits `baseHash` on a forced save.
 *
 * This is the regression catch for a defect that never manifested in the
 * running app: `file-editor-pane.tsx` built its request body directly
 * instead of going through `buildEditRequest`, so it silently skipped the
 * `correlationId` every other direct-lane edit gets. Nothing broke today
 * only because this lane never wires a verification record — the moment
 * it does, the original disjoint-id-space bug reappears with nothing here
 * to catch it. This test is that catch.
 */

import { describe, expect, it } from "vitest"
import { buildFileEditorSaveRequest } from "./build-file-editor-save-request"

describe("buildFileEditorSaveRequest", () => {
  it("always attaches a non-empty correlationId", () => {
    const body = buildFileEditorSaveRequest({
      file: "src/App.vue",
      newSource: "<template></template>",
      baseHash: "abc123",
    })
    expect(typeof body.correlationId).toBe("string")
    expect((body.correlationId as string).length).toBeGreaterThan(0)
  })

  it("mints a FRESH correlationId on every call — two saves never share a join key", () => {
    const a = buildFileEditorSaveRequest({ file: "src/App.vue", newSource: "one" })
    const b = buildFileEditorSaveRequest({ file: "src/App.vue", newSource: "two" })
    expect(a.correlationId).not.toBe(b.correlationId)
  })

  it("carries the overwrite edit shape with baseHash when provided", () => {
    const body = buildFileEditorSaveRequest({
      file: "src/App.vue",
      newSource: "<template></template>",
      baseHash: "abc123",
    })
    expect(body.edit).toEqual({
      kind: "overwrite",
      file: "src/App.vue",
      newSource: "<template></template>",
      baseHash: "abc123",
    })
  })

  it("omits baseHash entirely (not undefined) on a forced save", () => {
    const body = buildFileEditorSaveRequest({
      file: "src/App.vue",
      newSource: "<template></template>",
    })
    expect(body.edit).toEqual({
      kind: "overwrite",
      file: "src/App.vue",
      newSource: "<template></template>",
    })
    expect("baseHash" in (body.edit as object)).toBe(false)
    // The whole point of the fix: JSON.stringify must actually emit the
    // key. `correlationId` in the object is not enough on its own — a
    // value of `undefined` would also pass an `in` check's cousin but
    // vanish over the wire, which is exactly the failure mode the ledger
    // route relies on for "absent means absent" (see the Task 4b e2e test
    // in editor-cli).
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
    expect(typeof wire.correlationId).toBe("string")
  })
})

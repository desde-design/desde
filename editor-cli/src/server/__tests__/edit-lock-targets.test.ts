/**
 * Route-layer lock-target derivation (Task 11).
 *
 * These assertions are what makes the per-file scheme correct at the HTTP
 * boundary: the route must name EVERY file an edit can write before dispatch,
 * and must return nothing (→ caller falls back to the exclusive tree lock)
 * rather than guessing when the shape is unrecognized.
 */

import { describe, expect, it } from "vitest"
import { editLockTargets } from "../edit-lock-targets"
import { fileEditLockKey } from "../session-lock"
import type { EditRequestBody } from "../../../../src/editor/edit-service/validate-edit-request"

const asBody = (edit: unknown): EditRequestBody => ({ edit }) as EditRequestBody

describe("editLockTargets", () => {
  it("returns the single target for a prop edit", () => {
    expect(
      editLockTargets(
        asBody({
          kind: "prop",
          file: "src/App.vue",
          line: 3,
          column: 5,
          propName: "title",
          value: "Hi",
        }),
      ),
    ).toEqual(["src/App.vue"])
  })

  it("returns BOTH files for a detach (consumer written, component read)", () => {
    expect(
      editLockTargets(
        asBody({
          kind: "detach",
          file: "src/App.vue",
          line: 3,
          column: 5,
          componentFile: "src/components/Card.vue",
          componentName: "Card",
        }),
      ),
    ).toEqual(["src/App.vue", "src/components/Card.vue"])
  })

  it("returns file + destFile for a move", () => {
    expect(
      editLockTargets(
        asBody({
          kind: "move",
          file: "src/App.vue",
          line: 3,
          column: 5,
          destFile: "src/App.vue",
          destParentLine: 1,
          destParentColumn: 1,
          destIndex: 0,
        }),
      ),
    ).toEqual(["src/App.vue", "src/App.vue"])
  })

  it("derives every file in an llm-patch bundle from the mutations' locs", () => {
    const targets = editLockTargets(
      asBody({
        kind: "llm-patch",
        mutations: [
          { sourceLoc: "src/A.vue:10:3", scope: "definition" },
          { sourceLoc: "src/B.vue:2:1", scope: "definition" },
        ],
      }),
    )
    expect(targets).toEqual(["src/A.vue", "src/B.vue"])
  })

  it("uses the CALLSITE file for a cross-file 'this-instance' mutation", () => {
    // Mirrors handleLLMPatch: that mutation's patch lands in the callsite's
    // file, so that's the file whose lock must be held.
    const targets = editLockTargets(
      asBody({
        kind: "llm-patch",
        mutations: [
          {
            sourceLoc: "src/components/Card.vue:10:3",
            callsiteLoc: "src/App.vue:4:2",
            scope: "callsite",
            disambiguationChoice: "this-instance",
          },
          {
            sourceLoc: "src/components/Card.vue:11:3",
            callsiteLoc: "src/App.vue:4:2",
            scope: "callsite",
            disambiguationChoice: "all-instances",
          },
        ],
      }),
    )
    expect(targets).toEqual(["src/App.vue", "src/components/Card.vue"])
  })

  it("handles a Windows-style drive-letter path in a sourceLoc", () => {
    expect(
      editLockTargets(
        asBody({
          kind: "llm-patch",
          mutations: [{ sourceLoc: "C:\\repo\\src\\A.vue:10:3", scope: "definition" }],
        }),
      ),
    ).toEqual(["C:\\repo\\src\\A.vue"])
  })

  it("returns [] for unrecognized / malformed shapes so the caller can fail safe", () => {
    expect(editLockTargets(asBody(undefined))).toEqual([])
    expect(editLockTargets(asBody({ kind: "prop" }))).toEqual([])
    expect(editLockTargets(asBody({ kind: "prop", file: "" }))).toEqual([])
    expect(
      editLockTargets(
        asBody({ kind: "llm-patch", mutations: [{ sourceLoc: "no-colons" }] }),
      ),
    ).toEqual([])
    expect(editLockTargets(asBody({ kind: "llm-patch", mutations: [null] }))).toEqual([])
  })

  it("derives the same key an equivalent discard request would take", () => {
    // /api/editor/branches/discard passes the Activity row's `path`
    // verbatim; /api/editor/edit passes `edit.file`. Same physical file →
    // same key, which is what preserves the P2 discard-vs-edit race fix.
    const [editTarget] = editLockTargets(
      asBody({
        kind: "prop",
        file: "./src/App.vue",
        line: 1,
        column: 1,
        propName: "t",
        value: "x",
      }),
    )
    expect(fileEditLockKey("/tmp/repo", editTarget)).toBe(
      fileEditLockKey("/tmp/repo", "src/App.vue"),
    )
  })
})

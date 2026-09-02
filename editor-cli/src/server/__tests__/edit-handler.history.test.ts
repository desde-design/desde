/**
 * Task 3 of the toolbar undo/redo plan — verifies the edit handler's write
 * lanes record a history step via `getSharedEditHistory()` on a successful
 * write, and record NOTHING when an applicator refuses upstream of any
 * write (the no-op prop edit case, matching
 * `edit-handler.backup-journal.test.ts`'s second case).
 *
 * Harness copied verbatim from `edit-handler.backup-journal.test.ts` — same
 * fixture shapes, same `ApplicatorLoaders` wiring — since this suite drives
 * the exact same `applyEdit` call sites, just asserting on
 * `getSharedEditHistory().state()` afterward instead of the backup journal.
 *
 * Task 3 fix round (review): every editor write lane records history, so
 * this file also covers the `allowCreate` new-file lane (`create: <file>`)
 * and distinguishes `writePatchedFilesThroughBroker`'s two callers by label
 * — the deterministic llm-patch fast-path (`edit: <files>`, no LLM call)
 * versus the genuine LLM-result lane (`AI edit: <files>`).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import {
  getSharedEditHistory,
  resetSharedEditHistoryForTests,
} from "../../../../src/editor/edit-service/edit-history"

const REAL_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
}

// Same rationale as edit-handler.backup-journal.test.ts's LLM_PATCH_APPLICATORS:
// loadApplySlotTextEdit is what enables the deterministic llm-patch fast-path
// (an `attr` mutation routes straight through applyPropEdit, no LLM call);
// loadApplyLLMPatch/loadStyleGrounding just need to be present to pass
// handleLLMPatch's up-front "loaders configured" gate.
let llmInvocations = 0
const LLM_FASTPATH_APPLICATORS: ApplicatorLoaders = {
  ...REAL_APPLICATORS,
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => {
        llmInvocations += 1
        return { ok: true, patchedFiles: new Map(), perMutationOutcomes: [] }
      }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
  }),
}

// Deliberately OMITS loadApplySlotTextEdit — without it the fast-path branch
// never populates `deterministicPatched`, so `handleLLMPatch` always falls
// through to the genuine `applyLLMPatch` call below. The stub returns real
// patched content (unlike the no-op-returning fast-path stub above) so the
// write actually lands and the no-op guard doesn't refuse it.
const LLM_GENUINE_APPLICATORS: ApplicatorLoaders = {
  ...REAL_APPLICATORS,
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => ({
        ok: true,
        patchedFiles: new Map([
          [
            "App.vue",
            ["<template>", '  <KEmptyState title="World" />', "</template>", ""].join("\n"),
          ],
        ]),
        perMutationOutcomes: [],
      })) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
  }),
}

describe("edit-handler — history recording from every write lane (Task 3)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-handler-history-"))
    resetSharedEditHistoryForTests()
    llmInvocations = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a successful deterministic prop edit records one history step with label "<kind>: <file>"', async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "title", value: "World" },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)

    expect(getSharedEditHistory().state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: expect.stringContaining("prop"),
    })
    expect(getSharedEditHistory().state().undoLabel).toBe("prop: App.vue")
  })

  it("a refused edit records nothing", async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    // Same value as already on disk — apply-prop-edit refuses this
    // upstream of any write, so the broker (and therefore history.record)
    // must never run.
    const body: EditRequestBody = {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "title", value: "Hello" },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(false)

    expect(getSharedEditHistory().state()).toMatchObject({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
    })
  })

  it('a successful allowCreate new-file edit records one history step labeled "create: <file>"', async () => {
    const newSource = "<template><div>fresh</div></template>\n"
    const body: EditRequestBody = {
      edit: { kind: "overwrite", file: "Fresh.vue", newSource, allowCreate: true },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)

    expect(getSharedEditHistory().state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "create: Fresh.vue",
    })
  })

  it('the llm-patch deterministic fast-path records a step labeled "edit: <files>", not "AI edit" (no LLM call happened)', async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "attr",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            target: "title",
            before: "Hello",
            after: "World",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, LLM_FASTPATH_APPLICATORS)
    expect(result.ok).toBe(true)
    expect(llmInvocations).toBe(0)

    expect(getSharedEditHistory().state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "edit: App.vue",
    })
  })

  it('a genuine LLM-authored patch records a step labeled "AI edit: <files>"', async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "class",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            target: "class",
            before: "",
            after: "text-lg",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, LLM_GENUINE_APPLICATORS)
    expect(result.ok).toBe(true)

    expect(getSharedEditHistory().state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "AI edit: App.vue",
    })
  })
})

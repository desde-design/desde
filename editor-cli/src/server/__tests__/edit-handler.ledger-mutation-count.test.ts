/**
 * Whole-branch review finding (Important, 2026-08-18): the llm-patch
 * lane's ledger entry recorded `mutationCount: ops.length`, where `ops`
 * inside `writePatchedFilesThroughBroker` is one entry per patched FILE
 * (built from `patchedFiles`, a file-keyed Map) — not per mutation. A
 * bundle of several DOM mutations landing in one file (the ordinary attr
 * fast-path shape: several inspector/contentEditable tweaks on one page
 * before a single commit) recorded `mutationCount: 1` regardless of how
 * many mutations the bundle actually carried.
 *
 * The ledger is append-only, so a wrong count here is permanent. This
 * suite pins the fix: the recorded count must come from the mutation
 * bundle itself (`mutations.length`), not from the number of files it
 * touched.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

const REAL_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
}

// Same wiring as edit-handler.history.test.ts's LLM_FASTPATH_APPLICATORS:
// loadApplySlotTextEdit is what gates entry into the deterministic
// fast-path branch at all (even for attr-only mutations); the LLM loader
// is stubbed with an invocation counter so the test can assert the LLM
// lane was never reached.
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

describe("edit-handler — llm-patch ledger entry records the mutation count", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-handler-ledger-mutcount-"))
    llmInvocations = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("a 3-mutation, 1-file attr bundle records mutationCount: 3, not the file count", async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Old title" subtitle="Old subtitle" footer="Old footer" />',
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
            before: "Old title",
            after: "New title",
          },
          {
            id: "m-2",
            kind: "attr",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            target: "subtitle",
            before: "Old subtitle",
            after: "New subtitle",
          },
          {
            id: "m-3",
            kind: "attr",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            target: "footer",
            before: "Old footer",
            after: "New footer",
          },
        ],
      },
    }

    const result = await applyEdit(body, dir, LLM_FASTPATH_APPLICATORS)
    expect(result.ok).toBe(true)
    // Confirms this exercised the deterministic fast-path (all 3 attr
    // mutations landed in App.vue), not the genuine LLM lane.
    expect(llmInvocations).toBe(0)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const entries = await readLedger(dir)
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.type).toBe("edit")
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    // One FILE touched...
    expect(entry.files).toEqual(["App.vue"])
    // ...but three MUTATIONS bundled into it. Before the fix this was
    // `{ mutationCount: 1 }` (files.length via `ops.length`).
    expect(entry.fields).toEqual({ mutationCount: 3 })
  })
})

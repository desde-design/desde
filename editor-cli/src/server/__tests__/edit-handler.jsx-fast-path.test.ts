/**
 * CLI fast-path tests for React/JSX (M4). The commit-time deterministic
 * fast-path now routes per-file by extension: a `.tsx`/`.jsx` text mutation
 * goes to applyJsxSlotTextEdit and an attr mutation to applyJsxPropEdit, with
 * the Vue applicators reserved for `.vue`. A shape the JSX text applicator
 * can't handle (e.g. an interpolation child) bails to the LLM lane.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

let llmInvocations = 0

const REACT_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyJsxSlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-slot-text-edit"),
  loadApplyJsxPropEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-prop-edit"),
  loadInferAttrFromTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
  loadInferAttrFromJsxTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-jsx-text-edit"),
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

const APP_TSX = `export default function App() {
  return (
    <span className="cta">Save</span>
  )
}
`
// <span> opening tag: line 3, indented 4 → column 4.

describe("CLI fast-path — React/JSX", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-jsx-fastpath-"))
    llmInvocations = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("rewrites a .tsx text mutation via applyJsxSlotTextEdit, skipping the LLM", async () => {
    writeFileSync(join(dir, "App.tsx"), APP_TSX)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.tsx:3:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".cta",
            before: "Save",
            after: "Submit",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, REACT_APPLICATORS)
    expect(result.ok).toBe(true)
    const written = readFileSync(join(dir, "App.tsx"), "utf8")
    expect(written).toContain('<span className="cta">Submit</span>')
    expect(llmInvocations).toBe(0)
  })

  it("rewrites a .tsx attr mutation via applyJsxPropEdit, skipping the LLM", async () => {
    writeFileSync(join(dir, "App.tsx"), APP_TSX)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "attr",
            target: "className",
            sourceLoc: "App.tsx:3:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".cta",
            before: "cta",
            after: "cta-active",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, REACT_APPLICATORS)
    expect(result.ok).toBe(true)
    const written = readFileSync(join(dir, "App.tsx"), "utf8")
    expect(written).toContain('<span className="cta-active">Save</span>')
    expect(llmInvocations).toBe(0)
  })

  it("recovers prop-rendered text via the JSX text→attr inferrer, skipping the LLM", async () => {
    // The host renders its label from a prop, so there's no JSX text child to
    // edit — the slot-text applicator refuses and the inferrer re-routes to the
    // prop applicator deterministically.
    const propRendered = `export default function App() {
  return (
    <Button label="Save" variant="primary" />
  )
}
`
    writeFileSync(join(dir, "App.tsx"), propRendered)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.tsx:3:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".btn",
            before: "Save",
            after: "Submit",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, REACT_APPLICATORS)
    expect(result.ok).toBe(true)
    const written = readFileSync(join(dir, "App.tsx"), "utf8")
    expect(written).toContain('<Button label="Submit" variant="primary" />')
    expect(llmInvocations).toBe(0)
  })

  it("bails to the LLM when the JSX text shape can't be statically rewritten (interpolation)", async () => {
    const withInterp = `export default function App({ n }: { n: number }) {
  return (
    <span className="cta">Count {n}</span>
  )
}
`
    writeFileSync(join(dir, "App.tsx"), withInterp)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.tsx:3:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".cta",
            before: "Count",
            after: "Total",
          },
        ],
      },
    }
    await applyEdit(body, dir, REACT_APPLICATORS)
    expect(llmInvocations).toBe(1)
  })
})

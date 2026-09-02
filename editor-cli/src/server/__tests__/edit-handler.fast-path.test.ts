/**
 * CLI fast-path tests. Mirrors the web route's
 * `route.llm-patch.test.ts` deterministic fast-path coverage so the two
 * dispatchers stay behavior-identical (CLAUDE.md verification step 7).
 *
 * Specifically pins the prop-rendered-text recovery: when the bridge
 * captures a `kind: "text"` mutation on a component that renders its
 * text from a prop (e.g. `<KEmptyState title="…" />`),
 * `inferAttrFromTextEdit` should locate the attribute and re-route the
 * mutation through `applyPropEdit` without invoking the LLM.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

let llmInvocations = 0

const REAL_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadInferAttrFromTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
  // Stub the LLM loader — the whole point of the fast-path is that we
  // never reach this. Increment a counter when called so the test can
  // assert non-invocation.
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => {
        llmInvocations += 1
        return {
          ok: true,
          patchedFiles: new Map(),
          perMutationOutcomes: [],
        }
      }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({
      tokens: [],
      classTaxonomy: [],
      preprocessor: "css" as const,
    }),
  }),
}

describe("CLI handler deterministic fast-path — text→attr inference", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-fastpath-"))
    llmInvocations = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("rewrites a prop-rendered text edit via applyPropEdit and skips the LLM", async () => {
    const original = [
      "<template>",
      "  <KEmptyState",
      '    title="No data plane nodes"',
      '    message="Add a data plane node."',
      "  >",
      "    <template #icon><span /></template>",
      "  </KEmptyState>",
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
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "No data plane nodes",
            after: "Data planes are scalable and self-managed.",
          },
        ],
      },
    }

    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)

    const written = readFileSync(join(dir, "App.vue"), "utf8")
    expect(written).toContain('title="Data planes are scalable and self-managed."')
    expect(written).not.toContain("No data plane nodes")
    expect(llmInvocations).toBe(0)
  })

  it("falls through to the LLM when no static attr matches before", async () => {
    // `before` doesn't match any static attribute. The inferrer
    // refuses, the fast-path bails, the LLM lane takes over.
    const original = [
      "<template>",
      "  <KEmptyState",
      '    title="Other title"',
      '    message="Other message"',
      "  >",
      "    <template #icon><span /></template>",
      "  </KEmptyState>",
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
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "Nothing matches this string",
            after: "Whatever",
          },
        ],
      },
    }

    await applyEdit(body, dir, REAL_APPLICATORS)
    expect(llmInvocations).toBe(1)
  })

  it("falls through to the LLM when two static attrs share the value (genuinely ambiguous)", async () => {
    // Two attrs with the same value — the heuristic can't tell which
    // is the real text source, so it must refuse and let the LLM lane
    // decide. Pinned separately from the no-match case so an
    // unintended widening of inferAttrFromTextEdit can't silently make
    // ambiguity matches succeed.
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" message="Hello" />',
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
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "Hello",
            after: "World",
          },
        ],
      },
    }

    await applyEdit(body, dir, REAL_APPLICATORS)
    expect(llmInvocations).toBe(1)
  })

  it("refuses with 422 when the LLM lane returns a no-op patch (matches originals byte-for-byte)", async () => {
    // The user-reported bug: bridge sends a text mutation whose
    // `before` doesn't match any source literal (e.g. library-rendered
    // text rendered by a bound prop). Deterministic fast-path refuses,
    // LLM lane runs and returns the originals unchanged. Without the
    // no-op guard the handler would write the file (a no-op) and
    // return ok, surfacing "Saved 1 DOM mutation(s)" to the designer
    // while nothing on disk actually changed.
    const original = [
      "<template>",
      '  <KEmptyState :title="pageTitle" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    let noopLLMInvocations = 0
    const loadersWithNoopLLM: ApplicatorLoaders = {
      ...REAL_APPLICATORS,
      loadApplyLLMPatch: async () => ({
        applyLLMPatch: (async (args: { files: Map<string, string> }) => {
          noopLLMInvocations += 1
          // Return the inputs unchanged — the "model refused / no-op"
          // case the guard exists to catch.
          return {
            ok: true,
            patchedFiles: new Map(args.files),
            perMutationOutcomes: [
              { mutationId: "m-1", outcome: "refused", reason: "no source change" },
            ],
          }
        }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
        parseSourceLocFile: () => null,
        isCrossFileInstanceEdit: () => false,
        patchFileFor: () => ({ ok: false, reason: "stub" }),
      }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
    }

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "Whatever the bridge captured",
            after: "Something new",
          },
        ],
      },
    }

    const result = await applyEdit(body, dir, loadersWithNoopLLM)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.reason).toMatch(/no source changes/i)
    expect(noopLLMInvocations).toBe(1)

    // File on disk must be unchanged — guard fires BEFORE writes.
    const onDisk = readFileSync(join(dir, "App.vue"), "utf8")
    expect(onDisk).toBe(original)
  })

  it("escalates to chat (needsChat, no LLM) when llmFallback='chat' and the deterministic lane refuses", async () => {
    // `'chat'` fallback mode: a non-deterministic text edit (before
    // doesn't match any static attr) must short-circuit with
    // needsChat:true and NEVER invoke the LLM patch lane — the client
    // hands the edit to the chat agent instead.
    const original = [
      "<template>",
      '  <KEmptyState title="Other title" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        llmFallback: "chat",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "Nothing matches this string",
            after: "Whatever",
          },
        ],
      },
    }

    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    expect(llmInvocations).toBe(0)
    // File untouched — escalation writes nothing.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(original)
  })

  it("still applies deterministically (no escalation) when llmFallback='chat' and the fast-path handles it", async () => {
    // Escalation must NOT pre-empt the deterministic lane: a
    // prop-rendered text edit that infers cleanly still applies in
    // sub-100ms, with no needsChat and no LLM, even in chat mode.
    const original = [
      "<template>",
      '  <KEmptyState title="No data plane nodes" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        llmFallback: "chat",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "No data plane nodes",
            after: "Renamed",
          },
        ],
      },
    }

    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)
    expect(result.needsChat).toBeUndefined()
    expect(llmInvocations).toBe(0)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain('title="Renamed"')
  })

  it("falls through to the LLM when loadInferAttrFromTextEdit is not provided (back-compat parity)", async () => {
    // Pins the documented optional-loader behavior: a consumer that
    // hasn't been updated to pass loadInferAttrFromTextEdit gets the
    // same outcome as before the feature existed — i.e. the text
    // refusal drags the batch into the LLM lane (no silent skip, no
    // crash). Production wiring at edit-handler.ts:1053 always
    // includes the loader; this guards against future drift.
    const original = [
      "<template>",
      '  <KEmptyState title="No data plane nodes" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const loadersWithoutInferrer: ApplicatorLoaders = {
      ...REAL_APPLICATORS,
      loadInferAttrFromTextEdit: undefined,
    }

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            before: "No data plane nodes",
            after: "Data planes are scalable and self-managed.",
          },
        ],
      },
    }

    await applyEdit(body, dir, loadersWithoutInferrer)
    expect(llmInvocations).toBe(1)
  })
})

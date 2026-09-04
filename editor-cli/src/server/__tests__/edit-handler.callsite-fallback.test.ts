/**
 * The consumer-callsite fallback rung in the deterministic text lane.
 *
 * WHY IT EXISTS. `sourceLoc` is the DOM anchor — the JSX/template node that
 * DREW the element — because the scoped-CSS lane emits it as a
 * `[data-desde-src="…"]` rule head and needs a coordinate that is really on an
 * element. The text lane wants a different fact: where the bytes of this text
 * live. On Vue the two coincide, because attribute fallthrough puts the
 * PARENT's stamp on a component root. On React they diverge for every
 * first-party wrapper, because the JSX stamper deliberately writes its own
 * attribute AFTER `{...props}` so the wrapper's stamp survives the spread
 * (`jsx-source-tag-plugin.ts`). The anchor then names `<Comp {...props} />`
 * inside `button.tsx`, which has no text child, and the whole deterministic
 * lane refuses.
 *
 * MEASURED on a canonical shadcn app, 2026-08-16
 * (`tasks/react-hint-generation-phase0.md` § 7.8.1): 4 of 61 text edits landed
 * without this rung, 19 of 61 with it.
 *
 * WHAT THESE TESTS PIN, in order of what would hurt most if it broke:
 *   1. the fallback fires and lands at the user's own callsite
 *   2. it stays a FALLBACK — a working direct rung is never overridden
 *   3. a wrong callsite REFUSES rather than editing the wrong bytes
 *   4. two mutations falling back into one file both survive (no clobber)
 *   5. it is framework-neutral, not a React special case
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import type { ChatHandlerLoaders } from "../chat-handler.js"

let llmInvocations = 0

const APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySlotTextEdit: () => import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyJsxSlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-slot-text-edit"),
  loadApplyJsxPropEdit: () => import("../../../../src/editor/edit-service/apply-jsx-prop-edit"),
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

/** The shadcn shape: a wrapper that renders a host element and spreads props. */
const BUTTON_TSX = [
  "export function Button({ className, ...props }) {",
  "  return <button className={className} {...props} />",
  "}",
  "",
].join("\n")
// `<button` — line 2, column 9 (Babel: 1-based line, 0-based column).

const APP_TSX = [
  'import { Button } from "./Button"',
  "export default function App() {",
  "  return (",
  '    <Button className="cta">Save</Button>',
  "  )",
  "}",
  "",
].join("\n")
// `<Button` — line 4, column 4.

function textMutation(over: Record<string, unknown>): EditRequestBody {
  return {
    edit: {
      kind: "llm-patch",
      mutations: [
        {
          id: "m-1",
          kind: "text",
          sourceLoc: "Button.tsx:2:9",
          resolutionKind: "direct",
          scope: "definition",
          callsiteLoc: "App.tsx:4:4",
          instancePath: "[0]",
          selector: ".cta",
          before: "Save",
          after: "Submit",
          ...over,
        },
      ],
    },
  } as EditRequestBody
}

describe("deterministic text lane — consumer-callsite fallback", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-callsite-fallback-"))
    llmInvocations = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("lands at the user's callsite when the anchor's own element has no text child", async () => {
    writeFileSync(join(dir, "Button.tsx"), BUTTON_TSX)
    writeFileSync(join(dir, "App.tsx"), APP_TSX)

    const result = await applyEdit(textMutation({}), dir, APPLICATORS)

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.tsx"), "utf8")).toContain(
      '<Button className="cta">Submit</Button>',
    )
    // The wrapper is not the place the designer typed. It must be untouched.
    expect(readFileSync(join(dir, "Button.tsx"), "utf8")).toBe(BUTTON_TSX)
    expect(llmInvocations).toBe(0)
  })

  it("does NOT override a working direct rung", async () => {
    // The anchor itself holds the text. `callsiteLoc` also points at editable
    // text, so a fallback that ran unconditionally would edit the wrong file
    // and this test would catch it.
    writeFileSync(join(dir, "Leaf.tsx"), ["export const Leaf = () => (", '  <p>Save</p>', ")", ""].join("\n"))
    writeFileSync(join(dir, "App.tsx"), APP_TSX)

    const result = await applyEdit(
      textMutation({ sourceLoc: "Leaf.tsx:2:2", callsiteLoc: "App.tsx:4:4" }),
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "Leaf.tsx"), "utf8")).toContain("<p>Submit</p>")
    expect(readFileSync(join(dir, "App.tsx"), "utf8")).toBe(APP_TSX)
  })

  it("refuses to the LLM lane when the callsite's text does not match `before`", async () => {
    // This is the whole safety argument: the applicators re-check the captured
    // `before` at the new position, so a wrong callsite cannot write.
    writeFileSync(join(dir, "Button.tsx"), BUTTON_TSX)
    writeFileSync(
      join(dir, "App.tsx"),
      APP_TSX.replace('<Button className="cta">Save</Button>', '<Button className="cta">Other</Button>'),
    )

    const before = readFileSync(join(dir, "App.tsx"), "utf8")
    // The stubbed LLM returns an empty patch, which the no-op guard rejects —
    // so the assertion is "the deterministic lane declined", not `result.ok`.
    await applyEdit(textMutation({}), dir, APPLICATORS)

    expect(llmInvocations).toBe(1)
    expect(readFileSync(join(dir, "App.tsx"), "utf8")).toBe(before)
    expect(readFileSync(join(dir, "Button.tsx"), "utf8")).toBe(BUTTON_TSX)
  })

  it("never uses the fallback for an empty `before` (the needle would match too easily)", async () => {
    writeFileSync(join(dir, "Button.tsx"), BUTTON_TSX)
    writeFileSync(join(dir, "App.tsx"), APP_TSX)

    await applyEdit(textMutation({ before: "   " }), dir, APPLICATORS)

    expect(llmInvocations).toBe(1)
    expect(readFileSync(join(dir, "App.tsx"), "utf8")).toBe(APP_TSX)
  })

  it("keeps both edits when two mutations fall back into the SAME file", async () => {
    // The regression this guards: the pre-fallback code held one `source`
    // string per file inside a group-by-file loop. Two mutations landing in a
    // file that was nobody's primary target would each start from the pristine
    // text, and the second write would silently drop the first.
    writeFileSync(join(dir, "Button.tsx"), BUTTON_TSX)
    const twoButtons = [
      'import { Button } from "./Button"',
      "export default function App() {",
      "  return (",
      "    <div>",
      '      <Button className="a">Save</Button>',
      '      <Button className="b">Cancel</Button>',
      "    </div>",
      "  )",
      "}",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.tsx"), twoButtons)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1", kind: "text", sourceLoc: "Button.tsx:2:9", resolutionKind: "direct",
            scope: "definition", callsiteLoc: "App.tsx:5:6", instancePath: "[0]",
            selector: ".a", before: "Save", after: "Submit",
          },
          {
            id: "m-2", kind: "text", sourceLoc: "Button.tsx:2:9", resolutionKind: "direct",
            scope: "definition", callsiteLoc: "App.tsx:6:6", instancePath: "[0]",
            selector: ".b", before: "Cancel", after: "Dismiss",
          },
        ],
      },
    } as EditRequestBody

    const result = await applyEdit(body, dir, APPLICATORS)

    expect(result.ok).toBe(true)
    const written = readFileSync(join(dir, "App.tsx"), "utf8")
    expect(written).toContain('<Button className="a">Submit</Button>')
    expect(written).toContain('<Button className="b">Dismiss</Button>')
    expect(llmInvocations).toBe(0)
  })

  it("is framework-neutral — the same rung recovers a Vue slot-text edit", async () => {
    writeFileSync(
      join(dir, "Card.vue"),
      ["<template>", '  <div class="body"><slot /></div>', "</template>", ""].join("\n"),
    )
    writeFileSync(
      join(dir, "App.vue"),
      ["<template>", "  <Card>Hello</Card>", "</template>", ""].join("\n"),
    )

    const result = await applyEdit(
      textMutation({
        sourceLoc: "Card.vue:2:3",
        callsiteLoc: "App.vue:2:3",
        before: "Hello",
        after: "Goodbye",
      }),
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain("<Card>Goodbye</Card>")
    expect(llmInvocations).toBe(0)
  })
})

const PROP_EDIT_ORIGINAL_SOURCE = [
  "<template>",
  '  <UiInput :placeholder="filterPlaceholder" />',
  "</template>",
  "<script setup>",
  "const filterPlaceholder = 'Search...'",
  "</script>",
  "",
].join("\n")

const propEditBodyThatRefuses: EditRequestBody = {
  edit: {
    kind: "prop",
    file: "App.vue",
    line: 2,
    column: 3,
    propName: "placeholder",
    value: "Filter results",
  },
} as EditRequestBody

/**
 * The interim behaviour was an inline capability refusal keyed on
 * `llmProviderId`, because reaching for Anthropic credentials the user never
 * gave is worse than declining. That trade is over: the mini-turn now
 * resolves the same runtime chat does, for ANY project provider, rather than
 * refusing everything but Anthropic (see Task 43,
 * `src/editor/agent-chat-sdk/edit-fix-mini-turn.ts`'s module doc).
 */
describe("the edit-fix mini-turn runs on the project's own provider", () => {
  let dir: string
  const applicatorLoaders: ApplicatorLoaders = {
    ...APPLICATORS,
    loadApplyPropEdit: async () => ({
      applyPropEdit: () => ({
        ok: false,
        reason: 'Cannot overwrite bound prop "placeholder" — source uses v-bind.',
        fallback: { kind: "bound-binding" as const, expression: "filterPlaceholder" },
      }),
    }),
  } as ApplicatorLoaders

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-mini-turn-provider-gate-"))
    writeFileSync(join(dir, "App.vue"), PROP_EDIT_ORIGINAL_SOURCE)
    // Branch mode is git-native, and the mini-turn refuses to run when the
    // working state can't be snapshotted (its cross-file writes would be
    // unverifiable) — the fixture must be a real repo like every prototype.
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"],
      { cwd: dir },
    )
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: dir },
    )
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs for an OpenAI project instead of refusing with a capability message", async () => {
    const seen: Array<{ model?: string; providerId?: string }> = []
    const loadRunEditFixMiniTurn = vi.fn(async () => ({
      runEditFixMiniTurn: async (input: { model?: string; providerId?: string }) => {
        seen.push({ model: input.model, providerId: input.providerId })
        return { outcome: "refused" as const, notes: "not the point of this test" }
      },
    }))
    const result = await applyEdit(
      propEditBodyThatRefuses,
      dir,
      { ...applicatorLoaders, loadRunEditFixMiniTurn } as unknown as ApplicatorLoaders,
      undefined,
      { llmProviderId: "openai" },
    )
    expect(loadRunEditFixMiniTurn).toHaveBeenCalled()
    expect(seen).toEqual([{ model: "gpt-5.6", providerId: "openai" }])
    expect(JSON.stringify(result)).not.toMatch(/capability/i)
  })

  it("still runs for an Anthropic project", async () => {
    const loadRunEditFixMiniTurn = vi.fn(async () => ({
      runEditFixMiniTurn: async () => ({ outcome: "refused" as const, notes: "no change" }),
    }))
    await applyEdit(
      propEditBodyThatRefuses,
      dir,
      { ...applicatorLoaders, loadRunEditFixMiniTurn } as unknown as ApplicatorLoaders,
      undefined,
      { llmProviderId: "anthropic" },
    )
    expect(loadRunEditFixMiniTurn).toHaveBeenCalled()
  })

  it("a refused chat runtime answers with a clean refusal, not a throw", async () => {
    vi.stubEnv("EDITOR_NEUTRAL_CHAT", "0")
    try {
      const loadRunEditFixMiniTurn = vi.fn(async () => ({
        runEditFixMiniTurn: async () => {
          throw new Error("should not be called — resolveChatRuntime refuses first")
        },
      }))
      const loadRunChatTurnNeutral = vi.fn(async () => {
        throw new Error("should not be called — resolveChatRuntime refuses before any loader runs")
      })
      const result = await applyEdit(
        propEditBodyThatRefuses,
        dir,
        { ...applicatorLoaders, loadRunEditFixMiniTurn } as unknown as ApplicatorLoaders,
        undefined,
        {
          llmProviderId: "openai",
          chatLoaders: { loadRunChatTurnNeutral } as unknown as ChatHandlerLoaders,
        },
      )
      expect(result.ok).toBe(false)
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.status).toBeLessThan(500)
      expect(result.reason).toMatch(/neutral|turned off|not available/i)
      expect(JSON.stringify(result)).not.toMatch(/at .*\.ts:\d+/)
      expect(loadRunChatTurnNeutral).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

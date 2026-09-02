/**
 * Phase 3 Task 6 (app-token mtime invalidation, Phase 2 carry-forward I1).
 *
 * The CLI's `handleLLMPatch` memoizes `ProjectStyleContext` at module scope,
 * keyed on `repoRoot` alone before this change — a stylesheet edit mid-session
 * fed a stale token list into every subsequent LLM-patch call until the CLI
 * restarted. The fix fetches tokens BEFORE the memo check and folds a cheap
 * fingerprint of the fetched token list into the memo key
 * (`${rootReal}::${fingerprint}`), so a different token list for the SAME
 * root busts the cache instead of reusing the previous style context.
 *
 * This test drives that through the real `applyEdit` → `handleLLMPatch` path
 * (not a unit test of the private fingerprint helper, which isn't exported),
 * using a `getGrounding` stub whose token list the test controls per-call and
 * a `loadStyleGrounding` stub instrumented to record how many times — and
 * with what token lists — it was actually invoked.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { applyEdit, type ApplicatorLoaders, type EditRequestBody, type ApplyEditOpts } from "../edit-handler.js"
import type { DesignToken } from "../../../../src/editor/core/design-tokens"

// A `text` mutation whose `before` matches nothing in source — the
// deterministic fast-path (inferAttrFromTextEdit) refuses, so every call
// falls through to `handleLLMPatch`'s LLM lane and reaches the
// projectStyleContext memo. Mirrors the "falls through to the LLM" fixture
// in edit-handler.fast-path.test.ts.
const MUTATION_BODY = (): EditRequestBody => ({
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
})

function makeGrounding(tokens: DesignToken[]): ApplyEditOpts["getGrounding"] {
  return async () =>
    ({
      tokens: { listTokens: async () => tokens } as unknown,
    }) as Awaited<ReturnType<NonNullable<ApplyEditOpts["getGrounding"]>>>
}

describe("CLI handler — projectStyleContext memo keyed on token fingerprint", () => {
  let dir: string
  let styleGroundingCalls: DesignToken[][]

  function loaders(): ApplicatorLoaders {
    return {
      loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
      loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
      loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
      loadApplySlotTextEdit: () =>
        import("../../../../src/editor/edit-service/apply-slot-text-edit"),
      loadInferAttrFromTextEdit: () =>
        import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
      loadApplyLLMPatch: async () =>
        ({
          applyLLMPatch: (async () => ({
            ok: true,
            patchedFiles: new Map(),
            perMutationOutcomes: [],
          })) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
          parseSourceLocFile: () => null,
          isCrossFileInstanceEdit: () => false,
          patchFileFor: () => ({ ok: false, reason: "stub" }),
        }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
      loadStyleGrounding: async () => ({
        loadStyleGrounding: (opts: { tokens: readonly DesignToken[] }) => {
          styleGroundingCalls.push([...opts.tokens])
          return { tokens: [...opts.tokens], classTaxonomy: [], preprocessor: "css" as const }
        },
      }),
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-style-context-memo-"))
    writeFileSync(
      join(dir, "App.vue"),
      ["<template>", '  <KEmptyState title="Other title" />', "</template>", ""].join("\n"),
    )
    styleGroundingCalls = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("re-derives the style context when the fetched token list changes for the SAME root", async () => {
    const tokensV1: DesignToken[] = [
      { name: "--color-primary", value: "#0044f4", category: "color", source: "app-stylesheets" },
    ]
    const tokensV2: DesignToken[] = [
      { name: "--color-primary", value: "#123456", category: "color", source: "app-stylesheets" },
    ]

    await applyEdit(MUTATION_BODY(), dir, loaders(), undefined, {
      getGrounding: makeGrounding(tokensV1),
    })
    // Same root, DIFFERENT token value (a stylesheet edit mid-session) — the
    // fingerprint must change and bust the memo instead of replaying the v1
    // style context.
    await applyEdit(MUTATION_BODY(), dir, loaders(), undefined, {
      getGrounding: makeGrounding(tokensV2),
    })

    expect(styleGroundingCalls).toHaveLength(2)
    expect(styleGroundingCalls[0]).toEqual(tokensV1)
    expect(styleGroundingCalls[1]).toEqual(tokensV2)
  })

  it("reuses the cached style context when the token list is unchanged for the SAME root", async () => {
    const tokens: DesignToken[] = [
      { name: "--color-primary", value: "#0044f4", category: "color", source: "app-stylesheets" },
    ]

    await applyEdit(MUTATION_BODY(), dir, loaders(), undefined, {
      getGrounding: makeGrounding(tokens),
    })
    await applyEdit(MUTATION_BODY(), dir, loaders(), undefined, {
      getGrounding: makeGrounding(tokens),
    })

    // loadStyleGrounding is only invoked on a memo MISS — an unchanged
    // fingerprint for the same root should short-circuit the second call.
    expect(styleGroundingCalls).toHaveLength(1)
  })
})

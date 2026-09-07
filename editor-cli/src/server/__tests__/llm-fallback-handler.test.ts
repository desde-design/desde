/**
 * Tests for the React-enabling changes to the Tier 2 repair endpoint
 * (`handleLLMFallback`): `.tsx`/`.jsx` files are now repairable, and the
 * intent validator accepts 0-based JSX columns (Babel convention) — a
 * column-0 React target must not 400 before the repair lane runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  handleLLMFallback,
  type LLMFallbackLoaders,
  type LLMFallbackRequestBody,
} from "../llm-fallback-handler"

const REWRITTEN = "export default function App() {\n  return <main>repaired</main>\n}\n"

// Stub the repair service so no LLM call happens — we only exercise the
// endpoint's gates (extension + intent validation + path containment).
const loaders: LLMFallbackLoaders = {
  // Cast because the loader's type is the WHOLE module and this stub is only
  // the one function the handler calls. `repair-edit` also exports its
  // response schema (read by `ai-sdk-strict-schema.test.ts`), which a stub
  // has no business reproducing.
  loadApplyRepairEdit: async () =>
    ({
      applyRepairEdit: async () => ({
        ok: true as const,
        newSource: REWRITTEN,
        originalSourceHash: "deadbeef",
        explanation: "stubbed repair",
      }),
    }) as unknown as Awaited<ReturnType<NonNullable<LLMFallbackLoaders["loadApplyRepairEdit"]>>>,
}

describe("handleLLMFallback — React (.tsx/.jsx) support", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-fallback-react-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function body(overrides: Partial<LLMFallbackRequestBody> = {}): LLMFallbackRequestBody {
    return {
      file: "App.tsx",
      intent: {
        kind: "delete",
        description: "Delete <button>",
        sourceLine: 2,
        sourceColumn: 0, // 0-based Babel column — a top-level, unindented element
      },
      errorReason: "No JSX element found at 2:0",
      ...overrides,
    }
  }

  it("repairs a .tsx file (no longer Vue-only) and accepts a 0-based column", async () => {
    writeFileSync(join(dir, "App.tsx"), "export default function App() {\n<button/>\n}\n")
    const r = await handleLLMFallback(body(), dir, loaders)
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.proposal?.newSource).toBe(REWRITTEN)
  })

  it("repairs a .jsx file", async () => {
    writeFileSync(join(dir, "Card.jsx"), "export default function Card() {\n  return <div/>\n}\n")
    const r = await handleLLMFallback(body({ file: "Card.jsx" }), dir, loaders)
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
  })

  it("still rejects unsupported extensions", async () => {
    writeFileSync(join(dir, "styles.css"), ".x{}")
    const r = await handleLLMFallback(body({ file: "styles.css" }), dir, loaders)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.reason).toMatch(/Only \.vue, \.tsx, and \.jsx/)
  })

  it("rejects a negative column (still guards garbage input)", async () => {
    writeFileSync(join(dir, "App.tsx"), "export default function App() {\n<button/>\n}\n")
    const r = await handleLLMFallback(body({
      intent: {
        kind: "delete",
        description: "Delete <button>",
        sourceLine: 2,
        sourceColumn: -1,
      },
    }), dir, loaders)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.reason).toMatch(/non-negative integer/)
  })

  it("still rejects a 0 LINE (lines are 1-based in both frameworks)", async () => {
    writeFileSync(join(dir, "App.tsx"), "export default function App() {\n<button/>\n}\n")
    const r = await handleLLMFallback(body({
      intent: {
        kind: "delete",
        description: "Delete <button>",
        sourceLine: 0,
        sourceColumn: 0,
      },
    }), dir, loaders)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.reason).toMatch(/positive integer/)
  })
})

describe("handleLLMFallback — iteration-data lane (F-11)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-fallback-iter-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const ITER_SOURCE = "<script setup>const rows=[{key:'a'}]</script>\n<template><li v-for=\"r in rows\" :key=\"r.key\">{{ r.key }}</li></template>\n"
  const ITER_REWRITTEN = ITER_SOURCE.replace("key:'a'", "key:'a-2'")

  const iterationLoaders: LLMFallbackLoaders = {
    ...loaders,
    loadApplyIterationDataLlm: async () =>
      ({
        applyIterationDataLlm: async () => ({
          ok: true as const,
          newSource: ITER_REWRITTEN,
          originalSourceHash: "cafebabe",
          explanation: "stubbed iteration edit",
        }),
      }) as unknown as Awaited<
        ReturnType<NonNullable<LLMFallbackLoaders["loadApplyIterationDataLlm"]>>
      >,
  }

  function iterationBody(
    overrides: Partial<LLMFallbackRequestBody> = {},
  ): LLMFallbackRequestBody {
    return {
      file: "List.vue",
      intent: {
        kind: "iteration-data",
        description: "Set the text of item a",
        templateLocation: { file: "List.vue", line: 2, column: 11 },
        iterationContext: { source: "v-for" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
        pageSourceFile: null,
        payload: { operation: "patch-text", value: "A2" },
      },
      // Deliberately no errorReason: the static resolver's soft refusal never
      // leaves that endpoint, and requiring one here is exactly the wire
      // mismatch that kept this lane dead (finding F-11). This test fails
      // against the old validator, which returned "body.errorReason required".
      ...overrides,
    }
  }

  it("refuses a .tsx target rather than sending JSX to the Vue prompt", async () => {
    // `isRepairableSource` admits .vue/.tsx/.jsx because the REPAIR lane
    // handles all three and picks its prompt by extension. This lane has one
    // prompt, and it opens "You are a Vue 3 SFC iteration-aware editor". A
    // TSX file reaching it would get a refusal the user cannot act on, or a
    // full-file rewrite from a prompt that misread the file. Found by a codex
    // review; fails against the ungated version, which returned 200 with a
    // proposal.
    writeFileSync(join(dir, "List.tsx"), "export const rows = [{ key: 'a' }]\n")
    const r = await handleLLMFallback(
      iterationBody({
        file: "List.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the text of item a",
          templateLocation: { file: "List.tsx", line: 1, column: 1 },
          iterationContext: { source: "map" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      iterationLoaders,
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(422)
    expect(r.reason).toMatch(/only supported in Vue single-file components/)
  })

  it("accepts an iteration-data request WITHOUT errorReason and returns the proposal with its target file", async () => {
    writeFileSync(join(dir, "List.vue"), ITER_SOURCE)
    const r = await handleLLMFallback(iterationBody(), dir, iterationLoaders)
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.proposal?.newSource).toBe(ITER_REWRITTEN)
    expect(r.proposal?.baseHash).toBe("cafebabe")
    expect(r.proposal?.file).toBe("List.vue")
  })

  it("still requires errorReason for the structural-repair kinds", async () => {
    writeFileSync(join(dir, "App.tsx"), "export default () => <div/>\n")
    const r = await handleLLMFallback(
      {
        file: "App.tsx",
        intent: {
          kind: "delete",
          description: "Delete <div>",
          sourceLine: 1,
          sourceColumn: 0,
        },
      } as LLMFallbackRequestBody,
      dir,
      iterationLoaders,
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.reason).toMatch(/errorReason required/)
  })

  it("400s an iteration-data request whose payload has no operation", async () => {
    writeFileSync(join(dir, "List.vue"), ITER_SOURCE)
    const bad = iterationBody()
    ;(bad.intent as { payload: unknown }).payload = { value: "A2" }
    const r = await handleLLMFallback(bad, dir, iterationLoaders)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.reason).toMatch(/payload\.operation required/)
  })

  it("500s naming the gap when the iteration loader is not configured", async () => {
    writeFileSync(join(dir, "List.vue"), ITER_SOURCE)
    const r = await handleLLMFallback(iterationBody(), dir, loaders)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
    expect(r.reason).toMatch(/iteration-data LLM lane loader not configured/)
  })
})

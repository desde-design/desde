/**
 * Tests for the React-enabling changes to the Tier 2 repair endpoint
 * (`handleLLMFallback`): `.tsx`/`.jsx` files are now repairable, and the
 * intent validator accepts 0-based JSX columns (Babel convention) — a
 * column-0 React target must not 400 before the repair lane runs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  handleLLMFallback,
  type LLMFallbackLoaders,
  type LLMFallbackRequestBody,
} from "../llm-fallback-handler"
import type { IterationDataPromptFile } from "../../../../src/editor/edit-service/iteration-data-prompt.js"

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
  let capturedBundles: IterationDataPromptFile[][]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-fallback-iter-"))
    capturedBundles = []
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write a file, creating any missing parent directories. */
  function write(relPath: string, content: string): void {
    const full = join(dir, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  const ITER_SOURCE = "<script setup>const rows=[{key:'a'}]</script>\n<template><li v-for=\"r in rows\" :key=\"r.key\">{{ r.key }}</li></template>\n"
  const ITER_REWRITTEN = ITER_SOURCE.replace("key:'a'", "key:'a-2'")

  const iterationLoaders: LLMFallbackLoaders = {
    ...loaders,
    loadApplyIterationDataLlm: async () =>
      ({
        applyIterationDataLlm: async (input: { files: IterationDataPromptFile[] }) => {
          capturedBundles.push(input.files)
          return {
            ok: true as const,
            file: "List.vue",
            newSource: ITER_REWRITTEN,
            originalSourceHash: "cafebabe",
            explanation: "stubbed iteration edit",
          }
        },
      }) as unknown as Awaited<
        ReturnType<NonNullable<LLMFallbackLoaders["loadApplyIterationDataLlm"]>>
      >,
  }

  /** A stub that names `fileName` (falling back to the first bundled file) as
   *  the file it rewrote, so tests can assert `proposal.file` echoes it back. */
  function loadersNaming(fileName?: string): LLMFallbackLoaders {
    return {
      ...loaders,
      loadApplyIterationDataLlm: async () =>
        ({
          applyIterationDataLlm: async (input: { files: IterationDataPromptFile[] }) => {
            capturedBundles.push(input.files)
            const target =
              (fileName !== undefined ? input.files.find((f) => f.path === fileName) : undefined) ??
              input.files[0]
            return {
              ok: true as const,
              file: target.path,
              newSource: `${target.source}\n// edited`,
              originalSourceHash: "cafebabe",
              explanation: "stubbed iteration edit",
            }
          },
        }) as unknown as Awaited<
          ReturnType<NonNullable<LLMFallbackLoaders["loadApplyIterationDataLlm"]>>
        >,
    }
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

  it("accepts a .tsx loop file (no per-framework gate any more) and bundles the import chain", async () => {
    // Until 2026-09-08 this lane refused any non-.vue target because it had
    // one Vue-only prompt. The prompt is now framework-agnostic and the
    // handler assembles a bundle instead of gating on extension, so a React
    // loop file is accepted like Vue is.
    write(
      "src/pages/overview.tsx",
      'import { METRICS } from "../data"\nexport default function Overview() {\n  return <ul>{METRICS.map((m) => <li key={m.id}>{m.name}</li>)}</ul>\n}\n',
    )
    write("src/data.ts", 'export const METRICS = [{ id: 1, name: "a" }]\n')

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/pages/overview.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the name of item 1",
          templateLocation: { file: "src/pages/overview.tsx", line: 3, column: 20 },
          iterationContext: { source: "map" as const, key: 1, index: 0, siblingCount: 1, expression: "METRICS" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming("src/data.ts"),
    )

    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual([
      "src/pages/overview.tsx",
      "src/data.ts",
    ])
    expect(r.proposal?.file).toBe("src/data.ts")
  })

  it("follows a re-export chain to the file with the array literal", async () => {
    write(
      "src/pages/overview.tsx",
      'import { METRICS } from "../data"\nexport default function Overview() {\n  return <ul>{METRICS.map((m) => <li key={m.id}>{m.name}</li>)}</ul>\n}\n',
    )
    write("src/data.ts", 'export { METRICS } from "./metrics"\n')
    write("src/metrics.ts", 'export const METRICS = [{ id: 1, name: "a" }]\n')

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/pages/overview.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the name of item 1",
          templateLocation: { file: "src/pages/overview.tsx", line: 3, column: 20 },
          iterationContext: { source: "map" as const, key: 1, index: 0, siblingCount: 1, expression: "METRICS" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual([
      "src/pages/overview.tsx",
      "src/data.ts",
      "src/metrics.ts",
    ])
  })

  it("stops the bundle at a bare package import", async () => {
    write(
      "src/pages/overview.tsx",
      'import { METRICS } from "some-pkg"\nexport default function Overview() {\n  return <ul>{METRICS.map((m) => <li key={m.id}>{m.name}</li>)}</ul>\n}\n',
    )

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/pages/overview.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the name of item 1",
          templateLocation: { file: "src/pages/overview.tsx", line: 3, column: 20 },
          iterationContext: { source: "map" as const, key: 1, index: 0, siblingCount: 1, expression: "METRICS" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    // A bare specifier is a dependency, never followed — the bundle is just
    // the loop file, and the stub still answers.
    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/pages/overview.tsx"])
  })

  it("stops the bundle at a specifier that resolves outside the prototype root", async () => {
    write(
      "src/overview.tsx",
      'import { METRICS } from "../../outside"\nexport default function Overview() {\n  return <ul>{METRICS.map((m) => <li key={m.id}>{m.name}</li>)}</ul>\n}\n',
    )

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/overview.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the name of item 1",
          templateLocation: { file: "src/overview.tsx", line: 3, column: 20 },
          iterationContext: { source: "map" as const, key: 1, index: 0, siblingCount: 1, expression: "METRICS" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/overview.tsx"])
  })

  it("bundles the page source file alongside the loop file when present", async () => {
    write(
      "src/Row.vue",
      "<script setup>\nconst rows = [{ key: 'a' }]\n</script>\n<template>\n  <li v-for=\"r in rows\" :key=\"r.key\">{{ r.key }}</li>\n</template>\n",
    )
    write("src/Page.vue", "<template>\n  <Row />\n</template>\n")

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/Row.vue",
        intent: {
          kind: "iteration-data",
          description: "Set the text of item a",
          templateLocation: { file: "src/Row.vue", line: 5, column: 3 },
          iterationContext: { source: "v-for" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
          pageSourceFile: "src/Page.vue",
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/Row.vue", "src/Page.vue"])
  })

  it("drops a page source file that escapes the prototype root", async () => {
    write(
      "src/Row.vue",
      "<script setup>\nconst rows = [{ key: 'a' }]\n</script>\n<template>\n  <li v-for=\"r in rows\" :key=\"r.key\">{{ r.key }}</li>\n</template>\n",
    )

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/Row.vue",
        intent: {
          kind: "iteration-data",
          description: "Set the text of item a",
          templateLocation: { file: "src/Row.vue", line: 5, column: 3 },
          iterationContext: { source: "v-for" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
          pageSourceFile: "../escape.vue",
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/Row.vue"])
  })

  it("drops a page source file with a non-rewritable extension", async () => {
    write(
      "src/Row.vue",
      "<script setup>\nconst rows = [{ key: 'a' }]\n</script>\n<template>\n  <li v-for=\"r in rows\" :key=\"r.key\">{{ r.key }}</li>\n</template>\n",
    )
    write("src/Page.ts", "export const page = 1\n")

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/Row.vue",
        intent: {
          kind: "iteration-data",
          description: "Set the text of item a",
          templateLocation: { file: "src/Row.vue", line: 5, column: 3 },
          iterationContext: { source: "v-for" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
          pageSourceFile: "src/Page.ts",
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/Row.vue"])
  })

  it("reads the <script setup> block, not the whole .vue file, to find the iteratee's import", async () => {
    write(
      "src/List.vue",
      '<script setup>\nimport { rows } from "./rows"\n</script>\n<template>\n  <li v-for="r in rows" :key="r.key">{{ r.key }}</li>\n</template>\n',
    )
    write("src/rows.ts", "export const rows = [{ key: 'a' }]\n")

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/List.vue",
        intent: {
          kind: "iteration-data",
          description: "Set the text of item a",
          templateLocation: { file: "src/List.vue", line: 5, column: 3 },
          iterationContext: { source: "v-for" as const, key: "a", index: 0, siblingCount: 1, expression: "rows" },
          pageSourceFile: null,
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/List.vue", "src/rows.ts"])
  })

  it("adds a file that is both the page source and the import-chain target only once", async () => {
    write(
      "src/comp/Row.tsx",
      'import { ITEMS } from "../shared"\nexport default function Row() {\n  return <ul>{ITEMS.map((i) => <li key={i.id}>{i.name}</li>)}</ul>\n}\n',
    )
    write("src/shared.tsx", 'export const ITEMS = [{ id: 1, name: "a" }]\n')

    const r = await handleLLMFallback(
      iterationBody({
        file: "src/comp/Row.tsx",
        intent: {
          kind: "iteration-data",
          description: "Set the name of item 1",
          templateLocation: { file: "src/comp/Row.tsx", line: 3, column: 20 },
          iterationContext: { source: "map" as const, key: 1, index: 0, siblingCount: 1, expression: "ITEMS" },
          pageSourceFile: "src/shared.tsx",
          payload: { operation: "patch-text", value: "A2" },
        },
      }),
      dir,
      loadersNaming(),
    )

    expect(r.status).toBe(200)
    expect(capturedBundles).toHaveLength(1)
    expect(capturedBundles[0].map((f) => f.path)).toEqual(["src/comp/Row.tsx", "src/shared.tsx"])
  })

  it("passes the lane's refusal kind through to the HTTP result", async () => {
    write("src/List.vue", ITER_SOURCE)
    const unavailableLoaders: LLMFallbackLoaders = {
      ...loaders,
      loadApplyIterationDataLlm: async () =>
        ({
          applyIterationDataLlm: async () => ({
            ok: false as const,
            reason: "no key",
            kind: "unavailable" as const,
          }),
        }) as unknown as Awaited<
          ReturnType<NonNullable<LLMFallbackLoaders["loadApplyIterationDataLlm"]>>
        >,
    }

    const r = await handleLLMFallback(
      iterationBody({ file: "src/List.vue" }),
      dir,
      unavailableLoaders,
    )
    expect(r.ok).toBe(false)
    expect(r.status).toBe(422)
    expect(r.kind).toBe("unavailable")
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

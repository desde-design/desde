/**
 * An SFC's own block sub-requests must not be mistaken for a rewritten SFC.
 *
 * `@vitejs/plugin-vue` re-requests each block of an SFC as its own module —
 * `App.vue?vue&type=style&index=0`, `?vue&type=script&setup=true` — where `code`
 * is that BLOCK, not the file. The path still ends `.vue` once the query is
 * stripped, so the plugin's `.vue` check admitted them, and
 * `classifyTransformInput(code, cleanId)` then compared a 36-byte style block
 * against the 510-byte file on disk and concluded the SFC had been rewritten by
 * another plugin.
 *
 * The resulting warning claims "`data-desde-src` may name the wrong element and
 * edits to this file may land in the wrong place" — MEASURED on a boot that was
 * otherwise 9/9 correct. A false alarm on the one warning that means "your edits
 * are unsafe" is worse than no warning: it trains the reader to ignore the real
 * one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sourceTagPlugin } from "../source-tag-plugin.js"

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const SFC = `<template>
  <main class="root">
    <p class="row">hello</p>
  </main>
</template>

<script setup lang="ts">
const n = 1
</script>

<style scoped>
.root { padding: 4px; }
</style>
`

/** The style block exactly as plugin-vue re-requests it. */
const STYLE_BLOCK = `.root { padding: 4px; }\n`

function project(): { root: string; abs: string } {
  const root = mkdtempSync(join(tmpdir(), "pt-subreq-"))
  roots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  const abs = join(root, "src", "App.vue")
  writeFileSync(abs, SFC)
  return { root, abs }
}

function runTransform(root: string, code: string, id: string) {
  const plugin = sourceTagPlugin({ repoRoot: root })
  const transform = plugin.transform as unknown as (
    this: unknown,
    code: string,
    id: string,
  ) => { code: string } | null
  return transform.call({}, code, id)
}

describe("source-tag-plugin — SFC block sub-requests", () => {
  it("stamps the main request", () => {
    const { root, abs } = project()
    const out = runTransform(root, SFC, abs)
    expect(out?.code).toContain("data-desde-src")
  })

  it("does NOT warn that the file was rewritten when a style block arrives", () => {
    const { root, abs } = project()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const out = runTransform(root, STYLE_BLOCK, `${abs}?vue&type=style&index=0&lang.css`)

    // Nothing to stamp in a style block — that part was always a no-op.
    expect(out).toBeNull()
    // THE REGRESSION: the sub-request must not be diffed against the whole file.
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).not.toMatch(/land in the wrong place/)
    expect(said).not.toMatch(/transformed by another Vite plugin/)
  })

  it("does NOT warn for a script sub-request either", () => {
    const { root, abs } = project()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    runTransform(root, "const n = 1\n", `${abs}?vue&type=script&setup=true&lang.ts`)

    const said = warn.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).not.toMatch(/land in the wrong place/)
  })

  it("still warns for a genuinely rewritten MAIN request", () => {
    // The guard must not have silenced the real signal it was protecting.
    const { root, abs } = project()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    runTransform(root, `/* injected by another plugin */\n${SFC}`, abs)

    const said = warn.mock.calls.map((c) => String(c[0])).join("\n")
    expect(said).toMatch(/transformed by another Vite plugin/)
  })
})

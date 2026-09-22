/**
 * Tests for `runUniqueTextStep`: collect, find, apply, over a real temp
 * repo. The three pieces it composes have their own colocated tests; what
 * this suite pins is the composition and, above all, the REFUSAL REASONS.
 *
 * The reasons are not incidental strings. Every one of them is shown to
 * the designer and then pasted into the chat hand-off prompt, so they are
 * part of the product surface: plain sentences, no jargon, no first
 * person, no em dashes.
 *
 * See `docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { runUniqueTextStep } from "../unique-text-step.js"
import type { CollectResult } from "../collect-search-files.js"

async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

describe("runUniqueTextStep", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "unique-text-step-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("produces the new contents when the text appears exactly once", async () => {
    await writeFile(tmp, "content/home.json", '{"dates":"May 2022 - present"}')
    await writeFile(tmp, "content/about.json", '{"dates":"Something else"}')

    const result = await runUniqueTextStep(tmp, "May 2022 - present", "May 2023 - present")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe("content/home.json")
    expect(result.source).toBe('{"dates":"May 2022 - present"}')
    expect(result.newSource).toBe('{"dates":"May 2023 - present"}')
    // The step never writes; the caller does.
    expect(await fs.readFile(path.join(tmp, "content/home.json"), "utf-8")).toBe(result.source)
  })

  it("refuses when no file contains the text", async () => {
    await writeFile(tmp, "content/home.json", '{"dates":"May 2022 - present"}')

    const result = await runUniqueTextStep(tmp, "Nowhere in this project", "Somewhere")

    expect(result).toEqual({
      ok: false,
      reason: "That text was not found in any of the project's files.",
    })
  })

  it("refuses when the text appears in more than one file, and names them", async () => {
    await writeFile(tmp, "content/home.json", '{"label":"Email"}')
    await writeFile(tmp, "content/about.json", '{"label":"Email"}')

    const result = await runUniqueTextStep(tmp, "Email", "Contact")

    expect(result).toEqual({
      ok: false,
      reason: "The text appears 2 times in the project (content/about.json, content/home.json).",
    })
  })

  it("refuses when the text appears twice in the SAME file", async () => {
    await writeFile(tmp, "content/home.json", '{"a":"Email","b":"Email"}')

    const result = await runUniqueTextStep(tmp, "Email", "Contact")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(
      "The text appears 2 times in the project (content/home.json).",
    )
  })

  it("stops naming files past the first three", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await writeFile(tmp, `content/${name}.json`, '{"label":"Email"}')
    }

    const result = await runUniqueTextStep(tmp, "Email", "Contact")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(
      "The text appears 5 times in the project (content/a.json, content/b.json, content/c.json, and 2 more).",
    )
  })

  it("passes a collect refusal through unchanged", async () => {
    const collect = async (): Promise<CollectResult> => ({
      ok: false,
      reason: "Too many files to search (over 5,000).",
    })

    const result = await runUniqueTextStep(tmp, "Email", "Contact", { collect })

    expect(result).toEqual({
      ok: false,
      reason: "Too many files to search (over 5,000).",
    })
  })

  it("trips the real file-count limit with a lowered bound", async () => {
    await writeFile(tmp, "content/a.json", '{"label":"Email"}')
    await writeFile(tmp, "content/b.json", '{"label":"Other"}')

    const result = await runUniqueTextStep(tmp, "Email", "Contact", {
      limits: { maxFiles: 1, maxFileBytes: 1_048_576, budgetMs: 1500 },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // Asserted loosely on purpose: the collector's message names the
    // PRODUCTION bound (5,000), not the one injected here, so pinning the
    // exact string would pin a number this run never used.
    expect(result.reason).toMatch(/^Too many files to search/)
  })

  it("passes an encoding refusal through", async () => {
    // A JSX text node cannot carry a brace literally, so `apply` refuses
    // rather than writing something that would render as an expression.
    // The refusal reaches the designer verbatim.
    await writeFile(
      tmp,
      "src/Page.jsx",
      ["export const Page = () => (", "  <p>Read the docs</p>", ")", ""].join("\n"),
    )

    const result = await runUniqueTextStep(tmp, "Read the docs", "Read the {docs}")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.reason).not.toContain("—")
  })

  it("refuses an empty or whitespace-only `before` before searching anything", async () => {
    let collected = false
    const collect = async (): Promise<CollectResult> => {
      collected = true
      return { ok: true, files: [], skippedLarge: 0 }
    }

    const result = await runUniqueTextStep(tmp, "   ", "Contact", { collect })

    expect(result).toEqual({ ok: false, reason: "There is no text to look for." })
    expect(collected).toBe(false)
  })

  it("refuses when the new text equals the old text", async () => {
    const result = await runUniqueTextStep(tmp, "Email", "Email")

    expect(result).toEqual({
      ok: false,
      reason: "The new text is the same as the old text.",
    })
  })

  it("does not follow a symlink into a file outside the root", async () => {
    // The only copy of the text lives outside the repo, reachable only
    // through a link inside it. `collectSearchFiles` never follows a
    // symlink, so the step sees no match at all.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "unique-text-step-outside-"))
    try {
      await fs.writeFile(path.join(outside, "secret.json"), '{"label":"Email"}', "utf-8")
      await fs.symlink(path.join(outside, "secret.json"), path.join(tmp, "linked.json"))

      const result = await runUniqueTextStep(tmp, "Email", "Contact")

      expect(result).toEqual({
        ok: false,
        reason: "That text was not found in any of the project's files.",
      })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it("passes one shared deadline across collection and search (P2)", async () => {
    // A `collect` stub that ignores `now` entirely, so every `now()` call
    // recorded here comes from the step itself or from `findUniqueText`.
    // If the step built a fresh deadline for the search phase instead of
    // reusing the one it made before collection, the search phase would
    // see plenty of budget left and this would find the match instead of
    // timing out.
    const collect = async (): Promise<CollectResult> => ({
      ok: true,
      files: [
        { path: "content/home.json", content: '{"a":"first","b":"Email"}' },
        { path: "content/other.json", content: '{"c":"Email"}' },
      ],
      skippedLarge: 0,
    })

    // Calls in order: the step's own `start` (0), then findUniqueText's
    // per-file checks. The clock has already jumped to 10,000 by the time
    // findUniqueText makes its first check, as if collection alone had
    // used up the whole budget.
    const clock = [0, 10_000]
    const now = () => clock.shift() ?? 10_000

    const result = await runUniqueTextStep(tmp, "Email", "Contact", {
      collect,
      now,
      limits: { maxFiles: 5000, maxFileBytes: 1_048_576, budgetMs: 500 },
    })

    expect(result).toEqual({ ok: false, reason: "Searching the project took too long." })
  })

  it("finds text in a Markdown paragraph, not only in JSON", async () => {
    await writeFile(tmp, "content/post.md", "# Title\n\nA plain paragraph line.\n")

    const result = await runUniqueTextStep(tmp, "A plain paragraph line.", "A different line.")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe("content/post.md")
    expect(result.newSource).toBe("# Title\n\nA different line.\n")
  })
})

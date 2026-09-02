/**
 * Tests for `normalizeProjectKnowledgeResponse` — the defensive coercion
 * that keeps a malformed `/api/editor/project-knowledge` body from
 * crashing the Editor header.
 */

import { describe, expect, it } from "vitest"
import { normalizeProjectKnowledgeResponse } from "./useProjectKnowledge"

const VALID_KNOWLEDGE = {
  rules: "----- CLAUDE.md -----\nbody",
  rulesFiles: [{ path: "CLAUDE.md", chars: 30, truncated: false }],
  docIndex: [],
  truncated: false,
}

describe("normalizeProjectKnowledgeResponse", () => {
  it("passes through a well-formed response", () => {
    const out = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: ["AGENTS.md"],
      knowledge: VALID_KNOWLEDGE,
    })
    expect(out).toEqual({
      useRepoConventions: true,
      excludeFiles: ["AGENTS.md"],
      sdkRuntime: false,
      nativeFiles: [],
      knowledge: VALID_KNOWLEDGE,
    })
  })

  it("threads sdkRuntime + nativeFiles from an SDK-mode response", () => {
    const out = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      sdkRuntime: true,
      nativeFiles: ["CLAUDE.md"],
      knowledge: { ...VALID_KNOWLEDGE, rulesFiles: [] },
    })
    expect(out.sdkRuntime).toBe(true)
    expect(out.nativeFiles).toEqual(["CLAUDE.md"])
  })

  it("ignores a malformed nativeFiles field", () => {
    const out = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      sdkRuntime: true,
      nativeFiles: [1, 2, 3],
      knowledge: VALID_KNOWLEDGE,
    })
    expect(out.nativeFiles).toEqual([])
  })

  it("degrades non-object / null / ok:false bodies", () => {
    const degraded = {
      useRepoConventions: true,
      excludeFiles: [],
      sdkRuntime: false,
      nativeFiles: [],
      knowledge: null,
    }
    expect(normalizeProjectKnowledgeResponse(null)).toEqual(degraded)
    expect(normalizeProjectKnowledgeResponse("nope")).toEqual(degraded)
    expect(
      normalizeProjectKnowledgeResponse({ ok: false, reason: "boom" }),
    ).toEqual(degraded)
  })

  it("treats a structurally-malformed knowledge object as null", () => {
    // ok:true but knowledge.rulesFiles is a string, not an array — must
    // not reach the badge as-is (it would crash on `.length` / `.map`).
    const out = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      knowledge: { rules: "x", rulesFiles: "not-an-array", docIndex: [], truncated: false },
    })
    expect(out.knowledge).toBeNull()
  })

  it("rejects a digest whose rulesFiles / docIndex entries are malformed", () => {
    // Arrays, but with junk elements — the badge dereferences `f.path`,
    // `f.chars`, `d.title`, so a `[null]` entry must degrade to null.
    const badRules = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      knowledge: { rules: "x", rulesFiles: [null], docIndex: [], truncated: false },
    })
    expect(badRules.knowledge).toBeNull()

    const badDocs = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      knowledge: {
        rules: "x",
        rulesFiles: [],
        docIndex: [{ path: "docs/a.md" }], // missing `title`
        truncated: false,
      },
    })
    expect(badDocs.knowledge).toBeNull()
  })

  it("honors useRepoConventions:false and a missing knowledge field", () => {
    const out = normalizeProjectKnowledgeResponse({
      ok: true,
      useRepoConventions: false,
      excludeFiles: [],
      knowledge: null,
    })
    expect(out.useRepoConventions).toBe(false)
    expect(out.knowledge).toBeNull()
  })
})

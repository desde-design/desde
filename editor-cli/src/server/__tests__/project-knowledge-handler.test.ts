import { describe, expect, it, vi } from "vitest"
import {
  handleProjectKnowledgeQuery,
  type ProjectKnowledgeLoaders,
} from "../project-knowledge-handler.js"

type LoadOpts = { prototypeRoot: string; excludeFiles?: readonly string[] }

const FAKE_DIGEST = {
  rules: "----- CLAUDE.md -----\nUse <script setup>.",
  rulesFiles: [{ path: "CLAUDE.md", chars: 40, truncated: false }],
  docIndex: [{ path: "docs/arch.md", title: "Architecture" }],
  truncated: false,
}

/** A loader impl that honors `excludeFiles` so SDK-mode tests can assert the
 *  budgeted-vs-full digest split (CLAUDE.md excluded from the budget, kept for
 *  native-file detection). */
function digestExcluding(excludeFiles: readonly string[] = []) {
  const ex = new Set(excludeFiles)
  const rulesFiles = [
    { path: "CLAUDE.md", chars: 40, truncated: false },
    { path: "AGENTS.md", chars: 20, truncated: false },
  ].filter((f) => !ex.has(f.path))
  return {
    rules: rulesFiles.map((f) => `----- ${f.path} -----`).join("\n"),
    rulesFiles,
    docIndex: [],
    truncated: false,
  }
}

/** Build a loader stub whose `loadCachedProjectKnowledge` runs `impl`. */
function makeLoaders(
  impl: (opts: LoadOpts) => unknown,
): ProjectKnowledgeLoaders {
  return {
    loadProjectKnowledge: async () =>
      ({
        loadCachedProjectKnowledge: impl,
        loadProjectKnowledge: impl,
        __clearProjectKnowledgeCache: () => {},
      }) as unknown as Awaited<
        ReturnType<ProjectKnowledgeLoaders["loadProjectKnowledge"]>
      >,
  }
}

describe("handleProjectKnowledgeQuery", () => {
  it("loads the digest when conventions are on (config undefined)", async () => {
    const impl = vi.fn(() => FAKE_DIGEST)
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      undefined,
      makeLoaders(impl),
      false,
    )
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      useRepoConventions: true,
      excludeFiles: [],
      sdkRuntime: false,
      nativeFiles: [],
      knowledge: FAKE_DIGEST,
    })
    expect(impl).toHaveBeenCalledWith({ prototypeRoot: "/repo", excludeFiles: [] })
  })

  it("skips loading and returns null knowledge when conventions are off", async () => {
    const impl = vi.fn(() => FAKE_DIGEST)
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      { useRepoConventions: false },
      makeLoaders(impl),
      false,
    )
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      ok: true,
      useRepoConventions: false,
      excludeFiles: [],
      sdkRuntime: false,
      nativeFiles: [],
      knowledge: null,
    })
    expect(impl).not.toHaveBeenCalled()
  })

  it("threads excludeFiles through to the loader", async () => {
    const impl = vi.fn((opts: LoadOpts) => ({
      ...FAKE_DIGEST,
      // echo the received excludeFiles so the assertion can see them
      _received: opts.excludeFiles,
    }))
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      { excludeFiles: ["AGENTS.md"] },
      makeLoaders(impl),
      false,
    )
    expect(result.status).toBe(200)
    expect(impl).toHaveBeenCalledWith({
      prototypeRoot: "/repo",
      excludeFiles: ["AGENTS.md"],
    })
    expect((result.body as { excludeFiles: string[] }).excludeFiles).toEqual([
      "AGENTS.md",
    ])
  })

  it("excludes CLAUDE.md from the budgeted digest and reports it as native in SDK mode", async () => {
    const impl = vi.fn((opts: LoadOpts) => digestExcluding(opts.excludeFiles))
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      undefined,
      makeLoaders(impl),
      true,
    )
    expect(result.status).toBe(200)
    const body = result.body as {
      sdkRuntime: boolean
      nativeFiles: string[]
      excludeFiles: string[]
      knowledge: { rulesFiles: { path: string }[] }
    }
    expect(body.sdkRuntime).toBe(true)
    // CLAUDE.md is loaded natively by the SDK, so it's listed there, not in
    // the budgeted digest.
    expect(body.nativeFiles).toEqual(["CLAUDE.md"])
    expect(body.knowledge.rulesFiles.map((f) => f.path)).toEqual(["AGENTS.md"])
    // The config exclusion list (empty) is untouched by the native exclusion.
    expect(body.excludeFiles).toEqual([])
    // The budgeted load excludes CLAUDE.md; a second (full) load detects it.
    expect(impl).toHaveBeenCalledWith({
      prototypeRoot: "/repo",
      excludeFiles: ["CLAUDE.md"],
    })
    expect(impl).toHaveBeenCalledWith({ prototypeRoot: "/repo", excludeFiles: [] })
  })

  it("reports no native files in SDK mode when the repo has no CLAUDE.md", async () => {
    const impl = vi.fn((opts: LoadOpts) => {
      const d = digestExcluding(["CLAUDE.md", ...(opts.excludeFiles ?? [])])
      return d
    })
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      undefined,
      makeLoaders(impl),
      true,
    )
    const body = result.body as { nativeFiles: string[] }
    expect(body.nativeFiles).toEqual([])
  })

  it("returns a 500 with a reason when discovery throws", async () => {
    const result = await handleProjectKnowledgeQuery(
      "/repo",
      undefined,
      makeLoaders(() => {
        throw new Error("disk on fire")
      }),
      false,
    )
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok: false })
    expect((result.body as { reason: string }).reason).toMatch(/disk on fire/)
  })
})

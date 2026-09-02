import { describe, it, expect, vi } from "vitest"
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import type { ViteDevServer } from "vite"
import { invalidateViteModules } from "../vite-invalidate.js"

function fakeServer(root: string) {
  const emit = vi.fn()
  const server = {
    config: { root },
    watcher: { emit },
  } as unknown as ViteDevServer
  return { server, emit }
}

describe("invalidateViteModules", () => {
  it("emits a 'change' event resolved against the WORKTREE root (repoRoot), not vite's root", () => {
    // repoRoot != server.config.root simulates a `root: 'app'` vite config. The
    // edited path is worktree-relative, so it must resolve against repoRoot.
    const repoRoot = "/work/.desde/scratch/abc"
    const { server, emit } = fakeServer("/work/.desde/scratch/abc/app")
    invalidateViteModules(server, repoRoot, ["app/src/router/index.ts"])
    // Correct absolute path — NOT the duplicated-`app/` path that resolving
    // against server.config.root would have produced.
    expect(emit).toHaveBeenCalledWith("change", "/work/.desde/scratch/abc/app/src/router/index.ts")
    expect(emit).not.toHaveBeenCalledWith(
      "change",
      "/work/.desde/scratch/abc/app/app/src/router/index.ts",
    )
  })

  it("no-ops when the server is undefined (non-supervised runs / tests)", () => {
    expect(() => invalidateViteModules(undefined, "/work", ["src/a.vue"])).not.toThrow()
  })

  it("no-ops on empty / undefined file lists", () => {
    const { server, emit } = fakeServer("/work")
    invalidateViteModules(server, "/work", [])
    invalidateViteModules(server, "/work", undefined)
    expect(emit).not.toHaveBeenCalled()
  })

  it("does not throw if the watcher emit throws (best-effort; OS watcher is the backstop)", () => {
    const emit = vi.fn(() => {
      throw new Error("watcher mid-teardown")
    })
    const server = { config: { root: "/work" }, watcher: { emit } } as unknown as ViteDevServer
    expect(() => invalidateViteModules(server, "/work", ["src/a.vue", "src/b.vue"])).not.toThrow()
    // Still attempts every file rather than bailing on the first throw.
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it("also emits the realpath of an existing file reached via a symlinked dir", () => {
    // macOS tmpdir is under /var -> /private/var, so a real file's realpath
    // differs from its symlinked absolute path — exercising the realpath branch.
    const dir = mkdtempSync(join(tmpdir(), "pt-vinv-"))
    try {
      const file = "x.vue"
      const abs = resolve(dir, file)
      writeFileSync(abs, "<template/>")
      const real = realpathSync(abs)
      const { server, emit } = fakeServer(dir)
      invalidateViteModules(server, dir, [file])
      expect(emit).toHaveBeenCalledWith("change", abs)
      if (real !== abs) {
        // Symlinked path differs from canonical → both emitted.
        expect(emit).toHaveBeenCalledWith("change", real)
        expect(emit).toHaveBeenCalledTimes(2)
      } else {
        // No symlink in the path → single emit, no duplicate.
        expect(emit).toHaveBeenCalledTimes(1)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

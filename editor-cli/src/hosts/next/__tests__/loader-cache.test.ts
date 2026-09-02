/**
 * Where the Turbopack loader lands, and the proof that it works from there.
 *
 * The destination is not a tidiness question. The loader has to be a FILE
 * because Turbopack runs loaders in a forked worker, and the only two places it
 * could plausibly go — the customer's repository and the installed package
 * directory — are both wrong for reasons that bite different users (a repo Editor
 * promised not to touch; a root-owned global install). So the cache dir is the
 * answer, and what has to be tested is that a bundle written there is genuinely
 * self-contained: a cache directory has no `node_modules` anywhere above it.
 */
import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { cacheHome, materializeNextLoader, nextLoaderDir } from "../loader-cache.js"

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pt-loader-cache-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("cacheHome", () => {
  it("honours XDG_CACHE_HOME on every platform, including macOS", () => {
    // A user who set it has said where cache data goes; honouring it costs
    // nothing and is the only way to redirect this in a sandbox.
    expect(cacheHome({ XDG_CACHE_HOME: "/xdg" }, "darwin", "/home/me")).toBe("/xdg")
    expect(cacheHome({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg")
    expect(cacheHome({ XDG_CACHE_HOME: "/xdg", LOCALAPPDATA: "C:/local" }, "win32", "C:/Users/me")).toBe("/xdg")
  })

  it("uses each platform's own convention when it is not set", () => {
    expect(cacheHome({}, "darwin", join(sep, "home", "me"))).toBe(join(sep, "home", "me", "Library", "Caches"))
    expect(cacheHome({}, "linux", join(sep, "home", "me"))).toBe(join(sep, "home", "me", ".cache"))
    expect(cacheHome({ LOCALAPPDATA: "C:/local" }, "win32", "C:/Users/me")).toBe("C:/local")
  })

  it("falls back to a temp dir when there is no home directory at all", () => {
    // Some CI containers and daemon users have none. Losing the warm-cache
    // property across reboots is the entire cost; refusing to boot would not be.
    expect(cacheHome({}, "linux", "")).toBe(tmpdir())
  })

  it("ignores an empty environment value rather than treating it as a path", () => {
    expect(cacheHome({ XDG_CACHE_HOME: "" }, "linux", join(sep, "home", "me"))).toBe(
      join(sep, "home", "me", ".cache"),
    )
  })
})

describe("nextLoaderDir", () => {
  it("is version-keyed, so two editor-cli installs cannot fight over one path", () => {
    expect(nextLoaderDir("/cache", "1.2.3")).toBe(join("/cache", "desde", "1.2.3", "stamp"))
  })
})

describe("materializeNextLoader", () => {
  it("bundles a self-contained loader into the cache dir, and nowhere near a repo", async () => {
    const cacheRoot = tempDir()
    const result = await materializeNextLoader({ cacheRoot })

    expect(result.loaderPath).toBe(join(nextLoaderDir(cacheRoot), "next-loader.cjs"))
    expect(existsSync(result.loaderPath)).toBe(true)
    expect(result.rebuilt).toBe(true)

    const code = readFileSync(result.loaderPath, "utf8")
    // CommonJS, because a Turbopack loader is `module.exports = fn`.
    expect(code).toContain("module.exports")
    // Self-contained: there is no `node_modules` anywhere above a cache dir, so
    // a bare `require` of @babel/parser would throw inside the forked worker and
    // the loader's own catch-all would swallow it into "stamps nothing".
    expect(code).not.toMatch(/require\(["']@babel\/parser["']\)/)
  }, 60_000)

  it("does not re-bundle when nothing changed", async () => {
    // Turbopack keys its persistent `.next` cache on the loader's BYTES, so a
    // stable path that is not needlessly rewritten is what keeps a customer's
    // compile cache warm across Editor restarts.
    const cacheRoot = tempDir()
    await materializeNextLoader({ cacheRoot })
    const second = await materializeNextLoader({ cacheRoot })

    expect(second.rebuilt).toBe(false)
  }, 60_000)

  it("fails loudly and names the directory when the cache dir cannot be written", async () => {
    // The asymmetry that earns a throw: an unstamped Next dev server boots
    // healthy and serves 200s, so degrading here would surface as a refused edit
    // minutes later instead of a message at boot.
    const blocked = join(tempDir(), "a-file")
    // A FILE where the cache root should be: `mkdir -p` under it fails with
    // ENOTDIR, which is the closest reproducible stand-in for an unwritable
    // cache home that does not depend on running as a particular user.
    writeFileSync(blocked, "not a directory")

    await expect(materializeNextLoader({ cacheRoot: blocked })).rejects.toThrow(
      /could not write the Next\.js source-code stamper to .*desde/i,
    )
  })
})

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findNextDistDir } from "./fs-probe"

/**
 * Codex round 4, Fix 4. `BUILD_ID` alone used to be hard-coded under `.next`
 * in `next.ts`, so a checkout with a custom `distDir` (e.g. `distDir:
 * "build"` in `next.config`) fell through to static publishing and failed —
 * nothing ever looked anywhere else. This scans for the pair of files EVERY
 * non-export Next build writes together, in its own dist dir wherever that
 * is: `BUILD_ID` and `required-server-files.json`.
 */
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fs-probe-next-"))
  roots.push(dir)
  return dir
}

async function writeDistDir(base: string, rel: string): Promise<void> {
  const dir = join(base, rel)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "BUILD_ID"), "abc123")
  await writeFile(join(dir, "required-server-files.json"), "{}")
}

describe("findNextDistDir", () => {
  it("finds the default .next dist dir", async () => {
    const r = await root()
    await writeDistDir(r, ".next")
    expect(await findNextDistDir(r)).toBe(".next")
  })

  it("finds a custom depth-1 distDir (distDir: \"build\")", async () => {
    const r = await root()
    await writeDistDir(r, "build")
    expect(await findNextDistDir(r)).toBe("build")
  })

  it("finds a custom nested distDir (distDir: \"build/next\")", async () => {
    const r = await root()
    await writeDistDir(r, "build/next")
    expect(await findNextDistDir(r)).toBe("build/next")
  })

  it("prefers .next when it qualifies, even alongside another qualifying directory", async () => {
    const r = await root()
    await writeDistDir(r, ".next")
    await writeDistDir(r, "build")
    expect(await findNextDistDir(r)).toBe(".next")
  })

  it("does not descend into node_modules, .git, out, or public", async () => {
    const r = await root()
    await writeDistDir(r, join("node_modules", ".next"))
    await writeDistDir(r, join(".git", ".next"))
    await writeDistDir(r, join("out", ".next"))
    await writeDistDir(r, join("public", ".next"))
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("ignores a directory with only ONE of the two required files", async () => {
    const r = await root()
    await mkdir(join(r, ".next"), { recursive: true })
    await writeFile(join(r, ".next", "BUILD_ID"), "abc123")
    // required-server-files.json missing
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("answers null when nothing qualifies", async () => {
    const r = await root()
    expect(await findNextDistDir(r)).toBeNull()
  })
})

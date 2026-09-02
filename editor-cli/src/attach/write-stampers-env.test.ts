/**
 * Bundling the stampers must not leak ambient process state.
 *
 * Vite's `build()` DEFAULTS `process.env.NODE_ENV` to "production" when it is
 * unset and never restores it. MEASURED before the fix: null before the bundle,
 * "production" after, persisting for the life of the CLI process. Two
 * consequences were measured downstream, both reaching into the user's machine:
 *
 *  - Next, booted for DEV in the same process, sees a production NODE_ENV and
 *    REWRITES the customer's `tsconfig.json`. In-process boot exists precisely
 *    so the repo is left untouched; this wrote to it on the first boot.
 *  - Every child process the agent spawns inherits it, so an `npm install`
 *    silently skips devDependencies.
 *
 * **Why this test deletes NODE_ENV first, and why that is the whole point.**
 * Vitest pre-sets `NODE_ENV="test"`, and Vite only defaults the variable when it
 * is UNSET — so a probe that leaves vitest's value in place exercises the one
 * condition where the bug cannot appear, and reports a comfortable pass. The
 * shipped CLI sets no NODE_ENV, so unset IS the real condition. The first
 * version of this check made exactly that mistake and passed.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeStamperFiles } from "./write-stampers.js"
import { nextLoaderFiles } from "../attach-preflight/stamper-files.js"

const dests: string[] = []

afterEach(() => {
  for (const dir of dests.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run `fn` with NODE_ENV genuinely absent, restoring whatever vitest had. */
async function withUnsetNodeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.NODE_ENV
  delete process.env.NODE_ENV
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prior
  }
}

function freshDest(): string {
  const dest = mkdtempSync(join(tmpdir(), "pt-stamper-env-"))
  dests.push(dest)
  return dest
}

describe("writeStamperFiles — ambient environment", () => {
  it("leaves NODE_ENV unset when it started unset", async () => {
    const observed = await withUnsetNodeEnv(async () => {
      const result = await writeStamperFiles({
        destDir: freshDest(),
        files: nextLoaderFiles().map((f) => ({ ...f, path: "next-loader.cjs" })),
      })
      // A cache hit skips the bundler entirely and would pass trivially, so
      // assert we actually exercised the bundling path.
      expect(result.rebuilt).toBe(true)
      return process.env.NODE_ENV ?? null
    })
    expect(observed).toBeNull()
  }, 120_000)

  it("preserves an explicit NODE_ENV rather than overwriting it", async () => {
    const prior = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    try {
      await writeStamperFiles({
        destDir: freshDest(),
        files: nextLoaderFiles().map((f) => ({ ...f, path: "next-loader.cjs" })),
      })
      // The restore must put back what was there, not merely delete.
      expect(process.env.NODE_ENV).toBe("development")
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prior
    }
  }, 120_000)
})

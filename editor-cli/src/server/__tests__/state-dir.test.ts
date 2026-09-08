/**
 * The CLI's one state directory: its path, and that it ends up 0700 no
 * matter which writer creates it first (the defect: a launcher-first boot
 * left it 0755 because the non-secret writers passed no mode, and a later
 * secret store's `mkdir` with a mode could not tighten an existing dir).
 */
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cliStateDir, ensureCliStateDir } from "../state-dir.js"
import { markDemoTried } from "../demo/paths.js"

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "state-dir-"))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe("cliStateDir", () => {
  it("is ~/.config/desde and nothing else", () => {
    expect(cliStateDir(home)).toBe(path.join(home, ".config", "desde"))
    expect(cliStateDir(home)).not.toContain(".desde")
  })
})

describe("ensureCliStateDir", () => {
  it("creates the directory 0700", async () => {
    await ensureCliStateDir(home)
    expect((await fs.stat(cliStateDir(home))).mode & 0o777).toBe(0o700)
  })

  it("tightens a directory that already exists wider", async () => {
    await fs.mkdir(cliStateDir(home), { recursive: true, mode: 0o755 })
    await fs.chmod(cliStateDir(home), 0o755)
    await ensureCliStateDir(home)
    expect((await fs.stat(cliStateDir(home))).mode & 0o777).toBe(0o700)
  })

  it("a non-secret writer running first still leaves the directory 0700", async () => {
    await markDemoTried(home)
    expect((await fs.stat(cliStateDir(home))).mode & 0o777).toBe(0o700)
  })
})

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { demoRepoPath, demoStatePath, markDemoTried, readDemoState } from "../paths.js"

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demo-paths-"))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("demo paths", () => {
  it("puts the repo in a SIBLING of .desde, and its state inside", () => {
    expect(demoRepoPath(home)).toBe(join(home, ".desde-demo"))
    expect(demoStatePath(home)).toBe(join(home, ".desde", "demo-state.json"))
  })

  it("reads an empty state when nothing is written yet", async () => {
    expect(await readDemoState(home)).toEqual({})
  })

  it("records triedAt and survives a later read", async () => {
    await markDemoTried(home)
    expect(typeof (await readDemoState(home)).triedAt).toBe("string")
  })

  it("treats a corrupt state file as empty rather than throwing", async () => {
    await mkdir(join(home, ".desde"), { recursive: true })
    await writeFile(demoStatePath(home), "{not json", "utf8")
    expect(await readDemoState(home)).toEqual({})
  })

  it("treats a non-object state file as empty", async () => {
    await mkdir(join(home, ".desde"), { recursive: true })
    await writeFile(demoStatePath(home), '"a string"', "utf8")
    expect(await readDemoState(home)).toEqual({})
  })

  it("does not overwrite an existing triedAt", async () => {
    await markDemoTried(home)
    const first = (await readDemoState(home)).triedAt
    await markDemoTried(home)
    expect((await readDemoState(home)).triedAt).toBe(first)
  })
})

import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { materializeDemo } from "../materialize.js"
import { classifyDemoChanges, removeDemo } from "../remove.js"
import { demoRepoPath, readDemoState } from "../paths.js"

const execFileAsync = promisify(execFile)
const git = (cwd: string, args: string[]) => execFileAsync("git", ["-C", cwd, ...args])

let home: string
let fixtureDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demo-home-"))
  fixtureDir = await mkdtemp(join(tmpdir(), "demo-fixture-"))
  await mkdir(join(fixtureDir, "src"), { recursive: true })
  await writeFile(join(fixtureDir, "package.json"), '{"name":"desde-demo"}', "utf8")
  await writeFile(join(fixtureDir, "src", "App.tsx"), "export const App = () => null\n", "utf8")
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(fixtureDir, { recursive: true, force: true })
})

describe("classifyDemoChanges", () => {
  it("reports absent when the demo was never materialized", async () => {
    expect(await classifyDemoChanges(home)).toEqual({
      present: false,
      dirtyFiles: 0,
      extraCommits: 0,
    })
  })

  it("reports untouched right after materializing", async () => {
    await materializeDemo({ home, fixtureDir })
    expect(await classifyDemoChanges(home)).toEqual({
      present: true,
      dirtyFiles: 0,
      extraCommits: 0,
    })
  })

  it("counts uncommitted changes", async () => {
    const { path } = await materializeDemo({ home, fixtureDir })
    await writeFile(join(path, "src", "App.tsx"), "// edited\n", "utf8")
    expect((await classifyDemoChanges(home)).dirtyFiles).toBe(1)
  })

  it("counts commits past the seed commit", async () => {
    const { path } = await materializeDemo({ home, fixtureDir })
    await writeFile(join(path, "src", "App.tsx"), "// edited\n", "utf8")
    await git(path, ["add", "-A"])
    await git(path, [
      "-c", "user.name=T", "-c", "user.email=t@t.local",
      "commit", "--quiet", "-m", "mine",
    ])
    const result = await classifyDemoChanges(home)
    expect(result.extraCommits).toBe(1)
    expect(result.dirtyFiles).toBe(0)
  })
})

describe("removeDemo", () => {
  it("deletes the directory", async () => {
    await materializeDemo({ home, fixtureDir })
    expect(await removeDemo(home)).toEqual({ removed: true })
    await expect(access(demoRepoPath(home))).rejects.toThrow()
  })

  it("is safe to call when nothing is there", async () => {
    expect(await removeDemo(home)).toEqual({ removed: false })
  })

  it("keeps triedAt, so the demo is demoted rather than resurrected", async () => {
    await materializeDemo({ home, fixtureDir })
    await removeDemo(home)
    expect(typeof (await readDemoState(home)).triedAt).toBe("string")
  })

  it("round-trips: delete then materialize again", async () => {
    await materializeDemo({ home, fixtureDir })
    await removeDemo(home)
    expect((await materializeDemo({ home, fixtureDir })).created).toBe(true)
  })

  it("takes no path parameter, so a caller cannot steer the delete", () => {
    // The signature is the guard. A second parameter here would mean a request
    // body could name what gets recursively removed.
    expect(removeDemo.length).toBeLessThanOrEqual(1)
  })
})

import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { materializeDemo } from "../materialize.js"
import { demoRepoPath, readDemoState } from "../paths.js"

const execFileAsync = promisify(execFile)

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

describe("materializeDemo", () => {
  it("copies the fixture and reports it created the repo", async () => {
    const result = await materializeDemo({ home, fixtureDir })
    expect(result.path).toBe(demoRepoPath(home))
    expect(result.created).toBe(true)
    expect(await readFile(join(result.path, "src", "App.tsx"), "utf8")).toContain("App")
  })

  it("initialises git with exactly one commit", async () => {
    const { path } = await materializeDemo({ home, fixtureDir })
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-list", "--count", "HEAD"])
    expect(stdout.trim()).toBe("1")
  })

  it("leaves a clean working tree", async () => {
    const { path } = await materializeDemo({ home, fixtureDir })
    const { stdout } = await execFileAsync("git", ["-C", path, "status", "--porcelain"])
    expect(stdout.trim()).toBe("")
  })

  it("configures NO origin remote, so the push controls render disabled", async () => {
    const { path } = await materializeDemo({ home, fixtureDir })
    const { stdout } = await execFileAsync("git", ["-C", path, "remote"])
    expect(stdout.trim()).toBe("")
  })

  it("is idempotent: a second call opens the existing repo without recopying", async () => {
    const first = await materializeDemo({ home, fixtureDir })
    await writeFile(join(first.path, "src", "App.tsx"), "// edited by the user\n", "utf8")
    const second = await materializeDemo({ home, fixtureDir })
    expect(second.created).toBe(false)
    expect(await readFile(join(second.path, "src", "App.tsx"), "utf8")).toContain("edited by the user")
  })

  it("records triedAt", async () => {
    await materializeDemo({ home, fixtureDir })
    expect(typeof (await readDemoState(home)).triedAt).toBe("string")
  })

  it("cleans up and rethrows when the fixture is missing, so the next attempt is clean", async () => {
    await rm(fixtureDir, { recursive: true, force: true })
    await expect(materializeDemo({ home, fixtureDir })).rejects.toThrow()
    await expect(access(demoRepoPath(home))).rejects.toThrow()
  })

  it("does not mark triedAt when materializing failed", async () => {
    await rm(fixtureDir, { recursive: true, force: true })
    await expect(materializeDemo({ home, fixtureDir })).rejects.toThrow()
    expect(await readDemoState(home)).toEqual({})
  })
})

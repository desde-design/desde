import { mkdir, mkdtemp, rm, writeFile, access, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { seedDemoProject, DEMO_PROJECT_SLUG } from "../seed.js"
import { demoRepoPath, markDemoTried, readDemoState } from "../paths.js"
import { readProjectsRegistry, removeProjectRegistryEntry } from "../../projects-registry.js"
import { removeDemo } from "../remove.js"

let home: string
let fixtureDir: string
let realHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demo-seed-home-"))
  fixtureDir = await mkdtemp(join(tmpdir(), "demo-seed-fixture-"))
  await mkdir(join(fixtureDir, "src"), { recursive: true })
  await writeFile(join(fixtureDir, "package.json"), '{"name":"desde-demo"}', "utf8")
  await writeFile(join(fixtureDir, "src", "App.tsx"), "export const App = () => null\n", "utf8")
  // The registry has no `home` parameter: it reads HOME, as the editor's own
  // boot does when it registers a project.
  realHome = process.env.HOME
  process.env.HOME = home
})

afterEach(async () => {
  process.env.HOME = realHome
  await rm(home, { recursive: true, force: true })
  await rm(fixtureDir, { recursive: true, force: true })
})

describe("seedDemoProject", () => {
  it("materialises the demo and registers it as a project on a fresh machine", async () => {
    const result = await seedDemoProject({ home, fixtureDir })
    expect(result.seeded).toBe(true)
    expect(result.path).toBe(demoRepoPath(home))
    await expect(access(join(demoRepoPath(home), "src", "App.tsx"))).resolves.toBeUndefined()

    const registry = await readProjectsRegistry()
    expect(registry.projects.map((p) => [p.path, p.slug])).toEqual([
      [demoRepoPath(home), DEMO_PROJECT_SLUG],
    ])
    expect((await readDemoState(home)).triedAt).toBeTypeOf("string")
  })

  it("seeds once: a second call is a no-op", async () => {
    await seedDemoProject({ home, fixtureDir })
    const again = await seedDemoProject({ home, fixtureDir })
    expect(again.seeded).toBe(false)
    expect((await readProjectsRegistry()).projects).toHaveLength(1)
  })

  it("does not re-seed a demo the user deleted", async () => {
    await seedDemoProject({ home, fixtureDir })
    await removeDemo(home)
    const after = await seedDemoProject({ home, fixtureDir })
    expect(after.seeded).toBe(false)
    await expect(access(demoRepoPath(home))).rejects.toThrow()
  })

  it("registers a demo that was copied but never made it into the registry", async () => {
    // The stranded case: marker written, copy on disk, registry write lost.
    await seedDemoProject({ home, fixtureDir })
    await removeProjectRegistryEntry(demoRepoPath(home))
    expect((await readProjectsRegistry()).projects).toHaveLength(0)
    const repaired = await seedDemoProject({ home, fixtureDir })
    expect(repaired.seeded).toBe(true)
    expect((await readProjectsRegistry()).projects.map((p) => p.slug)).toEqual([DEMO_PROJECT_SLUG])
    // And not again.
    expect((await seedDemoProject({ home, fixtureDir })).seeded).toBe(false)
  })

  it("skips while another process holds the seed lock, and takes over a stale one", async () => {
    const lock = join(home, ".desde", "demo-seed.lock")
    await mkdir(lock, { recursive: true })
    const skipped = await seedDemoProject({ home, fixtureDir })
    expect(skipped.seeded).toBe(false)
    await expect(access(demoRepoPath(home))).rejects.toThrow()
    // A lock from a crashed copy, well past the stale threshold.
    const old = new Date(Date.now() - 60 * 60_000)
    await utimes(lock, old, old)
    const taken = await seedDemoProject({ home, fixtureDir })
    expect(taken.seeded).toBe(true)
    await expect(access(lock)).rejects.toThrow()
  })

  it("releases the lock when the copy fails", async () => {
    const missing = join(fixtureDir, "does-not-exist")
    await expect(seedDemoProject({ home, fixtureDir: missing })).rejects.toThrow()
    await expect(access(join(home, ".desde", "demo-seed.lock"))).rejects.toThrow()
    // The marker was never written, so the next call still seeds.
    expect((await seedDemoProject({ home, fixtureDir })).seeded).toBe(true)
  })

  it("respects a machine that tried the demo before this existed", async () => {
    // The tile era's marker, with no demo on disk: the user tried and removed
    // it, or the marker is all that survived. Either way, not a fresh machine.
    await markDemoTried(home)
    const result = await seedDemoProject({ home, fixtureDir })
    expect(result.seeded).toBe(false)
    expect((await readProjectsRegistry()).projects).toHaveLength(0)
  })
})

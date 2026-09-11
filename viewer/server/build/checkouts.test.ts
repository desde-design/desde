import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { checkoutDirFor, keepCheckout, pruneSupersededCheckouts } from "./checkouts"

const roots: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "checkouts-"))
  roots.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe("keepCheckout", () => {
  it("moves the checkout into place, creating the parent, and replaces a stale one", async () => {
    const work = await tmp()
    const root = join(await tmp(), "checkouts")
    await mkdir(join(work, "repo", "node_modules"), { recursive: true })
    await writeFile(join(work, "repo", "package.json"), "{}")
    const dest = checkoutDirFor(root, "dep-1")
    await keepCheckout(join(work, "repo"), dest)
    expect(await exists(join(dest, "package.json"))).toBe(true)
    expect(await exists(join(work, "repo"))).toBe(false)
    // A second keep for the same id (a rebuild that reused the id) replaces it.
    await mkdir(join(work, "repo"), { recursive: true })
    await writeFile(join(work, "repo", "other.txt"), "x")
    await keepCheckout(join(work, "repo"), dest)
    expect(await exists(join(dest, "other.txt"))).toBe(true)
    expect(await exists(join(dest, "package.json"))).toBe(false)
  })
  it("rejects a deployment id that would escape the root", () => {
    expect(() => checkoutDirFor("/data/checkouts", "../etc")).toThrow()
  })
})

describe("pruneSupersededCheckouts", () => {
  it("keeps the active checkout and the newest other one, removes the rest, and warns before each removal", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = await storage.createDeployment({ projectId: project.id })
      ids.push(d.id)
      await mkdir(checkoutDirFor(root, d.id), { recursive: true })
    }
    // ids[3] is newest. Make ids[0] (oldest) active: it must survive.
    const removed: string[] = []
    await pruneSupersededCheckouts(storage, root, project.id, ids[0]!, async (id) => {
      removed.push(id)
    })
    expect(await exists(checkoutDirFor(root, ids[0]!))).toBe(true) // active
    expect(await exists(checkoutDirFor(root, ids[3]!))).toBe(true) // newest other
    expect(await exists(checkoutDirFor(root, ids[2]!))).toBe(false)
    expect(await exists(checkoutDirFor(root, ids[1]!))).toBe(false)
    expect(removed.sort()).toEqual([ids[1]!, ids[2]!].sort())
  })
  it("tolerates a deployment with no checkout directory", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const a = await storage.createDeployment({ projectId: project.id })
    await storage.createDeployment({ projectId: project.id })
    await storage.createDeployment({ projectId: project.id })
    await expect(pruneSupersededCheckouts(storage, root, project.id, a.id)).resolves.toBeUndefined()
  })
})

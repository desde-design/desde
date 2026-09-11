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

  /**
   * `beforeRemove` is awaited BEFORE the directory is removed, for every
   * stale deployment (the loop is sequential, not concurrent) — this is
   * what makes it safe for `server/index.ts` to wire `beforeRemove` to the
   * process manager's `retire()` instead of `stop()`. `retire` stops the
   * process AND leaves a permanent, non-retryable crash behind
   * synchronously before this function ever reaches `rm`, so a request
   * that calls `ensure` on that deployment id — even one landing in the
   * gap between this `beforeRemove` and the `rm` below — finds the entry
   * already refusing, rather than racing to spawn a fresh child into a
   * directory that is about to disappear. See
   * `prototype-processes.test.ts`'s "retire" tests for that half.
   */
  it("awaits beforeRemove, with the directory still present, before removing it", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = await storage.createDeployment({ projectId: project.id })
      ids.push(d.id)
      await mkdir(checkoutDirFor(root, d.id), { recursive: true })
    }
    const sawDirDuring: boolean[] = []
    await pruneSupersededCheckouts(storage, root, project.id, ids[0]!, async (id) => {
      sawDirDuring.push(await exists(checkoutDirFor(root, id)))
    })
    // Two deployments get pruned (same fixture shape as the test above);
    // `beforeRemove` observed the directory present for both, every time.
    expect(sawDirDuring).toEqual([true, true])
  })

  /**
   * Codex round 3, item 4. `listDeployments` returns the WHOLE history, so
   * every deployment outside the retention window reaches this loop again on
   * every later activation — including ones whose checkout directory was
   * already removed by a previous prune. Without a stat-before check,
   * `beforeRemove` (wired to the process manager's `retire`) ran for every
   * one of those every time, creating a permanent map entry per id
   * (unbounded growth) for quadratic, pointless work. Neither hook should
   * fire for a deployment with no directory to begin with.
   */
  it("skips both hooks for a deployment with no checkout directory", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const active = await storage.createDeployment({ projectId: project.id })
    const stale = await storage.createDeployment({ projectId: project.id })
    await storage.createDeployment({ projectId: project.id }) // the "newest other", keeps `stale` in the pruned set
    // No mkdir for `stale`: its checkout directory never existed.
    const before: string[] = []
    const after: string[] = []
    await pruneSupersededCheckouts(
      storage,
      root,
      project.id,
      active.id,
      async (id) => {
        before.push(id)
      },
      async (id) => {
        after.push(id)
      },
    )
    expect(before).not.toContain(stale.id)
    expect(after).not.toContain(stale.id)
  })

  /** The companion case: a real directory triggers beforeRemove, then the removal, then afterRemove, in that order. */
  it("triggers beforeRemove then afterRemove, in that order, for a deployment with a real checkout directory", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const active = await storage.createDeployment({ projectId: project.id })
    const stale = await storage.createDeployment({ projectId: project.id })
    await storage.createDeployment({ projectId: project.id })
    await mkdir(checkoutDirFor(root, stale.id), { recursive: true })
    const calls: string[] = []
    await pruneSupersededCheckouts(
      storage,
      root,
      project.id,
      active.id,
      async (id) => {
        calls.push(`before:${id}`)
      },
      async (id) => {
        calls.push(`after:${id}`)
      },
    )
    expect(calls).toEqual([`before:${stale.id}`, `after:${stale.id}`])
    expect(await exists(checkoutDirFor(root, stale.id))).toBe(false)
  })
})

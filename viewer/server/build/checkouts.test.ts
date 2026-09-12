import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { checkoutDirFor, keepCheckout, pruneSupersededCheckouts, reconcileCheckouts } from "./checkouts"

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

/**
 * Codex round 33. A Viewer killed after the runner moved a checkout into
 * place but before the deployment row went live left that directory,
 * `node_modules` and all, for ever: boot marks the row failed, and the
 * prune only runs when the project next activates.
 */
describe("reconcileCheckouts", () => {
  it("removes a checkout whose row failed, or has no row, and keeps a deployed one", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const live = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    const failed = await storage.createDeployment({ projectId: project.id, status: "failed" })
    for (const id of [live.id, failed.id, "no-such-row"]) {
      await mkdir(join(checkoutDirFor(root, id), "node_modules"), { recursive: true })
    }
    expect(await reconcileCheckouts(storage, root)).toBe(2)
    expect(await exists(checkoutDirFor(root, live.id))).toBe(true)
    expect(await exists(checkoutDirFor(root, failed.id))).toBe(false)
    expect(await exists(checkoutDirFor(root, "no-such-row"))).toBe(false)
  })

  it("answers 0 for a checkouts root that does not exist yet", async () => {
    expect(await reconcileCheckouts(new InMemoryStorage(), join(await tmp(), "checkouts"))).toBe(0)
  })
})

describe("pruneSupersededCheckouts", () => {
  it("keeps the active checkout and the newest other one, removes the rest, and warns before each removal", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      // `deployed`, stated rather than defaulted: only a build that finished
      // is a candidate for the retained slot. See the "did not finish" test.
      const d = await storage.createDeployment({ projectId: project.id, status: "deployed" })
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
  it("keeps two server checkouts when the active deployment is a static upload with none (codex round 18)", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const older = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, older.id), { recursive: true })
    const newer = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, newer.id), { recursive: true })
    const upload = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    const removed: string[] = []
    await pruneSupersededCheckouts(storage, root, project.id, upload.id, async (id) => {
      removed.push(id)
    })
    expect(removed).toEqual([])
    expect(await exists(checkoutDirFor(root, older.id))).toBe(true)
    expect(await exists(checkoutDirFor(root, newer.id))).toBe(true)
  })
  it("leaves a build in flight alone, whether counting or pruning (codex round 21)", async () => {
    // An upload activates while a server build has moved its checkout into
    // place but not yet flipped to deployed. That checkout is the build's;
    // sweeping it as unfinished failed the build or activated it with no
    // checkout.
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const older = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, older.id), { recursive: true })
    const newer = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, newer.id), { recursive: true })
    const inFlight = await storage.createDeployment({ projectId: project.id, status: "building" })
    await mkdir(checkoutDirFor(root, inFlight.id), { recursive: true })
    const upload = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    const removed: string[] = []
    await pruneSupersededCheckouts(storage, root, project.id, upload.id, async (id) => {
      removed.push(id)
    })
    expect(removed).toEqual([])
    expect(await exists(checkoutDirFor(root, inFlight.id))).toBe(true)
    expect(await exists(checkoutDirFor(root, older.id))).toBe(true)
  })
  it("counts only deployments that have a checkout when choosing what to keep", async () => {
    // Codex round 9. A failed build, or a static one, has no checkout. When
    // one of those is NEWER than the previous server build, it used to take
    // the one retained slot, and the real previous checkout was pruned: a
    // pinned review of it broke, and there was nothing to roll back to.
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const previous = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, previous.id), { recursive: true })
    await storage.createDeployment({ projectId: project.id, status: "failed" }) // failed: no checkout
    const active = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, active.id), { recursive: true })
    const removed: string[] = []
    await pruneSupersededCheckouts(storage, root, project.id, active.id, async (id) => {
      removed.push(id)
    })
    expect(await exists(checkoutDirFor(root, previous.id))).toBe(true)
    expect(removed).toEqual([])
  })
  /**
   * Codex round 13. A build that never activated can still have left a
   * checkout on disk: the runner moves it into place BEFORE the deployment
   * and project rows are written, so a failure at either write leaves the
   * directory behind under a row marked failed. That directory used to count
   * as the retained previous checkout — and, being newer, it took the slot
   * from the last build anyone can actually review, which was then deleted.
   *
   * Only a deployment that finished is a candidate for the retained slot. The
   * rest are swept.
   */
  it("never retains a checkout whose deployment did not finish", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const previous = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, previous.id), { recursive: true })
    const failed = await storage.createDeployment({ projectId: project.id, status: "failed" })
    await mkdir(checkoutDirFor(root, failed.id), { recursive: true })
    const active = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    await mkdir(checkoutDirFor(root, active.id), { recursive: true })

    const removed: string[] = []
    await pruneSupersededCheckouts(storage, root, project.id, active.id, async (id) => {
      removed.push(id)
    })

    expect(await exists(checkoutDirFor(root, previous.id)), "the last reviewable checkout was deleted").toBe(true)
    expect(await exists(checkoutDirFor(root, failed.id))).toBe(false)
    expect(removed).toEqual([failed.id])
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
      const d = await storage.createDeployment({ projectId: project.id, status: "deployed" })
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
    // A server deployment: it has a checkout, so it takes one of the two
    // retained slots (since codex round 18 an active upload without one
    // takes none, and both others would be kept).
    await mkdir(checkoutDirFor(root, active.id), { recursive: true })
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

  /**
   * Codex round 11, Fix 3. `pruneSupersededCheckouts` is documented and
   * called as best-effort cleanup, but its `listDeployments` call used to sit
   * OUTSIDE any try: a transient storage error rejected the whole function.
   * Both callers (`build-queue.ts`, and the upload route in
   * `viewer/server/api/`) await this AFTER marking the deployment deployed
   * and active — so a rejection here used to unwind a successful activation:
   * the upload route marked the deployment failed and deleted the assets it
   * had just published, and the build queue rewrote a successful build as
   * failed. A storage fault must not be able to do that.
   */
  it("resolves and removes nothing when listDeployments rejects", async () => {
    const storage = { listDeployments: () => Promise.reject(new Error("storage is down")) }
    const root = await tmp()
    const before: string[] = []
    await expect(
      pruneSupersededCheckouts(storage, root, "proj-1", "active-id", async (id) => {
        before.push(id)
      }),
    ).resolves.toBeUndefined()
    expect(before).toEqual([])
  })

  /** The companion case: a real directory triggers beforeRemove, then the removal, then afterRemove, in that order. */
  it("triggers beforeRemove then afterRemove, in that order, for a deployment with a real checkout directory", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "p", name: "P" })
    const root = await tmp()
    const active = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    const stale = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    const newest = await storage.createDeployment({ projectId: project.id, status: "deployed" })
    // The active deployment is a server one with a checkout, so it takes one
    // of the two retained slots; an active upload without one takes none
    // (codex round 18), and nothing here would be stale.
    await mkdir(checkoutDirFor(root, active.id), { recursive: true })
    await mkdir(checkoutDirFor(root, stale.id), { recursive: true })
    // The newest needs a checkout of its own to take the retained slot;
    // since codex round 9 a row with no checkout does not count.
    await mkdir(checkoutDirFor(root, newest.id), { recursive: true })
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

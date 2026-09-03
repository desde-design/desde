import { expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seedDemoProject } from "./seed-demo-project"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { DiskAssetStore } from "../assets/disk-asset-store"
import { loadRuntimeConfig } from "../runtime-config"
import type { AssetStore } from "../assets/types"
import type { StorageAdapter } from "../storage/types"
import { upsertTestUser } from "../__tests__/user-fixtures"
import { canReadProject, loadProjectReadPolicy, makeProjectMembership } from "../auth/authorize"

let dataDir: string
let fixtureDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "viewer-demo-data-"))
  fixtureDir = mkdtempSync(join(tmpdir(), "viewer-demo-fixture-"))
  mkdirSync(join(fixtureDir, "assets"), { recursive: true })
  writeFileSync(join(fixtureDir, "index.html"), "<!doctype html><title>demo</title>")
  writeFileSync(join(fixtureDir, "assets", "app.js"), "console.log(1)")
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
})

const deps = () => ({
  storage: new InMemoryStorage(),
  // There is no in-memory AssetStore in this repo — DiskAssetStore against a
  // temp dir is the only impl, and it is what the other asset tests use.
  assets: new DiskAssetStore(join(dataDir, "assets")),
  dataDir,
  fixtureDir,
})

/**
 * Wraps a real AssetStore so its Nth `put` call throws instead of writing —
 * simulates a mid-seed failure (disk full, one unreadable fixture file)
 * partway through copying the demo's files.
 */
function assetStoreFailingOnNthPut(inner: AssetStore, n: number): AssetStore {
  let calls = 0
  return {
    async put(deploymentId, relPath, body) {
      calls++
      if (calls === n) throw new Error(`simulated write failure on put #${n}`)
      return inner.put(deploymentId, relPath, body)
    },
    async get(deploymentId, relPath) {
      return inner.get(deploymentId, relPath)
    },
    async deleteDeployment(deploymentId) {
      return inner.deleteDeployment(deploymentId)
    },
  }
}

/**
 * Wraps a real StorageAdapter so `deleteProject` always throws — simulates
 * the rollback's OWN cleanup step failing, to prove a cleanup failure never
 * shadows the original seed failure. `InMemoryStorage` has no TypeScript/JS
 * private (`#`) fields, only compile-time-private properties, so forwarding
 * through a Proxy is safe: `Reflect.get` on a plain data property ignores
 * the receiver, so methods still see the real internal state.
 */
function storageFailingDeleteProject(inner: StorageAdapter): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "deleteProject") {
        return async () => {
          throw new Error("simulated cleanup failure")
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as StorageAdapter
}

it("creates a public-link project with an active deployment", async () => {
  const d = deps()
  await expect(seedDemoProject(d)).resolves.toBe("seeded")
  const project = await d.storage.getProjectBySlug("demo")
  expect(project?.access).toBe("public-link")
  expect(project?.activeDeploymentId).not.toBeNull()
})

/**
 * The demo is the first thing a fresh install shows, and it must be clickable
 * before anyone signs in. Authorization v2 narrowed anonymous reading to
 * `public-link` projects under an enabled kill switch, so this asserts the
 * demo lands on the correct side of BOTH halves of that rule — driven through
 * the real `canReadProject`, not by re-reading `access` (which the test above
 * already does, and which would not catch a policy regression).
 */
it("stays anonymously readable through canReadProject with the public-link switch on", async () => {
  const d = deps()
  await seedDemoProject(d)
  const project = (await d.storage.getProjectBySlug("demo"))!

  const anonymous = { user: null, isAdmin: false }
  const membership = makeProjectMembership(d.storage)
  expect(await loadProjectReadPolicy(d.storage)).toEqual({ allowPublicLinks: true })
  expect(await canReadProject(anonymous, project, membership, { allowPublicLinks: true })).toBe(true)

  // ...and the operator's kill switch does reach it, which is the point of
  // the switch: an instance that turns public links off turns the demo off.
  expect(await canReadProject(anonymous, project, membership, { allowPublicLinks: false })).toBe(false)
})

it("copies every fixture file into the asset store, including nested ones", async () => {
  const d = deps()
  await seedDemoProject(d)
  const project = await d.storage.getProjectBySlug("demo")
  const id = project!.activeDeploymentId!
  expect(await d.assets.get(id, "index.html")).not.toBeNull()
  expect(await d.assets.get(id, "assets/app.js")).not.toBeNull()
})

it("marks the deployment deployed, not building", async () => {
  const d = deps()
  await seedDemoProject(d)
  const project = await d.storage.getProjectBySlug("demo")
  const deployment = await d.storage.getDeployment(project!.activeDeploymentId!)
  expect(deployment?.status).toBe("deployed")
})

it("does not seed twice", async () => {
  const d = deps()
  await seedDemoProject(d)
  await expect(seedDemoProject(d)).resolves.toBe("skipped")
})

it("does not re-seed after the demo project is deleted", async () => {
  const d = deps()
  await seedDemoProject(d)
  const project = await d.storage.getProjectBySlug("demo")
  await d.storage.deleteProject(project!.id)
  await expect(seedDemoProject(d)).resolves.toBe("skipped")
  expect(await d.storage.getProjectBySlug("demo")).toBeNull()
})

it("puts the given user on the demo's access list", async () => {
  // The row used to be what let the local operator upload to the demo at all
  // (`requireWrite`'s per-project membership check). Under Authorization v2 it
  // no longer carries authority — the operator uploads because their account
  // is `role: "admin"` — and the demo is `public-link`, so the row does not
  // affect readability either. It is kept as the honest record of who the
  // demo belongs to; Task 11 decides whether the add still happens.
  const d = deps()
  const user = await upsertTestUser(d.storage, {
    provider: "github",
    providerUserId: "local-operator",
    email: "operator@localhost",
    displayName: "Local operator",
    avatarUrl: "",
    role: "admin",
  })
  await seedDemoProject({ ...d, seedMemberUserId: user.id })
  const project = await d.storage.getProjectBySlug("demo")
  const members = await d.storage.listProjectMembers(project!.id)
  expect(members).toMatchObject([{ userId: user.id }])
})

it("seeds memberless when no seed member is given", async () => {
  const d = deps()
  await seedDemoProject(d)
  const project = await d.storage.getProjectBySlug("demo")
  expect(await d.storage.listProjectMembers(project!.id)).toEqual([])
})

it("skips when any project already exists", async () => {
  const d = deps()
  await d.storage.createProject({ slug: "mine", name: "Mine" })
  await expect(seedDemoProject(d)).resolves.toBe("skipped")
})

it("skips rather than throwing when the fixture directory is missing", async () => {
  const d = { ...deps(), fixtureDir: join(fixtureDir, "nope") }
  await expect(seedDemoProject(d)).resolves.toBe("skipped")
})

it("rolls back the half-built project when a mid-seed write fails, and a later call with a healthy store retries and succeeds", async () => {
  const d = deps()
  const flakyAssets = assetStoreFailingOnNthPut(d.assets, 2)

  await expect(seedDemoProject({ ...d, assets: flakyAssets })).rejects.toThrow(
    "simulated write failure on put #2",
  )
  // No half-built project left behind...
  expect(await d.storage.getProjectBySlug("demo")).toBeNull()
  // ...and no marker was written, so the next boot's "have we ever done
  // this?" check does not treat the broken attempt as handled.
  expect(loadRuntimeConfig(d.dataDir).demoSeededAt).toBeUndefined()

  // A later call, with a healthy store, retries on the now-clean slate and
  // succeeds — proving the failed attempt didn't permanently strand the
  // "any project exists" skip on a leftover row either.
  await expect(seedDemoProject(d)).resolves.toBe("seeded")
  const project = await d.storage.getProjectBySlug("demo")
  expect(project?.activeDeploymentId).not.toBeNull()
})

it("propagates the original failure, not a cleanup failure, when rollback's own deleteProject also throws", async () => {
  const d = deps()
  const flakyAssets = assetStoreFailingOnNthPut(d.assets, 2)
  const flakyStorage = storageFailingDeleteProject(d.storage)

  await expect(
    seedDemoProject({ ...d, storage: flakyStorage, assets: flakyAssets }),
  ).rejects.toThrow("simulated write failure on put #2")
})

// ── Seeded conversation (2026-09-01) ────────────────────────────────────────

it("seeds comments and replies when a page prefix is given", async () => {
  const d = deps()
  await seedDemoProject({ ...d, commentPagePrefix: "/p/demo/" })
  const project = (await d.storage.listProjects())[0]
  const comments = await d.storage.listComments(project.id)

  expect(comments).toHaveLength(4)
  expect(comments.flatMap((c) => c.replies)).toHaveLength(3)
  // One arrives already resolved, so the rail's Resolved toggle is not empty
  // on a first boot.
  expect(comments.filter((c) => c.resolved)).toHaveLength(1)
  // One comment on the Overview page, not two (Mo, 2026-09-02).
  const overview = comments.filter((c) => c.position.page === "/p/demo/")
  expect(overview).toHaveLength(1)
})

it("seeds nothing when no page prefix is given", async () => {
  // A wrong page key is worse than none: the threads would fill the rail while
  // their pins never appeared, which reads as a broken product rather than an
  // unseeded one.
  const d = deps()
  await seedDemoProject(d)
  const project = (await d.storage.listProjects())[0]
  expect(await d.storage.listComments(project.id)).toHaveLength(0)
})

it("keys every seeded comment to the prefix it was given", async () => {
  const d = deps()
  await seedDemoProject({ ...d, commentPagePrefix: "/" })
  const project = (await d.storage.listProjects())[0]
  const pages = new Set((await d.storage.listComments(project.id)).map((c) => c.position.page))
  // Root prefix, i.e. the prototype has an origin of its own.
  expect([...pages].sort()).toEqual(["/", "/settings", "/workspaces"])
})

it("gives every seeded author a uid strangers cannot mutate", async () => {
  // `mayMutateCommentContent` treats a non-`user:` uid as unowned and lets ANY
  // writer rewrite or delete it. On the public demo, where anonymous comments
  // are allowed, that is every visitor. This assertion is the guard.
  const d = deps()
  await seedDemoProject({ ...d, commentPagePrefix: "/p/demo/" })
  const project = (await d.storage.listProjects())[0]
  const comments = await d.storage.listComments(project.id)
  const authors = [...comments.map((c) => c.author), ...comments.flatMap((c) => c.replies.map((r) => r.author))]
  expect(authors).not.toHaveLength(0)
  for (const a of authors) expect(a.uid.startsWith("user:")).toBe(true)
})

it("says nothing in first person, and uses no em dashes", async () => {
  // Both are absolute copy rules, and seeded text is copy: on the public demo
  // it is the first thing most people read in this product.
  const d = deps()
  await seedDemoProject({ ...d, commentPagePrefix: "/p/demo/" })
  const project = (await d.storage.listProjects())[0]
  const comments = await d.storage.listComments(project.id)
  const text = [...comments.map((c) => c.body), ...comments.flatMap((c) => c.replies.map((r) => r.body))]
  expect(text).not.toHaveLength(0)
  for (const body of text) {
    expect(body).not.toContain("—")
    expect(body.toLowerCase()).not.toMatch(/\b(me|my)\b/)
  }
})

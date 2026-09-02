/**
 * Tests for the per-user project registry (`~/.desde/projects.json`).
 *
 * `HOME` is redirected to a tmp dir per test so we exercise the real
 * `homedir()`-derived path without touching the developer's actual
 * registry. Covers: empty-on-absent, round-trip, upsert-by-path,
 * most-recent-first ordering, field merge, corrupt-file tolerance, and
 * removal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  projectsRegistryPath,
  readProjectsRegistry,
  removeProjectRegistryEntry,
  upsertProjectRegistryEntry,
} from "../projects-registry.js"

let tmpHome: string
let realHome: string | undefined

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "projects-registry-"))
  realHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe("projects-registry", () => {
  it("returns an empty registry when the file is absent", async () => {
    expect(await readProjectsRegistry()).toEqual({ version: 1, projects: [] })
  })

  it("writes under ~/.desde/projects.json", async () => {
    await upsertProjectRegistryEntry({ path: "/repo/a" })
    expect(projectsRegistryPath()).toBe(
      path.join(tmpHome, ".desde", "projects.json"),
    )
    const onDisk = JSON.parse(
      await fs.readFile(projectsRegistryPath(), "utf-8"),
    )
    expect(onDisk.projects[0].path).toBe("/repo/a")
  })

  it("upserts by path and keeps most-recent first", async () => {
    await upsertProjectRegistryEntry({ path: "/repo/a", lastPort: 4321 })
    await upsertProjectRegistryEntry({ path: "/repo/b", lastPort: 4322 })
    const reg = await readProjectsRegistry()
    expect(reg.projects.map((p) => p.path)).toEqual(["/repo/b", "/repo/a"])

    // Re-opening A moves it back to the front without duplicating.
    await upsertProjectRegistryEntry({ path: "/repo/a", lastPort: 4399 })
    const reg2 = await readProjectsRegistry()
    expect(reg2.projects.map((p) => p.path)).toEqual(["/repo/a", "/repo/b"])
    expect(reg2.projects).toHaveLength(2)
    expect(reg2.projects[0].lastPort).toBe(4399)
  })

  it("merges newly-known fields but preserves prior ones", async () => {
    await upsertProjectRegistryEntry({
      path: "/repo/a",
      slug: "my-app",
      lastPort: 4321,
    })
    // A later boot learns the projectId but doesn't re-supply the slug.
    await upsertProjectRegistryEntry({ path: "/repo/a", projectId: "proj-1" })
    const [entry] = (await readProjectsRegistry()).projects
    expect(entry.projectId).toBe("proj-1")
    expect(entry.slug).toBe("my-app")
    expect(entry.lastPort).toBe(4321)
  })

  it("tolerates a corrupt registry file (degrades to empty, then repairs)", async () => {
    await fs.mkdir(path.join(tmpHome, ".desde"), { recursive: true })
    await fs.writeFile(projectsRegistryPath(), "{ not json", "utf-8")
    expect(await readProjectsRegistry()).toEqual({ version: 1, projects: [] })

    // A subsequent upsert overwrites the garbage with a valid registry.
    await upsertProjectRegistryEntry({ path: "/repo/a" })
    const reg = await readProjectsRegistry()
    expect(reg.projects).toHaveLength(1)
  })

  describe("removeProjectRegistryEntry", () => {
    it("drops the named entry and leaves the others in order", async () => {
      await upsertProjectRegistryEntry({ path: "/repo/a" })
      await upsertProjectRegistryEntry({ path: "/repo/b" })
      await upsertProjectRegistryEntry({ path: "/repo/c" })

      expect(await removeProjectRegistryEntry("/repo/b")).toBe(true)

      const reg = await readProjectsRegistry()
      // Most-recently-upserted first, minus the removed one.
      expect(reg.projects.map((p) => p.path)).toEqual(["/repo/c", "/repo/a"])
    })

    it("reports false for a path that was never in the list, and writes nothing", async () => {
      await upsertProjectRegistryEntry({ path: "/repo/a" })
      const before = await fs.readFile(projectsRegistryPath(), "utf-8")

      expect(await removeProjectRegistryEntry("/repo/never")).toBe(false)

      // Byte-identical: a no-op removal must not rewrite the file, or two
      // launchers racing on unrelated deletes would clobber each other's.
      expect(await fs.readFile(projectsRegistryPath(), "utf-8")).toBe(before)
    })

    it("removes an entry whose folder no longer exists", async () => {
      // The registry is a cache of paths, not a directory listing. A folder
      // moved or deleted outside the app leaves a dead row, and that row is
      // exactly the one a user most wants to clear.
      await upsertProjectRegistryEntry({ path: "/repo/gone-from-disk" })
      expect(await removeProjectRegistryEntry("/repo/gone-from-disk")).toBe(true)
      expect((await readProjectsRegistry()).projects).toHaveLength(0)
    })

    it("is a no-op on an absent registry rather than creating one", async () => {
      expect(await removeProjectRegistryEntry("/repo/a")).toBe(false)
      await expect(fs.access(projectsRegistryPath())).rejects.toThrow()
    })
  })
})

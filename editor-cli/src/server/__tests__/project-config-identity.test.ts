import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  readProjectConfig,
  ensureProjectIdentity,
  renameProjectIdentity,
} from "../project-config.js"

/**
 * Embedded project identity (schema v2) in `.desde/config.json`.
 *
 * Two invariants under test, both load-bearing for two independently deployed
 * surfaces sharing one config file:
 *   1. v1 configs keep working untouched, and v2 configs need no `projectSlug`.
 *   2. Identity is written ONLY by an explicit action, never at boot, and the
 *      write preserves keys this build has never heard of.
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pt-identity-"))
  await fs.mkdir(join(root, ".desde"), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeConfig(obj: unknown): Promise<void> {
  await fs.writeFile(
    join(root, ".desde", "config.json"),
    JSON.stringify(obj, null, 2),
  )
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(join(root, ".desde", "config.json"), "utf-8"),
  ) as Record<string, unknown>
}

describe("readProjectConfig — schema compatibility", () => {
  it("reads a v1 config that has only projectSlug", async () => {
    await writeConfig({ version: 1, projectSlug: "legacy-proto" })
    const result = await readProjectConfig(root)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.projectSlug).toBe("legacy-proto")
    expect(result.ok && result.config.project).toBeUndefined()
  })

  it("reads a v2 config with no projectSlug at all", async () => {
    await writeConfig({
      version: 2,
      project: { id: "abc123def", name: "AI Gateway", slug: "ai-gateway" },
    })
    const result = await readProjectConfig(root)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.project?.name).toBe("AI Gateway")
    expect(result.ok && result.config.project?.id).toBe("abc123def")
  })

  it("reads a v2 config that ALSO carries a legacy projectSlug", async () => {
    await writeConfig({
      version: 2,
      projectSlug: "legacy-proto",
      project: { id: "abc123def", name: "AI Gateway", slug: "ai-gateway" },
    })
    const result = await readProjectConfig(root)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.projectSlug).toBe("legacy-proto")
    expect(result.ok && result.config.project?.id).toBe("abc123def")
  })

  it("degrades to no identity when the project block is malformed", async () => {
    await writeConfig({ version: 2, project: { name: "no id here" } })
    const result = await readProjectConfig(root)
    // A bad identity must not fail the WHOLE config — the rest of the file
    // (conventions, chat quotas) is still usable, and boot must not block.
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.project).toBeUndefined()
  })
})

describe("ensureProjectIdentity", () => {
  it("mints and persists an identity when none exists", async () => {
    await writeConfig({ version: 1, projectSlug: "legacy" })
    const identity = await ensureProjectIdentity(root, { name: "AI Gateway" })
    expect(identity.name).toBe("AI Gateway")
    expect(identity.id).toBeTruthy()
    const raw = await readRaw()
    expect(raw.version).toBe(2)
    expect((raw.project as Record<string, unknown>).id).toBe(identity.id)
  })

  it("is idempotent — a second call returns the SAME id and does not rename", async () => {
    await writeConfig({ version: 1 })
    const first = await ensureProjectIdentity(root, { name: "One" })
    const second = await ensureProjectIdentity(root, { name: "Ignored" })
    expect(second.id).toBe(first.id)
    expect(second.name).toBe("One")
  })

  it("preserves unknown keys written by a newer peer", async () => {
    await writeConfig({
      version: 1,
      conventions: { useRepoConventions: false },
      futureThing: 42,
    })
    await ensureProjectIdentity(root, { name: "Proto" })
    const raw = await readRaw()
    expect(raw.futureThing).toBe(42)
    expect(raw.conventions).toEqual({ useRepoConventions: false })
  })

  it("creates the config when the repo has none", async () => {
    const identity = await ensureProjectIdentity(root, { name: "Fresh" })
    const raw = await readRaw()
    expect((raw.project as Record<string, unknown>).id).toBe(identity.id)
  })

  it("refuses rather than clobbering an unparseable config", async () => {
    await fs.writeFile(
      join(root, ".desde", "config.json"),
      "{ this is not json",
    )
    await expect(
      ensureProjectIdentity(root, { name: "Proto" }),
    ).rejects.toThrow(/not valid JSON/i)
  })

  it("refuses a schema version it does not know, rather than minting over it", async () => {
    // The create flow runs against clones too; a newer peer's file must not
    // come back as v2 with a fresh id. Same guard the rename path has.
    await writeConfig({ version: 3, someNewV3Field: { x: 1 } })
    await expect(ensureProjectIdentity(root, { name: "Proto" })).rejects.toThrow(
      /schema version 3 is not supported/,
    )
    expect(await readRaw()).toEqual({ version: 3, someNewV3Field: { x: 1 } })

    await writeConfig({ conventions: { useRepoConventions: false } })
    await expect(ensureProjectIdentity(root, { name: "Proto" })).rejects.toThrow(
      /schema version undefined/,
    )
  })

  it("treats an empty file as no config and mints", async () => {
    await fs.writeFile(join(root, ".desde", "config.json"), "\n")
    const identity = await ensureProjectIdentity(root, { name: "Empty" })
    expect((await readRaw()).project).toMatchObject({ id: identity.id, name: "Empty" })
  })

  it("falls back to a placeholder rather than persisting a blank name", async () => {
    const identity = await ensureProjectIdentity(root, { name: "   " })
    expect(identity.name).toBe("Untitled project")
    expect(identity.slug).toBeTruthy()
  })
})

/**
 * The config write predates the `.desde` guard, and a prototype repo is
 * untrusted input: shipping `.desde` as a symlink used to land `config.json`
 * (and, once the stores followed, every note and comment) wherever the link
 * pointed. See `src/editor/worktree/desde-dir.ts`.
 */
describe("project config under a symlinked .desde", () => {
  let linked: string
  let target: string

  beforeEach(async () => {
    linked = await mkdtemp(join(tmpdir(), "pt-identity-linked-"))
    target = join(linked, "target")
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, join(linked, ".desde"))
  })

  afterEach(async () => {
    await rm(linked, { recursive: true, force: true })
  })

  it("refuses to create the project identity, and writes nothing at the link target", async () => {
    await expect(
      ensureProjectIdentity(linked, { name: "Hostile" }),
    ).rejects.toThrow(/\.desde is a symbolic link/)
    expect(await fs.readdir(target)).toEqual([])
  })

  it("reports the config as unreadable rather than following the link", async () => {
    await fs.writeFile(
      join(target, "config.json"),
      JSON.stringify({ version: 1, projectSlug: "outside" }),
    )
    const result = await readProjectConfig(linked)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: "malformed" })
    expect((result as { message: string }).message).toMatch(
      /\.desde is a symbolic link/,
    )
  })
})

describe("renameProjectIdentity", () => {
  it("changes the name and keeps the id AND the slug", async () => {
    // The slug is a routing preference the viewer may already serve the
    // project at; a rename must not move the URL out from under a link.
    const minted = await ensureProjectIdentity(root, { name: "One" })
    const renamed = await renameProjectIdentity(root, "Two")
    expect(renamed).toEqual({ ...minted, name: "Two" })
    const raw = await readRaw()
    expect(raw.project).toEqual({ id: minted.id, name: "Two", slug: minted.slug })
    expect((await readProjectConfig(root) as { config: { project?: { name: string } } }).config.project?.name).toBe("Two")
  })

  it("preserves every other key", async () => {
    await writeConfig({ version: 1, conventions: { useRepoConventions: false }, futureThing: 42 })
    await ensureProjectIdentity(root, { name: "One" })
    await renameProjectIdentity(root, "Two")
    const raw = await readRaw()
    expect(raw.futureThing).toBe(42)
    expect(raw.conventions).toEqual({ useRepoConventions: false })
  })

  it("keeps keys under `project` that this build has never heard of", async () => {
    // A newer peer may write additive fields inside the identity block; a
    // rename that rebuilt the block from known fields would delete them.
    await writeConfig({
      version: 2,
      project: { id: "id-1", name: "One", slug: "one", futureField: { nested: true } },
    })
    const renamed = await renameProjectIdentity(root, "Two")
    expect(renamed).toMatchObject({ id: "id-1", name: "Two", slug: "one" })
    expect((await readRaw()).project).toEqual({
      id: "id-1",
      name: "Two",
      slug: "one",
      futureField: { nested: true },
    })
  })

  it("persists a slug that was only ever derived, so the rename does not move it", async () => {
    // A block with no slug gets `deriveSlug(name)` on every read. Leaving it
    // absent would let the NEXT read derive a new slug from the new name.
    await writeConfig({ version: 2, project: { id: "id-1", name: "One" } })
    const renamed = await renameProjectIdentity(root, "Two")
    expect(renamed.slug).toBe("one")
    expect((await readRaw()).project).toEqual({ id: "id-1", name: "Two", slug: "one" })
    const reread = await readProjectConfig(root)
    expect(reread.ok && reread.config.project?.slug).toBe("one")
  })

  it("refuses a schema version this build does not know, rather than relabelling it", async () => {
    await writeConfig({ version: 3, project: { id: "id-1", name: "One", slug: "one" }, newer: true })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/schema version 3 is not supported/)
    expect(await readRaw()).toEqual({
      version: 3,
      project: { id: "id-1", name: "One", slug: "one" },
      newer: true,
    })
  })

  it("mints when there is no identity block at all: a v1 config, or no config", async () => {
    // The Settings page can show a repo opened straight from a folder; its
    // first name is a mint, not a rename.
    await writeConfig({ version: 1, projectSlug: "legacy", futureThing: 42 })
    const minted = await renameProjectIdentity(root, "First name")
    expect(minted.name).toBe("First name")
    expect((await readRaw()).project).toMatchObject({ id: minted.id, name: "First name" })
    expect((await readRaw()).futureThing).toBe(42)

    await rm(join(root, ".desde"), { recursive: true, force: true })
    const fresh = await renameProjectIdentity(root, "From nothing")
    expect((await readRaw()).project).toMatchObject({ id: fresh.id, name: "From nothing" })
  })

  it("refuses a malformed identity block rather than replacing it", async () => {
    // The minter would put a fresh id here, and the id is the join key.
    await writeConfig({ version: 2, project: { name: "No id", slug: "no-id" } })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/malformed/)
    expect((await readRaw()).project).toEqual({ name: "No id", slug: "no-id" })
  })

  it("refuses an unsupported version even when there is no block to rename, rather than minting over it", async () => {
    // The mint branch must not reach the minter first: it rewrites the file
    // as v2 as well.
    await writeConfig({ version: 3, futureThing: true })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/schema version 3 is not supported/)
    expect(await readRaw()).toEqual({ version: 3, futureThing: true })

    await writeConfig({ futureThing: true })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/schema version undefined/)
    expect(await readRaw()).toEqual({ futureThing: true })
  })

  it("repairs a block whose defects are confined to the name", async () => {
    // Supplying a name is exactly the repair being asked for, and the name
    // is the one field this write overwrites anyway. The slug is derived
    // from the NEW name only when there was none to keep.
    await writeConfig({ version: 2, project: { id: "id-1", name: "  " } })
    expect(await renameProjectIdentity(root, "Fixed")).toEqual({ id: "id-1", name: "Fixed", slug: "fixed" })
    expect((await readRaw()).project).toEqual({ id: "id-1", name: "Fixed", slug: "fixed" })

    await writeConfig({ version: 2, project: { id: "id-1", name: 5, slug: "five" } })
    expect(await renameProjectIdentity(root, "Fixed")).toEqual({ id: "id-1", name: "Fixed", slug: "five" })

    await writeConfig({ version: 2, project: { id: "id-1", slug: "kept" } })
    expect(await renameProjectIdentity(root, "Fixed")).toEqual({ id: "id-1", name: "Fixed", slug: "kept" })

    // A defect anywhere else is still refused.
    await writeConfig({ version: 2, project: { id: 42, name: "Something" } })
    await expect(renameProjectIdentity(root, "Fixed")).rejects.toThrow(/malformed/)
  })

  it("treats an empty file like no file: both writers mint", async () => {
    await fs.writeFile(join(root, ".desde", "config.json"), "")
    const minted = await renameProjectIdentity(root, "Empty")
    expect((await readRaw()).project).toMatchObject({ id: minted.id, name: "Empty" })
  })

  it("reports a read failure as a read failure, not as bad JSON", async () => {
    // config.json as a directory: EISDIR, not a parse error.
    await fs.mkdir(join(root, ".desde", "config.json"))
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/could not be read/)
    await expect(ensureProjectIdentity(root, { name: "Two" })).rejects.toThrow(/could not be read/)
  })

  it("refuses a missing or non-numeric version on a config that has a block", async () => {
    await writeConfig({ version: "3", project: { id: "id-1", name: "One", slug: "one" } })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/schema version "3" is not supported/)
    expect((await readRaw()).version).toBe("3")

    await writeConfig({ project: { id: "id-1", name: "One", slug: "one" } })
    await expect(renameProjectIdentity(root, "Two")).rejects.toThrow(/schema version undefined is not supported/)
    expect((await readRaw()).project).toMatchObject({ name: "One" })
  })

  it("refuses a blank name", async () => {
    await ensureProjectIdentity(root, { name: "One" })
    await expect(renameProjectIdentity(root, "   ")).rejects.toThrow(/name/i)
    expect((await readRaw()).project).toMatchObject({ name: "One" })
  })
})

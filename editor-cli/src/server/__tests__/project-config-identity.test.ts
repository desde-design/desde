import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readProjectConfig, ensureProjectIdentity } from "../project-config.js"

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

  it("falls back to a placeholder rather than persisting a blank name", async () => {
    const identity = await ensureProjectIdentity(root, { name: "   " })
    expect(identity.name).toBe("Untitled project")
    expect(identity.slug).toBeTruthy()
  })
})

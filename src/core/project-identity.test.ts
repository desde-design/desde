import { describe, expect, it } from "vitest"
import {
  deriveSlug,
  mintProjectId,
  parseProjectIdentity,
  readIdentityFromConfig,
  writeIdentityIntoConfig,
} from "./project-identity"

describe("mintProjectId", () => {
  it("returns a distinct opaque id each call", () => {
    const a = mintProjectId()
    const b = mintProjectId()
    expect(a).not.toEqual(b)
    expect(a.length).toBeGreaterThan(8)
  })
})

describe("deriveSlug", () => {
  it("lowercases, collapses non-alphanumerics to one hyphen, trims", () => {
    expect(deriveSlug("AI Gateway")).toBe("ai-gateway")
    expect(deriveSlug("  My__Cool  Proto!! ")).toBe("my-cool-proto")
  })

  it("caps length and never ends on a hyphen", () => {
    const slug = deriveSlug("x".repeat(100))
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug.endsWith("-")).toBe(false)
  })

  it("falls back when a name has no usable characters", () => {
    expect(deriveSlug("!!!")).toBe("project")
    expect(deriveSlug("")).toBe("project")
  })
})

describe("parseProjectIdentity", () => {
  it("accepts a well-formed identity", () => {
    const r = parseProjectIdentity({
      id: "abc123def",
      name: "AI Gateway",
      slug: "ai-gateway",
    })
    expect(r.ok).toBe(true)
  })

  it("rejects a missing or blank id", () => {
    expect(parseProjectIdentity({ name: "x", slug: "x" }).ok).toBe(false)
    expect(parseProjectIdentity({ id: "  ", name: "x", slug: "x" }).ok).toBe(false)
  })

  it("rejects a blank name", () => {
    expect(
      parseProjectIdentity({ id: "abc123def", name: "   ", slug: "x" }).ok,
    ).toBe(false)
  })

  it("derives a slug when absent rather than failing", () => {
    const r = parseProjectIdentity({ id: "abc123def", name: "AI Gateway" })
    expect(r.ok && r.identity.slug).toBe("ai-gateway")
  })

  it("rejects a non-object", () => {
    expect(parseProjectIdentity(null).ok).toBe(false)
    expect(parseProjectIdentity("nope").ok).toBe(false)
    expect(parseProjectIdentity([]).ok).toBe(false)
  })
})

describe("readIdentityFromConfig", () => {
  it("returns null for a v1 config with no project block", () => {
    expect(readIdentityFromConfig({ version: 1, projectSlug: "legacy" })).toBeNull()
  })

  it("reads a v2 project block", () => {
    const identity = readIdentityFromConfig({
      version: 2,
      project: { id: "abc123def", name: "AI Gateway", slug: "ai-gateway" },
    })
    expect(identity?.name).toBe("AI Gateway")
    expect(identity?.id).toBe("abc123def")
  })

  it("returns null rather than throwing on a malformed block", () => {
    expect(readIdentityFromConfig({ version: 2, project: { name: "no id" } })).toBeNull()
    expect(readIdentityFromConfig({ version: 2, project: "nope" })).toBeNull()
    expect(readIdentityFromConfig(null)).toBeNull()
  })
})

describe("writeIdentityIntoConfig", () => {
  it("preserves every unknown key so a newer peer's fields survive", () => {
    const before = {
      version: 1,
      projectSlug: "legacy",
      conventions: { useRepoConventions: true },
      someFutureKey: { nested: [1, 2, 3] },
    }
    const after = writeIdentityIntoConfig(before, {
      id: "abc123def",
      name: "AI Gateway",
      slug: "ai-gateway",
    })
    expect(after.someFutureKey).toEqual({ nested: [1, 2, 3] })
    expect(after.conventions).toEqual({ useRepoConventions: true })
    expect(after.projectSlug).toBe("legacy")
  })

  it("bumps version to 2 and writes the project block", () => {
    const after = writeIdentityIntoConfig({ version: 1 }, {
      id: "abc123def",
      name: "AI Gateway",
      slug: "ai-gateway",
    }) as Record<string, unknown>
    expect(after.version).toBe(2)
    expect(after.project).toEqual({
      id: "abc123def",
      name: "AI Gateway",
      slug: "ai-gateway",
    })
  })

  it("does not mutate its input", () => {
    const before = { version: 1 }
    writeIdentityIntoConfig(before, { id: "a1b2c3d4e", name: "N", slug: "n" })
    expect(before).toEqual({ version: 1 })
  })

  it("omits viewerUrl when absent rather than writing undefined", () => {
    const after = writeIdentityIntoConfig({}, {
      id: "a1b2c3d4e",
      name: "N",
      slug: "n",
    }) as Record<string, unknown>
    expect(Object.keys(after.project as object)).toEqual(["id", "name", "slug"])
  })

  it("round-trips through readIdentityFromConfig", () => {
    const identity = {
      id: "a1b2c3d4e",
      name: "Round Trip",
      slug: "round-trip",
      viewerUrl: "https://viewer.example",
    }
    expect(readIdentityFromConfig(writeIdentityIntoConfig({}, identity))).toEqual(
      identity,
    )
  })
})

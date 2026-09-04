import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProjectConfig, writeProjectConfig } from "../project-config.js"

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-cfg-"))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function writeConfig(contents: string | object): Promise<void> {
  await mkdir(join(repoRoot, ".desde"), { recursive: true })
  const text = typeof contents === "string" ? contents : JSON.stringify(contents)
  await writeFile(join(repoRoot, ".desde/config.json"), text, "utf-8")
}

describe("readProjectConfig — happy path", () => {
  it("parses a minimal valid config", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app" })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: { version: 1, projectSlug: "my-app" },
    })
  })

  it("parses a config with platformBaseUrl override", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      platformBaseUrl: "https://staging.desde.dev",
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        projectSlug: "my-app",
        platformBaseUrl: "https://staging.desde.dev",
      },
    })
  })

  it("parses a config with a cloud projectId", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      projectId: "3f2a1c9e-0b7d-4e21-9a5f-1234567890ab",
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        projectSlug: "my-app",
        projectId: "3f2a1c9e-0b7d-4e21-9a5f-1234567890ab",
      },
    })
  })

  it("accepts single-character slugs", async () => {
    await writeConfig({ version: 1, projectSlug: "a" })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
  })

  it("accepts hyphenated slugs", async () => {
    await writeConfig({ version: 1, projectSlug: "my-cool-app-2" })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
  })
})

describe("readProjectConfig — failure paths", () => {
  it("returns reason 'missing' when the file does not exist", async () => {
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "missing",
    })
  })

  it("returns reason 'malformed' on invalid JSON", async () => {
    await writeConfig("{ not valid json")
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' when the root is not an object", async () => {
    await writeConfig([1, 2, 3] as unknown as object)
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' when version is missing", async () => {
    await writeConfig({ projectSlug: "my-app" } as unknown as object)
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' when projectId is an empty string", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", projectId: "" })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })

  it("returns reason 'malformed' when projectId contains a slash or space", async () => {
    for (const bad of ["a/b", "has space", "dot.ted", "..\\evil"]) {
      await writeConfig({ version: 1, projectSlug: "my-app", projectId: bad })
      const result = await readProjectConfig(repoRoot)
      expect(result).toMatchObject({ ok: false, reason: "malformed" })
    }
  })

  it("returns reason 'unsupported-version' on a future version", async () => {
    // 1 and 2 are both readable now (v2 carries the embedded identity), so
    // the first genuinely-unknown version is 3.
    await writeConfig({ version: 3, projectSlug: "my-app" })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported-version",
    })
  })

  it("accepts a config with no projectSlug at all", async () => {
    // `projectSlug` became OPTIONAL with schema v2: identity moved to the
    // `project` block. A repo carrying neither is valid — it just hasn't had
    // a project created for it yet, and the CLI must not mint one at boot.
    await writeConfig({ version: 1 } as unknown as object)
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.projectSlug).toBeUndefined()
  })

  it("returns reason 'malformed' when projectSlug is present but empty", async () => {
    // Absent is fine; present-and-empty is a typo worth surfacing.
    await writeConfig({ version: 1, projectSlug: "" })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' on slug with uppercase letters", async () => {
    await writeConfig({ version: 1, projectSlug: "MyApp" })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' on slug with leading/trailing hyphen", async () => {
    await writeConfig({ version: 1, projectSlug: "-my-app" })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
    await writeConfig({ version: 1, projectSlug: "my-app-" })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
  })

  it("returns reason 'malformed' on slug with spaces or path traversal", async () => {
    await writeConfig({ version: 1, projectSlug: "my app" })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
    await writeConfig({ version: 1, projectSlug: "../escape" })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
  })

  it("returns reason 'malformed' on non-http platformBaseUrl", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      platformBaseUrl: "ftp://malicious.example",
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' on relative platformBaseUrl", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      platformBaseUrl: "/api",
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })

  it("returns reason 'malformed' on non-string platformBaseUrl", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      platformBaseUrl: 42 as unknown as string,
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: false,
      reason: "malformed",
    })
  })
})

describe("writeProjectConfig — merge-preserving link write", () => {
  it("creates a fresh config with projectId + slug when none exists", async () => {
    await writeProjectConfig(repoRoot, {
      projectSlug: "my-app",
      projectId: "proj-123",
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: { version: 1, projectSlug: "my-app", projectId: "proj-123" },
    })
  })

  it("preserves existing chat / conventions keys when linking", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "old-slug",
      chat: { maxModelCallsPerTurn: 5 },
      conventions: { useRepoConventions: false },
    })
    await writeProjectConfig(repoRoot, {
      projectSlug: "new-slug",
      projectId: "proj-xyz",
    })
    const onDisk = JSON.parse(
      await readFile(join(repoRoot, ".desde/config.json"), "utf-8"),
    )
    // Association fields overwritten; user tunables preserved.
    expect(onDisk.projectSlug).toBe("new-slug")
    expect(onDisk.projectId).toBe("proj-xyz")
    expect(onDisk.chat).toEqual({ maxModelCallsPerTurn: 5 })
    expect(onDisk.conventions).toEqual({ useRepoConventions: false })
  })

  it("preserves unknown future keys the schema doesn't model", async () => {
    await writeConfig({ version: 1, projectSlug: "s", futureKey: { a: 1 } })
    await writeProjectConfig(repoRoot, {
      projectSlug: "s",
      projectId: "p",
    })
    const onDisk = JSON.parse(
      await readFile(join(repoRoot, ".desde/config.json"), "utf-8"),
    )
    expect(onDisk.futureKey).toEqual({ a: 1 })
  })

  it("writes a platformBaseUrl when provided", async () => {
    const merged = await writeProjectConfig(repoRoot, {
      projectSlug: "s",
      projectId: "p",
      platformBaseUrl: "https://staging.example.com",
    })
    expect(merged.platformBaseUrl).toBe("https://staging.example.com")
  })

  it("refuses to overwrite a non-object config file", async () => {
    await writeConfig("[1, 2, 3]")
    await expect(
      writeProjectConfig(repoRoot, { projectSlug: "s", projectId: "p" }),
    ).rejects.toThrow(/not a JSON object/i)
  })
})

describe("readProjectConfig — conventions section", () => {
  it("parses conventions with useRepoConventions + excludeFiles", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      conventions: {
        useRepoConventions: false,
        excludeFiles: ["docs/internal.md", "AGENTS.md"],
      },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        projectSlug: "my-app",
        conventions: {
          useRepoConventions: false,
          excludeFiles: ["docs/internal.md", "AGENTS.md"],
        },
      },
    })
  })

  it("omits conventions entirely when the section is empty", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", conventions: {} })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: { version: 1, projectSlug: "my-app" },
    })
  })

  it("returns 'malformed' when conventions is not an object", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      conventions: "on" as unknown as object,
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })

  it("returns 'malformed' when useRepoConventions is not a boolean", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      conventions: { useRepoConventions: "yes" as unknown as boolean },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })

  it("returns 'malformed' when excludeFiles has a non-string / empty entry", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      conventions: { excludeFiles: ["ok.md", ""] as unknown as string[] },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })
})

describe("readProjectConfig — chat.detachedSessions (Phase 5)", () => {
  it("parses chat.detachedSessions: false (opt-out)", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: { detachedSessions: false },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toEqual({
      ok: true,
      config: {
        version: 1,
        projectSlug: "my-app",
        chat: { detachedSessions: false },
      },
    })
  })

  it("parses chat.detachedSessions: true (explicit opt-in)", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: { detachedSessions: true },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: true,
      config: { chat: { detachedSessions: true } },
    })
  })

  it("omits detachedSessions when the field is not present (caller treats as default-on)", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: { maxModelCallsPerTurn: 5 },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: true,
      config: {
        chat: { maxModelCallsPerTurn: 5 },
      },
    })
    if (result.ok) {
      expect(result.config.chat?.detachedSessions).toBeUndefined()
    }
  })

  it("coexists with other chat.* fields", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: {
        maxModelCallsPerTurn: 5,
        costCeilingUsd: 1.5,
        detachedSessions: false,
      },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: true,
      config: {
        chat: {
          maxModelCallsPerTurn: 5,
          costCeilingUsd: 1.5,
          detachedSessions: false,
        },
      },
    })
  })

  it("returns 'malformed' when detachedSessions is not a boolean", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: { detachedSessions: "off" as unknown as boolean },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
    if (!result.ok) {
      expect(result.message).toMatch(/chat\.detachedSessions/)
    }
  })
})

describe("readProjectConfig — chat.costCeilingUsd null/0 opt-out (audit Task 15)", () => {
  it("parses an explicit positive costCeilingUsd verbatim", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", chat: { costCeilingUsd: 7.5 } })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: true, config: { chat: { costCeilingUsd: 7.5 } } })
  })

  it("normalizes explicit null to null (opt-out marker)", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", chat: { costCeilingUsd: null } })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: true, config: { chat: { costCeilingUsd: null } } })
  })

  it("normalizes explicit 0 to null (opt-out marker)", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", chat: { costCeilingUsd: 0 } })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: true, config: { chat: { costCeilingUsd: null } } })
  })

  it("omits costCeilingUsd entirely when the key is absent (caller applies the soft default)", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", chat: { maxModelCallsPerTurn: 3 } })
    const result = await readProjectConfig(repoRoot)
    if (result.ok) {
      expect(result.config.chat?.costCeilingUsd).toBeUndefined()
    } else {
      throw new Error("expected ok:true")
    }
  })

  it("returns 'malformed' on a negative costCeilingUsd", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app", chat: { costCeilingUsd: -5 } })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })

  it("returns 'malformed' on a non-number, non-null costCeilingUsd", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      chat: { costCeilingUsd: "unlimited" as unknown as number },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })
})

describe("readProjectConfig — retention (audit Task 15)", () => {
  it("parses a full retention block", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: {
        backups: { keepNewest: 50, maxAgeDays: 7 },
        chatSessionTurns: { maxTurns: 100 },
      },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({
      ok: true,
      config: {
        retention: {
          backups: { keepNewest: 50, maxAgeDays: 7 },
          chatSessionTurns: { maxTurns: 100 },
        },
      },
    })
  })

  it("omits retention entirely when absent (caller applies documented defaults)", async () => {
    await writeConfig({ version: 1, projectSlug: "my-app" })
    const result = await readProjectConfig(repoRoot)
    if (result.ok) {
      expect(result.config.retention).toBeUndefined()
    } else {
      throw new Error("expected ok:true")
    }
  })

  it("accepts a partial retention.backups block (only keepNewest)", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: { backups: { keepNewest: 10 } },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: true, config: { retention: { backups: { keepNewest: 10 } } } })
  })

  it("returns 'malformed' when retention.backups.keepNewest is not a positive integer", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: { backups: { keepNewest: 0 } },
    })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: { backups: { keepNewest: 1.5 } },
    })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
  })

  it("returns 'malformed' when retention.backups.maxAgeDays is not a positive finite number", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: { backups: { maxAgeDays: -1 } },
    })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
  })

  it("returns 'malformed' when retention.chatSessionTurns.maxTurns is not a positive integer", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: { chatSessionTurns: { maxTurns: -100 } },
    })
    expect((await readProjectConfig(repoRoot)).ok).toBe(false)
  })

  it("returns 'malformed' when retention itself is not an object", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "my-app",
      retention: "yes" as unknown as object,
    })
    const result = await readProjectConfig(repoRoot)
    expect(result).toMatchObject({ ok: false, reason: "malformed" })
  })

  it("preserves retention across a writeProjectConfig link (merge-preserving)", async () => {
    await writeConfig({
      version: 1,
      projectSlug: "old-slug",
      retention: { backups: { keepNewest: 42 } },
    })
    await writeProjectConfig(repoRoot, { projectSlug: "new-slug", projectId: "proj-xyz" })
    const onDisk = JSON.parse(
      await readFile(join(repoRoot, ".desde/config.json"), "utf-8"),
    )
    expect(onDisk.retention).toEqual({ backups: { keepNewest: 42 } })
  })
})

describe("editor.codeView", () => {
  it("reads an explicit true", async () => {
    await writeConfig({ version: 1, editor: { codeView: true } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config?.editor?.codeView).toBe(true)
  })

  it("reads an explicit false", async () => {
    await writeConfig({ version: 1, editor: { codeView: false } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config?.editor?.codeView).toBe(false)
  })

  it("is absent when the key is omitted, which the flag reads as dormant", async () => {
    await writeConfig({ version: 1, editor: { canvas: true } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config?.editor?.codeView).toBeUndefined()
      expect(result.config?.editor?.canvas).toBe(true)
    }
  })

  it("refuses a non-boolean, naming the key", async () => {
    await writeConfig({ version: 1, editor: { codeView: "yes" } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("'editor.codeView' must be a boolean")
    }
  })
})

describe("editor.notes", () => {
  it("reads an explicit true", async () => {
    await writeConfig({ version: 1, editor: { notes: true } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config?.editor?.notes).toBe(true)
  })

  it("is absent when the key is omitted, which the flag reads as dormant", async () => {
    await writeConfig({ version: 1, editor: { codeView: true } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config?.editor?.notes).toBeUndefined()
  })

  it("refuses a non-boolean, naming the key", async () => {
    await writeConfig({ version: 1, editor: { notes: 0 } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("'editor.notes' must be a boolean")
  })

  it("carries every dormant gate through together", async () => {
    await writeConfig({
      version: 1,
      editor: { canvas: true, codeView: true, notes: true },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config?.editor).toEqual({ canvas: true, codeView: true, notes: true })
    }
  })
})

describe("the llm block", () => {
  it("accepts a default provider and per-provider overrides", async () => {
    await writeConfig({
      version: 1,
      llm: {
        defaultProvider: "openai",
        providers: { openai: { model: "gpt-5.4-mini", baseUrl: "https://gw.internal" } },
      },
    })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.llm).toEqual({
      defaultProvider: "openai",
      providers: { openai: { model: "gpt-5.4-mini", baseUrl: "https://gw.internal" } },
    })
  })

  it("refuses a non-string defaultProvider", async () => {
    await writeConfig({ version: 1, llm: { defaultProvider: 7 } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("malformed")
    expect(result.message).toContain("llm.defaultProvider")
  })

  it("refuses a provider override that is not an object of strings", async () => {
    await writeConfig({ version: 1, llm: { providers: { openai: { model: 3 } } } })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain("llm.providers.openai.model")
  })

  it("omits the block entirely when it is absent", async () => {
    await writeConfig({ version: 1 })
    const result = await readProjectConfig(repoRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.llm).toBeUndefined()
  })
})

import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearLlmApiKey,
  llmCredentialFilePath,
  readLlmCredentials,
  readPromptDismissed,
  resetMalformedProviderWarningsForTests,
  setLlmDevMode,
  setPromptDismissed,
  writeLlmApiKey,
  writeLlmBaseUrl,
} from "../llm-credential-store.js"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "llm-cred-"))
  // `warnedMalformedProviders` is a module-level Set that survives across
  // tests (by design — it de-dupes for the life of the process), so a
  // test asserting "warns once" must start from a clean slate or an
  // earlier test's warning silently suppresses this one's.
  resetMalformedProviderWarningsForTests()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  // A test that spies on console.warn and fails before its own
  // `mockRestore()` would otherwise leave the spy in place and silently
  // swallow (or mis-attribute) console.warn calls in every test that runs
  // after it.
  vi.restoreAllMocks()
})

const configDir = () => join(home, ".config", "desde")

/** Writes an arbitrary raw JSON object at the store path, mode 0600. */
async function writeRawFile(homeDir: string, value: unknown): Promise<void> {
  await fs.mkdir(join(homeDir, ".config", "desde"), { recursive: true })
  await fs.writeFile(llmCredentialFilePath(homeDir), JSON.stringify(value), { mode: 0o600 })
}

describe("llm-credential-store", () => {
  it("returns typed defaults when the file is absent", async () => {
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: false })
  })

  it("round-trips an api key", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-secret1234" } },
      devMode: false,
    })
  })

  it("writes the file 0600 and the directory 0700", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    const file = await fs.stat(llmCredentialFilePath(home))
    const dir = await fs.stat(configDir())
    expect(file.mode & 0o777).toBe(0o600)
    expect(dir.mode & 0o777).toBe(0o700)
  })

  it("preserves dev mode when the key changes", async () => {
    await setLlmDevMode(true, home)
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-secret1234" } },
      devMode: true,
    })
  })

  it("preserves the key when dev mode changes", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    await setLlmDevMode(true, home)
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-secret1234" } },
      devMode: true,
    })
  })

  it("clears only the key, leaving dev mode intact", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    await setLlmDevMode(true, home)
    await clearLlmApiKey("anthropic", home)
    expect(await readLlmCredentials(home)).toEqual({ providers: { anthropic: {} }, devMode: true })
  })

  it("degrades to defaults on malformed JSON rather than throwing", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(llmCredentialFilePath(home), "{ not json")
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: false })
  })

  it("degrades to defaults on a wrong-shaped file", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 99, apiKey: 42 }),
    )
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: false })
  })

  it("degrades to defaults when a v1 apiKey is the wrong type", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 1, apiKey: 42, devMode: false }),
    )
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: false })
  })

  it("leaves no temp file behind after a write", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-secret1234", home)
    expect(await fs.readdir(configDir())).toEqual(["llm-credentials.json"])
  })
})

/**
 * The single highest-risk line in the whole multi-provider design.
 *
 * MEASURED before this change: `readFile()` discarded the ENTIRE file and
 * returned defaults on any `file.version !== SCHEMA_VERSION`. Moving the
 * constant to 2 without a migration branch silently deletes every existing
 * user's Anthropic key on the first read after upgrade. These cases run
 * against a real file in a real temp HOME for that reason.
 */
describe("v1 to v2 migration", () => {
  it("lifts a v1 key into the anthropic provider slot", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({
        version: 1,
        apiKey: "sk-ant-fromv1",
        devMode: false,
        promptDismissed: true,
      }),
    )
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-fromv1" } },
      devMode: false,
    })
    expect(await readPromptDismissed(home)).toBe(true)
  })

  it("migrates a v1 file that never held a key", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 1, devMode: true, promptDismissed: false }),
    )
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: true })
  })

  it("does not rewrite the file on read, only on the next write", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    const raw = JSON.stringify({ version: 1, apiKey: "sk-ant-fromv1", devMode: false })
    await fs.writeFile(llmCredentialFilePath(home), raw)
    await readLlmCredentials(home)
    expect(await fs.readFile(llmCredentialFilePath(home), "utf8")).toBe(raw)

    await writeLlmApiKey("openai", "sk-openai", home)
    const after = JSON.parse(
      await fs.readFile(llmCredentialFilePath(home), "utf8"),
    ) as Record<string, unknown>
    expect(after.version).toBe(2)
    expect(after.providers).toEqual({
      anthropic: { apiKey: "sk-ant-fromv1" },
      openai: { apiKey: "sk-openai" },
    })
  })

  it("still degrades to defaults for a version from the future", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 99, providers: { anthropic: { apiKey: "x" } } }),
    )
    expect(await readLlmCredentials(home)).toEqual({ providers: {}, devMode: false })
  })
})

describe("provider-scoped writers", () => {
  it("keeps two providers' keys side by side", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-one", home)
    await writeLlmApiKey("openai", "sk-two", home)
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-one" }, openai: { apiKey: "sk-two" } },
      devMode: false,
    })
  })

  it("clears one provider's key without touching the other", async () => {
    await writeLlmApiKey("anthropic", "sk-ant-one", home)
    await writeLlmApiKey("openai", "sk-two", home)
    await clearLlmApiKey("openai", home)
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-one" }, openai: {} },
      devMode: false,
    })
  })

  it("round-trips a base URL and clears it with undefined", async () => {
    await writeLlmBaseUrl("openai", "https://gateway.internal", home)
    expect((await readLlmCredentials(home)).providers.openai).toEqual({
      baseUrl: "https://gateway.internal",
    })
    await writeLlmBaseUrl("openai", undefined, home)
    expect((await readLlmCredentials(home)).providers.openai).toEqual({})
  })

  it("keeps a base URL when the key is replaced", async () => {
    await writeLlmBaseUrl("openai", "https://gateway.internal", home)
    await writeLlmApiKey("openai", "sk-two", home)
    expect((await readLlmCredentials(home)).providers.openai).toEqual({
      apiKey: "sk-two",
      baseUrl: "https://gateway.internal",
    })
  })
})

/**
 * Codex review round three: each setter rewrites the WHOLE file from a
 * snapshot it read, so two overlapping updates could each read the same
 * snapshot and the second rewrite would erase the first's change.
 */
describe("concurrent writes do not lose fields", () => {
  it("keeps a key saved concurrently with a dev-mode toggle", async () => {
    await Promise.all([
      writeLlmApiKey("anthropic", "sk-ant-concurrent", home),
      setLlmDevMode(true, home),
    ])
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-concurrent" } },
      devMode: true,
    })
  })

  it("keeps every field under a burst of interleaved updates", async () => {
    await Promise.all([
      writeLlmApiKey("anthropic", "sk-ant-burst", home),
      setLlmDevMode(true, home),
      setPromptDismissed(true, home),
    ])
    const file = JSON.parse(
      await fs.readFile(llmCredentialFilePath(home), "utf8"),
    ) as Record<string, unknown>
    expect(file.providers).toEqual({ anthropic: { apiKey: "sk-ant-burst" } })
    expect(file.devMode).toBe(true)
    expect(file.promptDismissed).toBe(true)
  })

  it("leaves no temp files behind after concurrent writes", async () => {
    await Promise.all([
      writeLlmApiKey("anthropic", "sk-ant-a", home),
      setLlmDevMode(true, home),
      setPromptDismissed(true, home),
    ])
    expect(await fs.readdir(configDir())).toEqual(["llm-credentials.json"])
  })
})

describe("cx1: independent field migration and per-slot sanitization", () => {
  it("keeps a v1 key when devMode is missing, and the next write persists it as v2", async () => {
    await writeRawFile(home, { version: 1, apiKey: "sk-ant-keep-me" }) // no devMode, no promptDismissed
    expect((await readLlmCredentials(home)).providers.anthropic?.apiKey).toBe("sk-ant-keep-me")
    await setPromptDismissed(true, home)
    const onDisk = JSON.parse(await fs.readFile(llmCredentialFilePath(home), "utf8")) as Record<
      string,
      unknown
    >
    expect(onDisk.version).toBe(2)
    expect(
      (onDisk.providers as Record<string, { apiKey?: string }>).anthropic.apiKey,
    ).toBe("sk-ant-keep-me")
    expect(onDisk.devMode).toBe(false)
  })

  it("keeps a valid slot when another slot is malformed, and warns naming only the provider id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await writeRawFile(home, {
      version: 2,
      providers: { anthropic: { apiKey: "sk-ant-keep-me" }, openai: { apiKey: 42 } },
      devMode: false,
      promptDismissed: true,
    })
    const read = await readLlmCredentials(home)
    expect(read.providers.anthropic?.apiKey).toBe("sk-ant-keep-me")
    expect(read.providers.openai).toBeUndefined()
    expect(warn.mock.calls.flat().join(" ")).toMatch(/openai/)
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/sk-ant-keep-me|42/)
    await writeLlmApiKey("openai", "sk-new", home)
    const onDisk = JSON.parse(await fs.readFile(llmCredentialFilePath(home), "utf8")) as Record<
      string,
      unknown
    >
    expect(
      (onDisk.providers as Record<string, { apiKey?: string }>).anthropic.apiKey,
    ).toBe("sk-ant-keep-me")
    expect(
      (onDisk.providers as Record<string, { apiKey?: string }>).openai.apiKey,
    ).toBe("sk-new")
    warn.mockRestore()
  })

  it("keeps a v2 key when devMode is the wrong type, and the next write persists it as a real boolean", async () => {
    // Same data-loss class as the v1 case above, one line down: a v2 file
    // with a malformed (non-boolean) `devMode` used to discard the WHOLE
    // file via `return defaults()`, silently deleting a real key.
    await writeRawFile(home, {
      version: 2,
      providers: { anthropic: { apiKey: "sk-ant-keep-me" } },
      devMode: "yes",
      promptDismissed: false,
    })
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-keep-me" } },
      devMode: false,
    })
    await setPromptDismissed(true, home)
    const onDisk = JSON.parse(await fs.readFile(llmCredentialFilePath(home), "utf8")) as Record<
      string,
      unknown
    >
    expect(
      (onDisk.providers as Record<string, { apiKey?: string }>).anthropic.apiKey,
    ).toBe("sk-ant-keep-me")
    expect(onDisk.devMode).toBe(false)
  })

  it("warns about a malformed slot once per process, not once per read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // A provider id unique to this test, so an earlier test's warning for
    // 'openai' (already de-duplicated by the time this test runs, since
    // the warned-ids set is module-level) can't make this assertion pass
    // for the wrong reason.
    await writeRawFile(home, {
      version: 2,
      providers: { "cx7-dedup-vendor": { apiKey: 42 } },
      devMode: false,
      promptDismissed: false,
    })
    await readLlmCredentials(home)
    await readLlmCredentials(home)
    const matching = warn.mock.calls.filter((call) => call.join(" ").includes("cx7-dedup-vendor"))
    expect(matching).toHaveLength(1)
    warn.mockRestore()
  })
})

describe("promptDismissed", () => {
  it("defaults to false and round-trips", async () => {
    expect(await readPromptDismissed(home)).toBe(false)
    await setPromptDismissed(true, home)
    expect(await readPromptDismissed(home)).toBe(true)
  })

  it("survives a key write and a key clear", async () => {
    await setPromptDismissed(true, home)
    await writeLlmApiKey("anthropic", "sk-ant-x", home)
    await clearLlmApiKey("anthropic", home)
    expect(await readPromptDismissed(home)).toBe(true)
  })

  it("tolerates a v1 file written before the field existed", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 1, apiKey: "sk-ant-old", devMode: false }),
    )
    // Tolerated, not rejected: discarding it would drop the user's key.
    expect(await readLlmCredentials(home)).toEqual({
      providers: { anthropic: { apiKey: "sk-ant-old" } },
      devMode: false,
    })
    expect(await readPromptDismissed(home)).toBe(false)
  })

  describe("the store never guesses the home directory", () => {
    it("refuses a two-argument write at the type level", () => {
      // A two-argument call is exactly the shape that wrote test fixtures into
      // a real ~/.config/desde/llm-credentials.json on 2026-09-04 (the old
      // signature was (apiKey, home); the new one is (providerId, apiKey, home)
      // and `home` used to default to homedir()). Pinning the error keeps the
      // third argument mandatory.
      // @ts-expect-error home is required
      const call = () => writeLlmApiKey("anthropic", "sk-ant-two-args")
      expect(call).toBeTypeOf("function")
    })

    it("refuses a read with no home at the type level", () => {
      // @ts-expect-error home is required
      const call = () => readLlmCredentials()
      expect(call).toBeTypeOf("function")
    })
  })
})

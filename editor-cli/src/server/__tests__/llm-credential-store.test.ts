import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearLlmApiKey,
  llmCredentialFilePath,
  readLlmCredentials,
  readPromptDismissed,
  setLlmDevMode,
  setPromptDismissed,
  writeLlmApiKey,
} from "../llm-credential-store.js"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "llm-cred-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const configDir = () => join(home, ".config", "desde")

describe("llm-credential-store", () => {
  it("returns typed defaults when the file is absent", async () => {
    expect(await readLlmCredentials(home)).toEqual({ devMode: false })
  })

  it("round-trips an api key", async () => {
    await writeLlmApiKey("sk-ant-secret1234", home)
    expect(await readLlmCredentials(home)).toEqual({
      apiKey: "sk-ant-secret1234",
      devMode: false,
    })
  })

  it("writes the file 0600 and the directory 0700", async () => {
    await writeLlmApiKey("sk-ant-secret1234", home)
    const file = await fs.stat(llmCredentialFilePath(home))
    const dir = await fs.stat(configDir())
    expect(file.mode & 0o777).toBe(0o600)
    expect(dir.mode & 0o777).toBe(0o700)
  })

  it("preserves dev mode when the key changes", async () => {
    await setLlmDevMode(true, home)
    await writeLlmApiKey("sk-ant-secret1234", home)
    expect(await readLlmCredentials(home)).toEqual({
      apiKey: "sk-ant-secret1234",
      devMode: true,
    })
  })

  it("preserves the key when dev mode changes", async () => {
    await writeLlmApiKey("sk-ant-secret1234", home)
    await setLlmDevMode(true, home)
    expect(await readLlmCredentials(home)).toEqual({
      apiKey: "sk-ant-secret1234",
      devMode: true,
    })
  })

  it("clears only the key, leaving dev mode intact", async () => {
    await writeLlmApiKey("sk-ant-secret1234", home)
    await setLlmDevMode(true, home)
    await clearLlmApiKey(home)
    expect(await readLlmCredentials(home)).toEqual({ devMode: true })
  })

  it("degrades to defaults on malformed JSON rather than throwing", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(llmCredentialFilePath(home), "{ not json")
    expect(await readLlmCredentials(home)).toEqual({ devMode: false })
  })

  it("degrades to defaults on a wrong-shaped file", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 99, apiKey: 42 }),
    )
    expect(await readLlmCredentials(home)).toEqual({ devMode: false })
  })

  it("degrades to defaults when apiKey is the wrong type", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 1, apiKey: 42, devMode: false }),
    )
    expect(await readLlmCredentials(home)).toEqual({ devMode: false })
  })

  it("leaves no temp file behind after a write", async () => {
    await writeLlmApiKey("sk-ant-secret1234", home)
    expect(await fs.readdir(configDir())).toEqual(["llm-credentials.json"])
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
      writeLlmApiKey("sk-ant-concurrent", home),
      setLlmDevMode(true, home),
    ])
    expect(await readLlmCredentials(home)).toEqual({
      apiKey: "sk-ant-concurrent",
      devMode: true,
    })
  })

  it("keeps every field under a burst of interleaved updates", async () => {
    await Promise.all([
      writeLlmApiKey("sk-ant-burst", home),
      setLlmDevMode(true, home),
      setPromptDismissed(true, home),
    ])
    const file = JSON.parse(
      await fs.readFile(llmCredentialFilePath(home), "utf8"),
    ) as Record<string, unknown>
    expect(file.apiKey).toBe("sk-ant-burst")
    expect(file.devMode).toBe(true)
    expect(file.promptDismissed).toBe(true)
  })

  it("leaves no temp files behind after concurrent writes", async () => {
    await Promise.all([
      writeLlmApiKey("sk-ant-a", home),
      setLlmDevMode(true, home),
      setPromptDismissed(true, home),
    ])
    expect(await fs.readdir(configDir())).toEqual(["llm-credentials.json"])
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
    await writeLlmApiKey("sk-ant-x", home)
    await clearLlmApiKey(home)
    expect(await readPromptDismissed(home)).toBe(true)
  })

  it("tolerates a file written before the field existed", async () => {
    await fs.mkdir(configDir(), { recursive: true })
    await fs.writeFile(
      llmCredentialFilePath(home),
      JSON.stringify({ version: 1, apiKey: "sk-ant-old", devMode: false }),
    )
    // Tolerated, not rejected: discarding it would drop the user's key.
    expect(await readLlmCredentials(home)).toEqual({
      apiKey: "sk-ant-old",
      devMode: false,
    })
    expect(await readPromptDismissed(home)).toBe(false)
  })
})

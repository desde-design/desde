import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readStoredDevMode, readStoredProviderKeys } from "../llm-credentials-read.js"
import { shouldDownloadClaudeRuntime } from "../claude-runtime-gate.js"

function homeWith(contents: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "desde-cred-"))
  mkdirSync(join(home, ".config", "desde"), { recursive: true })
  writeFileSync(join(home, ".config", "desde", "llm-credentials.json"), JSON.stringify(contents))
  return home
}

describe("readStoredProviderKeys", () => {
  it("reads a v2 file", () => {
    const home = homeWith({
      version: 2,
      providers: { openai: { apiKey: "sk-test" } },
      devMode: false,
      promptDismissed: false,
    })
    try {
      expect(readStoredProviderKeys(home)).toEqual({ openai: { apiKey: "sk-test" } })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("reads a v1 file as an Anthropic key", () => {
    // A user who upgrades has a v1 file until the CLI next WRITES. The desktop
    // process may read it before that ever happens, so it has to understand
    // both shapes or it would decide "nothing credentialed" for a user who has
    // had an Anthropic key for months.
    const home = homeWith({ version: 1, apiKey: "sk-ant-test", devMode: false, promptDismissed: false })
    try {
      expect(readStoredProviderKeys(home)).toEqual({ anthropic: { apiKey: "sk-ant-test" } })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("returns nothing for a missing, unreadable or unrecognised file", () => {
    const home = mkdtempSync(join(tmpdir(), "desde-cred-"))
    try {
      expect(readStoredProviderKeys(home)).toEqual({})
      expect(readStoredDevMode(home)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
    const bad = homeWith({ version: 99, whatever: true })
    try {
      // Fails toward "nothing credentialed", which makes the gate download.
      // Every unreadable case must land on today's behaviour, never on
      // silently skipping a download the user needs.
      expect(readStoredProviderKeys(bad)).toEqual({})
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  })
})

describe("shouldDownloadClaudeRuntime", () => {
  const none = {}
  it("downloads on a first run with nothing configured", () => {
    expect(shouldDownloadClaudeRuntime({ stored: none, devMode: false, env: {} })).toBe(true)
  })

  it("skips only when a non-Anthropic provider is credentialed and Anthropic is not", () => {
    expect(
      shouldDownloadClaudeRuntime({ stored: { openai: { apiKey: "sk-test" } }, devMode: false, env: {} }),
    ).toBe(false)
  })

  it("downloads when Anthropic is credentialed too", () => {
    expect(
      shouldDownloadClaudeRuntime({
        stored: { openai: { apiKey: "sk-test" }, anthropic: { apiKey: "sk-ant-test" } },
        devMode: false,
        env: {},
      }),
    ).toBe(true)
  })

  it("downloads when Anthropic's key comes from the environment", () => {
    // An Anthropic user with a shell-exported key stores nothing. Reading only
    // the file would decide they are an OpenAI-only user and break their chat.
    expect(
      shouldDownloadClaudeRuntime({
        stored: { openai: { apiKey: "sk-test" } },
        devMode: false,
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      }),
    ).toBe(true)
  })

  it("downloads when dev mode or the subscription opt-in is on", () => {
    // Both mean "use the bundled binary", which is the thing being downloaded.
    expect(
      shouldDownloadClaudeRuntime({ stored: { openai: { apiKey: "sk-test" } }, devMode: true, env: {} }),
    ).toBe(true)
    expect(
      shouldDownloadClaudeRuntime({
        stored: { openai: { apiKey: "sk-test" } },
        devMode: false,
        env: { EDITOR_USE_CLAUDE_SUBSCRIPTION: "1" },
      }),
    ).toBe(true)
  })

  it("ignores a provider entry with no key", () => {
    expect(shouldDownloadClaudeRuntime({ stored: { openai: {} }, devMode: false, env: {} })).toBe(true)
  })
})

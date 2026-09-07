import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { readStoredDevMode, readStoredProviderKeys } from "../llm-credentials-read.js"
import { credentialed, isSubscriptionOptIn, shouldDownloadClaudeRuntime } from "../claude-runtime-gate.js"

// `readFileSync` is spied, not stubbed — every OTHER test in this file
// still hits the real filesystem via `homeWith()`. Only the "no explicit
// home" test below reads the spy; everything else runs through untouched.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

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

  it("requires an explicit home — a defaulted home is the footgun a prior fix removed", () => {
    vi.mocked(readFileSync).mockClear()
    // @ts-expect-error — `home` has no default; every caller must say whose
    // credentials it means. That is a COMPILE-time guard only — this test
    // is what pins the RUNTIME behavior when it is bypassed anyway (a `.js`
    // caller, or a cast).
    const result = readStoredProviderKeys()
    // "Fails toward nothing configured" (see the module doc comment) means
    // the missing `home` throws inside `path.join(undefined, ...)` and that
    // throw is swallowed the same way an unreadable file's is, above.
    expect(result).toEqual({})
    // The property this test actually exists to pin: nothing beneath it
    // ever resolved a path and asked the filesystem for it. If `home` ever
    // gained a default of `homedir()`, this assertion is what would catch
    // it — `readFileSync` would be called, against a REAL user's file,
    // instead of `path.join` throwing before any read is attempted.
    expect(readFileSync).not.toHaveBeenCalled()
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

describe("credentialed", () => {
  // Mirrors `isCredentialedFromEnv` (`src/editor/llm-providers/provider-registry.ts`):
  // a whitespace-only key must not count as credentialed.
  it("trims a whitespace-only env key to not-credentialed", () => {
    expect(credentialed("openai", "OPENAI_API_KEY", {}, { OPENAI_API_KEY: "   " })).toBe(false)
  })

  it("trims a whitespace-only stored key to not-credentialed", () => {
    expect(credentialed("openai", "OPENAI_API_KEY", { openai: { apiKey: "   " } }, {})).toBe(false)
  })

  it("still accepts a real key on either side", () => {
    expect(credentialed("openai", "OPENAI_API_KEY", {}, { OPENAI_API_KEY: "sk-test" })).toBe(true)
    expect(credentialed("openai", "OPENAI_API_KEY", { openai: { apiKey: "sk-test" } }, {})).toBe(true)
  })
})

describe("isSubscriptionOptIn", () => {
  // Mirrors `isClaudeSubscriptionOptIn` (`src/editor/llm-providers/claude-subscription.ts`):
  // a shell-exported value keeps its surrounding whitespace.
  it("trims surrounding whitespace before checking the accepted-values list", () => {
    expect(isSubscriptionOptIn(" yes ")).toBe(true)
    expect(isSubscriptionOptIn(" 1 ")).toBe(true)
    expect(isSubscriptionOptIn(" TRUE ")).toBe(true)
  })

  it("rejects anything outside the accepted-values list", () => {
    expect(isSubscriptionOptIn("nope")).toBe(false)
    expect(isSubscriptionOptIn(undefined)).toBe(false)
  })
})

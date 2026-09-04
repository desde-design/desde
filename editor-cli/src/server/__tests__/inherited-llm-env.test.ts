import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  captureInheritedLlmEnv,
  inheritedLlmEnv,
  resetInheritedLlmEnvForTests,
  spawnEnvWithInheritedLlmCredentials,
  TRACKED_LLM_ENV_VARS,
} from "../inherited-llm-env.js"

afterEach(() => {
  resetInheritedLlmEnvForTests()
})

describe("captureInheritedLlmEnv", () => {
  it("tracks every descriptor's key and base URL plus the subscription flag", () => {
    expect([...TRACKED_LLM_ENV_VARS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "EDITOR_USE_CLAUDE_SUBSCRIPTION",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ])
  })

  it("records what the shell provided, for every tracked variable", () => {
    expect(
      captureInheritedLlmEnv({
        ANTHROPIC_API_KEY: "sk-ant-exported",
        OPENAI_API_KEY: "sk-exported",
        OPENAI_BASE_URL: "https://gateway.internal",
        EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes",
        UNRELATED: "kept out",
      }),
    ).toEqual({
      vars: {
        ANTHROPIC_API_KEY: "sk-ant-exported",
        OPENAI_API_KEY: "sk-exported",
        OPENAI_BASE_URL: "https://gateway.internal",
        EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes",
      },
    })
  })

  it("records an empty baseline when the shell provided nothing", () => {
    expect(captureInheritedLlmEnv({})).toEqual({ vars: {} })
  })

  it("only the FIRST call records, so an injection cannot be mistaken for the shell", () => {
    captureInheritedLlmEnv({})
    // Simulates boot injection happening between the two calls.
    captureInheritedLlmEnv({ OPENAI_API_KEY: "sk-injected" })
    expect(inheritedLlmEnv()).toEqual({ vars: {} })
  })

  it("defaults to an empty baseline when capture never ran", () => {
    expect(inheritedLlmEnv()).toEqual({ vars: {} })
  })
})

/**
 * Codex review P1: the launcher spawns a child editor per project and the
 * child inherited `process.env` wholesale, so it captured OUR injection as its
 * own baseline and disabled the controls for a key the app owns.
 */
describe("spawnEnvWithInheritedLlmCredentials", () => {
  it("rolls EVERY provider's injected variable back out of the child", () => {
    captureInheritedLlmEnv({})
    const parentEnv = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-injected",
      OPENAI_API_KEY: "sk-injected",
      OPENAI_BASE_URL: "https://injected.internal",
    }
    const childEnv = spawnEnvWithInheritedLlmCredentials(parentEnv)
    expect("ANTHROPIC_API_KEY" in childEnv).toBe(false)
    expect("OPENAI_API_KEY" in childEnv).toBe(false)
    expect("OPENAI_BASE_URL" in childEnv).toBe(false)
    expect(childEnv.PATH).toBe("/bin")
  })

  it("preserves an OpenAI key the shell really did export", () => {
    captureInheritedLlmEnv({ OPENAI_API_KEY: "sk-exported" })
    expect(
      spawnEnvWithInheritedLlmCredentials({ OPENAI_API_KEY: "sk-exported" })
        .OPENAI_API_KEY,
    ).toBe("sk-exported")
  })

  it("preserves a key the shell really did export", () => {
    captureInheritedLlmEnv({ ANTHROPIC_API_KEY: "sk-ant-exported" })
    const childEnv = spawnEnvWithInheritedLlmCredentials({
      ANTHROPIC_API_KEY: "sk-ant-exported",
    })
    expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-ant-exported")
  })

  it("rolls the subscription flag back too", () => {
    captureInheritedLlmEnv({})
    const childEnv = spawnEnvWithInheritedLlmCredentials({
      EDITOR_USE_CLAUDE_SUBSCRIPTION: "1",
    })
    expect("EDITOR_USE_CLAUDE_SUBSCRIPTION" in childEnv).toBe(false)
  })

  it("does not mutate the parent environment it was given", () => {
    captureInheritedLlmEnv({})
    const parentEnv = { ANTHROPIC_API_KEY: "sk-ant-injected" }
    spawnEnvWithInheritedLlmCredentials(parentEnv)
    expect(parentEnv.ANTHROPIC_API_KEY).toBe("sk-ant-injected")
  })
})

/**
 * Codex review round three: the dismiss-prompt handler existed and had tests,
 * but was never added to `ROUTE_TABLE`, so every real request 404'd. The unit
 * tests called the handler directly and could not see it.
 */
describe("every credential route reaches the router", () => {
  it("registers the base, dev-mode and dismiss-prompt paths", () => {
    const source = readFileSync(
      new URL("../http-server.ts", import.meta.url),
      "utf8",
    )
    for (const constant of [
      "LLM_CREDENTIALS_ROUTE",
      "LLM_CREDENTIALS_DEV_MODE_ROUTE",
      "LLM_CREDENTIALS_DISMISS_ROUTE",
    ]) {
      expect(source).toContain(`path: ${constant},`)
    }
  })
})

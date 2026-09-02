import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  captureInheritedLlmEnv,
  inheritedLlmEnv,
  resetInheritedLlmEnvForTests,
  spawnEnvWithInheritedLlmCredentials,
} from "../inherited-llm-env.js"

afterEach(() => {
  resetInheritedLlmEnvForTests()
})

describe("captureInheritedLlmEnv", () => {
  it("records what the shell provided", () => {
    expect(
      captureInheritedLlmEnv({
        ANTHROPIC_API_KEY: "sk-ant-exported",
        EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes",
      }),
    ).toEqual({ apiKey: "sk-ant-exported", useSubscription: "yes" })
  })

  it("records an empty baseline when the shell provided nothing", () => {
    expect(captureInheritedLlmEnv({})).toEqual({})
  })

  it("only the FIRST call records, so an injection cannot be mistaken for the shell", () => {
    captureInheritedLlmEnv({})
    // Simulates boot injection happening between the two calls.
    captureInheritedLlmEnv({ ANTHROPIC_API_KEY: "sk-ant-injected" })
    expect(inheritedLlmEnv()).toEqual({})
  })

  it("defaults to an empty baseline when capture never ran", () => {
    expect(inheritedLlmEnv()).toEqual({})
  })
})

/**
 * Codex review P1: the launcher spawns a child editor per project and the
 * child inherited `process.env` wholesale, so it captured OUR injection as its
 * own baseline and disabled the controls for a key the app owns.
 */
describe("spawnEnvWithInheritedLlmCredentials", () => {
  it("rolls an injected key back out of the child's environment", () => {
    captureInheritedLlmEnv({})
    const parentEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-injected" }
    const childEnv = spawnEnvWithInheritedLlmCredentials(parentEnv)
    expect("ANTHROPIC_API_KEY" in childEnv).toBe(false)
    expect(childEnv.PATH).toBe("/bin")
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

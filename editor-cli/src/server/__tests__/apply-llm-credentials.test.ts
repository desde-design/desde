import { describe, expect, it } from "vitest"
import { applyLlmCredentialsToEnv } from "../apply-llm-credentials.js"
import type { InheritedLlmEnv } from "../inherited-llm-env.js"

/** No inherited baseline: the shell gave the process nothing. */
const CLEAN: InheritedLlmEnv = {}

describe("applyLlmCredentialsToEnv", () => {
  it("injects a stored key when the environment has none", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: false }, env, CLEAN)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stored")
  })

  it("never overwrites a key the shell exported", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: false }, env, {
      apiKey: "sk-ant-env",
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-env")
  })

  it("does nothing when there is no stored key", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv({ devMode: false }, env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("dev mode DELETES an environment key rather than leaving it", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv({ devMode: true }, env, { apiKey: "sk-ant-env" })
    // `delete`, not assignment to undefined: spawn() passes an `undefined`
    // value through as the STRING "undefined" on some platforms.
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("dev mode deletes a stored key's injection too, and sets the flag", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: true }, env, {
      apiKey: "sk-ant-env",
    })
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")
  })

  it("does not set the subscription flag when dev mode is off", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: false }, env, CLEAN)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBeUndefined()
  })

  it("treats a whitespace-only stored key as absent", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv({ apiKey: "   ", devMode: false }, env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("treats a whitespace-only inherited key as absent and injects the stored one", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "  " }
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: false }, env, {
      apiKey: "  ",
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stored")
  })
})

/**
 * Codex review, P2 "Restore inherited credentials after dev mode": writing
 * this as an in-place mutation let a dev-mode toggle permanently destroy an
 * exported key, because nothing recorded what the shell had provided.
 */
describe("applyLlmCredentialsToEnv restores the inherited baseline", () => {
  it("gives an exported key back when dev mode is turned off", () => {
    const inherited: InheritedLlmEnv = { apiKey: "sk-ant-exported" }
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-exported" }

    applyLlmCredentialsToEnv({ devMode: true }, env, inherited)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)

    applyLlmCredentialsToEnv({ devMode: false }, env, inherited)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-exported")
  })

  it("gives an exported subscription flag back when dev mode is turned off", () => {
    const inherited: InheritedLlmEnv = { useSubscription: "yes" }
    const env: NodeJS.ProcessEnv = { EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes" }

    applyLlmCredentialsToEnv({ devMode: true }, env, inherited)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")

    applyLlmCredentialsToEnv({ devMode: false }, env, inherited)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("yes")
  })

  it("is idempotent: repeated applies do not accumulate state", () => {
    const env: NodeJS.ProcessEnv = {}
    const stored = { apiKey: "sk-ant-stored", devMode: false }

    applyLlmCredentialsToEnv(stored, env, CLEAN)
    const first = { ...env }
    applyLlmCredentialsToEnv(stored, env, CLEAN)
    expect({ ...env }).toEqual(first)
  })

  it("removes a previously injected key once the store is cleared", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv({ apiKey: "sk-ant-stored", devMode: false }, env, CLEAN)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stored")

    applyLlmCredentialsToEnv({ devMode: false }, env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { applyLlmCredentialsToEnv } from "../apply-llm-credentials.js"
import type { InheritedLlmEnv } from "../inherited-llm-env.js"

/** No inherited baseline: the shell gave the process nothing. */
const CLEAN: InheritedLlmEnv = { vars: {} }

const noKey = { providers: {}, devMode: false }

function withAnthropicKey(apiKey: string, devMode = false) {
  return { providers: { anthropic: { apiKey } }, devMode }
}

describe("applyLlmCredentialsToEnv", () => {
  it("injects a stored key when the environment has none", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored"), env, CLEAN)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stored")
  })

  it("never overwrites a key the shell exported", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored"), env, {
      vars: { ANTHROPIC_API_KEY: "sk-ant-env" },
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-env")
  })

  it("does nothing when there is no stored key", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(noKey, env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("dev mode DELETES an environment key rather than leaving it", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv({ providers: {}, devMode: true }, env, {
      vars: { ANTHROPIC_API_KEY: "sk-ant-env" },
    })
    // `delete`, not assignment to undefined: spawn() passes an `undefined`
    // value through as the STRING "undefined" on some platforms.
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("dev mode deletes a stored key's injection too, and sets the flag", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-env" }
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored", true), env, {
      vars: { ANTHROPIC_API_KEY: "sk-ant-env" },
    })
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")
  })

  it("does not set the subscription flag when dev mode is off", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored"), env, CLEAN)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBeUndefined()
  })

  it("treats a whitespace-only stored key as absent", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(withAnthropicKey("   "), env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })

  it("treats a whitespace-only inherited key as absent and injects the stored one", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "  " }
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored"), env, {
      vars: { ANTHROPIC_API_KEY: "  " },
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
    const inherited: InheritedLlmEnv = { vars: { ANTHROPIC_API_KEY: "sk-ant-exported" } }
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-exported" }

    applyLlmCredentialsToEnv({ providers: {}, devMode: true }, env, inherited)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)

    applyLlmCredentialsToEnv({ providers: {}, devMode: false }, env, inherited)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-exported")
  })

  it("gives an exported subscription flag back when dev mode is turned off", () => {
    const inherited: InheritedLlmEnv = { vars: { EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes" } }
    const env: NodeJS.ProcessEnv = { EDITOR_USE_CLAUDE_SUBSCRIPTION: "yes" }

    applyLlmCredentialsToEnv({ providers: {}, devMode: true }, env, inherited)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")

    applyLlmCredentialsToEnv({ providers: {}, devMode: false }, env, inherited)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("yes")
  })

  it("is idempotent: repeated applies do not accumulate state", () => {
    const env: NodeJS.ProcessEnv = {}
    const stored = withAnthropicKey("sk-ant-stored")

    applyLlmCredentialsToEnv(stored, env, CLEAN)
    const first = { ...env }
    applyLlmCredentialsToEnv(stored, env, CLEAN)
    expect({ ...env }).toEqual(first)
  })

  it("removes a previously injected key once the store is cleared", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(withAnthropicKey("sk-ant-stored"), env, CLEAN)
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stored")

    applyLlmCredentialsToEnv({ providers: {}, devMode: false }, env, CLEAN)
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
  })
})

/**
 * The assembly case. MEASURED before this change: the dev-mode branch
 * `return`ed, so an OpenAI injection added after it would silently never run
 * and dev mode would disable a provider it has no business touching.
 */
describe("dev mode is Anthropic-scoped and never short-circuits another provider", () => {
  it("injects a stored OpenAI key even with dev mode ON", () => {
    const env: NodeJS.ProcessEnv = {}
    applyLlmCredentialsToEnv(
      {
        providers: {
          anthropic: { apiKey: "sk-ant-stored" },
          openai: { apiKey: "sk-openai-stored", baseUrl: "https://gateway.internal" },
        },
        devMode: true,
      },
      env,
      { vars: {} },
    )
    expect("ANTHROPIC_API_KEY" in env).toBe(false)
    expect(env.EDITOR_USE_CLAUDE_SUBSCRIPTION).toBe("1")
    expect(env.OPENAI_API_KEY).toBe("sk-openai-stored")
    expect(env.OPENAI_BASE_URL).toBe("https://gateway.internal")
  })

  it("lets a shell-exported OpenAI key beat the stored one", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-exported" }
    applyLlmCredentialsToEnv(
      { providers: { openai: { apiKey: "sk-stored" } }, devMode: false },
      env,
      { vars: { OPENAI_API_KEY: "sk-exported" } },
    )
    expect(env.OPENAI_API_KEY).toBe("sk-exported")
  })

  it("removes a previously injected OpenAI key once the store is cleared", () => {
    const env: NodeJS.ProcessEnv = {}
    const inherited = { vars: {} }
    applyLlmCredentialsToEnv(
      { providers: { openai: { apiKey: "sk-stored" } }, devMode: false },
      env,
      inherited,
    )
    expect(env.OPENAI_API_KEY).toBe("sk-stored")
    applyLlmCredentialsToEnv({ providers: {}, devMode: false }, env, inherited)
    expect("OPENAI_API_KEY" in env).toBe(false)
  })
})

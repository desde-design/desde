import { describe, expect, it } from "vitest"
import { resolveLlmConfig } from "../llm-config.js"

describe("resolveLlmConfig", () => {
  it("resolves the credentialed provider when the config says nothing", () => {
    expect(resolveLlmConfig(undefined, { OPENAI_API_KEY: "sk-y" })).toMatchObject({
      provider: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    })
  })

  it("honours llm.defaultProvider when that provider is credentialed", () => {
    expect(
      resolveLlmConfig(
        { llm: { defaultProvider: "openai" } },
        { ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-y" },
      ),
    ).toMatchObject({ provider: "openai" })
  })

  it("ignores llm.defaultProvider when that provider has no credential", () => {
    expect(
      resolveLlmConfig(
        { llm: { defaultProvider: "openai" } },
        { ANTHROPIC_API_KEY: "sk-ant-x" },
      ),
    ).toMatchObject({ provider: "anthropic" })
  })

  it("applies the per-provider model, base URL and key variable overrides", () => {
    expect(
      resolveLlmConfig(
        {
          llm: {
            defaultProvider: "openai",
            providers: {
              openai: {
                model: "gpt-5.4-mini",
                baseUrl: "https://gw.internal",
                apiKeyEnv: "WORK_OPENAI_KEY",
              },
            },
          },
        },
        { WORK_OPENAI_KEY: "sk-y", OPENAI_API_KEY: "sk-ignored" },
      ),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKeyEnv: "WORK_OPENAI_KEY",
      baseUrl: "https://gw.internal",
    })
  })

  it("ignores another provider's overrides", () => {
    expect(
      resolveLlmConfig(
        { llm: { providers: { openai: { model: "gpt-5.4-mini" } } } },
        { ANTHROPIC_API_KEY: "sk-ant-x" },
      ),
    ).toMatchObject({ provider: "anthropic", model: undefined })
  })

  it("still routes to claude_code on the explicit subscription opt-in", () => {
    expect(
      resolveLlmConfig(undefined, { EDITOR_USE_CLAUDE_SUBSCRIPTION: "1" }),
    ).toMatchObject({ provider: "claude_code" })
  })
})

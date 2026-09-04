import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resolveChatRuntime } from "../chat-runtime-dispatch"
import { chatRuntimeOverride, isNeutralChatEnabled } from "../dormant-surfaces"

const loaders = {
  loadRunChatTurnSdk: vi.fn(async () => ({ runChatTurnSdk: vi.fn() })),
  loadRunChatTurnNeutral: vi.fn(async () => ({ runChatTurnNeutral: vi.fn() })),
}

beforeEach(() => {
  loaders.loadRunChatTurnSdk.mockClear()
  loaders.loadRunChatTurnNeutral.mockClear()
  delete process.env.EDITOR_NEUTRAL_CHAT
  delete process.env.EDITOR_CHAT_RUNTIME_OVERRIDE
})
afterEach(() => {
  delete process.env.EDITOR_NEUTRAL_CHAT
  delete process.env.EDITOR_CHAT_RUNTIME_OVERRIDE
})

describe("resolveChatRuntime", () => {
  it("returns the SDK runtime for an anthropic session", async () => {
    await resolveChatRuntime("anthropic", loaders as never)
    expect(loaders.loadRunChatTurnSdk).toHaveBeenCalled()
    expect(loaders.loadRunChatTurnNeutral).not.toHaveBeenCalled()
  })

  it("refuses a neutral descriptor while the surface is dormant, naming what to flip", async () => {
    await expect(resolveChatRuntime("openai", loaders as never)).rejects.toThrow(
      /neutral chat runtime is dormant/i,
    )
    expect(loaders.loadRunChatTurnNeutral).not.toHaveBeenCalled()
  })

  it("returns the neutral runtime for a neutral descriptor once the surface is on", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    await resolveChatRuntime("openai", loaders as never)
    expect(loaders.loadRunChatTurnNeutral).toHaveBeenCalled()
    expect(loaders.loadRunChatTurnSdk).not.toHaveBeenCalled()
  })

  it("honours the dev override for an anthropic session, which is how phase 3 proves the loop", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"
    await resolveChatRuntime("anthropic", loaders as never)
    expect(loaders.loadRunChatTurnNeutral).toHaveBeenCalled()
    expect(loaders.loadRunChatTurnSdk).not.toHaveBeenCalled()
  })

  it("refuses the dev override too while the surface is dormant", async () => {
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"
    await expect(resolveChatRuntime("anthropic", loaders as never)).rejects.toThrow(/dormant/i)
  })

  it("never touches the Agent SDK loader on a neutral dispatch", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    await resolveChatRuntime("openai", loaders as never)
    expect(loaders.loadRunChatTurnSdk).not.toHaveBeenCalled()
  })
})

describe("the gate readers themselves", () => {
  it("isNeutralChatEnabled is off with no config and no env", () => {
    expect(isNeutralChatEnabled({})).toBe(false)
  })

  it("isNeutralChatEnabled is off for a malformed value, because absent already means dormant", () => {
    expect(isNeutralChatEnabled({ editor: { neutralChat: "yes" } } as never)).toBe(false)
  })

  it("chatRuntimeOverride reads only the exact value", () => {
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "neutral" })).toBe("neutral")
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "sdk" })).toBeUndefined()
    expect(chatRuntimeOverride({})).toBeUndefined()
  })
})

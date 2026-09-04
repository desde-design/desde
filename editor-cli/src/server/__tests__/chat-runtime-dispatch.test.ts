import { afterEach, describe, expect, it, vi } from "vitest"
import * as dormantSurfaces from "../dormant-surfaces.js"
import { resolveChatRuntime } from "../chat-runtime-dispatch.js"

const sdkRuntime = vi.fn()
const neutralRuntime = vi.fn()

function loaders(overrides: Record<string, unknown> = {}) {
  return {
    loadSessionStore: vi.fn(),
    loadRunChatTurnSdk: vi.fn(async () => ({ runChatTurnSdk: sdkRuntime })),
    ...overrides,
  } as never
}

afterEach(() => {
  delete process.env.EDITOR_NEUTRAL_CHAT
  delete process.env.EDITOR_CHAT_RUNTIME_OVERRIDE
  vi.clearAllMocks()
})

describe("resolveChatRuntime", () => {
  it("returns the SDK runtime for a claude-agent-sdk provider", async () => {
    expect(await resolveChatRuntime("anthropic", loaders())).toBe(sdkRuntime)
  })

  /**
   * The dispatch half of a both-ends gate. The client half is that the catalog
   * resolver does not serve a neutral provider's group, so no picker offers
   * this model. A stale or hand-built request must be refused here anyway.
   */
  it("refuses a neutral provider while the flag is off, naming the flag", async () => {
    await expect(resolveChatRuntime("openai", loaders())).rejects.toThrow(
      /EDITOR_NEUTRAL_CHAT/,
    )
  })

  it("does not import the SDK module when it refuses", async () => {
    const l = loaders()
    await expect(resolveChatRuntime("openai", l)).rejects.toThrow()
    expect((l as unknown as { loadRunChatTurnSdk: ReturnType<typeof vi.fn> }).loadRunChatTurnSdk)
      .not.toHaveBeenCalled()
  })

  it("says the neutral runtime is not available yet once the flag is on", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    await expect(resolveChatRuntime("openai", loaders())).rejects.toThrow(
      /not available yet/,
    )
  })

  it("uses the neutral loader once one is supplied", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    const l = loaders({
      loadRunChatTurnNeutral: vi.fn(async () => ({ runChatTurnNeutral: neutralRuntime })),
    })
    expect(await resolveChatRuntime("openai", l)).toBe(neutralRuntime)
  })

  it("lets the dev override force the neutral lane for an Anthropic session", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"
    const l = loaders({
      loadRunChatTurnNeutral: vi.fn(async () => ({ runChatTurnNeutral: neutralRuntime })),
    })
    expect(await resolveChatRuntime("anthropic", l)).toBe(neutralRuntime)
  })

  it("refuses a provider nobody registered", async () => {
    await expect(resolveChatRuntime("moonshot", loaders())).rejects.toThrow(/moonshot/)
  })

  /**
   * `resolveChatRuntime` takes no project-config argument today, so there is
   * nothing for a caller to widen the gate with directly. What pins the rule
   * is the call site inside it: it must always ask `isNeutralChatEnabled({})`
   * with an EMPTY config, never a config carrying `editor.neutralChat`, so a
   * later refactor that threads the project config through this function
   * cannot silently let `.desde/config.json` open the gate that today only
   * `EDITOR_NEUTRAL_CHAT` can.
   */
  it("reads the environment only: isNeutralChatEnabled is always called with an empty config", async () => {
    const spy = vi.spyOn(dormantSurfaces, "isNeutralChatEnabled")
    await expect(resolveChatRuntime("openai", loaders())).rejects.toThrow(/neutral/i)
    expect(spy).toHaveBeenCalledWith({})
  })
})

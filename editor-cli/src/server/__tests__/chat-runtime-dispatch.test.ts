import { afterEach, describe, expect, it, vi } from "vitest"
import * as dormantSurfaces from "../dormant-surfaces.js"
import { resolveChatRuntime } from "../chat-runtime-dispatch.js"

const sdkRuntime = vi.fn()
const neutralRuntime = vi.fn()

function loaders(overrides: Record<string, unknown> = {}) {
  return {
    loadSessionStore: vi.fn(),
    loadRunChatTurnSdk: vi.fn(async () => ({ runChatTurnSdk: sdkRuntime })),
    // Required now that `agent-chat-neutral/` exists — a real caller always
    // supplies this. Overridable per test so a case can swap in its own spy.
    loadRunChatTurnNeutral: vi.fn(async () => ({ runChatTurnNeutral: neutralRuntime })),
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
   *
   * The gate is opt-OUT now (Task 40): the flag must be explicitly set to
   * "0" to reach this refusal, not merely left unset.
   */
  it("refuses a neutral provider while the flag is explicitly off, naming the flag", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    await expect(resolveChatRuntime("openai", loaders())).rejects.toThrow(
      /EDITOR_NEUTRAL_CHAT/,
    )
  })

  it("does not import the SDK module when it refuses", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    const l = loaders()
    await expect(resolveChatRuntime("openai", l)).rejects.toThrow()
    expect((l as unknown as { loadRunChatTurnSdk: ReturnType<typeof vi.fn> }).loadRunChatTurnSdk)
      .not.toHaveBeenCalled()
  })

  it("uses the neutral loader with no configuration at all", async () => {
    const l = loaders()
    expect(await resolveChatRuntime("openai", l)).toBe(neutralRuntime)
  })

  it("uses the neutral loader once the flag is explicitly on", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "1"
    const l = loaders()
    expect(await resolveChatRuntime("openai", l)).toBe(neutralRuntime)
  })

  it("never touches the SDK loader on a neutral dispatch", async () => {
    const l = loaders()
    await resolveChatRuntime("openai", l)
    expect((l as unknown as { loadRunChatTurnSdk: ReturnType<typeof vi.fn> }).loadRunChatTurnSdk)
      .not.toHaveBeenCalled()
  })

  it("lets the dev override force the neutral lane for an Anthropic session", async () => {
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"
    const l = loaders()
    expect(await resolveChatRuntime("anthropic", l)).toBe(neutralRuntime)
  })

  it("refuses the dev override too while the flag is explicitly off", async () => {
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    process.env.EDITOR_CHAT_RUNTIME_OVERRIDE = "neutral"
    await expect(resolveChatRuntime("anthropic", loaders())).rejects.toThrow(/dormant/i)
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
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    const spy = vi.spyOn(dormantSurfaces, "isNeutralChatEnabled")
    await expect(resolveChatRuntime("openai", loaders())).rejects.toThrow(/neutral/i)
    expect(spy).toHaveBeenCalledWith({})
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveChatRuntime, resolveChatRuntimeKind } from "../chat-runtime-dispatch.js"

const sidecarRuntime = vi.fn()
const neutralRuntime = vi.fn()

function loaders(overrides: Record<string, unknown> = {}) {
  return {
    loadSessionStore: vi.fn(),
    loadRunChatTurnSidecar: vi.fn(async () => ({ runChatTurnSdk: sidecarRuntime })),
    loadRunChatTurnNeutral: vi.fn(async () => ({ runChatTurnNeutral: neutralRuntime })),
    ...overrides,
  } as never
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION
  vi.clearAllMocks()
})

describe("resolveChatRuntimeKind", () => {
  it("is neutral for OpenAI regardless of the subscription opt-in", () => {
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    expect(resolveChatRuntimeKind("openai", process.env)).toBe("neutral")
  })

  it("is neutral for Anthropic with a configured key, even with the opt-in set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    expect(resolveChatRuntimeKind("anthropic", process.env)).toBe("neutral")
  })

  it("is neutral for Anthropic with no key and no opt-in", () => {
    expect(resolveChatRuntimeKind("anthropic", process.env)).toBe("neutral")
  })

  it("is sidecar for Anthropic with the subscription opt-in and no key", () => {
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    expect(resolveChatRuntimeKind("anthropic", process.env)).toBe("sidecar")
  })

  it("throws for a provider nobody registered", () => {
    expect(() => resolveChatRuntimeKind("moonshot", process.env)).toThrow(/moonshot/)
  })
})

describe("resolveChatRuntime", () => {
  it("uses the neutral loader for OpenAI", async () => {
    expect(await resolveChatRuntime("openai", loaders())).toBe(neutralRuntime)
  })

  it("uses the neutral loader for Anthropic with a configured key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    expect(await resolveChatRuntime("anthropic", loaders())).toBe(neutralRuntime)
  })

  it("uses the sidecar loader for Anthropic opted into the subscription with no key", async () => {
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    expect(await resolveChatRuntime("anthropic", loaders())).toBe(sidecarRuntime)
  })

  it("never touches the sidecar loader on a neutral dispatch", async () => {
    const l = loaders()
    await resolveChatRuntime("openai", l)
    expect(
      (l as unknown as { loadRunChatTurnSidecar: ReturnType<typeof vi.fn> }).loadRunChatTurnSidecar,
    ).not.toHaveBeenCalled()
  })

  it("never touches the neutral loader on a sidecar dispatch", async () => {
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    const l = loaders()
    await resolveChatRuntime("anthropic", l)
    expect(
      (l as unknown as { loadRunChatTurnNeutral: ReturnType<typeof vi.fn> }).loadRunChatTurnNeutral,
    ).not.toHaveBeenCalled()
  })

  it("refuses a provider nobody registered", async () => {
    await expect(resolveChatRuntime("moonshot", loaders())).rejects.toThrow(/moonshot/)
  })

  /**
   * The rare stale client: it saw the sidecar available (opt-in on, no key)
   * a moment ago and asks for it by name. If the switch has since gone off —
   * a key got configured, or the opt-in got unset — the computed kind is
   * `'neutral'` and this refuses rather than silently downgrading the turn
   * onto a runtime the caller never asked to run on.
   */
  it("refuses a stale sidecar request once the switch is off, naming the switch", async () => {
    // No EDITOR_USE_CLAUDE_SUBSCRIPTION set: the switch is off, so the
    // computed kind is neutral even though the request explicitly names the
    // sidecar.
    await expect(
      resolveChatRuntime("anthropic", loaders(), "sidecar"),
    ).rejects.toThrow(/EDITOR_USE_CLAUDE_SUBSCRIPTION/)
  })

  it("does not load either runtime when it refuses a stale sidecar request", async () => {
    const l = loaders()
    await expect(resolveChatRuntime("anthropic", l, "sidecar")).rejects.toThrow()
    expect(
      (l as unknown as { loadRunChatTurnSidecar: ReturnType<typeof vi.fn> }).loadRunChatTurnSidecar,
    ).not.toHaveBeenCalled()
    expect(
      (l as unknown as { loadRunChatTurnNeutral: ReturnType<typeof vi.fn> }).loadRunChatTurnNeutral,
    ).not.toHaveBeenCalled()
  })

  it("a sidecar request is a no-op once the computed kind already agrees", async () => {
    process.env.EDITOR_USE_CLAUDE_SUBSCRIPTION = "1"
    expect(await resolveChatRuntime("anthropic", loaders(), "sidecar")).toBe(sidecarRuntime)
  })
})

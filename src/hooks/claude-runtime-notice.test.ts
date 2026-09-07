import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION,
  CLAUDE_RUNTIME_DOWNLOADING_TITLE,
  CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION,
  CLAUDE_RUNTIME_ERROR_TITLE,
  CLAUDE_RUNTIME_TOAST_ID,
  notifyClaudeRuntimeRetrySkipped,
  notifyClaudeRuntimeState,
} from "./claude-runtime-notice"

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}))

describe("notifyClaudeRuntimeState", () => {
  beforeEach(() => {
    vi.mocked(toast.loading).mockClear()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.dismiss).mockClear()
  })

  it("downloading: shows a loading toast naming the download, keyed on the stable id", () => {
    notifyClaudeRuntimeState({ phase: "downloading" }, vi.fn())
    expect(toast.loading).toHaveBeenCalledWith(CLAUDE_RUNTIME_DOWNLOADING_TITLE, {
      id: CLAUDE_RUNTIME_TOAST_ID,
      description: CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION,
    })
  })

  it("error: shows the error toast with the bridge's own message and a retry action", () => {
    const retry = vi.fn()
    notifyClaudeRuntimeState({ phase: "error", error: "Couldn't reach the npm registry" }, retry)

    expect(toast.error).toHaveBeenCalledTimes(1)
    const [title, options] = vi.mocked(toast.error).mock.calls[0]
    expect(title).toBe(CLAUDE_RUNTIME_ERROR_TITLE)
    expect(options?.id).toBe(CLAUDE_RUNTIME_TOAST_ID)
    expect(options?.description).toBe("Couldn't reach the npm registry")
    const action = options?.action as { label: string; onClick: () => void } | undefined
    expect(action?.label).toBe("Retry")

    action?.onClick?.()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("error: falls back to a generic description when the bridge sent none", () => {
    notifyClaudeRuntimeState({ phase: "error" }, vi.fn())
    const [, options] = vi.mocked(toast.error).mock.calls[0]
    expect(options?.description).toBe(CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION)
  })

  it("error: falls back to the generic description for a whitespace-only message", () => {
    notifyClaudeRuntimeState({ phase: "error", error: "   " }, vi.fn())
    const [, options] = vi.mocked(toast.error).mock.calls[0]
    expect(options?.description).toBe(CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION)
  })

  it("checking: dismisses any active toast, opens nothing new", () => {
    notifyClaudeRuntimeState({ phase: "checking" }, vi.fn())
    expect(toast.dismiss).toHaveBeenCalledWith(CLAUDE_RUNTIME_TOAST_ID)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("ready: dismisses any active toast, opens nothing new (quiet completion)", () => {
    notifyClaudeRuntimeState({ phase: "ready" }, vi.fn())
    expect(toast.dismiss).toHaveBeenCalledWith(CLAUDE_RUNTIME_TOAST_ID)
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe("notifyClaudeRuntimeRetrySkipped", () => {
  beforeEach(() => {
    vi.mocked(toast.info).mockClear()
  })

  it("shows the gate's own reason, keyed on the same stable id as every other phase", () => {
    notifyClaudeRuntimeRetrySkipped("AI chat runtime install skipped: a configured provider does not need it.")
    expect(toast.info).toHaveBeenCalledWith(
      "AI chat runtime install skipped: a configured provider does not need it.",
      { id: CLAUDE_RUNTIME_TOAST_ID },
    )
  })
})

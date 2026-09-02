import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}))

import { toast } from "sonner"
import { useClaudeRuntimeStatus, DOWNLOADING_TOAST_DELAY_MS } from "./useClaudeRuntimeStatus"
import type { DesktopBridge, DesktopClaudeRuntimeState, DesktopUpdateState } from "@/types/desktop-bridge"

function installBridge(initialState: DesktopClaudeRuntimeState): {
  emit: (state: DesktopClaudeRuntimeState) => void
  retry: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<(state: DesktopClaudeRuntimeState) => void>()
  const retry = vi.fn()
  const bridge: DesktopBridge = {
    appVersion: "0.1.0",
    updates: {
      getState: vi.fn(async () => ({ phase: "idle" }) as DesktopUpdateState),
      onState: () => () => {},
      download: vi.fn(async () => {}),
      restartAndInstall: vi.fn(),
      checkForUpdates: vi.fn(async () => ({ performed: false })),
      getAutoDownload: vi.fn(async () => true),
      setAutoDownload: vi.fn(async () => {}),
    },
    claudeRuntime: {
      getState: vi.fn(async () => initialState),
      onState: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      retry,
    },
    pickFolder: vi.fn(async () => null),
  }
  ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
  return { emit: (state) => listeners.forEach((l) => l(state)), retry }
}

beforeEach(() => {
  vi.mocked(toast.loading).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.dismiss).mockClear()
})

afterEach(() => {
  delete (window as { desdeDesktop?: unknown }).desdeDesktop
  vi.useRealTimers()
})

describe("useClaudeRuntimeStatus — absent bridge (plain browser tab)", () => {
  it("does nothing when window.desdeDesktop is absent", () => {
    renderHook(() => useClaudeRuntimeStatus())
    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.dismiss).not.toHaveBeenCalled()
  })
})

describe("useClaudeRuntimeStatus — downloading debounce", () => {
  it("does NOT toast a downloading phase that resolves before the debounce delay", async () => {
    vi.useFakeTimers()
    const { emit } = installBridge({ phase: "downloading" })
    renderHook(() => useClaudeRuntimeStatus())

    // Resolve the initial getState() promise (fake timers don't advance
    // microtasks, so flush with a real Promise tick under fake timers).
    await act(async () => {
      await Promise.resolve()
    })

    // Completes well before the debounce window — a fast connection.
    act(() => {
      vi.advanceTimersByTime(DOWNLOADING_TOAST_DELAY_MS - 200)
      emit({ phase: "ready" })
    })
    act(() => {
      vi.advanceTimersByTime(DOWNLOADING_TOAST_DELAY_MS)
    })

    expect(toast.loading).not.toHaveBeenCalled()
  })

  it("DOES toast a downloading phase that outlasts the debounce delay", async () => {
    vi.useFakeTimers()
    installBridge({ phase: "downloading" })
    renderHook(() => useClaudeRuntimeStatus())

    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(DOWNLOADING_TOAST_DELAY_MS + 50)
    })

    expect(toast.loading).toHaveBeenCalledTimes(1)
  })
})

describe("useClaudeRuntimeStatus — error and retry", () => {
  it("toasts an error state with a working retry action wired to the bridge", async () => {
    const { retry } = installBridge({ phase: "error", error: "Couldn't reach the npm registry" })
    renderHook(() => useClaudeRuntimeStatus())

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1)
    })
    const [, options] = vi.mocked(toast.error).mock.calls[0]
    const action = options?.action as { label: string; onClick: () => void } | undefined
    action?.onClick?.()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe("useClaudeRuntimeStatus — quiet on ready (the common case)", () => {
  it("mounting with the runtime already ready shows nothing", async () => {
    installBridge({ phase: "ready" })
    renderHook(() => useClaudeRuntimeStatus())

    await act(async () => {
      await Promise.resolve()
    })

    expect(toast.loading).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe("useClaudeRuntimeStatus — unmount cleanup", () => {
  it("does not fire a debounced toast after unmount", async () => {
    vi.useFakeTimers()
    installBridge({ phase: "downloading" })
    const { unmount } = renderHook(() => useClaudeRuntimeStatus())

    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(DOWNLOADING_TOAST_DELAY_MS + 50)
    })

    expect(toast.loading).not.toHaveBeenCalled()
  })
})

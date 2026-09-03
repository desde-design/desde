import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// sonner's toast is a side effect we don't assert on except in the failure case.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

import { toast } from "sonner"
import { AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID, useDesktopUpdates } from "./useDesktopUpdates"
import type { DesktopBridge, DesktopClaudeRuntimeState, DesktopUpdateState } from "@/types/desktop-bridge"

// The mock is module-scoped and would otherwise accumulate calls across
// every `it` in this file.
beforeEach(() => {
  vi.mocked(toast.error).mockClear()
})

function installBridge(overrides: Partial<DesktopBridge["updates"]> = {}): {
  bridge: DesktopBridge
  listeners: Set<(state: DesktopUpdateState) => void>
} {
  const listeners = new Set<(state: DesktopUpdateState) => void>()
  const bridge: DesktopBridge = {
    appVersion: "0.1.0",
    updates: {
      getState: vi.fn(async () => ({ phase: "idle" }) as DesktopUpdateState),
      onState: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      download: vi.fn(async () => {}),
      restartAndInstall: vi.fn(() => new Promise<never>(() => {})),
      checkForUpdates: vi.fn(async () => ({ performed: true })),
      getAutoDownload: vi.fn(async () => true),
      setAutoDownload: vi.fn(async () => {}),
      ...overrides,
    },
    claudeRuntime: {
      getState: vi.fn(async () => ({ phase: "ready" }) as DesktopClaudeRuntimeState),
      onState: () => () => {},
      retry: vi.fn(),
    },
    pickFolder: vi.fn(async () => null),
  }
  ;(window as unknown as { desdeDesktop: DesktopBridge }).desdeDesktop = bridge
  return { bridge, listeners }
}

afterEach(() => {
  delete (window as { desdeDesktop?: unknown }).desdeDesktop
})

describe("useDesktopUpdates — absent bridge (plain browser tab)", () => {
  it("returns undefined when window.desdeDesktop does not exist", () => {
    const { result } = renderHook(() => useDesktopUpdates())
    expect(result.current).toBeUndefined()
  })
})

describe("useDesktopUpdates — bridge present", () => {
  it("hydrates state and autoDownload from the bridge on mount", async () => {
    installBridge({
      getState: vi.fn(async () => ({ phase: "available", version: "1.2.0" }) as DesktopUpdateState),
      getAutoDownload: vi.fn(async () => false),
    })
    const { result } = renderHook(() => useDesktopUpdates())

    await waitFor(() => {
      expect(result.current?.state).toEqual({ phase: "available", version: "1.2.0" })
    })
    expect(result.current?.autoDownload).toBe(false)
  })

  it("autoDownload is undefined until the initial read resolves", async () => {
    installBridge({ getAutoDownload: vi.fn(() => new Promise<boolean>(() => {})) }) // never resolves
    const { result } = renderHook(() => useDesktopUpdates())
    expect(result.current?.autoDownload).toBeUndefined()
    // Let the OTHER initial read (getState(), which does resolve) settle
    // inside `act()` before the test ends, so its state update doesn't land
    // un-wrapped after this test's body has already returned.
    await act(async () => {
      await Promise.resolve()
    })
  })

  it("subscribes to onState and updates on a pushed state", async () => {
    const { listeners } = installBridge()
    const { result } = renderHook(() => useDesktopUpdates())

    await waitFor(() => expect(listeners.size).toBe(1))
    act(() => {
      listeners.forEach((cb) => cb({ phase: "downloading", version: "2.0.0", progressPercent: 40 }))
    })

    await waitFor(() => {
      expect(result.current?.state).toEqual({ phase: "downloading", version: "2.0.0", progressPercent: 40 })
    })
  })

  it("unsubscribes onState on unmount", async () => {
    const { listeners } = installBridge()
    const { unmount } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(listeners.size).toBe(1))
    unmount()
    expect(listeners.size).toBe(0)
  })

  it("setAutoDownload updates optimistically, then calls the bridge", async () => {
    const { bridge } = installBridge({ getAutoDownload: vi.fn(async () => true) })
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current?.autoDownload).toBe(true))

    await act(async () => {
      await result.current?.setAutoDownload(false)
    })
    expect(result.current?.autoDownload).toBe(false)
    expect(bridge.updates.setAutoDownload).toHaveBeenCalledWith(false)
  })

  it("download() delegates to the bridge", async () => {
    const { bridge } = installBridge()
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current).not.toBeUndefined())
    await result.current?.download()
    expect(bridge.updates.download).toHaveBeenCalledTimes(1)
  })

  describe("restartAndInstall() drives the 'restarting' flag the check dialog shows", () => {
    it("is false before the click and true right after it, while the bridge call is still pending (the normal path: the app quits before it settles)", async () => {
      installBridge()
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))
      expect(result.current?.restarting).toBe(false)
      act(() => result.current?.restartAndInstall())
      await waitFor(() => expect(result.current?.restarting).toBe(true))
    })

    it("goes back to false when the main process reports nothing is restarting after all", async () => {
      installBridge({ restartAndInstall: vi.fn(async () => "failed" as const) })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))
      act(() => result.current?.restartAndInstall())
      await waitFor(() => expect(result.current?.restarting).toBe(false))
    })

    it("stays true on 'installing' — the window is about to close", async () => {
      installBridge({ restartAndInstall: vi.fn(async () => "installing" as const) })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))
      act(() => result.current?.restartAndInstall())
      await waitFor(() => expect(result.current?.restarting).toBe(true))
      await new Promise((r) => setTimeout(r, 10))
      expect(result.current?.restarting).toBe(true)
    })

    it("goes back to false on an IPC-layer failure, instead of an unhandled rejection", async () => {
      installBridge({ restartAndInstall: vi.fn(async () => { throw new Error("IPC channel closed") }) })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))
      act(() => result.current?.restartAndInstall())
      await waitFor(() => expect(result.current?.restarting).toBe(false))
    })
  })

  it("restartAndInstall() delegates to the bridge", async () => {
    const { bridge } = installBridge()
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current).not.toBeUndefined())
    result.current?.restartAndInstall()
    expect(bridge.updates.restartAndInstall).toHaveBeenCalledTimes(1)
  })

  it("checkForUpdates() delegates to the bridge", async () => {
    const { bridge } = installBridge({ checkForUpdates: vi.fn(async () => ({ performed: true })) })
    const { result } = renderHook(() => useDesktopUpdates())
    await waitFor(() => expect(result.current).not.toBeUndefined())
    await act(async () => {
      result.current?.checkForUpdates()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bridge.updates.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  /**
   * The click's own outcome is state (`lastCheck`), not a toast. Mo,
   * 2026-09-02: "we should use a modal and not a toast as this is an
   * explicit action from a user". The toast this replaces also had no host
   * on the launcher page, so there the click did nothing visible at all.
   *
   * The bridge's `checkForUpdates()` resolves precisely when the underlying
   * check settles (threaded through `updater.ts`'s own tracked-check
   * promise via IPC `invoke`/`handle`), so "checking" holds until then with
   * no timeout window to guess. `performed` is read first (F8): a check
   * that never ran (a packaged build with no publish provider, unpackaged
   * dev's no-op) must not be reported as anything the state says.
   */
  describe("checkForUpdates() records the click's own result in lastCheck", () => {
    it("is undefined before any click", async () => {
      installBridge()
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())
      expect(result.current?.lastCheck).toBeUndefined()
    })

    it("holds 'checking' until the bridge call settles, however long that takes, then records 'performed'", async () => {
      let resolveCheck: ((result: { performed: boolean }) => void) | undefined
      installBridge({
        checkForUpdates: vi.fn(
          () => new Promise<{ performed: boolean }>((resolve) => { resolveCheck = resolve }),
        ),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      act(() => {
        result.current?.checkForUpdates()
      })
      expect(result.current?.lastCheck).toEqual({ status: "checking" })

      // Many microtask turns with the bridge call still unsettled: nothing
      // here races a clock, so it must still say "checking".
      await act(async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "checking" })

      await act(async () => {
        resolveCheck?.({ performed: true })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "performed" })
    })

    it("records 'not-performed' when the bridge says nothing was checked, so idle is not read as up to date", async () => {
      installBridge({
        checkForUpdates: vi.fn(async () => ({ performed: false })),
        getState: vi.fn(async () => ({ phase: "idle" }) as DesktopUpdateState),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      await act(async () => {
        result.current?.checkForUpdates()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "not-performed" })
      expect(result.current?.state).toEqual({ phase: "idle" })
    })

    it("is untouched by a background state push that no click here triggered (the silent boot/4h check)", async () => {
      const { listeners } = installBridge()
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      act(() => {
        listeners.forEach((cb) => cb({ phase: "checking" }))
      })
      act(() => {
        listeners.forEach((cb) => cb({ phase: "idle" }))
      })
      expect(result.current?.lastCheck).toBeUndefined()
      expect(result.current?.state).toEqual({ phase: "idle" })
    })

    it("only the most recently issued click may write lastCheck, so an older settle cannot overwrite a newer click", async () => {
      const settlers: Array<(r: { performed: boolean }) => void> = []
      installBridge({
        checkForUpdates: vi.fn(
          () => new Promise<{ performed: boolean }>((resolve) => settlers.push(resolve)),
        ),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      act(() => {
        result.current?.checkForUpdates()
      })
      act(() => {
        result.current?.checkForUpdates()
      })
      expect(settlers).toHaveLength(2)

      // The FIRST click settles after the second was issued: ignored.
      await act(async () => {
        settlers[0]?.({ performed: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "checking" })

      await act(async () => {
        settlers[1]?.({ performed: true })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "performed" })
    })

    it("an IPC-layer failure from checkForUpdates() becomes a 'failed' result, not an unhandled rejection", async () => {
      installBridge({
        checkForUpdates: vi.fn(async () => {
          throw new Error("IPC channel closed")
        }),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      expect(() => {
        act(() => {
          result.current?.checkForUpdates()
        })
      }).not.toThrow()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current?.lastCheck).toEqual({ status: "failed", error: "IPC channel closed" })
    })

    it("exposes the running app's version, which is what 'up to date' names", async () => {
      installBridge()
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())
      expect(result.current?.appVersion).toBe("0.1.0")
    })
  })

  /**
   * F7 (adversarial review of Phase 4): a failed settings write must not
   * leave the checkbox showing an unpersisted value, and must not produce an
   * unhandled rejection from the fire-and-forget `void updates.setAutoDownload(value)`
   * callers use (`desktop-update-menu.tsx`'s `onCheckedChange`).
   */
  describe("setAutoDownload — write failure rolls back and surfaces a toast (F7)", () => {
    it("rolls back to the last CONFIRMED value and shows a toast when the write rejects", async () => {
      installBridge({
        getAutoDownload: vi.fn(async () => true),
        setAutoDownload: vi.fn(async () => {
          throw new Error("EACCES: permission denied")
        }),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))

      // Does not throw — the fire-and-forget `void updates.setAutoDownload(value)`
      // call site must never produce an unhandled rejection.
      await act(async () => {
        await expect(result.current?.setAutoDownload(false)).resolves.toBeUndefined()
      })

      // Rolled back to the last confirmed value (true), not left on the
      // optimistic (and never-persisted) false.
      expect(result.current?.autoDownload).toBe(true)
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't save the update setting",
        expect.objectContaining({ id: AUTO_DOWNLOAD_WRITE_FAILED_TOAST_ID }),
      )
    })

    it("a later successful toggle still works after an earlier one failed", async () => {
      const setAutoDownload = vi
        .fn<DesktopBridge["updates"]["setAutoDownload"]>()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(undefined)
      const { bridge } = installBridge({
        getAutoDownload: vi.fn(async () => true),
        setAutoDownload,
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))

      await act(async () => {
        await result.current?.setAutoDownload(false)
      })
      expect(result.current?.autoDownload).toBe(true) // rolled back

      await act(async () => {
        await result.current?.setAutoDownload(false)
      })
      expect(result.current?.autoDownload).toBe(false) // this one landed
      expect(bridge.updates.setAutoDownload).toHaveBeenCalledTimes(2)
    })

    /**
     * The overlapping-calls case: an OLDER call's FAILURE must never stomp a
     * NEWER call's SUCCESS, regardless of which one's underlying promise
     * settles first. Modeled with deferred promises so the test controls
     * resolution order explicitly — call A is issued first and fails, call
     * B is issued SECOND (while A is still in flight) and succeeds to the
     * SAME target value, and A's rejection is made to arrive at the hook
     * BEFORE B's success (a fast failure "lapping" a slower success that
     * was queued after it — entirely possible even with the main-process
     * side serialized in invocation order, since that only orders WHEN the
     * writes run, not how long each one takes to settle).
     *
     * A and B target the SAME value deliberately: if they targeted
     * different values, a buggy rollback (to the pre-toggle baseline) could
     * accidentally coincide with one of the calls' real values and the test
     * would pass for the wrong reason without actually exercising the
     * sequencing guard. Same value for both makes "rolled back to the
     * baseline" and "correctly shows what B confirmed" observably
     * different outcomes whenever the baseline itself differs from that
     * target value — which it does here (true vs. false).
     */
    it("an older call's failure arriving AFTER a newer call's success does not stomp the newer call's result", async () => {
      let rejectA: ((err: Error) => void) | undefined
      const callA = new Promise<void>((_resolve, reject) => {
        rejectA = reject
      })
      let resolveB: (() => void) | undefined
      const callB = new Promise<void>((resolve) => {
        resolveB = resolve
      })

      const setAutoDownload = vi
        .fn<DesktopBridge["updates"]["setAutoDownload"]>()
        .mockImplementationOnce(() => callA) // 1st invocation (call A)
        .mockImplementationOnce(() => callB) // 2nd invocation (call B)
      installBridge({ getAutoDownload: vi.fn(async () => true), setAutoDownload })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))

      // Call A (false) issued first — the synchronous optimistic state
      // update happens inside this call, before its first `await`.
      let pendingA: Promise<void> | undefined
      act(() => {
        pendingA = result.current?.setAutoDownload(false)
      })
      // ...call B (also false) issued second, while A is still pending.
      let pendingB: Promise<void> | undefined
      act(() => {
        pendingB = result.current?.setAutoDownload(false)
      })

      // A's rejection lands FIRST.
      rejectA?.(new Error("disk full"))
      await act(async () => {
        await expect(pendingA).resolves.toBeUndefined() // caught internally, never throws
      })
      // B's success lands SECOND.
      resolveB?.()
      await act(async () => {
        await pendingB
      })

      // The checkbox reflects B's real, successful write (false) — not
      // rolled back to the pre-toggle baseline (true) by A's stale failure.
      expect(result.current?.autoDownload).toBe(false)
    })

    /**
     * A subtler version of the same class of bug: an OLDER call's SUCCESS
     * settling AFTER a NEWER call's success must not corrupt what counts as
     * "the last confirmed value" — even though, at the moment it happens,
     * the DISPLAYED checkbox is untouched (both calls are superseded-safe on
     * the display, since only the latest-ISSUED call may touch it). The
     * corruption is invisible until some LATER call fails and rolls back to
     * the wrong (stale) confirmed value instead of the real one.
     *
     * Sequence: baseline true. Call A (→false) issued first, kept pending.
     * Call B (→true) issued second, resolves immediately. Call A THEN
     * resolves (out of order) — before the fix, this unconditionally
     * overwrote the confirmed ref back to false. Call C (→false) is issued
     * next and FAILS; its rollback target is what reveals whether the
     * confirmed ref still correctly says "true" (B's real result) or was
     * corrupted to "false" (A's stale one).
     */
    it("an older call's success settling AFTER a newer call's success does not corrupt the confirmed value a LATER failure rolls back to", async () => {
      let resolveA: (() => void) | undefined
      const callA = new Promise<void>((resolve) => {
        resolveA = resolve
      })

      const setAutoDownload = vi
        .fn<DesktopBridge["updates"]["setAutoDownload"]>()
        .mockImplementationOnce(() => callA) // call A (→false), kept pending
        .mockResolvedValueOnce(undefined) // call B (→true), resolves immediately
        .mockRejectedValueOnce(new Error("disk full")) // call C (→false), fails
      installBridge({ getAutoDownload: vi.fn(async () => true), setAutoDownload })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current?.autoDownload).toBe(true))

      // Call A (false) issued first, stays pending.
      act(() => {
        void result.current?.setAutoDownload(false)
      })
      // Call B (true) issued second, resolves right away — becomes the
      // latest CONFIRMED value and the displayed one.
      await act(async () => {
        await result.current?.setAutoDownload(true)
      })
      expect(result.current?.autoDownload).toBe(true)

      // Call A's success finally lands, out of order. The display is
      // unaffected either way (A is no longer the latest ISSUED call) — the
      // bug this covers is invisible here.
      await act(async () => {
        resolveA?.()
        await callA
      })
      expect(result.current?.autoDownload).toBe(true) // still unaffected on the surface

      // Call C fails. Its rollback target is what actually reveals the bug:
      // the confirmed value must still be B's `true`, not A's stale `false`.
      await act(async () => {
        await result.current?.setAutoDownload(false)
      })
      expect(result.current?.autoDownload).toBe(true)
    })
  })

  /**
   * F13 (second adversarial review pass): the toggle stays enabled while
   * the initial `getAutoDownload()` read is still in flight, so a user can
   * (and, per the UI's own `checked={updates.autoDownload ?? true}`
   * fallback, is invited to) toggle it before that read resolves. If the
   * read captured the value from BEFORE the toggle's write landed, it must
   * not overwrite the toggle's own, more current result once it finally
   * arrives.
   */
  describe("late hydration does not overwrite a completed toggle (F13)", () => {
    it("a completed toggle is not overwritten by a LATE getAutoDownload() response carrying the stale pre-toggle value", async () => {
      let resolveHydration: ((v: boolean) => void) | undefined
      const hydration = new Promise<boolean>((resolve) => {
        resolveHydration = resolve
      })
      installBridge({
        getAutoDownload: vi.fn(() => hydration), // pending until the test resolves it
        setAutoDownload: vi.fn(async () => {}),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      // Hydration is still pending — the hook's own documented state while
      // getAutoDownload() hasn't resolved yet.
      await waitFor(() => expect(result.current).not.toBeUndefined())
      expect(result.current?.autoDownload).toBeUndefined()

      // The user toggles BEFORE hydration ever resolves, and it succeeds.
      await act(async () => {
        await result.current?.setAutoDownload(false)
      })
      expect(result.current?.autoDownload).toBe(false)

      // Hydration FINALLY arrives, carrying the STALE pre-toggle value
      // (true) — it read the setting before the toggle's write landed.
      await act(async () => {
        resolveHydration?.(true)
        await hydration
      })

      // Must still show the user's own, more current toggle result, not
      // the stale hydration response.
      expect(result.current?.autoDownload).toBe(false)
    })

    it("a LATER failed toggle still rolls back to the value the earlier successful toggle confirmed, not to the stale hydration value", async () => {
      let resolveHydration: ((v: boolean) => void) | undefined
      const hydration = new Promise<boolean>((resolve) => {
        resolveHydration = resolve
      })
      installBridge({
        getAutoDownload: vi.fn(() => hydration),
        setAutoDownload: vi
          .fn<DesktopBridge["updates"]["setAutoDownload"]>()
          .mockResolvedValueOnce(undefined) // first toggle succeeds
          .mockRejectedValueOnce(new Error("disk full")), // second toggle fails
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      // First toggle, before hydration resolves, succeeds.
      await act(async () => {
        await result.current?.setAutoDownload(false)
      })
      expect(result.current?.autoDownload).toBe(false)

      // The stale hydration response arrives late, carrying the WRONG
      // pre-toggle value — must be ignored (same as the test above).
      await act(async () => {
        resolveHydration?.(true)
        await hydration
      })
      expect(result.current?.autoDownload).toBe(false)

      // A second toggle now fails. It must roll back to the first toggle's
      // CONFIRMED value (false) — not to the stale hydration value (true),
      // which would mean hydration silently won after all.
      await act(async () => {
        await result.current?.setAutoDownload(true)
      })
      expect(result.current?.autoDownload).toBe(false)
    })
  })

  /**
   * F17 (third adversarial review pass). F13's fix gated hydration on
   * "was ANY mutation issued" — too strict. If the user toggles before
   * hydration lands and that FIRST write FAILS, nothing was ever actually
   * confirmed: the catch rolls back to `lastConfirmedAutoDownload`, which
   * is still `undefined` (there was nothing better to roll back to), and
   * the too-strict gate then discarded the ONLY real answer hydration was
   * ever going to provide. Concretely: with `false` genuinely on disk, the
   * checkbox's own `undefined ?? true` fallback would show CHECKED
   * forever, permanently disagreeing with the real setting.
   */
  describe("a failed pre-hydration toggle does not discard the hydration read that arrives afterward (F17)", () => {
    it("the checkbox settles on the real persisted value once hydration arrives, instead of staying stuck on the failed rollback's undefined", async () => {
      let resolveHydration: ((v: boolean) => void) | undefined
      const hydration = new Promise<boolean>((resolve) => {
        resolveHydration = resolve
      })
      installBridge({
        getAutoDownload: vi.fn(() => hydration),
        setAutoDownload: vi.fn(async () => {
          throw new Error("EACCES: permission denied")
        }),
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())
      expect(result.current?.autoDownload).toBeUndefined()

      // The user toggles BEFORE hydration resolves, and it FAILS.
      await act(async () => {
        await result.current?.setAutoDownload(true)
      })
      // Rolled back to `undefined` — nothing has been confirmed by
      // anything yet; hydration hasn't arrived and this attempt failed.
      expect(result.current?.autoDownload).toBeUndefined()

      // Hydration finally arrives, carrying the REAL persisted value
      // (false). Nothing has actually CONFIRMED a different value, so this
      // must now be allowed to apply — both as the new rollback baseline
      // and the displayed value.
      await act(async () => {
        resolveHydration?.(false)
        await hydration
      })

      expect(result.current?.autoDownload).toBe(false)
    })

    it("a LATER failed toggle rolls back to what hydration eventually confirmed, not to undefined", async () => {
      let resolveHydration: ((v: boolean) => void) | undefined
      const hydration = new Promise<boolean>((resolve) => {
        resolveHydration = resolve
      })
      installBridge({
        getAutoDownload: vi.fn(() => hydration),
        setAutoDownload: vi
          .fn<DesktopBridge["updates"]["setAutoDownload"]>()
          .mockRejectedValueOnce(new Error("EACCES: permission denied")) // pre-hydration toggle fails
          .mockRejectedValueOnce(new Error("disk full")), // later toggle also fails
      })
      const { result } = renderHook(() => useDesktopUpdates())
      await waitFor(() => expect(result.current).not.toBeUndefined())

      await act(async () => {
        await result.current?.setAutoDownload(true)
      })
      expect(result.current?.autoDownload).toBeUndefined()

      await act(async () => {
        resolveHydration?.(false)
        await hydration
      })
      expect(result.current?.autoDownload).toBe(false)

      // A later toggle fails too — must roll back to what hydration
      // confirmed (false), not to undefined.
      await act(async () => {
        await result.current?.setAutoDownload(true)
      })
      expect(result.current?.autoDownload).toBe(false)
    })
  })
})

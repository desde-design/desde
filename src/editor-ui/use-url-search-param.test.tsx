import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useUrlSearchParam } from "./use-url-search-param"

const originalPushState = window.history.pushState
const originalReplaceState = window.history.replaceState

beforeEach(() => {
  window.history.replaceState({}, "", "/")
})

afterEach(() => {
  // The hook patches pushState/replaceState lazily and never unpatches
  // (intentional — see use-url-search-param.ts comment). For test isolation
  // we restore originals so an earlier test's patched version doesn't leak.
  window.history.pushState = originalPushState
  window.history.replaceState = originalReplaceState
})

describe("useUrlSearchParam", () => {
  it("reads the initial query param on mount", () => {
    window.history.replaceState({}, "", "/?url=https://example.com/proto")
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBe("https://example.com/proto")
  })

  it("returns null when the param is absent", () => {
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBeNull()
  })

  it("re-renders on popstate (browser back/forward)", () => {
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBeNull()
    act(() => {
      window.history.replaceState({}, "", "/?url=https://a.test/")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(result.current).toBe("https://a.test/")
  })

  it("re-renders on history.pushState (Next router.push)", () => {
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBeNull()
    act(() => {
      window.history.pushState({}, "", "/?url=https://pushed.test/")
    })
    expect(result.current).toBe("https://pushed.test/")
  })

  it("re-renders on history.replaceState", () => {
    const { result } = renderHook(() => useUrlSearchParam("url"))
    act(() => {
      window.history.pushState({}, "", "/?url=https://first.test/")
    })
    expect(result.current).toBe("https://first.test/")
    act(() => {
      window.history.replaceState({}, "", "/?url=https://replaced.test/")
    })
    expect(result.current).toBe("https://replaced.test/")
  })

  it("re-renders on hashchange", () => {
    window.history.replaceState({}, "", "/?url=https://stable.test/")
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBe("https://stable.test/")
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"))
    })
    // Hash didn't affect the query string, but the hook still re-reads.
    expect(result.current).toBe("https://stable.test/")
  })

  it("preserves native pushState/replaceState arity (length === 3)", () => {
    renderHook(() => useUrlSearchParam("url"))
    // Native History methods are arity 3: (state, unused, url?). Some
    // routing/instrumentation libraries inspect Function.length to detect
    // the patched-vs-native shape; the wrapper must keep length === 3.
    expect(window.history.pushState.length).toBe(3)
    expect(window.history.replaceState.length).toBe(3)
  })

  it("transitions from a value to null when the param is removed", () => {
    window.history.replaceState({}, "", "/?url=https://present.test/")
    const { result } = renderHook(() => useUrlSearchParam("url"))
    expect(result.current).toBe("https://present.test/")
    act(() => {
      window.history.pushState({}, "", "/")
    })
    expect(result.current).toBeNull()
  })
})

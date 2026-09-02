/**
 * jsdom gap-fillers, shared by every suite in the repo that renders React.
 *
 * Split out of `./test-setup.ts` so the VIEWER's surface-gallery sweep can
 * reuse them. That suite runs under `viewer/vitest.config.ts`, which does not
 * set `globals: true` — and `@testing-library/jest-dom`, which `test-setup`
 * imports on the line above these, reads a global `expect` at import time and
 * throws without one. The shims themselves need no globals.
 *
 * Everything here is ADDITIVE and self-guarding: each block installs only if
 * the API is missing, so a future jsdom with a real implementation wins.
 */

/**
 * jsdom in this repo does not ship the Pointer Events capture API.
 * Radix UI components (Tabs, Dialog, etc.) call these on internal
 * Triggers and will throw on click in tests without them. No-op
 * polyfills make the click path work in jsdom without affecting
 * real browser behavior. (Additive — only sets if missing, so a
 * future jsdom with real impls would win.)
 */
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function () {
      return false
    }
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {
      // no-op
    }
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {
      // no-op
    }
  }
}

/**
 * jsdom in this repo ships `window.localStorage` as an empty object
 * without the Storage methods. Install a minimal in-memory mock so
 * components using `localStorage.getItem` / `setItem` don't crash.
 * Tests that need to assert localStorage interactions can clear the
 * store in `beforeEach` via `window.localStorage.clear()`.
 */
if (typeof window !== "undefined") {
  const hasRealStorage =
    typeof window.localStorage === "object" &&
    typeof (window.localStorage as Storage | undefined)?.setItem === "function"
  if (!hasRealStorage) {
    const store: Record<string, string> = {}
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = String(v)
        },
        removeItem: (k: string) => {
          delete store[k]
        },
        clear: () => {
          for (const k of Object.keys(store)) delete store[k]
        },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() {
          return Object.keys(store).length
        },
      },
    })
  }
}

/**
 * jsdom does not implement ResizeObserver. Components that watch
 * element size changes (e.g. Radix popovers/dropdowns) crash without
 * it. The no-op observer is enough — tests assert on static rendered
 * output, not on resize-driven state transitions.
 */
if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    NoopResizeObserver
}

/**
 * jsdom ships no `window.matchMedia` at all, so any component that picks a
 * layout from the viewport throws during render rather than falling back.
 *
 * This is a real evaluator, not a `matches: false` stub. A stub that always
 * says "no" reports the same viewport whatever the test does, so a
 * responsive component can only ever be observed in its smallest state and a
 * breakpoint bug is untestable by construction. This parses `(min-width: Npx)`
 * / `(max-width: Npx)` against `window.innerWidth`, which jsdom does maintain
 * and tests can set — so a test can choose a viewport and get the layout that
 * viewport really implies. Anything it cannot parse returns false.
 *
 * Additive, like the rest of this file: a future jsdom with a real impl wins.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  const evaluate = (query: string): boolean => {
    const min = /\(\s*min-width:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(query)
    if (min && window.innerWidth < Number(min[1])) return false
    const max = /\(\s*max-width:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(query)
    if (max && window.innerWidth > Number(max[1])) return false
    return Boolean(min || max)
  }
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<EventListenerOrEventListenerObject>()
    return {
      get matches() {
        return evaluate(query)
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, l: EventListenerOrEventListenerObject) => {
        listeners.add(l)
      },
      removeEventListener: (
        _t: string,
        l: EventListenerOrEventListenerObject,
      ) => {
        listeners.delete(l)
      },
      // Deprecated pair, still what some libraries reach for first.
      addListener: (l: EventListenerOrEventListenerObject) => {
        listeners.add(l)
      },
      removeListener: (l: EventListenerOrEventListenerObject) => {
        listeners.delete(l)
      },
      dispatchEvent: () => true,
    } as unknown as MediaQueryList
  }
}

/**
 * jsdom omits Element.scrollIntoView / scrollBy. Components that
 * scroll the active item into view (Radix menus, lists) call these in
 * layout effects and crash on render without a stub. No-ops are
 * sufficient — none of the assertions probe scroll position.
 */
if (typeof Element !== "undefined") {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {
      // no-op
    }
  }
  if (!Element.prototype.scrollBy) {
    Element.prototype.scrollBy = function () {
      // no-op
    }
  }
}

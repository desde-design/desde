/**
 * DOM-interaction helpers for fixtures whose interesting states live behind
 * an internal step machine that the host component reaches only through a
 * real interaction (typing, clicking) — there is no prop that sets the state
 * directly. A handful of this catalog's surfaces (`connect-viewer-dialog`,
 * `new-project-page`, `branch-menu`, `capture-to-canvas-button`,
 * `activity-panel`) expose every dependency as a plain prop (async callbacks
 * we fully control, or a store we seed directly) but gate the RENDERING on
 * internal `useState` reached only by clicking through the same UI a user
 * would. Driving that interaction is the only way to reach the state
 * honestly — a shortcut prop would be inventing an API the component doesn't
 * have.
 *
 * Both techniques mirror ones already proven in this exact runtime by
 * `editor-cli/self-host/src/main.tsx`'s own seeding code (`enterSelectMode`,
 * `seedThinkingChat`), not invented here:
 *
 * - `setNativeValue` sets through the platform's native property setter
 *   (bypassing React's internal value-tracker) then dispatches a real
 *   bubbling `input` event, so a controlled input's `onChange` fires exactly
 *   as it would for a real keystroke.
 * - `waitForElement` polls via `setTimeout` until a selector's target
 *   mounts. A fixed number of React commits can't be assumed because the
 *   step transition depends on an injected callback prop's OWN promise
 *   resolving on its own schedule (a microtask chain we don't control the
 *   exact length of), not on a render this module triggered.
 */

export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

export interface WaitForElementOptions {
  timeoutMs?: number
  intervalMs?: number
  /**
   * Stops the poll (resolving `null`) as soon as it answers true — pass the
   * fixture's unmount flag. Without it a wait that outlives its fixture
   * keeps calling `find` for up to `timeoutMs`, and in vitest's full run
   * that poll can land AFTER the test file's jsdom environment is torn
   * down, where the first `document` access inside `find` throws into an
   * unhandled rejection. Surfaced when the repo-panel drivers grew a second
   * wait per step (2026-08-29).
   */
  isCancelled?: () => boolean
}

/**
 * Poll `find` until it returns a truthy value, or give up after `timeoutMs`.
 * Returns `null` on timeout rather than throwing — callers run inside a
 * fixture's `useEffect`, where an uncaught rejection would surface as an
 * unhandled-rejection warning rather than a legible failure. A `null` result
 * is logged to the console so a stalled sequence is still visible while
 * driving the gallery manually.
 */
export async function waitForElement<T extends Element>(
  find: () => T | null,
  { timeoutMs = 2000, intervalMs = 10, isCancelled }: WaitForElementOptions = {},
): Promise<T | null> {
  // A throwing finder counts as "not found" rather than escaping as an
  // unhandled rejection. The one real thrower is a poll that outlives its
  // test file in vitest's full run — the environment's `document` is gone,
  // and several fixtures predate the `isCancelled` option, so the flag
  // alone cannot close the race. A finder that always throws still ends as
  // the logged timeout below.
  const probe = (): T | null => {
    try {
      return find()
    } catch {
      return null
    }
  }
  if (isCancelled?.()) return null
  const immediate = probe()
  if (immediate) return immediate
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    if (isCancelled?.()) return null
    const next = probe()
    if (next) return next
  }
  console.warn("[gallery] waitForElement timed out", find)
  return null
}

/**
 * Find the first element matching `selector` whose text content matches
 * `pattern` — for interactive elements with no `data-testid` (a Radix
 * `DropdownMenuItem` renders `[role="menuitem"]` on a `div`, not a
 * `<button>`, so a plain "query all buttons" helper can't find it).
 */
export function findByText<T extends Element = HTMLElement>(
  selector: string,
  pattern: RegExp,
  root: ParentNode = document,
): T | null {
  return (
    (Array.from(root.querySelectorAll<T>(selector)).find((el) =>
      pattern.test(el.textContent ?? ""),
    ) as T | undefined) ?? null
  )
}

/** Find a `<button>` by its visible text — for buttons with no `data-testid`. */
export function findButtonByText(
  pattern: RegExp,
  root: ParentNode = document,
): HTMLButtonElement | null {
  return findByText<HTMLButtonElement>("button", pattern, root)
}

/**
 * Click `el` through a full pointer-event sequence
 * (pointerdown → mousedown → pointerup → mouseup → click), not a bare
 * `el.click()`. Confirmed live against the real self-host harness
 * (`npm run gallery`) that this distinction is load-bearing: Radix's
 * `DropdownMenuTrigger` opens on `onPointerDown`, so `el.click()` — which
 * synthesizes only a `click` event, no pointer events — silently does
 * nothing to it, even in a real browser (this is NOT the jsdom-only
 * "needs real pointer-capture semantics" limitation other tests in this
 * repo work around by mocking the primitive — that one is about jsdom
 * lacking pointer-capture APIs at all; this is about which event TYPE a
 * Radix trigger actually listens for). Plain buttons and Radix `Dialog`
 * triggers respond to `click` and are unaffected by also receiving the
 * pointer events first, so this is safe to use as the one click primitive
 * every fixture reaches for, rather than reasoning per-target about which
 * primitive needs which event.
 */
export function clickLikeUser(el: Element): void {
  const rect = el.getBoundingClientRect()
  const opts: PointerEventInit & MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  }
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
}

/**
 * Fire-and-forget a driven interaction (fill inputs, click, wait for the
 * next element, click again, …) from a `useEffect`. Effects can't be async
 * themselves, so this is the one place every interaction-driven fixture
 * kicks its sequence off — named so the intent ("this runs once, its
 * completion isn't awaited by the caller") reads at every call site instead
 * of a bare `void (async () => {...})()`.
 *
 * An earlier version of this wrapped `fn` in React's own `act()` to quiet
 * the "not wrapped in act(...)" warning `registry.test.tsx` sees when a
 * fixture's deferred continuation resolves after that test's synchronous
 * render loop has moved on. That made things WORSE, not better: `act()`
 * warns itself when its callback isn't awaited, and calling it once per
 * state across a tight, un-awaited loop opens overlapping act() scopes that
 * corrupted a LATER state's render (`connect-viewer-dialog/rejected-token`
 * rendered empty — a real test failure, not just noise). The registry
 * test's OWN loop is already immune to this without any wrapper: every
 * `cleanup()` call runs synchronously before the loop's next `render()`, so
 * each state's `cancelled` flag (see each fixture's effect) flips before
 * this function's pending microtask ever gets a chance to resume. The
 * remaining source of warnings was `gallery-overlay.test.tsx`'s "wraps to
 * last state" / "switches surfaces" tests, which mount ONE state and rely
 * on the framework's automatic (delayed) `afterEach` cleanup — fixed there
 * directly with an explicit synchronous `cleanup()` call instead of here.
 */
export function runDrivenInteraction(fn: () => Promise<void>): void {
  void fn()
}

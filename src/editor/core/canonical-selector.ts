/**
 * Canonical single-token DOM selector — shared by the bridge's click-time
 * attribution extraction (`src/bridge/build-attribution-context.ts`) and the
 * design-system probe driver (`src/editor/hints/probe-driver.ts`, Phase 4
 * "rendering hints at scale").
 *
 * THE correctness crux this module exists to close: a `RenderingHint`'s
 * `domTarget.selector` is only useful if it string-matches what the bridge
 * computes for `selectorWithinMountRoot` at the moment the user clicks.
 * Before this module existed, that algorithm lived ONLY as a private
 * function inside `build-attribution-context.ts` — anything else that
 * needed to reproduce it (the probe driver, generating hints server-side)
 * would have had to hand-copy it, and a hand-copy drifts silently the next
 * time either side changes. Factoring it out here gives both call sites the
 * exact same function object.
 *
 * - The bridge imports these functions directly and calls them against real
 *   DOM `Element`s (which satisfy {@link CanonicalSelectorElement}
 *   structurally — no cast needed).
 * - The probe driver runs the algorithm INSIDE a Playwright page via
 *   `page.evaluate(string)`, which can't `import` a module. It splices
 *   `sortedClasses.toString()` + `canonicalSelectorOf.toString()` verbatim
 *   into the injected in-page script (see `buildInPageScript` in
 *   `probe-driver.ts`). Because that's the SAME function VALUE — not a
 *   hand-copied duplicate — there is nothing for the two paths to drift out
 *   of sync on; a change here propagates to both simply by re-running the
 *   probe (no separate "keep this in sync" step to remember).
 *
 * Pure and framework-neutral: the only shape required is
 * `{ tagName, classList }`, which every DOM `Element` — Vue's, React's,
 * anyone's — satisfies. Nothing here imports Vue, React, or any adapter.
 */

/**
 * Minimal duck-typed element shape this module needs. A real DOM `Element`
 * satisfies this structurally; tests can pass a stub without constructing a
 * real DOM node.
 */
export interface CanonicalSelectorElement {
  tagName: string
  classList: { length: number; item(index: number): string | null }
}

/**
 * Sorted classList tokens — stability across class-order churn (Vue
 * reactivity re-renders, HMR) and across whatever order the probe's runtime
 * DOM happens to expose them in.
 */
export function sortedClasses(el: CanonicalSelectorElement): string[] {
  const list: string[] = []
  for (let i = 0; i < el.classList.length; i++) {
    const cls = el.classList.item(i)
    if (cls === null) continue
    list.push(cls)
  }
  list.sort()
  return list
}

/**
 * Canonical single-token selector for an element, composed from:
 *   - tag name (lowercased) — always emitted unless empty
 *   - sorted classList joined with `.` — for stability across class
 *     reordering
 *
 * Does NOT decide `:root` — callers compare element identity against their
 * own mount-root reference first (`el === mountRoot ? ':root' :
 * canonicalSelectorOf(el)`), since "what counts as the root" depends on the
 * caller's context (a live Vue instance's `$el` for the bridge; the
 * isolation page's mounted component root for the probe).
 *
 * V1 does NOT emit ids, attributes, or pseudo-classes; hints are authored
 * (hand-written or probe-generated) to match this shape. If a hint needs a
 * different shape (id, attribute selector), the caller must teach this
 * function how to emit it OR the shell-side matcher must accept richer
 * hints — coordinate the two together so they stay in sync.
 */
export function canonicalSelectorOf(el: CanonicalSelectorElement): string {
  const tag = el.tagName.toLowerCase()
  const classes = sortedClasses(el)
  if (classes.length === 0) return tag
  return `${tag}.${classes.join('.')}`
}

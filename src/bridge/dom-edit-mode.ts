/**
 * Desde Bridge — DOM-edit mode
 *
 * Extracted from `comment-bridge.ts` (audit Task 22). `createDomEditMode`
 * was already dependency-injected (`inspector`, `overridePreview`); the
 * only thing it reached into the IIFE for were importable helpers
 * (`getSourceLocation`, `generateSelector`, `parseSourceTag`,
 * `fileVersionFor`, `sendToShell`) plus the framework runtime adapter,
 * which is now a third explicit parameter rather than a closed-over
 * module global.
 *
 * esbuild inlines this back into the single bridge IIFE at bundle time.
 */

import type { FrameworkRuntimeAdapter } from "./leaf-prop-attribution"
import type { InspectorOverlayManager } from "./inspector-overlay"
import type { OverridePreview } from "./override-preview"
import { sendToShell } from "./bridge-runtime"
import { resolveDomAnchor } from "./element-attribution"
import { classifyMutationScope } from "./mutation-scope"
import { generateSelector } from "./selector-engine"
import { parseSourceTag, fileVersionFor } from "./inspection-extractors"

// ── DOM-edit mode (Phase A — BRIDGE_VERSION 2026-05-07a-dom+) ─────────
//
// Designer enters DOM-edit mode → bridge enables `contentEditable` on
// text-bearing leaves with `data-desde-src`, listens for `input` events
// on those leaves only, and emits {@link BridgeMutation}s via
// `MUTATION_CAPTURED`. Per-element `input` events are critical for
// distinguishing user typing from app-driven Vue reactivity churn (a
// global `MutationObserver` would log every reactive DOM patch as a
// false-positive — codex round-2 P1 #1).
//
// v-for ambiguity (one `data-desde-src` shared across N rendered
// instances) goes through a two-phase flow: bridge fires
// `MUTATION_AWAITING_DISAMBIGUATION` and waits for the shell to call
// `resolveMutationDisambiguation` before promoting to a
// fully-formed `BridgeMutation`.
//
// V1 captures: text edits only. Attribute / class / style edits are
// gated behind `options.experimental` flags and currently disabled by
// default — V1 has no UI surface for them, and a global
// `MutationObserver` would conflate them with app-driven reactivity.
//
// Inspector coexistence: enterDomEditMode suspends the InspectorOverlayManager
// (deactivate; remember prior state) so its click-trap doesn't swallow
// the clicks the designer needs to focus contentEditable elements.
// exitDomEditMode restores the prior inspector state.
//
// Resolution policy:
//   `direct`   — edited node has its own `data-desde-src` AND only one
//                element matches that data-desde-src → MUTATION_CAPTURED.
//                Multiple candidates → AWAITING_DISAMBIGUATION.
//   `ancestor` — only an ancestor has `data-desde-src`.
//                  · `class` kind: captured (resolutionKind preserved on
//                    the payload). The shell's save dispatch routes it
//                    through the Phase G scoped-css-override applicator,
//                    which writes a `:deep()` rule into the consumer SFC.
//                  · other kinds (text/attr/style): RESOLUTION_FAILED —
//                    no source mapping exists for them.
//                Never silently retargeted (codex round-1 P1 #2).
//   `none`     — no `data-desde-src` ancestor → RESOLUTION_FAILED.

export type DomEditModeOptions = {
  experimental?: {
    /** Enable class/inline-style attribute capture (off in V1). */
    styleEdits?: boolean
    /** Enable non-class/style attribute capture (off in V1). */
    attributeEdits?: boolean
  }
}

export type BridgeMutationKind = "text" | "attr" | "class" | "style"

/**
 * Precise preview closures for an override registration (WS3, codex
 * round-11). SET_ELEMENT_TEXT can mutate a specific TEXT NODE (or an
 * internal wrapper) while the mutation pipeline anchors on the nearest
 * STAMPED ancestor for source mapping — an anchor whose textContent may
 * include sibling elements (icons, tooltips). Overrides must
 * re-assert/revert against the node that was ACTUALLY edited, never the
 * anchor, or a re-assert tick would wipe those siblings.
 */
export interface OverridePreviewOps {
  apply: () => void
  /** Restore to `value` — the chain's CURRENT revert baseline, which can
   *  rebase when a superseded dispatch lands (see overrideChains). */
  revert: (value: string) => void
  isApplied: () => boolean
}

export interface InternalBridgeMutation {
  id: string
  kind: BridgeMutationKind
  sourceLoc: string | null
  /** Live match count for `[data-desde-src="<sourceLoc>"]` at capture time —
   *  the styling lanes refuse a 0 rather than write a rule that matches
   *  nothing. Undefined when there is no anchor to count. */
  anchorMatchCount?: number
  /** Per-file source-version hash (data-desde-v) paired with `sourceLoc` at
   *  capture time — see fileVersionFor. Null when the plugin didn't stamp. */
  sourceVersion: string | null
  resolutionKind: "direct" | "ancestor" | "none"
  scope: "definition" | "callsite" | "unknown"
  callsiteLoc: string | null
  /** Per-file version (data-desde-v) of `callsiteLoc`'s FILE, captured in the
   *  same DOM snapshot. Cross-file mutations splice against the callsite
   *  file, so its version must be guarded too (codex WS1 P2). */
  callsiteVersion: string | null
  instancePath: string
  selector: string
  target?: string
  before: string
  after: string
  disambiguationChoice?: "this-instance" | "all-instances"
}

interface PendingDraft {
  draft: Omit<InternalBridgeMutation, "instancePath">
  candidates: { instancePath: string; selector: string; origin: boolean }[]
  originInstancePath: string
  /**
   * The element the mutation was captured on, plus the capture site's
   * apply/revert closures when it supplied them — carried through the pending
   * entry so `resolveDisambiguation` can hand the SAME override registration to
   * `registerMutationOverride` that the direct `emit`/`emitPinned` paths do
   * (Phase 3 live finding 2). Before this, a v-for class edit's optimistic
   * preview was never registered, so the shell's `resolveOverride(id,
   * "confirmed")` after the write was a no-op against an unknown id and the
   * inline `!important` shim outlived the edit forever — the DOM then lied about
   * what source says, and (pre-shim-immunity) cascade verification measured the
   * shim instead of the cascade.
   */
  el: Element
  previewOps?: OverridePreviewOps
}

export function createDomEditMode(
  inspector: InspectorOverlayManager,
  overridePreview: OverridePreview,
  /**
   * Live framework runtime adapter — used only by `computeCallsiteLoc`
   * (walk the component chain for the consumer's file). Passed in rather
   * than imported so this module stays framework-neutral, matching the
   * `inspector` / `overridePreview` DI already in the signature.
   */
  frameworkAdapter: FrameworkRuntimeAdapter,
): {
  enter: (opts: DomEditModeOptions) => void
  exit: () => void
  resolveDisambiguation: (pendingId: string, choice: "this-instance" | "all-instances" | "cancel") => void
  isActive: () => boolean
  /**
   * Emit a captured mutation through the DOM-edit pipeline (sourceLoc
   * resolution, v-for disambiguation, MUTATION_CAPTURED dispatch).
   * Exposed so shell-initiated DOM edits (SET_ELEMENT_TEXT,
   * SET_ELEMENT_CLASSES) can route through the same path that
   * iframe contenteditable typing uses, without requiring DOM-edit
   * mode to be `active=true` (which deactivates the inspector and
   * breaks click-to-select in unified compose mode).
   *
   * `previewOps` (optional, WS3): precise apply/revert/isApplied
   * closures for `registerMutationOverride` — same purpose as on
   * `captureDirectMutationPinned` below, threaded here too because
   * `SET_ELEMENT_CLASSES` must stay on the NON-pinned path (v-for
   * class edits need real disambiguation; the scoped-CSS save lane's
   * selector matches every sibling, so "this-instance" pinning would
   * lie about scope — see the SET_ELEMENT_CLASSES handler). Ignored
   * when the mutation resolves into the disambiguation flow
   * (candidates.length > 1) — see resolveDisambiguation's note.
   */
  captureDirectMutation: (
    el: Element,
    kind: BridgeMutationKind,
    target: string | undefined,
    before: string,
    after: string,
    previewOps?: OverridePreviewOps,
  ) => void
  /**
   * Shell-pinned variant: same pipeline as `captureDirectMutation`
   * but skips the v-for disambiguation flow. Used by shell-initiated
   * edits (SET_ELEMENT_TEXT / SET_ELEMENT_CLASSES) where the payload
   * selector already pins the row the user pointed at — sending
   * `MUTATION_AWAITING_DISAMBIGUATION` would create a pending entry
   * that the worktree-session shell has no UI to resolve and
   * `hasUnsavedChanges` ignores, leaving Save disabled despite a
   * visible preview. Stamps `disambiguationChoice: "this-instance"`
   * when the source-loc has multiple v-for candidates.
   */
  captureDirectMutationPinned: (
    el: Element,
    kind: BridgeMutationKind,
    target: string | undefined,
    before: string,
    after: string,
    previewOps?: OverridePreviewOps,
  ) => void
} {
  let active = false
  let opts: DomEditModeOptions = {}
  /** Per-element original textContent at enable time, for before/after diff. */
  const editableElements = new Set<HTMLElement>()
  const originalContentEditable = new WeakMap<HTMLElement, string | null>()
  const originalTextContent = new WeakMap<HTMLElement, string>()
  const inputHandlers = new WeakMap<HTMLElement, EventListener>()
  /** Whether the inspector was active when DOM-edit mode entered (so we restore on exit). */
  let restoreInspectorOnExit = false
  /** Style tag injected on enter; removed on exit. */
  let editableStyleEl: HTMLStyleElement | null = null
  const pendingDisambiguation = new Map<string, PendingDraft>()
  let mutationIdCounter = 0
  let pendingIdCounter = 0
  // Debounce per element — collapse rapid keystrokes into one mutation.
  const debounceTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  const DEBOUNCE_MS = 400

  function nextMutationId(): string {
    mutationIdCounter++
    return `dom-mut-${mutationIdCounter}`
  }

  function nextPendingId(): string {
    pendingIdCounter++
    return `dom-pending-${pendingIdCounter}`
  }

  function findTextLeaves(root: Element): HTMLElement[] {
    const leaves: HTMLElement[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node: Node) {
        const el = node as HTMLElement
        if (el.dataset?.prototypeFlow) return NodeFilter.FILTER_REJECT
        // Skip elements containing other elements (not leaves).
        if (el.children.length > 0) return NodeFilter.FILTER_SKIP
        if (!el.textContent || !el.textContent.trim()) return NodeFilter.FILTER_SKIP
        // V1: only direct sourceLoc resolves to a patchable edit.
        if (!el.dataset?.desdeSrc) return NodeFilter.FILTER_SKIP
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let n: Node | null = walker.nextNode()
    while (n) {
      leaves.push(n as HTMLElement)
      n = walker.nextNode()
    }
    return leaves
  }

  function enableContentEditable(): void {
    // Inject a per-session <style> tag with hover/focus affordances on
    // contentEditable elements. Cheaper than per-element inline
    // styles — Vue can't reactively stomp this. Removed on exit.
    if (!editableStyleEl) {
      editableStyleEl = document.createElement("style")
      editableStyleEl.dataset.prototypeFlow = "" // exclude from selector capture
      // NOTE: the indentation inside this template literal is load-bearing
      // for byte-identity with the pre-extraction bundle (audit Task 22's
      // token-preservation check) — it ships verbatim into the injected
      // <style> tag. Leave it alone unless the CSS itself changes.
      editableStyleEl.textContent = `
          [contenteditable="plaintext-only"]:hover {
            outline: 1.5px dashed rgba(245, 158, 11, 0.55) !important;
            outline-offset: 2px !important;
            cursor: text !important;
          }
          [contenteditable="plaintext-only"]:focus {
            outline: 2px solid rgba(245, 158, 11, 0.85) !important;
            outline-offset: 2px !important;
          }
        `
      document.head.appendChild(editableStyleEl)
    }

    const leaves = findTextLeaves(document.body)
    for (const el of leaves) {
      // Save the previous attribute value so we can restore on exit
      // (attribute may be missing, falsy, or set elsewhere).
      const prev = el.getAttribute("contenteditable")
      originalContentEditable.set(el, prev)
      // Snapshot text BEFORE Vue's next reactive patch could mutate it.
      // We diff against this baseline on input — Vue will likely re-render
      // on its own state cadence and stomp our DOM edits, but the
      // captured mutation already reached the shell before that happens.
      originalTextContent.set(el, el.textContent ?? "")
      el.setAttribute("contenteditable", "plaintext-only")

      // Attach the input handler. Capturing is fine; bubble would also
      // work since input events bubble from contentEditable elements.
      const handler: EventListener = () => onInput(el)
      el.addEventListener("input", handler)
      inputHandlers.set(el, handler)

      editableElements.add(el)
    }
  }

  function disableContentEditable(): void {
    for (const el of editableElements) {
      const prev = originalContentEditable.get(el)
      if (prev === null || prev === undefined) {
        el.removeAttribute("contenteditable")
      } else {
        el.setAttribute("contenteditable", prev)
      }
      const handler = inputHandlers.get(el)
      if (handler) {
        el.removeEventListener("input", handler)
        inputHandlers.delete(el)
      }
      originalTextContent.delete(el)
    }
    editableElements.clear()
    // Remove the affordance style tag we injected on enter.
    if (editableStyleEl && editableStyleEl.parentNode) {
      editableStyleEl.parentNode.removeChild(editableStyleEl)
      editableStyleEl = null
    }
  }

  function onInput(el: HTMLElement): void {
    if (!active) return
    const before = originalTextContent.get(el) ?? ""
    const after = el.textContent ?? ""
    if (before === after) return

    // Debounce: collapse rapid keystrokes into one mutation. We keep
    // the ORIGINAL `before` (the snapshot at enable time) so the final
    // emitted mutation reflects the full edit, not just the last
    // keystroke since the previous tick.
    const existing = debounceTimers.get(el)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      debounceTimers.delete(el)
      if (!active) return
      const finalBefore = originalTextContent.get(el) ?? ""
      const finalAfter = el.textContent ?? ""
      if (finalBefore === finalAfter) return
      emit(el, "text", undefined, finalBefore, finalAfter)
    }, DEBOUNCE_MS)
    debounceTimers.set(el, timer)
  }

  /**
   * Emit every pending debounced text edit NOW, then clear the timers.
   *
   * It used to only `clearTimeout` them, which despite the name DISCARDED the
   * edit. Typing in a contenteditable leaf and leaving DOM-edit mode inside
   * the 400 ms window left the new text on screen with no `MUTATION_CAPTURED`
   * ever sent — the preview showed a change that no source file explained and
   * that the shell had no way to save. Silent, and the faster you work the
   * more likely you hit it.
   *
   * Emits directly rather than firing the timer callbacks: those re-check
   * `active`, and the one caller (`exit`) is on its way to false.
   */
  function flushDebounced(): void {
    for (const [el, timer] of debounceTimers) {
      clearTimeout(timer)
      const before = originalTextContent.get(el) ?? ""
      const after = el.textContent ?? ""
      if (before !== after) emit(el, "text", undefined, before, after)
    }
    debounceTimers.clear()
  }

  function buildMutation(
    el: Element,
    kind: BridgeMutationKind,
    target: string | undefined,
    before: string,
    after: string,
    candidates: { instancePath: string; selector: string; origin: boolean }[],
    /** One entry per candidate, same order — see `candidateCallsites`. */
    candidateCallsiteLocs: (string | null)[],
  ): InternalBridgeMutation {
    // `sourceLoc` is read off the DOM, not off attribution. Both consumers
    // need it to BE the rendered anchor: the scoped-css lane emits it as a
    // `[data-desde-src="…"]` rule head, and the deterministic applicators splice
    // at the coordinate the stamper wrote. `getSourceLocation` used to supply
    // the ancestor branch, and it returns `authoredAt` — which prefers the
    // `data-desde-own` rescue stamp and therefore names a coordinate no element
    // carries whenever the nearest stamped ancestor is a component root.
    // MEASURED dead: `tasks/dev-server-hosts.md` § 9g.8, "shape 2".
    //
    // PRODUCER DISCIPLINE (`tasks/dev-server-hosts.md` § 9g.9): the anchor and
    // its match count come from ONE `resolveDomAnchor` call. The dead-anchor
    // guard downstream compares the count the producer attached against the
    // anchor the producer chose — it is blind to a producer that computes them
    // from different places. The direct branch used to emit the raw attribute
    // string while the count described the parsed-and-reconstructed value; the
    // two agree for a well-formed stamp, but "agree today" is not the property
    // the guard needs.
    const anchor = resolveDomAnchor(el)
    let resolutionKind: "direct" | "ancestor" | "none" = "none"
    let sourceLoc: string | null = null
    let sourceVersion: string | null = null
    if (anchor) {
      resolutionKind = anchor.resolution
      sourceLoc = `${anchor.file}:${anchor.line}:${anchor.column}`
      sourceVersion =
        anchor.resolution === "direct"
          ? ((el as HTMLElement).dataset?.desdeV ?? null)
          : (fileVersionFor(anchor.file) ?? null)
    }
    // `definition` (one authored line, N renderings) vs `callsite` (N authored
    // lines sharing a stamp) — see `mutation-scope.ts` for why the two cannot
    // be told apart by `anchorMatchCount`, and why the rule demands a 1:1
    // mapping rather than "any two differ". A non-direct resolution stays
    // `unknown` exactly as before.
    const scope: "definition" | "callsite" | "unknown" =
      resolutionKind === "direct"
        ? classifyMutationScope(candidateCallsiteLocs)
        : "unknown"

    let selector = ""
    try { selector = generateSelector(el) } catch { /* ignore */ }

    // Stable instancePath: document-order index of `el` among candidates.
    // Avoids the Vue-component-tree fragility codex flagged in round 2
    // P1 #3 (Anonymous components, HMR remounts, fragments). For unique
    // sourceLocs the index is 0 and instancePath is just "[0]"; for
    // v-for siblings each gets a stable distinct index.
    let instancePath = "[0]"
    const originIdx = candidates.findIndex((c) => c.origin)
    if (originIdx >= 0) instancePath = `[${originIdx}]`

    const callsiteLoc = computeCallsiteLoc(el, anchor?.file ?? null)
    const callsiteFile = callsiteLoc ? parseSourceTag(callsiteLoc)?.file : undefined
    return {
      id: nextMutationId(),
      kind,
      sourceLoc,
      // How many elements the emitted `[data-desde-src="…"]` rule head matches
      // right now. Only meaningful when `sourceLoc` came from the DOM anchor
      // — which, per the note above, it now always does.
      anchorMatchCount: sourceLoc ? anchor?.matchCount : undefined,
      sourceVersion,
      resolutionKind,
      scope,
      callsiteLoc,
      callsiteVersion: callsiteFile ? (fileVersionFor(callsiteFile) ?? null) : null,
      instancePath,
      selector,
      target,
      before,
      after,
    }
  }

  /**
   * Register the mutation just built as an OverrideStore entry (WS3).
   * Called from `emit`/`emitPinned` right after `buildMutation` succeeds,
   * BEFORE the corresponding `MUTATION_CAPTURED` send — the override id
   * is `mutation.id`, the same id the shell dispatches to the server, so
   * a later `RESOLVE_OVERRIDE` for that id resolves exactly this entry.
   *
   * 'text' and 'attr' kinds always register. 'class' registers ONLY when
   * the caller supplies `previewOps` (SET_ELEMENT_CLASSES — see below);
   * without precise closures a class override can't be replayed safely
   * (the chain box only holds the className string, not the inline-style
   * `!important` shim `applyClassOverride` layers on top), so a raw
   * class mutation stays fire-and-forget. 'style' previews are never
   * registered — no capture site produces them yet.
   *
   * The element reference is captured now (closure), but re-resolved by
   * selector at apply/revert time if it's since been detached (v-for
   * remount, unrelated re-render swapping the node) — same fallback
   * pattern as the shell-initiated SET_ELEMENT_TEXT handler below.
   */
  function registerMutationOverride(
    el: Element,
    mutation: InternalBridgeMutation,
    previewOps?: OverridePreviewOps,
  ): void {
    // A capture site that supplied `previewOps` for a kind we don't register
    // would leave that preview unowned once the mutation is emitted — and unlike
    // the refused-resolution paths we CAN'T just revert it, since the edit really
    // is on its way to the server and reverting would suppress a successful
    // edit's own feedback. No capture site does this today ('style' has no
    // producer, and every 'class' site passes previewOps); the warning is here so
    // a future one is loud instead of silently leaking a shim.
    if (previewOps && mutation.kind !== "text" && mutation.kind !== "attr" && mutation.kind !== "class") {
      console.warn(
        `[Desde DomEdit] previewOps supplied for an unregisterable mutation kind '${mutation.kind}' — the preview will be unowned`,
      )
    }
    if (mutation.kind === "style") return
    if (mutation.kind === "class" && !previewOps) return
    if (mutation.kind !== "text" && mutation.kind !== "attr" && mutation.kind !== "class") return
    if (previewOps) {
      // Precise closures from the capture site (SET_ELEMENT_TEXT's
      // text-node targeting, SET_ELEMENT_CLASSES' className + inline-
      // style shim targeting) — the chain machinery still applies, but
      // apply/isApplied come from the caller; revert composes the
      // caller's revert with the chain's rebasable before via the box.
      const chainKey = `${mutation.kind}|${mutation.selector}|${mutation.target ?? ""}`
      const revertTarget = overridePreview.chainRegister(chainKey, mutation.id, mutation.before, mutation.after)
      overridePreview.store.register({
        id: mutation.id,
        kind: mutation.kind,
        selector: mutation.selector,
        apply: previewOps.apply,
        revert: () => previewOps.revert(String(revertTarget.value ?? "")),
        isApplied: previewOps.isApplied,
      })
      if (mutation.kind === "class") {
        // Load-bearing beyond bookkeeping: applyClassOverride writes
        // inline `!important` declarations that outrank the freshly-
        // persisted stylesheet rule FOREVER (inline-important beats
        // stylesheet-important). Nothing else strips them on success —
        // this retire hook, fired when the LIVE chain id resolves
        // terminally (see RESOLVE_OVERRIDE), is what makes "DOM shows
        // source truth" actually true for this lane. On a failed
        // resolution `previewOps.revert` above already restored the
        // style; running clearClassOverrideFor again here is idempotent
        // (no-op once the snapshot entry is gone).
        const selector = mutation.selector
        const capturedEl = el
        const resolveEl = (): Element | null => {
          if (capturedEl.isConnected) return capturedEl
          if (!selector) return null
          try {
            return document.querySelector(selector)
          } catch {
            return null
          }
        }
        overridePreview.retireHooks.set(mutation.id, {
          kind: "classOv",
          retire: () => {
            const target = resolveEl()
            if (target) overridePreview.clearClassOverrideFor(target)
          },
        })
      }
      return
    }
    const selector = mutation.selector
    const capturedEl = el
    const resolveEl = (): Element | null => {
      if (capturedEl.isConnected) return capturedEl
      if (!selector) return null
      try {
        return document.querySelector(selector)
      } catch {
        return null
      }
    }
    // Supersede any live prior entry for this target (see overrideChains).
    const chainKey = `${mutation.kind}|${selector}|${mutation.target ?? ""}`
    const revertTarget = overridePreview.chainRegister(
      chainKey,
      mutation.id,
      mutation.before,
      mutation.after,
    )
    const after = mutation.after

    if (mutation.kind === "text") {
      overridePreview.store.register({
        id: mutation.id,
        kind: "text",
        selector,
        apply: () => {
          const target = resolveEl()
          if (target) target.textContent = after
        },
        revert: () => {
          const target = resolveEl()
          if (target) target.textContent = String(revertTarget.value ?? "")
        },
        isApplied: () => resolveEl()?.textContent === after,
      })
      return
    }

    // kind === "attr" — `target` (the captureDirectMutation param) is the
    // attribute name. `before`/`after` are non-nullable strings on
    // InternalBridgeMutation, so there's no dedicated "was absent"
    // signal; an empty `before` is treated as absent (mirrors
    // applyAttrOverride's `value === null/undefined ? "" : String(value)`
    // collapse above) — revert removes the attribute rather than
    // setting it back to "".
    const attrName = mutation.target
    if (!attrName) return
    overridePreview.store.register({
      id: mutation.id,
      kind: "attr",
      selector,
      apply: () => {
        const target = resolveEl()
        if (target) target.setAttribute(attrName, after)
      },
      revert: () => {
        const target = resolveEl()
        if (!target) return
        const value = revertTarget.value
        if (value === "" || value === undefined || value === null) {
          target.removeAttribute(attrName)
        } else {
          target.setAttribute(attrName, String(value))
        }
      },
      isApplied: () => resolveEl()?.getAttribute(attrName) === after,
    })
  }

  /** Defence-in-depth bound on the component-chain walk below. React chains
   *  through a headless library run deep — MEASURED 22 entries for one Radix
   *  Dialog close button — so the bound is set well past any real chain rather
   *  than at Vue-ish depth. */
  const MAX_CALLSITE_HOPS = 64

  /**
   * The consumer's `<Tag>` position for the component that owns `el` — the
   * place a designer would go to retype this text, as distinct from the place
   * the element's bytes live.
   *
   * Walks the component chain (NOT DOM ancestry — codex round-2 P1 #1) from
   * the owning component outward, and returns the first `getCallSiteStamp`
   * whose FILE differs from `anchorFile` (the file `sourceLoc` names).
   *
   * ── Why `getCallSiteStamp` and not `getInstanceFile` ──
   *
   * The predecessor asked `getInstanceFile` for each ancestor's DEFINITION
   * file and returned that file at `0:0`. Two problems, both MEASURED
   * 2026-08-16 (`tasks/react-hint-generation-phase0.md` § 7.7):
   *
   *   1. `getInstanceFile` returns null unconditionally on React
   *      (`comment-bridge.ts`, and deliberately — a fiber exposes the JSX
   *      callsite, never the component's definition file). So this function
   *      returned null for EVERY React mutation, on every fixture measured.
   *   2. `file:0:0` names no JSX/template node, so nothing that splices at a
   *      coordinate could ever use it — only a name-based LLM search could.
   *
   * `getCallSiteStamp` is implemented on BOTH adapters and returns a precise
   * `file:line:column` (Vue reads `vnode.props['data-desde-src']`, React reads
   * `fiber.memoizedProps['data-desde-src']`). So the answer is now usable by the
   * deterministic applicators, not just by prose in an LLM prompt.
   *
   * ── Why "first differing FILE" ──
   *
   * A component and the library internals it delegates to share the wrapper's
   * file: MEASURED on shadcn, clicking a `<Button>` gives a chain of
   * `Primitive.button` / `Button` whose stamps are all inside
   * `components/ui/button.tsx`, and the App callsite is the first entry that
   * leaves that file. Skipping same-file entries is what walks past the whole
   * delegation run in one step.
   *
   * This is a FALLBACK coordinate, never a replacement for `sourceLoc`: the
   * consumer (`edit-handler.ts`) tries the anchor first and only reaches here
   * when the applicator refused, and every applicator re-checks the captured
   * `before` text at the new position. A wrong guess therefore refuses rather
   * than editing the wrong bytes.
   */
  function computeCallsiteLoc(el: Element, anchorFile: string | null): string | null {
    if (!anchorFile) return null
    let cur: unknown = frameworkAdapter.getOwningInstance(el)
    let hops = 0
    while (cur && hops++ < MAX_CALLSITE_HOPS) {
      const stamp = frameworkAdapter.getCallSiteStamp(cur)
      const loc = stamp ? parseSourceTag(stamp) : undefined
      if (loc && loc.file !== anchorFile) {
        return `${loc.file}:${loc.line}:${loc.column}`
      }
      cur = frameworkAdapter.getParentInstance(cur)
    }
    return null
  }

  /**
   * Find all rendered DOM elements sharing the same `data-desde-src`,
   * returning them in document order. When > 1, the source location
   * is inside a v-for. The element passed as `originEl` is marked
   * `origin: true` so the shell can default to "this-instance" in the
   * disambiguation UI (codex round-1 P2 #3 — origin-candidate marker).
   */
  function findVForCandidates(
    sourceLoc: string,
    originEl: Element,
  ): {
    /** WIRE shape — this is posted to the shell verbatim. Must stay
     *  structured-cloneable, which is why the elements travel separately. */
    candidates: { instancePath: string; selector: string; origin: boolean }[]
    /** Same order as `candidates`. Bridge-internal; an Element in a
     *  postMessage payload throws DataCloneError. */
    elements: Element[]
  } {
    try {
      const escaped = sourceLoc.replace(/"/g, '\\"')
      const matches = document.querySelectorAll(`[data-desde-src="${escaped}"]`)
      const out: { instancePath: string; selector: string; origin: boolean }[] = []
      const elements: Element[] = []
      let idx = 0
      for (const m of Array.from(matches)) {
        let sel = ""
        try { sel = generateSelector(m) } catch { /* ignore */ }
        out.push({
          instancePath: `[${idx}]`,
          selector: sel,
          origin: m === originEl,
        })
        elements.push(m)
        idx++
      }
      return { candidates: out, elements }
    } catch {
      return { candidates: [], elements: [] }
    }
  }

  /**
   * Per-candidate callsites, for {@link classifyMutationScope}.
   *
   * Bounded on purpose. A large table is the common many-candidate shape and
   * every entry costs a component-chain walk, so a 200-row grid would pay 200
   * of them for an answer the first few already settle. The bound is safe in
   * the direction that matters: a sample that reaches the cap is treated as
   * NOT provably 1:1, which fails safe to `definition` — the pre-existing
   * behaviour — rather than claiming a per-item edit we cannot justify.
   */
  const MAX_SCOPE_SAMPLE = 24
  function candidateCallsites(elements: Element[]): (string | null)[] {
    if (elements.length > MAX_SCOPE_SAMPLE) return [null]
    return elements.map((candidateEl) => {
      const anchor = resolveDomAnchor(candidateEl)
      return computeCallsiteLoc(candidateEl, anchor?.file ?? null)
    })
  }

  /**
   * Report a mutation the bridge could not map to a source position AND release
   * the optimistic preview the capture site had already stamped for it.
   *
   * Both halves live here on purpose. The capture sites (`SET_ELEMENT_CLASSES`,
   * `SET_ELEMENT_TEXT`) stamp their preview BEFORE calling in — the shim is what
   * makes the edit feel instant — and this is the one terminal outcome where NO
   * mutation is ever emitted, so no `MUTATION_CAPTURED` reaches the shell, no
   * dispatch happens, and no `RESOLVE_OVERRIDE` can ever come back to retire an
   * override. Registering one would be worse than useless (nothing would ever
   * resolve it); returning without releasing leaves `applyClassOverride`'s inline
   * `!important` declaration on the element FOREVER, showing a change that exists
   * in no source file until the next reload. That is the DOM lying about source —
   * the exact failure `inline.fromPreview` and release-then-verify exist to
   * prevent. Keeping the send and the release in one function is what stops the
   * two emit paths below from drifting apart on it again.
   *
   * Revert first, THEN send: postMessage is async, so by the time any shell
   * consumer of `MUTATION_RESOLUTION_FAILED` can look, the DOM is already back to
   * its authored state. No double-revert is possible — this is the only release on
   * this path, and it runs exactly once per refused mutation.
   */
  function failResolution(
    mutation: InternalBridgeMutation,
    previewOps: OverridePreviewOps | undefined,
  ): void {
    // Detect F3/F4 isolation view (`/__compose/component/...`): edits there
    // can never resolve to a callsite because the designer is viewing a
    // packaged component mounted directly, with no consumer SFC in the tree.
    // Surface a message that explains the situation rather than the generic
    // "no source-location ancestor" error which makes it look like a bug.
    const inIsolationView =
      typeof window !== "undefined" &&
      window.location?.pathname?.startsWith("/__compose/component/")
    let reason: string
    if (inIsolationView) {
      reason =
        "Editing isn't supported in isolation view — this is a Storybook-style preview of a packaged component. To customize the appearance, exit isolation view (top toolbar) and edit a real instance in your prototype; the change will scope to that callsite via a CSS override."
    } else if (mutation.resolutionKind === "ancestor") {
      reason =
        "Edit applies to an element with no data-desde-src; the only nearby anchor is on an ancestor — cannot reliably map to source."
    } else {
      reason = "No source-location ancestor — cannot map this edit to source."
    }
    releaseUnownedPreview(previewOps, mutation.before)
    sendToShell({
      type: "MUTATION_RESOLUTION_FAILED",
      payload: {
        id: mutation.id,
        reason,
        selector: mutation.selector,
      },
    })
  }

  function emit(el: Element, kind: BridgeMutationKind, target: string | undefined, before: string, after: string, previewOps?: OverridePreviewOps): void {
    // Compute candidates (always — the origin flag depends on doc-order
    // among same-sourceLoc DOM elements). For unresolvable cases the
    // list is empty/single, and disambiguation never fires.
    const directSrc = (el as HTMLElement).dataset?.desdeSrc
    const found = directSrc ? findVForCandidates(directSrc, el) : { candidates: [], elements: [] }
    const candidates = found.candidates

    let mutation: InternalBridgeMutation
    try {
      mutation = buildMutation(
        el, kind, target, before, after, candidates, candidateCallsites(found.elements),
      )
    } catch (err) {
      console.warn("[Desde DomEdit] buildMutation failed:", err)
      // Same reasoning as failResolution: nothing was emitted, so nothing will
      // ever own the preview the capture site stamped. Release it here or it
      // outlives an edit that never happened.
      releaseUnownedPreview(previewOps, before)
      return
    }

    // Ancestor-resolution `class` mutations are eligible for the
    // scoped-css-override save lane (Phase G): the inner edited element
    // has no data-desde-src but the consumer call-site (ancestor) does, and
    // the shell can write a `:deep()` rule scoped to that call-site.
    // Capture them so the save dispatcher in useEditorEditing can pick
    // them up; the resolutionKind='ancestor' tag on the payload is what
    // routes the save off the llm-patch path. Other ancestor kinds
    // (text/attr/style) remain unmappable and still fail.
    const ancestorOverrideEligible =
      mutation.resolutionKind === "ancestor" && mutation.kind === "class"
    if (mutation.resolutionKind !== "direct" && !ancestorOverrideEligible) {
      failResolution(mutation, previewOps)
      return
    }

    // V-for disambiguation: > 1 DOM elements share this sourceLoc.
    if (candidates.length > 1) {
      const pendingId = nextPendingId()
      const { instancePath, ...draftWithoutInstance } = mutation
      pendingDisambiguation.set(pendingId, {
        draft: draftWithoutInstance,
        candidates,
        originInstancePath: instancePath,
        el,
        ...(previewOps ? { previewOps } : {}),
      })
      sendToShell({
        type: "MUTATION_AWAITING_DISAMBIGUATION",
        payload: {
          pendingId,
          draft: draftWithoutInstance,
          candidates,
        },
      })
      return
    }

    registerMutationOverride(el, mutation, previewOps)
    sendToShell({ type: "MUTATION_CAPTURED", payload: mutation })
  }

  /**
   * Shell-pinned variant of {@link emit}. Same source-resolution and
   * MUTATION_RESOLUTION_FAILED gating, but skips v-for disambiguation:
   * when `SET_ELEMENT_TEXT` / `SET_ELEMENT_CLASSES` arrives from the
   * shell, the selector in the payload already pins the row the user
   * pointed at via the inspector. The bridge's
   * MUTATION_AWAITING_DISAMBIGUATION flow exists for in-iframe
   * contentEditable typing where no shell-side row context exists —
   * for shell-initiated edits it's the wrong question, and routing
   * through it leaves the entry in `pendingDisambiguations` (which
   * `hasUnsavedChanges` ignores in worktree-session mode and the
   * Session log doesn't surface), making Save look like "No changes
   * made" while the preview is visible. Stamp `disambiguationChoice:
   * "this-instance"` so the save dispatcher knows the user meant the
   * specific row, not the template.
   */
  function emitPinned(el: Element, kind: BridgeMutationKind, target: string | undefined, before: string, after: string, previewOps?: OverridePreviewOps): void {
    const directSrc = (el as HTMLElement).dataset?.desdeSrc
    const found = directSrc ? findVForCandidates(directSrc, el) : { candidates: [], elements: [] }
    const candidates = found.candidates

    let mutation: InternalBridgeMutation
    try {
      mutation = buildMutation(
        el, kind, target, before, after, candidates, candidateCallsites(found.elements),
      )
    } catch (err) {
      console.warn("[Desde DomEdit] buildMutation failed:", err)
      releaseUnownedPreview(previewOps, before)
      return
    }

    const ancestorOverrideEligible =
      mutation.resolutionKind === "ancestor" && mutation.kind === "class"
    if (mutation.resolutionKind !== "direct" && !ancestorOverrideEligible) {
      failResolution(mutation, previewOps)
      return
    }

    if (candidates.length > 1) {
      mutation = { ...mutation, disambiguationChoice: "this-instance" }
    }
    registerMutationOverride(el, mutation, previewOps)
    sendToShell({ type: "MUTATION_CAPTURED", payload: mutation })
  }

  /**
   * Enter the in-iframe contentEditable affordance.
   *
   * Reachable only from the `ENTER_DOM_EDIT_MODE` handler, which no shell code
   * sends any more — the adapter's `enterDomEditMode` was deleted, so
   * `domEditModeActive` is never flipped true (see the note on
   * `BridgeFrameworkAdapter.exitDomEditMode`). The LIVE capture path is
   * `captureDirectMutation` / `captureDirectMutationPinned`, which deliberately
   * do not require `active`.
   *
   * It used to answer with `DOM_EDIT_MODE_ENTERED` on both branches. That
   * message was doubly dead — never emitted (this function is unreachable) and
   * never consumed (no adapter case, no listener set) — so it was removed from
   * the protocol on 2026-08-06 rather than left as a member the union claims to
   * support. A real throw here now warns locally instead of reporting to a shell
   * that isn't listening; a future re-enabler adds the ack back alongside its
   * consumer, in one piece.
   */
  function enter(passedOpts: DomEditModeOptions): void {
    if (active) return
    active = true
    opts = passedOpts ?? {}
    try {
      // Suspend the inspector so its click trap doesn't swallow the
      // designer's clicks into contentEditable elements (codex round-2
      // P1 #2). We restore on exit.
      restoreInspectorOnExit = inspector.isActive()
      if (restoreInspectorOnExit) {
        inspector.deactivate()
      }
      enableContentEditable()
    } catch (err) {
      active = false
      opts = {}
      if (restoreInspectorOnExit) {
        try { inspector.activate() } catch { /* ignore */ }
        restoreInspectorOnExit = false
      }
      console.warn("[Desde DomEdit] failed to enter DOM-edit mode:", err)
    }
  }

  function exit(): void {
    if (!active) return
    // Flush BEFORE clearing `active`: the flush emits, and everything
    // downstream of a mutation should still see an active session.
    flushDebounced()
    active = false
    disableContentEditable()
    // Same unowned-preview rule as 'cancel' (see releaseUnownedPreview): once the
    // entry is dropped the shell can no longer resolve that pendingId, so nothing
    // will ever own — or retire — the shim the capture site stamped. Dropping the
    // entries without releasing their previews would leave the DOM showing a
    // change no source file explains. Reverting first, then clearing, keeps this
    // exactly-once.
    for (const pending of pendingDisambiguation.values()) {
      releasePendingPreview(pending)
    }
    pendingDisambiguation.clear()
    opts = {}
    // Restore the inspector if it was active when we entered.
    if (restoreInspectorOnExit) {
      try { inspector.activate() } catch { /* ignore */ }
      restoreInspectorOnExit = false
    }
    sendToShell({ type: "DOM_EDIT_MODE_EXITED" })
  }

  /**
   * Release a pending draft's optimistic preview WITHOUT going through the
   * OverrideStore — used on "Discard edit", where no `MUTATION_CAPTURED` is ever
   * sent, so no shell-side `resolveOverride` can arrive to release it. Reverting
   * here is the only release on that path, and it happens exactly once (the
   * pending entry is deleted before this runs).
   *
   * Only the capture sites that supplied `previewOps` (the shell-initiated
   * `SET_ELEMENT_CLASSES` / `SET_ELEMENT_TEXT` lanes, which layer the inline
   * `!important` shim) have a preview to release; in-iframe contentEditable
   * typing has none — the typed text IS the DOM — and is left untouched, exactly
   * as before.
   */
  function releasePendingPreview(pending: PendingDraft): void {
    releaseUnownedPreview(pending.previewOps, pending.draft.before)
  }

  /**
   * Revert an optimistic preview that no OverrideStore entry will ever own.
   *
   * The single release primitive for every terminal path that ends WITHOUT
   * emitting a mutation: a discarded disambiguation ({@link
   * releasePendingPreview}), a refused resolution ({@link failResolution}), and a
   * `buildMutation` throw. On all three, no `MUTATION_CAPTURED` reaches the shell,
   * so no dispatch and no `RESOLVE_OVERRIDE` can arrive — this call is the only
   * release, and it runs exactly once per path.
   *
   * Deliberately NOT called on the paths that DO emit: reverting a preview whose
   * edit is on its way to the server would suppress a successful edit's own live
   * feedback. Registration (or, for a raw class mutation with no `previewOps`,
   * having no preview at all) owns those.
   *
   * `baseline` is the mutation's `before` — the pre-edit value the capture site
   * measured, which for these paths is also the chain's revert target, since a
   * mutation that was never emitted can never have been superseded.
   */
  function releaseUnownedPreview(
    previewOps: OverridePreviewOps | undefined,
    baseline: string,
  ): void {
    if (!previewOps) return
    try {
      previewOps.revert(baseline)
    } catch (err) {
      console.warn("[Desde DomEdit] releasing an unowned preview failed:", err)
    }
  }

  function resolveDisambiguation(pendingId: string, choice: "this-instance" | "all-instances" | "cancel"): void {
    const pending = pendingDisambiguation.get(pendingId)
    if (!pending) return
    pendingDisambiguation.delete(pendingId)
    if (choice === "cancel") {
      // Nothing will be written and the shell will never see this draft again,
      // so the preview must come off HERE or it outlives the discarded edit.
      releasePendingPreview(pending)
      return
    }
    const mutation: InternalBridgeMutation = {
      ...pending.draft,
      instancePath: pending.originInstancePath,
      disambiguationChoice: choice,
    }
    // Register the override, exactly as the direct emit()/emitPinned() paths do
    // (Phase 3 live finding 2). This path used to skip registration on the
    // grounds that "all-instances" has no single element to close over — but the
    // PREVIEW does: it was stamped on the one element the user edited, which the
    // pending entry now carries. Without a registration the shell's
    // `resolveOverride(mutation.id, "confirmed")` after the write resolved an id
    // the bridge had never heard of, so the `classOv` retire hook never ran and
    // the inline `!important` shim stayed on that row indefinitely.
    //
    // Exactly one resolution per path: 'cancel' reverts above and never emits;
    // this branch registers and emits, and the shell's dispatch lane resolves
    // that id once (confirmed / failed / threw).
    registerMutationOverride(pending.el, mutation, pending.previewOps)
    sendToShell({ type: "MUTATION_CAPTURED", payload: mutation })
  }

  return {
    enter,
    exit,
    resolveDisambiguation,
    isActive: () => active,
    captureDirectMutation: emit,
    captureDirectMutationPinned: emitPinned,
  }
}

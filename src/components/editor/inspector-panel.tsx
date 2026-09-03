"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import type { ComponentManifest, Selection } from "@/editor/core"
import type { EditableTextField } from "@/types/bridge"
import type { TextBranch } from "@/editor/edit-service/detect-text-branches"
import { MoreVertical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { StatusDot } from "@/components/blocks"
import { cn } from "@/lib/utils"
import { editorFetch } from "@/lib/editor-fetch"
import { useEditorStore } from "@/stores/editor-only"
import { PropControl, type PropControlValue } from "./prop-control"
import { SectionHeader, fieldLabelClass, fieldRowClass, fieldValueClass, panelTitleClass, sectionDividerClass, stackedLabelClass } from "./section-header"
import { SpacingSection, SPACING_PROVENANCE_PROPERTIES } from "./spacing-section"
import { AlignSizeSection } from "./align-size-section"
import { ColorSection, COLOR_PROVENANCE_PROPERTIES } from "./color-section"
import { BorderSection, BORDER_PROVENANCE_PROPERTIES } from "./border-section"
import {
  TypographySection,
  TYPOGRAPHY_PROVENANCE_PROPERTIES,
} from "./typography-section"
import { ShadowSection, SHADOW_PROVENANCE_PROPERTIES } from "./shadow-section"
import {
  applyScopedChange,
  composeVariant,
  presentVariants,
  STATES,
  stripVariant,
  type ActiveBreakpoint,
  type ActiveState,
  type VariantState,
} from "./tailwind-classes"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  useIframeStyleProvenance,
  type StyleProvenanceMap,
} from "@/hooks/useIframeStyleProvenance"
import {
  needsScopeDialog,
  availableScopes,
  excludePreviewInline,
  singleScopeWarning,
  type StyleScope,
} from "./style-scope-decision"
import { resolveTokenScopeFile } from "./resolve-token-source-file"
import { freshComputedStyles } from "./fresh-computed-styles"
import {
  EDITOR_ELEMENT_SCOPE_OUTRANKED,
  EDITOR_FRAMEWORK,
  EDITOR_REPO_ROOT,
  EDITOR_REPO_ROOT_REAL,
} from "@/lib/editor-feature-flags"
import { StyleScopeDialog } from "./style-scope-dialog"
import type { StyleOrigin } from "@/types/bridge"
import { IconPickerSection } from "./icon-picker-section"
import { useIconSets } from "@/hooks/useIconSets"
import { findIconByTag } from "@/editor/icon-sets/find-icon"
import type { IconManifest } from "@/editor/core"

/** Union of CSS properties the style sections need provenance for. */
const ALL_PROVENANCE_PROPERTIES = [
  ...SPACING_PROVENANCE_PROPERTIES,
  ...COLOR_PROVENANCE_PROPERTIES,
  ...BORDER_PROVENANCE_PROPERTIES,
  ...TYPOGRAPHY_PROVENANCE_PROPERTIES,
  ...SHADOW_PROVENANCE_PROPERTIES,
]

/** Stable empty map so "no provenance" renders don't churn child props. */
const EMPTY_ORIGINS: StyleProvenanceMap = {}

/**
 * Offsets (ms) at which provenance is re-read after a live-preview override
 * reaches a terminal state (`previewSettleNonce`).
 *
 * `0` is the one that matters for correctness: the bridge reverts/releases the
 * shim synchronously inside the same message it resolved on, and postMessage is
 * FIFO, so the next provenance request is guaranteed to be processed against the
 * settled DOM. The later offsets cover the confirmed-write case, where the shim
 * comes off as soon as the write lands but the value from SOURCE only appears
 * once HMR re-renders — a lane that runs no verification has nothing else to
 * wait on.
 *
 * The whole schedule is PER SETTLE EVENT (L2), and it starts AT the event, so it
 * only ever has to outlast HMR — machine time. The old shim poll started at edit
 * time and had to outlast the user reading a dialog, which is what made L1
 * possible; no wall-clock budget can be both instant and longer than a person.
 */
const SETTLE_REREAD_DELAYS_MS = [0, 250, 600, 1200, 2400] as const

interface InspectorPanelProps {
  selection: Selection | null
  manifest: ComponentManifest | null
  /**
   * Active responsive breakpoint, owned by the editor chrome's global
   * viewport control. The style sections read & write classes for this
   * breakpoint (composed with the inspector-local state axis). Defaults to
   * `"base"`.
   */
  activeBreakpoint?: ActiveBreakpoint
  /**
   * Prototype iframe — drives the on-demand style-provenance round-trip
   * (Layer 2). Optional: when absent the style "From:" rows just don't render.
   */
  iframeRef?: React.RefObject<HTMLIFrameElement | null>
  /**
   * V1.3+ — when provided, prop controls become interactive and dispatch
   * `PropEdit` through this callback. The caller is expected to translate
   * `(propName, value)` into a `StructuralEdit` and call the framework
   * adapter's `applyEdit`.
   */
  onPropEdit?: (propName: string, value: PropControlValue) => void
  /**
   * V1.4+ — when provided, the Identity section shows a "Detach" action
   * for prototype-authored components (those with a `componentFile` not
   * under `node_modules`). Caller dispatches `DetachEdit` via the adapter.
   */
  onDetach?: () => void
  /**
   * Phase F2 — when provided, the Identity section shows a "Swap" action
   * (visible for any component with a known editTarget). Opens the
   * SwapDialog; caller dispatches `SwapEdit` via the adapter.
   */
  onSwap?: () => void
  /**
   * Phase F4 — when provided, the Identity section shows an "Edit
   * component" action that navigates the iframe to the F3 isolation
   * route. Visible for first-party components (componentFile in user
   * tree). Library components (node_modules) can't be edited there
   * because the user can't write to that location.
   */
  onEditComponent?: () => void
  /**
   * V1.5+ — when provided, the DOM section renders one labeled input per
   * entry in `selection.editableTexts`. Each edit is routed by the
   * field's `kind`: `prop` flows through the deterministic `PropEdit`
   * pipeline (rewrites the SFC attribute via `apply-prop-edit.ts`);
   * `dom-text` flows through `SET_ELEMENT_TEXT` + mutation capture (the
   * legacy text-edit path for plain DOM text leaves).
   */
  onEditTextField?: (field: EditableTextField, value: string) => void
  /**
   * V1.5+ — when provided, the DOM section shows an editable class-list
   * input. Edits flow through SET_ELEMENT_CLASSES.
   */
  onClassesEdit?: (classes: string[]) => void
  /**
   * Phase 3 (style provenance) — when provided, the scope dialog can offer
   * "This page": apply a style edit as a scoped-css-override (a `<style scoped>`
   * rule) rather than a class on the consumer. Receives the full next class list.
   */
  onScopedStyleEdit?: (nextClasses: string[]) => void
  /**
   * §6 Phase 3 (style provenance) — when provided, the scope dialog can offer
   * "The token": patch the design token's value at its definition (so every
   * consumer updates) instead of overriding on the element. Receives the edited
   * CSS property, its provenance (the var chain root is the token to patch), and
   * the full next class list (its resolved value for `property` becomes the new
   * token value).
   */
  onTokenStyleEdit?: (
    property: string,
    origin: StyleOrigin,
    nextClasses: string[],
  ) => void
  /**
   * When provided, conditional-text detection is enabled: if the
   * selection's editTarget maps to an element whose only child is a
   * `{{ test ? a : b }}` interpolation, the inspector shows one editable
   * field per branch. Each commit dispatches a `TextBranchEdit` via this
   * callback. Detection happens server-side via /api/editor/text-branches.
   */
  onEditTextBranch?: (branch: TextBranch, newValue: string) => void
  /**
   * When provided AND the selection's tag matches an icon from a
   * registered icon set, the inspector renders the icon picker. Each
   * pick fires this callback; caller dispatches a swap edit via the
   * `apply-icon-swap` orchestrator.
   *
   * The optional `override` resolves the icon-component identity
   * when the bridge selection landed on a child element of the icon
   * (e.g. an SVG `<path>` inside the package icons). The inspector walks
   * `selection.ancestry` to find the enclosing icon and passes that
   * ancestor's componentName + selector so the swap targets the
   * actual icon's source position, not the clicked-child position.
   */
  onPickIcon?: (
    sourceId: string,
    icon: IconManifest,
    override?: { fromComponentName?: string; bridgeSelector?: string },
  ) => void
}

/**
 * Right-rail inspector for editor. Renders the Identity section
 * (component name, source, ancestry) and the Variants & Props section
 * driven by the selected component's `ComponentManifest`.
 *
 * Interactive when `onPropEdit` is provided (V1.3+, live mode). Read-only
 * otherwise (dev picker).
 *
 * The component is independent of the framework adapter — it consumes
 * the normalized `Selection` and `ComponentManifest` shapes directly.
 * Callers wire it to whichever adapter pair is active for the current
 * prototype.
 */
function InspectorPanelImpl({
  selection,
  manifest,
  activeBreakpoint = "base",
  iframeRef,
  onPropEdit,
  onDetach,
  onSwap,
  onEditComponent,
  onEditTextField,
  onClassesEdit,
  onScopedStyleEdit,
  onTokenStyleEdit,
  onEditTextBranch,
  onPickIcon,
}: InspectorPanelProps) {
  const { sets: iconSets } = useIconSets()
  // Icon detection looks at the direct selection's componentName first,
  // then falls back to ancestry. Without the fallback, clicking an SVG
  // child of an icon (`<path>` inside the package icons) sets
  // selectedAsElement=true and strips componentName — so picker never
  // surfaces despite the user clearly clicking an icon.
  const iconSelectionTag = !onPickIcon
    ? null
    : selection?.componentName ??
      selection?.ancestry?.find(
        (a) => !!findIconByTag({ tag: a.componentName, sets: iconSets }),
      )?.componentName ??
      null
  const iconMatch =
    onPickIcon && iconSelectionTag
      ? findIconByTag({ tag: iconSelectionTag, sets: iconSets })
      : null

  // Style provenance (Layer 2): fetch on-demand when the selection changes,
  // keyed by selector, so each style row can show an honest "From:" origin.
  // On-demand (not via ELEMENT_INSPECTED) to avoid bloating every inspection.
  // Result is tagged with the selector it was fetched for, so a stale fetch
  // for a previous selection never leaks into the current rows.
  const fallbackRef = useRef<HTMLIFrameElement | null>(null)
  const fetchProvenance = useIframeStyleProvenance(iframeRef ?? fallbackRef)
  const [fetched, setFetched] = useState<{
    selector: string
    map: StyleProvenanceMap
  } | null>(null)
  const selector = selection?.selector ?? null
  // `editNonce` bumps whenever a style edit dispatches FROM this panel. The
  // inspector's class/color edits mutate the live DOM (SET_ELEMENT_CLASSES,
  // inline `!important` preview) WITHOUT republishing `ELEMENT_INSPECTED`, so
  // `selection` is unchanged after them — a selection-derived key would never
  // re-trigger. The nonce does, so the "From:" row refreshes (and honestly
  // reports the inline override the preview just applied) instead of going
  // stale until reselect. `selection` identity covers external re-inspection +
  // selecting a different node.
  const [editNonce, setEditNonce] = useState(0)
  useEffect(() => {
    if (!selector) return
    const ctrl = new AbortController()
    void fetchProvenance(selector, ALL_PROVENANCE_PROPERTIES, ctrl.signal).then(
      (result) => {
        if (!ctrl.signal.aborted) setFetched({ selector, map: result })
      },
    )
    return () => ctrl.abort()
    // selection identity + editNonce are the invalidation triggers.
  }, [selection, editNonce, selector, fetchProvenance])
  // The class edit below stamps its resolved declarations into the element's
  // inline style with `!important` (bridge `applyClassOverride`), and the
  // `editNonce` re-fetch above then honestly reports our own shim — so the
  // pre-flight scope gate must discount it or every repeat edit of the same
  // property looks like it is fighting an `!important` incumbent.
  //
  // No panel-side bookkeeping is needed for that any more: the bridge marks its
  // own stamps per property (`StyleOrigin.inline.fromPreview`), and
  // `excludePreviewInline` reads that flag directly (cascade follow-ups Phase 2).
  // The previous approximation — a set of previously-previewed property NAMES —
  // also discounted an author's own inline `!important` on such a property, so
  // the gate went silent exactly where it should have warned.
  //
  // `bumpEditNonce` is the shared trigger: EVERY scope lane must invalidate, not
  // just the element one. The token and page lanes bypassed
  // `onClassesEditTracked` entirely, so a "The token" edit left both the "From:"
  // row and the style sections reading pre-edit provenance forever (part of F8).
  const bumpEditNonce = useCallback(() => setEditNonce((n) => n + 1), [])
  const onClassesEditTracked = useCallback(
    (next: string[]) => {
      onClassesEdit?.(next)
      // Re-fetch provenance after the live-DOM mutation lands (the bridge
      // processes SET_ELEMENT_CLASSES before this fetch's round-trip).
      bumpEditNonce()
    },
    [onClassesEdit, bumpEditNonce],
  )
  // Inspector-local STATE axis (hover/focus/dark). Composes with the global
  // breakpoint into the active variant context. Resets to "default" when the
  // selected element changes.
  const [activeState, setActiveState] = useState<ActiveState>("default")
  useEffect(() => {
    setActiveState("default")
  }, [selection?.targetId])
  const origins: StyleProvenanceMap =
    fetched && fetched.selector === selector ? fetched.map : EMPTY_ORIGINS
  // Flat list for the panel-level provenance notice (N4). Every origin carries
  // its own `property`, so the notice needs no key mapping.

  // ── F8: keep the style sections reading the element's CURRENT values ──
  //
  // `selection.computedStyles` is an ELEMENT_INSPECTED snapshot and nothing
  // republishes it after an edit (there is no re-inspection message in the
  // protocol), so every section fed from it — most visibly the colour swatch and
  // its token/class label — rendered the PRE-EDIT value for the rest of the
  // selection's life. Provenance is the thing the panel already re-fetches, and
  // each origin carries a fresh `computedValue`, so overlay those.
  const computedStyles = useMemo(
    () => freshComputedStyles(selection?.computedStyles, origins),
    [selection?.computedStyles, origins],
  )
  // Trigger 1 — a live-preview override reached a terminal state (L1/L2).
  //
  // The read taken right after an edit is real-on-screen but PROVISIONAL: it
  // reports editor's own inline `!important` shim. The shim's removal is an
  // EVENT the shell itself performs — `resolveOverride(confirmed|failed|
  // ineffective)`, the bridge's own revert, or "Discard edit" on the v-for
  // dialog — and `previewSettleNonce` is that event. Refreshing on it replaces
  // the previous cut's poll-until-`inline.fromPreview`-clears, whose fixed
  // 8 × 250 ms budget was consumed by the user reading the dialog: the last read
  // was then the shim's, nothing re-read after Discard, and the swatch named a
  // colour that existed nowhere — permanently, since the budget also reset only
  // per SELECTION, so the next edit on the same element got zero re-reads and
  // re-clicking it re-inspects nothing (the bridge no-ops a click on the
  // already-selected element).
  const previewSettleNonce = useEditorStore((s) => s.previewSettleNonce)
  useEffect(() => {
    if (previewSettleNonce === 0) return
    const timers = SETTLE_REREAD_DELAYS_MS.map((delay) =>
      setTimeout(bumpEditNonce, delay),
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [previewSettleNonce, bumpEditNonce])
  // Trigger 2 — a verification settled. The token lane registers no preview
  // override at all (`handleTokenStyleEdit` never calls `setElementClasses`), so
  // its new value only exists after the file write plus HMR and there is no shim
  // for trigger 1 to watch. The verifier already waits out exactly that window
  // (`confirmStableMs` > HMR), so its completion is the honest "source settled"
  // event — cheaper and more accurate than the panel timing HMR itself.
  const settledVerifications = useEditorStore(
    (s) => s.verifications.filter((v) => v.phase === "done").length,
  )
  useEffect(() => {
    if (settledVerifications === 0) return
    bumpEditNonce()
  }, [settledVerifications, bumpEditNonce])

  // Phase 2 — provenance-gated scope dialog. A style edit applies directly
  // unless provenance flags it as scope-ambiguous (token-driven / inherited /
  // library-rendered), in which case we prompt for WHERE to apply it. The
  // remembered scope (session) short-circuits repeats.
  const [scopePrompt, setScopePrompt] = useState<{
    property: string
    origin: StyleOrigin
    nextClasses: string[]
  } | null>(null)
  const rememberedScopeRef = useRef<StyleScope | null>(null)
  // Always-current refs for the awaited gate: `targetId` is the STABLE element
  // identity (a real target switch aborts the in-flight edit); `selector` is
  // the bridge's CSS query path, which the SAME element can get re-issued on
  // re-inspection (so a mid-fetch selector change → the result is stale, retry
  // against the new selector rather than cancel or trust stale provenance).
  // Sections call this with the CSS property they edit + a thunk that applies
  // the edit directly. The gate is SYNCHRONOUS — it decides only from provenance
  // already loaded for the current selection (`origins` is non-empty only when
  // it matches the live selector). Deliberately not async: an on-demand fetch
  // (for the rare case of editing FASTER than the ~ms provenance round-trip
  // after selecting) introduced stale-selection / wrong-target races not worth
  // the narrow benefit. Documented degradation: if provenance hasn't arrived,
  // the edit applies directly (the historical behavior — correct, just no scope
  // prompt for that first fast edit). The gate is a UX enhancement, not a safety
  // gate.
  // "This page" is offered only for the DIRECT case (the styled element is
  // authored in the current page). A reused-component element's `authoredAt`
  // points into the component's own file, where a scoped-override would leak
  // across instances — disable it there (handleScopedStyleEdit also refuses).
  // "This page" v1 is offered only when the override target is confidently a
  // single instance authored in the current page: not a cross-file reused
  // component, and not iterated (a v-for row inside a reused child component
  // passes the file check yet still leaks across pages — can't be distinguished
  // from a same-page v-for here, so refuse conservatively). Mirrors the handler.
  // …and only when the rule would actually SELECT something: the override is
  // a `[data-desde-src="…"]` rule anchored on `domAnchor`, so without a live
  // anchor the choice is a dead end. Offering it anyway is how § 9g.8's
  // silent failure reached a designer — pick "This page", watch nothing
  // change. `matchCount === 0` is refused by the builder either way; this
  // stops the dialog from proposing it in the first place.
  //
  // The `authoredAt` / reused-component / iterated conditions are about where
  // the rule LANDS, and they only describe a hazard when the destination is
  // derived from the selection — i.e. a Vue SFC's own `<style scoped>` block.
  // On a substrate whose rule goes into a project stylesheet those three are
  // not merely unnecessary, they are actively wrong: an element inside a
  // component you don't own has NO `authoredAt` (MEASURED on MUI —
  // `tasks/dev-server-hosts.md` § 9g.2), which is precisely the case the lane
  // exists for. What both substrates need is the same one thing: a live
  // anchor. Mirrors `buildPageScopedCssOverrideEdit`.
  const canScopeToPage =
    !!onScopedStyleEdit &&
    !!selection?.domAnchor &&
    selection.domAnchor.matchCount > 0 &&
    (EDITOR_FRAMEWORK === "react" ||
      (!!selection.authoredAt &&
        (!selection.editTarget ||
          selection.editTarget.file === selection.authoredAt.file) &&
        !selection.iterationContext))
  // Which scopes are actually WIRED for this origin (a subset of
  // `availableScopes`). "element" always; "page" when the rule would select
  // something live (and, on Vue, when the override target is a confident
  // single same-page instance — see `canScopeToPage`); "token" only when a
  // handler exists AND the value is
  // token-backed AND its root definition resolves to a writable first-party
  // `.css` (a token defined in an SFC `<style>` block is offered by
  // availableScopes — first-party — but the `.css`-only token lane can't patch
  // it, so don't enable a dead-end choice). "token" and "component" are
  // framework-neutral CSS-file edits, so they flow through on React too when
  // first-party. Shared by the remembered-scope short-circuit and the dialog
  // so the two can't disagree.
  const computeEnabledScopes = useCallback(
    (origin: StyleOrigin): StyleScope[] => {
      const offered = availableScopes(origin, {
        framework: EDITOR_FRAMEWORK,
        // Not gated here on whether a destination stylesheet resolved: that
        // needs a bridge round trip, and this runs synchronously per render.
        // The builder refuses with a specific, actionable message ("create a
        // CSS file and import it") when there is genuinely nowhere to write.
        // An explained refusal beats an affordance that silently isn't there.
        elementScopeOutranked: EDITOR_ELEMENT_SCOPE_OUTRANKED,
      })
      const enabled: StyleScope[] = ["element"]
      if (canScopeToPage && offered.includes("page")) enabled.push("page")
      if (onTokenStyleEdit && offered.includes("token")) {
        // No basePath here — this is only a resolvability check (does it map to
        // a first-party .css at all). The actual edit path strips the base.
        // `repoRoot` IS needed: on a Vite dev substrate the token's stylesheet is
        // an injected `<style>` whose source is an absolute path in
        // `sourceHint`, so without the root nothing resolves and this scope
        // would stay dead exactly where it is most useful.
        if (
          resolveTokenScopeFile(origin, {
            repoRoot: EDITOR_REPO_ROOT,
            repoRootReal: EDITOR_REPO_ROOT_REAL,
          }) !== null
        ) {
          enabled.push("token")
        }
      }
      return enabled
    },
    [canScopeToPage, onTokenStyleEdit],
  )
  // Apply a settled scope choice for a given next-class-list. `ctx` carries the
  // edited property + its provenance — required only for the "token" scope (the
  // token to patch + the value to resolve); "element"/"page" ignore it.
  const applyScope = useCallback(
    (
      scope: StyleScope,
      nextClasses: string[],
      ctx?: { property: string; origin: StyleOrigin },
    ) => {
      if (scope === "page" && canScopeToPage && onScopedStyleEdit) {
        onScopedStyleEdit(nextClasses)
        // These two lanes bypass `onClassesEditTracked`, so they must invalidate
        // provenance themselves or the panel keeps showing pre-edit values (F8).
        bumpEditNonce()
      } else if (scope === "token" && onTokenStyleEdit && ctx) {
        onTokenStyleEdit(ctx.property, ctx.origin, nextClasses)
        bumpEditNonce()
      } else {
        // "element" (and any not-yet-wired/ineligible scope as a safe fallback)
        // → splice the class onto the consumer, the historical direct path.
        onClassesEditTracked(nextClasses)
      }
    },
    [
      canScopeToPage,
      onScopedStyleEdit,
      onTokenStyleEdit,
      onClassesEditTracked,
      bumpEditNonce,
    ],
  )
  const gateStyleEdit = useCallback(
    (property: string, nextClasses: string[]) => {
      // Strip our own live-preview inline declaration before ANY decision is
      // derived from provenance (final-review I5, residual-review R1, cascade
      // follow-ups Phase 2). `excludePreviewInline` drops it only when the bridge
      // marked it `fromPreview` — an author-written inline style, `!important` or
      // not, still triggers the gate.
      const rawOrigin = origins[property]
      const origin = rawOrigin ? excludePreviewInline(rawOrigin) : rawOrigin
      // No provenance (yet / at all) or an unambiguous plain consumer value → apply.
      // ACCEPTED LIMITATION: if the user edits an ambiguous style WITHIN the
      // sub-ms window before the on-select provenance fetch completes, this
      // applies directly and skips the prompt (e.g. a `(none)` on a library
      // element could no-op once). Not human-reachable — the fetch starts on
      // selection-render and finishes in ms, while select→edit involves a
      // mouse move + click (>>100ms). Chosen over an async gate, which traded
      // this for stale-selection / wrong-target races (worse). See spec.
      if (!origin || !needsScopeDialog(origin)) {
        applyScope("element", nextClasses)
        return
      }
      // Ambiguous origin with only one place to put the edit: a one-option
      // dialog is noise, so apply — and warn ONLY if a reason describes a way
      // the edit can fail to take effect. Dialog-worthy is not warning-worthy
      // (`singleScopeWarning`): "no rule declares this property" is a fine
      // reason to ask WHERE, and a false alarm as a might-not-work warning —
      // it fired on four consecutive working edits in the live run. Null =
      // the edit will simply land; say nothing.
      const enabledForOrigin = computeEnabledScopes(origin)
      if (enabledForOrigin.length === 1) {
        const warning = singleScopeWarning(origin, enabledForOrigin, {
          elementScopeOutranked: EDITOR_ELEMENT_SCOPE_OUTRANKED,
        })
        if (warning) toast.warning("This may not take effect", { description: warning })
        applyScope("element", nextClasses)
        return
      }
      // Remembered scope this session → apply without re-prompting, BUT only if
      // it's still applicable to THIS origin. A remembered "token" must not be
      // forced onto a later edit whose value isn't token-backed (no varChain) —
      // that would dead-end in handleTokenStyleEdit's "not a design token"
      // refusal. Fall back to "element" when the remembered scope no longer fits.
      if (rememberedScopeRef.current) {
        const enabled = computeEnabledScopes(origin)
        const scope = enabled.includes(rememberedScopeRef.current)
          ? rememberedScopeRef.current
          : "element"
        applyScope(scope, nextClasses, { property, origin })
        return
      }
      setScopePrompt({ property, origin, nextClasses })
    },
    [origins, applyScope, computeEnabledScopes],
  )

  // ── Variant axis wiring ──────────────────────────────────────────
  // The structured sections are variant-agnostic: they receive the active
  // context's classes (prefix stripped) and emit the next scoped list. We
  // diff that against the scoped-before within `applyScopedChange` and
  // splice only the delta (re-prefixed) onto the full list — so base and
  // sibling variants keep their position.
  const variant = composeVariant(activeBreakpoint, activeState)
  const isBase = variant === ""
  const fullClasses = selection?.classes ?? []
  const classesKey = fullClasses.join(" ")
  const scopedClasses = useMemo(
    () => stripVariant(fullClasses, variant),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classesKey, variant],
  )
  const present = useMemo(
    () => presentVariants(fullClasses),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [classesKey],
  )
  // Element-scope writer for the active context (used everywhere off-base,
  // and as the "element" sink the gate falls through to on-base).
  const handleScopedClassesChange = useCallback(
    (scopedNext: string[]) => {
      onClassesEditTracked(
        applyScopedChange(fullClasses, variant, scopedClasses, scopedNext),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onClassesEditTracked, classesKey, variant],
  )
  // Base-only: route through the provenance scope gate. Provenance is keyed
  // off live (base) computed style, so it can't speak to a specific variant
  // — non-base edits bypass the gate and apply at element scope.
  const handleScopedScopedEdit = useCallback(
    (property: string, scopedNext: string[]) => {
      gateStyleEdit(
        property,
        applyScopedChange(fullClasses, variant, scopedClasses, scopedNext),
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateStyleEdit, classesKey, variant],
  )
  // Props common to every structured style section. `computedStyles` is the
  // provenance-refreshed map (F8), not the inspection-time snapshot.
  const sectionProps = {
    classes: scopedClasses,
    computedStyles: isBase ? computedStyles : undefined,
    onScopedEdit: isBase ? handleScopedScopedEdit : undefined,
    onClassesChange: handleScopedClassesChange,
  }

  if (!selection && !manifest) {
    return (
      <aside
        aria-label="Editor inspector"
        className="flex h-full w-full min-w-0 flex-col items-center justify-center bg-background p-6 text-center text-base text-muted-foreground"
      >
        Select a component in the prototype to inspect it.
      </aside>
    )
  }

  return (
    <>
    <aside
      aria-label="Editor inspector"
      className="flex h-full w-full min-w-0 flex-col"
    >
      <ScrollArea className="flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        {/*
            Every direct child of this stack pads itself with `px-3`, and the
            `<Separator />`s deliberately do not — that is what lets a rule run
            border to border while the content it divides stays inset. The rail
            itself has no horizontal padding, so a child that forgets renders
            flush against the border. Three have, one at a time.
          */}
          <div className="space-y-4 py-4">
          <IdentitySection
            selection={selection}
            manifest={manifest}
            onDetach={onDetach}
            onSwap={onSwap}
            onEditComponent={onEditComponent}
          />
          {iconMatch && onPickIcon ? (
            <>
              <Separator className={sectionDividerClass} />
              <IconPickerSection
                key={`icon-${selection?.targetId ?? "no-target"}`}
                iconSets={iconSets}
                selectionTag={iconSelectionTag}
                onPickIcon={(sourceId, icon) => {
                  // When ancestry resolved the icon (user clicked an
                  // SVG child), hint the dispatcher: use the icon
                  // component's name + the icon's root selector so
                  // the swap targets the icon source, and the live
                  // bridge preview lands on the icon wrapper instead
                  // of the inner path.
                  const usedAncestry =
                    selection?.selectedAsElement === true &&
                    iconSelectionTag !== selection?.componentName
                  const ancestor = usedAncestry
                    ? selection?.ancestry?.find(
                        (a) => a.componentName === iconSelectionTag,
                      )
                    : undefined
                  onPickIcon(sourceId, icon, {
                    fromComponentName: iconSelectionTag ?? undefined,
                    bridgeSelector: ancestor?.targetId,
                  })
                }}
              />
            </>
          ) : null}
          {manifest ? (
            <>
              <Separator className={sectionDividerClass} />
              {/*
                Key by the active target id so per-control local state
                (`useState` initial values inside PropControl) resets when the
                designer selects a different instance — even when the manifest
                is identical. Without this, switching between two UiButtons
                shows the previous instance's edited value and could dispatch
                a stale next value.
              */}
              <VariantsAndPropsSection
                key={selection?.targetId ?? "no-target"}
                manifest={manifest}
                currentProps={selection?.currentProps}
                onPropEdit={onPropEdit}
              />
            </>
          ) : selection?.currentProps &&
            Object.keys(selection.currentProps).length > 0 ? (
            <>
              <Separator className={sectionDividerClass} />
              <CurrentPropsSection
                key={`props-${selection.targetId}`}
                currentProps={selection.currentProps}
                onPropEdit={onPropEdit}
              />
            </>
          ) : null}
          {selection && onClassesEdit ? (
            <>
              <Separator className={sectionDividerClass} />
              <StyleContextBar
                activeBreakpoint={activeBreakpoint}
                activeState={activeState}
                onStateChange={setActiveState}
                presentStates={present.states}
              />
              <Separator className={sectionDividerClass} />
              <SpacingSection
                key={`spacing-${selection.targetId}`}
                {...sectionProps}
              />
              <Separator className={sectionDividerClass} />
              <AlignSizeSection
                key={`align-${selection.targetId}`}
                classes={sectionProps.classes}
                // Unlike the value-inferring sections, this one reads
                // `computedStyles` ONLY for the structural flex/grid gate
                // (whether to show the align grid) — never as a value
                // fallback — so it's safe (and necessary) to pass the real
                // computed styles even off-base, or the align controls would
                // vanish for variant contexts. Uses the provenance-refreshed map
                // for the same reason the sections do (F8) — it differs from the
                // snapshot only where a fresh read actually answered.
                computedStyles={computedStyles}
                onClassesChange={sectionProps.onClassesChange}
              />
              <Separator className={sectionDividerClass} />
              <ColorSection
                key={`color-${selection.targetId}`}
                {...sectionProps}
              />
              <Separator className={sectionDividerClass} />
              <BorderSection
                key={`border-${selection.targetId}`}
                {...sectionProps}
              />
              <Separator className={sectionDividerClass} />
              <TypographySection
                key={`typography-${selection.targetId}`}
                {...sectionProps}
              />
              <Separator className={sectionDividerClass} />
              <ShadowSection
                key={`shadow-${selection.targetId}`}
                {...sectionProps}
              />
            </>
          ) : null}
          {selection ? (
            <>
              <Separator className={sectionDividerClass} />
              <DomSection
                key={`dom-${selection.targetId}`}
                selection={selection}
                onEditTextField={onEditTextField}
                // Preserve read-only mode: only hand DomSection an edit handler
                // when one really exists (it gates `canEditClasses` on truthiness
                // and renders ungated by `onClassesEdit`, unlike the sections above).
                onClassesEdit={onClassesEdit ? onClassesEditTracked : undefined}
              />
            </>
          ) : null}
          {selection?.editTarget && onEditTextBranch ? (
            <ConditionalTextSection
              key={`conditional-${selection.targetId}`}
              file={selection.editTarget.file}
              line={selection.editTarget.line}
              column={selection.editTarget.column}
              onEditTextBranch={onEditTextBranch}
            />
          ) : null}
          {selection?.currentAttrs &&
          Object.keys(selection.currentAttrs).length > 0 ? (
            <>
              <Separator className={sectionDividerClass} />
              <AttributesSection
                key={`attrs-${selection.targetId}`}
                attrs={selection.currentAttrs}
                manifest={manifest}
                onPropEdit={onPropEdit}
              />
            </>
          ) : null}
          {!manifest && selection && !selection.selectedAsElement ? (
            // Sits beside sections that carry their own `px-3`, so it needs
            // the same inset or it prints flush against the rail's border
            // (Mo, 2026-09-02). "Manifest" is our word, not the reader's: say
            // what is missing and what that changes.
            <p className="px-3 text-xs text-muted-foreground">
              No prop definitions were found for this component, so only
              element properties can be edited.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
    {scopePrompt ? (
      <StyleScopeDialog
        open
        property={scopePrompt.property}
        origin={scopePrompt.origin}
        scopes={availableScopes(scopePrompt.origin, {
          framework: EDITOR_FRAMEWORK,
          elementScopeOutranked: EDITOR_ELEMENT_SCOPE_OUTRANKED,
        })}
        enabledScopes={computeEnabledScopes(scopePrompt.origin)}
        elementScopeOutranked={EDITOR_ELEMENT_SCOPE_OUTRANKED}
        onConfirm={(scope, remember) => {
          if (remember) rememberedScopeRef.current = scope
          applyScope(scope, scopePrompt.nextClasses, {
            property: scopePrompt.property,
            origin: scopePrompt.origin,
          })
          setScopePrompt(null)
        }}
        onCancel={() => setScopePrompt(null)}
      />
    ) : null}
    </>
  )
}

/**
 * Memoized — same rationale as `LayersPanel`. The inspector is forceMounted
 * inside the Edit tab and its props (selection, manifest, breakpoint, the
 * stable edit handlers, the iframe ref) are untouched by chat streaming.
 */
export const InspectorPanel = memo(InspectorPanelImpl)
InspectorPanel.displayName = "InspectorPanel"

/**
 * Shorten an absolute source path for display: strip everything up to the
 * prototype directory by anchoring on the first `/src/` or `/node_modules/`
 * segment, prefixing the remainder with an ellipsis. The full path is kept
 * available to callers via a `title` tooltip. Falls back to the raw path
 * when no marker is found.
 */
function shortenSourcePath(file: string): string {
  for (const marker of ["/src/", "/node_modules/"]) {
    const at = file.indexOf(marker)
    if (at >= 0) return `…/${file.slice(at + 1)}`
  }
  return file
}

/**
 * The variant-context bar above the style sections. The breakpoint axis is
 * owned by the global viewport control in the chrome (shown here read-only
 * as an `@ md` chip so the user knows which breakpoint they're editing);
 * the state axis (hover/focus/dark) is a flat toggle list edited in place.
 * A dot marks states that already carry overrides on this element.
 */
function StyleContextBar({
  activeBreakpoint,
  activeState,
  onStateChange,
  presentStates,
}: {
  activeBreakpoint: ActiveBreakpoint
  activeState: ActiveState
  onStateChange: (state: ActiveState) => void
  presentStates: VariantState[]
}) {
  const options: ActiveState[] = ["default", ...STATES]
  return (
    <div className="space-y-1.5 px-3">
      <div className="flex items-center justify-between">
        <span className={fieldLabelClass}>State</span>
        {activeBreakpoint !== "base" ? (
          <Badge variant="secondary" className="font-mono text-code">
            @ {activeBreakpoint}
          </Badge>
        ) : null}
      </div>
      <ToggleGroup
        size="sm"
        type="single"
        variant="outline"
        spacing={0}
        value={activeState}
        onValueChange={(v) => onStateChange((v || "default") as ActiveState)}
        className="w-full"
      >
        {options.map((s) => (
          <ToggleGroupItem
            key={s}
            value={s}
            aria-label={s}
            className="flex-1 gap-1 px-2 capitalize"
          >
            {s}
            {s !== "default" && presentStates.includes(s as VariantState) ? (
              <StatusDot size="sm" className="bg-primary" />
            ) : null}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

function IdentitySection({
  selection,
  manifest,
  onDetach,
  onSwap,
  onEditComponent,
}: {
  selection: Selection | null
  manifest: ComponentManifest | null
  onDetach?: () => void
  onSwap?: () => void
  onEditComponent?: () => void
}) {
  // Element-level selections (the layers tree's `type === "element"` rows)
  // identify by tag rather than by enclosing component — without this, a
  // div selected inside ProtoCatalogCard would render "ProtoCatalogCard"
  // as the heading even though the layers tree highlights the div.
  const isElement = !!selection?.selectedAsElement
  const name = isElement
    ? selection?.tagName ?? selection?.selector ?? "(unknown)"
    : manifest?.name ??
      selection?.componentName ??
      selection?.tagName ??
      selection?.selector ??
      "(unknown)"
  const sourceFile = isElement
    ? undefined
    : selection?.componentFile ?? manifest?.source?.declarations?.[0]?.file
  // Detach is offered only for prototype-authored components — a path
  // outside `node_modules` indicates the user can edit the component's
  // source. Library components (Acme DS, etc.) require V2 work to
  // detach safely (we'd be inlining minified bundle templates).
  const canDetach =
    !isElement &&
    !!onDetach &&
    !!selection?.componentName &&
    !!selection.componentFile &&
    !selection.componentFile.includes("node_modules") &&
    !!selection.editTarget
  // Swap is offered for any component selection with an editTarget —
  // the call-site lives in the consumer's SFC regardless of whether the
  // host component is first-party or library. The applicator only
  // rewrites the consumer (the parent SFC), not the host's source, so
  // node_modules hosts are fine here (the consumer's tree is editable).
  const canSwap =
    !isElement &&
    !!onSwap &&
    !!selection?.componentName &&
    !!selection?.editTarget
  // Edit-component (Phase F4) navigates the iframe to the isolation
  // route. Originally restricted to first-party hosts (node_modules
  // paths aren't writable), but the Storybook-style variant grid is
  // most useful for design-system components — viewing a library component
  // UiButton in isolation doesn't claim source-edit ability, it just
  // opens the variant grid. The edit pipeline still refuses writes
  // into node_modules.
  const canEditComponent =
    !isElement &&
    !!onEditComponent &&
    !!selection?.componentName

  return (
    <section aria-label="Identity" className="px-3 space-y-1">
      <header className="flex items-start justify-between gap-2">
        <h3 className={cn(panelTitleClass, "leading-none")}>{name}</h3>
        {canEditComponent || canSwap || canDetach ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mt-1 -mr-1 shrink-0"
                aria-label="Component actions"
                data-testid="component-actions-btn"
              >
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEditComponent ? (
                <DropdownMenuItem onSelect={onEditComponent} data-testid="edit-component-btn">
                  Edit component
                </DropdownMenuItem>
              ) : null}
              {canSwap ? (
                <DropdownMenuItem onSelect={onSwap} data-testid="swap-component-btn">
                  Swap component
                </DropdownMenuItem>
              ) : null}
              {canDetach ? (
                <DropdownMenuItem onSelect={onDetach}>
                  Detach component
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>
      {sourceFile ? (
        <p className="break-all text-xs text-muted-foreground" title={sourceFile}>
          {shortenSourcePath(sourceFile)}
        </p>
      ) : null}
    </section>
  )
}

function VariantsAndPropsSection({
  manifest,
  currentProps,
  onPropEdit,
}: {
  manifest: ComponentManifest
  /** Live prop values from the bridge — overrides manifest defaults when present. */
  currentProps?: Record<string, unknown>
  onPropEdit?: (propName: string, value: PropControlValue) => void
}) {
  const props = manifest.props ?? []
  if (props.length === 0) {
    return (
      <section aria-label="Variants and props" className="px-3 space-y-2">
        <SectionHeader title="Variants and props" />
        <p className="text-xs text-muted-foreground">
          This component has no own props.
        </p>
      </section>
    )
  }
  return (
    <section aria-label="Variants and props" className="px-3 space-y-3">
      <SectionHeader title="Variants and props" />
      <div className="space-y-2">
        {props.map((prop) => (
          <PropControl
            key={prop.name}
            prop={prop}
            currentValue={currentProps?.[prop.name]}
            onChange={onPropEdit ? (value) => onPropEdit(prop.name, value) : undefined}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Renders fallthrough attributes the parent template passed to this
 * component instance — `placeholder`, `data-testid`, `required`, etc.
 * — that the design system didn't typed-declare as props.
 *
 * Why this exists separately from `VariantsAndPropsSection`: typed
 * props come from the manifest (with control kinds, defaults, finite
 * choices). Fallthrough attrs come from the bridge's runtime
 * `instance.attrs` snapshot only — we don't have a manifest entry, so
 * we render every value as an editable text input. The edit dispatch
 * goes through the same `onPropEdit` callback because the apply-prop-
 * edit service writes attribute names into the call site regardless
 * of whether the design system formally types them.
 *
 * Filter rules:
 * - Skip attrs whose name matches a manifest-typed prop (would be a
 *   duplicate row). In practice Vue routes these to `props` not
 *   `attrs`, but defensive filtering keeps the UI clean.
 * - Skip non-stringifiable values (objects, functions). Editing those
 *   needs a richer control we don't yet have.
 */
function AttributesSection({
  attrs,
  manifest,
  onPropEdit,
}: {
  attrs: Record<string, unknown>
  manifest: ComponentManifest | null
  onPropEdit?: (propName: string, value: PropControlValue) => void
}) {
  const typedPropNames = new Set((manifest?.props ?? []).map((p) => p.name))
  const editable = Object.entries(attrs).filter(([key, value]) => {
    if (typedPropNames.has(key)) return false
    return (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    )
  })
  if (editable.length === 0) return null

  return (
    <section aria-label="Attributes" className="px-3 space-y-3">
      <SectionHeader
        title="Attributes"
        description="Fallthrough props the parent passed to this instance."
      />
      <div className="space-y-3">
        {editable.map(([name, value]) => (
          <AttributeRow
            key={name}
            name={name}
            initial={value === null ? "" : String(value)}
            onChange={
              onPropEdit
                ? (next) => onPropEdit(name, next)
                : undefined
            }
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Manifest-less fallback for a component's own props. When the manifest
 * pipeline has no entry for the selected component (a library we haven't
 * onboarded a manifest source for — see
 * `tasks/design-system-manifest-onboarding.md`), `VariantsAndPropsSection`
 * renders nothing and the inspector would be empty. This surfaces the
 * component's *currently-set* prop values (`selection.currentProps`,
 * read live off the instance by the bridge) as editable rows so the
 * panel is never fully empty.
 *
 * Graceful degradation, NOT a manifest replacement:
 * - Only props that currently have a value appear (no manifest ⇒ no way
 *   to know about unset props — that capability needs the manifest).
 * - Plain text inputs only — no typed controls (boolean toggles, enum
 *   dropdowns) and no defaults/descriptions.
 * - Edits route through the same `onPropEdit` callback as typed props;
 *   the write path doesn't consult the manifest.
 *
 * Skips non-stringifiable values (objects/arrays/functions) for the same
 * reason `AttributesSection` does — there's no text control for them yet.
 */
function CurrentPropsSection({
  currentProps,
  onPropEdit,
}: {
  currentProps: Record<string, unknown>
  onPropEdit?: (propName: string, value: PropControlValue) => void
}) {
  const editable = Object.entries(currentProps).filter(
    ([, value]) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null,
  )
  if (editable.length === 0) return null

  return (
    <section aria-label="Props" className="px-3 space-y-3">
      <SectionHeader
        title="Props"
        description="Live prop values. No prop definitions were found, so types and unset props aren't shown."
      />
      <div className="space-y-3">
        {editable.map(([name, value]) => (
          <AttributeRow
            key={name}
            name={name}
            initial={value === null ? "" : String(value)}
            onChange={
              onPropEdit ? (next) => onPropEdit(name, next) : undefined
            }
          />
        ))}
      </div>
    </section>
  )
}

function AttributeRow({
  name,
  initial,
  onChange,
}: {
  name: string
  initial: string
  onChange?: (value: PropControlValue) => void
}) {
  const [value, setValue] = useState(initial)
  const interactive = typeof onChange === "function"
  const commit = (next: string) => {
    if (!interactive) return
    if (next === initial) return
    onChange?.(next)
  }
  return (
    <div className={fieldRowClass}>
      <label
        className={cn("min-w-0", fieldLabelClass)}
        htmlFor={`attr-${name}`}
      >
        {name}
      </label>
      <Input
        id={`attr-${name}`}
        size="sm"
        value={value}
        readOnly={!interactive}
        aria-readonly={interactive ? undefined : "true"}
        onChange={(e) => {
          if (!interactive) return
          setValue(e.target.value)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit((e.target as HTMLInputElement).value)
          }
        }}
      />
    </div>
  )
}

/**
 * Sentinel id for the Classes input in the shared dirty set. It is not one of
 * the bridge's fields, but it has the same "do not clobber what I am typing"
 * requirement, and a field id can never collide with it.
 */
// Written as an escape, not a literal NUL byte: the same string at runtime,
// but a raw NUL makes git and grep treat this whole file as binary.
const CLASSES_FIELD_ID = "\u0000classes"

function DomSection({
  selection,
  onEditTextField,
  onClassesEdit,
}: {
  selection: Selection
  onEditTextField?: (field: EditableTextField, value: string) => void
  onClassesEdit?: (classes: string[]) => void
}) {
  // The bridge is the sole source of editable text fields. The old
  // `selection.textContent` stale-bridge fallback was removed 2026-08-04 —
  // shell and bridge ship together from one repo, so a bridge old enough to
  // omit `editableTexts` can't reach this build.
  const reported = useMemo(
    () => selection.editableTexts ?? [],
    [selection.editableTexts],
  )

  /**
   * The fields this panel is willing to show for the CURRENT selection.
   *
   * Not simply what the bridge last reported. The bridge derives editable
   * text from what is actually rendered, so an element whose text you have
   * just deleted reports NO field at all: the input vanished mid-edit and
   * took with it the only way to type a replacement. Once a field has been
   * seen for a selection it stays until the selection changes, with an empty
   * value, so clearing a field and pasting a new one is one continuous
   * gesture instead of a dead end.
   */
  const [knownFields, setKnownFields] = useState<EditableTextField[]>(reported)

  // `reported` is derived from `selection` so its reference changes every
  // render. Key effects on a fingerprint (ids + values) rather than the array
  // itself, or the reset below loops forever.
  const reportedFingerprint = reported.map((f) => `${f.id}:${f.value}`).join("|")

  const [textValues, setTextValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(reported.map((f) => [f.id, f.value])),
  )
  const [classesValue, setClassesValue] = useState(
    (selection.classes ?? []).join(" "),
  )

  /**
   * Fields the user has typed into and not yet committed.
   *
   * A bridge re-emit must never overwrite one. ELEMENT_INSPECTED fires for
   * reasons that have nothing to do with this input (an edit elsewhere, an
   * HMR reload, a re-inspection of the same element), and re-syncing a focused
   * field under the user replaces what they typed with what the file still
   * says. That is the flicker: the value snapping back and forth, and the
   * caret jumping to the end each time.
   */
  const dirtyRef = useRef<Set<string>>(new Set())

  // A new element: drop everything, including anything uncommitted. The
  // previous selection's half-typed value must not appear against a
  // different element.
  useEffect(() => {
    dirtyRef.current = new Set()
    setKnownFields(selection.editableTexts ?? [])
    setTextValues(
      Object.fromEntries((selection.editableTexts ?? []).map((f) => [f.id, f.value])),
    )
    setClassesValue((selection.classes ?? []).join(" "))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.targetId])

  // Same element, fresh values from the bridge (typically a write landing).
  // Adopt them for every field EXCEPT one the user is mid-edit on, and keep
  // any field the bridge has stopped reporting.
  useEffect(() => {
    setKnownFields((prev) => {
      const merged = new Map(prev.map((f) => [f.id, f]))
      for (const f of reported) merged.set(f.id, f)
      return [...merged.values()]
    })
    setTextValues((prev) => {
      const next = { ...prev }
      for (const f of reported) {
        if (!dirtyRef.current.has(f.id)) next[f.id] = f.value
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedFingerprint])

  useEffect(() => {
    setClassesValue((prev) =>
      dirtyRef.current.has(CLASSES_FIELD_ID) ? prev : (selection.classes ?? []).join(" "),
    )
  }, [selection.classes])

  const editableTexts = knownFields

  /**
   * Send a text field's buffered value, if it actually differs from what the
   * bridge last reported.
   *
   * Comparing against `field.value` rather than tracking what we last sent is
   * deliberate: after a successful write the bridge re-emits with the new
   * value, so a second blur is correctly a no-op, while after a FAILED write
   * it still holds the old one, so blurring again retries. That is the
   * behaviour you want from both.
   */
  const commitText = (field: EditableTextField) => {
    if (!onEditTextField) return
    dirtyRef.current.delete(field.id)
    const next = textValues[field.id] ?? field.value
    if (next === field.value) return
    onEditTextField(field, next)
  }

  const commitClasses = () => {
    if (!onClassesEdit) return
    dirtyRef.current.delete(CLASSES_FIELD_ID)
    const current = (selection.classes ?? []).join(" ")
    if (classesValue.trim() === current.trim()) return
    onClassesEdit(classesValue.split(/\s+/).filter((t) => t.length > 0))
  }

  const canEditClasses = !!onClassesEdit
  const hasAnyEditableText = editableTexts.length > 0

  if (!hasAnyEditableText && !canEditClasses && (selection.classes ?? []).length === 0) {
    return null
  }

  return (
    <section aria-label="DOM" className="px-3 space-y-3">
      <SectionHeader title="DOM" />
      {editableTexts.map((field) => {
        const value = textValues[field.id] ?? field.value
        if (field.readOnly || !onEditTextField) {
          return (
            <div key={field.id} className="space-y-1">
              <label className={stackedLabelClass}>
                {field.label}
              </label>
              <p className={cn("break-words", fieldValueClass)}>{value}</p>
              {field.readOnlyReason ? (
                <p className="text-xs text-muted-foreground">
                  {field.readOnlyReason}
                </p>
              ) : null}
            </div>
          )
        }
        return (
          <div key={field.id} className="space-y-1">
            <label className={stackedLabelClass}>
              {field.label}
            </label>
            <Input
              size="sm"
              value={value}
              data-testid={`dom-text-${field.id}`}
              onChange={(e) => {
                // Typing is LOCAL. It used to dispatch a source edit per
                // keystroke, which is what produced "the text didn't match"
                // carrying half a word: the first keystroke rewrote the file,
                // so the second one's `before` no longer matched anything.
                dirtyRef.current.add(field.id)
                setTextValues((prev) => ({ ...prev, [field.id]: e.target.value }))
              }}
              onBlur={() => commitText(field)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitText(field)
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  dirtyRef.current.delete(field.id)
                  setTextValues((prev) => ({ ...prev, [field.id]: field.value }))
                  e.currentTarget.blur()
                }
              }}
            />
          </div>
        )
      })}
      {canEditClasses ? (
        <div className="space-y-1">
          <label className={stackedLabelClass}>
            Classes
          </label>
          <Input
            size="sm"
            value={classesValue}
            data-testid="dom-classes"
            onChange={(e) => {
              // Local until commit, for the same reason as the text fields
              // above. Committing per keystroke rewrote the class attribute
              // on every character, so typing "flex" wrote "f", "fl", "fle".
              dirtyRef.current.add(CLASSES_FIELD_ID)
              setClassesValue(e.target.value)
            }}
            onBlur={commitClasses}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commitClasses()
                e.currentTarget.blur()
              } else if (e.key === "Escape") {
                e.preventDefault()
                dirtyRef.current.delete(CLASSES_FIELD_ID)
                setClassesValue((selection.classes ?? []).join(" "))
                e.currentTarget.blur()
              }
            }}
            placeholder="space-separated tokens"
          />
        </div>
      ) : (selection.classes ?? []).length > 0 ? (
        <div className="space-y-1">
          <label className={stackedLabelClass}>
            Classes
          </label>
          <p className={cn("break-words", fieldValueClass)}>
            {(selection.classes ?? []).join(" ")}
          </p>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Conditional-text editor. Hits /api/editor/text-branches on selection
 * change; if the element's only child is a `{{ test ? a : b }}` ternary
 * the section appears with one labeled input per branch. Each blur
 * dispatches a `TextBranchEdit` via `onEditTextBranch`.
 *
 * Renders nothing while the fetch is in flight or when the endpoint
 * returns no detection — the inspector silently stays clean for the
 * (vast) majority of elements that aren't conditional ternaries.
 */
function ConditionalTextSection({
  file,
  line,
  column,
  onEditTextBranch,
}: {
  file: string
  line: number
  column: number
  onEditTextBranch: (branch: TextBranch, newValue: string) => Promise<void> | void
}) {
  const [data, setData] = useState<
    { testExpression: string; branches: TextBranch[] } | null
  >(null)
  // Local edit buffer keyed by branch.kind (NOT byteStart): byteStart
  // changes after each successful edit because the file length shifts,
  // but kind ("consequent" / "alternate") is stable for the lifetime of
  // a selection.
  const [draft, setDraft] = useState<Record<string, string>>({})
  // Bumped after each successful edit to trigger a refetch — the
  // server returns the new byte ranges, so we never dispatch a stale
  // splice (Codex review finding: editing branch 1 invalidates branch 2's
  // recorded byteStart/byteEnd when the lengths differ).
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    editorFetch("/api/editor/text-branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, line, column }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        if (json?.ok) {
          setData({
            testExpression: json.testExpression as string,
            branches: json.branches as TextBranch[],
          })
        } else {
          setData(null)
        }
        // Clear any in-flight draft input on refetch — the user's edit
        // committed, the new value is in `branch.value` now.
        setDraft({})
      })
      .catch(() => {
        /* silent — section just doesn't render */
      })
    return () => {
      cancelled = true
    }
  }, [file, line, column, revision])

  if (!data) return null

  const commit = async (branch: TextBranch) => {
    const next = draft[branch.kind] ?? branch.value
    if (next === branch.value) return
    await onEditTextBranch(branch, next)
    // Refetch — the file has shifted, so the OTHER branch's byteStart/
    // byteEnd are now stale. Server returns fresh values; we re-render
    // with them and clear the draft buffer.
    setRevision((r) => r + 1)
  }

  return (
    <>
      <Separator className={sectionDividerClass} />
      <section className="px-3 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold">Conditional text</h3>
          <code className="text-code text-muted-foreground">
            on {data.testExpression}
          </code>
        </div>
        <div className="space-y-3">
          {data.branches.map((branch) => {
            const id = `branch-${branch.kind}`
            const current = draft[branch.kind] ?? branch.value
            return (
              <div key={branch.kind} className="space-y-1">
                <label
                  htmlFor={id}
                  className="flex items-baseline justify-between text-xs text-muted-foreground"
                >
                  <span>
                    when{" "}
                    <code className="font-mono">{data.testExpression}</code> ={" "}
                    {branch.kind === "consequent" ? "true" : "false"}
                  </span>
                  <Badge variant="secondary">
                    {branch.valueKind === "literal" ? "string" : "expression"}
                  </Badge>
                </label>
                <Input
                  id={id}
                  size="sm"
                  value={current}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [branch.kind]: e.target.value }))
                  }
                  onBlur={() => void commit(branch)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      ;(e.currentTarget as HTMLInputElement).blur()
                    }
                  }}
                  spellCheck={branch.valueKind === "literal"}
                />
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

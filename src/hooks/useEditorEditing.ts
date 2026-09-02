"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type {
  ComponentManifestSource,
  DisambiguationChoice,
  DragMoveRequest,
  FrameworkAdapter,
  InsertAtPointRequest,
  ResizeRequest,
  IconManifest,
  IterationContext,
  Mutation,
  PendingMutation,
  PropEdit,
  SaveLLMTrace,
  Selection,
  StructuralEdit,
} from "@/editor/core"
import { BridgeFrameworkAdapter } from "@/editor/adapters/bridge"
import {
  EDITOR_FRAMEWORK,
  EDITOR_OVERRIDE_STYLESHEET,
  EDITOR_REPO_ROOT,
  EDITOR_REPO_ROOT_REAL,
  EDITOR_VITE_BASE,
} from "@/lib/editor-feature-flags"
import { CompositeManifestSource } from "@/editor/adapters/composite"
import { CachedManifestLookup } from "@/editor/attribution/manifest-lookup"
import { attribute } from "@/editor/attribution/attribute"
import { detectDrift } from "@/editor/attribution/detect-drift"
import type {
  AttributionContext,
  AttributionResult,
  RenderSite,
} from "@/editor/attribution/types"
import {
  isAttributionOverrideCandidate,
  routeAttributionResult,
} from "@/editor/attribution/route-result"
import { useDriftReporter } from "./useDriftReporter"
import type { CatalogEntry } from "@/editor/edit-service/component-catalog"
import { buildVariantCells } from "@/editor/edit-service/variant-cells"
import type {
  LayersDropRefusal,
  LayersMovePayload,
} from "@/components/editor/layers-panel"
import { applyClassMutation } from "@/components/editor/align-size"
import type { PropControlValue } from "@/components/editor/prop-control"
import { resolveTailwindClasses } from "@/components/editor/tailwind-declarations"
import { resolveTokenScopeFile } from "@/components/editor/resolve-token-source-file"
import type { EditableTextField, OutlineNode, StyleOrigin } from "@/types/bridge"
import { editorFetch } from "@/lib/editor-fetch"
import { useEditorStore } from "@/stores/editor-only"
import { useAppStore } from "@/stores"
import { useEditVerification } from "./useEditVerification"
import type { IterationEditKind } from "./iteration-fallback"
import {
  logIterationScopeChoice,
  requestIterationProposal,
} from "./iteration-fallback"
import { applyEditWithLLMFallback } from "./apply-edit-with-llm-fallback"
import {
  buildEditEscalationPrompt,
  buildPropEditEscalationPrompt,
} from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  coalesceCapturedMutation,
  mutationIdentity,
  shouldProbeTextMutation,
} from "./editor-mutation-coalesce"
import { recordHmrTreeUpdate, requestPrototypeReload } from "./editor-hmr-watchdog"
import {
  blastRadiusNotice,
  buildPageScopedCssOverrideEdit,
  buildStyleEdit,
  isUnsupportedStyleBuild,
  type StyleEditDestinationOptions,
} from "./style-edit-builders"
import { useIframeStylesheetTargets } from "./useIframeStylesheetTargets"
import {
  isOverrideStylesheetRefusal,
  resolveOverrideStylesheet,
} from "@/components/editor/resolve-override-stylesheet"
import { makeEditId } from "./make-edit-id"
import { describeEditOutcome } from "./edit-outcome"
import { reconcileDispatchedValue } from "./dispatch-reconcile"
import { cascadeTargetForStyleEdit } from "./cascade-target-for-style-edit"
import { handleResolutionFailure } from "./resolution-failure-notice"
import { offeredDisambiguationChoices } from "./disambiguation-choices"
import { routeAwaitingDisambiguation } from "./disambiguation-route"
import { notifySingleChoiceDisambiguation } from "./single-choice-disambiguation-notice"
import { notifyOverridePreviewFailure } from "./override-preview-notice"
import type { ManifestValue } from "@/editor/core/manifest"
import type { IterationScope } from "@/components/editor/iteration-scope-dialog"
import {
  collectVueFiles,
  fetchConditionalGroupsForFiles,
  findGroupFirstChildSelector,
  isGroupSelector,
  mergeConditionalGroups,
  type FileConditionalGroups,
} from "./layers-conditional-groups"
import {
  filterLayersByDensity,
  type LayersDensity,
} from "./layers-density-filter"
import {
  readStoredLayersDensity,
  writeStoredLayersDensity,
} from "./layers-density-storage"

/**
 * Shared empty listing for "this refresh found no `.vue` files". A module
 * constant so the identity is stable: `layersRoots` memoizes on this map, and
 * a fresh `new Map()` per refresh would rebuild the filtered tree (and
 * re-render the whole panel) for no reason.
 */
const EMPTY_CONDITIONAL_GROUPS: Map<string, FileConditionalGroups> = new Map()

/**
 * Narrow a {@link PropEdit}'s value to the string|number|boolean shape the
 * escalation prompt expects. The wire protocol's PropEdit body (per
 * {@link validateEditRequest}) only accepts these three primitive kinds —
 * arrays / objects / null get rejected at the server boundary. So in
 * practice this is just a type-narrowing assertion; the fallback
 * stringifies defensively in case a future PropEdit variant slips through.
 */
function normalizeManifestValueForEscalation(
  value: ManifestValue,
): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  // ManifestValue widens to null / array / object for non-prop edits.
  // PropEdits don't carry these — fall back to a labeled string so the
  // prompt is still readable if the validator drifts.
  return String(value)
}

/**
 * `adapter.resolveOverride`, plus the shell-side "the preview shim is gone" edge
 * (L1). Every terminal resolution must go through this rather than calling the
 * adapter directly: the inspector's style rows show a PROVISIONAL value while
 * editor's inline `!important` preview is stamped on the element, and this
 * event is what tells them to re-read. It previously polled until the bridge
 * stopped reporting `inline.fromPreview`, on a fixed budget the user's own
 * reading time could consume — after which a Discard left the swatch naming a
 * colour that existed nowhere.
 *
 * Display-only and strictly after the resolution: nothing about the edit is
 * gated or delayed on it.
 */
function resolveOverrideSettled(
  adapter: Pick<FrameworkAdapter, "resolveOverride">,
  id: string,
  outcome: "confirmed" | "failed" | "ineffective",
  reason?: string,
): void {
  adapter.resolveOverride(id, outcome, reason)
  useEditorStore.getState().notePreviewSettled()
}

/** {@link resolveOverrideSettled} for a possibly-absent adapter ref. */
function resolveOverrideSettledOptional(
  adapter: Pick<FrameworkAdapter, "resolveOverride"> | null | undefined,
  id: string,
  outcome: "confirmed" | "failed" | "ineffective",
  reason?: string,
): void {
  if (!adapter) return
  resolveOverrideSettled(adapter, id, outcome, reason)
}

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "error"; message: string }

/**
 * Pending iteration edit — held while the IterationScopeDialog asks the
 * user to pick between mutating the data array entry vs. the template.
 * Each variant carries the data the legacy-path handler would need so
 * "all-rows" can re-enter without re-collecting inputs. New iteration-
 * aware edit kinds add a variant here.
 */
type PendingIterationEdit =
  | {
      editKind: "delete"
      selection: Selection
      node: OutlineNode
      iterationContext: IterationContext
    }
  | {
      editKind: "prop"
      selection: Selection
      propName: string
      value: PropControlValue
      iterationContext: IterationContext
    }
  | {
      editKind: "move"
      payload: LayersMovePayload
      iterationContext: IterationContext
    }
  | {
      editKind: "dom-text"
      selection: Selection
      field: EditableTextField
      value: string
      iterationContext: IterationContext
      /**
       * Set ONLY when the edit reached us as a bridge pending disambiguation —
       * i.e. the designer typed in the page rather than in the inspector. The
       * bridge is holding a draft mutation and a live DOM preview, so every
       * exit from the dialog must resolve or cancel it; leaving it hanging
       * blocks Save behind `handleSaveAll`'s gate.
       */
      bridgePendingId?: string
    }

interface UseEditorEditingOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  prototypeUrl: string
  /**
   * When false, the hook is dormant — no adapter is attached, no
   * listeners are registered, all state stays at initial values.
   * Toggling to true attaches the adapter; toggling back to false
   * disposes it.
   */
  enabled?: boolean
  /**
   * Manifest source. Defaults to an EMPTY `CompositeManifestSource` — a
   * caller that supplies nothing gets no manifests (and `attribute()`
   * degrades to its heuristic fallback), never another substrate's catalog.
   * The production callers (`<EditorSurface>`, `editor-page`) pass a
   * `RemoteManifestSource` pointed at `/api/editor/manifest`.
   */
  manifestSource?: ComponentManifestSource
  /**
   * Hand a direct-manipulation edit to the chat agent when the server
   * stops at the deterministic boundary in `'chat'` fallback mode
   * (`needsChat`). The hook builds a seed prompt from the failed
   * mutations and calls this; the surface wires it to `chat.submit` and
   * reveals the chat rail. Omitted in legacy/`'patch'` mode (the
   * in-modal LLM lane handles the fallback instead).
   *
   * Returns whether the handoff was ACCEPTED: `true` when a chat turn was
   * dispatched, `false` when it no-ops (no chat transport available). The
   * internal `needsChat` auto-fire paths ignore the return value.
   */
  escalateToChat?: (prompt: string) => boolean
}

/**
 * Editor editing state + handlers, decoupled from the iframe owner.
 * Used by the standalone `<EditorSurface>`, which renders its own
 * iframe.
 *
 * The adapter is attached when `enabled` is true and an iframe element
 * is present in `iframeRef`; disposed on disable or unmount. The hook
 * intentionally does NOT render any UI — callers compose the parts
 * (layers tree, inspector, pending-changes panel) into their own
 * layouts.
 */
export function useEditorEditing({
  iframeRef,
  prototypeUrl,
  enabled = true,
  manifestSource: manifestSourceOverride,
  escalateToChat,
}: UseEditorEditingOptions) {
  // The fallback is an EMPTY composite, not a design system.
  //
  // It used to be `new Acme DSManifestSource()`, described as the "V1.2
  // fallback ... so tests and offline use cases work without network." That
  // made Acme DS the silent default for any caller that forgot the
  // override — on a React + Material UI or Naive UI prototype the hook would
  // attribute against a catalog describing components that are not on the
  // page. Wrong answers, not absent ones.
  //
  // Empty degrades correctly instead: `attribute()` finds no manifest and
  // falls back to the retained heuristic, which is exactly the documented
  // behaviour for a component with no manifest. Production is unaffected —
  // `<EditorSurface>` and `editor-page` both pass a `RemoteManifestSource`
  // pointed at `/api/editor/manifest`, where the real composite (auto-scanned
  // libraries, local SFCs, Storybook, hints) is assembled server-side.
  const manifestSource = useMemo(
    () => manifestSourceOverride ?? new CompositeManifestSource({ sources: [] }),
    [manifestSourceOverride],
  )
  // Phase 3 Stage A: a synchronous manifest lookup over the same source,
  // warmed by `prefetch` when a selection arrives so `attribute()` can run
  // synchronously at edit-dispatch time (see handleEditTextField).
  const attributionLookup = useMemo(
    () => new CachedManifestLookup(manifestSource),
    [manifestSource],
  )
  // Phase 5 Task 2: advisory shell-side drift detection, wired at the same
  // call site attribute() itself runs from — see handleEditTextField below.
  // Phase 5 Task 5: thread the SAME `attributionLookup` instance through so
  // a server-side auto-repair (Task 4) drops the stale cached manifest —
  // otherwise attribution keeps serving the pre-repair manifest until
  // something else happens to invalidate it. Also exposed below (as
  // `invalidateAttributionManifest`) so `useDriftEntries` — a SIBLING data
  // hook owned by `DesignSystemsPanel`, not this hook — can invalidate the
  // SAME lookup instance when a dismiss/clear/regenerate-hints response
  // carries an `invalidate` list (final review fix wave).
  const invalidateAttributionManifest = useCallback(
    (entries: Array<{ name: string; importPath?: string }>) => attributionLookup.invalidate(entries),
    [attributionLookup],
  )
  const driftReporter = useDriftReporter({ invalidateManifest: invalidateAttributionManifest })
  /**
   * Phase 5 Task 2 (commit-time) + the 2026-07-30 widening to inspection
   * time: advisory drift detection, shared by BOTH call sites —
   * `handleEditTextField` below (on text-edit commit) and the selection
   * subscription in the adapter-lifecycle effect below (on click/
   * inspection, before any edit happens). Both resolve the owning
   * manifest the SAME way (`componentChain[0]` + `attributionLookup.
   * getByName`) and must never let a detection/reporting failure affect
   * anything else — this try/catch is the single place both callers rely
   * on for that guarantee.
   *
   * `unknown-component` guard: `CachedManifestLookup.getByName` returns
   * `null` both for "confirmed no manifest for this component" and for "a
   * prefetch fetch for this component failed" (see `hasFailedFetch`'s doc
   * comment in manifest-lookup.ts) — indistinguishable from the return
   * value alone. `detectUnknownComponent` is the ONLY drift rule keyed on
   * `owningManifest === null` by itself (hint-miss/unknown-props/
   * selector-ambiguous all require a RESOLVED manifest to fire, so a
   * failed fetch can't fake any of those), so filtering just that one kind
   * when we know the fetch for this exact component failed closes the
   * false-positive window without losing real signals.
   */
  const reportDriftForAttribution = useCallback(
    (attributionCtx: AttributionContext, attributionResult: AttributionResult) => {
      try {
        const owning = attributionCtx.componentChain[0]
        const owningManifest = owning
          ? attributionLookup.getByName(owning.name, owning.importPath)
          : null
        let driftSignals = detectDrift({
          context: attributionCtx,
          result: attributionResult,
          owningManifest,
        })
        if (
          owningManifest === null &&
          owning &&
          attributionLookup.hasFailedFetch(owning.name, owning.importPath)
        ) {
          driftSignals = driftSignals.filter((signal) => signal.kind !== "unknown-component")
        }
        if (driftSignals.length > 0) driftReporter.report(driftSignals)
      } catch {
        // Advisory-first — drift detection/reporting never breaks editing.
      }
    },
    [attributionLookup, driftReporter],
  )
  const editorSelection = useEditorStore((s) => s.editorSelection)
  const editorManifest = useEditorStore((s) => s.editorManifest)
  const setEditorSelection = useEditorStore((s) => s.setEditorSelection)
  const setEditorManifest = useEditorStore((s) => s.setEditorManifest)

  const adapterRef = useRef<BridgeFrameworkAdapter | null>(null)
  const treeUpdateUnsubRef = useRef<(() => void) | null>(null)
  const [adapterReadyMarker, setAdapterReadyMarker] = useState(0)
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting" })

  // Tier-2 edit verification (P1): fired after a session-mode source write
  // lands and HMR re-renders, to confirm the edit actually took effect.
  // Held in a ref so the stable (deps: []) dispatch callbacks can call it
  // without re-creating on every render. See `useEditVerification`.
  const { verifyEdit } = useEditVerification(() => adapterRef.current)
  const verifyEditRef = useRef(verifyEdit)

  /**
   * Whether the live bridge implements `READ_RENDERED_VALUE`. The agent's
   * `verify_edit` tool gates on this (via the `chat:read_rendered_value` shell
   * handler) before relying on a read — an older bridge silently drops the
   * query, so an ungated read would time out → null → a *false* failure that
   * pushes the agent into a needless self-correct loop. Conservative: returns
   * false when no adapter is bound or the version is unknown. Stable identity.
   */
  const supportsRenderedValueRead = useCallback(
    (): boolean => !!adapterRef.current?.supportsRenderedValueRead?.(),
    [],
  )
  /**
   * Whether the live bridge implements `READ_MEASUREMENTS`. The agent's
   * `verify_goal` tool gates on this (via the `chat:read_measurements` shell
   * handler) before relying on a read — same false-failure rationale as
   * `supportsRenderedValueRead`. Conservative on an unknown version.
   */
  const supportsMeasurementsRead = useCallback(
    (): boolean => !!adapterRef.current?.supportsMeasurementsRead?.(),
    [],
  )
  verifyEditRef.current = verifyEdit

  // Escalate-to-chat callback held in a ref so the stable (deps: [])
  // dispatch callbacks can reach the latest value without re-creating.
  const escalateToChatRef = useRef(escalateToChat)
  escalateToChatRef.current = escalateToChat

  // Fuzzy-edit queue. When a typing-time dispatch comes back `needsChat`
  // (deterministic lane can't apply it), the mutation is NOT escalated
  // mid-edit — it stays in the buffer and its identity is recorded here
  // so the capture scheduler stops re-dispatching it on every keystroke.
  // The queued edits are applied by the LLM lane at commit/flush time
  // (`handleSaveAll` dispatches them with `llmFallback: 'patch'`).
  const queuedForAiRef = useRef<Set<string>>(new Set())
  // Mirror of the queue size for the UI (Commit badge). State, not just
  // the ref, so the count re-renders. `setAiQueueCount` is a stable
  // setState; call it with `queuedForAiRef.current.size` after mutating
  // the set.
  const [aiQueueCount, setAiQueueCount] = useState(0)

  const layersGenerationRef = useRef(0)
  // The tree exactly as the bridge walked it. The panel is handed a FILTERED
  // view of this (see `layersRoots` below); both are kept so changing the
  // density is a re-render, not a refetch.
  const [layersRawRoots, setLayersRawRoots] = useState<OutlineNode[] | null>(() => {
    // Self-host harness seed. The standalone harness
    // (editor-cli/self-host) sets `window.__DESDE_SELF_HOST_LAYERS__`
    // so the Layers panel renders a representative tree with no live
    // bridge — mirroring how `mock-selection` seeds the inspector. A real
    // bridge (CLI supervision) overwrites this via `refreshLayers()` the
    // moment it connects, so production is unaffected: the global is never
    // set there and this falls through to `null`.
    if (typeof window !== "undefined") {
      const seed = (
        window as Window & { __DESDE_SELF_HOST_LAYERS__?: OutlineNode[] }
      ).__DESDE_SELF_HOST_LAYERS__
      if (Array.isArray(seed)) return seed
    }
    return null
  })
  // How much of the DOM tree the Structure panel shows. A per-user VIEW
  // preference, so it is NOT an `EDITOR_*` feature flag (those are boot-time
  // config read from the CLI's config file) — it lives in localStorage next
  // to the rail width, and survives a reload.
  const [layersDensity, setLayersDensityState] = useState<LayersDensity>(
    readStoredLayersDensity,
  )
  const setLayersDensity = useCallback((density: LayersDensity) => {
    setLayersDensityState(density)
    writeStoredLayersDensity(density)
  }, [])
  // Source-derived `<template v-if>` / `v-for` listings for the files the
  // raw tree references, fetched once per refresh and re-merged whenever the
  // density changes. Held in state rather than merged eagerly so switching
  // density costs no network round-trip.
  const [layersGroups, setLayersGroups] = useState<
    Map<string, FileConditionalGroups>
  >(EMPTY_CONDITIONAL_GROUPS)
  /**
   * What the panel renders: conditional-group rows merged into the RAW
   * tree, and THEN the density filter applied to the merged tree.
   *
   * The order is load-bearing, and it used to be the other way round. That
   * was the defect. `mergeConditionalGroups` matches a node by the
   * `(file, line, column)` of `authoredAt ?? editTarget`. A
   * `<div v-if="…">` holding one child is a stamped, single-child,
   * non-semantic wrapper, which is exactly what the filter's rule 3 elides
   * at `essentials` — so filtering first DELETED the node the merge was
   * about to look for, and the group row was never built at the default
   * density.
   *
   * The old argument for filter-first was that the merge collapses
   * CONSECUTIVE sibling runs, so filtering afterwards would grope at a
   * shape that no longer exists. It conflated two things. The merge builds
   * its groups once, from the raw shape; a later filter cannot re-run the
   * grouping, so there is nothing to invalidate. And the filter's
   * `isProtected` keeps every `conditionalGroup` row unconditionally, which
   * is exactly the protection a merged tree needs. Do not restore the old
   * order.
   */
  const layersRoots = useMemo(() => {
    if (!layersRawRoots) return null
    const merged =
      layersGroups.size === 0
        ? layersRawRoots
        : mergeConditionalGroups(layersRawRoots, layersGroups)
    return filterLayersByDensity(merged, layersDensity)
  }, [layersRawRoots, layersDensity, layersGroups])
  const [layersRefreshing, setLayersRefreshing] = useState(false)
  // True when the structure fetch has exhausted its retries and left `roots`
  // null. Lets the panel render a "couldn't load — retry" state instead of an
  // indistinguishable perpetual "Loading layers…". Cleared at the start of the
  // next refresh and never set while a newer refresh is in flight.
  const [layersError, setLayersError] = useState(false)

  const refreshLayers = useCallback(async () => {
    const adapter = adapterRef.current
    if (!adapter) return
    const generation = ++layersGenerationRef.current
    setLayersRefreshing(true)
    setLayersError(false)
    // Retry a bounded number of times. The first fetch fires right after the
    // handshake, concurrently with the iframe finishing its reload — that one
    // GET_STRUCTURE can be dropped (now surfaced as a timeout rather than a
    // hang). A static prototype emits no follow-up onTreeUpdate to retrigger
    // us, so without a retry a single dropped reply leaves the panel stuck on
    // "Loading layers…". Bail immediately if a newer refresh superseded us.
    const MAX_ATTEMPTS = 3
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const roots = await adapter.getStructure()
          if (generation !== layersGenerationRef.current) return
          // Synthesize <template v-if>/v-for group rows (WS2 follow-up):
          // those wrappers render no DOM, so the DOM walk above can never
          // surface them. Best-effort — a fetch failure or a substrate
          // with zero .vue files just leaves the tree as the DOM walk saw
          // it. See mergeConditionalGroups for the merge semantics.
          //
          // The file list comes from the RAW tree, here, before anything is
          // filtered or merged. That is what keeps it complete: the density
          // filter can only ever remove nodes, so deriving the fetch list
          // from a filtered tree could shrink it, and a file dropped from
          // the list gets no group rows at all. The MERGE runs in the
          // `layersRoots` memo, on the raw tree, BEFORE the filter.
          const vueFiles = collectVueFiles(roots)
          const groups =
            vueFiles.size === 0
              ? EMPTY_CONDITIONAL_GROUPS
              : await fetchConditionalGroupsForFiles([...vueFiles])
          if (generation !== layersGenerationRef.current) return
          setLayersRawRoots(roots)
          setLayersGroups(groups)
          return
        } catch (err) {
          if (generation !== layersGenerationRef.current) return
          if (attempt === MAX_ATTEMPTS) {
            console.warn(
              `[Editor] getStructure failed after ${MAX_ATTEMPTS} attempts:`,
              err,
            )
            setLayersError(true)
            return
          }
        }
      }
    } finally {
      if (generation === layersGenerationRef.current) {
        setLayersRefreshing(false)
      }
    }
  }, [])

  // Adapter lifecycle. Attached when `enabled` flips true and an iframe
  // is present; disposed on disable, unmount, or url change. Selection
  // wiring + manifest lookup mirror what `<LivePrototypePane>` does so
  // the project-route inline mode behaves identically to /compose.
  useEffect(() => {
    if (!enabled) return
    const iframe = iframeRef.current
    if (!iframe) return

    const adapter = new BridgeFrameworkAdapter()
    let cancelled = false
    let adapterReadyAnnounced = false
    let latestSelector: string | null = null

    const unsubSelection = adapter.onSelectionChange(
      async (selection: Selection | null) => {
        if (cancelled) return
        setEditorSelection(selection)
        // Phase 3 Stage A: warm the manifest cache for this selection's
        // component chain so `attribute()` resolves synchronously at edit
        // time. Also the entry point for the 2026-07-30 widening (Phase 5
        // carry-forward): once the prefetch SETTLES, run the same advisory
        // drift detection `handleEditTextField` runs at commit time — so a
        // click alone can surface a drift signal, not only a committed
        // text edit. This is why the prefetch is consumed via `.then()`
        // now instead of pure fire-and-forget: detection needs the
        // settled cache (an in-flight or still-failed lookup would make
        // `unknown-component` unreliable — see `reportDriftForAttribution`),
        // and needs to reject running against a selection that's gone
        // stale by the time the fetch resolves.
        if (selection?.attributionContext) {
          const attributionContext = selection.attributionContext
          const driftRequestSelector = selection.selector
          void attributionLookup
            .prefetch(
              attributionContext.componentChain.map((entry) => ({
                name: entry.name,
                importPath: entry.importPath,
              })),
            )
            .then(() => {
              // Staleness guard — SAME shape as the manifest branch below
              // (`cancelled` + comparing against the selector captured
              // when THIS selection arrived). Two independent awaits can
              // now interleave across selections in this callback (this
              // prefetch chain and the `manifestSource.getComponent` await
              // further down); reusing `latestSelector` — which the
              // synchronous part of this function always advances to the
              // newest selection before either await suspends — is what
              // keeps a superseded selection's stale `attributionContext`
              // from ever reaching `attribute()`/`detectDrift`.
              // Named scenario this guards: selection A's prefetch is still
              // pending when selection B arrives and supersedes it, then A's
              // prefetch finally settles — A must not run detection at that
              // point (pinned by the "supersedes a still-pending prefetch"
              // test in live-prototype-pane.test.tsx).
              if (cancelled || latestSelector !== driftRequestSelector) return
              try {
                const attributionResult = attribute(attributionContext, attributionLookup)
                reportDriftForAttribution(attributionContext, attributionResult)
              } catch {
                // Advisory-first — never affects selection handling.
              }
            })
            .catch(() => {})
        }
        if (!selection) {
          latestSelector = null
          setEditorManifest(null)
          return
        }
        const requestSelector = selection.selector
        latestSelector = requestSelector
        const componentName = selection.componentName
        if (!componentName) {
          setEditorManifest(null)
          return
        }
        let manifest: Awaited<
          ReturnType<ComponentManifestSource["getComponent"]>
        > = null
        try {
          manifest = await manifestSource.getComponent(componentName)
        } catch (err) {
          if (!cancelled && latestSelector === requestSelector) {
            console.warn(
              `[Editor] manifest lookup for ${componentName} failed:`,
              err,
            )
            setEditorManifest(null)
          }
          return
        }
        if (cancelled) return
        if (latestSelector !== requestSelector) return
        setEditorManifest(manifest)
      },
    )

    const runHandshake = () => {
      if (cancelled) return
      setStatus({ kind: "connecting" })
      let origin = "*"
      try {
        origin = new URL(prototypeUrl, window.location.href).origin
      } catch {
        // Malformed URL — fall back to wildcard.
      }
      adapter
        .init({ iframe, origin })
        .then(() => {
          if (cancelled) return
          setStatus({ kind: "ready" })
          if (!adapterReadyAnnounced) {
            adapterReadyAnnounced = true
            adapterRef.current = adapter
            setAdapterReadyMarker((n) => n + 1)
            void refreshLayers()
            treeUpdateUnsubRef.current = adapter.onTreeUpdate(() => {
              void refreshLayers()
              recordHmrTreeUpdate()
            })
            // Compose mode does NOT auto-enter the bridge's DOM-edit
            // mode. That mode deactivates the inspector to allow
            // contenteditable, which would break click-to-select on
            // tabs/buttons. Instead, in Select mode the inspector stays
            // active (init() re-applies the adapter's persisted
            // desiredActive state), and shell-initiated text/class edits
            // route through `captureDirectMutation` in the bridge — no
            // DOM-edit-mode active state required.
          }
        })
        .catch((err) => {
          if (cancelled) return
          const message = (err as Error).message ?? ""
          if (message.includes("superseded")) return
          setStatus({ kind: "error", message })
        })
    }

    iframe.addEventListener("load", runHandshake)
    runHandshake()

    return () => {
      cancelled = true
      iframe.removeEventListener("load", runHandshake)
      treeUpdateUnsubRef.current?.()
      treeUpdateUnsubRef.current = null
      unsubSelection()
      // Best-effort exit DOM-edit mode before disposing — the bridge
      // gets a clean signal even if the iframe is staying mounted (e.g.,
      // editorMode flipping back to false in the project route).
      adapter.exitDomEditMode().catch(() => {
        /* iframe may already be torn down */
      })
      adapter.dispose().catch(() => {
        /* iframe may already be torn down */
      })
      adapterRef.current = null
      setAdapterReadyMarker((n) => n + 1)
      setLayersRawRoots(null)
      setLayersGroups(EMPTY_CONDITIONAL_GROUPS)
      setLayersError(false)
      setEditorSelection(null)
      setEditorManifest(null)
      // Clear component-edit state alongside the rest of the hook's
      // session-scoped state. Without this, leaving compose mode and
      // re-entering would leave the "Editing <Component>" banner up
      // and have handleExitComponentEdit pointing at a stale URL
      // from a prior session (codex F4 P2).
      setComponentEditState(null)
    }
  }, [
    enabled,
    iframeRef,
    prototypeUrl,
    manifestSource,
    attributionLookup,
    reportDriftForAttribution,
    refreshLayers,
    setEditorSelection,
    setEditorManifest,
  ])

  /**
   * Phase 6 — multi-select. Resolves each selector via the adapter
   * and writes the result to `editorSelectionMany` (which the chat
   * header reads). The store also pins the first resolved selection
   * as the primary so single-selection inspectors stay coherent.
   */
  const handleSelectMany = useCallback(
    async (selectors: readonly string[]): Promise<Selection[]> => {
      const adapter = adapterRef.current
      if (!adapter) return []
      const selections = await adapter.selectMany(selectors)
      useEditorStore.getState().setEditorSelectionMany(selections)
      return selections
    },
    [],
  )

  /**
   * Clear the current selection (single or multi). Drives the bridge's
   * `clearSelection()` so the in-iframe highlight overlay is removed; the
   * resulting `ELEMENT_DESELECTED` flows back through `onSelectionChange(null)`
   * to null `editorSelection`. Also empties `editorSelectionMany` (which
   * nulls the primary too). Used by the chat input's selection badge.
   */
  const handleClearSelection = useCallback(async () => {
    useEditorStore.getState().setEditorSelectionMany([])
    const adapter = adapterRef.current
    if (adapter) {
      await adapter.clearSelection()
    } else {
      useEditorStore.getState().setEditorSelection(null)
    }
  }, [])

  // Escape DESELECTS COMPLETELY (Mo's decision 2026-08-04). This SHELL-level
  // listener is the path a real keypress actually takes: the bridge prevents
  // focus on iframe mousedown (so clicking the prototype never moves keyboard
  // focus into the iframe), which means Escape lands in the shell document —
  // the bridge's own Escape handler only covers the rare iframe-focused case.
  // Guards: typing surfaces and open dialogs own their Escape; only act when
  // something is actually selected.
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (
        t?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return
      }
      const store = useEditorStore.getState()
      if (!store.editorSelection && store.editorSelectionMany.length === 0) {
        return
      }
      void handleClearSelection()
    }
    window.addEventListener("keydown", onKeydown)
    return () => window.removeEventListener("keydown", onKeydown)
  }, [handleClearSelection])

  const handleLayerSelect = useCallback(async (selector: string) => {
    const adapter = adapterRef.current
    if (!adapter) return
    // `__desde-group__…` is a non-resolving sentinel (see
    // layers-conditional-groups.ts) — dispatching it to selectBySelector
    // would just produce a harmless-but-useless
    // ELEMENT_INSPECTION_UNRESOLVED. Select the group's first real child
    // instead; no-op when it has none.
    if (isGroupSelector(selector)) {
      const childSelector = findGroupFirstChildSelector(layersRoots, selector)
      if (!childSelector) return
      await adapter.selectBySelector(childSelector)
      return
    }
    await adapter.selectBySelector(selector)
  }, [layersRoots])

  const handleLayerHover = useCallback((selector: string | null) => {
    adapterRef.current?.previewHighlight(selector)
  }, [])

  const handleLayerMove = useCallback(
    (
      payload: LayersMovePayload,
      skipIterationCheck: boolean = false,
    ) => {
      const { source, destParent, destIndex } = payload
      const adapter = adapterRef.current
      if (!adapter || !source.editTarget || !destParent.editTarget) {
        return
      }
      if (!skipIterationCheck && source.iterationContext) {
        if (
          interceptIterationEditRef.current?.({
            editKind: "move",
            payload,
            iterationContext: source.iterationContext,
          })
        ) {
          return
        }
      }
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "move",
        id,
        target: {
          targetId: source.selector,
          selector: source.selector,
          componentName: source.name,
          componentFile: source.componentFile,
          packageName: source.packageName,
          editTarget: source.editTarget,
        },
        destination: {
          parentId: destParent.selector,
          index: destIndex,
          parentEditTarget: destParent.editTarget,
        },
        // Conditional-GROUP move: source is a synthetic layers-panel row
        // (see layers-conditional-groups.ts) whose editTarget is the
        // v-if/v-for HEAD wrapper — the applicator relocates the whole
        // branch chain as a unit. See MoveEdit.moveGroup.
        ...(source.conditionalGroup ? { moveGroup: true } : {}),
      }
      // The edit lands in the working tree immediately; Vite HMR shows the
      // truthful preview. Errors surface via saveStatus. On deterministic
      // refusal we auto-fire the LLM repair lane (same endpoint the manual
      // retry hits) so cycle / coordinate-drift refusals don't dead-end the
      // user.
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Move", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  /**
   * Direct-manipulation drag-to-move (Phase 2). The bridge's DragMoveOverlay
   * emits a DRAG_MOVE_COMMITTED on drop; the adapter forwards it here. Build
   * the SAME `move` StructuralEdit handleLayerMove builds (from source +
   * destParent editTargets + index) and dispatch through the worktree path —
   * reusing apply-move-edit, no new applicator. Cross-file / v-for edge cases
   * refuse gracefully via setSaveStatus (the applicator's same-file guard),
   * same as the Layers-panel drag.
   */
  const handleDragMove = useCallback((move: DragMoveRequest) => {
    const adapter = adapterRef.current
    if (!adapter) return
    // Refuse iterated (v-for/map) source OR destination: a plain move would
    // rewrite the shared loop template for EVERY row (codex). Iterated moves
    // need the iteration-scope intercept the Layers-panel drag provides.
    if (move.sourceIsIterated || move.destIsIterated) {
      setSaveStatus(
        "Drag-move involving a repeated (v-for) element isn't supported yet. Use the Layers panel to move it with a scope choice.",
      )
      return
    }
    // Same-file only (apply-move-edit's contract). A cross-file drop (the common
    // slot / component-internal case where the resolved destination lives in a
    // different SFC) must refuse cleanly here — NOT fall into the LLM-repair
    // path, which could drop the destination anchor and rewrite the source file
    // (codex P1). Matches the documented slotted-reorder limitation.
    if (move.sourceEditTarget.file !== move.destParentEditTarget.file) {
      setSaveStatus(
        "Can't drag-move across files (the drop landed in another component's source). Use the Layers panel for cross-file / slotted moves.",
      )
      return
    }
    const id = makeEditId()
    const edit: StructuralEdit = {
      kind: "move",
      id,
      target: {
        targetId: move.sourceSelector,
        selector: move.sourceSelector,
        editTarget: move.sourceEditTarget,
      },
      destination: {
        parentId: move.destParentSelector,
        index: move.destIndex,
        parentEditTarget: move.destParentEditTarget,
      },
    }
    // Drag-move dispatches immediately, like every other edit (branch mode
    // is the only editor edit substrate).
    void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
      const outcome = describeEditOutcome("Move", result, fallback)
      if (outcome.message) setSaveStatus(outcome.message)
    })
  }, [])

  const handleLayerMoveRefused = useCallback((reason: LayersDropRefusal) => {
    // The layers panel silently rejects most invalid drops (returns false
    // from handleDragOver, no-ops in handleDrop). Without surfacing the
    // reason, designers see "dragging does nothing" with zero feedback.
    // Translate each refusal into a one-liner the pending-changes-panel
    // banner can show — same channel used by deterministic edit failures.
    const message =
      reason === "no-source-location"
        ? "Can't drag this element: it has no source mapping (not authored in this prototype's repo, or the framework adapter didn't tag it)."
        : reason === "no-parent-source-location"
          ? "Can't drop here: the destination's parent has no source mapping."
          : reason === "different-file"
            ? "Can't drop here: source and destination live in different files (cross-file moves aren't supported yet)."
            : reason === "self-or-descendant"
              ? "Can't drop an element into itself or one of its descendants."
              : reason === "no-parent"
                ? "Can't drop here: no valid parent container."
                : reason === "unmapped-row"
                  ? "Can't move this row: it isn't in the unfiltered tree, so the new position can't be counted. Switch the Structure detail to Everything and try again."
                  : `Drag/drop refused: ${reason}`
    setSaveStatus(message)
    console.info("[Editor] Drag/drop refused:", reason)
  }, [])

  // Phase F4 — Edit component flow. Tracks whether the iframe is
  // currently navigated to the F3 isolation route, plus the URL we
  // came from so "Exit" returns the designer to where they were.
  const [componentEditState, setComponentEditState] = useState<{
    componentFile: string
    componentName: string
    returnUrl: string
  } | null>(null)

  const handleEditComponent = useCallback(async () => {
    const selection = useEditorStore.getState().editorSelection
    if (!selection?.componentName) {
      console.warn(
        "[Editor] EditComponent requires selection.componentName",
      )
      return
    }
    const iframe = iframeRef.current
    if (!iframe) return
    // Cross-origin iframes block parent reads of `contentWindow.location.href`
    // (browsers throw SecurityError). Use the parent-set `iframe.src`
    // instead — it's readable cross-origin since it's a parent attribute.
    // For SPA navigation inside the iframe, `iframe.src` won't reflect
    // the current path, but it's the best the parent can see.
    const currentUrl = iframe.src || prototypeUrl

    // Storybook-style intent: render the component once per variant
    // (boolean axes / enum props) so the designer sees a grid rather
    // than a single mount with parent-page props. We fetch the
    // catalog shell-side and pass cells via `?variants=` — keeps the
    // substrate plugin thin (no cross-origin fetch from the iframe).
    //
    // Fetch failures are non-fatal: navigate anyway with empty
    // variants. The plugin's empty-state placeholder is a clearer
    // failure mode than blocking navigation.
    let cellsJson = "[]"
    let catalogEntry: CatalogEntry | undefined
    try {
      const res = await editorFetch("/api/editor/catalog", { cache: "no-store" })
      if (res.ok) {
        const catalog = (await res.json()) as CatalogEntry[]
        // Match by name first (works for design-system components
        // whose catalog `file` field points at a type declaration,
        // not the importable SFC), fall back to file for first-party
        // components where two SFCs might share a name.
        catalogEntry =
          catalog.find((e) => e.name === selection.componentName) ??
          (selection.componentFile
            ? catalog.find((e) => e.file === selection.componentFile)
            : undefined)
        if (catalogEntry) {
          const cells = buildVariantCells(
            catalogEntry.variantHints,
            catalogEntry.name,
          )
          cellsJson = JSON.stringify(cells)
        }
      }
    } catch {
      // Non-fatal — navigate with empty variants.
    }

    // Determine the import spec for the substrate plugin:
    // - Design-system entry with packageName → import the named export
    //   from the package (e.g. `import { UiButton } from '@acme/design-system'`).
    // - Otherwise → import the SFC from its file path.
    //
    // Without a usable spec (no packageName AND no componentFile), we
    // can't open the isolation route. This is rare — happens only when
    // the manifest source returns no file *and* no importPath.
    let spec: string | null = null
    let exportName: string | null = null
    if (catalogEntry?.isDesignSystem && catalogEntry.packageName) {
      spec = catalogEntry.packageName
      exportName = catalogEntry.name
    } else if (selection.componentFile && !selection.componentFile.includes("node_modules")) {
      spec = selection.componentFile
    } else if (catalogEntry?.file && !catalogEntry.file.includes("node_modules")) {
      spec = catalogEntry.file
    }
    if (!spec) {
      console.warn(
        "[Editor] EditComponent: no usable import spec for",
        selection.componentName,
      )
      window.alert(
        "Could not resolve an import path for this component. The component manifest needs either a package name (importPath) or a first-party file location.",
      )
      return
    }

    // Encode all parameters in path segments — NO query string. Vite's
    // transformIndexHtml-html-proxy mechanism appends `?html-proxy&
    // index=N` to the page URL, which yields a malformed URL (two `?`)
    // when the page already has a query. The resulting inline scripts
    // never load and the canvas stays blank. Path-only avoids this.
    //
    // Config is base64url-encoded JSON: `{ name?, variants? }`.
    const config: { name?: string; variants?: unknown[] } = {}
    if (exportName) config.name = exportName
    try {
      config.variants = JSON.parse(cellsJson)
    } catch {
      config.variants = []
    }
    const configJson = JSON.stringify(config)
    const configB64 = encodeBase64Url(configJson)

    // Build the F3 isolation URL relative to the iframe's current
    // origin so it shares the same host (and bridge injection).
    let target: string
    try {
      const u = new URL(currentUrl)
      u.pathname =
        "/__compose/component/" +
        encodeURIComponent(spec) +
        "/" +
        configB64
      u.search = ""
      u.hash = ""
      target = u.toString()
    } catch {
      console.warn("[Editor] Could not parse iframe URL:", currentUrl)
      return
    }
    setComponentEditState({
      componentFile: selection.componentFile ?? spec,
      componentName: selection.componentName,
      returnUrl: currentUrl,
    })
    // Setting `iframe.src` is the cross-origin-safe navigation primitive
    // (parents can write to a child's location even though they can't
    // read it). `contentWindow.location.assign` would also work for
    // navigation specifically — but using `.src` is more explicit
    // about staying on the parent-side API.
    iframe.src = target
  }, [iframeRef, prototypeUrl])

  const handleExitComponentEdit = useCallback(() => {
    const state = componentEditState
    setComponentEditState(null)
    const iframe = iframeRef.current
    if (!iframe || !state) return
    iframe.src = state.returnUrl
  }, [componentEditState, iframeRef])

  // Phase F2 — Swap component flow. The dialog handles fetching the
  // catalog and computing the prop mapping; this just opens the dialog
  // and, on confirm, dispatches a SwapEdit through the adapter.
  const [swapDialogOpen, setSwapDialogOpen] = useState(false)
  const handleSwap = useCallback(() => {
    const selection = useEditorStore.getState().editorSelection
    if (!selection?.componentName || !selection.editTarget) {
      console.warn(
        "[Editor] Swap requires selection.componentName + editTarget",
      )
      return
    }
    setSwapDialogOpen(true)
  }, [])

  const handleSwapConfirm = useCallback(
    (params: {
      toComponentName: string
      toPackageName?: string
      toFile?: string
      propMapping: Record<string, string | null>
      newComponentRequiredProps: string[]
    }) => {
      setSwapDialogOpen(false)
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection?.componentName || !selection.editTarget) {
        return
      }
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "swap",
        id,
        target: selection,
        fromComponentName: selection.componentName,
        toComponentName: params.toComponentName,
        propMapping: params.propMapping,
        newComponentRequiredProps: params.newComponentRequiredProps,
        toPackageName: params.toPackageName,
        toFile: params.toFile,
        // V1 doesn't auto-detect "no other call-sites" — leave the old
        // import in place. Designer can clean up after.
        removeFromImport: false,
      }
      // Immediate dispatch (see Move handler).
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Swap", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  // Icon picker — dispatches a SwapEdit (kind: 'swap') with identity
  // prop mapping. Reuses the existing swap pipeline end-to-end; the
  // only icon-specific bit is `propMapping = {}` (props are stable
  // across an icon set) and the label format. `removeFromImport` is
  // left false to match other structural edits — clearing the old
  // import is unsafe without a cross-file usage walk.
  //
  // Branch mode (matches handleLayerMove / handleLayerInsert): immediate
  // dispatch via `applyEditWithLLMFallback`. Edit lands in the working
  // tree instantly (uncommitted); Vite HMR re-renders the iframe with the
  // new icon. No buffer, no DOM-overlay lie. Commit stages the working
  // tree separately.
  //
  // Stale-stamp caveat (audit Task 23 widened the server's `data-desde-v`
  // guard to the structural kinds, swap included). `scheduleSelectionStampRefresh`
  // — the post-HMR re-read that keeps a stamp current — is wired ONLY into
  // `dispatchBranchTextMutation` and `dispatchBranchPropEdit`. So:
  //   - Layers-panel-driven edits re-stamp on their own, via
  //     `onTreeUpdate` → `refreshLayers()` (tree entries carry their own
  //     fileHash).
  //   - Edits dispatched off `editorSelection` — this one — do NOT. The
  //     open selection keeps its PRE-write `editTarget.fileHash`, so a
  //     second pick against the same selection can 409 `stale-target` until
  //     the user re-inspects (click the element again).
  // Degraded, not broken: the refusal is loud and re-selection clears it.
  const handlePickIcon = useCallback(
    (
      _sourceId: string,
      icon: IconManifest,
      override?: { fromComponentName?: string; bridgeSelector?: string },
    ) => {
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      // When the user clicked an SVG child of an icon, selection.componentName
      // is empty (selectedAsElement). The inspector hints the resolved icon
      // via override.fromComponentName; we use that as the fallback. Without
      // this, the click would early-return silently.
      const fromName = override?.fromComponentName ?? selection?.componentName
      if (!adapter || !fromName || !selection?.editTarget) return

      if (icon.ref.kind !== "named-component-import") {
        console.warn(
          `[Editor] icon picker V1 only supports named-component-import refs (got ${icon.ref.kind})`,
        )
        return
      }

      // No-op guard: clicking the currently-selected icon shouldn't
      // buffer a self-swap. The applicator would succeed (splice the
      // same tag back) but produces no diff.
      if (icon.ref.exportName === fromName) return

      const newId = makeEditId()
      const exportName = icon.ref.exportName
      const importPath = icon.ref.importPath
      const edit: StructuralEdit = {
        kind: "swap",
        id: newId,
        target: selection,
        fromComponentName: fromName,
        toComponentName: exportName,
        propMapping: {},
        toPackageName: importPath,
        removeFromImport: false,
      }
      // Immediate dispatch. The structural edit pipeline writes to the SFC;
      // Vite HMR re-renders the iframe. The bridge re-inspects the new tree
      // and selection updates to the swapped-in icon, so a subsequent pick
      // sees the right fromComponentName naturally — no buffering or replace
      // logic needed.
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Icon swap", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  const handleDetach = useCallback(() => {
    const adapter = adapterRef.current
    const selection = useEditorStore.getState().editorSelection
    if (!adapter || !selection?.componentName || !selection.componentFile) {
      return
    }
    if (!selection.editTarget) {
      console.warn(
        "[Editor] Detach requires an editTarget; element not tagged by data-desde-src",
      )
      return
    }
    const id = makeEditId()
    const edit: StructuralEdit = {
      kind: "detach",
      id,
      target: selection,
      componentFile: selection.componentFile,
    }
    // Immediate dispatch (see Move handler).
    void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
      const outcome = describeEditOutcome("Detach", result, fallback)
      if (outcome.message) setSaveStatus(outcome.message)
    })
  }, [])

  // Layers-panel insert (right-click → "Insert child…"). Targets a
  // specific OutlineNode as the destination PARENT and buffers an
  // InsertEdit. The bridge shows a labeled placeholder where the new
  // element will land; the actual file write happens on Save.
  const handleLayerInsert = useCallback(
    (parentNode: OutlineNode, snippet: string, destIndex = -1) => {
      const adapter = adapterRef.current
      if (!adapter || !parentNode.editTarget) return
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "insert",
        id,
        target: {
          targetId: parentNode.selector,
          selector: parentNode.selector,
          componentName: parentNode.name,
          componentFile: parentNode.componentFile,
          packageName: parentNode.packageName,
          editTarget: parentNode.editTarget,
        },
        destIndex,
        snippet,
      }
      // Immediate dispatch (see Move handler).
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Insert", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  // Phase 3 — insert-at-point: the pending palette snippet while the bridge is
  // in click-to-place mode, consumed by the onInsertAtPoint subscription
  // below. The entry point that used to populate this (a palette UI calling
  // `adapter.enterInsertPlacement` and stashing the snippet here) was never
  // built — see the dead-surface deletion in share-readiness Phase 3 Batch
  // A — so this currently always reads back `null`. Left in place (with
  // `handleInsertAtPoint` and its `onInsertAtPoint` subscription) as the
  // live response half of the round trip for whenever a placement UI wires
  // `adapter.enterInsertPlacement` back up.
  const insertPlacementRef = useRef<{
    snippet: string
    contentKind: "element" | "text"
  } | null>(null)

  /**
   * Phase 3 — the bridge resolved an insert-at-point placement click. Insert
   * the pending snippet into the resolved container. Refuse iterated (v-for)
   * containers (would add to every row) — same posture as drag-move.
   */
  const handleInsertAtPoint = useCallback(
    (req: InsertAtPointRequest) => {
      const pending = insertPlacementRef.current
      insertPlacementRef.current = null
      if (!pending) return
      if (req.parentIsIterated) {
        setSaveStatus(
          "Can't insert into a repeated (v-for) element: pick a non-repeated container or use chat.",
        )
        return
      }
      const adapter = adapterRef.current
      if (!adapter) {
        setSaveStatus("Select a container element first.")
        return
      }
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "insert",
        id,
        target: {
          targetId: req.parentSelector,
          selector: req.parentSelector,
          editTarget: req.parentEditTarget,
        },
        destIndex: req.destIndex,
        snippet: pending.snippet,
        contentKind: pending.contentKind,
      }
      // Immediate dispatch (see Move handler).
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Insert", result, fallback)
        // Deviation from the common outcome shape (see edit-outcome.ts):
        // insert-at-point only surfaces FAILURES, never an "applied via AI
        // repair" success message — preserved from the pre-extraction
        // behavior, not normalized away.
        if (outcome.kind === "failed") setSaveStatus(outcome.message)
      })
    },
    [],
  )

  // Dispatches a DeleteEdit immediately (branch mode — see Move handler)
  // at the chosen scope. Shared by the direct path (element not inside a
  // reused component) and the scope-prompt path (`confirmDeleteScope`).
  const dispatchDeleteEdit = useCallback(
    (node: OutlineNode, scope: "definition" | "callsite") => {
      const adapter = adapterRef.current
      if (!adapter) return
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "delete",
        id,
        scope,
        target: {
          targetId: node.selector,
          selector: node.selector,
          componentName: node.name,
          componentFile: node.componentFile,
          packageName: node.packageName,
          authoredAt: node.authoredAt,
          editTarget: node.editTarget,
          isLibrary: node.isLibrary,
        },
      }
      // Immediate dispatch (see Move handler). The load-bearing payoff of
      // editing in place — `:last-child` and other structural CSS recompute
      // against the real new DOM (the source changed and Vite HMR'd), not
      // against a `display:none` overlay that lies about the tree.
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Delete", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  // Layers-panel delete (right-click → "Delete"). When the element lives
  // inside a reused component (editTarget.file !== authoredAt.file),
  // prompt the designer for scope (this usage vs. the component
  // definition) before buffering; otherwise buffer immediately.
  const handleLayerDelete = useCallback(
    (node: OutlineNode) => {
      if (!adapterRef.current || !node.authoredAt) return
      // Iteration check first — a v-for'd element shares its data-desde-src
      // with N siblings, so a definition-scope delete would wipe every
      // row. Route through the iteration-scope dialog instead.
      //
      // Codex round-2 P1: the layers-panel right-click "Delete" doesn't
      // select the row first, so `editorSelection` may be null. We
      // synthesize a Selection-shaped wrapper from the OutlineNode in
      // that case — the dispatcher only reads selector + editTarget /
      // authoredAt off it for the iteration intent, both of which the
      // node carries.
      if (node.iterationContext) {
        const live = useEditorStore.getState().editorSelection
        const selectionForIntent: Selection =
          live ??
          ({
            targetId: node.selector,
            selector: node.selector,
            componentName: node.name,
            componentFile: node.componentFile,
            packageName: node.packageName,
            authoredAt: node.authoredAt,
            editTarget: node.editTarget,
            isLibrary: node.isLibrary,
            iterationContext: node.iterationContext,
            ancestry: [],
          } as Selection)
        if (
          interceptIterationEditRef.current?.({
            editKind: "delete",
            selection: selectionForIntent,
            node,
            iterationContext: node.iterationContext,
          })
        ) {
          return
        }
      }
      // Prompt for scope only when the callsite is a distinct file
      // from the definition — same-file means the two scopes would
      // produce identical edits.
      const distinctCallsite =
        !!node.editTarget &&
        !!node.authoredAt &&
        node.editTarget.file !== node.authoredAt.file
      if (distinctCallsite) {
        setDeleteScopePrompt({ node })
        return
      }
      dispatchDeleteEdit(node, "definition")
    },
    [dispatchDeleteEdit],
  )

  // Layers-panel unwrap (right-click → "Unwrap"). Dissolves a wrapper
  // element — the wrapper's tags are removed and its children become
  // siblings of the wrapper's former parent. Buffered; the bridge
  // previews by relocating the children in DOM.
  const handleLayerUnwrap = useCallback((node: OutlineNode) => {
    const adapter = adapterRef.current
    if (!adapter || !node.editTarget) return
    const id = makeEditId()
    const edit: StructuralEdit = {
      kind: "unwrap",
      id,
      target: {
        targetId: node.selector,
        selector: node.selector,
        componentName: node.name,
        componentFile: node.componentFile,
        packageName: node.packageName,
        editTarget: node.editTarget,
      },
    }
    // Immediate dispatch (see Move handler).
    void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
      const outcome = describeEditOutcome("Unwrap", result, fallback)
      if (outcome.message) setSaveStatus(outcome.message)
    })
  }, [])

  // Layers-panel flatten-conditional. Collapses a v-if chain down to a
  // single chosen branch. V1 only exposes "this branch" (v-if itself,
  // branchToKeep=0) and "else branch" (branchToKeep="else") in the
  // submenu; multi-else-if chains can still be flattened via the agent
  // tier when that ships. Buffered; bridge shows a labeled badge.
  const handleLayerFlattenConditional = useCallback(
    (node: OutlineNode, branchToKeep: number | "else") => {
      const adapter = adapterRef.current
      if (!adapter || !node.editTarget) return
      const id = makeEditId()
      const edit: StructuralEdit = {
        kind: "flatten-conditional",
        id,
        target: {
          targetId: node.selector,
          selector: node.selector,
          componentName: node.name,
          componentFile: node.componentFile,
          packageName: node.packageName,
          editTarget: node.editTarget,
        },
        branchToKeep,
      }
      // Immediate dispatch (see Move handler).
      void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
        const outcome = describeEditOutcome("Flatten", result, fallback)
        if (outcome.message) setSaveStatus(outcome.message)
      })
    },
    [],
  )

  // Layers-panel detach (right-click → "Detach component"). Same buffer
  // semantics as handleDetach but targets an arbitrary OutlineNode the
  // designer hovered rather than the current selection.
  const handleLayerDetach = useCallback((node: OutlineNode) => {
    const adapter = adapterRef.current
    if (!adapter || !node.componentFile || !node.editTarget) return
    const id = makeEditId()
    const edit: StructuralEdit = {
      kind: "detach",
      id,
      target: {
        targetId: node.selector,
        selector: node.selector,
        componentName: node.name,
        componentFile: node.componentFile,
        packageName: node.packageName,
        editTarget: node.editTarget,
      },
      componentFile: node.componentFile,
    }
    // Immediate dispatch (see Move handler).
    void applyEditWithLLMFallback(edit, adapter).then(({ result, fallback }) => {
      const outcome = describeEditOutcome("Detach", result, fallback)
      if (outcome.message) setSaveStatus(outcome.message)
    })
  }, [])

  // Prop edits accumulate here. The bridge gets an APPLY_PROP_OVERRIDE /
  // APPLY_ATTR_OVERRIDE for each so the iframe shows the change live; a
  // debounced per-(selector,propName) dispatch then writes each to the
  // working tree (see `dispatchBranchPropEdit` below), mirroring the
  // text path — the buffer is the always-latest source the dispatch
  // reads.
  const [pendingPropEdits, setPendingPropEdits] = useState<PropEdit[]>([])
  // Tracks which buffered edits target a fallthrough attribute rather
  // than a typed prop, so revert can re-issue the right override.
  // The PropEdit.target only carries SelectionTarget (no live props
  // map), so the routing decision can't be re-derived later — capture
  // it at edit time.
  const attrEditIdsRef = useRef<Set<string>>(new Set())
  // Manifest dom-hint captured at buffer time (from `attribute()`'s
  // `renders`, when the edit was routed through attribution) — the L2
  // value-oracle read-back target for Tier-2 verification. Keyed by
  // edit id, same lifecycle as `attrEditIdsRef`: set when buffered (only
  // when a hint was resolved), deleted when the buffered entry is
  // actually removed (settled write or needsChat escalation). Absent
  // means "no manifest coverage for this edit" — `dispatchBranchPropEdit`
  // passes no `domField`, `deriveExpectation` declines, and the outcome is
  // `skipped` (releases exactly like today, no regression).
  const pendingPropRenderSitesRef = useRef<Map<string, RenderSite>>(new Map())

  // ── Branch-mode prop dispatch (mirrors the dom-text path) ───────────────
  // Always-latest mirror of `pendingPropEdits` so the debounced dispatch
  // reads the freshest buffered value from inside a setTimeout callback.
  const pendingPropEditsRef = useRef<PropEdit[]>([])
  pendingPropEditsRef.current = pendingPropEdits
  // Per-(selector,propName) debounce timers + in-flight set, same shape as the
  // dom-text dispatch. Key built by `propEditKey`.
  const branchPropDispatchTimers = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map())
  const branchPropInFlight = useRef<Set<string>>(new Set())
  /** One-shot stale-target recovery guard, keyed like branchPropInFlight.
   *  Cleared on a successful dispatch; prevents 409→refresh→409 loops. */
  const staleRetriedRef = useRef<Set<string>>(new Set())
  /**
   * Override ids whose dispatch is currently awaiting the server. The
   * OVERRIDE_UNVERIFIED status is suppressed for these: the store's 5s
   * timeout routinely fires DURING a long dispatch (the AI fallback can
   * take up to ~90s), and "not yet confirmed" is misleading while the
   * request is still in flight — in-flight is the expected state.
   */
  const inFlightOverrideIdsRef = useRef<Set<string>>(new Set())
  const propEditKey = (selector: string, propName: string): string =>
    `${selector}\u0000${propName}`
  // Hoisted ref so `dispatchAllRowsPropEdit` (defined above the dispatcher)
  // can schedule it without a TDZ/circular-callback dance — same pattern as
  // `dispatchBranchTextMutationRef` / `handleSaveAllRef`.
  const dispatchBranchPropEditRef = useRef<
    ((key: string) => void) | null
  >(null)
  // Schedule the debounced auto-commit of a buffered prop edit to the working
  // tree. EVERY write to `pendingPropEdits` must call this — the buffer is the
  // live transient the debounced dispatch reads, not a save-time flush queue.
  // Skip scheduling when a dispatch for this identity is already in flight; its
  // completion re-fires if the buffer advanced meanwhile.
  const scheduleBranchPropDispatch = useCallback(
    (selector: string, propName: string) => {
      const key = propEditKey(selector, propName)
      if (branchPropInFlight.current.has(key)) return
      const existing = branchPropDispatchTimers.current.get(key)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        branchPropDispatchTimers.current.delete(key)
        dispatchBranchPropEditRef.current?.(key)
      }, BRANCH_PROP_DISPATCH_DEBOUNCE_MS)
      branchPropDispatchTimers.current.set(key, timer)
    },
    [],
  )

  // Set to true whenever a chat-applied edit writes to the working tree on
  // disk (either the SDK wrote it via `appliedByAgent`, or the shell wrote
  // it via `adapter.applyEdit`). Read+cleared by `handleChatTurnComplete`
  // at end-of-turn to fire a single iframe hard-reload covering every edit
  // the agent made during the turn.
  //
  // Vite HMR alone is not reliable enough here (same suspected causes
  // documented above `iframe.src = iframe.src` in handleSaveAll: race
  // between fs.writeFile and chokidar, stale HMR sockets, etc.).
  // Without this safety net, the agent's "added the field" reply
  // doesn't reflect in the live preview until the user manually saves,
  // which contradicts branch mode's edit model (edits land on disk
  // immediately, uncommitted; Commit records them as a commit, it does
  // not write anything new).
  const chatTurnDirtyRef = useRef(false)

  // Set when the designer triggers a delete on an element that lives inside a
  // reused component — `handleLayerDelete` defers buffering until they pick a
  // scope via the DeleteScopeDialog (`confirmDeleteScope` / `cancelDeleteScope`).
  const [deleteScopePrompt, setDeleteScopePrompt] = useState<{
    node: OutlineNode
  } | null>(null)

  // Iteration-scope prompt (Phase 2 of tasks/_archive/one-shot-tasks/iteration-aware-edits.md).
  // When a structural edit fires on an element rendered by a framework loop
  // (`selection.iterationContext` set), we hold the edit payload here while
  // the IterationScopeDialog asks the user "this row" vs "all rows."
  //
  // `PendingIterationEdit` is a tagged union over edit kinds — each variant
  // carries enough state to (a) route to today's path on "all-rows" without
  // re-collecting inputs, and (b) build an iteration-data intent on
  // "this-row." Adding a new edit kind = adding a variant.
  const [iterationScopePrompt, setIterationScopePrompt] =
    useState<PendingIterationEdit | null>(null)
  // Per-edit-kind remembered scope. Cleared on hook unmount; not persisted
  // across reloads (v1 — the dialog's "Remember for this session" checkbox).
  const iterationScopeMemoryRef = useRef<
    Partial<Record<IterationEditKind, IterationScope>>
  >({})
  // Ref-based dispatcher so the early-defined edit handlers (handleLayerMove
  // at line ~300, handlePropEdit at line ~900) can route an iterated edit
  // through interceptIterationEdit (defined far below) without falling into
  // the temporal-dead-zone trap. The ref is updated by a useEffect once the
  // real dispatcher closes over its latest deps; handlers read
  // `interceptIterationEditRef.current?.(pending)`.
  const interceptIterationEditRef = useRef<
    ((pending: PendingIterationEdit) => boolean) | null
  >(null)

  /**
   * Buffer a PropEdit against an explicit selection — used both by
   * `handlePropEdit` (live selection) and `dispatchIterationEdit`
   * "all-rows" path (captured pending selection). Splitting this out
   * (Codex P1 #4) is what lets the all-rows path apply against the
   * row the user clicked on, even if their selection has since moved.
   */
  const dispatchAllRowsPropEdit = useCallback(
    (
      selection: Selection,
      propName: string,
      value: PropControlValue,
      // Manifest dom-hint for this edit, when the caller resolved one via
      // `attribute()` (see `handleEditTextField`). Absent for edits that
      // didn't go through attribution (Props panel, agent proposals,
      // iteration all-rows re-entry) — those keep today's skip-and-release
      // behavior.
      renderSite?: RenderSite,
    ) => {
      const adapter = adapterRef.current
      if (!adapter) return
      const edit: PropEdit = {
        kind: "prop",
        id: makeEditId(),
        target: selection,
        propName,
        value,
      }
      if (renderSite) {
        pendingPropRenderSitesRef.current.set(edit.id, renderSite)
      }
      setPendingPropEdits((prev) => {
        // Last-write-wins per (selector, propName). Multiple debounced
        // edits on the same prop collapse to one buffered entry.
        const filtered = prev.filter(
          (e) =>
            !(
              e.target.selector === selection.selector &&
              e.propName === propName
            ),
        )
        return [...filtered, edit]
      })
      const isTypedProp =
        selection.currentProps && propName in selection.currentProps
      const isAttr =
        !isTypedProp &&
        selection.currentAttrs &&
        propName in selection.currentAttrs
      if (isAttr) {
        attrEditIdsRef.current.add(edit.id)
        // WS3: same overrideId correlation as the prop branch below.
        adapter.applyAttrOverride(selection.selector, propName, value, edit.id)
      } else {
        attrEditIdsRef.current.delete(edit.id)
        // WS3: overrideId === the buffered PropEdit's own id, so
        // `dispatchBranchPropEdit`'s later resolveOverride (keyed off
        // `current.id`) correlates back to this exact bridge override.
        adapter.applyPropOverride(selection.selector, propName, value, edit.id)
      }
      // The override above is just the instant preview; the debounced
      // source write + HMR is the truthful render.
      scheduleBranchPropDispatch(selection.selector, propName)
    },
    [scheduleBranchPropDispatch],
  )

  const handlePropEdit = useCallback((
    propName: string,
    value: PropControlValue,
    skipIterationCheck: boolean = false,
    // See `dispatchAllRowsPropEdit` — forwarded from `handleEditTextField`'s
    // attribution-routed "same call site" branch. Lost on the iteration-
    // dialog detour (PendingIterationEdit's "prop" variant doesn't carry
    // it); that's a deliberate fail-safe scope limit, not a regression —
    // v-for prop edits simply keep today's skip-and-release behavior.
    renderSite?: RenderSite,
  ) => {
    const adapter = adapterRef.current
    const selection = useEditorStore.getState().editorSelection
    if (!adapter || !selection) return
    if (!skipIterationCheck && selection.iterationContext) {
      if (
        interceptIterationEditRef.current?.({
          editKind: "prop",
          selection,
          propName,
          value,
          iterationContext: selection.iterationContext,
        })
      ) {
        return
      }
    }
    dispatchAllRowsPropEdit(selection, propName, value, renderSite)
  }, [dispatchAllRowsPropEdit])

  const handleEditTextField = useCallback(
    (field: EditableTextField, value: string) => {
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection) return
      // Phase 3 Stage A: manifest-first attribution routing. For
      // override-candidate fields, consult attribute() (over the prewarmed
      // lookup) and route a resolved direct/prop edit at its
      // manifest-grounded call site. Every other outcome — slot,
      // cross-file, llm, refuse — returns `fallback`, leaving the legacy
      // dispatch below to run unchanged (refuse-fallback is the
      // load-bearing path for plain template content).
      const attributionCtx = selection.attributionContext
      if (attributionCtx && isAttributionOverrideCandidate(field)) {
        const attributionResult = attribute(attributionCtx, attributionLookup)
        const decision = routeAttributionResult(attributionResult)
        // Advisory-only: compute + report structural drift signals from the
        // SAME inputs/output attribute() just produced. Never influences
        // `decision` or the dispatch below — a detection or reporting
        // failure must never affect attribution or the edit itself. Shared
        // with the inspection-time call site in the selection-change
        // handler above — see `reportDriftForAttribution`'s doc comment.
        reportDriftForAttribution(attributionCtx, attributionResult)
        if (decision.kind === "prop-edit") {
          let coercedAttr: PropControlValue = value
          if (decision.valueType === "number") {
            const n = Number(value)
            if (Number.isFinite(n)) coercedAttr = n
          } else if (decision.valueType === "boolean") {
            const lower = value.trim().toLowerCase()
            if (lower === "true") coercedAttr = true
            else if (lower === "false") coercedAttr = false
          }
          // Preserve legacy iteration semantics. When attribute() resolves
          // to the SAME call site the selection already edits (a
          // same-component prop), route through handlePropEdit so a v-for
          // selection still gets the "this row vs all rows" intercept —
          // dispatchAllRowsPropEdit would force an all-rows template edit
          // and skip the prompt (codex P1). When it resolves to a
          // DIFFERENT call site (ancestor / cross-component), dispatch
          // directly at that loc, mirroring the legacy `field.editTarget`
          // branch which intentionally skips the leaf's iteration intercept
          // (the leaf's iterationContext doesn't apply to the ancestor).
          const sel = selection.editTarget
          const sameCallSite =
            !!sel &&
            sel.file === decision.targetFile &&
            sel.line === decision.line &&
            sel.column === decision.column
          if (sameCallSite) {
            handlePropEdit(
              decision.propName,
              coercedAttr,
              /* skipIterationCheck */ false,
              decision.renders,
            )
          } else {
            const target: Selection = {
              ...selection,
              editTarget: {
                file: decision.targetFile,
                line: decision.line,
                column: decision.column,
              },
            }
            dispatchAllRowsPropEdit(
              target,
              decision.propName,
              coercedAttr,
              decision.renders,
            )
          }
          return
        }
        // decision.kind === "fallback" → continue to legacy dispatch.
      }
      if (field.kind === "prop") {
        if (!field.propName) return
        // Coerce the input string back to the prop's original type so
        // apply-prop-edit emits the correct binding form: `:step="1"`
        // (bound number) for number props vs. `step="1"` (string
        // attribute, which Vue would treat as the literal string "1")
        // for string props. Booleans likewise need `:disabled="true"`.
        // Invalid coercions fall back to the original string so the
        // applicator can refuse with a clean message rather than us
        // silently swallowing the input here.
        let coerced: PropControlValue = value
        if (field.valueType === "number") {
          const n = Number(value)
          if (Number.isFinite(n)) coerced = n
        } else if (field.valueType === "boolean") {
          const lower = value.trim().toLowerCase()
          if (lower === "true") coerced = true
          else if (lower === "false") coerced = false
        }
        // Ancestor-prop case: the field carries an explicit
        // `editTarget` pointing at a parent component's `<Tag>` in the
        // consumer SFC (e.g. the rendered "3" inside
        // `<EntityFormBlock :step="3">` surfaces EntityFormBlock's
        // `step` prop with the consumer's tag location). Build a
        // synthetic target so dispatchAllRowsPropEdit writes to the
        // ancestor's call site, not the leaf selection. Iteration
        // intercept is intentionally skipped — the ancestor is rarely
        // inside a v-for relative to the leaf, and the iteration
        // prompt currently keys off the selection's iterationContext
        // which doesn't apply to the ancestor.
        if (field.editTarget) {
          const ancestorTarget: Selection = {
            ...selection,
            editTarget: field.editTarget,
          }
          dispatchAllRowsPropEdit(ancestorTarget, field.propName, coerced)
          return
        }
        // Route through `handlePropEdit` (not directly to
        // `dispatchAllRowsPropEdit`) so v-for iteration edits land in the
        // iteration-scope dialog the same way Variants & Props edits do.
        // Without this, editing a UiLabel inside `v-for` would rewrite the
        // template-level prop and skip the "this row vs all rows" prompt.
        handlePropEdit(field.propName, coerced)
        return
      }
      // dom-text. When the selection is inside a v-for, route through
      // the iteration-scope dialog the same way prop edits do — "this
      // row" patches the data array entry deterministically (see
      // dispatchIterationEdit's dom-text branch), "all rows" rewrites
      // the template literal via the existing
      // setElementText → mutations buffer → applySlotTextEdit path.
      // Without this prompt the bridge would auto-pin "this-instance"
      // (Commit 1's `captureDirectMutationPinned`) which is silently
      // wrong for slot interpolations whose semantics demand a
      // data-array edit, not a template literal rewrite. Skipped for
      // non-iterated elements — same gate as `handlePropEdit`.
      if (selection.iterationContext) {
        if (
          interceptIterationEditRef.current?.({
            editKind: "dom-text",
            selection,
            field,
            value,
            iterationContext: selection.iterationContext,
          })
        ) {
          return
        }
      }
      // Bridge mutates the DOM element's textContent;
      // captureDirectMutationPinned (Commit 1) emits MUTATION_CAPTURED
      // straight through and the entry accumulates in the existing
      // `mutations` log. On Save, ships as part of the llm-patch
      // bundle — applySlotTextEdit handles the deterministic literal
      // case, LLM patch covers the rest. Use the field's own selector
      // when set (slot-text leaves under a composite component — the
      // click landed on the wrapper but the editable text is inside
      // an internal element); fall back to the selection's selector
      // for the plain single-text-leaf case. `textNodeIndex`, when
      // set, targets a specific text-node child so the bridge can
      // mutate slot text alongside sibling elements (icon, tooltip)
      // without nuking them.
      const targetSelector = field.selector ?? selection.selector
      adapter.setElementText(targetSelector, value, field.textNodeIndex)
    },
    [handlePropEdit, dispatchAllRowsPropEdit, attributionLookup, reportDriftForAttribution],
  )

  const handleEditTextBranch = useCallback(
    async (
      branch: import("@/editor/edit-service/detect-text-branches").TextBranch,
      newValue: string,
    ) => {
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection?.editTarget) return
      const id = makeEditId()
      const edit: import("@/editor/core").StructuralEdit = {
        kind: "text-branch",
        id,
        target: {
          targetId: selection.selector,
          selector: selection.selector,
          componentName: selection.componentName,
          componentFile: selection.componentFile,
          packageName: selection.packageName,
          editTarget: selection.editTarget,
        },
        file: selection.editTarget.file,
        byteStart: branch.byteStart,
        byteEnd: branch.byteEnd,
        valueKind: branch.valueKind,
        newValue,
      }
      // text-branch is deterministic-only (in the LLM-fallback helper's
      // exclusion list — there's no useful repair lane for a byte-range
      // splice). Unlike prop/move/insert it ALSO has no bridge preview
      // mechanism: the change only becomes visible to the designer when
      // the file lands on disk and Vite HMR refreshes the iframe. We
      // dispatch directly to disk, surface failures via setSaveStatus, and
      // rely on the inspector's refetch-on-success to keep the OTHER
      // branch's byte ranges from going stale.
      try {
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          setSaveStatus(`Conditional text edit failed: ${result.reason}`)
          return
        }
      } catch (err) {
        setSaveStatus(`Conditional text edit threw: ${(err as Error).message}`)
      }
    },
    [],
  )

  const handleClassesEdit = useCallback((classes: string[]) => {
    const adapter = adapterRef.current
    const selection = useEditorStore.getState().editorSelection
    if (!adapter || !selection) return
    // Resolve every class in the new list to raw CSS declarations on
    // the shell side (using the inspector's known palette + sizing
    // scales). Bridge applies the result as inline `!important` styles
    // so live preview works even when the substrate has no Tailwind
    // (the iframe in our `ai-gateway-prototype` dogfood does not).
    // Classes outside the resolver's coverage produce no entries — the
    // bridge still updates className, so substrates that DO ship the
    // matching CSS keep working.
    const declarations = resolveTailwindClasses(classes)
    adapter.setElementClasses(selection.selector, classes, declarations)
  }, [])

  /**
   * Direct-manipulation drag-to-resize (Phase 4). The bridge's ResizeOverlay
   * emits a quantized width class on handle release; apply it to the selected
   * element by swapping its width utility (remove existing `w-*`, add the new
   * one) through the SAME class-edit path the inspector width control uses —
   * no new applicator. (Defined after handleClassesEdit so it can depend on it.)
   */
  const handleResize = useCallback(
    (req: ResizeRequest) => {
      const selection = useEditorStore.getState().editorSelection
      if (!selection) return
      const classes = selection.classes ?? []
      // Remove BASE and responsive/variant-prefixed width utilities (`w-*`,
      // `md:w-*`, `2xl:w-*`, …). Without clearing the variants, a `md:w-1/2`
      // would keep overriding the new base width at that breakpoint and the
      // resize would look ignored (codex). The dragged width wins. (Excludes
      // `min-w-*`/`max-w-*`, which don't start with a `w-` segment.)
      const widthRe = /^([a-z0-9-]+:)*w-/
      const remove = classes.filter((c) => widthRe.test(c))
      const next = applyClassMutation(classes, { remove, add: [req.widthClass] })
      handleClassesEdit(next)
    },
    [handleClassesEdit],
  )

  // DeleteScopeDialog resolution. `confirmDeleteScope` buffers the deferred
  // DeleteEdit at the chosen scope; `cancelDeleteScope` drops it with no edit.
  const confirmDeleteScope = useCallback(
    (scope: "definition" | "callsite") => {
      if (deleteScopePrompt) dispatchDeleteEdit(deleteScopePrompt.node, scope)
      setDeleteScopePrompt(null)
    },
    [deleteScopePrompt, dispatchDeleteEdit],
  )

  const cancelDeleteScope = useCallback(() => setDeleteScopePrompt(null), [])

  /**
   * Drive a pending iteration edit through the chosen scope. Used by
   * both the dialog confirm path AND the remembered-scope fast path
   * (when the user already picked "this row"/"all rows" for this edit
   * kind earlier in the session). On "all-rows" we run today's
   * applicator; on "this-row" we POST to the LLM fallback and buffer
   * the resulting full-file rewrite as an OverwriteEdit.
   */
  const dispatchIterationEdit = useCallback(
    async (pending: PendingIterationEdit, scope: IterationScope) => {
      if (scope === "all-rows") {
        // Today's behavior — route back to the legacy handler with the
        // same arguments. Each variant has a tiny re-entry point.
        if (pending.editKind === "delete") {
          dispatchDeleteEdit(pending.node, "definition")
        } else if (pending.editKind === "prop") {
          // Codex P1 #4: the legacy prop handler reads
          // `useEditorStore.getState().editorSelection`, which may
          // have drifted between dialog-open and dialog-confirm.
          // Buffer the prop edit directly against the captured
          // selection here instead of re-entering handlePropEdit.
          dispatchAllRowsPropEdit(pending.selection, pending.propName, pending.value)
        } else if (pending.editKind === "move") {
          legacyHandleLayerMoveRef.current?.(pending.payload)
        } else if (pending.editKind === "dom-text") {
          // The intercept short-circuited handleEditTextField before
          // adapter.setElementText was called, so the bridge hasn't
          // mutated yet. Re-enter the dom-text dispatch now that the
          // user confirmed "all rows" — the bridge mutates one DOM
          // element for preview and captureDirectMutationPinned emits
          // MUTATION_CAPTURED. Save-time, applySlotTextEdit rewrites
          // the template literal which Vue re-renders to every row.
          const adapter = adapterRef.current
          if (adapter) {
            if (pending.bridgePendingId) {
              // The bridge already captured this edit and is holding it. Let it
              // through as the shared-template rewrite. Re-typing via
              // setElementText here would emit a SECOND mutation for the same
              // keystroke and leave the first pending forever.
              adapter.resolveMutationDisambiguation(
                pending.bridgePendingId,
                "all-instances",
              )
            } else {
              const targetSelector =
                pending.field.selector ?? pending.selection.selector
              adapter.setElementText(
                targetSelector,
                pending.value,
                pending.field.textNodeIndex,
              )
            }
          }
        }
        return
      }

      // The designer picked the narrower scope, so the bridge's draft — which is
      // the SHARED-template edit — must never reach the edit route. Cancel it.
      //
      // Cancelling does NOT restore the typed text, and an earlier version of
      // this comment claimed it did. `releaseUnownedPreview` returns early when
      // there are no `previewOps`, and the in-page contentEditable path
      // (`inspector.setCaptureTextMutation`) supplies none — the designer typed
      // into the DOM directly, so there was never an optimistic preview to
      // revert. The text therefore stays as typed until HMR renders the real
      // write. On the success path that is momentary and correct; on a refusal
      // the DOM keeps showing a change that was never written, which
      // `setSaveStatus` reports but the page does not undo. That gap is
      // pre-existing (the mutation-disambiguation dialog's own Cancel has it
      // too) and closing it means giving this capture path real `previewOps`,
      // which is its own change.
      if (pending.editKind === "dom-text" && pending.bridgePendingId) {
        adapterRef.current?.resolveMutationDisambiguation(
          pending.bridgePendingId,
          "cancel",
        )
      }

      // "this-row" → deterministic iteration-data edit, LLM fallback behind it.
      // Build the payload that the prompt builder expects (one shape per
      // operation).
      const templateLocation = pending.iterationContext
        ? pending.editKind === "delete"
          ? pending.node.editTarget
          : pending.editKind === "prop"
          ? pending.selection.editTarget
          : pending.editKind === "dom-text"
          ? pending.selection.editTarget
          : pending.payload.source.editTarget
        : undefined
      if (!templateLocation) {
        setSaveStatus(
          "Iteration edit refused: no source location on the selection.",
        )
        return
      }
      const pageSourceFile = useAppStore.getState().currentSourceFile
      let payload
      let description: string
      if (pending.editKind === "delete") {
        payload = { operation: "remove" as const }
        description = `Remove row ${JSON.stringify(pending.iterationContext.key)} from the iteration data`
      } else if (pending.editKind === "prop") {
        payload = {
          operation: "patch" as const,
          updates: { [pending.propName]: serializePropValue(pending.value) },
        }
        description = `Patch row ${JSON.stringify(pending.iterationContext.key)}: set ${pending.propName}`
      } else if (pending.editKind === "move") {
        payload = {
          operation: "reorder" as const,
          toIndex: pending.payload.destIndex,
        }
        description = `Reorder row ${JSON.stringify(pending.iterationContext.key)} to index ${pending.payload.destIndex}`
      } else if (pending.editKind === "dom-text") {
        // The client deliberately does NOT name the property here. It knows the
        // new string; it does not know which field of the row rendered it,
        // because that answer lives in the source file. `patch-text` carries
        // the value alone and the SERVER derives the key with the
        // interpolation extractor (Vue or JSX, one shared refusal set).
        //
        // The predecessor to this line refused outright, on the correct
        // reasoning that guessing a key would let the static endpoint write a
        // literal `"Text (2)": "new"` into the data array. That reasoning
        // stands; the fix was to stop guessing, not to keep refusing.
        payload = { operation: "patch-text" as const, value: pending.value }
        description = `Set the text of row ${JSON.stringify(pending.iterationContext.key)}`
      } else {
        return
      }

      setSaveStatus(null)
      try {
        const result = await requestIterationProposal({
          editKind: pending.editKind,
          templateLocation,
          iterationContext: pending.iterationContext,
          pageSourceFile,
          payload,
          description,
        })
        if (!result.ok) {
          setSaveStatus(`Iteration edit refused: ${result.reason}`)
          return
        }
        const id = makeEditId()
        const overwrite: StructuralEdit = {
          kind: "overwrite",
          id,
          target: {
            targetId: result.proposal.file,
            selector: result.proposal.file,
          },
          file: result.proposal.file,
          newSource: result.proposal.newSource,
          baseHash: result.proposal.baseHash,
        }
        // Immediate dispatch: the proposal is a deterministic full-file
        // rewrite; write it to the working tree so Vite HMR reflects it.
        const adapter = adapterRef.current
        if (!adapter) {
          setSaveStatus("Editor adapter not ready. Try again in a moment.")
          return
        }
        const applied = await adapter.applyEdit(overwrite)
        if (applied.kind === "failed") {
          setSaveStatus(
            `Iteration edit failed for ${result.proposal.file}: ${applied.reason}`,
          )
          return
        }
        setSaveStatus(
          `Iteration applied to ${result.proposal.file}: ${
            result.proposal.explanation ?? description
          }`,
        )
      } catch (err) {
        setSaveStatus(`Iteration edit threw: ${(err as Error).message}`)
      }
    },
    // legacyHandle*Ref are stable refs; dispatchDeleteEdit is stable. The deps
    // are intentionally minimal so the function identity stays stable.
    // (The directive below is what actually suppresses the warning — this
    // comment claimed to "suppress" it for a long time while doing nothing.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dispatchDeleteEdit],
  )

  /** Refs to the legacy handlers so dispatchIterationEdit can re-enter
   *  them on "all-rows" without dependency cycles. The setters live in
   *  the post-handler `useEffect`s below; they always invoke with
   *  `skipIterationCheck = true` so the legacy path runs cleanly. */
  const legacyHandlePropEditRef = useRef<
    ((propName: string, value: PropControlValue) => void) | null
  >(null)
  const legacyHandleLayerMoveRef = useRef<
    ((payload: LayersMovePayload) => void) | null
  >(null)

  const confirmIterationScope = useCallback(
    (scope: IterationScope, remember: boolean) => {
      const pending = iterationScopePrompt
      if (!pending) return
      logIterationScopeChoice({
        editKind: pending.editKind,
        scope,
        iterationContext: pending.iterationContext,
        remembered: remember,
      })
      if (remember) {
        iterationScopeMemoryRef.current[pending.editKind] = scope
      }
      setIterationScopePrompt(null)
      void dispatchIterationEdit(pending, scope)
    },
    [iterationScopePrompt, dispatchIterationEdit],
  )

  const cancelIterationScope = useCallback(() => {
    // A prompt that arrived from the BRIDGE (in-page typing) means the bridge
    // is still holding a draft mutation keyed by `bridgePendingId`. Dismissing
    // the dialog — Cancel, Escape, or the close button — used to drop only the
    // React state, orphaning that draft in the bridge's pending map with no
    // path to ever resolve it. Release it here so dismissal means the same
    // thing on both sides. Harmless for prompts that never came from the
    // bridge: `resolveDisambiguation` no-ops on an unknown id.
    setIterationScopePrompt((current) => {
      if (current?.editKind === "dom-text" && current.bridgePendingId) {
        adapterRef.current?.resolveMutationDisambiguation(
          current.bridgePendingId,
          "cancel",
        )
      }
      return null
    })
  }, [])

  /**
   * Funnel a pending iteration edit through the remembered-or-prompt
   * gate. Returns `true` when the dispatcher intercepted (and the
   * caller should NOT run the legacy path); `false` when there's no
   * iteration context and the caller should proceed normally.
   *
   * Used by handleLayerDelete / handlePropEdit / handleLayerMove as the
   * first line of their handler. Keeps the gate logic in one place.
   */
  const interceptIterationEdit = useCallback(
    (pending: PendingIterationEdit): boolean => {
      const remembered = iterationScopeMemoryRef.current[pending.editKind]
      if (remembered) {
        logIterationScopeChoice({
          editKind: pending.editKind,
          scope: remembered,
          iterationContext: pending.iterationContext,
          remembered: true,
        })
        void dispatchIterationEdit(pending, remembered)
        return true
      }
      setIterationScopePrompt(pending)
      return true
    },
    [dispatchIterationEdit],
  )

  // Keep the early-handler ref pointed at the latest interceptor. The
  // handlers (handleLayerMove/handlePropEdit/handleLayerDelete) are defined
  // before this useCallback in source order; routing through a ref decouples
  // their identity from interceptIterationEdit's deps without re-running
  // any of them on every render. See the ref's declaration for rationale.
  useEffect(() => {
    interceptIterationEditRef.current = interceptIterationEdit
    return () => {
      interceptIterationEditRef.current = null
    }
  }, [interceptIterationEdit])

  // Same trick for the legacy-handler refs that dispatchIterationEdit uses
  // when the user picks "all-rows" — re-enter the existing path with
  // skipIterationCheck=true.
  useEffect(() => {
    legacyHandlePropEditRef.current = (propName, value) =>
      handlePropEdit(propName, value, /* skipIterationCheck */ true)
    return () => {
      legacyHandlePropEditRef.current = null
    }
  }, [handlePropEdit])

  useEffect(() => {
    legacyHandleLayerMoveRef.current = (payload) =>
      handleLayerMove(payload, /* skipIterationCheck */ true)
    return () => {
      legacyHandleLayerMoveRef.current = null
    }
  }, [handleLayerMove])

  // ─── DOM-edit mutation log (Phase B integration) ─────────────────────
  // The bridge stays in inspector mode in compose; shell-initiated text /
  // class edits route through `captureDirectMutation` and surface here.
  // No DOM-edit-mode toggle — editor mode itself implies editability.
  const [mutations, setMutations] = useState<Mutation[]>([])
  const [pendingDisambiguations, setPendingDisambiguations] = useState<
    PendingMutation[]
  >([])
  /**
   * The oldest unresolved v-for disambiguation, surfaced by
   * `MutationDisambiguationDialog`. Fix for "stuck disambiguation blocks
   * Save forever": before this, anything landing in
   * `pendingDisambiguations` (multiple origin candidates, or
   * `scope === "definition"` per the honesty-rule comment in
   * `onMutationAwaitingDisambiguation` below) had no UI to resolve it, so
   * `handleSaveAll`'s gate refused Save indefinitely. Resolving the head
   * entry surfaces the next one automatically (queue semantics fall out of
   * deriving from the array head rather than tracking a separate index).
   */
  const disambiguationPrompt = pendingDisambiguations[0] ?? null
  /**
   * Designer picked a scope for `disambiguationPrompt`. Forwards to the
   * adapter (which promotes the pending item to a `Mutation` and emits
   * `onMutationCaptured`) then drops it from the queue — nothing else
   * removes a resolved entry from `pendingDisambiguations`.
   *
   * WHERE THE PREVIEW OVERRIDE IS RELEASED on this path (Phase 3 live finding
   * 2): the promoted mutation carries the draft's own id, and the bridge now
   * registers it with the OverrideStore as it promotes — so the release is the
   * SAME release-then-verify call every other lane makes,
   * `resolveOverrideSettled(adapter, current.id, 'confirmed')` in
   * `dispatchBranchClassMutation` once the write lands. It is not repeated
   * here (that would be the second resolve for one override).
   *
   * Before the bridge fix, that call resolved an id the bridge had never
   * registered — a silent no-op — so the inline `!important` class-preview shim
   * outlived the edit and the DOM kept claiming a class that exists in no source
   * file. `cancelDisambiguation` below emits no mutation at all, so nothing
   * shell-side could ever release it; the bridge reverts that path itself.
   */
  const confirmDisambiguation = useCallback(
    (choice: DisambiguationChoice) => {
      const prompt = pendingDisambiguations[0]
      if (!prompt) return
      adapterRef.current?.resolveMutationDisambiguation(prompt.pendingId, choice)
      setPendingDisambiguations((prev) =>
        prev.filter((p) => p.pendingId !== prompt.pendingId),
      )
    },
    [pendingDisambiguations],
  )
  /** Designer discarded `disambiguationPrompt` — no edit is written. */
  const cancelDisambiguation = useCallback(() => {
    const prompt = pendingDisambiguations[0]
    if (!prompt) return
    adapterRef.current?.resolveMutationDisambiguation(prompt.pendingId, "cancel")
    // The ONLY settle signal on this path (L1). No mutation is emitted, so no
    // override is ever registered and no `resolveOverride` can fire — the bridge
    // reverts the draft's preview itself (`releasePendingPreview`,
    // `src/bridge/dom-edit-mode.ts`). Without this the inspector's last read
    // stays the shim's: the live run left the swatch on the discarded
    // `bg-amber-500` while the badge had reverted to `rgb(249,250,251)`.
    useEditorStore.getState().notePreviewSettled()
    setPendingDisambiguations((prev) =>
      prev.filter((p) => p.pendingId !== prompt.pendingId),
    )
  }, [pendingDisambiguations])
  // Ref mirror of `pendingDisambiguations.length`, kept in sync on every
  // render (assignment, not an effect — always current by the time any
  // event handler reads it). Lets the `beforeunload` guard below register
  // its listener once at mount and read live counts at fire-time instead
  // of re-registering on every state change.
  const pendingDisambiguationsCountRef = useRef(0)
  pendingDisambiguationsCountRef.current = pendingDisambiguations.length
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  /**
   * Mutation summary the server expects to send to the LLM. Computed
   * eagerly when the save starts so the dialog can show "Asking AI…"
   * with the input the model is about to see (no need to wait for the
   * route to echo it back). Cleared on save complete.
   */
  const [savePendingLLMInput, setSavePendingLLMInput] = useState<
    SaveLLMTrace['mutationSummary'] | null
  >(null)
  /**
   * Trace returned by the route when the LLM ran. The dialog renders it
   * verbatim so the designer can see what the model did. Sticky across
   * saves (overwritten on each save) so the dialog can keep displaying
   * the last trace after the save returns.
   */
  const [saveLastLLMTrace, setSaveLastLLMTrace] = useState<SaveLLMTrace | null>(
    null,
  )
  /**
   * Streaming LLM response text (accumulated token deltas) while a
   * save's `llm-patch` is in flight. The dialog renders this in a
   * code-style scrolling block so the designer sees the model "thinking"
   * instead of a blank wait. Cleared at the start of each save.
   *
   * Stored in a ref so high-frequency token updates don't trigger a
   * re-render per token (which would tank performance for the dialog).
   * The dialog reads via `saveStreamingText` state, which is set on a
   * throttled cadence from the ref.
   */
  const saveStreamingTextRef = useRef<string>('')
  const [saveStreamingText, setSaveStreamingText] = useState<string>('')
  // Phase E external-edit guard. Each successful llm-patch save returns
  // post-write SHA-256 hashes per file; we carry them to the next save
  // as `baseHashes`. The route compares pre-write hashes server-side
  // and rejects (409 + `external-edit-conflict`) if the file was
  // modified by someone else (e.g. engineer in their IDE) between
  // saves — which would otherwise silently overwrite their work.
  const fileHashesRef = useRef<Record<string, string>>({})
  const [conflict, setConflict] = useState<{
    files: ReadonlyArray<{ file: string; expected: string; actual: string }>
    pendingMutations: Mutation[]
  } | null>(null)

  // Warn on tab close/reload when there's un-dispatched work that a reload
  // would silently discard: mutations queued for the AI lane
  // (`queuedForAiRef` — only flushed by `handleSaveAll`'s LLM dispatch, not
  // by any autosave) and unresolved v-for disambiguations
  // (`pendingDisambiguations` — the designer hasn't picked a target yet, so
  // nothing has been written). Registers the listener once at mount and
  // reads the ref/ref-mirrored count at fire-time rather than re-registering
  // per state change — simpler and race-free since both refs are updated
  // synchronously during render, before any unload can occur.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const hasUndispatchedWork =
        queuedForAiRef.current.size > 0 ||
        pendingDisambiguationsCountRef.current > 0
      if (!hasUndispatchedWork) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [])

  // Always-latest mirror of `mutations` so the branch-mode debounced
  // dispatch (below) reads the freshest captured state from inside a
  // setTimeout callback.
  const mutationsRef = useRef<Mutation[]>([])
  mutationsRef.current = mutations

  // Per-mutation-identity debounce timers for branch-mode dom-text
  // immediate-dispatch. Every keystroke in the inspector TEXT input
  // fires a fresh MUTATION_CAPTURED for the same identity (the buffer
  // dedup logic above merges them, keeping the original `before` and
  // the latest `after`). We restart the 500ms timer on each capture so
  // dispatch only runs after the designer stops typing — no per-
  // keystroke LLM-lane spam, and the Commit (N) badge enables on its
  // own as soon as the write lands (uncommitted) on the working tree.
  const branchTextDispatchTimers = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map())
  // Identities with an in-flight dispatch. Used to serialize per-
  // identity so two same-identity dispatches can't race and complete
  // out of order. Codex P0 fix (2026-05-26): without this, fast typing
  // during a 5-95s LLM-lane round-trip could trigger a second dispatch
  // that completes out of order, with the older request's stale `after`
  // overwriting the user's newer value.
  const branchTextInFlight = useRef<Set<string>>(new Set())

  /**
   * WS1 follow-through (codex round-8): after OUR OWN successful write to
   * the selected element's file, the open selection still carries the
   * PRE-write `editTarget.fileHash` (and possibly-shifted coordinates), so
   * the NEXT edit from the same selection would false-409 on the
   * stale-target guard until the user reselects. Refresh the selection
   * from the re-stamped post-HMR DOM via the same inspection path a click
   * uses — bounded retries because HMR timing isn't ours to control.
   *
   * Guards: skip when the user has moved to a different selection, and
   * back off while another dispatch is in flight (a refresh mid-burst
   * would rebuild the inspector under the user's cursor). Stop early once
   * the refreshed stamp differs from the pre-write one. If HMR never
   * lands within the window, we stop — degraded to today's behavior
   * (409 → reselect), never worse.
   */
  const scheduleSelectionStampRefresh = useCallback((changedFiles: string[]) => {
    const selection = useEditorStore.getState().editorSelection
    const file = selection?.editTarget?.file
    if (!selection || !file || !changedFiles.includes(file)) return
    const selector = selection.selector
    const priorHash = selection.editTarget?.fileHash
    const delays = [300, 800, 1600]
    const attempt = (i: number): void => {
      const timer = setTimeout(async () => {
        const adapter = adapterRef.current
        const current = useEditorStore.getState().editorSelection
        if (!adapter || !current || current.selector !== selector) return
        if (
          branchPropInFlight.current.size > 0 ||
          branchTextInFlight.current.size > 0
        ) {
          if (i + 1 < delays.length) attempt(i + 1)
          return
        }
        try {
          const refreshed = await adapter.selectBySelector(selector)
          const freshHash = refreshed?.editTarget?.fileHash
          if (freshHash && freshHash !== priorHash) return // re-stamped
        } catch {
          // Iframe mid-render — next attempt retries.
        }
        if (i + 1 < delays.length) attempt(i + 1)
      }, delays[i])
      // Fire-and-forget by design; timers die with the page. Void to make
      // the intent explicit to the linter.
      void timer
    }
    attempt(0)
  }, [])
  const BRANCH_TEXT_DISPATCH_DEBOUNCE_MS = 500
  // Prop edits debounce on the same cadence (a slider/number drag fires many
  // intermediate values; we auto-commit only after the designer settles).
  const BRANCH_PROP_DISPATCH_DEBOUNCE_MS = 500

  /**
   * Branch-mode immediate-dispatch for dom-text inspector edits.
   *
   * Every direct DOM mutation (`text`, `class`, etc.) lands in the
   * `mutations` buffer for display, but this schedules the actual write:
   * we build a single-mutation llm-patch (same shape `handleSaveAll`
   * ships) and call `adapter.applyEdit`; the server's deterministic-first
   * pipeline handles `applySlotTextEdit` → `inferAttrFromTextEdit` → LLM
   * lane, exactly as on a full Save. The write lands directly in the
   * user's working tree as an uncommitted change — same immediate-dispatch
   * pattern as structural moves and chat-driven prop edits — so the
   * top-bar Commit affordance (an ordinary `git add -A && git commit`)
   * picks it up without the designer needing to trigger anything else.
   */
  const dispatchBranchTextMutation = useCallback(
    async (identityKey: string) => {
      const adapter = adapterRef.current
      if (!adapter) return
      // Per-identity serialization. A second dispatch for the same
      // identity while one is in flight would create out-of-order
      // completion risk (older response overwriting newer value). The
      // in-flight one will re-check the buffer when it returns and
      // re-fire if intervening keystrokes left work behind, so we just
      // short-circuit here.
      if (branchTextInFlight.current.has(identityKey)) return
      // Latest captured state for this identity — `after` may have
      // advanced since the timer was scheduled.
      const current = mutationsRef.current.find(
        (m) => mutationIdentity(m) === identityKey,
      )
      if (!current) return
      // Snapshot the `after` we're about to dispatch. After the round-
      // trip we compare against the buffer's current `after` to detect
      // whether the user typed more during the in-flight call.
      const dispatchedAfter = current.after
      // Match handleSaveAll's Phase-E1 normalization: callsite-scope
      // mutations the designer didn't explicitly toggle default to
      // "this-instance" so the prompt has a clean routing rule
      // instead of an undefined disambiguationChoice falling through.
      const normalized: Mutation =
        current.disambiguationChoice === undefined &&
        current.scope === "callsite" &&
        current.callsiteLoc !== null &&
        current.kind !== "class"
          ? { ...current, disambiguationChoice: "this-instance" }
          : current
      const baseHashes = { ...fileHashesRef.current }
      const selection = useEditorStore.getState().editorSelection
      const edit = {
        kind: "llm-patch" as const,
        id: makeEditId(),
        target: selection ?? {
          targetId: "llm-patch-bundle",
          selector: "llm-patch-bundle",
          ancestry: [],
        },
        mutations: [normalized],
        // Typing-time: probe the deterministic lane only. A fuzzy edit
        // comes back `needsChat` and gets QUEUED (below) rather than
        // running the LLM mid-edit — the queue is applied at commit.
        llmFallback: "chat" as const,
        ...(Object.keys(baseHashes).length > 0 ? { baseHashes } : {}),
      }
      branchTextInFlight.current.add(identityKey)
      inFlightOverrideIdsRef.current.add(normalized.id)
      try {
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          // `'chat'` mode: the deterministic lane couldn't apply this edit.
          // Don't interrupt the user mid-type — QUEUE it. Keep the mutation
          // in the buffer, record its identity so the capture scheduler
          // stops re-dispatching on every keystroke (the buffer's `after`
          // still updates as they type), and let it apply at commit via
          // `handleSaveAll`'s `llmFallback: 'patch'` dispatch.
          if (result.needsChat) {
            queuedForAiRef.current.add(identityKey)
            setAiQueueCount(queuedForAiRef.current.size)
            return
          }
          // Leave the mutation in the buffer so the user can still
          // retry via Commit's `beforeCommit → handleSaveAll` flush
          // (or via the future "Retry with AI" affordance). Same
          // degradation contract as a failed structural edit anywhere
          // else in branch mode.
          setSaveStatus(`Inline text edit failed: ${result.reason}`)
          // WS3: the write never landed — revert the optimistic preview.
          // (needsChat above deliberately does NOT resolve: the edit is
          // queued for the AI lane and the preview legitimately stays.)
          resolveOverrideSettled(adapter, normalized.id, "failed", result.reason)
          return
        }
        if (result.kind === "applied" && result.newHashes) {
          fileHashesRef.current = {
            ...fileHashesRef.current,
            ...result.newHashes,
          }
        }
        // Tier-2 verification: the source write landed in the worktree and HMR
        // will re-render. Confirm the edited text actually shows up in the live
        // DOM (catches values overridden by a binding, gated by v-if, etc.).
        // Best-effort and fire-and-forget — never blocks the edit flow.
        verifyEditRef.current(
          {
            editId: edit.id,
            selector: current.selector,
            expectedValue: dispatchedAfter,
            editKind: "dom-text",
            // Join key for the Activity-row badge, when set. Branch mode
            // never auto-commits, so no adapter sets this today — see the
            // `commitSha` doc on `EditResult` in core/framework-adapter.ts.
            commitSha:
              result.kind === "applied" ? result.commitSha : undefined,
            // Verification settles 0.85-3s later; by then a newer keystroke
            // has typically re-dispatched (or is in flight) and this
            // snapshot's `dispatchedAfter` is stale. Read the LIVE buffer
            // lazily at verification-complete time rather than snapshotting
            // now — a "fail" against a value nobody's typing anymore isn't
            // worth a toast (the outcome/store bookkeeping still records it).
            isSuperseded: () => {
              const m = mutationsRef.current.find(
                (m) => mutationIdentity(m) === identityKey,
              )
              return !!m && !Object.is(m.after, dispatchedAfter)
            },
          },
          // WS3 release gate: 'verified' → the post-HMR DOM renders the value
          // from source, release the override. 'didnt-take' → the write
          // landed but rendering doesn't show it (bound/shadowed) — release
          // WITHOUT reverting ('ineffective'; post-HMR DOM is the truth, the
          // verification hook's own warning toast explains). 'skipped'
          // (older bridge, no read support) → the write landed; release
          // rather than leave the override fighting HMR.
          (outcome) => {
            resolveOverrideSettled(
              adapter,
              normalized.id,
              outcome === "didnt-take" ? "ineffective" : "confirmed",
            )
          },
        )
        // Refresh the (still-open) selection's stamps so the next edit from
        // it doesn't false-409 against its own predecessor's write.
        if (result.kind === "applied" && result.newHashes) {
          scheduleSelectionStampRefresh(Object.keys(result.newHashes))
        }
        // Reconcile the buffer with the dispatched state — see
        // dispatch-reconcile.ts for the shared settle/advance decision:
        //   - "settled": the entry's `after` still matches what we
        //     dispatched, no keystrokes arrived during the in-flight call
        //     → drop the entry; the next keystroke will create a fresh
        //     one against the now-on-disk source.
        //   - "advanced": the entry's `after` moved (user typed more),
        //     keep the entry but rebase `before` to the dispatched
        //     `after`, because that's what's now in source. Without
        //     rebasing, the next dispatch would send the ORIGINAL
        //     `before` to the LLM and fail to locate it (file already has
        //     the post-dispatch text).
        let needsRefire = false
        setMutations((prev) => {
          const idx = prev.findIndex(
            (m) => mutationIdentity(m) === identityKey,
          )
          const entry = idx === -1 ? undefined : prev[idx]
          const decision = reconcileDispatchedValue(
            idx !== -1,
            dispatchedAfter,
            entry?.after,
          )
          if (decision === "no-entry" || !entry) return prev
          if (decision === "settled") {
            return prev.filter((m) => mutationIdentity(m) !== identityKey)
          }
          needsRefire = true
          const updated = [...prev]
          // Rebase `before` to what's now in source AND the stale-target
          // stamp to this write's hash (codex round-15) — the re-fired
          // dispatch must not 409 against our own write. Full hash is fine:
          // the guard prefix-compares.
          const file = entry.sourceLoc ? entry.sourceLoc.slice(0, entry.sourceLoc.lastIndexOf(":", entry.sourceLoc.lastIndexOf(":") - 1)) : null
          const freshHash =
            result.kind === "applied" && result.newHashes && file
              ? result.newHashes[file]
              : undefined
          updated[idx] = {
            ...entry,
            before: dispatchedAfter,
            ...(freshHash ? { sourceVersion: freshHash } : {}),
          }
          return updated
        })
        // If the user typed during the in-flight call, the
        // onMutationCaptured handler skipped scheduling a timer (because
        // we were in-flight). Kick one off now so the post-dispatch
        // typing actually dispatches. Use the standard debounce so a
        // continued burst still settles before firing.
        if (needsRefire) {
          const timers = branchTextDispatchTimers.current
          const existing = timers.get(identityKey)
          if (existing) clearTimeout(existing)
          const timer = setTimeout(() => {
            timers.delete(identityKey)
            void dispatchBranchTextMutationRef.current?.(identityKey)
          }, BRANCH_TEXT_DISPATCH_DEBOUNCE_MS)
          timers.set(identityKey, timer)
        }
      } catch (err) {
        setSaveStatus(
          `Inline text edit threw: ${(err as Error).message}`,
        )
        resolveOverrideSettled(adapter, normalized.id, "failed", (err as Error).message)
      } finally {
        inFlightOverrideIdsRef.current.delete(normalized.id)
        branchTextInFlight.current.delete(identityKey)
      }
    },
    [scheduleSelectionStampRefresh],
  )

  // Self-reference for the re-fire path inside `dispatchBranchText-
  // Mutation`'s success branch. A direct call would close over the
  // initial useCallback identity (stable since deps are []); using a
  // ref keeps it consistent if we ever broaden the deps and lets the
  // cleanup effect tear it down without leaving a dangling reference.
  const dispatchBranchTextMutationRef = useRef<
    typeof dispatchBranchTextMutation | null
  >(null)
  dispatchBranchTextMutationRef.current = dispatchBranchTextMutation

  /**
   * Branch-mode dispatch for a buffered prop/attr edit, keyed by
   * `propEditKey(selector, propName)`. Mirrors `dispatchBranchTextMutation`:
   * reads the freshest buffered value, dispatches it to the working tree via
   * `adapter.applyEdit` (the server's deterministic-first pipeline handles the
   * bound-binding LLM fallback internally), reconciles the buffer, and re-fires
   * if the value advanced during the in-flight round-trip. The DOM override set
   * at edit time is the instant preview; HMR re-renders the truthful source.
   * Serialized per identity so two same-key dispatches can't complete out of
   * order (same race the text path's in-flight set guards).
   */
  const dispatchBranchPropEdit = useCallback(async (key: string) => {
    const adapter = adapterRef.current
    if (!adapter) return
    if (branchPropInFlight.current.has(key)) return
    const current = pendingPropEditsRef.current.find(
      (e) => propEditKey(e.target.selector, e.propName) === key,
    )
    if (!current) return
    const dispatchedValue = current.value
    branchPropInFlight.current.add(key)
    inFlightOverrideIdsRef.current.add(current.id)
    // The prop request is a plain synchronous POST — when the deterministic
    // lane refuses, the server runs the AI mini-turn INSIDE this request
    // (up to ~90s) with no streaming signal. The client can't know the
    // fallback engaged, but a prop dispatch outlasting a couple of seconds
    // is a reliable tell — surface it so the wait isn't silent.
    const askingAiTimer = setTimeout(() => {
      if (branchPropInFlight.current.has(key)) {
        setSaveStatus(`Asking AI to apply "${current.propName}"…`)
      }
    }, 2_000)
    try {
      const result = await adapter.applyEdit(current)
      if (result.kind === "failed") {
        // `'chat'` fallback mode: the deterministic applicator refused
        // (bound-binding / v-model / dynamic-vbind) AND the source-aware
        // LLM lane refused too, so the server returned `needsChat`. Route
        // the edit to the chat agent (which has multi-file tool access)
        // instead of leaving it stuck in the buffer, and drop the entry.
        // Mirrors the inline text path at ~line 2311.
        if (result.needsChat && escalateToChatRef.current) {
          const editTarget = current.target.editTarget
          const editTargetLocation = editTarget
            ? `${editTarget.file}:${editTarget.line}`
            : null
          escalateToChatRef.current(
            buildPropEditEscalationPrompt({
              propName: current.propName,
              // Pass the raw value (string | number | boolean) so the
              // prompt renders unquoted for non-string literals — the
              // agent must not write `:max="42"` as `:max="\"42\""`.
              newValue: normalizeManifestValueForEscalation(current.value),
              componentName: current.target.componentName,
              editTargetLocation,
              selector: current.target.selector,
            }),
          )
          setPendingPropEdits((prev) => prev.filter((e) => e.id !== current.id))
          attrEditIdsRef.current.delete(current.id)
          pendingPropRenderSitesRef.current.delete(current.id)
          return
        }
        // The source write genuinely failed (not a needsChat refusal). Keep
        // the entry buffered so it stays consistent with the live preview
        // override (still showing the attempted value) and `hasUnsavedChanges`
        // stays true — the value is NOT on disk. There is no save-time flush to
        // retry it (branch mode has no buffer flush; git Commit records the
        // working tree, it doesn't re-run dispatch); editing the field again
        // re-arms the debounced dispatch, which is the retry path.
        // Stale-target auto-recovery (follow-up to WS1): a 409 means the
        // file moved under the buffered entry's captured stamps — usually
        // our own just-landed write. Re-capture coordinates+hash from the
        // post-HMR DOM once, rebase the entry, and re-fire before
        // surfacing failure. One shot per key: a second 409 surfaces.
        if (/stale target/i.test(result.reason) && !staleRetriedRef.current.has(key)) {
          staleRetriedRef.current.add(key)
          const refreshed = await adapter
            .selectBySelector(current.target.selector)
            .catch(() => null)
          if (refreshed?.editTarget) {
            setPendingPropEdits((prev) => {
              const idx = prev.findIndex(
                (e) => propEditKey(e.target.selector, e.propName) === key,
              )
              if (idx === -1) return prev
              const updated = [...prev]
              updated[idx] = { ...updated[idx], target: refreshed }
              return updated
            })
            const existing = branchPropDispatchTimers.current.get(key)
            if (existing) clearTimeout(existing)
            const timer = setTimeout(() => {
              branchPropDispatchTimers.current.delete(key)
              dispatchBranchPropEditRef.current?.(key)
            }, BRANCH_PROP_DISPATCH_DEBOUNCE_MS)
            branchPropDispatchTimers.current.set(key, timer)
            return
          }
        }
        setSaveStatus(`Inline prop edit failed: ${result.reason}`)
        // WS3: the write never landed — revert the preview poke. (The
        // needsChat escalation above does NOT resolve: chat will land the
        // edit; the preview rides until then or until the store times out.)
        resolveOverrideSettled(adapter, current.id, "failed", result.reason)
        return
      }
      if (result.kind === "applied" && result.newHashes) {
        fileHashesRef.current = {
          ...fileHashesRef.current,
          ...result.newHashes,
        }
      }
      if (result.kind === "applied" && result.fallbackUsed) {
        const notes = result.notes
        const truncatedNotes =
          notes && notes.length > 140 ? notes.slice(0, 140) + "…" : notes
        setSaveStatus(
          `Edited via AI fallback${truncatedNotes ? `: ${truncatedNotes}` : ""}`,
        )
      }
      staleRetriedRef.current.delete(key)
      // RELEASE-THEN-VERIFY (final-review C1, same shape as the style lane
      // below). The write landed — release the preview override immediately,
      // as this lane did before verification was wired here, then verify
      // diagnostically. Holding the preview until the read-back confirms
      // means the read-back is partly measuring our own optimistic override
      // (`APPLY_PROP_OVERRIDE` / `APPLY_ATTR_OVERRIDE`), which is what
      // `confirmStableMs` has to fight; releasing first lets the post-HMR DOM
      // be the only thing under the microscope. Exactly ONE resolve per
      // override id: every failure branch above returns.
      resolveOverrideSettled(adapter, current.id, "confirmed")
      // Verify the prop's value actually rendered (diagnostic only — the
      // override is already released). The oracle needs a manifest dom-hint
      // (captured at buffer time from `attribute()`'s `renders` — see
      // `dispatchAllRowsPropEdit`) to know WHERE the value surfaces; without
      // one `deriveExpectation` declines and nothing is reported.
      const renderSite = pendingPropRenderSitesRef.current.get(current.id)
      // Boolean-attribute exclusion: Vue's `patchAttr` renders a *special*
      // boolean HTML attribute (disabled/checked/readonly/selected/…) as
      // `attr=""` when true and removes it entirely when false. The
      // bridge's READ_RENDERED_VALUE only special-cases `checked`/`value`;
      // every other attribute name falls through to plain `getAttribute`,
      // so reading it back would compare `""` against `String(true)` →
      // `"true"` and never match — a CORRECT edit would be reported as
      // "didn't take effect." A false failure is worse than no signal, so
      // decline the oracle for this exact combination (same as no hint at
      // all) rather than try to model boolean-attribute semantics with a
      // "matches any of" expectation. Numbers are unaffected — Vue
      // stringifies `4` to `"4"`, which matches — so gate specifically on
      // `typeof === 'boolean'`, not "non-string".
      const isBooleanAttributeHint =
        typeof dispatchedValue === "boolean" && renderSite?.field === "attribute"
      verifyEditRef.current({
        editId: current.id,
        selector: current.target.selector,
        expectedValue: String(dispatchedValue ?? ""),
        editKind: "prop",
        propName: current.propName,
        domField: isBooleanAttributeHint ? undefined : renderSite?.field,
        attribute: isBooleanAttributeHint ? undefined : renderSite?.attribute,
        // Verification settles 0.85-3s later; by then a newer keystroke/
        // drag has typically re-dispatched (or is in flight) and this
        // snapshot's `dispatchedValue` is stale. Read the LIVE buffer
        // lazily at verification-complete time — mirrors the dom-text
        // lane's `isSuperseded` against its own mutations buffer.
        isSuperseded: () => {
          const stillBuffered = pendingPropEditsRef.current.find(
            (e) => propEditKey(e.target.selector, e.propName) === key,
          )
          return !!stillBuffered && !Object.is(stillBuffered.value, dispatchedValue)
        },
      })
      // Refresh the (still-open) selection's stamps so the next edit from
      // it doesn't false-409 against its own predecessor's write.
      scheduleSelectionStampRefresh(
        result.kind === "applied" && result.newHashes
          ? Object.keys(result.newHashes)
          : [current.target.editTarget?.file].filter((f): f is string => !!f),
      )
      // Reconcile (see dispatch-reconcile.ts for the shared decision):
      // "settled" — the buffered value still matches what we dispatched,
      // the worktree now holds it — drop the entry. "advanced" — it moved
      // (the designer kept dragging), keep it and re-fire. Prop
      // applicators re-parse source each call, so no `before`-rebase is
      // needed (unlike the text path) — only the stale-target stamp.
      let needsRefire = false
      setPendingPropEdits((prev) => {
        const idx = prev.findIndex(
          (e) => propEditKey(e.target.selector, e.propName) === key,
        )
        const decision = reconcileDispatchedValue(
          idx !== -1,
          dispatchedValue,
          idx === -1 ? undefined : prev[idx].value,
        )
        if (decision === "no-entry") return prev
        if (decision === "settled") {
          attrEditIdsRef.current.delete(prev[idx].id)
          pendingPropRenderSitesRef.current.delete(prev[idx].id)
          return prev.filter((_, i) => i !== idx)
        }
        needsRefire = true
        // Rebase the kept entry's stale-target stamp to THIS write's hash
        // (codex round-15): the re-fire dispatches this entry, and without
        // the rebase its pre-write fileHash 409s against our own write.
        // Coordinates stay valid — the prop splice never moves the
        // element's start tag.
        const freshHash =
          result.kind === "applied" && result.newHashes
            ? result.newHashes[prev[idx].target.editTarget?.file ?? ""]
            : undefined
        if (!freshHash || !prev[idx].target.editTarget) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          target: {
            ...updated[idx].target,
            editTarget: { ...updated[idx].target.editTarget!, fileHash: freshHash },
          },
        }
        return updated
      })
      if (needsRefire) {
        const existing = branchPropDispatchTimers.current.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          branchPropDispatchTimers.current.delete(key)
          dispatchBranchPropEditRef.current?.(key)
        }, BRANCH_PROP_DISPATCH_DEBOUNCE_MS)
        branchPropDispatchTimers.current.set(key, timer)
      }
    } catch (err) {
      setSaveStatus(`Inline prop edit threw: ${(err as Error).message}`)
      resolveOverrideSettledOptional(
        adapterRef.current,
        current.id,
        "failed",
        (err as Error).message,
      )
    } finally {
      clearTimeout(askingAiTimer)
      inFlightOverrideIdsRef.current.delete(current.id)
      branchPropInFlight.current.delete(key)
    }
  }, [scheduleSelectionStampRefresh])
  dispatchBranchPropEditRef.current = dispatchBranchPropEdit

  /**
   * Where a `scoped-css-override` rule is written on this substrate — and, on
   * a substrate that has nowhere to put one, why not.
   *
   * Vue answers this with no round trip: an SFC carries its own
   * `<style scoped>` block, so the destination is dictated by the anchor.
   * React has no such thing, so the rule goes into a project stylesheet the
   * page actually loads — which is a fact only the document holds. Hence one
   * bridge read (`GET_STYLESHEET_TARGETS`), a first-party-writable filter, and
   * the ladder in `resolve-override-stylesheet.ts`.
   *
   * The session's earlier choice is remembered — but as a HINT fed back into
   * the ladder, never as a shortcut around it. Remembering keeps a project's
   * overrides in one file when a mid-session HMR reorders imports; feeding it
   * back through reachability keeps a remembered file that is no longer loaded
   * (a route change, a deleted import) from silently collecting dead rules.
   * The round trip is a few milliseconds and it is the only thing that can
   * tell the difference. Across sessions the CLI's boot-time `sticky` scan
   * plays the same role.
   */
  const fetchStylesheetTargets = useIframeStylesheetTargets(iframeRef)
  const overrideStylesheetRef = useRef<string | undefined>(undefined)
  const resolveStyleDestination = useCallback(async (): Promise<
    | { ok: true; opts: StyleEditDestinationOptions }
    | { ok: false; reason: string }
  > => {
    if (EDITOR_FRAMEWORK !== "react") return { ok: true, opts: {} }
    const sheets = await fetchStylesheetTargets()
    const resolved = resolveOverrideStylesheet(sheets, {
      basePath: EDITOR_VITE_BASE,
      repoRoot: EDITOR_REPO_ROOT,
      repoRootReal: EDITOR_REPO_ROOT_REAL,
      configured: EDITOR_OVERRIDE_STYLESHEET.configured,
      sticky: overrideStylesheetRef.current ?? EDITOR_OVERRIDE_STYLESHEET.sticky,
    })
    if (isOverrideStylesheetRefusal(resolved)) {
      return {
        ok: false,
        reason: `${resolved.reason} Create ${resolved.suggestion} and import it from your entry module, then try again.`,
      }
    }
    overrideStylesheetRef.current = resolved.file
    return { ok: true, opts: { overrideStylesheet: resolved.file } }
    // `iframeRef` is deliberately absent: a ref object is stable for the
    // component's lifetime, and `fetchStylesheetTargets` (which does read it)
    // is the dependency that actually changes.
  }, [fetchStylesheetTargets])

  /**
   * Inspector style-provenance Phase 3 — the "This page" scope. Apply a style
   * change as a scoped-css-override (a rule in the consumer SFC's
   * `<style scoped>` block targeting the element by `data-desde-src`) rather than
   * splicing a Tailwind class onto the consumer. The scope dialog
   * ([style-scope-dialog.tsx]) routes here when the designer picks "This page"
   * for a provenance-ambiguous edit.
   *
   * The anchor + guard decisions live in `buildPageScopedCssOverrideEdit`
   * (style-edit-builders.ts) — extracted so they are testable without mounting
   * this hook, which is how the § 9g.8 dead-anchor defect stayed invisible.
   * This callback owns only the dispatch and the status reporting.
   */
  const handleScopedStyleEdit = useCallback(
    async (nextClasses: string[]) => {
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection) return
      const destination = await resolveStyleDestination()
      if (!destination.ok) {
        setSaveStatus(destination.reason)
        return
      }
      const built = buildPageScopedCssOverrideEdit(
        selection,
        nextClasses,
        destination.opts,
      )
      if (built.kind === "noop") return
      if (built.kind === "refused") {
        setSaveStatus(built.reason)
        return
      }
      const edit = built.edit
      try {
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          setSaveStatus(`Scoped style edit failed: ${result.reason}`)
          return
        }
        // Keep the external-edit hash guard in sync with our own write, like
        // the other immediate applyEdit paths — else the next save trips the
        // conflict guard against this change.
        if (result.kind === "applied" && result.newHashes) {
          fileHashesRef.current = {
            ...fileHashesRef.current,
            ...result.newHashes,
          }
        }
        // Blast radius, AFTER the write and only when it is bigger than one.
        // The count comes from the same `resolveDomAnchor` call that produced
        // the anchor, so it describes the rule that was actually written —
        // and it is a lower bound (the rendered page, not every route), which
        // the copy says out loud.
        if (built.notice) setSaveStatus(built.notice)
      } catch (err) {
        setSaveStatus(`Scoped style edit threw: ${(err as Error).message}`)
      }
    },
    [resolveStyleDestination],
  )

  /**
   * Inspector style-provenance §6 Phase 3 — the "The token" scope. When a
   * style value is token-driven (`var(--…)`) the scope dialog offers patching
   * the TOKEN's definition instead of overriding on the element — so every
   * consumer of the token updates (the blast-radius the dialog warns about).
   *
   * Unlike "This page" (which adds a `<style scoped>` rule), this rewrites the
   * custom-property's VALUE at its definition site via the `token-value`
   * applicator. The new value is the resolved CSS value of the property the
   * designer just edited (the picked Tailwind class → its declaration), NOT a
   * class — you can't express "the token is now blue" as a class on an element.
   *
   * Source-file resolution: the token's definition lives in a stylesheet whose
   * href the bridge captured. We map that href back to a prototype-root-relative
   * path; first-party token files (the common case — `@acme/design-tokens`
   * ships .css, but a prototype's own token file is first-party) resolve, and
   * library/unresolvable hrefs are refused here (belt-and-suspenders with the
   * handler's node_modules refusal and the dialog's `availableScopes` gate,
   * which only offers "token" when the root definition is first-party).
   */
  const handleTokenStyleEdit = useCallback(
    async (property: string, origin: StyleOrigin, nextClasses: string[]) => {
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection) return
      // The ROOT of the var chain is what you'd actually patch — the last hop
      // is the concrete value (`#f7f7f7`), earlier hops are `var(...)` aliases.
      const root = origin.varChain[origin.varChain.length - 1]
      if (!root) {
        setSaveStatus(
          "Can't edit the token: this value isn't backed by a design token.",
        )
        return
      }
      // Strip the prototype's served base path (Vite `base`, e.g. `/app/`) so
      // the token href maps to a prototype-root-relative file the handler can
      // write. EDITOR_VITE_BASE is the AUTHORITATIVE resolved base, plumbed
      // from the CLI's resolved Vite config. We deliberately do NOT guess the
      // base from any route/URL when it's absent: the page route is the live SPA
      // path (not the base) and the prototype URL can prefix-collide with a real
      // stylesheet path — both mis-strip. When there's no authoritative base
      // (non-CLI shell, where token edits can't complete anyway — the web
      // editor edit route was removed 2026-06-04), default `/` no-ops the
      // strip, which is correct for the realistic root-served case. A safe
      // no-op beats a sometimes-wrong heuristic.
      //
      // `repoRoot` is the other half: Vite dev injects first-party CSS as a
      // `<style>` with no href, so the token's file is only knowable from the
      // bundler's absolute `sourceHint` — which is relativised against the root.
      // Absent root ⇒ unresolvable ⇒ refused below, never guessed.
      // Same helper the inspector's scope-enabling check uses, so the file this
      // writes is the file that check declared writable.
      const file = resolveTokenScopeFile(origin, {
        basePath: EDITOR_VITE_BASE,
        repoRoot: EDITOR_REPO_ROOT,
        repoRootReal: EDITOR_REPO_ROOT_REAL,
      })
      if (!file) {
        setSaveStatus(
          "Can't edit the token: its stylesheet isn't a writable first-party file.",
        )
        return
      }
      // The token's NEW value = the resolved CSS value of the edited property
      // from the class the designer just picked. (Additive only — a clear can't
      // be expressed as a token value; route through the element scope.)
      const before = new Set(selection.classes ?? [])
      const added = nextClasses.filter((c) => !before.has(c))
      if (added.length === 0) {
        setSaveStatus(
          "Clearing a token-backed style isn't supported yet. Edit at the element scope to clear it.",
        )
        return
      }
      const declarations = resolveTailwindClasses(added)
      const newValue = declarations[property]
      if (!newValue) {
        setSaveStatus(
          `Can't map the picked class to a ${property} value to set the token.`,
        )
        return
      }
      const edit: StructuralEdit = {
        kind: "token-value",
        id: makeEditId(),
        // token-value carries its own file/tokenName; the adapter ignores
        // `target`, but StructuralEditBase requires one — the selection is a
        // valid SelectionTarget superset and keeps history correlation honest.
        target: selection,
        file,
        tokenName: root.name,
        newValue,
        selector: root.definedAt.selector,
      }
      try {
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          setSaveStatus(`Token edit failed: ${result.reason}`)
          return
        }
        // Keep the external-edit hash guard in sync with our own write, like
        // the other immediate applyEdit paths, so the next save doesn't trip
        // the conflict guard against this change.
        if (result.kind === "applied" && result.newHashes) {
          fileHashesRef.current = {
            ...fileHashesRef.current,
            ...result.newHashes,
          }
        }
        // Cascade verification: confirm the patched token actually wins the
        // cascade for this element/property. Diagnostic-only, like every
        // cascade/value verification since the final-review C1 fix — and here
        // there was never anything to gate anyway: a token-value edit
        // registers no live preview override (this lane doesn't call
        // `adapter.setElementClasses` / `resolveOverride` at all). Surfaces
        // the same "didn't take effect, X wins the cascade" toast the class
        // lane produces when a competing declaration still beats the token
        // post-write.
        verifyEditRef.current({
          editId: edit.id,
          selector: selection.selector,
          expectedValue: newValue,
          editKind: "token",
          styleProperty: property,
          cascadeOwner: { kind: "token", token: root.name },
          // THE VALUE DIMENSION (codex R4) — ownership alone false-passes a
          // REPEAT token edit: the element still resolves THROUGH `root.name`
          // whatever that token is now set to, so the chain-contains-our-token
          // test is unchanged by #ef4444 → #3b82f6 (or by a write that never
          // landed). `newValue` is the literal this edit wrote to the token's
          // definition site, and the walker reads that same definition back as
          // `varChain[].value` — so the oracle can also require the definition
          // to carry it. A chained definition (`var(...)`) or an
          // un-canonicalizable value declines back to ownership-only.
          expectedDeclarationValue: newValue,
        })
      } catch (err) {
        setSaveStatus(`Token edit threw: ${(err as Error).message}`)
      }
    },
    [],
  )

  /**
   * Branch-mode dispatch for a `class` mutation, keyed by
   * `mutationIdentity`. Unlike text/attr/style (llm-patch), class edits go
   * through the scoped-css-override applicator (injects a CSS rule rather than
   * rewriting source). Reuses the dom-text timers/in-flight maps — keys carry
   * `kind`, so class and text identities never collide.
   */
  const dispatchBranchClassMutation = useCallback(
    async (identityKey: string) => {
      const adapter = adapterRef.current
      if (!adapter) return
      if (branchTextInFlight.current.has(identityKey)) return
      const current = mutationsRef.current.find(
        (m) => mutationIdentity(m) === identityKey,
      )
      if (!current) return
      const dispatchedAfter = current.after
      const destination = await resolveStyleDestination()
      if (!destination.ok) {
        setSaveStatus(`Inline style edit failed: ${destination.reason}`)
        resolveOverrideSettled(adapter, current.id, "failed", destination.reason)
        return
      }
      const edit = buildStyleEdit(current, destination.opts)
      if (!edit) return
      if (isUnsupportedStyleBuild(edit)) {
        setSaveStatus(`Inline style edit failed: ${edit.unsupported}`)
        // WS3: the applicator can't express this edit at all — the write
        // never landed, so revert the live class/inline-style preview the
        // bridge is holding under `current.id` (same id the OverrideStore
        // registered when SET_ELEMENT_CLASSES fired). Mirrors the prop/text
        // lanes' "the write genuinely failed" resolve call.
        resolveOverrideSettled(adapter, current.id, "failed", edit.unsupported)
        return
      }
      branchTextInFlight.current.add(identityKey)
      inFlightOverrideIdsRef.current.add(current.id)
      try {
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          setSaveStatus(`Inline class edit failed: ${result.reason}`)
          // WS3: the write never landed — revert the preview. Resolve by
          // `current.id` (the captured Mutation's id / OverrideStore
          // registration key), NOT `edit.id` (the scoped-css-override /
          // jsx-style dispatch id, which is unrelated to the bridge-side
          // override entry) — same distinction the text lane draws between
          // `normalized.id` and the llm-patch `edit.id`.
          resolveOverrideSettled(adapter, current.id, "failed", result.reason)
          return
        }
        if (result.kind === "applied" && result.newHashes) {
          fileHashesRef.current = {
            ...fileHashesRef.current,
            ...result.newHashes,
          }
        }
        // RELEASE-THEN-VERIFY (final-review C1). The write landed — release
        // the preview override NOW, exactly as this lane did before cascade
        // verification existed, and run verification purely diagnostically
        // afterwards.
        //
        // Why the two goals can't be combined: the live class preview stamps
        // its declarations inline with `!important`
        // (`src/bridge/override-preview.ts` `applyClassOverride`), and inline
        // `!important` outranks everything. Holding the preview until the
        // cascade is verified means the cascade walk is measuring OUR OWN
        // shim — `evaluateCascadeOutcome` then reports `inline style
        // !important` as the winner on 100% of SUCCESSFUL edits, and the
        // React inline lane can never observe the failure it exists to
        // detect. Measuring cascade ownership requires that our preview is
        // already gone; keeping the preview until verified requires the
        // opposite. Releasing first is the only shape that measures reality.
        //
        // Resolving terminally also fires the bridge's `classOv` retire hook,
        // which strips the inline shim (`dom-edit-mode.ts`) — so by the time
        // verification's first read lands (settle 250ms, then polling) the
        // element carries the real cascade again.
        //
        // What we keep: the DIAGNOSIS. A lost cascade still toasts, naming the
        // rule that actually won instead of the misleading `hmr-stale` "HMR
        // did not apply the change". What we give up: verify-before-release.
        // Restoring it needs a bridge-side `inline.fromPreview` flag so the
        // evaluator can discount our own shim — the documented follow-up (see
        // tasks/editor-edit-verification.md); this branch does not change
        // the bridge.
        //
        // Exactly ONE resolve per override id on every path: the failure
        // branches above all `return`, and verification's callback no longer
        // resolves anything.
        resolveOverrideSettled(adapter, current.id, "confirmed")
        // No derivable owner/property (edit kind we don't recognize, or no
        // class/declaration resolved to CSS) → nothing to diagnose; the
        // release above already happened.
        const cascadeTarget = cascadeTargetForStyleEdit(edit)
        if (cascadeTarget) {
          verifyEditRef.current({
            // P2-1 (codex review round 5, 2026-08-20): `editId` here MUST be
            // `edit.id`, not `current.id`. `buildStyleEdit` mints `edit.id`
            // fresh (`makeEditId()`) — it is the id `adapter.applyEdit(edit)`
            // actually dispatches, and `build-edit-request.ts`'s single
            // choke point sends THAT id as the ledger row's `correlationId`.
            // The Activity panel's verification pill joins on
            // `row.correlationId === verificationByEditId`'s key
            // (`activity-verification-join.ts`) — so the id recorded here
            // must be the SAME `edit.id`, or the join can never match and
            // this lane's verification silently never shows up. `current.id`
            // is the right id for `resolveOverrideSettled` two lines up (the
            // OverrideStore's own registration key from `SET_ELEMENT_CLASSES`
            // — a different id, for a different purpose) but the wrong one
            // here. Every other lane already gets this right: the dom-text
            // lane keys on its own freshly-minted `edit.id` while resolving
            // the preview on `normalized.id`, and the token-value lane's
            // `edit` IS what it dispatches, so there's nothing to confuse.
            editId: edit.id,
            selector: current.selector,
            // The RESOLVED CSS value for the representative property — not
            // the raw className string, which produced labels like
            // `background-color = "rounded bg-red-500"` in the Checks strip
            // and the toast (final-review M10).
            expectedValue: cascadeTarget.value,
            // EVERY property this edit sets, shorthands expanded, each carrying
            // its own expected value (Phase 2). Two things this closes:
            //  - the single-representative-property false pass — apply `border`
            //    to an element already carrying `border-width: 0 !important`
            //    inline and the sampled `border-style` wins while the border
            //    stays invisible;
            //  - the shorthand/longhand blind spot — CSSOM reports `''` for a
            //    shorthand a rule didn't declare, so a library rule declaring
            //    `padding-left` was never a candidate in the walk for `padding`.
            // The per-property value closes THE VALUE DIMENSION (codex P1 for
            // `pt-src`, P2 for `inline`): ownership/presence alone false-passes a
            // REPEAT edit of a property our own declaration already owns (pick
            // red, then pick blue — the same rule still wins, so the first poll
            // reports `won` while the DOM may still show red). `pt-src` and
            // `inline` author the declaration verbatim; the `classes` owner
            // passes values too and the evaluator declines per property wherever
            // the winning utility routes through a `var()` our literal could
            // never match.
            styleProperties: cascadeTarget.properties,
            // `cascadeTargetForStyleEdit` only ever returns pt-src / inline /
            // classes owners (the Vue/React styling lanes) — `token-value`
            // isn't reachable through `buildStyleEdit`, so this is always
            // the style kind, never token.
            editKind: "style",
            styleProperty: cascadeTarget.property,
            cascadeOwner: cascadeTarget.owner,
            isSuperseded: () => {
              const m = mutationsRef.current.find(
                (m) => mutationIdentity(m) === identityKey,
              )
              return !!m && !Object.is(m.after, dispatchedAfter)
            },
          })
        }
        // Reconcile (see dispatch-reconcile.ts for the shared decision):
        // "settled" — drop the entry; "advanced" — keep it and re-fire.
        // No rebase needed here (unlike text/prop): the class lane has no
        // stale-target stamp to refresh.
        let needsRefire = false
        setMutations((prev) => {
          const idx = prev.findIndex(
            (m) => mutationIdentity(m) === identityKey,
          )
          const decision = reconcileDispatchedValue(
            idx !== -1,
            dispatchedAfter,
            idx === -1 ? undefined : prev[idx].after,
          )
          if (decision === "no-entry") return prev
          if (decision === "settled") {
            return prev.filter((m) => mutationIdentity(m) !== identityKey)
          }
          needsRefire = true
          return prev
        })
        if (needsRefire) {
          const timers = branchTextDispatchTimers.current
          const existing = timers.get(identityKey)
          if (existing) clearTimeout(existing)
          const timer = setTimeout(() => {
            timers.delete(identityKey)
            void dispatchBranchClassMutationRef.current?.(identityKey)
          }, BRANCH_TEXT_DISPATCH_DEBOUNCE_MS)
          timers.set(identityKey, timer)
        }
      } catch (err) {
        setSaveStatus(`Inline class edit threw: ${(err as Error).message}`)
        // WS3: same as the prop/text lanes' catch — revert the preview
        // rather than leave it lying with no dispatch outcome recorded.
        resolveOverrideSettled(adapter, current.id, "failed", (err as Error).message)
      } finally {
        inFlightOverrideIdsRef.current.delete(current.id)
        branchTextInFlight.current.delete(identityKey)
      }
    },
    // `buildStyleEdit` is a stable top-level import (see
    // style-edit-builders.ts), not a hook value — no dep entry needed.
    // `resolveStyleDestination` IS one, and it is stable.
    [resolveStyleDestination],
  )
  const dispatchBranchClassMutationRef = useRef<
    typeof dispatchBranchClassMutation | null
  >(null)
  dispatchBranchClassMutationRef.current = dispatchBranchClassMutation

  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    // Capture the timers Map at effect-mount so the cleanup uses the
    // same instance the effect's setTimeout calls populated (satisfies
    // the lint rule about ref.current potentially changing between
    // mount and cleanup, even though useRef preserves identity here).
    const timers = branchTextDispatchTimers.current
    // Same local-capture for the in-flight set (added with the Codex
    // P0 #1 fix so the dispatch can detect stale-race conditions).
    const inFlight = branchTextInFlight.current
    // Same captures for the prop auto-commit timers/in-flight set.
    const propTimers = branchPropDispatchTimers.current
    const propInFlight = branchPropInFlight.current
    const unsubCaptured = adapter.onMutationCaptured((m) => {
      // Coalesce by identity, preserving the first `before` (see
      // coalesceCapturedMutation). "Edit a field repeatedly" → one entry.
      setMutations((prev) => coalesceCapturedMutation(prev, m))
      // Branch mode: kick off (or reset) a debounced immediate-dispatch
      // so every edit writes straight to the working tree as an
      // uncommitted change — there is no separate Save step.
      // `text`, `attr`, and `style` ride this single-mutation llm-patch
      // path — same set the save-time flush bundles as `directMutations`
      // (`kind !== "class"`); the server's deterministic attr fast-path
      // handles attr without the LLM lane. Only `class` is dispatched
      // separately below as a scoped-css-override edit (a different
      // applicator — injects CSS rules rather than rewriting source).
      //
      // Skip scheduling when an in-flight dispatch already covers
      // this identity. The buffer dedup above has already merged the
      // new keystroke's `after` into the existing entry; the in-flight
      // dispatch will see the updated state in its post-completion
      // reconciliation and re-fire if needed. Without this gate we'd
      // start a second dispatch in parallel — that's the race Codex
      // flagged (Step 1 P0 #1).
      if (
        shouldProbeTextMutation(m, {
          inFlight,
          queued: queuedForAiRef.current,
        })
      ) {
        const key = mutationIdentity(m)
        const existing = timers.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(key)
          void dispatchBranchTextMutation(key)
        }, BRANCH_TEXT_DISPATCH_DEBOUNCE_MS)
        timers.set(key, timer)
      }
      // `class` mutations auto-commit too, but via the scoped-css-override
      // dispatch (different applicator). Same filter the commit-time flush
      // uses for `scopedOverrideMutations` (sourceLoc + direct/ancestor).
      // Reuses the shared timers/in-flight maps — identity carries `kind`.
      if (
        m.kind === "class" &&
        m.sourceLoc !== null &&
        (m.resolutionKind === "direct" || m.resolutionKind === "ancestor") &&
        !inFlight.has(mutationIdentity(m))
      ) {
        const key = mutationIdentity(m)
        const existing = timers.get(key)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          timers.delete(key)
          void dispatchBranchClassMutation(key)
        }, BRANCH_TEXT_DISPATCH_DEBOUNCE_MS)
        timers.set(key, timer)
      }
    })
    const unsubAwaiting = adapter.onMutationAwaitingDisambiguation((p) => {
      // Auto-resolve to "this-instance" when:
      //   1. The bridge marked exactly one origin candidate
      //      (the DOM element that received the mutation), AND
      //   2. The draft mutation has `scope === "callsite"` — only
      //      this scope's save path actually honors a this-instance
      //      choice (the fast-path swaps `sourceLoc` → `callsiteLoc`
      //      for the splice target, doing a cross-file write to the
      //      parent's <Tag>).
      //
      // For `scope === "definition"` mutations (the v-for-shared
      // template line is in the same file as the script), the
      // save-time path always rewrites the template literal — the
      // disambiguationChoice is ignored. Auto-resolving definition-
      // scope mutations to "this-instance" would silently lie:
      // claim a row-only edit while the save actually affects every
      // row. Codex P1 #1 — leave those in `pendingDisambiguations`
      // so `handleSaveAll`'s gate refuses the save with a clear
      // message rather than silently doing the wrong thing.
      const originCount = p.candidates.filter((c) => c.origin).length

      // A LOOP row, typed directly in the page. The dialog below can only ever
      // offer "change the shared code" for `definition` scope, which is a dead
      // end when what the designer wants is this row — and the OTHER dialog,
      // the iteration one, can do exactly that by patching the row's entry in
      // the data array. Route there instead. MEASURED
      // (`tasks/react-hint-generation-phase0.md` § 7.8.3a): the two paths
      // reached different capabilities for the same intent depending only on
      // whether the designer typed in the page or in the inspector.
      //
      // Gated on the selection describing the SAME source position the bridge
      // anchored the mutation to. The selection is shell state and can drift
      // (a click elsewhere between capture and delivery); an unrelated loop
      // selection must not capture this prompt, so a mismatch falls through to
      // the existing dialog unchanged.
      const selection = useEditorStore.getState().editorSelection
      const iteration = selection?.iterationContext
      const selectionLoc = selection?.editTarget
        ? `${selection.editTarget.file}:${selection.editTarget.line}:${selection.editTarget.column}`
        : null
      // Built as a nullable PAYLOAD rather than a bare boolean so TypeScript
      // narrows `selection`, `iteration` and the interceptor here, at the one
      // place the predicate is written. Folding the same conjunction into a
      // boolean and re-reading the parts in the branch below type-checks only
      // with three non-null assertions, which is a promise the compiler stops
      // being able to keep the moment anyone edits the predicate.
      const intercept = interceptIterationEditRef.current
      const iterationEdit =
        p.draft.kind === "text" &&
        p.draft.scope === "definition" &&
        iteration &&
        selection &&
        selectionLoc !== null &&
        selectionLoc === p.draft.sourceLoc &&
        intercept
          ? {
              intercept,
              args: {
                editKind: "dom-text" as const,
                selection,
                // Synthesised rather than carried: the bridge payload has no
                // `EditableTextField`, and the only field this path reads is
                // the selector/textNodeIndex pair used by the NON-bridge
                // all-rows branch, which `bridgePendingId` routes past.
                field: {
                  id: "dom-text",
                  kind: "dom-text" as const,
                  label: "Text",
                  value: p.draft.before,
                },
                value: p.draft.after,
                iterationContext: iteration,
                bridgePendingId: p.pendingId,
              },
            }
          : null

      // The four-way decision lives in `disambiguation-route.ts`, and it is
      // there because the ORDER of these branches is load-bearing and was
      // guarded by nothing. `offeredDisambiguationChoices` returns one choice
      // for EVERY definition-scope prompt, so the auto-apply predicate matches
      // essentially every loop row, and the iteration predicate matches loop
      // rows too. If auto-apply were checked first, a loop row would silently
      // apply "change all N items" with a success toast and the per-row
      // patch-text lane would become unreachable, with nothing thrown and
      // nothing logged. `disambiguation-route.test.ts` asserts the precedence
      // directly. Flagged in cross-session review, before it could regress.
      const route = routeAwaitingDisambiguation({
        pending: p,
        originCount,
        iterationRouteAvailable: iterationEdit !== null,
      })

      if (route.kind === "auto-resolve") {
        adapter.resolveMutationDisambiguation(p.pendingId, route.choice)
        return
      }

      if (route.kind === "iteration-dialog" && iterationEdit) {
        iterationEdit.intercept(iterationEdit.args)
        return
      }

      // Nothing to ask when the honesty rule leaves exactly one option: a
      // one-radio group above a Save button is not a decision. Apply it and
      // report the blast radius instead. HMR repaints every affected item, so
      // the consequence is visible without a gate. See
      // `single-choice-disambiguation-notice` for why a notice and not
      // silence, and for why it says "this edit changes" rather than
      // "changed". The two-option prompt still opens the dialog below.
      if (route.kind === "auto-apply") {
        adapter.resolveMutationDisambiguation(p.pendingId, route.choice)
        // `sourceLoc` is the natural key (repeat edits to one shared line
        // should replace the toast, not stack), but it is nullable; the
        // selector keeps the id stable for that case rather than collapsing
        // every anchorless edit onto one toast.
        notifySingleChoiceDisambiguation(
          offeredDisambiguationChoices(p),
          p.draft.sourceLoc ?? p.draft.selector,
        )
        return
      }

      setPendingDisambiguations((prev) =>
        prev.some((existing) => existing.pendingId === p.pendingId)
          ? prev
          : [...prev, p],
      )
    })
    // The bridge refused to map this edit to a source position (isolation view,
    // or the only nearby `data-desde-src` is on an ancestor and the kind isn't
    // class). No mutation was captured, so nothing else in the shell will ever
    // mention this edit again — without this subscription the bridge's reason
    // string was written, sent, dispatched by the adapter, and dropped, leaving
    // the user with a preview that vanished (or, pre-2026-08-06g, stuck) and no
    // explanation. See `resolution-failure-notice` for why a toast and not the
    // Checks tab.
    //
    // The settle bump is the other half: the bridge reverts its own preview on
    // this path (`releaseUnownedPreview`), and since no override was ever
    // registered there is no `resolveOverride` to carry the usual settle
    // signal — so this is the ONLY thing that tells the inspector's style rows
    // to stop reporting the shim's value. Same reasoning as
    // `cancelDisambiguation` below.
    const unsubResolutionFailed = adapter.onResolutionFailed((failure) =>
      handleResolutionFailure(failure, useEditorStore.getState().notePreviewSettled),
    )
    // A live-preview poke the substrate couldn't apply (no component instance
    // for the selector, no props object, assignment refused). Unlike the
    // resolution failure above, the buffered edit is NOT lost — it still
    // dispatches to source — but the iframe shows nothing, so a silent
    // `ok: false` reads as "the control is broken". See
    // `override-preview-notice` for why this is a sibling notice and not the
    // same one.
    const unsubOverridePreviewFailed = adapter.onOverridePreviewFailed(
      notifyOverridePreviewFailure,
    )
    const unsubDragMove = adapter.onDragMoveCommitted(handleDragMove)
    const unsubInsertAtPoint = adapter.onInsertAtPoint(handleInsertAtPoint)
    const unsubResize = adapter.onResizeCommitted(handleResize)
    // WS3 closed loop: the bridge reverted an optimistic preview (edit
    // failed after the DOM already showed it) — surface it per-edit. The
    // wording must match the save-progress dialog's destructive-tone gate
    // (/failed|threw|conflict|refused|error/i).
    const unsubOverrideReverted = adapter.onOverrideReverted((p) => {
      setSaveStatus(`Edit failed and was reverted: ${p.reason}`)
      // Belt-and-braces settle edge (L1): every revert we know of is driven by a
      // `resolveOverrideSettled(…, 'failed')` that already bumped, but this is
      // the bridge stating outright that it just restored the pre-edit DOM — so
      // any revert path we failed to enumerate still refreshes the inspector.
      // Idempotent: an extra bump only costs one provenance re-read.
      useEditorStore.getState().notePreviewSettled()
    })
    // Quiet signal only — the override went unresolved past the timeout
    // (slow HMR, dropped dispatch). The DOM keeps the preview; the user
    // can re-edit or commit to force truth. Edits sitting in the AI queue
    // are EXPECTED to pend past the timeout (they apply at commit) — the
    // status would be noise for them, so they're filtered out.
    const unsubOverrideUnverified = adapter.onOverrideUnverified((p) => {
      // Suppressed while the dispatch is still awaiting the server (the AI
      // fallback runs inside the request, up to ~90s — pending is the
      // expected state, and the prop lane shows "Asking AI…" instead).
      // The id set alone misses mid-flight REPLACEMENTS (editing the same
      // prop again mints a new id while the key-level dispatch is still
      // out), so also resolve the id through the buffers to its dispatch
      // key and check the key-level in-flight sets (codex).
      if (inFlightOverrideIdsRef.current.has(p.id)) return
      const pendingProp = pendingPropEditsRef.current.find((e) => e.id === p.id)
      if (
        pendingProp &&
        branchPropInFlight.current.has(
          propEditKey(pendingProp.target.selector, pendingProp.propName),
        )
      ) {
        return
      }
      const bufferedMutation = mutationsRef.current.find((m) => m.id === p.id)
      if (
        bufferedMutation &&
        branchTextInFlight.current.has(mutationIdentity(bufferedMutation))
      ) {
        return
      }
      const queued = mutationsRef.current.some(
        (m) => m.id === p.id && queuedForAiRef.current.has(mutationIdentity(m)),
      )
      if (!queued) {
        setSaveStatus("Edit applied but not yet confirmed by the prototype")
      }
    })
    return () => {
      unsubCaptured()
      unsubAwaiting()
      unsubResolutionFailed()
      unsubOverridePreviewFailed()
      unsubDragMove()
      unsubInsertAtPoint()
      unsubOverrideReverted()
      unsubOverrideUnverified()
      unsubResize()
      // Cancel any in-flight debounced branch-mode text dispatches; the
      // adapter is going away (new mount or unmount), so firing the
      // timer afterwards would call into a stale adapter ref.
      for (const t of timers.values()) {
        clearTimeout(t)
      }
      timers.clear()
      // Drop the in-flight identity set too — once the adapter is gone,
      // any pending dispatch will short-circuit on the `adapter` null
      // check, but a stale identity in the set would block future
      // dispatches when a new adapter mounts.
      inFlight.clear()
      dispatchBranchTextMutationRef.current = null
      // Same teardown for the prop auto-commit timers/in-flight set, using the
      // captured locals (not ref.current, which may have changed by cleanup).
      for (const t of propTimers.values()) {
        clearTimeout(t)
      }
      propTimers.clear()
      propInFlight.clear()
    }
    // `handleDragMove` / `handleInsertAtPoint` / `handleResize` are listed so a
    // future edit that makes one reactive cannot silently strand a stale
    // closure in the bridge subscription.
    //
    // They are inert TODAY, but read the chain before relying on that:
    // `handleDragMove` and `handleInsertAtPoint` are `useCallback(…, [])`;
    // `handleResize` is `useCallback(…, [handleClassesEdit])`, and
    // `handleClassesEdit` is itself `[]`. So handleResize is stable only
    // TRANSITIVELY. Give `handleClassesEdit` a real dependency and this effect
    // starts re-running.
    //
    // And re-running is NOT free — an earlier version of this comment claimed
    // "the cleanup just unsubscribes, so re-running is safe" and that is wrong.
    // The cleanup below also `clearTimeout`s every pending debounced dispatch
    // and `.clear()`s both in-flight guard sets (the Codex P0 #1 out-of-order
    // overwrite guard). Re-running mid-edit therefore DROPS debounced edits and
    // reopens the race those sets exist to close. If you make anything in this
    // dep list reactive, make the cleanup re-entrant-safe first.
  }, [
    adapterReadyMarker,
    dispatchBranchTextMutation,
    dispatchBranchClassMutation,
    handleDragMove,
    handleInsertAtPoint,
    handleResize,
  ])

  /**
   * Phase E3 — after an external-edit-conflict the designer can ask to
   * force-overwrite (drop the conflicting files from baseHashes and
   * re-run save) or reload (discard pending mutations and reload the
   * iframe so the panel re-syncs against the engineer's file state).
   *
   * `handleSaveAll` is hoisted via a ref because it's defined further
   * down. Calling through the ref avoids the TDZ + circular-callback
   * dance while still letting "Force overwrite" actually re-attempt
   * the save (codex Phase E P2).
   */
  const handleSaveAllRef = useRef<
    (() => Promise<{ ok: true } | { ok: false; reason: string }>) | null
  >(null)

  const handleClearConflict = useCallback(() => {
    setConflict(null)
  }, [])

  const handleForceOverwrite = useCallback(async () => {
    if (!conflict) return
    for (const c of conflict.files) {
      delete fileHashesRef.current[c.file]
    }
    setConflict(null)
    setSaveStatus(null)
    // Re-run the save now that the conflicting hashes are cleared. The
    // route will read the on-disk source (which IS the engineer's
    // version) and the LLM patches on top of it. Backups still capture
    // the pre-overwrite state so the engineer can recover via
    // .desde/backups/.
    await handleSaveAllRef.current?.()
  }, [conflict])

  const handleReloadAfterConflict = useCallback(() => {
    setConflict(null)
    setMutations([])
    setPendingDisambiguations([])
    fileHashesRef.current = {}
    setSaveStatus(null)
    adapterRef.current?.clearPropOverrides()
    adapterRef.current?.clearAttrOverrides()
    adapterRef.current?.clearClassOverrides()
    // Reload via the bridge's RELOAD_PROTOTYPE message rather than
    // touching `iframe.src` from the parent. Parent-side
    // `iframe.src = …` reloads at the SRC ATTRIBUTE (the parent's
    // last assignment, usually the session-start route) — not at the
    // iframe's actual current URL. After any SPA navigation that
    // bounces the user back to the start route. RELOAD_PROTOTYPE
    // runs inside the iframe and calls `window.location.reload()`,
    // which preserves the live SPA URL.
    //
    // `force` mode: this fires from the user clicking "Reload" after
    // a conflict, so it must always reload regardless of the
    // backstop flag. The flag only governs the AUTOMATIC post-edit
    // safety net; explicit user actions bypass it.
    requestPrototypeReload(iframeRef.current, "conflict-reload", "force")
  }, [iframeRef])

  /**
   * Merge a chat-proposed edit into the live editing state. Called by
   * `useEditorChat` when the orchestrator emits an `edit_proposed` event.
   *
   * - `prop_edit` → look up the selection by selector; if it matches
   *   the current `editorSelection`, push a `PropEdit` into
   *   `pendingPropEdits` (which the Vue3 adapter previews live) and
   *   dispatch it to the working tree.
   * - `overwrite` → dispatch a synthetic `OverwriteEdit` straight to the
   *   working tree (branch mode — see the immediate-dispatch note below).
   *
   * Selection drift handling: if the user moved their selection after
   * the agent learned it but before the proposal arrived, the
   * selector won't match the current selection. We refuse the prop
   * edit and surface a status so the user knows to re-pin and re-ask.
   */
  const applyAgentProposal = useCallback(
    async (
      editId: string,
      proposal:
        | {
            type: "prop_edit"
            selector: string
            targetId?: string
            propName: string
            value: unknown
          }
        | {
            type: "overwrite"
            file: string
            newSource: string
            baseHash?: string
            explanation?: string
            /** Phase 4: true when this is a new-file creation. */
            allowCreate?: boolean
            /**
             * SDK runtime — agent has already written the file. Shell
             * must NOT re-apply via adapter.applyEdit, only record
             * the proposal for diff display.
             */
            appliedByAgent?: boolean
          }
        | {
            type: "file_delete"
            file: string
            baseHash: string
            appliedByAgent?: boolean
          }
        | {
            type: "file_rename"
            fromFile: string
            toFile: string
            baseHash: string
            appliedByAgent?: boolean
          },
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      // File-delete and file-rename carriers are always agent-applied
      // (the SDK MCP tool performed the unlink/rename inline before
      // emitting). The shell records the proposal for the activity log
      // and marks the turn dirty (drives the post-turn reload in
      // `handleChatTurnComplete`) — but does not attempt a re-apply.
      if (proposal.type === "file_delete" || proposal.type === "file_rename") {
        chatTurnDirtyRef.current = true
        if (proposal.type === "file_delete") {
          setSaveStatus(`Agent deleted ${proposal.file}.`)
        } else {
          setSaveStatus(`Agent renamed ${proposal.fromFile} → ${proposal.toFile}.`)
        }
        return { ok: true }
      }
      if (proposal.type === "prop_edit") {
        // Selection-drift detection: prefer matching by targetId
        // (stable across selector normalization quirks); fall back to
        // exact-selector match if the agent didn't pin a targetId
        // (older read tool output, pre-Phase-2.1).
        const selection = useEditorStore.getState().editorSelection
        const matched =
          selection != null &&
          (proposal.targetId
            ? selection.targetId === proposal.targetId
            : selection.selector === proposal.selector)
        if (!selection || !matched) {
          const reason =
            "Selection changed before the agent's prop edit arrived. Re-select the element and ask again."
          setSaveStatus(reason)
          return { ok: false, reason }
        }
        // Validate the value shape against what the adapter accepts
        // before buffering. Catches the "agent passed an object for a
        // string prop" class of drift early, instead of failing on
        // Save when the diagnostic would be far from the cause.
        if (!isAcceptablePropValue(proposal.value)) {
          const reason = `Prop value type ${describeJsType(proposal.value)} is not supported by the Vue3 adapter (string | number | boolean only).`
          setSaveStatus(reason)
          return { ok: false, reason }
        }
        const adapter = adapterRef.current
        const propEdit: PropEdit = {
          kind: "prop",
          id: editId,
          target: selection,
          propName: proposal.propName,
          value: proposal.value as PropEdit["value"],
        }
        setPendingPropEdits((prev) => {
          // Last-write-wins per (selector, propName) — mirrors
          // handlePropEdit so multiple agent proposals on the same
          // prop collapse to the latest value.
          const filtered = prev.filter(
            (e) =>
              !(e.target.selector === selection.selector && e.propName === proposal.propName),
          )
          return [...filtered, propEdit]
        })
        // Mirror handlePropEdit's prop vs attr routing for live preview:
        // typed props mutate `instance.props`; fallthrough attrs walk
        // the rendered DOM subtree.
        if (adapter) {
          const isTypedProp =
            selection.currentProps && proposal.propName in selection.currentProps
          const isAttr =
            !isTypedProp &&
            selection.currentAttrs &&
            proposal.propName in selection.currentAttrs
          if (isAttr) {
            attrEditIdsRef.current.add(propEdit.id)
            // WS3: overrideId correlation (codex round-19) — without it the
            // failure path resolves an id the bridge never registered and a
            // refused AI attr edit stays visible.
            adapter.applyAttrOverride(
              selection.selector,
              proposal.propName,
              propEdit.value,
              propEdit.id,
            )
          } else {
            attrEditIdsRef.current.delete(propEdit.id)
            // WS3: same overrideId correlation as dispatchAllRowsPropEdit.
            adapter.applyPropOverride(
              selection.selector,
              proposal.propName,
              propEdit.value,
              propEdit.id,
            )
          }
        }
        // Buffering alone would never reach disk: `pendingPropEdits` is the
        // live transient the debounced dispatch drains, so arm it here too
        // (matches dispatchAllRowsPropEdit). Without this the agent's prop
        // edit previews but never lands in the working tree.
        scheduleBranchPropDispatch(selection.selector, proposal.propName)
        return { ok: true }
      }
      // overwrite — mirrors the Tier 3 path's synthetic target.
      // Phase 4: allowCreate flows through so the save endpoint can
      // create the file instead of rejecting with ENOENT.
      const overwrite: StructuralEdit = {
        kind: "overwrite",
        id: editId,
        target: {
          targetId: proposal.file,
          selector: proposal.file,
        },
        file: proposal.file,
        newSource: proposal.newSource,
        baseHash: proposal.baseHash,
        allowCreate: proposal.allowCreate,
      }
      const verb = proposal.allowCreate ? "create" : "rewrite"
      // Branch mode: edits land in the working tree immediately so the dev
      // server can HMR them into the iframe before Commit (which is just
      // the commit step). Without this, the agent's "removed the column,
      // click Commit" message would not reflect in the live preview,
      // because the file was never written.
      //
      // SDK runtime: the agent (via canUseTool → SDK Write/Edit) has
      // ALREADY written the file to the working tree when
      // `appliedByAgent` is set. A shell applyEdit here would race the
      // SDK's write and double-write the change. Skip the disk write.
      if (proposal.appliedByAgent) {
        chatTurnDirtyRef.current = true
        setSaveStatus(
          `Agent applied (${verb}) ${proposal.file}.`,
        )
        return { ok: true }
      }
      const adapter = adapterRef.current
      if (!adapter) {
        const reason = "Editor adapter not ready, try again in a moment."
        setSaveStatus(reason)
        return { ok: false, reason }
      }
      const result = await adapter.applyEdit(overwrite)
      if (result.kind === "failed") {
        setSaveStatus(
          `Agent proposal failed (${verb}) for ${proposal.file}: ${result.reason}`,
        )
        return { ok: false, reason: result.reason }
      }
      chatTurnDirtyRef.current = true
      setSaveStatus(
        `Agent applied (${verb}) ${proposal.file}.`,
      )
      return { ok: true }
    },
    [scheduleBranchPropDispatch],
  )

  const handleSaveAll = useCallback(async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    const adapter = adapterRef.current
    if (!adapter) return { ok: true } // nothing to do, trivially ok
    // Track per-call success so callers can chain a session-merge or
    // similar after a successful buffered-edit flush. Set false on any
    // failure path; the function still resolves normally so existing
    // onClick callers (which ignore the return) keep working unchanged
    // (Codex review W-4-client #3).
    let saveOk = true
    // Captures the catch block's reason so the function can return it
    // alongside `ok: false`. The earlier failure paths already return a
    // typed `{ ok: false, reason }` directly — only the throw path needs
    // this hoist because the catch + the final `return` are split by the
    // finally block.
    let saveThrowReason: string | null = null
    // The llm-patch applicator hard-refuses class/style mutations
    // (apply-llm-patch.ts: "V1 only patches text and attr"), so direct
    // CLASS mutations must NOT go through that lane — they go through
    // `scoped-css-override` instead, with no `:deep()` because the
    // call-site IS the styled element. Direct text/attr mutations
    // continue to use llm-patch. Without this split, a designer
    // editing the bg color of an element that happens to carry
    // data-desde-src on itself (e.g. a back button in the prototype's own
    // SFCs) hit a 422 and the bridge's in-memory `!important` style
    // masked the failure — visual change appears to "stick" until a
    // refresh wipes the override and reveals the unwritten file.
    const directMutations = mutations.filter(
      (m) => m.resolutionKind === "direct" && m.kind !== "class",
    )
    // Class mutations route through the scoped-css-override lane in
    // BOTH the direct case (call-site is the styled element → rule on
    // `.scopeClass` alone) and the ancestor case (inner library element
    // → `:deep()` rule pierces the scope boundary).
    const scopedOverrideMutations = mutations.filter(
      (m) =>
        m.kind === "class" &&
        m.sourceLoc !== null &&
        (m.resolutionKind === "direct" || m.resolutionKind === "ancestor"),
    )
    if (
      directMutations.length === 0 &&
      scopedOverrideMutations.length === 0
    ) {
      // Codex P0 #2: `hasUnsavedChanges` now includes
      // `pendingDisambiguations.length` so Save is click-able when a
      // v-for disambiguation is the only unsaved state. If we
      // silently return `{ ok: true }` here the user sees "saved!"
      // with no resolved disambiguation and nothing on disk. Surface
      // the gap loudly instead so the user knows the edit needs an
      // explicit scope choice (or, with the auto-resolve scope guard
      // in onMutationAwaitingDisambiguation, that the bridge couldn't
      // identify an unambiguous origin and the in-iframe edit was
      // genuinely ambiguous).
      //
      // In practice this should rarely be hit: `MutationDisambiguationDialog`
      // (driven by `disambiguationPrompt`) now opens automatically the
      // moment an item lands in `pendingDisambiguations`, at capture time —
      // well before the designer ever reaches Save. This gate is
      // belt-and-braces for the gap between capture and the dialog
      // mounting (or a dialog dismissed via Escape without an explicit
      // choice, which — same as its Cancel button — discards rather than
      // resolves).
      // Read the ALWAYS-CURRENT ref, not the closed-over state. `handleSaveAll`
      // does not depend on `pendingDisambiguations` (depending on it would
      // rebuild the callback every time one lands), so the captured value can
      // be stale — and a stale 0 here would return `{ ok: true }` and show
      // "saved!" with nothing written, which is the exact failure this guard
      // exists to prevent. `pendingDisambiguationsCountRef` is assigned on
      // every render for precisely this read-at-fire-time case.
      const pendingDisambiguationCount = pendingDisambiguationsCountRef.current
      if (pendingDisambiguationCount > 0) {
        const n = pendingDisambiguationCount
        const reason = `Cannot save: ${n} edit${n === 1 ? "" : "s"} still need a scope choice. Resolve the "Resolve ambiguous edit" dialog, or dismiss it to discard, before saving.`
        setSaveStatus(reason)
        return { ok: false, reason }
      }
      return { ok: true }
    }
    setSaving(true)
    setSaveStatus(null)
    // Reset prior LLM state — the dialog should not show stale trace
    // info from a previous save while the current one is in flight.
    setSavePendingLLMInput(null)
    setSaveLastLLMTrace(null)
    const saveStart = performance.now()
    console.info("[Editor] save-dispatch", {
      mutations: mutations.length,
      directMutations: directMutations.length,
      scopedOverrides: scopedOverrideMutations.length,
    })
    try {
      // Buffered structural + prop edits no longer exist: every
      // direct-manipulation edit dispatches to the working tree the
      // moment it's made (branch mode). This flush is now solely the
      // AI-queue drain — the fuzzy DOM mutations the deterministic lane
      // refused mid-edit, applied here via the llm-patch bundle.
      // Dispatch DOM mutation log as a single llm-patch bundle.
      if (directMutations.length > 0) {
        const selection = useEditorStore.getState().editorSelection
        const baseHashes = { ...fileHashesRef.current }
        // Eagerly snapshot the input the LLM would see (capped at 10
        // entries, mirroring the server's truncation). The dialog
        // renders this WHILE the request is in flight so the designer
        // sees "Asking AI to interpret these N edits" instead of a
        // blank spinner. If the server's fast-path handles the bundle
        // (no LLM call), the dialog clears this on response.
        //
        // This is the commit/flush path — it dispatches with
        // `llmFallback: 'patch'` (below) to APPLY queued fuzzy edits via
        // the LLM, so the progress snapshot is wanted here (unlike the
        // typing-time path, which queues silently).
        setSavePendingLLMInput(
          directMutations.slice(0, 10).map((m) => ({
            id: m.id,
            kind: m.kind,
            sourceLoc: m.sourceLoc,
            target: m.target,
            before: m.before.length > 200 ? m.before.slice(0, 200) + '…' : m.before,
            after: m.after.length > 200 ? m.after.slice(0, 200) + '…' : m.after,
          })),
        )
        // Phase E1 — normalize the panel's "this instance" default on
        // any callsite-scope mutation the designer didn't explicitly
        // toggle. The panel surfaces the toggle (default: this-instance)
        // for any non-class callsite mutation with a known callsiteLoc;
        // here we make the saved disambiguationChoice match the UI's
        // visual default. Without this step, an unticked toggle falls
        // through with disambiguationChoice=undefined and the prompt
        // has no clean routing rule.
        const normalizedMutations: Mutation[] = directMutations.map((m) => {
          if (
            m.disambiguationChoice === undefined &&
            m.scope === "callsite" &&
            m.callsiteLoc !== null &&
            m.kind !== "class"
          ) {
            return { ...m, disambiguationChoice: "this-instance" }
          }
          return m
        })
        // Reset the streaming buffer on dispatch. Tokens accumulate into
        // a ref (cheap per-token) and the throttled state push (below)
        // is what triggers re-renders in the dialog.
        saveStreamingTextRef.current = ''
        setSaveStreamingText('')
        let streamFlushTimer: ReturnType<typeof setTimeout> | null = null
        const flushStreamSoon = () => {
          if (streamFlushTimer !== null) return
          // ~33ms cadence = 30fps, smooth enough for live text rendering
          // without re-rendering the whole dialog per token.
          streamFlushTimer = setTimeout(() => {
            streamFlushTimer = null
            setSaveStreamingText(saveStreamingTextRef.current)
          }, 33)
        }
        const result = await adapter.applyEdit(
          {
            kind: "llm-patch",
            id: makeEditId(),
            target: selection ?? {
              targetId: "llm-patch-bundle",
              selector: "llm-patch-bundle",
              ancestry: [],
            },
            mutations: normalizedMutations,
            // Commit/flush path: APPLY via the LLM lane (parallel per-file
            // server-side), not escalate. This is where queued fuzzy edits
            // actually get written to the worktree.
            llmFallback: "patch" as const,
            ...(Object.keys(baseHashes).length > 0 ? { baseHashes } : {}),
          },
          {
            onLLMStreamStart: () => {
              // Reset on start so a previous save's tail doesn't
              // contaminate the new run. (We also reset above on
              // dispatch, but the start event arrives only AFTER the
              // server confirmed the LLM actually fires — i.e. the
              // fast-path was bypassed.)
              saveStreamingTextRef.current = ''
              setSaveStreamingText('')
            },
            onLLMStreamDelta: (delta) => {
              saveStreamingTextRef.current += delta
              flushStreamSoon()
            },
          },
        )
        // Final flush so the last tokens land in state even if the
        // throttled timer hadn't fired yet.
        if (streamFlushTimer !== null) {
          clearTimeout(streamFlushTimer)
          streamFlushTimer = null
        }
        setSaveStreamingText(saveStreamingTextRef.current)
        if (result.kind === "failed") {
          // `'chat'` fallback mode: the deterministic lane couldn't apply
          // the bundle, so the server returned `needsChat`. Hand it to
          // the chat agent and clear the dispatched mutations from the
          // buffer instead of surfacing a save error.
          if (result.needsChat && escalateToChatRef.current) {
            escalateToChatRef.current(
              buildEditEscalationPrompt(normalizedMutations),
            )
            setSavePendingLLMInput(null)
            const escalatedIds = new Set(normalizedMutations.map((m) => m.id))
            setMutations((prev) =>
              prev.filter((m) => !escalatedIds.has(m.id)),
            )
            return { ok: true }
          }
          // Phase E3 — if the route returned 409 + conflicts, surface
          // them in the panel with reload / force-overwrite recovery.
          // Mutations stay in the buffer so the designer can re-save
          // after choosing.
          if (result.conflicts && result.conflicts.length > 0) {
            setConflict({
              files: result.conflicts,
              pendingMutations: directMutations.slice(),
            })
            const reason = `External-edit conflict on ${result.conflicts.length} file(s): choose a recovery option.`
            setSaveStatus(reason)
            return { ok: false, reason }
          }
          const reason = `Save failed at DOM mutations: ${result.reason}`
          setSaveStatus(reason)
          setSavePendingLLMInput(null)
          return { ok: false, reason }
        }
        if (result.kind === "applied" && result.newHashes) {
          fileHashesRef.current = {
            ...fileHashesRef.current,
            ...result.newHashes,
          }
        }
        // Capture the LLM trace if the server invoked it. Absent on the
        // fast-path; presence is what the dialog uses to decide between
        // "Saved" (deterministic) and "AI made the changes" (LLM) framing.
        if (result.kind === "applied" && result.llmTrace) {
          setSaveLastLLMTrace(result.llmTrace)
        }
        // Clear the in-flight LLM input regardless of which path ran —
        // success means the dialog should move from "Asking AI…" to the
        // outcome view (either the trace, or just "Saved" for fast-path).
        setSavePendingLLMInput(null)
        const directIds = new Set(normalizedMutations.map((m) => m.id))
        setMutations((prev) => prev.filter((m) => !directIds.has(m.id)))
        // WS3 (codex round-9): the flush just landed every mutation in this
        // bundle — release their preview overrides so the bridge stops
        // re-asserting/reporting them. (The failure paths above deliberately
        // do NOT resolve: on conflict/hard-failure the mutations stay
        // buffered for re-save and the preview legitimately rides; on
        // needsChat escalation chat lands the edit later and HMR shows
        // truth — the store's give-up timeout bounds the assertion either
        // way.)
        for (const m of normalizedMutations) {
          resolveOverrideSettled(adapter, m.id, "confirmed")
        }
        // The queued fuzzy edits in this bundle were just applied — clear
        // them from the AI queue so the Commit badge resets.
        if (queuedForAiRef.current.size > 0) {
          const dispatchedKeys = new Set(
            normalizedMutations.map((m) => mutationIdentity(m)),
          )
          for (const k of queuedForAiRef.current) {
            if (dispatchedKeys.has(k)) queuedForAiRef.current.delete(k)
          }
          setAiQueueCount(queuedForAiRef.current.size)
        }
      }

      // 3. Dispatch each ancestor-resolution class mutation as its own
      //    scoped-css-override edit. Sequential (not parallel): later
      //    edits may upsert additional rules into the same style block
      //    a previous edit just wrote, and the applicator is idempotent
      //    PER (file, scopeClass, deepSelector) but the file is shared.
      //    Failures stop the loop; succeeded edits stay.
      //
      // Track the EXPLICIT ids of mutations whose applyEdit succeeded
      // so the cleanup filter never confuses skipped mutations
      // (malformed sourceLoc, empty class diff) with saved ones —
      // slicing by a counter would silently remove the wrong ids.
      const scopedOverrideSavedIds: string[] = []
      const flushDestination = await resolveStyleDestination()
      if (!flushDestination.ok && scopedOverrideMutations.length > 0) {
        setSaveStatus(`Save failed: ${flushDestination.reason}`)
        return { ok: false, reason: flushDestination.reason }
      }
      const flushOpts = flushDestination.ok ? flushDestination.opts : {}
      /** Widest blast radius across this flush, reported once at the end. */
      let widestRadius: number | undefined
      for (const m of scopedOverrideMutations) {
        // Shared with the branch-mode class dispatch so the Tailwind-
        // resolution + deep-selector logic stays single-sourced. Framework-aware
        // (Vue → scoped-css-override; React → jsx-style). Null = no sourceLoc /
        // no class diff → skip (matches the prior inline guards).
        const edit = buildStyleEdit(m, flushOpts)
        if (!edit) continue
        if (
          m.anchorMatchCount !== undefined &&
          m.anchorMatchCount > (widestRadius ?? 1)
        ) {
          widestRadius = m.anchorMatchCount
        }
        if (isUnsupportedStyleBuild(edit)) {
          // Surface loudly rather than skip — the change can't be expressed on
          // this substrate (e.g. an inline-only React app + a shadow utility).
          const reason = `Save failed: ${edit.unsupported}`
          setSaveStatus(reason)
          return { ok: false, reason }
        }
        const result = await adapter.applyEdit(edit)
        if (result.kind === "failed") {
          const reason = `Save failed at scoped-css-override ${scopedOverrideSavedIds.length + 1}: ${result.reason}`
          setSaveStatus(reason)
          return { ok: false, reason }
        }
        scopedOverrideSavedIds.push(m.id)
      }
      if (scopedOverrideSavedIds.length > 0) {
        const savedIds = new Set(scopedOverrideSavedIds)
        setMutations((prev) => prev.filter((m) => !savedIds.has(m.id)))
        // "N > 1 must say N" (§ 9g.8 item 4). One rule can cover several
        // elements — on React that is the normal shape for a first-party
        // component, whose internal root stamp is shared by every instance —
        // and the number was already in hand.
        const radiusNote = blastRadiusNotice(widestRadius)
        if (radiusNote) setSaveStatus(radiusNote)
      }

      // Clear bridge overrides. Files are now the source of truth; any
      // HMR/reload from the substrate will reflect them.
      adapter.clearPropOverrides()
      adapter.clearAttrOverrides()
      // After a successful save the bridge's preview state diverges
      // from the on-disk state — Vue's HMR may or may not pick up
      // every change cleanly, and the bridge previously mutated DOM
      // that Vue doesn't own. A hard reload re-syncs.
      //
      // Vite HMR sometimes misses editor file writes — suspected
      // causes: race between fs.writeFile and chokidar, a stale HMR
      // WebSocket left over from a long-lived dev-server session, manual
      // textContent mutation pre-empting Vue's diff. Designers were
      // seeing "the save did nothing" — the file WAS written, but the
      // iframe kept showing the pre-edit render until manual refresh.
      //
      // Backstop via the bridge's RELOAD_PROTOTYPE message — runs
      // `window.location.reload()` inside the iframe, which preserves
      // the live SPA URL. A previous version did `iframe.src =
      // iframe.src` from the parent, which bounces to the start route
      // because the src ATTRIBUTE doesn't track SPA navigation.
      const anyApplied =
        directMutations.length > 0 || scopedOverrideSavedIds.length > 0
      if (anyApplied) {
        requestPrototypeReload(iframeRef.current, "save-success")
      }

      const elapsed = Math.round(performance.now() - saveStart)
      const summary = [
        directMutations.length > 0 && `${directMutations.length} DOM mutation(s)`,
        scopedOverrideSavedIds.length > 0 &&
          `${scopedOverrideSavedIds.length} scoped CSS override(s)`,
      ]
        .filter(Boolean)
        .join(", ")
      setSaveStatus(`Saved ${summary}.`)
      console.info("[Editor] save-success", {
        elapsed_ms: elapsed,
        mutations: directMutations.length,
        scopedOverrides: scopedOverrideSavedIds.length,
      })
    } catch (err) {
      saveOk = false
      const reason = `Save threw: ${(err as Error).message}`
      setSaveStatus(reason)
      saveThrowReason = reason
      console.warn("[Editor] save-threw", err)
    } finally {
      setSaving(false)
    }
    if (!saveOk) {
      // saveThrowReason is set only when the catch block ran. Any earlier
      // failure path returned its own typed reason above (the function
      // doesn't reach this point on those branches). Defensive fallback
      // for completeness.
      return { ok: false, reason: saveThrowReason ?? "Save failed." }
    }
    return { ok: true }
    // `buildStyleEdit` (called in the body) is a stable top-level import —
    // no dep entry needed. This deps array previously named the unrelated
    // `buildScopedCssOverrideEdit` callback (stale from before
    // `buildStyleEdit` replaced a direct call here); both were always
    // stable regardless, so removing it is behavior-neutral.
    // `resolveStyleDestination` IS a hook value and IS read in the body (the
    // flush needs a destination stylesheet before it can build a React
    // override), so it is named — it is stable, so this costs nothing.
  }, [iframeRef, mutations, resolveStyleDestination])

  // Wire the ref so handleForceOverwrite can re-trigger the save.
  // Updating on every render is cheap and keeps the ref pointing at
  // the current closure (so it sees the latest mutations + hashes).
  handleSaveAllRef.current = handleSaveAll

  const setEditorActive = useCallback(async (active: boolean) => {
    await adapterRef.current?.setActive(active)
  }, [])

  // Called by `useEditorChat` on `turn_complete`. If the agent wrote
  // any files to the worktree during the turn, ask the bridge to
  // reload so the user sees the disk state immediately. Same backstop
  // rationale as handleSaveAll — Vite HMR alone misses these writes
  // often enough that "chat edits appear instantly" was breaking.
  //
  // Uses RELOAD_PROTOTYPE (iframe-internal `window.location.reload`)
  // rather than parent-side `iframe.src = …` so the SPA URL is
  // preserved (the src attribute lags behind SPA navigation).
  const handleChatTurnComplete = useCallback(() => {
    if (!chatTurnDirtyRef.current) return
    chatTurnDirtyRef.current = false
    requestPrototypeReload(iframeRef.current, "chat-turn-complete")
  }, [iframeRef])

  return {
    setEditorActive,
    status,
    editorSelection,
    editorManifest,
    layersRoots,
    /**
     * The unfiltered tree, for mapping a selection the density filter hid
     * back onto the nearest row the panel is still showing.
     */
    layersRawRoots,
    layersDensity,
    setLayersDensity,
    layersRefreshing,
    layersError,
    refreshLayers,
    handleLayerSelect,
    handleSelectMany,
    handleClearSelection,
    handleLayerHover,
    handleLayerMove,
    handleLayerMoveRefused,
    handleDetach,
    handleLayerDetach,
    handleLayerDelete,
    deleteScopePrompt,
    confirmDeleteScope,
    cancelDeleteScope,
    iterationScopePrompt,
    confirmIterationScope,
    cancelIterationScope,
    disambiguationPrompt,
    confirmDisambiguation,
    cancelDisambiguation,
    handleLayerInsert,
    handleLayerUnwrap,
    handleLayerFlattenConditional,
    handlePropEdit,
    handleEditTextField,
    handleClassesEdit,
    handleEditTextBranch,
    applyAgentProposal,
    handleChatTurnComplete,
    saving,
    saveStatus,
    /**
     * Count of fuzzy edits queued for the AI (deterministic lane refused
     * mid-edit). Applied at commit via `handleSaveAll`'s `'patch'`
     * dispatch. Drives the Commit "N need AI" badge.
     */
    aiQueueCount,
    /** Eager mutation snapshot rendered while the LLM is in flight. */
    savePendingLLMInput,
    /** Trace returned by the route when the LLM ran (null on fast-path). */
    saveLastLLMTrace,
    /** Accumulated LLM response text streaming live during the save. */
    saveStreamingText,
    /** Phase 3 — "This page" scope: apply a style edit as a scoped-css-override. */
    handleScopedStyleEdit,
    /** §6 Phase 3 — "The token" scope: patch the design token's value at its definition. */
    handleTokenStyleEdit,
    handleSaveAll,
    conflict,
    handleClearConflict,
    handleForceOverwrite,
    handleReloadAfterConflict,
    handleSwap,
    swapDialogOpen,
    handleSwapConfirm,
    handleSwapCancel: () => setSwapDialogOpen(false),
    handlePickIcon,
    handleEditComponent,
    handleExitComponentEdit,
    componentEditState,
    supportsRenderedValueRead,
    supportsMeasurementsRead,
    /**
     * Final review fix wave — invalidate the SAME `CachedManifestLookup`
     * instance `attribute()` reads from, keyed by `(name, importPath)`.
     * Threaded down to `DesignSystemsPanel`'s `useDriftEntries` (via
     * `EditorSettingsMenu`) so a repair that settles through a
     * dismiss/clear/regenerate-hints response also drops the stale cached
     * manifest, not only when a later text-edit-driven drift POST happens
     * to carry the same `invalidate` list.
     */
    invalidateAttributionManifest,
  }
}

/**
 * Coerce a PropControlValue (string | number | boolean) into the JSON
 * payload value the iteration-data prompt expects. Identity for the
 * three primitive types; future PropControlValue expansions land here.
 */
function serializePropValue(
  v: PropControlValue,
): string | number | boolean {
  return v
}

/**
 * The Vue3 adapter's `applyPropOverride` / `applyAttrOverride` reject
 * anything outside the primitive set. Validate the agent's proposed
 * value before buffering so the model gets a clear diagnostic rather
 * than a save-time failure. Null is accepted as "unset".
 */
function isAcceptablePropValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function describeJsType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Encode a UTF-8 string as base64url (RFC 4648 §5) — `-`/`_` instead
 * of `+`/`/`, and no `=` padding. Safe to drop into a URL path
 * segment without further escaping.
 *
 * Browser-side equivalent of Node's
 * `Buffer.from(s).toString('base64url')`. Used for the F4 isolation
 * config segment so the route URL stays query-free (Vite's html-
 * proxy mechanism breaks when the page has a query string).
 */
function encodeBase64Url(input: string): string {
  // TextEncoder → Uint8Array → binary string → btoa is the standard
  // browser idiom for getting raw bytes through btoa correctly when
  // the string contains non-ASCII characters.
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

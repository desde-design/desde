"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { RefObject } from "react"
import type {
  ComponentManifestSource,
  DisambiguationChoice,
  DragMoveRequest,
  EditResult,
  FrameworkAdapter,
  InsertAtPointRequest,
  ResizeRequest,
  IconManifest,
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
import type { IterationEditKind } from "@/editor/edit-service/iteration-fallback"
import {
  logIterationScopeChoice,
  requestIterationProposal,
} from "@/editor/edit-service/iteration-fallback"
import { applyEditWithChatHandoff } from "./apply-edit-with-chat-handoff"
import type { ChatHandoffOutcome } from "./apply-edit-with-chat-handoff"
import {
  afterEscalation,
  buildEditEscalationPrompt,
} from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  coalesceCapturedMutation,
  mutationIdentity,
  pruneAiQueue,
  shouldProbeClassMutation,
  shouldProbeTextMutation,
} from "./editor-mutation-coalesce"
import { recordHmrTreeUpdate, requestPrototypeReload } from "./editor-hmr-watchdog"
import {
  blastRadiusNotice,
  buildPageScopedCssOverrideEdit,
  buildStyleEdit,
  isUnsupportedStyleBuild,
  type StyleEditDestinationOptions,
} from "@/editor/edit-service/style-edit-builders"
import { useIframeStylesheetTargets } from "./useIframeStylesheetTargets"
import {
  isOverrideStylesheetRefusal,
  resolveOverrideStylesheet,
} from "@/components/editor/resolve-override-stylesheet"
import { makeEditId } from "@/editor/edit-service/make-edit-id"
import { describeEditOutcome } from "./edit-outcome"
import { handleResolutionFailure } from "./resolution-failure-notice"
import { offeredDisambiguationChoices } from "./disambiguation-choices"
import { routeAwaitingDisambiguation } from "./disambiguation-route"
import { notifySingleChoiceDisambiguation } from "./single-choice-disambiguation-notice"
import { notifyOverridePreviewFailure } from "./override-preview-notice"
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
import {
  bridgeDraftIdOf,
  DEFERRED_PARK_STATUS,
  NOT_CONNECTED_STATUS,
  iterationRouteFor,
  parkedReason,
  MALFORMED_ITERATION_STATUS,
  sameBridgeDraft,
  SAVE_HANDOFF_TIMEOUT_STATUS,
  SAVE_PAGE_CHANGED_STATUS,
  settleHandOff,
  structuralRouteFor,
  type PendingIterationEdit,
} from "./pending-iteration-edit"
import {
  hasUndispatchedWork,
  isSupersededHandshake,
  shouldEndSessionOnHandshake,
  type BridgeSessionEndReason,
} from "@/editor/session/session-state"
import type { ModalRequest as SessionModalRequest } from "@/editor/session/modal-queue"
import {
  EditSession,
  type SessionEndResult,
} from "@/editor/session/edit-session"

/** The one dialog request shape this hook raises, bound to its prompt type. */
type ModalRequest = SessionModalRequest<PendingIterationEdit>
import {
  dispatchPropEdit,
  propEditKey,
} from "@/editor/edit-service/lanes/prop-lane"
import {
  dispatchClassMutation,
  dispatchTextMutation,
  type TextLaneDeps,
} from "@/editor/edit-service/lanes/text-lane"
import {
  dispatchIteration,
  interceptIteration,
} from "@/editor/edit-service/lanes/iteration-lane"
import { verifyIterationLoop } from "./iteration-verify"
import { parkedSaveRefusal, saveGate } from "./save-gate"

/**
 * Shared empty listing for "this refresh found no `.vue` files". A module
 * constant so the identity is stable: `layersRoots` memoizes on this map, and
 * a fresh `new Map()` per refresh would rebuild the filtered tree (and
 * re-render the whole panel) for no reason.
 */
const EMPTY_CONDITIONAL_GROUPS: Map<string, FileConditionalGroups> = new Map()

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
   * Hand a direct-manipulation edit to the chat agent in a NEW chat
   * session. Used for `needsChat` refusals, for structural edits the
   * deterministic lane refused, and for iteration prompts whose loop
   * could not be found in source.
   *
   * Resolves to whether the hand-off was ACCEPTED: `true` when the server
   * took the chat turn, `false` when the client-side guard refused it (a chat
   * is already streaming, or no transport exists) or when the POST itself
   * failed. Asynchronous on purpose: the guard is knowable at once, but the
   * server's answer is not, and a caller that clears its edit buffer on a
   * synchronous `true` can lose an edit the server then refused.
   *
   * `options.signal` aborts the submission itself, not just the wait for it.
   * A hand-off that has passed its deadline is parked in the deterministic
   * dialog, and the chat turn must not still be on its way to the same
   * element: the agent would write the file while the designer picks a scope
   * for the very same edit. See `settleHandOff`.
   */
  escalateToChat?: (
    prompt: string,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean>
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

  /**
   * The chat submission, as one stable function.
   *
   * Through the REF, not the captured prop: the iteration lane hands off after
   * an HTTP round trip that can take fifteen seconds, and the prop can be
   * replaced in that window. A shell with no chat resolves false, which is the
   * refusal the lane already treats "there is nowhere to send this" as.
   */
  const handOffToChat = useCallback(
    (prompt: string, options?: { signal?: AbortSignal }): Promise<boolean> =>
      escalateToChatRef.current?.(prompt, options) ?? Promise.resolve(false),
    [],
  )

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

  /**
   * The one status line the whole hook writes to.
   *
   * Declared HERE, above the session, rather than next to `saving` where the
   * rest of the save state lives. The session is built during the first render
   * and its `onModalOpened` writes this line, so the setter has to exist by
   * then; a `useState` further down the file has not run yet at that point.
   */
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  /**
   * THE bridge session. One document in the iframe, as an object.
   *
   * `useMemo` with no dependencies rather than `useRef`, because the session is
   * created once per hook instance and never replaced: attaching, ending and
   * reconnecting are transitions ON it, not new ones.
   *
   * Seventeen refs used to hold what it holds, spread across this file. The
   * map from each old name to its replacement is in
   * `src/editor/session/README.md`; it is not repeated here, because a test in
   * `src/editor/session/edit-session.test.ts` reads THIS file and fails on any
   * of those names, and documentation that names them would be the thing that
   * fails it.
   *
   * The buffers, the dialog rows, the open question and the held drafts are
   * on it too, read through {@link sessionState} below.
   */
  const session = useMemo(
    () =>
      new EditSession<PendingIterationEdit>({
        promptDraftId: bridgeDraftIdOf,
        propEditKey: (edit) => propEditKey(edit.target.selector, edit.propName),
        mutationKey: mutationIdentity,
        onModalOpened: (request) => {
          if (request.kind === "disambiguation" && request.reason !== undefined) {
            setSaveStatus(request.reason)
          }
        },
      }),
    [],
  )

  /**
   * What the session is holding, as React sees it.
   *
   * `useSyncExternalStore` rather than four `useState`s plus four "always
   * latest" mirror refs. The mirrors existed because the async lanes have to
   * read the CURRENT buffer from inside a `setTimeout`, and a state value
   * captured at render is half a second old by then. Two authorities for one
   * array is how a retirement and a coalesce could disagree; there is one now,
   * and React reads it rather than owning it.
   *
   * Only the three fields something RENDERS from are named below. The prop
   * buffer has no render-time reader at all: every lane that touches it runs
   * inside a callback, and a callback reads `session.getSnapshot().propEdits`
   * so it sees the buffer as it is at that moment rather than as it was when
   * the callback was built.
   */
  const sessionState = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  )
  /** The captured DOM mutations, for Save and for the flush's own filters. */
  const mutations = sessionState.mutations
  /** The open scope question, rendered by `IterationScopeDialog`. */
  const iterationScopePrompt = sessionState.scopePrompt

  /**
   * True only once React has begun unmounting this hook.
   *
   * Both cases give every held draft back to the bridge, so this decides only
   * whether the teardown SAYS what it discarded. `enabled` flipping off leaves
   * the panels mounted, so the status line is read; unmounting takes the status
   * bar with it, and a count nobody can see is a state write for nothing.
   *
   * Declared BEFORE the adapter effect deliberately. React runs a component's
   * cleanups in the order its effects were defined, so on unmount this one runs
   * first and the flag is already set when the adapter's cleanup reads it. An
   * `enabled` flip re-runs only the adapter effect and never this one, so the
   * flag cannot be true in that case, which is the direction that would cost
   * the designer their typed text.
   */
  const hookUnmountingRef = useRef(false)
  /**
   * The prototype URL as of the LATEST render, so the adapter effect's cleanup
   * can tell why it is running.
   *
   * The cleanup closes over the url its own attachment used; this ref already
   * holds the new one, because React renders before it runs cleanups. Different
   * values mean the iframe is being pointed at another prototype, which is a
   * document change and must retire the buffers; equal values mean the effect
   * re-ran for one of its other dependencies (`enabled`, the manifest source,
   * an attribution callback) with the same page still on screen.
   */
  const prototypeUrlRef = useRef(prototypeUrl)
  prototypeUrlRef.current = prototypeUrl
  useEffect(() => {
    // Reset on every (re-)mount, the same way `useEditorChat`'s `disposedRef`
    // does. StrictMode runs mount → unmount → mount on ONE instance, so the
    // cleanup below latches `true` and the flag would still be true at the
    // second mount. A later `enabled` flip would then take the unmount arm of
    // the adapter teardown on a hook that is still on screen.
    hookUnmountingRef.current = false
    return () => {
      hookUnmountingRef.current = true
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
    // A new session starts here. Anything still in flight from the previous
    // one is now stale, whatever it does next.
    //
    // `attach` deliberately leaves the DOCUMENT id alone. The session that was
    // running ended in the previous cleanup, and the reason it ended decided
    // whether the document is still the same one: a plain `teardown` detaches
    // the adapter with the page still on screen and keeps the id, so this
    // attachment's first handshake can recognise the page and re-arm the
    // buffered edits made against it (`resumePlan`). Every reason that IS a
    // document change forgets the id inside `session.end`, and so does a failed
    // handshake, so the first-handshake-ends-nothing case is still covered
    // wherever it is true.
    session.attach()

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
          // THE DOCUMENT BOUNDARY. A handshake that reports a different
          // document than the one this attachment adopted means the page was
          // replaced, and everything the previous page's session was holding
          // ends here — before the new document is adopted, so a continuation
          // that resumes afterwards sees the session it belongs to as over.
          //
          // Nothing is cancelled with the bridge: those drafts died with the
          // document that issued them, and the instance that would receive the
          // cancel is a different one that numbers its own drafts from
          // `dom-pending-1`.
          //
          // Every bridge the shell accepts reports its document id, so the ids
          // decide this on their own; a bridge that reports none is refused at
          // the handshake instead (`REQUIRED_BRIDGE_VERSION`).
          const documentToken = adapter.bridgeDocumentId
          if (shouldEndSessionOnHandshake(session.documentId, documentToken)) {
            // Through `endBridgeSession`, not through the end inside
            // `session.start`: the buffers, the dialog rows and the held drafts
            // are still this hook's, and they are half of what a document
            // change discards. The end forgets the document, so the `start`
            // below adopts the new one and does not end a second time.
            endBridgeSessionRef.current?.({
              reason: "reconnect",
              cancelWithBridge: false,
            })
          }
          // `bridgeDocumentId` is `string | null` and `start` takes the same,
          // so there is no `?? ""` here: an empty string would be ADOPTED as a
          // real document and the next handshake would read as a change.
          const { resumed } = session.start(documentToken, (mutation) =>
            mutationResumeEligibleRef.current(mutation),
          )
          setStatus({ kind: "ready" })
          // THE SAME DOCUMENT, ANSWERING AGAIN, which is what a non-null
          // `resumed` says. It is either the page's own second handshake or an
          // adapter that detached and came back with the page still on screen.
          // A plain teardown keeps the buffered edits but cancels the debounce
          // timers that would have written them, so the entries would sit in
          // the buffer with nothing left to write them. Re-arm them here, which
          // is what the designer's next keystroke would have done anyway.
          //
          // The lists ON `resumed` ARE the answer: the session holds both
          // lanes' markers, so `resume` already skipped every entry being
          // written right now, which is the rule that keeps a second timer off
          // an in-flight identity. All that is left is arming them.
          if (resumed) {
            for (const edit of resumed.propEdits) {
              scheduleBranchPropDispatchRef.current?.(
                edit.target.selector,
                edit.propName,
              )
            }
            for (const mutation of resumed.mutations) {
              scheduleBranchMutationDispatchRef.current?.(mutation)
            }
          }
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
          // A newer handshake replaced this one. Nothing failed, and the newer
          // one decides the document boundary itself.
          if (isSupersededHandshake(message)) return
          // A REAL failure: the new document never handshaked. It is
          // off-origin, or it answered 500, or the five-second timeout ran
          // out. Either way there is no document behind the session the shell
          // is still holding, and leaving it open leaves the generation where
          // it was, so every continuation from the OLD page reads itself as
          // current and acts on a page nobody can see.
          //
          // So the session ends here, the same way a reconnect ends one, and
          // nothing is handed back to the bridge: there is no bridge to hear
          // it. `reconnect` forgets the document as well as retiring the
          // buffers, so the next handshake that does complete is the first of a
          // fresh session and ends nothing.
          endBridgeSessionRef.current?.({
            reason: "reconnect",
            cancelWithBridge: false,
          })
          setStatus({ kind: "error", message })
        })
    }

    /**
     * A document in the iframe has finished loading. It MAY be a new one.
     *
     * All this does is re-handshake. `load` is a trigger, never the boundary:
     * it fires for the document the shell is already connected to whenever a
     * subresource finishes after the bridge announced itself, and ending the
     * session there discarded the designer's in-progress edits on a page that
     * was still right in front of them. The handshake carries the document's
     * id, so the boundary is decided where that id is read, in the `.then`
     * above.
     */
    const onIframeLoad = () => {
      runHandshake()
    }

    iframe.addEventListener("load", onIframeLoad)
    runHandshake()

    return () => {
      cancelled = true
      // Stop everything the iteration lane still has in flight, and end the
      // session those requests belong to: a late answer must do NOTHING, not
      // even release its own draft, because ending the session hands every held
      // draft back and the next adapter re-uses the same draft ids.
      //
      // `endBridgeSession` bumps the generation, aborts the session's requests,
      // and hands every held draft back — while the adapter is still there to
      // hear it, which is why this is ordered BEFORE `dispose()`. Via a ref
      // because the callback is defined far below this effect; see its
      // declaration.
      // WHICH REASON. `unmount` when React is taking the hook away. Otherwise
      // the effect is re-running for one of its dependencies, and the one that
      // means the DOCUMENT is being replaced is `prototypeUrl`: the iframe is
      // about to point at another prototype, which is `reload` by any other
      // name and must retire the buffers (see `retiresBufferedEntries`). Every
      // other dependency (`enabled`, the manifest source, an attribution
      // callback) detaches the adapter with the same page still on screen, and
      // that is a plain `teardown` which leaves the designer's buffered edits
      // where they are.
      const documentReplaced = prototypeUrlRef.current !== prototypeUrl
      endBridgeSessionRef.current?.({
        reason: hookUnmountingRef.current
          ? "unmount"
          : documentReplaced
            ? "reload"
            : "teardown",
        cancelWithBridge: true,
      })
      iframe.removeEventListener("load", onIframeLoad)
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
    session,
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
   * The ONE continuation for every `applyEditWithChatHandoff` call.
   *
   * Eleven call sites used to write the same three lines each, which is how a
   * guard gets added to ten of them. They now share `applyEditThenReport`
   * below, which is the only caller of this.
   *
   * Built at DISPATCH time so it captures the bridge session the edit belongs
   * to, and silent when that session has ended before the answer came back: the
   * status bar it would write to is either gone or is now describing a
   * different page, and the edit it names was applied through an adapter nobody
   * is looking at any more. The apply itself is not in question here —
   * `applyEditWithChatHandoff` holds its own adapter reference and has already
   * finished with it. Only the report is dropped.
   */
  const reportEditOutcome = useCallback((kindLabel: string) => {
    const generation = session.generation
    return ({
      result,
      handoff,
    }: {
      result: EditResult
      handoff: ChatHandoffOutcome
    }): void => {
      if (!session.isCurrent(generation)) return
      const outcome = describeEditOutcome(kindLabel, result, handoff)
      // Success carries a null message, so a successful edit says nothing.
      if (outcome.message) setSaveStatus(outcome.message)
    }
  }, [session])

  /**
   * THE dispatch for a structural edit: apply it, hand a refusal to chat, then
   * report — with one captured bridge session governing all three.
   *
   * The eleven call sites called `applyEditWithChatHandoff(...).then(report)`
   * themselves, and that shape had the guard in the wrong place. The report was
   * guarded; the HAND-OFF was not, and the hand-off is the half that acts. An
   * apply that spans a page reload could still start a chat turn saying "make
   * this edit happen" about an element on a document that no longer exists, and
   * the caller's guard only ran on the result the turn had already been started
   * for.
   *
   * So the session is handed over whole. The helper captures it on entry and
   * guards the hand-off with it; the continuation below reads it again before
   * the status. Capturing a generation here and a signal there would be
   * capturing one session at two moments.
   */
  const applyEditThenReport = useCallback(
    (
      edit: StructuralEdit,
      adapter: Pick<BridgeFrameworkAdapter, "applyEdit">,
      kindLabel: string,
    ): void => {
      // The session itself, not a generation and a signal captured here. The
      // helper enters it before the apply, which is the moment that has to be
      // captured, and it reads both facts off the one run.
      void applyEditWithChatHandoff(edit, adapter, escalateToChatRef.current, {
        session,
      }).then(reportEditOutcome(kindLabel))
    },
    [reportEditOutcome, session],
  )

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
      if (!skipIterationCheck) {
        // The DESTINATION is checked too. See `structuralRouteFor`: a context
        // the page sent and we could not read is refused, never treated as
        // "not a loop", at either end. Moving a loop row as if it were an
        // ordinary element rewrites the shared template, and so does dropping
        // a row into a loop we cannot read.
        const route = structuralRouteFor({ node: source, destParent })
        if (route === "refuse") {
          setSaveStatus(MALFORMED_ITERATION_STATUS)
          return
        }
        if (route === "iteration" && source.iterationContext) {
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
      // refusal we hand the edit off to chat (a new session, with the
      // selector and the refusal text) so cycle / coordinate-drift refusals
      // don't dead-end the user.
      applyEditThenReport(edit, adapter, "Move")
    },
    [applyEditThenReport],
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
    applyEditThenReport(edit, adapter, "Move")
  }, [applyEditThenReport])

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
      applyEditThenReport(edit, adapter, "Swap")
    },
    [applyEditThenReport],
  )

  // Icon picker — dispatches a SwapEdit (kind: 'swap') with identity
  // prop mapping. Reuses the existing swap pipeline end-to-end; the
  // only icon-specific bit is `propMapping = {}` (props are stable
  // across an icon set) and the label format. `removeFromImport` is
  // left false to match other structural edits — clearing the old
  // import is unsafe without a cross-file usage walk.
  //
  // Branch mode (matches handleLayerMove / handleLayerInsert): immediate
  // dispatch via `applyEditWithChatHandoff`. Edit lands in the working
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
      applyEditThenReport(edit, adapter, "Icon swap")
    },
    [applyEditThenReport],
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
    applyEditThenReport(edit, adapter, "Detach")
  }, [applyEditThenReport])

  // Layers-panel insert (right-click → "Insert child…"). Targets a
  // specific OutlineNode as the destination PARENT and buffers an
  // InsertEdit. The bridge shows a labeled placeholder where the new
  // element will land; the actual file write happens on Save.
  const handleLayerInsert = useCallback(
    (parentNode: OutlineNode, snippet: string, destIndex = -1) => {
      const adapter = adapterRef.current
      if (!adapter || !parentNode.editTarget) return
      // Same refusal as every other entry point (see `structuralRouteFor`).
      // The parent is a DESTINATION, so a valid loop context on it changes
      // nothing — inserting into a `v-for` adds to the shared template on
      // purpose. Only loop information we could not read refuses, because
      // then we cannot tell that case from this one. The Layers menu does not
      // offer the control in that state either; this is the dispatch half.
      if (structuralRouteFor({ destParent: parentNode }) === "refuse") {
        setSaveStatus(MALFORMED_ITERATION_STATUS)
        return
      }
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
      applyEditThenReport(edit, adapter, "Insert")
    },
    [applyEditThenReport],
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
      // This site used to write its own continuation, on the grounds that
      // insert-at-point announces a hand-off but not a success. It shares the
      // common one: `describeEditOutcome` gives success a null message, so
      // "not success" and "has a message" are the same set.
      applyEditThenReport(edit, adapter, "Insert")
    },
    [applyEditThenReport],
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
      applyEditThenReport(edit, adapter, "Delete")
    },
    [applyEditThenReport],
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
      // A context the page sent that failed the boundary check is the WORST
      // case for this handler specifically: falling through means
      // `dispatchDeleteEdit(node, "definition")`, which removes the shared
      // template and with it every row. See `iterationRouteFor`.
      if (iterationRouteFor(node) === "refuse") {
        setSaveStatus(MALFORMED_ITERATION_STATUS)
        return
      }
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
    applyEditThenReport(edit, adapter, "Unwrap")
  }, [applyEditThenReport])

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
      applyEditThenReport(edit, adapter, "Flatten")
    },
    [applyEditThenReport],
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
    applyEditThenReport(edit, adapter, "Detach")
  }, [applyEditThenReport])

  // Prop edits accumulate on the SESSION (`session.getSnapshot().propEdits`).
  // The bridge gets an APPLY_PROP_OVERRIDE / APPLY_ATTR_OVERRIDE for each so
  // the iframe shows the change live; a debounced per-(selector,propName)
  // dispatch then writes each to the working tree (see
  // `dispatchBranchPropEdit` below), mirroring the text path. The buffer is
  // the always-latest source the dispatch reads, which is why it is the
  // session's one authority and not a state plus a mirror of it.
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
  // The debounce timers and the in-flight markers are the SESSION's, under the
  // `"prop"` lane: `dispatchPropEdit` schedules and marks through it, so a
  // timer or a marker cannot outlive the page it belongs to. Key built by
  // `propEditKey`.
  /** One-shot stale-target recovery guard, keyed like the in-flight markers.
   *  Cleared on a successful dispatch; prevents 409→refresh→409 loops. It stays
   *  the hook's because a retired buffer entry has to forget its key here, and
   *  the lane never sees a session end. */
  const staleRetriedRef = useRef<Set<string>>(new Set())
  /**
   * Override ids whose dispatch is currently awaiting the server. The
   * OVERRIDE_UNVERIFIED status is suppressed for these: the store's 5s
   * timeout routinely fires DURING a long dispatch (the AI fallback can
   * take up to ~90s), and "not yet confirmed" is misleading while the
   * request is still in flight — in-flight is the expected state.
   */
  const inFlightOverrideIdsRef = useRef<Set<string>>(new Set())
  // Hoisted ref so `dispatchAllRowsPropEdit` (defined above the dispatcher)
  // can schedule it without a TDZ/circular-callback dance — same pattern as
  // `dispatchBranchTextMutationRef` / `handleSaveAllRef`.
  const dispatchBranchPropEditRef = useRef<
    ((key: string, scheduledGeneration?: number) => void) | null
  >(null)
  // Schedule the debounced auto-commit of a buffered prop edit to the working
  // tree. EVERY write to `pendingPropEdits` must call this — the buffer is the
  // live transient the debounced dispatch reads, not a save-time flush queue.
  // Skip scheduling when a dispatch for this identity is already in flight; its
  // completion re-fires if the buffer advanced meanwhile.
  const scheduleBranchPropDispatch = useCallback(
    (selector: string, propName: string) => {
      const key = propEditKey(selector, propName)
      if (session.isInFlight("prop", key)) return
      // The session this buffered edit belongs to, captured NOW rather than
      // read inside the callback half a second later. Read there it would be
      // whatever session is live when the timer fires, so a timer that outlived
      // a page reload would write the old page's edit under the new page's
      // session and pass every guard on the way. `session.schedule` refuses to
      // run the callback at all once the generation has moved.
      const generation = session.generation
      session.schedule(
        "prop",
        key,
        generation,
        () => dispatchBranchPropEditRef.current?.(key, generation),
        BRANCH_PROP_DISPATCH_DEBOUNCE_MS,
      )
    },
    [session],
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
  // The open one is `sessionState.scopePrompt`, read above as
  // `iterationScopePrompt`. It is the session's because the modal OWNER and
  // the queue behind it are, and until round 10 those three could disagree:
  // the mutation dialog opened itself the moment its rows were non-empty, the
  // scope prompt opened itself the moment its state was set, and neither knew
  // about the other. Every raise now goes through `session.requestModal` and
  // every close through `session.releaseModal`, which is one object deciding
  // both. A queued request is unsaved work with nothing on screen to mention
  // it, so `hasUndispatchedWork` and the Save gate both count
  // `session.queuedCount`.
  /**
   * How to end the bridge session, for the adapter effect and its iframe `load`
   * handler to call.
   *
   * A ref because that effect is defined ABOVE these callbacks in source order,
   * so it cannot name them in its dependency array without a temporal-dead-zone
   * error. Same trick, and the same reason, as `interceptIterationEditRef`. The
   * assignment happens during render, next to the callback itself.
   */
  const endBridgeSessionRef = useRef<
    ((args: { reason: BridgeSessionEndReason; cancelWithBridge: boolean }) => void) | null
  >(null)
  /**
   * The status line the last session end put on screen, or null.
   *
   * A page change ends the session and a save running through it stops, and both
   * write to the one status channel. The session end's line is the one worth
   * keeping: it says how many edits were discarded, which the designer cannot
   * see anywhere else. The save's line only says the save stopped, which the
   * page changing under them already told them.
   */
  const sessionEndStatusRef = useRef<string | null>(null)
  /**
   * The two schedulers, for the handshake that finds the same document still
   * there and has to re-arm what a session end cancelled.
   *
   * Refs for the same reason as `endBridgeSessionRef`: the adapter effect is
   * defined above both callbacks.
   */
  const scheduleBranchPropDispatchRef = useRef<
    ((selector: string, propName: string) => void) | null
  >(null)
  const scheduleBranchMutationDispatchRef = useRef<
    ((mutation: Mutation) => void) | null
  >(null)
  /**
   * Which buffered captures a re-arm may still write, for `session.start`.
   *
   * `EditSession.resume` takes this predicate because the answer is the
   * capture scheduler's, not the session's: a mutation that would not have
   * armed a timer when it was captured (a `class` capture with no source
   * location, an identity parked for the AI queue, one being written right
   * now) must not get one on a re-attach either. Passed as a ref for the same
   * reason as the two schedulers above: the adapter effect is defined above the
   * callback that decides it.
   */
  const mutationResumeEligibleRef = useRef<(mutation: Mutation) => boolean>(
    () => true,
  )
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
        // The session this edit was captured in. The buffer outlives the
        // document, and this is the only thing on the entry that says which
        // document it describes. See `retireForeignEntries`.
        generation: session.generation,
      }
      if (renderSite) {
        pendingPropRenderSitesRef.current.set(edit.id, renderSite)
      }
      session.updatePropEdits((prev) => {
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
    [scheduleBranchPropDispatch, session],
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
    if (!skipIterationCheck) {
      // See `iterationRouteFor`. `dispatchAllRowsPropEdit` below is the
      // shared-template write, which is exactly what an unreadable loop
      // context must not silently become.
      const route = iterationRouteFor(selection)
      if (route === "refuse") {
        setSaveStatus(MALFORMED_ITERATION_STATUS)
        return
      }
      if (route === "iteration" && selection.iterationContext) {
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
      const textRoute = iterationRouteFor(selection)
      // See `iterationRouteFor`. Falling through here rewrites the template
      // literal for every row, which is the wrong edit for a loop row and is
      // not a decision an unreadable message from the page gets to make.
      if (textRoute === "refuse") {
        setSaveStatus(MALFORMED_ITERATION_STATUS)
        return
      }
      if (textRoute === "iteration" && selection.iterationContext) {
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
      //
      // THE SESSION, as a run, the same shape the token lane uses. The byte
      // range in this edit was read off ONE document's source, and the status
      // line below is written after the write returns. A page replaced in that
      // window makes the report describe a document nobody is looking at, over
      // the line that says what the page change discarded.
      await session.run(async (ctx) => {
        try {
          const written = await ctx.step(
            adapter.applyEdit(edit, { signal: ctx.signal }),
          )
          if (written.stale) return
          const result = written.value
          if (result.kind === "failed") {
            setSaveStatus(`Conditional text edit failed: ${result.reason}`)
            return
          }
        } catch (err) {
          // `ctx.step` turns a throw from a departed session into a stale
          // answer, so this covers only a throw from the synchronous code
          // beside it. A departed page's error is not news about the page in
          // front of the designer now.
          if (!ctx.current) return
          setSaveStatus(`Conditional text edit threw: ${(err as Error).message}`)
        }
      })
    },
    [session],
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

  // ─── The bridge draft an in-page typing session is holding ───────────
  //
  // Three facts about one draft id, kept together because every rule below
  // reads more than one of them.

  // Both of them are the session's now: `session.holdDraft` / `getDraft` /
  // `releaseDraft` for the bridge's own `PendingMutation` per draft id, and
  // `session.claimPending` / `latestPendingFor` for the newest pending edit
  // per draft id.
  //
  // The first is kept rather than reconstructed because routing a draft to the
  // iteration dialog takes it OUT of the deterministic dialog's rows before it
  // is ever added, and when the iteration lane cannot land the edit the honest
  // fallback is the question that path replaced. That dialog needs the real
  // candidate list, which is the bridge's answer about the live DOM.
  //
  // The second exists because an in-page typing session rebuilds the pending
  // object on every keystroke round trip, and a newer one can take over the
  // same draft while an older one is still awaiting. Object identity is the
  // only thing that separates them: they share the draft id by construction.

  // A prompt that arrived from the BRIDGE (in-page typing) means the bridge
  // is still holding a draft mutation keyed by `bridgePendingId`. Every exit
  // from the pending state (cancel, hand-off to chat, refusal) must release
  // it, or the orphaned draft blocks Save behind `handleSaveAll`'s gate.
  // Harmless for prompts that never came from the bridge:
  // `resolveDisambiguation` no-ops on an unknown id.
  const releaseBridgeDraft = useCallback(
    (pending: PendingIterationEdit | null) => {
      if (!pending) return
      const draftId = bridgeDraftIdOf(pending)
      if (!draftId) return
      // The bridge is told here, because the adapter is this hook's. The
      // bookkeeping is the session's, and `releaseDraft` also drops any queued
      // question about this draft: the bridge has been told to forget it, so
      // answering that question would resolve an id it no longer knows.
      adapterRef.current?.resolveMutationDisambiguation(draftId, "cancel")
      session.releaseDraft(draftId)
    },
    [session],
  )

  /**
   * Release this pending's bridge draft, unless something LIVE still needs it.
   *
   * Two owners can outrank a completing pending: a NEWER intercept for the same
   * draft (the user kept typing), and the dialog currently open on it. Both
   * describe the same in-page typing session, so cancelling "this one's" draft
   * would cancel theirs. Used by every late completion — stale, disposed, or
   * post-await.
   */
  const releaseBridgeDraftUnlessShared = useCallback(
    (pending: PendingIterationEdit) => {
      const draftId = bridgeDraftIdOf(pending)
      if (draftId && session.latestPendingFor(draftId) !== pending) return
      // Read, not a `setState` updater. The open prompt used to be read
      // through one because that was the only always-current view of it, and
      // the comment on that ref said outright that releasing a bridge draft
      // from inside an updater is a side effect in a place React may run
      // twice. The snapshot is current by construction, so the read is plain.
      const open = session.getSnapshot().scopePrompt
      if (!open || !sameBridgeDraft(open, pending)) releaseBridgeDraft(pending)
    },
    [releaseBridgeDraft, session],
  )

  /**
   * Ask for a dialog. THE way either one is raised.
   *
   * Returns true when it opened now, false when it is waiting behind the
   * dialog already on screen. A false answer is not a failure: the request is
   * held with its payload and opens when the current question is answered. The
   * caller's only job then is to say so in the status bar, because a queued
   * request has no dialog of its own to be seen in yet.
   *
   * A thin forward to the session, kept as a named callback because a dozen
   * call sites and three dependency arrays name it. The decision itself, and
   * the opening that follows a true answer, are `EditSession.requestModal`:
   * putting a dialog on screen writes the owner, the queue and the state the
   * dialog renders from together, so they cannot come apart. The park status
   * line a disambiguation request carries is written by the session's
   * `onModalOpened`, which is the hook's one status channel.
   */
  const requestModal = useCallback(
    (request: ModalRequest): boolean => session.requestModal(request),
    [session],
  )

  /**
   * The shell is refusing a draft the bridge is holding. Ask the deterministic
   * question about it instead of cancelling it, now or when the modal frees up.
   *
   * Cancelling loses the designer's typed text with nothing written anywhere:
   * the in-page contentEditable path has no preview ops to revert, so the DOM
   * keeps showing a change that reached no file, and the only remaining record
   * of what they typed is gone. The dialog this asks in is the honest choice
   * that existed before the iteration lane: "this instance" or "all instances",
   * answerable and already wired to the same draft.
   *
   * The caller HAS the payload here. {@link parkOrDefer} is the same park for a
   * caller that has an iteration edit and must look the payload up.
   */
  const parkHeldOrDefer = useCallback(
    (held: PendingMutation, reason: string) => {
      if (!requestModal({ kind: "disambiguation", mutation: held, reason })) {
        // Waiting behind the open dialog. Say so, because nothing else will:
        // the question about this edit is not on screen yet.
        setSaveStatus(DEFERRED_PARK_STATUS)
      }
    },
    [requestModal],
  )

  /**
   * THE park choke point for the iteration lane.
   *
   * Every failure exit in the lane calls this, because the decision is the same
   * one at all of them and the exits are added one at a time. Three of them (a
   * failed loop check, a refused hand-off, a failed row write) opened the
   * dialog immediately until round 9, so a second edit made while a prompt was
   * open stacked the deterministic dialog over that prompt.
   *
   * Returns true when this call has taken ownership of the draft, by either
   * route, so the caller must not release it. False means there was nothing
   * held to park and the caller should say why itself: queueing a park with no
   * payload would promise a question that can never be asked.
   */
  const parkOrDefer = useCallback(
    (pending: PendingIterationEdit, reason: string): boolean => {
      const draftId = bridgeDraftIdOf(pending)
      if (!draftId) return false
      const held = session.getDraft(draftId)
      if (!held) return false
      parkHeldOrDefer(held, reason)
      return true
    },
    [parkHeldOrDefer, session],
  )

  /**
   * Close the scope prompt, by whatever path, and ask the next question.
   *
   * The ONE close for this dialog. Every exit goes through here so that "the
   * prompt closed" and "the modal was given up" cannot come apart: a request is
   * queued precisely because something is open, so a close that forgets to
   * release strands an edit the bridge is still holding, with no dialog
   * anywhere that mentions it.
   *
   * One call. `session.releaseModal` clears the scope prompt itself when a
   * SCOPE dialog was the one that just closed, and a prompt is only ever
   * non-null while the scope dialog owns the modal, so there is no second case
   * for an explicit `setScopePrompt(null)` to cover.
   */
  const closeIterationPrompt = useCallback(() => {
    session.releaseModal()
  }, [session])

  /**
   * The terminal step for an iteration edit that will NOT be applied: park the
   * bridge's draft in the deterministic dialog when there is one, and release
   * it only when there is nothing to park.
   *
   * Cancelling is not a neutral cleanup. For an in-page typing session the
   * bridge's cancel has no preview ops to revert, so the DOM keeps showing
   * text that reached no file, nothing anywhere records what was typed, and
   * Save then reports success over an edit that no longer exists. Two exits
   * used to cancel: a failed loop check, and a throw inside the verify
   * completion. The refused-hand-off exit already parked, which is what these
   * two now share.
   *
   * The parked status itself is `parkedReason`, shared with the proposal
   * refusal so the same situation is not described two ways.
   */
  const releaseOrPark = useCallback(
    (pending: PendingIterationEdit, message: string): void => {
      const parked = parkOrDefer(pending, parkedReason(message))
      // Both park routes set their own status, so only the release path states
      // the reason here.
      if (parked) return
      releaseBridgeDraft(pending)
      setSaveStatus(message)
    },
    [parkOrDefer, releaseBridgeDraft],
  )

  /**
   * {@link releaseOrPark} for a LATE completion: does nothing when something
   * live still owns the draft. The two owners are the same ones
   * `releaseBridgeDraftUnlessShared` checks — a newer intercept for the same
   * in-page typing session, and the dialog currently open on it — and the
   * reason is stronger here: parking takes the draft out of the maps, so doing
   * it to someone else's draft strands the edit they can still see.
   */
  const releaseOrParkUnlessShared = useCallback(
    (pending: PendingIterationEdit, message: string): void => {
      const draftId = bridgeDraftIdOf(pending)
      if (draftId && session.latestPendingFor(draftId) !== pending) return
      const open = session.getSnapshot().scopePrompt
      if (open && sameBridgeDraft(open, pending)) return
      releaseOrPark(pending, message)
    },
    [releaseOrPark, session],
  )

  /**
   * Drive a pending iteration edit through the chosen scope. Used by both the
   * dialog confirm path AND the remembered-scope fast path (when the user
   * already picked "this row" or "all rows" for this edit kind earlier in the
   * session).
   *
   * The dispatch itself is `dispatchIteration` in
   * `src/editor/edit-service/lanes/iteration-lane.ts`, which is a function of
   * the session and takes no refs: every await in it goes through `ctx.step`,
   * so an answer that arrives after the page changed is never read. What is
   * left here is the wiring, and the adapter instance it captures.
   */
  const dispatchIterationEdit = useCallback(
    async (pending: PendingIterationEdit, scope: IterationScope) => {
      await dispatchIteration(pending, scope, {
        session,
        handOff: handOffToChat,
        // Read ONCE, here, before the lane's first await: an adapter that
        // replaces this one mid-flight belongs to another session, and the
        // lane must not write through it.
        adapter: adapterRef.current,
        parkOrDefer,
        releaseDraft: releaseBridgeDraft,
        setStatus: setSaveStatus,
        requestProposal: requestIterationProposal,
        pageSourceFile: () => useAppStore.getState().currentSourceFile,
        // The three "all rows" re-entries. Each one re-enters an existing
        // handler with the values CAPTURED on the pending edit, never with
        // whatever the live selection has drifted to.
        applyAllRowsDelete: (row) => dispatchDeleteEdit(row.node, "definition"),
        applyAllRowsProp: (row) =>
          dispatchAllRowsPropEdit(row.selection, row.propName, row.value),
        applyAllRowsMove: (row) => legacyHandleLayerMoveRef.current?.(row.payload),
      })
    },
    // legacyHandleLayerMoveRef is a stable ref; dispatchDeleteEdit is stable.
    // The deps are intentionally minimal so the function identity stays stable.
    // (The directive below is what actually suppresses the warning - this
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
      // The question is answered, so anything waiting behind it can ask its
      // own now. Closing and releasing the modal are one call for that reason.
      // It runs BEFORE the dispatch so that a failure inside the dispatch asks
      // its own question immediately rather than queueing behind a prompt that
      // is already closed.
      closeIterationPrompt()
      void dispatchIterationEdit(pending, scope)
    },
    [iterationScopePrompt, dispatchIterationEdit, closeIterationPrompt],
  )

  const cancelIterationScope = useCallback(() => {
    // The snapshot rather than the rendered value: this runs from a dialog
    // callback, and the release below has to be about the prompt that is on
    // screen at this instant. `closeIterationPrompt` clears it on the next
    // line, so the read has to come first.
    releaseBridgeDraft(session.getSnapshot().scopePrompt)
    closeIterationPrompt()
  }, [releaseBridgeDraft, closeIterationPrompt, session])

  /**
   * Everything ending a session means OUTSIDE the session object: the bridge
   * cancels, the per-entry side tables, and the one status line.
   *
   * The plan says what was discarded and how many; this does the parts of it
   * that need the adapter and React.
   */
  const applySessionEnd = useCallback(
    (
      plan: SessionEndResult,
      { cancelWithBridge }: { cancelWithBridge: boolean },
    ) => {
      for (const entry of plan.retiredPropEdits) {
        // The per-entry side tables keyed by edit id. Left behind they leak,
        // and `attrEditIdsRef` decides how a later revert re-issues the
        // override, so a stale id there is a wrong answer, not just waste.
        attrEditIdsRef.current.delete(entry.id)
        pendingPropRenderSitesRef.current.delete(entry.id)
        inFlightOverrideIdsRef.current.delete(entry.id)
        staleRetriedRef.current.delete(
          propEditKey(entry.target.selector, entry.propName),
        )
      }
      for (const mutation of plan.retiredMutations) {
        inFlightOverrideIdsRef.current.delete(mutation.id)
      }
      // The AI queue holds IDENTITIES, not entries, and an identity left behind
      // makes the capture scheduler skip the next inline edit on that element
      // and keeps the unload warning up over a queue that is empty in fact.
      if (
        plan.retiredMutations.length > 0 &&
        pruneAiQueue(queuedForAiRef.current, plan.retiredMutations)
      ) {
        setAiQueueCount(queuedForAiRef.current.size)
      }
      if (cancelWithBridge) {
        const adapter = adapterRef.current
        for (const draftId of plan.cancelDraftIds) {
          adapter?.resolveMutationDisambiguation(draftId, "cancel")
        }
      }
      if (plan.status) setSaveStatus(plan.status)
      // Remembered so a save stopping for the same page change does not replace
      // it: that line names what the designer LOST, and the save's own line
      // only says the save stopped, which they can already see. Written on
      // EVERY end, null included, so a session end that said nothing cannot
      // leave an older end's line looking like its own.
      sessionEndStatusRef.current = plan.status
    },
    [],
  )

  /**
   * END THE BRIDGE SESSION. The one place a session ends, for all three of the
   * ways one can end.
   *
   * A "bridge session" is one document in the iframe, seen through one adapter
   * attachment. Everything the iteration lane is holding belongs to exactly one
   * of them: the drafts the bridge issued, the questions on screen about those
   * drafts, the requests waiting to become questions, and every continuation
   * that is mid-await. When the session ends, all of it ends with it.
   *
   * It ends in three ways, and until this function existed each of them cleared
   * a different subset:
   *
   * | Reason | What happens to the document | Was |
   * | --- | --- | --- |
   * | `teardown` / `unmount` | the adapter detaches | cleared everything |
   * | `reload` | the conflict reload replaces it | cleared everything but the maps' cancels |
   * | `reconnect` | the iframe loaded a NEW document | cleared NOTHING |
   *
   * The third one is why this exists. A reload the shell asks for (the
   * post-turn refresh, the post-edit backstop, the conflict reload) fires the
   * iframe's `load` event and the bridge comes back with its draft ids
   * restarted at `dom-pending-1`. Nothing bumped the generation, so an older
   * verify or hand-off resolved as if it were still current: it opened a dialog
   * about a draft the new document does not hold, applied an overwrite computed
   * for a document that is gone, or cancelled the NEW document's draft that
   * happens to have been given the same id.
   *
   * `cancelWithBridge` is the one thing the reasons genuinely disagree about.
   * A detaching adapter is still there to hear a cancel, and the cleanup runs
   * this BEFORE `dispose()` for exactly that reason. A reloaded document is
   * not: the drafts died with the document that issued them, and a cancel sent
   * afterwards names ids that now belong to somebody else.
   *
   * The count is what the designer sees, and it is decided by `sessionEndPlan`
   * rather than accumulated here, so the three reasons cannot drift apart on
   * it. `unmount` is the one reason that does not say it: there is no status
   * bar left on an unmounting hook to say it in.
   */
  const endBridgeSession = useCallback(
    ({
      reason,
      cancelWithBridge,
    }: {
      reason: BridgeSessionEndReason
      cancelWithBridge: boolean
    }) => {
      // THE SESSION'S END, and the whole of it. The generation moves, every
      // request it holds is aborted, its controller is renewed for the next
      // edit, its own timers are cancelled, and the document is forgotten when
      // the reason is a document change. That order matters: every
      // continuation still awaiting belongs to the session that is ending, and
      // the clearing is what it would otherwise resume into.
      //
      // The plan it hands back is what the designer sees. THE BUFFERS are the
      // half of it that is easy to miss. Cancelling a debounce timer stops the
      // write from being attempted; it does nothing about the entry the timer
      // was going to write, and the buffers are read by things that run under
      // the NEXT document. So the session partitions them on the generation
      // each entry was captured in, discards everything the departed document
      // left behind, and COUNTS it: applying one page's buffered edit to a
      // different page is the hazard, and a silent drop would leave the
      // designer looking for an edit nothing will ever make. That partition is
      // only for a DOCUMENT CHANGE (`retiresBufferedEntries`); a `teardown`
      // leaves the same page on screen with its previews showing, and
      // `unmount` needs nothing because React drops the hook.
      const plan = session.end(reason)
      // Both lanes' markers and both lanes' armed writes went with
      // `session.end` above. The markers are per identity and shared across
      // sessions, so they die with the session that set them: each lane's
      // `finally` refuses to give a marker up once the generation has moved (it
      // would be giving up the NEXT session's), which is only safe because the
      // end clears them. The timers matter for the same reason from the other
      // side: a debounce callback is a plain `setTimeout` that knows nothing
      // about sessions, so left running it fires after the new document has
      // attached and writes the previous page's edit into the page in front of
      // the designer now. Cancelling is the first of two locks on that door;
      // the dispatches capturing the generation at SCHEDULE time is the second.
      applySessionEnd(
        // `unmount` is the one reason that says nothing: there is no status
        // bar left on an unmounting hook to say it in. The count is the
        // session's either way; this decides only whether it is spoken.
        reason === "unmount" ? { ...plan, status: null } : plan,
        { cancelWithBridge },
      )
    },
    [applySessionEnd, session],
  )
  // Assigned during render, like the other always-latest mirrors in this hook,
  // so the adapter effect's cleanup and its `load` handler always call the
  // current one.
  endBridgeSessionRef.current = endBridgeSession

  /**
   * Funnel a pending iteration edit through: verify the loop in source,
   * then remembered-scope, then the dialog. Returns `true` synchronously
   * (the caller must not run the legacy path); the decision lands
   * asynchronously.
   *
   * The funnel itself is `interceptIteration` in
   * `src/editor/edit-service/lanes/iteration-lane.ts`. It runs inside
   * `session.run`, so the `gone()` closure this callback used to build out of
   * three refs is the run context now, and the verify and the hand-off both
   * race the session's own signal.
   */
  const interceptIterationEdit = useCallback(
    (pending: PendingIterationEdit): boolean => {
      // Not awaited: the caller needs its answer now, and the lane reports
      // everything it decides through the callbacks below.
      void interceptIteration(pending, {
        session,
        verify: verifyIterationLoop,
        handOff: handOffToChat,
        rememberedScope: (kind) => iterationScopeMemoryRef.current[kind],
        releaseDraft: releaseBridgeDraft,
        releaseDraftUnlessShared: releaseBridgeDraftUnlessShared,
        parkOrDefer,
        releaseOrPark,
        releaseOrParkUnlessShared,
        dispatch: dispatchIterationEdit,
        setStatus: setSaveStatus,
        logScopeChoice: logIterationScopeChoice,
      })
      return true
    },
    [
      session,
      dispatchIterationEdit,
      handOffToChat,
      parkOrDefer,
      releaseBridgeDraft,
      releaseBridgeDraftUnlessShared,
      releaseOrPark,
      releaseOrParkUnlessShared,
    ],
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
  // The captured mutations are `sessionState.mutations`, read as `mutations`
  // above. The disambiguation dialog's rows are `sessionState.rows`.
  /**
   * The oldest unresolved v-for disambiguation, surfaced by
   * `MutationDisambiguationDialog`. Fix for "stuck disambiguation blocks
   * Save forever": before this, anything landing in the dialog's rows
   * (multiple origin candidates, or `scope === "definition"` per the
   * honesty-rule comment in `onMutationAwaitingDisambiguation` below) had no
   * UI to resolve it, so `handleSaveAll`'s gate refused Save indefinitely.
   * Resolving the head entry surfaces the next one automatically (queue
   * semantics fall out of deriving from the array head rather than tracking a
   * separate index).
   */
  const disambiguationPrompt = sessionState.rows[0] ?? null
  /**
   * Designer picked a scope for `disambiguationPrompt`. Forwards to the
   * adapter (which promotes the pending item to a `Mutation` and emits
   * `onMutationCaptured`) then drops it from the queue — nothing else
   * removes a resolved entry from the dialog's rows.
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
      // The HEAD ROW off the snapshot, which is what the dialog is asking
      // about at this instant. Read here rather than closed over, so this
      // callback does not have to be rebuilt every time a row lands.
      const prompt = session.getSnapshot().rows[0]
      if (!prompt) return
      // KEEP the row when there is no adapter. Answering this dialog is a
      // message to the bridge, and an optional-chained call on a disposed
      // adapter sends nothing while the row is removed regardless: the designer
      // chooses a scope, the dialog closes, and the edit is gone with no record
      // of it anywhere. Teardown should have cleared this row already; if one
      // survives, refusing is the only honest answer.
      const adapter = adapterRef.current
      if (!adapter) {
        setSaveStatus(NOT_CONNECTED_STATUS)
        return
      }
      adapter.resolveMutationDisambiguation(prompt.pendingId, choice)
      session.updateRows((prev) =>
        prev.filter((p) => p.pendingId !== prompt.pendingId),
      )
      // A close, so the modal goes back to whatever is waiting. Only once the
      // last row leaves: the dialog is still on screen while another row is
      // behind this one, and it stays the owner until it isn't.
      if (session.getSnapshot().rows.length === 0) session.releaseModal()
    },
    [session],
  )
  /** Designer discarded `disambiguationPrompt` — no edit is written. */
  const cancelDisambiguation = useCallback(() => {
    // Same head-row read as the confirm above, and for the same reason.
    const prompt = session.getSnapshot().rows[0]
    if (!prompt) return
    // Same refusal as the confirm above, and for the same reason: a discard is
    // a message to the bridge too. Nothing is settled here either, because the
    // preview this would revert lives in an iframe that is gone.
    const adapter = adapterRef.current
    if (!adapter) {
      setSaveStatus(NOT_CONNECTED_STATUS)
      return
    }
    adapter.resolveMutationDisambiguation(prompt.pendingId, "cancel")
    // The ONLY settle signal on this path (L1). No mutation is emitted, so no
    // override is ever registered and no `resolveOverride` can fire — the bridge
    // reverts the draft's preview itself (`releasePendingPreview`,
    // `src/bridge/dom-edit-mode.ts`). Without this the inspector's last read
    // stays the shim's: the live run left the swatch on the discarded
    // `bg-amber-500` while the badge had reverted to `rgb(249,250,251)`.
    useEditorStore.getState().notePreviewSettled()
    session.updateRows((prev) =>
      prev.filter((p) => p.pendingId !== prompt.pendingId),
    )
    // Same close rule as the confirm above.
    if (session.getSnapshot().rows.length === 0) session.releaseModal()
  }, [session])
  const [saving, setSaving] = useState(false)
  /**
   * Why the last STARTED save ended badly, or null if it did not.
   *
   * The save dialog used to infer this from `saveStatus`'s wording, and
   * `saveStatus` is a shared channel: the iteration lane writes hand-off
   * sentences to it with no save in flight, and some of those read as
   * failures. This is the structured signal instead. It is written only by
   * `handleSaveAll`, only for a save that got past the pre-save gate (a gate
   * refusal is toast territory and must not raise a modal over the dialog it
   * is telling the designer to answer), and it is cleared when the next save
   * begins.
   */
  const [lastSaveFailure, setLastSaveFailure] = useState<string | null>(null)
  /**
   * Set the moment a save passes the pre-save gate and goes in flight. A ref
   * rather than state because the wrapper below reads it immediately after the
   * inner run resolves, and a state write would not be visible yet.
   */
  const saveStartedRef = useRef(false)
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
  // by any autosave), unresolved v-for disambiguations
  // (the disambiguation dialog's rows, where the designer has not picked a
  // target yet so nothing has been written), and dialogs waiting behind the
  // open one (`session.queuedCount`, where the bridge is holding the drafts
  // and no dialog mentions them yet, which makes them the easiest of the
  // three to lose).
  // The rule itself is `hasUndispatchedWork`, a pure function, so it can be
  // read and tested without a listener. Registers once at mount and reads all
  // three at fire-time rather than re-registering per state change: the
  // session's snapshot is current by construction, so there is nothing to
  // re-subscribe to.
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const undispatched = hasUndispatchedWork({
        aiQueue: queuedForAiRef.current.size,
        parked: session.getSnapshot().rows.length,
        deferred: session.queuedCount,
      })
      if (!undispatched) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [session])

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
        if (session.hasInFlight("prop") || session.hasInFlight("text")) {
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
  }, [session])
  const BRANCH_TEXT_DISPATCH_DEBOUNCE_MS = 500
  // Prop edits debounce on the same cadence (a slider/number drag fires many
  // intermediate values; we auto-commit only after the designer settles).
  const BRANCH_PROP_DISPATCH_DEBOUNCE_MS = 500

  /**
   * Branch-mode dispatch for a buffered prop/attr edit, keyed by
   * `propEditKey(selector, propName)`.
   *
   * The dispatch itself is `dispatchPropEdit` in
   * `src/editor/edit-service/lanes/prop-lane.ts`, which is a function of the
   * session and takes no refs. What is left here is the wiring: the adapter
   * instance, the shell-side side tables keyed by edit id, and the four
   * callbacks that write to React state.
   *
   * `scheduledGeneration` is the bridge session the caller decided to write in,
   * which for a debounced call is the session that was live when the designer
   * typed, half a second before this runs. It defaults to the session that is
   * live now, for the immediate callers who have no wait to span.
   */
  const dispatchBranchPropEdit = useCallback(
    async (key: string, scheduledGeneration?: number) => {
      const adapter = adapterRef.current
      if (!adapter) return
      await dispatchPropEdit(key, scheduledGeneration ?? session.generation, {
        session,
        adapter,
        escalateToChat: escalateToChatRef.current,
        setStatus: setSaveStatus,
        recordHashes: (hashes) => {
          fileHashesRef.current = { ...fileHashesRef.current, ...hashes }
        },
        // Through the REF, not the captured instance: this is the shell-side
        // "the preview shim is gone" edge, and the throw path can reach it
        // after the adapter has been torn down.
        resolveOverride: (id, outcome, reason) =>
          resolveOverrideSettledOptional(adapterRef.current, id, outcome, reason),
        verifyEdit: (request) => verifyEditRef.current(request),
        refreshSelectionStamps: scheduleSelectionStampRefresh,
        forgetEditId: (id) => {
          attrEditIdsRef.current.delete(id)
          pendingPropRenderSitesRef.current.delete(id)
          inFlightOverrideIdsRef.current.delete(id)
        },
        setOverrideInFlight: (id, inFlight) => {
          if (inFlight) inFlightOverrideIdsRef.current.add(id)
          else inFlightOverrideIdsRef.current.delete(id)
        },
        renderSiteFor: (id) => pendingPropRenderSitesRef.current.get(id),
        staleRetried: staleRetriedRef.current,
        debounceMs: BRANCH_PROP_DISPATCH_DEBOUNCE_MS,
      })
    },
    [scheduleSelectionStampRefresh, session],
  )
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
      // The adapter this edit is being written through, read ONCE, before the
      // lane's first await. Read again afterwards it would be whichever adapter
      // is attached by then, which is the one this edit is not about.
      const adapter = adapterRef.current
      const selection = useEditorStore.getState().editorSelection
      if (!adapter || !selection) return
      // THE SESSION, as a run rather than as a captured number. Every await
      // below is a `ctx.step`, and a step whose session has ended answers
      // `stale` instead of handing back a value, so the lines after it do not
      // run at all. See `EditSession.run`.
      await session.run(async (ctx) => {
        // This lane has an await before it writes anything: resolving where a
        // rule may go can ask the DOCUMENT (`GET_STYLESHEET_TARGETS`), and a
        // page replaced in that window makes the answer describe another app's
        // stylesheets.
        const resolved = await ctx.step(resolveStyleDestination())
        if (resolved.stale) return
        const destination = resolved.value
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
          // The hashes come off the promise itself, BEFORE staleness is
          // decided, the way both mutation lanes do it: they are disk truth,
          // not session state, and dropping them leaves the next save
          // comparing against a hash this write invalidated.
          const write = adapter
            .applyEdit(edit, { signal: ctx.signal })
            .then((outcome) => {
              if (outcome.kind === "applied" && outcome.newHashes) {
                fileHashesRef.current = {
                  ...fileHashesRef.current,
                  ...outcome.newHashes,
                }
              }
              return outcome
            })
          // The page this edit was made on may be gone. Then nothing below
          // runs: the status bar is describing a different page, and an
          // aborted request arrives here as a failure that is not one.
          const written = await ctx.step(write)
          if (written.stale) return
          const result = written.value
          if (result.kind === "failed") {
            setSaveStatus(`Scoped style edit failed: ${result.reason}`)
            return
          }
          // Blast radius, AFTER the write and only when it is bigger than one.
          // The count comes from the same `resolveDomAnchor` call that produced
          // the anchor, so it describes the rule that was actually written, and
          // it is a lower bound (the rendered page, not every route), which the
          // copy says out loud.
          if (built.notice) setSaveStatus(built.notice)
        } catch (err) {
          // Same rule for the throw path: a departed page's error is not news
          // about the page in front of the designer now. `ctx.step` turns a
          // throw from a departed session into a stale answer, so this covers
          // only a throw from the synchronous code between the steps.
          if (!ctx.current) return
          setSaveStatus(`Scoped style edit threw: ${(err as Error).message}`)
        }
      })
    },
    [resolveStyleDestination, session],
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
      // The adapter this edit is being written through, read ONCE, before the
      // lane's one await.
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
      // THE SESSION, as a run. The write is this lane's one await, so it is
      // one `ctx.step`: a session that ended while it was out answers `stale`
      // and everything after it is skipped.
      await session.run(async (ctx) => {
        try {
          // Keep the external-edit hash guard in sync with our own write, like
          // the other immediate applyEdit paths, so the next save doesn't trip
          // the conflict guard against this change. Disk truth first, then the
          // session check, the same order every other lane uses.
          const write = adapter
            .applyEdit(edit, { signal: ctx.signal })
            .then((outcome) => {
              if (outcome.kind === "applied" && outcome.newHashes) {
                fileHashesRef.current = {
                  ...fileHashesRef.current,
                  ...outcome.newHashes,
                }
              }
              return outcome
            })
          // The page this token edit was made on may be gone. Nothing below is
          // meaningful for the page that replaced it: the verification reads the
          // NEW document for a value written into the old one's stylesheet, and
          // the status bar is describing something else now.
          const written = await ctx.step(write)
          if (written.stale) return
          const result = written.value
          if (result.kind === "failed") {
            setSaveStatus(`Token edit failed: ${result.reason}`)
            return
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
          // Same rule for the throw path: a departed page's error is not news
          // about the page in front of the designer now. `ctx.step` turns a
          // throw from a departed session into a stale answer, so this covers
          // only a throw from the synchronous code beside it.
          if (!ctx.current) return
          setSaveStatus(`Token edit threw: ${(err as Error).message}`)
        }
      })
    },
    [session],
  )

  /**
   * The wiring both mutation lanes take.
   *
   * One builder rather than two copies: the text lane and the class lane share
   * their markers, their timers and every side table they touch, so a dep list
   * that drifted between them would be two answers to one question. The adapter
   * is a parameter rather than a dep, because each dispatch captures the
   * instance it is writing through before its first await.
   */
  const buildMutationLaneDeps = useCallback(
    (adapter: FrameworkAdapter): TextLaneDeps => ({
      session,
      adapter,
      mutationKey: mutationIdentity,
      setStatus: setSaveStatus,
      recordHashes: (hashes) => {
        fileHashesRef.current = { ...fileHashesRef.current, ...hashes }
      },
      baseHashes: () => ({ ...fileHashesRef.current }),
      // Through the CAPTURED adapter, which is what both lanes did before the
      // move: the preview being resolved is the one this dispatch poked, and
      // an adapter that has since been replaced is not holding it.
      resolveOverride: (id, outcome, reason) =>
        resolveOverrideSettled(adapter, id, outcome, reason),
      verifyEdit: (request, onOutcome) => verifyEditRef.current(request, onOutcome),
      refreshSelectionStamps: scheduleSelectionStampRefresh,
      queueForAi: (identityKey) => {
        queuedForAiRef.current.add(identityKey)
        setAiQueueCount(queuedForAiRef.current.size)
      },
      forgetEditId: (id) => {
        inFlightOverrideIdsRef.current.delete(id)
      },
      resolveStyleDestination,
      selection: () => useEditorStore.getState().editorSelection,
      setOverrideInFlight: (id, inFlight) => {
        if (inFlight) inFlightOverrideIdsRef.current.add(id)
        else inFlightOverrideIdsRef.current.delete(id)
      },
      debounceMs: BRANCH_TEXT_DISPATCH_DEBOUNCE_MS,
    }),
    [resolveStyleDestination, scheduleSelectionStampRefresh, session],
  )

  /**
   * Branch-mode immediate-dispatch for a buffered dom-text capture.
   *
   * The dispatch itself is `dispatchTextMutation` in
   * `src/editor/edit-service/lanes/text-lane.ts`, which is a function of the
   * session and takes no refs. What is left here is the wiring above and the
   * adapter instance.
   *
   * `scheduledGeneration` is the bridge session the caller decided to write in,
   * which for a debounced call is the session that was live when the designer
   * stopped typing, half a second before this runs. It defaults to the session
   * that is live now, for the callers with no wait to span.
   */
  const dispatchBranchTextMutation = useCallback(
    async (identityKey: string, scheduledGeneration?: number) => {
      const adapter = adapterRef.current
      if (!adapter) return
      await dispatchTextMutation(
        identityKey,
        scheduledGeneration ?? session.generation,
        buildMutationLaneDeps(adapter),
      )
    },
    [buildMutationLaneDeps, session],
  )
  // Self-reference for the scheduler and the adapter effect's cleanup, both of
  // which are defined away from this callback.
  const dispatchBranchTextMutationRef = useRef<
    typeof dispatchBranchTextMutation | null
  >(null)
  dispatchBranchTextMutationRef.current = dispatchBranchTextMutation

  /**
   * Branch-mode dispatch for a buffered `class` capture, keyed by
   * `mutationIdentity`.
   *
   * The dispatch is `dispatchClassMutation`, the text lane's sibling in
   * `src/editor/edit-service/lanes/text-lane.ts`. It rides the SAME lane on the
   * session, which is what the shared `"text"` lane id says: one marker set and
   * one timer map, keyed by an identity that carries the mutation's kind, so a
   * class and a text edit on one element never collide.
   */
  const dispatchBranchClassMutation = useCallback(
    async (identityKey: string, scheduledGeneration?: number) => {
      const adapter = adapterRef.current
      if (!adapter) return
      await dispatchClassMutation(
        identityKey,
        scheduledGeneration ?? session.generation,
        buildMutationLaneDeps(adapter),
      )
    },
    [buildMutationLaneDeps, session],
  )
  const dispatchBranchClassMutationRef = useRef<
    typeof dispatchBranchClassMutation | null
  >(null)
  dispatchBranchClassMutationRef.current = dispatchBranchClassMutation

  /**
   * Arm (or re-arm) the debounced write for one buffered mutation.
   *
   * Both dispatches are ONE lane on the session, the `"text"` one, keyed by an
   * identity that carries the mutation's kind so `class` and `text` on the same
   * element cannot collide. Which dispatch a mutation takes is its kind's
   * business and nothing else's: a `class` capture is written as a CSS rule,
   * everything else rides the llm-patch lane.
   *
   * The generation is captured HERE, at schedule time, not read inside the
   * callback half a second later — read there it would be whichever session is
   * live when the timer fires, so a timer that outlived a page change would
   * write the previous page's edit under the new page's session.
   */
  const scheduleBranchMutationDispatch = useCallback(
    (m: Mutation) => {
      const key = mutationIdentity(m)
      const generation = session.generation
      const isClass = m.kind === "class"
      session.schedule(
        "text",
        key,
        generation,
        () => {
          if (isClass) void dispatchBranchClassMutationRef.current?.(key, generation)
          else void dispatchBranchTextMutationRef.current?.(key, generation)
        },
        BRANCH_TEXT_DISPATCH_DEBOUNCE_MS,
      )
    },
    [session],
  )

  /**
   * May a re-arm still write this captured mutation?
   *
   * Exactly the two questions the capture scheduler asks, in the same order:
   * a mutation that would not have armed a timer when it was captured must not
   * get one now either (a `class` capture with no source location, an identity
   * parked for the AI queue). Named because `session.start` takes it too, and
   * a session whose `resume` answered "everything" would be a different
   * answer to the same question.
   */
  const isMutationResumeEligible = useCallback(
    (m: Mutation): boolean =>
      shouldProbeTextMutation(m, {
        inFlight: session.inFlightKeys("text"),
        queued: queuedForAiRef.current,
      }) ||
      shouldProbeClassMutation(m, { inFlight: session.inFlightKeys("text") }),
    [session],
  )

  // Assigned during render, like the hook's other always-latest mirrors, so the
  // adapter effect's handshake always re-arms through the current schedulers.
  scheduleBranchPropDispatchRef.current = scheduleBranchPropDispatch
  scheduleBranchMutationDispatchRef.current = scheduleBranchMutationDispatch
  mutationResumeEligibleRef.current = isMutationResumeEligible

  useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    // The lane's markers, as a live read-only view. The two `shouldProbe`
    // predicates below take a set, and they have to see the marker a dispatch
    // took a moment ago rather than a copy from effect-mount time.
    const inFlight = session.inFlightKeys("text")
    const unsubCaptured = adapter.onMutationCaptured((m) => {
      // THE tag, for both buffers' sake: the bridge knows nothing about
      // sessions, so the shell stamps the capture with the document it came
      // from as it arrives. A repeat capture on the same identity carries the
      // live session's number and `coalesceCapturedMutation` takes the
      // incoming fields, so a re-edited entry belongs to the session that
      // re-edited it. See `retireForeignEntries`.
      const tagged: Mutation = { ...m, generation: session.generation }
      // Coalesce by identity, preserving the first `before` (see
      // coalesceCapturedMutation). "Edit a field repeatedly" → one entry.
      session.updateMutations((prev) => coalesceCapturedMutation(prev, tagged))
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
        scheduleBranchMutationDispatch(m)
      }
      // `class` mutations auto-commit too, but via the scoped-css-override
      // dispatch (different applicator). Same filter the commit-time flush
      // uses for `scopedOverrideMutations` (sourceLoc + direct/ancestor).
      // Reuses the shared timers/in-flight maps — identity carries `kind`.
      if (shouldProbeClassMutation(m, { inFlight })) {
        scheduleBranchMutationDispatch(m)
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
      // Same refusal as every other entry point (see `iterationRouteFor`),
      // with two differences. It is SCOPED by the same source-position gate
      // the iteration route below uses, because only then does the selection
      // describe this mutation at all: a drifted selection must not disturb a
      // draft it has nothing to do with. And it cannot simply return: the
      // bridge is holding a draft for this pendingId, and an orphaned draft
      // blocks Save behind `handleSaveAll`'s gate forever.
      //
      // So it PARKS rather than cancels. Cancelling would throw away what the
      // designer typed in the page, and the in-page contentEditable path has
      // no preview ops to revert, so the page would go on showing text that
      // reached no file. Refusing the ITERATION route is not the same as
      // refusing the edit: the deterministic "this instance / all instances"
      // question is still answerable, and the queue below is where it is
      // asked. Same rule as the iteration lane's own failures
      // (`parkOrDefer`). DEFERRED when a scope prompt is open, for the same
      // reason the lane's own parks are: the deterministic dialog opens itself
      // and would land on top of the question being asked.
      if (
        iterationRouteFor(selection) === "refuse" &&
        selectionLoc !== null &&
        selectionLoc === p.draft.sourceLoc
      ) {
        parkHeldOrDefer(p, MALFORMED_ITERATION_STATUS)
        return
      }
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
        // Keep the bridge's own payload. The iteration lane may fail to land
        // this edit (chat refuses the hand-off, the proposal or the write
        // fails), and the honest fallback is the deterministic dialog this
        // route skipped, which needs the real candidate list.
        session.holdDraft(p.pendingId, p)
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

      // The bridge's ordinary route, and it goes through the SAME owner as
      // every other raise. It used to push straight into
      // `pendingDisambiguations`, which opens the dialog on its own the moment
      // it is non-empty: with a scope prompt already up, this landed on top of
      // the question the designer was answering. Nothing about this route is a
      // failure, so it carries no reason and leaves the status bar alone.
      if (!requestModal({ kind: "disambiguation", mutation: p })) {
        // Waiting. Say so, because the edit is held with nothing on screen
        // about it until the open question is answered.
        setSaveStatus(DEFERRED_PARK_STATUS)
      }
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
      const pendingProp = session.getSnapshot().propEdits.find((e) => e.id === p.id)
      if (
        pendingProp &&
        session.isInFlight(
          "prop",
          propEditKey(pendingProp.target.selector, pendingProp.propName),
        )
      ) {
        return
      }
      const bufferedMutation = session.getSnapshot().mutations.find((m) => m.id === p.id)
      if (
        bufferedMutation &&
        session.isInFlight("text", mutationIdentity(bufferedMutation))
      ) {
        return
      }
      const queued = session.getSnapshot().mutations.some(
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
      dispatchBranchTextMutationRef.current = null
      // Both lanes back to rest. The adapter is going away (a new mount or an
      // unmount), so a debounce that fired afterwards would call into an
      // adapter that is gone, and a marker left behind would block the first
      // dispatch for that identity once a new adapter attaches. One call per
      // lane, and neither touches the other.
      //
      // This cleanup never runs for the teardown-time `adapterReadyMarker`
      // bump. That render's body returns early at `if (!adapter) return` above,
      // so no subscription is registered and there is nothing to clean up.
      // The early return is load-bearing: were this cleanup to run then, it
      // would clear the markers and the armed timers that W2/X2 exist to keep,
      // and the buffered edits held over a plain detach would never re-arm.
      session.resetLane("prop")
      session.resetLane("text")
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
    // The cleanup below also takes BOTH lanes back to rest, which cancels every
    // armed debounced write and drops every in-flight marker (the out-of-order
    // overwrite guard). Re-running mid-edit therefore DROPS debounced edits and
    // reopens the race those markers exist to close. If you make anything in
    // this dep list reactive, make the cleanup re-entrant-safe first.
  }, [
    session,
    adapterReadyMarker,
    scheduleBranchMutationDispatch,
    handleDragMove,
    handleInsertAtPoint,
    handleResize,
    parkHeldOrDefer,
    requestModal,
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
    fileHashesRef.current = {}
    // Cleared BEFORE the session ends, not after: ending it says how many held
    // edits the reload threw away, and that sentence is the last word here.
    setSaveStatus(null)
    // A reload ends the drafts' session as surely as a teardown does, without
    // detaching the adapter: the bridge comes back a fresh instance numbering
    // its drafts from `dom-pending-1` again. So it goes through the same one
    // function, and it clears NOTHING of its own first. The captured mutations
    // used to be emptied by hand on the line above this one, which took them
    // out of the buffer before the end could count them, so the reload was the
    // one end that threw work away without saying how much (findings S2, T4).
    //
    // `cancelWithBridge` is true, for the same reason the detach passes true:
    // the bridge is still there. The reload below is REQUESTED THROUGH it, so
    // it is listening when the cancels go out, and a draft handed back is a
    // preview reverted rather than one left on screen belonging to nothing.
    endBridgeSessionRef.current?.({ reason: "reload", cancelWithBridge: true })
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
          // Same tag as the designer's own prop edits: the agent's proposal is
          // about the document on screen when it arrived, and it sits in the
          // same buffer. See `retireForeignEntries`.
          generation: session.generation,
        }
        session.updatePropEdits((prev) => {
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
      // THE ONE WRITE IN THIS HOOK THAT SITS OUTSIDE THE SESSION, deliberately.
      // Every other lane's write is a page-bound source edit, and a page change
      // is the honest reason to abandon it. This one is the agent's file
      // rewrite answering a chat turn: the caller is the chat runtime waiting
      // for an answer, not the iframe, so the write has to complete and report
      // whatever the page does. Cancelling it on the session's signal would
      // half-answer the agent, and returning `stale` would leave the turn with
      // no answer at all.
      //
      // The generation is captured BEFORE the await, so the status lines below
      // can still be guarded: a departed page's "Agent applied…" must not land
      // over the line saying what the page change discarded.
      const generation = session.generation
      const result = await adapter.applyEdit(overwrite)
      if (result.kind === "failed") {
        if (session.isCurrent(generation)) {
          setSaveStatus(
            `Agent proposal failed (${verb}) for ${proposal.file}: ${result.reason}`,
          )
        }
        return { ok: false, reason: result.reason }
      }
      chatTurnDirtyRef.current = true
      if (session.isCurrent(generation)) {
        setSaveStatus(
          `Agent applied (${verb}) ${proposal.file}.`,
        )
      }
      return { ok: true }
    },
    [scheduleBranchPropDispatch, session],
  )

  const runSaveAll = useCallback(async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    saveStartedRef.current = false
    const adapter = adapterRef.current
    if (!adapter) return { ok: true } // nothing to do, trivially ok
    /**
     * Stop the save because the document went away. Touches no overrides, no
     * mutations, and reloads nothing: the buffer still holds whatever was not
     * written, and it belongs to a page that is no longer on screen.
     *
     * The in-flight LLM snapshot IS cleared, because it is the save dialog's
     * own "asking AI to interpret these N edits" panel and leaving it up would
     * describe a request that is over.
     *
     * Called ONCE, from below the run. A step inside the run that comes back
     * stale returns `null` rather than reporting, so the report is written in
     * one place whichever of the four awaits the page change landed in.
     */
    const stopForPageChange = (): { ok: false; reason: string } => {
      setSavePendingLLMInput(null)
      // The session end that stopped this save may already have said something
      // better on this one channel: "N pending edits were discarded" names what
      // the designer LOST, and this line would replace it with the fact that the
      // save stopped, which the page changing under them already showed. So it
      // only writes when the line on screen is not that one.
      setSaveStatus((current) =>
        current !== null && current === sessionEndStatusRef.current
          ? current
          : SAVE_PAGE_CHANGED_STATUS,
      )
      // The RETURN is unchanged either way: the caller records why the save
      // failed, and that is the page change whatever the status bar reads.
      return { ok: false, reason: SAVE_PAGE_CHANGED_STATUS }
    }
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
    {
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
      // The check runs BEFORE anything is applied, and refuses the whole
      // Save. It used to run only when both mutation arrays were empty, so
      // one writable mutation was enough to skip it: Save applied that
      // mutation, said "saved", and left the parked edit sitting in its
      // dialog. `saveGate` is the decision, kept pure and tested.
      //
      // In practice this should rarely be hit: `MutationDisambiguationDialog`
      // (driven by `disambiguationPrompt`) now opens automatically the
      // moment an item lands in the dialog's rows, at capture time, well
      // before the designer ever reaches Save. This gate is
      // belt-and-braces for the gap between capture and the dialog
      // mounting (or a dialog dismissed via Escape without an explicit
      // choice, which — same as its Cancel button — discards rather than
      // resolves).
      // Read the SESSION, not a closed-over value. `handleSaveAll` does not
      // depend on the dialog's rows (depending on them would rebuild the
      // callback every time one lands), so a captured value could be stale.
      // A stale 0 here would return `{ ok: true }` and show "saved!" with
      // nothing written, which is the exact failure this guard exists to
      // prevent. The snapshot is current at the moment it is read, which is
      // precisely this read-at-fire-time case.
      // Both counts, because only one dialog is on screen at a time: an edit
      // whose question is still queued is exactly as unwritable as the one
      // being asked about, and it appears in no other count.
      const parkedRows = session.getSnapshot().rows.length
      const pendingDisambiguationCount = parkedRows + session.queuedCount
      const gate = saveGate({
        pendingDisambiguations: parkedRows,
        queuedModalRequests: session.queuedCount,
        mutations: directMutations.length,
        scoped: scopedOverrideMutations.length,
      })
      if (gate === "blocked-parked") {
        const reason = parkedSaveRefusal(pendingDisambiguationCount)
        setSaveStatus(reason)
        return { ok: false, reason }
      }
      if (gate === "nothing") return { ok: true }
    }
    setSaving(true)
    setSaveStatus(null)
    // Past the pre-save gate: from here on a failure is a FAILED SAVE, and the
    // save dialog is the right place to say so. Before here it is a refusal to
    // start, which belongs in a toast.
    saveStartedRef.current = true
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
    // THE SESSION THIS SAVE BELONGS TO, as one run.
    //
    // A save is several requests in a row, and the page can be replaced between
    // any two of them: the AI-queue flush runs an LLM on the server and takes
    // as long as that takes, and the scoped-CSS flush is one request per
    // mutation. Everything after the boundary would act on the wrong document.
    // It resolves a stylesheet against the NEW page, writes the departed page's
    // scoped-CSS mutations into it, clears the departed page's preview
    // overrides, and reloads the page that replaced it.
    //
    // So every await below is a `ctx.step`, which does not hand back a value
    // once the session has ended, and `ctx.signal` goes to every request whose
    // transport takes one. The lanes' own runs cover a single edit; this one
    // covers the multi-request run. `null` is this body's way of saying "the
    // page changed"; the caller below does the reporting.
    const run = await session.run(async (
      ctx,
    ): Promise<{ ok: true } | { ok: false; reason: string } | null> => {
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
          // THE HASHES COME OFF THE PROMISE ITSELF, before staleness is decided.
          // They are disk truth, not session state: this write landed on files
          // that are the same files whichever page is on screen now, and dropping
          // the new hashes leaves the shell's stale-target guard holding pre-write
          // ones. The next save of the same file then 409s against Desde's own
          // change (finding X5). Same order as the four single-edit lanes.
          const write = adapter.applyEdit(
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
              // The session's lifetime. Ending it aborts this request, which
              // settles as an ordinary failed result; the step below is what
              // decides what happens next, before the result is even read.
              signal: ctx.signal,
            },
          ).then((outcome) => {
            if (outcome.kind === "applied" && outcome.newHashes) {
              fileHashesRef.current = {
                ...fileHashesRef.current,
                ...outcome.newHashes,
              }
            }
            return outcome
          })
          // THE PAGE. Answered before the rest of the result is read: an abort
          // arrives here as `failed`, and reporting "Save failed at DOM mutations:
          // edit request cancelled" would blame the write for the page going away.
          const bundle = await ctx.step(write)
          // The throttled timer is this call's own, so it is cancelled whichever
          // way the flush ends. Cancelled BEFORE the staleness answer is read, or
          // a stale save would leave a timeout writing into the dialog behind it.
          if (streamFlushTimer !== null) {
            clearTimeout(streamFlushTimer)
            streamFlushTimer = null
          }
          if (bundle.stale) return null
          const result = bundle.value
          // Final flush so the last tokens land in state even if the
          // throttled timer hadn't fired yet.
          setSaveStreamingText(saveStreamingTextRef.current)
          if (result.kind === "failed") {
            // `'chat'` fallback mode: the deterministic lane couldn't apply
            // the bundle, so the server returned `needsChat`. Hand it to
            // the chat agent and clear the dispatched mutations from the
            // buffer instead of surfacing a save error.
            if (result.needsChat && escalateToChatRef.current) {
              // A refused hand-off submitted nothing, whether the client guard
              // refused it (a chat is already streaming) or the server refused
              // the POST. Dropping the bundle here and returning ok:true
              // reported a successful Save for edits that were never written and
              // no longer existed anywhere.
              //
              // BOUNDED, like the iteration lane's two hand-offs. This await sits
              // behind the save dialog, which shows no close control while a save
              // is in flight, and the server can hold a submission for a
              // concurrency slot for as long as the project's other turns take.
              // Without a bound the designer is left in front of a modal they
              // cannot dismiss, over a save that may never answer.
              const handOff = escalateToChatRef.current
              const prompt = buildEditEscalationPrompt(normalizedMutations)
              // The session's own signal goes in alongside the deadline's, the
              // way the iteration lane's hand-offs pass theirs. Without it the
              // helper aborts only on the timeout: a page changed while this POST
              // is out would still let the turn be ACCEPTED, and an accepted turn
              // edits files for the page that left. The step below cannot retract
              // a turn that has already been taken.
              //
              // The hand-off can hold for as long as the project's other turns
              // take, which is easily long enough for the page to be replaced.
              // Both arms below write `mutations`, so neither may run for a
              // document that is gone.
              const settled = await ctx.step(
                settleHandOff((signal) => handOff(prompt, { signal }), {
                  signal: ctx.signal,
                }),
              )
              if (settled.stale) return null
              const outcome = settled.value
              if (outcome === "timed-out") {
                // Neither accepted nor refused: the POST is aborted and the
                // mutations stay in the buffer, so this is a failed save with
                // everything still there to retry.
                const reason = SAVE_HANDOFF_TIMEOUT_STATUS
                setSavePendingLLMInput(null)
                setSaveStatus(reason)
                return { ok: false, reason }
              }
              const aftermath = afterEscalation(
                outcome === "accepted",
                normalizedMutations.length === 1
                  ? "This edit"
                  : `These ${normalizedMutations.length} edits`,
              )
              setSavePendingLLMInput(null)
              if (aftermath.buffer === "keep") {
                setSaveStatus(aftermath.status)
                return { ok: false, reason: aftermath.status }
              }
              const escalatedIds = new Set(normalizedMutations.map((m) => m.id))
              session.updateMutations((prev) =>
                prev.filter((m) => !escalatedIds.has(m.id)),
              )
              // The identities go with the mutations. Chat owns these edits now,
              // and an identity left in the queue makes the capture scheduler
              // skip the next inline text edit on that same element, then keeps
              // the unload warning up over a queue that is empty in fact.
              if (pruneAiQueue(queuedForAiRef.current, normalizedMutations)) {
                setAiQueueCount(queuedForAiRef.current.size)
              }
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
          // (The new hashes were recorded above, before the staleness check, so a
          // save the page change stops still leaves them on record.)
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
          session.updateMutations((prev) => prev.filter((m) => !directIds.has(m.id)))
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
          // The queued fuzzy edits in this bundle were just applied, so they
          // leave the AI queue with them and the Commit badge resets.
          if (pruneAiQueue(queuedForAiRef.current, normalizedMutations)) {
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
        // Resolving a destination stylesheet can ask the DOCUMENT
        // (`GET_STYLESHEET_TARGETS`), so a page replaced in that window makes the
        // answer describe a different app's stylesheets. Nothing may be written
        // against it.
        const resolvedFlush = await ctx.step(resolveStyleDestination())
        if (resolvedFlush.stale) return null
        const flushDestination = resolvedFlush.value
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
          // Same rule as the bundle above, and the same reason for answering
          // before the result is read: an abort is a `failed` result, and the
          // page going away is not a failure of this write.
          const scoped = await ctx.step(
            adapter.applyEdit(edit, { signal: ctx.signal }),
          )
          if (scoped.stale) return null
          const result = scoped.value
          if (result.kind === "failed") {
            const reason = `Save failed at scoped-css-override ${scopedOverrideSavedIds.length + 1}: ${result.reason}`
            setSaveStatus(reason)
            return { ok: false, reason }
          }
          scopedOverrideSavedIds.push(m.id)
        }
        if (scopedOverrideSavedIds.length > 0) {
          const savedIds = new Set(scopedOverrideSavedIds)
          session.updateMutations((prev) => prev.filter((m) => !savedIds.has(m.id)))
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
        // Same rule as the two style lanes: a departed page's error is not news
        // about the page in front of the designer now. `ctx.step` turns a throw
        // from a departed session into a stale answer, so this covers only a
        // throw from the synchronous code between the steps. `null` is the
        // body's word for "the page changed", and the `finally` below still
        // clears `saving` on the way out.
        if (!ctx.current) return null
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
    })
    // ONE report for the page change, whichever await it landed in. A step that
    // came back stale returned `null` above; a session that ended after the
    // last step is caught by `run`'s own final answer, which withholds the
    // value the same way. Either way the save stopped and nothing further was
    // applied, which is the one sentence both of them mean.
    if (run.stale || run.value === null) return stopForPageChange()
    return run.value
    // `buildStyleEdit` (called in the body) is a stable top-level import —
    // no dep entry needed. This deps array previously named the unrelated
    // `buildScopedCssOverrideEdit` callback (stale from before
    // `buildStyleEdit` replaced a direct call here); both were always
    // stable regardless, so removing it is behavior-neutral.
    // `resolveStyleDestination` IS a hook value and IS read in the body (the
    // flush needs a destination stylesheet before it can build a React
    // override), so it is named — it is stable, so this costs nothing.
  }, [iframeRef, mutations, resolveStyleDestination, session])

  /**
   * `runSaveAll` plus the one fact the save dialog needs and cannot read off
   * `saveStatus`: did THIS save fail, and why.
   *
   * The wrapper exists so the answer is recorded in one place instead of at
   * the dozen `{ ok: false }` returns inside the run, which is how the signal
   * drifted out of sync with the dialog in the first place.
   */
  const handleSaveAll = useCallback(async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    setLastSaveFailure(null)
    const result = await runSaveAll()
    if (!result.ok && saveStartedRef.current) setLastSaveFailure(result.reason)
    return result
  }, [runSaveAll])

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
     * Why the last started save failed, or null. The save dialog's failure
     * signal: structured, so it cannot be confused with another lane's prose
     * on the shared `saveStatus` channel.
     */
    lastSaveFailure,
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

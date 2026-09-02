/**
 * BridgeFrameworkAdapter — the shell-side `FrameworkAdapter` implemented over
 * the comment-bridge postMessage protocol.
 *
 * **Framework-neutral**: drives Vue 3 *and* React substrates with one code
 * path. The framework-specific work lives elsewhere — the bridge auto-detects
 * Vue vs React at runtime (`FrameworkRuntimeAdapter`) and emits a uniform
 * `InspectionData`, and the server edit-handler routes `applyEdit` to the Vue
 * or JSX applicator by the target file's extension. This adapter only relays
 * the neutral protocol (selection, structure, DOM-edit mode,
 * direct-manipulation gestures, subscriptions, and the `/api/editor/edit`
 * POST carrying the `editTarget` coordinate). See `./README.md`.
 *
 * Originally `Vue3FrameworkAdapter`; generalized when React support landed
 * (tasks/editor-react-support.md M3) after it was found to have no real Vue
 * coupling. Wraps BRIDGE_VERSION 2026-05-02a+.
 */

import type {
  AdapterSubscription,
  AdapterTarget,
  ApplyEditOpts,
  DisambiguationChoice,
  DragMoveRequest,
  EditResult,
  FrameworkAdapter,
  FrameworkId,
  InsertAtPointRequest,
  OverridePreviewFailure,
  ResizeRequest,
  Mutation,
  PendingMutation,
  SaveLLMTrace,
  Selection,
  StructuralEdit,
} from '../../core'
import type {
  BridgeMutation,
  BridgePendingMutation,
  BridgeToShellMessage,
  InspectionData,
  Measurements,
  OutlineNode,
  PreviewFailureKind,
  ShellToBridgeMessage,
  StyleOrigin,
} from '@/types/bridge'
import { editorFetch } from '@/lib/editor-fetch'
import { buildEditRequest } from './build-edit-request'
import { consumeSSEEditResponse } from './sse-consumer'
import {
  bridgeMutationDraftToCore,
  bridgeMutationToCore,
  inspectionDataToSelection,
} from './inspection-conversion'

const REQUIRED_BRIDGE_VERSION = '2026-05-06a'

/**
 * Phase 6 feature gate. Bridges below this version don't know about
 * `INSPECT_MANY` and would never respond, causing `selectMany` to
 * hang. Feature-gating instead of raising `REQUIRED_BRIDGE_VERSION`
 * keeps older bridges able to handshake — only multi-select calls
 * fail loudly.
 */
const REQUIRED_BRIDGE_VERSION_MULTI_SELECT = '2026-05-13a-multi-select'

/** Hard timeout on a `INSPECT_MANY` round-trip. Prevents the promise
 * from hanging forever if the bridge silently drops the message. */
const INSPECT_MANY_TIMEOUT_MS = 10_000
// GET_STRUCTURE is sent right after the handshake to populate the Layers
// panel. On a browser refresh it races the iframe's own reload, so a dropped
// STRUCTURE_CAPTURED reply must not hang the promise forever — otherwise the
// panel stays stuck on "Loading layers…". Bounded like every sibling request.
const GET_STRUCTURE_TIMEOUT_MS = 10_000
const BRIDGE_READY_TIMEOUT_MS = 5_000
// A single rendered-value read is a cheap DOM lookup; keep the wait short so
// the verifier's poll loop stays responsive.
const READ_RENDERED_VALUE_TIMEOUT_MS = 1_500
// Bridge version that first implements the READ_RENDERED_VALUE query. Older
// bridges silently drop it; without gating, every verification read would time
// out and convert to a false L2 failure on an otherwise-successful edit.
const REQUIRED_BRIDGE_VERSION_READ_RENDERED_VALUE = '2026-05-30a-verify'
// Measurements are a handful of synchronous DOM reads; same short ceiling.
const READ_MEASUREMENTS_TIMEOUT_MS = 1_500
// Bridge version that first implements READ_MEASUREMENTS (Tier-2 verification
// P2). Older bridges drop it; gating prevents a false skip→timeout.
const REQUIRED_BRIDGE_VERSION_READ_MEASUREMENTS = '2026-06-08e-measurements'
const DOM_EDIT_MODE_TIMEOUT_MS = 5_000
// Style-cascade verification: a cascade walk touches every accessible
// stylesheet, so give it more headroom than the single-DOM-read queries above.
const GET_STYLE_PROVENANCE_TIMEOUT_MS = 5_000
// Bridge version that first implements GET_STYLE_PROVENANCE. Older bridges
// silently drop it; gating prevents a false "nobody owns this property"
// verification failure on a successful edit.
const REQUIRED_BRIDGE_VERSION_STYLE_PROVENANCE = '2026-06-08a-style-provenance'

type SelectionListener = (selection: Selection | null) => void
type TreeUpdateListener = () => void
type MutationCapturedListener = (mutation: Mutation) => void
type MutationAwaitingListener = (pending: PendingMutation) => void
type ResolutionFailedListener = (
  failure: { id: string; reason: string; selector: string },
) => void
type OverrideRevertedListener = (event: {
  id: string
  kind: string
  selector: string
  reason: string
}) => void
type OverrideUnverifiedListener = (event: {
  id: string
  kind: string
  selector: string
}) => void
type OverridePreviewFailedListener = (failure: OverridePreviewFailure) => void

interface PendingRequest {
  resolve: (data: InspectionData | null) => void
  reject: (reason: unknown) => void
}

interface PendingStructureRequest {
  resolve: (roots: OutlineNode[]) => void
  reject: (reason: unknown) => void
}

interface PendingManyRequest {
  resolve: (data: InspectionData[]) => void
  reject: (reason: unknown) => void
}

interface BridgeEnvelope {
  source?: string
  type?: string
  payload?: unknown
  requestId?: string
}

export class BridgeFrameworkAdapter implements FrameworkAdapter {
  /**
   * The declared framework, satisfying the `FrameworkAdapter` interface.
   * Informational only — this adapter's behavior is framework-neutral
   * (runtime detection happens in the bridge; edits route by file extension
   * server-side), and nothing currently branches on it. Defaults to `'vue3'`
   * so existing call sites are unchanged; pass `'react'` when the shell knows
   * it's a React substrate.
   */
  readonly framework: FrameworkId

  constructor(framework: FrameworkId = 'vue3') {
    this.framework = framework
  }

  private currentTarget: AdapterTarget | null = null
  private currentSelection: Selection | null = null

  private boundMessageListener: ((event: MessageEvent) => void) | null = null
  private requestCounter = 0
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly pendingStructureRequests = new Map<string, PendingStructureRequest>()
  private readonly pendingManyRequests = new Map<string, PendingManyRequest>()
  private readonly pendingValueRequests = new Map<
    string,
    { resolve: (value: string | null) => void; reject: (err: Error) => void }
  >()
  private readonly pendingMeasurementRequests = new Map<
    string,
    { resolve: (m: Measurements | null) => void; reject: (err: Error) => void }
  >()
  private readonly pendingProvenanceRequests = new Map<
    string,
    {
      resolve: (origins: Record<string, StyleOrigin>) => void
      reject: (err: Error) => void
    }
  >()
  private bridgeReadyPromise: Promise<void> | null = null
  private bridgeReadyResolve: (() => void) | null = null
  private bridgeReadyReject: ((reason: unknown) => void) | null = null
  private bridgeReadyTimeout: ReturnType<typeof setTimeout> | null = null

  private readonly selectionListeners = new Set<SelectionListener>()
  private readonly treeUpdateListeners = new Set<TreeUpdateListener>()

  // Desired inspector/editor-active state, owned by the shell via
  // setActive(). Persisted across iframe reloads so init() re-applies the
  // CURRENT mode instead of force-activating. Without this, every full-
  // document navigation re-fires the iframe `load` → runHandshake →
  // init(), which used to unconditionally send the activation triple —
  // flipping the inspector (and its hover/selection box) back ON even
  // while the user is in Navigate mode. Defaults to false to match the
  // shell's default `iframeMode === 'navigate'`.
  private desiredActive = false

  // DOM-edit mode state. Adapter is a thin proxy — it does NOT cache
  // emitted mutations. The shell accumulates the MutationLog by
  // subscribing to onMutationCaptured. This keeps the log alive across
  // adapter dispose+reinit (e.g., HMR or iframe navigation) without an
  // adapter-side snapshot/restore dance.
  private domEditModeActive = false
  private domEditExitPending: {
    resolve: () => void
    timeout: ReturnType<typeof setTimeout>
  } | null = null
  private lastBridgeVersion: string | null = null
  private readonly mutationCapturedListeners = new Set<MutationCapturedListener>()
  private readonly dragMoveListeners = new Set<(move: DragMoveRequest) => void>()
  private readonly insertAtPointListeners = new Set<(req: InsertAtPointRequest) => void>()
  private readonly resizeListeners = new Set<(req: ResizeRequest) => void>()
  private readonly mutationAwaitingListeners = new Set<MutationAwaitingListener>()
  private readonly resolutionFailedListeners = new Set<ResolutionFailedListener>()
  private readonly overrideRevertedListeners = new Set<OverrideRevertedListener>()
  private readonly overrideUnverifiedListeners = new Set<OverrideUnverifiedListener>()
  private readonly overridePreviewFailedListeners =
    new Set<OverridePreviewFailedListener>()

  async init(target: AdapterTarget): Promise<void> {
    // Re-init across iframe reloads: when the iframe does a full document
    // reload (router navigation that hits a fresh document, RELOAD_PROTOTYPE
    // dispatch, or any other page load), the bridge IIFE re-runs in a clean
    // state. Editor needs to re-send the activation set (ACTIVATE_INSPECTOR
    // + ENTER_EDITOR_MODE + ACTIVATE_TABLE_EDGE_MENU) so the new bridge instance
    // knows we're driving. init() is idempotent against the same iframe and
    // tears down before re-initing against a different iframe.
    if (this.currentTarget && this.currentTarget.iframe !== target.iframe) {
      await this.dispose()
    }
    if (!this.currentTarget) {
      this.currentTarget = target
      this.boundMessageListener = (event: MessageEvent) => this.handleMessage(event)
      window.addEventListener('message', this.boundMessageListener)
    } else {
      // Same iframe; update origin in case it changed across navigations.
      this.currentTarget = target
    }

    // Abort any in-flight handshake from a previous init() so its awaiter
    // returns instead of hanging when this fresh init supersedes it.
    if (this.bridgeReadyReject) {
      this.bridgeReadyReject(new Error('BridgeFrameworkAdapter: handshake superseded by fresh init()'))
    }
    this.clearBridgeReadyTimers()
    this.bridgeReadyPromise = null

    await this.waitForBridgeReady()
    // Re-apply the CURRENT desired mode rather than unconditionally
    // activating. On iframe reloads (full-document navigation re-fires
    // `load` → runHandshake → init), force-activation leaked the
    // hover/selection box into Navigate mode. Persisting desiredActive
    // keeps the box scoped to Select mode across reloads.
    this.applyActiveState()
  }

  /** Push the messages matching `desiredActive`. The adapter is the single
   *  shell-side Select-mode signal: ENTER/EXIT_EDITOR_MODE, the inspector,
   *  AND the table-edge band all move together, so no overlay can be left on
   *  while the user is navigating. Select mode is the only state in which the
   *  bridge draws any of these overlays.
   *  (The table-edge menu hook only listens for the context-menu event now;
   *  it no longer drives activation.)
   *
   *  **No `ENABLE_HOVER_EVENTS`.** The bridge is still fully capable of the
   *  `HOVER_TARGET_CHANGED` stream — a future hover-driven feature
   *  (breadcrumb-on-hover, sibling preview) re-enables it with this one line —
   *  but nothing consumes it today: there is no switch case for the message,
   *  and its converter had no callers. Enabling it cost a `generateSelector` +
   *  component-tree walk + postMessage on every animation frame the cursor
   *  moved, for a message that fell through to `default:`. The bridge's own
   *  hover OVERLAY is independent of this toggle (see
   *  `InspectorOverlayManager.handleMouseMove`), so the designer still sees
   *  what's under the cursor.
   *
   *  `DISABLE_HOVER_EVENTS` stays in the teardown path below: it costs one
   *  message and it settles a bridge that some other shell (or an older build)
   *  left streaming. */
  private applyActiveState(): void {
    if (!this.currentTarget) return
    if (this.desiredActive) {
      this.send({ type: 'ACTIVATE_INSPECTOR' })
      this.send({ type: 'ENTER_EDITOR_MODE' })
      this.send({ type: 'ACTIVATE_TABLE_EDGE_MENU' })
    } else {
      this.send({ type: 'DISABLE_HOVER_EVENTS' })
      this.send({ type: 'EXIT_EDITOR_MODE' })
      this.send({ type: 'DEACTIVATE_INSPECTOR' })
      this.send({ type: 'DEACTIVATE_TABLE_EDGE_MENU' })
    }
  }

  async setActive(active: boolean): Promise<void> {
    // Remember the mode even when no target is attached yet, so the next
    // init() (post-handshake) applies it.
    this.desiredActive = active
    this.applyActiveState()
  }

  async dispose(): Promise<void> {
    if (!this.currentTarget) return
    try {
      this.send({ type: 'DISABLE_HOVER_EVENTS' })
      this.send({ type: 'EXIT_EDITOR_MODE' })
      this.send({ type: 'DEACTIVATE_INSPECTOR' })
      this.send({ type: 'DEACTIVATE_TABLE_EDGE_MENU' })
    } catch {
      // iframe may already be torn down; ignore.
    }
    if (this.boundMessageListener) {
      window.removeEventListener('message', this.boundMessageListener)
      this.boundMessageListener = null
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    this.pendingRequests.clear()
    for (const pending of this.pendingStructureRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    for (const pending of this.pendingManyRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    for (const pending of this.pendingValueRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    for (const pending of this.pendingMeasurementRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    for (const pending of this.pendingProvenanceRequests.values()) {
      pending.reject(new Error('BridgeFrameworkAdapter disposed'))
    }
    this.pendingProvenanceRequests.clear()
    this.pendingMeasurementRequests.clear()
    this.pendingValueRequests.clear()
    this.pendingManyRequests.clear()
    this.pendingStructureRequests.clear()
    // If a handshake was in flight when dispose ran, reject its promise so
    // the awaiter (the original init() call) returns instead of dangling
    // forever. Without this, rapid mount/unmount cycles leak pending
    // promises plus their .then callbacks.
    if (this.bridgeReadyReject) {
      this.bridgeReadyReject(new Error('BridgeFrameworkAdapter disposed before handshake completed'))
    }
    this.clearBridgeReadyTimers()
    this.bridgeReadyPromise = null
    this.currentTarget = null
    this.currentSelection = null
    this.selectionListeners.clear()
    this.treeUpdateListeners.clear()
    // DOM-edit-mode teardown. Listeners are cleared so a fresh init
    // starts with no leftover subscribers. The shell-owned MutationLog
    // is unaffected — it lives outside the adapter precisely so it can
    // survive adapter dispose+reinit (HMR, iframe navigation).
    this.domEditModeActive = false
    if (this.domEditExitPending) {
      clearTimeout(this.domEditExitPending.timeout)
      // Resolve, not reject — caller treats dispose during exit as exit-ok.
      this.domEditExitPending.resolve()
      this.domEditExitPending = null
    }
    this.lastBridgeVersion = null
    this.mutationCapturedListeners.clear()
    this.dragMoveListeners.clear()
    this.insertAtPointListeners.clear()
    this.resizeListeners.clear()
    this.mutationAwaitingListeners.clear()
    this.resolutionFailedListeners.clear()
    this.overrideRevertedListeners.clear()
    this.overrideUnverifiedListeners.clear()
    this.overridePreviewFailedListeners.clear()
  }

  async selectBySelector(selector: string): Promise<Selection | null> {
    const data = await this.request({
      type: 'INSPECT_SELECTOR',
      payload: { selector },
    })
    return this.applySelectionFromInspection(data)
  }

  async selectMany(selectors: readonly string[]): Promise<Selection[]> {
    if (!this.currentTarget) {
      throw new Error('BridgeFrameworkAdapter.selectMany: adapter not initialized')
    }
    if (selectors.length === 0) return []
    // Feature-gate: older bridges (pre-multi-select) won't respond to
    // INSPECT_MANY. Without this check, the promise would hang for
    // the duration of the timeout. Throw eagerly so callers get a
    // clear "bridge too old" diagnostic.
    if (
      this.lastBridgeVersion &&
      this.compareVersions(
        this.lastBridgeVersion,
        REQUIRED_BRIDGE_VERSION_MULTI_SELECT,
      ) < 0
    ) {
      throw new Error(
        `BridgeFrameworkAdapter.selectMany: bridge version ${this.lastBridgeVersion} does not support multi-select (need ${REQUIRED_BRIDGE_VERSION_MULTI_SELECT}+)`,
      )
    }
    const requestId = `many-${++this.requestCounter}`
    const promise = new Promise<InspectionData[]>((resolve, reject) => {
      // Bounded wait. Bridge that handshakes the right version but
      // somehow drops INSPECT_MANY (network glitch, message-channel
      // backpressure) won't leave us hanging forever.
      const timer = setTimeout(() => {
        if (this.pendingManyRequests.delete(requestId)) {
          reject(
            new Error(
              `BridgeFrameworkAdapter.selectMany: timed out after ${INSPECT_MANY_TIMEOUT_MS}ms`,
            ),
          )
        }
      }, INSPECT_MANY_TIMEOUT_MS)
      this.pendingManyRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer)
          resolve(data)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
    this.send({
      type: 'INSPECT_MANY',
      payload: { selectors: [...selectors] },
      requestId,
    } as ShellToBridgeMessage)
    const items = await promise
    const selections = items.map((d) => inspectionDataToSelection(d))
    // Pin the FIRST resolved selection as the primary so the existing
    // inspector path stays coherent. The shell mirrors the full list
    // into `editorSelectionMany`. On an empty result, we
    // INTENTIONALLY clear the primary too — "no resolved selectors"
    // is meaningfully different from "previous selection still
    // applies".
    this.currentSelection = selections[0] ?? null
    this.notifySelectionListeners()
    return selections
  }

  async selectParent(): Promise<Selection | null> {
    const current = this.currentSelection
    if (!current) return null
    const data = await this.request({
      type: 'INSPECT_PARENT',
      payload: { selector: current.selector },
    })
    return this.applySelectionFromInspection(data)
  }

  async getStructure(): Promise<OutlineNode[]> {
    if (!this.currentTarget) {
      throw new Error('BridgeFrameworkAdapter.getStructure: adapter not initialized')
    }
    const requestId = `struct-${++this.requestCounter}`
    const promise = new Promise<OutlineNode[]>((resolve, reject) => {
      // Bounded wait. A bridge that handshakes but drops STRUCTURE_CAPTURED
      // (iframe reload race on refresh, message-channel backpressure) must
      // reject rather than dangle — a hung promise leaves the Layers panel
      // stuck on "Loading layers…" with no recovery.
      const timer = setTimeout(() => {
        if (this.pendingStructureRequests.delete(requestId)) {
          reject(
            new Error(
              `BridgeFrameworkAdapter.getStructure: timed out after ${GET_STRUCTURE_TIMEOUT_MS}ms`,
            ),
          )
        }
      }, GET_STRUCTURE_TIMEOUT_MS)
      this.pendingStructureRequests.set(requestId, {
        resolve: (roots) => {
          clearTimeout(timer)
          resolve(roots)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
    this.send({ type: 'GET_STRUCTURE', requestId } as ShellToBridgeMessage)
    return promise
  }

  /**
   * Tier-2 edit verification: read the current rendered value at a selector
   * via the bridge `READ_RENDERED_VALUE` query. Bounded wait; resolves `null`
   * on no-match, timeout, or an uninitialized adapter (verification is
   * best-effort — a failed read must not throw into the edit flow).
   */
  /**
   * Whether the connected bridge implements `READ_RENDERED_VALUE`. Conservative
   * on an unknown version (returns false → verification skips) because a
   * best-effort verify must never produce a false failure. Callers should gate
   * on this before relying on a read; `readRenderedValue` also short-circuits.
   */
  supportsRenderedValueRead(): boolean {
    return (
      !!this.lastBridgeVersion &&
      this.compareVersions(
        this.lastBridgeVersion,
        REQUIRED_BRIDGE_VERSION_READ_RENDERED_VALUE,
      ) >= 0
    )
  }

  async readRenderedValue(
    selector: string,
    accessor: { kind: 'text' | 'attr' | 'style'; name?: string },
  ): Promise<string | null> {
    if (!this.currentTarget) return null
    // Old bridge that can't answer — return null fast instead of timing out.
    // (Verification callers gate on `supportsRenderedValueRead()` so this null
    // never reaches the comparator as a false failure.)
    if (!this.supportsRenderedValueRead()) return null
    const requestId = `val-${++this.requestCounter}`
    const promise = new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingValueRequests.delete(requestId)) {
          reject(
            new Error(
              `BridgeFrameworkAdapter.readRenderedValue: timed out after ${READ_RENDERED_VALUE_TIMEOUT_MS}ms`,
            ),
          )
        }
      }, READ_RENDERED_VALUE_TIMEOUT_MS)
      this.pendingValueRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
    this.send({
      type: 'READ_RENDERED_VALUE',
      payload: { selector, accessor },
      requestId,
    } as ShellToBridgeMessage)
    return promise.catch(() => null)
  }

  /**
   * Whether the connected bridge implements `READ_MEASUREMENTS` (Tier-2
   * verification P2). Conservative on an unknown version (false → the goal
   * verifier skips rather than false-fail), mirroring `supportsRenderedValueRead`.
   */
  supportsMeasurementsRead(): boolean {
    return (
      !!this.lastBridgeVersion &&
      this.compareVersions(
        this.lastBridgeVersion,
        REQUIRED_BRIDGE_VERSION_READ_MEASUREMENTS,
      ) >= 0
    )
  }

  /**
   * Tier-2 edit verification P2: read live geometry + a computed-style subset
   * at a selector via the bridge `READ_MEASUREMENTS` query. Bounded wait;
   * resolves `null` on no-match, timeout, an old bridge, or an uninitialized
   * adapter (verification is best-effort — a failed read must not throw).
   */
  async readMeasurements(selector: string): Promise<Measurements | null> {
    if (!this.currentTarget) return null
    if (!this.supportsMeasurementsRead()) return null
    const requestId = `meas-${++this.requestCounter}`
    const promise = new Promise<Measurements | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingMeasurementRequests.delete(requestId)) {
          reject(
            new Error(
              `BridgeFrameworkAdapter.readMeasurements: timed out after ${READ_MEASUREMENTS_TIMEOUT_MS}ms`,
            ),
          )
        }
      }, READ_MEASUREMENTS_TIMEOUT_MS)
      this.pendingMeasurementRequests.set(requestId, {
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
    this.send({
      type: 'READ_MEASUREMENTS',
      payload: { selector },
      requestId,
    } as ShellToBridgeMessage)
    return promise.catch(() => null)
  }

  /**
   * Whether the connected bridge implements `GET_STYLE_PROVENANCE`. Conservative
   * on an unknown version (returns false) because a best-effort verify must
   * never produce a false failure. Callers should gate on this before relying
   * on a read; `getStyleProvenance` also short-circuits.
   */
  supportsStyleProvenance(): boolean {
    return (
      !!this.lastBridgeVersion &&
      this.compareVersions(
        this.lastBridgeVersion,
        REQUIRED_BRIDGE_VERSION_STYLE_PROVENANCE,
      ) >= 0
    )
  }

  /**
   * Style-cascade verification: resolve which CSS rule owns each of
   * `properties` on the element at `selector` via the bridge's cascade walk.
   *
   * Bounded wait. NEVER throws (verification is best-effort and must not break
   * the edit flow), but it does distinguish two outcomes the caller must not
   * conflate (final-review I3):
   *  - `{}` (or a partial map) — the read SUCCEEDED; the bridge simply had no
   *    origin for those properties (e.g. the selector matched nothing).
   *  - `null` — the read FAILED and we know nothing: timeout, disposal, an old
   *    bridge, or no attached target.
   *
   * `verifyCascade` maps `null` to `skipped`, never to a failure — a verdict we
   * cannot substantiate must not be reported as "the edit didn't take effect".
   *
   * What `null` is NOT (residual-review R2): a class edit invalidating its own
   * selector. The bridge builds class-based selectors (`selector-engine.ts`), so
   * `div.bg-white` stops matching the moment the user swaps the background — but
   * the bridge answers that gracefully with an EMPTY MAP, not a failure, so it
   * arrives here as `{}`. `verifyCascade` handles that case separately: on a
   * successful-but-empty read it probes `READ_RENDERED_VALUE` once, and reports
   * `skipped` only when the selector matches no element at all. `null` therefore
   * covers only the genuine read failures listed above.
   */
  async getStyleProvenance(
    selector: string,
    properties: readonly string[],
  ): Promise<Record<string, StyleOrigin> | null> {
    // No attached iframe — there is nothing to read, and no answer to give.
    if (!this.currentTarget) return null
    // Nothing was asked; an empty answer is complete, not a failure.
    if (!properties.length) return {}
    // Old bridge that can't answer — report a failed read fast instead of
    // timing out. Verification callers also gate on `supportsStyleProvenance()`,
    // so this normally isn't even reached.
    if (!this.supportsStyleProvenance()) return null
    const requestId = `prov-${++this.requestCounter}`
    const promise = new Promise<Record<string, StyleOrigin>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingProvenanceRequests.delete(requestId)) {
          reject(
            new Error(
              `BridgeFrameworkAdapter.getStyleProvenance: timed out after ${GET_STYLE_PROVENANCE_TIMEOUT_MS}ms`,
            ),
          )
        }
      }, GET_STYLE_PROVENANCE_TIMEOUT_MS)
      this.pendingProvenanceRequests.set(requestId, {
        resolve: (origins) => {
          clearTimeout(timer)
          resolve(origins)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
    this.send({
      type: 'GET_STYLE_PROVENANCE',
      payload: { selector, properties: [...properties] },
      requestId,
    } as ShellToBridgeMessage)
    // Keep the "never throw at the caller" ergonomics; signal failure as null.
    return promise.catch(() => null)
  }

  async clearSelection(): Promise<void> {
    // Tell the bridge to drop its own selectedElement reference too —
    // otherwise the next click on the same element takes the bridge's
    // toggle-deselect branch and emits ELEMENT_DESELECTED instead of a
    // fresh ELEMENT_INSPECTED, making re-selection feel broken.
    this.send({ type: 'CLEAR_SELECTION' })
    this.currentSelection = null
    this.notifySelectionListeners()
  }

  previewHighlight(selector: string | null): void {
    this.send({ type: 'PREVIEW_HIGHLIGHT', payload: { selector } })
  }

  async applyEdit(edit: StructuralEdit, opts?: ApplyEditOpts): Promise<EditResult> {
    const built = buildEditRequest(edit, opts)
    if (!built.ok) return built.result
    const requestBody = built.requestBody

    // For llm-patch with progress callbacks set, request SSE so the
    // route streams token deltas as they arrive. Other edit kinds (and
    // llm-patch without callbacks) get the legacy JSON response.
    //
    // In `'chat'` fallback mode there is no in-request LLM call to
    // stream — the server stops at the deterministic boundary and returns
    // `needsChat` as plain JSON — so never request SSE. This keeps both
    // routes on the non-streaming path, where the escalate short-circuit
    // lives.
    const wantStream =
      edit.kind === 'llm-patch' &&
      edit.llmFallback === 'patch' &&
      (opts?.onLLMStreamStart !== undefined || opts?.onLLMStreamDelta !== undefined)
    let response: Response
    try {
      response = await editorFetch('/api/editor/edit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(wantStream ? { Accept: 'text/event-stream, application/json' } : {}),
        },
        body: JSON.stringify(requestBody),
      })
    } catch (err) {
      return { kind: 'failed', reason: `edit service unreachable: ${(err as Error).message}` }
    }

    const isSSEResponse =
      wantStream &&
      response.headers.get('content-type')?.includes('text/event-stream') === true
    if (isSSEResponse && response.body) {
      return consumeSSEEditResponse(response, edit, opts!)
    }

    if (!response.ok) {
      let reason = `edit service responded ${response.status}`
      let conflicts:
        | ReadonlyArray<{ file: string; expected: string; actual: string }>
        | undefined
      let needsChat = false
      try {
        const body = (await response.json()) as {
          reason?: string
          needsChat?: boolean
          conflicts?: ReadonlyArray<{
            file: string
            expected: string
            actual: string
          }>
        }
        if (body?.reason) reason = body.reason
        if (Array.isArray(body?.conflicts)) conflicts = body.conflicts
        if (body?.needsChat === true) needsChat = true
      } catch {
        // body wasn't JSON; keep the status-based reason.
      }
      // `'chat'` fallback mode: the server stopped at the deterministic
      // boundary and wants the edit handed to the chat agent. Surface it
      // as a distinct failure flag so the caller escalates instead of
      // showing a save error.
      if (needsChat) return { kind: 'failed', reason, needsChat: true }
      return conflicts
        ? { kind: 'failed', reason, conflicts }
        : { kind: 'failed', reason }
    }

    // No RELOAD_PROTOTYPE dispatch on the happy path: in dev Vite's HMR
    // hot-swaps the changed module within ~50-100ms, and in production the
    // V1.4 GitHub-PR pipeline triggers a fresh deploy that the next iframe
    // navigation picks up via its `?v=${deploymentId}` cache-buster. Forcing
    // a reload here was tearing down the inspector's local PropControl state
    // (every input's `useState` re-initializes from the manifest default,
    // not the live instance value), causing the inspector to drift away
    // from the iframe after each edit. Editor keeps RELOAD_PROTOTYPE as
    // an explicit message in the protocol for cases that genuinely need a
    // forced reload; the auto-dispatch on edit success was doing more harm
    // than good.
    let newHashes: Readonly<Record<string, string>> | undefined
    let llmTrace: SaveLLMTrace | undefined
    let fallbackUsed: 'source-aware-llm' | 'agent-mini-turn' | undefined
    let fallbackNotes: string | undefined
    // Every successful write now returns `newHashes` (the deterministic
    // single-edit lane included, since the buffered-edit rebase work), so
    // the body is parsed for EVERY kind — dropping hashes for e.g.
    // scoped-css-override left the client registry stale and made a later
    // save conflict with our own write (codex follow-up round-2).
    // llm-patch additionally carries llmTrace; prop carries
    // fallbackUsed/notes from the mini-turn lane. Reading the extras
    // unconditionally is harmless — absent fields stay undefined.
    // (No `autoCommit.sha` read here: branch mode's CLI edit handler always
    // returns the no-op `{ ok: true, empty: true }` autoCommit shape — it has
    // no `sha` field — so a guard on `typeof body.autoCommit.sha === 'string'`
    // could never be true. Removed 2026-08-08 audit; `EditResult.commitSha`
    // stays optional and simply goes unset by this adapter.)
    try {
      const body = (await response.json()) as {
        newHashes?: Record<string, string>
        llmTrace?: SaveLLMTrace
        fallbackUsed?: 'source-aware-llm' | 'agent-mini-turn'
        notes?: string
      }
      if (body?.newHashes && typeof body.newHashes === 'object') {
        newHashes = body.newHashes
      }
      if (body?.llmTrace && typeof body.llmTrace === 'object') {
        llmTrace = body.llmTrace
      }
      if (body?.fallbackUsed === 'source-aware-llm' || body?.fallbackUsed === 'agent-mini-turn') {
        fallbackUsed = body.fallbackUsed
      }
      if (typeof body?.notes === 'string') {
        fallbackNotes = body.notes
      }
    } catch {
      // body wasn't JSON; ignore. Hash-guard degrades gracefully —
      // next save just won't carry a baseHashes entry for this file.
    }
    return {
      kind: 'applied',
      appliedEditId: edit.id,
      affectedTargetIds: [edit.target.targetId],
      ...(newHashes ? { newHashes } : {}),
      ...(llmTrace ? { llmTrace } : {}),
      ...(fallbackUsed ? { fallbackUsed } : {}),
      ...(fallbackNotes ? { notes: fallbackNotes } : {}),
    }
  }

  // ---------- DOM-edit mode ----------
  //
  // `enterDomEditMode` (the entry point) had zero production callers and
  // was removed in share-readiness Phase 3 Batch A. `exitDomEditMode`
  // stays — it's still called defensively from adapter teardown
  // (useEditorEditing.ts) — but with `domEditModeActive` now never
  // flipped true by anything, it's a permanent no-op until a future
  // caller re-enters DOM-edit mode some other way.

  async exitDomEditMode(): Promise<void> {
    if (!this.domEditModeActive) return
    if (!this.currentTarget) {
      // Adapter teardown raced with exit — just clear local state.
      this.domEditModeActive = false
      return
    }
    this.domEditModeActive = false
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.domEditExitPending) {
          this.domEditExitPending = null
          // Resolve even on timeout — the bridge may already be torn down
          // from an iframe nav. Local state is cleared either way.
          resolve()
        }
      }, DOM_EDIT_MODE_TIMEOUT_MS)
      this.domEditExitPending = { resolve, timeout }
      this.send({ type: 'EXIT_DOM_EDIT_MODE' } as ShellToBridgeMessage)
    })
  }

  /**
   * Apply a prop override in the live iframe so the buffered edit is
   * visible before save. Fire-and-forget with respect to the CALLER — the
   * shell already shows the pending edit in its UI — but the bridge response
   * (`PROP_OVERRIDE_RESULT`) is not discarded: a failure reaches
   * {@link onOverridePreviewFailed}. If the bridge can't find the Vue instance
   * for the selector the override no-ops, and the user is told the preview is
   * missing rather than left staring at a control that did nothing; the
   * buffered edit still dispatches on save either way.
   *
   * `overrideId` (WS3, optional): pass the id the caller will later hand
   * to {@link resolveOverride} (typically the buffered PropEdit's own
   * id) so the bridge registers this preview in its override store —
   * re-asserting it against unrelated re-renders and reverting it on a
   * `'failed'` resolution. Omitted ⇒ today's untracked fire-and-forget
   * preview.
   */
  applyPropOverride(
    selector: string,
    propName: string,
    value: unknown,
    overrideId?: string,
  ): void {
    if (!this.currentTarget) return
    this.send({
      type: 'APPLY_PROP_OVERRIDE',
      payload: {
        selector,
        propName,
        value,
        ...(overrideId !== undefined ? { overrideId } : {}),
      },
    } as ShellToBridgeMessage)
  }

  /**
   * WS3 closed-loop transactions. See {@link FrameworkAdapter.resolveOverride}.
   */
  resolveOverride(
    id: string,
    outcome: 'confirmed' | 'failed' | 'ineffective',
    reason?: string,
  ): void {
    if (!this.currentTarget) return
    this.send({
      type: 'RESOLVE_OVERRIDE',
      payload: { id, outcome, ...(reason !== undefined ? { reason } : {}) },
    } as ShellToBridgeMessage)
  }

  /**
   * Restore all original prop values in the iframe. Sent on Discard so
   * the iframe returns to its pre-buffer state.
   */
  clearPropOverrides(): void {
    if (!this.currentTarget) return
    this.send({ type: 'CLEAR_PROP_OVERRIDES' } as ShellToBridgeMessage)
  }

  /**
   * Live-preview a fallthrough attribute edit (placeholder, data-testid,
   * required, ...). Distinct from `applyPropOverride` because Vue's
   * `instance.attrs` is computed and not directly mutable — the bridge
   * walks the rendered subtree and stamps the DOM attribute on every
   * descendant that has it.
   */
  applyAttrOverride(
    selector: string,
    attrName: string,
    value: unknown,
    overrideId?: string,
  ): void {
    if (!this.currentTarget) return
    this.send({
      type: 'APPLY_ATTR_OVERRIDE',
      payload: {
        selector,
        attrName,
        value,
        // WS3: registers the preview with the bridge OverrideStore so a
        // failed save reverts it — same loop as applyPropOverride.
        ...(overrideId !== undefined ? { overrideId } : {}),
      },
    } as ShellToBridgeMessage)
  }

  /**
   * Restore all original attribute values. Sent on Discard alongside
   * `clearPropOverrides`.
   */
  clearAttrOverrides(): void {
    if (!this.currentTarget) return
    this.send({ type: 'CLEAR_ATTR_OVERRIDES' } as ShellToBridgeMessage)
  }

  /**
   * Restore all original className + inline style values stashed by the
   * bridge's class-override live preview (the !important specificity
   * boost behind SET_ELEMENT_CLASSES). Sent on Discard so the iframe
   * returns to its pre-edit visual state without a full reload.
   */
  clearClassOverrides(): void {
    if (!this.currentTarget) return
    this.send({ type: 'CLEAR_CLASS_OVERRIDES' } as ShellToBridgeMessage)
  }

  /**
   * Right-rail inspector "Text" input dispatches here. The bridge
   * mutates the element's textContent; DOM-edit mode's MutationObserver
   * captures the change and emits a Mutation that flows into the
   * existing Save pipeline. No new save path needed.
   *
   * `textNodeIndex` (optional): targets a specific text-node child
   * instead of replacing the whole element's textContent. Used when
   * the editable text is a sibling of element children (slot text
   * alongside an icon/tooltip in components like KLabel). Without it,
   * the bridge would nuke the sibling element.
   */
  setElementText(selector: string, value: string, textNodeIndex?: number): void {
    if (!this.currentTarget) return
    this.send({
      type: 'SET_ELEMENT_TEXT',
      payload: { selector, value, textNodeIndex },
    } as ShellToBridgeMessage)
  }

  /**
   * Right-rail inspector class-list input dispatches here. Same model
   * as `setElementText` but for the className token list. The optional
   * `declarations` map carries shell-resolved CSS for the new classes
   * so the bridge can apply them as inline `!important` overrides for
   * live preview without relying on the substrate having Tailwind (or
   * any framework that would supply the matching CSS rules).
   */
  setElementClasses(
    selector: string,
    classes: string[],
    declarations?: Record<string, string>,
  ): void {
    if (!this.currentTarget) return
    this.send({
      type: 'SET_ELEMENT_CLASSES',
      payload: { selector, classes, declarations },
    } as ShellToBridgeMessage)
  }

  onMutationCaptured(listener: MutationCapturedListener): AdapterSubscription {
    this.mutationCapturedListeners.add(listener)
    return () => {
      this.mutationCapturedListeners.delete(listener)
    }
  }

  onDragMoveCommitted(
    listener: (move: DragMoveRequest) => void,
  ): AdapterSubscription {
    this.dragMoveListeners.add(listener)
    return () => {
      this.dragMoveListeners.delete(listener)
    }
  }

  enterInsertPlacement(label: string): void {
    if (!this.currentTarget) return
    this.send({
      type: "ENTER_INSERT_PLACEMENT",
      payload: { label },
    } as ShellToBridgeMessage)
  }

  exitInsertPlacement(): void {
    if (!this.currentTarget) return
    this.send({ type: "EXIT_INSERT_PLACEMENT" } as ShellToBridgeMessage)
  }

  onInsertAtPoint(
    listener: (req: InsertAtPointRequest) => void,
  ): AdapterSubscription {
    this.insertAtPointListeners.add(listener)
    return () => {
      this.insertAtPointListeners.delete(listener)
    }
  }

  onResizeCommitted(
    listener: (req: ResizeRequest) => void,
  ): AdapterSubscription {
    this.resizeListeners.add(listener)
    return () => {
      this.resizeListeners.delete(listener)
    }
  }

  onMutationAwaitingDisambiguation(
    listener: MutationAwaitingListener,
  ): AdapterSubscription {
    this.mutationAwaitingListeners.add(listener)
    return () => {
      this.mutationAwaitingListeners.delete(listener)
    }
  }

  resolveMutationDisambiguation(
    pendingId: string,
    choice: DisambiguationChoice | 'cancel',
  ): void {
    if (!this.currentTarget) {
      throw new Error(
        'BridgeFrameworkAdapter.resolveMutationDisambiguation: adapter not initialized',
      )
    }
    this.send({
      type: 'RESOLVE_MUTATION_DISAMBIGUATION',
      payload: { pendingId, choice },
    } as ShellToBridgeMessage)
  }

  onResolutionFailed(listener: ResolutionFailedListener): AdapterSubscription {
    this.resolutionFailedListeners.add(listener)
    return () => {
      this.resolutionFailedListeners.delete(listener)
    }
  }

  onOverrideReverted(listener: OverrideRevertedListener): AdapterSubscription {
    this.overrideRevertedListeners.add(listener)
    return () => {
      this.overrideRevertedListeners.delete(listener)
    }
  }

  onOverridePreviewFailed(
    listener: OverridePreviewFailedListener,
  ): AdapterSubscription {
    this.overridePreviewFailedListeners.add(listener)
    return () => {
      this.overridePreviewFailedListeners.delete(listener)
    }
  }

  onOverrideUnverified(listener: OverrideUnverifiedListener): AdapterSubscription {
    this.overrideUnverifiedListeners.add(listener)
    return () => {
      this.overrideUnverifiedListeners.delete(listener)
    }
  }

  // ---------- Subscriptions ----------

  onSelectionChange(listener: SelectionListener): AdapterSubscription {
    this.selectionListeners.add(listener)
    return () => {
      this.selectionListeners.delete(listener)
    }
  }

  onTreeUpdate(listener: TreeUpdateListener): AdapterSubscription {
    this.treeUpdateListeners.add(listener)
    return () => {
      this.treeUpdateListeners.delete(listener)
    }
  }

  // ────────────────────────── postMessage plumbing ──────────────────────────

  private send(message: ShellToBridgeMessage): void {
    if (!this.currentTarget) return
    const targetWindow = this.currentTarget.iframe.contentWindow
    if (!targetWindow) return
    targetWindow.postMessage(message, this.targetOrigin())
  }

  /**
   * The `targetOrigin` for every post into the prototype frame (K12).
   *
   * `currentTarget.origin` is the prototype origin the shell resolved when it
   * attached (`useEditorEditing` derives it from `prototypeUrl`), so naming it
   * means a frame that has wandered off that origin stops receiving edit
   * traffic — selections, prop/attr overrides, captured source paths. A post
   * that lands nowhere is the correct failure mode there.
   *
   * `'*'` stays reachable, deliberately, for the case where the origin is
   * genuinely unnameable rather than merely unknown: a frame sandboxed without
   * `allow-same-origin` has an OPAQUE origin, which serializes to `"null"` and
   * matches no origin string at all, so pinning would silently mute the
   * channel. The caller signals that by passing `'*'` (or an empty string) as
   * the target origin.
   */
  private targetOrigin(): string {
    return this.currentTarget?.origin || '*'
  }

  private async request(
    message: { type: ShellToBridgeMessage['type']; payload?: unknown },
  ): Promise<InspectionData | null> {
    if (!this.currentTarget) {
      throw new Error('BridgeFrameworkAdapter.request: adapter not initialized')
    }
    const requestId = `req-${++this.requestCounter}`
    const promise = new Promise<InspectionData | null>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject })
    })
    this.send({ ...(message as ShellToBridgeMessage), requestId } as ShellToBridgeMessage)
    return promise
  }

  private waitForBridgeReady(): Promise<void> {
    if (this.bridgeReadyPromise) return this.bridgeReadyPromise
    this.bridgeReadyPromise = new Promise<void>((resolve, reject) => {
      this.bridgeReadyResolve = () => {
        this.clearBridgeReadyTimers()
        resolve()
      }
      this.bridgeReadyReject = (reason) => {
        this.clearBridgeReadyTimers()
        reject(reason)
      }
      // Send PING so the (potentially already-loaded) bridge re-emits
      // BRIDGE_READY now that our listener is attached. Without this,
      // React Strict Mode's double-invoke (mount → unmount → re-mount)
      // detaches+re-attaches the message listener around the moment the
      // bridge IIFE fires its native BRIDGE_READY on iframe load, and
      // the shell misses it. PING is a non-navigating echo — distinct
      // from the older NAVIGATE-kick approach that caused a reload loop
      // when the prototype's router redirected away from the src
      // pathname.
      this.send({ type: 'PING' })
      this.bridgeReadyTimeout = setTimeout(() => {
        if (this.bridgeReadyReject) {
          this.bridgeReadyReject(
            new Error(
              `BridgeFrameworkAdapter.init: timed out waiting for BRIDGE_READY (need ${REQUIRED_BRIDGE_VERSION}+)`,
            ),
          )
        }
      }, BRIDGE_READY_TIMEOUT_MS)
    })
    return this.bridgeReadyPromise
  }

  private clearBridgeReadyTimers(): void {
    if (this.bridgeReadyTimeout !== null) {
      clearTimeout(this.bridgeReadyTimeout)
      this.bridgeReadyTimeout = null
    }
    this.bridgeReadyResolve = null
    this.bridgeReadyReject = null
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.currentTarget) return
    if (event.source !== this.currentTarget.iframe.contentWindow) return
    const envelope = event.data as BridgeEnvelope | null
    if (!envelope || typeof envelope !== 'object') return
    if (envelope.source !== 'desde-bridge') return
    if (typeof envelope.type !== 'string') return

    const message = envelope as unknown as BridgeToShellMessage & {
      requestId?: string
    }

    switch (message.type) {
      case 'BRIDGE_READY':
        this.handleBridgeReady(message.payload?.version)
        break
      case 'ELEMENT_INSPECTED':
        if (message.requestId) {
          this.resolveRequest(message.requestId, message.payload)
        } else {
          this.applySelectionFromInspection(message.payload)
        }
        break
      case 'ELEMENTS_INSPECTED':
        // Phase 6 multi-select response. Always paired with an
        // INSPECT_MANY requestId — the bridge doesn't currently emit
        // ELEMENTS_INSPECTED unsolicited.
        if (message.requestId) {
          this.resolveManyRequest(message.requestId, message.payload ?? [])
        }
        break
      case 'ELEMENT_DESELECTED':
        this.currentSelection = null
        this.notifySelectionListeners()
        break
      case 'ELEMENT_INSPECTION_UNRESOLVED':
        if (message.requestId) {
          this.resolveRequest(message.requestId, null)
        }
        break
      case 'STRUCTURE_CAPTURED':
        if (message.requestId) {
          this.resolveStructureRequest(message.requestId, message.payload.roots)
        }
        break
      case 'RENDERED_VALUE_READ':
        if (message.requestId) {
          const pending = this.pendingValueRequests.get(message.requestId)
          if (pending) {
            this.pendingValueRequests.delete(message.requestId)
            pending.resolve(message.payload?.value ?? null)
          }
        }
        break
      case 'MEASUREMENTS_READ':
        if (message.requestId) {
          const pending = this.pendingMeasurementRequests.get(message.requestId)
          if (pending) {
            this.pendingMeasurementRequests.delete(message.requestId)
            pending.resolve(message.payload?.measurements ?? null)
          }
        }
        break
      case 'STYLE_PROVENANCE_RESULT':
        if (message.requestId) {
          const pending = this.pendingProvenanceRequests.get(message.requestId)
          // Not ours — `useIframeStyleProvenance` correlates its own ids off
          // the same message stream, so an unknown id is expected, not an
          // error.
          if (pending) {
            this.pendingProvenanceRequests.delete(message.requestId)
            pending.resolve(message.payload?.origins ?? {})
          }
        }
        break
      case 'ESCAPE_PRESSED':
        // Escape deselects completely (Mo's decision 2026-08-04). The bridge
        // clears its own selection and emits ELEMENT_DESELECTED (handled
        // above) — nothing selection-related to do here.
        //
        // The old comment here claimed the message was "kept for shell
        // consumers that close annotation popups on Escape". Audited
        // 2026-08-06: no such consumer exists (the shell's own popovers close
        // on their own keydown, inside the shell document). Kept anyway — an
        // explicit no-op case documents that the fall-through is intended,
        // which `default:` cannot, and the message is a one-per-keypress
        // event, not a stream.
        break
      case 'ROUTE_CHANGED':
      case 'DOM_MUTATED':
        this.notifyTreeUpdateListeners()
        break
      case 'DOM_EDIT_MODE_EXITED':
        this.handleDomEditModeExited()
        break
      case 'MUTATION_CAPTURED':
        this.handleMutationCaptured(message.payload)
        break
      case 'DRAG_MOVE_COMMITTED':
        for (const listener of this.dragMoveListeners) {
          try {
            listener(message.payload)
          } catch {
            // A listener throwing must not break the message pump.
          }
        }
        break
      case 'INSERT_AT_POINT':
        for (const listener of this.insertAtPointListeners) {
          try {
            listener(message.payload)
          } catch {
            // A listener throwing must not break the message pump.
          }
        }
        break
      case 'RESIZE_COMMITTED':
        for (const listener of this.resizeListeners) {
          try {
            listener(message.payload)
          } catch {
            // A listener throwing must not break the message pump.
          }
        }
        break
      case 'MUTATION_AWAITING_DISAMBIGUATION':
        this.handleMutationAwaiting(message.payload)
        break
      case 'MUTATION_RESOLUTION_FAILED':
        this.handleResolutionFailed(message.payload)
        break
      case 'PROP_OVERRIDE_RESULT':
        this.handleOverridePreviewResult('prop', {
          selector: message.payload.selector,
          name: message.payload.propName,
          ok: message.payload.ok,
          reason: message.payload.reason,
          cause: message.payload.kind,
        })
        break
      case 'ATTR_OVERRIDE_RESULT':
        this.handleOverridePreviewResult('attr', {
          selector: message.payload.selector,
          name: message.payload.attrName,
          ok: message.payload.ok,
          reason: message.payload.reason,
          cause: message.payload.kind,
        })
        break
      case 'OVERRIDE_REVERTED':
        this.handleOverrideReverted(message.payload)
        break
      case 'OVERRIDE_UNVERIFIED':
        this.handleOverrideUnverified(message.payload)
        break
      default:
        // Unhandled bridge message types are review-app concerns or future
        // editor extensions; silently pass through.
        break
    }
  }

  private handleDomEditModeExited(): void {
    const pending = this.domEditExitPending
    this.domEditExitPending = null
    if (pending) {
      clearTimeout(pending.timeout)
      pending.resolve()
    }
  }

  private handleMutationCaptured(payload: BridgeMutation): void {
    const mutation = bridgeMutationToCore(payload)
    for (const listener of this.mutationCapturedListeners) {
      try {
        listener(mutation)
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] mutation-captured listener threw:',
          err,
        )
      }
    }
  }

  private handleMutationAwaiting(payload: BridgePendingMutation): void {
    const pending: PendingMutation = {
      pendingId: payload.pendingId,
      draft: bridgeMutationDraftToCore(payload.draft),
      candidates: payload.candidates.map((c) => ({
        instancePath: c.instancePath,
        selector: c.selector,
        origin: c.origin,
      })),
    }
    for (const listener of this.mutationAwaitingListeners) {
      try {
        listener(pending)
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] mutation-awaiting listener threw:',
          err,
        )
      }
    }
  }

  private handleResolutionFailed(payload: {
    id: string
    reason: string
    selector: string
  }): void {
    for (const listener of this.resolutionFailedListeners) {
      try {
        listener({ id: payload.id, reason: payload.reason, selector: payload.selector })
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] resolution-failed listener threw:',
          err,
        )
      }
    }
  }

  /**
   * `PROP_OVERRIDE_RESULT` / `ATTR_OVERRIDE_RESULT` arrive for EVERY poke; only
   * the failures have a consumer, so a success stops here rather than waking
   * shell listeners on every keystroke of a slider drag. Both message shapes
   * fold into one `OverridePreviewFailure` — they differ only in whether the
   * targeted name arrives as `propName` or `attrName`, and the shell surfaces
   * them identically.
   *
   * The bridge's `kind` is relayed as `cause` — the adapter does NOT filter on
   * it. Dispatch stays "every failure reaches the listener"; deciding that a
   * capability gap isn't worth a toast is a presentation call, and it lives with
   * the presentation (`src/hooks/override-preview-notice.ts`) so a future
   * consumer — a substrate-capability badge, telemetry — still sees the event.
   */
  private handleOverridePreviewResult(
    kind: 'prop' | 'attr',
    result: {
      selector: string
      name: string
      ok: boolean
      reason?: string
      cause?: PreviewFailureKind
    },
  ): void {
    if (result.ok) return
    const failure: OverridePreviewFailure = {
      kind,
      selector: result.selector,
      name: result.name,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.cause !== undefined ? { cause: result.cause } : {}),
    }
    for (const listener of this.overridePreviewFailedListeners) {
      try {
        listener(failure)
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] override-preview-failed listener threw:',
          err,
        )
      }
    }
  }

  private handleOverrideReverted(payload: {
    id: string
    kind: string
    selector: string
    reason: string
  }): void {
    for (const listener of this.overrideRevertedListeners) {
      try {
        listener({
          id: payload.id,
          kind: payload.kind,
          selector: payload.selector,
          reason: payload.reason,
        })
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] override-reverted listener threw:',
          err,
        )
      }
    }
  }

  private handleOverrideUnverified(payload: {
    id: string
    kind: string
    selector: string
  }): void {
    for (const listener of this.overrideUnverifiedListeners) {
      try {
        listener({ id: payload.id, kind: payload.kind, selector: payload.selector })
      } catch (err) {
        console.warn(
          '[BridgeFrameworkAdapter] override-unverified listener threw:',
          err,
        )
      }
    }
  }

  private handleBridgeReady(version: string | undefined): void {
    if (version && this.compareVersions(version, REQUIRED_BRIDGE_VERSION) < 0) {
      if (this.bridgeReadyReject) {
        this.bridgeReadyReject(
          new Error(
            `BridgeFrameworkAdapter: bridge version ${version} is older than required ${REQUIRED_BRIDGE_VERSION}`,
          ),
        )
      }
      return
    }
    this.lastBridgeVersion = version ?? null
    if (this.bridgeReadyResolve) {
      this.bridgeReadyResolve()
    }
  }

  private resolveManyRequest(
    requestId: string,
    payload: InspectionData[],
  ): void {
    const pending = this.pendingManyRequests.get(requestId)
    if (!pending) return
    this.pendingManyRequests.delete(requestId)
    pending.resolve(payload)
  }

  private resolveRequest(requestId: string, payload: InspectionData | null): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return
    this.pendingRequests.delete(requestId)
    pending.resolve(payload)
  }

  private resolveStructureRequest(requestId: string, roots: OutlineNode[]): void {
    const pending = this.pendingStructureRequests.get(requestId)
    if (!pending) return
    this.pendingStructureRequests.delete(requestId)
    pending.resolve(roots)
  }

  private applySelectionFromInspection(
    data: InspectionData | null | undefined,
  ): Selection | null {
    if (!data) return null
    const selection = inspectionDataToSelection(data)
    this.currentSelection = selection
    this.notifySelectionListeners()
    return selection
  }

  private notifySelectionListeners(): void {
    for (const listener of this.selectionListeners) {
      listener(this.currentSelection)
    }
  }

  private notifyTreeUpdateListeners(): void {
    for (const listener of this.treeUpdateListeners) {
      listener()
    }
  }

  /** Compare YYYY-MM-DDx-style version strings lexicographically. Same prefix
   *  for the same date; the letter suffix orders intra-day bumps. */
  private compareVersions(a: string, b: string): number {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }
}


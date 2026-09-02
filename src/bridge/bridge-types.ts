/**
 * Desde Bridge — shared payload types
 *
 * Type-only module: the comment/note and flow payload shapes that several
 * bridge manager classes (and the postMessage handler) share. Extracted from
 * `comment-bridge.ts` so the manager classes can move into their own modules
 * and still name these types. esbuild erases type-only imports, so pulling
 * these out leaves the emitted bundle byte-identical.
 */
import type { OverrideKind, OverrideOutcome } from "./override-store"

/**
 * Lifecycle contract shared by the bridge's Select-mode overlays — the
 * mousemove-driven, shadow-DOM affordances that may only draw while the
 * user is in Select mode (the component inspector, the table-edge band).
 *
 * Both implementations stay separate (their hit-testing and protocols
 * differ), but the bridge drives them through one registry so a new
 * overlay can't silently skip mode-teardown or navigation-clear — the
 * two failure modes that previously let a highlight leak into Navigate
 * mode or linger frozen after a route change.
 */
export interface SelectModeOverlay {
  /** Attach listeners; begin drawing on hover. Idempotent. */
  activate(): void
  /** Detach listeners; clear any drawn overlay. Idempotent. */
  deactivate(): void
  /** Route changed: drop overlay tracked against the old document. */
  handleNavigation(): void
}

export interface CommentPosition {
  anchorSelector: string
  page: string
  tabPanelIds?: string[]
}

export interface CommentAuthor {
  displayName: string
  email: string
  photoURL: string
}

export interface Comment {
  id: string
  number: number
  position: CommentPosition
  body: string
  author: CommentAuthor
  createdAt: string
  resolved: boolean
  replies: { id: string; body: string; author: CommentAuthor; createdAt: string }[]
}

export interface BridgeNote {
  id: string
  number: number
  position: CommentPosition
  body: string
  author: CommentAuthor
  createdAt: string
  resolved: boolean
  minimized: boolean
  replies: { id: string; body: string; author: CommentAuthor; createdAt: string }[]
}

export interface Attribution {
  editTarget: { file: string; line: number; column: number; fileHash?: string }
  authoredAt: { file: string; line: number; column: number }
  /**
   * The `data-desde-src` value literally present on the element (or its nearest
   * stamped ancestor), plus how many elements it matches right now. This is
   * the only coordinate a `[data-desde-src="…"]` CSS rule may be anchored on —
   * `authoredAt` prefers the `data-desde-own` rescue stamp, which on a component
   * root names a coordinate no element carries. Absent when nothing in the
   * ancestry is stamped. See `resolveDomAnchor` in `element-attribution.ts`.
   */
  domAnchor?: {
    file: string
    line: number
    column: number
    matchCount: number
    resolution: "direct" | "ancestor"
  }
  editableComponent: Record<string, unknown>
  /**
   * Raw `data-desde-src` string for the leaf vnode stamp (undefined for
   * root-SFC native elements). Preserved so derivations can perform
   * exact-string comparisons against parent stamps without
   * re-stringifying the parsed loc.
   */
  leafVnodeStampRaw?: string
  iteration?: {
    source: "v-for" | "map" | "each" | "unknown"
    key: string | number
    index: number
    siblingCount: number
    expression: string | null
  }
  isLibrary: boolean
}

/**
 * Override-store wire payloads (WS3, tasks/edit-pipeline-rearchitecture.md).
 * The store itself (`./override-store`) owns the state machine; these are
 * just the shapes that cross the postMessage boundary.
 */

/** Shell → bridge: resolve a pending override by the id it was registered
 *  under (the same id used on the wire to POST /api/editor/edit). */
export interface ResolveOverridePayload {
  id: string
  outcome: OverrideOutcome
  reason?: string
}

/** Shell → bridge: APPLY_PROP_OVERRIDE gains an optional `overrideId` — when
 *  present, the bridge also registers the poke with the OverrideStore so a
 *  failed/refused save reverts it. Omitting it preserves today's fire-and-
 *  forget behavior for callers that haven't wired the closed loop yet. */
export interface ApplyPropOverridePayload {
  selector: string
  propName: string
  value: unknown
  overrideId?: string
}

/** Bridge → shell: an override was reverted (edit failed/refused). */
export interface OverrideRevertedPayload {
  id: string
  kind: OverrideKind
  selector: string
  reason: string
}

/** Bridge → shell: an override went unresolved past the timeout — DOM is
 *  left as-is, but the shell should surface a subtle "unverified" state. */
export interface OverrideUnverifiedPayload {
  id: string
  kind: OverrideKind
  selector: string
}

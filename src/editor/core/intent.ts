/**
 * Handoff data structures editor authors and the engineering MCP
 * serves. These structures travel with the prototype source so they
 * survive across sessions and reach engineering on the way to
 * implementation.
 *
 * Targets are referenced by lightweight `targetId` strings rather than
 * full {@link ./selection.SelectionTarget} objects to avoid circular
 * dependencies and to keep the structures portable across sessions.
 *
 * **`OffSystemMarker` placement note.** It lives here (not in
 * `selection.ts`) because structurally it's a handoff artifact — the
 * eng MCP serves it during handoff alongside intent and data
 * contracts. `Selection.offSystem` references it from the runtime side
 * by composition; the runtime knows when an element has an active
 * marker, but ownership of the data structure is on the handoff side.
 * Markers can also persist standalone (without a live `Selection`),
 * which is why they carry their own `id` and target reference.
 */

import type { ComponentPropManifest, ManifestValue } from './manifest'

/**
 * Free-form rationale capture. Designers record why a decision was made
 * so engineering can preserve intent during implementation. Created
 * lazily — only when a decision matters.
 */
export interface IntentRecord {
  id: string
  /** ISO 8601 timestamp. */
  createdAt: string
  /** Author identifier — designer id, session id, or auth subject. */
  authorId: string
  /** Free-form rationale text. */
  text: string
  /** Optional tags for categorization (e.g., 'accessibility', 'a/b-test'). */
  tags?: string[]
  /** Lightweight target reference. */
  targetId: string
  /** Component name when known, for human-readable handoff display. */
  componentName?: string
  /** Optional prop-level scope. */
  scope?: {
    propName?: string
    variantGroup?: string
  }
}

/**
 * Mock-data shape attached to a data-bound component. Doubles as a
 * contract for what the production API should return.
 */
export interface DataBinding {
  id: string
  /** Lightweight target reference. */
  targetId: string
  /** Component name when known. */
  componentName?: string
  /** Optional human-readable name for this binding (e.g., 'CustomerProfile'). */
  name?: string
  /** Shape of the expected data, expressed in the same prop shape used elsewhere. */
  shape: ComponentPropManifest[]
  /** Concrete sample data used to render the component during refinement. */
  example: ManifestValue
  /** Reference to a production schema (e.g., OpenAPI fragment id, Protobuf message). */
  productionSchemaRef?: string
}

/**
 * Marks an element (or a specific property of an element) as off-system —
 * authored with a value outside the design system's vocabulary. Eng MCP
 * exposes these during handoff so engineering can decide whether to
 * reproduce the override or push back to design.
 *
 * Lightweight `targetId` reference for the same reasons as `IntentRecord`
 * and `DataBinding` — markers persist alongside the prototype source and
 * re-resolve to live elements via the bridge protocol's target-id contract.
 */
export interface OffSystemMarker {
  id: string
  /** ISO 8601 timestamp. */
  createdAt: string
  /** Lightweight target reference. */
  targetId: string
  /** Property scope. '*' means the whole element is off-system. */
  property: string
  /** The off-system value (e.g., a literal pixel value where a token was expected). */
  value: ManifestValue
  /** Optional rationale (e.g., "designer requested 13px specifically per spec"). */
  reason?: string
}

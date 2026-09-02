/**
 * Expectation capture (pure).
 *
 * Turns a just-dispatched deterministic edit + the manifest forward-hint
 * `attribute()` already resolved into an `EditExpectation` — the read-back
 * target for L2. Returns `null` when we cannot say *where* the value should
 * render (no manifest dom-hint and not an obvious text/attr edit); the
 * verifier then reports `skipped` rather than guessing. We never claim to
 * verify what we can't locate.
 */

import type { SourceLocation } from '../core'
import type { EditExpectation, RenderAccessor } from './types'
import type {
  CascadeExpectationSpec,
  CascadeOwner,
  CascadePropertyExpectation,
} from './cascade-outcome'

export interface ExpectationInput {
  /** Id of the edit that produced this expectation. */
  editId: string
  /** DOM selector for the element the value renders into. */
  selector: string
  /** The new value, already stringified as it should appear in the DOM. */
  expectedValue: string
  /** What kind of edit this was. */
  editKind: 'prop' | 'slot' | 'dom-text' | 'style' | 'token'
  /** Prop name (when `editKind === 'prop'`). */
  propName?: string
  /**
   * The manifest dom-hint `field`, when one was resolved by attribution.
   * `'attribute'` → read an attr; `'textContent'`/`'innerHTML'` → read text.
   */
  domField?: 'textContent' | 'attribute' | 'innerHTML'
  /** Attribute name (required when `domField === 'attribute'`). */
  attribute?: string
  /**
   * The REPRESENTATIVE CSS property a style/token edit set (required for those
   * kinds) — it names the read-back accessor and the human-facing label. What
   * gets VERIFIED is `styleProperties` when supplied; this is the one the label
   * describes, so it should be the property the user's action is about (the
   * authored declaration, pre-shorthand-expansion).
   */
  styleProperty?: string
  /**
   * How to recognize the rule this edit wrote (required for style/token kinds).
   * Without it we cannot tell our rule from a competing one, so we decline.
   */
  cascadeOwner?: CascadeOwner
  /**
   * The CSS value the edit wrote for `styleProperty`, in AUTHORED form —
   * optional. Supplying it adds the value dimension to the cascade oracle so a
   * repeat edit of an already-owned property can't pass on ownership alone. See
   * `CascadeSinglePropertySpec.expectedDeclarationValue`.
   *
   * Single-property shorthand for the common case (the token lane); ignored when
   * `styleProperties` is supplied, which carries a value per property.
   */
  expectedDeclarationValue?: string
  /**
   * EVERY property the edit set, with the value expected for each — shorthands
   * already expanded to their longhands (`expandStyleDeclarations`). This is the
   * set the cascade oracle verifies; a single unowned property fails the edit.
   *
   * Omit for a single-property edit and the spec falls back to `styleProperty` +
   * `expectedDeclarationValue`, i.e. exactly the pre-Phase-2 behavior.
   */
  styleProperties?: readonly CascadePropertyExpectation[]
  /** Source position the literal was written to. */
  sourceLoc?: SourceLocation
  /** File the edit rewrote. */
  targetFile?: string
  /** SHA of the worktree auto-commit this edit produced, when known. */
  commitSha?: string
}

/** Derive the read-back accessor, or `null` when the render site is unknown. */
function deriveAccessor(input: ExpectationInput): RenderAccessor | null {
  // Style + token edits read a computed CSS property. Both fields are required:
  // without a property there is nothing to read, and without an owner we could
  // not distinguish our rule from the one that beat it.
  if (input.editKind === 'style' || input.editKind === 'token') {
    if (!input.styleProperty || !input.cascadeOwner) return null
    return { kind: 'style', name: input.styleProperty }
  }
  // Manifest dom-hint is the authoritative source.
  if (input.domField === 'attribute') {
    if (!input.attribute) return null // attribute hint without a name is unusable
    return { kind: 'attr', name: input.attribute }
  }
  if (input.domField === 'textContent' || input.domField === 'innerHTML') {
    return { kind: 'text' }
  }
  // No dom-hint: fall back on edit kind. Slot / dom-text always render as text.
  if (input.editKind === 'slot' || input.editKind === 'dom-text') {
    return { kind: 'text' }
  }
  // A prop with no manifest hint — we don't know if it surfaces as text, an
  // attr, or nothing visible. Decline rather than guess.
  return null
}

function buildLabel(input: ExpectationInput): string {
  const name =
    input.propName ??
    input.styleProperty ??
    (input.editKind === 'prop' ? 'prop' : 'text')
  const v =
    input.expectedValue.length > 32
      ? `${input.expectedValue.slice(0, 31)}…`
      : input.expectedValue
  return `${name} = ${JSON.stringify(v)}`
}

function buildCascade(input: ExpectationInput): CascadeExpectationSpec | undefined {
  if (input.editKind !== 'style' && input.editKind !== 'token') return undefined
  if (!input.styleProperty || !input.cascadeOwner) return undefined
  // Multi-property (the style lanes, post-expansion) wins when supplied; the
  // single-property fallback keeps the token lane and every older caller working
  // exactly as before. An empty array is treated as "not supplied" rather than
  // "verify nothing", so a caller whose resolver produced no declarations still
  // gets the representative property checked instead of a silent skip.
  const properties: readonly CascadePropertyExpectation[] =
    input.styleProperties && input.styleProperties.length > 0
      ? input.styleProperties
      : [
          {
            property: input.styleProperty,
            // Spread rather than assign `undefined`: absent means
            // "ownership-only", and callers/tests compare the spec structurally.
            ...(input.expectedDeclarationValue
              ? { expectedDeclarationValue: input.expectedDeclarationValue }
              : {}),
          },
        ]
  return { owner: input.cascadeOwner, properties }
}

export function deriveExpectation(input: ExpectationInput): EditExpectation | null {
  if (!input.selector) return null
  const accessor = deriveAccessor(input)
  if (!accessor) return null
  return {
    editId: input.editId,
    label: buildLabel(input),
    selector: input.selector,
    accessor,
    expectedValue: input.expectedValue,
    sourceLoc: input.sourceLoc,
    targetFile: input.targetFile,
    commitSha: input.commitSha,
    cascade: buildCascade(input),
    provenance: 'deterministic',
  }
}

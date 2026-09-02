/**
 * Cascade-verification target for a style edit (pure).
 *
 * Extracted from `useEditorEditing` for the same reason `style-edit-builders.ts`
 * was: it has zero React dependency (it only reads the edit it is handed and
 * calls other pure functions), and the multi-property/shorthand behavior it
 * encodes is exactly what needs a colocated test — the hook is 4k lines and
 * cannot be exercised for this in isolation.
 */

import type { StructuralEdit } from "@/editor/core"
import { resolveTailwindClasses } from "@/components/editor/tailwind-declarations"
import {
  expandStyleDeclarations,
  type CascadeOwner,
  type CascadePropertyExpectation,
} from "@/editor/verification"

/**
 * Which rule will own the properties once this style edit lands, EVERY property
 * to verify, and the CSS value each was set to — the identity the cascade
 * verifier (`src/editor/verification/cascade-outcome.ts`) checks, plus the
 * label the Checks strip / toast shows. Mirrors the lane split in
 * `buildStyleEdit` / `style-edit-builders.ts`:
 *   - Vue `scoped-css-override` emits a single `[data-desde-src="…"]`-anchored
 *     rule covering every declaration the edit set.
 *   - React `jsx-style` emits either a `className` splice (ownership by
 *     class name) or an inline `style={{}}` merge, depending on `mode`.
 * A `token-value` edit isn't handled here — `buildStyleEdit` never produces
 * one (it's Vue/React styling only); the token lane derives its own owner
 * directly in `handleTokenStyleEdit`, where `property` and the token name
 * are already in scope.
 *
 * **Every property, not one representative (Phase 2).** A single class edit sets
 * several CSS declarations (`border` → `border-style` + `border-width`), and v1
 * verified only the sorted-first one, which false-passed a half-landed edit: an
 * element already carrying `style="border-width: 0 !important"` beats us on the
 * un-sampled property while our rule wins the sampled one, and the border stays
 * invisible. That splits the verdict on the Vue lane too, not just React's
 * `classes` lane, because a competing declaration can be scoped to one property
 * even when our rule is a single block. `properties` therefore carries all of
 * them — on every lane.
 *
 * `property`/`value` survive as the REPRESENTATIVE — the sorted-first authored
 * declaration, pre-expansion — because they name the read-back accessor and the
 * human-facing label ("padding" reads better than one of its four longhands).
 *
 * **Both extra dimensions — shorthand expansion and per-property values — are
 * gated on the OWNER, because both rest on the same premise: the declaration
 * being verified is one WE authored, with a literal value.**
 *
 *  - `pt-src` / `inline` — true by construction. The Vue applicator splices our
 *    resolved declarations verbatim into a `[data-desde-src]` rule; the React inline
 *    lane writes them into `style={{}}`. So a shorthand of ours answers for each
 *    of its longhands (CSSOM reports every longhand of a declared shorthand),
 *    which is what makes a competing longhand rule a candidate in the walk at
 *    all, and the value comparison is authored-vs-specified for one declaration.
 *  - `classes` — FALSE. The declaration belongs to **Tailwind**, and we only hold
 *    a model of it. Expanding is unsound: a utility whose value routes through a
 *    custom property (v4 `.p-4 { padding: calc(var(--spacing)*4) }`,
 *    `.rounded-lg { border-radius: var(--radius-lg) }`, `.border-red-500
 *    { border-color: var(--color-red-500) }`, v3 `border-color: rgb(… /
 *    var(--tw-border-opacity))`) is a *pending-substitution value*, whose longhand
 *    serialization is the empty string — so the walker's candidacy test
 *    (`rule.style.getPropertyValue(property)`, `src/bridge/style-provenance.ts`)
 *    skips the utility for its own longhands and preflight (`*, ::before, ::after
 *    { margin: 0; padding: 0; border: 0 solid }`) wins them, turning a visibly
 *    correct `p-4` into "`*, ::after, ::before` wins the cascade for
 *    padding-bottom". This is the exact premise `style-shorthands.ts` already uses
 *    to refuse expanding our OWN `var()` shorthands; it belongs here too.
 *    Value-comparing is unsound for a second reason: a mismatch between Tailwind's
 *    declaration and our model of that utility means our model drifted (a
 *    customized v3 `theme.extend.spacing` scale emits a literal `1.125rem` for
 *    `p-4`), not that the edit failed.
 *
 * So `classes` verifies the authored, UNEXPANDED property set for **ownership
 * only**. That knowingly gives up one genuine catch — a `p-4`-vs-library-
 * `padding-left` conflict on a v3 substrate whose spacing scale is literal — which
 * is the correct trade: a false alarm is worse than no signal.
 *
 * Returns null when no owner/property can be derived — an edit kind this
 * function doesn't recognize, or no class/declaration resolved to CSS. The
 * caller then falls back to the pre-existing confirm-on-write release
 * rather than blocking or breaking an edit that would previously succeed.
 */
export function cascadeTargetForStyleEdit(edit: StructuralEdit): {
  owner: CascadeOwner
  /** Representative authored property — accessor + label only. */
  property: string
  /** Representative authored value — the human-facing expected value. */
  value: string
  /** Every property to verify, shorthands expanded, with per-property values. */
  properties: CascadePropertyExpectation[]
} | null {
  const target = (
    owner: CascadeOwner,
    declarations: Record<string, string>,
  ): ReturnType<typeof cascadeTargetForStyleEdit> => {
    // Sorted for determinism: object key order would otherwise decide the label.
    const sorted = Object.keys(declarations).sort()
    const property = sorted[0]
    if (!property) return null
    // Tailwind authors the declaration on this lane, so neither expansion nor a
    // value comparison is sound — see the owner gate in this function's doc.
    const properties: CascadePropertyExpectation[] =
      owner.kind === 'classes'
        ? sorted.map((p) => ({ property: p }))
        : expandStyleDeclarations(declarations).map((d) => ({
            property: d.property,
            // A longhand whose expected value is ambiguous (a shorthand and one
            // of its own longhands were both set) is ownership-only.
            ...(d.value ? { expectedDeclarationValue: d.value } : {}),
          }))
    return { owner, property, value: declarations[property], properties }
  }
  if (edit.kind === "scoped-css-override") {
    return target({ kind: "pt-src" }, edit.declarations ?? {})
  }
  if (edit.kind === "jsx-style") {
    if (edit.mode === "inline") {
      return target({ kind: "inline" }, edit.declarations ?? {})
    }
    const classes = edit.addClasses ?? []
    if (classes.length === 0) return null
    return target({ kind: "classes", classes }, resolveTailwindClasses(classes))
  }
  return null
}

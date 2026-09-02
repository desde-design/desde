/**
 * Bounded CSS shorthand → longhand expansion for the cascade oracle (pure).
 *
 * **The blind spot this closes.** The cascade walker asks each candidate rule
 * `rule.style.getPropertyValue(property)`. CSSOM answers that question
 * asymmetrically for shorthands: a rule declaring `padding: 1rem` DOES report
 * `padding-left` (the shorthand sets every longhand in the declaration block),
 * but a rule declaring only `padding-left: 2rem` reports `''` for `padding`. So
 * verifying the shorthand a utility resolved to (`p-4` → `{ padding: '1rem' }`)
 * makes a competing longhand rule invisible: it is never even a candidate in the
 * walk, our shorthand rule is reported as the winner, and the padding visibly
 * does not move on the side the library owns. Verifying the LONGHANDS instead
 * makes both directions work, because our own shorthand answers for each of
 * them.
 *
 * **Deliberately bounded, not a general CSS shorthand database.** The map covers
 * exactly the shorthands the inspector's own resolver can emit
 * (`src/components/editor/tailwind-declarations.ts`): `padding` / `margin` /
 * `gap` (spacing), `border-width` / `border-style` / `border-color` (borders),
 * and `border-radius`. Everything else — including a shorthand we decline to
 * expand for one of the reasons below — passes through untouched, which degrades
 * to the pre-expansion behavior rather than to a wrong verdict.
 *
 * **Only sound for declarations WE author.** The whole mechanism rests on "our own
 * shorthand answers for each longhand", which is true by construction for the
 * `pt-src` and `inline` lanes (we splice literal values) and FALSE for a
 * Tailwind-authored utility, whose value routinely routes through a custom
 * property and therefore serializes as `''` per longhand — the same reason
 * `shorthandValueIsExpandable` refuses our own `var()` shorthands below. The
 * caller gates on the cascade owner accordingly
 * (`src/hooks/cascade-target-for-style-edit.ts`); this module is never handed a
 * `classes`-owner declaration map.
 *
 * No React, no DOM, no design-system knowledge — plain CSS structure over a
 * declaration map.
 */

/**
 * Shorthand → the longhands it sets, for the shorthands the resolver emits.
 * Order within each list is the CSS-canonical one (top/right/bottom/left;
 * corners clockwise from top-left), which only affects output ordering.
 */
export const EXPANDABLE_SHORTHANDS: Readonly<Record<string, readonly string[]>> =
  {
    padding: [
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ],
    margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    gap: ['row-gap', 'column-gap'],
    'border-width': [
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
    ],
    'border-style': [
      'border-top-style',
      'border-right-style',
      'border-bottom-style',
      'border-left-style',
    ],
    'border-color': [
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
    ],
    'border-radius': [
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  }

/** One property to verify, with the value to expect for it when we know it. */
export interface ExpandedDeclaration {
  property: string
  /**
   * The value this property should carry, or `undefined` when the expansion
   * cannot name one unambiguously. Ownership is still verified in that case; the
   * value dimension simply declines, which is the fail-safe direction.
   */
  value?: string
}

/**
 * Split a CSS value into its top-level, whitespace-separated components,
 * ignoring whitespace inside parentheses so `rgb(1, 2, 3)` counts as one.
 */
function topLevelComponentCount(value: string): number {
  let depth = 0
  let count = 0
  let inComponent = false
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    const isSpace = depth === 0 && /\s/.test(ch)
    if (isSpace) {
      inComponent = false
      continue
    }
    if (!inComponent) {
      inComponent = true
      count++
    }
  }
  return count
}

/**
 * Can this shorthand VALUE be pushed down to every longhand verbatim? Two
 * refusals, both of which would otherwise manufacture a false failure:
 *
 *  - **more than one component** (`padding: 1rem 2rem`) — the components map to
 *    different sides, and the box-model distribution rules are exactly the kind
 *    of general shorthand modelling this module refuses to own. (The resolver
 *    only ever emits single-component shorthands; this is the guard for the day
 *    something else feeds the oracle.)
 *  - **a `var()` / `env()` reference** (`border-color: var(--brand)`, from
 *    `border-[var(--brand)]`) — a shorthand whose value contains a substitution
 *    function becomes a *pending-substitution value* in CSSOM, and the spec has
 *    longhand serialization return the empty string for it. So expanding
 *    `border-color: var(--x)` would make our OWN rule stop answering for
 *    `border-top-color`, and the oracle would report a good edit as overridden.
 */
function shorthandValueIsExpandable(value: string): boolean {
  if (/(?:^|[^\w-])(?:var|env)\s*\(/i.test(value)) return false
  return topLevelComponentCount(value) === 1
}

/**
 * Expand a declaration map into the property set the cascade oracle should
 * verify: every longhand a supported single-value shorthand implies, plus every
 * declaration that is not such a shorthand, sorted by property name so the
 * result is deterministic regardless of key insertion order.
 *
 * When a shorthand and one of its own longhands are BOTH set (`p-4 pl-2` →
 * `{ padding, padding-left }`), which value wins depends on their order inside
 * the emitted rule body — which this module does not model. It keeps the
 * longhand in the verified set (ownership is unaffected) and drops its expected
 * VALUE, so an unmodelled ordering can never produce a false `stale-value`.
 */
export function expandStyleDeclarations(
  declarations: Readonly<Record<string, string>>,
): ExpandedDeclaration[] {
  const expandable: string[] = []
  const passthrough: string[] = []
  for (const property of Object.keys(declarations)) {
    const longhands = EXPANDABLE_SHORTHANDS[property]
    if (longhands && shorthandValueIsExpandable(declarations[property])) {
      expandable.push(property)
    } else {
      passthrough.push(property)
    }
  }

  const out = new Map<string, ExpandedDeclaration>()
  for (const shorthand of expandable) {
    for (const longhand of EXPANDABLE_SHORTHANDS[shorthand]) {
      out.set(longhand, { property: longhand, value: declarations[shorthand] })
    }
  }
  for (const property of passthrough) {
    // An explicitly-set property always stays in the verified set; it only loses
    // its expected value when a shorthand above already claimed it (the
    // unmodelled-ordering case documented on this function).
    out.set(
      property,
      out.has(property)
        ? { property }
        : { property, value: declarations[property] },
    )
  }
  return [...out.values()].sort((a, b) => (a.property < b.property ? -1 : 1))
}

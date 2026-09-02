/**
 * Decides whether a mutation whose `data-desde-src` is shared by several rendered
 * elements is `definition`-scoped (ONE authored line, rendered N times) or
 * `callsite`-scoped (N authored lines that merely share a stamp).
 *
 * ── Why the distinction is not cosmetic ──
 *
 * `scope` decides which choices the disambiguation dialog may offer, and
 * `disambiguation-choices.ts` states the rule it enforces: a per-item option is
 * offered ONLY for `callsite`, because a `definition`-scoped save rewrites the
 * shared line whatever the user picked, so offering "this one only" there
 * "would silently lie."
 *
 * Until 2026-08-16 `scope` was derived from `resolutionKind` alone and could
 * therefore never be `callsite` — which was safe on Vue and wrong on React.
 * MEASURED on a canonical shadcn app
 * (`tasks/react-hint-generation-phase0.md` § 7.8.3a): typing in the iframe on
 * one of two `<Button>`s raised the dialog with `anchorMatchCount: 2`, offering
 * only "Change all 2 items" with the hint "This text is written once in the code
 * shared by every item." Both halves were false. The two labels are written
 * separately at two callsites in `App.tsx`; they share a `sourceLoc` only
 * because the shadcn wrapper stamps its own `<Comp {...props} />`. Applying that
 * one offered choice changed ONE item.
 *
 * Vue does not reach this shape by construction: attribute fallthrough puts the
 * PARENT's stamp on a component root, so two usages of one component carry
 * DIFFERENT `data-desde-src` values and never appear in each other's candidate
 * list. Loop rows, on both frameworks, share one callsite.
 *
 * ── Why ALL-distinct, and not merely "any two differ" ──
 *
 * A component can be used at one callsite AND inside a loop at another, so the
 * candidate set is a mix: 10 rows sharing callsite A plus 1 standalone at B.
 * "Any two differ" would call that `callsite`, and then "this one only" on a
 * loop row would edit callsite A and silently change all ten. Requiring a 1:1
 * mapping — every candidate a DISTINCT, known callsite — is the only shape
 * where the per-item option is honest for every candidate. Anything else fails
 * safe to `definition`, which is exactly today's behaviour.
 */

/** The scope vocabulary `BridgeMutation.scope` uses. */
export type MutationScope = 'definition' | 'callsite' | 'unknown'

/**
 * @param callsiteLocs one entry per candidate element, in candidate order.
 *   `null` means the callsite could not be resolved for that candidate.
 * @returns `'callsite'` only when there are 2+ candidates and every one maps to
 *   its own distinct, known callsite; `'definition'` otherwise.
 */
export function classifyMutationScope(
  callsiteLocs: readonly (string | null)[],
): 'definition' | 'callsite' {
  // A single candidate is never ambiguous, and promoting it would flip
  // `isCrossFile` for ordinary edits across the whole product. Out of scope.
  if (callsiteLocs.length < 2) return 'definition'
  const seen = new Set<string>()
  for (const loc of callsiteLocs) {
    // Unknown for any candidate ⇒ we cannot prove the 1:1 mapping.
    if (loc === null || loc.length === 0) return 'definition'
    // A repeat means at least two candidates come from one authored line,
    // so a per-item edit would move more than that item.
    if (seen.has(loc)) return 'definition'
    seen.add(loc)
  }
  return 'callsite'
}

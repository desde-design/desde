/**
 * Probe-derivation engine — Phase 4 "rendering hints at scale" (Task 3).
 *
 * Pure orchestration over an INJECTED probe function: given one component's
 * manifest, builds the sentinel mount spec (string-typed props + the default
 * slot), hands it to the probe, and turns the resulting `ProbeObservation`
 * into `RenderingHint`s. No browser, no filesystem, no HTTP — every
 * dependency is a plain function parameter, so this is unit-testable with a
 * fake probe (see `derive-hints.test.ts`). The caller that wires up a REAL
 * browser (Task 3's `generate-hints-run.ts`, and ultimately
 * `editor-cli/src/server/design-systems-handler.ts`) supplies `probe` as a
 * closure over `probeComponent` (`./probe-driver.ts`) + a live `ProbePage`.
 *
 * ── String-prop predicate (conservative, stated per the task brief) ──
 *
 * Only `control.kind === 'text'` props are probed. This is the ONE
 * `ControlKind` that means "arbitrary free-text string, safe to overwrite
 * with a sentinel": `'finite-choice'` (enums — a component may validate/
 * reject an out-of-set sentinel value, or its rendering depends on the
 * MEANING of the value, not just its presence), `'token'` (design-token
 * references — same reasoning), `'boolean'`/`'number'`/`'function'`/
 * `'object'`/`'array'`/`'slot'`/`'event'`/`'unknown'` are all excluded because
 * a sentinel STRING isn't a valid value of that shape at all. See
 * `src/editor/adapters/component-meta/normalize.ts`'s `classifyControl` for
 * how `'text'` gets assigned (a schema whose primitive set is exactly
 * `string`).
 *
 * ── Sentinel naming convention ──
 *
 * Per the Phase 4 plan's global constraints: `PT_SENTINEL_<n>_<suffix>`,
 * where `n` is the sentinel's 0-based index within THIS component's mount
 * (unique per prop/slot within a mount — string props first, in manifest
 * order, then the default slot last) and `suffix` is shared across an entire
 * generate-hints RUN (computed once by the caller, e.g.
 * `generate-hints-run.ts`, and threaded through every component's derive
 * call) — NOT regenerated per component. `n` alone already guarantees no two
 * sentinels WITHIN one mount collide; the shared suffix additionally makes
 * every sentinel from a run vanishingly unlikely to collide with the
 * component's own static markup.
 *
 * ── Match resolution (mount-root vs. descendant ambiguity) ──
 *
 * `probeComponent` deliberately does NOT resolve this — Task 2 reports both
 * a mount-root match and a descendant match for a sentinel whose value rolls
 * up through `textContent` (a single-child wrapper's `:root` textContent
 * equals its one child's textContent too). This module's `resolveMatch`
 * picks the MORE SPECIFIC (descendant) selector when there's exactly one
 * root match plus exactly one distinct non-root selector; anything else
 * genuinely ambiguous (two or more DISTINCT non-root elements matched the
 * same sentinel) is treated exactly like "not found" — no hint, silent,
 * counted only in the sense that `hints.length` for that finding is 0.
 */

import type { ComponentManifest, ComponentPropManifest, RenderingHint } from '../core/manifest'
import type { ProbeMountSpec, ProbeObservation, ProbeObservationMatch } from './probe-driver'

/** A probe function, fully decoupled from browser/page concerns — see module doc comment. */
export type ProbeFn = (spec: ProbeMountSpec) => Promise<ProbeObservation>

export interface DeriveHintsOutcome {
  /** `false` when the component could not be mounted/probed at all (never fatal to the caller). */
  ok: boolean
  /** Set when `ok` is false. */
  reason?: string
  /** Generated `RenderingHint`s — empty when nothing was found (not an error). */
  hints: RenderingHint[]
}

/**
 * Conservative "plain, arbitrary string" predicate — see module doc comment.
 * Exported for testing and for any future caller (e.g. Task 4's source
 * inference lane) that needs the SAME notion of "string-typed prop".
 */
export function isStringProp(prop: ComponentPropManifest): boolean {
  return prop.control.kind === 'text'
}

/**
 * Builds the `ProbeMountSpec` for one component: a sentinel value for every
 * string-typed prop (see {@link isStringProp}), plus a sentinel for the
 * component's default slot (always attempted — mounting an extra, unused
 * slot is a harmless no-op for a component that doesn't render one; the
 * finding simply comes back with zero matches). Exported for direct testing.
 */
export function buildProbeMountSpec(
  manifest: ComponentManifest,
  sentinelSuffix: string,
): ProbeMountSpec {
  const stringProps = manifest.props.filter(isStringProp)
  const props: Record<string, string> = {}
  stringProps.forEach((prop, i) => {
    props[prop.name] = sentinelFor(i, sentinelSuffix)
  })
  return {
    importPath: manifest.importPath ?? '',
    exportName: manifest.name,
    props,
    slotText: sentinelFor(stringProps.length, sentinelSuffix),
  }
}

function sentinelFor(index: number, suffix: string): string {
  return `PT_SENTINEL_${index}_${suffix}`
}

/**
 * Probe one component and derive its `RenderingHint`s. Never throws: a probe
 * that rejects, or an `ProbeObservation` with `ok: false` (mount failure,
 * timeout, crash), resolves to `{ ok: false, reason, hints: [] }` — the
 * caller (`generate-hints-run.ts`) counts this as a skipped component, never
 * fatal to the run.
 */
export async function deriveHintsForComponent(
  manifest: ComponentManifest,
  probe: ProbeFn,
  sentinelSuffix: string,
): Promise<DeriveHintsOutcome> {
  if (!manifest.importPath) {
    return {
      ok: false,
      reason: 'manifest has no importPath: cannot mount for probing',
      hints: [],
    }
  }

  const spec = buildProbeMountSpec(manifest, sentinelSuffix)

  let observation: ProbeObservation
  try {
    observation = await probe(spec)
  } catch (err) {
    return { ok: false, reason: `probe threw: ${errMessage(err)}`, hints: [] }
  }
  if (!observation.ok) {
    return { ok: false, reason: observation.reason ?? 'component failed to mount', hints: [] }
  }

  const hints: RenderingHint[] = []
  for (const finding of observation.findings) {
    const resolved = resolveMatch(finding.matches)
    if (!resolved) continue
    // A match rendered by a CHILD component becomes a `forward` hint, not a
    // `dom` one — the two are consumed by different halves of `attribute()`
    // and are not interchangeable. See `ProbeOwnership` in `probe-driver.ts`
    // for the measurement that forced this branch: without it every hint this
    // engine has ever produced was `dom`, including ones describing DOM the
    // component does not own, which `findDomHit` can never match.
    if (resolved.ownedByChild) {
      hints.push({
        kind: 'forward',
        source: finding.propOrSlot,
        forwardTo: {
          component: resolved.ownedByChild.component,
          ...(resolved.ownedByChild.childProp !== undefined
            ? { childProp: resolved.ownedByChild.childProp }
            : {}),
          ...(resolved.ownedByChild.childSlot !== undefined
            ? { childSlot: resolved.ownedByChild.childSlot }
            : {}),
        },
        provenance: 'generated',
        verified: true,
      })
      continue
    }
    hints.push({
      kind: 'dom',
      source: finding.propOrSlot,
      domTarget: {
        selector: resolved.selector,
        field: resolved.field,
        ...(resolved.attribute ? { attribute: resolved.attribute } : {}),
      },
      editability: 'literal',
      provenance: 'generated',
      verified: true,
    })
  }
  // C1 safety guard: two DIFFERENT sentinels (different props/slots) can
  // still resolve to the identical (selector, field, attribute) site within
  // ONE component's own probe pass (e.g. two sibling `div.msg` elements) —
  // see `dropCollidingHints`'s doc comment for why this can't be left to
  // attribution time.
  return { ok: true, hints: dropCollidingHints(hints) }
}

/**
 * Drops every `kind: 'dom'` hint whose rendering SITE — the triple
 * `(domTarget.selector, domTarget.field, domTarget.attribute ?? '')` — is
 * claimed by more than one DISTINCT source (a different `(source.kind,
 * source.name)`). This is the cross-prop counterpart to `resolveMatch`'s
 * ambiguity policy: `resolveMatch` refuses when ONE sentinel matches two
 * distinct elements; this refuses when TWO sentinels (i.e. two different
 * props/slots) both land on the SAME element/field/attribute. Left
 * unguarded, both would be emitted as independently `verified: true` hints
 * at the identical site, and `findDomHit`
 * (`src/editor/attribution/attribute.ts`) — which matches by site and
 * returns the FIRST hit — would deterministically attribute an edit to
 * whichever prop happens to appear first in the array, silently editing the
 * WRONG prop when the user meant the other one. Mirrors `resolveMatch`'s
 * "genuinely ambiguous ⇒ no hint, silent" posture rather than guessing.
 *
 * Duplicate hints for the SAME source at the SAME site (e.g. a probe hint
 * and an inferred hint for the identical prop, already deduped upstream by
 * `mergeRenderingHints`) are NOT ambiguous — this collapses them to one
 * entry rather than dropping them, preserving that existing dedupe
 * behavior.
 *
 * Applied at all three points a component's hint set is assembled: this
 * function's own caller ({@link deriveHintsForComponent}, the raw
 * probe-derivation output), `generate-hints-run.ts` (the merged
 * probe+inference set), and `llm-generate-hints.ts` (the LLM-verified
 * additions) — extracted here as the ONE shared implementation so the rule
 * can't drift between call sites.
 *
 * `kind: 'forward'` hints are held to the SAME rule, keyed on their
 * destination (`forwardTo.component` plus `childProp`/`childSlot`) rather than
 * on a DOM site. This function used to exempt them, on the reasoning that
 * "collisions are only meaningful for concrete DOM sites" — that was only ever
 * true because no generator could emit a forward hint at all.
 * `findForwardHint` (`src/editor/attribution/attribute.ts`) also returns the
 * FIRST match, so two distinct props both claiming to feed `KLabel`'s default
 * slot would misattribute in exactly the way two dom hints at one site do.
 */
export function dropCollidingHints(hints: RenderingHint[]): RenderingHint[] {
  const bySite = new Map<string, RenderingHint[]>()
  for (const hint of hints) {
    const key = siteKey(hint)
    const group = bySite.get(key)
    if (group) group.push(hint)
    else bySite.set(key, [hint])
  }

  const kept: RenderingHint[] = []
  for (const group of bySite.values()) {
    const distinctSources = new Set(group.map((h) => `${h.source.kind}:${h.source.name}`))
    if (distinctSources.size > 1) continue // cross-prop collision — drop the whole site
    kept.push(group[0]) // same-source duplicate — collapse, not a collision
  }
  return kept
}

function siteKey(hint: RenderingHint): string {
  if (hint.kind === 'dom') {
    return `dom\u0000${hint.domTarget.selector}\u0000${hint.domTarget.field}\u0000${hint.domTarget.attribute ?? ''}`
  }
  return `fwd\u0000${hint.forwardTo.component}\u0000${hint.forwardTo.childProp ?? ''}\u0000${hint.forwardTo.childSlot ?? ''}`
}

/**
 * Resolves a sentinel's raw match list to at most ONE usable match — see the
 * "Match resolution" section of the module doc comment. Exported for direct
 * unit testing of the ambiguity policy.
 */
export function resolveMatch(matches: ProbeObservationMatch[]): ProbeObservationMatch | null {
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]

  const nonRoot = matches.filter((m) => m.selector !== ':root')
  // All matches were at the mount root itself (e.g. both textContent AND an
  // attribute matched on :root) — no descendant to prefer; take the first
  // (an edge case the brief doesn't specify further; documented here rather
  // than silently dropped).
  if (nonRoot.length === 0) return matches[0]

  const distinctNonRootSelectors = new Set(nonRoot.map((m) => m.selector))
  // Exactly one specific (non-root) element matched — whether alongside a
  // root match (the documented rollup case) or by itself with more than one
  // field match on the SAME element. Prefer it: more specific wins.
  if (distinctNonRootSelectors.size === 1) return nonRoot[0]

  // Two or more DISTINCT non-root elements matched the same sentinel —
  // genuinely ambiguous. Treat exactly like "not found": no hint.
  return null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

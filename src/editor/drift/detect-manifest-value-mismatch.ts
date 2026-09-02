/**
 * Manifest-value-mismatch drift detector — the honest delivery of Phase 5
 * carry-forward (g), "edit-refusal correlation" (see
 * `.superpowers/sdd/2026-07-25-grounding-phase5-drift-detection.md` /
 * `docs/superpowers/specs/2026-07-25-manifest-grounding-rearchitecture-design.md`).
 *
 * The spec's original proposal hooked this producer to
 * `PropEditFallbackHint` (`bound-binding` / `dynamic-vbind` / `v-model` —
 * `src/editor/edit-service/apply-prop-edit.ts`). A thorough exploration
 * (2026-07-30) found that suggestion WRONG and it is deliberately NOT
 * implemented here: every one of those three refusal kinds means "the
 * source shape is richer than a byte-splice can safely rewrite" — a
 * `:variant="computedVariant()"` binding, a `v-model`, a `v-bind="$attrs"`
 * spread — never "the manifest disagrees with reality." Hooking drift to
 * them would fire on nearly every component that uses a computed prop or
 * two-way binding, which is the overwhelming common case, not drift.
 * Likewise `apply-slot-text-edit.ts`'s "before doesn't match source" and
 * `resolve-template-target.ts`'s `tag-mismatch` are bridge-capture/stale-
 * coordinate races (the DOM re-rendered between capture and commit), not
 * manifest drift. None of the pipeline's existing refusal shapes actually
 * encode "manifest vs. source disagreement" — so this module doesn't
 * derive drift from a refusal at all. It derives drift from a
 * *successful* edit whose new value the manifest didn't expect.
 *
 * **This never blocks the edit.** Grounded edit validation is an explicit
 * non-goal of the grounding rearchitecture (see the design doc's scope
 * section) — Editor's edit pipeline stays deterministic-first and
 * fast, not gated on a manifest round-trip. An off-manifest value on a
 * `finite-choice` prop means the manifest and the installed package
 * disagree, but WHICH side is wrong is genuinely ambiguous from here:
 *
 *   - the user (or an LLM edit) may have typed a value the design system
 *     never supported — the manifest is right, the edit is wrong; or
 *   - the installed package may have shipped a new variant since the
 *     manifest was last extracted — the edit is right, the manifest is
 *     stale.
 *
 * Refusing the edit on a hunch would be wrong roughly as often as it was
 * right. Recording a signal and letting auto-repair (a fresh, cheap
 * re-extraction — see `REPAIRABLE_DRIFT_KINDS` in `../core/drift.ts`)
 * resolve the ambiguity is strictly better: if the re-extracted manifest
 * now declares the value, the manifest was stale and repair fixes it
 * silently; if it still doesn't, the manifest was right and the signal
 * stays as a legitimate "off-catalog value" flag for the user to review
 * in the Drift panel.
 *
 * **No rendering-hint trust gate (revised 2026-07-30, review round 2).**
 * The first landing of this rule additionally required the owning
 * manifest to carry a TRUSTED rendering hint (`isTrustedHint` over
 * `manifest.rendering`, the same gate `../attribution/detect-drift.ts`
 * uses for `hint-miss`/`selector-ambiguous`) before firing. That gate is
 * WRONG for this rule and has been removed: rendering-hint provenance
 * (was this DOM-location hint hand-authored or probe-verified?) and
 * prop/enum extraction (does `vue-dts-meta`'s TS-checker walk of the
 * installed `.d.ts` know this prop's option values?) come from
 * completely different pipelines with no dependency on each other. The
 * closest sibling signal, `unknown-props` (`../attribution/detect-drift.ts`),
 * makes the same call: it gates only on the manifest existing, precisely
 * BECAUSE prop data is sourced from dts extraction, not from rendering
 * hints. Gating this rule on hint trust silently suppressed the signal
 * for exactly the components whose enum data is MOST trustworthy — a
 * component with a full-fidelity, freshly-extracted `finite-choice` prop
 * but no (or no verified) rendering hints authored yet. The gate now
 * matches `unknown-props`'s posture: manifest exists, `finite-choice`
 * with non-empty options, value off-list. Nothing else.
 */

import type { ComponentManifest, ControlOption, DriftSignal, ManifestValue } from '../core'

/** How many declared option values to preview in `DriftSignal.detail` before truncating. */
const MAX_OPTIONS_IN_DETAIL = 8

export interface DetectManifestValueMismatchArgs {
  /** The manifest of the component the edit targeted. */
  manifest: ComponentManifest
  /** The prop the edit set. */
  propName: string
  /** The value the edit set it to. */
  value: ManifestValue
}

function formatOptions(options: ControlOption[]): string {
  const values = options.map((o) => String(o.value))
  if (values.length <= MAX_OPTIONS_IN_DETAIL) return values.join(', ')
  return `${values.slice(0, MAX_OPTIONS_IN_DETAIL).join(', ')}, …`
}

/**
 * Advisory-only check: did an edit just set a `finite-choice` prop to a
 * value the manifest doesn't declare? Returns a `manifest-value-mismatch`
 * `DriftSignal` when so, `null` otherwise. Never throws on well-typed
 * input; callers that can't guarantee that (e.g. an HTTP handler reading
 * an untrusted manifest cache) should still wrap the call, since a
 * malformed `manifest.props` shape is not something this function
 * defends against on its own.
 *
 * Gate, precisely (mirrors `unknown-props`'s posture — see the module
 * doc comment for why no rendering-hint trust check belongs here):
 *   (a) the manifest exists and declares the target prop;
 *   (b) that prop's `control.kind === 'finite-choice'` with a non-empty
 *       `options` list;
 *   (c) `value` is not among the declared `options[].value`.
 *
 * All three must hold. A prop the manifest doesn't know about at all, or
 * a non-finite-choice control (text/number/boolean/…), deliberately
 * produce no signal.
 */
export function detectManifestValueMismatch(
  args: DetectManifestValueMismatchArgs,
): DriftSignal | null {
  const { manifest, propName, value } = args

  const prop = manifest.props.find((p) => p.name === propName)
  if (!prop) return null
  if (prop.control.kind !== 'finite-choice') return null

  const options = prop.control.options ?? []
  if (options.length === 0) return null

  const known = options.some((o) => o.value === value)
  if (known) return null

  return {
    kind: 'manifest-value-mismatch',
    component: manifest.name,
    ...(manifest.importPath !== undefined ? { importPath: manifest.importPath } : {}),
    designSystem: manifest.designSystem,
    detail: `${propName}="${String(value)}" not in [${formatOptions(options)}]`,
    at: new Date().toISOString(),
  }
}

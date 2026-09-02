/**
 * Structural drift detection over `attribute()`'s inputs/outputs (Phase 5
 * Task 2 of the grounding rearchitecture — see
 * `.superpowers/sdd/2026-07-29-grounding-phase5-drift/task-2-brief.md`;
 * Task 1 defined the signal model + live log in `../core/drift.ts`).
 *
 * Pure: called right after `attribute()` runs, with the SAME
 * `AttributionContext` + the owning manifest the call site already looked
 * up, plus the `AttributionResult` `attribute()` just produced. Never
 * re-derives anything `attribute()` didn't already compute, and — load
 * bearing — never inspects `AttributionResult.reason` as a STRING. Message
 * text is prose for a human, not a stable contract; every rule below
 * reasons about the same structural facts `attribute()` itself branched on
 * (whether a manifest has trusted hints, whether Step 1's dom-hit search
 * matched anything, whether a manifest exists at all).
 *
 * Precision over recall: a false-positive drift signal wastes the user's
 * attention on a follow-up repair suggestion that isn't actually needed, so
 * every rule here is deliberately conservative. Four refusal shapes are
 * explicitly EXCLUDED (see `detectHintMiss` below for how each is closed
 * out structurally, not by special-casing):
 *
 *   - no-hints-authored refusal   (the manifest simply has no rendering hints)
 *   - an `uneditable` hint         (the manifest explicitly declines editing)
 *   - unmanifested-parent break    (an ancestor has no manifest to walk through)
 *   - prop-not-set-at-call-site    (the consumer never passed this prop)
 *
 * All four are "absence", not "disagreement" — the manifest and the click
 * agree on where they part ways, so there's nothing wrong with the
 * grounding data. `hint-miss` is reserved for the one case where the
 * manifest promised a rendering hint set and NONE of it matched the
 * clicked element — that's the grounding data being wrong, not merely
 * incomplete.
 *
 * `selector-ambiguous` (Phase 5 Task 3) is the DISAGREEMENT counterpart to
 * `hint-miss`'s absence: a trusted dom hit DID match the clicked element's
 * selector, but the bridge's click-time uniqueness check
 * (`ClickedElementContext.soleMatchWithinMountRoot`) found more than one
 * element in the mount root answering to that same selector — the hint may
 * be pointing at the wrong instance. Reuses the exact same trust gate +
 * dom-hit matcher `attribute()` itself uses (`isTrustedHint` / `findDomHit`)
 * so the two can't silently diverge on what counts as "a hit."
 */

import { findDomHit, isTrustedHint } from './attribute'
import type { AttributionContext, AttributionResult, ComponentChainEntry } from './types'
import type { ComponentManifest, DriftSignal } from '../core'

/**
 * Standard HTML global attributes — valid (and common) on ANY element,
 * regardless of component, so no manifest is expected to declare them as a
 * prop. The bridge's `consumerVnodeProps` extraction passes through EVERY
 * non-`data-desde-` attribute the consumer template wrote (see
 * `build-attribution-context.ts`), which includes Vue's `$attrs`
 * fallthrough — so a library component receiving `id`, `data-testid`,
 * `aria-label`, `title`, `role`, etc. from its call site is completely
 * ordinary, not a sign the manifest is stale. Without this exclusion,
 * `unknown-props` fired on essentially every real component (a false
 * signal that now also triggers auto-repair — see Task 4). Lowercased set:
 * these are written verbatim in templates (not camelCased like a real Vue
 * prop), so a case-insensitive compare guards against incidental casing
 * without needing per-attribute normalization.
 */
const GLOBAL_HTML_ATTRS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'role',
  'tabindex',
  'slot',
  'lang',
  'dir',
  'hidden',
  'draggable',
  'spellcheck',
  'translate',
  'accesskey',
  'autocapitalize',
  'contenteditable',
  'enterkeyhint',
  'inputmode',
  'is',
  'itemid',
  'itemprop',
  'itemref',
  'itemscope',
  'itemtype',
  'nonce',
  'part',
  'popover',
  'exportparts',
])

/**
 * Vue/DOM-global prop names no manifest is expected to declare. Mirrors the
 * platform-prop filtering `ComponentManifestSource` adapters are required to
 * apply (see the doc comment on that interface in `../core/manifest.ts`) —
 * kept as a local literal set because no such filter is reachable as an
 * importable constant today (it's baked into each adapter's extraction, not
 * exposed). If that changes, prefer importing the real filter over this
 * fallback so the two can't drift apart.
 *
 * Also excludes `data-*`/`aria-*` (open-ended families, not enumerable) and
 * the standard HTML global attributes in {@link GLOBAL_HTML_ATTRS} — see
 * that constant's doc comment for why these are load-bearing, not cosmetic.
 */
function isPlatformProp(name: string): boolean {
  if (name === 'class' || name === 'style' || name === 'key' || name === 'ref') return true
  if (/^on[A-Z]/.test(name)) return true
  const lower = name.toLowerCase()
  if (lower.startsWith('data-') || lower.startsWith('aria-')) return true
  return GLOBAL_HTML_ATTRS.has(lower)
}

export interface DetectDriftArgs {
  context: AttributionContext
  result: AttributionResult
  /** null ⇒ unknown-component candidate. */
  owningManifest: ComponentManifest | null
}

/**
 * Run every drift rule over one `attribute()` call's inputs/outputs.
 * Returns zero or more signals — the rules are independent (a single click
 * can, in principle, surface both an `unknown-props` and a `hint-miss`
 * signal for the same owning component).
 */
export function detectDrift(args: DetectDriftArgs): DriftSignal[] {
  const chain = args.context.componentChain
  // No owning component identified at all (plain DOM / unresolvable click)
  // — there's nothing to report drift ABOUT. Every rule below needs an
  // owning chain entry, so bail out up front rather than threading an
  // undefined-entry check through each one.
  if (chain.length === 0) return []
  const owning = chain[0]

  const signals: DriftSignal[] = []
  const hintMiss = detectHintMiss(args, owning)
  if (hintMiss) signals.push(hintMiss)
  const selectorAmbiguous = detectSelectorAmbiguous(args, owning)
  if (selectorAmbiguous) signals.push(selectorAmbiguous)
  const unknownComponent = detectUnknownComponent(args, owning)
  if (unknownComponent) signals.push(unknownComponent)
  const unknownProps = detectUnknownProps(args, owning)
  if (unknownProps) signals.push(unknownProps)
  return signals
}

function detectHintMiss(
  { context, result, owningManifest }: DetectDriftArgs,
  owning: ComponentChainEntry,
): DriftSignal | null {
  if (result.kind !== 'refuse') return null
  if (!owningManifest) return null

  // Reuse attribute()'s own trust gate: an all-untrusted (or absent)
  // rendering set behaves EXACTLY like no hints at all, per isTrustedHint's
  // doc comment — so this closes out the no-hints-authored exclusion.
  const trustedRendering = owningManifest.rendering?.filter(isTrustedHint) ?? []
  if (trustedRendering.length === 0) return null

  // Reuse attribute()'s own Step-1 matcher. If it found a hit, the refuse
  // MUST have come from further downstream (an `uneditable` hint,
  // unmanifested-parent chain break, or prop-not-set-at-call-site) — all
  // three are excluded by definition, and this single check closes out all
  // of them at once without needing to distinguish which one occurred.
  const domHit = findDomHit(trustedRendering, context.clickedElement)
  if (domHit) return null

  // The runtime chain's `importPath` is Vite-dev-only (it comes off the
  // component's stripped-at-build `__file`), so it's routinely absent for
  // pre-compiled library components — Acme DS is exactly this shape.
  // Fall back to the manifest's `importPath`: it was already resolved FOR
  // this owning component by the manifest lookup the call site did before
  // invoking `detectDrift`, so it's the best available package identity for
  // server-side auto-repair, which requires one. Without this, the most
  // common library shape logs a signal that immediately fails repair with
  // "no importPath."
  const importPath = importPathFor(owning, owningManifest)

  return {
    kind: 'hint-miss',
    component: owning.name,
    ...(importPath !== undefined ? { importPath } : {}),
    designSystem: owningManifest.designSystem,
    detail: context.clickedElement.selectorWithinMountRoot,
    at: new Date().toISOString(),
  }
}

/**
 * `owning.importPath` when the runtime chain entry has one, else the owning
 * manifest's `importPath`. See the `hint-miss` call site above for why the
 * fallback exists: runtime `__file` (which the chain's `importPath` derives
 * from) is stripped for pre-compiled libraries, but the manifest lookup
 * already resolved an identity for this exact component, so it's the best
 * available fallback rather than leaving repair permanently unreachable.
 */
function importPathFor(owning: ComponentChainEntry, owningManifest: ComponentManifest): string | undefined {
  return owning.importPath ?? owningManifest.importPath
}

/**
 * Structural mirror of `attribute()`'s Phase 5 Task 3 ambiguity check: a
 * trusted dom hit matched the clicked element's selector, but the bridge's
 * click-time uniqueness query found more than one element in the mount
 * root answering to it. Fires independently of `result.kind` — `attribute()`
 * downgrades this case to a `refuse`, but the drift signal is about the
 * grounding-data mismatch itself, not about what `attribute()` decided to
 * do with it.
 */
function detectSelectorAmbiguous(
  { context, owningManifest }: DetectDriftArgs,
  owning: ComponentChainEntry,
): DriftSignal | null {
  if (context.clickedElement.soleMatchWithinMountRoot !== false) return null
  if (!owningManifest) return null

  const trustedRendering = owningManifest.rendering?.filter(isTrustedHint) ?? []
  if (trustedRendering.length === 0) return null

  const domHit = findDomHit(trustedRendering, context.clickedElement)
  if (!domHit) return null

  return {
    kind: 'selector-ambiguous',
    component: owning.name,
    ...(owning.importPath !== undefined ? { importPath: owning.importPath } : {}),
    designSystem: owningManifest.designSystem,
    detail: context.clickedElement.selectorWithinMountRoot,
    at: new Date().toISOString(),
  }
}

/**
 * Extension suffixes that mark an `importPath` as a SOURCE FILE, never a
 * package specifier — a component/module file the bridge could plausibly
 * report via `readImportPath`'s file-path branch (see that function's doc
 * comment in `src/bridge/build-attribution-context.ts`). Checked case-
 * insensitively since the values here are file-path strings, not npm
 * specifiers (which are always lowercase by registry convention, so casing
 * for THOSE is a non-issue).
 */
const SOURCE_FILE_EXTENSIONS = /\.(vue|tsx|jsx|ts|js)$/i

/**
 * Is `importPath` evidence of a LIBRARY package (drift-repair-able), as
 * opposed to a first-party source file path?
 *
 * `readImportPath` (`src/bridge/build-attribution-context.ts`) returns two
 * different SHAPES under one field name: for a `node_modules` instance it
 * extracts the real package specifier (`@acme/design-system`); for anything
 * else — first-party, non-`node_modules` — it returns the component's own
 * source file path VERBATIM (e.g. `src/components/Foo.vue`, or even a bare
 * `form.vue`), because that's genuinely the most useful identity a local
 * component has. `detectUnknownComponent` used to treat "`importPath` is
 * present" as "this is a library," which meant a local component simply
 * missing from the manifest (importPath = its own source file) satisfied
 * the same branch and got mis-reported as an unknown THIRD-PARTY library —
 * the drift panel then offered "Add design system" for a file like
 * `src/components/Foo.vue`, which is nonsensical.
 *
 * A package specifier is never a relative path (`./…`), never an absolute
 * POSIX path (`/…`), never a Windows drive-letter path (`C:\…` / `C:/…`),
 * and never ends in a component/source-file extension — real npm
 * specifiers (bare, scoped, or scoped-with-subpath: `lodash`,
 * `@acme/design-system`, `@acme/ui/components`) satisfy all three. Anything
 * that looks like a file path on disk fails at least one of them.
 */
function looksLikePackageSpecifier(importPath: string): boolean {
  if (importPath.startsWith('.') || importPath.startsWith('/')) return false
  if (/^[A-Za-z]:[\\/]/.test(importPath)) return false
  if (SOURCE_FILE_EXTENSIONS.test(importPath)) return false
  return true
}

function detectUnknownComponent(
  { owningManifest }: DetectDriftArgs,
  owning: ComponentChainEntry,
): DriftSignal | null {
  if (owningManifest !== null) return null

  // Conservative gate: require PACKAGE EVIDENCE, not merely the absence of
  // a call site. The old gate also fired when `consumerSourceLoc` was
  // undefined, reasoning that "no call site" meant "library-internal
  // render" — but a first-party ROOT component (e.g. `src/App.vue`)
  // legitimately has no consumerSourceLoc either (nothing in the prototype
  // calls it), and its own `importPath` — when the chain even has one — is
  // a file path, not a package specifier. That branch misfired on every
  // undocumented root, reporting ordinary app code as an unknown LIBRARY
  // and offering "Add design system" for it. `looksLikePackageSpecifier`
  // is the only signal that actually distinguishes "library we don't have
  // a manifest for" from "first-party code, including its root" — and it's
  // also the only signal that's ACTIONABLE: auto-repair needs a package
  // identity to re-extract from, and "Add design system" needs a package
  // name to attach, so a component with no package-specifier importPath at
  // all offers neither consumer anything to act on. Emit nothing for it.
  if (owning.importPath === undefined || !looksLikePackageSpecifier(owning.importPath)) return null

  return {
    kind: 'unknown-component',
    component: owning.name,
    ...(owning.importPath !== undefined ? { importPath: owning.importPath } : {}),
    at: new Date().toISOString(),
  }
}

function detectUnknownProps(
  { owningManifest }: DetectDriftArgs,
  owning: ComponentChainEntry,
): DriftSignal | null {
  if (!owningManifest) return null
  const consumerProps = owning.consumerVnodeProps
  if (!consumerProps) return null

  const manifestPropNames = new Set(owningManifest.props.map((p) => p.name))
  const unknownNames = Object.keys(consumerProps)
    .filter((name) => !manifestPropNames.has(name) && !isPlatformProp(name))
    .sort()
  if (unknownNames.length === 0) return null

  // See `importPathFor`'s doc comment (used by `detectHintMiss` above) —
  // same fallback, same reason: runtime `__file` is absent for pre-compiled
  // library components, so the manifest's `importPath` is the best
  // available identity for auto-repair.
  const importPath = importPathFor(owning, owningManifest)

  return {
    kind: 'unknown-props',
    component: owning.name,
    ...(importPath !== undefined ? { importPath } : {}),
    designSystem: owningManifest.designSystem,
    detail: unknownNames.slice(0, 5).join(', '),
    at: new Date().toISOString(),
  }
}

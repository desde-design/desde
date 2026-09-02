/**
 * Substrate style capabilities — neutral facts about how the prototype's own CSS
 * competes with the rules Editor writes.
 *
 * Framework- and design-system-NEUTRAL by contract (this is `core/`): the facts
 * are stated in terms of the CSS cascade, never in terms of a particular
 * utility framework. The detectors that produce them are substrate-specific and
 * live behind the adapter seam (`src/editor/adapters/tailwind/` today), and
 * the neutral composition entry is
 * `src/editor/onboarding/detect-style-capabilities.ts`.
 *
 * Why this exists: Editor's element-scope style edit emits an **unlayered**
 * `[data-desde-src="…"] { prop: value !important }` rule (Vue) or a plain inline
 * declaration (React inline lane). Under the corrected `!important` cascade-layer
 * model (see `tasks/editor-edit-verification.md` § "Cascade oracle"),
 * unlayered-important is the WEAKEST important tier — so on a substrate whose
 * utility CSS is itself compiled `!important`, that edit can never win a property
 * a utility declares. Verification then honestly reports `css-overridden` on
 * every such edit, which is correct but a miserable loop for the user. Knowing
 * this about the substrate lets the UI steer to a scope that can win instead.
 */

export interface SubstrateStyleCapabilities {
  /**
   * True when the substrate's utility/framework CSS is compiled with
   * `!important` on every declaration, so a declaration Editor adds at the
   * element scope competes at the same-or-weaker important tier and generally
   * loses.
   *
   * Deliberately conservative: this is `false` whenever detection can't tell
   * (unreadable files, unrecognized config shape, unsupported substrate) —
   * a false positive would needlessly deprioritise a scope that works.
   */
  importantUtilities: boolean
}

/**
 * The fail-safe value: every capability off, i.e. "behave exactly as before any
 * of this existed". Returned whenever detection is unavailable or throws.
 */
export const NO_SUBSTRATE_STYLE_CAPABILITIES: SubstrateStyleCapabilities = {
  importantUtilities: false,
}

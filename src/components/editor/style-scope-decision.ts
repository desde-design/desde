/**
 * Scope-decision core for the inspector's style scope dialog — Phase 2 of
 * tasks/inspector-style-provenance.md, provenance-gated variant.
 *
 * Pure logic over a {@link StyleOrigin} (the provenance Phase 1 produces):
 * decides whether a style edit is scope-AMBIGUOUS enough to prompt, and which
 * scopes are offered. Keeping the common case (a plain consumer-authored rule)
 * dialog-free matches the codebase's deterministic-first / don't-interrupt
 * philosophy; we only ask where "what do you even mean?" is a real question.
 *
 * No React, no I/O — unit-tested against fixture origins.
 */
import type { StyleOrigin, StyleStylesheetRef } from "@/types/bridge"
import { wouldLoseToImportant } from "@/editor/verification"

/** Where a style edit can be applied. */
export type StyleScope = "element" | "page" | "token" | "component"

/**
 * A stylesheet is "library" (un-editable from the prototype) when its href
 * resolved to a `node_modules/<pkg>` — provenance records that as `package`.
 * First-party stylesheets (the prototype's own CSS, a `<style>` block) carry
 * no package.
 */
export function isLibraryStylesheet(ref: StyleStylesheetRef): boolean {
  return ref.package !== undefined
}

/**
 * Whether an edit to `property` on this origin should open the scope dialog
 * rather than apply directly. Ambiguous when the rendered value is:
 *  - **token-driven** (`varChain`) — patch the token, or just override here?
 *  - **inherited** from an ancestor — a local class-splice mis-targets;
 *  - **library-rendered** (winning rule in node_modules) — a consumer class
 *    edit silently no-ops (the `(none)` trap);
 *  - **un-attributable** (no winning rule + no inline, but something renders) —
 *    same library/UA-default ambiguity. Includes the transient-only case (only a
 *    `:hover`/`:focus` rule declares the property, so nothing does at rest): the
 *    trigger is the same, but `scopeDialogReasonEntries` explains it differently
 *    — see the `transient-only` reason.
 *
 * A plain consumer rule (or an existing inline override) with none of the above
 * is the obvious "this element" intent → apply directly, no prompt.
 */
export function needsScopeDialog(origin: StyleOrigin): boolean {
  if (origin.varChain.length > 0) return true
  if (origin.inherited) return true
  if (origin.winningRule && isLibraryStylesheet(origin.winningRule.stylesheet)) {
    return true
  }
  if (!origin.winningRule && !origin.inline && origin.computedValue) return true
  // An `!important` incumbent is the one case our own override — which always
  // emits `!important` (apply-scoped-css-override-edit.ts) — may still lose.
  // Predictable enough to ask rather than write a doomed rule.
  if (wouldLoseToImportant(origin)) return true
  return false
}

/** Which `needsScopeDialog` trigger a reason line came from. */
export type ScopeReasonKind =
  | "token"
  | "inherited"
  | "library"
  | "no-rule"
  /** The `no-rule` trigger, refined: a transient-state rule IS declaring it. */
  | "transient-only"
  | "important"
  | "outranked"

export interface ScopeReason {
  kind: ScopeReasonKind
  text: string
}

/**
 * Substrate facts that sharpen the reason lines. Separate from the origin
 * because they describe the PROJECT, not this property: the origin says what
 * currently wins, this says what CAN win here at all.
 */
export interface ScopeReasonOptions {
  /**
   * See {@link ScopeAvailabilityOptions.elementScopeOutranked}. When set, the
   * generic `!important` line is replaced by the sharper `outranked` line — the
   * two would otherwise say the same thing, one of them vaguely.
   */
  elementScopeOutranked?: boolean
}

/**
 * The `outranked` line. States the SUBSTRATE fact and its consequence without
 * naming a specific alternative scope: the same line is reused by
 * {@link singleScopeWarning}, where "patch the token" would propose something
 * the user can't pick.
 */
const OUTRANKED_REASON =
  // Same fix: name the options rather than describing a class of them.
  'This project marks its utility CSS !important, so a change on just this element will be ignored and the old value keeps showing. Choose "This page" or "The token" instead.'


/**
 * Why this origin is scope-ambiguous, tagged by trigger. Mirrors
 * `needsScopeDialog`'s triggers one-for-one; empty when it returns false. The
 * tag lets a caller drop lines that don't apply to the scopes it can actually
 * offer (see {@link singleScopeWarning}) instead of showing the user a remedy
 * that isn't on the menu.
 *
 * One line is substrate-driven rather than origin-driven: with
 * `opts.elementScopeOutranked`, the generic `important` line becomes the sharper
 * `outranked` line. It stays inside the `wouldLoseToImportant` trigger — the
 * capability alone is not a claim about THIS property (a property no utility
 * declares is still winnable at the element scope), so the mirror with
 * `needsScopeDialog` is preserved and the line never over-claims.
 */
export function scopeDialogReasonEntries(
  origin: StyleOrigin,
  opts: ScopeReasonOptions = {},
): ScopeReason[] {
  const reasons: ScopeReason[] = []
  const root = origin.varChain[origin.varChain.length - 1]
  if (root) {
    reasons.push({
      kind: "token",
      text: `This value comes from the design token ${root.name}. Patching the token updates every use; overriding here affects only this element.`,
    })
  }
  if (origin.inherited) {
    reasons.push({
      kind: "inherited",
      text: "This value is inherited from an ancestor, so a local override may target the wrong element.",
    })
  }
  if (origin.winningRule && isLibraryStylesheet(origin.winningRule.stylesheet)) {
    reasons.push({
      kind: "library",
      text: `This value is set by ${origin.winningRule.selector}, a rule inside ${origin.winningRule.stylesheet.package} rather than your project, so it can't be changed where it's written.`,
    })
  }
  if (!origin.winningRule && !origin.inline && origin.computedValue) {
    // Same trigger, two truths. When a transient-state rule currently applies,
    // SOMETHING does declare the property — just not at rest — so the generic
    // "browser default or unreadable stylesheet" line is simply false, and it
    // contradicted the `From: only under :hover` row in the same dialog (rec-4
    // N5). Reword rather than suppress: naming the state explains where the value
    // on screen comes from, which is what the user is asking.
    const transient = origin.transientRuleApplies
    reasons.push(
      transient
        ? {
            kind: "transient-only",
            text: `No rule declares this property at rest: the value on screen comes from the ${transient.pseudoClass} rule that currently applies.`,
          }
        : {
            kind: "no-rule",
            text: "No stylesheet rule declares this property: the value comes from a browser default or an unreadable stylesheet.",
          },
    )
  }
  if (wouldLoseToImportant(origin)) {
    reasons.push(
      opts.elementScopeOutranked
        ? { kind: "outranked", text: OUTRANKED_REASON }
        : {
            kind: "important",
            // "A broader scope" named nothing the reader can point at (Mo,
            // 2026-08-18). The dialog's own options are "This element", "This
            // page" and "The token", so the advice names two of them.
            text: 'The current value is set with !important, so a change on just this element may be ignored. Choosing "This page" or "The token" is more likely to work.',
          },
    )
  }
  return reasons
}

/**
 * Why this origin is scope-ambiguous, as user-facing lines for the dialog.
 * Kept pure and separate so the dialog can explain the prompt instead of just
 * presenting options.
 */
export function scopeDialogReasons(
  origin: StyleOrigin,
  opts: ScopeReasonOptions = {},
): string[] {
  return scopeDialogReasonEntries(origin, opts).map((r) => r.text)
}

/**
 * **Dialog-worthy ≠ warning-worthy.** The set of reasons that justify "we should
 * ask you where to put this" is NOT the set that justifies "this might not work"
 * — conflating the two produced a live false alarm (cascade follow-ups, final
 * live report §3-B): four Background edits on a transparent element all worked,
 * and all four toasted *"This may not take effect — no stylesheet rule declares
 * this property…"*. A property no rule declares is the EASIEST case for a local
 * override to win; there is nothing to outrank.
 *
 * A reason is warning-worthy only if it describes a way the edit can **fail to
 * take effect** — i.e. a declaration our override cannot outrank already wins.
 * Per-reason judgement:
 *
 * | reason | warning-worthy | why |
 * | --- | --- | --- |
 * | `token` | no | Patching the token vs overriding locally is a CHOICE; the local override still wins. |
 * | `inherited` | no | Any declaration on the element itself beats an inherited value — including an ancestor's `!important` one. |
 * | `library` | no | Our element override is an unlayered `!important` `[data-desde-src]` rule (`apply-scoped-css-override-edit.ts`), which outranks an ordinary-weight `node_modules` rule. An `!important` library rule is a different reason (`important`) and IS warned. |
 * | `no-rule` | no | Nothing declares the property, so nothing can outrank us. The observed false alarm. |
 * | `transient-only` | no | Our rule applies at rest, so the edit lands. It also overrides the `:hover` rule — a side effect worth explaining in the DIALOG, not a claim the edit may not work. |
 * | `important` | **yes** | An `!important` incumbent is the one thing our own `!important` override can genuinely lose to. |
 * | `outranked` | **yes** | Substrate fact: this project's utility CSS is compiled `!important`, so an element-scope rule is the weakest important tier. |
 *
 * Suppressing `library` knowingly gives up one speculative catch (a
 * higher-specificity library rule beating a React+Tailwind className splice —
 * the one element lane that does not emit `!important`). That is the right trade,
 * and it is not a blind spot: the post-hoc cascade verifier
 * (`src/editor/verification/cascade-outcome.ts`, surfaced by the Checks strip
 * and the failure toast) MEASURES the real winner after the edit lands and names
 * it. A measured failure beats a guessed one — and a false alarm is worse than no
 * signal, because it teaches the user to ignore the one warning that matters.
 */
const WARNING_WORTHY_REASONS: ReadonlySet<ScopeReasonKind> = new Set<ScopeReasonKind>([
  "important",
  "outranked",
])

/** Whether this reason kind describes a way the edit can fail to take effect. */
export function isWarningWorthyReason(kind: ScopeReasonKind): boolean {
  return WARNING_WORTHY_REASONS.has(kind)
}

/**
 * Scopes whose write is an OVERRIDE that has to outrank whatever currently wins
 * (an `!important` `[data-desde-src]` rule, a scoped `<style>` block, a className
 * splice) — as opposed to editing the winning declaration itself, where an
 * `!important` incumbent is our own flag and cannot be lost to.
 */
const OVERRIDE_SCOPES: ReadonlySet<StyleScope> = new Set<StyleScope>(["element", "page"])

/**
 * The one line to show when an origin is ambiguous but there is only ONE scope
 * to apply at (a one-option dialog is noise). Returns **null** when nothing
 * warning-worthy applies — the edit will simply work, and silently applying a
 * working edit is the correct behaviour. See {@link WARNING_WORTHY_REASONS} for
 * the per-reason judgement.
 *
 * Two applicability filters survive from final-review M11, both now expressed
 * against the warning-worthy subset:
 *  - the reason must be warning-worthy at all (the new split);
 *  - both `!important` lines describe the rule that currently WINS, which on an
 *    INHERITED origin is an ancestor's rule rather than this element's — so they
 *    only apply when something on the element itself carries the flag.
 *
 * `enabled` still matters: an `!important` incumbent is only a loss risk for a
 * scope that writes an override (see {@link OVERRIDE_SCOPES}). Editing the token
 * or the component's own declaration changes the winning rule in place.
 */
export function singleScopeWarning(
  origin: StyleOrigin,
  enabled: readonly StyleScope[],
  opts: ScopeReasonOptions = {},
): string | null {
  if (!enabled.some((scope) => OVERRIDE_SCOPES.has(scope))) return null
  const applicable = scopeDialogReasonEntries(origin, opts).filter((reason) => {
    if (!isWarningWorthyReason(reason.kind)) return false
    return !origin.inherited || !!origin.inline?.important
  })
  return applicable[0]?.text ?? null
}

/**
 * Drop the live-preview's own inline declaration from an origin before it feeds
 * a pre-flight decision (final-review I5, residual-review R1, cascade
 * follow-ups Phase 2).
 *
 * Editor's class/style preview stamps its resolved declarations inline with
 * `!important` (`src/bridge/override-preview.ts` `applyClassOverride`), and the
 * inspector re-reads provenance right after dispatching an edit — so from the
 * SECOND edit of the same property onward the provenance we read back honestly
 * reports OUR OWN shim. Feeding that to `needsScopeDialog` /
 * `wouldLoseToImportant` makes every follow-up swatch click look like it is
 * fighting an `!important` incumbent, interrupting the core iterate-on-a-colour
 * loop with a scope dialog or a warning toast.
 *
 * **Keyed on the bridge's own claim, `inline.fromPreview`.** The preview layer
 * records the properties it stamped, on the same `ClassOverrideSnapshot` that
 * holds the inline-style backup, and only when the engine actually ACCEPTED the
 * declaration (`src/bridge/override-preview.ts`); the walker surfaces that as
 * `StyleOrigin.inline.fromPreview` (`src/bridge/style-provenance.ts`). So the
 * question "is this declaration ours?" is answered by the layer that would know,
 * per property, per element, in lockstep with the style it describes.
 *
 * Two earlier cuts of this helper are worth not re-inventing:
 *  - comparing the inline VALUE against the value we previewed was inert for the
 *    dominant case — the shell previews colours as hex (`#ef4444`), CSSOM hands
 *    them back serialized (`rgb(239, 68, 68)`), so every colour edit still
 *    prompted while lengths looked fixed;
 *  - keying on the previewed PROPERTY NAMES fixed that but over-claimed in one
 *    direction: an author's own inline `!important` on a property the user had
 *    previewed earlier on this element was discounted too, so the gate went
 *    silent exactly where it should have warned. `fromPreview` is the exact
 *    signal, so that residue is closed rather than traded.
 *
 * Back-compat by construction: an origin with no `inline`, or an `inline` without
 * the flag (an older bridge, or an authored declaration), is returned untouched —
 * only `fromPreview === true` is a positive claim. Note the flag already implies
 * `!important` in practice (our shim always stamps with it), so no separate
 * priority check is needed; a declaration the shim did not stamp is never ours
 * regardless of its priority.
 *
 * Pure — the predicates stay unaware of preview state, and the exclusion stays
 * at the call site.
 */
export function excludePreviewInline(origin: StyleOrigin): StyleOrigin {
  if (origin.inline?.fromPreview !== true) return origin
  const withoutInline: StyleOrigin = { ...origin }
  delete withoutInline.inline
  return withoutInline
}

export interface ScopeAvailabilityOptions {
  /**
   * Whether the element has a stable selector reachable from its SFC root, so
   * a scoped `<style>` block can target it ("This page"). The inspector knows
   * this from the bridge-generated selector; default true (selectors are
   * bridge-generated and stable by construction).
   */
  hasStableSelector?: boolean
  /**
   * Substrate framework. Kept for callers that still pass it, but it no longer
   * gates anything: the "page" scope used to be Vue-only because it wrote an
   * SFC `<style scoped>` block, and it now writes a project `.css` on
   * substrates that have no such block. What decides availability is
   * {@link hasOverrideDestination} — a fact about the PROJECT, not a fact
   * about React. That substitution is the positioning rule applied: a gate
   * named after a framework is a gate that will be wrong for the next one.
   */
  framework?: "vue3" | "react"
  /**
   * Whether this substrate has somewhere to put a page-scoped rule.
   *
   * Vue always does (every SFC carries a `<style scoped>` block, created on
   * demand). React does when the page loads a first-party writable stylesheet
   * — a fact the caller establishes from `document.styleSheets` via
   * `resolveOverrideStylesheet`, because a rule in a file the app never
   * imports is inert.
   *
   * Defaults to `true`, which is correct for Vue and for any caller that
   * hasn't been taught the question yet: the builder refuses with a specific,
   * actionable message when there is genuinely nowhere to write, and an
   * explained refusal beats a silently missing affordance.
   */
  hasOverrideDestination?: boolean
  /**
   * True when the substrate's own CSS outranks anything the ELEMENT scope can
   * emit, so an override there generally cannot take effect — today: a project
   * whose utility CSS is compiled `!important` (Tailwind global important mode),
   * where Editor's unlayered-`!important` `[data-desde-src]` rule is the weakest
   * important tier. Derived from the boot-detected substrate capability
   * (`EDITOR_ELEMENT_SCOPE_OUTRANKED`, which also carves out the React+Tailwind
   * lane — there the element edit REPLACES the utility rather than layering on
   * top of it, so it is not outranked).
   *
   * Effect: "This element" is DEPRIORITISED — offered last instead of first —
   * and the dialog explains why. Never removed: a user may still deliberately
   * want a local override, and silently dropping an affordance is its own kind of
   * confusing. Defaults to false, which reproduces the historical ordering
   * exactly; a detection failure therefore degrades to today's behavior.
   */
  elementScopeOutranked?: boolean
}

/**
 * Which scopes to offer for this origin, in PRESENTATION ORDER (the dialog
 * renders them as given — the first entry is the preferred choice).
 * "This element" is always available; "The token" / "The component" gate on the
 * relevant source being first-party (editing `node_modules` is refused — you
 * can't write there). "The page" needs a stable selector AND somewhere to
 * write the rule (see opts.hasOverrideDestination) — on Vue that is the SFC's
 * own `<style scoped>` block, on React a project stylesheet the page loads.
 *
 * On a substrate where the element scope is outranked
 * (`opts.elementScopeOutranked`) the element entry moves to the END: it stays
 * available, but it is no longer what the dialog leads with.
 */
export function availableScopes(
  origin: StyleOrigin,
  opts: ScopeAvailabilityOptions = {},
): StyleScope[] {
  const scopes: StyleScope[] = []
  if (!opts.elementScopeOutranked) scopes.push("element")
  // "Page" is no longer Vue-only. It emits a `[data-desde-src="…"]` rule, and
  // where that rule LIVES is the only per-substrate part: an SFC's
  // `<style scoped>` block on Vue, a project stylesheet on React. So the gate
  // is "is there a destination", not "is this React".
  if (
    (opts.hasOverrideDestination ?? true) &&
    (opts.hasStableSelector ?? true)
  ) {
    scopes.push("page")
  }

  // The token is editable only if its ROOT definition (the last hop in the
  // chain — what you'd actually patch) lives in first-party source.
  const rootToken = origin.varChain[origin.varChain.length - 1]
  if (rootToken && !isLibraryStylesheet(rootToken.definedAt.stylesheet)) {
    scopes.push("token")
  }

  // The component scope edits the winning rule's stylesheet; only first-party
  // (locally vendored) component CSS is editable.
  if (origin.winningRule && !isLibraryStylesheet(origin.winningRule.stylesheet)) {
    scopes.push("component")
  }
  // Deprioritised, not removed (see `elementScopeOutranked`): last on the menu.
  if (opts.elementScopeOutranked) scopes.push("element")
  return scopes
}

/**
 * Render verifier (orchestration, DI'd I/O).
 *
 * Runs the deterministic ladder for a captured `EditExpectation`:
 *   L1 (optional) — the literal is present at the source location.
 *   L2 (required) — after HMR settle, the live DOM at the manifest-hinted
 *                   location reflects the value (the key check).
 *
 * All I/O is injected (`readRenderedValue`, optional `readSourceAt`), plus
 * an injectable clock/sleep so the polling loop is deterministic in tests.
 */

import type {
  EditExpectation,
  FailureCause,
  VerificationResult,
} from './types'
import { isLlmFixable } from './types'
import { classifyFailure, hasBindingForm } from './classify-failure'
import type { StyleOrigin } from '@/types/bridge'
import {
  describeCascadeWinner,
  evaluateCascadeVerification,
  type CascadeOutcome,
  type CascadeVerification,
} from './cascade-outcome'

export interface VerifyDeps {
  /**
   * Read the current rendered value off the live DOM via the bridge
   * `READ_RENDERED_VALUE` query. Resolves `null` when the selector matches
   * nothing or the accessor has no value.
   */
  readRenderedValue: (
    selector: string,
    accessor: EditExpectation['accessor'],
  ) => Promise<string | null>
  /**
   * Optional L1 source check: return the source *line* (or a small slice)
   * at the given location. Omit to skip L1 entirely.
   */
  readSourceAt?: (
    targetFile: string,
    sourceLoc: NonNullable<EditExpectation['sourceLoc']>,
  ) => Promise<string | null>
  /** Poll cadence for L2, ms (default 100). */
  pollIntervalMs?: number
  /** L2 budget, ms (default 2500). */
  timeoutMs?: number
  /**
   * Confirm-stable window, ms (default 0 = off). Editor applies an instant
   * live DOM *override* for feedback, then writes source which HMR re-renders.
   * A failing (bound/shadowed) edit shows the expected value via the override
   * *before* HMR reverts it — so a naive "pass on first match" false-passes the
   * very cases we must catch. When set, a matching read must still match after
   * this delay (long enough to outlast HMR) before we accept a pass; a flip
   * after HMR is caught and the loop continues to a correct fail. The wiring
   * layer sets this; the pure tests drive it explicitly.
   */
  confirmStableMs?: number
  /** Injectable monotonic clock (default `Date.now`). */
  now?: () => number
  /** Injectable sleep (default real timer). */
  sleep?: (ms: number) => Promise<void>
  /**
   * Read style provenance off the live DOM via the bridge
   * `GET_STYLE_PROVENANCE` query — the cascade walk that says which rule owns
   * each property. Required for the cascade lane; when absent, a cascade
   * expectation reports `skipped` rather than guessing.
   *
   * Resolving `null` means the READ FAILED (timeout, disposal, unsupported
   * bridge) — distinct from a successful read that found no origin (`{}`), which
   * the bridge returns when the selector matched nothing OR when it matched an
   * element no rule styles. `verifyCascade` reports `null` as `skipped` (a
   * verdict we could not substantiate must never be surfaced as a failure) and
   * disambiguates the empty-map case with one `readRenderedValue` probe.
   */
  readStyleProvenance?: (
    selector: string,
    properties: readonly string[],
  ) => Promise<Record<string, StyleOrigin> | null>
}

/** Collapse runs of whitespace and trim — DOM text vs literal comparison. */
function normalize(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function verifyRender(
  expectation: EditExpectation,
  deps: VerifyDeps,
): Promise<VerificationResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const pollInterval = deps.pollIntervalMs ?? 100
  const timeout = deps.timeoutMs ?? 2500
  const start = now()
  const expectedNorm = normalize(expectation.expectedValue)

  const done = (
    partial: Omit<VerificationResult, 'editId' | 'durationMs' | 'expectedValue'>,
  ): VerificationResult => ({
    editId: expectation.editId,
    expectedValue: expectation.expectedValue,
    durationMs: now() - start,
    ...partial,
  })

  if (expectation.cascade) {
    return verifyCascade(expectation, deps, done, now, sleep)
  }

  // Read the source line once if an L1 reader is wired — reused for both the
  // L1 presence check and L2 failure classification.
  let sourceLine: string | null | undefined
  const haveSourceReader =
    !!deps.readSourceAt && !!expectation.sourceLoc && !!expectation.targetFile
  if (haveSourceReader) {
    sourceLine = await deps.readSourceAt!(
      expectation.targetFile!,
      expectation.sourceLoc!,
    )

    // — L1: literal present at the source location —
    if (sourceLine != null && normalize(sourceLine).length > 0) {
      const present = sourceLine.includes(expectation.expectedValue)
      const propName =
        expectation.accessor.kind === 'attr' ? expectation.accessor.name : undefined
      if (!present && !hasBindingForm(sourceLine, propName)) {
        // Literal absent AND no binding form on the line → the splice
        // mis-targeted (or didn't land). Escalation can't fix a wrong-location
        // write, so this is a hard, non-escalatable fail.
        return done({
          status: 'fail',
          failedAt: 'L1',
          escalatable: false,
          observedValue: null,
          detail: `Literal not found in source at ${expectation.targetFile}:${expectation.sourceLoc!.line}. The write may have mis-targeted.`,
        })
      }
      // Literal absent BUT a binding form is present → the value is bound
      // (`:prop` / v-model / dynamic v-bind). That's the escalatable L2 case,
      // not a mis-target: fall through to L2, which will fail and classify it.
    }
  }

  // — L2: poll the live DOM until it reflects the value or we time out —
  const confirmStable = deps.confirmStableMs ?? 0
  let observed: string | null = null
  let polledOnce = false
  while (now() - start < timeout || !polledOnce) {
    polledOnce = true
    observed = await deps.readRenderedValue(
      expectation.selector,
      expectation.accessor,
    )
    if (normalize(observed) === expectedNorm) {
      // Defeat the live-override false-pass: re-read after a window that
      // outlasts HMR. If the value flips (HMR reverted an override), this is
      // a real failure — keep `recheck` as the new observation and continue.
      if (confirmStable > 0) {
        await sleep(confirmStable)
        const recheck = await deps.readRenderedValue(
          expectation.selector,
          expectation.accessor,
        )
        if (normalize(recheck) !== expectedNorm) {
          observed = recheck
          if (now() - start >= timeout) break
          await sleep(pollInterval)
          continue
        }
        observed = recheck
      }
      return done({
        status: 'pass',
        escalatable: false,
        observedValue: observed,
        detail: `Verified: ${expectation.label} rendered.`,
      })
    }
    if (now() - start >= timeout) break
    await sleep(pollInterval)
  }

  // L2 failed — classify and decide escalation.
  const { cause, escalatable } = classifyFailure({
    sourceLine: sourceLine ?? null,
    propName: expectation.accessor.kind === 'attr' ? expectation.accessor.name : undefined,
    observedValue: observed,
    expectedValue: expectation.expectedValue,
  })
  return done({
    status: 'fail',
    failedAt: 'L2',
    cause,
    escalatable,
    observedValue: observed,
    detail: describeFailure(expectation, observed, cause, escalatable),
  })
}

/**
 * L2 for style/token edits: poll until the rule this edit wrote owns EVERY
 * property the edit set, or the budget runs out. Ownership — not computed-value
 * equality — is the oracle here; see `cascade-outcome.ts` for why.
 *
 * **Every property, not one representative** (Phase 2). A style edit routinely
 * sets several declarations (`border` → `border-style` + `border-width`; `p-4` →
 * four padding longhands after expansion), and a per-property competitor splits
 * the verdict even on the Vue `pt-src` lane, where our rule is a single block:
 * an element carrying `style="border-width: 0 !important"` beats us on that one
 * property while we win the other. So a pass requires all of them, and a failure
 * names which property lost and to whom. One provenance round-trip covers the
 * whole set (`readStyleProvenance` already takes an array), and the whole thing
 * collapses into ONE `VerificationResult` — one Checks record, at most one toast.
 *
 * Ownership is not sufficient on its own for a REPEAT edit of a property our
 * rule already owned (red → blue leaves ownership unchanged), so each property
 * carries its own `expectedDeclarationValue` where the comparison is sound; our
 * declaration owning the property while still carrying the old value polls on
 * (HMR legitimately takes time) and, if the budget expires, fails as `hmr-stale`
 * rather than `css-overridden`.
 *
 * A won cascade on an invisible element is still reported as a failure with
 * cause `css-hidden`: the rule applied, but the user's "it didn't work" is
 * about what they can see, and naming invisibility is the useful answer.
 */
async function verifyCascade(
  expectation: EditExpectation,
  deps: VerifyDeps,
  done: (
    partial: Omit<VerificationResult, 'editId' | 'durationMs' | 'expectedValue'>,
  ) => VerificationResult,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<VerificationResult> {
  const cascade = expectation.cascade!
  if (!deps.readStyleProvenance) {
    return done({
      status: 'skipped',
      escalatable: false,
      detail: 'Verification skipped: no style provenance reader is wired.',
    })
  }
  const properties = cascade.properties.map((p) => p.property)
  if (properties.length === 0) {
    // Nothing to check is not a failure — we never claim what we can't verify.
    return done({
      status: 'skipped',
      escalatable: false,
      detail: 'Verification skipped: the edit set no CSS property we can verify.',
    })
  }
  const pollInterval = deps.pollIntervalMs ?? 100
  const timeout = deps.timeoutMs ?? 2500
  const start = now()

  let verification: CascadeVerification = evaluateCascadeVerification(
    undefined,
    cascade,
  )
  let origins: Readonly<Record<string, StyleOrigin>> = {}
  let polledOnce = false
  while (now() - start < timeout || !polledOnce) {
    polledOnce = true
    const read = await deps.readStyleProvenance(expectation.selector, properties)
    // `null` = the read FAILED, so we know nothing (final-review I3). Report
    // `skipped`, never a failure — the binding constraint is that a verdict we
    // cannot substantiate is not a verdict. Causes: a timeout, a disposed
    // target, an old bridge. (A class edit invalidating its own class-based
    // selector does NOT land here — the bridge answers that gracefully with an
    // empty map; see the successful-but-empty probe after the loop.)
    if (read === null) {
      return done({
        status: 'skipped',
        escalatable: false,
        detail: `Verification skipped: could not read style provenance for ${expectation.selector}.`,
      })
    }
    origins = read
    verification = evaluateCascadeVerification(origins, cascade)
    if (verification.won) break
    if (now() - start >= timeout) break
    await sleep(pollInterval)
  }

  if (verification.won) {
    // Report the representative property's computed value — the accessor's
    // property, when it is in the verified set, else the first one.
    const observed = observedComputedValue(origins, expectation, properties)
    // The rule applied — but check the user can actually see it.
    if (await isVisuallyHidden(expectation.selector, deps)) {
      const { cause, escalatable } = classifyFailure({
        sourceLine: null,
        observedValue: observed,
        expectedValue: expectation.expectedValue,
        hidden: true,
      })
      return done({
        status: 'fail',
        failedAt: 'L2',
        cause,
        escalatable,
        observedValue: observed,
        detail: `${expectation.label} applied and wins the cascade, but the element isn't visible (display/visibility): nothing changes on screen.`,
      })
    }
    return done({
      status: 'pass',
      escalatable: false,
      observedValue: observed,
      detail:
        properties.length > 1
          ? `Verified: ${expectation.label} wins the cascade (all ${properties.length} properties it sets).`
          : `Verified: ${expectation.label} wins the cascade.`,
    })
  }

  // A SUCCESSFUL read that produced no origin for ANY property is ambiguous
  // (residual-review R2), and the two readings need opposite verdicts:
  //  - the selector no longer matches any element — the realistic case a class
  //    edit produces, since the bridge builds class-based selectors
  //    (`selector-engine.ts`) and `div.bg-white` stops matching the moment the
  //    background class is swapped. The bridge answers that gracefully with an
  //    empty map, so it never reaches the `null` branch above. We cannot
  //    substantiate a failure against an element we can't find → `skipped`.
  //  - the element IS there and genuinely has no rule declaring the property —
  //    a real "the edit didn't land anywhere" signal → keep `fail` /
  //    `selector-missing`.
  // One extra probe distinguishes them, on the already-injected value reader:
  // `null` means nothing matched the selector. The probe is gated on the WHOLE
  // set being absent: any single origin proves the selector matched, so a
  // per-property miss is a real signal, not a missing element. It runs only on
  // that path and only after the poll loop, so the happy path is unchanged and
  // (verification being purely diagnostic) nothing is gated either way.
  const failing = verification.failing!
  // NOT MEASURABLE — editor's own live-preview declaration still occupies the
  // property this owner's evidence lives in (only the `inline` owner can produce
  // this; for a stylesheet owner the evaluator skips the shim outright). Absent
  // evidence is never a failure: report `skipped`. Reaching here means the shim
  // outlived the whole poll window, which the release-then-verify sequencing is
  // supposed to prevent — so the detail says so plainly rather than blaming the
  // cascade or HMR.
  if (failing.outcome.reason === 'preview-shim') {
    return done({
      status: 'skipped',
      escalatable: false,
      detail: `Verification skipped: editor's live preview is still applied to ${failing.property} on ${expectation.selector}, so cascade ownership can't be measured.`,
    })
  }
  if (properties.every((p) => origins[p] === undefined)) {
    const probe = await readStyleValue(expectation.selector, failing.property, deps)
    if (probe === null) {
      return done({
        status: 'skipped',
        escalatable: false,
        detail: `Verification skipped: no element matches ${expectation.selector} anymore (the edit may have changed the classes its selector was built from).`,
      })
    }
  }

  const observed = origins[failing.property]?.computedValue ?? null
  const { cause, escalatable } = classifyFailure({
    sourceLine: null,
    observedValue: observed,
    expectedValue: expectation.expectedValue,
    cascadeOutcome: failing.outcome,
  })
  const detail = describeCascadeFailure(
    expectation,
    failing.property,
    failing.outcome,
    verification,
  )
  return done({
    status: 'fail',
    failedAt: 'L2',
    cause,
    escalatable,
    observedValue: observed,
    detail,
  })
}

/**
 * The computed value to report on a PASS. Prefers the accessor's property (the
 * label's subject) so the Checks strip shows what the user was editing; falls
 * back to the first verified property, since after shorthand expansion the
 * accessor's property may not itself be in the verified set (`padding` expands
 * away into its longhands).
 */
function observedComputedValue(
  origins: Readonly<Record<string, StyleOrigin>>,
  expectation: EditExpectation,
  properties: readonly string[],
): string | null {
  const named = expectation.accessor.name
  if (named && origins[named]) return origins[named].computedValue ?? null
  return origins[properties[0]]?.computedValue ?? null
}

/**
 * Wording for a lost/stale cascade. The three reasons need three different
 * remedies, and getting them mixed up is actively misleading advice:
 *  - `overridden`  — someone else owns it → escalate the edit's SCOPE.
 *  - `no-rule`     — nothing declares it at all.
 *  - `stale-value` — OUR rule owns it but still declares the old value. Nobody
 *                    outranked us, so "escalate scope" would be wrong; the honest
 *                    reading is that the new value never reached the browser.
 *
 * `property` is the reported loss (the most actionable one — see
 * `CascadeVerification.failing`); `verification` supplies the partial-application
 * context, which is the difference between "this edit did nothing" and "this edit
 * half-landed" and is exactly what the single-representative-property oracle
 * could not say.
 */
function describeCascadeFailure(
  expectation: EditExpectation,
  property: string,
  outcome: Extract<CascadeOutcome, { won: false }>,
  verification: CascadeVerification,
): string {
  const base =
    outcome.reason === 'no-rule'
      ? `Did not take effect: ${describeCascadeWinner(outcome)} at ${expectation.selector} (${property}).`
      : outcome.reason === 'stale-value'
        ? `Did not take effect: the declaration this edit wrote${
            outcome.winnerSelector ? ` (\`${outcome.winnerSelector}\`)` : ''
          } owns ${property} but still declares the previous value, so the new one never reached the browser (the write may not have landed, or HMR did not apply it).`
        : `Did not take effect: the edit is in source but ${describeCascadeWinner(
            outcome,
          )} wins the cascade for ${property}. Re-apply at a broader scope (the design token, or the stylesheet that declares that rule).`
  return `${base}${describePartialApplication(property, verification)}`
}

/**
 * The multi-property tail: which OTHER properties also lost, and whether the
 * rest of the edit did land. Silent for a single-property edit, so no existing
 * wording changes.
 */
function describePartialApplication(
  reported: string,
  verification: CascadeVerification,
): string {
  if (verification.properties.length < 2) return ''
  const others = verification.lost.filter((p) => p !== reported)
  const alsoLost =
    others.length > 0 ? ` Also did not land: ${others.join(', ')}.` : ''
  const owned = verification.properties.length - verification.lost.length
  const landed =
    owned > 0
      ? ` The other ${owned} propert${owned === 1 ? 'y' : 'ies'} this edit sets did land, so the change is only partly applied.`
      : ''
  return `${alsoLost}${landed}`
}

/**
 * Read one computed style property off the live element via the injected value
 * reader. `null` = the selector matched nothing (or the property has no value).
 * A throwing reader is treated as "present": this probe only ever converts a
 * failure into a `skipped`, and a broken read must not manufacture one.
 */
async function readStyleValue(
  selector: string,
  property: string,
  deps: VerifyDeps,
): Promise<string | null> {
  try {
    return await deps.readRenderedValue(selector, { kind: 'style', name: property })
  } catch {
    return ''
  }
}

/**
 * Whether the element renders no box. Uses the same `READ_RENDERED_VALUE`
 * style accessor the value lane uses, so no new bridge capability is needed.
 * A read failure returns false — we never invent a visibility failure.
 */
async function isVisuallyHidden(selector: string, deps: VerifyDeps): Promise<boolean> {
  try {
    const [display, visibility] = await Promise.all([
      deps.readRenderedValue(selector, { kind: 'style', name: 'display' }),
      deps.readRenderedValue(selector, { kind: 'style', name: 'visibility' }),
    ])
    return display === 'none' || visibility === 'hidden'
  } catch {
    return false
  }
}

/**
 * The "Edit didn't take effect" toast's description.
 *
 * Rewritten 2026-08-18 (Mo, on the sibling copy: "I don't understand what you
 * mean by prop and literal"). It used to read like a test assertion —
 * `Did not take effect — expected "8px", DOM still shows "4px" (value comes
 * from a bound expression)` — three of whose four parts are ours: "DOM", the
 * JSON quoting, and a cause phrased as a fact about the framework rather than
 * about the reader's edit.
 *
 * The shape now answers the four questions in order: what the page shows
 * against what was asked for, why, and what to do. `causeText` is the "why",
 * and every line of it says what it means FOR THE EDIT, not what the compiler
 * did.
 */
function describeFailure(
  expectation: EditExpectation,
  observed: string | null,
  cause: FailureCause,
  escalatable: boolean,
): string {
  const sawText =
    observed === null
      ? `The element isn't on the page any more, so this couldn't be checked.`
      : `It still shows ${observed}, not ${expectation.expectedValue}.`
  /*
   * Each line finishes "…because". They avoid `prop`, `binding`, `literal`,
   * `DOM`, `v-model` and `v-bind` — every one of which is a name for how the
   * framework works, on a message read by someone changing a colour.
   *
   * `unknown` deliberately says nothing rather than "cause undetermined": an
   * empty clause is honest, and a sentence admitting we do not know reads as
   * a fault report on us at the moment the reader wants to move on.
   */
  const causeText: Record<FailureCause, string> = {
    'bound-binding': ' This value is calculated in code, so it has to change where it is calculated.',
    'v-model': ' This value is tied to a form field, so it changes as someone types rather than from here.',
    'dynamic-vbind': ' This value is calculated in code, so it has to change where it is calculated.',
    conditional: ' This element only appears in some states, and it is not in one of them right now.',
    'css-hidden': ' This element is hidden right now, so the change is there but not visible.',
    'css-overridden': ' Another style rule is winning over this one.',
    'hmr-stale': ' The page did not pick up the change. Reloading usually fixes it.',
    'selector-missing': ' The element could not be found on the page.',
    unknown: '',
  }
  // `escalatable` classifies the failure as one chat's LLM lane could plausibly
  // fix — it does not mean anything auto-escalates. There is no automatic
  // direct-manip repair loop (see tasks/editor-edit-verification.md); the
  // user has to ask chat.
  const tail = escalatable ? ' Ask chat to make this change instead.' : ''
  return `${sawText}${causeText[cause]}${tail}`
}

export { isLlmFixable }

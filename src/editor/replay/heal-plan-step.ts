/**
 * Self-heal of a broken screenshot-plan interact step (Phase 4 of
 * editor-screenshot-flows.md) — the CORRECTNESS-CRITICAL gate.
 *
 * When deterministic replay hits a `needsHeal` step (its cached selector no
 * longer resolves), the agent re-finds the element by the step's NL intent and
 * proposes a healed target. We then **independently re-resolve that proposal
 * against the live page and validate it matches the step's ORIGINAL intent
 * BEFORE writing it back** — the prior-art scan's hard rule: never trust the
 * first re-resolution; a wrong cached click is worse than a slow one. A
 * validated heal rewrites `target.resolvedSelector` (+ role/name) so the next
 * run is deterministic again; a rejected proposal is surfaced honestly, never
 * silently written.
 *
 * Framework-neutral and pure — the live re-resolution is done by the caller
 * (the heal tool, via the bridge); this module only judges + applies.
 */

import type { ScreenshotPlanStep } from "../core/screenshot-plan"

/** A live re-resolution of a proposed target (from the bridge RESOLVE_TARGET). */
export interface LiveResolution {
  found: boolean
  selector?: string
  role?: string
  name?: string
}

export interface HealValidation {
  valid: boolean
  reason?: string
}

/** Generic words ignored when token-matching an element name to an intent. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "and",
  "or",
  "for",
  "this",
  "that",
  "click",
  "button",
  "link",
  "field",
  "input",
  "page",
])

/** Significant lowercase tokens (length ≥ 3, non-stopword) of a string. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )
}

/** Whether the live element name shares any significant token with the intent. */
function shareToken(liveName: string, intent: string): boolean {
  const a = tokens(liveName)
  const b = tokens(intent)
  for (const t of a) if (b.has(t)) return true
  return false
}

/**
 * Does the live-resolved element match the step's recorded intent? Exact /
 * substring name match wins; otherwise require a shared significant token with
 * the step's name / text / description. Conservative by design: a fully-renamed
 * element with NO shared word fails to heal (we surface it rather than write a
 * possibly-wrong selector).
 */
function matchesIntent(
  liveName: string,
  target: { name?: string; text?: string; description?: string } | undefined,
): boolean {
  const ln = liveName.trim().toLowerCase()
  const wantName = target?.name?.trim().toLowerCase()
  if (wantName) {
    if (ln === wantName) return true
    if (ln.includes(wantName) || wantName.includes(ln)) return true
  }
  const intent = `${target?.name ?? ""} ${target?.text ?? ""} ${target?.description ?? ""}`
  return shareToken(ln, intent)
}

/**
 * Validate a healed proposal against a step's original intent. `live` is the
 * INDEPENDENT re-resolution of the agent's proposal (not the agent's word).
 * Returns `{ valid:false, reason }` with a human-facing reason so the agent can
 * try a different element.
 */
export function validateHealedTarget(
  step: ScreenshotPlanStep,
  live: LiveResolution | null,
): HealValidation {
  if (step.kind !== "interact") {
    return { valid: false, reason: "only interact steps can be healed" }
  }
  if (!live?.found || !live.selector) {
    return {
      valid: false,
      reason: "the proposed target did not resolve to a live element on the page",
    }
  }
  const target = step.target
  const wantRole = target?.role?.trim().toLowerCase()
  const liveRole = live.role?.trim().toLowerCase()
  if (wantRole && liveRole && liveRole !== wantRole) {
    return {
      valid: false,
      reason: `Role mismatch: the step's target is a '${wantRole}', but the resolved element is a '${liveRole}'`,
    }
  }
  const liveName = (live.name ?? "").trim()
  if (!liveName) {
    return {
      valid: false,
      reason: "the resolved element has no accessible name to confirm it matches the step",
    }
  }
  if (!matchesIntent(liveName, target)) {
    const intentLabel = (target?.name ?? target?.description ?? "").trim()
    return {
      valid: false,
      reason: `the resolved element "${liveName}" doesn't match the step's intent "${intentLabel}": pick the element that intent describes, or report it can't be found`,
    }
  }
  return { valid: true }
}

/**
 * Apply a VALIDATED live resolution to a step — rewrite the cached selector
 * (+ role/name when the live page reports them) while preserving the step's NL
 * `description` (the durable intent the next heal re-resolves against). Pure;
 * returns a new step.
 */
export function applyHealToStep(
  step: ScreenshotPlanStep,
  live: LiveResolution,
): ScreenshotPlanStep {
  const prev = step.target ?? { description: step.intent }
  return {
    ...step,
    target: {
      ...prev,
      description: prev.description || step.intent,
      ...(live.role ? { role: live.role } : {}),
      ...(live.name ? { name: live.name } : {}),
      resolvedSelector: live.selector,
    },
  }
}

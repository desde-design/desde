/**
 * Shared email validation and normalization for every write path in this API
 * that accepts an address by hand.
 *
 * `isValidEmail` is the low-level shape check; `normalizeEmailInput` is what
 * an actual write path should call — it trims, rejects whitespace/control
 * characters, runs the shape check, and lowercases (see its own doc comment
 * below for the X5 consolidation history). Every current caller goes
 * through `normalizeEmailInput`: `POST /auth/magic-link` (auth-routes.ts),
 * `POST /instance/invites` (instance-routes.ts), `POST /projects/:id/members`
 * (members-routes.ts), and `POST /projects/:id/participants` plus
 * `upsertAuthorParticipant` (participants-routes.ts — moved off a direct
 * `isValidEmail` call in the viewer-membership post-review follow-up, so a
 * participant-directory row can no longer carry interior whitespace or a
 * control character the other write paths already reject). They all must
 * agree on what a valid email is, or one path can write a row — or admit a
 * sign-in — that another would have rejected.
 */

export const MAX_EMAIL_CHARS = 254
export const MAX_NAME_CHARS = 80

/**
 * Basic shape check, not full RFC 5322 validation: contains `@`, a
 * non-empty local part and domain, within the length cap. Good enough to
 * reject obvious junk without rejecting real addresses a stricter regex
 * might choke on.
 */
export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > MAX_EMAIL_CHARS) return false
  const at = email.indexOf("@")
  if (at <= 0 || at === email.length - 1) return false
  if (email.indexOf("@", at + 1) !== -1) return false
  return true
}

/**
 * Any whitespace or C0/DEL control character. Checked AFTER trimming, so it
 * catches what a trim cannot: an INTERIOR character, not a leading or
 * trailing one. That distinction matters because an address destined for a
 * mail transport with a CR/LF in the middle is the classic header-injection
 * payload (`victim@example.test\r\nBcc: attacker@evil.test`), and a value
 * with interior whitespace defeats a trim-then-compare match against a
 * lookup that was itself trimmed and lowercased elsewhere.
 *
 * Written as escapes rather than literal bytes so this file stays plain text
 * that grep, diff and a code review can all read.
 */
const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/

/**
 * The one normalization every email-accepting write path in this API must
 * run before doing anything else with the value: confirm it's a string,
 * trim it, refuse anything still carrying whitespace or a control
 * character, run `isValidEmail`'s shape check, and lowercase on success.
 * Returns `null` on any failure — a caller turns that into its own 400.
 *
 * Consolidated (viewer-membership X5) from three near-identical copies that
 * had drifted from each other: `POST /auth/magic-link` (auth-routes.ts)
 * trimmed and rejected whitespace/control characters BEFORE validating;
 * `POST /instance/invites` and its regenerate route (instance-routes.ts),
 * and `POST /projects/:id/members` (members-routes.ts), validated the RAW
 * value and only trimmed afterward — which meant an address a caller could
 * satisfy with surrounding whitespace was checked in one shape and then
 * silently normalized into a different one before being stored or looked
 * up, and neither of those two routes rejected an interior control
 * character at all. One function now, so the three cannot disagree again.
 */
export function normalizeEmailInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || CONTROL_OR_SPACE.test(trimmed) || !isValidEmail(trimmed)) return null
  return trimmed.toLowerCase()
}

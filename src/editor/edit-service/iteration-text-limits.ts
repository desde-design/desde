/**
 * The shape rule for the two FREE-TEXT fields an iteration context carries:
 * `key` (when it is a string) and `expression`.
 *
 * Both originate in the page. Both travel into an LLM request — the
 * iteration-data lane renders them into the prompt it sends with the file
 * sources — and into the iteration dialog's copy. So they are capped and they
 * may not carry control characters. Rejected, never stripped: an expression
 * carrying a newline is not an expression that got mangled in transit, it is a
 * page writing extra lines into a message.
 *
 * Lives here, in a module whose only import is a sibling with no imports of
 * its own, because BOTH ends apply it: the client's wire boundary
 * (`validateIterationContext`) and the CLI's two iteration routes, which must
 * not trust a hand-built request either.
 *
 * What counts as a control character is NOT decided here. It comes from
 * `control-characters.ts`, shared with `sanitizeField`, which flattens the
 * same class downstream. The two used to disagree: this check covered C0 and
 * DEL, while `sanitizeField` also covered C1 and U+2028/U+2029, so the
 * narrower of the two was the one deciding what was safe to send.
 */
import { hasControlCharacters } from "./control-characters"

/** A `v-for` expression or a row key that is longer than this is not one. */
export const ITERATION_TEXT_LIMIT = 200

/**
 * The cap for the iteration intent's `description`, which is a SENTENCE built
 * around a key rather than an identifier ("Patch row \"x\": set label"). Same
 * rule otherwise: it reaches the same prompt, so it may not carry lines.
 */
export const ITERATION_DESCRIPTION_LIMIT = 500

/**
 * Why `value` is not acceptable as `label`, or null when it is fine.
 *
 * The returned sentence is for logs, tests and HTTP 400 bodies. It never
 * reaches a prompt, and it never quotes the value.
 */
export function iterationTextProblem(
  label: string,
  value: string,
  limit: number = ITERATION_TEXT_LIMIT,
): string | null {
  if (value.length > limit) {
    return `${label} is longer than ${limit} characters`
  }
  if (hasControlCharacters(value)) return `${label} contains control characters`
  return null
}

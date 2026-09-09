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
 * Lives here, in a module with no imports, because BOTH ends apply it: the
 * client's wire boundary (`validateIterationContext`) and the CLI's two
 * iteration routes, which must not trust a hand-built request either.
 */

/** A `v-for` expression or a row key that is longer than this is not one. */
export const ITERATION_TEXT_LIMIT = 200

// eslint-disable-next-line no-control-regex -- matching control characters IS the check
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

/**
 * Why `value` is not acceptable as `label`, or null when it is fine.
 *
 * The returned sentence is for logs, tests and HTTP 400 bodies. It never
 * reaches a prompt, and it never quotes the value.
 */
export function iterationTextProblem(label: string, value: string): string | null {
  if (value.length > ITERATION_TEXT_LIMIT) {
    return `${label} is longer than ${ITERATION_TEXT_LIMIT} characters`
  }
  if (CONTROL_CHARACTERS.test(value)) return `${label} contains control characters`
  return null
}

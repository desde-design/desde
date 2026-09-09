/**
 * The ONE definition of "control character" for everything that flattens or
 * refuses page-supplied text on its way into a prompt.
 *
 * Two rules used to disagree about what the class was. `sanitizeField`
 * (`build-edit-escalation-prompt.ts`) flattened C0, DEL, C1 and the two
 * Unicode line separators; the iteration boundary check
 * (`iteration-text-limits.ts`) refused C0 and DEL only. So a `v-for`
 * expression carrying U+2028 passed the boundary and then had to be flattened
 * downstream, and the narrower rule was the one deciding whether a message
 * was safe to build at all. A value either may carry these or it may not; one
 * class, both ends.
 *
 * The class is the C0 range, DEL, the C1 range, and U+2028/U+2029 — which
 * JavaScript treats as line terminators, so they can forge a new bullet in a
 * one-fact-per-line block exactly the way a newline can.
 *
 * No imports, deliberately: the CLI's iteration routes reach this through
 * `iteration-text-limits.ts` by relative path, and it must stay loadable from
 * both a browser bundle and a Node process.
 *
 * The class is written with escapes, so it needs no lint suppression. That is
 * a property of how it is written, not a change anyone made to it: it has
 * always been escapes. `no-control-regex` is the rule that would care, and it
 * is NOT enabled in this repo (`npx eslint --print-config` on this file
 * reports it absent; the config is `eslint-config-next` only, with no
 * `eslint:recommended`). The `eslint-disable-next-line no-control-regex`
 * directive that used to sit above the old copy of this class was therefore
 * unused, and an unused directive is itself a warning at this repo's bar,
 * which is what made it worth removing.
 */

const CONTROL_CHARACTER_CLASS = "[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]"

/** One character of the class. Not global: it carries no `lastIndex` state. */
const ONE_CONTROL_CHARACTER = new RegExp(CONTROL_CHARACTER_CLASS)

/**
 * A RUN of them, for collapsing to a single space. Global, which is safe here
 * only because `String.prototype.replace` resets `lastIndex` itself; never
 * call `.test` on it.
 */
const CONTROL_CHARACTER_RUNS = new RegExp(`${CONTROL_CHARACTER_CLASS}+`, "g")

/** Does `value` carry a control character? The refusing half of the rule. */
export function hasControlCharacters(value: string): boolean {
  return ONE_CONTROL_CHARACTER.test(value)
}

/** Every run of them collapsed to one space. The flattening half. */
export function flattenControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTER_RUNS, " ")
}

/**
 * Pure (filesystem-free) ScopedCssOverrideEdit applicator.
 *
 * Use case: a designer wants to restyle either (a) an authored consumer
 * element, or (b) an element living INSIDE a component they do not own
 * (e.g., KCard's internal `.card-header`, or MUI's `.MuiAlert-message`).
 * The applicator writes a rule targeting the styled element by its
 * `data-desde-src` source-position attribute.
 *
 * **Why `data-desde-src` and not a class.** Earlier revisions tagged the
 * call-site with a deterministic `proto-XXXXXX` class and matched on it
 * (`.proto-XXXXXX :deep(...)`). That depends on Vue's automatic
 * `class` fallthrough merging the consumer's class onto the child
 * component's root, which silently breaks for components like KCard
 * whose compiled root is created with a frozen static-class object —
 * the proto class doesn't reach the rendered element, the rule matches
 * nothing, and the override appears to "save" but never renders. The
 * `data-desde-src` attribute is injected by the substrate's source-tag
 * Vite plugin onto every authored element directly (no fallthrough
 * involved), so it's a stable handle independent of component-author
 * choices about `inheritAttrs`, multi-root templates, etc.
 *
 * **Two destinations, one core** (`tasks/dev-server-hosts.md` § 9g.5). The
 * anchor half of this lane is framework-neutral — both stampers emit
 * `data-desde-src` — so the only per-substrate parts are where the rule is
 * written and whether scoping must be pierced:
 *
 * | | `vue-sfc` | `css-file` |
 * | --- | --- | --- |
 * | destination | the consumer SFC's `<style scoped>` | a project `.css`, block appended at EOF |
 * | descendant form | `:deep(<sel>)` | plain descendant combinator |
 * | integrity guard | `parseSfc` before + after | bytes outside the managed block unchanged + brace balance |
 * | body dialect | may emit `@apply` | declarations only |
 *
 * React needs no `:deep()` because it has no style scoping: a plain rule in
 * any stylesheet the app loads already reaches inside a third-party
 * component. And it must NOT emit `@apply`: whether the destination `.css`
 * is processed by Tailwind is not knowable in general, and an uncompiled
 * `@apply` is a rule that is present and inert — the exact failure this
 * module's history is about.
 *
 * **Selector shape.**
 *   - Direct: `[data-desde-src="<file>:<line>:<col>"] { ...!important }`
 *   - Ancestor (vue): `[data-desde-src="…"] :deep(<deep-selector>) { … }`
 *   - Ancestor (css):  `[data-desde-src="…"] <deep-selector> { … }`
 *
 * **The anchor is not the destination.** They coincide on Vue only because
 * an SFC contains both the callsite and the stylesheet; encoding that
 * coincidence is what made the lane read as though `authoredAt` were a valid
 * selector source (§ 9g.8). They are separate inputs here, and the anchor is
 * a free string, so it is SANITISED: a `"` in it would close the attribute
 * selector and inject CSS into a file we write.
 *
 * **No template changes.** The applicator only touches the style block.
 *
 * **Idempotence.** Same anchor + same deep-selector overwrite the prior rule
 * body in place. The rule head is the idempotence key, and it is the same key
 * on both destinations.
 *
 * **Refusals.**
 *   - Empty applyClasses AND empty declarations (nothing to write).
 *   - An anchor containing a quote, backslash, newline or control character.
 *   - A descendant/deep selector containing a brace, a comment marker, a
 *     control character, or an UNBALANCED quote. A well-formed quoted
 *     attribute selector (`[data-testid="hero"]`) is allowed — see
 *     `DEEP_SELECTOR_STRUCTURAL_BAN` / `hasBalancedQuotes` below (F-17).
 *   - `applyClasses` on the `css-file` destination (would emit an inert `@apply`).
 *   - SFC parse fails, or a `.css` write disturbed bytes outside the block.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'

/**
 * Where the managed override block lives, and therefore which CSS dialect the
 * rule is rendered in. One value per substrate shape, NOT per framework: a
 * substrate is `css-file` because it has no scoped-style block to write into,
 * not because it is "React".
 */
export type ScopedCssDestinationKind = 'vue-sfc' | 'css-file'

export interface ApplyScopedCssOverrideInput {
  source: string
  /**
   * Which destination dialect to render. Defaults to `vue-sfc`, which is what
   * every caller meant before the split existed.
   */
  destination?: ScopedCssDestinationKind
  /** Anchor location — the coordinate literally present on an element in the
   *  rendered document (`data-desde-src`), 1-based. The applicator builds the
   *  rule head from these. NOT necessarily a position in `source`: on a
   *  `css-file` destination it names a `.tsx`/`.vue` elsewhere in the repo. */
  anchorLine: number
  anchorColumn: number
  /**
   * Prototype-root-relative path of the anchor's file, forward slashes. Used
   * as the prefix in the `data-desde-src` selector — the source-tag plugins
   * encode positions as `<file>:<line>:<col>`.
   */
  anchorFile: string
  /**
   * Selector for the styled element RELATIVE to the anchor element. Omit for
   * the *direct* case where the anchor IS the styled element. On `vue-sfc` it
   * is wrapped in `:deep()`; on `css-file` it is a plain descendant. The
   * applicator does NOT validate the selector is well-formed CSS.
   */
  deepSelector?: string
  /** Tailwind utility classes to wrap in `@apply` (each emitted with
   *  `!` prefix for `!important`). Refused on `css-file`. */
  applyClasses?: string[]
  /** Raw CSS declarations (property → value). Each emitted with
   *  `!important`. */
  declarations?: Record<string, string>
  /**
   * Content version of the ANCHOR's file (`data-desde-v`), when the stamper
   * emitted one. Written as a trailing comment on the rule so staleness — the
   * anchor's element having been deleted or moved — is a pure function of the
   * file rather than something only a human can notice. Never auto-pruned:
   * deleting a designer's styling without asking is worse than dead CSS.
   */
  anchorVersion?: string
}

export type ApplyScopedCssOverrideResult =
  | { ok: true; source: string; targetSelector: string }
  | { ok: false; reason: string }

const BLOCK_START = '/* @editor-scoped-overrides start */'
const BLOCK_END = '/* @editor-scoped-overrides end */'

/**
 * Characters that would break OUT of `[data-desde-src="…"]`. The anchor used to
 * be `body.edit.file`, already resolved and confined to the prototype root, so
 * it could not contain a quote. Decoupled from the destination it is a free
 * string on the wire — and this is the single easiest thing to miss in the
 * whole design (§ 9g.4).
 *
 * A space is deliberately NOT rejected: `src/my file.tsx` is a legal path and
 * a legal quoted attribute value. Only what can terminate the string, escape
 * out of it, or break the surrounding declaration is.
 */
const UNSAFE_ANCHOR = /["\\{}]|[\u0000-\u001f\u007f]/

/**
 * Structural characters that can never appear in `deepSelector`, quoted or
 * not. Unlike the anchor (a file path — never legitimately quoted),
 * `deepSelector` is a full CSS selector fragment, and CSS attribute
 * selectors are QUOTED BY DESIGN (`[data-testid="hero"]`). So `"` is not on
 * this list; it is checked separately by `hasBalancedQuotes`, below.
 *
 * `{` / `}` stay banned even inside a quoted value: `bracesBalanced()` (the
 * `css-file` destination's integrity guard, further down this file) counts
 * every `{`/`}` byte with a naive counter that does not understand CSS
 * string context either, so a brace hidden inside a quoted value would
 * desync that counter exactly as it would desync the rule/managed-block
 * boundary. Comment markers stay banned unconditionally for the same reason
 * as before: they could end the enclosing `<style>` block's content early,
 * or (on `css-file`) hide part of the managed block from a plain-text
 * reader.
 *
 * `</style` (case-insensitive) is banned too, found by adversarially fuzzing
 * this guard while writing its tests. `@vue/compiler-sfc`'s `<style>` block
 * is a raw-text element (the same HTML5 parsing rule as `<script>`) — the
 * parser does not interpret anything inside it as markup, it just scans for
 * the literal closing tag. A `deepSelector` containing `</style>` (no quote,
 * brace, or control character needed — none of the checks above touch
 * `<`/`>`) lands inside the rule text this module splices into that block,
 * ends it EARLY, and turns whatever the attacker put after it into ordinary
 * top-level SFC content — e.g. `</style><script>evil</script>` becomes a
 * second, real `<script>` block that Vite compiles and runs. MEASURED: before
 * this line existed, that exact input returned `ok: true` and the payload
 * landed byte-for-byte in the written file. `<` / `>` otherwise stay
 * allowed — `>` is an ordinary CSS child combinator.
 */
const DEEP_SELECTOR_STRUCTURAL_BAN =
  /[{}]|\/\*|\*\/|<\/style|[\u0000-\u001f\u007f]/i

/**
 * True when every `"` in `selector` is balanced, respecting `\`-escapes —
 * e.g. `[data-testid="hero"]` (balanced) vs. `[data-testid="hero` (not).
 *
 * **Why balance, not "no quotes."** `deepSelectorFromMutationSelector`
 * (`src/hooks/style-edit-builders.ts`) derives `deepSelector` from the
 * bridge's own stable selector, which already runs attribute VALUES through
 * `CSS.escape()` (`src/bridge/selector-engine.ts`) — so
 * `[data-testid="hero"]` arrives already well-formed. Refusing every `"`
 * outright (the old behaviour) refused every element whose stable selector
 * happened to be an attribute selector — this was F-17.
 *
 * What genuinely has to be refused is a quote that never closes. CSS's
 * error recovery for an unterminated string consumes everything up to the
 * next newline — or, in a single-line/minified stylesheet, to EOF — as a
 * "bad string" token. That is how an unbalanced quote could swallow
 * whatever comes after it in the file; CSS has no code-execution model to
 * "inject" into, so file corruption (hiding or breaking later rules) is the
 * actual risk being guarded against, not script execution.
 *
 * A backslash always escapes exactly the next character (CSS.escape's own
 * escape form, e.g. `\"` for a literal quote inside the value) — the
 * escaped character is consumed as a unit and never itself toggles string
 * state. A trailing `\` with nothing left to escape is refused as
 * malformed: real `CSS.escape` output never ends on a dangling backslash,
 * so this can only be hand-crafted input, and there is no legitimate
 * selector shape it would produce.
 *
 * `deepSelector` also arrives as a free string straight off the wire at the
 * CLI's edit endpoint (`editor-cli/src/server/edit-handler.ts`), independent
 * of the shell's construction — so this function, not the shell's
 * `CSS.escape` call, is what the applicator can actually trust.
 */
function hasBalancedQuotes(selector: string): boolean {
  let inString = false
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '\\') {
      if (i + 1 >= selector.length) return false // dangling escape
      i++ // consume the escaped character as one unit — it can't toggle string state
      continue
    }
    if (ch === '"') inString = !inString
  }
  return !inString
}

export function applyScopedCssOverrideEdit(
  input: ApplyScopedCssOverrideInput,
): ApplyScopedCssOverrideResult {
  const { source, anchorLine, anchorColumn, anchorFile, deepSelector } = input
  const destination: ScopedCssDestinationKind = input.destination ?? 'vue-sfc'
  const applyClasses = (input.applyClasses ?? []).filter((c) => c.length > 0)
  const declarations = input.declarations ?? {}

  if (applyClasses.length === 0 && Object.keys(declarations).length === 0) {
    return {
      ok: false,
      reason: 'Nothing to write: this override has no classes and no declarations.',
    }
  }
  if (!anchorFile || anchorFile.length === 0) {
    return {
      ok: false,
      reason:
        "Editor can't tell which of your files this element came from, so it has " +
        'nowhere to write the rule. Usually that means a library component drew ' +
        'it. Try an element you can find in your own code, or ask chat to change ' +
        'the library component.',
    }
  }
  if (UNSAFE_ANCHOR.test(anchorFile)) {
    return {
      ok: false,
      reason:
        "This element's file path has a character that can't go inside a CSS " +
        'selector, so the rule could not be attached to it.',
    }
  }
  if (!Number.isInteger(anchorLine) || !Number.isInteger(anchorColumn)) {
    return {
      ok: false,
      reason:
        "Editor can't tell where this element is in your source, so it has " +
        'nowhere to write the rule. Click it again and retry.',
    }
  }
  if (destination === 'css-file' && applyClasses.length > 0) {
    // Whether a project `.css` is processed by Tailwind is knowable for the
    // entry stylesheet and not knowable in general. An uncompiled `@apply` is
    // a rule that is present and does nothing — the failure this lane exists
    // to eliminate. The shell refuses unresolvable classes before this point;
    // this is the backstop.
    return {
      ok: false,
      reason:
        'These classes would be written as @apply into a plain stylesheet, where ' +
        'they do nothing unless Tailwind processes that file. Ask chat to set ' +
        'this instead.',
    }
  }
  if (input.anchorVersion !== undefined && UNSAFE_ANCHOR.test(input.anchorVersion)) {
    return {
      ok: false,
      reason:
        "This element's source marker is malformed, so the rule could not be " +
        'attached to it safely.',
    }
  }
  const normalizedDeepSelector =
    deepSelector && deepSelector.trim().length > 0 ? deepSelector.trim() : null
  if (
    normalizedDeepSelector &&
    (DEEP_SELECTOR_STRUCTURAL_BAN.test(normalizedDeepSelector) ||
      !hasBalancedQuotes(normalizedDeepSelector))
  ) {
    // A `{`/`}`/comment marker in the descendant selector would end the rule
    // (or the managed block) early — same class of injection as the anchor.
    // An UNBALANCED quote is refused too (see `hasBalancedQuotes`); a
    // balanced one, like a quoted attribute selector, is not (F-17).
    return {
      ok: false,
      reason:
        "The part of this component you're targeting can't be written as a CSS " +
        'selector.',
    }
  }

  // The source-tag plugins use POSIX-style file paths. Match that (callers
  // pass paths with forward slashes already on every platform because the
  // bridge captures `data-desde-src` straight from the DOM).
  const sourceLoc = `${anchorFile}:${anchorLine}:${anchorColumn}`
  const targetSelector = `[data-desde-src="${sourceLoc}"]`

  const ruleBody = renderRuleBody(applyClasses, declarations)
  const newRule = renderRule(
    targetSelector,
    normalizedDeepSelector,
    ruleBody,
    destination,
    sourceLoc,
    input.anchorVersion,
  )

  return destination === 'vue-sfc'
    ? applyToVueSfc(source, targetSelector, normalizedDeepSelector, newRule, destination)
    : applyToCssFile(source, targetSelector, normalizedDeepSelector, newRule, destination)
}

// ── Destinations ──────────────────────────────────────────────────

function applyToVueSfc(
  source: string,
  targetSelector: string,
  deepSelector: string | null,
  rule: string,
  destination: ScopedCssDestinationKind,
): ApplyScopedCssOverrideResult {
  // Pre-splice parse — bail early if the SFC is malformed (so we don't
  // overwrite a broken file with a half-applied edit).
  try {
    parseSfc(source)
  } catch (err) {
    return {
      ok: false,
      reason: `Could not read this component's file: ${(err as Error).message}`,
    }
  }

  const sourceWithStyle = upsertScopedStyleRule(
    source,
    targetSelector,
    deepSelector,
    rule,
    destination,
  )

  // Post-splice parse check.
  try {
    parseSfc(sourceWithStyle)
  } catch (err) {
    return {
      ok: false,
      reason:
        "Writing the rule would have left this component's file unreadable, so " +
        `nothing was changed: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: sourceWithStyle, targetSelector }
}

/**
 * A plain stylesheet destination. The managed block is appended at
 * end-of-file, so the integrity guard is stronger than the SFC one and needs
 * no parser: every byte OUTSIDE the managed block must be unchanged, plus the
 * block itself must be brace-balanced. (The brace-depth technique is already
 * in-tree with no CSS-parser dependency —
 * `src/editor/adapters/css-custom-properties/parser.ts`.)
 *
 * Trailing whitespace is the one exception, and it is the one the splice
 * itself creates: appending a block to a file that had none adds a separating
 * newline at what used to be the end. Comparing with trailing whitespace
 * normalised keeps the guard exact about every byte that matters — anything
 * inserted, removed or reordered in the user's own CSS still fails it —
 * without failing on the change we deliberately make.
 */
function applyToCssFile(
  source: string,
  targetSelector: string,
  deepSelector: string | null,
  rule: string,
  destination: ScopedCssDestinationKind,
): ApplyScopedCssOverrideResult {
  const before = splitManagedBlock(source)
  const updated = upsertCssFileRule(source, targetSelector, deepSelector, rule, destination)
  const after = splitManagedBlock(updated)
  if (after === null) {
    return {
      ok: false,
      reason:
        "Editor's override block went missing while writing the rule, so nothing " +
        'was changed.',
    }
  }
  const outsideBefore = before === null ? source : before.outside
  if (trimEnd(after.outside) !== trimEnd(outsideBefore)) {
    return {
      ok: false,
      reason:
        'Writing this rule would have changed part of the file outside the block ' +
        'Editor manages, so nothing was changed.',
    }
  }
  if (!bracesBalanced(after.inner)) {
    return {
      ok: false,
      reason: 'Refusing the override: the managed block is not brace-balanced after the splice',
    }
  }
  return { ok: true, source: updated, targetSelector }
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/, '')
}

/**
 * The managed block's inner text and everything outside it (with the block
 * itself elided to a single sentinel so the "outside" strings of two revisions
 * are comparable). `null` when the file has no managed block yet.
 */
function splitManagedBlock(
  source: string,
): { inner: string; outside: string } | null {
  const startIdx = source.indexOf(BLOCK_START)
  if (startIdx < 0) return null
  const endIdx = source.indexOf(BLOCK_END, startIdx + BLOCK_START.length)
  if (endIdx < 0) return null
  const inner = source.slice(startIdx + BLOCK_START.length, endIdx)
  const outside =
    source.slice(0, startIdx) + source.slice(endIdx + BLOCK_END.length)
  return { inner, outside }
}

function bracesBalanced(css: string): boolean {
  let depth = 0
  for (const ch of css) {
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return false
    }
  }
  return depth === 0
}

// ── Rule rendering ────────────────────────────────────────────────

function renderRuleBody(
  applyClasses: readonly string[],
  declarations: Readonly<Record<string, string>>,
): string {
  // Every declaration emits with `!important`. Without it, the override
  // routinely loses the cascade against library scoped CSS like
  // `.ui-card[data-v-internal]` (specificity 0,2,0). Designer tools
  // (Webflow, Framer) emit `!important` for the same reason — the
  // override expresses intent, not a cascade contribution. Tailwind v4
  // supports `!important` on `@apply` via the `!` class prefix; v3
  // recognizes it too via the deprecated suffix form. We prefix-each-
  // class so both versions render correctly.
  const parts: string[] = []
  if (applyClasses.length > 0) {
    parts.push(`@apply ${applyClasses.map((c) => `!${c}`).join(' ')};`)
  }
  for (const [prop, value] of Object.entries(declarations)) {
    parts.push(`${prop}: ${value} !important;`)
  }
  return parts.join(' ')
}

function renderRule(
  targetSelector: string,
  deepSelector: string | null,
  body: string,
  destination: ScopedCssDestinationKind,
  sourceLoc: string,
  anchorVersion: string | undefined,
): string {
  const head = renderRuleHead(targetSelector, deepSelector, destination)
  const rule = `${head} { ${body} }`
  // A rule in a project stylesheet has no `<style scoped>` fence and no
  // colocation with the anchor's file, so staleness has to be checkable from
  // the rule alone. The trailing comment makes it one.
  if (destination === 'css-file') {
    const v = anchorVersion ? ` v=${anchorVersion}` : ''
    return `${rule} /* pt ${sourceLoc}${v} */`
  }
  return rule
}

/**
 * The rule head — and, up to `{`, the idempotence key. Shared by rendering
 * and by the upsert's match test so the two cannot drift.
 */
function renderRuleHead(
  targetSelector: string,
  deepSelector: string | null,
  destination: ScopedCssDestinationKind,
): string {
  if (deepSelector === null) return targetSelector
  return destination === 'vue-sfc'
    ? `${targetSelector} :deep(${deepSelector})`
    : `${targetSelector} ${deepSelector}`
}

/** `^<head>\s*\{` — the idempotence key as a regex. */
function ruleHeadMatcher(
  targetSelector: string,
  deepSelector: string | null,
  destination: ScopedCssDestinationKind,
): RegExp {
  return new RegExp(
    `^${escapeRegex(renderRuleHead(targetSelector, deepSelector, destination))}\\s*\\{`,
  )
}

// ── Style block management ────────────────────────────────────────

/**
 * Upsert the override rule into the consumer's `<style scoped>` block.
 *
 * Algorithm:
 *   - If no `<style scoped>` exists → append one with the managed
 *     block + the new rule.
 *   - If the managed block doesn't exist within the style block →
 *     insert it (and the rule) before `</style>`.
 *   - If the managed block exists → parse it for an existing rule with
 *     the same target selector + deep selector, REPLACE if found,
 *     otherwise append the new rule before the block-end marker.
 */
function upsertScopedStyleRule(
  source: string,
  targetSelector: string,
  deepSelector: string | null,
  rule: string,
  destination: ScopedCssDestinationKind,
): string {
  const styleScopedRe = /<style\b[^>]*\bscoped\b[^>]*>/i
  const openMatch = styleScopedRe.exec(source)

  if (!openMatch) {
    // No scoped style block — append a new one at end-of-file.
    const block = `\n\n<style scoped>\n${BLOCK_START}\n${rule}\n${BLOCK_END}\n</style>\n`
    const trimmed = source.replace(/\s*$/, '')
    return trimmed + block
  }

  const openEnd = openMatch.index + openMatch[0].length
  const closeIdx = source.indexOf('</style>', openEnd)
  if (closeIdx < 0) {
    return source // malformed; post-splice parse will catch
  }
  const styleBody = source.slice(openEnd, closeIdx)

  const blockStartIdx = styleBody.indexOf(BLOCK_START)
  if (blockStartIdx < 0) {
    // No managed block yet — append it before the closing tag.
    const insertion = `\n${BLOCK_START}\n${rule}\n${BLOCK_END}\n`
    return source.slice(0, closeIdx) + insertion + source.slice(closeIdx)
  }
  const blockEndIdx = styleBody.indexOf(BLOCK_END, blockStartIdx + BLOCK_START.length)
  if (blockEndIdx < 0) {
    return source
  }
  const blockInner = styleBody.slice(
    blockStartIdx + BLOCK_START.length,
    blockEndIdx,
  )
  const newBlockInner = `\n${upsertRuleLines(
    blockInner,
    rule,
    ruleHeadMatcher(targetSelector, deepSelector, destination),
  ).join('\n')}\n`

  const newStyleBody =
    styleBody.slice(0, blockStartIdx + BLOCK_START.length) +
    newBlockInner +
    styleBody.slice(blockEndIdx)
  return source.slice(0, openEnd) + newStyleBody + source.slice(closeIdx)
}

/**
 * Upsert into a plain `.css` file: the managed block lives at end-of-file and
 * nothing outside it is ever touched (which is what makes the integrity guard
 * a byte comparison rather than a parse).
 */
function upsertCssFileRule(
  source: string,
  targetSelector: string,
  deepSelector: string | null,
  rule: string,
  destination: ScopedCssDestinationKind,
): string {
  const split = splitManagedBlock(source)
  if (split === null) {
    const lead = source.length === 0 || /\n$/.test(source) ? '' : '\n'
    return `${source}${lead}\n${BLOCK_START}\n${rule}\n${BLOCK_END}\n`
  }
  const startIdx = source.indexOf(BLOCK_START)
  const endIdx = source.indexOf(BLOCK_END, startIdx + BLOCK_START.length)
  const newInner = `\n${upsertRuleLines(
    split.inner,
    rule,
    ruleHeadMatcher(targetSelector, deepSelector, destination),
  ).join('\n')}\n`
  return (
    source.slice(0, startIdx + BLOCK_START.length) + newInner + source.slice(endIdx)
  )
}

/**
 * Idempotence, shared by both destinations: one rule per line, replaced in
 * place when its head matches, appended otherwise.
 *
 * Semantics worth stating because they surprise people: a second edit to the
 * same element REPLACES the first rule's whole body rather than merging
 * per-property. That is the shipped Vue behavior, kept deliberately — the
 * shell sends the element's full resolved declaration set each time, so a
 * merge here would resurrect declarations the designer had cleared.
 */
function upsertRuleLines(
  blockInner: string,
  rule: string,
  ruleHeadRe: RegExp,
): string[] {
  const lines = blockInner.split('\n').map((l) => l.trim()).filter(Boolean)
  let replaced = false
  const updated: string[] = []
  for (const line of lines) {
    if (!replaced && ruleHeadRe.test(line)) {
      updated.push(rule)
      replaced = true
    } else {
      updated.push(line)
    }
  }
  if (!replaced) updated.push(rule)
  return updated
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

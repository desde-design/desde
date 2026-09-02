/**
 * Pure (filesystem-free) TokenEdit applicator — §6 Phase 3 of
 * tasks/inspector-style-provenance.md, the "The token" scope.
 *
 * Patches a CSS custom-property (design-token) declaration in its source:
 * `--acme-color-background-disabled: #f7f7f7;` → `: <newValue>;`. Used when the
 * inspector's scope dialog routes a style edit to "The token" — the value is
 * changed at its DEFINITION, so every consumer of the token updates (the
 * blast-radius the dialog warns about).
 *
 * Provenance (Phase 1) supplies which file the token lives in and the winning
 * definition's selector (e.g. `:root`); this applicator locates the declaration
 * by NAME within that selector's rule and rewrites the value via postcss
 * (formatting-preserving for unchanged nodes).
 *
 * **Refusals are the caller's job for source location.** This applicator is
 * pure over a source string — the node_modules refusal (can't write library
 * token files) is enforced at dispatch from the file path, not here.
 *
 * **v1 scope:** plain CSS sources (the typical design-token file). Tokens
 * defined inside a Vue SFC `<style>` block would need extraction first —
 * deferred (no dogfood driver; @acme/design-tokens ships .css).
 */
import postcss from 'postcss'

export interface ApplyTokenEditInput {
  /** The token file's source (CSS). */
  source: string
  /** Custom property name, e.g. `--acme-color-background-disabled`. */
  tokenName: string
  /** New value to set (verbatim — e.g. `#ff0000`, `var(--other)`, `1rem`). */
  newValue: string
  /**
   * Selector of the WINNING definition (e.g. `:root`), from provenance.
   * Disambiguates which rule's declaration to patch when the token is defined
   * in several rules (theming). Omit to patch the first definition found.
   */
  selector?: string
}

export type ApplyTokenEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

export function applyTokenEdit({
  source,
  tokenName,
  newValue,
  selector,
}: ApplyTokenEditInput): ApplyTokenEditResult {
  if (!tokenName.startsWith('--')) {
    return { ok: false, reason: `Not a custom property: '${tokenName}'` }
  }
  if (newValue.includes('}') || newValue.includes('{') || newValue.includes(';')) {
    // Defense-in-depth: a value with block/decl punctuation could break out of
    // the declaration. postcss would re-serialize it as-is, so reject up front.
    return { ok: false, reason: 'Token value contains illegal CSS punctuation' }
  }

  let root: postcss.Root
  try {
    root = postcss.parse(source)
  } catch (err) {
    return { ok: false, reason: `CSS parse failed: ${(err as Error).message}` }
  }

  const wantSelector = selector ? normalizeSelector(selector) : null
  let patched = false
  root.walkRules((rule) => {
    if (patched) return
    // Match against EACH comma-part — token files commonly share definitions
    // across a selector list (`:root, :host { --t: … }`), and provenance
    // identifies just one part (e.g. `:root`).
    if (wantSelector !== null && !ruleSelectorMatches(rule.selector, wantSelector)) {
      return
    }
    rule.walkDecls(tokenName, (decl) => {
      if (patched) return
      decl.value = newValue
      patched = true
    })
  })

  if (!patched) {
    return {
      ok: false,
      reason: `Token '${tokenName}' not found${selector ? ` in '${selector}'` : ''}.`,
    }
  }

  let out: string
  try {
    out = root.toString()
  } catch (err) {
    return { ok: false, reason: `CSS re-stringify failed: ${(err as Error).message}` }
  }
  return { ok: true, source: out }
}

/** Collapse whitespace so `:root` and ` :root ` compare equal. */
function normalizeSelector(sel: string): string {
  return sel.trim().replace(/\s+/g, ' ')
}

/**
 * Whether a rule's selector list contains `want`. Splits on TOP-LEVEL commas
 * only, so a part with nested commas (`:where(:root, :host)`, `[a="x,y"]`) isn't
 * torn apart. (A self-contained splitter — not the bridge's `splitSelectorList`
 * — to keep this applicator free of the bridge's `@bramus/specificity` dep,
 * which editor-cli must not transitively typecheck.)
 */
function ruleSelectorMatches(ruleSelector: string, want: string): boolean {
  const parts: string[] = []
  let depthParen = 0
  let depthBracket = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  let current = ''
  for (const ch of ruleSelector) {
    // Escape-first: a backslash makes the NEXT char literal, in or out of a
    // string (CSS identifier escapes like `.a\"b`, and escaped quotes in attr
    // values). So an escaped char is never structural and never toggles quotes.
    if (escaped) {
      escaped = false
      current += ch
      continue
    }
    if (ch === '\\') {
      escaped = true
      current += ch
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(') depthParen++
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1)
    else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1)
    if (ch === ',' && depthParen === 0 && depthBracket === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts.some((part) => normalizeSelector(part) === want)
}

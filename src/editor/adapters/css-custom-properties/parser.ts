/**
 * Block-aware CSS custom-property parser.
 *
 * Handles arbitrary prototype CSS rather than one fixed auto-generated file
 * shape: a
 * project's global tokens can live in `:root {}`, `html {}`/`html.dark {}`
 * (theme variants), or Tailwind v4's `@theme {}`, and may be wrapped in
 * `@media`/`@layer`/`@supports` for conditional theming. Declarations in any
 * OTHER selector scope (component styles) are deliberately not collected —
 * those are local, not global design tokens — and `var(...)` USAGE (not
 * declaration) is never mistaken for a declaration by construction, since the
 * declaration regex requires the property name to start the line.
 *
 * Brace-depth scanning only — no CSS parser dependency. A single pass tracks
 * a stack of block frames; each frame's `kind` is classified from its OWN
 * header only (not inherited from an enclosing wrapper), which is sufficient
 * because eligible blocks (`:root`/`html`/`@theme`) never directly contain
 * bare declarations at a wrapper's nesting level in real CSS — the wrapper's
 * own buffer, before its nested rule opens, is just whitespace/comments, so
 * it naturally yields no matches. This keeps `@media`/`@layer`/`@supports`
 * wrapping "for free" without a separate inheritance rule.
 */
export interface ParsedCustomProperty {
  /** `--color-primary` (leading dashes). */
  name: string
  /** Trimmed, as written. */
  value: string
  /** Trailing `/* … *\/` or `/** … *\/` comment on the same line, if present. */
  description?: string
  block: 'root' | 'html' | 'theme'
}

type BlockKind = 'root' | 'html' | 'theme' | null

interface Frame {
  kind: BlockKind
  buffer: string
}

/**
 * Matches a custom-property declaration line: `--name: value;` with an
 * optional trailing `/* *\/` or `/** *\/` description comment.
 *
 * The optional-comment group's leading `\s*` is INSIDE the optional group
 * (not `\s*(?:...)?` with the whitespace outside): if it were outside, it
 * would greedily consume the next declaration's leading newline/indent when
 * no comment is present.
 *
 * The pre-comment whitespace is `[ \t]*` (same-line only), not `\s*` —
 * `\s` includes `\n`, which would let this group reach across a line break
 * and swallow an UNRELATED comment on a following line as if it were this
 * declaration's trailing description (see `stripNonTrailingComments`, which
 * additionally strips any comment that isn't actually a same-line trailer).
 */
const DECLARATION_RE =
  /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);(?:[ \t]*\/\*\*?\s*(.+?)\s*\*\/)?/gm

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Remove every block comment from `buffer` EXCEPT one that is a genuine
 * same-line trailing description (immediately after a declaration's `;`,
 * only spaces/tabs between). A commented-out declaration —
 * `/* --old-bg: #eee; *\/` sitting on its own line — must never leak into
 * the collected tokens: without this it would either be silently ignored
 * (lucky) or, when a live declaration's `;` precedes it across a blank line,
 * get glued on as that declaration's `description` (data corruption) because
 * the old `\s*` in {@link DECLARATION_RE}'s trailing-comment group could
 * cross the line break. Stripping non-trailing comments up front makes both
 * failure modes impossible regardless of the regex's own whitespace class.
 */
function stripNonTrailingComments(buffer: string): string {
  let result = ''
  let i = 0
  const len = buffer.length
  while (i < len) {
    const start = buffer.indexOf('/*', i)
    if (start === -1) {
      result += buffer.slice(i)
      break
    }
    result += buffer.slice(i, start)
    const closeIdx = buffer.indexOf('*/', start + 2)
    const end = closeIdx === -1 ? len : closeIdx + 2

    // Same-line lookback: does a `;` (optionally followed only by
    // spaces/tabs) immediately precede this comment on its own line?
    const lineStart = buffer.lastIndexOf('\n', start) + 1
    const beforeOnLine = buffer.slice(lineStart, start)
    const isTrailingDescription = /;[ \t]*$/.test(beforeOnLine)

    if (isTrailingDescription) {
      result += buffer.slice(start, end) // keep verbatim for DECLARATION_RE
    }
    // else: drop the comment entirely — it's a standalone/commented-out line.

    i = end
  }
  return result
}

/** Classify a block header (the trimmed text between the previous brace event and `{`). */
function classifyHeader(header: string): BlockKind {
  const trimmed = stripComments(header).trim()
  if (trimmed.startsWith(':root')) return 'root'
  if (trimmed.startsWith('html')) return 'html'
  if (trimmed.startsWith('@theme')) return 'theme'
  return null
}

function collectDeclarations(
  buffer: string,
  block: 'root' | 'html' | 'theme',
): ParsedCustomProperty[] {
  const results: ParsedCustomProperty[] = []
  const cleaned = stripNonTrailingComments(buffer)
  DECLARATION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DECLARATION_RE.exec(cleaned)) !== null) {
    const [, name, rawValue, rawDescription] = match
    const value = rawValue.trim()
    const description = rawDescription?.trim()
    results.push({
      name,
      value,
      ...(description ? { description } : {}),
      block,
    })
  }
  return results
}

/**
 * Extract custom-property DECLARATIONS from `:root{}`, `html{}` (incl.
 * `html.dark` etc. — selector startsWith 'html' or ':root'), and `@theme … {}`
 * blocks. Ignores declarations elsewhere (component scopes) and `var()`
 * USAGE. Brace-depth scanning, tolerant of nesting inside `@media`/`@layer`/
 * `@supports` wrappers.
 */
export function parseCustomProperties(css: string): ParsedCustomProperty[] {
  const results: ParsedCustomProperty[] = []
  const stack: Frame[] = [{ kind: null, buffer: '' }]

  const len = css.length
  let i = 0
  while (i < len) {
    const ch = css[i]

    // Comments are copied verbatim into the current buffer without
    // interpreting any braces inside them (e.g. a comment mentioning `{`).
    if (ch === '/' && css[i + 1] === '*') {
      const closeIdx = css.indexOf('*/', i + 2)
      const end = closeIdx === -1 ? len : closeIdx + 2
      stack[stack.length - 1].buffer += css.slice(i, end)
      i = end
      continue
    }

    if (ch === '{') {
      const parent = stack[stack.length - 1]

      // The parent's buffer may hold BOTH already-complete declarations
      // (when this `{` opens a rule NESTED inside an eligible frame, e.g. an
      // `@media` conditionally overriding a `:root` token) and the header
      // text for the upcoming nested block. Only the tail since the last
      // `;` is the header — collect anything before it as declarations of
      // the parent NOW, rather than clearing it unseen (the previous
      // unconditional `parent.buffer = ''` silently dropped those
      // declarations whenever a nested rule followed them in the same
      // frame).
      const lastSemi = parent.buffer.lastIndexOf(';')
      const declarationsPart = lastSemi === -1 ? '' : parent.buffer.slice(0, lastSemi + 1)
      const header = lastSemi === -1 ? parent.buffer : parent.buffer.slice(lastSemi + 1)
      if (parent.kind && declarationsPart) {
        results.push(...collectDeclarations(declarationsPart, parent.kind))
      }

      // `@media`/`@layer`/`@supports` wrap transparently per the module
      // contract — but that "free" pass-through only works when the wrapper
      // is a SIBLING of (or ancestor to) the eligible block, because then the
      // wrapper's own header-position buffer is genuinely empty. Nested
      // INSIDE an already-eligible frame (the case this fixes), the wrapper
      // header text is non-empty (it's real `@media (...)` selector text),
      // so `classifyHeader` on it returns null and would wrongly demote the
      // nested declarations to "unclassified". Detect that shape explicitly
      // and inherit the parent's kind instead.
      const trimmedHeader = stripComments(header).trim()
      const isTransparentWrapper = /^@(media|supports|layer)\b/i.test(trimmedHeader)
      const kind =
        isTransparentWrapper && parent.kind ? parent.kind : classifyHeader(header)

      parent.buffer = '' // consumed as declarations + this block's header
      stack.push({ kind, buffer: '' })
      i += 1
      continue
    }

    if (ch === '}') {
      const frame = stack.pop()
      if (frame?.kind) {
        results.push(...collectDeclarations(frame.buffer, frame.kind))
      }
      // Guard against unbalanced braces in malformed input — never empty the stack.
      if (stack.length === 0) stack.push({ kind: null, buffer: '' })
      i += 1
      continue
    }

    stack[stack.length - 1].buffer += ch
    i += 1
  }

  return results
}

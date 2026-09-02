/**
 * Deterministic iteration-data applicator. Phase 3 of
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`. Takes an `IterationDataLocation`
 * (resolved by the adapter) + an operation payload + source, and
 * returns the mutated source. No LLM involvement.
 *
 * Detects Vue SFCs and trims the rewriter's target range to the
 * `<script>` (or `<script setup>`) block so byte offsets align with
 * the resolver's reported (line, column). For non-Vue files, runs
 * directly on the whole source.
 *
 * Returns `{ ok: false, reason }` when:
 *  - The location doesn't resolve to an array literal (rewriter
 *    refusal — usually means the resolver and the file drifted).
 *  - The matchers find zero or multiple entries.
 *  - The patch operation targets a non-object entry.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import {
  rewriteArrayLiteral,
  type ArrayMatcher,
  type ArrayOperation,
  type JsonValue,
} from './array-literal-rewriter'

export interface ApplyIterationDataEditInput {
  /** Full source of the file being edited. */
  source: string
  /** Repo-relative file path — used to dispatch SFC handling. */
  file: string
  /** Resolved array location (1-based line/column, SFC-absolute when in SFC). */
  arrayLocation: { line: number; column: number }
  /** How to pick the entry. */
  matchers: ReadonlyArray<ArrayMatcher>
  /** What to do with the matched entry. */
  operation: ApplyIterationDataPayload
}

/**
 * The operation payload the applicator accepts. Mirrors
 * `IterationDataPayload` from the prompt builder but uses an `operation`
 * discriminator that matches the rewriter's `ArrayOperation` shape so the
 * two stay aligned.
 */
export type ApplyIterationDataPayload =
  | { operation: 'remove' }
  | { operation: 'patch'; updates: Readonly<Record<string, JsonValue>> }
  | { operation: 'duplicate'; afterMatch?: boolean }
  | { operation: 'reorder'; toIndex: number }
  | {
      operation: 'insert'
      entry: JsonValue
      position: 'before' | 'after'
    }

export type ApplyIterationDataEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

function toRewriterOp(p: ApplyIterationDataPayload): ArrayOperation {
  switch (p.operation) {
    case 'remove':
      return { kind: 'remove' }
    case 'patch':
      return { kind: 'patch', updates: p.updates }
    case 'duplicate':
      return { kind: 'duplicate', afterMatch: p.afterMatch }
    case 'reorder':
      return { kind: 'reorder', toIndex: p.toIndex }
    case 'insert':
      return { kind: 'insert', entry: p.entry, position: p.position }
  }
}

/** Vue SFC detection: filename suffix is sufficient for our use. */
function isVueSfc(file: string): boolean {
  return file.toLowerCase().endsWith('.vue')
}

/**
 * Locate the `<script>` (or `<script setup>`) block within an SFC. Returns
 * the SFC line where the script's content starts (1-based) so the
 * rewriter can translate SFC-absolute coordinates back to script-local
 * Babel positions. We also extract the script content + lang for the
 * rewriter's input.
 */
function findScriptBlock(source: string, sfcDescriptor: {
  script?: { content: string; loc: { start: { line: number; column: number } }; lang?: string | null } | null
  scriptSetup?: { content: string; loc: { start: { line: number; column: number } }; lang?: string | null } | null
}): { content: string; startLine: number; lang: 'js' | 'ts' | 'jsx' | 'tsx' } | null {
  const block = sfcDescriptor.scriptSetup ?? sfcDescriptor.script
  if (!block) return null
  // Compiler-sfc reports loc.start.line/column for the block — but
  // `block.content` starts AFTER the opening `<script ...>` tag. We
  // need the line number of the first content character. Walk `source`
  // up to that point.
  // The `loc.start` reported by parseSfc is the start of the *content*
  // (right after the opening tag). Verified by inspection: testing
  // `<script>const x = 1</script>` puts loc.start at index of `c` in
  // `const`. Use it directly.
  const startLine = block.loc.start.line
  const lang = block.lang === 'ts' || block.lang === 'tsx' ? block.lang : 'ts'
  return { content: block.content, startLine, lang }
}

export function applyIterationDataEditStatic(
  input: ApplyIterationDataEditInput,
): ApplyIterationDataEditResult {
  // Matcher: callers may pass a list, but we use the first one. The
  // rewriter handles match-failure cleanly so subsequent matchers in
  // the list aren't tried in v1 — keeping behavior simple. Adding
  // try-each-in-order is a follow-up if static failure rates warrant.
  const matcher = input.matchers[0]
  if (!matcher) {
    return { ok: false, reason: 'No matchers supplied' }
  }
  const op = toRewriterOp(input.operation)

  if (!isVueSfc(input.file)) {
    // Plain .ts / .js: rewrite the whole file with default scriptOffset.
    return rewriteArrayLiteral({
      source: input.source,
      location: input.arrayLocation,
      matcher,
      operation: op,
      lang: input.file.endsWith('.tsx')
        ? 'tsx'
        : input.file.endsWith('.ts')
        ? 'ts'
        : input.file.endsWith('.jsx')
        ? 'jsx'
        : 'js',
    })
  }

  // Vue SFC: extract the script block, rewrite IT, splice back into
  // the SFC. The rewriter operates on script-local source but the
  // caller's `arrayLocation` is SFC-absolute (the source-tag plugin's
  // convention). We use `scriptOffset` to bridge the two.
  let descriptor
  try {
    descriptor = parseSfc(input.source).descriptor
  } catch (err) {
    return { ok: false, reason: `SFC parse failed: ${(err as Error).message}` }
  }
  const scriptInfo = findScriptBlock(input.source, descriptor)
  if (!scriptInfo) {
    return {
      ok: false,
      reason: 'SFC has no <script> or <script setup> block: nothing to rewrite',
    }
  }

  const rewrite = rewriteArrayLiteral({
    source: scriptInfo.content,
    location: input.arrayLocation,
    matcher,
    operation: op,
    lang: scriptInfo.lang,
    scriptOffset: { line: scriptInfo.startLine, column: 0 },
  })
  if (!rewrite.ok) return rewrite

  // Splice the new script content back into the SFC at the exact
  // bytes the original block occupied. `block.loc.start.offset` /
  // `block.loc.end.offset` would be ideal but @vue/compiler-sfc's
  // typing doesn't always expose offsets on every block; we recover
  // them by string-find of the original `block.content` (unique
  // enough in practice).
  const oldContent = (descriptor.scriptSetup?.content ?? descriptor.script?.content) as string
  const oldIdx = input.source.indexOf(oldContent)
  if (oldIdx < 0) {
    return {
      ok: false,
      reason: 'Could not locate script block in SFC source for splicing',
    }
  }
  const nextSource =
    input.source.slice(0, oldIdx) +
    rewrite.source +
    input.source.slice(oldIdx + oldContent.length)
  return { ok: true, source: nextSource }
}

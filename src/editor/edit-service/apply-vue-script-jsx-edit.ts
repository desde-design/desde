/**
 * Edits to JSX that lives inside a Vue SFC's `<script setup lang="tsx">` block.
 *
 * WHY THIS EXISTS. `edit-handler.ts` picks an applicator by the resolved FILE
 * EXTENSION, so a `.vue` always reached the Vue template applicators
 * (`@vue/compiler-dom`). That is right for the template block and wrong for the
 * script block, where the markup is JSX — the Vue parser finds nothing and
 * refuses with "No element found at SFC line N, column M". Since those elements
 * became source-stamped they are offered as edit targets, so without this they
 * would be offered and then always refused.
 *
 * ONE HELPER, NO PER-KIND SPECIAL CASES. {@link applyInVueScriptJsxBlock} does
 * the three things every kind needs — locate the block, rebase the line, splice
 * the result back — and each kind is a thin wrapper that calls its own JSX
 * applicator. Input validation stays where it already lives: inside each
 * applicator. An earlier draft added a snippet-language guard to `insert`
 * alone; that was both redundant (`applyJsxInsertEdit` already parses the
 * snippet and refuses, and re-parses after splicing) and misplaced, since it
 * would have pushed framework knowledge up into the router — the exact
 * anti-pattern that made shared bridge code read Vue-only properties.
 *
 * THE COORDINATE CONTRACT, which is the whole risk:
 *
 *   - Incoming `line` is SFC-ABSOLUTE (1-based) — what `data-desde-src` carries.
 *   - Incoming `column` is left UNTOUCHED. Script-JSX stamps are written by
 *     `collectEmbeddedJsxInsertions`, which keeps Babel's 0-based column, and
 *     that is exactly what the JSX applicators expect.
 *   - Only the LINE is rebased, because Babel re-parses the block string on its
 *     own and numbers it from 1.
 *
 * A `.vue` therefore carries two column conventions at once — 1-based for
 * template stamps, 0-based for script-JSX stamps. That is deliberate (each
 * matches its applicator) and is why dispatch must key on WHICH BLOCK the
 * coordinate falls in, never on the file extension.
 */
import { parse } from "@vue/compiler-sfc"
import { applyJsxPropEdit } from "./apply-jsx-prop-edit"
import { applyJsxDeleteEdit } from "./apply-jsx-delete-edit"
import { applyJsxUnwrapEdit } from "./apply-jsx-unwrap-edit"
import { applyJsxInsertEdit } from "./apply-jsx-insert-edit"
import type { PropEditValue, PropEditFallbackHint } from "./apply-jsx-prop-edit"
import type { ApplyJsxInsertEditInput } from "./apply-jsx-insert-edit"

/**
 * The shape every applicator in this family returns.
 *
 * `warnings` is carried because `applyJsxInsertEdit` can SUCCEED and still
 * report one — it inserts the element but declines to add the import when a
 * binding of the same name already exists. Dropping that would tell the user
 * their component saved cleanly while it silently will not resolve.
 */
export type BlockEditResult =
  | { ok: true; source: string; warnings?: string[] }
  | { ok: false; reason: string; fallback?: PropEditFallbackHint }

/** A `<script>` block whose contents are JSX, located within its SFC. */
export interface VueScriptJsxBlock {
  content: string
  /** 1-based SFC line on which the block's CONTENT begins. */
  startLine: number
  /** Byte offset in the SFC where the content begins. */
  startOffset: number
  /** Byte offset in the SFC where the content ends. */
  endOffset: number
}

/**
 * The JSX script block containing `line`, or null.
 *
 * Null is the signal to fall through to the Vue template applicator — a
 * template coordinate, a plain `<script>` with no JSX, or an unparseable SFC
 * must all keep their existing behaviour rather than being rerouted.
 */
export function findVueScriptJsxBlock(
  source: string,
  line: number,
): VueScriptJsxBlock | null {
  let descriptor
  try {
    const parsed = parse(source)
    if (parsed.errors.length > 0) return null
    descriptor = parsed.descriptor
  } catch {
    return null
  }

  for (const block of [descriptor.scriptSetup, descriptor.script]) {
    if (!block) continue
    if (block.lang !== "tsx" && block.lang !== "jsx") continue
    const startLine = block.loc?.start?.line
    const endLine = block.loc?.end?.line
    const startOffset = block.loc?.start?.offset
    const endOffset = block.loc?.end?.offset
    if (
      typeof startLine !== "number" ||
      typeof endLine !== "number" ||
      typeof startOffset !== "number" ||
      typeof endOffset !== "number"
    ) {
      continue
    }
    if (line < startLine || line > endLine) continue
    return { content: block.content, startLine, startOffset, endOffset }
  }
  return null
}

/**
 * Run `apply` against the JSX script block containing `line`, and return the
 * FULL SFC.
 *
 * `null` means "this coordinate is not in a JSX script block" — the caller must
 * then use the ordinary Vue applicator. That is deliberately distinct from a
 * refusal: a refusal is this family's answer, a null is a routing signal.
 */
export function applyInVueScriptJsxBlock(
  source: string,
  line: number,
  apply: (blockCode: string, blockLine: number) => BlockEditResult,
): BlockEditResult | null {
  const block = findVueScriptJsxBlock(source, line)
  if (!block) return null

  // Rebase into the block's own numbering. Babel parses `content` standalone
  // and counts from 1, and `block.loc.start.line` is the SFC line the content
  // begins on — so the content's first line IS `startLine`.
  const blockLine = line - block.startLine + 1
  if (blockLine < 1) return null

  const result = apply(block.content, blockLine)
  if (!result.ok) return result

  // Splice back between the CONTENT offsets, so the `<script>` tags are never
  // inside the replaced range.
  const patched =
    source.slice(0, block.startOffset) + result.source + source.slice(block.endOffset)

  // Same no-op rule the other applicators enforce: never hand back an unchanged
  // file as a success, or the handler reports a write that did nothing.
  if (patched === source) return { ok: false, reason: "Edit produced no change" }
  // SPREAD, don't rebuild. Only `source` is ours to replace — every other
  // field the applicator set has to survive the splice. Rebuilding the object
  // dropped `warnings` from a successful insert, so a component whose import
  // could not be added reported a clean save (codex review).
  return { ...result, source: patched }
}

export function applyVueScriptJsxPropEdit(input: {
  source: string
  line: number
  column: number
  propName: string
  value: PropEditValue
}): BlockEditResult | null {
  return applyInVueScriptJsxBlock(input.source, input.line, (blockCode, blockLine) =>
    applyJsxPropEdit({
      source: blockCode,
      line: blockLine,
      column: input.column,
      propName: input.propName,
      value: input.value,
    }),
  )
}

export function applyVueScriptJsxDeleteEdit(input: {
  source: string
  line: number
  column: number
}): BlockEditResult | null {
  return applyInVueScriptJsxBlock(input.source, input.line, (blockCode, blockLine) =>
    applyJsxDeleteEdit({ source: blockCode, line: blockLine, column: input.column }),
  )
}

export function applyVueScriptJsxUnwrapEdit(input: {
  source: string
  line: number
  column: number
}): BlockEditResult | null {
  return applyInVueScriptJsxBlock(input.source, input.line, (blockCode, blockLine) =>
    applyJsxUnwrapEdit({ source: blockCode, line: blockLine, column: input.column }),
  )
}

export function applyVueScriptJsxInsertEdit(input: {
  source: string
  /** SFC-absolute line of the DESTINATION PARENT's opening tag. */
  line: number
  column: number
  destIndex: number
  snippet: string
  contentKind?: ApplyJsxInsertEditInput["contentKind"]
  /**
   * Forwarded, not dropped. The block IS the module as far as imports go — a
   * Vue SFC's script block holds its own `import` statements — so the JSX
   * applicator's import insertion lands in the right place unchanged.
   */
  componentImport?: ApplyJsxInsertEditInput["componentImport"]
}): BlockEditResult | null {
  return applyInVueScriptJsxBlock(input.source, input.line, (blockCode, blockLine) =>
    applyJsxInsertEdit({
      source: blockCode,
      destParentLine: blockLine,
      destParentColumn: input.column,
      destIndex: input.destIndex,
      snippet: input.snippet,
      contentKind: input.contentKind,
      componentImport: input.componentImport,
    }),
  )
}

/**
 * Move is the one kind this family does NOT implement, and the reason is
 * structural rather than linguistic: it is the only kind with TWO coordinates,
 * and they can land in different blocks.
 *
 * A cross-block move is meaningless — a JSX element cannot become a child of a
 * Vue template node, and vice versa; they are different languages compiled by
 * different pipelines. Silently doing something (moving within one block and
 * ignoring the other coordinate, say) would relocate a node somewhere the user
 * did not point at. Refusing is the honest answer, and it matches the standing
 * rule elsewhere in this codebase that ambiguity loses.
 *
 * Returns a refusal when EITHER coordinate is inside a JSX script block, and
 * null when neither is — null being the signal to fall through to the ordinary
 * Vue move applicator, so template-only moves are untouched.
 */
export function refuseVueScriptJsxMove(input: {
  source: string
  sourceLine: number
  destParentLine: number
}): BlockEditResult | null {
  const from = findVueScriptJsxBlock(input.source, input.sourceLine)
  const to = findVueScriptJsxBlock(input.source, input.destParentLine)
  if (!from && !to) return null
  return {
    ok: false,
    reason:
      "Moving elements into or out of a <script setup lang=\"tsx\"> block isn't supported: " +
      "the template and the script block are different languages. Move it by editing the source directly.",
  }
}

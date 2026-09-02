/**
 * Pure (filesystem-free) move/reorder applicator. Given a Vue SFC's source
 * and the build-time `(line, column)` of a source element + a destination
 * parent + a final child index, produces a new SFC source with the element
 * relocated.
 *
 * Same-file scope only — `MoveEdit` whose source and destination are in
 * different SFCs is V2 work (requires creating new prop wiring in the
 * destination component, not just rewriting one file). The API route
 * enforces that source and dest live in the same file before calling here.
 *
 * `destIndex` semantics: the FINAL position the element should occupy in
 * the destination parent's children list AFTER the move. Same-parent
 * reorder, cross-parent move (same file), and same-position no-ops all
 * route through the same call.
 *
 * Coordinate convention follows {@link applyPropEdit}: line/column are
 * SFC-absolute (the values the substrate's source-tag plugin writes into
 * `data-desde-src`). Internally this re-parses the template with
 * `@vue/compiler-dom` (template-content-relative loc) and shifts by the
 * SFC's template block start when matching.
 *
 * Whitespace handling (fixed 2026-08-10; was a V1 simplification):
 *  - The element moves together with its **gutter** — the horizontal
 *    whitespace back to the start of its line plus that line's leading
 *    newline. Snipping the element's exact byte range instead left a
 *    whitespace-only orphan line at the vacated position, and dropped the
 *    inter-sibling separator at the destination so two reordered siblings
 *    ended up glued (`</span><span …>`). For same-line siblings that is a
 *    RENDERED-output change: Vue's default `whitespace: 'condense'` keeps a
 *    single space between elements that were separated on one line (it only
 *    drops newline-bearing runs), so losing it removes a real space.
 *  - At the destination the element is re-emitted behind a copy of the
 *    separator that already precedes its new neighbour, so exactly one
 *    separator sits between every adjacent pair and the local indentation
 *    convention is matched without re-indenting anything.
 *  - Refuses cross-parent moves when source and destination parents are
 *    not both Element nodes (no v-if/v-for branch wrappers as containers).
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { compile as compileTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'
import { findGutterStart, readGutterBefore, readLineIndent } from './template-whitespace'

export interface ApplyMoveEditInput {
  /** Full SFC source text. */
  source: string
  /** Source element location — 1-based SFC-absolute. */
  sourceLine: number
  sourceColumn: number
  /** Destination parent element location — 1-based SFC-absolute. */
  destParentLine: number
  destParentColumn: number
  /**
   * Final 0-based index the moved element should occupy in the destination
   * parent's children list (counting only Element-type children). Negative
   * values count from the end (-1 means "append").
   */
  destIndex: number
  /**
   * Conditional-GROUP move (WS2 follow-up): the source coordinates must
   * target the `<template v-if>` HEAD of a branch group; the moved byte
   * range extends across every consecutive `<template v-else-if>` /
   * `<template v-else>` sibling, so the whole conditional relocates as a
   * unit and the branch pairing survives. The layers panel's synthetic
   * group rows dispatch with this flag.
   */
  moveGroup?: boolean
}

export type ApplyMoveEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number } }
  props: unknown[]
  children: ElementLike[]
  isSelfClosing: boolean
}

export function applyMoveEdit(input: ApplyMoveEditInput): ApplyMoveEditResult {
  const {
    source,
    sourceLine,
    sourceColumn,
    destParentLine,
    destParentColumn,
    destIndex,
    moveGroup,
  } = input

  // Resolve the source element and the destination parent via the shared
  // resolver. Both calls parse the same source independently — that matches
  // current behavior (no cross-call caching), kept simple.
  const sourceResolved = resolveTemplateTarget({ source, line: sourceLine, column: sourceColumn })
  if (!sourceResolved.ok) {
    return { ok: false, reason: sourceResolved.failure.reason }
  }

  const destResolved = resolveTemplateTarget({
    source,
    line: destParentLine,
    column: destParentColumn,
  })
  if (!destResolved.ok) {
    // Historical reason string for the destination lookup differs from the
    // shared resolver's generic "No element found…" — preserve it.
    const reason =
      destResolved.failure.kind === 'not-found'
        ? `No destination parent found at SFC line ${destParentLine}, column ${destParentColumn}`
        : destResolved.failure.reason
    return { ok: false, reason }
  }
  const destEl = destResolved.node as unknown as ElementLike
  const { templateContent, templateOffset } = destResolved.ctx

  // The two resolver calls parse the source independently, so their nodes
  // live in different ASTs. The checks below rely on object identity
  // (self-parent, cycle detection, same-parent indexOf) — re-locate the
  // source element inside destResolved's AST by its start offset, which is
  // unique per element and identical across parses of the same source.
  const sourceEl = findByStartOffset(
    destResolved.ctx.templateAst.children as unknown as ElementLike[],
    (sourceResolved.node as unknown as ElementLike).loc.start.offset,
  )
  if (!sourceEl) {
    // Unreachable in practice (both parses see the same source); kept for
    // type safety with the historical not-found reason.
    return {
      ok: false,
      reason: `No element found at SFC line ${sourceLine}, column ${sourceColumn}`,
    }
  }

  // Conditional-group expansion: collect the consecutive v-else-if/v-else
  // template siblings that pair with the targeted v-if head. Whitespace
  // text (and comments) between branches ride along inside the moved range.
  const groupMembers: ElementLike[] = [sourceEl]
  if (moveGroup) {
    if ((sourceEl as { tagType?: number }).tagType !== TAG_TYPE_TEMPLATE) {
      return {
        ok: false,
        reason: 'Group move requires a <template v-if> wrapper as the source',
      }
    }
    const headDirective = structuralDirectiveOf(sourceEl)
    if (!headDirective || (headDirective.name !== 'if' && headDirective.name !== 'for')) {
      return {
        ok: false,
        reason:
          headDirective && (headDirective.name === 'else' || headDirective.name === 'else-if')
            ? 'Group move must target the v-if HEAD of the conditional group, not a v-else branch'
            : 'Group move requires a <template v-if> or <template v-for> wrapper as the source',
      }
    }
    const parent = findParentOf(
      destResolved.ctx.templateAst.children as unknown as ElementLike[],
      sourceEl,
    )
    const rawSiblings = parent
      ? parent.children
      : (destResolved.ctx.templateAst.children as unknown as ElementLike[])
    const headIdx = rawSiblings.indexOf(sourceEl)
    for (let i = headIdx + 1; i < rawSiblings.length; i++) {
      const sib = rawSiblings[i] as ElementLike & { tagType?: number }
      if (sib.type !== NodeTypes.ELEMENT) continue // whitespace/comments ride along
      const dir = structuralDirectiveOf(sib)
      if (
        sib.tagType === TAG_TYPE_TEMPLATE &&
        dir &&
        (dir.name === 'else' || dir.name === 'else-if')
      ) {
        groupMembers.push(sib)
        continue
      }
      break
    }
  }
  const groupTail = groupMembers[groupMembers.length - 1]

  if (groupMembers.includes(destEl)) {
    return { ok: false, reason: 'Source element cannot be its own destination parent' }
  }
  for (const member of groupMembers) {
    if (containsElement(member, destEl)) {
      return {
        ok: false,
        reason: 'Cannot move an element into one of its descendants (would create a cycle)',
      }
    }
  }

  // Self-closing destination → no `<...>children</...>` slot to splice into.
  // Refuse upfront with a designer-readable reason instead of bottoming out
  // at the opaque "Could not compute destination insertion offset."
  if (destEl.isSelfClosing) {
    return {
      ok: false,
      reason: `Destination <${destEl.tag}> is self-closing and can't contain children`,
    }
  }

  // Element-only children for stable indexing — text nodes and whitespace
  // shouldn't count when the user said "drop at index 2."
  const destElementChildren = (destEl.children as ElementLike[]).filter(
    (c) => c.type === NodeTypes.ELEMENT,
  )

  // Resolve the final index, handling negative ("from end") semantics.
  let finalIndex = destIndex
  if (finalIndex < 0) finalIndex = destElementChildren.length + 1 + finalIndex
  if (finalIndex < 0) finalIndex = 0
  if (finalIndex > destElementChildren.length) finalIndex = destElementChildren.length

  // Determine current position of sourceEl among destEl.children (if any).
  // For same-parent reorder, this lets us early-return on no-op and adjust
  // the insertion offset to reflect "final index after move."
  const currentIndexInDest = destElementChildren.indexOf(sourceEl)
  const isSameParent = currentIndexInDest >= 0

  if (isSameParent && currentIndexInDest === finalIndex) {
    return { ok: true, source } // no-op
  }

  // Compute SFC-absolute byte offsets. For a group move the range spans
  // head through the last paired branch (inclusive of the whitespace and
  // comments between them).
  const srcStart = templateOffset + sourceEl.loc.start.offset
  const srcEnd = templateOffset + groupTail.loc.end.offset

  // The range actually removed extends back over the element's gutter, so
  // the vacated position doesn't keep a whitespace-only orphan line and the
  // two elements that become adjacent keep exactly one separator between
  // them (rather than two, or — for the tail case — a trailing one).
  const removeStart = findGutterStart(source, srcStart)

  // The insertion offset is keyed off the PRE-MOVE child list. If the user
  // wants the element to end up at finalIndex AFTER the move, and source is
  // in the same parent at currentIndex < finalIndex, we need to insert
  // before pre-move children[finalIndex + 1] (because removing source first
  // shifts subsequent indices left by 1). If currentIndex > finalIndex (or
  // not in this parent at all), insert before pre-move children[finalIndex].
  // Removing N group members before the target position shifts later
  // indices left by N (the single-element case is N=1).
  const removedCount = isSameParent
    ? groupMembers.filter((m) => destElementChildren.includes(m)).length
    : 0
  const preIndex =
    isSameParent && currentIndexInDest < finalIndex
      ? finalIndex + removedCount
      : finalIndex

  const slot = computeInsertionSlot(
    destEl,
    destElementChildren,
    preIndex,
    source,
    templateContent,
    templateOffset,
  )
  if (!slot) {
    return { ok: false, reason: 'Could not compute destination insertion offset' }
  }
  // `anchor` is the SEMANTIC insertion position (the child boundary the
  // index resolves to). The guards below are stated against it so their
  // behaviour is unchanged by the whitespace handling; `slot.offset` — which
  // may sit a gutter earlier — is used only for the actual splice.
  const insertOffset = slot.anchor

  if (insertOffset > removeStart && insertOffset < srcEnd) {
    return { ok: false, reason: 'Destination position falls inside the source element' }
  }

  // Semantic-closure guard (WS2, tasks/edit-pipeline-rearchitecture.md):
  // refuse moves that cross OUT of an enclosing `<template v-if/v-else-if/
  // v-else/v-for>` wrapper. The wrapper renders no DOM element, so the user
  // cannot see they're dragging across a conditional/iteration boundary —
  // and the element's own byte range doesn't include the wrapper's
  // directive, so the splice would silently drop the condition (the
  // reproduced 2026-07-24 bug: a v-if-gated card moved to the end of its
  // section began rendering unconditionally, ok:true). Moves out of a
  // VISIBLE conditional container (`<div v-if>`) stay allowed — the user
  // can see that container, and reparenting out of it is a normal edit.
  // A directive ON the moved element itself also stays allowed — it lives
  // inside the element's byte range and travels with it.
  const wrapper = nearestStructuralTemplateWrapper(sourceResolved.path as unknown as ElementLike[])
  if (wrapper) {
    const wrapStart = templateOffset + wrapper.node.loc.start.offset
    const wrapEnd = templateOffset + wrapper.node.loc.end.offset
    // Both bounds strict: an insertion AT wrapStart places the element
    // immediately BEFORE `<template ...>` (outside it — codex WS2 P1), and
    // wrapEnd is one past `</template>` (outside). Legitimate inside
    // insertions always land past the wrapper's open tag, so > wrapStart.
    if (insertOffset <= wrapStart || insertOffset >= wrapEnd) {
      const consequence =
        wrapper.directive.name === 'for'
          ? 'it would stop repeating per item and render exactly once'
          : 'it would silently stop being conditional and render always'
      return {
        ok: false,
        reason: `Cannot move <${sourceEl.tag}> out of its enclosing <template ${wrapper.description}>: ${consequence}. The wrapper renders no visible element, so the ${wrapper.directive.name === 'for' ? 'iteration' : 'condition'} would not travel with the element. Move the whole <template ${wrapper.description}> block instead, or restructure via chat.`,
      }
    }
  }

  const srcText = source.slice(srcStart, srcEnd)
  const newSource = spliceMove(
    source,
    removeStart,
    srcEnd,
    slot.offset,
    slot.separator + srcText,
  )

  // Post-splice validation — the splice operates on byte offsets and doesn't
  // validate that the resulting markup is well-formed OR semantically valid.
  // We run the FULL compile (parse + transforms + codegen), not just parse,
  // because some bugs only surface in the transform/codegen phase. The case
  // that motivated this: moving a v-for child out of a <template v-if> can
  // leave a sibling <template v-else> orphaned (no preceding v-if), which
  // parses fine but fails Vite's compile with "Codegen node is missing for
  // element/if/for node." Catching it here turns a silently-broken file
  // write into an upfront refusal.
  try {
    const newDescriptor = parseSfc(newSource).descriptor
    if (!newDescriptor.template) {
      return { ok: false, reason: 'Post-splice SFC lost its <template> block' }
    }
    compileTemplate(newDescriptor.template.content)
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice template compile failed: ${(err as Error).message}`,
    }
  }

  return { ok: true, source: newSource }
}

const TAG_TYPE_TEMPLATE = 3 // ElementTypes.TEMPLATE — `<template>` wrapper node

/** The structural directive (v-if / v-else-if / v-else / v-for) on a node,
 *  or null. Same detection the ancestor-wrapper guard uses. */
function structuralDirectiveOf(el: ElementLike): DirectiveLike | null {
  return (
    (el.props as DirectiveLike[]).find(
      (p) =>
        p.type === NodeTypes.DIRECTIVE &&
        (p.name === 'if' || p.name === 'else-if' || p.name === 'else' || p.name === 'for'),
    ) ?? null
  )
}

/** Depth-first parent lookup by object identity within one parsed AST. */
function findParentOf(children: ElementLike[], node: ElementLike): ElementLike | null {
  for (const child of children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    if ((child.children as ElementLike[]).includes(node)) return child
    const nested = findParentOf(child.children as ElementLike[], node)
    if (nested) return nested
  }
  return null
}

interface DirectiveLike {
  type: number
  name: string
  exp?: { content?: string } | null
}

/**
 * Nearest (innermost) ancestor that is a `<template>` wrapper carrying a
 * structural directive (v-if / v-else-if / v-else / v-for). Returns the
 * wrapper node plus a human-readable directive description for the refusal
 * message. `path` is outermost → innermost (from the shared resolver), so
 * scan from the end.
 */
function nearestStructuralTemplateWrapper(
  path: ElementLike[],
): { node: ElementLike; directive: DirectiveLike; description: string } | null {
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i]
    if ((ancestor as { tagType?: number }).tagType !== TAG_TYPE_TEMPLATE) continue
    const directive = (ancestor.props as DirectiveLike[]).find(
      (p) =>
        p.type === NodeTypes.DIRECTIVE &&
        (p.name === 'if' || p.name === 'else-if' || p.name === 'else' || p.name === 'for'),
    )
    if (!directive) continue
    const expr = directive.exp?.content
    const description = expr ? `v-${directive.name}="${expr}"` : `v-${directive.name}`
    return { node: ancestor, directive, description }
  }
  return null
}

/** Recursively walk element children for the node whose template-content-
 *  relative start offset matches. Used to re-locate the source element inside
 *  the destination resolver call's AST (offsets are identical across parses
 *  of the same source). */
function findByStartOffset(children: ElementLike[], startOffset: number): ElementLike | null {
  for (const child of children) {
    if (child.type !== NodeTypes.ELEMENT) continue
    if (child.loc.start.offset === startOffset) return child
    const nested = findByStartOffset(child.children, startOffset)
    if (nested) return nested
  }
  return null
}

function containsElement(ancestor: ElementLike, candidate: ElementLike): boolean {
  for (const child of ancestor.children) {
    if (child === candidate) return true
    if (child.type === NodeTypes.ELEMENT && containsElement(child, candidate)) {
      return true
    }
  }
  return false
}

/** Where a moved element lands, and the separator emitted in front of it. */
interface InsertionSlot {
  /**
   * Semantic insertion position — the child boundary `preIndex` resolves to.
   * Guards (cycle / conditional-wrapper containment) are stated against this
   * so whitespace handling can't shift a refusal.
   */
  anchor: number
  /** Byte offset the payload is actually spliced at (`anchor` or a gutter earlier). */
  offset: number
  /** Whitespace emitted before the element so it matches local convention. */
  separator: string
}

/**
 * Resolve `preIndex` into an insertion slot: where to splice, and the
 * separator to emit. The separator is a COPY of the whitespace already
 * preceding the neighbour we're inserting next to, so the result adopts the
 * file's own indentation without any re-indenting logic.
 */
function computeInsertionSlot(
  dest: ElementLike,
  destElementChildren: ElementLike[],
  preIndex: number,
  source: string,
  templateContent: string,
  templateOffset: number,
): InsertionSlot | null {
  if (preIndex < destElementChildren.length) {
    // Insert before the Nth element child. Splicing at the START of that
    // child's gutter (rather than at the child itself) leaves the child's
    // own separator intact behind the moved element — insert `SEP + el` and
    // both neighbours end up correctly separated.
    const target = destElementChildren[preIndex]
    const anchor = templateOffset + target.loc.start.offset
    return {
      anchor,
      offset: findGutterStart(source, anchor),
      separator: readGutterBefore(source, anchor),
    }
  }
  // Append after the last child, reusing that child's own leading separator.
  if (destElementChildren.length > 0) {
    const last = destElementChildren[destElementChildren.length - 1]
    const end = templateOffset + last.loc.end.offset
    return {
      anchor: end,
      offset: end,
      separator: readGutterBefore(source, templateOffset + last.loc.start.offset),
    }
  }
  // No children — insert right after `>` of the open tag. There is no
  // sibling to copy a separator from, so indent one step past the parent.
  const openTagClose = findOpenTagClose(templateContent, dest)
  if (openTagClose < 0) return null
  // findOpenTagClose returns the offset of `>` (or `/` in `/>`). For self-
  // closing destinations there are no children to insert into; refuse upstream.
  if (dest.isSelfClosing) return null
  const at = templateOffset + openTagClose + 1
  const destIndent = readLineIndent(source, templateOffset + dest.loc.start.offset)
  return { anchor: at, offset: at, separator: `\n${destIndent}  ` }
}

function findOpenTagClose(templateContent: string, target: ElementLike): number {
  const startOffset = target.loc.start.offset
  // Skip past the open tag's name. Don't try to skip past attributes — the
  // parser has already consumed everything up to `>` for us; scanning from
  // after the tag name is safe even with multi-line attribute lists because
  // we look for the FIRST `>` that isn't inside an attribute value, and
  // scanning after the tag name catches all attributes' quoted values too.
  // (PropEdit uses last-prop-end as the start; we prefer the more conservative
  // tag-name-end which works even for elements with no props.)
  const propsArr = target.props as Array<{ loc?: { end?: { offset?: number } } }>
  let scanFrom: number
  if (propsArr.length > 0) {
    const lastProp = propsArr[propsArr.length - 1]
    scanFrom = lastProp.loc?.end?.offset ?? startOffset + 1 + target.tag.length
  } else {
    scanFrom = startOffset + 1 + target.tag.length
  }
  for (let i = scanFrom; i < templateContent.length; i++) {
    const ch = templateContent[i]
    if (ch === '>') return i
    if (ch === '/' && templateContent[i + 1] === '>') return i
  }
  return -1
}

/**
 * Atomic move splice. Given the source text, the removed byte range
 * `[removeStart, removeEnd)` (the element plus its gutter), and an insertion
 * offset outside that range, produces a new source with the range removed and
 * `payload` inserted at the insertion offset (with offsets resolved against
 * the ORIGINAL source — the caller doesn't have to think about post-removal
 * index shifts).
 *
 * The boundary cases are real, not theoretical: `insertOffset === removeStart`
 * (moving to the slot immediately before yourself) and
 * `insertOffset === removeEnd` (the gutter of the next sibling starting exactly
 * where you end) both arise from the gutter-aware ranges, and both are
 * well-defined — only a STRICTLY interior offset is a caller bug.
 */
function spliceMove(
  source: string,
  removeStart: number,
  removeEnd: number,
  insertOffset: number,
  payload: string,
): string {
  if (insertOffset > removeStart && insertOffset < removeEnd) {
    // Inserting within self → no-op (caller should have refused already).
    return source
  }
  if (removeEnd <= insertOffset) {
    // Source is BEFORE destination in source order.
    return (
      source.slice(0, removeStart) +
      source.slice(removeEnd, insertOffset) +
      payload +
      source.slice(insertOffset)
    )
  }
  // Destination is before source.
  return (
    source.slice(0, insertOffset) +
    payload +
    source.slice(insertOffset, removeStart) +
    source.slice(removeEnd)
  )
}

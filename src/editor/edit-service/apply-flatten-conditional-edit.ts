/**
 * Pure (filesystem-free) FlattenConditionalEdit applicator. Collapses a
 * Vue conditional chain (v-if + 0..n v-else-if + 0..1 v-else) down to
 * a single chosen branch. The chosen branch's wrapper is unwrapped —
 * its children land where the chain was.
 *
 * `(line, column)` must point at the chain's FIRST element (the v-if
 * root). The applicator walks the AST sibling list starting from that
 * root, collecting every adjacent element that carries v-else-if or
 * v-else, stopping at the first non-conditional sibling.
 *
 * `branchToKeep` semantics:
 *   - `0`   → keep the v-if branch
 *   - `1..n` → keep the Nth v-else-if (1-indexed: 1 is the FIRST else-if)
 *   - `"else"` → keep the v-else branch (must exist)
 *
 * Refusal cases:
 *   - No element at (line, column).
 *   - Element at (line, column) has no v-if directive.
 *   - branchToKeep doesn't resolve to a branch on this chain.
 *   - Chosen branch has no rendered children — collapsing to nothing
 *     should be a Delete, not a Flatten.
 *   - Flattening yields multiple template roots (Vue requires one).
 *
 * Like the other applicators, post-splice runs the full compile() to
 * catch malformed output (e.g., a stray sibling that depended on the
 * deleted v-else).
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { compile as compileTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export interface ApplyFlattenConditionalEditInput {
  /** Full SFC source text. */
  source: string
  /** Chain root location (the v-if element) — 1-based SFC-absolute. */
  line: number
  column: number
  /** Index of the branch to keep. 0 = v-if; 1..n = Nth v-else-if; "else" = v-else. */
  branchToKeep: number | 'else'
}

export type ApplyFlattenConditionalEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string }

// Vue's compiler-dom directive shape we care about.
interface Directive {
  type: 7 // NodeTypes.DIRECTIVE
  name: string
  loc?: { start?: { offset?: number }; end?: { offset?: number } }
}

interface ElementLike {
  type: number
  tag: string
  isSelfClosing: boolean
  loc: {
    start: { line: number; column: number; offset: number }
    end: { offset: number }
  }
  props: Array<Directive | { type: number; name?: string }>
  children: ChildNode[]
}

interface ChildNode {
  type: number
  content?: string
}

type ChainKind = 'if' | 'else-if' | 'else'

function directiveOn(el: ElementLike): ChainKind | null {
  for (const p of el.props) {
    if (p.type === NodeTypes.DIRECTIVE) {
      const name = (p as Directive).name
      if (name === 'if') return 'if'
      if (name === 'else-if') return 'else-if'
      if (name === 'else') return 'else'
    }
  }
  return null
}

function hasRenderedContent(children: ChildNode[]): boolean {
  for (const c of children) {
    if (c.type === NodeTypes.ELEMENT) return true
    if (c.type === NodeTypes.INTERPOLATION) return true
    if (c.type === NodeTypes.TEXT && typeof c.content === 'string' && c.content.trim().length > 0) {
      return true
    }
  }
  return false
}

function countElementChildren(children: ChildNode[]): number {
  let n = 0
  for (const c of children) if (c.type === NodeTypes.ELEMENT) n++
  return n
}

export function applyFlattenConditionalEdit(
  input: ApplyFlattenConditionalEditInput,
): ApplyFlattenConditionalEditResult {
  const { source, line, column, branchToKeep } = input

  // Locate the chain root via the shared resolver, then derive its
  // containing sibling list + ancestor sibling lists from the resolver's
  // `path` (outermost → innermost ancestors) — we need those to walk
  // forward and gather v-else-if / v-else nodes, and to climb out of a
  // rendered child up to the enclosing v-if.
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.failure.reason }
  }
  const { templateContent, templateOffset, templateAst } = resolved.ctx
  const node = resolved.node as unknown as ElementLike
  const path = resolved.path as unknown as ElementLike[]
  const rootChildren = templateAst.children as unknown as ChildNode[]
  const siblingsOf = (i: number): ChildNode[] =>
    i === 0 ? rootChildren : path[i - 1].children
  const targetSiblings = path.length > 0 ? path[path.length - 1].children : rootChildren
  const lookup: SiblingHit = {
    target: node,
    siblings: targetSiblings,
    indexInSiblings: targetSiblings.indexOf(node as unknown as ChildNode),
    ancestors: path.map((el, i) => {
      const sibs = siblingsOf(i)
      return { el, siblings: sibs, indexInSiblings: sibs.indexOf(el as unknown as ChildNode) }
    }),
  }

  // Reachability fix (codex #9): the substrate's source-tag plugin skips
  // <template> nodes, so a `<template v-if>` chain root has no source-
  // tag → the designer can't right-click ON the chain root directly,
  // only on a rendered child. Walk ancestors here to find the enclosing
  // v-if and use IT as the chain root. The designer's coordinate just
  // needs to land SOMEWHERE inside a conditional branch.
  let target: ElementLike = lookup.target
  let siblings: ChildNode[] = lookup.siblings
  let indexInSiblings: number = lookup.indexInSiblings
  if (directiveOn(target) !== 'if') {
    // Walk from the immediate parent outward looking for an element
    // with v-if. Stop at the first one — that's our chain root.
    let foundEnclosingIf = false
    for (let i = lookup.ancestors.length - 1; i >= 0; i--) {
      const a = lookup.ancestors[i]
      if (directiveOn(a.el) === 'if') {
        target = a.el
        siblings = a.siblings
        indexInSiblings = a.indexInSiblings
        foundEnclosingIf = true
        break
      }
    }
    if (!foundEnclosingIf) {
      return {
        ok: false,
        reason: `Element at (${line}, ${column}) is not in a v-if branch: flatten requires a target inside a conditional chain`,
      }
    }
  }

  // Walk siblings forward, collecting the chain. The walk continues
  // through INTERPOLATION/TEXT whitespace siblings (the AST exposes
  // text-node siblings between elements; v-else-if/else are still
  // "adjacent" from Vue's perspective). Stop at the first ELEMENT that
  // is NOT v-else-if/v-else (or end of siblings).
  type Link = { kind: ChainKind; el: ElementLike }
  const chain: Link[] = [{ kind: 'if', el: target }]
  for (let i = indexInSiblings + 1; i < siblings.length; i++) {
    const sib = siblings[i] as unknown as ElementLike
    if (sib.type !== NodeTypes.ELEMENT) continue
    const kind = directiveOn(sib)
    if (kind === 'else-if' || kind === 'else') {
      chain.push({ kind, el: sib })
      if (kind === 'else') break // v-else terminates the chain
    } else {
      break
    }
  }

  // Resolve branchToKeep to a chain index.
  let chainIndex: number
  if (branchToKeep === 'else') {
    chainIndex = chain.findIndex((l) => l.kind === 'else')
    if (chainIndex < 0) {
      return { ok: false, reason: 'No v-else branch on this chain' }
    }
  } else if (Number.isInteger(branchToKeep) && branchToKeep >= 0) {
    if (branchToKeep === 0) {
      chainIndex = 0 // the v-if
    } else {
      // 1-indexed walk of v-else-if links.
      const elseIfLinks: number[] = []
      chain.forEach((l, i) => { if (l.kind === 'else-if') elseIfLinks.push(i) })
      if (branchToKeep - 1 < elseIfLinks.length) {
        chainIndex = elseIfLinks[branchToKeep - 1]
      } else {
        return {
          ok: false,
          reason: `branchToKeep=${branchToKeep} but the chain has only ${elseIfLinks.length} v-else-if branch(es)`,
        }
      }
    }
  } else {
    return { ok: false, reason: `Invalid branchToKeep: ${String(branchToKeep)}` }
  }

  const chosen = chain[chainIndex].el

  // The full chain occupies bytes
  // [chain[0].el.loc.start.offset, chain[last].el.loc.end.offset).
  const chainStart = templateOffset + chain[0].el.loc.start.offset
  const chainEnd = templateOffset + chain[chain.length - 1].el.loc.end.offset

  const validated = (newSource: string): ApplyFlattenConditionalEditResult => {
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

  // A `<template>` wrapper is an invisible grouping node, so flattening it
  // means unwrapping its children into the chain's slot (the path further
  // down). Any OTHER branch root — a plain element or a component — is real
  // rendered markup: its children may be slot templates (`<template
  // #toolbar>` on a component) that cannot exist outside it, and dropping
  // the element changes layout even when they could. For those, flatten
  // keeps the element itself and strips only its conditional directive.
  // MEASURED (stress test 2026-09-01, F-15): unwrapping a chosen
  // `<KCatalog v-if>` spliced its slot templates into a plain <div> and the
  // post-splice compile refused with the orphaned-branch signature.
  if (chosen.tag !== 'template') {
    const dir = chosen.props.find(
      (p): p is Directive =>
        p.type === NodeTypes.DIRECTIVE &&
        ((p as Directive).name === 'if' ||
          (p as Directive).name === 'else-if' ||
          (p as Directive).name === 'else'),
    )
    const dirStart = dir?.loc?.start?.offset
    const dirEnd = dir?.loc?.end?.offset
    if (dirStart === undefined || dirEnd === undefined) {
      return {
        ok: false,
        reason: 'Could not locate the conditional directive on the chosen branch',
      }
    }
    // Eat the whitespace run immediately before the directive so the open
    // tag is left with single spacing.
    let wsStart = dirStart
    while (wsStart > 0 && /\s/.test(templateContent[wsStart - 1])) wsStart--
    const keepText =
      templateContent.slice(chosen.loc.start.offset, wsStart) +
      templateContent.slice(dirEnd, chosen.loc.end.offset)
    return validated(source.slice(0, chainStart) + keepText + source.slice(chainEnd))
  }

  if (!hasRenderedContent(chosen.children)) {
    return {
      ok: false,
      reason:
        `Chosen branch has no rendered children: use Delete on the chain instead of Flatten`,
    }
  }

  // Top-level-root sanity check. If the chain occupies the only
  // meaningful top-level slot and the chosen branch has multiple
  // element children, the flattened template will have >1 root.
  // Single-element-child case is fine; the post-splice compile will
  // confirm. Interpolation/text-only branches are caught by the
  // hasRenderedContent check above.
  const meaningfulRoots = (templateAst.children as ChildNode[]).filter((c) => {
    if (c.type === NodeTypes.ELEMENT) return true
    if (c.type === NodeTypes.INTERPOLATION) return true
    if (c.type === NodeTypes.TEXT && typeof c.content === 'string' && c.content.trim().length > 0) return true
    return false
  })
  const chainIsOnlyRoot = meaningfulRoots.every((r) =>
    chain.some((l) => (l.el as unknown as ChildNode) === r),
  )
  if (chainIsOnlyRoot && countElementChildren(chosen.children) > 1) {
    return {
      ok: false,
      reason:
        "Flattening would leave the template with multiple roots: choose a branch with exactly one element child or wrap it in a single element.",
    }
  }

  const openTagClose = findOpenTagClose(templateContent, chosen)
  if (openTagClose < 0) {
    return { ok: false, reason: `Could not locate open-tag close for <${chosen.tag}>` }
  }
  const innerStart = templateOffset + openTagClose + 1
  const innerEnd = templateOffset + chosen.loc.end.offset - (chosen.tag.length + 3)
  if (innerStart > innerEnd) {
    return { ok: false, reason: 'Computed inner-content range is inconsistent' }
  }
  const innerText = source.slice(innerStart, innerEnd)
  return validated(source.slice(0, chainStart) + innerText + source.slice(chainEnd))
}

interface SiblingHit {
  target: ElementLike
  siblings: ChildNode[]
  indexInSiblings: number
  /** Ancestor chain (root → parent-of-target) walked during lookup.
   *  Each entry carries the parent element AND the sibling list it
   *  lives in. Used by `findEnclosingConditional` to climb out of a
   *  rendered child up to the nearest v-if root. */
  ancestors: Array<{ el: ElementLike; siblings: ChildNode[]; indexInSiblings: number }>
}

function findOpenTagClose(templateContent: string, target: ElementLike): number {
  const startOffset = target.loc.start.offset
  const props = target.props
  let scanFrom: number
  if (props.length > 0) {
    const lastProp = props[props.length - 1] as Directive
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

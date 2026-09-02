/**
 * Source-derived conditional/iteration group listing (WS2 follow-up,
 * tasks/edit-pipeline-rearchitecture.md § Deferred).
 *
 * `<template v-if>` / `<template v-for>` wrappers render no DOM element,
 * so the layers panel's DOM walk can never show them — the exact reason
 * the WS2 move guard exists (users could only ever grab a leaf). This
 * analyzer lists the groups straight from the SFC template AST so the
 * shell can synthesize selectable/movable group rows and dispatch
 * `moveGroup` edits against the head wrapper's coordinates.
 *
 * Pure (no I/O), same parsing substrate as the applicators. All
 * coordinates are 1-based SFC-absolute — the `data-desde-src` convention —
 * so `memberLocs` correlate directly with the DOM walk's
 * `authoredAt`/`editTarget` values.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import type { ElementNode, TemplateChildNode } from '@vue/compiler-dom'
import { toSfcPosition } from './resolve-template-target'

const TAG_TYPE_TEMPLATE = 3 // ElementTypes.TEMPLATE

export interface ConditionalGroupBranch {
  /** 'if' | 'else-if' | 'else' | 'for' */
  directive: string
  /** Directive expression as authored; null for bare v-else. */
  expression: string | null
  /** Branch wrapper start tag, 1-based SFC-absolute. */
  line: number
  column: number
}

export interface ConditionalGroup {
  /** Head wrapper (`v-if` / `v-for`) start tag — the moveGroup target. */
  head: { line: number; column: number }
  directive: 'if' | 'for'
  expression: string | null
  branches: ConditionalGroupBranch[]
  /**
   * Start-tag coordinates of every ELEMENT child across all branches —
   * these are the nodes the DOM walk DOES see (when their branch is
   * rendered), used to anchor the synthetic group row in the layers tree.
   */
  memberLocs: Array<{ line: number; column: number }>
}

export type ListConditionalGroupsResult =
  | { ok: true; groups: ConditionalGroup[] }
  | { ok: false; reason: string }

export function listConditionalGroups(source: string): ListConditionalGroupsResult {
  let descriptor
  try {
    descriptor = parseSfc(source).descriptor
  } catch (err) {
    return { ok: false, reason: `SFC parse failed: ${(err as Error).message}` }
  }
  if (!descriptor.template) return { ok: true, groups: [] }
  const templateStartLine = descriptor.template.loc.start.line
  const templateStartColumn = descriptor.template.loc.start.column

  let ast
  try {
    ast = parseTemplate(descriptor.template.content)
  } catch (err) {
    return { ok: false, reason: `Template parse failed: ${(err as Error).message}` }
  }

  const groups: ConditionalGroup[] = []
  const sfcPos = (node: ElementNode): { line: number; column: number } =>
    toSfcPosition(node.loc.start, templateStartLine, templateStartColumn)

  const structuralDirective = (el: ElementNode): { name: string; exp: string | null } | null => {
    for (const p of el.props) {
      if (
        p.type === NodeTypes.DIRECTIVE &&
        (p.name === 'if' || p.name === 'else-if' || p.name === 'else' || p.name === 'for')
      ) {
        const exp =
          p.exp && 'content' in p.exp && typeof p.exp.content === 'string'
            ? p.exp.content
            : null
        return { name: p.name, exp }
      }
    }
    return null
  }

  const isTemplateWrapper = (n: TemplateChildNode): n is ElementNode =>
    n.type === NodeTypes.ELEMENT && (n as ElementNode).tagType === TAG_TYPE_TEMPLATE

  const collectMemberLocs = (wrapper: ElementNode, out: ConditionalGroup['memberLocs']): void => {
    for (const child of wrapper.children) {
      if (child.type === NodeTypes.ELEMENT) out.push(sfcPos(child as ElementNode))
    }
  }

  const walk = (children: TemplateChildNode[]): void => {
    for (let i = 0; i < children.length; i++) {
      const node = children[i]
      if (node.type !== NodeTypes.ELEMENT) continue
      const el = node as ElementNode

      if (isTemplateWrapper(node)) {
        const dir = structuralDirective(el)
        if (dir && (dir.name === 'if' || dir.name === 'for')) {
          const group: ConditionalGroup = {
            head: sfcPos(el),
            directive: dir.name,
            expression: dir.exp,
            branches: [
              { directive: dir.name, expression: dir.exp, ...sfcPos(el) },
            ],
            memberLocs: [],
          }
          collectMemberLocs(el, group.memberLocs)
          // Consume consecutive paired branches (v-if groups only).
          let j = i + 1
          for (; dir.name === 'if' && j < children.length; j++) {
            const sib = children[j]
            if (sib.type !== NodeTypes.ELEMENT) continue // whitespace/comments
            if (!isTemplateWrapper(sib)) break
            const sibEl = sib as ElementNode
            const sibDir = structuralDirective(sibEl)
            if (!sibDir || (sibDir.name !== 'else' && sibDir.name !== 'else-if')) break
            group.branches.push({
              directive: sibDir.name,
              expression: sibDir.exp,
              ...sfcPos(sibEl),
            })
            collectMemberLocs(sibEl, group.memberLocs)
          }
          groups.push(group)
          // Recurse into every branch's subtree for nested groups, then
          // skip past the consumed branches.
          walk(el.children)
          for (let k = i + 1; k < j; k++) {
            const consumed = children[k]
            if (consumed.type === NodeTypes.ELEMENT) walk((consumed as ElementNode).children)
          }
          i = j - 1
          continue
        }
      }
      walk(el.children)
    }
  }
  walk(ast.children)

  return { ok: true, groups }
}

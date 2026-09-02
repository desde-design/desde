/**
 * Companion heuristic for `applySlotTextEdit`. When the bridge captures a
 * designer text edit on rendered DOM text that's actually produced by a
 * component *prop* (e.g. `<KEmptyState title="No data plane nodes" />`,
 * where the title text is rendered inside KEmptyState's template, not as
 * an SFC slot child), the slot-text applicator refuses — there's no
 * matching TEXT child at the host element. The mutation then drags the
 * entire batch into the LLM lane via the all-or-nothing fast-path rule.
 *
 * This function lets the fast-path recover the common case: locate the
 * element at `(line, column)`, scan its **static** attributes, and if
 * exactly one attribute's trimmed value equals `before.trim()`, return
 * that attribute's name. The caller then re-runs the mutation through
 * `applyPropEdit` with the inferred propName.
 *
 * Safety:
 *  - **No bound directives anywhere on the element.** If the element
 *    carries ANY `v-bind` (`:foo="…"`, `:[name]="…"`, `v-bind="…"`) or
 *    `v-model` directive, refuse outright. A binding's runtime value
 *    may equal `before`, in which case the *actual* text source is the
 *    bound prop — but the heuristic can only see static attrs, so it
 *    could otherwise pick an unrelated static attr (e.g. `aria-label`)
 *    as the text source and silently rewrite that instead of the real
 *    binding. Conservative refusal here keeps the LLM lane as the
 *    arbiter of bound text sources.
 *  - **Static attributes only.** Even within an unbound element, only
 *    `NodeTypes.ATTRIBUTE` props are scanned — directives are never
 *    rewritten.
 *  - **Single-match requirement.** Zero or 2+ matches refuse, preserving
 *    fast-path safety. If two attributes share the same value the
 *    correct attribute is ambiguous and the LLM (with broader context)
 *    is the right tool.
 *  - **Pure — no I/O.** Same contract as the other applicators in this
 *    directory.
 */

import { NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'

export interface InferAttrFromTextEditInput {
  /** Full SFC source text. */
  source: string
  /** 1-based line within the SFC (the same coords `data-desde-src` carries). */
  line: number
  /** 1-based column within the SFC. */
  column: number
  /** The rendered text the bridge captured before the designer's edit. */
  before: string
}

export type InferAttrFromTextEditResult =
  | { ok: true; propName: string }
  | { ok: false; reason: string }

interface ElementLike {
  type: number
  tag: string
  loc: { start: { line: number; column: number; offset: number } }
  props: Array<PropLike>
  children: Array<unknown>
}

interface AttributePropLike {
  type: typeof NodeTypes.ATTRIBUTE
  name: string
  value?: { content: string } | null
}

interface DirectivePropLike {
  type: typeof NodeTypes.DIRECTIVE
  name: string
}

type PropLike = AttributePropLike | DirectivePropLike

export function inferAttrFromTextEdit(
  input: InferAttrFromTextEditInput,
): InferAttrFromTextEditResult {
  const { source, line, column, before } = input

  const trimmedBefore = before.trim()
  if (trimmedBefore.length === 0) {
    return { ok: false, reason: 'before is empty after trimming' }
  }

  // Resolve the target element via the shared resolver (parse the SFC,
  // re-parse the template content, shift loc, exact-match walk).
  const resolved = resolveTemplateTarget({ source, line, column })
  if (!resolved.ok) {
    return { ok: false, reason: resolved.failure.reason }
  }
  const target = resolved.node as unknown as ElementLike

  // Refuse outright if the element carries any v-bind or v-model
  // directive. With a bound prop on the element the rendered text
  // source could be the binding's runtime value — but the inferrer
  // only inspects static attrs, so a happenstance match on an
  // unrelated static attr (e.g. `aria-label`) would silently rewrite
  // the wrong attribute. Falling through to the LLM keeps these cases
  // safe (codex P1 round-1).
  for (const prop of target.props) {
    if (prop.type !== NodeTypes.DIRECTIVE) continue
    const dir = prop as DirectivePropLike
    if (dir.name === 'bind' || dir.name === 'model') {
      return {
        ok: false,
        reason: `Refusing: <${target.tag}> has a v-${dir.name} directive. Rendered text source is ambiguous when bindings are present; deferring to LLM lane`,
      }
    }
  }

  const matches: string[] = []
  for (const prop of target.props) {
    if (prop.type !== NodeTypes.ATTRIBUTE) continue
    const attr = prop as AttributePropLike
    const value = attr.value?.content
    if (typeof value !== 'string') continue
    if (value.trim() === trimmedBefore) {
      matches.push(attr.name)
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      reason: `No static attribute on <${target.tag}> matches before (\`${truncate(trimmedBefore, 60)}\`)`,
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous: ${matches.length} static attributes on <${target.tag}> match before (\`${truncate(trimmedBefore, 60)}\`): ${matches.join(', ')}`,
    }
  }
  return { ok: true, propName: matches[0] }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

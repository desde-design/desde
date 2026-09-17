/**
 * Post-condition for the llm-patch LLM lane: a `text`/`attr` patch must not
 * introduce a NEW dynamic binding.
 *
 * Why this exists. The deterministic applicators splice a verified span, so
 * they can enforce inertness mechanically — `apply-jsx-slot-text-edit.ts` runs
 * the designer's text through `escapeJsxText` before it goes anywhere near the
 * file. The LLM lane cannot: the model authors the whole file, so the only
 * enforcement available is a check on what came back. A syntax parse is not
 * that check. `Add {n}` written verbatim into a JSXText position is perfectly
 * valid JSX that binds to a variable, and `{{ n }}` in a Vue template is the
 * same story — both parse clean, both silently convert the designer's literal
 * text into live state.
 *
 * The invariant. This lane accepts `text` and `attr` mutations only (`class`
 * and `style` are hard-refused upstream), and neither can require a new
 * binding site. Editing the literal scaffolding INSIDE an existing binding is
 * supported and keeps the count the same, so counting binding sites before and
 * after is both sufficient for the attack and safe for every documented case:
 *
 * - `Add {{ n > 0 ? '(N)' : '' }}` → `Add {{ n > 0 ? 'N' : '' }}` — one
 *   interpolation before, one after. Allowed.
 * - expanding a self-closing call-site, or adding a static prop the call-site
 *   did not pass — no binding site either way. Allowed.
 * - `Add (3)` → the model emits `Add {n}` — zero before, one after. REFUSED.
 * - `title="x"` → the model emits `title={x}` — REFUSED.
 *
 * Counting, not identity-matching, is deliberate. A swap (one binding removed,
 * another added) keeps the count equal and slips through. That is accepted: the
 * cheap structural check buys the whole class of *additions* without any risk
 * of refusing a legitimate patch, and a swap still has to survive the parse
 * gate and the per-mutation outcome validation. A residual gap this does NOT
 * close is entity round-tripping — a designer who types the literal text
 * `&lt;b&gt;` needs `&amp;lt;b&amp;gt;` in JSX, and only the prompt asks for
 * that.
 *
 * Symmetric across both dialects on purpose. A guard that held for React and
 * not Vue would be the same shape of asymmetry that left this lane Vue-only in
 * the first place.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'

import { parseJsxModule, walkJsx, type JsxNode } from './resolve-jsx-target'
import { resolvePatchFramework } from './patch-framework'

export interface FindNewDynamicBindingInput {
  /** Repo-relative path — selects the dialect. */
  file: string
  /** The file as it was before the patch. */
  original: string
  /** The file the model returned. */
  patched: string
}

export type FindNewDynamicBindingResult =
  /** No new binding site. `null` reason means the file was clean. */
  | { ok: true }
  /** A new binding site appeared; `reason` is caller-facing. */
  | { ok: false; reason: string }

/**
 * Compare binding-site counts across the patch. Returns `{ ok: true }` when the
 * patch added none, and when the dialect or either source can't be counted —
 * failing OPEN is correct here because this runs after the strict parse gate,
 * and an uncountable file is a gate problem, not a finding of this check.
 */
export function findNewDynamicBinding(
  input: FindNewDynamicBindingInput,
): FindNewDynamicBindingResult {
  const { file, original, patched } = input
  const framework = resolvePatchFramework(file)
  const count = framework === 'react' ? countJsxBindings : framework === 'vue' ? countVueBindings : null
  if (!count) return { ok: true }

  const before = count(original)
  const after = count(patched)
  if (before === null || after === null) return { ok: true }
  if (after <= before) return { ok: true }

  return {
    ok: false,
    reason:
      `Patched source for '${file}' introduces ${after - before} new dynamic ` +
      `binding(s) (${before} → ${after}). A text or attribute edit never needs one — ` +
      `the designer's literal text was most likely written as live code instead of ` +
      `inert text. Refusing rather than writing it.`,
  }
}

/**
 * JSX expression containers — the one node type covering both a `{expr}` child
 * and an `attr={expr}` value. `parseJsxModule` runs with `errorRecovery`, which
 * is right for counting: the strict gate has already rejected genuinely broken
 * output, and a recovered parse still counts the containers it found.
 */
function countJsxBindings(source: string): number | null {
  const parsed = parseJsxModule(source)
  if (!parsed.ok) return null
  let n = 0
  walkJsx(parsed.ast as JsxNode, (node) => {
    if (node.type === 'JSXExpressionContainer') n += 1
  })
  return n
}

/**
 * Vue template interpolations (`{{ … }}`) plus directive props. Directives are
 * counted too because Vue's dynamic-attribute form is a directive (`:title`,
 * `v-model`) rather than an expression node — without them the React side
 * would catch `title={x}` while the Vue side missed `:title="x"`.
 *
 * `<script>` is not counted: the lane patches markup, and a legitimate patch
 * has no reason to touch script bindings.
 */
function countVueBindings(source: string): number | null {
  interface VueNode {
    type: number
    children?: unknown
    props?: unknown
  }
  let ast: VueNode
  try {
    const { descriptor, errors } = parseSfc(source)
    if (errors.length > 0 || !descriptor.template) return null
    ast = parseTemplate(descriptor.template.content) as unknown as VueNode
  } catch {
    return null
  }

  let n = 0
  const visit = (node: VueNode | null | undefined): void => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'number') return
    if (node.type === NodeTypes.INTERPOLATION) n += 1
    if (Array.isArray(node.props)) {
      for (const prop of node.props as VueNode[]) {
        if (prop && prop.type === NodeTypes.DIRECTIVE) n += 1
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children as VueNode[]) visit(child)
    }
  }
  visit(ast)
  return n
}

/**
 * Pure (filesystem-free) inline style/class applicator for React/JSX — the
 * `.tsx`/`.jsx` analog of the Vue [apply-scoped-css-override-edit.ts](./apply-scoped-css-override-edit.ts).
 *
 * **Why this exists.** The Vue styling lane writes a rule into the consumer
 * SFC's `<style scoped>` block (`:deep()` + `data-desde-src` selector). React has
 * no universal `<style scoped>` equivalent, so an inline restyle must land in
 * the substrate's own idiom. This applicator emits one of two shapes, chosen by
 * the request's `mode` (the shell picks it from the detected styling system —
 * see `editor-cli/src/server/styling-system-detection.ts`):
 *
 *   - **`classname`** — merge Tailwind utility class names into the element's
 *     `className` string (the Onlook approach: clean, no style bloat). Used when
 *     the substrate is Tailwind. Conflicting utilities (`border-b-2` vs
 *     `border-b-4`) are resolved by `tailwind-merge`, so a "change this value"
 *     edit replaces rather than stacks.
 *   - **`inline`** — merge CSS declarations into a JSX `style={{ … }}` object
 *     (per-property idempotent: set/update/remove keys). Universal fallback for
 *     any React app regardless of styling system.
 *
 * **Coordinate convention:** Babel coords — 1-based line, 0-based column (what
 * `jsx-source-tag-plugin.ts` stamps into `data-desde-src` and the bridge surfaces
 * as `editTarget`). Matches [apply-jsx-prop-edit.ts](./apply-jsx-prop-edit.ts).
 *
 * **Additive semantics (matches the Vue lane).** Like `scoped-css-override`,
 * this is additive-first. A pure *clear* (remove a property with no replacement)
 * is expressible via `removeClasses` / `removeDeclarations`, but the common edit
 * is "set/change a value." Both modes refuse a true no-op so the handler's
 * batch-level no-op-write guard is never reached with an unchanged file.
 *
 * **Refusals.**
 *   - `className` / `style` bound to a non-literal expression
 *     (`className={cn(...)}`, `style={base}`) → `bound-binding` fallback (a
 *     deterministic splice would clobber the binding; the LLM lane can trace it).
 *   - element carrying a `{...spread}` and missing the target attr → `dynamic-vbind`
 *     (the spread may supply `className`/`style`).
 *   - an existing `style` object with a spread or computed/complex property →
 *     refuse (can't safely rebuild).
 */

import { twMerge } from "tailwind-merge"

import {
  parseJsxModule,
  findJsxOpeningElementAt,
  type JsxNode,
} from "./resolve-jsx-target"

/**
 * Typed refusal hint for the jsx-style lane — the sibling of
 * `PropEditFallbackHint` (`apply-prop-edit.ts`), kept SEPARATE because the two
 * route to different places in the dispatcher: a `PropEditFallbackHint` engages
 * the source-aware agent mini-turn, while a jsx-style refusal has no
 * deterministic or prompt-shaped repair (the mini-turn's prompt is prop/text
 * shaped, not a className composition) and must surface an actionable
 * "adjust it via chat" refusal instead.
 *
 * Before audit Task 23 the dispatcher inferred that routing from
 * `body.edit.kind === 'jsx-style'` (plus a truthy `fallback`) and appended a
 * hardcoded reason-string suffix. Carrying `lane: 'jsx-style'` on the hint
 * makes the refusal self-describing: the dispatcher routes on the TYPE, so a
 * future applicator that wants this treatment opts in by emitting the hint
 * rather than by the dispatcher growing another kind check.
 *
 * Routing delta from that change: a refusal hint that does NOT carry
 * `lane: 'jsx-style'` now yields a plain 422 without the "adjust it via chat"
 * guidance, where the old kind-based check would have added it. All five
 * production refusal sites below stamp `lane`, so this is inert in practice —
 * but `loadApplyJsxStyleEdit` is an injection seam, so an alternative or
 * stubbed applicator must stamp it to get the guidance.
 *
 * Kinds mirror the prop lane's vocabulary:
 *  - `bound-binding`: `className={cn(…)}` / `style={base}` — a non-literal
 *    expression a deterministic splice would clobber.
 *  - `dynamic-vbind`: a `{...spread}` that may supply or override the attr.
 */
export type JsxStyleFallbackHint = { lane: "jsx-style" } & (
  | { kind: "bound-binding"; attribute: "className" | "style"; expression: string }
  | { kind: "dynamic-vbind"; attribute: "className" | "style" }
)

/** Type guard the dispatcher uses to tell a jsx-style hint from a prop hint. */
export function isJsxStyleFallbackHint(
  hint: { kind: string } | undefined,
): hint is JsxStyleFallbackHint {
  return !!hint && (hint as { lane?: unknown }).lane === "jsx-style"
}

export interface ApplyJsxStyleEditInput {
  /** Full `.tsx`/`.jsx` source text. */
  source: string
  /** 1-based line of the element's opening tag (Babel `loc.start.line`). */
  line: number
  /** 0-based column of the element's opening tag (Babel `loc.start.column`). */
  column: number
  /** Output shape — see module header. */
  mode: "classname" | "inline"
  /** `classname` mode: Tailwind utility classes to add to `className`. */
  addClasses?: readonly string[]
  /** `classname` mode: classes to remove from `className`. */
  removeClasses?: readonly string[]
  /** `inline` mode: CSS declarations to set (kebab-case property → value). */
  declarations?: Readonly<Record<string, string>>
  /** `inline` mode: CSS properties to remove from `style` (kebab-case). */
  removeDeclarations?: readonly string[]
}

export type ApplyJsxStyleEditResult =
  | { ok: true; source: string }
  | { ok: false; reason: string; fallback?: JsxStyleFallbackHint }

/** Class/property tokens we accept — guards against splicing arbitrary chars
 *  into source. Covers utilities, arbitrary-value syntax (`border-b-[3px]`),
 *  variants (`hover:bg-red-500`), and negatives (`-mt-2`). */
const SAFE_CLASS_RE = /^-?[A-Za-z0-9_:/[\].,%#()!-]+$/
/** Kebab-case CSS property names (incl. custom props `--foo`). */
const SAFE_CSS_PROP_RE = /^-{0,2}[a-z][a-z0-9-]*$/

/** Local extension of the shared node shape: attribute- and object-literal-
 *  level fields the style splice reads as typed nodes. */
interface BabelNode extends JsxNode {
  name?: BabelNode | string
  typeParameters?: BabelNode
  attributes?: BabelNode[]
  value?: BabelNode | null
  expression?: BabelNode
  properties?: BabelNode[]
  key?: BabelNode
  computed?: boolean
}

export function applyJsxStyleEdit(
  input: ApplyJsxStyleEditInput,
): ApplyJsxStyleEditResult {
  const { source, line, column, mode } = input

  const parsed = parseJsxModule(source)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const ast = parsed.ast as BabelNode

  const target = findJsxOpeningElementAt(ast, line, column) as BabelNode | null
  if (!target) {
    return { ok: false, reason: `No JSX element found at ${line}:${column}` }
  }

  return mode === "classname"
    ? applyClassNameMode(source, target, input)
    : applyInlineStyleMode(source, target, input)
}

// ── classname mode ───────────────────────────────────────────────────

function applyClassNameMode(
  source: string,
  target: BabelNode,
  input: ApplyJsxStyleEditInput,
): ApplyJsxStyleEditResult {
  const addClasses = (input.addClasses ?? []).filter((c) => c.length > 0)
  const removeClasses = new Set((input.removeClasses ?? []).filter(Boolean))
  if (addClasses.length === 0 && removeClasses.size === 0) {
    return { ok: false, reason: "classname edit has no classes to add or remove" }
  }
  for (const c of [...addClasses, ...removeClasses]) {
    if (!SAFE_CLASS_RE.test(c)) {
      return { ok: false, reason: `Unsafe class name "${c}"` }
    }
  }

  const attrs = target.attributes ?? []
  const existing = attrs.find(
    (a) => a.type === "JSXAttribute" && attrName(a) === "className",
  )
  const hasSpread = attrs.some((a) => a.type === "JSXSpreadAttribute")

  // Resolve the current className string literal (or "" when absent).
  let currentValue: string | null = null
  if (existing) {
    const valNode = existing.value ?? null
    if (valNode == null) {
      // boolean-shorthand `className` — degenerate; treat as empty string slot.
      currentValue = ""
    } else if (valNode.type === "StringLiteral") {
      currentValue = stringLiteralValue(source, valNode)
    } else if (valNode.type === "JSXExpressionContainer") {
      const expr = valNode.expression
      if (expr?.type === "StringLiteral") {
        currentValue = stringLiteralValue(source, expr)
      } else {
        // className={cn(...)} / className={styles.x} — non-literal binding.
        const expression =
          expr && typeof expr.start === "number" && typeof expr.end === "number"
            ? source.slice(expr.start, expr.end)
            : ""
        return {
          ok: false,
          reason: `className is bound to an expression ({${expression}}); a deterministic splice would clobber the binding.`,
          fallback: {
            lane: "jsx-style",
            kind: "bound-binding",
            attribute: "className",
            expression,
          },
        }
      }
    } else {
      return { ok: false, reason: `Unsupported className value node: ${valNode.type}` }
    }
  }

  const nextValue = mergeClassNames(currentValue ?? "", addClasses, removeClasses)
  if (currentValue !== null && nextValue === currentValue) {
    return { ok: false, reason: "className is unchanged. No edit needed." }
  }
  if (currentValue === null && nextValue.length === 0) {
    return { ok: false, reason: "Nothing to add to className." }
  }

  if (existing) {
    // A spread after className can override it at runtime → editing the literal
    // would be silently inert. Refuse rather than report a no-effect success.
    if (hasSpreadAfter(attrs, existing)) {
      return {
        ok: false,
        reason: `className has a {...spread} after it that may override the edit at runtime.`,
        fallback: { lane: "jsx-style", kind: "dynamic-vbind", attribute: "className" },
      }
    }
    return spliceAttrStringValue(source, existing, nextValue)
  }
  if (hasSpread) {
    return {
      ok: false,
      reason: `Element has a {...spread}; can't statically set className (the spread may supply it).`,
      fallback: { lane: "jsx-style", kind: "dynamic-vbind", attribute: "className" },
    }
  }
  return insertAttr(source, target, `className="${escapeAttr(nextValue)}"`)
}

/** Remove `removeClasses`, append `addClasses`, then let tailwind-merge resolve
 *  any remaining same-property conflicts (so "change a value" replaces rather
 *  than stacks `border-b-2 border-b-4`). Whitespace is normalized to single
 *  spaces. */
function mergeClassNames(
  current: string,
  addClasses: readonly string[],
  removeClasses: ReadonlySet<string>,
): string {
  const kept = current.split(/\s+/).filter((c) => c.length > 0 && !removeClasses.has(c))
  const combined = [...kept, ...addClasses].join(" ")
  return twMerge(combined).trim()
}

// ── inline style mode ────────────────────────────────────────────────

function applyInlineStyleMode(
  source: string,
  target: BabelNode,
  input: ApplyJsxStyleEditInput,
): ApplyJsxStyleEditResult {
  const declarations = input.declarations ?? {}
  const removeDeclarations = new Set(
    (input.removeDeclarations ?? []).filter(Boolean),
  )
  const setEntries = Object.entries(declarations).filter(([, v]) => v != null)
  if (setEntries.length === 0 && removeDeclarations.size === 0) {
    return { ok: false, reason: "inline style edit has no declarations to set or remove" }
  }
  for (const [prop] of setEntries) {
    if (!SAFE_CSS_PROP_RE.test(prop)) {
      return { ok: false, reason: `Unsafe CSS property "${prop}"` }
    }
  }
  for (const prop of removeDeclarations) {
    if (!SAFE_CSS_PROP_RE.test(prop)) {
      return { ok: false, reason: `Unsafe CSS property "${prop}"` }
    }
  }

  // Merge into an ordered [camelKey, valueText] list so existing properties
  // keep their position; set/replace matched keys; drop removed keys; append
  // new ones at the end.
  const setMap = new Map<string, string>(
    setEntries.map(([prop, value]) => [cssPropToCamel(prop), value]),
  )
  const removeSet = new Set([...removeDeclarations].map(cssPropToCamel))

  const attrs = target.attributes ?? []
  const existing = attrs.find(
    (a) => a.type === "JSXAttribute" && attrName(a) === "style",
  )
  const hasSpread = attrs.some((a) => a.type === "JSXSpreadAttribute")

  // A spread after an existing `style` can override it at runtime → editing the
  // object would be silently inert. Refuse rather than report a no-op success.
  if (existing && hasSpreadAfter(attrs, existing)) {
    return {
      ok: false,
      reason: `style has a {...spread} after it that may override the edit at runtime.`,
      fallback: { lane: "jsx-style", kind: "dynamic-vbind", attribute: "style" },
    }
  }

  const ordered: Array<[string, string]> = []
  const seen = new Set<string>()

  if (existing) {
    const valNode = existing.value ?? null
    const objExpr =
      valNode?.type === "JSXExpressionContainer" &&
      valNode.expression?.type === "ObjectExpression"
        ? valNode.expression
        : null
    if (valNode != null && objExpr == null) {
      // style={base} or style="..." — non-object-literal binding.
      const expr =
        valNode.type === "JSXExpressionContainer" ? valNode.expression : undefined
      const expression =
        expr && typeof expr.start === "number" && typeof expr.end === "number"
          ? source.slice(expr.start, expr.end)
          : ""
      return {
        ok: false,
        reason: `style is bound to a non-object expression; a deterministic splice would clobber it.`,
        fallback: {
          lane: "jsx-style",
          kind: "bound-binding",
          attribute: "style",
          expression,
        },
      }
    }
    if (objExpr) {
      for (const prop of objExpr.properties ?? []) {
        if (prop.type !== "ObjectProperty" || prop.computed) {
          return {
            ok: false,
            reason: "style object has a spread or computed property; can't safely rebuild it.",
          }
        }
        const keyName = objectKeyName(prop.key)
        const valNode2 = prop.value as BabelNode | undefined
        if (keyName == null || !valNode2 || typeof valNode2.start !== "number") {
          return { ok: false, reason: "style object has an unreadable property." }
        }
        if (removeSet.has(keyName)) continue // drop
        seen.add(keyName)
        const valueText = setMap.has(keyName)
          ? renderStyleValue(setMap.get(keyName)!)
          : source.slice(valNode2.start, valNode2.end as number)
        ordered.push([objectKeyName(prop.key, /*raw*/ true) ?? keyName, valueText])
      }
    }
  }

  // Append any set keys not already present (preserving declaration order).
  for (const [camelKey, value] of setMap) {
    if (seen.has(camelKey)) continue
    ordered.push([renderObjectKey(camelKey), renderStyleValue(value)])
  }

  // Clearing the last property: an existing `style` object reduced to zero keys
  // is removed entirely (the honest result of a pure `removeDeclarations`). With
  // no existing attribute, an empty result means there was nothing to do.
  if (ordered.length === 0) {
    if (
      existing &&
      typeof existing.start === "number" &&
      typeof existing.end === "number"
    ) {
      // Consume the single separating space before the attribute so we don't
      // leave `<div  >`. The opening tag always has a tag name before the
      // first attribute, so start>0 and a leading space is expected.
      const from =
        existing.start > 0 && source[existing.start - 1] === " "
          ? existing.start - 1
          : existing.start
      const next = splice(source, from, existing.end, "")
      if (next === source) {
        return { ok: false, reason: "style is unchanged. No edit needed." }
      }
      return { ok: true, source: next }
    }
    return { ok: false, reason: "Nothing to set on style." }
  }

  const objLiteral = `{ ${ordered.map(([k, v]) => `${k}: ${v}`).join(", ")} }`
  const newAttrText = `style={${objLiteral}}`

  if (existing) {
    if (typeof existing.start !== "number" || typeof existing.end !== "number") {
      return { ok: false, reason: "could not locate style attribute range" }
    }
    const next = splice(source, existing.start, existing.end, newAttrText)
    if (next === source) {
      return { ok: false, reason: "style is unchanged. No edit needed." }
    }
    return { ok: true, source: next }
  }
  if (hasSpread) {
    return {
      ok: false,
      reason: `Element has a {...spread}; can't statically set style (the spread may supply it).`,
      fallback: { lane: "jsx-style", kind: "dynamic-vbind", attribute: "style" },
    }
  }
  return insertAttr(source, target, newAttrText)
}

// ── shared helpers ───────────────────────────────────────────────────

/** A JSX `style={{}}` value is a JavaScript string, not an HTML attribute — use
 *  JS-string escaping (JSON.stringify). HTML escaping would corrupt CSS values
 *  that are valid but contain quotes/backslashes, e.g.
 *  `background-image: url("/hero.png")` or a quoted font-family. */
function renderStyleValue(value: string): string {
  return JSON.stringify(value)
}

/** camelCase identifier keys are emitted bare; anything else (custom props,
 *  reserved) is quoted as a JS string. */
function renderObjectKey(camelKey: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(camelKey)
    ? camelKey
    : JSON.stringify(camelKey)
}

/** kebab-case CSS property → camelCase JS key. Leaves custom props (`--foo`)
 *  intact (they stay quoted via renderObjectKey). */
function cssPropToCamel(prop: string): string {
  if (prop.startsWith("--")) return prop
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** The object-property key as a string. `raw=true` returns the source-faithful
 *  key text (so a quoted `"--foo"` key round-trips); otherwise the bare name. */
function objectKeyName(key: BabelNode | undefined, raw = false): string | null {
  if (!key) return null
  if (key.type === "Identifier" && typeof key.name === "string") return key.name
  if (key.type === "StringLiteral") {
    const v = (key as { value?: unknown }).value
    if (typeof v !== "string") return null
    return raw ? `"${v}"` : v
  }
  return null
}

function stringLiteralValue(source: string, node: BabelNode): string {
  // Use the AST's decoded value when present; fall back to slicing the literal
  // body (minus quotes) so we never re-encode entities.
  const v = (node as { value?: unknown }).value
  if (typeof v === "string") return v
  if (typeof node.start === "number" && typeof node.end === "number") {
    return source.slice(node.start + 1, node.end - 1)
  }
  return ""
}

/** Replace a JSXAttribute's value with a quoted string literal (string-literal
 *  or expression-container-wrapped-literal value), or append `="x"` to a
 *  boolean-shorthand attr. */
function spliceAttrStringValue(
  source: string,
  attr: BabelNode,
  nextValue: string,
): ApplyJsxStyleEditResult {
  const valNode = attr.value ?? null
  const rendered = `"${escapeAttr(nextValue)}"`
  if (valNode == null) {
    const nameEnd = (attr.name as BabelNode)?.end
    if (typeof nameEnd !== "number") {
      return { ok: false, reason: "could not locate attribute name end" }
    }
    return okOrNoop(source, splice(source, nameEnd, nameEnd, `=${rendered}`))
  }
  if (typeof valNode.start !== "number" || typeof valNode.end !== "number") {
    return { ok: false, reason: "could not locate attribute value range" }
  }
  return okOrNoop(source, splice(source, valNode.start, valNode.end, rendered))
}

function insertAttr(
  source: string,
  target: BabelNode,
  attrText: string,
): ApplyJsxStyleEditResult {
  const tagNameEnd = (target.name as BabelNode)?.end
  const typeParamsEnd = (target.typeParameters as BabelNode | undefined)?.end
  const insertAt = typeof typeParamsEnd === "number" ? typeParamsEnd : tagNameEnd
  if (typeof insertAt !== "number") {
    return { ok: false, reason: "could not locate opening-tag name end" }
  }
  return okOrNoop(source, splice(source, insertAt, insertAt, ` ${attrText}`))
}

function okOrNoop(source: string, next: string): ApplyJsxStyleEditResult {
  if (next === source) {
    return { ok: false, reason: "Edit produced no change. No edit needed." }
  }
  return { ok: true, source: next }
}

/** JSX string-attribute escaping: `&` and `"` only. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/** A `{...spread}` positioned AFTER `target` in source order can override the
 *  target attribute at runtime (JSX applies attributes left-to-right), so a
 *  literal edit to `target` may render no effect. Attributes are in source
 *  order in the array. (A spread BEFORE the target is itself overridden by the
 *  later literal — safe to edit.) */
function hasSpreadAfter(attrs: readonly BabelNode[], target: BabelNode): boolean {
  const idx = attrs.indexOf(target)
  if (idx < 0) return false
  for (let i = idx + 1; i < attrs.length; i++) {
    if (attrs[i].type === "JSXSpreadAttribute") return true
  }
  return false
}

function attrName(attr: BabelNode): string | null {
  const n = attr.name
  if (!n || typeof n === "string") return typeof n === "string" ? n : null
  const inner = (n as BabelNode).name
  return typeof inner === "string" ? inner : null
}

function splice(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + text + source.slice(end)
}

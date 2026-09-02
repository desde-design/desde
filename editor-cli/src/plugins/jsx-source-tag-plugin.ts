import { parse } from "@babel/parser"
import type { Plugin } from "vite"
import { resolveStampPolicy, stampPathFor, type StampScope } from "../hosts/stamp-policy.js"
// From its own Vue-free module, NOT from `./source-tag-plugin` (the Vue
// stamper), which module-scope imports `@vue/compiler-sfc`. See the comment on
// `sourceVersionOf` — this import is what keeps the React lane loadable in a
// project that has no Vue installed.
import { sourceVersionOf } from "./source-version.js"
import { classifyTransformInput, reportStampProblem } from "./transform-input.js"

/**
 * Which files this stamper may annotate, and what `data-desde-src` paths are
 * relative to — the same {@link StampScope} the Vue stamper takes, so the two
 * lanes cannot diverge on containment. `hosts/stamp-policy.ts` has the rule.
 */
export type JsxSourceTagPluginOptions = StampScope

/**
 * Vite plugin that stamps every JSX element in a `.tsx`/`.jsx` module with
 * `data-desde-src="<file>:<line>:<col>"` — the React analog of
 * [source-tag-plugin.ts](./source-tag-plugin.ts) for Vue SFCs. The editor
 * bridge reads this attribute at inspect time (a framework-agnostic DOM walk in
 * `attributeElement`) and surfaces `editTarget` / `authoredAt`, so clicking a
 * React element resolves to its source location.
 *
 * Why a build-time DOM-attribute stamp instead of fiber introspection: React 19
 * removed `fiber._debugSource`, so the Vue-style "read the callsite off the
 * runtime instance" path returns null on modern React. A `data-*` attribute is
 * version-independent (React passes `data-*` through to host-element DOM
 * untouched) and is exactly what the Vue lane already relies on. See
 * tasks/editor-react-support.md § M1.
 *
 * Implementation mirrors the Vue plugin: parse with `@babel/parser` (jsx +
 * typescript), walk for every `JSXOpeningElement`, and splice the attribute in
 * right after the tag name — EXCEPT on an element carrying a `{...spread}`,
 * where it goes after the last attribute so a forwarded `data-desde-src` in the
 * spread can't clobber the element's own callsite stamp (later-key-wins).
 * Insertions are applied descending-by-offset so each splice doesn't shift the
 * un-applied ones.
 *
 * Coordinate convention: Babel reports 1-based lines and **0-based** columns
 * (Vue's compiler is 1-based on both). Each framework lane is internally
 * consistent — the React stamp is written by Babel here and re-read by Babel in
 * the JSX applicators (M2) — and the bridge's `parseSourceTag` is base-agnostic
 * (it just splits "file:line:col"). So the 0-based column is intentional, not a
 * bug to "fix" against the Vue lane.
 *
 * Stamps BOTH host elements (`<div>`) and component elements (`<Foo>`). On a
 * host element the `data-*` attribute reaches the DOM (what the bridge walks);
 * on a component it's an inert prop unless the component spreads it — same
 * graceful behavior as a Vue component without attribute inheritance. Fragments
 * (`<>…</>`) have no opening element name and are naturally skipped.
 */
export function jsxSourceTagPlugin(opts: JsxSourceTagPluginOptions): Plugin {
  // Resolved once at construction: the policy is immutable and `transform` runs
  // per module, per HMR round.
  const policy = resolveStampPolicy(opts)
  return {
    name: "@desde/editor-jsx-source-tag-plugin",
    enforce: "pre",
    transform(code, id) {
      // Strip Vite's query suffix (`?foo`) before the extension check —
      // dependency-optimizer / HMR requests can append one.
      const cleanId = id.split("?")[0]
      if (!cleanId.endsWith(".tsx") && !cleanId.endsWith(".jsx")) return null

      // Root containment + segment-exact denial + the emitted path, from ONE
      // call — see the same block in `source-tag-plugin.ts` and the rule in
      // `hosts/stamp-policy.ts`. Runs before the parse: refusing a file is
      // strictly cheaper than parsing it first.
      const filePath = stampPathFor(policy, cleanId)
      if (filePath === null) return null

      const tsx = cleanId.endsWith(".tsx")
      const ast = parseJsx(code, tsx)
      // A genuine parse failure — Vite will surface the real syntax error via
      // its own pipeline; we just decline to stamp.
      if (ast === null) return null

      // Are these the AUTHORED bytes? A `data-desde-src` is a claim about the file
      // on disk, and an earlier `enforce: "pre"` plugin (`vite:react-babel` is
      // one) makes `code` something else entirely — see `transform-input.ts`
      // for the measurement. When it has been rewritten, coordinates come from
      // the authored parse and only the SPLICE offsets come from this one.
      const input = classifyTransformInput(code, cleanId)
      const insertions =
        input.kind === "rewritten"
          ? realignJsxInsertions({ ast, code, authored: input.authored, filePath, tsx, cleanId })
          : collectInsertions(ast, filePath, sourceVersionOf(code))

      if (insertions === null || insertions.length === 0) return null

      const updated = applyInsertions(code, insertions)
      if (updated === code) return null
      return { code: updated, map: null }
    },
  }
}

/**
 * Parse for stamping, or `null` if the source will not parse.
 *
 * `.tsx` needs the typescript plugin; `.jsx` must NOT enable it (a plain-JS
 * file may use syntax the TS parser rejects, e.g. the `<T,>` arrow-generic
 * disambiguation that only exists in TS).
 */
function parseJsx(source: string, tsx: boolean): BabelFile | null {
  try {
    return parse(source, {
      sourceType: "module",
      plugins: tsx ? ["jsx", "typescript"] : ["jsx"],
      errorRecovery: true,
    }) as unknown as BabelFile
  } catch {
    return null
  }
}

/**
 * Stamp AUTHORED coordinates onto a module some earlier plugin already
 * rewrote.
 *
 * Both sources are parsed and their JSX opening elements paired BY POSITION in
 * the walk, then checked pairwise by tag name. Each emitted stamp takes its
 * `line:col` from the authored element and its splice offset from the rewritten
 * one, so the attribute lands in the served DOM while naming the place the user
 * would have to edit. `data-desde-v` likewise hashes the authored bytes, which is
 * the only thing `edit-handler.ts`'s stale-target guard can usefully compare
 * against on-disk content.
 *
 * WHY PAIR BY POSITION AND NOT BY OFFSET. The rewriting transform is free to
 * reformat: MEASURED on `@vitejs/plugin-react` v4, `</main>\n  );` comes back
 * as `</main>);` and a hook-using component gains an inline `_s();`, so the
 * authored bytes are not even a contiguous substring of the output. What such a
 * transform does NOT do is add, remove or rename JSX elements — so the walk
 * order is an exact correspondence while byte arithmetic is not.
 *
 * REFUSES (returns null) the moment that correspondence is in doubt: a parse
 * failure on either side, a different element count, or a single tag-name
 * disagreement. A refusal costs the file its stamps and makes it inspect-only,
 * which is loud and recoverable; guessing costs the user an edit applied to an
 * element they never clicked, which is neither.
 */
function realignJsxInsertions(opts: {
  /** Already-parsed AST of the rewritten `code` — reused, not re-parsed. */
  ast: BabelFile
  code: string
  authored: string
  filePath: string
  tsx: boolean
  cleanId: string
}): Insertion[] | null {
  const refuse = (why: string): null => {
    reportStampProblem(
      opts.cleanId,
      {
        file: opts.filePath,
        outcome: "inspect-only",
        // One clause, because the boot summary gives each file one line. The
        // full prose below — including the plugin-version advice — still prints
        // in its own right; this is the version that fits a list.
        detail: `another Vite plugin rewrote it before Editor could stamp it, and the result could not be realigned onto the authored source (${why})`,
      },
      `[stamp] ${opts.filePath} is transformed by another Vite plugin before Editor can stamp it, ` +
        `and the result could not be realigned onto the authored source (${why}). This file stays ` +
        "inspect-only: its elements are selectable but edits to them are refused, because a stamp " +
        "computed from transformed source would name the wrong element. If the plugin is " +
        "`@vitejs/plugin-react`, upgrading to v6 removes the rewrite. v5 still rewrites.",
    )
    return null
  }

  const authoredAst = parseJsx(opts.authored, opts.tsx)
  if (authoredAst === null) return refuse("the authored source did not parse")

  const authoredEls = collectElements(authoredAst)
  const codeEls = collectElements(opts.ast)
  if (authoredEls.length !== codeEls.length) {
    return refuse(
      `the transform changed the element count (${authoredEls.length} authored, ${codeEls.length} after)`,
    )
  }

  const sourceVersion = sourceVersionOf(opts.authored)
  const out: Insertion[] = []
  for (let i = 0; i < codeEls.length; i++) {
    const authoredEl = authoredEls[i]
    const codeEl = codeEls[i]
    if (authoredEl.tag !== codeEl.tag) {
      return refuse(`element ${i} is <${authoredEl.tag}> authored but <${codeEl.tag}> after`)
    }
    // Idempotency and the outlet skip are decided on the side being spliced.
    if (codeEl.skip || codeEl.alreadyStamped) continue
    out.push(
      ...insertionsForElement(codeEl.insertOffset, opts.filePath, sourceVersion, {
        line: authoredEl.line,
        column: authoredEl.column,
      }),
    )
  }
  return out
}

interface Insertion {
  /** Absolute offset within the module source. */
  offset: number
  /** String to insert at `offset`. */
  text: string
}

/**
 * Stamp JSX that lives INSIDE another file — today, a Vue SFC's
 * `<script setup lang="tsx">` block.
 *
 * WHY THIS EXISTS. Such JSX was stamped by nobody: the Vue plugin only walks
 * `descriptor.template.ast`, and this plugin bails on any id that is not
 * `.tsx`/`.jsx`, which a `.vue` never is. Measured on the dogfood Vue subject:
 * 1 stamp in a `<script setup lang="tsx">` component against 24 in a
 * template-based sibling. Without a stamp the bridge cannot map a click to
 * source, so the Editor is inspect-only there and refuses every edit.
 *
 * Returns insertions in the OUTER file's coordinates, so the caller can merge
 * them with its own and apply a single pass.
 *
 * COORDINATE CONVENTION — a `.vue` ends up carrying TWO, deliberately.
 * Stamps from the template block are SFC-absolute with a **1-based** column
 * (what `apply-prop-edit.ts` expects); stamps from here keep Babel's
 * **0-based** column (what `apply-jsx-prop-edit.ts` expects). Both applicators
 * document their own convention and neither is wrong — but anything that later
 * routes an edit for a `.vue` must pick the applicator by WHICH BLOCK the
 * coordinate came from, not by the file extension, or it will be off by one.
 *
 * That routing now exists: `edit-handler.ts` asks
 * `applyVueScriptJsxPropEdit` FIRST for a `.vue`, and that returns null for any
 * coordinate outside a JSX script block — which is the fall-through to the Vue
 * template applicator. So these elements are inspectable AND editable, and the
 * two column conventions each reach the applicator that expects them.
 *
 * THE COORDINATES ARE THE WHOLE RISK. A wrong line here does not throw — it
 * points an edit at a real, different line. Two independent shifts are needed
 * and they are not interchangeable:
 *   - `startLine` makes Babel report SFC-ABSOLUTE line numbers, which is what
 *     goes into the `data-desde-src` text.
 *   - `offsetShift` moves the byte position where the attribute is spliced,
 *     because Babel's `start`/`end` are relative to the block string.
 */
export function collectEmbeddedJsxInsertions(opts: {
  /** The block's contents, exactly as they appear inside the outer file. */
  blockCode: string
  /** Repo-relative path of the OUTER file (the `.vue`). */
  filePath: string
  /** Version stamp for the OUTER file's full source. */
  sourceVersion: string
  /** 1-based line in the outer file where `blockCode` begins. */
  startLine: number
  /** Byte offset in the outer file where `blockCode` begins. */
  offsetShift: number
  /**
   * Lowercased tag names to leave unstamped. OPT-IN, and only the Vue caller
   * passes it: a Vue SFC can render a routing outlet from a `<script setup
   * lang="tsx">` render function just as easily as from a template, and an
   * outlet's stamp lands on the ROUTED page's root element in a different
   * file — see TRANSPARENT_ROUTING_OUTLETS in source-tag-plugin.ts.
   *
   * Deliberately NOT a default inside this collector. React's own outlet
   * (`<Outlet />`) has different fallthrough semantics and has not been
   * measured, so baking a list in here would change the React lane on a
   * guess. Absent this option the behaviour is exactly as before.
   */
  skipTags?: ReadonlySet<string>
}): Insertion[] {
  let ast: BabelFile
  try {
    ast = parse(opts.blockCode, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
      // Babel then reports `loc.line` in the OUTER file's numbering.
      startLine: opts.startLine,
    }) as unknown as BabelFile
  } catch {
    return []
  }
  return collectInsertions(ast, opts.filePath, opts.sourceVersion, opts.skipTags).map((ins) => ({
    ...ins,
    offset: ins.offset + opts.offsetShift,
  }))
}

/** Minimal shape of the Babel nodes we touch — avoids a hard @babel/types dep. */
interface BabelNode {
  type?: string
  start?: number | null
  end?: number | null
  loc?: { start?: { line?: number; column?: number } } | null
  // JSXOpeningElement fields
  name?: BabelNode
  /** TSX generic type args (`<Foo<T> />`) — ends past `name.end`. */
  typeParameters?: BabelNode
  attributes?: BabelNode[]
  // JSXAttribute fields
  [key: string]: unknown
}

interface BabelFile {
  type: "File"
  program: BabelNode
}

/**
 * One JSX opening element, as both the ordinary and the realigned path need it.
 *
 * `skip` and `alreadyStamped` are FLAGS rather than omissions on purpose: the
 * realigner pairs two parses by walk position, so an element dropped from one
 * list and kept in the other would silently shift every pair after it. Both
 * lists therefore hold every element, and filtering happens at emit time.
 */
interface JsxElement {
  /** Tag as written — `div`, `Card`, `Router.Outlet`, `svg:use`. The pairing key. */
  tag: string
  /** 1-based line, Babel's own. */
  line: number
  /** 0-based column, Babel's own — see the coordinate-convention note above. */
  column: number
  /** Where the attribute is spliced into THIS parse's source. */
  insertOffset: number
  /** Matched `skipTags` (a transparent routing outlet). */
  skip: boolean
  /** Already carries `data-desde-src`, so a re-run must not add a second. */
  alreadyStamped: boolean
}

/** Tag name as a stable string. Used to pair two parses, so it must not lose information. */
function tagOf(name: BabelNode): string {
  if (name.type === "JSXIdentifier") {
    const raw = (name as { name?: unknown }).name
    return typeof raw === "string" ? raw : "?"
  }
  if (name.type === "JSXMemberExpression") {
    const object = name.object as BabelNode | undefined
    const property = name.property as BabelNode | undefined
    return `${object ? tagOf(object) : "?"}.${property ? tagOf(property) : "?"}`
  }
  if (name.type === "JSXNamespacedName") {
    const namespace = name.namespace as BabelNode | undefined
    const local = name.name as BabelNode | undefined
    return `${namespace ? tagOf(namespace) : "?"}:${local ? tagOf(local) : "?"}`
  }
  return name.type ?? "?"
}

/** Walk the whole AST collecting every JSXOpeningElement, in walk order. */
function collectElements(ast: BabelFile, skipTags?: ReadonlySet<string>): JsxElement[] {
  const out: JsxElement[] = []
  walkNode(ast.program, (node) => {
    if (node.type !== "JSXOpeningElement") return
    const name = node.name
    if (!name || typeof name.end !== "number") return

    const line = node.loc?.start?.line
    const column = node.loc?.start?.column
    if (typeof line !== "number" || typeof column !== "number") return

    // Opt-in outlet skip (see `skipTags`). Only a plain JSXIdentifier is
    // matched: every outlet in the set is a bare name, and a
    // JSXMemberExpression (`<Router.Outlet/>`) carries no `.name` string, so
    // reading one loosely would compare `undefined` and match nothing.
    const skip =
      !!skipTags &&
      skipTags.size > 0 &&
      name.type === "JSXIdentifier" &&
      typeof (name as { name?: unknown }).name === "string" &&
      skipTags.has(((name as { name?: unknown }).name as string).toLowerCase())

    // Idempotent re-runs: skip if a `data-desde-src` JSXAttribute is already
    // present (a JSXSpreadAttribute has no `.name`, so it never matches).
    const alreadyStamped =
      node.attributes?.some((attr) => {
        // JSXAttribute.name is a JSXIdentifier whose `.name` is a string
        // (distinct from JSXOpeningElement.name, which is a node) — read it
        // loosely to avoid conflating the two in the minimal node interface.
        const attrName = (attr.name as { name?: unknown } | undefined)?.name
        return attr.type === "JSXAttribute" && attrName === "data-desde-src"
      }) ?? false

    // Insertion position. Default: right after the tag name — but AFTER any
    // TSX type arguments (`<Table<Row> …>`: Babel puts `<Row>` in
    // `typeParameters`, which ends past `name.end`; inserting at `name.end`
    // would corrupt to `<Table data-desde-src=…<Row>`). Falls back to `name.end`
    // for the common non-generic case. Works for host / component / member /
    // self-closing.
    //
    // EXCEPTION — elements carrying a `{...spread}`: insert AFTER the last
    // attribute instead, so the stamp is the LAST attribute and wins on the
    // later-key-wins merge. A component that forwards its props
    // (`function Wrapper(props){ return <Card {...props} /> }`) would otherwise
    // let the caller's forwarded `data-desde-src` clobber the stamp placed before
    // the spread, making `<Card>`'s callsite resolve to Wrapper's caller. Babel
    // exposes spreads as JSXSpreadAttribute in `node.attributes`.
    const attrs = node.attributes ?? []
    const hasSpread = attrs.some((a) => a.type === "JSXSpreadAttribute")
    const lastAttrEnd = attrs.length > 0 ? (attrs[attrs.length - 1] as BabelNode).end : undefined
    const typeParamsEnd = (node.typeParameters as BabelNode | undefined)?.end
    const insertOffset =
      hasSpread && typeof lastAttrEnd === "number"
        ? lastAttrEnd
        : typeof typeParamsEnd === "number"
          ? typeParamsEnd
          : name.end

    out.push({ tag: tagOf(name), line, column, insertOffset, skip, alreadyStamped })
  })
  return out
}

/** The two attributes one element contributes, both at the same offset. */
function insertionsForElement(
  insertOffset: number,
  filePath: string,
  sourceVersion: string,
  at: { line: number; column: number },
): Insertion[] {
  return [
    {
      offset: insertOffset,
      text: ` data-desde-src=${JSON.stringify(`${filePath}:${at.line}:${at.column}`)}`,
    },
    // Sibling per-file version stamp (data-desde-v) — see sourceVersionOf in
    // source-version.ts. Same offset; later-key-wins ordering doesn't
    // matter here (nothing forwards a competing data-desde-v before the stamp).
    { offset: insertOffset, text: ` data-desde-v=${JSON.stringify(sourceVersion)}` },
  ]
}

/** Walk the whole AST collecting one Insertion per JSXOpeningElement. */
function collectInsertions(
  ast: BabelFile,
  filePath: string,
  sourceVersion: string,
  skipTags?: ReadonlySet<string>,
): Insertion[] {
  const out: Insertion[] = []
  for (const el of collectElements(ast, skipTags)) {
    if (el.skip || el.alreadyStamped) continue
    out.push(...insertionsForElement(el.insertOffset, filePath, sourceVersion, el))
  }
  return out
}

/**
 * Generic depth-first AST walk. Visits every node, recursing into any child
 * that is itself a node ({type:...}) or an array of nodes. Avoids the
 * @babel/traverse ESM-interop friction for a one-node-type collector.
 */
function walkNode(node: BabelNode | null | undefined, visit: (n: BabelNode) => void): void {
  if (!node || typeof node !== "object") return
  if (typeof node.type === "string") visit(node)
  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) walkNode(item as BabelNode, visit)
    } else if (value && typeof value === "object" && typeof (value as BabelNode).type === "string") {
      walkNode(value as BabelNode, visit)
    }
  }
}

/**
 * Apply insertions descending-by-offset so each splice doesn't shift the
 * offsets of insertions not yet applied. (Same approach as the Vue plugin.)
 */
function applyInsertions(source: string, insertions: Insertion[]): string {
  const sorted = [...insertions].sort((a, b) => b.offset - a.offset)
  let out = source
  for (const ins of sorted) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset)
  }
  return out
}

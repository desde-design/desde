/**
 * Callsite recovery from source, for a component the runtime has no
 * instance for.
 *
 * On a Next.js App Router page a server component leaves no client fiber,
 * and it ignores its props, so nothing the caller stamps on `<KpiCards />`
 * reaches the browser (the `data-desde-call` stamp covers a component that
 * SPREADS its props; this covers one that does not). The bridge can only
 * attribute the component's root element to the root markup inside the
 * component's own file. The callsite is on disk, though: given the root's
 * coordinate and the file the element is displayed inside, these two pure
 * functions answer "which component is this the root of?" and "where is it
 * written in that file?" from the source alone.
 *
 * Both refuse rather than guess. `resolveJsxComponentRoot` names a component
 * only when the element IS its whole output (the argument of the return, or
 * an arrow's expression body); a root fragment or a conditional return
 * answers null. `findJsxCallsites` reports callsites only when the parent
 * file imports that name from a module that resolves to the definition
 * file; the same name from anywhere else answers null.
 *
 * Pure: no I/O. The CLI handler (`resolve-callsites-handler.ts`) reads the
 * files and applies the root-containment rules.
 */
import { parseJsxModule, findJsxElementAt, walkJsx, type JsxNode } from "./resolve-jsx-target"

export interface JsxCallsite {
  /** 1-based line, Babel's own. */
  line: number
  /** 0-based column, Babel's own — the JSX lane's convention throughout. */
  column: number
  /**
   * NOT known to render exactly once, in source order. A static callsite
   * is one whose path up to a module-level component function is pure JSX
   * nesting plus the function's own `return` (or an arrow's expression
   * body). Anything else on that path — a `{…}` expression, a conditional,
   * a `.map`, an `if`, a variable it was assigned to first, a helper
   * function — can render it zero, one or many times, or in another order,
   * so the order of elements on screen says nothing about which callsite
   * each came from.
   */
  dynamic: boolean
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])

/** Root-to-`target` node path, both ends inclusive, or null when unreachable. */
function findAncestorPath(ast: JsxNode, target: JsxNode): JsxNode[] | null {
  const stack: JsxNode[] = []
  let found: JsxNode[] | null = null
  const visit = (node: JsxNode | null | undefined): void => {
    if (found || !node || typeof node !== "object") return
    if (typeof node.type !== "string") return
    stack.push(node)
    if (node === target) {
      found = [...stack]
    } else {
      for (const key in node) {
        if (key === "loc" || key === "start" || key === "end" || key === "type") continue
        const v = node[key]
        if (Array.isArray(v)) {
          for (const item of v) visit(item as JsxNode)
        } else if (v && typeof v === "object" && typeof (v as JsxNode).type === "string") {
          visit(v as JsxNode)
        }
        if (found) break
      }
    }
    stack.pop()
  }
  visit(ast)
  return found
}

function identifierName(node: JsxNode | undefined): string | null {
  if (!node || node.type !== "Identifier") return null
  const name = (node as { name?: unknown }).name
  return typeof name === "string" && name.length > 0 ? name : null
}

/**
 * The name a component function is bound to. A declaration carries its own;
 * an expression takes the variable it is assigned to, looking through ONE
 * wrapping call (`forwardRef(...)`, `memo(...)`). An anonymous default export
 * has no name a callsite could be matched on, so it answers null.
 */
function nameOfFunction(path: JsxNode[], fnIndex: number): string | null {
  const fn = path[fnIndex]
  if (fn.type === "FunctionDeclaration") {
    return identifierName(fn.id as JsxNode | undefined)
  }
  let parent = path[fnIndex - 1]
  if (parent?.type === "CallExpression") parent = path[fnIndex - 2]
  if (parent?.type === "VariableDeclarator") {
    return identifierName(parent.id as JsxNode | undefined)
  }
  return null
}

/**
 * Which component is the JSX element at (line, column) the whole output of?
 * Null when it is nested, wrapped in a fragment, returned conditionally, or
 * there is no element at the coordinate.
 */
export function resolveJsxComponentRoot(
  source: string,
  line: number,
  column: number,
): { name: string } | null {
  const parsed = parseJsxModule(source)
  if (!parsed.ok) return null
  const el = findJsxElementAt(parsed.ast, line, column)
  if (!el) return null
  const path = findAncestorPath(parsed.ast, el)
  if (!path || path.length < 2) return null
  const parent = path[path.length - 2]

  let fnIndex: number
  if (parent.type === "ReturnStatement" && parent.argument === el) {
    // return (<el/>) directly inside the function body — not inside an if.
    const block = path[path.length - 3]
    const fn = path[path.length - 4]
    if (block?.type !== "BlockStatement" || !fn || !FUNCTION_TYPES.has(fn.type ?? "")) return null
    fnIndex = path.length - 4
  } else if (FUNCTION_TYPES.has(parent.type ?? "") && parent.body === el) {
    // () => <el/>
    fnIndex = path.length - 2
  } else {
    return null
  }
  const name = nameOfFunction(path, fnIndex)
  return name ? { name } : null
}

/** Strip a source extension; also the trailing `/index` a directory import omits. */
function moduleIdsOf(file: string): string[] {
  const base = file.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "")
  return base.endsWith("/index") ? [base, base.slice(0, -"/index".length)] : [base]
}

/** POSIX join + normalize without node:path, so this module stays I/O-free. */
function normalizeJoin(dir: string, rel: string): string {
  const out: string[] = []
  for (const seg of `${dir}/${rel}`.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join("/")
}

/**
 * Does `specifier`, written in `parentFile`, name `definitionFile`?
 *
 * A relative specifier resolves against the parent's directory. A bare
 * project path under a `baseUrl` (`src/components/ui/card`) must equal the
 * file's module id exactly. An alias is recognised only by the one-character
 * roots projects use for one (`@/`, `~/`, `#/`, `$/`) and matches on the tail
 * after that root. Everything else — a bare package name, and a SCOPED
 * package like `@scope/ui/card` whose tail could equal a local file's —
 * is an installed library, never this file (codex P1).
 */
function specifierNamesFile(specifier: string, parentFile: string, definitionFile: string): boolean {
  const ids = moduleIdsOf(definitionFile)
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentDir = parentFile.includes("/") ? parentFile.slice(0, parentFile.lastIndexOf("/")) : ""
    const resolved = moduleIdsOf(normalizeJoin(parentDir, specifier))[0]
    return ids.includes(resolved)
  }
  const stripped = specifier.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "")
  if (/^[@~#$]\//.test(stripped)) {
    const tail = stripped.slice(2)
    return tail.length > 0 && ids.some((id) => id === tail || id.endsWith(`/${tail}`))
  }
  return ids.includes(stripped)
}

/**
 * Every place `parentSource` writes `<Name …>`, in source order — provided
 * it imports `Name` from a module that resolves to `definitionFile`. Null
 * when it does not: the same name from another module is another component.
 */
export function findJsxCallsites(input: {
  source: string
  name: string
  definitionFile: string
  parentFile: string
}): JsxCallsite[] | null {
  const { source, name, definitionFile, parentFile } = input
  const parsed = parseJsxModule(source)
  if (!parsed.ok) return null

  let imported = false
  const callsites: JsxCallsite[] = []
  walkWithAncestors(parsed.ast, (node, ancestors) => {
    if (node.type === "ImportDeclaration") {
      const specifier = (node.source as { value?: unknown } | undefined)?.value
      const specifiers = (node.specifiers as JsxNode[] | undefined) ?? []
      const bindsName = specifiers.some((s) => identifierName(s.local as JsxNode | undefined) === name)
      if (bindsName && typeof specifier === "string" && specifierNamesFile(specifier, parentFile, definitionFile)) {
        imported = true
      }
      return
    }
    if (node.type !== "JSXOpeningElement") return
    const tag = node.name as JsxNode | undefined
    if (tag?.type !== "JSXIdentifier" || (tag as { name?: unknown }).name !== name) return
    const start = node.loc?.start
    if (typeof start?.line !== "number" || typeof start?.column !== "number") return
    callsites.push({
      line: start.line,
      column: start.column,
      dynamic: !isStaticCallsite(ancestors),
    })
  })
  return imported ? callsites : null
}

const MODULE_LEVEL_WRAPPERS = new Set(["ExportNamedDeclaration", "ExportDefaultDeclaration"])

/**
 * Is a JSX opening element, given its ancestors (outermost first, the
 * element's own JSXElement last), rendered exactly once in source order?
 *
 * Yes only when, walking up, there is nothing but JSX nesting until a
 * module-level component function's own `return` (through its block) or an
 * arrow's expression body. Every other construct on the way — an if, a
 * variable, a call, a nested function, a `{…}` container — answers no. The
 * first delta review showed why the `{…}` check alone was not enough:
 * `const rows = items.map(i => <Card/>)` has no container in its ancestry
 * and renders any number of times.
 */
function isStaticCallsite(ancestors: readonly JsxNode[]): boolean {
  // ancestors[last] is the opening element's own JSXElement.
  let i = ancestors.length - 1
  let child = ancestors[i]
  if (child?.type !== "JSXElement") return false
  i--
  while (i >= 0 && (ancestors[i].type === "JSXElement" || ancestors[i].type === "JSXFragment")) {
    child = ancestors[i]
    i--
  }
  const boundary = ancestors[i]
  if (!boundary) return false

  let fnIndex: number
  if (boundary.type === "ReturnStatement" && boundary.argument === child) {
    const block = ancestors[i - 1]
    const fn = ancestors[i - 2]
    if (block?.type !== "BlockStatement" || block.body === undefined || !fn || !FUNCTION_TYPES.has(fn.type ?? "")) {
      return false
    }
    fnIndex = i - 2
  } else if (FUNCTION_TYPES.has(boundary.type ?? "") && boundary.body === child) {
    fnIndex = i
  } else {
    return false
  }

  // The function must be a module-level component definition, not a helper
  // or a callback: a declaration under Program (or an export), or an
  // expression assigned to a module-level variable, through at most one
  // wrapping call (forwardRef, memo), or exported directly as the default.
  const fn = ancestors[fnIndex]
  let j = fnIndex - 1
  if (fn.type === "FunctionDeclaration") {
    if (ancestors[j] && MODULE_LEVEL_WRAPPERS.has(ancestors[j].type ?? "")) j--
    return ancestors[j]?.type === "Program"
  }
  if (ancestors[j]?.type === "ExportDefaultDeclaration") return ancestors[j - 1]?.type === "Program"
  if (ancestors[j]?.type === "CallExpression") j--
  if (ancestors[j]?.type !== "VariableDeclarator") return false
  j--
  if (ancestors[j]?.type !== "VariableDeclaration") return false
  j--
  if (ancestors[j] && MODULE_LEVEL_WRAPPERS.has(ancestors[j].type ?? "")) j--
  return ancestors[j]?.type === "Program"
}

/** Depth-first walk that hands each node its ancestor chain, outermost first. */
function walkWithAncestors(
  root: JsxNode,
  visit: (node: JsxNode, ancestors: readonly JsxNode[]) => void,
): void {
  const stack: JsxNode[] = []
  const step = (node: JsxNode | null | undefined): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return
    visit(node, stack)
    stack.push(node)
    for (const key in node) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue
      const v = node[key]
      if (Array.isArray(v)) {
        for (const item of v) step(item as JsxNode)
      } else if (v && typeof v === "object" && typeof (v as JsxNode).type === "string") {
        step(v as JsxNode)
      }
    }
    stack.pop()
  }
  step(root)
}

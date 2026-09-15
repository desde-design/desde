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
 * Does `specifier`, written in `parentFile`, name `definitionFile`? A
 * relative specifier resolves against the parent's directory. An aliased
 * one (`@/components/ui/card`, `~/x`, or a bare `src/x` under a baseUrl)
 * matches on its tail after the first segment. A bare package name never
 * matches: that is an installed library, not this file.
 */
function specifierNamesFile(specifier: string, parentFile: string, definitionFile: string): boolean {
  const ids = moduleIdsOf(definitionFile)
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentDir = parentFile.includes("/") ? parentFile.slice(0, parentFile.lastIndexOf("/")) : ""
    const resolved = moduleIdsOf(normalizeJoin(parentDir, specifier))[0]
    return ids.includes(resolved)
  }
  if (!specifier.includes("/")) return false
  const stripped = specifier.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "")
  const tail = stripped.slice(stripped.indexOf("/") + 1)
  return ids.some((id) => id === stripped || id.endsWith(`/${tail}`) || id === tail)
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
  walkJsx(parsed.ast, (node) => {
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
    callsites.push({ line: start.line, column: start.column })
  })
  return imported ? callsites : null
}

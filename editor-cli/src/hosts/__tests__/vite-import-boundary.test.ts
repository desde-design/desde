/**
 * **S12 — no Vite import outside the Vite-owning files** (`tasks/dev-server-hosts.md` § 4).
 *
 * The invariant this protects: the framework-neutral half of the CLI — `core.ts`,
 * `server/**`, `attach/**` minus the stamper bundler — must be able to run a
 * session on a host that has no Vite anywhere (Next's Turbopack lane). Every
 * time a `ViteDevServer` leaked into a shared type, the leak's first symptom was
 * a caller reaching for `handle.vite.server` and silently degrading on the hosts
 * that have none.
 *
 * **Why this is not the grep § 4 wrote down.** That grep was
 * `grep -rl 'from "vite"' editor-cli/src`, and it is wrong in both directions:
 *
 *  - **False positives.** `hosts/vite/host.ts` contains the STRING
 *    `'createServer(merged) from "vite"'` — a seam description, not an import.
 *    A file-level grep flags it, and the only ways out are widening the
 *    allowlist (which then tolerates a real import in that file) or deleting a
 *    piece of documentation to satisfy a checker.
 *  - **Wrong unit.** `import type { Plugin } from "vite"` is ERASED by the
 *    compiler. `hosts/types.ts` has one, and it is not a leak: nothing loads
 *    Vite because of it, and the alternative — restating Vite's `Plugin` shape
 *    ourselves — would be a copy that goes stale. The thing that actually pulls
 *    Vite into the process is a VALUE import, so that is what gets the strict
 *    list; type imports get a wider, separately-stated one.
 *
 * So the classification is done on the TypeScript AST, where "type-only" is a
 * property the compiler already computed and a string literal is not an import.
 *
 * Both lists are asserted for EXACT equality, not containment. A subset check
 * passes forever once the list is generous, and cannot notice that a file
 * stopped needing Vite — which is the change this milestone is.
 */
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url))

/**
 * Files allowed to make Vite EXIST at runtime — an import with a value binding,
 * a bare side-effect import, `require("vite…")`, or `import("vite…")`.
 *
 * Three files, and each one boots or builds with Vite as its whole job.
 */
const VALUE_IMPORTS_ALLOWED = [
  // Calls `createServer` / `loadConfigFromFile` / `mergeConfig`: the plain-Vite
  // boot path itself.
  "supervisor/vite-supervisor.ts",
  // `defaultAllowedOrigins`, restated into the pinned server config.
  "supervisor/harden-plugin.ts",
  // `build()` — bundles the attach-mode stampers to disk.
  "attach/write-stampers.ts",
  // `require("vite/package.json")` twice, through `createRequire`: ours and the
  // prototype's, to report a major-version skew. Reads JSON, loads no Vite code
  // — but it is still a runtime resolution of the `vite` package, so a checker
  // that only understood `import` statements would miss it and be lying about
  // its own scope.
  "hosts/vite/host.ts",
].sort()

/**
 * Files allowed to NAME a Vite type. Erased at runtime, so this is a design
 * boundary rather than a dependency one: it says which modules are permitted to
 * speak Vite's vocabulary in their signatures.
 *
 * `core.ts` and `server/**` are absent, and that absence is the point of the
 * leak-plugging milestone.
 */
const TYPE_IMPORTS_ALLOWED = [
  // The four Vite-family hosts, plus the two shared plugin helpers and the
  // capture seam they all reach the live server through.
  "hosts/vite/host.ts",
  "hosts/vite/module-graph-evidence.ts",
  "hosts/vite-capture.ts",
  "hosts/vite-invalidate.ts",
  "hosts/root-default-plugin.ts",
  "hosts/nuxt/host.ts",
  "hosts/astro/host.ts",
  "hosts/react-router/host.ts",
  // `StamperInjection`'s vite-plugin channel is literally a `Plugin[]`. Restating
  // that shape by hand would be a copy of someone else's interface that goes
  // stale silently; the import is erased, so it costs nothing at runtime.
  "hosts/types.ts",
  // The injected plugins themselves.
  "plugins/bridge-plugin.ts",
  "plugins/source-tag-plugin.ts",
  "plugins/jsx-source-tag-plugin.ts",
  "plugins/tracer-plugin.ts",
  "plugins/compose-isolation.ts",
  // The supervised boot path.
  "supervisor/vite-supervisor.ts",
  "supervisor/harden-plugin.ts",
  // Bundles the stampers with Vite's own `build`.
  "attach/write-stampers.ts",
].sort()

interface ViteImport {
  file: string
  /** `false` for `import type …` and for a clause whose every binding is `type`. */
  typeOnly: boolean
}

describe("S12 — the Vite import boundary", () => {
  const found = collectViteImports()

  it("keeps Vite itself out of every file that is not booting or building with it", () => {
    const valueImporters = unique(found.filter((i) => !i.typeOnly).map((i) => i.file))
    expect(valueImporters).toEqual(VALUE_IMPORTS_ALLOWED)
  })

  it("keeps Vite's vocabulary out of the framework-neutral half", () => {
    const anyImporters = unique(found.map((i) => i.file))
    expect(anyImporters).toEqual(unique([...VALUE_IMPORTS_ALLOWED, ...TYPE_IMPORTS_ALLOWED]))
  })

  it("names an import and not a string that happens to read like one", () => {
    // The exact false positive the § 4 grep produces. If this file ever stops
    // containing that seam description the assertion is meaningless, so it
    // checks the bait is still there before checking the checker ignored it.
    const host = readFileSync(join(SRC_ROOT, "hosts", "vite", "host.ts"), "utf8")
    expect(host).toContain('from "vite"')
    expect(found.filter((i) => i.file === "hosts/vite/host.ts" && i.typeOnly)).toHaveLength(0)
  })
})

/**
 * Every Vite reference in shipped source, classified.
 *
 * **Tests are excluded**, deliberately. The invariant is about what the CLI
 * process loads; a test that builds a fake `Plugin[]` or boots a real Vite to
 * assert the hardening pins is not a dependency of the product, and folding
 * them in would mean maintaining an allowlist that grows with every new suite
 * while protecting nothing.
 */
function collectViteImports(): ViteImport[] {
  const out: ViteImport[] = []
  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split(sep).join("/")
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ false,
      rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      if (!isViteSpecifier(statement.moduleSpecifier)) continue
      out.push({ file: rel, typeOnly: isTypeOnlyClause(statement.importClause) })
    }
    // `require("vite…")` / `import("vite…")` — a runtime resolution that no
    // import-statement walk would see.
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression
      const isRequire = ts.isIdentifier(callee) && callee.text === "require"
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      if (!isRequire && !isDynamicImport) return
      const arg = node.arguments[0]
      if (!arg || !isViteSpecifier(arg)) return
      out.push({ file: rel, typeOnly: false })
    })
  }
  return out
}

function isViteSpecifier(node: ts.Node): boolean {
  if (!ts.isStringLiteral(node)) return false
  return node.text === "vite" || node.text.startsWith("vite/")
}

/**
 * True when the import contributes NO runtime binding: either `import type …`,
 * or a named clause whose every specifier carries its own `type` keyword.
 *
 * A clause-less `import "vite"` is a side-effect import and is emphatically not
 * type-only, which is why the absence of a clause falls through to `false`.
 */
function isTypeOnlyClause(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return false
  return bindings.elements.every((element) => element.isTypeOnly)
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node)
  ts.forEachChild(node, (child) => visit(child, fn))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "__smoke__") continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

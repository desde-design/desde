/**
 * Server-side wiring for the `manifest-value-mismatch` drift signal (Phase
 * 5 carry-forward (g), landed 2026-07-30 — see
 * `src/editor/drift/detect-manifest-value-mismatch.ts` for the rule and
 * why it is NOT hooked to `PropEditFallbackHint`).
 *
 * Called from `http-server.ts`'s `runEditAndAutoCommit`, strictly AFTER
 * `applyEdit` has resolved and only when it succeeded — this module never
 * participates in deciding whether an edit applies, only in observing one
 * that already did. Every step here is best-effort:
 *
 *   1. Re-resolve the target element the prop edit hit, from the
 *      (line, column) the request already carried — `PropEditBody` has no
 *      `componentName` field (unlike `DetachEditBody`/`SwapEditBody`),
 *      so the component identity isn't otherwise available at this call
 *      site. Dispatches by file extension: `.vue` reuses the same pure
 *      `resolveTemplateTarget` the deterministic Vue applicator uses;
 *      `.tsx`/`.jsx` reuses `resolveJsxOpeningElement` (the Babel sibling
 *      the JSX applicators use) — this producer used to run
 *      `resolveTemplateTarget` unconditionally, which finds nothing for a
 *      JSX file (silently swallowed by the outer catch), so React never
 *      recorded this signal and the React auto-repair path was
 *      unreachable from it (codex P2 fix, 2026-07-30). Reading the file
 *      again after the write is safe for both because a prop-value splice
 *      never moves the target element's opening-tag position, only bytes
 *      inside one of its attributes. Any other extension has no resolver
 *      and no-ops silently, same as an unresolvable target always has.
 *   2. Resolve the tag to a manifest via the SAME memoized `GroundingService`
 *      every other grounding consumer reads from — disambiguating a
 *      same-name collision across manifest sources by the edited file's
 *      actual import path where possible (see `resolveManifestForName`'s
 *      doc comment for the precedence; codex P2 fix, 2026-07-30). Blaming
 *      the wrong package would be worse than staying silent, since a
 *      recorded signal can trigger an automatic re-extraction REPAIR
 *      against whatever `(component, importPath)` the chosen manifest
 *      names.
 *   3. Hand `(manifest, propName, value)` to the pure detector.
 *   4. Record any signal onto the process-lifetime `DriftLog`, then hand the
 *      resulting entry to `triggerRepairForEntry` (`repair-trigger.ts`) —
 *      the SAME repair-triggering path `POST /api/editor/drift` uses, so
 *      this producer's signals are auto-repaired identically to a
 *      client-POSTed one (codex P2 fix, 2026-07-30 — see
 *      `RecordManifestValueMismatchDriftCtx`'s doc comment for why this was
 *      previously inert).
 *
 * The whole body is one big try/catch: a failure at ANY step (file
 * unreadable, template/module no longer parses, no grounding service
 * configured, manifest lookup throws) is silently swallowed. This is
 * advisory telemetry about an edit that already succeeded — it must never
 * surface as an error, retry, or delay to the caller. `triggerRepairForEntry`
 * is itself fire-and-forget and never throws synchronously, so it can't
 * change this function's own advisory-only guarantee.
 */

import { promises as fsp } from "node:fs"
import path from "node:path"
import { parse as parseBabel } from "@babel/parser"
import { resolveTemplateTarget } from "../../../src/editor/edit-service/resolve-template-target.js"
import {
  resolveJsxOpeningElement,
  walkJsx,
  type JsxNode,
} from "../../../src/editor/edit-service/resolve-jsx-target.js"
import type { PropEditBody } from "../../../src/editor/edit-service/validate-edit-request.js"
import { detectManifestValueMismatch } from "../../../src/editor/drift/detect-manifest-value-mismatch.js"
import type { ComponentManifest, ComponentManifestSource, DriftLog } from "../../../src/editor/core"
import { getGroundingService, type GroundingLoaders } from "./grounding-context.js"
import { triggerRepairForEntry, type RepairTriggerCtx } from "./repair-trigger.js"

/**
 * `repair`/`pendingInvalidations` (inherited from `RepairTriggerCtx`,
 * `repair-trigger.ts`) are optional — codex P2 fix (2026-07-30). Before
 * this, a `manifest-value-mismatch` signal recorded here went straight
 * onto `ctx.driftLog`, bypassing the `POST /api/editor/drift` path
 * where `maybeTriggerRepair` (now `triggerRepairForEntry`) runs — so
 * adding `manifest-value-mismatch` to `REPAIRABLE_DRIFT_KINDS` had no
 * effect for THIS producer unless a client happened to independently POST
 * the same signal. Wiring these two fields lets the caller
 * (`fireManifestValueMismatchDriftCheck` in `http-server.ts`) pass the
 * SAME production `repair`/`pendingInvalidations` the drift route uses, so
 * a server-recorded signal is repaired identically to a client-POSTed one.
 * Omitted in tests that don't care about repair-triggering (mirrors every
 * other optional field on this ctx).
 */
export interface RecordManifestValueMismatchDriftCtx extends RepairTriggerCtx {
  repoRoot: string
  canonicalRoot: string
  groundingLoaders: GroundingLoaders
  driftLog: DriftLog
}

/**
 * PascalCase candidate for a template tag written in kebab-case (Vue
 * accepts both at the call site — `<KButton>` and `<ui-button>` resolve to
 * the same registered component). Manifests are keyed by the PascalCase
 * name, so a kebab-case tag needs this conversion before `getComponent`
 * has any chance of matching; an already-PascalCase tag (the convention
 * used throughout the dogfood substrate) passes through untouched and is
 * tried first.
 */
function candidateComponentNames(tag: string): string[] {
  if (!tag.includes("-")) return [tag]
  const pascal = tag
    .split("-")
    .map((seg) => (seg.length > 0 ? seg[0].toUpperCase() + seg.slice(1) : seg))
    .join("")
  return pascal === tag ? [tag] : [tag, pascal]
}

/**
 * One import binding, keyed by the LOCAL identifier (how the tag is
 * actually written in the template/JSX). `importPath` disambiguates a
 * same-name manifest collision (see `resolveManifestForName`);
 * `exportedName` is the name the MODULE exports it under — which
 * manifests are keyed by — and differs from the local key only for an
 * aliased named import (`import { Button as PrimaryButton } from 'x'`:
 * local `PrimaryButton`, `exportedName` `Button`). A default import has
 * no export-side name to recover from the import statement itself (a
 * default export carries no module-side binding name), so `exportedName`
 * falls back to the local name unchanged — codex P2 fix, 2026-07-30: an
 * aliased named import used to be looked up in the manifest by its LOCAL
 * name, which manifests never key by, silently skipping the signal and
 * its auto-repair even though the import path resolved fine.
 */
interface ImportBinding {
  importPath: string
  exportedName: string
}

/** The element the prop edit hit, resolved from source: its tag name plus
 *  every import binding (local identifier → `{importPath, exportedName}`)
 *  visible in the edited file, used to disambiguate a same-name manifest
 *  collision and to resolve an aliased import to its manifest key. */
interface ResolvedEditTarget {
  tag: string
  imports: Map<string, ImportBinding>
}

/** `.vue` resolution lane: reuses `resolveTemplateTarget`, the same pure
 *  resolver the deterministic Vue prop applicator uses. */
function resolveVueEditTarget(source: string, line: number, column: number): ResolvedEditTarget | null {
  const target = resolveTemplateTarget({ source, line, column })
  if (!target.ok) return null
  return { tag: target.node.tag, imports: collectVueImportBindings(target.ctx.descriptor) }
}

/** `.tsx`/`.jsx` resolution lane: reuses `resolveJsxOpeningElement`, the
 *  same pure resolver the JSX prop applicator (`apply-jsx-prop-edit.ts`)
 *  uses — this producer previously ran the Vue-only `resolveTemplateTarget`
 *  unconditionally, which finds nothing for a JSX file (silently swallowed
 *  by the outer catch), so `manifest-value-mismatch` was never recorded for
 *  React (codex P2 fix, 2026-07-30). */
function resolveJsxEditTarget(source: string, line: number, column: number): ResolvedEditTarget | null {
  const result = resolveJsxOpeningElement(source, line, column)
  if (!result.ok) return null
  const tag = jsxOpeningElementTagName(result.node)
  if (!tag) return null
  return { tag, imports: collectImportBindings(result.ast) }
}

/** A JSXOpeningElement's tag name, when it's a plain identifier (`<Foo>`) —
 *  not a member expression (`<Foo.Bar>`) or namespaced name, neither of
 *  which is a single import-bound local identifier. Mirrors the same
 *  extraction `infer-jsx-rendering-hints.ts`'s `isNativeElement` does. */
function jsxOpeningElementTagName(node: JsxNode): string | null {
  const name = node.name as JsxNode | string | undefined
  if (typeof name === "string") return name
  if (name && name.type === "JSXIdentifier" && typeof name.name === "string") return name.name
  return null
}

/**
 * Local identifier → `{importPath, exportedName}`, from every `import`
 * declaration in `ast`. Reuses `walkJsx` (`resolve-jsx-target.ts`) — a
 * generic Babel-node visitor, not JSX-specific despite the module name —
 * instead of writing a second import-statement walker.
 *
 * Per specifier kind:
 *  - `ImportSpecifier` (named, `{ Button }` or `{ Button as Primary }`):
 *    `exportedName` is `spec.imported`'s name — the module-side name, NOT
 *    `spec.local` — so an alias resolves to what the manifest actually
 *    keys it by. `imported` is normally an `Identifier` (`.name`); the
 *    rare string-literal export form (`{ "some-name" as foo }`) uses
 *    `.value` instead.
 *  - `ImportDefaultSpecifier` (`import Button from 'x'`): a default
 *    export has no module-side binding name to recover here, so
 *    `exportedName` falls back to the local name (see `ImportBinding`'s
 *    doc comment).
 *  - `ImportNamespaceSpecifier` (`import * as UI from 'x'`, used as
 *    `<UI.Button>`): NOT handled — the tag name extractors upstream
 *    (`jsxOpeningElementTagName`, `resolveTemplateTarget`'s tag) only
 *    resolve a plain identifier tag, never a member expression, so a
 *    namespaced usage never looks up a binding here anyway.
 */
function collectImportBindings(ast: JsxNode): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  walkJsx(ast, (node) => {
    if (node.type !== "ImportDeclaration") return
    const src = (node.source as JsxNode | undefined)?.value
    if (typeof src !== "string") return
    for (const spec of (node.specifiers as JsxNode[] | undefined) ?? []) {
      const localName = (spec.local as JsxNode | undefined)?.name
      if (typeof localName !== "string" || bindings.has(localName)) continue

      let exportedName: string | undefined
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported as JsxNode | undefined
        exportedName =
          (imported?.name as string | undefined) ?? (imported?.value as string | undefined)
      } else if (spec.type === "ImportDefaultSpecifier") {
        exportedName = localName
      }
      // ImportNamespaceSpecifier: no exportedName — see doc comment above.
      if (!exportedName) continue

      bindings.set(localName, { importPath: src, exportedName })
    }
  })
  return bindings
}

/**
 * Same as `collectImportBindings`, but for a Vue SFC: `@vue/compiler-sfc`
 * only gives us the `<script>`/`<script setup>` blocks' raw content, not a
 * parsed AST (the template AST `resolveTemplateTarget` builds doesn't cover
 * script), so each present block is parsed here with the same plugin set
 * `apply-jsx-prop-edit.ts`'s TS-only siblings use. A block that fails to
 * parse contributes no bindings — degrades to "import unresolved" for the
 * names it would have covered, same posture as every other best-effort step
 * in this module.
 */
function collectVueImportBindings(descriptor: {
  script?: { content: string } | null
  scriptSetup?: { content: string } | null
}): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const block of [descriptor.scriptSetup, descriptor.script]) {
    if (!block?.content) continue
    try {
      const ast = parseBabel(block.content, {
        sourceType: "module",
        plugins: ["typescript"],
      }) as unknown as JsxNode
      for (const [name, src] of collectImportBindings(ast)) {
        if (!bindings.has(name)) bindings.set(name, src)
      }
    } catch {
      // See the doc comment above.
    }
  }
  return bindings
}

/** Sentinel distinguishing "ambiguous across sources" from "no manifest at
 *  all" in `resolveManifestForName`'s return type. */
const AMBIGUOUS: unique symbol = Symbol("manifest-value-mismatch:ambiguous-component-name")

/**
 * Resolve the ONE manifest to check `name` against, disambiguating a
 * same-name collision across manifest sources by the edited file's actual
 * import (codex P2 fix, 2026-07-30 — `getComponent` alone always returns
 * the FIRST source's manifest, which can suppress a genuine off-manifest
 * edit or, worse, blame/repair the WRONG package). Precedence:
 *
 *  1. `getComponentCandidates` (composite-only) + a resolved `importPath`
 *     that matches EXACTLY ONE candidate's `importPath` → that candidate.
 *  2. The import-path filter leaves MORE THAN ONE candidate. This is the
 *     normal production shape on the real dogfood substrate — e.g. `KAlert`
 *     legitimately comes back with 3 candidates (`@acme/ds-vue-dts`,
 *     `@acme/ds:Alert`, `acme-ds-hints-cache`), all sharing the same
 *     `importPath` AND the same `designSystem`: several manifest sources
 *     redundantly covering the SAME component, not a collision. Distinguish
 *     by whether the surviving candidates AGREE on component identity —
 *     `designSystem` is the field that carries that identity here, since
 *     `name`/`importPath` are already pinned equal by this point:
 *       - All candidates agree on `designSystem` → RESOLVE. Redundant
 *         coverage of the same component; any candidate is the right
 *         answer, so pick the first — the composite's highest-priority
 *         (props-winner) candidate, the one the rest of the system already
 *         trusts — rather than merge or diff them.
 *       - Candidates DISAGREE on `designSystem` → AMBIGUOUS, emit nothing.
 *         This is the genuine collision this whole function exists to
 *         guard against: two different design systems exporting the same
 *         component name at the same import path (the registry allows this
 *         — `buildRegisteredSources` keys each source by its own
 *         `registeredCacheName()`, not by `importPath`). Guessing here
 *         could blame/repair the wrong package, which an advisory signal
 *         must never do — over-collapsing "redundant coverage" and "genuine
 *         collision" into one bucket was the ORIGINAL bug this precedence
 *         was written to prevent (codex P2 fix, 2026-07-30: `Array.find`
 *         silently picked the first importPath-matching candidate even
 *         when several matched); the fix here must not reintroduce it by
 *         swinging the other way and resolving every multi-candidate case.
 *  3. `importPath` resolved but matches no candidate (stale/relative import
 *     the manifest doesn't record, or the manifest lacks `importPath`) →
 *     fall through to (4) exactly as if the import were unresolvable. Never
 *     guess which candidate is "close enough" — advisory features must
 *     never blame an innocent package.
 *  4. No usable `importPath` → a single candidate is unambiguous (identical
 *     to what `getComponent` would have returned, so this is also today's
 *     behavior for the common single-source-per-name case); more than one
 *     candidate IS ambiguous — return `AMBIGUOUS` so the caller emits
 *     nothing rather than risk blaming the wrong package. (Only the
 *     import-path-filtered set in (2) gets the identity-agreement
 *     treatment — without a resolved import path there is no signal at all
 *     tying the edit to one of the candidates, so this stays conservative.)
 *  5. `getComponentCandidates` unimplemented (the source can't enumerate
 *     per-source candidates at all — e.g. a bare stub in a test) →
 *     ambiguity is undetectable; preserve the pre-existing single-source
 *     behavior byte-for-byte via `getComponent`.
 */
async function resolveManifestForName(
  manifestSource: ComponentManifestSource,
  name: string,
  importPath: string | undefined,
): Promise<ComponentManifest | null | typeof AMBIGUOUS> {
  const getCandidates = manifestSource.getComponentCandidates?.bind(manifestSource)
  if (!getCandidates) return manifestSource.getComponent(name)

  const candidates = await getCandidates(name)
  if (candidates.length === 0) return null

  if (importPath) {
    const importMatches = candidates.filter((c) => c.importPath === importPath)
    if (importMatches.length === 1) return importMatches[0]
    if (importMatches.length > 1) return resolveIfAgreeingIdentity(importMatches)
  }
  return candidates.length === 1 ? candidates[0] : AMBIGUOUS
}

/**
 * Given a set of candidates already pinned to the same `name` + `importPath`,
 * decide whether they're redundant coverage of the SAME component (resolve
 * to the first — the composite's props-winner) or a genuine identity
 * collision (ambiguous). See `resolveManifestForName`'s doc comment, step 2,
 * for the full reasoning and the live `KAlert`/`KButton`/`KBadge`/`KCard`
 * evidence this was written against.
 */
function resolveIfAgreeingIdentity(candidates: ComponentManifest[]): ComponentManifest | typeof AMBIGUOUS {
  const designSystems = new Set(candidates.map((c) => c.designSystem))
  return designSystems.size === 1 ? candidates[0] : AMBIGUOUS
}

/**
 * Best-effort: record a `manifest-value-mismatch` drift signal for a prop
 * edit that just succeeded. See the module doc comment for the full
 * step-by-step and the advisory-only guarantee. Never throws.
 */
export async function recordManifestValueMismatchDrift(
  edit: PropEditBody,
  ctx: RecordManifestValueMismatchDriftCtx,
): Promise<void> {
  try {
    const filePath = path.resolve(ctx.repoRoot, edit.file)
    const source = await fsp.readFile(filePath, "utf8")

    // Dispatch by extension: `.vue` → the Vue SFC template resolver;
    // `.tsx`/`.jsx` → the JSX resolver. No resolver exists for any other
    // extension — no-op silently, same as an unresolved target always has.
    const isJsx = edit.file.endsWith(".tsx") || edit.file.endsWith(".jsx")
    const isVue = edit.file.endsWith(".vue")
    const target = isJsx
      ? resolveJsxEditTarget(source, edit.line, edit.column)
      : isVue
        ? resolveVueEditTarget(source, edit.line, edit.column)
        : null
    if (!target) return

    const grounding = await getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders)
    const manifestSource = await grounding.getManifestSource()
    if (!manifestSource) return

    for (const name of candidateComponentNames(target.tag)) {
      // `name` here is a candidate TAG spelling (kebab-case or its
      // PascalCase conversion). The import-binding map is keyed by the
      // same local identifiers, but the manifest itself is keyed by the
      // EXPORTED name, which differs from the local one only for an
      // aliased named import (codex P2 fix, 2026-07-30 — see
      // `ImportBinding`'s doc comment). When no binding is found for this
      // candidate (e.g. a locally-declared component, or the kebab-case
      // spelling that never appears as an import identifier), fall back
      // to looking the candidate up directly, same as before this fix.
      const binding = target.imports.get(name)
      const manifestLookupName = binding?.exportedName ?? name
      const importPath = binding?.importPath
      const manifest = await resolveManifestForName(manifestSource, manifestLookupName, importPath)
      if (manifest === AMBIGUOUS) return
      if (!manifest) continue

      const signal = detectManifestValueMismatch({
        manifest,
        propName: edit.propName,
        value: edit.value,
      })
      if (signal) {
        const entry = ctx.driftLog.record(signal)
        triggerRepairForEntry(signal.kind, entry, ctx)
      }
      return
    }
  } catch {
    // Advisory-only — a failure here must never affect the edit that
    // already succeeded. See the module doc comment.
  }
}

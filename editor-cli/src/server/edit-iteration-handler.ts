/**
 * Deterministic iteration-data edit endpoint for the CLI HTTP server
 * (`POST /api/editor/edit-iteration`). Phase 3 of
 * `tasks/_archive/one-shot-tasks/iteration-aware-edits.md`.
 *
 * Accepts a `templateLocation` (v-for position in the SFC) +
 * iteration context + operation payload. Server-side:
 *   1. Reads the SFC.
 *   2. Calls the Vue same-file resolver to find the array literal.
 *   3. Calls the static applicator to mutate the array.
 *   4. Returns the new source as a proposal — does NOT write to disk.
 *      Client buffers an OverwriteEdit and Save commits through the
 *      normal edit flow.
 *
 * Returns 422 with `{ ok: false, reason }` when resolution is
 * unsuccessful so the client can fall back to the LLM lane.
 *
 * Prototype root is resolved from the CLI's RouteContext
 * (`ctx.repoRoot` — the active worktree branch) rather than
 * `resolvePrototypeRootForRequest` (which reads a session header).
 * Edits land in the worktree, so the file reads AND the
 * path-traversal containment guards are both anchored to `repoRoot`.
 * The handler does not need `canonicalRoot` because the iteration
 * resolver doesn't probe `node_modules`.
 */

import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
  isWithinRoot,
} from "./resolve-editable-path"
import { resolveRelativeModule } from "./resolve-relative-module.js"
import { readRawBody, BodyTooLargeError, EDIT_BODY_MAX_BYTES } from "./http-body.js"
import type { IterateeImportCandidate } from "../../../src/editor/edit-service/import-binding"
import { iterationTextProblem } from "../../../src/editor/edit-service/iteration-text-limits"

// ---------------------------------------------------------------------------
// Request body type + validator
// ---------------------------------------------------------------------------

export interface IterationEditRequestBody {
  /** Repo-relative path of the SFC containing the v-for. */
  file: string
  /** SFC-absolute (1-based) position of the v-for template element. */
  templateLocation: { line: number; column: number }
  /**
   * Position of the element the designer actually clicked, when that is
   * NESTED inside the loop root rather than being it.
   *
   * The two consumers want different positions. The data resolver matches the
   * loop element exactly, so it gets `templateLocation`. The `patch-text`
   * interpolation extractor reads the direct children of the position it is
   * given to name the property behind the text, so it gets this one:
   * `<li><span>{item.name}</span><span>{item.email}</span></li>` retyped on
   * the email span patched `name` while both positions were the `<li>`.
   *
   * Optional. An older client sends only `templateLocation`, and the extractor
   * falls back to it, which is the behaviour before this field existed.
   */
  fieldLocation?: { line: number; column: number }
  /**
   * Page source file when known. Phase 4 fallback: when same-file
   * resolution fails AND `pageSourceFile` is supplied, try the
   * cross-component resolver against the page SFC.
   */
  pageSourceFile?: string | null
  iterationContext: {
    key: string | number
    index: number
    siblingCount: number
    source?: string
    expression?: string | null
  }
  payload:
    | { operation: "remove" }
    | { operation: "patch"; updates: Record<string, unknown> }
    | { operation: "duplicate"; afterMatch?: boolean }
    | { operation: "reorder"; toIndex: number }
    | { operation: "insert"; entry: unknown; position: "before" | "after" }
    /**
     * "This row" for a TEXT edit. The client knows the new text but NOT which
     * property of the row produced it — that needs the source, which lives
     * here. The server derives the key with the interpolation extractor and
     * rewrites this into a plain `patch` before the applicator ever sees it,
     * so the applicator keeps exactly one text-shaped operation to reason
     * about.
     */
    | { operation: "patch-text"; value: string }
}

function hasNodeModulesSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules")
}

export function validateIterationBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object"
  const b = body as Record<string, unknown>
  if (typeof b.file !== "string" || b.file.length === 0)
    return "body.file required"
  const tl = b.templateLocation as Record<string, unknown> | undefined
  if (
    !tl ||
    typeof tl.line !== "number" ||
    typeof tl.column !== "number" ||
    tl.line < 1 ||
    tl.column < 0
  ) {
    // Column 0 is valid for JSX (Babel 0-based); Vue's are 1-based.
    return "body.templateLocation must be { line, column } (line 1-based, column >= 0)"
  }
  // Same rule when present: it is dispatched as a source coordinate, and a
  // bad one reads a position in a file.
  const fl = b.fieldLocation as Record<string, unknown> | undefined
  if (fl !== undefined && fl !== null) {
    if (
      typeof fl !== "object" ||
      typeof fl.line !== "number" ||
      typeof fl.column !== "number" ||
      fl.line < 1 ||
      fl.column < 0
    ) {
      return "body.fieldLocation must be { line, column } (line 1-based, column >= 0)"
    }
  }
  const ic = b.iterationContext as Record<string, unknown> | undefined
  if (
    !ic ||
    (typeof ic.key !== "string" && typeof ic.key !== "number") ||
    typeof ic.index !== "number"
  ) {
    return "body.iterationContext required with key + index"
  }
  // The two free-text fields ride into an LLM request when this route refuses
  // and the client falls back. The client checks them at its wire boundary;
  // this route must not trust a hand-built request either, so the SAME rule is
  // applied here. See `iteration-text-limits.ts`.
  const keyProblem = typeof ic.key === "string" ? iterationTextProblem("key", ic.key) : null
  if (keyProblem) return `body.iterationContext.${keyProblem}`
  if (ic.expression !== undefined && ic.expression !== null) {
    if (typeof ic.expression !== "string") return "body.iterationContext.expression must be a string or null"
    const problem = iterationTextProblem("expression", ic.expression)
    if (problem) return `body.iterationContext.${problem}`
  }
  const p = b.payload as Record<string, unknown> | undefined
  if (!p || typeof p.operation !== "string") {
    return "body.payload.operation required"
  }
  const ops = new Set(["remove", "patch", "duplicate", "reorder", "insert", "patch-text"])
  if (!ops.has(p.operation as string)) {
    return `body.payload.operation must be one of ${[...ops].join(" | ")}`
  }
  if (p.operation === "patch-text" && typeof p.value !== "string") {
    return "body.payload.value must be a string for operation 'patch-text'"
  }
  return null
}

// ---------------------------------------------------------------------------
// Core handler — pure-ish function for testability
// ---------------------------------------------------------------------------

export type IterationEditResult =
  | {
      ok: true
      status: 200
      proposal: {
        newSource: string
        explanation: string
        baseHash: string
        file: string
      }
      proposalId: string
    }
  | { ok: false; status: number; reason: string; kind?: string }

/**
 * Core logic extracted from the HTTP handler so tests can call it
 * without spinning up an HTTP server.
 *
 * @param body     — validated request body
 * @param repoRoot — active worktree root (file reads happen here)
 */
export async function handleIterationEdit(
  body: IterationEditRequestBody,
  repoRoot: string,
): Promise<IterationEditResult> {
  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const { rootReal, rootWithSep } = rootResolution

  const candidateResolution = resolveCandidateWithinRoot(body.file, rootResolution)
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  const isSupportedIterationFile = (p: string): boolean =>
    p.endsWith(".vue") || p.endsWith(".tsx") || p.endsWith(".jsx")
  if (!isSupportedIterationFile(candidate)) {
    return { ok: false, status: 400, reason: "Only .vue, .tsx, and .jsx files are supported" }
  }

  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution)
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath } = realpathResolution
  // The gate above checked the NAME the request asked for. A symlink with a
  // supported name can point at anything, so the RESOLVED target is checked
  // too, before the read. Same wording the other routes use for this.
  if (!isSupportedIterationFile(targetPath)) {
    return { ok: false, status: 400, reason: "Resolved target is not a .vue, .tsx, or .jsx file" }
  }
  // A dependency is never an edit target on this route either: the proposal
  // would be a full-file overwrite of library source that the next install
  // erases (codex round 4; the AI lane got the same guard in round 2).
  if (hasNodeModulesSegment(candidate) || hasNodeModulesSegment(targetPath)) {
    return {
      ok: false,
      status: 400,
      reason: "This file belongs to an installed library, which the Editor does not edit",
    }
  }

  let source: string
  try {
    source = await fs.readFile(targetPath, "utf8")
  } catch (e) {
    return {
      ok: false,
      status: 404,
      reason: `Could not read file: ${(e as Error).message}`,
    }
  }

  // Framework-aware resolution by extension: JSX `.map()` for .tsx/.jsx, Vue
  // `v-for` otherwise. Both return { arrayLocation, keyProperty } that the
  // static applicator consumes (it already handles .tsx whole-source rewriting).
  const isJsxIteration =
    targetPath.endsWith(".tsx") || targetPath.endsWith(".jsx")
  // Two files from here on, and they must not be conflated:
  //   - `source` is the LOOP file — the file the click landed in, where
  //     `templateLocation` points. The text-field interpolation extractor
  //     reads THIS file at that position.
  //   - `dataSource` / `dataFile` is where the array literal lives. Same file
  //     in the plain case; the imported module when the iteratee is imported;
  //     the parent page in the Vue cross-component case. The array rewriter
  //     edits THIS file, and the proposal names it.
  // Before 2026-09-08 one `resolvedSource` served both roles, so a retyped
  // text in a child component whose data lives in the page was extracted
  // from the PAGE at the COMPONENT's coordinates.
  let dataSource = source
  let dataFile = body.file
  let resolution: {
    ok: boolean
    file?: string | null
    arrayLocation?: { line: number; column: number }
    iterateeRoot?: string
    /** Loop variable — `r` in `v-for="r in rows"`, `item` in `.map((item) …)`.
     *  Distinct from `iterateeRoot`, which names the ARRAY. */
    itemVar?: string
    /** Entry count of the resolved array literal — see the matcher note. */
    entryCount?: number
    iterateeChain?: unknown[]
    keyProperty?: string | null
    reason?: string
    /** Same-file miss, but the name is imported: follow the import below. */
    importCandidate?: IterateeImportCandidate
  }
  if (isJsxIteration) {
    const { resolveIterationDataJsxSameFile } = await import(
      "../../../src/editor/edit-service/resolve-iteration-data-jsx.js"
    )
    const jsx = resolveIterationDataJsxSameFile({
      source,
      templateLocation: body.templateLocation,
    })
    resolution = jsx.ok
      ? {
          ok: true,
          file: body.file,
          arrayLocation: jsx.arrayLocation,
          iterateeRoot: jsx.iterateeRoot,
          itemVar: jsx.itemVar,
          entryCount: jsx.entryCount,
          iterateeChain: [],
          keyProperty: jsx.keyProperty,
        }
      : { ok: false, reason: jsx.reason, importCandidate: jsx.importCandidate }
  } else {
    const { resolveIterationDataVueSameFile } = await import(
      "../../../src/editor/edit-service/resolve-iteration-data-vue.js"
    )
    resolution = resolveIterationDataVueSameFile({
      source,
      templateLocation: body.templateLocation,
    })
  }

  // Imported data (both frameworks): the loop's array is `import { X } from
  // "./data"`. The resolver named the specifier; this is the one filesystem
  // hop, with the same containment guards as the loop file. One hop, named
  // export, `export const X = [ … ]` — anything else stays a 422 and the AI
  // lane gets the bundle. This is the case that shipped broken in the React
  // demo (`METRICS` in `data.ts`, 2026-09-08).
  if (!resolution.ok && resolution.importCandidate) {
    const candidate = resolution.importCandidate
    const { findExportedArrayLiteral } = await import(
      "../../../src/editor/edit-service/import-binding.js"
    )
    const mod = await resolveRelativeModule(
      targetPath,
      candidate.binding.specifier,
      rootResolution,
    )
    if (!mod.ok) {
      resolution = {
        ok: false,
        reason: `${resolution.reason}, but that file could not be opened: ${mod.reason}`,
      }
    } else {
      const exported = findExportedArrayLiteral(mod.source, candidate.binding.importedName)
      if (exported) {
        resolution = {
          ok: true,
          file: mod.relativePath,
          arrayLocation: exported.arrayLocation,
          iterateeRoot: candidate.iterateeRoot,
          itemVar: candidate.itemVar,
          entryCount: exported.entryCount,
          iterateeChain: [],
          keyProperty: candidate.keyProperty,
        }
        dataSource = mod.source
        dataFile = mod.relativePath
      } else {
        resolution = {
          ok: false,
          reason:
            `${resolution.reason} (${mod.relativePath}), but that file does not define ` +
            `"${candidate.binding.importedName}" as a plain exported array literal`,
        }
      }
    }
  }

  // Phase 4 (Vue only): if same-file resolution missed AND we have a page
  // source hint that differs from the component, try cross-component resolution.
  if (!isJsxIteration && !resolution.ok && body.pageSourceFile && body.pageSourceFile !== body.file) {
    const pageCandidate = path.resolve(rootReal, body.pageSourceFile)
    let pageOk = isWithinRoot(pageCandidate, rootReal, rootWithSep)
    pageOk = pageOk && pageCandidate.endsWith(".vue")
    if (pageOk) {
      let pageReal: string | null = null
      try {
        pageReal = await fs.realpath(pageCandidate)
      } catch {
        pageReal = null
      }
      if (
        pageReal &&
        isWithinRoot(pageReal, rootReal, rootWithSep) &&
        pageReal.endsWith(".vue") &&
        !hasNodeModulesSegment(pageCandidate) &&
        !hasNodeModulesSegment(pageReal)
      ) {
        let pageSource: string | null = null
        try {
          pageSource = await fs.readFile(pageReal, "utf8")
        } catch {
          pageSource = null
        }
        // The page hint is client-supplied. It is only the caller of this
        // component if it imports it; a page that merely uses the same tag
        // name would otherwise have ITS array rewritten (codex round 5). The
        // AI lane applies the same check to its bundle.
        // The name the page renders the component BY is its import's local
        // name, which is not always the filename (`import CardAlias from
        // "./Card.vue"` renders `<CardAlias>`; codex round 6).
        let componentLocalNames: string[] = []
        if (pageSource !== null) {
          const [{ importedLocalNamesForFile, hasAnyLocalImport }, { moduleSourceOfFile }] =
            await Promise.all([
              import("../../../src/editor/edit-service/import-binding.js"),
              import("../../../src/editor/edit-service/vue-script-content.js"),
            ])
          const pageRel = path.relative(rootReal, pageReal).split(path.sep).join("/")
          const loopRel = path.relative(rootReal, targetPath).split(path.sep).join("/")
          const pageModule = moduleSourceOfFile(pageRel, pageSource)
          componentLocalNames = importedLocalNamesForFile(pageModule, pageRel, loopRel)
          // A page that imports NO local component at all is on auto-imports
          // (Nuxt, unplugin-vue-components): there is no import to check, so
          // the tag is the filename, as it was before this series.
          if (componentLocalNames.length === 0 && !hasAnyLocalImport(pageModule)) {
            componentLocalNames = [path.basename(body.file, ".vue")]
          }
        }
        if (pageSource !== null && componentLocalNames.length === 1) {
          const { resolveIterationDataVueCrossComponent } = await import(
            "../../../src/editor/edit-service/resolve-iteration-data-vue-cross-component.js"
          )
          // The tag the page uses for this component is the import's local
          // name (usually, but not always, the filename). The resolver
          // matches both its PascalCase and kebab-case forms.
          const componentName = componentLocalNames[0]
          const crossResult = resolveIterationDataVueCrossComponent({
            componentSource: source,
            templateLocation: body.templateLocation,
            pageSource,
            pageSourceFile: body.pageSourceFile,
            componentName,
          })
          if (crossResult.ok) {
            resolution = {
              ok: true,
              file: crossResult.file,
              arrayLocation: crossResult.arrayLocation,
              iterateeRoot: "",
              iterateeChain: [],
              keyProperty: crossResult.keyProperty,
              entryCount: crossResult.entryCount,
              itemVar: crossResult.itemVar,
            }
            dataSource = pageSource
            dataFile = body.pageSourceFile
          }
        }
      }
    }
  }

  if (!resolution.ok) {
    // 422 = "Unresolved" — distinct from 400 (bad body) and 500 (bug).
    // Client uses this to decide whether to fall through to the LLM lane.
    return {
      ok: false,
      status: 422,
      reason: resolution.reason ?? "Could not resolve iteration data",
      kind: "unresolved",
    }
  }
  if (!resolution.arrayLocation) {
    return { ok: false, status: 500, reason: "Resolver returned no array location" }
  }
  const arrayLocation = resolution.arrayLocation

  // ── "this row" for a TEXT edit ─────────────────────────────────────────
  //
  // Turn `patch-text` into a plain `patch` by asking the source WHICH property
  // of the row produced the text the designer retyped. The client cannot do
  // this: it has the new string but not the file. Both extractors share one
  // refusal set on purpose — a designer must not find that "this row" means
  // something different depending on their framework — and a refusal here is a
  // 422, which is exactly how the client already decides to offer the LLM lane.
  let operation = body.payload as { operation: string; value?: string }
  if (operation.operation === "patch-text") {
    // The LOOP VARIABLE, not `iterateeRoot` (which is the ARRAY). Passing the
    // array name here made every extraction refuse with
    // "root `r` does not match the v-for iteratee `rows`" — a message that
    // reads like the user wrote something wrong. Measured 2026-08-16 on the
    // first live run of this lane.
    const itemVar = resolution.itemVar
    if (!itemVar) {
      return {
        ok: false,
        status: 422,
        reason:
          "Resolver could not name the loop variable, so the field behind this text is unknown",
        kind: "unresolved",
      }
    }
    // The FIELD's position, not the loop's. The extractor names the property
    // behind the text on the element it is pointed at, so a nested field must
    // be pointed at itself; the loop root answers for the row's first field.
    const fieldPosition = body.fieldLocation ?? body.templateLocation
    const keyResult = isJsxIteration
      ? (
          await import(
            "../../../src/editor/edit-service/extract-jsx-interpolation-key.js"
          )
        ).extractJsxInterpolationKey({
          source,
          line: fieldPosition.line,
          column: fieldPosition.column,
          itemVar,
        })
      : (
          await import(
            "../../../src/editor/edit-service/extract-slot-interpolation-key.js"
          )
        ).extractSlotInterpolationKey({
          source,
          line: fieldPosition.line,
          column: fieldPosition.column,
          itemVar,
        })
    if (!keyResult.ok) {
      return { ok: false, status: 422, reason: keyResult.reason, kind: "unresolved" }
    }
    operation = {
      operation: "patch",
      updates: { [keyResult.propertyKey]: operation.value ?? "" },
    } as unknown as { operation: string; value?: string }
  }

  const { applyIterationDataEditStatic } = await import(
    "../../../src/editor/edit-service/apply-iteration-data-edit-static.js"
  )

  // Match by the property the v-for's `:key` actually reads, not a
  // hardcoded `'key'`. If the resolver couldn't extract the property
  // (`:key="item"` itself, the v-for index, or a complex expression),
  // fall back to positional indexing.
  //
  // ── Why `key === index` falls back to positional matching ───────────────
  //
  // `iterationContext.key` is NOT always the framework's key. The bridge seeds
  // it with the positional index and only upgrades it by walking the component
  // chain for an instance whose callsite stamp matches the row
  // (`detectIterationViaStamp`). A `v-for` / `.map()` over NATIVE elements has
  // no such component, so the key stays positional — and matching a positional
  // key against the `:key` PROPERTY silently selects the wrong row.
  //
  // MEASURED 2026-08-17 by the live smoke, on `<li v-for="r in rows" :key="r.id">`
  // with ids 1..3: retyping row 2 (index 1) matched `id === 1` and rewrote
  // ROW 1. Pre-existing — delete / prop / move share this matcher — and only
  // visible end to end, because every unit test hands in a key it chose.
  //
  // `key !== index` proves the bridge upgraded it, so the property is right.
  // `key === index` is ambiguous (positional fallback, or a real key that
  // happens to equal its position) and positional matching is correct in BOTH:
  // the row was READ at that render position, and the resolver only resolves
  // iteratees it can trace to an array literal, where render order is array
  // order.
  // A key EQUAL to its index cannot be told apart from the positional seed, so
  // positional matching is only safe when render order provably equals array
  // order — i.e. nothing was filtered out. `siblingCount` counts RENDERED rows;
  // `entryCount` counts source entries. Codex round 2 (P1) supplied the case
  // this closes: `[{id:99,show:false},{id:0},{id:1}]` renders 2 rows, so the
  // first visible row arrives as `{key:0,index:0}` and positional matching
  // would rewrite the HIDDEN entry 0. When the counts disagree the row is not
  // identifiable either way, so refuse to the LLM lane rather than guess.
  const keyLooksPositional = body.iterationContext.key === body.iterationContext.index
  if (
    keyLooksPositional &&
    typeof resolution.entryCount === "number" &&
    resolution.entryCount !== body.iterationContext.siblingCount
  ) {
    return {
      ok: false,
      status: 422,
      reason:
        `This loop renders ${body.iterationContext.siblingCount} of ${resolution.entryCount} entries, ` +
        "so the row you picked cannot be mapped to a source entry by position, and the framework " +
        "gave no key to match on.",
      kind: "unresolved",
    }
  }
  const matcher = resolution.keyProperty && !keyLooksPositional
    ? ({
        kind: "object-property" as const,
        property: resolution.keyProperty,
        value: body.iterationContext.key,
        // React stringifies `key={item.id}` ("1") even for numeric-id arrays —
        // opt the JSX path into String-coerced matching. Vue keeps `:key` typed
        // and uses strict equality (distinguishes `{id:1}` from `{id:"1"}`).
        coerce: isJsxIteration,
      } as const)
    : ({
        kind: "index" as const,
        index: body.iterationContext.index,
      } as const)

  const applyResult = applyIterationDataEditStatic({
    source: dataSource,
    file: dataFile,
    arrayLocation,
    matchers: [matcher],
    operation: operation as unknown as Parameters<
      typeof applyIterationDataEditStatic
    >[0]["operation"],
  })
  if (!applyResult.ok) {
    return {
      ok: false,
      status: 422,
      reason: applyResult.reason,
      kind: "apply-failed",
    }
  }

  // Return as a proposal — same shape as the llm-fallback response so
  // the client's buffer code is uniform. The baseHash protects against
  // disk-changed-between-propose-and-save races (Phase E guard).
  const baseHash = createHash("sha256")
    .update(dataSource, "utf8")
    .digest("hex")
  return {
    ok: true,
    status: 200,
    proposal: {
      newSource: applyResult.source,
      explanation: `Iteration ${body.payload.operation}: row ${JSON.stringify(body.iterationContext.key)} via static resolver`,
      baseHash,
      file: dataFile,
    },
    proposalId: randomUUID(),
  }
}

// ---------------------------------------------------------------------------
// HTTP adapter — reads body, calls core, writes response
// ---------------------------------------------------------------------------

/**
 * HTTP-level entry point wired from http-server.ts.
 * `sendJson` is passed in to avoid importing it here (same pattern as
 * other sibling handlers that inline their HTTP response logic).
 */
export async function handleEditIterationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repoRoot: string,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  let raw: string
  try {
    raw = await readRawBody(req, { maxBytes: EDIT_BODY_MAX_BYTES })
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, reason: err.message })
      return
    }
    throw err
  }

  let body: IterationEditRequestBody
  try {
    body = JSON.parse(raw) as IterationEditRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }

  const validationError = validateIterationBody(body)
  if (validationError) {
    sendJson(res, 400, { ok: false, reason: validationError })
    return
  }

  const result = await handleIterationEdit(body, repoRoot)
  if (result.ok) {
    sendJson(res, result.status, {
      ok: true,
      proposal: result.proposal,
      proposalId: result.proposalId,
    })
  } else {
    sendJson(res, result.status, {
      ok: false,
      reason: result.reason,
      ...(result.kind !== undefined ? { kind: result.kind } : {}),
    })
  }
}

/**
 * `POST /api/editor/resolve-callsites`: for each element that is the root
 * of a component the runtime has no instance for, where is that component
 * written in the file the element is displayed inside?
 *
 * The Structure panel asks this once per structure fetch, for every row
 * whose source file differs from its nearest stamped ancestor's (see
 * `src/hooks/resolve-layer-callsites.ts`). A row it can answer is
 * re-targeted at the callsite, so a move among its siblings is a same-file
 * move again. A row it cannot answer stays as the bridge reported it: null
 * here is an ordinary answer, never an error, and one unreadable file does
 * not fail the batch.
 *
 * Same containment rules as `iteration-verify-handler.ts`: inside the root,
 * realpath-checked, never a dependency. A path that ESCAPES the root does
 * fail the whole request — that is a client bug or an attack, not a row the
 * bridge happened to see. Bound through `http-server.ts`.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
  type ResolvedRoot,
} from "./resolve-editable-path"
import { readRawBody, BodyTooLargeError } from "./http-body.js"
import { sourceVersionOf } from "../plugins/source-version.js"

export interface ResolveCallsitesItem {
  /** Repo-relative path of the file the element's stamp names. */
  file: string
  /** The stamp's position: line 1-based, column Babel 0-based. */
  line: number
  column: number
  /** Repo-relative path of the file the element is displayed inside. */
  parentFile: string
}

export interface ResolveCallsitesRequestBody {
  items: ResolveCallsitesItem[]
}

export interface ResolvedCallsite {
  name: string
  /**
   * The parent file's version, the same hash its `data-desde-v` stamps
   * carry, so a target recovered from it keeps the stale-target guard.
   */
  parentHash: string
  /** See `JsxCallsite` in `resolve-jsx-callsite.ts` for `inExpression`. */
  callsites: Array<{ line: number; column: number; inExpression: boolean }>
}

export type ResolveCallsitesResult =
  | { ok: true; status: 200; results: Array<ResolvedCallsite | null> }
  | { ok: false; status: number; reason: string }

/** One tree's worth of rows; the panel caps at 2000 rows and sends a fraction. */
const MAX_ITEMS = 200
/** Positions and two paths per item. */
const BODY_MAX_BYTES = 64 * 1024

function hasNodeModulesSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules")
}

function isJsxFile(p: string): boolean {
  return p.endsWith(".tsx") || p.endsWith(".jsx")
}

export function validateResolveCallsitesBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object"
  const items = (body as Record<string, unknown>).items
  if (!Array.isArray(items)) return "body.items must be an array"
  if (items.length > MAX_ITEMS) return `body.items must hold at most ${MAX_ITEMS} entries`
  for (const [i, raw] of items.entries()) {
    if (!raw || typeof raw !== "object") return `body.items[${i}] must be an object`
    const item = raw as Record<string, unknown>
    if (typeof item.file !== "string" || item.file.length === 0) return `body.items[${i}].file required`
    if (typeof item.parentFile !== "string" || item.parentFile.length === 0) {
      return `body.items[${i}].parentFile required`
    }
    if (!Number.isInteger(item.line) || (item.line as number) < 1) {
      return `body.items[${i}].line must be a positive integer`
    }
    if (!Number.isInteger(item.column) || (item.column as number) < 0) {
      return `body.items[${i}].column must be a non-negative integer`
    }
  }
  return null
}

type Loaded =
  | { kind: "source"; source: string; relPath: string }
  | { kind: "skip" }
  | { kind: "escape"; reason: string }

/**
 * Read one repo-relative file under the containment rules. `skip` is the
 * ordinary "not a file this can answer for" (missing, a dependency, not
 * JSX); `escape` is the one outcome that fails the request.
 */
async function loadWithinRoot(
  relPath: string,
  root: ResolvedRoot,
  cache: Map<string, Loaded>,
): Promise<Loaded> {
  const cached = cache.get(relPath)
  if (cached) return cached
  const loaded = await (async (): Promise<Loaded> => {
    // Lexical gates first, before anything touches the filesystem.
    if (!isJsxFile(relPath) || hasNodeModulesSegment(relPath)) return { kind: "skip" }
    const candidate = resolveCandidateWithinRoot(relPath, root)
    if (!candidate.ok) return { kind: "escape", reason: candidate.reason }
    const real = await resolveRealpathWithinRoot(candidate.candidate, root)
    if (!real.ok) {
      return real.status === 400 ? { kind: "escape", reason: real.reason } : { kind: "skip" }
    }
    // Gate the RESOLVED target too: a symlink named `x.tsx` can point anywhere.
    if (!isJsxFile(real.targetPath) || hasNodeModulesSegment(real.targetPath)) return { kind: "skip" }
    try {
      const source = await fs.readFile(real.targetPath, "utf8")
      return { kind: "source", source, relPath: path.relative(root.rootReal, real.targetPath) }
    } catch {
      return { kind: "skip" }
    }
  })()
  cache.set(relPath, loaded)
  return loaded
}

export async function handleResolveCallsites(
  body: ResolveCallsitesRequestBody,
  repoRoot: string,
): Promise<ResolveCallsitesResult> {
  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const { resolveJsxComponentRoot, findJsxCallsites } = await import(
    "../../../src/editor/edit-service/resolve-jsx-callsite.js"
  )
  const cache = new Map<string, Loaded>()
  const results: Array<ResolvedCallsite | null> = []
  for (const item of body.items) {
    const definition = await loadWithinRoot(item.file, rootResolution, cache)
    if (definition.kind === "escape") return { ok: false, status: 400, reason: definition.reason }
    const parent = await loadWithinRoot(item.parentFile, rootResolution, cache)
    if (parent.kind === "escape") return { ok: false, status: 400, reason: parent.reason }
    if (definition.kind !== "source" || parent.kind !== "source") {
      results.push(null)
      continue
    }
    const root = resolveJsxComponentRoot(definition.source, item.line, item.column)
    if (!root) {
      results.push(null)
      continue
    }
    // Compare on the paths the files really live at, so a symlinked import
    // path and a direct one agree.
    const callsites = findJsxCallsites({
      source: parent.source,
      name: root.name,
      definitionFile: definition.relPath.split(path.sep).join("/"),
      parentFile: parent.relPath.split(path.sep).join("/"),
    })
    results.push(
      callsites && callsites.length > 0
        ? { name: root.name, parentHash: sourceVersionOf(parent.source), callsites }
        : null,
    )
  }
  return { ok: true, status: 200, results }
}

export async function handleResolveCallsitesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repoRoot: string,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  let raw: string
  try {
    raw = await readRawBody(req, { maxBytes: BODY_MAX_BYTES })
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, reason: err.message })
      return
    }
    throw err
  }
  let body: ResolveCallsitesRequestBody
  try {
    body = JSON.parse(raw) as ResolveCallsitesRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const validationError = validateResolveCallsitesBody(body)
  if (validationError) {
    sendJson(res, 400, { ok: false, reason: validationError })
    return
  }
  const result = await handleResolveCallsites(body, repoRoot)
  if (result.ok) {
    sendJson(res, 200, { ok: true, results: result.results })
  } else {
    sendJson(res, result.status, { ok: false, reason: result.reason })
  }
}

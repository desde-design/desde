/**
 * `POST /api/editor/iteration/verify`: does the element at a source position
 * sit inside a loop?
 *
 * The client calls this BEFORE it opens the "this item or all items" dialog.
 * The bridge's iteration classification comes from DOM stamps, and N usages
 * of one component produce the same evidence as one usage in a loop. When
 * source has no loop at the position, the client hands the edit to chat
 * instead of asking a question that has no right answer.
 *
 * Same containment rules as `edit-iteration-handler.ts`: inside the root,
 * realpath-checked, never a dependency. A missing loop is a 200 with
 * `loop: null`, not an error. Bound through `http-server.ts`.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
} from "./resolve-editable-path"
import { readRawBody, BodyTooLargeError } from "./http-body.js"

export interface IterationVerifyRequestBody {
  /** Repo-relative path of the file the click's stamp names. */
  file: string
  /** The stamp's position. Line 1-based; column Babel 0-based (JSX) or 1-based (Vue). */
  templateLocation: { line: number; column: number }
}

export type IterationVerifyResult =
  | {
      ok: true
      status: 200
      loop: { kind: "map" | "v-for"; expression: string } | null
      /** Why no loop was found. Present only when `loop` is null. */
      reason?: string
    }
  | { ok: false; status: number; reason: string }

/** Small body; a position and a path. */
const VERIFY_BODY_MAX_BYTES = 16 * 1024

function hasNodeModulesSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules")
}

export function validateIterationVerifyBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object"
  const b = body as Record<string, unknown>
  if (typeof b.file !== "string" || b.file.length === 0) return "body.file required"
  const tl = b.templateLocation as Record<string, unknown> | undefined
  // `Number.isInteger`, not `typeof === "number"`: NaN and 1.5 are numbers,
  // and both reach the parser as a position that can never match a node.
  if (
    !tl ||
    !Number.isInteger(tl.line) ||
    !Number.isInteger(tl.column) ||
    (tl.line as number) < 1 ||
    (tl.column as number) < 0
  ) {
    return "body.templateLocation must be { line, column } integers (line 1-based, column >= 0)"
  }
  return null
}

function isSupportedIterationFile(p: string): boolean {
  return p.endsWith(".vue") || p.endsWith(".tsx") || p.endsWith(".jsx")
}

export async function handleIterationVerify(
  body: IterationVerifyRequestBody,
  repoRoot: string,
): Promise<IterationVerifyResult> {
  // Extension gate FIRST, lexically, before anything touches the filesystem.
  // `edit-iteration-handler.ts` gates on the resolved candidate; this route
  // gates one step earlier because it was the ordering that leaked. Reading
  // the bytes first pulled `.env` into memory, and answering 404 for a
  // missing path while answering 200 for an existing one made the route an
  // existence oracle for any path inside the root.
  if (!isSupportedIterationFile(body.file)) {
    return { ok: false, status: 400, reason: "Only .vue, .tsx, and .jsx files are supported" }
  }
  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const candidateResolution = resolveCandidateWithinRoot(body.file, rootResolution)
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution)
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath } = realpathResolution
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
    return { ok: false, status: 404, reason: `Could not read file: ${(e as Error).message}` }
  }
  const { locateLoopAt } = await import("../../../src/editor/edit-service/locate-loop.js")
  // Parse by the extension of the file the bytes actually came from, not the
  // one the client named. `body.file` may be a symlink whose extension says
  // nothing about the target's syntax, and `locateLoopAt` dispatches JSX vs
  // Vue on the extension alone. Mirrors `llm-fallback-handler.ts`'s
  // `resolvedRelPath`.
  const resolvedRelPath = path.relative(rootResolution.rootReal, targetPath)
  const located = locateLoopAt({ file: resolvedRelPath, source, templateLocation: body.templateLocation })
  if (located.found) {
    return { ok: true, status: 200, loop: { kind: located.kind, expression: located.expression } }
  }
  return { ok: true, status: 200, loop: null, reason: located.reason }
}

export async function handleIterationVerifyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repoRoot: string,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  let raw: string
  try {
    raw = await readRawBody(req, { maxBytes: VERIFY_BODY_MAX_BYTES })
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, reason: err.message })
      return
    }
    throw err
  }
  let body: IterationVerifyRequestBody
  try {
    body = JSON.parse(raw) as IterationVerifyRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const validationError = validateIterationVerifyBody(body)
  if (validationError) {
    sendJson(res, 400, { ok: false, reason: validationError })
    return
  }
  const result = await handleIterationVerify(body, repoRoot)
  if (result.ok) {
    sendJson(res, 200, { ok: true, loop: result.loop, ...(result.reason ? { reason: result.reason } : {}) })
  } else {
    sendJson(res, result.status, { ok: false, reason: result.reason })
  }
}

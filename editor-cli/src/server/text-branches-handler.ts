/**
 * CLI HTTP handler for `POST /api/editor/text-branches`.
 *
 * Returns the conditional-text branches for an element at (line, column)
 * in a .vue / .tsx / .jsx file inside the prototype repo. Drives the
 * inspector's two-field UI for `{{ test ? a : b }}` (Vue) and
 * `{test ? a : b}` (JSX) conditional text — the detector is framework-aware
 * by extension; both produce the same `TextBranch` shape.
 *
 * Security model matches `applyEdit`: candidate path must resolve
 * (after symlink) inside the configured repo root, and the target must
 * be a .vue / .tsx / .jsx file. No write side effects — read-only.
 */

import { promises as fs } from "node:fs"
import type { DetectTextBranchesResult } from "../../../src/editor/edit-service/detect-text-branches"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
} from "./resolve-editable-path"

export interface TextBranchesRequestBody {
  file?: unknown
  line?: unknown
  column?: unknown
}

export type TextBranchesResult =
  | { ok: true; status: 200; testExpression: string; branches: DetectTextBranchesResult["branches"] }
  | { ok: false; status: number; reason: string }

export interface TextBranchesLoaders {
  /**
   * Dynamic import for the detector. Mirrors the `applicatorLoaders`
   * pattern in edit-handler.ts — tests inject a stub; production wires
   * the in-tree module via `defaultTextBranchesLoaders`.
   */
  loadDetectTextBranches: () => Promise<typeof import("../../../src/editor/edit-service/detect-text-branches")>
  /** JSX sibling detector for .tsx/.jsx files. Optional for backward compat. */
  loadDetectJsxTextBranches?: () => Promise<typeof import("../../../src/editor/edit-service/detect-jsx-text-branches")>
}

export const defaultTextBranchesLoaders: TextBranchesLoaders = {
  loadDetectTextBranches: () =>
    import("../../../src/editor/edit-service/detect-text-branches"),
  loadDetectJsxTextBranches: () =>
    import("../../../src/editor/edit-service/detect-jsx-text-branches"),
}

export async function getTextBranches(
  body: TextBranchesRequestBody,
  repoRoot: string,
  loaders: TextBranchesLoaders = defaultTextBranchesLoaders,
): Promise<TextBranchesResult> {
  if (typeof body.file !== "string" || body.file.length === 0) {
    return { ok: false, status: 400, reason: "file required" }
  }
  if (
    typeof body.line !== "number" ||
    !Number.isInteger(body.line) ||
    body.line < 1
  ) {
    return { ok: false, status: 400, reason: "line must be a positive integer" }
  }
  if (
    typeof body.column !== "number" ||
    !Number.isInteger(body.column) ||
    body.column < 0
  ) {
    // 0-based columns are valid for JSX (Babel); Vue's are 1-based so a 0 just
    // no-matches there. Mirrors the edit-handler's relaxed column gate.
    return { ok: false, status: 400, reason: "column must be a non-negative integer" }
  }
  const { file, line, column } = body as { file: string; line: number; column: number }

  const rootResolution = await resolvePrototypeRoot(
    repoRoot,
    (m) => `Repo root unreadable: ${m}`,
  )
  if (!rootResolution.ok) return rootResolution
  const isSupported = (p: string): boolean =>
    p.endsWith(".vue") || p.endsWith(".tsx") || p.endsWith(".jsx")
  const candidateResolution = resolveCandidateWithinRoot(
    file,
    rootResolution,
    "File path escapes repo root",
  )
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  if (!isSupported(candidate)) {
    return { ok: false, status: 400, reason: "Only .vue, .tsx, and .jsx files are supported" }
  }
  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution, {
    escapeReason: "File path escapes repo root (after symlink resolution)",
  })
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath } = realpathResolution
  if (!isSupported(targetPath)) {
    return {
      ok: false,
      status: 400,
      reason: "Resolved target is not a .vue, .tsx, or .jsx file",
    }
  }

  let source: string
  try {
    source = await fs.readFile(targetPath, "utf8")
  } catch (err) {
    return {
      ok: false,
      status: 404,
      reason: `Could not read file: ${(err as Error).message}`,
    }
  }

  // Framework-aware by resolved-target extension: JSX (`{cond ? a : b}`) for
  // .tsx/.jsx, Vue (`{{ cond ? a : b }}`) otherwise.
  const isJsx = targetPath.endsWith(".tsx") || targetPath.endsWith(".jsx")
  let detection: DetectTextBranchesResult | null
  if (isJsx) {
    if (!loaders.loadDetectJsxTextBranches) {
      return { ok: false, status: 500, reason: "JSX text-branch detector is not wired" }
    }
    const { detectJsxTextBranches } = await loaders.loadDetectJsxTextBranches()
    detection = detectJsxTextBranches({ source, line, column })
  } else {
    const { detectTextBranches } = await loaders.loadDetectTextBranches()
    detection = detectTextBranches({ source, line, column })
  }
  if (!detection) {
    return {
      ok: false,
      status: 200,
      reason: "No conditional text at this location",
    }
  }
  return {
    ok: true,
    status: 200,
    testExpression: detection.testExpression,
    branches: detection.branches,
  }
}

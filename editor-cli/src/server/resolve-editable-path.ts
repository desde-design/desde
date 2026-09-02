import { promises as fs } from "node:fs"
import path from "node:path"

/**
 * Shared path-traversal guard for CLI HTTP handlers that accept a
 * repo-relative file path from the client (audit Task 20 dedup — this
 * exact three-step sequence was hand-copied across `edit-handler.ts`
 * (twice), `edit-iteration-handler.ts`, `file-read-handler.ts`,
 * `llm-fallback-handler.ts`, and `text-branches-handler.ts`).
 *
 * The sequence, split into three composable steps because callers
 * interleave their own extension/shape checks between them:
 *
 *   1. `resolvePrototypeRoot` — realpath the repo root itself (so a
 *      symlinked checkout still produces a canonical root to compare
 *      against). Callers do this once per request.
 *   2. `resolveCandidateWithinRoot` — lexically resolve the untrusted
 *      relative path against that root and refuse if it escapes, BEFORE
 *      touching the filesystem for the target itself.
 *   3. `resolveRealpathWithinRoot` — after whatever extension/shape
 *      checks the caller needs on the lexical candidate, realpath the
 *      candidate (resolving symlinks) and refuse again if the RESOLVED
 *      target escapes the root — closes the "symlink into elsewhere"
 *      gap the lexical check alone can't catch.
 *
 * Every call site's reason string and status code is preserved exactly
 * as it was before this extraction — most sites say "prototype root",
 * but `text-branches-handler.ts` says "repo root", so the reason text is
 * a parameter with the common wording as the default. This is a pure
 * dedup: no site's request/response behavior changed.
 *
 * NOTE: `src/editor/worktree/git-branches.ts`'s `resolveRepoRelative`
 * is a DELIBERATELY divergent sibling, not a missed call site — it skips
 * the `fs.realpath` step because `discardFile` legitimately targets
 * paths that may not exist on disk (a deleted file being restored, or a
 * rename's original path before it's recreated). See that function's own
 * doc comment.
 */

export interface ResolvedRoot {
  rootReal: string
  rootWithSep: string
}

export type ResolveRootResult =
  | ({ ok: true } & ResolvedRoot)
  | { ok: false; status: 503; reason: string }

/**
 * Realpath `repoRoot` and derive the trailing-separator form used by the
 * containment checks below. `unreadableReason` lets a caller match its own
 * wording (e.g. "Repo root unreadable" vs "Prototype root unreadable");
 * defaults to the wording every site but `text-branches-handler.ts` uses.
 */
export async function resolvePrototypeRoot(
  repoRoot: string,
  unreadableReason: (message: string) => string = (m) => `Prototype root unreadable: ${m}`,
): Promise<ResolveRootResult> {
  try {
    const rootReal = await fs.realpath(path.resolve(repoRoot))
    const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
    return { ok: true, rootReal, rootWithSep }
  } catch (err) {
    return { ok: false, status: 503, reason: unreadableReason((err as Error).message) }
  }
}

/** Pure containment predicate: does `candidate` sit at or under the root? */
export function isWithinRoot(candidate: string, rootReal: string, rootWithSep: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootWithSep)
}

export type ResolveCandidateResult =
  | { ok: true; candidate: string }
  | { ok: false; status: 400; reason: string }

/**
 * Lexically resolve `relativePath` against `root` and refuse if it
 * escapes. Runs BEFORE any filesystem access on the target — the lexical
 * gate every site applies prior to `fs.realpath`.
 */
export function resolveCandidateWithinRoot(
  relativePath: string,
  root: ResolvedRoot,
  escapeReason = "File path escapes prototype root",
): ResolveCandidateResult {
  const candidate = path.resolve(root.rootReal, relativePath)
  if (!isWithinRoot(candidate, root.rootReal, root.rootWithSep)) {
    return { ok: false, status: 400, reason: escapeReason }
  }
  return { ok: true, candidate }
}

export type ResolveRealpathResult =
  | { ok: true; targetPath: string }
  | { ok: false; status: 404; reason: string }
  | { ok: false; status: 400; reason: string }

/**
 * Realpath `candidate` (resolving symlinks) and refuse if the RESOLVED
 * target escapes `root`. `notFoundReason`/`escapeReason` let a caller
 * match its own wording; defaults match every site but
 * `text-branches-handler.ts`.
 */
export async function resolveRealpathWithinRoot(
  candidate: string,
  root: ResolvedRoot,
  opts: {
    notFoundReason?: (message: string) => string
    escapeReason?: string
  } = {},
): Promise<ResolveRealpathResult> {
  const notFoundReason = opts.notFoundReason ?? ((m: string) => `Could not read file: ${m}`)
  const escapeReason =
    opts.escapeReason ?? "File path escapes prototype root (after symlink resolution)"
  let targetPath: string
  try {
    targetPath = await fs.realpath(candidate)
  } catch (err) {
    return { ok: false, status: 404, reason: notFoundReason((err as Error).message) }
  }
  if (!isWithinRoot(targetPath, root.rootReal, root.rootWithSep)) {
    return { ok: false, status: 400, reason: escapeReason }
  }
  return { ok: true, targetPath }
}

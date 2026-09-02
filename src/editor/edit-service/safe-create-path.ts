/**
 * Symlink-safe path validation for new-file creation (`allowCreate`).
 *
 * The standard pattern `realpath(root) + path.resolve(root, file) +
 * startsWith` works for existing files (realpath follows symlinks on
 * the final segment). For NEW files, the leaf doesn't exist — we
 * can't realpath the candidate. An attacker could pre-stage:
 *
 *   1. An ancestor symlink: `repo/link-dir -> /etc`, then ask to
 *      create `link-dir/passwd` — the lexical check passes (path
 *      lives under `repo/`), but writeFile follows the link and
 *      lands in `/etc/passwd`.
 *   2. A dangling leaf symlink: `repo/foo.vue -> /etc/passwd`.
 *      `stat(foo.vue)` returns ENOENT (target missing); `writeFile`
 *      then creates the LINK's target (yes, Node's fs.writeFile
 *      follows symlinks on write).
 *
 * This helper walks the lexical path segment-by-segment, calling
 * `lstat` on each existing ancestor. Symlink found → reject. Leaf
 * itself must also not be a symlink (use `lstat`, not `stat`).
 *
 * Returns the absolute path if every segment under the realpath'd
 * root is either a regular directory (existing) or a path component
 * that doesn't exist yet (to be created during mkdir/write).
 */

import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, relative as pathRelative, resolve as resolvePath, sep as pathSep } from 'node:path'

export interface SafeCreatePathOk {
  ok: true
  /** Absolute path of the leaf, ready to write. */
  absolute: string
}

export interface SafeCreatePathErr {
  ok: false
  reason: string
}

export type SafeCreatePathResult = SafeCreatePathOk | SafeCreatePathErr

export async function resolveSafeCreatePath(
  repoRoot: string,
  filePath: string,
): Promise<SafeCreatePathResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'path must be a non-empty string' }
  }
  let resolvedRoot: string
  try {
    resolvedRoot = await realpath(repoRoot)
  } catch (err) {
    return {
      ok: false,
      reason: `repo root not accessible: ${(err as Error).message}`,
    }
  }
  const absolute = resolvePath(resolvedRoot, filePath)
  // Lexical containment first — cheap, catches `..` traversal before
  // we touch the filesystem.
  const rel = pathRelative(resolvedRoot, absolute)
  if (rel === '..' || rel.startsWith('..' + pathSep) || rel.startsWith('../')) {
    return { ok: false, reason: `path '${filePath}' escapes repo root` }
  }
  // Now walk segments. For each ancestor that exists, `lstat` must
  // return a directory (not a symlink). For the leaf, `lstat` must
  // ENOENT (we're creating it). A pre-existing leaf symlink — even
  // dangling — is rejected.
  const segments = rel === '' ? [] : rel.split(pathSep)
  if (segments.length === 0) {
    return { ok: false, reason: 'path resolved to the repo root itself' }
  }
  let cursor = resolvedRoot
  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i])
    let info
    try {
      info = await lstat(cursor)
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno === 'ENOENT') {
        // This segment doesn't exist. All later segments are
        // therefore non-existent too — we'll create them. Done.
        return { ok: true, absolute }
      }
      return { ok: false, reason: `cannot inspect ancestor: ${(err as Error).message}` }
    }
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        reason: `path '${filePath}' traverses a symlink at '${pathRelative(resolvedRoot, cursor)}'`,
      }
    }
    if (i === segments.length - 1) {
      // Leaf exists and isn't a symlink — caller should refuse
      // creation through this helper (allowCreate is for NEW files).
      return {
        ok: false,
        reason: `path '${filePath}' already exists; not a new-file target`,
      }
    }
    if (!info.isDirectory()) {
      return {
        ok: false,
        reason: `ancestor '${pathRelative(resolvedRoot, cursor)}' is not a directory`,
      }
    }
  }
  // Should not reach: segments.length > 0 implies we either ENOENT'd
  // mid-walk or hit a leaf. Defensive return.
  return { ok: true, absolute }
}

/**
 * Convenience: returns the parent directory of an already-validated
 * safe-create path. Callers use this for `fs.mkdir(parent, recursive)`.
 */
export function safeCreateParent(absolute: string): string {
  return dirname(absolute)
}

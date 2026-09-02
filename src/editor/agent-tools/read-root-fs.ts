/**
 * Reading a file out of a reference directory that is not a git repository.
 *
 * `read_file_at_commit` was built on `git show <ref>:<path>`, so a plain folder
 * was declared, listed to the agent, and unreadable. This is the other half of
 * that pairing, for reads only.
 *
 * **Search is deliberately NOT here.** It looks like the natural sibling, and a
 * filesystem walk with a JS `RegExp` was the first implementation. It was
 * replaced by `git grep --no-index` (see `search_external_files` in
 * `git-tools.ts`): `RegExp.test` backtracks, so one pathological pattern
 * against one long line blocks the whole Editor process, and neither a
 * query-length cap nor an AbortSignal can interrupt a single synchronous
 * evaluation. `git` is already a hard dependency and gives a linear-time engine
 * in a killable subprocess. History (`list_commits`, `diff_file`) has no
 * filesystem meaning at all and refuses a plain root by name.
 *
 * The asymmetry to know about: a git root reads at a REF (HEAD by default), so
 * uncommitted work in that repo is invisible. A plain root reads LIVE from
 * disk. That is inherent, not a bug, and the tools report which happened.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/**
 * Resolve a repo-relative path inside `rootPath`, refusing anything that
 * escapes it.
 *
 * The git path never needed this: `git show HEAD:../../etc/passwd` is rejected
 * by git itself because the ref-path is resolved inside the repo's object
 * database, not the filesystem. Reading through `fs` removes that free
 * protection, so containment becomes this module's job. Symlinks are resolved
 * before the check, so a link inside the root pointing out of it is caught too.
 */
export async function resolveInsideRoot(
  rootPath: string,
  relPath: string,
): Promise<{ ok: true; absolute: string } | { ok: false; error: string }> {
  // `realpath`, not `resolve`. The candidate side below is canonicalized, so
  // canonicalizing only one side compares two different namespaces: given a
  // root reached through a symlink (`/tmp` is one on macOS), EVERY path inside
  // it resolves "outside" and every legitimate read is refused. Masked in the
  // product because `loadReadRoots` stores already-realpath'd paths, but these
  // functions are exported and a direct caller hits it immediately.
  const rootReal = await realpath(rootPath).catch(() => null)
  if (rootReal === null) {
    // No path in the message. These errors are serialized straight to the
    // model, and `list_read_roots` deliberately withholds filesystem paths, so
    // a root that was moved or unmounted after load must not become the one
    // place the layout leaks out.
    return { ok: false, error: 'this read root is no longer accessible' }
  }

  const candidate = resolve(rootReal, relPath)
  // Compare on a path-segment boundary. A plain `startsWith` would accept
  // `/repo-secrets` for a root of `/repo`.
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    return { ok: false, error: `path escapes the read root: ${relPath}` }
  }

  let realCandidate: string
  try {
    realCandidate = await realpath(candidate)
  } catch {
    // Does not exist yet — the caller's own read will produce the real error.
    return { ok: true, absolute: candidate }
  }
  if (realCandidate !== rootReal && !realCandidate.startsWith(rootReal + sep)) {
    return { ok: false, error: `path resolves outside the read root: ${relPath}` }
  }
  return { ok: true, absolute: realCandidate }
}

/**
 * Read one file from a plain reference directory. `maxBytes` is enforced from
 * the stat, before any content is buffered, so an oversized file costs a stat
 * rather than a read.
 */
export async function readFileFromRoot(
  rootPath: string,
  relPath: string,
  maxBytes: number,
): Promise<{ ok: true; content: string; bytes: number } | { ok: false; error: string }> {
  const resolved = await resolveInsideRoot(rootPath, relPath)
  if (!resolved.ok) return resolved

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved.absolute)
  } catch {
    return { ok: false, error: `no such file in this read root: ${relPath}` }
  }
  if (info.isDirectory()) {
    return { ok: false, error: `${relPath} is a directory, not a file` }
  }
  // Regular files only. A reference folder is arbitrary user-chosen material
  // and may contain a FIFO, socket or device node; `readFile` on a FIFO with
  // no writer blocks forever, and this path has no abort signal to cut it off.
  if (!info.isFile()) {
    return { ok: false, error: `${relPath} is not a regular file` }
  }
  if (info.size > maxBytes) {
    return {
      ok: false,
      error: `file is ${info.size} bytes; max is ${maxBytes}. Read a smaller file, or search for the part you need.`,
    }
  }

  try {
    const content = await readFile(resolved.absolute, 'utf8')
    return { ok: true, content, bytes: info.size }
  } catch {
    // The Node error carries the absolute path; only the repo-relative one is
    // safe to hand back. See the note on the root check above.
    return { ok: false, error: `could not read ${relPath}` }
  }
}

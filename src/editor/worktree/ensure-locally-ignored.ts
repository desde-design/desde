/**
 * Keeps Editor's `.desde/` scaffolding out of the user's `git
 * status` in the real checkout it edits in place (branch mode).
 *
 * Originally lived in `session-manager.ts` alongside the worktree-session
 * `SessionRecord` type and lifecycle functions (createSession,
 * discardSession, listSessions/listOrphans, mergeSquashIntoCanonical,
 * commitInCanonical, push/update-worktree/canonical-conflict helpers).
 * Worktree-session mode was removed (branch mode is the only edit
 * substrate now — see tasks/branches-vs-worktree.md and
 * tasks/worktree-mode-decommission.md), which made `SessionRecord` and
 * every other function in that file dead. This function is the sole
 * survivor — `editor-cli/src/core.ts`'s branch-mode boot path still
 * calls it — so it was relocated to its own honestly-named file rather
 * than kept in a file named after a concept that no longer exists.
 */

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Add `entry` to `<canonicalRoot>/.git/info/exclude` if it isn't already
 * present. This is a per-clone ignore — never committed, never visible
 * to other contributors — so it's safe to do unconditionally on session
 * start. Failures are swallowed: a wrong-permissions exclude file just
 * means the user sees `.desde/` show up in `git status`, which is
 * cosmetic.
 */
export async function ensureLocallyIgnored(canonicalRoot: string, entry: string): Promise<void> {
  let gitDir: string
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      canonicalRoot,
      'rev-parse',
      '--git-common-dir',
    ])
    gitDir = stdout.trim()
    if (!path.isAbsolute(gitDir)) gitDir = path.resolve(canonicalRoot, gitDir)
  } catch {
    return
  }
  const excludePath = path.join(gitDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = await fs.readFile(excludePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return
    // ENOENT — we'll create it below.
  }
  // Preserve whatever line ending the file already uses (Codex review
  // #11). If the user committed `.git/info/exclude` from a Windows
  // editor it's CRLF; appending an LF entry creates mixed endings,
  // which some tools warn about. New empty files get LF.
  const usesCrlf = existing.includes('\r\n')
  const eol = usesCrlf ? '\r\n' : '\n'
  const lines = existing.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(entry) || lines.includes(`/${entry}`)) return
  const sep = existing.length === 0 || existing.endsWith(eol) ? '' : eol
  const next = `${existing}${sep}${entry}${eol}`
  try {
    await fs.mkdir(path.dirname(excludePath), { recursive: true })
    await fs.writeFile(excludePath, next, 'utf8')
  } catch {
    // best-effort
  }
}

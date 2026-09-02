/**
 * 3-way merge primitive — Phase 4b of
 * tasks/editor-detached-sessions.md.
 *
 * Wraps `git merge-file --stdout` so the conflict-resolution path
 * can attempt to auto-combine a loser session's intended content
 * (`mine`) with the winning content on disk (`theirs`), against the
 * read-time base both sessions started from. Returns either a clean
 * merged string (when neither side touched the same lines) OR a
 * string containing standard `<<<<<<<` / `=======` / `>>>>>>>`
 * conflict markers (when the lines overlap), so the resolver pane
 * UI can render the conflicts for manual resolution.
 *
 * Why shell out to git: battle-tested algorithm, available on
 * every dev machine where Editor runs, output format is the
 * standard the user will see in any other merge tool. No JS
 * implementation to maintain.
 *
 * Inputs are passed as strings (read by the caller from
 * proposals/, bases/, and the working tree respectively). The
 * primitive writes them to tempfiles for `git merge-file` to
 * read, then deletes the tempfiles. No persistent state.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface MergeContentArgs {
  base: string
  mine: string
  theirs: string
  /** Override for testing: which git executable to invoke. Defaults to 'git'. */
  gitBin?: string
  /**
   * Conflict labels surfaced to the user inside `<<<<<<<` markers.
   * Defaults: 'mine' for the mine side, 'theirs' for theirs. Pass a
   * file label (e.g. `'src/Button.vue (session A)'`) for richer UX.
   */
  labels?: {
    mine?: string
    theirs?: string
    base?: string
  }
}

export type MergeContentResult =
  | { ok: true; clean: true; content: string }
  | { ok: true; clean: false; content: string }
  | { ok: false; reason: string }

/**
 * Run a 3-way merge. The caller decides what to do with the
 * conflicted output (write it with markers and surface a resolver
 * pane, OR discard it and force the user to pick Use mine / Use
 * theirs instead).
 *
 * git merge-file exit codes (from `git merge-file --help`):
 *   - 0: clean merge
 *   - > 0: number of conflicts — but capped at 127 (any value > 0
 *     in the conflicted range still means "had conflicts")
 *   - < 0 / very high: an actual error (binary file, missing arg)
 *
 * We treat any exit code in [1, 126] as "conflicted" and pass the
 * stdout through. Exit codes 127+ are surfaced as errors.
 */
export async function mergeContent(
  args: MergeContentArgs,
): Promise<MergeContentResult> {
  const { base, mine, theirs } = args
  const git = args.gitBin ?? 'git'
  const labels = {
    mine: args.labels?.mine ?? 'mine',
    theirs: args.labels?.theirs ?? 'theirs',
    base: args.labels?.base ?? 'base',
  }

  // git merge-file modifies its first arg in place + writes the
  // result to stdout when --stdout is set. We use --stdout to avoid
  // mutating any of our inputs. Tempfiles live in a per-call
  // tempdir so failed cleanups don't pile up under a shared root.
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'editor-merge-'))
    const minePath = join(dir, 'mine.txt')
    const basePath = join(dir, 'base.txt')
    const theirsPath = join(dir, 'theirs.txt')
    await Promise.all([
      writeFile(minePath, mine, 'utf8'),
      writeFile(basePath, base, 'utf8'),
      writeFile(theirsPath, theirs, 'utf8'),
    ])
    let stdout = ''
    let exitCode = 0
    try {
      const result = await execFileAsync(
        git,
        [
          'merge-file',
          '--stdout',
          `-L`,
          labels.mine,
          `-L`,
          labels.base,
          `-L`,
          labels.theirs,
          minePath,
          basePath,
          theirsPath,
        ],
        // git merge-file output can be large for big files; bump
        // the default 1 MB buffer to 16 MB so we don't truncate on
        // realistic SFCs.
        { maxBuffer: 16 * 1024 * 1024 },
      )
      stdout = result.stdout
      exitCode = 0
    } catch (err) {
      // execFile rejects on non-zero exit. Conflicted merges
      // (exit 1-126) are still SUCCESS for our purposes — we
      // need the stdout (which carries the conflict markers).
      // exit 127+ is a real error (binary file, missing args,
      // git not installed).
      const errObj = err as {
        code?: number
        stdout?: string
        stderr?: string
        message?: string
      }
      if (typeof errObj.code === 'number' && errObj.code >= 1 && errObj.code <= 126) {
        stdout = errObj.stdout ?? ''
        exitCode = errObj.code
      } else {
        const stderrSnippet =
          typeof errObj.stderr === 'string' && errObj.stderr.length > 0
            ? `: ${errObj.stderr.trim()}`
            : ''
        return {
          ok: false,
          reason: `git merge-file failed (exit ${errObj.code ?? '?'})${stderrSnippet}. ${
            errObj.message ?? ''
          }`.trim(),
        }
      }
    }
    return exitCode === 0
      ? { ok: true, clean: true, content: stdout }
      : { ok: true, clean: false, content: stdout }
  } catch (err) {
    return {
      ok: false,
      reason: `merge-content setup failed: ${(err as Error).message}`,
    }
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup. A leftover tempdir is harmless —
        // OS will sweep it eventually.
      }
    }
  }
}

/**
 * Convenience: detect conflict markers in arbitrary text. Used by
 * the resolver pane to validate the user's edited resolution
 * before writing it to disk — refuses an apply if the user
 * forgot to strip a `<<<<<<<` block.
 */
export function containsConflictMarkers(content: string): boolean {
  if (!content) return false
  // Match standard git-style markers at the start of a line. The
  // exact label after `<<<<<<<` can vary; we don't require it.
  return (
    /^<{7}( |$)/m.test(content) ||
    /^={7}$/m.test(content) ||
    /^>{7}( |$)/m.test(content)
  )
}

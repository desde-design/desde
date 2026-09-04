/**
 * Desde's own `Glob` and `Grep`.
 *
 * Glob is Node's `fs.promises.glob` (MEASURED: a function on Node 22.12+,
 * which `editor-cli`'s engines field already requires). Grep is the same walk
 * plus a RegExp scan with a hard result cap. Neither shells out, so neither
 * depends on `git` or `ripgrep` being installed.
 *
 * `node_modules`, `.git`, `dist` and `.desde` are excluded from BOTH. They are
 * never what the user means, and one of them is large enough to spend a whole
 * turn's context on a single call.
 */

import { readFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { sep as pathSep } from 'node:path'

import { z } from 'zod'

import { resolveRepoPath } from '../agent-tools/read-tools'

/**
 * `@types/node` is pinned to the ^20 line repo-wide, whose `fs/promises`
 * typings predate `glob` (added in Node 22). The runtime here is Node
 * 22.12+ (MEASURED: `editor-cli`'s own `engines` field already requires
 * it) and the function exists at runtime; this is a typings gap, not a
 * missing capability, so it is bridged with one narrow assertion instead
 * of widening every caller to `any`.
 */
const globFn = (
  fsPromises as unknown as {
    glob(pattern: string, opts: { cwd: string }): AsyncIterable<string>
  }
).glob

export const GLOB_MAX_RESULTS = 500
export const GREP_MAX_MATCHES = 200
/** Files above this are treated as binary or generated and skipped by Grep. */
const GREP_MAX_FILE_BYTES = 512 * 1024

const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.desde', '.next', 'coverage']

export interface BuiltinSearchOpts {
  worktreeRoot: string
}

function isExcluded(repoRel: string): boolean {
  const parts = repoRel.split('/')
  return parts.some((p) => EXCLUDED_DIRS.includes(p))
}

async function matchingPaths(
  worktreeRoot: string,
  pattern: string,
  cap: number,
): Promise<string[]> {
  const out: string[] = []
  for await (const entry of globFn(pattern, { cwd: worktreeRoot })) {
    const repoRel = String(entry).split(pathSep).join('/')
    if (isExcluded(repoRel)) continue
    out.push(repoRel)
    if (out.length >= cap) break
  }
  out.sort()
  return out
}

/**
 * Return type left inferred, same reasoning as `buildReadToolSpec`: this
 * tool only emits `text` content, and the test file that imports it directly
 * reads `.content[0].text` without narrowing.
 */
export function buildGlobToolSpec(opts: BuiltinSearchOpts) {
  return {
    name: 'Glob',
    description:
      'Find files in the prototype repository by path pattern, for example `src/**/*.vue` or ' +
      '`**/Button*`. Returns repository-relative paths, sorted, capped at ' +
      `${GLOB_MAX_RESULTS}. Use this when you know roughly where a file lives but not its exact ` +
      'path. Use Grep instead when you know what is INSIDE the file. Build output, dependencies ' +
      'and version-control internals are never returned.',
    kind: 'builtin' as const,
    inputShape: {
      pattern: z
        .string()
        .describe('Glob pattern, relative to the repository root. For example `src/**/*.vue`.'),
    },
    handler: async (input: Record<string, unknown>, _ctx?: unknown) => {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      if (pattern.length === 0) return err('Glob needs a non-empty pattern.')
      try {
        const found = await matchingPaths(opts.worktreeRoot, pattern, GLOB_MAX_RESULTS)
        if (found.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No files matched.' }], isError: undefined }
        }
        const notice =
          found.length >= GLOB_MAX_RESULTS
            ? `\n\n[stopped at ${GLOB_MAX_RESULTS} results; narrow the pattern]`
            : ''
        return { content: [{ type: 'text' as const, text: `${found.join('\n')}${notice}` }], isError: undefined }
      } catch (e) {
        return err(`Glob failed: ${(e as Error).message}`)
      }
    },
  }
}

/** Return type left inferred; see `buildGlobToolSpec`. */
export function buildGrepToolSpec(opts: BuiltinSearchOpts) {
  return {
    name: 'Grep',
    description:
      'Search the prototype repository for a regular expression and return each match as ' +
      '`path:line:text`. Use this to find where a component is used, where a string appears, or ' +
      'where a value is set. Scope it with `glob` when you already know which part of the tree ' +
      `to look in. Capped at ${GREP_MAX_MATCHES} matches; if you hit the cap, make the pattern ` +
      'more specific rather than reading everything. Build output, dependencies and ' +
      'version-control internals are never searched.',
    kind: 'builtin' as const,
    inputShape: {
      pattern: z.string().describe('JavaScript regular expression source, for example `KButton`.'),
      glob: z
        .string()
        .optional()
        .describe('Restrict the search to files matching this glob, for example `src/**/*.vue`.'),
      case_insensitive: z
        .boolean()
        .optional()
        .describe('Match without regard to case. Defaults to false.'),
    },
    handler: async (input: Record<string, unknown>, _ctx?: unknown) => {
      const source = typeof input.pattern === 'string' ? input.pattern : ''
      if (source.length === 0) return err('Grep needs a non-empty pattern.')
      let re: RegExp
      try {
        re = new RegExp(source, input.case_insensitive === true ? 'i' : '')
      } catch (e) {
        return err(`Grep: '${source}' is not a valid regular expression: ${(e as Error).message}`)
      }
      const pattern = typeof input.glob === 'string' && input.glob.length > 0 ? input.glob : '**/*'
      let paths: string[]
      try {
        paths = await matchingPaths(opts.worktreeRoot, pattern, GLOB_MAX_RESULTS)
      } catch (e) {
        return err(`Grep failed to enumerate files: ${(e as Error).message}`)
      }
      const hits: string[] = []
      let capped = false
      for (const repoRel of paths) {
        if (capped) break
        const safe = await resolveRepoPath(opts.worktreeRoot, repoRel)
        if (!safe.ok) continue
        let text: string
        try {
          const raw = await readFile(safe.absolute)
          if (raw.byteLength > GREP_MAX_FILE_BYTES) continue
          // A NUL byte in the first kilobyte is the cheap binary test. A false
          // negative costs one unreadable line of output, not correctness.
          if (raw.subarray(0, 1024).includes(0)) continue
          text = raw.toString('utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          hits.push(`${repoRel}:${i + 1}:${lines[i]}`)
          if (hits.length >= GREP_MAX_MATCHES) {
            capped = true
            break
          }
        }
      }
      if (hits.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matches.' }], isError: undefined }
      }
      const notice = capped
        ? `\n\n[stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or pass a glob]`
        : ''
      return { content: [{ type: 'text' as const, text: `${hits.join('\n')}${notice}` }], isError: undefined }
    },
  }
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

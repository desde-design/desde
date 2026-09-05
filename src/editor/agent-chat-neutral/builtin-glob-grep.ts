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

import {
  globPatternTargetsSecret,
  isSecretAgentPath,
  secretPathDenial,
  secretPathOmissionNote,
} from '../agent-chat-sdk/protected-paths'
import { resolveRepoPath } from '../agent-tools/read-tools'

import { createRegexLineScanner, GREP_DEADLINE_MS } from './regex-line-scanner'

/**
 * The context the runner threads into every tool handler. Both handlers here
 * used to take `_ctx?: unknown` and ignore it, which is how a search could
 * outlive a cancelled turn.
 */
interface SearchToolContext {
  signal?: AbortSignal
}

function signalOf(ctx: unknown): AbortSignal | undefined {
  const signal = (ctx as SearchToolContext | undefined)?.signal
  return signal instanceof AbortSignal ? signal : undefined
}

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

/**
 * Ceiling on ONE matching line.
 *
 * A match used to push its whole line, and a line's length is bounded only by
 * its file's size. One checked-in minified bundle is a single line, so a single
 * match could return half a megabyte — past any turn's context budget on its
 * own, and `context-budget.ts` only elides OLDER tool results, so the current
 * one lands whole.
 */
export const GREP_MAX_LINE_CHARS = 2000

/**
 * Ceiling on the WHOLE result.
 *
 * The three older caps (500 files, 200 matches, 512 KiB per file) bound the
 * output only in combination, and their product is about 105 MB. This is the
 * one that makes the bound useful rather than arithmetically true.
 */
export const GREP_MAX_TOTAL_BYTES = 64 * 1024

const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', '.desde', '.next', 'coverage']

export interface BuiltinSearchOpts {
  worktreeRoot: string
  /**
   * The per-project override that lets the agent read secret-bearing files.
   * Default OFF, on the same `=== true` discipline as every other opt-in gate.
   *
   * With it off, an enumeration that HAPPENS to reach `.env` drops it from the
   * results and says how many were dropped; a pattern that AIMS at one is
   * refused outright by the shared gate before the handler runs. The two
   * treatments are deliberately different — see `globPatternTargetsSecret`.
   */
  allowSecretReads?: boolean
}

/** What an enumeration returned, and what it withheld on the way. */
interface Enumeration {
  paths: string[]
  /**
   * How many in-scope files were dropped for holding credentials. Counted
   * rather than discarded, because a short result set with no explanation
   * reads to the model as "the repository does not contain that", which is
   * both false and the belief that makes it keep searching under other names.
   */
  omittedSecrets: number
}

function isExcluded(repoRel: string): boolean {
  const parts = repoRel.split('/')
  return parts.some((p) => EXCLUDED_DIRS.includes(p))
}

async function matchingPaths(
  worktreeRoot: string,
  pattern: string,
  cap: number,
  signal: AbortSignal | undefined,
  allowSecretReads: boolean,
): Promise<Enumeration> {
  const out: string[] = []
  let omittedSecrets = 0
  for await (const entry of globFn(pattern, { cwd: worktreeRoot })) {
    // Enumeration is an async loop, so unlike the scan below it genuinely
    // yields between entries and a plain check is enough. It matters: a
    // pattern the model can write (`../../**/*`) walks the real filesystem,
    // and MEASURED by the verifier at 793 ms for one level above the repo.
    if (signal?.aborted === true) break
    const repoRel = String(entry).split(pathSep).join('/')
    if (isExcluded(repoRel)) continue
    // The pattern is model input, and the model reads an untrusted repo
    // (2026-08-09 doctrine), so it can be `/etc/*`, `../../*`, or a path
    // through a symlink the repo itself planted. `fs.glob` honours all
    // three: `cwd` is a starting point, not a boundary. Re-checking every
    // enumerated path is what makes the tool description ("only sees files
    // inside the repository") true, and it is the same check Grep already
    // runs before reading a file — the difference being that an unchecked
    // Glob leaks path NAMES, which is a directory listing of the user's
    // machine handed to the provider.
    const safe = await resolveRepoPath(worktreeRoot, repoRel)
    if (!safe.ok) continue
    // Both spellings, for the same reason Read checks both: an in-repo
    // symlink pointing at `.env` passes containment because the link and its
    // target are both inside the repository.
    if (
      !allowSecretReads &&
      (isSecretAgentPath(repoRel) || isSecretAgentPath(safe.absolute))
    ) {
      omittedSecrets++
      continue
    }
    out.push(repoRel)
    if (out.length >= cap) break
  }
  out.sort()
  return { paths: out, omittedSecrets }
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
    handler: async (input: Record<string, unknown>, ctx?: unknown) => {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      if (pattern.length === 0) return err('Glob needs a non-empty pattern.')
      const allowSecretReads = opts.allowSecretReads === true
      // The shared gate refuses this before the handler runs. Repeating it
      // here is the second of the two ends CLAUDE.md asks for: a caller that
      // assembles the catalog without the gate would otherwise get a Glob with
      // no policy on it at all. The LIST is not duplicated, only the call.
      if (!allowSecretReads && globPatternTargetsSecret(pattern)) {
        return err(secretPathDenial(pattern, 'search'))
      }
      const signal = signalOf(ctx)
      try {
        const found = await matchingPaths(
          opts.worktreeRoot,
          pattern,
          GLOB_MAX_RESULTS,
          signal,
          allowSecretReads,
        )
        if (signal?.aborted === true) {
          return { content: [{ type: 'text' as const, text: 'Search cancelled.' }], isError: undefined }
        }
        const omissionNotice = secretPathOmissionNote(found.omittedSecrets)
        if (found.paths.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No files matched.${omissionNotice}` }],
            isError: undefined,
          }
        }
        const notice =
          found.paths.length >= GLOB_MAX_RESULTS
            ? `\n\n[stopped at ${GLOB_MAX_RESULTS} results; narrow the pattern]`
            : ''
        return {
          content: [
            { type: 'text' as const, text: `${found.paths.join('\n')}${notice}${omissionNotice}` },
          ],
          isError: undefined,
        }
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
      `to look in. Capped at ${GREP_MAX_MATCHES} matches, ${GREP_MAX_LINE_CHARS} characters per ` +
      `line, ${GREP_MAX_TOTAL_BYTES} bytes of output in total and ${GREP_DEADLINE_MS}ms of ` +
      'searching; if you hit a cap, make the pattern more specific rather than reading ' +
      'everything. Avoid nested quantifiers such as `(a+)+` or `( +)+`: they backtrack ' +
      'exponentially and will hit the time limit without finding anything. Build output, ' +
      'dependencies and version-control internals are never searched.',
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
    handler: async (input: Record<string, unknown>, ctx?: unknown) => {
      const source = typeof input.pattern === 'string' ? input.pattern : ''
      if (source.length === 0) return err('Grep needs a non-empty pattern.')
      const flags = input.case_insensitive === true ? 'i' : ''
      // Compiled here only to reject a malformed pattern with a message the
      // model can act on. Compilation is linear; it is EXECUTION that can
      // backtrack forever, and that happens on another thread (see
      // `regex-line-scanner.ts`).
      try {
        new RegExp(source, flags)
      } catch (e) {
        return err(`Grep: '${source}' is not a valid regular expression: ${(e as Error).message}`)
      }
      const signal = signalOf(ctx)
      const deadlineAt = Date.now() + GREP_DEADLINE_MS
      const pattern = typeof input.glob === 'string' && input.glob.length > 0 ? input.glob : '**/*'
      const allowSecretReads = opts.allowSecretReads === true
      // The SCOPE is what can name a secret file. `input.pattern` is a regular
      // expression, not a path, so it is deliberately not tested against a
      // path policy. The verifier's own repro was `glob: '.env*'`, which is
      // this branch.
      if (!allowSecretReads && globPatternTargetsSecret(pattern)) {
        return err(secretPathDenial(pattern, 'search'))
      }
      let enumeration: Enumeration
      try {
        enumeration = await matchingPaths(
          opts.worktreeRoot,
          pattern,
          GLOB_MAX_RESULTS,
          signal,
          allowSecretReads,
        )
      } catch (e) {
        return err(`Grep failed to enumerate files: ${(e as Error).message}`)
      }
      const paths = enumeration.paths
      const secretOmissionNotice = secretPathOmissionNote(enumeration.omittedSecrets)
      // Enumeration itself is capped at GLOB_MAX_RESULTS files, independent of
      // the match cap below. Without this notice a repo with more candidate
      // files than the cap gets silently under-searched: "No matches." reads
      // as "nothing in the repo", when it can mean "nothing in the first 500
      // files scanned".
      const enumerationTruncated = paths.length >= GLOB_MAX_RESULTS
      const enumerationNotice = enumerationTruncated
        ? `\n\n[searched only the first ${GLOB_MAX_RESULTS} files matching this scope; narrow with \`glob\`]`
        : ''
      const hits: string[] = []
      let capped = false
      let byteCapped = false
      let clampedAny = false
      let totalBytes = 0
      /** Set when the search was cut short rather than finished. */
      let cutShort: 'deadline' | 'aborted' | null = null
      let scanFailed: string | null = null
      // The regex runs on another thread and the deadline is enforced by
      // terminating it, because the whole cost of a backtracking pattern lands
      // inside ONE `re.test` on ONE line: a check between lines is never
      // reached. See the header of `regex-line-scanner.ts` for the
      // measurements behind that.
      const scanner = createRegexLineScanner({ source, flags, deadlineAt, signal })
      try {
        for (const repoRel of paths) {
          if (capped || byteCapped) break
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
          const outcome = await scanner.scan(lines, GREP_MAX_MATCHES)
          if (outcome.status === 'failed') {
            scanFailed = outcome.message
            break
          }
          if (outcome.status !== 'ok') {
            cutShort = outcome.status
            break
          }
          for (const i of outcome.lineIndexes) {
            const raw = lines[i]
            const clamped = raw.length > GREP_MAX_LINE_CHARS
            if (clamped) clampedAny = true
            const shown = clamped
              ? `${raw.slice(0, GREP_MAX_LINE_CHARS)} …[line truncated at ${GREP_MAX_LINE_CHARS} characters]`
              : raw
            const hit = `${repoRel}:${i + 1}:${shown}`
            const size = Buffer.byteLength(hit, 'utf8') + 1
            // Checked BEFORE the push, and the first hit is always kept: a cap
            // that could return zero matches for a pattern that matched would
            // read to the model as "not in the repo".
            if (hits.length > 0 && totalBytes + size > GREP_MAX_TOTAL_BYTES) {
              byteCapped = true
              break
            }
            hits.push(hit)
            totalBytes += size
            if (hits.length >= GREP_MAX_MATCHES) {
              capped = true
              break
            }
          }
        }
      } finally {
        scanner.dispose()
      }
      if (scanFailed !== null && hits.length === 0) {
        return err(`Grep could not run the search: ${scanFailed}`)
      }
      // Attributed to the pattern rather than to the repository, because a
      // pattern is the only thing that reaches this limit in practice and it
      // is the only thing the model can change.
      const cutShortNotice =
        cutShort === 'deadline'
          ? `\n\n[stopped after ${GREP_DEADLINE_MS}ms; the search was cut short before every file ` +
            'was checked. A pattern with nested quantifiers such as `(a+)+` or `( +)+` backtracks ' +
            'exponentially and will never finish: rewrite it. Otherwise narrow the scope with ' +
            '`glob`.]'
          : cutShort === 'aborted'
            ? '\n\n[search cancelled.]'
            : ''
      if (hits.length === 0) {
        const head = cutShort === null ? 'No matches.' : 'No matches found before the search was cut short.'
        return {
          content: [
            {
              type: 'text' as const,
              text: `${head}${cutShortNotice}${enumerationNotice}${secretOmissionNotice}`,
            },
          ],
          // A deadline means the question was not answered, and "no matches"
          // would read to the model as "not in the repository". An abort is
          // not a failure: the user asked for it.
          isError: cutShort === 'deadline' ? (true as const) : undefined,
        }
      }
      // The match cap and the enumeration cap are independent: a search can
      // hit either, both, or neither, so both notices can appear together.
      const notice =
        cutShortNotice +
        (capped ? `\n\n[stopped at ${GREP_MAX_MATCHES} matches; narrow the pattern or pass a glob]` : '') +
        (byteCapped
          ? `\n\n[stopped at the ${GREP_MAX_TOTAL_BYTES}-byte output limit; narrow the pattern or pass a glob]`
          : '') +
        (clampedAny
          ? `\n\n[at least one match sat on a line longer than ${GREP_MAX_LINE_CHARS} characters and was cut short; open that file with Read to see the whole line]`
          : '') +
        enumerationNotice +
        secretOmissionNotice
      return {
        content: [{ type: 'text' as const, text: `${hits.join('\n')}${notice}` }],
        isError: cutShort === 'deadline' ? (true as const) : undefined,
      }
    },
  }
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

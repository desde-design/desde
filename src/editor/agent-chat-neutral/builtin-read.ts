/**
 * Desde's own `Read`.
 *
 * The Claude Agent SDK supplies a Read that executes inside its runtime, so
 * the SDK lane has to observe reads with a PreToolUse hook it documents as
 * existing only because `canUseTool` never fires for Read
 * (`file-read-snapshot.ts`). Owning the tool removes the hook: recording
 * `hashAtRead` is two lines here, in the code that did the reading.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import { READ_FILE_MAX_BYTES, resolveRepoPath } from '../agent-tools/read-tools'

/**
 * Byte cap on one Read. Imported rather than redeclared: `read-tools.ts` has
 * held this number since the legacy tool, both tools cap for the identical
 * reason (a large file spends the whole turn's context on one call), and two
 * spellings of one budget is how they drift apart without anything noticing.
 * Re-exported so the tool's own description can interpolate it.
 */
export { READ_FILE_MAX_BYTES } from '../agent-tools/read-tools'

/** What the runtime is told about a file the model just read. */
export interface FileReadObservation {
  absolutePath: string
  repoRel: string
  /** sha256 of the bytes on disk at read time. */
  hashAtRead: string
  readAt: string
}

export interface BuiltinReadOpts {
  worktreeRoot: string
  /**
   * Called for every SUCCESSFUL read. The loop writes the record into the
   * turn's `fileReads` map, which `edit-ack.ts`'s conflict detection reads to
   * decide whether a later write is overwriting someone else's change.
   */
  onFileRead?: (observation: FileReadObservation) => void
}

const DESCRIPTION =
  'Read a file from the prototype repository. Pass a repository-relative path such as ' +
  '`src/views/Home.vue`. Output is the file with line numbers, in the same form as `cat -n`, ' +
  'so you can quote a line number back to the user or aim an Edit at it. Reads are capped at ' +
  `${READ_FILE_MAX_BYTES} bytes; use offset and limit to page through a long file. This tool ` +
  'only sees files inside the repository. For a declared reference folder use ' +
  'mcp__editor__read_file_at_commit instead.'

/**
 * Return type intentionally not pinned to `ToolSpec`: this tool only ever
 * emits `text` content, and leaving the return type inferred lets a caller
 * that imports `buildReadToolSpec` directly (the test file does) read
 * `.content[0].text` without narrowing away the `image` branch that
 * `ToolHandlerResult` allows in general but this tool never produces. The
 * inferred shape is still structurally a `ToolSpec`, which is what matters
 * everywhere this is assembled into a `ToolSpec[]`.
 */
export function buildReadToolSpec(opts: BuiltinReadOpts) {
  return {
    name: 'Read',
    description: DESCRIPTION,
    kind: 'builtin' as const,
    inputShape: {
      file_path: z
        .string()
        .describe('Repository-relative path, for example `src/views/Home.vue`.'),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('First line to return, 1-based. Defaults to the start of the file.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How many lines to return. Defaults to the rest of the file.'),
    },
    handler: async (input: Record<string, unknown>, _ctx?: unknown) => {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath.length === 0) return err('Read needs a non-empty file_path.')
      const safe = await resolveRepoPath(opts.worktreeRoot, filePath)
      if (!safe.ok) return err(`Read denied: ${safe.reason}`)
      let raw: Buffer
      try {
        raw = await readFile(safe.absolute)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return err(
            `Read: file not found '${filePath}'. Use Glob or Grep to locate it, or ask the user for the right path.`,
          )
        }
        if (code === 'EISDIR') {
          return err(`Read: '${filePath}' is a directory. Use Glob to list what is inside it.`)
        }
        return err(`Read failed for '${filePath}': ${(e as Error).message}`)
      }
      const truncated = raw.byteLength > READ_FILE_MAX_BYTES
      const text = raw.subarray(0, READ_FILE_MAX_BYTES).toString('utf8')
      opts.onFileRead?.({
        absolutePath: safe.absolute,
        repoRel: filePath,
        // The hash covers the WHOLE file, not the truncated slice. It is a
        // stale-base check, and a partial hash would report every long file as
        // changed the moment anything wrote it.
        hashAtRead: createHash('sha256').update(raw).digest('hex'),
        readAt: new Date().toISOString(),
      })
      const lines = text.split('\n')
      // A trailing newline yields a final empty element that is not a line.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const start = typeof input.offset === 'number' ? Math.max(1, input.offset) : 1
      const count = typeof input.limit === 'number' ? Math.max(1, input.limit) : lines.length
      const slice = lines.slice(start - 1, start - 1 + count)
      const numbered = slice
        .map((line, i) => `${String(start + i).padStart(6, ' ')}\t${line}`)
        .join('\n')
      const notice = truncated
        ? `\n\n[truncated at ${READ_FILE_MAX_BYTES} bytes; use offset and limit to read the rest]`
        : ''
      return { content: [{ type: 'text' as const, text: `${numbered}${notice}` }], isError: undefined }
    },
  }
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

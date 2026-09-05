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
import { readFile, stat } from 'node:fs/promises'

import { z } from 'zod'

import { isSecretAgentPath, secretPathDenial } from '../agent-chat-sdk/protected-paths'
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
   *
   * Awaited when it returns a promise: the loop's observer also writes the
   * read-time base snapshot that "Merge" recovers from, and that snapshot has
   * to be on disk before the next write can conflict against it. The SDK
   * lane's equivalent hook awaits for the same reason.
   */
  onFileRead?: (observation: FileReadObservation) => void | Promise<void>
  /**
   * The per-project setting that stops the agent reading secret-bearing
   * files. Default OFF, on the same `=== true` discipline as every other
   * opt-in gate, so absent means this Read behaves as it did before the
   * policy existed.
   *
   * The shared gate (`buildToolPermissionGate`) refuses these before the
   * handler runs, so this is the SECOND of the two ends CLAUDE.md asks for
   * rather than the only one. It is here because this is the code that opens
   * the file: a caller that assembles the tool catalog without the gate — the
   * edit-fix mini turn, a future runtime, a test — would otherwise get a Read
   * with no policy at all, which is exactly the "UI-only gating leaves the API
   * open" shape the rule exists to prevent. The LIST is not duplicated; only
   * the call is.
   */
  blockSecretReads?: boolean
}

const DESCRIPTION =
  'Read a file from the prototype repository. Pass a repository-relative path such as ' +
  '`src/views/Home.vue`. Output is the file with line numbers, in the same form as `cat -n`, ' +
  'so you can quote a line number back to the user or aim an Edit at it. One call returns at ' +
  `most ${READ_FILE_MAX_BYTES} bytes; when it stops early it names the line to continue from, ` +
  'so offset and limit page through a file of any size. This tool ' +
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
      // BOTH spellings: the one the model asked for, and the realpath'd
      // target. The pair is what closes an in-repo symlink — `docs/notes.md`
      // pointing at `.env` passes containment, because the link and its
      // target are both inside the repository.
      if (
        opts.blockSecretReads === true &&
        (isSecretAgentPath(filePath) || isSecretAgentPath(safe.absolute))
      ) {
        return err(secretPathDenial(filePath))
      }
      // The SHAPE of the path is decided before it is opened.
      //
      // FX16 item 2 (2026-09-05). `readFile` blocks in `open(2)` on a FIFO
      // with no writer, and nothing above it can interrupt that: the turn's
      // signal aborts `fs.promises` between chunks, never during the open. The
      // handler then never returns, so the turn's `await runOneTool(...)` never
      // returns, so Stop cannot end the turn and the user restarts the CLI.
      // The verifier measured the same block on Grep at past 12 seconds with
      // both its deadline and its abort ignored.
      //
      // `stat` does not block on a FIFO; only `open` does. It follows
      // symlinks, so a link to a regular file still reads.
      try {
        const info = await stat(safe.absolute)
        if (info.isDirectory()) {
          return err(`Read: '${filePath}' is a directory. Use Glob to list what is inside it.`)
        }
        if (!info.isFile()) {
          return err(
            `Read: '${filePath}' is not a regular file, so it cannot be read. Reading a pipe, socket or device would block until something wrote to it.`,
          )
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return err(
            `Read: file not found '${filePath}'. Use Glob or Grep to locate it, or ask the user for the right path.`,
          )
        }
        return err(`Read failed for '${filePath}': ${(e as Error).message}`)
      }
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
      await opts.onFileRead?.({
        absolutePath: safe.absolute,
        repoRel: filePath,
        // The hash covers the WHOLE file. It is a stale-base check, and a
        // partial hash would report every long file as changed the moment
        // anything wrote it.
        hashAtRead: createHash('sha256').update(raw).digest('hex'),
        readAt: new Date().toISOString(),
      })
      // The WHOLE file is split into lines BEFORE offset and limit are
      // applied, and only the resulting SLICE is capped.
      //
      // It used to be the other way round: the buffer was cut to
      // READ_FILE_MAX_BYTES first, so on a 1 MB file every line past the first
      // 200 KB was unreachable by ANY offset (MEASURED: lines 2544-13000 of a
      // 13000-line file, 80% of it). Meanwhile the description and the
      // truncation notice both told the model to page with offset, so the
      // model followed an instruction that could not work and got back an
      // empty body it could not tell from the end of the file.
      const lines = raw.toString('utf8').split('\n')
      // A trailing newline yields a final empty element that is not a line.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `[${filePath} is empty]` }],
          isError: undefined,
        }
      }
      const start = typeof input.offset === 'number' ? Math.max(1, input.offset) : 1
      if (start > lines.length) {
        // Named, not empty. "Empty" and "past the end" look identical to the
        // model otherwise, and it has no other way to learn how long the file
        // is.
        return {
          content: [
            {
              type: 'text' as const,
              text: `[offset ${start} is past the end of '${filePath}'; it has ${lines.length} lines]`,
            },
          ],
          isError: undefined,
        }
      }
      const count = typeof input.limit === 'number' ? Math.max(1, input.limit) : lines.length
      const slice = lines.slice(start - 1, start - 1 + count)

      const kept: string[] = []
      let bytes = 0
      let byteCapped = false
      let lastLine = start - 1
      for (let i = 0; i < slice.length; i++) {
        const numbered = `${String(start + i).padStart(6, ' ')}\t${slice[i]}`
        // +1 for the newline this line will be joined with.
        const size = Buffer.byteLength(numbered, 'utf8') + (kept.length > 0 ? 1 : 0)
        if (kept.length === 0 && size > READ_FILE_MAX_BYTES) {
          // One line longer than the whole budget — a minified bundle, say.
          // Hand back the head of it rather than nothing at all.
          kept.push(Buffer.from(numbered, 'utf8').subarray(0, READ_FILE_MAX_BYTES).toString('utf8'))
          lastLine = start + i
          byteCapped = true
          break
        }
        if (bytes + size > READ_FILE_MAX_BYTES) {
          byteCapped = true
          break
        }
        kept.push(numbered)
        bytes += size
        lastLine = start + i
      }

      const notice = byteCapped
        ? `\n\n[truncated at ${READ_FILE_MAX_BYTES} bytes, after line ${lastLine} of ${lines.length}; continue with offset=${lastLine + 1}]`
        : lastLine < lines.length
          ? `\n\n[showed lines ${start} to ${lastLine} of ${lines.length}; continue with offset=${lastLine + 1}]`
          : ''
      return {
        content: [{ type: 'text' as const, text: `${kept.join('\n')}${notice}` }],
        isError: undefined,
      }
    },
  }
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

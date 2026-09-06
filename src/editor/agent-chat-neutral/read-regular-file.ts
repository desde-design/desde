/**
 * Open a model-supplied path ONCE, decide its shape from the handle, and
 * read the bytes through that same handle.
 *
 * ## Why this exists
 *
 * FX16 item 2 made `Read` and `Grep` decide the shape of a path before
 * opening it, because `readFile` blocks in `open(2)` on a FIFO with no
 * writer and nothing above can interrupt that: `fs.promises` honours an
 * abort signal between chunks, never during the open. The handler then
 * never returns, the turn's `await runOneTool(...)` never returns, Stop
 * cannot end the turn, and the user restarts the CLI.
 *
 * FX19 item 5 (2026-09-05). That fix inspected the path with `stat` and
 * then opened it a SECOND time with `readFile` — two independent path
 * lookups with nothing carrying identity between them. The prototype
 * repository is untrusted, and `rename(2)` is atomic and needs no
 * privilege, so an ordinary process in it can put a FIFO at the path
 * between the two. The adversarial verifier won that race with a plain
 * rename loop: 12,273 attempts in 15 seconds, ending in a process that had
 * to be SIGKILLed. The guard made the hang harder to reach, not
 * unreachable.
 *
 * ## What this does instead
 *
 * One `open` with `O_RDONLY | O_NONBLOCK`, then `handle.stat()` — an
 * `fstat` on the open file description, so it describes the object we are
 * actually holding rather than whatever the name means now — then reject
 * anything that is not a regular file, then read through the handle.
 * There is no second lookup for a swap to land in.
 *
 * `O_NONBLOCK` is what makes the open itself safe. Opening a FIFO for
 * reading blocks until a writer arrives; with `O_NONBLOCK` it returns
 * immediately, so even a rename that beats every check cannot hang the
 * turn. It has no effect on reads from a regular file.
 *
 * The open FOLLOWS symlinks, deliberately and exactly as the `stat` it
 * replaces did: a symlink to a regular file inside the repository is
 * readable, and containment has already been proven by the caller
 * (`resolveRepoPath`). A symlink to a FIFO is rejected on the `fstat`,
 * because the handle describes the target.
 */

import { open } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'

/**
 * Why a read did not happen. Callers phrase their own message from this —
 * the reasons exist because the two callers say different things about the
 * same fact, not because the text belongs here.
 */
export type ReadRegularFileFailure =
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'directory' }
  | { ok: false; reason: 'not-regular' }
  | { ok: false; reason: 'failed'; message: string }

export type ReadRegularFileResult = { ok: true; bytes: Buffer } | ReadRegularFileFailure

export async function readRegularFile(absPath: string): Promise<ReadRegularFileResult> {
  let handle
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // A dangling symlink surfaces as ENOENT, and a symlink loop as ELOOP;
    // both mean "there is nothing readable at this name", which is what
    // the caller's not-found wording says.
    if (code === 'ENOENT' || code === 'ELOOP') return { ok: false, reason: 'not-found' }
    // Linux refuses `O_RDONLY` on a directory at the open; macOS allows it
    // and the `fstat` below is what catches it. Both are reported the same
    // way, so the caller's message does not depend on the platform.
    if (code === 'EISDIR') return { ok: false, reason: 'directory' }
    return { ok: false, reason: 'failed', message: (e as Error).message }
  }
  try {
    const info = await handle.stat()
    if (info.isDirectory()) return { ok: false, reason: 'directory' }
    if (!info.isFile()) return { ok: false, reason: 'not-regular' }
    return { ok: true, bytes: await handle.readFile() }
  } catch (e) {
    return { ok: false, reason: 'failed', message: (e as Error).message }
  } finally {
    await handle.close().catch(() => {})
  }
}

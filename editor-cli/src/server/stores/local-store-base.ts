/**
 * Shared file-IO helpers for the local artifact stores.
 *
 * Atomic JSON reads/writes under `.desde/` inside the user's
 * repo root. Atomic write = write to temp + rename, so a crash mid-
 * write can't corrupt the canonical file.
 *
 * Concurrency: serialize writes to the same file with a per-path
 * lock. Reads are lock-free (atomic rename + read returns either old
 * or new content, never a half-written file). For v1, in-process
 * locking is enough — the CLI is a single Node process. Multi-process
 * coordination is out of scope here.
 */

import { mkdir, readFile, rename, writeFile, unlink, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import { desdePath, desdeRemovalPath } from "../../../../src/editor/worktree/desde-dir.js"

/** Default subdirectory under the user's repo root. */
export const DESDE_DIR = ".desde"

/**
 * Resolve a path inside `<repoRoot>/.desde/`.
 *
 * Every local artifact store (notes, comments, canvases, page statuses,
 * screenshot plans, smoke runs) builds its file paths here, and `writeJsonFile`
 * below `mkdir`s and writes them. `mkdir(..., { recursive: true })` on an
 * existing symlink-to-a-directory is a no-op and the write then follows the
 * link, so a prototype that ships `.desde` as a symlink would have every one of
 * those files land outside the working tree. `desdePath` is the one guard
 * against that, and it checks every segment below `.desde` as well as
 * `.desde` itself; see `src/editor/worktree/desde-dir.ts`. It throws
 * `DesdeDirSymlinkError`, which surfaces as a failed store call rather than a
 * silent write to someone else's directory.
 */
export function resolveStorePath(repoRoot: string, ...segments: string[]): string {
  return desdePath(repoRoot, ...segments)
}

/**
 * Resolve a path inside `<repoRoot>/.desde/` that the caller is about to
 * `rm(..., { recursive: true })`. Use this instead of {@link resolveStorePath}
 * for a RECURSIVE delete — `desdeRemovalPath` re-resolves the target with
 * `realpath` immediately before the caller's `rm`, closing the window where
 * `.desde` (or a directory beneath it) was swapped for a symlink between the
 * segment-walk check and the write. See `src/editor/worktree/desde-dir.ts`.
 */
export function resolveStoreRemovalPath(repoRoot: string, ...segments: string[]): string {
  return desdeRemovalPath(repoRoot, ...segments)
}

/**
 * Read a JSON file, returning `fallback` if the file doesn't exist.
 * Throws if the file exists but isn't valid JSON.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8")
    if (raw.trim().length === 0) return fallback
    return JSON.parse(raw) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return fallback
    throw err
  }
}

/**
 * Atomically write JSON to `filePath`. Creates parent directories if
 * needed. Writes to a sibling temp file first, then renames over the
 * target — a crash mid-write leaves the target intact.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const json = JSON.stringify(data, null, 2)
  try {
    await writeFile(tmp, json, "utf8")
    await rename(tmp, filePath)
  } catch (err) {
    // Best-effort cleanup. Swallow errors from cleanup — surfacing
    // them would mask the original write failure.
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * Per-path serial mutex. The lock guarantees that two concurrent
 * `mutate(path, fn)` calls on the same `path` run sequentially even
 * if `fn` is async. Different paths run in parallel.
 *
 * Use `mutate` when you need to read → modify → write a JSON file
 * without a concurrent writer racing in the middle.
 */
const locks = new Map<string, Promise<unknown>>()

export async function mutate<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // Store a non-rejecting tail so a failure in one op doesn't poison
  // the queue. Keep a stable reference (not a fresh `.catch(...)`
  // allocation each time we want to inspect it) so the cleanup
  // identity check below actually works — see codex round-1 review.
  const tail = next.catch(() => {})
  locks.set(filePath, tail)
  try {
    return await next
  } finally {
    if (locks.get(filePath) === tail) {
      locks.delete(filePath)
    }
  }
}

/**
 * In-process change emitter, keyed by store file path.
 *
 * All writes for a given `.desde/*.json` collection go through
 * the one CLI Node process, so a store can notify its own subscribers
 * after each successful write without watching the filesystem. This
 * backs the local-file `CommentStore.subscribe` (and, later, other
 * artifact stores) — the browser can't receive these directly (it
 * polls over HTTP), but the CLI-side store and any in-process
 * consumer get synchronous change signals.
 *
 * Listeners must not throw; a throwing listener is swallowed so it
 * can't break sibling listeners or the write path that triggered it.
 */
type FileChangeListener = () => void
const fileChangeListeners = new Map<string, Set<FileChangeListener>>()

/** Register `listener` for changes to `filePath`. Returns an unsubscribe fn. */
export function onFileChange(filePath: string, listener: FileChangeListener): () => void {
  let set = fileChangeListeners.get(filePath)
  if (!set) {
    set = new Set()
    fileChangeListeners.set(filePath, set)
  }
  set.add(listener)
  return () => {
    const current = fileChangeListeners.get(filePath)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) fileChangeListeners.delete(filePath)
  }
}

/** Notify all listeners registered for `filePath`. Call after a write. */
export function notifyFileChange(filePath: string): void {
  const set = fileChangeListeners.get(filePath)
  if (!set) return
  // Snapshot to an array so a listener that unsubscribes (or subscribes)
  // during iteration can't mutate the set we're walking.
  for (const listener of [...set]) {
    try {
      listener()
    } catch {
      // Swallow — a broken subscriber must not break the writer or peers.
    }
  }
}

/** Generate a stable, sortable artifact id. */
export function newId(): string {
  return randomUUID()
}

/** ISO-8601 timestamp for `createdAt` / `updatedAt`. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Sequential numbering for artifacts that surface a human-readable
 * counter (Comments / Notes — "Comment #4"). Given a list of items
 * each carrying a `number`, returns the next value.
 */
export function nextNumber(items: ReadonlyArray<{ number: number }>): number {
  let max = 0
  for (const item of items) {
    if (item.number > max) max = item.number
  }
  return max + 1
}

/**
 * List files in a directory, returning [] if the directory doesn't
 * exist. Useful for enumerating per-canvas subdirectories.
 */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

/** Check whether a path exists and is a directory. */
export async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

export { join }

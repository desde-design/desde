/**
 * One running editor per repository.
 *
 * The launcher used to spawn a fresh editor child on EVERY open, with no memory
 * of the ones already running. Going Home and clicking the same project again
 * therefore booted a second dev server in the same directory. On a Vite host
 * that only wasted a process; on Next it is a refusal, because Next 16 holds a
 * per-project lock (`.next/dev/lock`) and exits a second `next dev` for the
 * same directory whatever port it asked for. The error the user saw named the
 * launcher's OWN first child as the "already running" server.
 *
 * So the launcher remembers. `withRunningEditorReuse` wraps a spawn with a map
 * keyed on the canonical repo path:
 *
 *  - an open for a repo whose editor is alive answers with that editor's URL;
 *  - two opens racing (a double click, React's dev double-effect) share ONE
 *    spawn, because the map holds the in-flight promise, not just the result;
 *  - a spawn that rejects is forgotten, so the next open retries rather than
 *    replaying the failure;
 *  - a child that exits is forgotten, through the `exited` promise the spawn
 *    hands back — the only liveness signal used. Nothing here polls.
 *
 * Canonical means `realpath` where the directory exists: `/a/b/../b`, a
 * symlinked `Documents`, and the plain path must all land on the same entry,
 * or the lock collision comes back through a different spelling of the same
 * folder.
 */

import { realpath } from "node:fs/promises"
import { resolve } from "node:path"

export interface SpawnedEditor {
  url: string
  /**
   * Settles when the editor process is gone. Optional because an injected
   * spawn (tests) has no process behind it; an entry without it is kept until
   * the launcher itself exits.
   */
  exited?: Promise<void>
}

export type SpawnEditor = (repoPath: string) => Promise<SpawnedEditor>

export interface RunningEditorReuseOptions {
  /** Override the path canonicalisation (tests). Default: realpath, else resolve. */
  canonicalize?: (repoPath: string) => Promise<string>
  /**
   * Editors already running when the launcher starts — the ONE case being the
   * editor that started this launcher lazily from its own Home breadcrumb
   * (`desde <repo>` with no launcher above it). Without this, Home → reopen
   * the same repo is a cache miss and a second editor boots in the same
   * directory, which on Next is the lock refusal all over again. No `exited`:
   * that editor is this process's parent surface and outlives the launcher.
   */
  seed?: readonly SpawnedEditorSeed[]
}

export interface SpawnedEditorSeed {
  repoPath: string
  url: string
}

async function defaultCanonicalize(repoPath: string): Promise<string> {
  const absolute = resolve(repoPath)
  try {
    return await realpath(absolute)
  } catch {
    return absolute
  }
}

export function withRunningEditorReuse(
  spawn: SpawnEditor,
  opts: RunningEditorReuseOptions = {},
): SpawnEditor {
  const canonicalize = opts.canonicalize ?? defaultCanonicalize
  const running = new Map<string, Promise<SpawnedEditor>>()
  // Seeds are keyed lazily, on the first open, because canonicalisation is
  // async and this factory is not. ONE shared promise, so two opens racing on
  // the first call both wait for the seeds to be in the map — a second caller
  // that skipped ahead would miss the entry and spawn the duplicate this
  // whole file exists to prevent.
  let seeded: Promise<void> | null = null
  const ensureSeeded = (): Promise<void> => {
    if (seeded === null) {
      seeded = (async () => {
        for (const seed of opts.seed ?? []) {
          running.set(await canonicalize(seed.repoPath), Promise.resolve({ url: seed.url }))
        }
      })()
    }
    return seeded
  }

  return async (repoPath: string): Promise<SpawnedEditor> => {
    await ensureSeeded()
    const key = await canonicalize(repoPath)
    const existing = running.get(key)
    if (existing) return existing

    const entry = spawn(repoPath)
    running.set(key, entry)

    // Forget on either exit path. The identity check matters: by the time a
    // rejection or an exit lands, a later open may already own the slot, and
    // deleting blindly would drop a healthy editor from the map.
    const forget = () => {
      if (running.get(key) === entry) running.delete(key)
    }
    entry.then(
      (spawned) => {
        spawned.exited?.then(forget, forget)
      },
      () => forget(),
    )
    return entry
  }
}

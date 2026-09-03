/**
 * First-run seeding of the bundled demo AS A PROJECT.
 *
 * Until 2026-09-02 the demo was a tile in the launcher's empty state ("Try
 * the demo"), and the list of projects started empty. Mo: "What it should be
 * is just the demo project, as a project, not as a startup option. Users can
 * click on new project to create a new one." So the first time this machine
 * asks for its projects, the demo is materialised and registered like any
 * other project, and the list opens with one card in it.
 *
 * Once, ever. `triedAt` is the machine-level marker `materializeDemo` sets,
 * and it survives deleting the demo on purpose: someone who removed the demo
 * has nothing on the list and sees the empty state, which is what Mo asked
 * for ("the empty state should show if the demo project is deleted and there
 * are no projects"). Re-seeding on the next launch would undo their delete.
 *
 * Lazy, on the first projects request rather than at boot. The fixture is a
 * whole Vite app with its `node_modules` (175MB at the time of writing), so
 * the copy is seconds, not milliseconds; paying it during boot would delay
 * every launch for a one-time job. The page shows its loading skeleton for
 * that first request and never waits again.
 */

import { access, mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { readProjectsRegistry, upsertProjectRegistryEntry } from "../projects-registry.js"
import { materializeDemo, type MaterializeDemoOptions } from "./materialize.js"
import { demoRepoPath, readDemoState } from "./paths.js"

/** The registry slug, which is what the project card shows as its name. */
export const DEMO_PROJECT_SLUG = "demo"

export interface SeedDemoResult {
  /** True when this call materialised and registered the demo. */
  seeded: boolean
  path: string | null
}

/**
 * Two things the first draft of this got wrong, both found in review
 * (codex, 2026-09-02) before they shipped:
 *
 * STRANDING. `materializeDemo` writes the once-ever marker before this
 * function registers the copy. A registry write that failed between the two
 * left a demo on disk that no list would ever show and no later launch would
 * ever seed again. So the marker is no longer the whole story: a demo that
 * is on disk but missing from the registry is registered on the next call,
 * marker or not. That is safe because the demo's row never leaves the
 * registry by "remove from recents"; the launcher routes its delete to the
 * real removal (`remove.ts`), which takes the directory with it.
 *
 * TWO PROCESSES. The in-memory once-guard in the launcher covers one
 * process. Two launchers on a fresh machine (two windows, a terminal and
 * the app) could both pass the marker check and both copy. A lock directory
 * beside the marker makes the copy exclusive across processes: `mkdir` is
 * atomic, the loser skips and lets the winner register, and a lock older
 * than `STALE_LOCK_MS` (a crash mid-copy) is taken over rather than
 * honoured forever.
 */
const STALE_LOCK_MS = 10 * 60_000

function seedLockPath(home: string): string {
  return join(home, ".desde", "demo-seed.lock")
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** True when this process now holds the lock. */
async function acquireSeedLock(home: string): Promise<boolean> {
  const lock = seedLockPath(home)
  await mkdir(join(home, ".desde"), { recursive: true })
  try {
    await mkdir(lock)
    return true
  } catch {
    try {
      const age = Date.now() - (await stat(lock)).mtimeMs
      if (age < STALE_LOCK_MS) return false
      await rm(lock, { recursive: true, force: true })
      await mkdir(lock)
      return true
    } catch {
      return false
    }
  }
}

async function registerIfMissing(path: string): Promise<boolean> {
  const registry = await readProjectsRegistry()
  if (registry.projects.some((p) => p.path === path)) return false
  // The registry reads HOME itself (`projectsRegistryPath`), the same way the
  // editor's own boot registers a project. A seeded demo is a registry entry
  // like any other, so the demo's delete works on it unchanged.
  await upsertProjectRegistryEntry({ path, slug: DEMO_PROJECT_SLUG })
  return true
}

export async function seedDemoProject(
  opts: MaterializeDemoOptions = {},
): Promise<SeedDemoResult> {
  const home = opts.home ?? homedir()
  const path = demoRepoPath(home)
  const state = await readDemoState(home)
  if (state.triedAt !== undefined) {
    // Not a fresh machine. Repair a stranded copy; otherwise nothing to do.
    if ((await exists(path)) && (await registerIfMissing(path))) {
      return { seeded: true, path }
    }
    return { seeded: false, path: null }
  }
  if (!(await acquireSeedLock(home))) return { seeded: false, path: null }
  try {
    const result = await materializeDemo(opts)
    await registerIfMissing(result.path)
    return { seeded: true, path: result.path }
  } finally {
    await rm(seedLockPath(home), { recursive: true, force: true })
  }
}

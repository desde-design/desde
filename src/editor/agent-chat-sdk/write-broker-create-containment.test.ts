// @vitest-environment node
/**
 * FX17 item 1 (codex review + adversarial verification, 2026-09-05,
 * SECURITY) — a create must not walk the caller's bytes out of the
 * repository, and must never report an escape as a success.
 *
 * ## What went wrong, and why the test shape matters
 *
 * The defect shipped with a green suite AND a code comment claiming it had
 * been measured away: that a lost race could only leave a ZERO-BYTE file
 * outside the repository, and that no escape was ever reported as a
 * success. The adversarial verifier disproved both halves with two ordinary
 * user processes. Its swapper renamed the destination directory out of the
 * repository, let the create land in the replacement, renamed the
 * replacement BACK so the guard's `realpath` and `lstat` both agreed, and
 * then carried it out again. Sixteen non-empty payloads left the repository
 * in twenty-five seconds, all sixteen reported as successes.
 *
 * The suite that shipped alongside it could not have caught that, because
 * every test in it built ONE interleaving by hand — necessarily one the
 * author had already thought about, which is the one the code already
 * handled. So this file has two kinds of test and needs both:
 *
 *  - `refuses the winning interleaving` drives that exact sequence
 *    deterministically, by swapping the directories from inside a mocked
 *    `open`. It is the regression pin for THIS defect: remove the parent
 *    directory's inode from the guard's re-proof and it fails, because the
 *    create then succeeds and the payload is written.
 *  - `never lets the caller's bytes be observed outside the repository`
 *    runs the real primitive tens of thousands of times against a real
 *    second OS process that toggles as fast as it can, and asserts a
 *    property over the whole run rather than one arranged ordering. Stated
 *    plainly: the pre-FX17 code PASSES this one. It is not the regression
 *    pin, it is the invariant — and it is the invariant that rejected the
 *    obvious alternative fix, staging the bytes elsewhere and publishing
 *    them with `link`, which fails it because `link` can publish an
 *    already-filled file outside the repository.
 *
 * ## The property the loop asserts, stated exactly
 *
 * The swapper empties its outside directory before every flip, so anything
 * it finds there during a flip was put there by the create it is racing. It
 * counts a HARD ESCAPE when that file is NON-EMPTY while the repository
 * path is still the symlink — that is, when the caller's bytes exist at a
 * location no path inside the repository names. That count must be zero.
 *
 * It is that property, and not "a success never ends up outside", because
 * the second is not achievable by any implementation: a directory that is
 * genuinely inside the repository when the write happens can be renamed out
 * of it immediately afterwards, and no create primitive can prevent that.
 * Asserting it would be asserting something false.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One-shot swap performed from inside a real `open` call — the same
 * technique `write-broker-precondition-write-race.test.ts` uses, and for
 * the same reason: two OS threads cannot be made to race deterministically
 * inside a single-threaded Node test, so the interleaving is produced at
 * the exact seam it needs to happen at.
 */
const raceHookState = vi.hoisted(() => ({
  current: null as { targetPath: string; sub: string; hidden: string; outdir: string } | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (path, flags, mode) => {
    const hook = raceHookState.current
    if (hook !== null && path === hook.targetPath) {
      raceHookState.current = null
      // Step 1 — the destination directory leaves the repository and a
      // symlink to the attacker's directory takes its place, so the create
      // below lands OUTSIDE.
      await actual.rename(hook.sub, hook.hidden)
      await actual.symlink(hook.outdir, hook.sub)
      const handle = await actual.open(path, flags, mode)
      // Step 2 — the attacker's directory is renamed INTO the repository,
      // so the created file's own directory genuinely resolves inside it.
      // This is what made the FX11 guard's `realpath` and `lstat` agree.
      await actual.unlink(hook.sub)
      await actual.rename(hook.outdir, hook.sub)
      return handle
    }
    return actual.open(path, flags, mode)
  }
  return { ...actual, open }
})

import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import { createNoFollow } from './write-broker'

/**
 * The swapper, as a standalone script in its OWN process.
 *
 * It never writes agent content. It only re-parents directories, which any
 * process running in the user's prototype repository can do — a build
 * script, an `npm postinstall`, a second chat session.
 */
const SWAPPER_SCRIPT = `
import { renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
const [, , BASE, SPIN, MS] = process.argv
const REPO = BASE + '/repo', SUB = REPO + '/sub'
const HIDDEN = BASE + '/hidden', OUT = BASE + '/outdir'
const OUTFILE = OUT + '/new.txt'
const until = Date.now() + Number(MS)
let flips = 0, sawOutside = 0, hardEscapes = 0
while (Date.now() < until) {
  // Empty the outside directory FIRST, so anything found in it during this
  // flip was created during this flip and cannot be a leftover.
  try { unlinkSync(OUTFILE) } catch {}
  try { renameSync(SUB, HIDDEN); symlinkSync(OUT, SUB); flips++ } catch { break }
  for (let i = 0; i < Number(SPIN); i++) {
    let st
    try { st = statSync(OUTFILE) } catch { continue }
    sawOutside++
    // Non-empty while the repository path is still the symlink: the
    // caller's bytes are at a location no path inside the repository names.
    if (st.size > 0) hardEscapes++
    break
  }
  try { unlinkSync(SUB) } catch {}
  try { renameSync(HIDDEN, SUB) } catch {}
}
try { unlinkSync(SUB) } catch {}
try { renameSync(HIDDEN, SUB) } catch {}
writeFileSync(BASE + '/swapper.json', JSON.stringify({ flips, sawOutside, hardEscapes }))
`

/**
 * How long the hostile loop runs. Long enough to reach the race many
 * thousands of times, short enough to stay an ordinary unit test.
 */
const RUN_MS = 4000

let base: string
let rootReal: string

beforeEach(async () => {
  raceHookState.current = null
  base = await realpath(await mkdtemp(join(tmpdir(), 'create-containment-')))
  await mkdir(join(base, 'repo', 'sub'), { recursive: true })
  await mkdir(join(base, 'outdir'), { recursive: true })
  rootReal = await realpath(join(base, 'repo'))
})

afterEach(async () => {
  raceHookState.current = null
  await rm(base, { recursive: true, force: true })
})

describe('createNoFollow containment (FX17 item 1)', () => {
  it("never lets the caller's bytes be observed outside the repository", async () => {
    // Written to a file rather than passed with `-e`: `-e` shifts `argv`,
    // and a silently mis-shifted swapper would exit early and leave this
    // test looking green for the wrong reason.
    const scriptPath = join(base, 'swapper.mjs')
    await writeFile(scriptPath, SWAPPER_SCRIPT)
    const swapper = spawn(process.execPath, [scriptPath, base, '300', String(RUN_MS)], {
      stdio: 'ignore',
    })
    const swapperExit = new Promise<void>((resolve) => swapper.on('exit', () => resolve()))

    const absPath = join(base, 'repo', 'sub', 'new.txt')
    let attempts = 0
    let refused = 0
    const until = Date.now() + RUN_MS
    while (Date.now() < until) {
      attempts++
      await rm(absPath, { force: true }).catch(() => {})
      const content = `ATTEMPT:${attempts}:` + 'AGENT-SECRET-PAYLOAD-'.repeat(10)
      try {
        await createNoFollow(absPath, content, rootReal)
      } catch {
        refused++
      }
    }
    await swapperExit

    const report = JSON.parse(await readFile(join(base, 'swapper.json'), 'utf8')) as {
      flips: number
      sawOutside: number
      hardEscapes: number
    }

    // Anti-vacuity. A run where the swapper never started, or the agent
    // never got going, must fail rather than pass silently.
    expect(attempts).toBeGreaterThan(1000)
    expect(refused).toBeGreaterThan(0)
    expect(report.flips).toBeGreaterThan(200)
    // The race was genuinely reached: creates DID land outside the
    // repository. Every one of them must have been empty.
    expect(report.sawOutside).toBeGreaterThan(0)
    expect(report.hardEscapes).toBe(0)
  }, 30_000)

  it('refuses the winning interleaving, and leaves no bytes in the swapped directory', async () => {
    const sub = join(base, 'repo', 'sub')
    const target = join(sub, 'new.txt')
    const subInoBefore = (await stat(sub)).ino

    raceHookState.current = {
      targetPath: target,
      sub,
      hidden: join(base, 'hidden'),
      outdir: join(base, 'outdir'),
    }

    await expect(createNoFollow(target, 'AGENT-SECRET-PAYLOAD', rootReal)).rejects.toThrow(
      /moved out of the repository/,
    )

    // The hook is one-shot and fires only on a real production `open` of
    // this exact path. Still armed means the race was never exercised, and
    // a green run would prove nothing.
    expect(raceHookState.current).toBeNull()

    // The attacker's directory is now sitting at `repo/sub`. Whatever is in
    // it, the payload must not be: the create was refused before a byte was
    // written, and the empty file it made was unlinked.
    expect((await stat(sub)).ino).not.toBe(subInoBefore)
    for (const entry of await readdir(sub)) {
      expect((await readFile(join(sub, entry))).length).toBe(0)
    }

    // And after the attacker puts everything back, nothing non-empty is
    // left outside the repository either.
    await rename(sub, join(base, 'outdir'))
    await rename(join(base, 'hidden'), sub)
    for (const entry of await readdir(join(base, 'outdir'))) {
      expect((await readFile(join(base, 'outdir', entry))).length).toBe(0)
    }
  })

  it('refuses, and writes nothing outside, when the parent is already a symlink out of the repository', async () => {
    await rm(join(base, 'repo', 'sub'), { recursive: true, force: true })
    await symlink(join(base, 'outdir'), join(base, 'repo', 'sub'))

    await expect(
      createNoFollow(join(base, 'repo', 'sub', 'new.txt'), 'SECRET', rootReal),
    ).rejects.toThrow(/outside the repository/)

    expect(await readdir(join(base, 'outdir'))).toEqual([])
  })

  it('creates the file, with the caller bytes, when nothing is racing it', async () => {
    const absPath = join(base, 'repo', 'sub', 'ok.txt')
    await createNoFollow(absPath, 'HELLO', rootReal)
    expect(await readFile(absPath, 'utf8')).toBe('HELLO')
    const parent = await realpath(dirname(absPath))
    expect(parent === rootReal || parent.startsWith(rootReal + sep)).toBe(true)
  })

  it('refuses a second create at the same name', async () => {
    const absPath = join(base, 'repo', 'sub', 'once.txt')
    await createNoFollow(absPath, 'FIRST', rootReal)
    await expect(createNoFollow(absPath, 'SECOND', rootReal)).rejects.toThrow()
    expect(await readFile(absPath, 'utf8')).toBe('FIRST')
  })
})

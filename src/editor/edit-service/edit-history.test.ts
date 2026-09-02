/**
 * Unit tests for `EditorEditHistory` (Task 1 of the toolbar undo/redo
 * plan). Mirrors the temp-dir + real-fs + real-`brokeredWrite` pattern from
 * `src/editor/agent-chat-sdk/write-broker.test.ts` — no mocks: every
 * undo/redo goes through the real broker against real files on disk.
 */
import { mkdtemp, readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  EditorEditHistory,
  MAX_HISTORY_STEPS,
  MAX_HISTORY_BYTES,
  type RecordedFile,
  type HistoryFileState,
} from './edit-history'
import { brokeredWrite } from '../agent-chat-sdk/write-broker'
import { createFileLockManager, type FileLockManager } from './file-lock-manager'

const exists = (content: string): HistoryFileState => ({ exists: true, content: Buffer.from(content) })
const ABSENT: HistoryFileState = { exists: false, content: null }

describe('EditorEditHistory', () => {
  let root: string
  let history: EditorEditHistory

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'edit-history-')))
    history = new EditorEditHistory()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Writes (or removes) the literal on-disk content at repoRel. */
  async function setDisk(repoRel: string, content: string | null): Promise<void> {
    const absPath = join(root, repoRel)
    if (content === null) {
      await rm(absPath, { force: true })
    } else {
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, content)
    }
  }

  async function readDisk(repoRel: string): Promise<string | null> {
    try {
      return await readFile(join(root, repoRel), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  }

  /** Builds a RecordedFile from literal before/after strings (null = absent). */
  function recFile(repoRel: string, before: string | null, after: string | null): RecordedFile {
    return {
      repoRel,
      absPath: join(root, repoRel),
      before: before === null ? ABSENT : exists(before),
      after: after === null ? ABSENT : exists(after),
    }
  }

  it('record clears the redo stack and sets canUndo', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'edit A' })

    const undoResult = await history.undo({ canonicalRoot: root })
    expect(undoResult.ok).toBe(true)
    expect(history.state()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'edit A' })

    await setDisk('b.vue', 'B1')
    await history.record({ label: 'edit B', files: [recFile('b.vue', 'B0', 'B1')] })
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'edit B', redoLabel: null })
  })

  it('undo restores before-state and moves the step to redo', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    const result = await history.undo({ canonicalRoot: root })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toEqual(['a.vue'])
    expect(await readDisk('a.vue')).toBe('A0')
    expect(history.state().redoLabel).toBe('edit A')
    expect(history.state().canUndo).toBe(false)
  })

  it('redo re-applies after-state and moves the step back', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
    await history.undo({ canonicalRoot: root })

    const result = await history.redo({ canonicalRoot: root })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.files).toEqual(['a.vue'])
    expect(await readDisk('a.vue')).toBe('A1')
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'edit A', redoLabel: null })
  })

  it('undo refuses when current bytes differ from after-state', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    // File changed externally after the step was recorded.
    await setDisk('a.vue', 'EXTERNAL')

    const result = await history.undo({ canonicalRoot: root })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('a.vue')
    expect(await readDisk('a.vue')).toBe('EXTERNAL')
    expect(history.state().canUndo).toBe(true)
  })

  it('undo refuses (not rejects) when the recorded path is now a directory on disk', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    // The path is now a directory, not a file — readFile throws EISDIR, not
    // ENOENT. Before the fix this threw out of applyTop instead of
    // returning a refusal.
    await setDisk('a.vue', null)
    await mkdir(join(root, 'a.vue'), { recursive: true })

    await expect(history.undo({ canonicalRoot: root })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('a.vue'),
    })
    // The step wasn't popped — the stack isn't jammed.
    expect(history.state().canUndo).toBe(true)
  })

  it('undo of a created file deletes it', async () => {
    await setDisk('new.vue', 'CREATED')
    await history.record({ label: 'create new.vue', files: [recFile('new.vue', null, 'CREATED')] })

    const undoResult = await history.undo({ canonicalRoot: root })
    expect(undoResult.ok).toBe(true)
    expect(await readDisk('new.vue')).toBe(null)

    const redoResult = await history.redo({ canonicalRoot: root })
    expect(redoResult.ok).toBe(true)
    expect(await readDisk('new.vue')).toBe('CREATED')
  })

  it('undo of a deleted file restores it', async () => {
    await setDisk('gone.vue', null)
    await history.record({ label: 'delete gone.vue', files: [recFile('gone.vue', 'ORIGINAL', null)] })

    const undoResult = await history.undo({ canonicalRoot: root })
    expect(undoResult.ok).toBe(true)
    expect(await readDisk('gone.vue')).toBe('ORIGINAL')

    const redoResult = await history.redo({ canonicalRoot: root })
    expect(redoResult.ok).toBe(true)
    expect(await readDisk('gone.vue')).toBe(null)
  })

  it('rename step round-trips', async () => {
    // Simulates renaming old.vue -> new.vue: old.vue disappears, new.vue
    // appears with the same content.
    await setDisk('old.vue', null)
    await setDisk('new.vue', 'CONTENT')
    await history.record({
      label: 'rename old.vue -> new.vue',
      files: [recFile('old.vue', 'CONTENT', null), recFile('new.vue', null, 'CONTENT')],
    })

    const undoResult = await history.undo({ canonicalRoot: root })
    expect(undoResult.ok).toBe(true)
    expect(await readDisk('old.vue')).toBe('CONTENT')
    expect(await readDisk('new.vue')).toBe(null)

    const redoResult = await history.redo({ canonicalRoot: root })
    expect(redoResult.ok).toBe(true)
    expect(await readDisk('old.vue')).toBe(null)
    expect(await readDisk('new.vue')).toBe('CONTENT')
  })

  it('multi-file step is atomic on refusal', async () => {
    await setDisk('one.vue', 'ONE-1')
    await setDisk('two.vue', 'TWO-1')
    await history.record({
      label: 'edit two files',
      files: [recFile('one.vue', 'ONE-0', 'ONE-1'), recFile('two.vue', 'TWO-0', 'TWO-1')],
    })

    // Corrupt two.vue so its current bytes no longer match the recorded
    // after-state.
    await setDisk('two.vue', 'CORRUPTED')

    const result = await history.undo({ canonicalRoot: root })
    expect(result.ok).toBe(false)
    // Neither file is restored — one.vue stays at its after-state too.
    expect(await readDisk('one.vue')).toBe('ONE-1')
    expect(await readDisk('two.vue')).toBe('CORRUPTED')
    expect(history.state().canUndo).toBe(true)
  })

  it('caps at MAX_HISTORY_STEPS, evicting oldest', async () => {
    const total = MAX_HISTORY_STEPS + 1
    for (let i = 0; i < total; i++) {
      const repoRel = `f${i}.vue`
      await setDisk(repoRel, `A${i}`)
      await history.record({ label: `edit ${i}`, files: [recFile(repoRel, `B${i}`, `A${i}`)] })
    }

    // Only MAX_HISTORY_STEPS remain: exactly that many successful undos,
    // then refusal.
    let successCount = 0
    for (let i = 0; i < total; i++) {
      const result = await history.undo({ canonicalRoot: root })
      if (result.ok) successCount++
      else {
        expect(result.reason).toBe('Nothing to undo.')
        break
      }
    }
    expect(successCount).toBe(MAX_HISTORY_STEPS)

    // The oldest step (f0.vue, index 0) was evicted before it could ever
    // be undone — its content is still the after-state it was recorded
    // with, never reverted to its before-state.
    expect(await readDisk('f0.vue')).toBe('A0')
    // The next-oldest surviving step (f1.vue, index 1) WAS undone.
    expect(await readDisk('f1.vue')).toBe('B1')
  })

  it('undo with expectedTopId mismatch refuses without touching disk', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    const result = await history.undo({ canonicalRoot: root, expectedTopId: 'bogus-id' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('History changed. Try again.')
    expect(await readDisk('a.vue')).toBe('A1')
    expect(history.state().canUndo).toBe(true)
  })

  it('undo with empty stack refuses with "Nothing to undo."', async () => {
    const result = await history.undo({ canonicalRoot: root })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('Nothing to undo.')
  })

  it('peek returns top step id + repoRel files; null when empty', async () => {
    expect(history.peek('undo')).toBe(null)
    expect(history.peek('redo')).toBe(null)

    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    const top = history.peek('undo')
    expect(top).not.toBe(null)
    expect(top?.files).toEqual(['a.vue'])
    expect(history.peek('redo')).toBe(null)

    // The id peek() returns is the same id undo()'s expectedTopId accepts.
    const result = await history.undo({ canonicalRoot: root, expectedTopId: top!.id })
    expect(result.ok).toBe(true)
  })

  it('brokeredWrite record option round-trips through undo/redo (Task 2 integration)', async () => {
    // Proves the two halves agree on state shapes: `brokeredWrite`'s
    // `record` option (write-broker.ts) builds `RecordedFile`/
    // `HistoryFileState` values structurally, without importing this
    // module — this test drives them through the REAL `EditorEditHistory`
    // to confirm undo/redo can actually consume what the broker produces.
    await setDisk('App.vue', 'BEFORE')

    const writeResult = await brokeredWrite({
      canonicalRoot: root,
      journal: [{ file: 'App.vue', content: 'BEFORE' }],
      ops: [
        { kind: 'write', repoRel: 'App.vue', absPath: join(root, 'App.vue'), content: 'AFTER' },
      ],
      record: { history, label: 'edit App.vue via broker' },
    })

    expect(writeResult.ok).toBe(true)
    expect(await readDisk('App.vue')).toBe('AFTER')
    expect(history.state()).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: 'edit App.vue via broker',
    })

    const undoResult = await history.undo({ canonicalRoot: root })
    expect(undoResult.ok).toBe(true)
    if (!undoResult.ok) return
    expect(undoResult.files).toEqual(['App.vue'])
    expect(await readDisk('App.vue')).toBe('BEFORE')
    expect(history.state()).toMatchObject({ canUndo: false, canRedo: true })

    const redoResult = await history.redo({ canonicalRoot: root })
    expect(redoResult.ok).toBe(true)
    if (!redoResult.ok) return
    expect(await readDisk('App.vue')).toBe('AFTER')
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false })
  })

  it('clear empties both stacks (codex P2: history must not cross a checkout change)', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
    await setDisk('b.vue', 'B1')
    await history.record({ label: 'edit B', files: [recFile('b.vue', 'B0', 'B1')] })
    // Undo one step so BOTH stacks are non-empty before clearing.
    await history.undo({ canonicalRoot: root })
    expect(history.state()).toMatchObject({ canUndo: true, canRedo: true })

    await history.clear()

    expect(history.state()).toEqual({
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
    })
  })

  it('undo refuses (instead of clobbering) when a concurrent writer wins the race between the pre-read and the broker lock acquisition (TOCTOU regression, undo/redo follow-ups Task 1)', async () => {
    // The gap this closes: `applyTop`'s pre-read (above) sees the expected
    // after-bytes and decides to proceed, but a writer with no outer lock
    // on this step — an SDK structural tool from another chat session
    // doesn't hold the CLI's outer file-edit locks — can land in the
    // window between that read and the broker actually acquiring its
    // locks. Before this task, undo/redo had nothing guarding that window:
    // the broker would restore the recorded before-bytes right over the
    // concurrent writer's content, silently destroying it.
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    const realLockManager = createFileLockManager()
    const targetAbsPath = join(root, 'a.vue')
    // A wrapper around the real lock manager (mirrors write-broker.test.ts's
    // own `hooked` test seam) whose `withWriteLock` for the target path
    // writes interloper bytes BEFORE delegating to the real lock — i.e.
    // exactly the moment `applyTop`'s pre-read has already happened but the
    // broker's own lock-protected snapshot/precondition check hasn't yet.
    const interloperLockManager: FileLockManager = {
      withLock: (p, fn, o) => realLockManager.withLock(p, fn, o),
      withWriteLock: (p, fn, o) =>
        realLockManager.withWriteLock(
          p,
          async () => {
            if (p === targetAbsPath) {
              await writeFile(p, 'FROM-CONCURRENT-WRITER')
            }
            return fn()
          },
          o,
        ),
      inspect: () => realLockManager.inspect(),
    }

    const result = await history.undo({ canonicalRoot: root, lockManager: interloperLockManager })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('a.vue')
    // The interloper's bytes survive on disk — undo must not clobber them.
    expect(await readDisk('a.vue')).toBe('FROM-CONCURRENT-WRITER')
    // The step stays on the undo stack — refused, not lost.
    expect(history.state().canUndo).toBe(true)
  })

  it('clear serializes through the run queue: a record queued right after it still lands', async () => {
    await setDisk('a.vue', 'A1')
    await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

    // Don't await clear() before queuing the next record — both go through
    // the same `run` chain, so clear must finish emptying the stacks before
    // the queued record's push is applied, not race it.
    const clearPromise = history.clear()
    await setDisk('c.vue', 'C1')
    const recordPromise = history.record({ label: 'edit C', files: [recFile('c.vue', 'C0', 'C1')] })
    await Promise.all([clearPromise, recordPromise])

    expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'edit C' })
  })

  describe('byte budget (undo/redo follow-ups Task 2)', () => {
    it('exports the documented default budget', () => {
      expect(MAX_HISTORY_BYTES).toBe(20 * 1024 * 1024)
    })

    it('evicts the undo-stack bottom (oldest) when the byte budget is exceeded, labels shift correctly', async () => {
      // Each step below is 20 bytes (10-byte before + 10-byte after). A
      // 45-byte budget holds exactly two; the third pushes it over and the
      // oldest (edit 0) is evicted before it can ever be undone.
      history = new EditorEditHistory(45)
      await setDisk('f0.vue', '0123456789')
      await history.record({ label: 'edit 0', files: [recFile('f0.vue', '9876543210', '0123456789')] })
      await setDisk('f1.vue', '0123456789')
      await history.record({ label: 'edit 1', files: [recFile('f1.vue', '9876543210', '0123456789')] })
      await setDisk('f2.vue', '0123456789')
      await history.record({ label: 'edit 2', files: [recFile('f2.vue', '9876543210', '0123456789')] })

      // f0.vue was never touched — its step was evicted, not undone.
      expect(await readDisk('f0.vue')).toBe('0123456789')

      const first = await history.undo({ canonicalRoot: root })
      expect(first.ok).toBe(true)
      expect(await readDisk('f2.vue')).toBe('9876543210')
      expect(history.state()).toMatchObject({ undoLabel: 'edit 1', redoLabel: 'edit 2' })

      const second = await history.undo({ canonicalRoot: root })
      expect(second.ok).toBe(true)
      expect(await readDisk('f1.vue')).toBe('9876543210')
      expect(history.state()).toMatchObject({ redoLabel: 'edit 1' })

      // edit 0 is gone — nothing left to undo.
      const third = await history.undo({ canonicalRoot: root })
      expect(third.ok).toBe(false)
      if (third.ok) return
      expect(third.reason).toBe('Nothing to undo.')
    })

    it('keeps a single over-budget step alone instead of discarding it', async () => {
      history = new EditorEditHistory(10) // smaller than one step's own bytes
      await setDisk('big.vue', '0123456789')
      await history.record({ label: 'huge edit', files: [recFile('big.vue', '9876543210', '0123456789')] })

      expect(history.state()).toMatchObject({ canUndo: true, undoLabel: 'huge edit' })
      const result = await history.undo({ canonicalRoot: root })
      expect(result.ok).toBe(true)
      expect(await readDisk('big.vue')).toBe('9876543210')
    })

    it('redo bytes invalidated by the recording edit do not drive eviction', async () => {
      // Regression for a Task 2 review finding: enforceBudget() must run
      // AFTER record() clears the redo stack, not before. A step parked on
      // redo is invalidated by this very record() call — its bytes are
      // freed on the very next line regardless — so it must never be
      // allowed to justify evicting real, still-reachable undo history to
      // make room for it.
      history = new EditorEditHistory(45)
      await setDisk('a.vue', '0123456789')
      await history.record({ label: 'edit A', files: [recFile('a.vue', '9876543210', '0123456789')] }) // 20 bytes
      await setDisk('b.vue', '0123456789')
      await history.record({ label: 'edit B', files: [recFile('b.vue', '9876543210', '0123456789')] }) // total 40

      // Undo B: it moves to the redo stack. undo=[A](20) redo=[B](20), total 40 <= 45.
      await history.undo({ canonicalRoot: root })
      expect(history.state()).toMatchObject({
        canUndo: true,
        canRedo: true,
        undoLabel: 'edit A',
        redoLabel: 'edit B',
      })

      // Record C (20 bytes): push -> undo=[A,C], then redoStack is cleared
      // (B's bytes gone) BEFORE the budget is enforced. Total considered is
      // just A(20)+C(20)=40 <= 45 — under budget. Nothing is evicted; A
      // survives even though B was briefly "in the way" moments earlier.
      await setDisk('c.vue', '0123456789')
      await history.record({ label: 'edit C', files: [recFile('c.vue', '9876543210', '0123456789')] })

      expect(history.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: 'edit C' })
      const undoC = await history.undo({ canonicalRoot: root })
      expect(undoC.ok).toBe(true)
      expect(undoC.ok && undoC.files).toEqual(['c.vue'])

      // A is still there — it was never evicted.
      expect(history.state()).toMatchObject({ canUndo: true, undoLabel: 'edit A' })
      const undoA = await history.undo({ canonicalRoot: root })
      expect(undoA.ok).toBe(true)
      expect(undoA.ok && undoA.files).toEqual(['a.vue'])

      const nothingLeft = await history.undo({ canonicalRoot: root })
      expect(nothingLeft.ok).toBe(false)
    })

    it('the 50-step cap still applies independently of a generous byte budget', async () => {
      history = new EditorEditHistory(1024 * 1024) // 1MB — plenty for 51 tiny steps
      const total = MAX_HISTORY_STEPS + 1
      for (let i = 0; i < total; i++) {
        const repoRel = `h${i}.vue`
        await setDisk(repoRel, `A${i}`)
        await history.record({ label: `edit ${i}`, files: [recFile(repoRel, `B${i}`, `A${i}`)] })
      }

      let successCount = 0
      for (let i = 0; i < total; i++) {
        const result = await history.undo({ canonicalRoot: root })
        if (result.ok) successCount++
        else {
          expect(result.reason).toBe('Nothing to undo.')
          break
        }
      }
      expect(successCount).toBe(MAX_HISTORY_STEPS)
    })
  })

  describe('discardTop (undo/redo follow-ups Task 3)', () => {
    it('pops the top undo step without touching disk or applying anything', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

      const result = await history.discardTop('undo')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files).toEqual(['a.vue'])
      // Disk is untouched — discard never applies the step.
      expect(await readDisk('a.vue')).toBe('A1')
      expect(history.state()).toMatchObject({ canUndo: false, canRedo: false })
    })

    it('discard from undo does NOT push the step onto redo — it is gone', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

      const result = await history.discardTop('undo')
      expect(result.ok).toBe(true)
      expect(history.state()).toMatchObject({ canUndo: false, canRedo: false, redoLabel: null })
    })

    it('discard from redo does NOT push the step back onto undo', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
      await history.undo({ canonicalRoot: root })
      expect(history.state()).toMatchObject({ canUndo: false, canRedo: true })

      const result = await history.discardTop('redo')
      expect(result.ok).toBe(true)
      expect(history.state()).toMatchObject({ canUndo: false, canRedo: false, undoLabel: null })
    })

    it('refuses on an empty stack, without setting stranded', async () => {
      const result = await history.discardTop('undo')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('Nothing to undo.')
      expect(result.stranded).toBeUndefined()
    })

    it('refuses on expectedTopId mismatch, without setting stranded', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

      const result = await history.discardTop('undo', 'bogus-id')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('History changed. Try again.')
      expect(result.stranded).toBeUndefined()
      // The step wasn't discarded — the mismatched request had no effect.
      expect(history.state().canUndo).toBe(true)
    })

    it('accepts a matching expectedTopId', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
      const top = history.peek('undo')

      const result = await history.discardTop('undo', top!.id)
      expect(result.ok).toBe(true)
      expect(history.state().canUndo).toBe(false)
    })

    it('two-tabs regression: a stale expectedTopId refuses instead of popping whatever is now on top', async () => {
      // Tab A and tab B both observe step S1 (undo top) and its stranded
      // toast. Tab A discards S1 first — which pops it — then a NEW step S2
      // is recorded (a different edit landed in between, e.g. from tab A
      // itself). Tab B's stale "Discard step" click, still carrying S1's
      // id, must refuse — NOT silently pop S2, a perfectly valid step it
      // never observed.
      await setDisk('s1.vue', 'S1')
      await history.record({ label: 'edit S1', files: [recFile('s1.vue', 'S0', 'S1')] })
      const s1 = history.peek('undo')

      const discardS1 = await history.discardTop('undo', s1!.id)
      expect(discardS1.ok).toBe(true)

      await setDisk('s2.vue', 'S2')
      await history.record({ label: 'edit S2', files: [recFile('s2.vue', 'S0', 'S2')] })
      const s2 = history.peek('undo')
      expect(s2!.id).not.toBe(s1!.id)

      // Tab B's stale request, still targeting S1's id.
      const staleDiscard = await history.discardTop('undo', s1!.id)
      expect(staleDiscard.ok).toBe(false)
      if (staleDiscard.ok) return
      expect(staleDiscard.reason).toBe('History changed. Try again.')

      // S2 is untouched — still the undo top.
      expect(history.peek('undo')).toEqual(s2)
      expect(history.state()).toMatchObject({ canUndo: true, undoLabel: 'edit S2' })
    })
  })

  describe('stranded flag on applyTop refusals (undo/redo follow-ups Task 3)', () => {
    it('sets stranded:true and stepId when current bytes differ from the expected state (byte-mismatch)', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
      const top = history.peek('undo')
      await setDisk('a.vue', 'EXTERNAL')

      const result = await history.undo({ canonicalRoot: root })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.stranded).toBe(true)
      expect(result.stepId).toBe(top!.id)
    })

    it('sets stranded:true and stepId on a non-ENOENT read failure', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
      const top = history.peek('undo')
      await setDisk('a.vue', null)
      await mkdir(join(root, 'a.vue'), { recursive: true })

      const result = await history.undo({ canonicalRoot: root })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.stranded).toBe(true)
      expect(result.stepId).toBe(top!.id)
    })

    it('sets stranded:true and stepId on a broker precondition failure (TOCTOU race)', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })
      const top = history.peek('undo')

      const realLockManager = createFileLockManager()
      const targetAbsPath = join(root, 'a.vue')
      const interloperLockManager: FileLockManager = {
        withLock: (p, fn, o) => realLockManager.withLock(p, fn, o),
        withWriteLock: (p, fn, o) =>
          realLockManager.withWriteLock(
            p,
            async () => {
              if (p === targetAbsPath) {
                await writeFile(p, 'FROM-CONCURRENT-WRITER')
              }
              return fn()
            },
            o,
          ),
        inspect: () => realLockManager.inspect(),
      }

      const result = await history.undo({ canonicalRoot: root, lockManager: interloperLockManager })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.stranded).toBe(true)
      expect(result.stepId).toBe(top!.id)
    })

    it('does NOT set stranded or stepId on an empty-stack refusal', async () => {
      const result = await history.undo({ canonicalRoot: root })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.stranded).toBeUndefined()
      expect(result.stepId).toBeUndefined()
    })

    it('does NOT set stranded or stepId on an expectedTopId mismatch (id-race) refusal', async () => {
      await setDisk('a.vue', 'A1')
      await history.record({ label: 'edit A', files: [recFile('a.vue', 'A0', 'A1')] })

      const result = await history.undo({ canonicalRoot: root, expectedTopId: 'bogus-id' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.stranded).toBeUndefined()
      expect(result.stepId).toBeUndefined()
    })
  })
})

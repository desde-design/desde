/**
 * Tests for `insertElementHandler` — the standalone function backing
 * `mcp__editor__insert_element` (plain/primitive elements + bare text).
 * Branch mode: the handler mutates the repo's working tree in place with
 * NO per-op commit — the prior content is journaled to
 * `.desde/backups/` before the mutation and the change is left
 * uncommitted for the user's own git. Drives a real temp git repo (so
 * HEAD-didn't-move / working-tree-dirty assertions are meaningful). No
 * grounding — this path is catalog-free.
 */

import { execFile } from 'node:child_process'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EditProposalPayload } from '../agent-tools/types'
import type { EmitEditResult, FileWriteToolResult } from './editor-tools'
import { insertElementHandler } from './fs-structural-tools'

const execFileP = promisify(execFile)

const SFC = `<script setup lang="ts">
import { ref } from 'vue'
const n = ref(0)
</script>

<template>
  <div>
    <span>existing</span>
  </div>
</template>
`
// `<div>` sits at SFC line 7, column 3.
const DIV_LINE = 7
const DIV_COL = 3

async function makeWorktree(seedContent = SFC): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pt-insert-el-'))
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: root })
  await execFileP('mkdir', ['-p', join(root, 'src')], { cwd: root })
  await writeFile(join(root, 'src/App.vue'), seedContent, 'utf8')
  await execFileP('git', ['add', '-A'], { cwd: root })
  await execFileP('git', ['commit', '-q', '-m', 'seed'], { cwd: root })
  return { root }
}

function captureEmit(): {
  emitEdit: (p: EditProposalPayload) => Promise<EmitEditResult>
  emissions: EditProposalPayload[]
} {
  const emissions: EditProposalPayload[] = []
  return {
    emissions,
    emitEdit: async (payload) => {
      emissions.push(payload)
      return { ok: true, editId: `eid-${emissions.length}` }
    },
  }
}

function asJson(r: FileWriteToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>
}

async function headSubject(root: string): Promise<string> {
  const { stdout } = await execFileP('git', ['log', '-1', '--pretty=%s'], { cwd: root })
  return stdout.trim()
}

describe('insertElementHandler', () => {
  let root: string

  beforeEach(async () => {
    const made = await makeWorktree()
    root = made.root
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses without an editable repo root', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: undefined,
      emitEdit,
      input: { file: 'src/App.vue', line: DIV_LINE, column: DIV_COL, snippet: '<p>x</p>' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(
      /insert_element is not configured with an editable repo root for this run/,
    )
  })

  it('inserts a primitive element, adds NO import, journals a backup, invalidates the file, and does NOT commit', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidated: string[][] = []
    const before = await readFile(join(root, 'src/App.vue'), 'utf8')
    const r = await insertElementHandler({
      worktreeRoot: root,
      invalidateFiles: (files) => invalidated.push(files),
      emitEdit,
      input: {
        file: 'src/App.vue',
        line: DIV_LINE,
        column: DIV_COL,
        snippet: '<button class="btn">Go</button>',
      },
    })
    expect(r.isError).toBeFalsy()
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('<button class="btn">Go</button>')
    // No import added for a primitive element.
    expect(written).not.toContain("from '@")

    // Audit proposal emitted as an overwrite carrier.
    expect(emissions).toHaveLength(1)
    expect(emissions[0]).toMatchObject({ type: 'overwrite', file: 'src/App.vue', appliedByAgent: true })

    // Branch mode: prior content is recoverable from the backup journal.
    const out = asJson(r)
    expect(out.backupDir).toMatch(/^\.desde\/backups\//)
    const backedUp = await readFile(join(root, out.backupDir as string, 'src/App.vue'), 'utf8')
    expect(backedUp).toBe(before)

    // The Vite invalidation callback fired for the written file.
    expect(invalidated).toEqual([['src/App.vue']])

    // NO per-op commit — the insert is an ordinary uncommitted
    // working-tree change; HEAD stays at the seed commit.
    expect(await headSubject(root)).toBe('seed')
    const { stdout: status } = await execFileP('git', ['status', '--porcelain'], { cwd: root })
    expect(status).toMatch(/^ M src\/App\.vue/m)
  })

  it('inserts bare text (contentKind text) escaped into the container', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: {
        file: 'src/App.vue',
        line: DIV_LINE,
        column: DIV_COL,
        snippet: 'Tom & Jerry < co',
        contentKind: 'text',
      },
    })
    expect(r.isError).toBeFalsy()
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('Tom &amp; Jerry &lt; co')
  })

  it('refuses a multi-root element snippet', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: { file: 'src/App.vue', line: DIV_LINE, column: DIV_COL, snippet: '<i>a</i><i>b</i>' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/single root element/i)
  })

  it('refuses bare text passed in element mode (directs to text mode)', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: { file: 'src/App.vue', line: DIV_LINE, column: DIV_COL, snippet: 'just text' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no root element|contentKind/i)
  })

  it('refuses text content with Vue interpolation', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: {
        file: 'src/App.vue',
        line: DIV_LINE,
        column: DIV_COL,
        snippet: '{{ n }}',
        contentKind: 'text',
      },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/interpolation/i)
  })

  it('denies a path-traversal file', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: { file: '../../../etc/passwd', line: 1, column: 1, snippet: '<p>x</p>' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/denied/i)
  })

  it('refuses a non-integer coordinate', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: { file: 'src/App.vue', line: 7.5, column: DIV_COL, snippet: '<p>x</p>' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/integer/i)
  })

  it('refuses when the destination parent is not found', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertElementHandler({
      worktreeRoot: root,
      emitEdit,
      input: { file: 'src/App.vue', line: 999, column: 1, snippet: '<p>x</p>' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no destination parent/i)
  })
})

/**
 * Tests for `insertComponentHandler` — the standalone function backing
 * `mcp__editor__insert_component`. Branch mode: the handler mutates the
 * repo's working tree in place with NO per-op commit — the prior content
 * is journaled to `.desde/backups/` before the mutation and the
 * change is left uncommitted for the user's own git. Drives a real temp
 * git repo (so HEAD-didn't-move / working-tree-dirty assertions are
 * meaningful) and a stub GroundingService so component resolution is
 * deterministic.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EditProposalPayload } from '../agent-tools/types'
import type { ComponentManifest, GroundingService } from '../core'
import type { EmitEditResult, FileWriteToolResult } from './editor-tools'
import { insertComponentHandler } from './fs-structural-tools'
import type { GetGrounding } from './grounding-tools'

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

async function makeWorktree(seedFile = 'src/App.vue', seedContent = SFC): Promise<{
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'pt-insert-'))
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: root })
  const abs = join(root, seedFile)
  await execFileP('mkdir', ['-p', join(root, 'src')], { cwd: root })
  await writeFile(abs, seedContent, 'utf8')
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

/** Stub grounding that resolves a fixed manifest by name. */
function stubGrounding(manifests: Record<string, Partial<ComponentManifest>>): GetGrounding {
  const service = {
    getManifestSource: async () => ({
      getComponent: async (name: string) =>
        manifests[name] ? ({ name, ...manifests[name] } as ComponentManifest) : null,
      listComponents: async () => [],
    }),
  } as unknown as GroundingService
  return async () => service
}

function asJson(r: FileWriteToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>
}

async function headSubject(root: string): Promise<string> {
  const { stdout } = await execFileP('git', ['log', '-1', '--pretty=%s'], { cwd: root })
  return stdout.trim()
}

describe('insertComponentHandler', () => {
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
    const r = await insertComponentHandler({
      worktreeRoot: undefined,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(
      /insert_component is not configured with an editable repo root for this run/,
    )
  })

  it('refuses when grounding is not configured', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: undefined,
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/grounding/)
  })

  it('refuses an unknown component (not in the catalog)', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'KNope', file: 'src/App.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no component named "KNope"/)
  })

  it('refuses a path that escapes the worktree', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiCard', file: '../escape.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/denied/)
  })

  it('refuses when the parent location does not match an element', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 99, column: 99 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/No destination parent/)
  })

  it('inserts the component, auto-imports it, journals a backup, invalidates the file, emits an applied overwrite carrier, and does NOT commit', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidated: string[][] = []
    const before = await readFile(join(root, 'src/App.vue'), 'utf8')
    const r = await insertComponentHandler({
      worktreeRoot: root,
      invalidateFiles: (files) => invalidated.push(files),
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      // <div> is on line 7, col 3 in the seed SFC.
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3, text: 'Hello' },
    })
    expect(r.isError).toBeUndefined()

    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('<UiCard>Hello</UiCard>')
    expect(written).toContain("import { UiCard } from '@acme/design-system'")

    // Audit carrier: overwrite + appliedByAgent (no new payload type).
    expect(emissions).toHaveLength(1)
    const carrier = emissions[0]
    expect(carrier.type).toBe('overwrite')
    if (carrier.type !== 'overwrite') throw new Error('unreachable')
    expect(carrier.file).toBe('src/App.vue')
    expect(carrier.appliedByAgent).toBe(true)
    expect(carrier.newSource).toBe(written)
    expect(carrier.baseHash).toMatch(/^[0-9a-f]{64}$/)

    const out = asJson(r)
    expect(out.editId).toBe('eid-1')

    // Branch mode: prior content is recoverable from the backup journal.
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

  it('renders string props as literal attrs and numeric/boolean as bound', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiButton: { importPath: '@acme/design-system' } }),
      input: {
        componentName: 'UiButton',
        file: 'src/App.vue',
        line: 7,
        column: 3,
        props: { appearance: 'primary', count: 3, disabled: true },
        text: 'Save',
      },
    })
    expect(r.isError).toBeUndefined()
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('appearance="primary"')
    expect(written).toContain(':count="3"')
    // boolean true must be a BOUND attr (real boolean), not bare `disabled`.
    expect(written).toContain(':disabled="true"')
    expect(written).toContain('<UiButton')
  })

  it('inserts a self-closing element when no text is given', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiIcon: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiIcon', file: 'src/App.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBeUndefined()
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('<UiIcon />')
  })

  it('refuses (no write) when the manifest has no import path', async () => {
    // No importPath (first-party / globally-registered) → can't construct a
    // safe import deterministically → refuse rather than write unresolved.
    const before = await readFile(join(root, 'src/App.vue'), 'utf8')
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: {} }), // no importPath
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3, text: 'Hi' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/no import path/)
    expect(await readFile(join(root, 'src/App.vue'), 'utf8')).toBe(before)
  })

  it('refuses (no write) when the manifest import path is source-relative', async () => {
    // Storybook-style `./Button.vue` is valid from the story, not from an
    // arbitrary destination SFC — refuse rather than write a broken import.
    const before = await readFile(join(root, 'src/App.vue'), 'utf8')
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: './UiCard.vue' } }),
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3, text: 'Hi' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/source-relative import path/)
    expect(await readFile(join(root, 'src/App.vue'), 'utf8')).toBe(before)
  })

  it('accepts a build-alias import path (location-independent)', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ MyCard: { importPath: '@/components/MyCard.vue' } }),
      input: { componentName: 'MyCard', file: 'src/App.vue', line: 7, column: 3 },
    })
    expect(r.isError).toBeUndefined()
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).toContain('<MyCard />')
    // `@/...MyCard.vue` ends in .vue → default import.
    expect(written).toContain("import MyCard from '@/components/MyCard.vue'")
  })

  it('refuses (no write) when the import cannot be auto-added', async () => {
    // Options-API SFC: no <script setup>, so applyInsertEdit warns instead
    // of adding the import. The agent path is all-or-nothing — refuse
    // rather than write an unresolved <UiCard>.
    const optionsApi = `<script>\nexport default {}\n</script>\n\n<template>\n  <div>\n    <span>x</span>\n  </div>\n</template>\n`
    await writeFile(join(root, 'src/App.vue'), optionsApi, 'utf8')
    await execFileP('git', ['commit', '-qam', 'options-api'], { cwd: root })
    const before = await readFile(join(root, 'src/App.vue'), 'utf8')
    const { emitEdit, emissions } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 6, column: 3, text: 'Hi' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/import could not be added/)
    // File untouched, nothing emitted, nothing committed.
    expect(await readFile(join(root, 'src/App.vue'), 'utf8')).toBe(before)
    expect(emissions).toHaveLength(0)
    expect(await headSubject(root)).toBe('options-api')
  })

  it('refuses a non-integer destIndex (cleanly, not a crash)', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: { componentName: 'UiCard', file: 'src/App.vue', line: 7, column: 3, destIndex: 0.5 },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/must be integers/)
  })

  it('refuses slot text containing Vue interpolation delimiters', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: {
        componentName: 'UiCard',
        file: 'src/App.vue',
        line: 7,
        column: 3,
        text: 'Total: {{ count }}',
      },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/interpolation delimiters/)
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).not.toContain('UiCard')
  })

  it('refuses a malformed snippet (bad prop name) via the applicator post-splice parse', async () => {
    const { emitEdit } = captureEmit()
    const r = await insertComponentHandler({
      worktreeRoot: root,
      emitEdit,
      getGrounding: stubGrounding({ UiCard: { importPath: '@acme/design-system' } }),
      input: {
        componentName: 'UiCard',
        file: 'src/App.vue',
        line: 7,
        column: 3,
        props: { 'bad=name': 'x' },
      },
    })
    expect(r.isError).toBe(true)
    // The original file must be untouched on refusal.
    const written = await readFile(join(root, 'src/App.vue'), 'utf8')
    expect(written).not.toContain('UiCard')
  })
})

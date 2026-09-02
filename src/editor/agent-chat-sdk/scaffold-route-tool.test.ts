/**
 * Tests for `scaffoldRouteHandler` — the standalone function backing
 * `mcp__editor__scaffold_route` (create a page SFC + register its route).
 * Drives a real temp git repo seeded with a Vue Router config + a views dir.
 * Branch mode: the handler edits the working tree in place with no per-op
 * commit — undo comes from the backup journal, not git history.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditProposalPayload } from '../agent-tools/types'
import type { EmitEditResult } from './editor-tools'
import { scaffoldRouteHandler } from './fs-structural-tools'

const execFileP = promisify(execFile)

const ROUTER = `import { createRouter, createWebHistory } from 'vue-router'

import Home from '../views/Home.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: Home
    }
  ]
})

export default router
`

async function makeWorktree(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pt-scaffold-'))
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: root })
  await mkdir(join(root, 'src/router'), { recursive: true })
  await mkdir(join(root, 'src/views'), { recursive: true })
  await writeFile(join(root, 'src/router/index.ts'), ROUTER, 'utf8')
  await writeFile(join(root, 'src/views/Home.vue'), '<template><div>home</div></template>\n', 'utf8')
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

describe('scaffoldRouteHandler', () => {
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
    const r = await scaffoldRouteHandler({
      worktreeRoot: undefined,
      emitEdit,
      input: { path: '/about' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not configured with an editable repo root/i)
  })

  it('creates the page SFC, registers a lazy route, journals a backup, and emits two proposals', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidateFiles = vi.fn()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      invalidateFiles,
      emitEdit,
      input: { path: '/about' },
    })
    expect(r.isError).toBeFalsy()

    // New SFC created.
    const sfc = await readFile(join(root, 'src/views/About.vue'), 'utf8')
    expect(sfc).toContain('<h1>About</h1>')

    // Router updated with a lazy import — no separate import statement.
    const router = await readFile(join(root, 'src/router/index.ts'), 'utf8')
    expect(router).toContain("component: () => import('../views/About.vue')")
    expect(router).toContain("path: '/about'")
    expect(router).not.toContain('import About from')

    // No per-op commit — the write is an ordinary uncommitted working-tree
    // change; HEAD does not move.
    const status = (await execFileP('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()
    expect(status).not.toBe('')

    // Two audit proposals: new SFC (allowCreate) + router overwrite (baseHash).
    expect(emissions).toHaveLength(2)
    const sfcEmit = emissions.find((e) => 'file' in e && e.file === 'src/views/About.vue')
    const routerEmit = emissions.find((e) => 'file' in e && e.file === 'src/router/index.ts')
    expect(sfcEmit).toMatchObject({ type: 'overwrite', allowCreate: true, appliedByAgent: true })
    expect(routerEmit).toMatchObject({ type: 'overwrite', appliedByAgent: true })
    expect((routerEmit as { baseHash?: string }).baseHash).toBeTruthy()

    // invalidateFiles called with the new SFC + router repo-relative paths.
    expect(invalidateFiles).toHaveBeenCalledWith(['src/views/About.vue', 'src/router/index.ts'])

    // Result JSON carries the path + files + backupDir (not `committed`).
    const out = JSON.parse(r.content[0].text)
    expect(out.routePath).toBe('/about')
    expect(out.pageFile).toBe('src/views/About.vue')
    expect(out.backupDir).toMatch(/^\.desde\/backups\//)

    // The backup journal holds the router's ORIGINAL (pre-edit) content —
    // only the router is backed up; the new SFC had no prior content.
    const backedUpRouter = await readFile(join(root, out.backupDir, 'src/router/index.ts'), 'utf8')
    expect(backedUpRouter).toBe(ROUTER)
  })

  it('auto-detects the router when routerFile is omitted', async () => {
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/contact' },
    })
    expect(r.isError).toBeFalsy()
    expect(existsSync(join(root, 'src/views/Contact.vue'))).toBe(true)
  })

  it('honors an explicit routerFile', async () => {
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/help', routerFile: 'src/router/index.ts' },
    })
    expect(r.isError).toBeFalsy()
    expect(existsSync(join(root, 'src/views/Help.vue'))).toBe(true)
  })

  it('refuses a duplicate path', async () => {
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/' },
    })
    // '/' has no static segment → caught earlier as a naming refusal.
    expect(r.isError).toBe(true)
  })

  it('two concurrent scaffolds of the same route: one wins, the loser refuses without clobbering', async () => {
    // codex P2 (batch 4): the `existsSync` guard below runs before the
    // broker's write lock, so both calls pass it. Without `exclusive` on
    // the page-create op the loser would overwrite the winner's freshly
    // created page and then UNLINK it during `isNew` rollback — the page
    // would simply vanish while both calls looked plausible.
    const a = captureEmit()
    const b = captureEmit()
    const [r1, r2] = await Promise.all([
      scaffoldRouteHandler({ worktreeRoot: root, emitEdit: a.emitEdit, input: { path: '/about' } }),
      scaffoldRouteHandler({ worktreeRoot: root, emitEdit: b.emitEdit, input: { path: '/about' } }),
    ])

    // Exactly one succeeded; the loser refused with the same wording the
    // pre-write existence check uses.
    const errors = [r1, r2].filter((r) => r.isError)
    expect(errors).toHaveLength(1)
    expect(errors[0].content[0].text).toMatch(/already exists/i)

    // The winner's page is on disk and intact — not truncated, not removed.
    const page = await readFile(join(root, 'src/views/About.vue'), 'utf8')
    expect(page).toContain('<template>')
    expect(page.length).toBeGreaterThan(0)

    // The winner's route registration ALSO survives. This is what the
    // codex batch-5 P2 fix bought beyond the page file: the loser now
    // rolls back to what it actually clobbered (a snapshot taken under
    // the batch's locks, i.e. the winner's router) rather than to the
    // stale base it read before the winner ran. Previously the loser's
    // rollback reverted the winner's registration, leaving a page with
    // no route.
    const router = await readFile(join(root, 'src/router/index.ts'), 'utf8')
    expect(router).toContain('/about')
  })

  it('refuses when the page file already exists', async () => {
    await writeFile(join(root, 'src/views/About.vue'), '<template><div/></template>\n', 'utf8')
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/about' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/already exists/i)
  })

  it('refuses when no router config can be found', async () => {
    await rm(join(root, 'src/router/index.ts'))
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/about' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/could not auto-detect/i)
  })

  it('leaves the worktree clean (no write) when the plan is refused', async () => {
    const { emitEdit, emissions } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/:id' },
    })
    expect(r.isError).toBe(true)
    expect(emissions).toHaveLength(0)
    const status = (await execFileP('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()
    expect(status).toBe('')
  })

  it('denies a path-traversal routerFile', async () => {
    const { emitEdit } = captureEmit()
    const r = await scaffoldRouteHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '/about', routerFile: '../../../etc/hosts' },
    })
    expect(r.isError).toBe(true)
  })
})

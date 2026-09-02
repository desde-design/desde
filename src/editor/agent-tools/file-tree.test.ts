/**
 * Tests for `list_files` (Phase 4).
 */

import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listFilesTool } from './file-tree'
import type { BridgeClient, ToolContext } from './types'

const bridge: BridgeClient = { send: async () => null }

function makeCtx(repoRoot: string): ToolContext {
  return { bridge, repoRoot }
}

describe('list_files', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-listfiles-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('lists direct children of the repo root', async () => {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'README.md'), '#', 'utf8')
    const r = await listFilesTool.run({}, makeCtx(repoRoot))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { entries: Array<{ path: string; type: string }> }
    // Directories first, then files, sorted within each group.
    expect(out.entries.map((e) => e.path)).toEqual(['src', 'README.md'])
    expect(out.entries[0].type).toBe('dir')
    expect(out.entries[1].type).toBe('file')
  })

  it('lists a subdirectory at depth 1 by default', async () => {
    await mkdir(join(repoRoot, 'src/components'), { recursive: true })
    await writeFile(join(repoRoot, 'src/components/A.vue'), '<x/>', 'utf8')
    await writeFile(join(repoRoot, 'src/components/B.vue'), '<x/>', 'utf8')
    const r = await listFilesTool.run({ dir: 'src/components' }, makeCtx(repoRoot))
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { entries: Array<{ path: string }> }
    expect(out.entries.map((e) => e.path)).toEqual([
      'src/components/A.vue',
      'src/components/B.vue',
    ])
  })

  it('recurses when depth > 1', async () => {
    await mkdir(join(repoRoot, 'a/b'), { recursive: true })
    await writeFile(join(repoRoot, 'a/x.ts'), '', 'utf8')
    await writeFile(join(repoRoot, 'a/b/y.ts'), '', 'utf8')
    const r = await listFilesTool.run({ depth: 3 }, makeCtx(repoRoot))
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { entries: Array<{ path: string }> }
    const paths = out.entries.map((e) => e.path)
    expect(paths).toContain('a/x.ts')
    expect(paths).toContain('a/b/y.ts')
  })

  it('skips node_modules, .git, dist by default', async () => {
    await mkdir(join(repoRoot, 'node_modules/foo'), { recursive: true })
    await mkdir(join(repoRoot, '.git'), { recursive: true })
    await mkdir(join(repoRoot, 'dist'), { recursive: true })
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    const r = await listFilesTool.run({}, makeCtx(repoRoot))
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { entries: Array<{ path: string }> }
    const paths = out.entries.map((e) => e.path)
    expect(paths).not.toContain('node_modules')
    expect(paths).not.toContain('.git')
    expect(paths).not.toContain('dist')
    expect(paths).toContain('src')
  })

  it('rejects traversal paths', async () => {
    const r = await listFilesTool.run({ dir: '../etc' }, makeCtx(repoRoot))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/escapes repo root/)
  })

  it('returns clear error for non-existent dir', async () => {
    const r = await listFilesTool.run({ dir: 'no-such-dir' }, makeCtx(repoRoot))
    expect(r.ok).toBe(false)
  })

  it('skips symlinks inside the repo (no following)', async () => {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src/file.ts'), '', 'utf8')
    await symlink(join(repoRoot, 'src'), join(repoRoot, 'alias-dir'))
    const r = await listFilesTool.run({}, makeCtx(repoRoot))
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { entries: Array<{ path: string; type: string }> }
    // The symlink itself doesn't show as a directory (we filter on
    // isDirectory + isFile only).
    const aliasEntry = out.entries.find((e) => e.path === 'alias-dir')
    expect(aliasEntry).toBeUndefined()
  })
})

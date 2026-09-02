/**
 * Tests for `search_files` (Phase 4). Skipped on systems without
 * `rg` installed (the tool surfaces a clear "not installed" error in
 * that case; we verify that explicitly elsewhere).
 */

import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchFilesTool } from './search-files'
import type { BridgeClient, ToolContext } from './types'

function hasRipgrep(): boolean {
  try {
    execSync('rg --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const bridge: BridgeClient = { send: async () => null }
function makeCtx(repoRoot: string): ToolContext {
  return { bridge, repoRoot }
}

const itRg = hasRipgrep() ? it : it.skip

describe('search_files', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-search-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  itRg('finds literal matches across files', async () => {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src/a.ts'), 'export const VARIANT_PRIMARY = "primary"\n', 'utf8')
    await writeFile(join(repoRoot, 'src/b.ts'), 'import { VARIANT_PRIMARY } from "./a"\n', 'utf8')
    const r = await searchFilesTool.run(
      { pattern: 'VARIANT_PRIMARY' },
      makeCtx(repoRoot),
    )
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { hits: Array<{ file: string; line: number; text: string }> }
    expect(out.hits.length).toBeGreaterThanOrEqual(2)
    const files = out.hits.map((h) => h.file).sort()
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  itRg('honors a glob filter', async () => {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src/Demo.vue'), 'KButton\n', 'utf8')
    await writeFile(join(repoRoot, 'src/Demo.ts'), 'KButton\n', 'utf8')
    const r = await searchFilesTool.run(
      { pattern: 'KButton', glob: '*.vue' },
      makeCtx(repoRoot),
    )
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { hits: Array<{ file: string }> }
    expect(out.hits.map((h) => h.file)).toEqual(['src/Demo.vue'])
  })

  itRg('returns ok:true with empty hits when no matches found', async () => {
    await writeFile(join(repoRoot, 'a.ts'), 'nothing here\n', 'utf8')
    const r = await searchFilesTool.run(
      { pattern: 'NOTPRESENT' },
      makeCtx(repoRoot),
    )
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { hits: unknown[] }
    expect(out.hits).toEqual([])
  })

  itRg('treats fixed=true as literal (no regex)', async () => {
    await writeFile(join(repoRoot, 'a.ts'), '$1 special chars [.+?]\n', 'utf8')
    const r = await searchFilesTool.run(
      { pattern: '$1 special chars [.+?]', fixed: true },
      makeCtx(repoRoot),
    )
    if (!r.ok) throw new Error(r.error)
    const out = r.output as { hits: unknown[] }
    expect(out.hits.length).toBe(1)
  })

  it('rejects empty pattern', async () => {
    const r = await searchFilesTool.run({ pattern: '' }, makeCtx(repoRoot))
    expect(r.ok).toBe(false)
  })
})

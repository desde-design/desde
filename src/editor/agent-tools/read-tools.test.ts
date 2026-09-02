/**
 * Tests for the Phase 1 read tools. Covers:
 *   - get_selection / get_page_info round-trip through the bridge with
 *     correct messageType naming
 *   - read_file resolves repo-relative paths, rejects traversal,
 *     honors the byte cap, surfaces ENOENT / EISDIR distinctly
 *   - runTool() dispatches by name and returns a friendly error for
 *     unknown tools
 */

import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPageInfoTool,
  getSelectionTool,
  readFileTool,
  resolveRepoPath,
  runTool,
} from './read-tools'
import type { BridgeClient, ToolContext, ToolEntry } from './types'

function makeFakeBridge(handler: (type: string, payload: unknown) => unknown): BridgeClient {
  return {
    send: vi.fn(async (type, payload) => handler(type, payload)),
  }
}

function makeCtx(opts: { repoRoot?: string; bridge?: BridgeClient } = {}): ToolContext {
  return {
    bridge: opts.bridge ?? makeFakeBridge(() => null),
    repoRoot: opts.repoRoot ?? '/tmp',
  }
}

describe('get_selection tool', () => {
  it('round-trips through bridge with message type "chat:get_selection"', async () => {
    let captured: { type: string; payload: unknown } | null = null
    const bridge = makeFakeBridge((type, payload) => {
      captured = { type, payload }
      return { selector: '#btn', componentName: 'KButton' }
    })
    const ctx = makeCtx({ bridge })
    const result = await getSelectionTool.run({}, ctx)
    expect(captured).toEqual({ type: 'chat:get_selection', payload: undefined })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toEqual({ selector: '#btn', componentName: 'KButton' })
    }
  })

  it('returns ok:false with the bridge error when send() throws', async () => {
    const bridge: BridgeClient = {
      send: vi.fn(async () => {
        throw new Error('bridge offline')
      }),
    }
    const result = await getSelectionTool.run({}, makeCtx({ bridge }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/bridge offline/)
  })
})

describe('get_page_info tool', () => {
  it('round-trips through bridge with message type "chat:get_page_info"', async () => {
    let capturedType: string | null = null
    const bridge = makeFakeBridge((type) => {
      capturedType = type
      return { url: 'http://localhost:5173/', route: '/', framework: 'vue3' }
    })
    const result = await getPageInfoTool.run({}, makeCtx({ bridge }))
    expect(capturedType).toBe('chat:get_page_info')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toMatchObject({ route: '/', framework: 'vue3' })
    }
  })
})

describe('resolveRepoPath', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-readfile-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('resolves a simple repo-relative path', async () => {
    const r = await resolveRepoPath(repoRoot, 'src/foo.ts')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // realpath may have canonicalized /tmp/X; just assert the suffix.
      expect(r.absolute.endsWith('src/foo.ts')).toBe(true)
    }
  })

  it('rejects paths that traverse out of the repo (..)', async () => {
    const r = await resolveRepoPath(repoRoot, '../etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/escapes repo root/)
  })

  it('rejects deeply nested traversal', async () => {
    const r = await resolveRepoPath(repoRoot, 'a/b/c/../../../../etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/escapes repo root/)
  })

  it('rejects empty / non-string paths', async () => {
    const r1 = await resolveRepoPath(repoRoot, '')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toMatch(/non-empty string/)
    // @ts-expect-error — runtime check
    const r2 = await resolveRepoPath(repoRoot, undefined)
    expect(r2.ok).toBe(false)
  })

  it('reports a clear error when the repo root is missing', async () => {
    const r = await resolveRepoPath('/no-such-dir-exists-12345', 'foo.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not accessible/)
  })

  it('rejects symlinks that point outside the repo root', async () => {
    // Create a target file outside the repo and a symlink inside it.
    const outside = await mkdtemp(join(tmpdir(), 'desde-outside-'))
    try {
      const secret = join(outside, 'secret.txt')
      await writeFile(secret, 'super secret', 'utf8')
      const linkPath = join(repoRoot, 'secret-link.txt')
      await symlink(secret, linkPath)
      const r = await resolveRepoPath(repoRoot, 'secret-link.txt')
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toMatch(/escapes repo root|resolves outside repo root/i)
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects symlink escape even when read_file is invoked', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'desde-outside-'))
    try {
      const secret = join(outside, 'secret.txt')
      await writeFile(secret, 'super secret', 'utf8')
      await symlink(secret, join(repoRoot, 'leak'))
      const result = await readFileTool.run({ path: 'leak' }, makeCtx({ repoRoot }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/escapes repo root|outside repo root/i)
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('still resolves an in-repo file that goes through a symlink hop', async () => {
    // Two files inside the repo, one accessed via a symlink that
    // stays within the root. Should succeed.
    await mkdir(join(repoRoot, 'a'), { recursive: true })
    await writeFile(join(repoRoot, 'a/real.ts'), 'export const ok = true', 'utf8')
    await symlink(join(repoRoot, 'a/real.ts'), join(repoRoot, 'alias.ts'))
    const r = await resolveRepoPath(repoRoot, 'alias.ts')
    expect(r.ok).toBe(true)
  })
})

describe('read_file tool', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-readfile-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('reads a file under the repo root', async () => {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'src/foo.ts'), 'hello\nworld', 'utf8')
    const result = await readFileTool.run({ path: 'src/foo.ts' }, makeCtx({ repoRoot }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as { content: string; truncated: boolean; totalBytes: number }
      expect(out.content).toBe('hello\nworld')
      expect(out.truncated).toBe(false)
      expect(out.totalBytes).toBe(11)
    }
  })

  it('truncates files larger than the byte cap and signals truncated=true', async () => {
    const big = 'x'.repeat(300 * 1024)
    await writeFile(join(repoRoot, 'big.txt'), big, 'utf8')
    const result = await readFileTool.run({ path: 'big.txt' }, makeCtx({ repoRoot }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as { content: string; truncated: boolean; totalBytes: number }
      expect(out.truncated).toBe(true)
      expect(out.totalBytes).toBe(big.length)
      // 200 KB cap
      expect(out.content.length).toBe(200 * 1024)
    }
  })

  it("returns ok:false with 'file not found' for ENOENT", async () => {
    const result = await readFileTool.run({ path: 'missing.ts' }, makeCtx({ repoRoot }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/file not found/)
  })

  it("returns ok:false with 'not a file' for EISDIR", async () => {
    await mkdir(join(repoRoot, 'subdir'), { recursive: true })
    const result = await readFileTool.run({ path: 'subdir' }, makeCtx({ repoRoot }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a file/)
  })

  it('rejects traversal paths without touching the filesystem', async () => {
    const result = await readFileTool.run(
      { path: '../etc/passwd' },
      makeCtx({ repoRoot }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/escapes repo root/)
  })
})

describe('runTool dispatch', () => {
  const registry: ReadonlyArray<ToolEntry> = [
    getSelectionTool,
    getPageInfoTool,
    readFileTool,
  ] as ToolEntry[]

  it('dispatches a known tool by name', async () => {
    let captured: string | null = null
    const bridge = makeFakeBridge((type) => {
      captured = type
      return { ok: true }
    })
    const result = await runTool(registry, 'get_selection', {}, makeCtx({ bridge }))
    expect(result.ok).toBe(true)
    expect(captured).toBe('chat:get_selection')
  })

  it("returns 'unknown tool' for unregistered names", async () => {
    const result = await runTool(registry, 'definitely_not_a_tool', {}, makeCtx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/unknown tool/)
  })
})

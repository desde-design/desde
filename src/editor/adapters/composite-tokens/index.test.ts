import { describe, expect, it, vi } from 'vitest'
import { CompositeDesignTokenSource } from './index'
import type { DesignToken, DesignTokenSource } from '../../core/design-tokens'

function tok(name: string, value = '#000', source = 'src'): DesignToken {
  return { name, value, category: 'color', source }
}

function fakeSource(
  id: string,
  tokens: DesignToken[],
  designSystem: DesignTokenSource['designSystem'] = 'acme-ds',
): DesignTokenSource {
  return {
    id,
    designSystem,
    listTokens: async () => tokens,
    getToken: async (name) => tokens.find((t) => t.name === name) ?? null,
  }
}

describe('CompositeDesignTokenSource', () => {
  it('returns [] for no sources', async () => {
    const c = new CompositeDesignTokenSource({ sources: [] })
    expect(await c.listTokens()).toEqual([])
    expect(await c.getToken('--x')).toBeNull()
  })

  it('merges tokens across sources, first-source-wins on duplicate names', async () => {
    const a = fakeSource('a', [tok('--shared', '#aaa', 'a'), tok('--only-a', '#1', 'a')])
    const b = fakeSource('b', [tok('--shared', '#bbb', 'b'), tok('--only-b', '#2', 'b')])
    const c = new CompositeDesignTokenSource({ sources: [a, b] })

    const tokens = await c.listTokens()
    const names = tokens.map((t) => t.name).sort()
    expect(names).toEqual(['--only-a', '--only-b', '--shared'])
    // First source (a) wins the duplicate.
    expect(tokens.find((t) => t.name === '--shared')?.value).toBe('#aaa')
  })

  it('getToken returns the first non-null match in priority order', async () => {
    const a = fakeSource('a', [tok('--shared', '#aaa', 'a')])
    const b = fakeSource('b', [tok('--shared', '#bbb', 'b'), tok('--only-b', '#2', 'b')])
    const c = new CompositeDesignTokenSource({ sources: [a, b] })

    expect((await c.getToken('--shared'))?.source).toBe('a')
    expect((await c.getToken('--only-b'))?.value).toBe('#2')
    expect(await c.getToken('--missing')).toBeNull()
  })

  it('skips a throwing source and keeps the rest (error-tolerant)', async () => {
    const onSourceError = vi.fn()
    const bad: DesignTokenSource = {
      id: 'bad',
      designSystem: 'acme-ds',
      listTokens: async () => {
        throw new Error('boom')
      },
      getToken: async () => {
        throw new Error('boom')
      },
    }
    const good = fakeSource('good', [tok('--ok', '#0f0', 'good')])
    const c = new CompositeDesignTokenSource({ sources: [bad, good], onSourceError })

    expect(await c.listTokens()).toEqual([tok('--ok', '#0f0', 'good')])
    expect((await c.getToken('--ok'))?.source).toBe('good')
    expect(onSourceError).toHaveBeenCalledWith('bad', 'listTokens', expect.any(Error))
    expect(onSourceError).toHaveBeenCalledWith('bad', 'getToken', expect.any(Error))
  })

  it('propagates source errors when onSourceError rethrows (fail-loud opt-in)', async () => {
    const bad: DesignTokenSource = {
      id: 'bad',
      designSystem: 'acme-ds',
      listTokens: async () => {
        throw new Error('boom')
      },
      getToken: async () => {
        throw new Error('boom')
      },
    }
    const c = new CompositeDesignTokenSource({
      sources: [bad],
      onSourceError: (_id, _m, error) => {
        throw error
      },
    })
    await expect(c.listTokens()).rejects.toThrow('boom')
    await expect(c.getToken('--x')).rejects.toThrow('boom')
  })

  it('defaults designSystem to the first source', async () => {
    const c = new CompositeDesignTokenSource({
      sources: [fakeSource('a', [], 'acme-ds')],
    })
    expect(c.designSystem).toBe('acme-ds')
  })
})

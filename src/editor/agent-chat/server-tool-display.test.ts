import { describe, expect, it } from 'vitest'
import { describeServerToolOutput } from './server-tool-display'

describe('describeServerToolOutput', () => {
  it('lists search hits by title and URL, never the encrypted payload', () => {
    const text = describeServerToolOutput([
      { type: 'web_search_result', url: 'https://a.test/', title: 'A', encryptedContent: 'SECRETBLOB' },
      { type: 'web_search_result', url: 'https://b.test/', title: null, encryptedContent: 'X' },
    ])
    expect(text).toBe('A (https://a.test/)\nhttps://b.test/')
    expect(text).not.toContain('SECRETBLOB')
  })

  it('caps a long hit list and counts the rest', () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ url: `https://h${i}.test/` }))
    const text = describeServerToolOutput(hits)
    expect(text.split('\n')).toHaveLength(11)
    expect(text).toMatch(/and 2 more$/)
  })

  it('says so when a search found nothing', () => {
    expect(describeServerToolOutput([])).toBe('No results.')
  })

  it('names a fetched page by URL and title, not by its whole body', () => {
    const text = describeServerToolOutput({
      type: 'web_fetch_result',
      url: 'https://example.com/',
      content: { type: 'document', title: 'Example Domain', source: { data: 'BODY'.repeat(1000) } },
    })
    expect(text).toBe('Fetched https://example.com/: Example Domain')
  })

  it('reports a vendor error code in plain words', () => {
    expect(describeServerToolOutput({ type: 'web_fetch_tool_result_error', errorCode: 'url_not_accessible' })).toBe(
      'The provider could not complete this: url_not_accessible.',
    )
  })

  it('falls back to capped JSON for a shape it does not know', () => {
    const text = describeServerToolOutput({ stdout: 'x'.repeat(5000) })
    expect(text.length).toBeLessThanOrEqual(2001)
    expect(text.startsWith('{"stdout":')).toBe(true)
  })
})

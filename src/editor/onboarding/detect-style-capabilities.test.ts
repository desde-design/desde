/**
 * Tests for the neutral substrate-style-capability composition. The load-bearing
 * property is FAIL-SAFE: any detector failure degrades to "no capabilities",
 * i.e. exactly the behavior that existed before detection.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const detectTailwindImportantMode = vi.hoisted(() => vi.fn())
vi.mock('../adapters/tailwind', () => ({ detectTailwindImportantMode }))

import { detectSubstrateStyleCapabilities } from './detect-style-capabilities'

describe('detectSubstrateStyleCapabilities', () => {
  beforeEach(() => {
    detectTailwindImportantMode.mockReset()
  })

  it('reports importantUtilities: true with a note when the Tailwind probe matches', async () => {
    detectTailwindImportantMode.mockResolvedValue({
      detected: true,
      evidence: { signal: 'v4-import-important', file: '/p/src/app.css' },
    })
    const result = await detectSubstrateStyleCapabilities('/p')
    expect(result.capabilities.importantUtilities).toBe(true)
    expect(result.note).toContain('v4-import-important')
  })

  it('reports importantUtilities: false when nothing matched', async () => {
    detectTailwindImportantMode.mockResolvedValue({ detected: false })
    const result = await detectSubstrateStyleCapabilities('/p')
    expect(result.capabilities.importantUtilities).toBe(false)
    expect(result.note).toBeUndefined()
  })

  it('degrades to no-capabilities when a detector THROWS (fail safe)', async () => {
    detectTailwindImportantMode.mockRejectedValue(new Error('boom'))
    const result = await detectSubstrateStyleCapabilities('/p')
    expect(result.capabilities.importantUtilities).toBe(false)
    expect(result.note).toBeUndefined()
  })

  it('degrades to no-capabilities when a detector throws SYNCHRONOUSLY', async () => {
    detectTailwindImportantMode.mockImplementation(() => {
      throw new Error('sync boom')
    })
    const result = await detectSubstrateStyleCapabilities('/p')
    expect(result.capabilities.importantUtilities).toBe(false)
  })

  it('still carries a note when the probe matched without evidence', async () => {
    detectTailwindImportantMode.mockResolvedValue({ detected: true })
    const result = await detectSubstrateStyleCapabilities('/p')
    expect(result.capabilities.importantUtilities).toBe(true)
    expect(result.note).toBe('important utilities detected')
  })
})

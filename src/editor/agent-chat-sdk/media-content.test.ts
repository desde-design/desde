import { describe, expect, it } from 'vitest'
import {
  base64ByteLength,
  DEFAULT_MAX_IMAGE_BYTES,
  imageFromDataUrl,
} from './media-content'

// A 1x1 transparent PNG.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

describe('base64ByteLength', () => {
  it('approximates decoded byte length, accounting for padding', () => {
    expect(base64ByteLength('')).toBe(0)
    expect(base64ByteLength('QQ==')).toBe(1) // "A"
    expect(base64ByteLength('QUI=')).toBe(2) // "AB"
    expect(base64ByteLength('QUJD')).toBe(3) // "ABC"
  })
})

describe('imageFromDataUrl', () => {
  it('parses a valid PNG data URL into an MCP image block', () => {
    const r = imageFromDataUrl(PNG_1x1)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.image.type).toBe('image')
      expect(r.image.mimeType).toBe('image/png')
      expect(r.image.data).not.toContain('data:') // base64 only, no prefix
      expect(r.image.data.length).toBeGreaterThan(0)
      expect(r.bytes).toBeGreaterThan(0)
    }
  })

  it('rejects a non-data-URL string', () => {
    const r = imageFromDataUrl('https://example.com/x.png')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/data URL/i)
  })

  it('rejects an unsupported image type', () => {
    const r = imageFromDataUrl('data:image/tiff;base64,QUJD')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Unsupported image type/i)
  })

  it('normalizes mime-type casing', () => {
    const r = imageFromDataUrl('data:IMAGE/PNG;base64,QUJD')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.image.mimeType).toBe('image/png')
  })

  it('rejects empty image data', () => {
    const r = imageFromDataUrl('data:image/png;base64,')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Empty/i)
  })

  it('accepts a data URL with media-type parameters before ;base64,', () => {
    const r = imageFromDataUrl('data:image/png;charset=utf-8;base64,QUJD')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.image.mimeType).toBe('image/png')
  })

  it('uses the final ;base64, marker, skipping one in a quoted header param', () => {
    const r = imageFromDataUrl('data:image/png;name="x;base64,";base64,QUJD')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.image.mimeType).toBe('image/png')
      expect(r.image.data).toBe('QUJD')
    }
  })

  it('rejects a missing ;base64, marker', () => {
    const r = imageFromDataUrl('data:image/png,QUJD')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/base64/i)
  })

  it('rejects an invalid base64 payload', () => {
    const r = imageFromDataUrl('data:image/png;base64,%%%%')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not valid base64/i)
  })

  it('strips whitespace/newlines wrapping the base64 payload', () => {
    // Some producers chunk base64 across lines; whitespace is not part of the data.
    const r = imageFromDataUrl('data:image/png;base64,QU\n JD\t')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.image.data).toBe('QUJD')
      expect(r.image.data).not.toMatch(/\s/)
    }
  })

  it('rejects an over-cap image with a scope-down hint', () => {
    // 7MB of base64 → ~5.25MB decoded, over the default 4.5MB cap.
    const huge = 'A'.repeat(7_000_000)
    const r = imageFromDataUrl(`data:image/png;base64,${huge}`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/too large/i)
      expect(r.reason).toMatch(/scope:'element'|scope:'selector'/)
    }
  })

  it('honors a custom maxBytes', () => {
    const r = imageFromDataUrl(PNG_1x1, { maxBytes: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too large/i)
  })

  it('default cap is under the ~5MB vision limit', () => {
    expect(DEFAULT_MAX_IMAGE_BYTES).toBeLessThan(5_000_000)
  })
})

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { sanitizeSvg } from './sanitize-svg'

describe('sanitizeSvg', () => {
  it('returns empty string for empty input', () => {
    expect(sanitizeSvg('')).toBe('')
    expect(sanitizeSvg(null as unknown as string)).toBe('')
  })

  it('passes through a clean SVG unchanged structurally', () => {
    const input = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor"></path></svg>'
    const out = sanitizeSvg(input)
    expect(out).toContain('<svg')
    expect(out).toContain('<path')
    expect(out).toContain('d="M0 0h24v24H0z"')
    expect(out).toContain('fill="currentColor"')
  })

  it('strips <script> elements entirely', () => {
    const input =
      '<svg><script>alert(1)</script><path d="M0 0"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
    expect(out).toContain('<path')
  })

  it('strips on* event handler attributes', () => {
    const input =
      '<svg onload="alert(1)"><path onclick="x()" onmouseover="y()" d="M0 0"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).not.toContain('onload')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
    expect(out).not.toContain('alert')
  })

  it('strips javascript: URLs in href and xlink:href', () => {
    const input =
      '<svg><use href="javascript:alert(1)"/><use xlink:href="javascript:y()"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).not.toContain('javascript:')
    // The <use> elements remain but without their hrefs.
    expect(out).toContain('<use')
  })

  it('keeps fragment refs in href', () => {
    const input = '<svg><use href="#sprite-trash"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).toContain('href="#sprite-trash"')
  })

  it('strips elements not in the allowlist', () => {
    // foreignObject can embed arbitrary HTML — must be removed.
    const input =
      '<svg><foreignObject><iframe src="evil.com"></iframe></foreignObject><path d="M0 0"/></svg>'
    const out = sanitizeSvg(input)
    expect(out.toLowerCase()).not.toContain('foreignobject')
    expect(out).not.toContain('<iframe')
    expect(out).toContain('<path')
  })

  it('strips unknown attributes', () => {
    const input = '<svg data-desde-test="ok" cool-vibe="no"><path d="M"/></svg>'
    const out = sanitizeSvg(input)
    // data-* is allowed (testing-friendly)
    expect(out).toContain('data-desde-test="ok"')
    expect(out).not.toContain('cool-vibe')
  })

  // Audit K13: a verbatim `style` attribute lets an icon package paint a
  // full-viewport overlay over the Editor shell's own chrome — a
  // clickjacking surface over the buttons that write the user's source.
  it('strips the style attribute so an icon cannot lay itself over the shell', () => {
    const input =
      '<svg style="position:fixed;inset:0;width:100vw;height:100vh;z-index:99999">' +
      '<path style="pointer-events:all" d="M0 0"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).not.toContain('style')
    expect(out).not.toContain('position:fixed')
    expect(out).not.toContain('z-index')
    // The icon itself survives — only the layout control is gone.
    expect(out).toContain('<path')
    expect(out).toContain('d="M0 0"')
  })

  it('still allows the paint attributes real icons use', () => {
    const input =
      '<svg viewBox="0 0 24 24" width="16" height="16">' +
      '<defs><linearGradient id="g"><stop stop-color="#000"/></linearGradient></defs>' +
      '<path d="M0 0" fill="url(#g)" stroke="currentColor" stroke-width="2"/></svg>'
    const out = sanitizeSvg(input)
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('fill="url(#g)"')
    expect(out).toContain('stroke="currentColor"')
    expect(out).toContain('stroke-width="2"')
    // `id` is kept precisely so `url(#g)` still resolves.
    expect(out).toContain('id="g"')
  })

  it('keeps a vendor icon wrapper intact', () => {
    // Sample shape from real the package icons output (minus the kui-icon span,
    // which we strip via the SVG-only extraction in render-vue.mjs).
    const input =
      '<svg data-testid="kui-icon-svg-data-object-icon" fill="none" height="100%" role="img" viewBox="0 0 24 24" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="M14 20V18H17C17.2833 18 17.5208 17.9042 17.7125 17.7125C17.9042 17.5208 18 17.2833 18 17V13.5C18 12.8 18.2417 12.1875 18.725 11.6625C19.2083 11.1375 19.8083 10.8167 20.525 10.7V10.5C19.8083 10.3833 19.2083 10.0625 18.725 9.5375C18.2417 9.0125 18 8.4 18 7.7V4C18 3.71667 17.9042 3.47917 17.7125 3.2875C17.5208 3.09583 17.2833 3 17 3H14V1H17C17.85 1 18.5625 1.2875 19.1375 1.8625C19.7125 2.4375 20 3.15 20 4V7.7C20 7.98333 20.0958 8.22083 20.2875 8.4125C20.4792 8.60417 20.7167 8.7 21 8.7H22V12.7H21C20.7167 12.7 20.4792 12.7958 20.2875 12.9875C20.0958 13.1792 20 13.4167 20 13.7V17C20 17.85 19.7125 18.5625 19.1375 19.1375C18.5625 19.7125 17.85 20 17 20H14ZM7 20C6.15 20 5.4375 19.7125 4.8625 19.1375C4.2875 18.5625 4 17.85 4 17V13.7C4 13.4167 3.90417 13.1792 3.7125 12.9875C3.52083 12.7958 3.28333 12.7 3 12.7H2V8.7H3C3.28333 8.7 3.52083 8.60417 3.7125 8.4125C3.90417 8.22083 4 7.98333 4 7.7V4C4 3.15 4.2875 2.4375 4.8625 1.8625C5.4375 1.2875 6.15 1 7 1H10V3H7C6.71667 3 6.47917 3.09583 6.2875 3.2875C6.09583 3.47917 6 3.71667 6 4V7.7C6 8.4 5.75833 9.0125 5.275 9.5375C4.79167 10.0625 4.19167 10.3833 3.475 10.5V10.7C4.19167 10.8167 4.79167 11.1375 5.275 11.6625C5.75833 12.1875 6 12.8 6 13.5V17C6 17.2833 6.09583 17.5208 6.2875 17.7125C6.47917 17.9042 6.71667 18 7 18H10V20H7Z" fill="currentColor"></path></svg>'
    const out = sanitizeSvg(input)
    expect(out).toContain('viewBox')
    expect(out).toContain('<path')
    expect(out).toContain('fill="currentColor"')
    expect(out).toContain('d="M14 20')
    // Sanitizer must not strip the entire SVG.
    expect(out.length).toBeGreaterThan(500)
  })
})

import { describe, expect, it } from "vitest"
import { injectBaseHref, injectBridge, readBridgeBundle, rewriteRootRelativeUrls } from "../html-inject"

const BRIDGE_SRC = "/p/acme/__desde/bridge-test-version.js"

describe("injectBaseHref", () => {
  it("inserts a base tag as the first head child", () => {
    const html = "<html><head><title>x</title></head><body></body></html>"
    expect(injectBaseHref(html, "/p/acme/")).toBe(
      '<html><head><base href="/p/acme/"><title>x</title></head><body></body></html>',
    )
  })

  it("leaves an existing base tag alone", () => {
    const html = '<html><head><base href="/other/"></head><body></body></html>'
    expect(injectBaseHref(html, "/p/acme/")).toBe(html)
  })

  it("returns html unchanged when there is no head", () => {
    expect(injectBaseHref("<div>bare</div>", "/p/acme/")).toBe("<div>bare</div>")
  })
})

describe("injectBridge", () => {
  it("injects the shell origin config and an external bridge <script src> before </body>", () => {
    const html = "<html><head></head><body><h1>hi</h1></body></html>"
    const result = injectBridge(html, "https://viewer.example.com", BRIDGE_SRC)

    expect(result).toContain(
      'window.__DESDE_SHELL_ORIGIN__="https://viewer.example.com"',
    )
    // The bridge is referenced by src, never inlined as script content —
    // the built bundle contains `<!--`, which corrupts an inline <script>'s
    // parsing (see the doc comment on injectBridge).
    expect(result).toContain(
      '<script data-prototype-flow="bridge" data-shell-origin="https://viewer.example.com" ' +
        `src="${BRIDGE_SRC}"></script>`,
    )
    expect(result.indexOf("<h1>hi</h1>")).toBeLessThan(result.indexOf(BRIDGE_SRC))
    expect(result.indexOf(BRIDGE_SRC)).toBeLessThan(result.indexOf("</body>"))
  })

  it("carries the shell origin on an ATTRIBUTE, not only the inline script", () => {
    // The inline tag is a legacy fallback: a prototype serving
    // `script-src 'self'` without `'unsafe-inline'` drops it while the
    // external bundle loads normally. Since the bridge fails CLOSED on an
    // unresolvable origin, an attribute-less tag would leave the bridge
    // silent on exactly those prototypes. An attribute is markup, so no CSP
    // strips it.
    const result = injectBridge("<html><body></body></html>", "https://viewer.example.com", BRIDGE_SRC)
    const bridgeTag = result.slice(result.indexOf('data-prototype-flow="bridge"'))
    expect(bridgeTag).toContain('data-shell-origin="https://viewer.example.com"')
  })

  it("escapes the origin for ATTRIBUTE context, not JS-string context", () => {
    // `\"` is right inside a script body and wrong inside an attribute,
    // where it would terminate the value and let the rest be parsed as
    // further attributes.
    const result = injectBridge('<html><body></body></html>', 'https://a.example"><b x="', BRIDGE_SRC)
    const bridgeTag = result.slice(result.indexOf('data-prototype-flow="bridge"'))
    expect(bridgeTag).not.toContain('"><b x="')
    expect(bridgeTag).toContain("&quot;")
  })

  it("falls back to </head> when there is no body close tag", () => {
    const result = injectBridge("<html><head></head>", "https://v.example", BRIDGE_SRC)
    expect(result).toContain(BRIDGE_SRC)
    expect(result.indexOf(BRIDGE_SRC)).toBeLessThan(result.indexOf("</head>"))
  })

  it("appends when the document has neither", () => {
    const result = injectBridge("<div>bare</div>", "https://v.example", BRIDGE_SRC)
    expect(result.startsWith("<div>bare</div>")).toBe(true)
    expect(result).toContain(BRIDGE_SRC)
  })

  it("escapes a shell origin containing a quote", () => {
    const result = injectBridge("<body></body>", 'https://x"evil', BRIDGE_SRC)
    expect(result).not.toContain('"https://x"evil"')
    expect(result).toContain('https://x\\"evil')
  })

  it("prevents </script> injection in shell origin", () => {
    const result = injectBridge("<body></body>", 'https://evil</script><script>alert(1)</script>', BRIDGE_SRC)
    // Should not contain the literal </script><script> sequence from the attacker
    expect(result).not.toContain('</script><script>')
    // Should contain the escaped form
    expect(result).toContain('\\u003cscript>')
  })

  it("escapes a bridge src containing a quote to prevent attribute breakout", () => {
    const evilSrc = '/p/x/__desde/bridge-1.js"><script>alert(1)</script>'
    const result = injectBridge("<body></body>", "https://v.example", evilSrc)
    expect(result).not.toContain('src="' + evilSrc + '"')
    // The closing quote is entity-escaped so the browser can't treat it as
    // the end of the attribute value, and `<` is entity-escaped so no new
    // tag can start from inside the value either.
    expect(result).not.toContain('"><script>alert(1)</script>')
    expect(result).toContain("&quot;>&lt;script>")
  })

  it("does not inline the bundle body — never contains an inline bridge script", () => {
    const result = injectBridge("<body></body>", "https://v.example", BRIDGE_SRC)
    // Only the src reference appears; there's no second <script data-prototype-flow="bridge">
    // block carrying a body.
    const bridgeTagCount = (result.match(/data-prototype-flow="bridge"/g) ?? []).length
    expect(bridgeTagCount).toBe(1)
    expect(result).toContain(`src="${BRIDGE_SRC}"></script>`)
  })
})

describe("readBridgeBundle", () => {
  it("loads the built bridge bundle and its version", () => {
    const { script, version } = readBridgeBundle()
    expect(script.length).toBeGreaterThan(1000)
    expect(version).toMatch(/^\d{4}-\d{2}-\d{2}/)
  })
})

describe("rewriteRootRelativeUrls", () => {
  const base = "/p/acme/"

  it("rewrites root-relative src and href attributes", () => {
    const html = `<script src="/assets/index-abc.js"></script><link rel="stylesheet" href="/assets/index.css"><img src="/logo.png">`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`src="/p/acme/assets/index-abc.js"`)
    expect(out).toContain(`href="/p/acme/assets/index.css"`)
    expect(out).toContain(`src="/p/acme/logo.png"`)
  })

  it("leaves protocol-relative, absolute, fragment, data and relative URLs alone", () => {
    const html = [
      `<script src="//cdn.example.com/x.js"></script>`,
      `<a href="https://example.com/x">x</a>`,
      `<a href="#section">x</a>`,
      `<img src="data:image/png;base64,AAAA">`,
      `<img src="./rel.png">`,
      `<img src="rel2.png">`,
    ].join("")
    expect(rewriteRootRelativeUrls(html, base)).toBe(html)
  })

  it("rewrites each root-relative candidate in srcset", () => {
    const html = `<img srcset="/a-1x.png 1x, /a-2x.png 2x, https://cdn/b.png 3x">`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`/p/acme/a-1x.png 1x`)
    expect(out).toContain(`/p/acme/a-2x.png 2x`)
    expect(out).toContain(`https://cdn/b.png 3x`)
  })

  it("handles single-quoted attributes", () => {
    const out = rewriteRootRelativeUrls(`<script src='/assets/x.js'></script>`, base)
    expect(out).toContain(`src='/p/acme/assets/x.js'`)
  })

  it("does not rewrite root-relative URLs inside script body", () => {
    const html = `<script>var src="/init.js"; console.log(src);</script>`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`var src="/init.js"`)
    expect(out).not.toContain(`src="/p/acme/init.js"`)
  })

  it("does not rewrite root-relative URLs in inline script strings", () => {
    const html = `<script>document.write("<img src=\\"/logo.png\\">")</script>`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`src=\\"/logo.png\\"`)
    expect(out).not.toContain(`/p/acme/logo.png`)
  })

  it("rewrites src attribute in script opening tag but not the body", () => {
    const html = `<script src="/assets/entry.js">var x="/data.json";</script>`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`src="/p/acme/assets/entry.js"`)
    expect(out).toContain(`var x="/data.json"`)
  })

  it("does not rewrite root-relative URLs inside style body", () => {
    const html = `<style>.x{background:url(/a.png)}</style>`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toContain(`.x{background:url(/a.png)}`)
    expect(out).not.toContain(`url(/p/acme/a.png)`)
  })

  it("does not rewrite root-relative URLs inside HTML comments", () => {
    const html = `<!-- <img src="/c.png"> -->`
    const out = rewriteRootRelativeUrls(html, base)
    expect(out).toBe(html)
  })
})

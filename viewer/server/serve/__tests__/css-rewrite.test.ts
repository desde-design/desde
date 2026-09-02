import { describe, expect, it } from "vitest"
import { rewriteCssRootRelativeUrls } from "../css-rewrite"

describe("rewriteCssRootRelativeUrls", () => {
  const prefix = "/p/acme/~c/tok123/"

  it("rewrites an unquoted root-absolute url()", () => {
    const css = "@font-face { src: url(/fonts/x.woff2); }"
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`@font-face { src: url(${prefix}fonts/x.woff2); }`)
  })

  it("rewrites a single-quoted root-absolute url()", () => {
    const css = "background: url('/img/bg.png');"
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url('${prefix}img/bg.png');`)
  })

  it("rewrites a double-quoted root-absolute url()", () => {
    const css = 'background: url("/img/bg.png");'
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url("${prefix}img/bg.png");`)
  })

  it("tolerates whitespace inside the parens (unquoted)", () => {
    const css = "background: url(  /img/bg.png  );"
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url(${prefix}img/bg.png);`)
  })

  it("tolerates whitespace inside the parens (quoted)", () => {
    const css = 'background: url(  "/img/bg.png"  );'
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url("${prefix}img/bg.png");`)
  })

  it("joins the prefix and the target without a doubled slash", () => {
    // pathPrefix already ends in "/", so "/x" becomes prefix + "x", not prefix + "/x".
    const out = rewriteCssRootRelativeUrls("url(/x)", "/p/acme/")
    expect(out).toBe("url(/p/acme/x)")
  })

  it("adds a trailing slash to pathPrefix if the caller forgot one", () => {
    const out = rewriteCssRootRelativeUrls("url(/x)", "/p/acme")
    expect(out).toBe("url(/p/acme/x)")
  })

  it("does not rewrite a protocol-relative url()", () => {
    const css = "background: url(//cdn.example.com/x.png);"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite a protocol-relative quoted url()", () => {
    const css = "background: url('//cdn.example.com/x.png');"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite an absolute https url()", () => {
    const css = "background: url(https://cdn.example.com/x.png);"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite a data: url()", () => {
    const css = "background: url(data:image/png;base64,AAAA);"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite a fragment-only url()", () => {
    const css = "fill: url(#gradient);"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite a relative url()", () => {
    const css = "url(x.png) url(./x.png) url(../x.png)"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("rewrites multiple url() references across a whole file, leaving the rest untouched", () => {
    const css = [
      "@font-face { font-family: 'Custom'; src: url(/fonts/a.woff2) format('woff2'); }",
      ".logo { background: url('/img/logo.png') no-repeat; }",
      ".icon { background: url(https://cdn.example.com/icon.png); }",
      ".rel { background: url(./local.png); }",
    ].join("\n")
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toContain(`url(${prefix}fonts/a.woff2)`)
    expect(out).toContain(`url('${prefix}img/logo.png')`)
    expect(out).toContain(`url(https://cdn.example.com/icon.png)`)
    expect(out).toContain(`url(./local.png)`)
  })

  it("is case-insensitive on the url() function name", () => {
    const css = "background: URL(/img/bg.png);"
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: URL(${prefix}img/bg.png);`)
  })

  // KNOWN LIMIT (documented on the function itself): a CSS custom property
  // that assembles a url() from parts only exists as a literal path at
  // computed-style time, not in the source text. A text-based rewrite
  // cannot see through `var(...)` indirection, so this case is left alone.
  it("does NOT rewrite a url() built from a CSS custom property (documented limit)", () => {
    const css = ":root { --u: /x; } .bg { background: url(var(--u)); }"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  // Regression: the first version's quoted branch used `[^"']*`, which
  // excludes BOTH quote characters instead of just the delimiting one. A
  // double-quoted target with an embedded single quote (or vice versa) is
  // ordinary, legal CSS and must still match — stopping only at its OWN
  // delimiter, with the embedded opposite quote preserved as content.
  it("rewrites a double-quoted target containing an embedded single quote", () => {
    const css = `background: url("/a'b.woff2");`
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url("${prefix}a'b.woff2");`)
  })

  it("rewrites a single-quoted target containing an embedded double quote", () => {
    const css = `background: url('/a"b.woff2');`
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toBe(`background: url('${prefix}a"b.woff2');`)
  })

  it("does not rewrite a double-quoted target that is itself non-root (data:)", () => {
    const css = 'background: url("data:image/png;base64,AAAA");'
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does not rewrite a double-quoted target that is itself non-root (relative)", () => {
    const css = 'background: url("x");'
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  // Malformed input must no-op, never throw — the caller sends whatever
  // bytes a build tool produced, and a stray unclosed url( must not crash
  // the whole response.
  it("leaves an unclosed url( untouched and does not throw", () => {
    const css = "background: url(/broken.png"
    expect(() => rewriteCssRootRelativeUrls(css, prefix)).not.toThrow()
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("leaves an empty url() untouched and does not throw", () => {
    const css = "background: url();"
    expect(() => rewriteCssRootRelativeUrls(css, prefix)).not.toThrow()
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  // Regression (codex capstone review): a `content: "url(/x)"` string value
  // is DISPLAYED text (rendered via ::before/::after), not a network fetch.
  // An earlier version of this function treated it the same as a comment —
  // "never fetched, so rewriting it is harmless either way" — and that
  // reasoning was wrong specifically for `content` strings: it silently
  // changed the rendered text on the page. This function must never rewrite
  // the inside of a standalone CSS string literal, regardless of whether
  // the string happens to look like a url().
  it("does NOT rewrite a url()-shaped double-quoted content string", () => {
    const css = '.x::before { content: "url(/logo.svg)"; }'
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("does NOT rewrite a url()-shaped single-quoted content string", () => {
    const css = ".x::before { content: 'url(/logo.svg)'; }"
    expect(rewriteCssRootRelativeUrls(css, prefix)).toBe(css)
  })

  it("still rewrites a REAL quoted url() in the same rule set as a content string", () => {
    const css = '.x::before { content: "url(/logo.svg)"; } .y { background: url("/logo.svg"); }'
    const out = rewriteCssRootRelativeUrls(css, prefix)
    // The content string is untouched...
    expect(out).toContain('content: "url(/logo.svg)"')
    // ...but the real url() token right after it is rewritten.
    expect(out).toContain(`background: url("${prefix}logo.svg")`)
  })

  it("still rewrites a REAL unquoted url() elsewhere in a stylesheet that also has a content string", () => {
    const css = '.x::before { content: "url(/logo.svg)"; } .y { background: url(/bg.png); }'
    const out = rewriteCssRootRelativeUrls(css, prefix)
    expect(out).toContain('content: "url(/logo.svg)"')
    expect(out).toContain(`background: url(${prefix}bg.png)`)
  })

  it("rewrites only the real url(), not the content string, when both appear in one stylesheet", () => {
    const css = [
      '.x::before { content: "url(/logo.svg)"; }',
      "@font-face { src: url(/fonts/a.woff2); }",
      ".y::after { content: 'url(/other.png)'; }",
      ".z { background: url('/bg.png'); }",
    ].join("\n")
    const out = rewriteCssRootRelativeUrls(css, prefix)
    // Both content strings survive byte-identical.
    expect(out).toContain('content: "url(/logo.svg)"')
    expect(out).toContain("content: 'url(/other.png)'")
    // Both real url() tokens are rewritten.
    expect(out).toContain(`url(${prefix}fonts/a.woff2)`)
    expect(out).toContain(`url('${prefix}bg.png')`)
  })
})

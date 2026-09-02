/**
 * Pure scanner tests, from fixtures — no filesystem, no directory tree.
 *
 * The patterns under test come from the bundler-research scan design (see
 * the task's "Part 3 — Bundler-agnostic detection design"): HTML subresource
 * attributes, CSS `url(...)`, and two narrow, anchored JS runtime-base
 * signatures (Vite's preload helper, webpack's `publicPath` assignment).
 * Each pattern is deliberately narrow — a wrong warning erodes trust in
 * every warning after it — so the negative cases here are as load-bearing
 * as the positive ones.
 */
import { describe, expect, it } from "vitest"
import { scanBundleForRootAbsoluteAssets, type ScannableFile } from "../root-absolute-scan"

function file(path: string, text: string): ScannableFile {
  return { path, readText: async () => text, size: Buffer.byteLength(text, "utf-8") }
}

describe("scanBundleForRootAbsoluteAssets", () => {
  it("flags a Vite-default index.html's root-absolute <script>/<link> tags", async () => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head>",
      '<link rel="stylesheet" href="/assets/index-a1b2c3.css">',
      '<link rel="modulepreload" href="/assets/chunk-def456.js">',
      "</head>",
      '<body><div id="app"></div>',
      '<script type="module" src="/assets/index-a1b2c3.js"></script>',
      "</body></html>",
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings.length).toBe(3)
    expect(result.findings.every((f) => f.kind === "html-attr")).toBe(true)
    expect(result.findings.every((f) => f.file === "index.html")).toBe(true)
    expect(result.summary).toMatch(/3/)
  })

  it("flags Vite's preload-helper JS runtime-base construction", async () => {
    // The shape of Vite's absolute-base preload helper, roughly as it
    // survives minification, alongside the near-unique __vite__mapDeps
    // marker that ships in the same chunk.
    const js = [
      'const assetsURL=function(M){return"/"+M};',
      "function __vite__mapDeps(indexes) { return indexes.map(i => deps[i]) }",
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("assets/chunk-abc.js", js)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "assets/chunk-abc.js", kind: "js-runtime-base" })
  })

  it("flags webpack's __webpack_require__.p public-path assignment", async () => {
    const js = '!function(){"use strict";__webpack_require__.p="/";}();'
    const result = await scanBundleForRootAbsoluteAssets([file("main.js", js)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "main.js", kind: "js-runtime-base" })
  })

  it("flags a CSS url(/...) reference (e.g. a @font-face src)", async () => {
    const css = `@font-face { font-family: "Sans"; src: url(/fonts/sans.woff2) format("woff2"); }`
    const result = await scanBundleForRootAbsoluteAssets([file("assets/index.css", css)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "assets/index.css", kind: "css-url" })
  })

  it("flags an inline <style> block's url(/...) inside an HTML file", async () => {
    const html = `<html><head><style>body { background: url(/img/bg.png); }</style></head><body></body></html>`
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "index.html", kind: "css-url" })
  })

  it("does not flag a protocol-relative URL (//cdn.example/x.js)", async () => {
    const html = '<html><head><script src="//cdn.example/x.js"></script></head></html>'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toHaveLength(0)
    expect(result.summary).toBeNull()
  })

  it("does not flag a protocol-relative URL in CSS url()", async () => {
    const css = `.x { background: url(//cdn.example/bg.png); }`
    const result = await scanBundleForRootAbsoluteAssets([file("assets/index.css", css)])
    expect(result.findings).toHaveLength(0)
  })

  it("does not flag an ordinary same-origin API string in app JS", async () => {
    const js = 'fetch("/api/widgets").then(r => r.json());\nconst LOGIN = "/login";'
    const result = await scanBundleForRootAbsoluteAssets([file("assets/app.js", js)])
    expect(result.findings).toHaveLength(0)
  })

  it("does not flag an <a href> navigation link", async () => {
    const html = '<html><body><a href="/about">About</a></body></html>'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toHaveLength(0)
  })

  it("does not flag a relative-base Vite build (new URL(dep, importerUrl).href)", async () => {
    const js = [
      "const assetsURL=function(dep,importerUrl){return new URL(dep,importerUrl).href};",
      "function __vite__mapDeps(indexes) { return indexes.map(i => deps[i]) }",
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("assets/chunk-abc.js", js)])
    expect(result.findings).toHaveLength(0)
  })

  it("does not flag a <link rel=canonical> — not a fetched subresource", async () => {
    const html = '<html><head><link rel="canonical" href="/page"></head></html>'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toHaveLength(0)
  })

  it("does not flag a <meta> tag's content attribute", async () => {
    const html = '<html><head><meta property="og:image" content="/social.png"></head></html>'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toHaveLength(0)
  })

  it("skips files over the size cap without reading them", async () => {
    let read = false
    const big: ScannableFile = {
      path: "assets/huge.js",
      size: 50 * 1024 * 1024,
      readText: async () => {
        read = true
        return '__webpack_require__.p="/";'
      },
    }
    const result = await scanBundleForRootAbsoluteAssets([big])
    expect(result.findings).toHaveLength(0)
    expect(read).toBe(false)
  })

  it("skips non-text (unrecognized-extension) files entirely", async () => {
    const result = await scanBundleForRootAbsoluteAssets([
      file("assets/pic.png", '"/assets/pic.png" pretend-binary-but-contains-a-slash-string'),
      file("assets/font.woff2", "/binary/garbage"),
    ])
    expect(result.findings).toHaveLength(0)
  })

  it("returns a null summary and empty findings for a clean bundle", async () => {
    const result = await scanBundleForRootAbsoluteAssets([
      file("index.html", '<html><head><script src="./assets/app.js"></script></head></html>'),
      file("assets/app.js", 'import x from "./other.js"; export default x;'),
      file("assets/index.css", `.x { background: url(./bg.png); }`),
    ])
    expect(result.findings).toEqual([])
    expect(result.summary).toBeNull()
  })

  it("caps findings per file so a pathological bundle cannot blow up the result", async () => {
    const manyTags = Array.from(
      { length: 100 },
      (_, i) => `<img src="/img/${i}.png">`,
    ).join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", `<html>${manyTags}</html>`)])
    expect(result.findings.length).toBeLessThan(100)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  // --- Coordinator review fixes (round 1) ---------------------------------

  it("IMPORTANT 1: does not flag a lazy-load data-src attribute (fires no browser fetch)", async () => {
    const html = '<img data-src="/images/lazy.jpg" src="placeholder.svg">'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toEqual([])
  })

  it("IMPORTANT 1: does not flag an Angular ng-src binding", async () => {
    const html = '<img ng-src="/images/x.jpg">'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toEqual([])
  })

  it("IMPORTANT 1: does not flag a Vue v-bind:src binding", async () => {
    const html = '<img v-bind:src="/images/x.jpg">'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toEqual([])
  })

  it("IMPORTANT 1: does not flag an unrelated formaction-style attribute, and still flags the real src beside it", async () => {
    const html = '<img formaction="/submit" src="/images/real.jpg">'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toEqual([{ file: "index.html", kind: "html-attr", sample: html }])
  })

  it('IMPORTANT 2: does not flag a SAFE relative-base Vite helper just because unrelated app code nearby also does "/" + ident', async () => {
    const js = [
      "const assetsURL=function(dep,importerUrl){return new URL(dep,importerUrl).href};",
      "function __vite__mapDeps(indexes) { return indexes.map(i => deps[i]) }",
      "",
      "// Unrelated app code, nothing to do with asset loading:",
      'function profileUrl(id){ return "/" + id }',
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("assets/chunk-abc.js", js)])
    expect(result.findings).toEqual([])
  })

  it("IMPORTANT 2: still flags the real absolute-base Vite preload helper shape from a live build", async () => {
    const js = [
      'const assetsURL=function(A){return"/"+A};',
      "function __vite__mapDeps(indexes) { return indexes.map(i => deps[i]) }",
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("assets/chunk-abc.js", js)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "assets/chunk-abc.js", kind: "js-runtime-base" })
  })

  it("MINOR 4: flags a root-absolute web-app-manifest link (a real browser fetch)", async () => {
    const html = '<html><head><link rel="manifest" href="/manifest.webmanifest"></head></html>'
    const result = await scanBundleForRootAbsoluteAssets([file("index.html", html)])
    expect(result.findings).toEqual([
      { file: "index.html", kind: "html-attr", sample: '<link rel="manifest" href="/manifest.webmanifest">' },
    ])
  })

  // --- Coordinator review fixes (round 2) ---------------------------------

  it('IMPORTANT (regression): still flags the real Vite helper when the minifier names the parameter "$"', async () => {
    // `$` is a valid JS identifier character, and minifiers reach for it in
    // large shared scopes — a real absolute-base Vite build can minify the
    // preload helper's single parameter down to exactly this.
    const js = [
      'const assetsURL=function($){return"/"+$};',
      "function __vite__mapDeps(indexes) { return indexes.map(i => deps[i]) }",
    ].join("\n")
    const result = await scanBundleForRootAbsoluteAssets([file("assets/chunk-abc.js", js)])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ file: "assets/chunk-abc.js", kind: "js-runtime-base" })
  })
})

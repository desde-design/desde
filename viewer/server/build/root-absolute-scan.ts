/**
 * Root-absolute asset reference scan — the deploy-time detector for the
 * failure mode described in `docs/bundler-research` (viewer-membership row
 * 7): in path mode the review iframe has an opaque origin, so a URL the
 * bundle builds at runtime as `"/" + "assets/x.css"` (Vite's lazy-chunk
 * preload helper, webpack's `publicPath`) or writes literally into HTML/CSS
 * escapes the capability prefix and 404s for any non-public project. Most
 * scaffolds (Vite, CRA, Next export, Astro, Nuxt, Parcel) emit root-absolute
 * references by default, so this is common, not an edge case.
 *
 * This module is PURE — no filesystem access, no I/O beyond the `readText`
 * callback the caller supplies. `scanOutputTreeForRootAbsoluteAssets` below
 * is the one fs-backed adapter, shared by both deploy lanes (bundle upload
 * in `api/deployments-routes.ts`, and the repo build in
 * `build/in-process-build-runner.ts`) so the patterns can never drift
 * between them.
 *
 * The goal is a WARNING with a one-line fix, not a blocker — which shapes
 * every pattern below toward low false positives over perfect recall. A
 * wrong warning erodes trust in every warning after it. Three patterns,
 * each anchored as narrowly as it can be while still catching the common
 * case:
 *
 * - **html-attr** — an HTML subresource-fetching attribute (`<script src>`,
 *   `<link href>` restricted to a fetching `rel`, `<img src>`, `<source
 *   src>`, `<audio src>`, `<video src>`) whose value starts with a single
 *   `/`. Deliberately excludes `<a href>` (navigation, not a subresource
 *   fetch) and `<meta content>` (fires no request at all). This alone
 *   catches Vite, CRA, Next.js, Astro, Nuxt and Parcel's entry-HTML failure
 *   — the majority of real bundles, and the one that breaks at FIRST PAINT,
 *   not just on a lazy route.
 * - **css-url** — a CSS `url(/...)` reference, in a `.css` file or an inline
 *   `<style>` block. Covers `@font-face src` and `background-image` — the
 *   fonts-in-CSS case this feature exists to catch.
 * - **js-runtime-base** — two narrow, anchored bundler-runtime signatures:
 *   Vite's absolute-base preload helper — an ANONYMOUS one-parameter
 *   function shaped exactly like `function(M){return"/"+M}` (backreferenced
 *   to the same parameter, so a named app function never matches), found
 *   within a bounded window of the `__vite__mapDeps`/`"modulepreload"`
 *   marker that ships in the same chunk — and webpack's
 *   `__webpack_require__.p="/..."` publicPath assignment. A blanket "does
 *   this JS contain a leading-slash string" scan is NOT used here on
 *   purpose — it would flag every ordinary `fetch("/api/...")` call in the
 *   app, and a bare "somewhere in this file" marker check would flag a
 *   same-shaped but unrelated app function (e.g. `function profileUrl(id){
 *   return "/" + id }`) sitting anywhere near a Vite marker.
 *
 * A single `"/"` not followed by a second `/` is what "root-absolute"
 * means throughout: `//host/path` is a protocol-relative URL to a
 * DIFFERENT origin — a deliberate, legitimate pattern (a CDN) — and must
 * never be flagged.
 */
import { promises as fs } from "node:fs"
import { join } from "node:path"
import type { RootAbsoluteAssetFinding, RootAbsoluteAssetFindingKind } from "../storage/types"

export interface ScannableFile {
  path: string
  readText(): Promise<string>
  /**
   * Byte size, when known ahead of reading. Lets the scanner skip an
   * oversized file without ever reading it — the same "stat before read"
   * discipline `publish-output.ts` uses for the same reason (a single huge
   * file must not spike memory before a cap gets a chance to reject it).
   * When omitted, the scanner reads the file and applies the cap to the
   * decoded text length instead.
   */
  size?: number
}

export interface RootAbsoluteScanResult {
  findings: RootAbsoluteAssetFinding[]
  /** A short human summary, or `null` when `findings` is empty. */
  summary: string | null
}

/** Per-file size cap for the scan — skip anything larger, unread. */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024

/** Caps a pathological bundle (a generated page with thousands of tags) from producing an unbounded result. */
const MAX_FINDINGS_PER_FILE = 20
const MAX_TOTAL_FINDINGS = 200

const HTML_EXTENSIONS = new Set([".html", ".htm"])
const CSS_EXTENSIONS = new Set([".css"])
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])

/** `rel` values that make a `<link href>` a subresource browsers actually fetch. */
const FETCHING_LINK_RELS = new Set(["stylesheet", "modulepreload", "preload", "icon", "manifest"])

function extname(path: string): string {
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  if (dot === -1 || dot < slash) return ""
  return path.slice(dot).toLowerCase()
}

/** A single `/` not followed by a second `/` — see this module's header comment. */
function isRootAbsolute(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//")
}

function truncate(sample: string, max = 120): string {
  return sample.length > max ? `${sample.slice(0, max)}…` : sample
}

const HTML_SUBRESOURCE_TAG_RE = /<(script|link|img|source|audio|video)\b([^>]*)>/gi
// `(?:^|\s)` anchors the attribute name to a real attribute BOUNDARY —
// immediately after the tag name or a preceding attribute — rather than a
// bare `\b` word boundary. `\b` also fires between a non-word and a word
// character, so it wrongly matched "src" inside "data-src", "ng-src", or
// "v-bind:src" (the `-`/`:` before "src" is non-word, "s" is word — a `\b`
// boundary exists there even though this is not the "src" attribute at
// all). None of those fire a browser fetch, unlike a genuine `src`/`href`.
const ATTR_RE = /(?:^|\s)(?:src|href)\s*=\s*(["'])(.*?)\1/i
const REL_ATTR_RE = /(?:^|\s)rel\s*=\s*(["'])(.*?)\1/i

function scanHtmlSubresourceAttrs(text: string, findings: RootAbsoluteAssetFinding[], file: string): void {
  for (const tagMatch of text.matchAll(HTML_SUBRESOURCE_TAG_RE)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) return
    const tagName = tagMatch[1].toLowerCase()
    const attrs = tagMatch[2]
    if (tagName === "link") {
      const relMatch = REL_ATTR_RE.exec(attrs)
      const relTokens = relMatch ? relMatch[2].toLowerCase().split(/\s+/) : []
      if (!relTokens.some((t) => FETCHING_LINK_RELS.has(t))) continue
    }
    const attrMatch = ATTR_RE.exec(attrs)
    if (!attrMatch) continue
    const value = attrMatch[2]
    if (!isRootAbsolute(value)) continue
    findings.push({ file, kind: "html-attr", sample: truncate(tagMatch[0]) })
  }
}

const CSS_URL_RE = /url\(\s*(['"]?)\/(?!\/)([^'")]*)\1?\s*\)/gi

function scanCssUrls(text: string, findings: RootAbsoluteAssetFinding[], file: string): void {
  for (const match of text.matchAll(CSS_URL_RE)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) return
    findings.push({ file, kind: "css-url", sample: truncate(match[0]) })
  }
}

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi

function scanInlineStyleBlocks(text: string, findings: RootAbsoluteAssetFinding[], file: string): void {
  for (const styleMatch of text.matchAll(STYLE_BLOCK_RE)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) return
    scanCssUrls(styleMatch[1], findings, file)
  }
}

// Vite's absolute-base preload helper survives minification as a short
// ANONYMOUS function whose single PARAMETER is the identifier concatenated
// onto `"/"` in the return expression — `function(M){return"/"+M}`, or the
// arrow-function equivalent. The backreference (`\1`) is what makes this
// the actual helper shape rather than any `"/"+ident` construction: a named
// app function like `function profileUrl(id){ return "/" + id }` never
// matches, because "function" is immediately followed by a NAME before the
// parameter list, not by `(`.
//
// That shape check alone is not quite enough — nothing rules out an
// unrelated anonymous helper elsewhere in a large chunk that happens to
// have the same shape for a different reason — so a match additionally has
// to fall within VITE_PROXIMITY_WINDOW characters of one of Vite's own
// markers (`__vite__mapDeps`, `"modulepreload"`), which ship in the same
// chunk as the real preload helper and essentially nowhere else.
//
// The identifier class is `[\w$]+`, not `\w+`: `$` is a valid JS identifier
// character and minifiers reach for it in large shared scopes, so a real
// build can minify the parameter down to exactly `$` — `function($){return"/"+$}`.
// `\w+` alone made that a false NEGATIVE.
const VITE_MARKER_RE = /__vite__mapDeps|"modulepreload"/g
const VITE_HELPER_FUNCTION_RE = /function\s*\(\s*([\w$]+)\s*\)\s*\{\s*return\s*"\/"\s*\+\s*\1\s*\}/g
const VITE_HELPER_ARROW_RE = /\(?\s*([\w$]+)\s*\)?\s*=>\s*"\/"\s*\+\s*\1\b/g
const VITE_PROXIMITY_WINDOW = 400

// webpack's minified runtime assigns the public path as `.p="/..."`,
// anchored to the `__webpack_require__` identifier so an unrelated `.p =`
// property assignment elsewhere is never mistaken for it.
const WEBPACK_PUBLIC_PATH_RE = /__webpack_require__\s*\.\s*p\s*=\s*(["'])\/(?!\/)[^"']*\1/g

function matchIndices(re: RegExp, text: string): number[] {
  const indices: number[] = []
  for (const m of text.matchAll(re)) indices.push(m.index ?? 0)
  return indices
}

function withinWindow(index: number, others: number[], window: number): boolean {
  return others.some((o) => Math.abs(o - index) <= window)
}

function scanJsRuntimeBase(text: string, findings: RootAbsoluteAssetFinding[], file: string): void {
  const markerIndices = matchIndices(VITE_MARKER_RE, text)
  if (markerIndices.length > 0) {
    for (const helperRe of [VITE_HELPER_FUNCTION_RE, VITE_HELPER_ARROW_RE]) {
      for (const match of text.matchAll(helperRe)) {
        if (findings.length >= MAX_FINDINGS_PER_FILE) return
        const index = match.index ?? 0
        if (!withinWindow(index, markerIndices, VITE_PROXIMITY_WINDOW)) continue
        findings.push({ file, kind: "js-runtime-base", sample: truncate(match[0]) })
      }
    }
  }
  for (const match of text.matchAll(WEBPACK_PUBLIC_PATH_RE)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) return
    findings.push({ file, kind: "js-runtime-base", sample: truncate(match[0]) })
  }
}

function buildSummary(findings: RootAbsoluteAssetFinding[]): string | null {
  if (findings.length === 0) return null
  const fileCount = new Set(findings.map((f) => f.file)).size
  const refWord = findings.length === 1 ? "reference" : "references"
  const fileWord = fileCount === 1 ? "file" : "files"
  return `${findings.length} root-absolute asset ${refWord} found in ${fileCount} ${fileWord}`
}

/**
 * Scans an already-in-memory set of files for root-absolute asset
 * references. Pure — see this module's header comment for the patterns and
 * the false-positive reasoning behind each one.
 */
export async function scanBundleForRootAbsoluteAssets(
  files: ScannableFile[],
): Promise<RootAbsoluteScanResult> {
  const findings: RootAbsoluteAssetFinding[] = []
  for (const f of files) {
    if (findings.length >= MAX_TOTAL_FINDINGS) break
    const ext = extname(f.path)
    const isHtml = HTML_EXTENSIONS.has(ext)
    const isCss = CSS_EXTENSIONS.has(ext)
    const isJs = JS_EXTENSIONS.has(ext)
    if (!isHtml && !isCss && !isJs) continue // non-text / not a recognized asset-reference carrier
    if (f.size !== undefined && f.size > MAX_SCAN_BYTES) continue

    const text = await f.readText()
    if (f.size === undefined && Buffer.byteLength(text, "utf-8") > MAX_SCAN_BYTES) continue

    const perFile: RootAbsoluteAssetFinding[] = []
    if (isHtml) {
      scanHtmlSubresourceAttrs(text, perFile, f.path)
      scanInlineStyleBlocks(text, perFile, f.path)
    } else if (isCss) {
      scanCssUrls(text, perFile, f.path)
    } else if (isJs) {
      scanJsRuntimeBase(text, perFile, f.path)
    }
    findings.push(...perFile.slice(0, Math.max(0, MAX_TOTAL_FINDINGS - findings.length)))
  }
  return { findings, summary: buildSummary(findings) }
}

/**
 * Directory-backed adapter shared by both deploy lanes. `files` is the
 * already-computed repo-relative file list (both lanes have one already —
 * `collectFiles`/`collectOutputFiles`), so this only re-reads the subset
 * that can possibly match (recognized extension, under the size cap),
 * exactly like `publishOutputDir`'s own stat-before-read discipline.
 */
export async function scanOutputTreeForRootAbsoluteAssets(
  outputRoot: string,
  files: string[],
): Promise<RootAbsoluteScanResult> {
  const candidates = files.filter((relPath) => {
    const ext = extname(relPath)
    return HTML_EXTENSIONS.has(ext) || CSS_EXTENSIONS.has(ext) || JS_EXTENSIONS.has(ext)
  })
  const scannable: ScannableFile[] = []
  for (const relPath of candidates) {
    const full = join(outputRoot, relPath)
    const stat = await fs.stat(full)
    scannable.push({
      path: relPath,
      size: stat.size,
      readText: () => fs.readFile(full, "utf-8"),
    })
  }
  return scanBundleForRootAbsoluteAssets(scannable)
}

export type { RootAbsoluteAssetFinding, RootAbsoluteAssetFindingKind }

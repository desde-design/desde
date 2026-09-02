import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Serve-time HTML rewriting for hosted prototypes.
 *
 * Ported from the original GCP viewer's serve layer (deleted 2026-08-08). Two
 * differences: the bridge script is injected as a parameter (so the
 * router is unit-testable without disk I/O), and `injectBaseHref` is
 * new — path-based serving at /p/{slug}/ needs a <base> for prototypes
 * built with root-relative asset URLs.
 *
 * The bundle itself is the SAME artifact composer and the viewer
 * serve: dist/bridge-bundle.js, built from src/bridge/ by `npm run build:bridge`.
 * Never edit the bundle; edit the source and run `npm run build:bridge`.
 */

const BRIDGE_BUNDLE_PATH = fileURLToPath(
  new URL("../../../dist/bridge-bundle.js", import.meta.url),
)

export function injectBaseHref(html: string, basePath: string): string {
  if (/<base\s/i.test(html)) return html
  const headMatch = html.match(/<head[^>]*>/i)
  if (!headMatch) return html
  const insertAt = (headMatch.index ?? 0) + headMatch[0].length
  // Escape in attribute context: use HTML entities to prevent injection
  const safePath = basePath.replace(/"/g, "&quot;").replace(/</g, "&lt;")
  return (
    html.slice(0, insertAt) + `<base href="${safePath}">` + html.slice(insertAt)
  )
}

/**
 * Injects the shell-origin config as an inline script, and the bridge as an
 * EXTERNAL script (`bridgeSrc` is a URL, not the bundle body).
 *
 * The bridge used to be inlined verbatim. It can't be: the built bundle
 * (`dist/bridge-bundle.js`) contains the literal sequence
 * `<!--` inside a string in a bundled tokenizer, and per the HTML spec
 * `<!--` inside a classic `<script>` element switches the tokenizer into
 * script-data-escaped state, corrupting parsing of the rest of the inline
 * script (verified live in Chrome: `Unexpected token '<'`, bridge never
 * initializes — commenting/inspection dead on every hosted prototype). A
 * blanket textual escape of the bundle would risk corrupting the bundle's
 * own JS outside string literals, so instead the bundle is served as its
 * own resource (see `serve-router.ts`'s `__desde/bridge-<version>.js`
 * route) and referenced here by `src`, which has no such tokenizer hazard.
 */
export function injectBridge(
  html: string,
  shellOrigin: string,
  bridgeSrc: string,
): string {
  // Escape in order: backslash first, then quote, then < to prevent </script> injection
  const safeOrigin = shellOrigin
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\u003c")
  const configTag = `<script data-prototype-flow="config">window.__DESDE_SHELL_ORIGIN__="${safeOrigin}";</script>`
  // Attribute-value context (not a JS string): HTML-entity escape, same
  // convention as injectBaseHref's `safePath` above.
  const safeSrc = bridgeSrc.replace(/"/g, "&quot;").replace(/</g, "&lt;")
  // `data-shell-origin` is the AUTHORITATIVE origin channel; the inline tag
  // above is a legacy fallback. A prototype serving `script-src 'self'`
  // without `'unsafe-inline'` drops the inline tag while the external bundle
  // loads normally — and since the bridge now fails CLOSED on an unresolvable
  // origin (see docs/bridge-protocol.md), emitting only the inline tag would
  // leave the bridge silent on exactly those prototypes. An attribute is
  // markup, not script, so no CSP strips it.
  //
  // Escaped as an attribute value, NOT as the JS string `safeOrigin` above:
  // `\"` is correct inside a script body and wrong inside an HTML attribute,
  // where it would terminate the value.
  const safeOriginAttr = shellOrigin.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  const bridgeTag =
    `<script data-prototype-flow="bridge" ` +
    `data-shell-origin="${safeOriginAttr}" src="${safeSrc}"></script>`
  const injection = `${configTag}\n${bridgeTag}`

  // Before </body> so document.body exists when the bridge runs.
  if (html.includes("</body>")) {
    return html.replace("</body>", `${injection}\n</body>`)
  }
  if (html.includes("</head>")) {
    return html.replace("</head>", `${injection}\n</head>`)
  }
  return `${html}\n${injection}`
}

/**
 * Rewrites root-relative URLs in HTML attributes (src/href/srcset) to the
 * prototype's path prefix. `<base href>` cannot do this — the HTML spec
 * resolves only *relative* URLs against the base; a URL beginning with `/`
 * always resolves against the origin root. A stock Vite build emits
 * root-relative asset URLs, so without this rewrite every asset 404s under
 * path-based serving (Phase 1 smoke finding F-1).
 *
 * Script, style, and comment bodies are masked and never rewritten (design
 * decision — rewriting content inside JS/CSS is unsafe). Script and style
 * opening tags' own attributes (e.g., `<script src="/x">`) ARE rewritten,
 * since those are markup attributes, not content. HTML entities and
 * character references are preserved; this is attribute-level rewriting only.
 * Attributes whose values contain nested markup (e.g. `<meta content='<img src="/x">'>`)
 * may be rewritten, but detecting such cases requires a real HTML parser and
 * is an acceptable residue — the transformation is harmless (the browser
 * would normalize the URL the same way).
 *
 * Skips protocol-relative (`//…`) URLs: the `(?!\/)` lookahead requires the
 * character after the leading slash to not be another slash.
 */
export function rewriteRootRelativeUrls(html: string, basePath: string): string {
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`

  // Split on script/style/comment regions (capturing group keeps delimiters in result)
  const parts = html.split(/(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->)/gi)

  return parts
    .map((part, idx) => {
      // Odd indices are script/style/comment blocks (masked from full rewrite)
      if (idx % 2 === 1) {
        // For script/style opening tags, rewrite only the opening tag's attributes
        if (/^<(?:script|style)\b/i.test(part)) {
          const firstClose = part.indexOf(">")
          if (firstClose !== -1) {
            const opening = part.slice(0, firstClose + 1)
            const body = part.slice(firstClose + 1)
            const rewrittenOpening = rewriteAttributesInString(opening, prefix)
            return rewrittenOpening + body
          }
        }
        // Comments and other blocks pass through untouched
        return part
      }

      // Even indices are outside regions - apply full rewrite
      return rewriteAttributesInString(part, prefix)
    })
    .join("")
}

/**
 * Applies both src/href and srcset rewrites to a string segment.
 * Used for both full HTML segments and opening tags.
 */
function rewriteAttributesInString(str: string, prefix: string): string {
  let out = str.replace(
    /(\s(?:src|href)=)(["'])\/(?!\/)([^"']*)\2/g,
    (_m, attr: string, q: string, rest: string) => `${attr}${q}${prefix}${rest}${q}`,
  )
  out = out.replace(/(\ssrcset=)(["'])([^"']*)\2/g, (_m, attr: string, q: string, val: string) => {
    const rewritten = val
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim()
        if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
          return `${prefix}${trimmed.slice(1)}`
        }
        return trimmed
      })
      .join(", ")
    return `${attr}${q}${rewritten}${q}`
  })
  return out
}

let cached: { script: string; version: string } | null = null

export function readBridgeBundle(): { script: string; version: string } {
  if (cached) return cached
  const script = readFileSync(BRIDGE_BUNDLE_PATH, "utf-8")
  const match = script.match(/__DESDE_BRIDGE_VERSION__="([^"]+)"/)
  cached = { script, version: match?.[1] ?? "unknown" }
  return cached
}

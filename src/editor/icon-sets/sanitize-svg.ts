/**
 * Strip script and event-handler vectors from SVG markup before
 * insertion via `dangerouslySetInnerHTML` in the editor shell.
 *
 * Editor's shell origin holds the bearer token for `/api/editor/*`,
 * so any script that executes here runs with the shell's privileges.
 * Phase 1's only icon source is `npm-named-exports` against
 * locally-installed packages (same trust level as the rest of
 * node_modules), but the sanitizer creates a firm boundary so future
 * adapters (Phase 5's `custom`, an Iconify network adapter, etc.)
 * can't accidentally introduce an XSS regression. The picker is the
 * one place SVG markup crosses from adapter output into rendered DOM.
 *
 * Implementation: allowlist of SVG elements + attributes; strip
 * anything else. Uses the browser's DOMParser. SSR-safe: returns the
 * input unchanged on the server (no DOM, no execution risk).
 *
 * Known limits:
 *  - Allowlist is conservative for the SVG corpus icon libraries
 *    actually emit. Exotic SVG features (filters with complex
 *    primitives, MathML embedding) get stripped — fine for icons.
 *  - Not a substitute for DOMPurify if adapter output ever sources
 *    truly untrusted content. Upgrade if Phase 5 needs it.
 */

const ALLOWED_ELEMENTS = new Set<string>([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'defs',
  'mask',
  'clippath',
  'pattern',
  // Lookup lowercases `tagName`, so every entry in this set MUST be
  // lowercase. `linearGradient` was spelled camelCase and therefore never
  // matched — gradients were silently stripped, which is why an icon using
  // `fill="url(#g)"` rendered as nothing. Found while pinning K13.
  'lineargradient',
  'radialgradient',
  'stop',
  'filter',
  'fegaussianblur',
  'feflood',
  'fecomposite',
  'femerge',
  'femergenode',
  'fecolormatrix',
  'feoffset',
  'feblend',
  'fedropshadow',
  'use',
  'symbol',
  'title',
  'desc',
  'metadata',
])

// NOTE: `style` is deliberately ABSENT (audit K13). A verbatim style
// attribute is not a paint instruction — it is layout control, and the
// markup here is rendered into the EDITOR SHELL's own document via
// `dangerouslySetInnerHTML`. `style="position:fixed;inset:0;z-index:9999"`
// on a single <path> turns an icon into a full-viewport overlay sitting on
// top of the shell chrome, which is a clickjacking surface over the very
// buttons that write the user's source. Icon libraries paint with
// `fill` / `stroke` / `d`, all still allowed, so nothing legitimate
// regresses; a library that needs geometry uses `viewBox` / `width` /
// `height`, also still allowed.
//
// `id` is KEPT despite carrying its own (smaller) risk — a colliding id in
// the shell document can retarget a `<use href="#…">` or an aria
// reference. It stays because it is load-bearing for legitimate icons:
// `fill="url(#grad)"`, `mask="url(#m)"` and `clip-path="url(#c)"` all
// resolve through an id defined inside the same SVG, so dropping it would
// break gradients and masks outright. Revisit if an adapter ever sources
// icons from the network, where the trust calculus changes.
const ALLOWED_ATTRS = new Set<string>([
  'id',
  'class',
  'd',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'transform',
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'xmlns:xlink',
  'version',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-labelledby',
  'data-testid',
  'mask',
  'clip-path',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'in',
  'in2',
  'result',
  'stddeviation',
  'mode',
  'operator',
  'values',
  'type',
  'flood-color',
  'flood-opacity',
  'dx',
  'dy',
])

// Reference attributes — only allow same-document fragment refs (#foo).
// `<use href="javascript:…">` and `<use href="http://…">` are stripped.
const REFERENCE_ATTRS = new Set(['href', 'xlink:href'])

function sanitizeNode(node: Element): void {
  const tagName = node.tagName.toLowerCase()

  if (!ALLOWED_ELEMENTS.has(tagName)) {
    node.remove()
    return
  }

  // Snapshot attribute names so removal during iteration is safe.
  const attrNames = Array.from(node.attributes).map((a) => a.name)
  for (const name of attrNames) {
    const lower = name.toLowerCase()

    // Strip every event handler unconditionally.
    if (lower.startsWith('on')) {
      node.removeAttribute(name)
      continue
    }

    // Reference attrs: only allow fragment refs.
    if (REFERENCE_ATTRS.has(lower)) {
      const v = node.getAttribute(name) ?? ''
      if (!v.startsWith('#')) node.removeAttribute(name)
      continue
    }

    // Allowlist gate. data-* is allowed (low-risk, useful for testing).
    if (!ALLOWED_ATTRS.has(lower) && !lower.startsWith('data-') && !lower.startsWith('aria-')) {
      node.removeAttribute(name)
    }
  }

  // Recurse into children. Iterate over a static copy because
  // sanitizeNode can remove nodes mid-iteration.
  for (const child of Array.from(node.children)) {
    sanitizeNode(child)
  }
}

export function sanitizeSvg(markup: string): string {
  if (typeof markup !== 'string' || markup.length === 0) return ''
  if (typeof DOMParser === 'undefined') {
    // SSR: no DOM available, so no execution risk either. Return as-is.
    return markup
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<svg-root>${markup}</svg-root>`, 'text/html')
  const root = doc.querySelector('svg-root')
  if (!root) return ''

  for (const child of Array.from(root.children)) {
    sanitizeNode(child)
  }

  return root.innerHTML
}

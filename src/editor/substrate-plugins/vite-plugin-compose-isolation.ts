/**
 * Editor isolation route (Phase F3).
 *
 * Adds a virtual `/__compose/component/<encodedFile>` route to the
 * substrate's Vite dev server. Hits to this route serve an HTML
 * shell that imports the requested SFC via Vite's normal module-
 * graph (so HMR + bridge injection still work) and mounts it
 * standalone — no router, no app state, no auth.
 *
 * Companion to the F4 "Edit component" flow: when the designer
 * right-clicks a component in the prototype and chooses "Edit
 * component", the shell navigates the iframe here. The bridge
 * sees the same `data-desde-src` tagging, so selection / inspector /
 * mutation capture all work against the component's own SFC.
 *
 * Variant grid (V1.5+): currently the route renders a single
 * mount of the component with default props. The variant grid is
 * gated on a query string (`?variants=1`) and pulled from the
 * shell's `/api/editor/catalog` endpoint at runtime — keeping
 * the plugin thin and the shell as the single source of truth for
 * variant discovery.
 *
 * V2: package as `@desde/vite-plugin` alongside the source-tag
 * plugin so customer-onboarded substrates pull it in via npm.
 */

import type { Plugin } from 'vite'

const ROUTE_PREFIX = '/__compose/component/'

export interface ComposeIsolationPluginOptions {
  /** Project-relative root (defaults to vite's `root`). */
  root?: string
  /**
   * CSS modules to import into the isolation page so design-system
   * components render with their styles. Substrate-specific — Vue +
   * Acme DS passes the design system's style.css; React + Material UI
   * would pass MUI's. Without these, components render with no
   * styles and often look invisible.
   *
   * Each entry is passed verbatim to an `import 'X'` statement, so
   * Vite resolves them as normal modules (package specifiers,
   * relative paths, etc.).
   */
  cssImports?: string[]
}

export function composeIsolationPlugin(
  options: ComposeIsolationPluginOptions = {},
): Plugin {
  const cssImports = options.cssImports ?? []
  // Validate CSS imports look like sane import specifiers — same
  // package-spec rules as ?name=, plus relative-path support.
  // Without this, a config typo could splice arbitrary JS into the
  // inline script.
  for (const css of cssImports) {
    if (!isValidImportSpecifier(css)) {
      throw new Error(
        `composeIsolationPlugin: invalid cssImports entry: ${JSON.stringify(css)}`,
      )
    }
  }
  return {
    name: 'desde:compose-isolation',
    apply: 'serve', // dev only; production prototype builds don't need it
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()
        if (!req.url.startsWith(ROUTE_PREFIX)) return next()

        // Parse the URL — strictly path-based, NO query strings.
        //
        // Why: Vite's transformIndexHtml extracts inline `<script
        // type="module">` blocks and rewrites them to external
        // html-proxy URLs by appending `?html-proxy&index=N`. When
        // the page URL already has a query string, Vite's output
        // ends up with two `?` characters (e.g. `?name=...?html-
        // proxy&index=0.js`) which the browser parses as one query.
        // The proxy lookup then fails silently and the inline script
        // never runs — the page stays blank. Encoding everything in
        // the path sidesteps this entirely.
        //
        // Layout:
        //   /__compose/component/<encodedSpec>
        //   /__compose/component/<encodedSpec>/<base64urlConfig>
        //
        // - encodedSpec: URI-encoded import spec (file path or
        //   package name).
        // - base64urlConfig: optional second segment, base64url-
        //   encoded JSON `{ name?, variants?, props? }`.
        const path = req.url.split('?')[0] ?? req.url
        const rest = path.slice(ROUTE_PREFIX.length)
        const segments = rest.split('/').filter(Boolean)
        if (segments.length === 0) {
          res.statusCode = 400
          res.end('compose-isolation: missing component spec')
          return
        }
        if (segments.length > 2) {
          res.statusCode = 400
          res.end('compose-isolation: too many path segments (expected spec[/config])')
          return
        }
        const encodedSpec = segments[0]
        const encodedConfig = segments[1] ?? null

        // decodeURIComponent throws URIError on malformed percent-
        // encoding. Surface as 400 not 500 (codex F3 P1).
        let decoded: string
        try {
          decoded = decodeURIComponent(encodedSpec)
        } catch {
          res.statusCode = 400
          res.end('compose-isolation: malformed URI encoding in component spec')
          return
        }
        if (decoded.includes('..')) {
          res.statusCode = 400
          res.end('compose-isolation: path traversal rejected')
          return
        }

        // Decode the optional config segment. Failures are 400 — a
        // malformed config means the shell screwed up the URL.
        let config: IsolationConfig = {}
        if (encodedConfig) {
          const parsed = decodeConfigSegment(encodedConfig)
          if (!parsed.ok) {
            res.statusCode = 400
            res.end(`compose-isolation: ${parsed.error}`)
            return
          }
          config = parsed.value
        }

        // Validate config fields before splicing into HTML.
        if (config.name !== undefined && !isValidExportName(config.name)) {
          res.statusCode = 400
          res.end('compose-isolation: config.name must be a valid JS identifier')
          return
        }
        if (config.variants !== undefined && !Array.isArray(config.variants)) {
          res.statusCode = 400
          res.end('compose-isolation: config.variants must be an array')
          return
        }

        // Compute the import URL based on spec shape:
        // - config.name present → treat spec as package specifier.
        // - no name → must be a .vue file path.
        let componentImportUrl: string
        let isNamedImport: boolean
        if (config.name) {
          if (!isValidPackageSpec(decoded)) {
            res.statusCode = 400
            res.end('compose-isolation: package spec must be npm-style (when config.name is set)')
            return
          }
          componentImportUrl = decoded
          isNamedImport = true
        } else {
          if (!decoded.endsWith('.vue')) {
            res.statusCode = 400
            res.end('compose-isolation: file spec must end in .vue (or set config.name for a package)')
            return
          }
          componentImportUrl = '/' + decoded.replace(/^\/+/, '')
          isNamedImport = false
        }
        const componentName = config.name ?? inferComponentName(decoded)
        const propsRaw = sanitizeJsonForScript(JSON.stringify(config.props ?? {}))
        const variantsRaw =
          config.variants !== undefined
            ? sanitizeJsonForScript(JSON.stringify(config.variants))
            : null

        // Run the HTML through Vite's transformIndexHtml so the inline
        // `<script type="module">` gets the same treatment Vite gives
        // index.html: bare specifiers (`from 'vue'`) rewritten to
        // `/node_modules/.vite/deps/vue.js?v=...`, `/@vite/client`
        // injected for HMR. Without this, the browser would refuse to
        // resolve `'vue'` and the component would never mount — the
        // toolbar would render but the canvas stays blank.
        const rawHtml = renderHtml({
          componentImportUrl,
          componentName,
          propsRaw,
          variantsRaw,
          isNamedImport,
          cssImports,
        })
        const transformed = await server.transformIndexHtml(req.url, rawHtml)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.statusCode = 200
        res.end(transformed)
      })
    },
  }
}

function inferComponentName(file: string): string {
  // `src/components/MyButton.vue` → `MyButton`
  const base = file.split('/').pop() ?? file
  return base.replace(/\.vue$/, '')
}

function renderHtml(args: {
  componentImportUrl: string
  componentName: string
  propsRaw: string
  /** Pre-sanitized JSON array of `{label, props}` cells, or null if absent. */
  variantsRaw: string | null
  /** When true, generate `import { name } from spec` (named export). */
  isNamedImport: boolean
  /** Side-effect CSS imports declared by the substrate. */
  cssImports: string[]
}): string {
  const { componentImportUrl, componentName, propsRaw, variantsRaw, isNamedImport, cssImports } = args
  // Named import for design-system packages, default import for SFCs.
  // The componentName is already validated as a JS identifier when
  // it comes from `?name=`, so emitting it inline is safe.
  const importStatement = isNamedImport
    ? `import { ${componentName} as Component } from ${JSON.stringify(componentImportUrl)}`
    : `import Component from ${JSON.stringify(componentImportUrl)}`
  // Side-effect CSS imports — emitted before the runtime imports so
  // they're applied by the time components mount. Vite handles them
  // as normal module imports (CSS is wrapped into a JS module that
  // appends a <style> tag at evaluation time).
  const cssImportStatements = cssImports
    .map((spec) => `import ${JSON.stringify(spec)}`)
    .join('\n      ')
  // The page imports the component dynamically from Vite's module
  // graph, then mounts it. Vite injects HMR for the imported file,
  // and the existing source-tag plugin tags the SFC with
  // `data-desde-src` — both flow into the bridge as usual.
  //
  // When `variants` is provided, the page renders a grid of cells
  // instead of a single mount — Storybook-style component view. Each
  // cell is its own Vue app so an error in one cell doesn't blank
  // the page.
  const variantsLiteral = variantsRaw ?? 'null'
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Editor · ${escapeHtml(componentName)}</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, sans-serif; }
      body { background: #fafafa; }
      #compose-isolation-root {
        padding: 24px;
        min-height: 100%;
        box-sizing: border-box;
      }
      #compose-isolation-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: #fff;
        border-bottom: 1px solid #e5e7eb;
        font-size: 12px;
        color: #6b7280;
        position: sticky;
        top: 0;
        z-index: 10;
      }
      #compose-isolation-toolbar .name {
        font-family: ui-monospace, monospace;
        font-weight: 600;
        color: #111827;
      }
      .variant-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }
      .variant-cell {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .variant-cell-label {
        padding: 6px 10px;
        font-size: 11px;
        font-family: ui-monospace, monospace;
        color: #6b7280;
        background: #f9fafb;
        border-bottom: 1px solid #e5e7eb;
      }
      .variant-cell-mount {
        padding: 16px;
        flex: 1;
        min-height: 60px;
      }
      .variant-cell-error {
        padding: 16px;
        font-size: 12px;
        color: #b91c1c;
        background: #fef2f2;
      }
      .empty-state {
        max-width: 520px;
        margin: 48px auto;
        padding: 24px;
        background: #fff;
        border: 1px dashed #d1d5db;
        border-radius: 8px;
        color: #374151;
        font-size: 13px;
        line-height: 1.5;
      }
      .empty-state h2 {
        margin: 0 0 8px;
        font-size: 14px;
        color: #111827;
      }
      .empty-state code {
        font-family: ui-monospace, monospace;
        background: #f3f4f6;
        padding: 1px 4px;
        border-radius: 3px;
      }
    </style>
  </head>
  <body>
    <div id="compose-isolation-toolbar" data-prototype-flow>
      <span>Editing component:</span>
      <span class="name">${escapeHtml(componentName)}</span>
      <span style="flex:1"></span>
      <span>(isolation view)</span>
    </div>
    <div id="compose-isolation-root"></div>
    <script type="module">
      ${cssImportStatements}
      import { createApp, h } from 'vue'
      ${importStatement}
      const fallbackProps = ${propsRaw}
      const variants = ${variantsLiteral}
      const root = document.getElementById('compose-isolation-root')

      function mountCell(target, props, children) {
        // Pass children as the default slot when provided, so empty
        // text-slot components (like UiButton with no body) are at
        // least visible. children is a string here — Vue normalizes
        // it into a text vnode.
        const slot = children
          ? { default: () => children }
          : undefined
        const app = createApp({ render() { return h(Component, props, slot) } })
        app.config.errorHandler = (err) => {
          console.error('[compose-isolation] cell render error:', err)
          target.innerHTML = ''
          const msg = document.createElement('div')
          msg.className = 'variant-cell-error'
          msg.textContent = 'Cell failed to render: ' + (err && err.message ? err.message : String(err))
          target.appendChild(msg)
        }
        try {
          app.mount(target)
        } catch (err) {
          console.error('[compose-isolation] cell mount error:', err)
          target.innerHTML = ''
          const msg = document.createElement('div')
          msg.className = 'variant-cell-error'
          msg.textContent = 'Cell failed to mount: ' + (err && err.message ? err.message : String(err))
          target.appendChild(msg)
        }
      }

      function renderEmptyState() {
        const empty = document.createElement('div')
        empty.className = 'empty-state'
        empty.setAttribute('data-prototype-flow', '')
        empty.innerHTML = '<h2>No demo data available</h2>' +
          '<p>This component does not expose any enumerable variants ' +
          '(boolean / enum props), and no demo fixture was provided.</p>' +
          '<p>Add a <code>?props=&lt;JSON&gt;</code> query string to render ' +
          'this component with specific props, or declare demo data on the ' +
          'manifest so the variant grid can render automatically.</p>'
        root.appendChild(empty)
      }

      if (Array.isArray(variants) && variants.length > 0) {
        const grid = document.createElement('div')
        grid.className = 'variant-grid'
        for (const cell of variants) {
          // Cell wrapper is NOT tagged with data-prototype-flow — the
          // bridge uses .closest() to find tool-flow ancestors, and
          // tagging the wrapper would make the component inside
          // unselectable. Only the label header (chrome) gets the
          // marker.
          const wrapper = document.createElement('div')
          wrapper.className = 'variant-cell'
          const label = document.createElement('div')
          label.className = 'variant-cell-label'
          label.setAttribute('data-prototype-flow', '')
          label.textContent = String(cell.label || '')
          const mount = document.createElement('div')
          mount.className = 'variant-cell-mount'
          wrapper.appendChild(label)
          wrapper.appendChild(mount)
          grid.appendChild(wrapper)
          mountCell(mount, cell.props || {}, cell.children)
        }
        root.appendChild(grid)
      } else if (Array.isArray(variants)) {
        // Empty array — shell told us there are no variants to render.
        renderEmptyState()
      } else {
        // Absent variants param — fall back to single-mount with
        // fallbackProps. Preserves direct-URL access and the F4
        // punt-list ?props= path.
        const single = document.createElement('div')
        single.style.padding = '16px'
        root.appendChild(single)
        mountCell(single, fallbackProps, undefined)
      }
    </script>
  </body>
</html>`
}

/**
 * Shape of the optional `<base64urlConfig>` path segment, after
 * decoding. All fields are optional — an empty config means "render
 * the spec with default props, no variant grid."
 */
interface IsolationConfig {
  /** Named export from a package (e.g. "UiButton"). */
  name?: string
  /** Variant grid cells. Each renders one mounted instance. */
  variants?: Array<{
    label: string
    props: Record<string, unknown>
    children?: string
  }>
  /** Fallback prop set when no variants are provided. */
  props?: Record<string, unknown>
}

/**
 * Decode the optional config path segment.
 *
 * Format: base64url-encoded UTF-8 JSON. base64url (RFC 4648 §5)
 * uses `-` and `_` instead of `+` and `/` and omits padding so the
 * value is URL-safe in a path segment with no further escaping.
 *
 * Exported (in addition to the middleware use above) so the Phase 4 probe
 * driver's URL-building tests (`src/editor/hints/probe-driver.test.ts`)
 * can round-trip against the SAME decoder this route uses, instead of
 * hand-duplicating the encoding contract and hoping it stays in sync.
 */
export function decodeConfigSegment(
  encoded: string,
): { ok: true; value: IsolationConfig } | { ok: false; error: string } {
  // base64url alphabet only — reject anything that smuggled extra
  // characters past URL routing.
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { ok: false, error: 'config segment is not valid base64url' }
  }
  // Convert base64url → base64 by replacing alphabet and re-padding
  // to a multiple of 4. `Buffer.from(..., 'base64')` tolerates extra
  // padding but not missing padding.
  const padLen = (4 - (encoded.length % 4)) % 4
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen)
  let json: string
  try {
    json = Buffer.from(padded, 'base64').toString('utf-8')
  } catch {
    return { ok: false, error: 'config segment failed base64 decode' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'config segment is not valid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'config must be a JSON object' }
  }
  return { ok: true, value: parsed as IsolationConfig }
}

/**
 * Validator for plugin-side `cssImports` entries. Broader than
 * `isValidPackageSpec` because substrates may use relative paths
 * (`./styles/main.css`) or absolute imports — but still tight enough
 * to reject anything that could escape the import statement.
 */
function isValidImportSpecifier(spec: string): boolean {
  // Allow: package specs (handled by isValidPackageSpec), relative
  // (./, ../), absolute (starting with /), with the same character
  // restrictions. No traversal, no quotes, no whitespace.
  if (spec.includes('"') || spec.includes("'") || /\s/.test(spec)) return false
  if (spec.includes('..')) return false
  if (spec.startsWith('./') || spec.startsWith('/')) {
    return /^[./][a-z0-9._/@-]+$/i.test(spec)
  }
  return isValidPackageSpec(spec)
}

/**
 * Conservative npm-style package specifier check. Accepts:
 *   - `vue`, `react-dom`
 *   - `@acme/design-system`, `@acme/design-system/some/subpath`
 * Rejects URLs, absolute paths, traversal, or weird characters.
 *
 * Without this, `?name=Foo` + a malicious spec like
 * `https://attacker.example/x.js` would be passed through to the
 * inline script's import statement.
 */
function isValidPackageSpec(spec: string): boolean {
  // Allow letters, digits, dash, underscore, dot, slash, @ — and
  // require a sane top-level shape (`name`, `name/sub`, `@scope/name`,
  // `@scope/name/sub`).
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(spec)
}

/**
 * JS identifier check for the `?name=` query param. Restricts to a
 * conservative ASCII subset — sufficient for component export names
 * (`UiButton`, `Button2`, `_Internal`) and prevents anything that
 * could break out of the inline script's import statement.
 */
function isValidExportName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

/**
 * Make a JSON string safe to inline inside `<script>...</script>`.
 *
 * A valid JSON value can contain `</script>` literally (it's not a
 * JSON-special character), and the HTML parser would terminate the
 * surrounding `<script>` tag if we emitted it raw — full XSS via
 * crafted URL (codex F3 P1). Replace `</` with `<\/` (still valid JS,
 * escapes out of the parser's terminator). Same trick for `<!--`
 * which tokenizers also stop on.
 */
function sanitizeJsonForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { VueTracer } from "vite-plugin-vue-tracer"
import type { Plugin } from "vite"

export interface TracerPluginOptions {
  /**
   * Absolute REPO root. Everything downstream (`data-desde-src`, the edit
   * service) speaks paths relative to this.
   */
  repoRoot: string
  /**
   * Absolute VITE root — equal to `repoRoot` for a normal single-package
   * repo, or `<repoRoot>/<subdir>` when the prototype is a package inside a
   * larger repo.
   *
   * `vite-plugin-vue-tracer` hardcodes `relative(process.cwd(), id)`, and
   * since 2026-08-08 `core.ts` chdirs to the Vite root before constructing
   * these plugins — so the tracer emits VITE-root-relative paths. When the
   * two roots differ we must PREPEND the offset to get back to repo-relative.
   */
  viteRoot: string
}

/**
 * Path the tracer client module is served from inside Vite. Mirrors the
 * bridge plugin's `/@desde-bridge.js` convention: the `@`-prefix keeps
 * it out of the user's source namespace, and it's served as an external
 * `<script type="module">` (no inline JS) so it stays CSP-friendly under a
 * `script-src 'self'` policy.
 */
const TRACER_CLIENT_PATH = "/@desde-tracer-client.js"

/** HTTP methods the tracer-client endpoint allows. Anything else 405s. */
const ALLOWED_METHODS = new Set(["GET", "HEAD"])

/**
 * Off-the-shelf element-source attribution via antfu's
 * [`vite-plugin-vue-tracer`](https://github.com/antfu/vite-plugin-vue-tracer)
 * (MIT). Replaces the bespoke `data-desde-src` DOM-attribute stamping with a
 * source-map-based model: the tracer's compiler transform records each
 * vnode's authored `[file, line, column]` into a realm-global store
 * (`globalThis.__vue_tracer__`), keyed by `vnode.props` identity. The bridge
 * reads it back through the tracer's public client API
 * (`findTraceFromElement` / `findTraceFromVNode`).
 *
 * Two pieces, returned as a plugin pair:
 *
 *  1. **`VueTracer()`** — the recorder. `enforce: post`, runs on the compiled
 *     `_sfc_render` output and rewrites each create-vnode call to also call
 *     `recordPosition(file, line, col, vnode)`. Crucially, with the default
 *     `resolveRecordEntryPath: true` it rewrites the injected
 *     `recordPosition` import to a path resolved *relative to where the tracer
 *     package itself lives* (here: editor-cli's `node_modules`). That means
 *     **the user's prototype needs zero dependency on the tracer** — editor
 *     owns and injects it. This is the whole point: the user adds nothing.
 *
 *  2. **`tracerClientPlugin`** — exposes the tracer's client API on the
 *     prototype `window` as `__DESDE_TRACER__` so the self-contained
 *     bridge IIFE (which imports nothing at runtime) can read it. It serves a
 *     tiny module that re-imports the same `record.mjs` the compiled
 *     components write to (the `globalThis.__vue_tracer__` store is shared
 *     across the realm, so reader and writers see one store regardless of
 *     module instance) and assigns the namespace to the global.
 *
 * Because the served client module statically imports `record.mjs` from
 * editor-cli's `node_modules` — which is outside the prototype's Vite root —
 * the plugin also widens `server.fs.allow` to include that directory.
 */
/**
 * The offset the bridge prepends to every tracer-emitted path, so a
 * Vite-root-relative path becomes repo-root-relative.
 *
 * Exported and pure so it can be pinned directly — see
 * `__tests__/tracer-path-prefix.test.ts`. Both a missing and an extra segment
 * still name a real-looking file, so an error here mis-attributes edits
 * silently rather than throwing.
 *
 *   same root          -> ""                          (nothing to add)
 *   package in a repo  -> "editor-cli/self-host/"     (add the offset)
 *   vite root ABOVE    -> ""                          (unsupported; no-op
 *                                                      rather than "../")
 */
export function computeTracerPathPrefix(repoRoot: string, viteRoot: string): string {
  const rel = relative(repoRoot, viteRoot).split("\\").join("/")
  return rel && !rel.startsWith("..") ? `${rel}/` : ""
}

export function tracerPlugins(opts: TracerPluginOptions): Plugin[] {
  // Resolve the absolute path to the tracer's client `record.mjs`. The
  // package's `exports` map doesn't expose `package.json`, so resolve the
  // main entry (`dist/index.mjs`) and walk to the sibling client file.
  const require = createRequire(import.meta.url)
  const indexPath = require.resolve("vite-plugin-vue-tracer")
  const recordPath = join(dirname(indexPath), "client/record.mjs")
  const recordDir = dirname(recordPath)

  // The tracer emits `relative(process.cwd(), id)`, and cwd IS the Vite root
  // (core.ts chdirs before we are constructed). So its paths are Vite-root
  // relative, while everything downstream wants REPO-root relative. The
  // difference is exactly `relative(repoRoot, viteRoot)` — empty for a normal
  // single-package repo, `<subdir>` when the prototype is a package inside a
  // larger repo (`editor-cli/self-host` is the in-repo example).
  //
  // This is a PREPEND, not the strip it used to be. Before the chdir, cwd was
  // the launch directory and the tracer emitted a long `../../…` prefix that
  // had to be removed; now it emits a short path that may need extending.
  // Getting this backwards fails SILENTLY — attribution resolves a real file
  // at the wrong path — so `tracer-path-prefix.test.ts` pins both cases.
  const pathPrefix = computeTracerPathPrefix(opts.repoRoot, opts.viteRoot)

  // `VueTracer()` returns `undefined` when disabled (its `enabled` option);
  // with defaults it's active in `serve` mode. Filter so the array is `Plugin[]`.
  return [VueTracer(), tracerClientPlugin(recordPath, recordDir, pathPrefix)].filter(
    (p): p is Plugin => !!p,
  )
}

function tracerClientPlugin(
  recordPath: string,
  recordDir: string,
  pathPrefix: string,
): Plugin {
  // The served client module imports the canonical `record.mjs` via Vite's
  // explicit `/@fs/<abs>` handler — the documented way to fetch a file outside
  // the project root from the browser (Vite 7 also serves a bare absolute path,
  // but `/@fs/` is canonical and version-stable). `fs.allow` (widened below)
  // gates it. JSON.stringify keeps the URL a valid JS string literal. The
  // module also publishes the path prefix the bridge prepends. Paths
  // are posix-ified (`/@fs/` URLs use forward slashes even on Windows).
  const recordUrl = `/@fs/${recordPath.split("\\").join("/").replace(/^\/+/, "")}`
  const clientModule =
    `import * as __tracer from ${JSON.stringify(recordUrl)}\n` +
    `window.__DESDE_TRACER__ = __tracer\n` +
    `window.__DESDE_TRACER_PATH_PREFIX__ = ${JSON.stringify(pathPrefix)}\n`

  return {
    name: "@desde/editor-tracer-client-plugin",
    enforce: "post",
    configResolved(resolved) {
      // The client module (and the tracer-rewritten SFC imports) reach into
      // editor-cli's node_modules, outside the prototype's Vite root, so
      // `/@fs/` would 403 without widening `server.fs.allow`. We PUSH onto the
      // already-resolved allow list rather than declaring it via the `config`
      // hook: explicitly setting `server.fs.allow` disables Vite's automatic
      // inclusion of the project/workspace root (and editor's scratch
      // worktree root), which would break serving the prototype itself.
      const allow = resolved.server.fs.allow
      if (!allow.includes(recordDir)) allow.push(recordDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        if (url.pathname !== TRACER_CLIENT_PATH) {
          next()
          return
        }
        if (!ALLOWED_METHODS.has(req.method ?? "")) {
          res.statusCode = 405
          res.setHeader("Allow", "GET, HEAD")
          res.end()
          return
        }
        res.setHeader("Content-Type", "application/javascript; charset=utf-8")
        res.setHeader("Cache-Control", "no-store")
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
        res.setHeader("X-Content-Type-Options", "nosniff")
        if (req.method === "HEAD") {
          res.end()
          return
        }
        res.end(clientModule)
      })
    },
    transformIndexHtml(html) {
      // External module script, no inline JS — CSP-friendly like the bridge
      // tag. `type="module"` so the static `/@fs/` import resolves; the bridge
      // reads `__DESDE_TRACER__` lazily (on click/hover), long after this
      // deferred module has run, and falls back to `data-desde-src` if absent.
      const tracerTag = `<script data-prototype-flow="tracer-client" type="module" src=${JSON.stringify(
        TRACER_CLIENT_PATH,
      )}></script>`
      if (html.includes("</body>")) {
        return html.replace("</body>", `${tracerTag}\n</body>`)
      }
      return html + tracerTag
    },
  }
}

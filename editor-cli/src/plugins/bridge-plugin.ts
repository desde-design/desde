import { readFileSync, watch as fsWatch, type FSWatcher } from "node:fs"
import type { Plugin, ViteDevServer } from "vite"

export interface BridgeAssetsPluginOptions {
  /** Absolute path to the bridge bundle (`dist/bridge-bundle.js`). */
  bridgeBundlePath: string
  /**
   * Absolute path to `html2canvas.min.js`. When provided, the plugin also serves
   * it at {@link VENDOR_HTML2CANVAS_PATH} on the PROTOTYPE's own origin — not
   * just the shell's. The bridge resolves the vendor URL against
   * `document.referrer || window.location.href`; after the agent navigates the
   * iframe that referrer can become the prototype's own origin, where the shell
   * isn't reachable. Serving it here makes the load succeed either way.
   */
  html2canvasPath?: string
}

export interface BridgePluginOptions extends BridgeAssetsPluginOptions {
  /** Origin the shell will postMessage from. The bridge needs this to filter inbound messages. */
  shellOrigin: string
}

/**
 * Path the bridge bundle is served from inside Vite. The `@`-prefix
 * is a Vite convention for "virtual" or transformed modules; using it
 * keeps the path out of the user's source tree namespace.
 */
const BRIDGE_PATH = "/@desde-bridge.js"

/** Where the bridge loads html2canvas from (same path the shell HTTP server uses). */
const VENDOR_HTML2CANVAS_PATH = "/vendor/html2canvas.min.js"

/** HTTP methods the bridge endpoint allows. Anything else 405s. */
const ALLOWED_BRIDGE_METHODS = new Set(["GET", "HEAD"])

/**
 * Plugin name for the asset half alone. Deliberately distinct from
 * {@link BRIDGE_PLUGIN_NAME}: a server-rendering host installs only that half,
 * and a plugin list (or a Vite error trace) naming the composed plugin there
 * would claim a tag injection that measurably never happens.
 */
const BRIDGE_ASSETS_PLUGIN_NAME = "@desde/editor-bridge-assets"

/** Plugin name for the composed plugin. Unchanged — plain Vite still sees this. */
const BRIDGE_PLUGIN_NAME = "@desde/editor-bridge-plugin"

/**
 * The asset-serving half of {@link bridgePlugin}, plus the one piece of live
 * state the tag-injecting half has to read back.
 */
export interface BridgeAssetsPlugin extends Plugin {
  /**
   * Cache-busted URL of the bundle currently on disk, e.g.
   * `/@desde-bridge.js?v=2026-08-09e`.
   *
   * A method rather than a field because the version changes *under a running
   * server*: `reloadFromDisk` re-reads the bundle when `npm run build:bridge`
   * rewrites it and pushes a full reload. A caller that snapshots this value at
   * construction pins the browser to the stale cache key that very reload
   * exists to break.
   */
  bridgeScridesdeSrc(): string
}

/**
 * Serves the desde bridge runtime — and, optionally, html2canvas — from
 * the prototype's own Vite dev server. **Serving only; nothing is injected into
 * any HTML response.** {@link bridgePlugin} composes this with the tag
 * injection for the one host where injection works.
 *
 * The earlier D-0 implementation inlined the entire ~130 KB bridge
 * bundle into every HTML response. That worked but had two real costs:
 *  1. **CSP**: a strict `script-src` policy without `'unsafe-inline'`
 *     (or per-request nonces) would silently kill the bridge.
 *  2. **No caching**: the browser re-parsed 130 KB on every navigation.
 *
 * The external-file approach gives us both wins:
 *  - The injected `<script src="…">` tag is policy-friendly under
 *    `script-src 'self'` (the bridge is same-origin to the iframe).
 *  - The browser caches the bridge bundle naturally; subsequent loads
 *    only re-parse it when the version-prefixed URL changes.
 *
 * `configureServer` adds a middleware that serves `BRIDGE_PATH` from
 * `bridgeBundlePath` with the right MIME type, exact-pathname matched,
 * GET/HEAD only (S8 in `tasks/dev-server-hosts.md` § 4).
 *
 * **Why this is separable at all.** MEASURED (`tasks/dev-server-hosts.md` § 0a):
 * `transformIndexHtml` fires **zero** times on Astro 7.2.0, Nuxt 4.5.2 and
 * React Router 8.3.0 — in both `ssr:true` and `ssr:false`, on Vite 7.3.6 and
 * 8.2.1 — while the same probe plugin object fires it on a plain Vite SPA. A
 * server-rendering host therefore needs the serving half without the injecting
 * half, and gets its `<script>` tags from the attach proxy's streaming injector
 * (`../attach/inject-stream.ts`) instead. The same measurement confirmed this
 * middleware serves `/@desde-bridge.js` unchanged on all three.
 */
export function bridgeAssetsPlugin(opts: BridgeAssetsPluginOptions): BridgeAssetsPlugin {
  // Live state — re-read on disk change so an `npm run build:bridge`
  // in the parent repo flows through to the running prototype without
  // an editor-cli restart. The URL's `?v=` cache-buster comes from
  // the bundle's `BRIDGE_VERSION` literal, so as long as that gets
  // bumped per bundle, browsers naturally refetch on the next
  // full-reload event we trigger below.
  let bridgeScript = readFileSync(opts.bridgeBundlePath, "utf-8")
  let bridgeVersion = extractBridgeVersion(bridgeScript)
  let versionedBridgePath = makeVersionedPath(bridgeVersion)
  let viteServer: ViteDevServer | null = null
  let watcher: FSWatcher | null = null
  // Lazily-read html2canvas source. `undefined` = not read yet, `null` = the
  // file was missing/unreadable (then we fall through so the request 404s like
  // any unknown path rather than serving a broken script).
  let html2canvasScript: string | null | undefined

  const reloadFromDisk = (): void => {
    try {
      const next = readFileSync(opts.bridgeBundlePath, "utf-8")
      if (next === bridgeScript) return
      bridgeScript = next
      const nextVersion = extractBridgeVersion(next)
      if (nextVersion !== bridgeVersion) {
        bridgeVersion = nextVersion
        versionedBridgePath = makeVersionedPath(nextVersion)
      }
      // Push a full reload so the iframe re-requests the bridge URL
      // (and, when the version changed, picks up the new cache key).
      // The injected `<script>` tag's `src` is only re-evaluated on
      // page load, so a hot module update wouldn't get there.
      viteServer?.ws.send({ type: "full-reload", path: "*" })
    } catch {
      // Bundle was rewritten atomically and `readFileSync` raced with
      // the writer, or the file was deleted. Either way, the next
      // request will serve from the last-good cache; surfacing this
      // would noise the dev console for a transient.
    }
  }

  return {
    name: BRIDGE_ASSETS_PLUGIN_NAME,
    enforce: "post",
    bridgeScridesdeSrc: () => versionedBridgePath,
    configureServer(server) {
      viteServer = server
      // fs.watch + reloadFromDisk is the pair that makes
      // `npm run build:bridge` flow through to the running iframe
      // without an editor-cli restart. Atomic rewrites (esbuild does
      // this) fire `rename`; in-place writes fire `change`. We treat
      // both the same — read, diff, push reload if changed.
      try {
        watcher = fsWatch(opts.bridgeBundlePath, () => reloadFromDisk())
      } catch {
        // Watching can fail on some filesystems (NFS, certain
        // containerized environments). Without the watcher, the
        // editor still serves the bundle that was on disk at
        // startup — the legacy behavior.
      }
      server.middlewares.use((req, res, next) => {
        // Exact-pathname match: parse the URL and compare just `pathname`.
        // The earlier `startsWith(BRIDGE_PATH)` was too loose — it would
        // also match `/@desde-bridge.js.map`, `/@desde-bridge.jsX`,
        // etc., and could shadow legitimate user files. The `?v=…` query
        // string is harmless because we only inspect pathname.
        const url = parseRequestUrl(req)
        // Serve html2canvas from the PROTOTYPE origin so the bridge's screenshot
        // capture loads it whether its computed origin is the shell or the
        // prototype itself (see html2canvasPath docs). GET/HEAD only; falls
        // through to a 404 if the file isn't configured/readable.
        if (url.pathname === VENDOR_HTML2CANVAS_PATH && opts.html2canvasPath) {
          if (!ALLOWED_BRIDGE_METHODS.has(req.method ?? "")) {
            res.statusCode = 405
            res.setHeader("Allow", "GET, HEAD")
            res.end()
            return
          }
          if (html2canvasScript === undefined) {
            try {
              html2canvasScript = readFileSync(opts.html2canvasPath, "utf-8")
            } catch {
              html2canvasScript = null
            }
          }
          if (html2canvasScript === null) {
            next()
            return
          }
          res.setHeader("Content-Type", "application/javascript; charset=utf-8")
          res.setHeader("Cache-Control", "public, max-age=86400")
          res.setHeader("X-Content-Type-Options", "nosniff")
          if (req.method === "HEAD") {
            res.end()
            return
          }
          res.end(html2canvasScript)
          return
        }
        if (url.pathname !== BRIDGE_PATH) {
          next()
          return
        }
        if (!ALLOWED_BRIDGE_METHODS.has(req.method ?? "")) {
          res.statusCode = 405
          res.setHeader("Allow", "GET, HEAD")
          res.end()
          return
        }
        res.setHeader("Content-Type", "application/javascript; charset=utf-8")
        // No-store in dev so a stale browser cache can't shadow an
        // in-progress bridge edit. The version-prefixed URL is the
        // cache key for prod; the cost of `no-store` in dev is one
        // refetch per iframe reload.
        res.setHeader("Cache-Control", "no-store")
        // The bridge is non-sensitive (no per-session secrets), but keep
        // it cross-origin-isolated so it can't be embedded as a script
        // by an unrelated origin in pursuit of side-channel signals.
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
        res.setHeader("X-Content-Type-Options", "nosniff")
        if (req.method === "HEAD") {
          res.end()
          return
        }
        res.end(bridgeScript)
      })
    },
    closeBundle() {
      watcher?.close()
      watcher = null
      viteServer = null
    },
  }
}

/**
 * The shipped plugin: {@link bridgeAssetsPlugin} plus the `transformIndexHtml`
 * that references what it serves. Plain Vite is the only host this is used on —
 * see the MEASURED note on the assets plugin for why.
 *
 * Composed by object spread rather than by re-implementing the hooks, so the
 * asset half is the *same closure* either way: one live bundle, one watcher,
 * one reload path, whether or not the tags are injected here.
 *
 * `transformIndexHtml` injects the external `<script src="…">` for the bundle
 * carrying a `data-shell-origin` attribute, plus (for compatibility) the legacy
 * inline config script publishing `window.__DESDE_SHELL_ORIGIN__`. The
 * bridge reads the shell origin to validate inbound `postMessage` origins and to
 * address outbound posts (see "postMessage origin discipline" in
 * `src/bridge/comment-bridge.ts`). This mirrors the viewer's serve layer
 * (`viewer/server/serve/html-inject.ts`) and, for the hosts that cannot use this
 * hook at all, `../attach/bridge-tags.ts`.
 *
 * **The attribute is authoritative, not the inline tag.** A prototype serving
 * `script-src 'self'` without `'unsafe-inline'` drops the inline tag while the
 * external bundle tag loads normally — which used to leave the bridge with no
 * configured origin, and (until it was made to fail closed) accepting and
 * answering postMessages from any framing page. An attribute on the external tag
 * is markup, not script: no CSP strips it. The inline tag is kept only so a
 * bundle predating the attribute still gets an origin.
 */
export function bridgePlugin(opts: BridgePluginOptions): Plugin {
  const assets = bridgeAssetsPlugin(opts)
  return {
    ...assets,
    // After the spread: the composed plugin keeps the name it has always had,
    // so nothing reading a Vite plugin list or error trace sees a rename.
    name: BRIDGE_PLUGIN_NAME,
    transformIndexHtml(html) {
      // Serve-time only — Vite transforms the HTML response in memory;
      // nothing here is ever written to the user's repo.
      //
      // The config tag precedes the bundle tag. It is the COMPATIBILITY
      // path only: a prototype serving a strict CSP without
      // `'unsafe-inline'` drops it, which is exactly why the shell origin
      // also rides on the bundle tag's `data-shell-origin` attribute below.
      // The bridge prefers the attribute and falls back to this global.
      const configTag =
        `<script data-prototype-flow="config">` +
        `window.__DESDE_SHELL_ORIGIN__=${escapeForInlineScript(opts.shellOrigin)};` +
        `</script>`
      // `bridgeScridesdeSrc()` is called per HTML response, not hoisted, so a
      // bundle rebuild between server startup and the current request uses the
      // up-to-date version in the cache-buster query.
      //
      // `data-shell-origin` is the AUTHORITATIVE origin channel — an
      // attribute on an external script survives any CSP, so the bridge can
      // fail closed on an unresolvable origin without a strict-CSP prototype
      // becoming collateral damage.
      const bridgeTag =
        `<script data-prototype-flow="bridge" ` +
        `data-shell-origin="${escapeForHtmlAttribute(opts.shellOrigin)}" ` +
        `src=${JSON.stringify(assets.bridgeScridesdeSrc())} defer></script>`
      const injection = `${configTag}\n${bridgeTag}`

      if (html.includes("</body>")) {
        return html.replace("</body>", `${injection}\n</body>`)
      }
      return html + injection
    },
  }
}

/**
 * Serialize a string for embedding inside an inline `<script>` body.
 * `JSON.stringify` handles quoting/escaping; `<` is additionally escaped
 * so no value can close the script element early (`</script>`).
 */
function escapeForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/**
 * Serialize a string for a double-quoted HTML attribute value. `&` first so
 * the entities introduced after it aren't double-escaped; `"` is what would
 * otherwise close the attribute, and `<`/`>` keep a value from being read as
 * markup by a lenient parser.
 */
function escapeForHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Pull `BRIDGE_VERSION` out of a built bundle.
 *
 * Minified bundles (`build:bridge` runs esbuild with `--minify`) inline
 * and rename the `const BRIDGE_VERSION` binding, so the only reliable
 * anchor is the global assignment the bridge makes on the next line:
 * `window.__DESDE_BRIDGE_VERSION__ = BRIDGE_VERSION`, which minifies
 * to `…__DESDE_BRIDGE_VERSION__="<version>"`. The unminified
 * `BRIDGE_VERSION = "…"` form is kept as a fallback so a hand-built or
 * non-minified bundle still reports its version.
 */
function extractBridgeVersion(script: string): string {
  const global = script.match(/__DESDE_BRIDGE_VERSION__\s*=\s*["']([^"']+)["']/)
  if (global?.[1]) return global[1]
  const declaration = script.match(/BRIDGE_VERSION\s*=\s*["']([^"']+)["']/)
  return declaration?.[1] ?? "unknown"
}

function makeVersionedPath(version: string): string {
  return `${BRIDGE_PATH}?v=${encodeURIComponent(version)}`
}

/** Exposed for the supervisor's smoke test ("did the right version load?"). */
export function readBridgeVersion(bridgeBundlePath: string): string {
  return extractBridgeVersion(readFileSync(bridgeBundlePath, "utf-8"))
}

interface RequestWithUrl {
  url?: string
}

/** Parse req.url defensively. Vite middleware reqs always have a url. */
function parseRequestUrl(req: RequestWithUrl): URL {
  // Use a dummy origin to satisfy the URL constructor; we only read
  // pathname and don't care what the host is.
  return new URL(req.url ?? "/", "http://localhost")
}

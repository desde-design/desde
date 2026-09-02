/**
 * The exact two `<script>` tags `bridgePlugin.transformIndexHtml` injects,
 * built for a server that is not Vite.
 *
 * **Both tags matter, and the attribute matters most.** MEASURED in the spike
 * (`tasks/next-attach-mode-spike.md` §3): serving the bundle without the config
 * tag produced *zero* bridge messages, because the bridge had no shell origin.
 * Since then the bridge was made to fail CLOSED on an unresolvable origin
 * (`docs/bridge-protocol.md` § "postMessage origin discipline"), so the failure
 * mode is now a silent bridge rather than a promiscuous one — worse to debug,
 * identical to diagnose: no `data-shell-origin`, no bridge.
 *
 * `data-shell-origin` on the external tag is the AUTHORITATIVE channel and the
 * inline global is the compatibility one, because attach mode injects into a
 * response we did not author: an app serving `script-src 'self'` without
 * `'unsafe-inline'` keeps the external tag and drops the inline one. An
 * attribute is markup, not script, so no CSP strips it.
 *
 * The escaping helpers below mirror the private ones in
 * `../plugins/bridge-plugin.ts`. They are duplicated rather than shared because
 * the two injectors have no common module today; if a third appears, hoist
 * them. Any change to one must be made to the other — the tags are compared
 * byte-for-byte by `bridge-tags.test.ts`.
 */

/** Where the proxy serves html2canvas. Fixed: the bridge computes this path. */
export const VENDOR_HTML2CANVAS_PATH = "/vendor/html2canvas.min.js"

/**
 * Namespace for the two files the proxy serves of its own. Distinct from
 * `.desde` (which the proxy REFUSES) — one leading dot versus two
 * underscores, and nothing else lives under either.
 */
export const BRIDGE_PATH_PREFIX = "/__desde/bridge-"

/**
 * Version-stamped bridge URL, e.g. `/__desde/bridge-2026-08-09e.js`.
 *
 * The version is in the PATH rather than a `?v=` query (which is what the Vite
 * plugin uses) because attach mode has no websocket of its own to push a
 * full-reload on after a bundle rebuild: a distinct path is a cache key no
 * intermediary can collapse, so the next navigation cannot be served a stale
 * bundle out of the browser cache.
 */
export function bridgeScriptPath(version: string): string {
  return `${BRIDGE_PATH_PREFIX}${encodeURIComponent(version)}.js`
}

/** True for any versioned bridge URL, current or stale. See `proxy.ts`. */
export function isBridgeScriptPath(pathname: string): boolean {
  return pathname.startsWith(BRIDGE_PATH_PREFIX) && pathname.endsWith(".js")
}

/**
 * The injected markup: inline config tag, newline, external bundle tag.
 * Identical in shape to `bridgePlugin`'s `injection`.
 */
export function buildBridgeTags(shellOrigin: string, version: string): string {
  const configTag =
    `<script data-prototype-flow="config">` +
    `window.__DESDE_SHELL_ORIGIN__=${escapeForInlineScript(shellOrigin)};` +
    `</script>`
  const bridgeTag =
    `<script data-prototype-flow="bridge" ` +
    `data-shell-origin="${escapeForHtmlAttribute(shellOrigin)}" ` +
    `src=${JSON.stringify(bridgeScriptPath(version))} defer></script>`
  return `${configTag}\n${bridgeTag}\n`
}

/**
 * Serialize for an inline `<script>` body. `JSON.stringify` quotes and escapes;
 * `<` is additionally escaped so no value can close the element early.
 */
function escapeForInlineScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/**
 * Serialize for a double-quoted HTML attribute. `&` first so the entities
 * introduced after it are not double-escaped.
 */
function escapeForHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

import type { Plugin, ViteDevServer } from "vite"

/**
 * The ONE channel by which the pipeline gets hold of the `ViteDevServer`s a
 * Vite-family host created.
 *
 * **Why a sink and not a return value.** Four of the six hosts run Vite, and
 * only one of them (`vite`) hands us the server object directly — Nuxt, Astro
 * and React Router each own their own `createServer` call and return something
 * else. A plugin's `configureServer` hook is the one seam all four share.
 *
 * **Why a LIST and not a `let server`.** MEASURED on Nuxt (`tasks/dev-server-hosts.md`
 * § 1, `HostHmr`): `configureServer` fires TWICE, with two different watchers
 * AND two different module graphs (`build.ssr` false / true). A single-slot
 * capture is last-write-wins, and pushing an edit into the client lane alone
 * leaves the SSR lane serving stale HTML. Collecting every server is what makes
 * plural invalidation expressible at all.
 *
 * Nothing here is Vite-version-sensitive: `configureServer` is Vite's oldest
 * public server hook.
 */
export interface ViteServerCapture {
  /**
   * Every server whose `configureServer` ran, in the order Vite called them.
   * Empty until the host boots.
   */
  readonly servers: readonly ViteDevServer[]
  /** The plugin to add to the injected array. Safe to add once per boot. */
  plugin(): Plugin
}

export function createViteCapture(): ViteServerCapture {
  const servers: ViteDevServer[] = []
  return {
    // The returned object aliases the same array the hook pushes into, so a
    // caller that reads `servers` after boot sees what was captured. Typed
    // `readonly` so a caller cannot push a server we never saw.
    servers,
    plugin: () => ({
      name: "@desde/editor-vite-capture",
      configureServer(server) {
        servers.push(server)
      },
    }),
  }
}

import type { InlineConfig, Plugin, ResolvedConfig } from "vite"
import { defaultAllowedOrigins } from "vite"
import { hardenServerConfig, type ServerHardeningReport } from "./vite-supervisor.js"

/**
 * The security pins of {@link hardenServerConfig}, re-applied from inside
 * Vite's own plugin pipeline.
 *
 * **Why this exists, measured.** `hardenServerConfig` pins its keys on the
 * InlineConfig handed to `createServer`. Every plugin hook runs *after* that,
 * so a plugin in the repo's own `vite.config` can simply undo the pins. With a
 * six-line `configResolved` hook, MEASURED against this checkout:
 *
 * ```
 * RESOLVED fs.strict=false  fs.deny=[]  fs.allow=["/"]  allowedHosts=true
 * GET /@fs<root>/.env                  -> 200   (SECRET_TOKEN=hunter2)
 * GET /@fs<root>/.desde/…/s1.json -> 200   (chat transcript)
 * GET / with Host: evil.test           -> 200   (host validation skipped)
 * ```
 *
 * **What this does and does not defend against.** A `vite.config` is arbitrary
 * Node executed in our process by `loadConfigFromFile` — an author who wants to
 * read the developer's disk can do it directly and never touch Vite's config.
 * So this is NOT a sandbox for hostile configs, and must not be described as
 * one. What it closes is *accidental* widening: the `fs.allow: ['/']` or
 * `allowedHosts: true` a real plugin or a hurried developer leaves behind. The
 * `allowedHosts` pin is the one that carries most of the weight, because host
 * validation is what stops a DNS-rebound page on the open web from reaching a
 * dev server bound to loopback — it converts a local misconfiguration into
 * remote file read.
 *
 * **Why two hooks, not one.** They cover disjoint keys and neither is
 * sufficient alone:
 *
 *  - `config` (order `post`, so it runs after every repo plugin's `config`)
 *    is the only place `fs.deny` can be won. Vite compiles the deny list into
 *    a picomatch matcher during `resolveConfig`, and `isFileLoadingAllowed`
 *    consults that matcher rather than re-reading the array — so a `deny`
 *    assigned later is inert. Pinning here has the pleasing corollary that a
 *    repo plugin clearing `deny` in its own `configResolved` is *also* inert.
 *  - `configResolved` (order `post`) covers the keys that ARE read live per
 *    request — `cors`, `allowedHosts`, `fs.strict` — and is what actually
 *    closes the bypass above.
 *
 * **`fs.allow` is deliberately left alone**, matching `hardenServerConfig`:
 * widening the allow LIST is the supported escape hatch for a prototype that
 * legitimately imports from a sibling directory, and it grants reach without
 * disabling the deny glob.
 */
export interface HardenPluginOptions {
  /**
   * When true, the plugin owns the boot-time "we narrowed your config" report.
   * Left false on the supervised Vite path, where `bootSupervisor`'s existing
   * pre-merge `hardenServerConfig` call is already the single reporter and a
   * second one would double-log every key.
   */
  reportOverrides?: boolean
  /** Receives the report when {@link reportOverrides} is on. */
  onReport?: (report: ServerHardeningReport) => void
}

export function hardenPlugin(opts: HardenPluginOptions = {}): Plugin {
  return {
    name: "@desde/editor-harden",
    // `post` puts us last among plugins that did not ask for an explicit
    // order, and `mergeConfig` concatenates our plugin array AFTER the repo's,
    // so within the post bucket we are last by array position too.
    enforce: "post",
    config: {
      order: "post",
      handler(config) {
        // Mutate in place and return `undefined` ON PURPOSE. Returning a
        // partial config makes Vite feed it back through `mergeConfig`, whose
        // dedicated `allowedHosts` rule lets `true` on EITHER side win — which
        // would silently discard the very pin we are here to apply.
        const report = hardenServerConfig(
          config as InlineConfig,
          // Snapshot the pre-mutation server block so the report describes
          // what THIS hook took away. Taken from the live config rather than
          // the repo's file config, which means it also catches a widening
          // injected by another plugin — invisible to a file-based check.
          config.server ? ({ server: { ...config.server } } as InlineConfig) : null,
        )
        if (opts.reportOverrides) opts.onReport?.(report)
        return undefined
      },
    },
    configResolved: {
      order: "post",
      handler(resolved: ResolvedConfig) {
        // `ResolvedServerOptions` is typed as fully-resolved, so these
        // assignments are narrowing an already-required field back to our
        // value rather than filling a hole. The cast is only to shed
        // `readonly`; the shapes are Vite's own.
        const server = resolved.server as {
          cors?: unknown
          allowedHosts?: unknown
          fs?: { strict?: boolean }
        }
        server.cors = { origin: defaultAllowedOrigins }
        server.allowedHosts = []
        if (server.fs) server.fs.strict = true
        // `fs.deny` is NOT re-pinned here: the matcher is already compiled by
        // this point, so writing the array would be theatre. The `config` hook
        // above is what makes the deny list stick.
      },
    },
  }
}

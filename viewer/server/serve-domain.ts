import type { ViewerConfig } from "./config"

/**
 * The serve domain routing and allowlisting use: the configured one, else the
 * derived local one.
 *
 * Its own module, and not a function inside `config.ts`, for one reason: the
 * gallery. `viewer/gallery/harness/shims/server-config.ts` replaces
 * `server/config` for browser rendering, because the real module imports
 * `node:crypto` and reads `process.env`. Two server components call this
 * function through that module, so the shim has to provide it — and the only
 * ways to do that are to keep a second copy in the shim, or to put the real
 * one somewhere a browser bundle can reach. A leaf file with no Node imports
 * is that somewhere.
 *
 * `config.ts` re-exports it, so every existing caller keeps importing it from
 * there and nothing at a call site had to change.
 *
 * The `ViewerConfig` import is type-only and erased at build time, so this
 * file pulls no runtime dependency back in.
 */
export function effectiveServeDomain(
  config: Pick<ViewerConfig, "serveDomain" | "localServeDomain">,
): string | null {
  return config.serveDomain ?? config.localServeDomain
}

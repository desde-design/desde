/**
 * The boot-time line(s) that tell an operator which origin mode this
 * deployment is running in — loopback, subdomain, or fallback — computed
 * from config alone, before any request has been served.
 *
 * Kept as a pure function, separate from `server/index.ts`, so the exact
 * text is unit-tested without booting a real server (no listener, no Next
 * app, no storage). `server/index.ts` calls this once, inside the
 * `app.listen` callback, and chooses `console.log` or `console.warn` per
 * line based on `mode` — this module does not touch the console itself.
 *
 * Mode is decided the same way the resolver decides it for a real request:
 * `resolveOrigins` with `hostAllowed: false` and `hostIsPrototype: false`,
 * which forces it to fall back to `publicUrl` for both the mode and the
 * shell origin — the "config-only view" the same function offers a real
 * request when there is no allowed Host to trust. See
 * `prototype-origin-resolve.ts`'s own doc comment for why that fallback
 * exists.
 */

import type { ViewerConfig } from "../config"
import { pairedLoopbackHost, resolveOrigins, type OriginMode } from "./prototype-origin-resolve"

export interface OriginModeBanner {
  mode: OriginMode
  /** One line for loopback/subdomain/prototype-origin, two for fallback. No trailing newline. */
  lines: string[]
}

/**
 * The extra line printed when `loopbackAvailable` is what turned a shell
 * that would have been loopback mode into fallback instead — the
 * Docker/remote case (NEXT.md §17). Kept as a named constant so the "does
 * NOT print it for an unrelated fallback" test can assert its absence by
 * the same string the "does print it" test asserts its presence with.
 *
 * Plain language, no em dashes: same house style as the two fallback lines
 * beside it.
 */
const LOOPBACK_DISABLED_LINE =
  "[viewer] Loopback prototype listeners are disabled here (VIEWER_LOOPBACK_LISTENERS=auto detected " +
  "a container, or =off). Prototypes fall back to same-host path mode; root-absolute assets may not " +
  "fully load for signed-in members. For real isolation set VIEWER_SERVE_DOMAIN. If the browser " +
  "shares this host (host-network mode) set VIEWER_LOOPBACK_LISTENERS=on."

export function originModeBannerLines(
  config: Pick<ViewerConfig, "publicUrl" | "serveDomain" | "loopbackAvailable"> & {
    // Optional here (not on the required `Pick`) so the many existing callers
    // that never configure `VIEWER_PROTOTYPE_ORIGIN` need no edit; a full
    // `ViewerConfig` (what `server/index.ts` passes) satisfies it. Absent
    // reads as unset, which is the safe default — the mode is never
    // prototype-origin.
    prototypeOrigin?: string | null
  },
): OriginModeBanner {
  const resolved = resolveOrigins({
    requestHost: undefined,
    hostAllowed: false,
    hostIsPrototype: false,
    publicUrl: config.publicUrl,
    serveDomain: config.serveDomain,
    loopbackAvailable: config.loopbackAvailable,
    prototypeOrigin: config.prototypeOrigin,
  })

  // Was this shell downgraded from loopback to fallback specifically
  // because `loopbackAvailable` is false — as opposed to a shell that was
  // never going to be loopback mode at all (a public hostname, or an https
  // loopback shell)? Answered by re-resolving with `loopbackAvailable: true`
  // held fixed and comparing, rather than re-deriving the loopback-shell
  // predicate here: `resolveOrigins` already computes it, and a second copy
  // of "http + one of the three loopback spellings" is exactly how the two
  // checks would eventually disagree.
  const wouldHaveBeenLoopback =
    !config.loopbackAvailable &&
    resolveOrigins({
      requestHost: undefined,
      hostAllowed: false,
      hostIsPrototype: false,
      publicUrl: config.publicUrl,
      serveDomain: config.serveDomain,
      loopbackAvailable: true,
      prototypeOrigin: config.prototypeOrigin,
    }).mode === "loopback"

  if (resolved.mode === "prototype-origin") {
    return {
      mode: "prototype-origin",
      lines: [
        `[viewer] prototypes are served from a single shared origin: ${config.prototypeOrigin}`,
        `[viewer] All prototypes share that one origin, so they can read each other's storage and ` +
          `cookies. For per-prototype isolation set VIEWER_SERVE_DOMAIN. Subdomain mode is stronger.`,
      ],
    }
  }

  if (resolved.mode === "subdomain") {
    const scheme = new URL(resolved.shellOrigin).protocol
    return {
      mode: "subdomain",
      lines: [
        `[viewer] prototypes are served on their own subdomain: ${scheme}//{slug}.${config.serveDomain}`,
      ],
    }
  }

  if (resolved.mode === "loopback") {
    const scheme = new URL(resolved.shellOrigin).protocol
    // resolveOrigins only reports "loopback" for a shell hostname that is
    // one of the three loopback spellings, so pairedLoopbackHost's result
    // here is never null — asserted below rather than silently emitting
    // "null" into the banner if that contract were ever broken.
    const shellHostname = new URL(resolved.shellOrigin).hostname
    const prototypeHost = pairedLoopbackHost(shellHostname)
    if (!prototypeHost) {
      throw new Error(
        `originModeBannerLines: resolveOrigins reported loopback mode for a non-loopback ` +
          `shell hostname "${shellHostname}". This is a bug in resolveOrigins, not in config.`,
      )
    }
    return {
      mode: "loopback",
      lines: [
        `[viewer] prototypes are served from the other loopback name on an ephemeral port ` +
          `(shell=${resolved.shellOrigin} prototypes=${scheme}//${prototypeHost}:<ephemeral>)`,
        `[viewer] Loopback prototype listeners are reachable only from a browser on this same host. ` +
          `A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.`,
      ],
    }
  }

  return {
    mode: "fallback",
    lines: [
      "[viewer] Prototypes built with a root-absolute asset base will not fully load for signed-in members in this mode.",
      "[viewer] Fix: set VIEWER_SERVE_DOMAIN (one wildcard DNS record), or build prototypes with a relative base.",
      ...(wouldHaveBeenLoopback ? [LOOPBACK_DISABLED_LINE] : []),
    ],
  }
}

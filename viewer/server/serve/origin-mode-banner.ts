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

/**
 * Codex round 10, Fix 2. Printed in loopback mode, alongside (never instead
 * of) the listener lines, when a container was detected but
 * `isLikelyBridgedNamespace()` could not recognise the network layout — the
 * listener still opened (so this is NOT the downgrade-to-fallback case
 * `LOOPBACK_DISABLED_LINE` covers), it just stayed on the container's own
 * loopback instead of widening to every interface. Plain language, no em
 * dashes, same house style as the line beside it.
 */
const NETWORK_LAYOUT_UNRECOGNIZED_LINE =
  "[viewer] Prototype ports stay on the container's own loopback because the network layout was " +
  "not recognised. If the viewer is in Docker with -p published ports, set VIEWER_LOOPBACK_BIND=all."

export function originModeBannerLines(
  config: Pick<ViewerConfig, "publicUrl" | "serveDomain" | "loopbackAvailable"> & {
    // Optional here (not on the required `Pick`) so the many existing callers
    // that never configure `VIEWER_PROTOTYPE_ORIGIN` need no edit; a full
    // `ViewerConfig` (what `server/index.ts` passes) satisfies it. Absent
    // reads as unset, which is the safe default — the mode is never
    // prototype-origin.
    prototypeOrigin?: string | null
    // Same reasoning as `prototypeOrigin` above: optional here, not on the
    // required `Pick`, so existing callers that never configure
    // `VIEWER_LOOPBACK_PORT_RANGE` need no edit. Absent or null means no
    // fixed range is configured, so no extra line is printed.
    loopbackPortRange?: { from: number; to: number } | null
    // Same reasoning again: optional, so callers that never configure
    // `loopbackBindAllInterfaces` need no edit. Absent reads as `false` —
    // the pairing named below keeps offering `[::1]`, exactly as it did
    // before this field existed.
    loopbackBindAllInterfaces?: boolean
    // Optional, same reasoning: absent reads as `false`, so a caller that
    // never configures it (every existing one) gets no extra line, exactly
    // as before this field existed (codex round 10, Fix 2).
    loopbackBindNetworkUnrecognized?: boolean
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
    // The same pairing the route makes, told the same bind-all-interfaces
    // fact — a genuinely detected container binds the IPv4 wildcard, so the
    // pairing never names `[::1]` there and neither may this line. NOT the
    // same as "a range is configured": an explicit range on a laptop that is
    // not a container leaves the bind on loopback, so `[::1]` still answers.
    const prototypeHost = pairedLoopbackHost(shellHostname, {
      bindAllInterfaces: Boolean(config.loopbackBindAllInterfaces),
    })
    if (!prototypeHost) {
      throw new Error(
        `originModeBannerLines: resolveOrigins reported loopback mode for a non-loopback ` +
          `shell hostname "${shellHostname}". This is a bug in resolveOrigins, not in config.`,
      )
    }
    // A configured range and an ephemeral port are different facts, and this
    // line used to state the ephemeral one even when the line below it named
    // the range — two consecutive lines telling an operator two different
    // things about the same port (live acceptance finding, 2026-09-11).
    const range = config.loopbackPortRange
    const portPhrase = range ? "a port from the range below" : "an ephemeral port"
    const portSpelling = range ? `<${range.from}-${range.to}>` : "<ephemeral>"
    return {
      mode: "loopback",
      lines: [
        `[viewer] prototypes are served from the other loopback name on ${portPhrase} ` +
          `(shell=${resolved.shellOrigin} prototypes=${scheme}//${prototypeHost}:${portSpelling})`,
        // This line used to say listeners are "reachable only from a browser
        // on this same host". Inside a container that is not true: the socket
        // is on every interface there (see `loopback-listeners.ts`'s
        // `open()`), and what keeps the published ports off the network is
        // the `127.0.0.1:` prefix on the -p flag the next line prints.
        range
          ? `[viewer] Loopback prototype listeners are meant for a browser on this same machine. ` +
            `Inside a container the socket is on every interface, so publish the ports to this machine's ` +
            `loopback, as the next line shows. A remote deployment should set VIEWER_SERVE_DOMAIN, or a ` +
            `non-loopback VIEWER_PUBLIC_URL.`
          : `[viewer] Loopback prototype listeners are meant for a browser on this same machine. ` +
            `A containerized or remote deployment should set VIEWER_SERVE_DOMAIN, or a non-loopback VIEWER_PUBLIC_URL.`,
        ...(range
          ? [
              `[viewer] Loopback prototype ports: ${range.from}-${range.to}. ` +
                `In Docker, publish them to this machine's loopback: ` +
                `-p 127.0.0.1:${range.from}-${range.to}:${range.from}-${range.to}`,
            ]
          : []),
        // Codex round 6, Fix 1. `loopbackBindAllInterfaces` means the socket
        // is on every interface, not just loopback — worth saying on its
        // own, separate from the range line above, because a `--network
        // host` operator needs the opposite of what that line recommends:
        // turning the wide bind OFF, not publishing it.
        ...(config.loopbackBindAllInterfaces
          ? [
              `[viewer] Prototype ports bind every interface so Docker can publish them. ` +
                `On --network host set VIEWER_LOOPBACK_BIND=loopback.`,
            ]
          : []),
        // Codex round 10, Fix 2. The OTHER side of the same `auto` decision:
        // a container was detected, but the network layout was not
        // positively recognised as bridged, so the bind stayed narrow. An
        // operator publishing ports with `-p` needs to know why they are
        // unreachable and what to set instead — mutually exclusive with the
        // line above, since only one of the two conditions can hold.
        ...(config.loopbackBindNetworkUnrecognized ? [NETWORK_LAYOUT_UNRECOGNIZED_LINE] : []),
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

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

import type { ViewerConfig, ViewerLoopbackBindMode } from "../config"
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
 * `isLikelyBridgedNamespace()` could not recognise the network layout AND
 * the bind stayed narrow as a result — the listener still opened (so this is
 * NOT the downgrade-to-fallback case `LOOPBACK_DISABLED_LINE` covers), it
 * just stayed on the container's own loopback instead of widening to every
 * interface. Plain language, no em dashes, same house style as the line
 * beside it.
 *
 * When the bind is wide INSTEAD (an operator or the Docker image forced
 * `VIEWER_LOOPBACK_BIND=all` on that same unrecognised layout), this line
 * does not print — `WIDE_BIND_NETWORK_UNRECOGNIZED_LINE` below does, since
 * the fix it names is the opposite one. See `pickBindLine`.
 */
const NETWORK_LAYOUT_UNRECOGNIZED_LINE =
  "[viewer] Prototype ports stay on the container's own loopback because the network layout was " +
  "not recognised. If the viewer is in Docker with -p published ports, set VIEWER_LOOPBACK_BIND=all."

/**
 * Server-prototypes rework, Task 5. The Docker image now states its bind
 * explicitly (`ENV VIEWER_LOOPBACK_BIND=all`) rather than leaving container
 * detection to decide it — so the bind can be wide on a container whose
 * layout is NOT recognised as bridged: a `--network host` container running
 * the image without overriding the bind back to `loopback`, or a runtime
 * (Podman) the heuristic does not recognise either way. Printed instead of
 * (never alongside) the plain wide-bind line below, and instead of (never
 * alongside) `NETWORK_LAYOUT_UNRECOGNIZED_LINE` above — see `pickBindLine`.
 *
 * It names the CONDITION, not the runtime. The line used to tell anyone on an
 * unrecognised layout to set `loopback`, Podman included — and a rootless
 * Podman container's interface is `tap0`, so a perfectly correct
 * `podman run -p 127.0.0.1:3101-3120:3101-3120` lands here. An operator who
 * followed that advice broke every published port, and the README three
 * lines from the run command said the opposite (round 12, I5). Published
 * ports need the wide bind; only host networking does not.
 */
const WIDE_BIND_NETWORK_UNRECOGNIZED_LINE =
  "[viewer] Prototype ports bind every interface (VIEWER_LOOPBACK_BIND=all) and the network " +
  "layout was not recognised. With -p published ports that is right. On --network host set " +
  "VIEWER_LOOPBACK_BIND=loopback."

/**
 * The one line, if any, about `loopbackBindAllInterfaces` /
 * `loopbackBindNetworkUnrecognized`. The two booleans cross into four
 * combinations and at most one line ever applies (task-5-brief.md,
 * decision 2):
 *
 * - wide bind, layout unrecognised → the Task 5 warning (something is
 *   probably wrong: the operator or the image forced a bind this check
 *   cannot confirm is safe or reachable).
 * - wide bind, layout recognised (or bind forced by hand with nothing to
 *   contradict it) → the plain informational wide-bind line.
 * - narrow bind, layout unrecognised → the round-10 line (the bind COULD
 *   have widened but didn't, because the check could not confirm it).
 * - narrow bind, layout recognised or no container at all → nothing to say.
 */
function pickBindLine(
  bindAllInterfaces: boolean,
  networkUnrecognized: boolean,
  bind: ViewerLoopbackBindMode,
): string[] {
  if (bindAllInterfaces && networkUnrecognized) {
    return [WIDE_BIND_NETWORK_UNRECOGNIZED_LINE]
  }
  if (bindAllInterfaces) {
    return [
      "[viewer] Prototype ports bind every interface so Docker can publish them. " +
        "On --network host set VIEWER_LOOPBACK_BIND=loopback.",
    ]
  }
  // Only the DEFAULT's own choice is worth second-guessing: an operator who
  // wrote `loopback` meant it, and telling them to set `all` would be noise
  // on top of a deliberate decision (Task 5 review).
  if (networkUnrecognized && bind === "auto") {
    return [NETWORK_LAYOUT_UNRECOGNIZED_LINE]
  }
  return []
}

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
    // as before this field existed (codex round 10, Fix 2). After the Task 5
    // widening this can now be `true` together with `loopbackBindAllInterfaces:
    // true` — see `pickBindLine` for which line each combination prints.
    loopbackBindNetworkUnrecognized?: boolean
    /** The operator's bind mode; absent reads as the default, `auto`. */
    loopbackBind?: ViewerLoopbackBindMode
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
        // Codex round 6, Fix 1 (the plain wide-bind line) and round 10, Fix 2
        // (the narrow-bind-but-unrecognised line), joined by the Task 5
        // warning for the fourth combination the rework introduced: wide
        // bind, layout unrecognised. `pickBindLine` returns at most one line
        // — see its own doc comment for the four cases.
        ...pickBindLine(
          Boolean(config.loopbackBindAllInterfaces),
          Boolean(config.loopbackBindNetworkUnrecognized),
          config.loopbackBind ?? "auto",
        ),
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

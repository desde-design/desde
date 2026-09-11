/**
 * Whether to warn a reviewer that the loopback port their prototype is
 * served on may be unreachable from their browser.
 *
 * The case this catches: the viewer runs inside Docker, and the operator
 * did not publish the loopback listener's ephemeral port range with `-p`.
 * The listener opens fine INSIDE the container, the review page's iframe
 * points at it, and nothing on the server side ever sees a failure — the
 * request just never reaches the container from the host.
 *
 * **This used to key off the iframe's own `onLoad` and the bridge
 * handshake, and that was wrong.** On the HOST machine, a browser reaching a
 * loopback port with nothing listening on it gets an INSTANT refusal, not a
 * hang — and Chromium (measured) fires the iframe's `load` event on that
 * failed navigation's own error page just as it would for a real page. So
 * `prototypeLoaded` went true almost immediately in the exact case this
 * banner exists to catch, and the banner never showed. See
 * `review-shell.tsx`'s `probeReachable` for the replacement: a same-purpose
 * `fetch()` from the shell page itself, raced against a timeout, which is
 * the only signal that actually distinguishes "nothing answered" from "the
 * browser already gave up and rendered its own error page." Do not put
 * `prototypeLoaded` back here.
 *
 * Only loopback mode can have this problem — subdomain and the shared
 * prototype-origin host are reached the same way the shell itself is, so
 * if the shell loaded, they are already proven reachable.
 */

import type { OriginMode } from "../../server/serve/prototype-origin-resolve"

/** Also the probe's own time limit — see `review-shell.tsx`'s `probeReachable`. */
export const PORT_WATCHDOG_MS = 8000

export function shouldWarnPortUnreachable(input: {
  mode: OriginMode
  /** The bridge handshake has answered — see `review-shell.tsx`'s `bridgeReadyEpoch`. */
  bridgeReady: boolean
  /** The reachability probe's own outcome — see `review-shell.tsx`'s `probeReachable`. */
  probe: "pending" | "reachable" | "unreachable"
}): boolean {
  return input.mode === "loopback" && !input.bridgeReady && input.probe === "unreachable"
}

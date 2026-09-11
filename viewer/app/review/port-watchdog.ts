/**
 * Whether to warn a reviewer that the loopback port their prototype is
 * served on may be unreachable from their browser.
 *
 * The case this catches: the viewer runs inside Docker, and the operator
 * did not publish the loopback listener's ephemeral port range with `-p`.
 * The listener opens fine INSIDE the container, the review page's iframe
 * points at it, and nothing on the server side ever sees a failure — the
 * request just never reaches the container from the host. So this is a
 * CLIENT-side timeout, not a response the server could shape: after
 * `PORT_WATCHDOG_MS` with no sign the frame ever loaded, the banner in
 * `review-shell.tsx` says so and points at the fix.
 *
 * Only loopback mode can have this problem — subdomain and the shared
 * prototype-origin host are reached the same way the shell itself is, so
 * if the shell loaded, they are already proven reachable.
 */

import type { OriginMode } from "../../server/serve/prototype-origin-resolve"

export const PORT_WATCHDOG_MS = 8000

export function shouldWarnPortUnreachable(input: {
  mode: OriginMode
  /** The bridge handshake has answered — see `review-shell.tsx`'s `bridgeReadyEpoch`. */
  bridgeReady: boolean
  /** The iframe's own `onLoad` has fired. */
  prototypeLoaded: boolean
  elapsedMs: number
}): boolean {
  return (
    input.mode === "loopback" &&
    !input.bridgeReady &&
    !input.prototypeLoaded &&
    input.elapsedMs >= PORT_WATCHDOG_MS
  )
}

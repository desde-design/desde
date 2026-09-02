import type { RefObject } from "react"

/**
 * Shell-side authentication for `postMessage` traffic arriving from the
 * prototype iframe.
 *
 * ## Why this exists
 *
 * The bridge (inside the iframe) authenticates the shell carefully: it checks
 * `event.origin` against the injected shell origin AND requires
 * `event.source === window.parent` (see `isTrustedMessageOrigin` /
 * `isTrustedMessageSource` in `src/bridge/comment-bridge.ts`).
 *
 * The shell did not reciprocate. Of its eight listeners, only two —
 * `useIframeBridgeRequest` and the edit-driving adapter in
 * `src/editor/adapters/bridge/index.ts` — checked `event.source`. The other six
 * gated on nothing but a marker INSIDE the payload (`data.source ===
 * "desde-bridge"`), which any page in any window can trivially set. That
 * is audit finding S10.
 *
 * The blast radius was bounded — the edit pipeline was among the two that DID
 * check, so forged messages reached UI state (comment/note draft anchors,
 * route mirroring, `currentSourceFile`, context menus) rather than a source
 * write — but "the dangerous listener happened to be guarded" is not a design.
 *
 * ## What is actually checked
 *
 * 1. **`event.source` identity.** The message must come from the exact
 *    `contentWindow` of the iframe this hook is driving. This is stronger than
 *    an origin check alone: it names one window object, so no other frame,
 *    popup, or opener can satisfy it regardless of what origin it runs on.
 *
 * 2. **`event.origin`, when the caller knows what to expect.** Source identity
 *    alone is not sufficient, because `contentWindow` is stable across
 *    navigation: if the prototype navigates itself to an attacker's page, the
 *    window object is unchanged and check (1) still passes while the document
 *    is now hostile. Callers that know the prototype's origin should pass it.
 *
 * 3. **The payload marker**, kept last — it is a routing convenience for
 *    filtering out unrelated traffic (HMR clients, devtools, third-party
 *    widgets), never a credential.
 */
export const BRIDGE_SOURCE = "desde-bridge"

export interface BridgeMessageGuardOptions {
  /**
   * Origin the prototype is expected to be served from. When supplied, a
   * message whose `event.origin` differs is rejected even if it came from the
   * right window — this is what catches an iframe that navigated away.
   *
   * Omit only when the origin genuinely is not known to the caller; the
   * `event.source` identity check still applies.
   */
  expectedOrigin?: string | null
}

/**
 * True when `event` is a bridge message genuinely originating from
 * `iframeRef`'s current content window.
 */
export function isBridgeMessage(
  event: MessageEvent,
  iframeRef: RefObject<HTMLIFrameElement | null>,
  opts: BridgeMessageGuardOptions = {},
): boolean {
  const win = iframeRef.current?.contentWindow
  if (!win || event.source !== win) return false

  if (opts.expectedOrigin) {
    // An opaque origin serializes to the string "null" (sandboxed frames,
    // `data:`/`blob:` documents). It must never match, and it never equals a
    // real origin string, so no special case is needed beyond not treating an
    // empty `expectedOrigin` as a wildcard — hence the truthiness check above.
    if (event.origin !== opts.expectedOrigin) return false
  }

  const data = event.data as { source?: unknown } | null | undefined
  return !!data && typeof data === "object" && data.source === BRIDGE_SOURCE
}

/**
 * Derive the origin of a prototype URL for {@link BridgeMessageGuardOptions}.
 * Returns `null` for a malformed or relative URL, which callers should treat
 * as "origin unknown" (source-identity check only) rather than as a failure.
 */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

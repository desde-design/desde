/**
 * A stand-in for `iframe.contentWindow`. Records what the shell posts, and
 * can play the bridge's side of the protocol back.
 *
 * `MessageEvent.source` is a `WindowProxy` in the DOM's type world and jsdom
 * refuses a plain object in the constructor's init, so the event is built
 * first and `source` defined onto it — which is what the hook's identity gate
 * (`event.source !== iframeRef.current?.contentWindow`) reads.
 *
 * Shared by the handshake tests and the view-state tests: both need a frame
 * whose identity the hook will accept, and a hand-rolled second copy would be
 * a second chance to get that `source` subtlety wrong.
 */

/** The prototype origin these fakes emit from, matching `LOOPBACK_EMBED`. */
export const PROTOTYPE_ORIGIN = "http://127.0.0.1:45001"

/**
 * The embed to hand `useViewerBridge`: loopback mode on `PROTOTYPE_ORIGIN`.
 * The hook now gates inbound messages on `event.origin`, so a test that plays
 * the bridge's side must emit from an origin the embed names — which is why
 * `emit` defaults to `PROTOTYPE_ORIGIN` and this embed points at the same
 * value. A test exercising the origin gate itself passes a different origin to
 * `emit` explicitly (`use-viewer-bridge-origin.test.ts`).
 */
export const LOOPBACK_EMBED = { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" } as const

export interface FakeBridgeFrame {
  contentWindow: { postMessage: (m: unknown, t: string) => void }
  posted: { type?: string; payload?: unknown }[]
  emit: (data: unknown, origin?: string) => void
}

export function makeFakeFrame(): FakeBridgeFrame {
  const posted: { type?: string; payload?: unknown }[] = []
  const contentWindow = {
    postMessage: (m: unknown) => {
      posted.push(m as { type?: string; payload?: unknown })
    },
  }
  const emit = (data: unknown, origin: string = PROTOTYPE_ORIGIN): void => {
    const event = new MessageEvent("message", { data, origin })
    Object.defineProperty(event, "source", { value: contentWindow })
    window.dispatchEvent(event)
  }
  return { contentWindow, posted, emit }
}

export function frameRef(frame: FakeBridgeFrame) {
  return { current: { contentWindow: frame.contentWindow } as unknown as HTMLIFrameElement }
}

/** What the bridge sends to announce itself, natively or in answer to a PING. */
export const BRIDGE_READY = { source: "desde-bridge", type: "BRIDGE_READY", payload: {} }

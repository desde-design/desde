"use client"

/**
 * Viewer-side driver for the bridge protocol. The bridge (already injected
 * into the served prototype at `/p/{slug}/`) renders pins and the inspector
 * overlay inside the iframe; this hook posts shell state into it and
 * surfaces the bridge's reports back as React state.
 *
 * It covers three concerns, which is why it is no longer named for one of
 * them (it was `useViewerCommentBridge` until 2026-08-19):
 *
 * - **the handshake** — PING out on mount, BRIDGE_READY back. Everything
 *   else the shell sends is gated on `bridgeReadyEpoch`, so this one is
 *   load-bearing rather than a nicety; the effect below says why a single
 *   PING is both necessary and sufficient.
 * - **comments** — SET_COMMENTS / ENTER_COMMENT_MODE / ... out,
 *   COMMENT_PIN_CLICKED / NEW_COMMENT_POSITION back.
 * - **the current page** — ROUTE_CHANGED in, which is the only way the
 *   shell learns which route the reviewer is looking at. It also carries
 *   the page's source file when the substrate ships the source-tag plugin.
 * - **inspection** — ACTIVATE_INSPECTOR / DEACTIVATE_INSPECTOR out,
 *   ELEMENT_INSPECTED / ELEMENT_DESELECTED back. READ ONLY: the viewer
 *   renders what it is told and never posts a mutation. That is not an
 *   omission to be filled in later — "the viewer never modifies prototype
 *   source" is the rule this whole surface is built on (CLAUDE.md).
 *
 * Trimmed port of `src/hooks/useEditorCommentBridge.ts` (read first) —
 * same wire protocol (`ShellToBridgeMessage`/`BridgeToShellMessage` from
 * `src/types/bridge.ts`), dropped Editor's Zustand store coupling and
 * cross-page NAVIGATE/pending-highlight dance (the review page has no
 * multi-page flow model yet — highlighting a comment on a different page
 * is out of scope here, matches the brief).

 *
 * ## Origin discipline
 *
 * Both directions are pinned to the origin the frame is actually on, when it
 * has one. The shell posts to that origin instead of `"*"`, and only accepts a
 * message whose `event.origin` matches it. In fallback mode the frame is
 * opaque, which has no nameable origin, so `"*"` and the `"null"` origin
 * survive there and only there. The two gates and the reasoning for the split
 * are written out at `pinnedOrigin` and at the listener below.
 *
 * `COMMENT_ANCHOR_STATUS` is deliberately NOT handled. The bridge still emits
 * it, and this hook used to turn it into a "moved" badge on any comment whose
 * anchor had drifted to a coordinate fallback. Mo removed that badge on
 * 2026-08-20 — the signal was not worth the row it occupied — and the
 * plumbing went with it rather than staying as an unread subscription, which
 * is the state `docs/bridge-protocol.md`'s own audit calls out. The cost is
 * named there and worth knowing: a comment whose anchor drifted now points at
 * whatever the fallback coordinates land on, silently.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import type { RefObject } from "react"
import type {
  Comment,
  DOMRectJSON,
  InspectionData,
  ShellToBridgeMessage,
} from "@/types/bridge"
import type { OriginMode } from "../prototype-origin"

const BRIDGE_SOURCE = "desde-bridge"

/**
 * The origin serialization of an opaque origin. Every sandboxed frame,
 * `data:` document and `blob:` document on a page reports the same string, so
 * it identifies nothing on its own — see the inbound gate below.
 */
const OPAQUE_ORIGIN = "null"

/**
 * Where the prototype under review is, as far as the postMessage protocol is
 * concerned.
 *
 * `prototypeOrigin` must be the origin the frame is ACTUALLY on, not whatever
 * the server's `prototype-origin` route reported: several of the route's
 * answers name an origin the embed then declines to use. `prototypeEmbedOrigin`
 * (`app/prototype-origin.ts`) is the function that reconciles the two, and it
 * is what `review-shell.tsx` passes here.
 */
export interface ViewerBridgeEmbed {
  /** The frame's real origin, or `null` when it has none this shell can name. */
  prototypeOrigin: string | null
  /** The mode the server reported. A second gate on top of the origin. */
  mode: OriginMode
}

/**
 * `scheme://host[:port]`, or `null` when the value does not parse.
 *
 * Both sides of every comparison below go through this, so a configured
 * origin carrying a trailing slash can never become a target no frame
 * matches. `event.origin` in a real browser is already in this form; running
 * it through anyway costs nothing and keeps the two sides symmetrical.
 */
function normalizeOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export interface NewCommentDraft {
  anchorSelector: string
  page: string
  anchorX: number
  anchorY: number
  elementRect: DOMRectJSON
}

export interface PinClick {
  commentId: string
  pinRect: DOMRectJSON
}

export interface UseViewerBridgeResult {
  /** Increments each time the bridge reports BRIDGE_READY. Starts at 0. */
  bridgeReadyEpoch: number
  /** Set from the bridge's COMMENT_PIN_CLICKED. */
  pinClick: PinClick | null
  clearPinClick: () => void
  /** Set from the bridge's NEW_COMMENT_POSITION. */
  draft: NewCommentDraft | null
  clearDraft: () => void
  /**
   * The prototype's current route, as the bridge last reported it, plus the
   * source file behind it when the substrate stamps one. `null` until the
   * first ROUTE_CHANGED — which for a prototype that never navigates may be
   * never, so treat "no route yet" as ordinary rather than as an error.
   */
  page: { url: string; sourceFile?: string } | null
  /**
   * The colour the prototype paints its page, as the bridge last resolved it
   * (`rgb(…)` / `rgba(…)`), or `null` when it has not said.
   *
   * `null` is the ordinary state, not a failure: an older bridge bundle does
   * not send `PAGE_BACKGROUND_CHANGED` at all, and the prototype may not have
   * booted yet. A consumer must have a colour of its own to fall back to
   * rather than treating this as authoritative.
   */
  pageBackground: string | null
  /**
   * The element the reviewer last clicked with the inspector armed. Cleared
   * by ELEMENT_DESELECTED.
   */
  inspection: InspectionData | null
  activateInspector: () => void
  deactivateInspector: () => void
  syncComments: (comments: Comment[]) => void
  enterCommentMode: () => void
  exitCommentMode: () => void
  setShowResolved: (show: boolean) => void
  /**
   * Hide the comment PINS inside the prototype, without touching the rail.
   * The reviewer is looking at the design, not at what has been said about
   * it — so the list stays, only the overlay goes.
   */
  setPinsHidden: (hidden: boolean) => void
  highlightComment: (commentId: string) => void
}

export function useViewerBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  embed: ViewerBridgeEmbed,
): UseViewerBridgeResult {
  const [bridgeReadyEpoch, setBridgeReadyEpoch] = useState(0)
  const [pinClick, setPinClick] = useState<PinClick | null>(null)
  const [draft, setDraft] = useState<NewCommentDraft | null>(null)
  const [page, setPage] = useState<{ url: string; sourceFile?: string } | null>(null)
  const [pageBackground, setPageBackground] = useState<string | null>(null)
  const [inspection, setInspection] = useState<InspectionData | null>(null)

  // Destructured to PRIMITIVES on purpose. `review-shell.tsx` builds this
  // object inline, so its identity changes on every render; memoizing on the
  // object would rebuild `post` every render, and `post` is a dependency of
  // the effect below that attaches the message listener and sends the PING.
  // The listener would be torn down and re-attached, and a fresh PING sent,
  // on every single render.
  const { prototypeOrigin, mode } = embed

  /**
   * The origin to pin, or `null` when there is none to pin.
   *
   * BOTH conditions have to hold, and they catch different mistakes. The mode
   * check refuses fallback, where the frame is same-host and (when sandboxed)
   * opaque. The origin check refuses an isolated mode that produced no usable
   * origin — a loopback project with nothing built yet, a private subdomain
   * with no capability, an origin equal to the shell's. A caller that passes
   * the raw server response instead of `prototypeEmbedOrigin`'s reconciled
   * answer is wrong, but it is wrong safely: it lands on `"*"`, which works,
   * rather than on a name the frame is not on, which silently works never.
   */
  const pinnedOrigin = useMemo(
    () => (mode === "fallback" ? null : normalizeOrigin(prototypeOrigin)),
    [mode, prototypeOrigin],
  )

  /**
   * `"*"` is REQUIRED in fallback mode, and not laziness. There the iframe is
   * sandboxed without `allow-same-origin` (see `../prototype-origin.ts`),
   * which gives its document an opaque origin — and an opaque origin has no
   * serialization that can be named as a `targetOrigin`, so any concrete
   * value would silently drop every message and the bridge would never be
   * configured. Posting to `iframeRef.current.contentWindow` (never
   * `window.postMessage`) already bounds the recipient to that one frame;
   * `"*"` only means "whatever document is in it right now", and the
   * messages are shell state (comment list, view mode), carrying nothing
   * the prototype's own page could not already read off the DOM.
   *
   * An ISOLATED mode is the other case entirely, and it is why this is a
   * split rather than a constant: the frame has a real origin, so it can be
   * named, and naming it is the fix for a live leak. A prototype may always
   * navigate ITSELF, including to `https://evil.example/collector`. The
   * window handle is unchanged by that, so the identity gate below still
   * matches and `"*"` still delivers — and the shell keeps posting
   * `SET_COMMENTS`, which carries comment bodies, authors and
   * `participantEmails` (verified GitHub addresses). Naming the origin makes
   * every post after such a navigation fail silently, which is the wanted
   * outcome. See `docs/superpowers/research/2026-08-22-prototype-origin-
   * adversarial-review.md`, "Attack 6".
   */
  const post = useCallback(
    (message: ShellToBridgeMessage) => {
      iframeRef.current?.contentWindow?.postMessage(message, pinnedOrigin ?? "*")
    },
    [iframeRef, pinnedOrigin],
  )

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Sender IDENTITY, checked before anything in the payload is read.
      // An origin check cannot do this job: a sandboxed prototype posts
      // from an opaque origin, which serializes to the string `"null"` —
      // shared verbatim by every sandboxed frame, `data:` document and
      // `blob:` document on the page, so `event.origin` identifies nothing
      // here. `event.source` is the window handle itself, and only OUR
      // iframe's `contentWindow` is equal to it. This also closes what the
      // `data.source` marker below never could: that marker is a plain
      // string any sender writes for itself, so before this check any
      // frame or opener on the page could forge a `COMMENT_PIN_CLICKED` or
      // steer a `NEW_COMMENT_POSITION` draft.
      //
      // MEASURED (Chromium): a sandboxed frame's message arrives with
      // `event.origin === "null"` and `event.source === iframe.contentWindow`,
      // and the bridge's mirror-image gate (`event.source === window.parent`,
      // `src/bridge/comment-bridge.ts`) holds across the same boundary — so
      // the handshake completes in both directions under the sandbox.
      if (event.source !== iframeRef.current?.contentWindow) return

      // Sender ORIGIN, checked second and ADDED to the identity gate above,
      // never substituted for it. The two catch different things: identity
      // catches a different frame, origin catches the SAME frame after it
      // navigated itself somewhere else (the "Attack 6" case the outbound
      // comment above describes — the window handle survives a navigation,
      // so identity alone keeps saying yes).
      //
      // Isolated modes: the frame has a real origin and `allow-same-origin`,
      // so it posts from that origin and nothing else is our prototype. An
      // opaque `"null"` here is therefore also a refusal, not a special case.
      //
      // Fallback mode: `"null"` is exactly what the sandboxed prototype
      // reports, and the page's own origin is what the uncontained
      // degradation reports (a private prototype with no capability gets no
      // sandbox at all — see `../prototype-origin.ts`). Reading
      // `window.location.origin` here is validating an inbound message, not
      // deriving where to point the frame; the frame's own destination is
      // resolved server-side and never computed from the browser's location.
      //
      // Dropped silently either way. A console line per rejected message
      // would be a per-frame log on a page that can receive a lot of them,
      // and it would say nothing the reviewer could act on.
      const acceptable = pinnedOrigin
        ? event.origin === pinnedOrigin
        : event.origin === OPAQUE_ORIGIN || event.origin === window.location.origin
      if (!acceptable) return

      const data = event.data as
        | { source?: string; type?: string; payload?: unknown }
        | null
      if (!data || data.source !== BRIDGE_SOURCE) return

      switch (data.type) {
        case "BRIDGE_READY":
          setBridgeReadyEpoch((n) => n + 1)
          return
        case "COMMENT_PIN_CLICKED":
          setPinClick(data.payload as PinClick)
          return
        case "NEW_COMMENT_POSITION":
          setDraft(data.payload as NewCommentDraft)
          return
        case "PAGE_BACKGROUND_CHANGED": {
          const color = (data.payload as { color?: unknown } | undefined)?.color
          // Validated rather than trusted: this value is written straight
          // into a `background` style, and the payload crosses an origin
          // boundary. Only the shapes the bridge's own resolver can produce
          // are accepted.
          if (typeof color === "string" && /^(rgb|rgba|hsl|hsla|#)/.test(color.trim())) {
            setPageBackground(color.trim())
          }
          return
        }
        case "ROUTE_CHANGED":
          setPage(data.payload as { url: string; sourceFile?: string })
          // A navigation invalidates the selection: the inspected element
          // belonged to the page that just went away, and leaving its styles
          // on screen next to a different page is worse than showing nothing.
          setInspection(null)
          return
        case "ELEMENT_INSPECTED":
          setInspection(data.payload as InspectionData)
          return
        case "ELEMENT_DESELECTED":
          setInspection(null)
          return
        default:
          return
      }
    }
    window.addEventListener("message", onMessage)

    // Then ask the bridge to announce itself, because it has almost certainly
    // announced itself already and nobody was listening.
    //
    // `BRIDGE_READY` is emitted ONCE, from the bridge's IIFE, and postMessage
    // has no replay. The review page's `<iframe>` is part of the SERVER-
    // rendered HTML, so the browser starts fetching `/p/{slug}/` while the
    // shell document is still parsing — MEASURED on the live viewer: the
    // bridge fires `BRIDGE_READY` at +62ms, and this effect (which cannot run
    // before the shell bundle has loaded and hydrated) attaches at +600ms and
    // later. The shell missed it every single time, `bridgeReadyEpoch` stayed
    // 0, and every outbound message in `review-shell.tsx` is gated on it — so
    // "Add comment" armed its own button and the bridge was never told to
    // enter placement mode. Clicking the prototype did nothing.
    //
    // `PING` is a non-navigating echo: `src/bridge/comment-bridge.ts` answers
    // it with a fresh `BRIDGE_READY` and does nothing else. Editor hit the
    // same race (React Strict Mode's double-invoke re-attaching its listener
    // around the native announcement) and closed it the same way — see
    // `waitForBridgeReady` in `src/editor/adapters/bridge/index.ts`.
    //
    // ONE ping, not a retry loop. There are only three orderings and this
    // pair covers all of them: a bridge that booted first answers the PING; a
    // bridge that boots later announces itself natively into the listener
    // just attached; and a bridge that boots between the two is still the
    // second case, because the listener is already up. `BRIDGE_READY` can
    // only be missed when it fires before the listener exists — and in
    // exactly that case the bridge is fully booted, so the PING lands.
    //
    // NOT gated on the iframe having loaded: posting into a document that
    // has not installed its listener yet is a silent no-op, which is the
    // "boots later" case, already covered.
    post({ type: "PING" })

    return () => window.removeEventListener("message", onMessage)
    // `pinnedOrigin` is read by the listener, so a change to it must
    // re-attach — otherwise a stale closure would keep admitting the origin
    // the frame used to be on. `post` already depends on it, so in practice
    // the two move together; it is listed for the closure, not for `post`.
  }, [iframeRef, post, pinnedOrigin])

  return {
    bridgeReadyEpoch,
    pageBackground,
    pinClick,
    clearPinClick: useCallback(() => setPinClick(null), []),
    draft,
    clearDraft: useCallback(() => setDraft(null), []),
    syncComments: useCallback(
      (comments: Comment[]) => post({ type: "SET_COMMENTS", payload: comments }),
      [post],
    ),
    enterCommentMode: useCallback(() => post({ type: "ENTER_COMMENT_MODE" }), [post]),
    exitCommentMode: useCallback(() => post({ type: "EXIT_COMMENT_MODE" }), [post]),
    setShowResolved: useCallback(
      (show: boolean) => post({ type: "SET_SHOW_RESOLVED", payload: show }),
      [post],
    ),
    setPinsHidden: useCallback(
      (hidden: boolean) => post({ type: "SET_PINS_HIDDEN", payload: hidden }),
      [post],
    ),
    highlightComment: useCallback(
      (commentId: string) => post({ type: "HIGHLIGHT_COMMENT", payload: { commentId } }),
      [post],
    ),
    page,
    inspection,
    activateInspector: useCallback(() => post({ type: "ACTIVATE_INSPECTOR" }), [post]),
    deactivateInspector: useCallback(() => {
      post({ type: "DEACTIVATE_INSPECTOR" })
      // Clear locally too. The bridge does not send ELEMENT_DESELECTED when
      // the shell turns the inspector off — it only sends it when the USER
      // deselects — so without this the panel would keep showing the last
      // element after the tool was put away.
      setInspection(null)
    }, [post]),
  }
}

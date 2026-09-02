"use client"

/**
 * The editor shell's `chat:*` bridge handler map (Task 21,
 * editor-audit-fixes-plan) — extracted verbatim from `editor-surface.tsx`,
 * where it lived as a ~480-line `useMemo` carrying an
 * `eslint-disable react-hooks/exhaustive-deps` because its true dependency
 * surface couldn't be expressed as one list.
 *
 * Every `chat:*` messageType the agent runtime (and the always-on
 * `useShellBridgePoll` MCP channel) can ask for is resolved here, shell-side:
 * `get_selection` reads the Zustand store, `get_page_info` synthesizes from the
 * live route slice, `capture_screenshot` / `read_rendered_value` /
 * `read_measurements` / `resolve_target` / `perform_interact` round-trip to the
 * iframe bridge, `navigate` drives the iframe, and `ask_user_question` parks a
 * promise until the user answers.
 *
 * ## Dependency honesty
 *
 * Each handler is its own `useCallback` with a HONEST dependency list — no
 * suppression. That means the returned map's identity changes whenever any
 * input changes (e.g. the primary selection), which is safe and is already the
 * status quo: every consumer either reads the map through a latest-ref
 * (`useEditorChat`'s `handlersRef`, `useShellBridgePoll`'s `handlersRef`) or
 * invokes it imperatively at call time (`replayScreenshotPlan`). Nothing
 * subscribes to handler identity, so churn costs nothing and buys an honest
 * dep graph.
 *
 * ## Why `chat:navigate` does NOT ride on `useIframeBridgeRequest`
 *
 * The Task-17 primitive models ONE shape: post `{type, payload, requestId}` into
 * the iframe, resolve on the first bridge reply carrying the same `requestId`,
 * with a timeout/abort ceiling. `chat:navigate` shares none of that mechanism:
 *   - it sends no request message at all — it writes `iframe.src`;
 *   - the signal it waits on (`ROUTE_CHANGED`) is a BROADCAST with no
 *     `requestId`, so replies can't be correlated the primitive's way;
 *   - acceptance is gated on a DOM `load` event on the iframe element (the
 *     correlation guard that rejects a `ROUTE_CHANGED` still queued from the
 *     old page), which has no analogue in the primitive;
 *   - it has a second, nested timer (the 2s post-load best-effort settle) that
 *     resolves SUCCESSFULLY, unlike the primitive's single timeout ceiling.
 * Bending the primitive to cover this would mean four new extension points
 * (skip-the-post, match-without-requestId, external acceptance gate, secondary
 * success timer) threaded through the five existing wrappers — a fork wearing a
 * shared name. The load-gate machinery therefore stays here, factored into the
 * self-contained `navigateIframeAwaitingRoute` helper below; the primitive is
 * left untouched.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import type { Selection } from "@/editor/core"
import type { ChatBridgeHandler, ChatBridgeHandlers } from "./useEditorChat"
import type { CaptureScreenshotFn } from "./useIframeScreenshotCapture"
import type { IframeSemanticTarget } from "./useIframeSemanticTarget"
import type {
  ReadRenderedValueFn,
  RenderAccessor,
} from "./useIframeReadRenderedValue"
import type { ReadMeasurementsFn } from "./useIframeReadMeasurements"
import type { PendingQuestion } from "@/components/editor/chat-pending-question"
import { useEditorStore } from "@/stores/editor-only"
import { useAppStore } from "@/stores"
import { EDITOR_FRAMEWORK } from "@/lib/editor-feature-flags"
import { isBridgeMessage, originOf } from "./bridge-message-guard"

/**
 * Phase 6: snapshot a `Selection` into the chat's bridge-tool output
 * shape. Centralized so both single-select and multi-select paths in
 * `chat:get_selection` agree on what the agent sees.
 */
function toSelectionSnapshot(sel: Selection) {
  return {
    targetId: sel.targetId,
    selector: sel.selector,
    componentName: sel.componentName,
    componentFile: sel.componentFile,
    authoredAt: sel.authoredAt,
    editTarget: sel.editTarget,
    isLibrary: sel.isLibrary,
    packageName: sel.packageName,
    classes: sel.classes,
    tagName: sel.tagName,
    currentProps: sel.currentProps,
    currentAttrs: sel.currentAttrs,
    editableTexts: sel.editableTexts,
  }
}

type NavigateResult =
  | { ok: true; output: { route: string; alreadyThere: boolean } }
  | { ok: false; error: string }

/**
 * Drive the iframe to `targetUrl` and settle once the new page has actually
 * landed. Lifted verbatim out of the `chat:navigate` handler so the handler
 * body reads as route resolution + policy, not event plumbing. See the module
 * header for why this isn't `useIframeBridgeRequest`.
 */
function navigateIframeAwaitingRoute(opts: {
  iframe: HTMLIFrameElement
  targetUrl: string
  targetRoute: string
  /** False for a hash-ONLY nav (same-document — no `load` event will fire). */
  expectReload: boolean
  setCurrentPageInfo: (sourceFile: string | null, url: string) => void
  signal?: AbortSignal
}): Promise<NavigateResult> {
  const {
    iframe,
    targetUrl,
    targetRoute,
    expectReload,
    setCurrentPageInfo,
    signal,
  } = opts
  return new Promise<NavigateResult>((resolve) => {
    let settled = false
    // Correlation guard: a cross-page navigation is a HARD RELOAD, so
    // the iframe element fires a `load` event when the new document is
    // up. We only accept a ROUTE_CHANGED *after* that load — otherwise a
    // ROUTE_CHANGED still queued from the OLD page (SPA nav, a re-elicited
    // initial-source stamp, etc.) could resolve us early with the wrong
    // landed route, letting the agent act before the target page exists.
    let reloaded = false
    let postLoadTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      window.removeEventListener("message", onRouteChanged)
      iframe.removeEventListener("load", openGate)
      clearTimeout(timer)
      if (postLoadTimer) clearTimeout(postLoadTimer)
      if (signal) signal.removeEventListener("abort", onAbort)
    }
    const finish = (landed: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ok: true, output: { route: landed, alreadyThere: false } })
    }
    function openGate() {
      reloaded = true
      // The bridge re-injects (or, for a hash-only nav, fires
      // hashchange) and emits ROUTE_CHANGED — normally within ~100ms.
      // If it never does (e.g. a page the source-tag plugin doesn't
      // stamp), don't hang to the 15s ceiling: resolve best-effort with
      // the requested route shortly after the nav lands. The top-level
      // ROUTE_CHANGED listener never ran in that case, so update the
      // current-page slice here first — otherwise the agent's follow-up
      // get_page_info would still report the PREVIOUS page.
      if (postLoadTimer) clearTimeout(postLoadTimer)
      postLoadTimer = setTimeout(() => {
        setCurrentPageInfo(null, targetUrl)
        finish(targetRoute)
      }, 2_000)
    }
    function onRouteChanged(event: MessageEvent) {
      if (settled || !reloaded) return
      // S10: authenticate the sender rather than trusting the payload's
      // `source` marker, which any window can write. `targetUrl` is the exact
      // document we just asked THIS frame to load, so it is the tightest
      // expected origin available here — tighter than the canonical
      // `prototypeUrl` prop, which the navigate handler above deliberately
      // overrides with the live origin before assigning `iframe.src`.
      if (
        !isBridgeMessage(
          event,
          { current: iframe },
          { expectedOrigin: originOf(targetUrl) },
        )
      ) {
        return
      }
      const data = event.data as { type?: string; payload?: { url?: string } }
      if (data.type !== "ROUTE_CHANGED") return
      // First ROUTE_CHANGED after the reload IS the landed page — adopt
      // whatever route it reports (the router may have redirected away
      // from the requested path).
      let landed = targetRoute
      try {
        const u = new URL(data.payload?.url ?? targetUrl)
        landed = u.pathname + u.search + u.hash
      } catch {
        /* keep requested route as best-effort */
      }
      finish(landed)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ok: false, error: "navigation aborted" })
    }
    // 15s ceiling — a hard reload + bridge re-injection is well under a
    // second normally; this only fires if the page never loads at all.
    // Kept below the tool handler's 20s bridge.send timeout so a slow
    // nav surfaces THIS clean error rather than the generic transport
    // timeout.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ok: false,
        error: `navigation to '${targetRoute}' timed out (no load).`,
      })
    }, 15_000)
    window.addEventListener("message", onRouteChanged)
    iframe.addEventListener("load", openGate)
    if (signal) signal.addEventListener("abort", onAbort)
    // Drive the iframe. We deliberately do NOT optimistically seed the
    // current-page slice here: the top-level ROUTE_CHANGED listener
    // updates it from the REAL landed route, so a failed/aborted nav
    // never leaves the slice pointing at a page we didn't reach.
    iframe.src = targetUrl
    // A hash-only nav is same-document — no `load` event will fire, so
    // open the gate now and lean on the bridge's hashchange-driven
    // ROUTE_CHANGED (or the post-load fallback) to settle.
    if (!expectReload) openGate()
  })
}

export interface EditorBridgeHandlersOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** The iframe's canonical/seeded URL (the `prototypeUrl` prop). */
  prototypeUrl: string
  /** Live primary selection (`editing.editorSelection`). */
  editorSelection: Selection | null
  /** `editing.supportsRenderedValueRead` — live-bridge capability gate. */
  supportsRenderedValueRead: () => boolean
  /** `editing.supportsMeasurementsRead` — live-bridge capability gate. */
  supportsMeasurementsRead: () => boolean
  /** `editing.handleSelectMany` — pins a multi-selection. */
  selectMany: (selectors: readonly string[]) => Promise<Selection[]>
  captureScreenshot: CaptureScreenshotFn
  semanticTarget: IframeSemanticTarget
  readRenderedValue: ReadRenderedValueFn
  readMeasurements: ReadMeasurementsFn
}

export interface EditorBridgeHandlersResult {
  /** The `chat:*` handler map — pass to `useEditorChat` + `useShellBridgePoll`. */
  bridgeHandlers: ChatBridgeHandlers
  /** The question awaiting a user answer, if any (rendered by the surface). */
  pendingQuestion: PendingQuestion | null
}

export function useEditorBridgeHandlers(
  opts: EditorBridgeHandlersOptions,
): EditorBridgeHandlersResult {
  const {
    iframeRef,
    prototypeUrl,
    editorSelection,
    supportsRenderedValueRead,
    supportsMeasurementsRead,
    selectMany,
    captureScreenshot,
    semanticTarget,
    readRenderedValue,
    readMeasurements,
  } = opts
  const { resolveTarget, performInteract } = semanticTarget
  const setCurrentPageInfo = useAppStore((s) => s.setCurrentPageInfo)

  // Phase 3 — ask_user_question pending state. When the SDK tool fires
  // an `ask_user_question` bridge request, we store the question here;
  // the shell renders a choice UI and the user's click resolves the
  // pending promise. Only one question can be pending at a time — a
  // second arrival dismisses the first. The ref mirrors the live entry so
  // the handler (whose identity must not depend on this state) can read
  // the currently-pending question; it's maintained by the handler itself
  // rather than by a render-phase mirror write, so a second question that
  // arrives in the SAME tick as the first still sees it.
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null)
  const pendingQuestionRef = useRef<PendingQuestion | null>(null)

  const handleCaptureScreenshot = useCallback<ChatBridgeHandler>(
    async (payload, signal) => {
      // Phase 4 tool contract: { scope: 'viewport' | 'element' | 'selector', selector? }.
      const { scope, selector } = (payload ?? {}) as {
        scope?: "viewport" | "element" | "selector"
        selector?: string
      }
      let target: string | undefined
      if (scope === "selector") {
        if (!selector) {
          return { ok: false, error: "scope 'selector' requires a selector." }
        }
        target = selector
      } else if (scope === "element") {
        target = editorSelection?.selector
        if (!target) {
          return { ok: false, error: "scope 'element' requires a current selection." }
        }
      } else if (scope === "viewport") {
        // Capture the page body. (html2canvas captures the full element, so
        // this is the rendered page, not strictly the visible viewport.)
        target = undefined
      } else {
        // No scope → honor an explicit selector, else the page body.
        target = selector
      }
      const result = await captureScreenshot({ selector: target }, signal)
      if (!result.ok) {
        // Hand the agent an actionable reason. A selector miss is the common
        // case (it captured right after an edit, before navigating to the page
        // that renders the element) — not the "timeout" the old generic
        // message implied. Return the bare detail; the SDK tool layer
        // (editor-tool-handlers.captureScreenshot) adds the single
        // "Screenshot capture failed:" frame, so don't prefix it here.
        const where = useAppStore.getState().currentPageUrl
        let detail: string
        if (result.reason === "no-match") {
          detail = `No element matches selector "${target}"${where ? ` on ${where}` : ""}. If you just edited it, navigate to the page/step that renders it before capturing.`
        } else if (result.reason === "empty-element") {
          detail = `Element "${target}" is present but has no rendered size (likely hidden or on an inactive step/route)${where ? ` on ${where}` : ""}. Navigate to where it's visible, then capture again.`
        } else {
          detail = result.message
        }
        // Prefix a stable machine token so the SDK capture tool can tell a
        // selector miss (recoverable via auto-navigate) from a real failure
        // (render crash / timeout). It strips the token before showing the
        // agent. Only the SDK path reads `error`; the canvas-button toast uses
        // the hook's own clean message, so it's unaffected.
        return { ok: false, error: `[capture:${result.reason}] ${detail}` }
      }
      return { ok: true, output: result.shot }
    },
    [captureScreenshot, editorSelection],
  )

  // Phase 2/3 semantic-target round-trips: the agent's `interact` tool +
  // the deterministic replay both resolve a target then act through these.
  const handleResolveTarget = useCallback<ChatBridgeHandler>(
    async (payload, signal) => {
      const { target } = (payload ?? {}) as {
        target?: { role?: string; name?: string; text?: string; selector?: string }
      }
      if (!target) {
        return { ok: false, error: "resolve_target requires a target." }
      }
      const resolved = await resolveTarget(target, signal)
      return { ok: true, output: resolved ?? { found: false } }
    },
    [resolveTarget],
  )

  const handlePerformInteract = useCallback<ChatBridgeHandler>(
    async (payload, signal) => {
      const { selector, action, value } = (payload ?? {}) as {
        selector?: string
        action?: "click" | "fill" | "select"
        value?: string
      }
      if (!selector || !action) {
        return { ok: false, error: "perform_interact requires a selector and action." }
      }
      const outcome = await performInteract({ selector, action, value }, signal)
      return { ok: true, output: outcome ?? { ok: false, error: "no response" } }
    },
    [performInteract],
  )

  // Only EditorSurface needs this handler: verify_edit (like
  // capture_screenshot) is registered solely by buildEditorToolServer,
  // which runs only in the editor-cli SDK runtime (runChatTurnSdk) whose
  // surface is THIS component. The cloud-viewer project route never builds
  // that tool server, so it can't call verify_edit and intentionally omits
  // this handler (same as it omits chat:capture_screenshot).
  const handleReadRenderedValue = useCallback<ChatBridgeHandler>(
    async (payload, signal) => {
      // verify_edit tool contract: { selector, accessor: { kind, name? } }.
      // Round-trips to the bridge's READ_RENDERED_VALUE DOM read and returns
      // the current rendered value (or null when nothing matches). The
      // verify oracle treats null as "element/value not found".
      const { selector, accessor } = (payload ?? {}) as {
        selector?: string
        accessor?: RenderAccessor
      }
      if (!selector || !accessor?.kind) {
        return {
          ok: false,
          error: "read_rendered_value requires { selector, accessor: { kind } }.",
        }
      }
      // Gate on the live bridge version. An older bridge silently drops
      // READ_RENDERED_VALUE, so an ungated read would time out → null → a
      // FALSE failure. Signal `supported:false` so verify_edit reports
      // "skipped" instead of pushing the agent into a needless correction
      // loop. (Mirrors the React verifier's supportsRenderedValueRead gate.)
      if (!supportsRenderedValueRead()) {
        return { ok: true, output: { value: null, supported: false } }
      }
      const value = await readRenderedValue({ selector, accessor }, signal)
      return { ok: true, output: { value, supported: true } }
    },
    [readRenderedValue, supportsRenderedValueRead],
  )

  const handleReadMeasurements = useCallback<ChatBridgeHandler>(
    async (payload, signal) => {
      // verify_goal tool contract: { selector }. Round-trips to the bridge's
      // READ_MEASUREMENTS DOM read and returns live geometry + a computed-style
      // subset (or null when nothing matches). Same version-gate rationale as
      // read_rendered_value: an old bridge silently drops READ_MEASUREMENTS, so
      // an ungated read would time out → null → a false "not measurable".
      const { selector } = (payload ?? {}) as { selector?: string }
      if (!selector) {
        return { ok: false, error: "read_measurements requires { selector }." }
      }
      if (!supportsMeasurementsRead()) {
        return { ok: true, output: { measurements: null, supported: false } }
      }
      const measurements = await readMeasurements(selector, signal)
      return { ok: true, output: { measurements, supported: true } }
    },
    [readMeasurements, supportsMeasurementsRead],
  )

  const handleGetSelection = useCallback<ChatBridgeHandler>(async () => {
    const sel = editorSelection
    // Phase 6 multi-select: return an array shape when the user
    // has multiple selections. Single-select callers (the common
    // case) still get the single object shape they had pre-Phase-6.
    const many = useEditorStore.getState().editorSelectionMany
    if (many && many.length > 0) {
      return {
        ok: true,
        output: {
          kind: "many",
          selections: many.map(toSelectionSnapshot),
        },
      }
    }
    if (!sel) return { ok: true, output: null }
    return { ok: true, output: toSelectionSnapshot(sel) }
  }, [editorSelection])

  const handlePinSelections = useCallback<ChatBridgeHandler>(
    async (payload) => {
      const sels = (payload as { selectors?: unknown })?.selectors
      if (!Array.isArray(sels)) {
        return { ok: false, error: "selectors must be an array" }
      }
      try {
        const result = await selectMany(sels as string[])
        return {
          ok: true,
          output: {
            pinned: result.length,
            selectors: result.map((s) => s.selector),
          },
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    [selectMany],
  )

  const handleGetPageInfo = useCallback<ChatBridgeHandler>(async () => {
    // The parent shell can't read the iframe URL cross-origin, so
    // `prototypeUrl` (the prop) only reflects the iframe's initial
    // load — not the user's current SPA route. The bridge tracks
    // live navigation and pushes it into the current-page slice via
    // ROUTE_CHANGED. Prefer those live values; fall back to the
    // canonical prop when the bridge hasn't reported yet.
    const live = useAppStore.getState()
    const liveUrl = live.currentPageUrl
    const liveRoute = live.currentDisplayRoute
    const sourceFile = live.currentSourceFile ?? undefined
    let route = "/"
    let url = liveUrl ?? prototypeUrl
    try {
      const u = new URL(url)
      route = liveRoute ?? u.pathname + u.hash
      url = u.toString()
    } catch {
      // Non-URL prototype paths fall through with defaults.
      if (liveRoute) route = liveRoute
    }
    return {
      ok: true,
      output: {
        url,
        route,
        framework: EDITOR_FRAMEWORK,
        title: typeof document !== "undefined" ? document.title : undefined,
        sourceFile,
      },
    }
  }, [prototypeUrl])

  // Creation & navigation (#5) — agent-driven page navigation. The
  // agent is otherwise stuck on the page the user is looking at; this
  // lets it drive the iframe to another route to work on it. We resolve
  // the requested route against the live origin, hard-navigate the
  // iframe (matching the shell's own imperative-nav path — the bridge's
  // NAVIGATE handler reloads cross-page anyway, so there's no SPA
  // pushState shortcut to preserve), then await the bridge's
  // ROUTE_CHANGED handshake on the new page. Same-route requests are a
  // no-op so the agent doesn't pay a reload to "navigate" to where it
  // already is.
  const handleNavigate = useCallback<ChatBridgeHandler>(
    (payload, signal) => {
      const route = (payload as { route?: string })?.route
      if (typeof route !== "string" || route.trim() === "") {
        return Promise.resolve({
          ok: false as const,
          error: "navigate requires a non-empty { route }.",
        })
      }
      const live = useAppStore.getState()
      // Resolve the (possibly relative) route against the LIVE origin so the
      // iframe load lands on the same dev-server/worktree origin the user is
      // on — never the seeded canonical prop origin. Fallback order:
      //   1. currentPageUrl  — the bridge's last reported route (truest once
      //      a ROUTE_CHANGED has landed).
      //   2. the iframe's own current `src` — readable cross-origin (it's our
      //      attribute); reflects the current origin even before the first
      //      ROUTE_CHANGED.
      //   3. prototypeUrl — canonical origin, last resort.
      const liveIframeSrc = iframeRef.current?.src
      const currentFullUrl =
        live.currentPageUrl ??
        (liveIframeSrc && /^https?:/i.test(liveIframeSrc)
          ? liveIframeSrc
          : undefined) ??
        prototypeUrl
      let targetUrl: string
      let targetRoute: string
      try {
        const base = new URL(currentFullUrl)
        const u = new URL(route, currentFullUrl)
        // Pin the target to the LIVE origin. A relative route already
        // inherits it, but an absolute URL (`https://canonical.example/foo`)
        // would otherwise keep its own origin and drive the iframe off the
        // session worktree dev server — while edits still apply to the
        // session. We adopt only the requested path/search/hash.
        u.protocol = base.protocol
        u.host = base.host
        targetUrl = u.toString()
        // Report path+search+hash so query-only navigations read back
        // distinctly (a route is more than its pathname).
        targetRoute = u.pathname + u.search + u.hash
      } catch {
        return Promise.resolve({
          ok: false as const,
          error: `navigate: '${route}' is not a valid route.`,
        })
      }
      // Same-page short-circuit: compare the FULL resolved location
      // (path + search + hash), not just the pathname. `currentDisplayRoute`
      // is normalized to the pathname only, so comparing against it would
      // treat `/search?q=new` as "already on `/search`" and skip a real
      // (query-only) navigation. We ignore the origin on purpose — the live
      // URL may carry a per-session worktree origin while `targetUrl` was
      // resolved against it. Only short-circuit when we actually know the
      // live URL; otherwise fall through and navigate.
      //
      // We also derive `expectReload`: a path/search change is a full
      // document load, but a hash-ONLY change (e.g. `/p` → `/p#reviews`) is
      // a same-document fragment nav that fires NO iframe `load` event —
      // only a `hashchange`-driven ROUTE_CHANGED. The promise below uses
      // this to skip the load gate for hash-only navs (else they'd hang to
      // the timeout). Default true when the live URL is unknown.
      let expectReload = true
      if (live.currentPageUrl) {
        try {
          const cur = new URL(live.currentPageUrl)
          const tgt = new URL(targetUrl)
          if (
            cur.pathname === tgt.pathname &&
            cur.search === tgt.search &&
            cur.hash === tgt.hash
          ) {
            return Promise.resolve({
              ok: true as const,
              output: { route: targetRoute, alreadyThere: true },
            })
          }
          expectReload =
            cur.pathname !== tgt.pathname || cur.search !== tgt.search
        } catch {
          /* unparseable live URL — fall through and navigate */
        }
      }
      const iframe = iframeRef.current
      if (!iframe) {
        return Promise.resolve({
          ok: false as const,
          error: "navigate: iframe is not mounted.",
        })
      }
      return navigateIframeAwaitingRoute({
        iframe,
        targetUrl,
        targetRoute,
        expectReload,
        setCurrentPageInfo,
        signal,
      })
    },
    [iframeRef, prototypeUrl, setCurrentPageInfo],
  )

  // Phase 3 — ask_user_question. The agent calls this to present a
  // multiple-choice decision to the user. The handler returns a
  // long-lived Promise that resolves when the user clicks an option
  // or aborts when the turn's signal fires (Stop button). Only one
  // question can be pending at a time: if a second arrives while one
  // is active, the first is dismissed before the new one is shown.
  const handleAskUserQuestion = useCallback<ChatBridgeHandler>(
    (payload, signal) => {
      const p = payload as {
        question?: string
        options?: string[]
        multiSelect?: boolean
      }
      const question = p?.question ?? ""
      const options = Array.isArray(p?.options) ? (p.options as string[]) : []
      const multiSelect = p?.multiSelect === true

      // Dismiss any prior pending question so the UI never shows two
      // at once. We resolve to ok:false (dismissed) rather than
      // leaving the prior Promise hanging.
      const prior = pendingQuestionRef.current
      if (prior) {
        prior.resolve({ ok: false, error: "user dismissed the question" })
      }

      return new Promise<
        | { ok: true; output: { selected: string[] } }
        | { ok: false; error: string }
      >((resolve) => {
        // Declared up front so the resolve wrapper can detach it on the
        // normal (click/dismiss) path — otherwise the listener leaks on
        // the turn's signal and accumulates across repeated questions in
        // one turn (MaxListenersExceededWarning + stale callbacks).
        let onAbort: (() => void) | null = null
        const entry: PendingQuestion = {
          question,
          options,
          multiSelect,
          resolve: (r) => {
            if (onAbort && signal) {
              signal.removeEventListener("abort", onAbort)
              onAbort = null
            }
            resolve(r)
            // Clear state when this specific entry resolves (not a
            // stale prior entry that was already dismissed).
            if (pendingQuestionRef.current === entry) {
              pendingQuestionRef.current = null
            }
            setPendingQuestion((current) =>
              current === entry ? null : current,
            )
          },
        }
        pendingQuestionRef.current = entry
        setPendingQuestion(entry)

        // Wire the abort signal so that clicking Stop mid-question
        // doesn't leave the UI stuck and doesn't leave the pending
        // bridge request hanging on the server. The listener is removed
        // in `entry.resolve` on every path, so it never outlives the
        // question.
        if (signal) {
          if (signal.aborted) {
            entry.resolve({
              ok: false,
              error: "user dismissed the question",
            })
          } else {
            onAbort = () => {
              entry.resolve({
                ok: false,
                error: "user dismissed the question",
              })
            }
            signal.addEventListener("abort", onAbort)
          }
        }
      })
    },
    [],
  )

  const bridgeHandlers = useMemo<ChatBridgeHandlers>(
    () => ({
      "chat:capture_screenshot": handleCaptureScreenshot,
      "chat:resolve_target": handleResolveTarget,
      "chat:perform_interact": handlePerformInteract,
      "chat:read_rendered_value": handleReadRenderedValue,
      "chat:read_measurements": handleReadMeasurements,
      "chat:get_selection": handleGetSelection,
      "chat:pin_selections": handlePinSelections,
      "chat:get_page_info": handleGetPageInfo,
      "chat:navigate": handleNavigate,
      ask_user_question: handleAskUserQuestion,
    }),
    [
      handleCaptureScreenshot,
      handleResolveTarget,
      handlePerformInteract,
      handleReadRenderedValue,
      handleReadMeasurements,
      handleGetSelection,
      handlePinSelections,
      handleGetPageInfo,
      handleNavigate,
      handleAskUserQuestion,
    ],
  )

  return { bridgeHandlers, pendingQuestion }
}

/**
 * Desde Bridge — MCP query messages
 *
 * Extracted from `comment-bridge.ts` (share-readiness Phase 2, second
 * decomposition pass). Mechanical move — no behavior/protocol change.
 *
 * These are the shell→bridge query messages the MCP tools (get-code.ts,
 * get-assets.ts, …) and editor's tiered-resolution adapter drive:
 * inspecting the current/point/parent/many selection(s), the full DOM
 * outline, an element screenshot, and page-level design tokens. Each is a
 * fire-and-respond pair keyed by `requestId`.
 *
 * `handleMcpQuery` is a single dispatcher the main postMessage switch calls
 * BEFORE its own switch — returns `true` when it owned `data.type` (so the
 * caller returns early) or `false` when the message isn't one of these query
 * types (so the caller's own switch runs as before).
 */
import { sendToShell, inspectElement, attributeElement } from "./bridge-runtime"
import type { InspectorOverlayManager } from "./inspector-overlay"
import {
  detectOutlineComponent,
  extractPackageName,
  type OutlineNode,
} from "./framework-component-detection"
import { generateSelector } from "./selector-engine"
import { isBridgeOwnElement } from "./selector-helpers"
import { resolveHtml2canvasGlobal } from "./html2canvas-loader"

export interface McpQueryDeps {
  inspector: InspectorOverlayManager
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * Read `data.payload` without assuming it exists.
 *
 * The dispatcher only checks that `data.type` is a string, so a message with
 * no `payload` reaches a case that dereferences one. That threw a TypeError
 * out of the message listener — and because the throw happened BEFORE any
 * `sendToShell`, the shell's request promise simply never settled: the caller
 * hangs rather than getting an error. An absent payload should take the same
 * "nothing usable here" branch each case already has for a bad value.
 */
function payloadOf(data: unknown): Record<string, unknown> {
  const p = (data as { payload?: unknown } | null)?.payload
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {}
}

export function handleMcpQuery(data: any, deps: McpQueryDeps): boolean {
  const { inspector } = deps

  switch (data.type) {
    case "GET_CURRENT_INSPECTION": {
      const reqId = (data as { requestId: string }).requestId
      const currentEl = inspector.getSelectedElement()
      if (currentEl) {
        try {
          const inspData = inspectElement(currentEl)
          sendToShell({ type: "ELEMENT_INSPECTED", payload: inspData, requestId: reqId } as Record<string, unknown>)
        } catch (err) {
          console.warn("[Desde MCP] get current inspection failed:", err)
          sendToShell({ type: "ELEMENT_INSPECTED", payload: null, requestId: reqId } as Record<string, unknown>)
        }
      } else {
        sendToShell({ type: "ELEMENT_INSPECTED", payload: null, requestId: reqId } as Record<string, unknown>)
      }
      return true
    }
    case "INSPECT_MANY": {
      // Phase 6 multi-select. Resolves each selector to its
      // InspectionData and emits ELEMENTS_INSPECTED with the list
      // (preserving input order, skipping unresolved selectors).
      // Pins the FIRST resolved element as the bridge's internal
      // `selectedElement` so the existing single-selection click
      // path stays coherent.
      const reqId = (data as { requestId: string }).requestId
      const selectorsValue = payloadOf(data).selectors
      if (!Array.isArray(selectorsValue) || selectorsValue.length === 0) {
        sendToShell({
          type: "ELEMENTS_INSPECTED",
          payload: [],
          requestId: reqId,
        } as Record<string, unknown>)
        return true
      }
      const resolved: Record<string, unknown>[] = []
      let pinned = false
      for (const sel of selectorsValue) {
        if (typeof sel !== "string" || sel.length === 0) continue
        let matches: NodeListOf<Element>
        try {
          matches = document.querySelectorAll(sel)
        } catch {
          continue
        }
        if (matches.length === 0) continue
        const candidate = matches[0]
        if (isBridgeOwnElement(candidate)) continue
        try {
          const inspData = inspectElement(candidate) as Record<string, unknown>
          resolved.push(inspData)
          if (!pinned) {
            inspector.setSelectedElement(candidate)
            pinned = true
          }
        } catch (err) {
          console.warn("[Desde] INSPECT_MANY: inspect failed for", sel, err)
        }
      }
      sendToShell({
        type: "ELEMENTS_INSPECTED",
        payload: resolved,
        requestId: reqId,
      } as Record<string, unknown>)
      return true
    }
    case "INSPECT_SELECTOR": {
      const selectorValue = payloadOf(data).selector as string | undefined
      const reqId = (data as { requestId: string }).requestId
      // Legacy MCP and review-app consumers expect ELEMENT_INSPECTED
      // { payload: null } on no-match. Only editor (which speaks the
      // tiered protocol) gets the new ELEMENT_INSPECTION_UNRESOLVED
      // variants; gate by editor mode so the existing MCP tools at
      // mcp-server/src/tools/get-code.ts and get-assets.ts (which cast
      // to InspectionData and dereference .styles) keep working.
      const useTieredResolution = inspector.isEditorMode()
      const emitNotFound = (targetId: string, reason: "not-found" | "in-toolbar" | "ambiguous", extras?: Record<string, unknown>) => {
        if (useTieredResolution) {
          sendToShell({
            type: "ELEMENT_INSPECTION_UNRESOLVED",
            payload: { targetId, reason, ...(extras ?? {}) },
            requestId: reqId,
          } as Record<string, unknown>)
        } else {
          sendToShell({ type: "ELEMENT_INSPECTED", payload: null, requestId: reqId } as Record<string, unknown>)
        }
      }
      if (!selectorValue) {
        emitNotFound("", "not-found")
        return true
      }
      let matches: NodeListOf<Element>
      try {
        matches = document.querySelectorAll(selectorValue)
      } catch {
        emitNotFound(selectorValue, "not-found")
        return true
      }
      if (matches.length === 0) {
        emitNotFound(selectorValue, "not-found")
      } else if (matches.length === 1) {
        const sole = matches[0]
        if (isBridgeOwnElement(sole)) {
          emitNotFound(selectorValue, "in-toolbar")
          return true
        }
        try {
          const inspData = inspectElement(sole)
          // In editor mode, programmatic selection (e.g., from the
          // layers panel) must keep the bridge's internal selection
          // state in sync with editor's. Without this, the next
          // iframe click on `sole` takes the bridge's
          // toggle-deselect branch against a stale selectedElement
          // and the user sees a phantom deselect.
          if (useTieredResolution) {
            inspector.setSelectedElement(sole)
          }
          sendToShell({ type: "ELEMENT_INSPECTED", payload: inspData, requestId: reqId } as Record<string, unknown>)
        } catch (err) {
          console.warn("[Desde MCP] inspect selector failed:", err)
          emitNotFound(selectorValue, "not-found")
        }
      } else if (useTieredResolution) {
        const candidates: Record<string, unknown>[] = []
        matches.forEach((m) => {
          try {
            candidates.push(inspectElement(m) as Record<string, unknown>)
          } catch { /* skip */ }
        })
        sendToShell({
          type: "ELEMENT_INSPECTION_UNRESOLVED",
          payload: { targetId: selectorValue, reason: "ambiguous", candidates },
          requestId: reqId,
        } as Record<string, unknown>)
      } else {
        // Legacy: pick the first match (matches existing pre-bump behavior).
        try {
          const inspData = inspectElement(matches[0])
          sendToShell({ type: "ELEMENT_INSPECTED", payload: inspData, requestId: reqId } as Record<string, unknown>)
        } catch (err) {
          console.warn("[Desde MCP] inspect selector failed:", err)
          sendToShell({ type: "ELEMENT_INSPECTED", payload: null, requestId: reqId } as Record<string, unknown>)
        }
      }
      return true
    }
    case "READ_RENDERED_VALUE": {
      // Tier-2 edit verification (P1): read the current rendered value at
      // a selector so the shell can confirm a deterministic edit actually
      // took effect in the live DOM. {selector, accessor:{kind,name?}} →
      // RENDERED_VALUE_READ {value}. Fire-and-respond via requestId.
      const reqId = (data as { requestId: string }).requestId
      const rvPayload = (data as {
        payload: { selector: string; accessor: { kind: string; name?: string } }
      }).payload
      const respondValue = (value: string | null) =>
        sendToShell({
          type: "RENDERED_VALUE_READ",
          payload: { value },
          requestId: reqId,
        } as Record<string, unknown>)
      const rvSelector = rvPayload?.selector
      const rvAccessor = rvPayload?.accessor
      if (!rvSelector || !rvAccessor) {
        respondValue(null)
        return true
      }
      let rvEl: Element | null = null
      try {
        rvEl = document.querySelector(rvSelector)
      } catch {
        respondValue(null)
        return true
      }
      if (!rvEl || isBridgeOwnElement(rvEl)) {
        respondValue(null)
        return true
      }
      try {
        if (rvAccessor.kind === "text") {
          respondValue(rvEl.textContent)
        } else if (rvAccessor.kind === "attr") {
          if (!rvAccessor.name) {
            respondValue(null)
          } else if (
            rvAccessor.name === "checked" &&
            rvEl instanceof HTMLInputElement
          ) {
            // `checked` is meaningful only on <input>; reading it off a
            // <textarea>/<select> would yield "undefined".
            respondValue(String(rvEl.checked))
          } else if (
            rvAccessor.name === "value" &&
            (rvEl instanceof HTMLInputElement ||
              rvEl instanceof HTMLTextAreaElement ||
              rvEl instanceof HTMLSelectElement)
          ) {
            // Form controls' displayed value is the live property, not the
            // (often stale) attribute.
            respondValue(String(rvEl.value))
          } else {
            respondValue(rvEl.getAttribute(rvAccessor.name))
          }
        } else if (rvAccessor.kind === "style") {
          respondValue(
            rvAccessor.name
              ? getComputedStyle(rvEl as HTMLElement)
                  .getPropertyValue(rvAccessor.name)
                  .trim()
              : null,
          )
        } else {
          respondValue(null)
        }
      } catch {
        respondValue(null)
      }
      return true
    }
    case "READ_MEASUREMENTS": {
      // Tier-2 edit verification (P2): read live geometry + a small
      // computed-style subset at a selector so the shell can judge a fuzzy
      // goal against a measurable predicate (overflow / viewport-fit /
      // alignment / bbox-match / contrast / text). {selector} →
      // MEASUREMENTS_READ {measurements}. Mirrors READ_RENDERED_VALUE's
      // request/respond shape; reuses the inspector's own DOM reads.
      const reqId = (data as { requestId: string }).requestId
      const mPayload = (data as { payload: { selector: string } }).payload
      const respondMeasurements = (
        measurements: Record<string, unknown> | null,
      ) =>
        sendToShell({
          type: "MEASUREMENTS_READ",
          payload: { measurements },
          requestId: reqId,
        } as Record<string, unknown>)
      const mSelector = mPayload?.selector
      if (!mSelector) {
        respondMeasurements(null)
        return true
      }
      let mEl: Element | null = null
      try {
        mEl = document.querySelector(mSelector)
      } catch {
        respondMeasurements(null)
        return true
      }
      if (!mEl || isBridgeOwnElement(mEl)) {
        respondMeasurements(null)
        return true
      }
      try {
        const rectJson = (el: Element) => {
          const r = el.getBoundingClientRect()
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            left: r.left,
          }
        }
        const cs = getComputedStyle(mEl as HTMLElement)
        // Text for `textEquals` ("make it say Y" → the authored CONTENT).
        // Use textContent, NOT innerText: innerText applies CSS
        // text-transform (source "save" + uppercase → "SAVE"), which would
        // false-fail a correct content edit (verified empirically). Form
        // controls have empty textContent though, so mirror the
        // READ_RENDERED_VALUE special-case and read their .value /
        // selected-option label.
        let measuredText: string
        if (
          mEl instanceof HTMLInputElement ||
          mEl instanceof HTMLTextAreaElement
        ) {
          measuredText = String(mEl.value)
        } else if (mEl instanceof HTMLSelectElement) {
          measuredText = String(
            mEl.selectedOptions?.[0]?.text ?? mEl.value,
          )
        } else {
          measuredText = mEl.textContent ?? ""
        }
        respondMeasurements({
          bbox: rectJson(mEl),
          scrollWidth: (mEl as HTMLElement).scrollWidth,
          clientWidth: (mEl as HTMLElement).clientWidth,
          scrollHeight: (mEl as HTMLElement).scrollHeight,
          clientHeight: (mEl as HTMLElement).clientHeight,
          parentBbox: mEl.parentElement ? rectJson(mEl.parentElement) : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          computedStyle: {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontSize: cs.fontSize,
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            textTransform: cs.textTransform,
          },
          // Authored text content (textContent for elements, .value /
          // option-label for form controls — computed just above).
          textContent: measuredText,
        })
      } catch {
        respondMeasurements(null)
      }
      return true
    }
    case "INSPECT_POINT": {
      const point = (data as { payload: { x: number; y: number } }).payload
      const reqId = (data as { requestId: string }).requestId
      const target = inspector.selectAtPoint(point.x, point.y)
      if (target) {
        try {
          sendToShell({ type: "ELEMENT_INSPECTED", payload: inspectElement(target), requestId: reqId } as Record<string, unknown>)
        } catch (err) {
          console.warn("[Desde Inspector] inspect point failed:", err)
          sendToShell({
            type: "ELEMENT_INSPECTION_UNRESOLVED",
            payload: { targetId: "", reason: "not-found" },
            requestId: reqId,
          } as Record<string, unknown>)
        }
      } else {
        sendToShell({
          type: "ELEMENT_INSPECTION_UNRESOLVED",
          payload: { targetId: "", reason: "not-found" },
          requestId: reqId,
        } as Record<string, unknown>)
      }
      return true
    }
    case "INSPECT_PARENT": {
      const inSel = payloadOf(data).selector as string | undefined
      const reqId = (data as { requestId: string }).requestId
      const sourceEl = inSel ? document.querySelector(inSel) : null
      if (!sourceEl) {
        sendToShell({
          type: "ELEMENT_INSPECTION_UNRESOLVED",
          payload: { targetId: inSel, reason: "not-found" },
          requestId: reqId,
        } as Record<string, unknown>)
        return true
      }
      const parentEl = inspector.findParentComponent(sourceEl)
      if (!parentEl) {
        sendToShell({
          type: "ELEMENT_INSPECTION_UNRESOLVED",
          payload: { targetId: inSel, reason: "not-found" },
          requestId: reqId,
        } as Record<string, unknown>)
        return true
      }
      try {
        inspector.setSelectedElement(parentEl)
        sendToShell({ type: "ELEMENT_INSPECTED", payload: inspectElement(parentEl), requestId: reqId } as Record<string, unknown>)
      } catch (err) {
        console.warn("[Desde Inspector] inspect parent failed:", err)
        sendToShell({
          type: "ELEMENT_INSPECTION_UNRESOLVED",
          payload: { targetId: inSel, reason: "not-found" },
          requestId: reqId,
        } as Record<string, unknown>)
      }
      return true
    }
    case "GET_STRUCTURE": {
      const reqId = (data as { requestId: string }).requestId
      const maxDepth = ((data as { payload?: { depth?: number } }).payload?.depth) || 15
      const NODE_CAP = 2000
      let nodeCount = 0

      function buildOutline(el: Element, depth: number): OutlineNode | null {
        if (nodeCount >= NODE_CAP || depth > maxDepth) return null
        if ((el as HTMLElement).dataset?.prototypeFlow) return null
        nodeCount++
        // Capture id BEFORE recursing into children. If we read
        // nodeCount after the recursion, a parent's id can equal its
        // last descendant's id (every child increment moves nodeCount
        // forward) and React keys collide.
        const id = `n${nodeCount}`

        const rect = el.getBoundingClientRect()
        // Only label as component if this element is a component root (not a child)
        let name = el.tagName.toLowerCase()
        let nodeType: "element" | "component" | "text" = "element"
        let componentFile: string | undefined
        let packageName: string | undefined
        try {
          // Use the parent-chain-aware detector so transparent wrappers
          // (e.g. ProtoCatalogCard composed via <UiCard>) are labeled
           // by the prototype-authored component, not the design system
          // internals.
          const comp = detectOutlineComponent(el)
          if (comp) {
            name = comp.name
            nodeType = "component"
            componentFile = comp.file
            if (comp.file && comp.file.includes("node_modules")) {
              packageName = extractPackageName(comp.file)
            }
          }
        } catch { /* ignore */ }

        let selector = ""
        try {
          selector = generateSelector(el)
        } catch { /* ignore */ }

        let attribution: ReturnType<typeof attributeElement> = undefined
        try { attribution = attributeElement(el) } catch { /* ignore */ }

        const children: OutlineNode[] = []
        for (const child of Array.from(el.children)) {
          const childNode = buildOutline(child, depth + 1)
          if (childNode) children.push(childNode)
        }

        return {
          id,
          name,
          type: nodeType,
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          selector,
          componentFile,
          packageName,
          authoredAt: attribution?.authoredAt,
          editTarget: attribution?.editTarget,
          isLibrary: attribution?.isLibrary,
          iterationContext: attribution?.iteration,
          children: children.length > 0 ? children : undefined,
        }
      }

      const roots: OutlineNode[] = []
      const bodyChildren = document.body.children
      for (const child of Array.from(bodyChildren)) {
        if ((child as HTMLElement).dataset?.prototypeFlow) continue
        const node = buildOutline(child, 0)
        if (node) roots.push(node)
      }
      sendToShell({ type: "STRUCTURE_CAPTURED", payload: { roots }, requestId: reqId } as Record<string, unknown>)
      return true
    }
    case "CAPTURE_ELEMENT_SCREENSHOT": {
      const reqId3 = (data as { requestId: string }).requestId
      const selectorVal = ((data as { payload?: { selector?: string } }).payload?.selector)
      const targetEl = selectorVal ? document.querySelector(selectorVal) as HTMLElement | null : document.body as HTMLElement
      // Distinguish the failure modes the shell + agent need to tell apart:
      //   no-match      → the selector resolved to nothing on the current page
      //   empty-element → matched but zero-size (display:none / not rendered)
      //   render-failed → html2canvas threw (see .catch below)
      // Collapsing these into one null payload made every failure read as a
      // generic "capture failed or timed out", so the agent couldn't recover.
      const captureRect = targetEl && selectorVal ? targetEl.getBoundingClientRect() : null
      if (targetEl && captureRect && (captureRect.width < 1 || captureRect.height < 1)) {
        sendToShell({ type: "ELEMENT_SCREENSHOT_CAPTURED", payload: { error: "empty-element" }, requestId: reqId3 } as Record<string, unknown>)
      } else if (targetEl) {
        // Load html2canvas (vendored; served by the shell origin)
        const w = window as unknown as Record<string, unknown>
        const loadH2c = (): Promise<(el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement>> => {
          // Resolve across UMD shapes (stock = function, html2canvas-pro
          // = namespace with `.default`); see html2canvas-loader.ts.
          const existing = resolveHtml2canvasGlobal(w.html2canvas)
          if (existing) return Promise.resolve(existing)
          return new Promise((resolve, reject) => {
            const script = document.createElement("script")
            const origin = new URL(document.referrer || window.location.href).origin
            script.src = origin + "/vendor/html2canvas.min.js"
            script.onload = () => {
              const fn = resolveHtml2canvasGlobal((window as unknown as Record<string, unknown>).html2canvas)
              if (fn) resolve(fn)
              else reject(new Error("html2canvas failed to load"))
            }
            script.onerror = () => reject(new Error("Failed to load html2canvas"))
            document.head.appendChild(script)
          })
        }
        loadH2c().then((h2c) => {
          // Render at device resolution (capped at 2x) so SMALL element
          // captures — icons, chips, short labels — keep their detail for
          // the vision model. The byte problem is handled AFTER rendering by
          // the area/edge downscale below, which only shrinks captures that
          // actually exceed budget. (Capping at 2x — not raw dpr — bounds
          // the intermediate-canvas memory without hurting legibility.)
          const renderScale = Math.min(window.devicePixelRatio || 1, 2)
          return h2c(targetEl, { useCORS: true, allowTaint: true, scale: renderScale })
        }).then((rendered) => {
          // Downscale + recompress so large/dense captures land UNDER the
          // vision size cap (~4.5MB in media-content.ts) instead of being
          // refused. Cap total area (~1.5MP) and any single edge (1568px,
          // Anthropic's server-side resize threshold), preserving aspect.
          // Small captures fall through unchanged (scale stays 1).
          const MAX_PIXELS = 1_500_000
          const MAX_EDGE = 1568
          const srcW = rendered.width
          const srcH = rendered.height
          let scale = 1
          if (srcW * srcH > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (srcW * srcH))
          const longEdge = Math.max(srcW, srcH) * scale
          if (longEdge > MAX_EDGE) scale *= MAX_EDGE / longEdge
          let canvas: HTMLCanvasElement = rendered
          if (scale < 1) {
            const dw = Math.max(1, Math.round(srcW * scale))
            const dh = Math.max(1, Math.round(srcH * scale))
            const off = document.createElement("canvas")
            off.width = dw
            off.height = dh
            const ctx = off.getContext("2d")
            if (ctx) {
              ctx.imageSmoothingEnabled = true
              ctx.imageSmoothingQuality = "high"
              ctx.drawImage(rendered, 0, 0, dw, dh)
              canvas = off
            }
          }
          // Keep a crisp PNG when it's already small; otherwise prefer WebP
          // (small + sharp text), falling back to JPEG where WebP isn't
          // supported (toDataURL returns a PNG data URL in that case). The
          // `png` field name is historical — the value is a data URL whose
          // own MIME header drives downstream decoding (media-content.ts).
          const PNG_KEEP_LIMIT = 1_200_000 // ~0.9MB decoded
          let dataUrl = canvas.toDataURL("image/png")
          if (dataUrl.length > PNG_KEEP_LIMIT) {
            const webp = canvas.toDataURL("image/webp", 0.9)
            dataUrl = webp.indexOf("data:image/webp") === 0
              ? webp
              : canvas.toDataURL("image/jpeg", 0.85)
          }
          sendToShell({
            type: "ELEMENT_SCREENSHOT_CAPTURED",
            payload: { png: dataUrl, width: canvas.width, height: canvas.height },
            requestId: reqId3,
          } as Record<string, unknown>)
        }).catch((err) => {
          console.warn("[Desde MCP] screenshot failed:", err)
          sendToShell({ type: "ELEMENT_SCREENSHOT_CAPTURED", payload: { error: "render-failed", message: err instanceof Error ? err.message : String(err) }, requestId: reqId3 } as Record<string, unknown>)
        })
      } else {
        sendToShell({ type: "ELEMENT_SCREENSHOT_CAPTURED", payload: { error: "no-match" }, requestId: reqId3 } as Record<string, unknown>)
      }
      return true
    }
    case "GET_PAGE_TOKENS": {
      const reqId4 = (data as { requestId: string }).requestId
      const tokenMap: Record<string, { kind: string; value: string }> = {}

      // Collect from :root / html / body computed styles
      const rootStyle = window.getComputedStyle(document.documentElement)
      const bodyStyle = window.getComputedStyle(document.body)

      // Walk all stylesheets for custom properties
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              if (rule instanceof CSSStyleRule && (rule.selectorText === ":root" || rule.selectorText === "html" || rule.selectorText === "body")) {
                for (const prop of Array.from(rule.style)) {
                  if (prop.startsWith("--")) {
                    const resolved = rootStyle.getPropertyValue(prop).trim() || bodyStyle.getPropertyValue(prop).trim()
                    const kind = /^(#|rgb|hsl|oklch|lch|lab|oklab|color)/.test(resolved) ? "color"
                      : /^-?\d+(\.\d+)?(px|rem|em|%|vh|vw|pt|ch|ex)$/.test(resolved) ? "number"
                      : "string"
                    tokenMap[prop] = { kind, value: resolved }
                  }
                }
              }
            }
          } catch { /* cross-origin stylesheet */ }
        }
      } catch { /* styleSheets unavailable */ }

      sendToShell({ type: "PAGE_TOKENS_CAPTURED", payload: { tokens: tokenMap }, requestId: reqId4 } as Record<string, unknown>)
      return true
    }
    default:
      return false
  }
}

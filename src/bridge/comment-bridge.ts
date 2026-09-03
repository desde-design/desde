/**
 * Desde Bridge
 *
 * Standalone script injected into the prototype iframe.
 * Handles: selector engine, comment pins, placement overlay, dev inspector,
 * direct-manipulation overlays, postMessage communication.
 * All UI uses Shadow DOM for isolation. Elements tagged with data-prototype-flow
 * are excluded from selector capture.
 *
 * Built as an IIFE via esbuild `--bundle --format=iife`. ES module
 * imports below get inlined at bundle time; the runtime output is
 * still a single self-contained IIFE with no external deps.
 */
import { currentReactFiber, getReactComponentMountRoot } from "./framework-component-detection"
import { type FrameworkRuntimeAdapter as ImportedFrameworkRuntimeAdapter } from "./leaf-prop-attribution"
import {
  configureElementAttribution,
  attributeElement,
  inspectElement,
  findSourceAnchorElement,
} from "./element-attribution"
import { createDomEditMode } from "./dom-edit-mode"
import { collectStylesheetRefs, getStyleProvenance } from "./style-provenance"
import { isBridgeOwnElement } from "./selector-helpers"
import { getPageSourceFile } from "./inspection-extractors"
import type {
  CommentPosition,
  CommentAuthor,
  Comment,
  BridgeNote,
  SelectModeOverlay,
  ResolveOverridePayload,
  ApplyPropOverridePayload,
} from "./bridge-types"
import { configureBridgeRuntime } from "./bridge-runtime"
import { CommentPinsManager } from "./comment-pins"
import { NotePinsManager } from "./note-pins"
import { TableEdgeOverlayManager } from "./table-edge-overlay"
import { DragMoveOverlayManager } from "./drag-move-overlay"
import { InsertPlacementOverlayManager } from "./insert-placement-overlay"
import { ResizeOverlayManager } from "./resize-overlay"
import { InspectorOverlayManager } from "./inspector-overlay"
import {
  resolveSemanticTarget,
  performInteract,
  type InteractAction,
  type SemanticTargetInput,
} from "./semantic-target-resolver"
import { tracer } from "./tracer-attribution"
import { handleMcpQuery } from "./mcp-query-handlers"
import { createOverridePreview } from "./override-preview"

;(function () {
  "use strict"

  // ── BRIDGE_VERSION ────────────────────────────────────────────────────
  //
  // Bump this on every bridge change (see CLAUDE.md § Verification), then
  // `npm run build:bridge`.
  //
  // Shape matters: the literal is written STRAIGHT into the global and read
  // back, so it appears exactly once. `build:bridge` runs esbuild with
  // `--minify`, which renames identifiers — a literal bound to a `const`
  // that's referenced twice survives only as a renamed one-letter binding,
  // which no serve layer can find. Assigned once, esbuild inlines it into
  // the assignment to window.__DESDE_BRIDGE_VERSION__ — the stable
  // anchor both extractors regex for (editor-cli `extractBridgeVersion`,
  // the viewer's `html-inject`). Keep it a single-use literal;
  // bridge-bundle-version.test.ts fails if that stops holding.
  ;(window as unknown as Record<string, unknown>).__DESDE_BRIDGE_VERSION__ =
    "2026-09-03a-suspense-and-memo-chain"
  const BRIDGE_VERSION = (window as unknown as Record<string, unknown>)
    .__DESDE_BRIDGE_VERSION__ as string

  // ── postMessage origin discipline ─────────────────────────────────────
  //
  // The bridge protocol is exclusively shell↔iframe. Both serve layers
  // publish the shell's origin into the page at serve-time (never on disk).
  //
  // AUTHORITATIVE SOURCE: a `data-shell-origin` attribute on the bundle's
  // OWN `<script>` tag. The predecessor — an inline
  // `<script>window.__DESDE_SHELL_ORIGIN__=…</script>` ahead of the
  // bundle — is not survivable: any app serving `script-src 'self'` without
  // `'unsafe-inline'` drops the inline tag while the external bundle tag
  // loads fine, so the bridge booted with NO configured origin. An attribute
  // on the external tag is read from markup and no CSP can strip it.
  // The global is still read as a fallback so a serve layer that only emits
  // the old tag keeps working, but it is the compatibility path, not the
  // contract.
  //
  // Inbound: drop messages whose `event.origin` is neither the configured
  // shell nor the page's own origin. Outbound: address the shell instead
  // of broadcasting with `"*"`.
  //
  // FAIL CLOSED. Until 2026-08-10 an unconfigured origin meant accept-all +
  // `postMessage(…, "*")` with one console.warn, on the reasoning that a
  // version skew must not brick the bridge. That reasoning was wrong, and it
  // was exploited, not theorised: a page on an unrelated origin framing a
  // config-tag-less prototype received BRIDGE_READY, ELEMENT_INSPECTED
  // (selectors, geometry, computed styles, editable text), STRUCTURE_CAPTURED
  // and PAGE_TOKENS_CAPTURED (the whole design-token set), and drove
  // RESOLVE_TARGET + PERFORM_INTERACT + READ_RENDERED_VALUE into cross-origin
  // remote control of the developer's app. "Degraded but working" was worth
  // strictly less than "silent cross-origin read/write", so an unresolvable
  // shell origin now trusts nobody and posts nowhere.
  //
  // Same-origin senders remain trusted UNCONDITIONALLY — that allowance is
  // orthogonal to configuration. A same-origin embedder can already reach
  // into this document's DOM directly, so postMessage grants it nothing it
  // did not already have; refusing it would only break the dev harnesses
  // (tasks/scripts/bridge-smoke.mts drives the iframe from a driver page on
  // the Vite origin, which is NOT the shell origin) and the viewer's path
  // mode, where shell and prototype deliberately share an origin.
  let shellOriginRead = false
  let configuredShellOrigin: string | null = null

  /**
   * The bundle's own `<script>` element, captured at IIFE body time.
   * `document.currentScript` is only non-null while the script is executing,
   * and `getShellOrigin()` runs lazily on the first inbound message — long
   * after. Reading it here is the only way to get it.
   */
  const OWN_SCRIPT_ELEMENT: Element | null =
    typeof document !== "undefined" ? document.currentScript : null

  /**
   * Normalize a configured origin to the serialized form `event.origin`
   * carries, so `https://shell.example/` and `https://shell.example` compare
   * equal. Anything unparseable — or an opaque origin, which serializes to
   * the string `"null"` and would otherwise match every sandboxed sender —
   * is treated as unset.
   */
  function normalizeOrigin(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0) return null
    try {
      const origin = new URL(raw).origin
      return origin && origin !== "null" ? origin : null
    } catch {
      return null
    }
  }

  function readShellOriginAttribute(): string | null {
    if (typeof document === "undefined") return null
    const el =
      OWN_SCRIPT_ELEMENT ??
      // Fallback for a host that loads the bundle in a way that leaves
      // `document.currentScript` null (module wrapper, manual eval).
      document.querySelector('script[data-prototype-flow="bridge"][data-shell-origin]')
    return el?.getAttribute("data-shell-origin") ?? null
  }

  function getShellOrigin(): string | null {
    if (!shellOriginRead) {
      shellOriginRead = true
      configuredShellOrigin =
        normalizeOrigin(readShellOriginAttribute()) ??
        normalizeOrigin((window as unknown as Record<string, unknown>).__DESDE_SHELL_ORIGIN__)
      if (!configuredShellOrigin) {
        console.warn(
          "[Desde Bridge] no shell origin configured (neither a " +
            "data-shell-origin attribute on the bridge <script> tag nor " +
            "window.__DESDE_SHELL_ORIGIN__) — cross-origin postMessage is " +
            "REFUSED in both directions. Update the serve layer, or check whether " +
            "a strict CSP dropped the inline config tag.",
        )
      }
    }
    return configuredShellOrigin
  }

  /**
   * Origins already reported as rejected, so a chatty sender warns once.
   * Capped: a hostile page can mint unlimited distinct origins (wildcard
   * subdomains), and an unbounded Set would be a slow memory leak.
   */
  const warnedOrigins = new Set<string>()
  const WARNED_ORIGINS_LIMIT = 20

  /**
   * Is this message actually from the shell, rather than merely from
   * something that shares the shell's origin?
   *
   * The origin check alone is not sufficient. In PATH mode the prototype is
   * served from the same origin as the shell (`/p/{slug}/`), so
   * `origin === window.location.origin` is true for a script running inside
   * the prototype itself — untrusted, arbitrary code from a connected repo.
   * Such a script could `window.postMessage({type: "SET_ELEMENT_TEXT", …})`
   * to its own window and have the bridge act on it and answer over the
   * shell-bound channel.
   *
   * Every real sender posts from the PARENT into `iframe.contentWindow`
   * (`useEditorCommentBridge`, `useIframeBridgeRequest`, and the smoke
   * harnesses). So the parent window is the whole legitimate sender set.
   *
   * The un-framed case falls out correctly rather than needing an exception:
   * with no embedder `window.parent === window`, so a top-level harness that
   * self-posts still passes, while a self-post from a FRAMED prototype does
   * not — which is precisely the forgery being excluded.
   */
  function isTrustedMessageSource(source: MessageEventSource | null): boolean {
    return source !== null && source === window.parent
  }

  function isTrustedMessageOrigin(origin: string): boolean {
    // Opaque origins serialize to the STRING "null" — sandboxed iframes
    // (without allow-same-origin), `data:`/`blob:` documents, some
    // `file://` pages. Never trust one: if this document is itself opaque,
    // `window.location.origin` is also "null", so the same-origin check
    // below would compare "null" === "null" and open the gate to any
    // sandboxed sibling. Excluded before either comparison, so an opaque
    // sender always falls through to the reject path.
    const shellOrigin = getShellOrigin()
    if (origin !== "null") {
      // Unconditional — see "Same-origin senders remain trusted" above.
      if (origin === window.location.origin) return true
      if (shellOrigin !== null && origin === shellOrigin) return true
    }
    if (!warnedOrigins.has(origin) && warnedOrigins.size < WARNED_ORIGINS_LIMIT) {
      warnedOrigins.add(origin)
      console.warn(
        `[Desde Bridge] dropped message from untrusted origin ${origin} ` +
          (shellOrigin === null
            ? "(no shell origin is configured, so only same-origin senders are " +
              "accepted — see the boot warning above)."
            : `(expected ${shellOrigin}). If this is the editor shell, its host ` +
              `spelling disagrees with the CLI's — localhost vs 127.0.0.1 also 403s the HTTP API.`),
      )
    }
    return false
  }

  /**
   * Resolve an untrusted navigation target and return it as a same-origin
   * path (`pathname + search + hash`), or `null` if it is anything else.
   *
   * Used by the `NAVIGATE` handler, whose input is a comment-authored string.
   * Resolving against `window.location.href` and comparing `origin` is what
   * does the work: `javascript:` and `data:` URLs resolve to the opaque origin
   * (the string `"null"`), absolute URLs resolve to their own origin, and
   * protocol-relative `//evil.com/x` resolves to `evil.com` — none of which
   * equal ours. A bare path resolves to us and passes.
   *
   * Returns the RE-SERIALIZED path rather than the caller's string, so a
   * target that resolves same-origin by a quirk of parsing still navigates to
   * the parsed result, not to the raw input.
   */
  function sameOriginPath(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length === 0) return null
    let resolved: URL
    try {
      resolved = new URL(raw, window.location.href)
    } catch {
      return null
    }
    if (resolved.origin !== window.location.origin) return null
    // Belt and braces: an opaque origin serializes to "null", and if THIS
    // document is itself opaque the comparison above would be "null" ===
    // "null". Requiring the protocol to match too closes that.
    if (resolved.protocol !== window.location.protocol) return null
    return resolved.pathname + resolved.search + resolved.hash
  }

  /**
   * `targetOrigin` for outbound posts, or `null` when there is nobody we are
   * willing to address. Memoized: the embedder can't change origin without
   * tearing this document down with it.
   *
   * Never returns `"*"`. Broadcasting was the outbound half of the fail-open
   * defect — the inbound guard could be tightened all it liked while
   * BRIDGE_READY, ELEMENT_INSPECTED and PAGE_TOKENS_CAPTURED still went to
   * whatever page happened to be framing the prototype.
   */
  let shellTargetOrigin: string | null = null
  let shellTargetResolved = false

  function resolveShellTargetOrigin(): string | null {
    if (!shellTargetResolved) {
      shellTargetResolved = true
      // Reading `location.origin` on a cross-origin parent throws; that
      // throw IS the same-origin test. A same-origin embedder (dev
      // harness, viewer path mode) must be addressed by its own origin —
      // posting the configured shell origin at it would silently drop the
      // message.
      let sameOriginParent = false
      try {
        sameOriginParent = window.parent.location.origin === window.location.origin
      } catch {
        sameOriginParent = false
      }
      // `postMessage` throws a SyntaxError on a targetOrigin of "null", so an
      // opaque-origin document addresses nobody rather than crashing.
      const ownOrigin = window.location.origin
      shellTargetOrigin =
        sameOriginParent && ownOrigin && ownOrigin !== "null" ? ownOrigin : getShellOrigin()
    }
    return shellTargetOrigin
  }

  // ── Off-the-shelf source attribution (vite-plugin-vue-tracer) lives in
  // ./tracer-attribution ────────────────────────────────────────────────
  // (the lazily-read `tracer` client wrapper + detectIteration/
  // detectIterationViaStamp/detectIterationViaTracer — see that module's
  // header for the full vite-plugin-vue-tracer design.)

  // ── Types (mirrors src/types/comment.ts) ──────────────────────────────

  // Comment/Note payload types (CommentPosition, CommentAuthor, Comment,
  // BridgeNote) live in ./bridge-types

  // ── Selector Engine + Visibility helpers live in ./selector-engine ────
  // (generateSelector, candidateSelectors, looksGenerated, isUnique,
  //  buildClassSelector, buildNthChildPath, isElementVisible,
  //  getAncestorTabPanelIds, areTabPanelsActive)

  // ── Placement Overlay ─────────────────────────────────────────────────


  // ── PlacementOverlay lives in ./placement-overlay ─────────────────

  // ── Comment Pins ──────────────────────────────────────────────────────

  // ── CommentPinsManager (+ PINS_STYLES) lives in ./comment-pins ──────

  // ── Note Pins ─────────────────────────────────────────────────────────

  // ── NotePinsManager (+ NOTE_STYLES) lives in ./note-pins ─────────────

  // ── Style Categories live in ./style-categories ──────────────────────
  // (STYLE_CATEGORIES, isDefaultValue; DEFAULT_VALUES/ZERO_VALUES private)

  // ── Framework Component Detection lives in ./framework-component-detection ─
  // (detectFrameworkComponent, detectDirectComponent, detectOutlineComponent,
  //  buildVue3ComponentTree, buildReactComponentTree, extractComponentInfo,
  //  extractPackageName, getVueInstanceRootElement + internal detect*/serialize
  //  helpers; types FrameworkComponentInfo, ComponentTreeNode, OutlineNode)

  // ── Element Inspection ────────────────────────────────────────────────

  // ── Inspection extractors live in ./inspection-extractors ───────────
  // (extractDesignTokens, buildRawValueMap, getPageSourceFile, parseSourceTag;
  //  types InspectionStyleProperty/Category, InspectionDesignToken,
  //  InspectionBoxModelSides/Data)


  // Framework runtime adapter interface lives in `./leaf-prop-attribution`
  // so unit tests can implement stubs against it without booting the
  // bridge bundle. The local type alias keeps existing call sites
  // (`vue3RuntimeAdapter: FrameworkRuntimeAdapter`, etc.) compiling
  // unchanged while sharing the canonical contract with the
  // extracted attribution function and its tests.
  type FrameworkRuntimeAdapter = ImportedFrameworkRuntimeAdapter

  /**
   * Vue 3 runtime adapter. Reads the conventions Vue 3 sets on DOM
   * elements (`__vueParentComponent`) and component instances
   * (`type.__file`, `vnode.props`, `props`).
   *
   * Library detection: empty `__file` OR a `__file` containing
   * `node_modules`. Published libraries strip `__file` in their
   * production bundles (confirmed empirically: zero `__file`
   * references in the design system's `dist/`), so "empty" is the common
   * signal. User-authored SFCs in Vite dev mode keep `__file`
   * pointing at their own source path and are correctly rejected
   * here — their slot text is consumer-authored and falls through
   * to the slot-text path.
   */
  const vue3RuntimeAdapter: FrameworkRuntimeAdapter = {
    name: "vue3",
    getComponentName(instance) {
      const type = (instance as Record<string, unknown>)?.type as
        | Record<string, unknown>
        | undefined
      // `__name` is what `defineComponent` / the SFC compiler set; `name` is
      // the Options-API declaration.
      for (const key of ["__name", "name"] as const) {
        const v = type?.[key]
        if (typeof v === "string" && v.length > 0) return v
      }
      return null
    },
    hasOwnInstancePointer(el) {
      // Vue stamps this on every element it renders as its own vnode. Absent
      // means `el` came from a stringified static blob and is owned by some
      // ancestor — see `getOwningInstance` below for why that matters.
      return !!(el as unknown as Record<string, unknown>).__vueParentComponent
    },
    getOwningInstance(el) {
      // Vue stamps `__vueParentComponent` on every element it renders as an
      // individual vnode. But a fully-STATIC subtree gets stringified to one
      // `innerHTML` blob (Vue's `stringifyStatic` optimization — triggered
      // once a static run crosses a node/prop threshold, which the
      // source-tag plugin's per-element `data-desde-src` stamps push it toward,
      // and which a structural insert can tip), and those bulk-inserted
      // elements never receive the pointer. Walk up to the nearest ancestor
      // that DOES have it: a stringified static subtree lives entirely within
      // ONE component, so that ancestor is the owning instance. Without this,
      // inspecting any element in such a subtree (including ones you just
      // inserted) returns no source attribution — i.e. inserting into a
      // container silently makes the whole container un-selectable/un-editable.
      // Elements with their OWN pointer are unaffected (the slot-wrapper-leak
      // guard in attributeElement still sees their real instance), so this only
      // rescues otherwise-unattributable static nodes.
      let cur: Element | null = el
      while (cur) {
        const inst = (cur as Record<string, unknown>).__vueParentComponent as
          | Record<string, unknown>
          | null
          | undefined
        if (inst) return inst
        cur = cur.parentElement
      }
      return null
    },
    isLibraryInstance(instance) {
      // Derived from getInstanceFile so the two stay consistent —
      // null OR `node_modules` substring both mean "library." Same
      // shape the React adapter will use against
      // `fiber._debugSource.fileName`.
      const file = vue3RuntimeAdapter.getInstanceFile(instance)
      return file === null || file.split("/").includes("node_modules")
    },
    getCallSiteStamp(instance) {
      const i = instance as Record<string, unknown>
      const vnode = i.vnode as Record<string, unknown> | undefined
      // `data-desde-src` (editor's injected source-tag plugin) is the PRIMARY,
      // precise source: it reads the exact template AST column. The tracer is
      // sourcemap-based, so for static-hoisted / mid-line elements its column
      // is coarse (it can land columns away from the real `<Tag>`), which makes
      // the edit service fail to locate the node. So prefer the stamp here; the
      // tracer is only a fallback for substrates with no `data-desde-src` at all.
      // Vue stores `vnode.props` before inheritAttrs / multi-root fallthrough,
      // so this is the callsite, not an inherited stamp.
      const props = vnode?.props as Record<string, unknown> | undefined
      const stamp = props?.["data-desde-src"]
      if (typeof stamp === "string") return stamp
      return tracer.stamp(tracer.locFromVNode(vnode))
    },
    getInstanceMountRoot(instance) {
      const i = instance as Record<string, unknown>
      const subTree = i.subTree as { el?: unknown } | undefined
      const el = subTree?.el
      return el instanceof Element ? el : null
    },
    getParentInstance(instance) {
      const i = instance as Record<string, unknown>
      return (i.parent as Record<string, unknown> | null | undefined) ?? null
    },
    getRenderOwnerInstance(instance) {
      // Vue records the creating render context on the vnode itself, so this
      // is a direct read rather than an inference. MEASURED: KPop nested in
      // KTooltip reports ctx KTooltip (parent rendered it), while a KButton
      // written in AIGatewayListShell.vue and slotted into PageLayout reports
      // ctx AIGatewayListShell against parent PageLayout.
      const i = instance as Record<string, unknown>
      const vnode = i.vnode as Record<string, unknown> | undefined
      return (vnode?.ctx as Record<string, unknown> | null | undefined) ?? null
    },
    getInstanceFile(instance) {
      const i = instance as Record<string, unknown>
      const type = i.type as Record<string, unknown> | undefined
      const file = type?.__file
      return typeof file === "string" && file.length > 0 ? file : null
    },
    getInstanceIterationKey(instance) {
      const i = instance as Record<string, unknown>
      const vnode = i.vnode as Record<string, unknown> | undefined
      const key = vnode?.key
      return typeof key === "string" || typeof key === "number" ? key : null
    },
    readDeclaredProps(instance) {
      const i = instance as Record<string, unknown>
      const props = i.props as Record<string, unknown> | undefined
      if (!props) return {}
      const out: Record<string, unknown> = {}
      for (const propName of Object.keys(props)) {
        // Vue marks internals with a `__` prefix on the props object.
        if (propName.startsWith("__")) continue
        // Event listeners — `onClick`, `onMyEvent`. Universal Vue/React
        // convention so we filter at the adapter level for consistency.
        if (
          propName.length > 2 &&
          propName.startsWith("on") &&
          propName[2] >= "A" &&
          propName[2] <= "Z"
        ) continue
        out[propName] = props[propName]
      }
      return out
    },
    wasRenderedByInstanceTemplate(el, instance) {
      // Vue 3 stamps `__vnode` on each DOM element during patch, with
      // `vnode.ctx` pointing at the COMPONENT THAT AUTHORED the
      // vnode. For text rendered by UiEmptyState's own template
      // (`<h2>{{ title }}</h2>`), `ctx === UiEmptyState instance`.
      // For slot/children fragments the consumer passed in,
      // `ctx === consumer instance` even when `__vueParentComponent`
      // (the mounting component) is UiEmptyState. The identity check
      // discriminates the two precisely.
      //
      // If `__vnode` isn't present (defensive — patch hasn't run, or
      // Vue version changed the convention), fall back to TRUE so we
      // preserve the pre-disambiguation behavior. The single-match +
      // library-only filters upstream already keep the false-positive
      // surface narrow; "fail open" matches the conservative stance
      // (better to surface a prop field that the dispatch may have
      // to refuse than to silently hide it).
      const vnode = (el as Record<string, unknown>).__vnode as
        | Record<string, unknown>
        | undefined
      if (!vnode) return true
      const ctx = vnode.ctx as unknown
      if (ctx === undefined || ctx === null) return true
      return ctx === instance
    },
    readConsumerVnodeProps(instance) {
      // Vue 3 stores the consumer's passed-in props on
      // `instance.vnode.props` and marks which props came from
      // bindings (`:prop="expr"`) on `instance.vnode.dynamicProps`
      // (string[] of prop names). The latter is populated by Vue's
      // template compiler at build time — static `prop="literal"`
      // attrs don't appear; v-bind shorthand `:prop="x"` does.
      //
      // Returns null when the instance has no vnode (synthetic root,
      // hydration placeholder); the build-attribution-context layer
      // treats null as "no consumer props" and downstream attribute()
      // refuses prop edits for that entry.
      const i = instance as Record<string, unknown>
      const vnode = i.vnode as Record<string, unknown> | undefined
      if (!vnode) return null
      const vnodeProps = vnode.props as Record<string, unknown> | undefined
      const dynamicProps = vnode.dynamicProps as string[] | undefined
      if (!vnodeProps) return { props: {}, boundPropNames: new Set() }
      const props: Record<string, unknown> = {}
      // Collect the `data-desde-bind:<prop>` compile stamps emitted by the
      // source-tag plugin (Phase 2c) keyed by the bound prop name. These
      // are filtered OUT of `props` (they carry the `data-desde-` prefix)
      // but surfaced separately so build-attribution-context can attach
      // each binding's source loc + expression text.
      const boundPropStamps: Record<string, string> = {}
      const BIND_PREFIX = "data-desde-bind:"
      for (const propName of Object.keys(vnodeProps)) {
        // Filter Vue internals (__*), event listeners (onSomething),
        // ref/key, and the source-stamp attrs themselves so the
        // consumer-facing prop map stays minimal and editable.
        if (propName.startsWith("__")) continue
        if (propName === "ref" || propName === "key") continue
        if (propName.startsWith("data-desde-")) {
          if (propName.startsWith(BIND_PREFIX)) {
            const boundName = propName.slice(BIND_PREFIX.length)
            const stamp = vnodeProps[propName]
            if (boundName && typeof stamp === "string") {
              boundPropStamps[boundName] = stamp
            }
          }
          continue
        }
        if (
          propName.length > 2 &&
          propName.startsWith("on") &&
          propName[2] >= "A" &&
          propName[2] <= "Z"
        ) continue
        props[propName] = vnodeProps[propName]
      }
      // Intersect dynamicProps with the filtered set so the bound-
      // names set never claims to mark a prop we filtered out.
      const boundPropNames = new Set<string>()
      if (dynamicProps) {
        for (const name of dynamicProps) {
          if (name in props) boundPropNames.add(name)
        }
      }
      return { props, boundPropNames, boundPropStamps }
    },
  }

  /**
   * React runtime adapter. Reads conventions React sets on DOM
   * elements (`__reactFiber$<random>`) and fibers (`return`,
   * `_debugOwner`, `memoizedProps`, `key`, `stateNode`,
   * `_debugSource` on React ≤18).
   *
   * Source-tagging is the load-bearing gap on modern React.
   * Specifically:
   *  - React 17/18 dev builds with `@babel/plugin-transform-react-jsx-source`
   *    populate `fiber._debugSource = {fileName, lineNumber,
   *    columnNumber}` — the JSX CALLSITE (i.e. where `<Tag />` is
   *    written in user code). That's the right value for
   *    `getCallSiteStamp`. The migrated codepath uses it when
   *    present.
   *  - React 19 dropped `_debugSource` (confirmed: zero matches in
   *    `react-dom-client.development.js@19.x`) in favor of
   *    `_debugStack` (an Error captured at JSX time, requires
   *    parsing) and `_debugOwner`. Until we add a `_debugStack`
   *    parser or a custom Babel plugin that stamps callsites onto
   *    fibers, `getCallSiteStamp` returns null on React 19 and the
   *    adapter degrades to the slot-text path — no crashes, just
   *    no named-prop attribution for React 19 components yet.
   *  - `getInstanceFile` (component DEFINITION file) is NOT
   *    `_debugSource` even on React ≤18 — `_debugSource` is the
   *    callsite, not where the component was authored. React fibers
   *    don't expose definition-file metadata cleanly. Returns null,
   *    which makes `isLibraryInstance` default to true (matches the
   *    safe-fallback the Vue adapter takes on stripped `__file`).
   *    Codex round-1 P0 #2 — the prior draft conflated the two.
   *
   * Concrete consequence: React adapter attribution works under
   * React ≤18 + JSX source plugin (the common Create React App and
   * Next.js ≤14 dev configurations); for React 19 the bridge
   * gracefully falls back to the slot-text + server-side inferrer
   * path. See `tasks/framework-runtime-adapter.md` for the React
   * 19+ source-tagging follow-up.
   */
  let reactFiberKey: string | null = null
  function getReactFiber(el: Element): Record<string, unknown> | null {
    // The `__reactFiber$<suffix>` random suffix is per-React-root but
    // consistent across all elements on the page. Cache after first
    // resolve so subsequent lookups are O(1).
    if (reactFiberKey !== null) {
      // Resolved to the CURRENT alternate: the DOM node's pointer is the
      // stale one on every other commit (see `currentReactFiber`).
      const cached = (el as Record<string, unknown>)[reactFiberKey] as Record<string, unknown> | undefined
      return cached ? currentReactFiber(cached) : null
    }
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactFiber$")) {
        reactFiberKey = k
        const found = (el as Record<string, unknown>)[k] as Record<string, unknown> | undefined
        return found ? currentReactFiber(found) : null
      }
    }
    return null
  }

  // React WorkTag constants we care about for "is this a component fiber?"
  // (vs. a DOM/host fiber). Sourced from
  // https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactWorkTags.js
  //
  //   0  = FunctionComponent
  //   1  = ClassComponent
  //   5  = HostComponent (DOM element — what we walk PAST)
  //   11 = ForwardRef
  //   14 = MemoComponent
  //   15 = SimpleMemoComponent
  const REACT_COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])

  function findReactComponentFiber(
    start: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    let cur = start
    while (cur) {
      const tag = cur.tag as number | undefined
      if (typeof tag === "number" && REACT_COMPONENT_TAGS.has(tag)) return cur
      cur = (cur.return as Record<string, unknown> | null | undefined) ?? null
    }
    return null
  }

  const reactRuntimeAdapter: FrameworkRuntimeAdapter = {
    name: "react",
    getComponentName(instance) {
      // `fiber.type` is the component function/class. React puts the name on
      // `displayName` (set by devtools, HOCs, or the author) or the plain
      // function `name`. `memo`/`forwardRef` wrap the real component in an
      // object, so unwrap one level via `.type` / `.render` before giving up
      // — otherwise every memoized component reads as anonymous.
      const t = (instance as Record<string, unknown>)?.type as unknown
      const candidates: unknown[] = [t]
      if (t && typeof t === "object") {
        candidates.push(
          (t as Record<string, unknown>).type,
          (t as Record<string, unknown>).render,
        )
      }
      for (const c of candidates) {
        if (!c) continue
        const rec = c as Record<string, unknown>
        for (const key of ["displayName", "name"] as const) {
          const v = rec[key]
          if (typeof v === "string" && v.length > 0) return v
        }
      }
      return null
    },
    hasOwnInstancePointer(el) {
      // React attaches a fiber to every host element it renders — there is no
      // `stringifyStatic` equivalent to skip one — so the presence of the
      // element's own fiber is the direct-pointer answer.
      return !!getReactFiber(el)
    },
    getOwningInstance(el) {
      // React DOM elements' fiber is the HostComponent. The OWNING
      // component (what Vue calls `__vueParentComponent`) is the
      // nearest component-type fiber above it in the fiber tree —
      // walk `return`.
      const hostFiber = getReactFiber(el)
      if (!hostFiber) return null
      return findReactComponentFiber(hostFiber.return as Record<string, unknown> | null)
    },
    isLibraryInstance(instance) {
      // React fibers don't expose component-definition file
      // reliably (see header). `getInstanceFile` returns null, so we
      // can't distinguish user-authored from library by file path.
      // Defaulting to TRUE matches the safer policy: library-treated
      // components route through the prop-attribution path which
      // requires a callsite stamp (so it skips when there is none),
      // and `wasRenderedByInstanceTemplate` still catches slot
      // content. User-authored React components in dev where
      // `_debugSource` IS present get the same attribution path —
      // and we know it's correct because the rest of the
      // FrameworkRuntimeAdapter conditions all check the data we DO
      // have, not the data we don't.
      void instance
      return true
    },
    getCallSiteStamp(instance) {
      // Preferred: the JSX callsite stamp the source-tag plugin
      // (jsx-source-tag-plugin) writes as a `data-desde-src` prop on EVERY
      // JSX element — including component elements
      // (`<Card data-desde-src="src/App.tsx:10:6" />`). React threads every
      // prop (incl. `data-*`) onto the component fiber's `memoizedProps`,
      // so the callsite is readable here REGARDLESS of React version. This
      // is the exact React analog of the Vue adapter reading
      // `vnode.props["data-desde-src"]`, and it works on React 19 where
      // `_debugSource` is gone. It also returns the SAME repo-relative
      // `file:line:col` shape the attribution layer compares against
      // (`getCallSiteStamp(inst) === rawSrc`) — `_debugSource.fileName` is
      // an ABSOLUTE path and would never match.
      const i = instance as Record<string, unknown>
      const memoized = i.memoizedProps as Record<string, unknown> | undefined
      const stamped = memoized?.["data-desde-src"]
      if (typeof stamped === "string" && stamped.length > 0) return stamped

      // Fallback for a React ≤18 dev pipeline running
      // `@babel/plugin-transform-react-jsx-source` but NOT our stamp plugin
      // — `_debugSource` is the JSX callsite there. React 19 dropped it
      // (→ null), but the stamp above already covers that case. A
      // `_debugStack.stack` parser remains possible future work for a
      // pipeline running neither (its regexes for "first JSX-call frame"
      // are V8/JSC-format-fragile, so it's deferred).
      const debugSource = i._debugSource as
        | { fileName?: unknown; lineNumber?: unknown; columnNumber?: unknown }
        | undefined
      const fileName =
        typeof debugSource?.fileName === "string" ? debugSource.fileName : null
      const lineNumber =
        typeof debugSource?.lineNumber === "number" ? debugSource.lineNumber : null
      // Normalize column to Babel's 0-based convention. React's dev source
      // transform (`@babel/plugin-transform-react-jsx-source`) emits
      // `columnNumber = loc.start.column + 1` (1-based), but the `data-desde-src`
      // lane above and the JSX applicators (`apply-jsx-*-edit.ts`) both match on
      // Babel's 0-based `loc.start.column`. Passing the 1-based value straight
      // through makes the deterministic applicators look one column too far
      // right and miss the element ("No JSX element found at L:col"). Line is
      // already 1-based on both sides, so only the column shifts.
      const rawColumn =
        typeof debugSource?.columnNumber === "number" ? debugSource.columnNumber : 1
      const columnNumber = Math.max(0, rawColumn - 1)
      if (fileName === null || lineNumber === null) return null
      return `${fileName}:${lineNumber}:${columnNumber}`
    },
    readDeclaredProps(instance) {
      const i = instance as Record<string, unknown>
      const memoized = i.memoizedProps as Record<string, unknown> | undefined
      if (!memoized) return {}
      const out: Record<string, unknown> = {}
      for (const propName of Object.keys(memoized)) {
        // React internals: `children` is the slot equivalent and
        // surfacing it as a string prop would be wrong (it's almost
        // always a vnode/string mix, and the slot-text path is the
        // right rewrite route for slot content).
        if (propName === "key" || propName === "ref" || propName === "children") continue
        // The source-tag plugin's `data-desde-src` callsite stamp lands on
        // component `memoizedProps` — it's bridge internals, not a real prop.
        if (propName === "data-desde-src") continue
        if (
          propName.length > 2 &&
          propName.startsWith("on") &&
          propName[2] >= "A" &&
          propName[2] <= "Z"
        ) continue
        out[propName] = memoized[propName]
      }
      return out
    },
    wasRenderedByInstanceTemplate(el, instance) {
      // React's `_debugOwner` is the fiber that AUTHORED the JSX for
      // this element. For template-rendered content, owner is the
      // mounting component (Vue parity). For children passed in by
      // the caller, owner is the CALLER's fiber. Identity check
      // discriminates the same as Vue's `__vnode.ctx === instance`.
      //
      // Defensive fail-open when _debugOwner is unavailable (e.g.
      // production build with the dev plugin stripped) — same stance
      // as the Vue adapter for missing `__vnode`.
      const hostFiber = getReactFiber(el)
      if (!hostFiber) return true
      const owner = hostFiber._debugOwner
      if (owner === undefined || owner === null) return true
      return owner === instance
    },
    getInstanceMountRoot(instance) {
      // The shared walk (`framework-component-detection.ts`): the one host
      // the component's output starts with, none for a multi-root or
      // portal-only component, resolved on the current alternate. The
      // Structure panel and the tree use the same function, so attribution
      // and labelling cannot disagree about what a component's root is.
      return getReactComponentMountRoot(instance as Record<string, unknown>)
    },
    getParentInstance(instance) {
      const i = instance as Record<string, unknown>
      const ret = i.return as Record<string, unknown> | null | undefined
      if (!ret) return null
      return findReactComponentFiber(ret)
    },
    getRenderOwnerInstance(instance) {
      // React's authorship pointer is `_debugOwner`: the fiber whose render
      // created this element, as distinct from `return`, which is where it
      // was mounted. Children passed through JSX are the case that separates
      // them, exactly as slot content does in Vue.
      //
      // `_debugOwner` is DEV-ONLY, and that is acceptable here rather than a
      // hidden limitation: Editor only ever attaches to a running dev server.
      // A production build yields null, and null means UNKNOWN to every
      // caller — never "not rendered by the parent".
      const i = instance as Record<string, unknown>
      const owner = i._debugOwner as Record<string, unknown> | null | undefined
      if (!owner) return null
      return findReactComponentFiber(owner)
    },
    getInstanceFile(instance) {
      // Conceptually: file where the COMPONENT DEFINITION lives
      // (UiEmptyState.vue, Card.tsx, etc.). React fibers don't
      // expose this reliably — `_debugSource` is the JSX CALLSITE
      // (consumer's file), not the definition file, and
      // `fiber.type` (the component function/class) has no
      // built-in source-path metadata. Codex round-1 P0 #2 caught
      // the conflation. Returning null defers library-detection to
      // the `isLibraryInstance` override above (which returns true
      // and trusts the rest of the pipeline's safety filters).
      void instance
      return null
    },
    getInstanceIterationKey(instance) {
      const i = instance as Record<string, unknown>
      const key = i.key
      return typeof key === "string" || typeof key === "number" ? key : null
    },
    readConsumerVnodeProps(instance) {
      // React parity: `fiber.memoizedProps` holds the props the
      // consumer passed at the JSX call site. React does NOT mark
      // bindings vs. literals at runtime — every prop is just a
      // reference, and bound vs. literal is a compile-time concept
      // that doesn't survive into the fiber. boundPropNames stays
      // empty; the new attribution pipeline treats everything as
      // literal in React, which is correct for static JSX and may
      // misclassify dynamic JSX (router params, .map'd values).
      // Refinement waits on a React-side compile stamp parallel to
      // the Vue `:prop` source stamp.
      const i = instance as Record<string, unknown>
      const memoized = i.memoizedProps as Record<string, unknown> | undefined
      if (!memoized) return null
      const props: Record<string, unknown> = {}
      for (const propName of Object.keys(memoized)) {
        if (propName === "children" || propName === "ref" || propName === "key") continue
        // Bridge internals: the callsite stamp the source-tag plugin adds.
        if (propName === "data-desde-src") continue
        if (
          propName.length > 2 &&
          propName.startsWith("on") &&
          propName[2] >= "A" &&
          propName[2] <= "Z"
        ) continue
        props[propName] = memoized[propName]
      }
      return { props, boundPropNames: new Set() }
    },
  }

  /**
   * Pick a framework adapter based on conventions present in the live
   * DOM. Detection must run AFTER the framework has mounted (its
   * tracking metadata isn't there before then), so the call is
   * deferred via the `frameworkAdapter` proxy below — the first
   * method invocation triggers the scan.
   *
   * Preference order: React wins if any element under `document.body`
   * carries a `__reactFiber$<random>` key; else Vue wins if any
   * element carries `__vueParentComponent`; else default to Vue (the
   * legacy behavior — adapter methods will silently return null for
   * everything, which preserves "no attribution" rather than crashing).
   *
   * Why scan a few elements not the whole tree: the framework metadata
   * is uniformly set on its DOM subtree. A constant-bound walk down
   * the first few children of `<body>` is enough to discriminate
   * without becoming O(n).
   */
  function detectFrameworkAdapter(): FrameworkRuntimeAdapter {
    const body = document.body
    if (!body) return vue3RuntimeAdapter

    // Fast path: React marks the createRoot container itself with
    // `__reactContainer$<random>` ALONGSIDE host elements getting
    // `__reactFiber$<random>`. The container key is set even when
    // the React subtree hasn't fully painted, so scanning direct
    // children of <body> for either is the cheapest reliable check.
    // Codex round-1 P1 #4 — the prior BFS could exhaust its 32-node
    // budget on portals/dev overlays before reaching the React tree.
    for (const child of Array.from(body.children)) {
      for (const k of Object.keys(child)) {
        if (k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$")) {
          return reactRuntimeAdapter
        }
      }
      if ((child as Record<string, unknown>).__vueParentComponent) {
        return vue3RuntimeAdapter
      }
    }

    // Slower BFS for the case where the root mount element is wrapped
    // in a few layers of non-framework markup (theme provider DOM,
    // portal hosts, layout shells). Widened budget — 64 elements is
    // still O(1) but generous enough to traverse a deep wrapping
    // hierarchy without timing out on app cold-start.
    const seen = new Set<Element>()
    const queue: Element[] = [body]
    let budget = 64
    while (queue.length > 0 && budget-- > 0) {
      const el = queue.shift()!
      if (seen.has(el)) continue
      seen.add(el)
      for (const k of Object.keys(el)) {
        if (k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$")) {
          return reactRuntimeAdapter
        }
      }
      if ((el as Record<string, unknown>).__vueParentComponent) {
        return vue3RuntimeAdapter
      }
      for (const c of Array.from(el.children)) queue.push(c)
    }
    return vue3RuntimeAdapter
  }

  /**
   * Lazy-resolved adapter. Detection scans the DOM, so it can't run
   * at bridge bootstrap (framework hasn't mounted yet). The proxy
   * resolves on first method access — by then either React or Vue
   * has rendered into the page. The resolved adapter is cached for
   * the lifetime of the bridge (the framework can't change
   * mid-session).
   */
  let resolvedFrameworkAdapter: FrameworkRuntimeAdapter | null = null
  const frameworkAdapter: FrameworkRuntimeAdapter = new Proxy(
    {} as FrameworkRuntimeAdapter,
    {
      get(_target, prop) {
        if (resolvedFrameworkAdapter === null) {
          resolvedFrameworkAdapter = detectFrameworkAdapter()
        }
        return Reflect.get(
          resolvedFrameworkAdapter as object,
          prop,
          resolvedFrameworkAdapter,
        )
      },
    },
  )

  // ── Element attribution + inspection live in ./element-attribution ───
  // (attributeElement, getSourceLocation, computeIterationContext,
  //  computeCallsiteLocation, findEditTargetComponent,
  //  findEditableTextFields, findSlotTextLeaves, isComponentMountRoot,
  //  isAuthoredUnitBoundary, findSourceAnchorElement, inspectElement +
  //  the EditableTextField type.) That module reads the framework runtime
  //  ONLY through the adapter injected just below, so the concrete Vue 3 /
  //  React impls above stay the single home for DOM-convention knowledge.
  configureElementAttribution(frameworkAdapter)

  // ── Inspector Overlay ─────────────────────────────────────────────────

  // ── InspectorOverlayManager (+ INSPECTOR_OVERLAY_STYLES) lives in ./inspector-overlay ─

  // ── Table-edge Overlay ───────────────────────────────────────────────
  //
  // Google-Docs-style row/column affordance. Mouse near the top edge of
  // a column or the left edge of a row in a <table>, CSS Grid, Flex, or
  // generic multi-child container → a highlight band appears and the
  // cursor changes to col-resize / row-resize. Right-click on the band
  // emits TABLE_EDGE_CONTEXT_MENU; the shell renders the context menu
  // (Delete / Add above-below / Add left-right / Duplicate) and routes
  // the chosen action through the Editor chat agent.
  //
  // Coexistence: band uses its own closed shadow root, pointer-events:
  // none. InspectorOverlayManager's existing hover outline can still
  // appear under the band on the same cell — both are visually distinct
  // and not load-bearing for the menu interaction. The contextmenu
  // event is captured at document level and only acts when a band is
  // currently displayed; otherwise it passes through.
  //
  // Framework-agnostic by construction: hit-testing uses pure DOM
  // (elementsFromPoint, getBoundingClientRect, getComputedStyle).
  // Source-mapping (`editTarget`, `iterationContext`) piggybacks on
  // the existing getSourceLocation() / computeIterationContext()
  // helpers — same Vue-today / others-tomorrow posture as the inspector.

  // ── TableEdgeOverlayManager (+ TABLE_EDGE_* consts, TableEdgeBandHit) lives in ./table-edge-overlay ─

  // ── Selector Helpers live in ./selector-helpers ─
  // (describeElement, describeInput, waitForElement, findInteractiveAncestor,
  //  sleep)


  // ── simulateClick lives in ./dom-events ──────────────────────────────

  // ── postMessage Communication ─────────────────────────────────────────

  /** One warn per page load when outbound traffic is being dropped. */
  let warnedNoShellTarget = false

  function sendToShell(message: Record<string, unknown>): void {
    if (window.parent === window) return
    // Addressed, never broadcast — see "postMessage origin discipline" at
    // the top of the IIFE. A null target means the embedder is cross-origin
    // AND no shell origin was configured: there is no one we are willing to
    // hand inspection payloads or design tokens to, so nothing is sent.
    const target = resolveShellTargetOrigin()
    if (target === null) {
      if (!warnedNoShellTarget) {
        warnedNoShellTarget = true
        console.warn(
          "[Desde Bridge] refusing to postMessage to a cross-origin embedder " +
            "with no configured shell origin — bridge output is suppressed.",
        )
      }
      return
    }
    window.parent.postMessage({ source: "desde-bridge", ...message }, target)
  }

  // ── Override store + chain bookkeeping + prop/attr/class live-preview
  // implementations live in ./override-preview (createOverridePreview) ───
  // Instantiated once in init() and passed explicitly to createDomEditMode
  // (./dom-edit-mode) — replacing the previous mutable IIFE-scope refs
  // (`overrideStore`, `clearClassOverrideForFn`) that let a sibling
  // top-level function reach into init()-local state.

  // ── DOM-edit mode lives in ./dom-edit-mode ───────────────────────────
  // (createDomEditMode + the DomEditModeOptions / BridgeMutationKind /
  //  OverridePreviewOps / InternalBridgeMutation types. Instantiated in
  //  init() with the inspector, the override-preview, and the framework
  //  runtime adapter injected explicitly.)

  // ── Initialization ────────────────────────────────────────────────────

  function init(): void {
    // Inject the IIFE-bound deps the extracted manager modules import (see
    // ./bridge-runtime). Must run before any manager is constructed/used.
    configureBridgeRuntime({ sendToShell, inspectElement, attributeElement })
    // WS3 override store + chain bookkeeping + prop/attr/class live-preview
    // (default timing options — 300ms re-assert / 5s unverified / 20s
    // give-up — see override-store.ts).
    const overridePreview = createOverridePreview()
    const pins = new CommentPinsManager()
    const notePins = new NotePinsManager()
    const inspector = new InspectorOverlayManager()
    const tableEdge = new TableEdgeOverlayManager()
    // Direct-manipulation drag-to-move (Phase 2). Drags the currently-selected
    // element; shares the select-mode lifecycle with table-edge (activated on
    // the same ACTIVATE_TABLE_EDGE_MENU gate the shell already sends in
    // editor Select mode). Reads the live selection from the inspector.
    const dragMove = new DragMoveOverlayManager(() => inspector.getSelectedElement())
    // Direct-manipulation insert-at-point (Phase 3). Click-to-place; entered
    // via ENTER_INSERT_PLACEMENT, emits INSERT_AT_POINT on the placement click.
    const insertPlacement = new InsertPlacementOverlayManager()
    // Direct-manipulation drag-to-resize (Phase 4). Width handle on the selected
    // element; shares the select-mode gate with drag-move/table-edge.
    const resizeOverlay = new ResizeOverlayManager(() => inspector.getSelectedElement())
    // Debug handle for the drag-move live smoke (mirrors __DESDE_TABLE_EDGE__).
    ;(window as unknown as Record<string, unknown>).__DESDE_DRAG_MOVE__ = {
      isActive: () => dragMove.isActive(),
      selectedTag: () => {
        const s = inspector.getSelectedElement()
        return s ? `${s.tagName.toLowerCase()}#${(s as HTMLElement).id || ""}.${s.className || ""}` : null
      },
      // The live selected element (same-origin → usable by the smoke for
      // dispatching the drag on the ACTUAL drag target, since editor mode
      // resolves a click to the component root, not the raw clicked node).
      selectedEl: () => inspector.getSelectedElement(),
      probeDrop: (x: number, y: number) => {
        const s = inspector.getSelectedElement()
        if (!s) return { selected: null }
        const drop = dragMove.probeDrop(s, x, y)
        return {
          selected: s.tagName.toLowerCase(),
          container: drop ? (drop.container as HTMLElement).getAttribute("data-desde-src") : null,
          index: drop ? drop.index : null,
        }
      },
    }
    ;(window as unknown as Record<string, unknown>).__DESDE_TABLE_EDGE__ = {
      activate: () => tableEdge.activate(),
      deactivate: () => tableEdge.deactivate(),
      isActive: () => tableEdge.isActive(),
      probe: (x: number, y: number) => tableEdge.probe(x, y),
    }
    // Select-mode overlays share one lifecycle registry. Anything that
    // leaves Select mode (entering comment/note placement, recording,
    // flow playback, screenshot capture) tears them all down through
    // `deactivateSelectModeOverlays()`, and route changes clear them all
    // via the navigation callback below — so a newly-added overlay can't
    // silently skip teardown or nav-clear. The activation messages stay
    // per-overlay (the review-app activates the inspector alone, with no
    // table-edge), so only the teardown/nav paths are consolidated.
    const selectModeOverlays: SelectModeOverlay[] = [inspector, tableEdge, dragMove, insertPlacement, resizeOverlay]
    const deactivateSelectModeOverlays = (): void => {
      for (const overlay of selectModeOverlays) overlay.deactivate()
    }
    const domEditMode = createDomEditMode(inspector, overridePreview, frameworkAdapter)
    // Bridge inspector's double-click text editing through the
    // domEditMode mutation pipeline so sourceLoc resolution + v-for
    // disambiguation + save-on-flush all reuse the existing path.
    inspector.setCaptureTextMutation((el, before, after) => {
      domEditMode.captureDirectMutation(el, "text", undefined, before, after)
    })

    // Navigation callback subscribers
    const navigationCallbacks: (() => void)[] = []

    let lastUrl = window.location.href
    let navObserver: MutationObserver | null = null
    function checkRouteChange(): void {
      const currentUrl = window.location.href
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl
        // Notify navigation subscribers (pins, overlays) immediately
        for (const cb of navigationCallbacks) cb()
        // Clean up any previous navigation observer
        if (navObserver) { navObserver.disconnect(); navObserver = null }

        // pushState fires BEFORE the prototype's router.afterEach hook updates
        // data-page-source, so reading the attribute synchronously here returns
        // the previous route's value. Always wait for the attribute to mutate
        // (or a short fallback) before reporting the new source.
        let sent = false
        const send = (sourceFile: string | undefined): void => {
          if (sent) return
          sent = true
          if (navObserver) { navObserver.disconnect(); navObserver = null }
          sendToShell({ type: "ROUTE_CHANGED", payload: { url: currentUrl, sourceFile } })
          // Re-check the background here, not at the top of
          // `checkRouteChange`: `pushState` fires before the new route has
          // rendered, so reading it then would sample the OUTGOING page. By
          // the time `send` runs the attribute has mutated (or the 200ms
          // fallback has elapsed), which is the same moment the source file
          // is trustworthy. `sendPageBackground` de-dupes, so the common case
          // of a route that keeps the same colour posts nothing.
          sendPageBackground()
        }

        navObserver = new MutationObserver(() => {
          send(getPageSourceFile())
        })
        navObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-page-source"],
        })

        // Fallback: after 200ms, send whatever is currently on the attribute.
        // Covers prototypes that don't stamp the attribute at all.
        setTimeout(() => send(getPageSourceFile()), 200)
      }
    }

    // Register navigation handlers
    navigationCallbacks.push(() => pins.handleNavigation())
    navigationCallbacks.push(() => notePins.handleNavigation())
    // Clear every Select-mode overlay (inspector box, table-edge band) so
    // none linger frozen over the previous page's coordinates after an SPA
    // route change.
    navigationCallbacks.push(() => {
      for (const overlay of selectModeOverlays) overlay.handleNavigation()
    })
    // WS3: release every pending override on route change without
    // reverting — the elements are gone (new page), so "revert" has
    // nothing to revert to; source is whatever it is post-navigation.
    navigationCallbacks.push(() => overridePreview.store.releaseAll())

    // Intercept pushState/replaceState for SPA navigation
    const origPushState = history.pushState.bind(history)
    const origReplaceState = history.replaceState.bind(history)
    history.pushState = function (...args) {
      origPushState(...args)
      checkRouteChange()
    }
    history.replaceState = function (...args) {
      origReplaceState(...args)
      checkRouteChange()
    }
    window.addEventListener("popstate", checkRouteChange)
    window.addEventListener("hashchange", checkRouteChange)

    // ─── DOM mutation notifier (keeps shell LAYERS tree fresh) ──────────
    // Skeleton → real-content swaps, conditional renders, and prop edits
    // that change subtree shape used to require a manual layers refresh
    // because we only re-walked on ROUTE_CHANGED. Send DOM_MUTATED on a
    // trailing debounce so the shell can re-run getStructure().
    //
    // Filtering: light-DOM additions/removals tagged `data-prototype-flow`
    // are bridge UI hosts (Shadow-DOM internals don't bubble here at all),
    // so we discard records whose every added/removed node is tool-owned.
    {
      const DEBOUNCE_MS = 400
      const MAX_WAIT_MS = 2000
      let pendingTimer: ReturnType<typeof setTimeout> | null = null
      let firstPendingAt = 0

      const isToolOwned = (n: Node): boolean =>
        n.nodeType === 1 && isBridgeOwnElement(n)

      const isToolMutation = (m: MutationRecord): boolean => {
        const target = m.target as Element | null
        if (target && target.nodeType === 1 && isBridgeOwnElement(target)) return true
        const added = Array.from(m.addedNodes)
        const removed = Array.from(m.removedNodes)
        if (added.length === 0 && removed.length === 0) return false
        return added.every(isToolOwned) && removed.every(isToolOwned)
      }

      const flush = (): void => {
        pendingTimer = null
        firstPendingAt = 0
        sendToShell({ type: "DOM_MUTATED" })
      }

      const schedule = (): void => {
        const now = Date.now()
        if (firstPendingAt === 0) firstPendingAt = now
        const elapsed = now - firstPendingAt
        const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_WAIT_MS - elapsed))
        if (pendingTimer != null) clearTimeout(pendingTimer)
        pendingTimer = setTimeout(flush, delay)
      }

      const treeObserver = new MutationObserver((records) => {
        for (const r of records) {
          if (!isToolMutation(r)) { schedule(); return }
        }
      })
      treeObserver.observe(document.body, { childList: true, subtree: true })
    }

    // Forward Escape key to shell so it can close open annotations
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        sendToShell({ type: "ESCAPE_PRESSED" })
      }
    })

    // ── Prop / attr / class live-preview implementations live in
    // ./override-preview (createOverridePreview) — instantiated above as
    // `overridePreview`. SET_ELEMENT_TEXT/SET_ELEMENT_CLASSES below call
    // overridePreview.applyClassOverride / .releaseClassStyleSnapshot /
    // .clearClassOverrideFor directly; the RESOLVE_OVERRIDE /
    // APPLY_*_OVERRIDE / CLEAR_*_OVERRIDES message handlers are thin
    // delegations to overridePreview.handle* (see the switch below).


    // Listen for messages from shell
    window.addEventListener("message", (event) => {
      const data = event.data
      if (!data || typeof data.type !== "string") return
      // Shape guard first: unrelated postMessage traffic (devtools, HMR
      // clients, third-party widgets) is dropped silently, so only
      // bridge-shaped messages from an untrusted origin get warned about.
      if (!isTrustedMessageOrigin(event.origin)) return
      // Origin says "from a document that shares the shell's origin"; source
      // says "from the shell". In path mode the prototype satisfies the first
      // and must not satisfy the second. See isTrustedMessageSource.
      if (!isTrustedMessageSource(event.source)) return

      // MCP query messages (GET_CURRENT_INSPECTION, INSPECT_MANY,
      // INSPECT_SELECTOR, INSPECT_POINT, INSPECT_PARENT, GET_STRUCTURE,
      // CAPTURE_ELEMENT_SCREENSHOT, GET_PAGE_TOKENS, READ_RENDERED_VALUE,
      // READ_MEASUREMENTS) are dispatched from ./mcp-query-handlers before
      // the switch below — it returns true when it owned `data.type`.
      if (handleMcpQuery(data, { inspector })) return

      switch (data.type) {
        case "SET_COMMENTS":
          pins.setComments(data.payload as Comment[])
          break
        case "ENTER_COMMENT_MODE":
          deactivateSelectModeOverlays()
          notePins.exitPlacementMode()
          pins.enterPlacementMode()
          break
        case "EXIT_COMMENT_MODE":
          pins.exitPlacementMode()
          break
        case "SET_PINS_HIDDEN":
          pins.setHidden(data.payload as boolean)
          break
        case "SET_SHOW_RESOLVED":
          pins.setShowResolved(data.payload as boolean)
          break
        case "HIGHLIGHT_COMMENT":
          pins.highlightComment((data.payload as { commentId: string }).commentId)
          break
        case "NAVIGATE": {
          // `page` originates in a COMMENT's stored position, and a comment
          // can be authored by anyone who can comment on the project — in the
          // viewer, potentially an anonymous public-link visitor. Assigning it
          // straight to `location.href` made that a navigation primitive: a
          // stored `javascript:…` ran script in this frame, and an absolute
          // URL silently moved the developer's prototype iframe to an
          // attacker's origin while the shell chrome still framed it as the
          // prototype (audit B11).
          //
          // Resolve against this document and require the SAME ORIGIN. That
          // rejects `javascript:` and `data:` for free — both resolve to the
          // opaque origin, which never equals ours — as well as absolute and
          // protocol-relative (`//evil.com`) URLs.
          const targetPage = sameOriginPath((data.payload as { page?: unknown }).page)
          if (!targetPage) {
            console.warn(
              "[Desde Bridge] refused NAVIGATE to a non-same-origin or malformed target",
            )
            break
          }
          const currentPage = window.location.pathname + window.location.hash
          if (targetPage !== currentPage) {
            window.location.href = targetPage
          } else {
            // Already on the right page — tell shell bridge is still ready
            sendToShell({ type: "BRIDGE_READY", payload: { version: BRIDGE_VERSION } })
          }
          break
        }
        case "ACTIVATE_INSPECTOR":
          pins.exitPlacementMode()
          inspector.activate()
          break
        case "DEACTIVATE_INSPECTOR":
          inspector.deactivate()
          break
        case "HIGHLIGHT_COMPONENT": {
          const sel = (data.payload as { selector: string }).selector
          if (sel) {
            const target = document.querySelector(sel)
            if (target) {
              inspector.highlightElement(target)
              try {
                sendToShell({ type: "ELEMENT_INSPECTED", payload: inspectElement(target) })
              } catch (err) {
                console.warn("[Desde Inspector] re-inspect failed:", err)
              }
            }
          }
          break
        }
        case "PREVIEW_HIGHLIGHT": {
          const sel = (data.payload as { selector: string | null }).selector
          if (!sel) {
            inspector.previewHighlight(null)
          } else {
            const target = document.querySelector(sel)
            inspector.previewHighlight(target)
          }
          break
        }
        // ── MCP query messages ─────────────────────────────────────────
        case "GET_STYLE_PROVENANCE": {
          // Inspector style provenance (§6 Layer 1): resolve each requested
          // property to its winning cascade rule + var(--token) chain so the
          // inspector can show an honest "From:" origin instead of a reverse-
          // inferred guess. {selector, properties} → STYLE_PROVENANCE_RESULT
          // {selector, origins}. Mirrors READ_RENDERED_VALUE's request/respond
          // shape; the walker (style-provenance.ts) is pure + graceful.
          const reqId = (data as { requestId: string }).requestId
          const spPayload = (data as {
            payload: { selector: string; properties: string[] }
          }).payload
          const respondProvenance = (origins: Record<string, unknown>) =>
            sendToShell({
              type: "STYLE_PROVENANCE_RESULT",
              payload: { selector: spPayload?.selector ?? "", origins },
              requestId: reqId,
            } as Record<string, unknown>)
          const spSelector = spPayload?.selector
          const spProps = spPayload?.properties
          if (!spSelector || !Array.isArray(spProps) || spProps.length === 0) {
            respondProvenance({})
            break
          }
          let spEl: Element | null = null
          try {
            spEl = document.querySelector(spSelector)
          } catch {
            respondProvenance({})
            break
          }
          if (!spEl || isBridgeOwnElement(spEl)) {
            respondProvenance({})
            break
          }
          try {
            // Inject the preview layer's own record of what it stamped, so
            // `origin.inline.fromPreview` can tell editor's live-preview shim
            // from a declaration the prototype authored (the shell previously
            // had to infer it — see StyleOrigin.inline in src/types/bridge.ts).
            // A narrow read-only query; the walker keeps no import on the
            // preview module.
            respondProvenance(
              getStyleProvenance(spEl, spProps, {
                isPreviewStampedProperty: (el, property) =>
                  overridePreview.isPreviewStampedProperty(el, property),
              }),
            )
          } catch {
            // Never let a walker edge case break the inspector — degrade to
            // "no provenance" and let the row stay a plain class-edit surface.
            respondProvenance({})
          }
          break
        }
        case "GET_STYLESHEET_TARGETS": {
          // Where can a `[data-desde-src="…"]` override rule be written so that
          // it actually RENDERS? Only a stylesheet the document has loaded.
          // The shell maps these refs back to first-party writable paths
          // (`resolveTokenSourceFile`) and picks one by the § 9g.1 ladder;
          // the bridge just reports what the page has, in document order.
          const stReqId = (data as { requestId: string }).requestId
          let sheets: unknown[] = []
          try {
            sheets = collectStylesheetRefs(document)
          } catch {
            sheets = []
          }
          sendToShell({
            type: "STYLESHEET_TARGETS_CAPTURED",
            payload: { sheets },
            requestId: stReqId,
          } as Record<string, unknown>)
          break
        }
        case "RESOLVE_TARGET": {
          // Semantic-target resolution (screenshot-flows Phase 2): resolve a
          // {role,name,text,selector} target to a live element + stable selector
          // or report a miss — the cheap validity gate for deterministic replay
          // vs. heal. {target} → TARGET_RESOLVED {found, selector?, role?, name?}.
          const reqId = (data as { requestId: string }).requestId
          const rtPayload = (data as { payload?: { target?: SemanticTargetInput } }).payload
          let rtResult
          try {
            rtResult = resolveSemanticTarget(rtPayload?.target ?? {})
          } catch {
            rtResult = { found: false }
          }
          sendToShell({
            type: "TARGET_RESOLVED",
            payload: rtResult,
            requestId: reqId,
          } as Record<string, unknown>)
          break
        }
        case "PERFORM_INTERACT": {
          // Perform a click/fill/select on an already-resolved selector, reusing
          // the shared click sim (dom-events) + input dispatch. {selector,action,value?}
          // → INTERACT_PERFORMED {ok, error?}.
          const reqId = (data as { requestId: string }).requestId
          const piPayload = (data as {
            payload?: { selector?: string; action?: string; value?: string }
          }).payload
          let piResult
          try {
            piResult = performInteract({
              selector: piPayload?.selector ?? "",
              action: (piPayload?.action as InteractAction) ?? "click",
              value: piPayload?.value,
            })
          } catch (err) {
            piResult = { ok: false, error: (err as Error).message }
          }
          sendToShell({
            type: "INTERACT_PERFORMED",
            payload: piResult,
            requestId: reqId,
          } as Record<string, unknown>)
          break
        }
        // ── Editor extensions (BRIDGE_VERSION 2026-05-01a+) ────────────
        case "ENTER_EDITOR_MODE":
          // Suppress conflicting modes — editor drives the iframe alone.
          pins.exitPlacementMode()
          notePins.exitPlacementMode()
          inspector.setEditorMode(true)
          break
        case "EXIT_EDITOR_MODE":
          // Leaving editor entirely → cancel a pending insert placement so a
          // stashed snippet can't commit on a later click (codex).
          insertPlacement.exit()
          inspector.setEditorMode(false)
          inspector.setHoverEventsEnabled(false)
          // Editor leaving entirely → ensure DOM-edit mode is also off.
          domEditMode.exit()
          break
        case "ACTIVATE_TABLE_EDGE_MENU":
          // Gates ALL select-mode direct-manipulation overlays (table-edge +
          // drag-to-move) — the shell sends this exactly when editor Select
          // mode is on, which is the correct gate for both.
          tableEdge.activate()
          dragMove.activate()
          // Drag-to-resize width handle intentionally hidden for now: the
          // affordance is asymmetric (width-only, no height) and pending a
          // product decision. Re-enable by restoring `resizeOverlay.activate()`.
          // The overlay stays in `selectModeOverlays`, so its deactivate() on
          // teardown remains a harmless no-op while dormant.
          break
        case "DEACTIVATE_TABLE_EDGE_MENU":
          tableEdge.deactivate()
          dragMove.deactivate()
          resizeOverlay.deactivate()
          // Leaving Select mode also cancels a pending insert placement.
          insertPlacement.exit()
          break
        case "ENTER_INSERT_PLACEMENT": {
          const label = (data as { payload?: { label?: string } }).payload?.label
          insertPlacement.enter(typeof label === "string" ? label : "element")
          break
        }
        case "EXIT_INSERT_PLACEMENT":
          insertPlacement.exit()
          break
        case "ENTER_DOM_EDIT_MODE": {
          const optsPayload = (data as { payload?: { experimental?: { styleEdits?: boolean } } }).payload
          domEditMode.enter(optsPayload ?? {})
          break
        }
        case "EXIT_DOM_EDIT_MODE":
          domEditMode.exit()
          break
        case "RESOLVE_MUTATION_DISAMBIGUATION": {
          const payload = (data as { payload?: { pendingId?: string; choice?: "this-instance" | "all-instances" | "cancel" } }).payload
          if (payload?.pendingId && payload.choice) {
            domEditMode.resolveDisambiguation(payload.pendingId, payload.choice)
          }
          break
        }
        case "RESOLVE_OVERRIDE":
          overridePreview.handleResolveOverride(
            (data as { payload?: ResolveOverridePayload }).payload,
          )
          break
        case "APPLY_PROP_OVERRIDE":
          overridePreview.handleApplyPropOverride(
            (data as { payload?: ApplyPropOverridePayload }).payload,
          )
          break
        case "CLEAR_PROP_OVERRIDES":
          overridePreview.handleClearPropOverrides()
          break
        case "APPLY_ATTR_OVERRIDE":
          overridePreview.handleApplyAttrOverride(
            (data as {
              payload?: { selector?: string; attrName?: string; value?: unknown; overrideId?: string }
            }).payload,
          )
          break
        case "CLEAR_ATTR_OVERRIDES":
          overridePreview.handleClearAttrOverrides()
          break
        case "CLEAR_CLASS_OVERRIDES":
          overridePreview.handleClearClassOverrides()
          break
        case "SET_ELEMENT_TEXT": {
          // Shell-initiated text edit (e.g., right-rail inspector "Text"
          // input). Capture the before-value, mutate the DOM for live
          // preview, then call captureDirectMutation so the change
          // routes through the same MUTATION_CAPTURED pipeline that
          // iframe-typed edits use (sourceLoc resolution, v-for
          // disambiguation, save-on-flush).
          //
          // `textNodeIndex` (optional): targets a specific text-node
          // child so we don't nuke element siblings. Used for slot text
          // alongside icons/tooltips in design-system components
          // (e.g. `<label>Default ACL<UiTooltip/></label>`).
          const payload = (data as {
            payload?: {
              selector?: string
              value?: string
              textNodeIndex?: number
            }
          }).payload
          if (!payload?.selector || typeof payload.value !== "string") break
          try {
            const el = document.querySelector(payload.selector) as Element | null
            if (!el) break
            const after = payload.value
            const idx = payload.textNodeIndex
            // The selector resolves to whatever wrapper directly contained
            // the text node — often an internal library element (e.g.
            // UiCard's inner `<div class="ui-card-content">`) without its
            // own `data-desde-src`. The DOM mutation still happens on the
            // exact targeted text node, but for SOURCE mapping we walk up
            // to the nearest user-authored ancestor that carries
            // `data-desde-src`. That makes mutations resolve as `direct`
            // (instead of `ancestor`, which the emit pipeline rejects for
            // text), and routes the save to the call-site of the
            // component whose slot owns the text.
            const sourceAnchor = findSourceAnchorElement(el)
            // Preview closures target the node that was ACTUALLY edited —
            // never the source anchor, whose textContent may include
            // sibling elements a re-assert would wipe (codex round-11).
            const elSelector = payload.selector
            const resolveTargetEl = (): Element | null => {
              if (el.isConnected) return el
              try {
                return document.querySelector(elSelector)
              } catch {
                return null
              }
            }
            if (typeof idx === "number" && idx >= 0 && idx < el.childNodes.length) {
              const target = el.childNodes[idx]
              if (target.nodeType === Node.TEXT_NODE) {
                const before = target.textContent ?? ""
                if (before === after) break
                target.textContent = after
                const resolveTextNode = (): Node | null => {
                  const host = resolveTargetEl()
                  const node = host?.childNodes[idx]
                  return node && node.nodeType === Node.TEXT_NODE ? node : null
                }
                domEditMode.captureDirectMutationPinned(
                  sourceAnchor,
                  "text",
                  undefined,
                  before,
                  after,
                  {
                    apply: () => {
                      const node = resolveTextNode()
                      if (node) node.textContent = after
                    },
                    revert: (value) => {
                      const node = resolveTextNode()
                      if (node) node.textContent = value
                    },
                    isApplied: () => resolveTextNode()?.textContent === after,
                  },
                )
                break
              }
              // Fall through to the whole-element path if the indexed
              // child isn't a text node (selector resolved to a
              // re-rendered DOM where children shifted).
            }
            const before = el.textContent ?? ""
            if (before === after) break
            el.textContent = after
            domEditMode.captureDirectMutationPinned(sourceAnchor, "text", undefined, before, after, {
              apply: () => {
                const host = resolveTargetEl()
                if (host) host.textContent = after
              },
              revert: (value) => {
                const host = resolveTargetEl()
                if (host) host.textContent = value
              },
              isApplied: () => resolveTargetEl()?.textContent === after,
            })
          } catch {
            // Ignore — selector may have been invalidated by a re-render.
          }
          break
        }
        case "SET_ELEMENT_CLASSES": {
          // Same model as SET_ELEMENT_TEXT but for the className token list.
          const payload = (data as {
            payload?: {
              selector?: string
              classes?: string[]
              declarations?: Record<string, string>
            }
          }).payload
          if (!payload?.selector || !Array.isArray(payload.classes)) break
          try {
            const targetEl = document.querySelector(payload.selector) as HTMLElement | null
            if (!targetEl) break
            const el = targetEl
            const before = el.className
            const after = payload.classes.join(" ")
            const classes = payload.classes
            const declarations = payload.declarations
            if (before === after && !declarations) break
            // `applyClassOverride` snapshots `el.className`/`el.style.cssText`
            // on its FIRST call for this element (see override-preview.ts) — that
            // snapshot is what a confirmed disambiguation's "classOv" retire
            // hook (`clearClassOverrideFor`) restores className to afterward.
            // It MUST run before `el.className = after` below, or the snapshot
            // records the SPECULATIVE after-value as if it were the original,
            // and a confirmed resolution then "restores" the preview's own
            // addition instead of dropping it (N2: `bg-violet-500` survived a
            // confirmed "Change all rows" with no source file containing it).
            overridePreview.applyClassOverride(el, classes, declarations)
            el.className = after
            // Layer the new classes' declarations inline with !important
            // so live preview wins against high-specificity scoped library
            // CSS (UiCard's `.ui-button.primary[data-v-XXX]` etc.). Without
            // this the className update is a no-op visually for any
            // utility class targeting a library-internal element. Shell
            // pre-resolves utility classes to declarations so the override
            // works in substrates that don't ship Tailwind in the iframe.
            // kind: "class" matches BridgeMutationKind ("text" | "attr" |
            // "class" | "style"). Earlier this code passed "attribute"
            // which is NOT a member of the union — TypeScript missed it
            // because src/bridge is excluded from the root tsconfig
            // (the bridge is built with its own pipeline). The validator
            // at the save endpoint rejected the mutation with
            // 'edit.mutations[0].kind must be one of text | attr | class
            // | style', breaking every save-via-class-edit in DOM-edit
            // mode. The third arg is the attribute target name; for the
            // dedicated `class` kind that's redundant, so undefined.
            // Codex P1 #2: class edits route to a scoped-CSS save lane
            // that writes a `[data-desde-src="..."]` selector — the selector
            // matches EVERY v-for sibling sharing that source location,
            // so persisting "this-instance" semantics through the
            // pinned path is a lie. Live preview mutates one row but
            // the saved CSS rule affects all rows. Stay on the
            // non-pinned variant so v-for class edits surface as a
            // pending disambiguation (and `hasUnsavedChanges` +
            // `handleSaveAll`'s disambiguation gate refuses save
            // until the scope question has a real answer) instead of
            // silently doing the wrong thing.
            //
            // previewOps (WS3, class-override closed loop): re-resolve by
            // selector at apply/revert time — same fallback pattern as
            // SET_ELEMENT_TEXT's `resolveTargetEl` above, since a v-for
            // remount or unrelated re-render can detach `targetEl` while
            // the override is still pending.
            const elSelector = payload.selector
            const resolveEl = (): HTMLElement | null => {
              if (targetEl.isConnected) return targetEl
              try {
                return document.querySelector(elSelector) as HTMLElement | null
              } catch {
                return null
              }
            }
            domEditMode.captureDirectMutation(el, "class", undefined, before, after, {
              apply: () => {
                const el2 = resolveEl()
                if (!el2) return
                // Same ordering as the initial call above — applyClassOverride
                // must run before the className write so a re-assert tick can
                // never be the FIRST call to see `el2.className` (it never is
                // in practice, since the snapshot already exists by then, but
                // keeping the order identical avoids relying on that).
                overridePreview.applyClassOverride(el2, classes, declarations)
                el2.className = after
              },
              revert: (value) => {
                // A mid-chain landed predecessor means `value` (the
                // chain's current revert baseline) is not necessarily the
                // ORIGINAL className the snapshot was taken against — so
                // this restores the inline-style `!important` shim from
                // the snapshot (same as clearClassOverrideFor's style
                // half) and drops the snapshot entry, then sets className
                // to `value` explicitly rather than delegating className
                // restoration to the snapshot too.
                const el2 = resolveEl()
                if (!el2) return
                overridePreview.releaseClassStyleSnapshot(el2)
                el2.className = value
              },
              isApplied: () => resolveEl()?.className === after,
            })
          } catch {
            // Ignore.
          }
          break
        }
        case "CLEAR_SELECTION":
          inspector.clearSelectedOnly()
          break
        case "RELOAD_PROTOTYPE": {
          // Editor dispatches this after a successful edit so the iframe
          // re-fetches the freshly-written source. The bridge IIFE will re-run
          // in a clean state on the new document; the adapter's BRIDGE_READY
          // handler is what restores selection state via INSPECT_SELECTOR.
          const reason = (data as { payload?: { reason?: string } }).payload?.reason
          if (reason) console.info("[Desde Bridge] reload:", reason)
          window.location.reload()
          break
        }
        case "PING":
          // Re-emit BRIDGE_READY without navigating. Editor's adapter
          // sends this on init so it can attach its message listener
          // first, then ask the (already-loaded) bridge to announce
          // itself again — without this, React Strict Mode's double-
          // invoke detaches+re-attaches the listener around the
          // moment BRIDGE_READY fires natively, and the shell misses it.
          sendToShell({ type: "BRIDGE_READY", payload: { version: BRIDGE_VERSION } })
          // The page background is one-shot too, and loses the SAME race for
          // the same reason (see docs/bridge-protocol.md, "BRIDGE_READY is
          // one-shot"). MEASURED on the live viewer, 2026-08-28: the rail
          // never took the prototype's colour on a cold load, because the
          // shell's listener attaches after the bridge has already announced
          // itself, and the PING that recovers BRIDGE_READY was replaying
          // only that one message.
          //
          // `force`, because the de-dupe would otherwise swallow exactly this
          // case: the colour has not CHANGED, it was simply never heard.
          sendPageBackground({ force: true })
          break
        case "ENABLE_HOVER_EVENTS":
          inspector.setHoverEventsEnabled(true)
          break
        case "DISABLE_HOVER_EVENTS":
          inspector.setHoverEventsEnabled(false)
          break
        // ── End MCP query messages ───────────────────────────────────────

        // ── Note messages ──
        case "SET_NOTES":
          notePins.setNotes(data.payload as BridgeNote[])
          break
        case "ENTER_NOTE_MODE":
          deactivateSelectModeOverlays()
          pins.exitPlacementMode()
          notePins.enterPlacementMode()
          break
        case "EXIT_NOTE_MODE":
          notePins.exitPlacementMode()
          break
        case "SET_NOTES_HIDDEN":
          notePins.setHidden(data.payload as boolean)
          break
        case "SET_SHOW_RESOLVED_NOTES":
          notePins.setShowResolved(data.payload as boolean)
          break
        case "HIGHLIGHT_NOTE":
          notePins.highlightNote((data.payload as { noteId: string }).noteId)
          break
      }
    })

    /**
     * The colour a reader actually sees behind this page, resolved the way
     * the browser paints it.
     *
     * Not simply `getComputedStyle(document.body).backgroundColor`. A page
     * that sets its background on `html` (or on nothing at all) leaves `body`
     * computing to `rgba(0, 0, 0, 0)`, and reporting that transparent value
     * would tell the shell to paint its chrome see-through. The browser's own
     * rule is the propagation rule: body's background, else the root
     * element's, else the canvas default of white. This walks that same
     * ladder.
     *
     * Returns null only when neither element paints anything AND the default
     * cannot be assumed, which in practice does not happen — but a null is
     * still the honest answer for a shell to ignore rather than a white it
     * invented.
     */
    function resolvePageBackground(): string | null {
      const candidates = [document.body, document.documentElement]
      for (const el of candidates) {
        if (!el) continue
        const color = window.getComputedStyle(el).backgroundColor
        if (!color) continue
        // `transparent` and any zero-alpha rgba paint nothing, so the ladder
        // has to keep walking rather than report the first value it sees.
        if (color === "transparent") continue
        const alpha = /rgba?\(([^)]+)\)/.exec(color)
        if (alpha) {
          const parts = alpha[1].split(",").map((v) => v.trim())
          if (parts.length === 4 && Number(parts[3]) === 0) continue
        }
        return color
      }
      // Both transparent: the browser paints the canvas white.
      return "rgb(255, 255, 255)"
    }

    /**
     * Emits the page background, but only when it has actually changed.
     *
     * The de-dupe matters because this is called on every navigation and most
     * navigations do not change the colour — without it, a shell that reacts
     * to the message would re-render its whole chrome on every route change
     * for no reason.
     */
    let lastPageBackground: string | null = null
    function sendPageBackground(options?: { force?: boolean }): void {
      const color = resolvePageBackground()
      if (color === null) return
      if (!options?.force && color === lastPageBackground) return
      lastPageBackground = color
      sendToShell({ type: "PAGE_BACKGROUND_CHANGED", payload: { color } })
    }

    // Notify shell that bridge is ready
    sendToShell({ type: "BRIDGE_READY", payload: { version: BRIDGE_VERSION } })

    // Tell the shell what colour this page is painted, so its own chrome can
    // sit on the same ground and the iframe edge stops being a seam.
    //
    // Sent here rather than folded into ROUTE_CHANGED below, because that
    // one's initial emission is gated on `getPageSourceFile()` — a substrate
    // that stamps no `data-page-source` never sends it, and the background
    // has to work on every substrate. It is re-sent on navigation too, since
    // a route can change the colour.
    sendPageBackground()

    // Send initial source file — the prototype's router.afterEach may not have
    // fired yet, so watch for the data-page-source attribute to appear.
    let initialSourceSent = false
    function trySendInitialSource(): boolean {
      const sf = getPageSourceFile()
      if (sf) {
        initialSourceSent = true
        sendToShell({
          type: "ROUTE_CHANGED",
          payload: { url: window.location.href, sourceFile: sf },
        })
        return true
      }
      return false
    }

    if (!trySendInitialSource()) {
      // Watch for data-page-source to be stamped by the prototype's router hook
      const observer = new MutationObserver(() => {
        if (trySendInitialSource()) observer.disconnect()
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-page-source"],
      })
      // Safety timeout: stop watching after 5s
      setTimeout(() => observer.disconnect(), 5000)
    }
  }

  // Wait for DOM to be ready before initializing (bridge is injected in <head>)
  if (document.body) {
    init()
  } else {
    document.addEventListener("DOMContentLoaded", init)
  }
})()

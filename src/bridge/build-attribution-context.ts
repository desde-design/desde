/**
 * Build an {@link AttributionContext} from live framework runtime
 * state. Bridge-side counterpart to the shell-side `attribute()`
 * function: this is the half that knows about Vue instances and DOM
 * elements; everything past this boundary uses plain serializable
 * data (component name, source loc, prop values) and runs in the
 * shell.
 *
 * Pure-ish: takes an Element + a {@link FrameworkRuntimeAdapter}
 * (already factored out as an interface for testability — see
 * `leaf-prop-attribution.ts` for the pattern). Reads the live DOM
 * and framework runtime via the adapter; does NOT post messages,
 * touch globals, or import framework modules directly. This makes
 * it unit-testable against stub adapters without booting Vue or a
 * real browser.
 *
 * Selector convention: `selectorWithinMountRoot` is a single-token
 * CSS selector (`:root`, `tag`, `tag.class`, `.class`) rooted at
 * the owning component's mount root. V1 does NOT generate
 * descendant selectors (`.parent .child`); hints requiring multi-
 * level paths will return `null` from this function's matching
 * stage and the shell-side attribution will refuse with a useful
 * reason. See `tasks/attribution-rewrite.md` for the deferred
 * multi-level matcher.
 */

import type { FrameworkRuntimeAdapter } from './leaf-prop-attribution'
import type {
  AttributionContext,
  ClickedElementContext,
  ComponentChainEntry,
  ConsumerPropValue,
  SourceLoc,
} from '../editor/attribution/types'
import { canonicalSelectorOf } from '../editor/core/canonical-selector'

/**
 * Bounds the number of ancestors we walk for the chain. Real Vue
 * trees rarely exceed 30; cap at a generous limit to keep the
 * postMessage payload size predictable.
 */
const MAX_CHAIN_DEPTH = 32

/**
 * Optional click metadata for attribute targets (e.g. editing
 * `placeholder` via the inspector). Bridge callers that built
 * the context from a text-content click leave these undefined;
 * callers from an attribute-edit dispatch fill them in so
 * attribution can match `RenderingHint`s whose `field === 'attribute'`.
 */
export interface ClickedAttribute {
  attributeName: string
  attributeValue?: string
}

export function buildAttributionContext(
  el: Element,
  adapter: FrameworkRuntimeAdapter,
  options: {
    /** When provided, the context describes an attribute edit (not a text click). */
    attribute?: ClickedAttribute
    /**
     * Override for the maximum chain depth (testing). Production
     * callers should accept the default.
     */
    maxChainDepth?: number
  } = {},
): AttributionContext | null {
  const owning = adapter.getOwningInstance(el)
  if (!owning) return null

  const mountRoot = adapter.getInstanceMountRoot(owning)
  const clickedElement = buildClickedElementContext(el, mountRoot, options.attribute)

  const chain = buildComponentChain(owning, adapter, options.maxChainDepth ?? MAX_CHAIN_DEPTH)
  if (chain.length === 0) return null

  return { clickedElement, componentChain: chain }
}

// ──────────────── clicked element ────────────────

function buildClickedElementContext(
  el: Element,
  mountRoot: Element | null,
  attribute: ClickedAttribute | undefined,
): ClickedElementContext {
  const isMountRoot = mountRoot !== null && el === mountRoot
  const selectorWithinMountRoot = isMountRoot ? ':root' : canonicalSelectorOf(el)
  const soleMatchWithinMountRoot = computeSoleMatchWithinMountRoot(
    mountRoot,
    selectorWithinMountRoot,
    isMountRoot,
  )

  const base: ClickedElementContext = {
    selectorWithinMountRoot,
    textContent: el.textContent ?? undefined,
    ownText: ownTextOf(el),
    ...(soleMatchWithinMountRoot !== undefined ? { soleMatchWithinMountRoot } : {}),
  }
  if (attribute) {
    return {
      ...base,
      attributeName: attribute.attributeName,
      attributeValue: attribute.attributeValue,
    }
  }
  return base
}

/**
 * Click-time selector-uniqueness signal (Phase 5 Task 3 — carry-forward
 * I1). Cost note: exactly ONE extra `querySelectorAll` call per click,
 * scoped to the owning component's mount root (never the whole document),
 * so it stays cheap even on large pages — the query only has to walk the
 * mount root's own subtree, which V1's single-token selector convention
 * (`selectorWithinMountRoot` in `canonical-selector.ts`) keeps small in
 * practice.
 *
 * Returns `true` when the clicked element IS the mount root — trivially
 * unique, no query needed (there is exactly one mount root by
 * construction; running `querySelectorAll(':root')` scoped to an element
 * would query the DOCUMENT's root per the CSS spec, not this element,
 * and would misfire as "zero matches" here).
 *
 * Returns `undefined` — not `false` — on any failure: no mount root
 * resolvable, a substrate whose element shape doesn't expose
 * `querySelectorAll`, or the query itself throwing. This signal must
 * degrade to "unknown" rather than "ambiguous" so it never manufactures a
 * false refusal downstream.
 */
function computeSoleMatchWithinMountRoot(
  mountRoot: Element | null,
  selectorWithinMountRoot: string,
  isMountRoot: boolean,
): boolean | undefined {
  if (isMountRoot) return true
  if (!mountRoot) return undefined
  try {
    if (typeof mountRoot.querySelectorAll !== 'function') return undefined
    return mountRoot.querySelectorAll(selectorWithinMountRoot).length === 1
  } catch {
    return undefined
  }
}

/**
 * Concatenation of the element's DIRECT child text nodes — text the
 * element renders itself, excluding text rendered by nested child
 * elements. See `ClickedElementContext.ownText` for why this matters
 * (slot text alongside a sibling tooltip/icon element). Returns the
 * raw concatenation (no trimming) so the slot-text applicator's
 * whitespace-preserving match still works; an all-whitespace result
 * is left as-is and the shell refuses on the trimmed-empty check.
 */
function ownTextOf(el: Element): string {
  let out = ''
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      out += node.textContent ?? ''
    }
  }
  return out
}

// `canonicalSelectorOf` (and its `sortedClasses` helper) now live in
// `src/editor/core/canonical-selector.ts` — shared verbatim with the
// Phase 4 probe driver (`src/editor/hints/probe-driver.ts`), which embeds
// the SAME function source into its in-page script via `.toString()`. See
// that module's doc comment for why this matters: a hand-duplicated copy of
// this algorithm would silently drift from what the probe emits, breaking
// probe-generated `RenderingHint.domTarget.selector` string-matching against
// what this file computes at real click time.

// ──────────────── component chain ────────────────

function buildComponentChain(
  owning: unknown,
  adapter: FrameworkRuntimeAdapter,
  maxDepth: number,
): ComponentChainEntry[] {
  const chain: ComponentChainEntry[] = []
  let cursor: unknown | null = owning
  let depth = 0
  while (cursor && depth < maxDepth) {
    chain.push(extractChainEntry(cursor, adapter))
    cursor = adapter.getParentInstance(cursor)
    depth++
  }
  return chain
}

function extractChainEntry(
  instance: unknown,
  adapter: FrameworkRuntimeAdapter,
): ComponentChainEntry {
  const name = readComponentName(instance, adapter)
  const importPath = readImportPath(instance, adapter)
  const stampRaw = adapter.getCallSiteStamp(instance)
  const consumerSourceLoc = stampRaw ? parseSourceLoc(stampRaw) : undefined

  const consumerVnodeProps = classifyConsumerVnodeProps(instance, adapter)

  // Did the nesting parent also render this component, or was it handed in as
  // slot/children content? Left UNDEFINED when the adapter cannot say — that
  // is "unknown", and it is deliberately distinct from `false`. See
  // `ComponentChainEntry.renderedByParent`.
  const renderOwner = adapter.getRenderOwnerInstance(instance)
  const renderedByParent =
    renderOwner === null ? undefined : renderOwner === adapter.getParentInstance(instance)

  const entry: ComponentChainEntry = { name }
  if (importPath) entry.importPath = importPath
  if (consumerSourceLoc) entry.consumerSourceLoc = consumerSourceLoc
  if (renderedByParent !== undefined) entry.renderedByParent = renderedByParent
  if (consumerVnodeProps) entry.consumerVnodeProps = consumerVnodeProps
  return entry
}

/**
 * Best-effort component name. Vue 3 exposes it on
 * `instance.type.__name` (defineComponent) or as the registered
 * component name. Falls back to "<anonymous>" so the chain entry
 * always has a stable string for manifest lookup — the shell-side
 * lookup will return null for anonymous entries, which the
 * attribution function handles as "no rendering hints."
 */
function readComponentName(instance: unknown, adapter: FrameworkRuntimeAdapter): string {
  // Asked through the adapter. Reading `type.__name` here directly was
  // Vue-only, so React resolved to `<anonymous>` every time — and manifest
  // lookup is BY NAME, so manifest-first attribution was silently disabled
  // for the whole React substrate.
  const fromAdapter = adapter.getComponentName(instance)
  if (fromAdapter) return fromAdapter
  // Fall back to deriving from __file basename, e.g.
  // "src/components/MyCard.vue" → "MyCard". Useful for components
  // that didn't use defineComponent's name resolution but still have
  // a source file.
  const file = adapter.getInstanceFile(instance)
  if (file) {
    const base = file.split('/').pop() ?? ''
    const stripExt = base.replace(/\.(vue|tsx?|jsx?|svelte)$/i, '')
    if (stripExt.length > 0) return stripExt
  }
  return '<anonymous>'
}

/**
 * Best-effort import path. Library components (node_modules) get
 * the package import shape (`@acme/design-system`); user components
 * get the source-relative file path. Used by manifest registries
 * with named lookup that want to disambiguate name collisions.
 * Returns undefined when the file is unknown — the shell-side
 * registry lookup falls back to name-only resolution in that case.
 */
function readImportPath(instance: unknown, adapter: FrameworkRuntimeAdapter): string | undefined {
  const file = adapter.getInstanceFile(instance)
  if (!file) return undefined
  if (!file.includes('/node_modules/')) {
    // User-authored: return as-is (typically already a project-
    // relative path). Editor's manifest registry uses the file
    // path verbatim for first-party components.
    return file
  }
  // Library: extract the package name from the path. Splits on
  // /node_modules/ and uses the LAST segment so pnpm's nested
  // layout (`/node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/...`)
  // resolves to the real package (@scope/pkg) not the shim
  // directory (.pnpm). Standard layouts (npm/yarn/bun) have one
  // /node_modules/ in the path and behave identically.
  const segments = file.split('/node_modules/')
  const lastSegmentParts = segments[segments.length - 1]?.split('/')
  if (!lastSegmentParts || lastSegmentParts.length === 0) return undefined
  if (lastSegmentParts[0].startsWith('@') && lastSegmentParts.length >= 2) {
    return `${lastSegmentParts[0]}/${lastSegmentParts[1]}`
  }
  return lastSegmentParts[0]
}

/**
 * Read + classify the consumer's vnode props for an instance,
 * marking each as literal or binding using
 * `adapter.readConsumerVnodeProps`'s `boundPropNames` set. Vue
 * internals and event listeners are already filtered by the
 * adapter; this layer adds value-type coercion and skips props
 * whose values can't be carried over the postMessage wire (functions,
 * symbols, deep objects we won't introspect at attribution time).
 *
 * Returns undefined when the adapter has no consumer vnode (root
 * component, synthetic boundary) — attribution will see that as
 * "no consumer props" and fall back to refusing prop edits at this
 * level.
 */
function classifyConsumerVnodeProps(
  instance: unknown,
  adapter: FrameworkRuntimeAdapter,
): Record<string, ConsumerPropValue> | undefined {
  const raw = adapter.readConsumerVnodeProps(instance)
  if (!raw) return undefined
  const stamps = raw.boundPropStamps ?? {}
  const out: Record<string, ConsumerPropValue> = {}
  for (const [propName, value] of Object.entries(raw.props)) {
    const coerced = coercePropValue(value)
    if (coerced === undefined) continue
    if (raw.boundPropNames.has(propName)) {
      const binding: ConsumerPropValue = { kind: 'binding', value: coerced }
      // Phase 2c: if the source-tag plugin stamped this binding with a
      // `data-desde-bind:<prop>` attribute, decode its source loc +
      // expression text so attribution can route a simple-identifier
      // binding to `cross-file: ref`. Without a stamp (v-model, spread,
      // dynamic key, no plugin) the binding falls through to LLM.
      const decoded = decodeBindStamp(stamps[propName])
      if (decoded) {
        binding.bindingLoc = decoded.bindingLoc
        binding.expression = decoded.expression
      }
      out[propName] = binding
    } else {
      out[propName] = { kind: 'literal', value: coerced }
    }
  }
  return out
}

/**
 * Decode a `data-desde-bind:<prop>` compile stamp emitted by the
 * source-tag plugin. The value is `"<file>:<line>:<col> <base64(expr)>"`
 * — a `data-desde-src`-shaped loc, a space delimiter, then the
 * base64-encoded expression text. Split on the LAST space, not the
 * first: line/col/base64 never contain a space but the FILE portion of
 * the loc can (a path like `ui drafts/Foo.vue`), so the final space is
 * the only unambiguous delimiter. Returns undefined for a missing or
 * malformed stamp, which callers treat the same as "no binding source"
 * (the binding routes to LLM).
 */
function decodeBindStamp(
  raw: string | undefined,
): { bindingLoc: SourceLoc; expression: string } | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const spaceIdx = raw.lastIndexOf(' ')
  // A well-formed stamp always has the loc/expr delimiter; bail if the
  // space is missing or sits at the very start (empty loc).
  if (spaceIdx <= 0) return undefined
  const locPart = raw.slice(0, spaceIdx)
  const exprPart = raw.slice(spaceIdx + 1)
  const bindingLoc = parseSourceLoc(locPart)
  if (!bindingLoc) return undefined
  const expression = decodeBase64Utf8(exprPart)
  if (expression === undefined) return undefined
  return { bindingLoc, expression }
}

/**
 * Decode a base64 string to UTF-8 in both the browser (bridge runtime,
 * where `atob` exists) and Node (unit tests / SSR, where `Buffer`
 * exists). Returns undefined on a decode failure so a malformed stamp
 * degrades to "no binding source" instead of throwing inside the
 * bridge's extraction path.
 */
function decodeBase64Utf8(b64: string): string | undefined {
  try {
    const g = globalThis as {
      atob?: (s: string) => string
      Buffer?: { from(s: string, enc: string): { toString(enc: string): string } }
    }
    if (typeof g.atob === 'function') {
      // atob yields a binary (latin1) string; re-decode as UTF-8 so
      // non-ASCII expression text round-trips. TextDecoder is available
      // in every browser the bridge targets.
      const binary = g.atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new TextDecoder().decode(bytes)
    }
    if (g.Buffer) {
      return g.Buffer.from(b64, 'base64').toString('utf8')
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Coerce a runtime prop value to the literal/binding-value type
 * attribution expects (string | number | boolean | null). Returns
 * undefined for values we cannot represent (functions, symbols,
 * Map/Set/Date instances, deep objects). Skipped props don't
 * appear in the shell context and so can't be edited via the
 * deterministic path — they fall through to LLM.
 */
function coercePropValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  return undefined
}

/**
 * Parse a "file:line:column" stamp into the structured shape
 * `AttributionContext` uses. Returns undefined when the stamp is
 * malformed; callers treat that the same as "no source position."
 * Local copy parallels `leaf-prop-attribution.ts`'s parser; if
 * either changes shape, factor to a shared module.
 */
function parseSourceLoc(raw: string): SourceLoc | undefined {
  const lastColon = raw.lastIndexOf(':')
  if (lastColon < 0) return undefined
  const secondLastColon = raw.lastIndexOf(':', lastColon - 1)
  if (secondLastColon < 0) return undefined
  const file = raw.slice(0, secondLastColon)
  const line = Number(raw.slice(secondLastColon + 1, lastColon))
  const column = Number(raw.slice(lastColon + 1))
  if (!file || !Number.isFinite(line) || !Number.isFinite(column)) {
    return undefined
  }
  return { file, line, column }
}

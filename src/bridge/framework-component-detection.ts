/**
 * Desde Bridge — Framework Component Detection
 *
 * Extracted verbatim from `comment-bridge.ts`. Pure per-framework component
 * introspection: walks Vue 3/2, React fiber, Angular, Svelte, and web-component
 * runtime structures to recover component name/file/props/selector for the
 * inspector, layers tree, and edit-target resolution. No IIFE closure state —
 * depends only on browser globals and `generateSelector` (./selector-engine).
 * esbuild inlines this back into the IIFE at bundle time.
 */
import { generateSelector } from "./selector-engine"

// ── Framework Component Detection ─────────────────────────────────────

export interface FrameworkComponentInfo {
  framework: "vue" | "react" | "angular" | "svelte" | "web-component"
  name: string
  file?: string
  line?: number
  props?: Record<string, unknown>
}

export function serializePropValue(val: unknown): unknown {
  if (val === null || val === undefined) return val
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val
  if (typeof val === "function") return `[Function: ${(val as { name?: string }).name || "anonymous"}]`
  if (Array.isArray(val)) return `Array(${val.length})`
  if (typeof val === "object") {
    try {
      const keys = Object.keys(val)
      if (keys.length <= 3) {
        const preview: Record<string, unknown> = {}
        for (const k of keys) preview[k] = typeof (val as Record<string, unknown>)[k]
        return preview
      }
      return `Object(${keys.length} keys)`
    } catch { return "[Object]" }
  }
  return String(val)
}

export function inferNameFromFile(filePath?: string): string | null {
  if (!filePath) return null
  const parts = filePath.split("/")
  const filename = parts[parts.length - 1]
  return filename.replace(/\.\w+$/, "") || null
}

export function detectVue3(el: Element): FrameworkComponentInfo | null {
  let current: Element | null = el
  while (current && current !== document.documentElement) {
    const instance = (current as Record<string, unknown>).__vueParentComponent as Record<string, unknown> | undefined
    if (instance) {
      const type = instance.type as Record<string, unknown> | undefined
      if (!type) { current = current.parentElement; continue }
      const name = (type.__name || type.name || inferNameFromFile(type.__file as string | undefined) || "Anonymous") as string
      const props = serializeInstanceMap(instance.props)
      return { framework: "vue", name, file: (type.__file as string) || undefined, props }
    }
    current = current.parentElement
  }
  return null
}

/**
 * Serialize an `instance.props` or `instance.attrs` map into
 * something postMessage-safe. Skips internal `__*` keys and DOM
 * event listener attrs (`onClick`, etc. — these aren't editable
 * via the inspector's text-edit path).
 *
 * Also skips Desde-internal source-mapping stamps (`data-desde-src`,
 * `data-desde-bind:*`) that the source-tag plugin injects into the template.
 * Vue treats these as fallthrough attrs, so without this they leak into
 * the inspector's Attributes section as bogus "props" whose value is the
 * `file:line:col base64expr` stamp rather than anything editable.
 */
export function serializeInstanceMap(
  raw: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!raw || typeof raw !== "object") return out
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (key.startsWith("__")) continue
    // Internal source-mapping stamps — never user-editable attributes.
    if (key === "data-desde-src" || key.startsWith("data-desde-bind:")) continue
    // Vue normalizes event bindings as `onSomething`; skip them so
    // the inspector's Attributes section doesn't show a row of
    // un-editable function references.
    if (
      key.length > 2 &&
      key.startsWith("on") &&
      key[2] >= "A" &&
      key[2] <= "Z"
    ) {
      continue
    }
    out[key] = serializePropValue((raw as Record<string, unknown>)[key])
  }
  return out
}

export interface ComponentTreeNode {
  name: string
  file?: string
  line?: number
  props?: Record<string, unknown>
  /**
   * Fallthrough attrs (`instance.attrs` in Vue 3) — what the parent
   * template passed that the component didn't typed-declare. Surfaced
   * separately from `props` so the shell can render them as an
   * "Attributes" section distinct from manifest-typed props.
   */
  attrs?: Record<string, unknown>
  elementSelector: string
  isLibrary?: boolean
  packageName?: string
  /**
   * The `data-desde-src` callsite stamp the source-tag plugin put on this
   * component's tag (`file:line:col`, repo-relative), when the tag was
   * written in a stamped first-party file. A component instantiated inside
   * library code has none. This is what tells a first-party wrapper apart
   * from the library internals rooted at the same element on React, where
   * fibers carry no file: the shell prefers the OUTERMOST stamped node
   * rooted at the clicked element as the selection's component. MEASURED on
   * the bundled Acme demo (2026-09-02): the tree for its button was
   * `[App, Button, Button]`, the second being base-ui's internal, and the
   * old last-node rule picked the internal; it looked right only because
   * both are named Button.
   */
  callsite?: string
}

export interface OutlineNode {
  id: string
  name: string
  type: "element" | "component" | "text"
  x: number
  y: number
  width: number
  height: number
  selector: string
  componentFile?: string
  packageName?: string
  authoredAt?: { file: string; line: number; column: number }
  editTarget?: { file: string; line: number; column: number }
  isLibrary?: boolean
  children?: OutlineNode[]
}

export const VUE_INTERNAL_NAMES = new Set([
  "Fragment", "Teleport", "Suspense", "KeepAlive",
  "BaseTransition", "Transition", "TransitionGroup",
])

export function getVueInstanceRootElement(instance: Record<string, unknown>): Element | null {
  // Vue 3 component instances expose their root DOM via subTree.el
  const subTree = instance.subTree as Record<string, unknown> | undefined
  if (subTree) {
    const domEl = subTree.el as Element | undefined
    if (domEl && domEl instanceof Element) return domEl
  }
  // Fallback: try vnode.el
  const vnode = instance.vnode as Record<string, unknown> | undefined
  if (vnode) {
    const domEl = vnode.el as Element | undefined
    if (domEl && domEl instanceof Element) return domEl
  }
  return null
}

export function extractNodeFromInstance(inst: Record<string, unknown>): ComponentTreeNode | null {
  const type = inst.type as Record<string, unknown> | undefined
  if (!type) return null
  const name = (type.__name || type.name || inferNameFromFile(type.__file as string | undefined) || null) as string | null
  if (!name || name === "Anonymous" || name.startsWith("_") || VUE_INTERNAL_NAMES.has(name)) return null
  const props = serializeInstanceMap(inst.props)
  const attrs = serializeInstanceMap(inst.attrs)
  let selector = ""
  try {
    const rootEl = getVueInstanceRootElement(inst)
    if (rootEl) selector = generateSelector(rootEl)
  } catch { /* ignore */ }
  const file = (type.__file as string) || undefined
  const isLibrary = file ? file.includes("node_modules") : false
  const packageName = file && isLibrary ? extractPackageName(file) : undefined
  return {
    name,
    file,
    props: Object.keys(props).length > 0 ? props : undefined,
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    elementSelector: selector,
    isLibrary: isLibrary || undefined,
    packageName,
  }
}

/**
 * The outermost Vue instance whose render root IS `el` and which is not
 * `owner` — i.e. the component element the owner's template wrote at this
 * stamped node. Null when no instance is rooted here (plain markup in the
 * owner's own template) or when the runtime is not Vue 3. "Outermost
 * non-owner" is what resolves Vue root-chaining, where several instances
 * collapse onto one DOM node; the worked cases live in ONE place, the
 * `InspectionData.editTargetComponent` doc in `src/types/bridge.ts`.
 */
export function findOutermostInstanceRootedAt(
  el: Element,
  owner: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const start = (el as unknown as Record<string, unknown>).__vueParentComponent as
    | Record<string, unknown>
    | undefined
  if (!start) return null
  let found: Record<string, unknown> | null = null
  let inst: Record<string, unknown> | null = start
  while (inst) {
    if (inst === owner) break
    if (getVueInstanceRootElement(inst) === el) {
      found = inst
    } else {
      // Chained roots are contiguous from the innermost owner upward: once an
      // ancestor's render root stops being `el`, no higher ancestor's can be
      // `el` again — same early break `detectOutlineComponent` uses. Without
      // it, the walk climbs to the tree top on every inspection whenever
      // `owner` is absent or (as in the no-direct-instance case) a sentinel
      // object that can never reference-equal a real instance.
      break
    }
    inst = (inst.parent as Record<string, unknown> | null) ?? null
  }
  return found
}

export function buildVue3ComponentTree(el: Element): ComponentTreeNode[] {
  // Collect component instances from two sources and merge:
  // 1. DOM walk — catches slot wrapper components (e.g. EntityFormBlock wrapping slot content)
  // 2. Vue parent chain — catches components whose root is another component (e.g. EntityBaseForm whose root is UiCard)

  // Step 1: Walk DOM parents, collect all Vue instances encountered
  const domInstances: Record<string, unknown>[] = []
  const seen = new Set<Record<string, unknown>>()
  let current: Element | null = el
  while (current && current !== document.documentElement) {
    const instance = (current as Record<string, unknown>).__vueParentComponent as Record<string, unknown> | undefined
    if (instance && !seen.has(instance)) {
      domInstances.push(instance)
      seen.add(instance)
    }
    current = current.parentElement
  }

  // Step 2: For every DOM-found instance, also walk its Vue parent chain to catch
  // transparent wrappers (components whose root element is a child component)
  const allInstances: Record<string, unknown>[] = []
  for (const domInst of domInstances) {
    // Walk parent chain from this instance, collecting any unseen ancestors
    // until we hit an instance already collected from DOM or a previous chain walk
    const parentChain: Record<string, unknown>[] = []
    let inst = (domInst.parent as Record<string, unknown> | null) || null
    while (inst && !seen.has(inst)) {
      seen.add(inst)
      parentChain.push(inst)
      inst = (inst.parent as Record<string, unknown> | null) || null
    }
    // Insert parent chain ancestors before this DOM instance (they are higher in the tree)
    parentChain.reverse()
    allInstances.push(...parentChain)
    allInstances.push(domInst)
  }

  // Step 3: Continue walking the Vue parent chain from the last DOM instance
  // to catch any remaining ancestors above the DOM tree
  if (domInstances.length > 0) {
    const topDomInst = domInstances[domInstances.length - 1]
    let inst = (topDomInst.parent as Record<string, unknown> | null) || null
    const topAncestors: Record<string, unknown>[] = []
    while (inst && !seen.has(inst)) {
      seen.add(inst)
      topAncestors.push(inst)
      inst = (inst.parent as Record<string, unknown> | null) || null
    }
    topAncestors.reverse()
    allInstances.push(...topAncestors)
  }

  // Step 4: Build the final chain, root-first order
  // allInstances is currently in bottom-up order (nearest first), reverse for root-first
  allInstances.reverse()
  const chain: ComponentTreeNode[] = []
  for (const inst of allInstances) {
    const node = extractNodeFromInstance(inst)
    if (node) chain.push(node)
  }
  return chain
}

export const REACT_INTERNAL_NAMES = new Set([
  "Fragment", "Suspense", "StrictMode", "Profiler",
  "ForwardRef", "RenderedRoute", "Outlet",
])

export function extractPackageName(filePath: string): string | undefined {
  // e.g. "../../node_modules/@progress/kendo-react-buttons/dist/es/Button.js"
  const nmIdx = filePath.lastIndexOf("node_modules/")
  if (nmIdx === -1) return undefined
  const afterNm = filePath.substring(nmIdx + "node_modules/".length)
  if (afterNm.startsWith("@")) {
    // Scoped package: @scope/name
    const parts = afterNm.split("/")
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  }
  return afterNm.split("/")[0] || undefined
}

// ── React mount roots ─────────────────────────────────────────────────
//
// React never marks a DOM element with the component that rendered it the
// way Vue's `__vueParentComponent` does. The only link is the fiber tree: a
// host element's fiber (`__reactFiber$<random>` on the element) walks UP
// through `return` to the component fibers above it, and a component fiber
// reaches its rendered DOM only by walking DOWN `child` to the first
// HostComponent in its subtree. That first host is the component's MOUNT
// ROOT, and it is the one fact both consumers below need:
//
//   - `buildReactComponentTree` reports it as `elementSelector`. The shell
//     compares that against the clicked element's selector to decide whether
//     a click landed on the component itself (Variants & Props, Detach) or
//     on an element inside it. A function component's `stateNode` is null,
//     so before this walk existed the selector read "" for every React node
//     and no first-party React component could reach the component view —
//     only library-rooted ones, rescued by the `selfStamped: false`
//     carve-out in `inspection-conversion.ts`. MEASURED on the Northwind
//     demo's `Button` (2026-09-02): the bridge named the component and its
//     `variant`, the rail showed a bare `<a>`.
//   - `detectOutlineComponent` labels a Structure row as a component only
//     when the row's element IS a component's mount root, the same
//     `subTree.el === el` rule the Vue branch applies. Without it every
//     React row was a tag name.
//
// Tags are React's `WorkTag` numbers: FunctionComponent 0, ClassComponent 1,
// HostComponent 5, ForwardRef 11, MemoComponent 14, SimpleMemoComponent 15 —
// the set the runtime adapter in `comment-bridge.ts` keys on.
const REACT_COMPONENT_FIBER_TAGS = new Set([0, 1, 11, 14, 15])
const REACT_HOST_FIBER_TAG = 5

type ReactFiber = Record<string, unknown>

export function getReactFiberOf(el: Element): ReactFiber | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))
  if (!key) return null
  return ((el as Record<string, unknown>)[key] as ReactFiber | undefined) ?? null
}

/**
 * The component's function/class name, unwrapping `memo` / `forwardRef`
 * wrappers to any depth. `memo(forwardRef(fn))` is the common design-system
 * shape, and one level of unwrapping reads the forwardRef object (no name)
 * and stops (review finding, 2026-09-02). Each wrapper exposes the inner
 * component on `.type` (memo) or `.render` (forwardRef); `displayName` on
 * any layer wins, then the innermost function's own `name`.
 */
export function reactComponentName(type: unknown): string | null {
  let cur: unknown = type
  for (let depth = 0; depth < 6 && cur; depth++) {
    const rec = cur as { displayName?: unknown; name?: unknown; type?: unknown; render?: unknown }
    for (const v of [rec.displayName, rec.name]) {
      if (typeof v === "string" && v.length > 0) return v
    }
    if (typeof cur !== "object") break
    cur = rec.type ?? rec.render
  }
  return null
}

/**
 * Props the source-tag plugin writes onto every JSX element, component tags
 * included (`data-desde-src` callsite, `data-desde-v` file version, and any
 * future `data-desde-*`). They ride on the component fiber's `memoizedProps`
 * like a real prop, and the shell renders whatever arrives here as editable
 * rows when a component has no manifest. The Vue side strips its stamps in
 * `serializeInstanceMap` for the same reason; MEASURED on the Northwind
 * Button (2026-09-02): two stamp rows above `variant` in the rail.
 */
function isDesdeStampProp(key: string): boolean {
  return key.startsWith("data-desde-")
}

/**
 * Component fibers by TAG, not by `typeof fiber.type === "function"`: a
 * `forwardRef` or `memo` component's `type` is a wrapper OBJECT, so the old
 * test dropped every such component from the tree and from `detectReact`,
 * which is the pre-fix symptom (no component view) for exactly the
 * components design systems are made of. Falls back to the function test
 * for a fiber-shaped object with no tag (older fabricated inputs).
 */
function isReactComponentFiber(fiber: ReactFiber): boolean {
  const tag = fiber.tag
  if (typeof tag === "number") return REACT_COMPONENT_FIBER_TAGS.has(tag)
  return typeof fiber.type === "function"
}

/**
 * First HostComponent in `fiber`'s subtree — the DOM element the component
 * mounts as. Seeded with `fiber.child`, never `fiber.sibling` (outside the
 * subtree), and capped so a pathological tree cannot run away. The same
 * walk as `findFirstReactHostFiber` in the runtime adapter.
 */
export function getReactComponentMountRoot(fiber: ReactFiber): Element | null {
  const firstChild = fiber.child as ReactFiber | null | undefined
  if (!firstChild) return null
  const stack: ReactFiber[] = [firstChild]
  let budget = 256
  while (stack.length > 0 && budget-- > 0) {
    const cur = stack.pop()!
    if (cur.tag === REACT_HOST_FIBER_TAG && cur.stateNode instanceof Element) return cur.stateNode
    const sibling = cur.sibling as ReactFiber | null | undefined
    const child = cur.child as ReactFiber | null | undefined
    if (sibling) stack.push(sibling)
    if (child) stack.push(child)
  }
  return null
}

function isNamedReactComponent(name: string | null): name is string {
  return !!name && name !== "Anonymous" && !name.startsWith("_") && !REACT_INTERNAL_NAMES.has(name)
}

function reactPropsOf(fiber: ReactFiber): Record<string, unknown> {
  const memoized = fiber.memoizedProps as Record<string, unknown> | undefined
  const props: Record<string, unknown> = {}
  if (memoized) {
    for (const key of Object.keys(memoized)) {
      if (key === "children" || isDesdeStampProp(key)) continue
      props[key] = serializePropValue(memoized[key])
    }
  }
  return props
}

/**
 * React half of {@link detectOutlineComponent}: `el` is labeled with the
 * OUTERMOST named component whose mount root is `el`. Walking `return` from
 * the host fiber, every component fiber that mounts as `el` is a transparent
 * wrapper of the one below it (`Card` rendering `<Panel/>` rendering
 * `<div>`), so the chain keeps climbing while the mount root still is `el`.
 * The first host fiber above ends it: past that the DOM changes. A
 * component whose first host is some OTHER element ends it too — and so
 * does every ancestor, since an ancestor's first host is found through that
 * same subtree.
 */
export function detectReactOutlineComponent(el: Element): FrameworkComponentInfo | null {
  const hostFiber = getReactFiberOf(el)
  if (!hostFiber) return null
  let best: ReactFiber | null = null
  let cur = hostFiber.return as ReactFiber | null | undefined
  let budget = 64
  while (cur && budget-- > 0) {
    const tag = cur.tag as number | undefined
    if (tag === REACT_HOST_FIBER_TAG) break
    if (typeof tag === "number" && REACT_COMPONENT_FIBER_TAGS.has(tag)) {
      if (getReactComponentMountRoot(cur) !== el) break
      if (isNamedReactComponent(reactComponentName(cur.type))) best = cur
    }
    cur = cur.return as ReactFiber | null | undefined
  }
  if (!best) return null
  const source = best._debugSource as { fileName?: unknown; lineNumber?: unknown } | undefined
  return {
    framework: "react",
    name: reactComponentName(best.type)!,
    file: typeof source?.fileName === "string" ? source.fileName : undefined,
    line: typeof source?.lineNumber === "number" ? source.lineNumber : undefined,
    props: reactPropsOf(best),
  }
}

export function buildReactComponentTree(el: Element): ComponentTreeNode[] {
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))
  if (!fiberKey) return []

  let fiber = (el as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null

  // Walk up the fiber tree, collecting all function components
  const chain: ComponentTreeNode[] = []
  const seen = new Set<Record<string, unknown>>()

  while (fiber) {
    if (seen.has(fiber)) break
    seen.add(fiber)

    const type = fiber.type as ((...args: unknown[]) => unknown) | Record<string, unknown> | string | undefined
    if (type && isReactComponentFiber(fiber)) {
      const name = reactComponentName(type) ?? "Anonymous"

      if (!REACT_INTERNAL_NAMES.has(name) && name !== "Anonymous" && !name.startsWith("_")) {
        const props = reactPropsOf(fiber)
        const memoized = fiber.memoizedProps as Record<string, unknown> | undefined
        const stamp = memoized?.["data-desde-src"]
        const callsite = typeof stamp === "string" && stamp.length > 0 ? stamp : undefined

        const typeSource = (type as Record<string, unknown>).__source as Record<string, unknown> | undefined
        const fiberSource = fiber._debugSource as Record<string, unknown> | undefined
        const source = typeSource || fiberSource
        const file = (source?.fileName as string) || undefined
        const line = (source?.lineNumber as number) || undefined

        const isLibrary = file ? file.includes("node_modules") : false
        const packageName = file && isLibrary ? extractPackageName(file) : undefined

        // The component's mount root — see "React mount roots" above. This
        // used to read `fiber.stateNode`, which is null for a function
        // component, so every node carried "" and the shell could never
        // match a click to the component.
        let selector = ""
        try {
          const root = getReactComponentMountRoot(fiber)
          if (root) selector = generateSelector(root)
        } catch { /* ignore */ }

        chain.push({
          name,
          file,
          line,
          props: Object.keys(props).length > 0 ? props : undefined,
          elementSelector: selector,
          isLibrary: isLibrary || undefined,
          packageName,
          callsite,
        })
      }
    }

    fiber = (fiber.return || fiber._debugOwner) as Record<string, unknown> | null
  }

  // chain is nearest-first, reverse for root-first (matching Vue tree order)
  chain.reverse()
  return chain
}

export function detectVue2(el: Element): FrameworkComponentInfo | null {
  let current: Element | null = el
  while (current && current !== document.documentElement) {
    const vue = (current as Record<string, unknown>).__vue__ as Record<string, unknown> | undefined
    if (vue) {
      const options = vue.$options as Record<string, unknown> | undefined
      const name = ((options?.name || options?._componentTag || "Anonymous") as string)
      const file = (options?.__file as string) || undefined
      const propsData = vue.$props as Record<string, unknown> | undefined
      const props: Record<string, unknown> = {}
      if (propsData) {
        for (const key of Object.keys(propsData)) {
          props[key] = serializePropValue(propsData[key])
        }
      }
      return { framework: "vue", name, file, props }
    }
    current = current.parentElement
  }
  return null
}

export function detectReact(el: Element): FrameworkComponentInfo | null {
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"))
  if (!fiberKey) return null
  let fiber = (el as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null
  while (fiber) {
    const type = fiber.type as ((...args: unknown[]) => unknown) | Record<string, unknown> | string | undefined
    // An unnamed wrapper (anonymous forwardRef/memo) keeps the walk going to
    // the named component above it, as the old function-only test did by
    // accident; naming it "Anonymous" would stop the walk one level short.
    const wrapperName = type && isReactComponentFiber(fiber) ? reactComponentName(type) : null
    if (type && wrapperName) {
      const name = wrapperName
      const props = reactPropsOf(fiber)
      const typeSource = (type as Record<string, unknown>).__source as Record<string, unknown> | undefined
      const fiberSource = fiber._debugSource as Record<string, unknown> | undefined
      const source = typeSource || fiberSource
      const file = (source?.fileName as string) || undefined
      const line = (source?.lineNumber as number) || undefined
      return { framework: "react", name, file, line, props }
    }
    fiber = (fiber.return || fiber._debugOwner) as Record<string, unknown> | null
  }
  return null
}

export function detectAngular(el: Element): FrameworkComponentInfo | null {
  const ngContext = (el as Record<string, unknown>).__ngContext__ as unknown[] | undefined
  if (!ngContext) return null
  const ngAttr = Array.from(el.attributes).find((a) => a.name.startsWith("_ngcontent-") || a.name.startsWith("_nghost-"))
  const name = el.tagName.toLowerCase()
  if (name.includes("-") || ngAttr) {
    return { framework: "angular", name, props: {} }
  }
  return null
}

export function detectSvelte(el: Element): FrameworkComponentInfo | null {
  const svelteKey = Object.keys(el).find((k) => k.startsWith("__svelte"))
  if (svelteKey) {
    return { framework: "svelte", name: el.tagName.toLowerCase(), props: {} }
  }
  return null
}

export function detectWebComponent(el: Element): FrameworkComponentInfo | null {
  if (el.tagName.includes("-") && customElements.get(el.tagName.toLowerCase())) {
    const name = el.tagName.toLowerCase()
    const props: Record<string, unknown> = {}
    for (const attr of Array.from(el.attributes)) {
      props[attr.name] = attr.value
    }
    return { framework: "web-component", name, props }
  }
  return null
}

export function detectFrameworkComponent(el: Element): FrameworkComponentInfo | null {
  return detectVue3(el) || detectVue2(el) || detectReact(el) || detectSvelte(el) || detectAngular(el) || detectWebComponent(el) || null
}

/**
 * Layers-panel variant of {@link detectDirectComponent}. Walks UP the Vue
 * parent chain through "transparent wrapper" components — components
 * whose own `subTree.el` is the same DOM element as `el` (i.e., A
 * renders `<B/>` as its sole root, so A and B share a DOM root). Picks
 * the OUTERMOST user-authored ancestor (has `__file` not under
 * `node_modules`); falls back to the outermost named ancestor; falls
 * back to the innermost.
 *
 * Why this exists: `detectDirectComponent` only sees the leaf instance
 * (e.g. `UiCard`, a renderless design-system wrapper). The prototype
 * source actually wrote `<ProtoCatalogCard>` two levels up the Vue
 * parent chain. A designer staring at the layers tree wants to see
 * the component THEY composed, not the library internals it expanded
 * into. Mirrors the ancestry resolution `buildVue3ComponentTree`
 * already uses for the inspector breadcrumb.
 */
export function detectOutlineComponent(el: Element): FrameworkComponentInfo | null {
  const inst = (el as Record<string, unknown>).__vueParentComponent as
    | Record<string, unknown>
    | undefined
  if (inst) {
    // CRITICAL: only label `el` as a component if `el` IS the instance's
    // render root (`subTree.el`). Vue 3 sets `__vueParentComponent` on
    // every DOM node a component renders — not just the root — so
    // without this check every internal <div>/<span>/<button> inside
    // UiCard's template would also get labeled "UiCard", producing the
    // "tree is just nested UiCards" effect the designer flagged. Inner
    // markup correctly falls through to the tagName label.
    const ownSubTreeEl = (inst.subTree as { el?: Element } | undefined)?.el
    if (ownSubTreeEl !== el) return null

    // Collect the chain of components sharing `el` as their subTree
    // root — leaf-first. Each transparent-wrapper ancestor renders the
    // child as its sole root, so they share `el`.
    const chain: Record<string, unknown>[] = [inst]
    let p = (inst.parent as Record<string, unknown> | null) || null
    while (p) {
      const subTree = p.subTree as { el?: Element } | undefined
      if (subTree?.el !== el) break
      chain.push(p)
      p = (p.parent as Record<string, unknown> | null) || null
    }

    // Outermost first, then look for the best match.
    const reversed = chain.slice().reverse()
    // Pass 1: outermost user-authored (has __file outside node_modules).
    for (const candidate of reversed) {
      const info = extractComponentInfo(candidate, true)
      if (info) return info
    }
    // Pass 2: outermost named (any source).
    for (const candidate of reversed) {
      const info = extractComponentInfo(candidate, false)
      if (info) return info
    }
  }
  // React: label `el` only when it is a component's mount root, the same
  // rule the Vue branch applies through `subTree.el` — see "React mount
  // roots" above.
  const reactInfo = detectReactOutlineComponent(el)
  if (reactInfo) return reactInfo
  // Vue 2 / Angular / Svelte / WebComponent fall back to the strict
  // detector — none of these expose a usable parent-chain analog here.
  return detectDirectComponent(el)
}

/**
 * Pull a {@link FrameworkComponentInfo} out of a Vue 3 instance, applying
 * the same name and source-file filters as {@link detectDirectComponent}
 * but WITHOUT the renderless-render/template guard (the parent-chain walk
 * above handles transparent wrappers properly, so the guard is no longer
 * the right tool — it was rejecting legitimate setup-only components like
 * the design system's `UiCard`).
 *
 * When `requireUserFile` is true, only returns when `__file` is set and
 * does NOT contain `node_modules` — used to prefer prototype-authored
 * components over library internals.
 */
export function extractComponentInfo(
  inst: Record<string, unknown>,
  requireUserFile: boolean,
): FrameworkComponentInfo | null {
  const type = inst.type as Record<string, unknown> | undefined
  if (!type) return null
  const file = (type.__file as string | undefined) || undefined
  if (requireUserFile) {
    if (!file || file.includes("node_modules")) return null
  }
  const name = (type.__name ||
    type.name ||
    inferNameFromFile(file) ||
    "Anonymous") as string
  if (name === "Anonymous" || name.startsWith("_") || VUE_INTERNAL_NAMES.has(name)) {
    return null
  }
  const props: Record<string, unknown> = {}
  const instanceProps = inst.props as Record<string, unknown> | undefined
  if (instanceProps) {
    for (const key of Object.keys(instanceProps)) {
      if (key.startsWith("__")) continue
      props[key] = serializePropValue(instanceProps[key])
    }
  }
  return { framework: "vue", name, file, props }
}

/** Detect component only if `el` itself is a component root — no DOM/fiber walking.
 *  Skips renderless components (setup returns render, no compiled template). */
export function detectDirectComponent(el: Element): FrameworkComponentInfo | null {
  // Vue 3: element has __vueParentComponent directly (not inherited from a parent)
  const vueInstance = (el as Record<string, unknown>).__vueParentComponent as Record<string, unknown> | undefined
  if (vueInstance) {
    const type = vueInstance.type as Record<string, unknown> | undefined
    if (type) {
      // Skip renderless/transparent components — SFCs have a compiled render function,
      // renderless wrappers (e.g. KComponent) only return slots from setup and don't.
      if (typeof type.render !== "function" && typeof type.template !== "string") return null
      const name = (type.__name || type.name || inferNameFromFile(type.__file as string | undefined) || "Anonymous") as string
      if (name !== "Anonymous" && !name.startsWith("_") && !VUE_INTERNAL_NAMES.has(name)) {
        const props: Record<string, unknown> = {}
        const instanceProps = vueInstance.props as Record<string, unknown> | undefined
        if (instanceProps) {
          for (const key of Object.keys(instanceProps)) {
            if (key.startsWith("__")) continue
            props[key] = serializePropValue(instanceProps[key])
          }
        }
        return { framework: "vue", name, file: (type.__file as string) || undefined, props }
      }
    }
  }
  // Vue 2: element has __vue__ directly
  const vue2 = (el as Record<string, unknown>).__vue__ as Record<string, unknown> | undefined
  if (vue2) {
    const options = vue2.$options as Record<string, unknown> | undefined
    const name = ((options?.name || options?._componentTag || "Anonymous") as string)
    if (name !== "Anonymous") {
      const file = (options?.__file as string) || undefined
      const propsData = vue2.$props as Record<string, unknown> | undefined
      const props: Record<string, unknown> = {}
      if (propsData) {
        for (const key of Object.keys(propsData)) {
          props[key] = serializePropValue(propsData[key])
        }
      }
      return { framework: "vue", name, file, props }
    }
  }
  // Angular, Svelte, WebComponent already check the element directly
  return detectAngular(el) || detectSvelte(el) || detectWebComponent(el) || null
}


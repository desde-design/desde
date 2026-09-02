/**
 * Library-component prop attribution for slot-text leaves.
 *
 * Extracted from `comment-bridge.ts` so it can be unit-tested against a
 * stub `FrameworkRuntimeAdapter` without booting an iframe / Vue app /
 * Playwright environment. The bridge IIFE imports `resolve` and the
 * interface; esbuild inlines the module at bundle time.
 *
 * The function is pure — no DOM globals, no framework references. All
 * runtime introspection (instance lookup, prop reading, slot
 * disambiguation) goes through the adapter the caller passes in. That
 * means: same code path, same tests, when a React adapter is added.
 *
 * See `tasks/framework-runtime-adapter.md` for the broader migration
 * plan and the React-fiber recipe for each adapter method.
 */

/**
 * Per-framework runtime seam. The bridge's prop-attribution logic
 * talks to this interface instead of `__vueParentComponent` /
 * `instance.props` / `__reactFiber$xxx` / `fiber.memoizedProps`
 * directly. One impl per supported framework; today only Vue 3
 * (see `vue3RuntimeAdapter` in `comment-bridge.ts`).
 *
 * The handle type is `unknown` deliberately: Vue instances and React
 * fibers look nothing alike, but neither shape needs to leak to
 * callers — they pass the handle right back into another adapter
 * method. Casts live inside the adapter impls.
 */
export interface FrameworkRuntimeAdapter {
  /** Identifier — useful in logs, errors, smoke handshake. */
  name: string
  /**
   * Find the component instance that owns this DOM element. Returns
   * null when the element isn't tracked by the framework (raw DOM,
   * detached node, shadow boundary).
   */
  /**
   * True when `el` ITSELF carries the framework's own instance pointer, as
   * opposed to being reached by walking upward.
   *
   * Distinct from `getOwningInstance` on purpose. That method deliberately
   * walks ancestors (Vue's `stringifyStatic` bulk-inserts whole static
   * subtrees whose elements never receive a pointer), so a non-null instance
   * does NOT mean it describes `el` — it may describe an adopted ancestor.
   * Attribution needs the stricter question before it exposes
   * instance-derived fields (`editableComponent`, `leafVnodeStampRaw`,
   * `iteration`), because attributing a wrapper's props to a static
   * descendant points the edit at the wrong thing.
   *
   * Lives on the adapter because the answer is framework-specific: Vue stamps
   * `__vueParentComponent`, React stamps `__reactFiber$<suffix>`. Reading
   * either one directly in shared code silently pins that code to one
   * framework — which is exactly what happened here before 2026-08-09.
   */
  hasOwnInstancePointer(el: Element): boolean
  /**
   * The component's own name, or null when the runtime does not expose one.
   *
   * Framework-specific by nature and therefore the adapter's job: Vue keeps
   * it on `type.__name`, React on the function/class `displayName ?? name`
   * (often behind a `memo` / `forwardRef` wrapper). Shared code that reached
   * for `__name` directly resolved EVERY React component to `<anonymous>`,
   * and since manifest lookup is by name, manifest-first attribution was
   * silently off for the entire React substrate — degrading to the heuristic
   * fallback with nothing reporting that it had.
   */
  getComponentName(instance: unknown): string | null
  getOwningInstance(el: Element): unknown | null
  /**
   * True when the instance's component definition comes from a
   * library bundle (no editable source) and therefore the leaf
   * text is rendered by a template the user can't directly edit —
   * the rewrite has to land at the consumer's call site instead.
   * False for user-authored components, whose slot text IS the
   * editable surface (the legacy slot-text path handles them).
   */
  isLibraryInstance(instance: unknown): boolean
  /**
   * Source-tag string for where this component is *called from* in
   * user code. Equivalent of the consumer's `<Tag>` position —
   * "file:line:column" format, same convention as `data-desde-src`.
   * Returns null when no source tag is available (root component,
   * runtime-mounted, framework wrapper).
   */
  getCallSiteStamp(instance: unknown): string | null
  /**
   * Declared / consumer-passed props the inspector should consider
   * editable. Filtering of framework internals (Vue's `__*`,
   * React's `key`/`ref`, event listeners) lives INSIDE this method
   * so the consumer doesn't need to know each framework's reserved
   * names.
   */
  readDeclaredProps(instance: unknown): Record<string, unknown>
  /**
   * True when `el` was rendered by `instance`'s OWN template /
   * render function. False when `el` is slot/children content the
   * consumer passed in — in that case the rendered text is
   * authored at the CALLER's source position, and the slot-text
   * path is the correct rewrite route.
   *
   * Disambiguates the `<Card title="Hello">Hello</Card>` shape:
   * leaf text equals a prop value but the leaf is actually slot
   * content, not prop-rendered text.
   */
  wasRenderedByInstanceTemplate(el: Element, instance: unknown): boolean
  /**
   * Root DOM element of `instance` — i.e. the element produced by
   * `instance`'s render function and inserted into the DOM tree.
   * Used by callers that need to ask "is `el` the mount root of
   * its owning instance?" (the answer drives whether to prefer the
   * consumer's call-site or the leaf's own `data-desde-src` as the
   * edit target). Returns null when the instance hasn't mounted
   * yet, was rendered to a fragment, or otherwise has no single
   * DOM root.
   */
  getInstanceMountRoot(instance: unknown): Element | null
  /**
   * Parent component instance. Used to walk up the framework's
   * component tree (e.g. for transparent-wrapper resolution and
   * callsite-file detection). Returns null at the root.
   */
  getParentInstance(instance: unknown): unknown | null
  /**
   * The component instance whose RENDER created this instance —
   * its author, as opposed to {@link getParentInstance}, which is
   * where it ended up NESTED. The two differ for exactly one shape,
   * and that shape is why this method exists: a component the user
   * passed as slot/children content is nested inside the component
   * it was handed to, but authored by the component that wrote it.
   *
   * MEASURED on a live Vue app: a `<KButton>` written in
   * AIGatewayListShell.vue and handed to `<PageLayout>` reports
   * `getParentInstance` = PageLayout but this = AIGatewayListShell.
   * A library-internal `<KLabel>` that KSelect renders itself
   * reports KSelect for both.
   *
   * Callers compare the two. Equal means "my parent rendered me",
   * which is the only case where the parent's manifest may describe
   * what this component displays. This deliberately reads a runtime
   * fact rather than inferring authorship from source paths: a
   * `data-desde-src` stamp can be inherited through a framework's
   * attribute fallthrough, and definition-file paths are absent on
   * whole substrates (React fibers do not expose one).
   *
   * Returns null when the framework cannot say. Callers must treat
   * null as "unknown", NOT as "not rendered by the parent".
   */
  getRenderOwnerInstance(instance: unknown): unknown | null
  /**
   * The source file the component's definition was compiled from.
   * Vue 3 stores it on `instance.type.__file` (Vite dev only,
   * stripped in published library builds). React 17/18 stores it on
   * `fiber._debugSource.fileName` (dev only, populated by the JSX
   * source plugin).
   *
   * Returns null when the file is unknown (production library
   * bundle, framework wrapper, anonymous component). The library
   * check uses null OR `node_modules` substring; the callsite-file
   * walk uses null to mean "treat as library, can't be the host
   * frame."
   */
  getInstanceFile(instance: unknown): string | null
  /**
   * Per-iteration key for `instance` when its owning template
   * rendered it inside a `v-for` / `.map` / `each`. Frameworks
   * record this for reconciliation; the inspector surfaces it to
   * the disambiguation UI ("which row of the iteration is this?")
   * and the LLM patch prompt. Returns null when the instance isn't
   * iterated or the framework didn't record a key.
   */
  getInstanceIterationKey(instance: unknown): string | number | null
  /**
   * Read the props the CONSUMER passed at the instance's call site,
   * along with which prop names were bound (`:prop="expr"`) vs.
   * literal (`prop="value"`). Used by the new manifest-first
   * attribution pipeline (see `build-attribution-context.ts`) to
   * populate `ConsumerPropValue` entries — literals route to
   * `direct` edits, bindings route to `cross-file` (when the
   * binding source is captured) or `llm` (otherwise).
   *
   * Distinct from {@link readDeclaredProps}: that returns the
   * RESOLVED props on `instance.props` (post `withDefaults`, after
   * reactive unwrap). `readConsumerVnodeProps` returns the props on
   * `instance.vnode.props` — what the consumer's template literally
   * passed at the `<Tag>` site, including Vue's `dynamicProps`
   * marker that distinguishes bound vs. literal.
   *
   * Returns null when the instance has no consumer vnode (root
   * component, synthetic Suspense boundary, hydration placeholder).
   */
  readConsumerVnodeProps(instance: unknown): {
    /**
     * Map of prop name to its CURRENT VALUE at the consumer's call
     * site. For literals, this is the literal value. For bindings,
     * this is the resolved value (the binding's current `.value`).
     * Vue/React internals (`__*`, event listeners, `key`/`ref`,
     * `data-desde-*`) are filtered out before return.
     */
    props: Record<string, unknown>
    /**
     * Set of prop names from `props` that came from bindings
     * (`:prop="expr"`) rather than literals. Vue 3 exposes this
     * via `vnode.dynamicProps`; React exposes it indirectly via
     * fiber `pendingProps` referential identity tracking. When the
     * framework can't distinguish, return an empty set and the
     * pure attribution classifier treats everything as literal —
     * which is correct for static templates but may misclassify
     * bound props in dynamic ones.
     */
    boundPropNames: Set<string>
    /**
     * Raw `data-desde-bind:<prop>` compile stamps the source-tag plugin
     * (Phase 2c) emitted for bound props on the consumer's tag, keyed
     * by prop name. The stamp value encodes the bound expression's
     * source loc AND its text — see `editor-cli/src/plugins/
     * source-tag-plugin.ts` for the
     * `"<file>:<line>:<col> <base64(expr)>"` encoding. Absent (or an
     * empty object) when no plugin ran or the binding was a shape the
     * plugin skips (v-model, spread, dynamic key, event handler), in
     * which case attribution routes the binding to LLM. Consumed by
     * `build-attribution-context.ts` to populate
     * `ConsumerPropValue.bindingLoc` + `expression`, which lets a
     * binding-to-simple-identifier route `cross-file: ref` instead.
     */
    boundPropStamps?: Record<string, string>
  } | null
}

export interface LeafPropAttribution {
  propName: string
  editTarget: { file: string; line: number; column: number }
  rawValue: string
  valueType: "string" | "number" | "boolean"
  stampRaw: string
}

/**
 * Attribute a rendered text leaf back to a library component's prop
 * name + the consumer's call-site location. See module header for
 * the broader rationale.
 *
 * Returns null when:
 *   - The element isn't tracked by the framework.
 *   - The owning instance isn't a library component (slot-text path
 *     handles user-authored slot text correctly).
 *   - The leaf is slot/children content authored by the caller
 *     (`wasRenderedByInstanceTemplate` returns false).
 *   - No consumer call-site stamp on the instance.
 *   - The call-site stamp is malformed or points into `node_modules`.
 *   - Zero or 2+ static props match the leaf text (ambiguous — fall
 *     back to slot-text + server-side disambiguation).
 */
export function resolveLeafChildPropAttribution(
  leafEl: Element,
  trimmedText: string,
  adapter: FrameworkRuntimeAdapter,
): LeafPropAttribution | null {
  const instance = adapter.getOwningInstance(leafEl)
  if (!instance) return null
  if (!adapter.isLibraryInstance(instance)) return null
  if (!adapter.wasRenderedByInstanceTemplate(leafEl, instance)) return null

  const stampRaw = adapter.getCallSiteStamp(instance)
  if (!stampRaw) return null
  const editTarget = parseSourceTag(stampRaw)
  if (!editTarget) return null
  // Defense in depth: call-site must live in user-authored code.
  // Library re-renders carry stamps from their own templates and
  // aren't editable.
  if (editTarget.file.split("/").includes("node_modules")) return null

  const declaredProps = adapter.readDeclaredProps(instance)
  const matches: Array<{
    propName: string
    rawValue: string
    valueType: "string" | "number" | "boolean"
  }> = []
  for (const propName of Object.keys(declaredProps)) {
    const raw = declaredProps[propName]
    let strValue: string | undefined
    let valueType: "string" | "number" | "boolean" = "string"
    if (typeof raw === "string") {
      strValue = raw
      valueType = "string"
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      strValue = String(raw)
      valueType = "number"
    } else if (typeof raw === "boolean") {
      strValue = String(raw)
      valueType = "boolean"
    } else {
      continue
    }
    if (strValue.length === 0) continue
    if (strValue.trim() !== trimmedText) continue
    matches.push({ propName, rawValue: strValue, valueType })
  }
  if (matches.length !== 1) return null
  return {
    propName: matches[0].propName,
    editTarget,
    rawValue: matches[0].rawValue,
    valueType: matches[0].valueType,
    stampRaw,
  }
}

/**
 * Parse a `data-desde-src` value (`"<file>:<line>:<col>"`) into its
 * parts. `<file>` may itself contain colons on exotic paths, so split
 * from the right and take the last two pieces. Returns undefined when
 * malformed.
 *
 * Local copy — `comment-bridge.ts` keeps its own for the other ~5 use
 * sites. They're 10 lines, pure, and shouldn't drift; if either ever
 * needs to change shape, factor to a shared module then.
 */
function parseSourceTag(
  raw: string,
): { file: string; line: number; column: number } | undefined {
  const lastColon = raw.lastIndexOf(":")
  if (lastColon < 0) return undefined
  const secondLastColon = raw.lastIndexOf(":", lastColon - 1)
  if (secondLastColon < 0) return undefined
  const file = raw.slice(0, secondLastColon)
  const line = Number(raw.slice(secondLastColon + 1, lastColon))
  const column = Number(raw.slice(lastColon + 1))
  if (!file || !Number.isFinite(line) || !Number.isFinite(column)) {
    return undefined
  }
  return { file, line, column }
}

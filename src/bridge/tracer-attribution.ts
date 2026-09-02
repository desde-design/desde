/**
 * Desde Bridge — vite-plugin-vue-tracer client + iteration-detection
 * FALLBACK path.
 *
 * Extracted from `comment-bridge.ts` (share-readiness Phase 2, second
 * decomposition pass). Mechanical move — no behavior change.
 *
 * ── Off-the-shelf source attribution (vite-plugin-vue-tracer) ────────────
 *
 * Editor injects antfu's `vite-plugin-vue-tracer` into the supervised
 * Vite (editor-cli/src/plugins/tracer-plugin.ts) and exposes its client
 * API on `window.__DESDE_TRACER__`. The tracer records each vnode's
 * authored `[file, line, column]` (0-based column, 1-based line) into a
 * realm-global store keyed by `vnode.props` identity, and resolves it back
 * from a DOM element (`el.__vnode`) or a vnode.
 *
 * This is the AUTHORITATIVE source of element→source attribution when
 * present — it replaces the need for any DOM-attribute stamping in the
 * prototype. `data-desde-src` (editor's own sourceTagPlugin, or a prototype's
 * bespoke plugin) remains a graceful fallback so substrates without the
 * tracer keep working unchanged.
 *
 * We normalize the tracer's 0-based column to the 1-based `data-desde-src`
 * convention (`<file>:<line>:<col>`) so every downstream consumer —
 * parseSourceTag, the edit service, stamp string-equality walks — is
 * unchanged. (Validated by an `applyPropEdit` round-trip: raw 0-based column
 * mis-targets; +1 lands exactly.)
 *
 * CRITICAL: the tracer global (`window.__DESDE_TRACER__`) is read
 * LAZILY, per call — the client module is a deferred `<script type=module>`,
 * so it may not be present on the very first synchronous frame. `tracer`
 * below re-reads on every access (a getter, not a cached reference); NEVER
 * cache the client at module-import time.
 */
import type { Attribution } from "./bridge-types"
import type { FrameworkRuntimeAdapter } from "./leaf-prop-attribution"

interface TracerTraceInfo {
  pos?: [string, number, number]
  vnode?: unknown
  el?: Element
  getElementsSamePosition?: () => Element[] | undefined
}

interface TracerClient {
  findTraceFromElement(el?: Element | null): TracerTraceInfo | undefined
  findTraceFromVNode(vnode?: unknown, el?: Element): TracerTraceInfo | undefined
}

type SourceLoc = { file: string; line: number; column: number }

export const tracer = {
  /** Live read — the client module is a deferred `<script type=module>`, so
   *  it may not be present on the very first synchronous frame. Re-read each
   *  call; attribution only runs on user interaction, long after load. */
  get client(): TracerClient | null {
    const c = (window as unknown as Record<string, unknown>).__DESDE_TRACER__
    return c && typeof (c as TracerClient).findTraceFromElement === "function"
      ? (c as TracerClient)
      : null
  },
  locFromInfo(info: TracerTraceInfo | undefined): SourceLoc | null {
    const pos = info?.pos
    if (!pos || typeof pos[0] !== "string" || !pos[0]) return null
    // The tracer emits paths relative to `process.cwd()`, and since
    // 2026-08-08 editor-cli chdirs to the prototype's VITE root before
    // constructing the plugin — so these are Vite-root relative. Everything
    // downstream (`data-desde-src`, the edit service) speaks REPO-root relative,
    // so prepend the editor-published offset. It is empty for a normal
    // single-package repo and `<subdir>/` when the prototype is a package
    // inside a larger repo.
    //
    // This replaced a STRIP of a `../../…` prefix, which is what the tracer
    // produced back when cwd was the launch directory. Both directions
    // resolve a real file, so getting it wrong points attribution at the
    // WRONG file silently — see tracer-path-prefix.test.ts.
    // ALWAYS prepend — never conditionally on `startsWith(prefix)`.
    //
    // That guard was here until 2026-08-09 and was wrong (codex review). The
    // tracer's output is unconditionally Vite-root relative, so a path that
    // merely BEGINS with the same text as the offset is not already
    // repo-relative. With `viteRoot = <repo>/app` (prefix `app/`), a
    // component at `<repo>/app/app/Foo.vue` is emitted as `app/Foo.vue`; the
    // guard saw the `app/` and skipped, resolving to `<repo>/app/Foo.vue` —
    // a different file, which may well exist, so the edit lands silently in
    // the wrong place. Double-prefixing is not a risk the guard was needed
    // for: the input is never already prefixed.
    const prefix = (window as unknown as Record<string, unknown>)
      .__DESDE_TRACER_PATH_PREFIX__
    let file = pos[0]
    if (typeof prefix === "string" && prefix) {
      file = prefix + file
    }
    // 0-based tracer column → 1-based `data-desde-src` convention.
    return { file, line: Number(pos[1]), column: Number(pos[2]) + 1 }
  },
  locFromVNode(vnode: unknown): SourceLoc | null {
    const c = this.client
    if (!c || vnode == null) return null
    try {
      return this.locFromInfo(c.findTraceFromVNode(vnode))
    } catch {
      return null
    }
  },
  locFromElement(el: Element): SourceLoc | null {
    const c = this.client
    if (!c) return null
    try {
      return this.locFromInfo(c.findTraceFromElement(el))
    } catch {
      return null
    }
  },
  /** `"<file>:<line>:<col>"` — same shape as a `data-desde-src` value, so it
   *  drops into the stamp string-equality walks (editableComponent,
   *  detectIteration) without changing their logic. */
  stamp(loc: SourceLoc | null): string | null {
    return loc ? `${loc.file}:${loc.line}:${loc.column}` : null
  },
}

// Tracer FALLBACK for iteration detection, used only when no `data-desde-src`
// is present (zero-config substrates). Elements sharing `el.__vnode`'s
// recorded position are loop siblings. Restricted to NON-component-roots:
// for a component root the tracer reports the component's INTERNAL root line,
// which every instance shares regardless of callsite, so unrelated
// `<MyRow v-for>`s (or a loop plus a standalone) would merge into one bogus
// sibling set (codex P1). Positional index is the documented key fallback.
export function detectIterationViaTracer(
  el: Element,
  leafInst: unknown | null | undefined,
  frameworkAdapter: FrameworkRuntimeAdapter,
): Attribution["iteration"] {
  const elIsComponentRoot =
    !!leafInst && frameworkAdapter.getInstanceMountRoot(leafInst) === el
  const client = tracer.client
  if (!client || elIsComponentRoot) return undefined
  try {
    const info = client.findTraceFromElement(el)
    const others = info?.getElementsSamePosition?.()
    if (info && others && others.length > 0) {
      const siblings = [el, ...others].filter((e): e is Element => !!e)
      siblings.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      const index = siblings.indexOf(el)
      if (index >= 0 && siblings.length >= 2) {
        return { source: "v-for", key: index, index, siblingCount: siblings.length, expression: null }
      }
    }
  } catch {
    // No iteration detectable.
  }
  return undefined
}

export function detectIteration(
  el: Element,
  leafInst: unknown | null | undefined,
  frameworkAdapter: FrameworkRuntimeAdapter,
): Attribution["iteration"] {
  // PRIMARY: `data-desde-src` grouping (editor's injected source-tag plugin) —
  // precise, callsite-based. FALLBACK: the tracer, whenever the stamp path
  // yields no iteration (no stamp, OR an unusable owner — incomplete stamping,
  // single match, cross-instance leak). The fallback is safe: it's native-only
  // and excludes component roots, so it can't reintroduce the coarse-position
  // over-grouping (codex review-1 P1). (codex review-2 P1.)
  return (
    detectIterationViaStamp(el, leafInst, frameworkAdapter) ??
    detectIterationViaTracer(el, leafInst, frameworkAdapter)
  )
}

export function detectIterationViaStamp(
  el: Element,
  leafInst: unknown | null | undefined,
  frameworkAdapter: FrameworkRuntimeAdapter,
): Attribution["iteration"] {
  let owner: Element | null = el
  while (owner) {
    if ((owner as HTMLElement).dataset?.desdeSrc) break
    owner = owner.parentElement
  }
  if (!owner) return undefined
  // Same-instance guard: owner's data-desde-src must have been stamped
  // by the leaf's authoring component. Without this, slotted
  // siblings (KInput + KMultiselect inside an EntityFormBlock slot)
  // all walk up to the same wrapper stamp and get falsely
  // classified as v-for siblings. The framework-neutral check is
  // `getOwningInstance(owner) === leafInst`.
  const ownerInst = frameworkAdapter.getOwningInstance(owner)
  if (leafInst && ownerInst && leafInst !== ownerInst) return undefined
  const rawSrc = (owner as HTMLElement).dataset!.desdeSrc!
  let matches: NodeListOf<Element>
  try {
    const escaped = rawSrc.replace(/"/g, '\\"')
    // Scoped to a component instance's mount root rather than the document —
    // but to the NEAREST ANCESTOR THAT ACTUALLY CONTAINS THE REPEATS, not
    // simply to the owning component.
    //
    // Two shapes pull in opposite directions, and each breaks the other's
    // scope. Both are MEASURED on the fixtures (2026-08-17):
    //
    //   `<li v-for>` / `items.map(i => <li/>)`  — the repeats are rendered BY
    //     the owning component, so its mount root is right. The DOCUMENT is
    //     wrong: a component mounted twice reports 6 siblings for a 3-entry
    //     array, and `edit-iteration-handler` then refuses to map positions.
    //
    //   `items.map(i => <Wrapper><span/></Wrapper>)` — one wrapper COMPONENT
    //     per iteration. `getOwningInstance` returns that iteration's Wrapper
    //     (`.return` is nesting), whose mount root holds ONE row, so scoping
    //     there finds a single match and drops iterationContext entirely.
    //     Codex round 4 caught this as a regression from the round-3 fix.
    //
    // Widening until the scope holds MORE THAN ONE match satisfies both: the
    // native loop stops at its owning component, and the wrapper loop steps
    // past the per-iteration wrapper to the component that renders them all.
    // Neither ever reaches the shared parent of two separate mounts, because
    // the first scope containing the repeats is inside one mount.
    //
    // The scope must also CONTAIN `owner` — `querySelectorAll` never returns
    // the root it is called on, so a loop on a component's own root element
    // would otherwise be dropped by the very scope chosen for it.
    const selector = `[data-desde-src="${escaped}"]`
    const contains = (list: NodeListOf<Element>): boolean => {
      for (let i = 0; i < list.length; i++) if (list[i] === owner) return true
      return false
    }
    matches = document.querySelectorAll(selector)
    let scopeInst: unknown = ownerInst
    let hops = 0
    while (scopeInst && hops++ < 8) {
      const root = frameworkAdapter.getInstanceMountRoot(scopeInst)
      if (root) {
        const scoped = root.querySelectorAll(selector)
        if (scoped.length > 1 && contains(scoped)) {
          matches = scoped
          break
        }
      }
      scopeInst = frameworkAdapter.getParentInstance(scopeInst)
    }
  } catch {
    return undefined
  }
  if (matches.length < 2) return undefined
  let index = -1
  for (let i = 0; i < matches.length; i++) {
    if (matches[i] === owner) {
      index = i
      break
    }
  }
  if (index < 0) return undefined
  let key: string | number = index
  try {
    // Walk the component chain looking for the instance whose
    // vnode stamp matches `rawSrc` — that's the per-iteration
    // instance whose key we want. React's equivalent: walk
    // `fiber.return` until a fiber with the same source-tag,
    // read `fiber.key`.
    let inst = frameworkAdapter.getOwningInstance(owner)
    while (inst) {
      if (frameworkAdapter.getCallSiteStamp(inst) === rawSrc) {
        const k = frameworkAdapter.getInstanceIterationKey(inst)
        if (k !== null) key = k
        break
      }
      inst = frameworkAdapter.getParentInstance(inst)
    }
  } catch {
    // Best-effort — positional index is a fine fallback.
  }
  return { source: "v-for", key, index, siblingCount: matches.length, expression: null }
}

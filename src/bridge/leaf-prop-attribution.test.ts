/**
 * Unit coverage for `resolveLeafChildPropAttribution`. Adapter is
 * always stubbed — these tests pin the function's pure logic. The
 * Vue-3 adapter impl (live `__vueParentComponent` / `__vnode` reads)
 * lives in `comment-bridge.ts` and is exercised by the Playwright
 * smoke test in `editor-cli/src/__smoke__/`.
 *
 * Each test builds a minimal stub adapter via `makeStubAdapter` and
 * asserts the function's return shape — propName, editTarget, raw
 * value preservation, valueType coercion, single-match refusals,
 * slot-vs-template disambiguation.
 */
import { describe, it, expect } from "vitest"
import {
  resolveLeafChildPropAttribution,
  type FrameworkRuntimeAdapter,
} from "./leaf-prop-attribution"

interface StubOverrides {
  owningInstance?: unknown | null
  isLibrary?: boolean
  callSiteStamp?: string | null
  declaredProps?: Record<string, unknown>
  renderedByOwnTemplate?: boolean
  mountRoot?: Element | null
  parentInstance?: unknown | null
  instanceFile?: string | null
  iterationKey?: string | number | null
}

function makeStubAdapter(overrides: StubOverrides = {}): FrameworkRuntimeAdapter {
  return {
    name: "stub",
    getOwningInstance: () =>
      "owningInstance" in overrides ? overrides.owningInstance! : { __id: "fake" },
    isLibraryInstance: () => overrides.isLibrary ?? true,
    getCallSiteStamp: () =>
      "callSiteStamp" in overrides
        ? overrides.callSiteStamp!
        : "src/views/Foo.vue:10:5",
    readDeclaredProps: () => overrides.declaredProps ?? {},
    wasRenderedByInstanceTemplate: () =>
      overrides.renderedByOwnTemplate ?? true,
    // The methods below aren't reached by
    // `resolveLeafChildPropAttribution` today, but the stub has to
    // satisfy the interface so future migrations of bridge consumers
    // (attributeElement, etc.) into this test file don't require
    // re-stubbing. Codex round-1 P2 #5.
    getInstanceMountRoot: () => overrides.mountRoot ?? null,
    getParentInstance: () =>
      "parentInstance" in overrides ? overrides.parentInstance! : null,
    getInstanceFile: () =>
      "instanceFile" in overrides ? overrides.instanceFile! : null,
    getInstanceIterationKey: () =>
      "iterationKey" in overrides ? overrides.iterationKey! : null,
    // Not reached by resolveLeafChildPropAttribution; stubbed to
    // satisfy the interface so adding new bridge consumers doesn't
    // force re-stubbing here.
    readConsumerVnodeProps: () => null,
  }
}

const fakeEl = {} as Element

describe("resolveLeafChildPropAttribution — happy path", () => {
  it("attributes a leaf to the single matching library prop", () => {
    const adapter = makeStubAdapter({
      declaredProps: {
        title: "Data planes are scalable",
        message: "Other text",
      },
    })
    const result = resolveLeafChildPropAttribution(
      fakeEl,
      "Data planes are scalable",
      adapter,
    )
    expect(result).not.toBeNull()
    expect(result?.propName).toBe("title")
    expect(result?.rawValue).toBe("Data planes are scalable")
    expect(result?.valueType).toBe("string")
    expect(result?.editTarget).toEqual({
      file: "src/views/Foo.vue",
      line: 10,
      column: 5,
    })
    expect(result?.stampRaw).toBe("src/views/Foo.vue:10:5")
  })

  it("matches across leading/trailing whitespace via trimmed compare", () => {
    const adapter = makeStubAdapter({
      declaredProps: { title: "  Hello  " },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result?.propName).toBe("title")
    // Raw value preserved — applicator needs the original whitespace
    // to splice back into source correctly.
    expect(result?.rawValue).toBe("  Hello  ")
  })

  it("coerces numeric prop to valueType=number", () => {
    const adapter = makeStubAdapter({
      declaredProps: { step: 3 },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "3", adapter)
    expect(result?.propName).toBe("step")
    expect(result?.valueType).toBe("number")
    expect(result?.rawValue).toBe("3")
  })

  it("coerces boolean prop to valueType=boolean", () => {
    const adapter = makeStubAdapter({
      declaredProps: { disabled: true },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "true", adapter)
    expect(result?.propName).toBe("disabled")
    expect(result?.valueType).toBe("boolean")
    expect(result?.rawValue).toBe("true")
  })
})

describe("resolveLeafChildPropAttribution — refusal paths", () => {
  it("returns null when no owning instance", () => {
    const adapter = makeStubAdapter({ owningInstance: null })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when instance is user-authored (not a library)", () => {
    // The user-authored case — slot text IS the editable surface and
    // is handled by the legacy slot-text path. The adapter's
    // `isLibraryInstance` is the gate.
    const adapter = makeStubAdapter({
      isLibrary: false,
      declaredProps: { title: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when the leaf is slot content (not template-rendered)", () => {
    // `<Card title="Hello">Hello</Card>` — the inner "Hello" is the
    // consumer's slot fragment, not Card's template rendering its
    // own title prop. `wasRenderedByInstanceTemplate` returning false
    // is the precise signal that single-string-match couldn't
    // otherwise catch.
    const adapter = makeStubAdapter({
      renderedByOwnTemplate: false,
      declaredProps: { title: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when no call-site stamp is available", () => {
    const adapter = makeStubAdapter({
      callSiteStamp: null,
      declaredProps: { title: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when the call-site stamp is malformed", () => {
    const adapter = makeStubAdapter({
      callSiteStamp: "no-colons-here",
      declaredProps: { title: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when the call-site stamp points into node_modules", () => {
    // Defense in depth — library re-renders carry stamps from their
    // own templates and aren't editable.
    const adapter = makeStubAdapter({
      callSiteStamp:
        "node_modules/@some-lib/dist/KEmptyState.vue:42:3",
      declaredProps: { title: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when no prop matches", () => {
    const adapter = makeStubAdapter({
      declaredProps: { title: "Foo", message: "Bar" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("returns null when two props share the value (ambiguous)", () => {
    // Two static props happening to carry the same string is
    // genuinely ambiguous — bail and let the slot-text + server-side
    // inferrer handle disambiguation.
    const adapter = makeStubAdapter({
      declaredProps: { title: "Hello", subtitle: "Hello" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result).toBeNull()
  })

  it("ignores empty-string prop values", () => {
    const adapter = makeStubAdapter({
      declaredProps: { title: "Hello", placeholder: "" },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result?.propName).toBe("title")
  })

  it("ignores non-primitive prop values (objects, arrays, functions)", () => {
    const adapter = makeStubAdapter({
      declaredProps: {
        title: "Hello",
        features: [{ key: "a" }],
        onClick: () => undefined,
        config: { nested: true },
      },
    })
    const result = resolveLeafChildPropAttribution(fakeEl, "Hello", adapter)
    expect(result?.propName).toBe("title")
  })
})

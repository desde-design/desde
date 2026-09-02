/**
 * Smoke tests for the InspectorPanel rendering. Wired against a manifest
 * produced by the REAL normalizer over a neutral raw fixture, so the
 * assertions here also catch regressions in the manifest pipeline that
 * surface as visible UI problems (e.g., a finite-choice prop suddenly
 * showing up as a text input would mean the control classifier broke).
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StyleOrigin } from "@/types/bridge"
import { normalizeComponentMeta } from "@/editor/adapters/component-meta/normalize"
import { UI_BUTTON_RAW } from "@/editor/adapters/component-meta/__fixtures__/ui-button-raw"
import type { ComponentManifest, Selection } from "@/editor/core"
import { useEditorStore } from "@/stores/editor-only"
import { InspectorPanel } from "./inspector-panel"

// The panel fetches style provenance over the iframe on every selection; there is
// no iframe here. Stubbed file-wide (returning `{}` unless a test sets a result),
// which is what the other tests would get from the real hook's no-iframe path.
const provenanceStub = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  calls: [] as string[],
}))
vi.mock("@/hooks/useIframeStyleProvenance", () => {
  // ONE stable function identity, like the real hook's useCallback — a fresh one
  // per render would re-trigger the panel's provenance effect forever.
  const fetchProvenance = async (selector: string) => {
    provenanceStub.calls.push(selector)
    return provenanceStub.result
  }
  return { useIframeStyleProvenance: () => fetchProvenance }
})

function loadManifest(name: string): ComponentManifest {
  return normalizeComponentMeta(UI_BUTTON_RAW, {
    componentName: name,
    framework: "vue3",
    designSystem: "acme-ds",
    extractor: "vue-component-meta",
    importPath: "@acme/design-system",
  })
}

function selectionFor(
  manifest: ComponentManifest,
  currentProps?: Record<string, unknown>,
): Selection {
  return {
    targetId: manifest.id,
    selector: manifest.id,
    componentName: manifest.name,
    ancestry: [],
    currentProps,
  }
}

describe("InspectorPanel", () => {
  it("renders a placeholder when no selection or manifest is provided", () => {
    render(<InspectorPanel selection={null} manifest={null} />)
    expect(
      screen.getByText(/Select a component in the prototype/i),
    ).toBeInTheDocument()
  })

  it("renders the Identity section with the component's name", async () => {
    const manifest = loadManifest("UiButton")
    // The manifest still carries the design-system + framework as data…
    expect(manifest.designSystem).toBe("acme-ds")
    expect(manifest.framework).toBe("vue3")
    render(
      <InspectorPanel selection={selectionFor(manifest)} manifest={manifest} />,
    )
    // …but the identity header renders just the component name. The
    // design-system / framework / "element" badges were intentionally
    // removed from the header in the shadcn + named-type-scale cleanup
    // (they used a banned `text-[10px]`) — see IdentitySection.
    expect(
      screen.getByRole("heading", { name: "UiButton" }),
    ).toBeInTheDocument()
    expect(screen.queryByText("acme-ds")).not.toBeInTheDocument()
    expect(screen.queryByText("vue3")).not.toBeInTheDocument()
  })

  it("renders one prop control per ComponentPropManifest entry", async () => {
    const manifest = loadManifest("UiButton")
    render(
      <InspectorPanel selection={selectionFor(manifest)} manifest={manifest} />,
    )
    expect(
      screen.getByRole("region", { name: "Variants and props" }),
    ).toBeInTheDocument()
    for (const prop of manifest.props) {
      // Prop labels render in sentence case (`appearance` → "Appearance"),
      // via PropControl's `toSentenceCase`.
      const labelText = prop.name.charAt(0).toUpperCase() + prop.name.slice(1)
      expect(
        screen.getByText(labelText, { selector: "label" }),
      ).toBeInTheDocument()
    }
  })

  it("initializes finite-choice controls from selection.currentProps when present (V1.3.1)", async () => {
    const manifest = loadManifest("UiButton")
    const finiteProp = manifest.props.find((p) => p.control.kind === "finite-choice")
    if (!finiteProp || finiteProp.control.kind !== "finite-choice") {
      throw new Error("Expected at least one finite-choice prop on UiButton")
    }
    const options = finiteProp.control.options ?? []
    // Pick a non-default option as the live value so we can distinguish
    // "rendered the manifest default" from "rendered the live value."
    const defaultRaw = finiteProp.defaultValue?.value
    const liveOption = options.find((o) => o.value !== defaultRaw) ?? options[0]
    if (!liveOption) throw new Error("Expected at least one option on the finite-choice prop")
    const liveValue = String(liveOption.value)

    render(
      <InspectorPanel
        selection={selectionFor(manifest, { [finiteProp.name]: liveValue })}
        manifest={manifest}
        onPropEdit={() => {}}
      />,
    )
    // The Radix Select trigger renders the current value as text. Its
    // accessible name comes from the sentence-cased prop label, so match
    // the prop name case-insensitively.
    const trigger = screen.getByLabelText(new RegExp(`^${finiteProp.name}$`, "i"))
    expect(trigger).toHaveTextContent(liveOption.label)
  })

  it("dispatches onPropEdit when a boolean checkbox is toggled (V1.3 interactivity)", async () => {
    const manifest = loadManifest("UiButton")
    const boolProp = manifest.props.find((p) => p.control.kind === "boolean")
    if (!boolProp) {
      throw new Error("Expected at least one boolean prop on UiButton")
    }
    const onPropEdit = vi.fn()
    render(
      <InspectorPanel
        selection={selectionFor(manifest)}
        manifest={manifest}
        onPropEdit={onPropEdit}
      />,
    )
    // The boolean control renders a Radix Switch tied to the prop label
    // (accessible name = the sentence-cased prop label).
    const toggle = screen.getByLabelText(new RegExp(`^${boolProp.name}$`, "i"))
    fireEvent.click(toggle)
    expect(onPropEdit).toHaveBeenCalledTimes(1)
    expect(onPropEdit.mock.calls[0][0]).toBe(boolProp.name)
    expect(typeof onPropEdit.mock.calls[0][1]).toBe("boolean")
  })

  it("renders element-level identity (tag name, no Detach) when selectedAsElement is set", async () => {
    const manifest = loadManifest("UiButton")
    const onDetach = vi.fn()
    // Element-level selection: layers panel selected an internal div inside
    // ProtoCatalogCard. The inspector should show "div" (not the enclosing
    // component name) and must not surface Detach.
    const elementSelection: Selection = {
      targetId: "div.entity-name",
      selector: "div.entity-name",
      tagName: "div",
      selectedAsElement: true,
      editTarget: { file: "/repo/components/ProtoCatalogCard.vue", line: 7, column: 5 },
      ancestry: [
        { targetId: "#card-1", componentName: "ProtoCatalogCard" },
      ],
    }
    render(
      <InspectorPanel
        selection={elementSelection}
        manifest={null}
        onDetach={onDetach}
      />,
    )
    // Identity shows the element's tag, not the enclosing component. The
    // "element" badge and the ancestry chips (which previously surfaced
    // "ProtoCatalogCard") were removed from IdentitySection in the header
    // redesign — so the enclosing component name must not leak here.
    expect(screen.getByRole("heading", { name: "div" })).toBeInTheDocument()
    expect(screen.queryByText(/Detach component/i)).not.toBeInTheDocument()
    expect(screen.queryByText("ProtoCatalogCard")).not.toBeInTheDocument()

    // Component-level selection on the same manifest still shows the
    // component identity — the element/component branch is exclusive.
    const componentSelection: Selection = {
      ...selectionFor(manifest),
      componentFile: "/repo/components/ProtoCatalogCard.vue",
      editTarget: { file: "/repo/Demo.vue", line: 3, column: 5 },
    }
    const { rerender } = render(
      <InspectorPanel
        selection={componentSelection}
        manifest={manifest}
        onDetach={onDetach}
      />,
    )
    expect(screen.getAllByRole("heading", { name: "UiButton" }).length).toBeGreaterThan(0)
    rerender(
      <InspectorPanel
        selection={componentSelection}
        manifest={manifest}
        onDetach={onDetach}
      />,
    )
  })

  it("falls back to a live-values Props section when the component has no manifest", async () => {
    // A library component we haven't onboarded a manifest source for
    // (manifest === null). Without the fallback the inspector would be
    // empty for it. The fallback renders currently-set scalar props from
    // selection.currentProps as editable rows; non-scalars are skipped.
    const onPropEdit = vi.fn()
    const selection: Selection = {
      targetId: "div.some-lib-widget",
      selector: "div.some-lib-widget",
      componentName: "SomeLibWidget",
      ancestry: [],
      currentProps: {
        loading: false,
        rowKey: "id",
        headers: [{ key: "a" }], // non-scalar → skipped
      },
    }
    render(
      <InspectorPanel
        selection={selection}
        manifest={null}
        onPropEdit={onPropEdit}
      />,
    )
    // Scalar props surface as editable rows…
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.getByText("rowKey")).toBeInTheDocument()
    // …the non-scalar one does not (no text control for it yet).
    expect(screen.queryByText("headers")).not.toBeInTheDocument()

    const rowKeyInput = screen.getByLabelText("rowKey") as HTMLInputElement
    expect(rowKeyInput.value).toBe("id")
    fireEvent.change(rowKeyInput, { target: { value: "uuid" } })
    fireEvent.blur(rowKeyInput)
    expect(onPropEdit).toHaveBeenCalledWith("rowKey", "uuid")
  })

  it("shows the Detach action only for prototype-authored components (componentFile outside node_modules)", async () => {
    const manifest = loadManifest("UiButton")
    const onDetach = vi.fn()
    // Detach now lives inside the "Component actions" dropdown
    // (data-testid="component-actions-btn"). With only `onDetach` wired,
    // that menu renders iff Detach is available, so its trigger's
    // presence/absence is a faithful proxy for the gating. Opening the
    // Radix portal menu to click the item is trusted shadcn wiring verified
    // live, not driven in jsdom (see editor-settings-menu.test.tsx).

    // A library component in node_modules → not prototype-authored → no actions menu.
    const libSelection: Selection = {
      ...selectionFor(manifest),
      componentFile: "/repo/node_modules/@acme/design-system/dist/UiButton.vue",
      editTarget: { file: "/repo/Demo.vue", line: 3, column: 5 },
    }
    const { rerender } = render(
      <InspectorPanel
        selection={libSelection}
        manifest={manifest}
        onDetach={onDetach}
      />,
    )
    expect(screen.queryByTestId("component-actions-btn")).not.toBeInTheDocument()
    expect(screen.queryByText(/Detach component/i)).not.toBeInTheDocument()

    // Same component, but its componentFile now points at a prototype-
    // authored file (outside node_modules) → Detach is available → the
    // actions menu appears.
    const userSelection: Selection = {
      ...selectionFor(manifest),
      componentFile: "/repo/components/ProtoCatalogCard.vue",
      editTarget: { file: "/repo/Demo.vue", line: 3, column: 5 },
    }
    rerender(
      <InspectorPanel
        selection={userSelection}
        manifest={manifest}
        onDetach={onDetach}
      />,
    )
    expect(screen.getByTestId("component-actions-btn")).toBeInTheDocument()
  })
})

/**
 * N4 gate — the transient-state provenance explanation must actually MOUNT in the
 * panel. Its component and copy were unit-tested and correct, yet unreachable: it
 * rendered only inside the scope dialog, which `transientRuleApplies` does not
 * open. A test that renders the component directly cannot catch that; this one
 * drives the panel and stubs only the provenance round-trip.
 */
/**
 * The transient-state banner was REMOVED (2026-08-12), after three attempts at
 * wording it that Mo could not read on sight.
 *
 * The situation it warned about is real: with `:hover` live, the swatches show
 * hover values while an edit writes the resting rule, so what you see is not
 * what you change. But a warning nobody can parse does not warn anyone, and it
 * cost a permanent block of prose in the middle of the style sections. If this
 * comes back it needs a form that survives being read once, at a glance.
 */
describe("InspectorPanel — a live transient state adds no banner", () => {
  const hoveredBackground: StyleOrigin = {
    property: "background-color",
    computedValue: "rgb(0, 48, 204)",
    winningRule: {
      selector: ".ui-button.primary[data-v-2f66f2ee]",
      stylesheet: { href: "<style>" },
      declaration: "background-color: var(--acme-color-background-primary)",
      specificity: [0, 2, 0],
    },
    varChain: [],
    transientRuleApplies: { pseudoClass: ":hover" },
  }

  it("renders the style sections and nothing extra", async () => {
    provenanceStub.result = { "background-color": hoveredBackground }
    provenanceStub.calls.length = 0
    const manifest = loadManifest("UiButton")
    render(
      <InspectorPanel
        selection={selectionFor(manifest)}
        manifest={manifest}
        onClassesEdit={() => {}}
      />,
    )
    // Prove the provenance round-trip ran, so absence is not just "nothing
    // rendered yet".
    await waitFor(() => expect(provenanceStub.calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(screen.getByText("State")).toBeInTheDocument()
    expect(screen.queryByTestId("style-transient-notice")).toBeNull()
  })
})

/**
 * F8 gate — the colour swatch and its label must show the colour the element
 * has NOW, not the one it had when it was selected.
 *
 * `Selection.computedStyles` is an `ELEMENT_INSPECTED` snapshot and nothing
 * republishes it after a style edit, so the swatch used to render the pre-edit
 * colour indefinitely. These drive the panel with a stale snapshot plus fresh
 * provenance — the exact live pairing from the rec-4 run (`.org-avatar`: rose
 * when selected, green after the edit) — so the assertions fail against the
 * pre-fix panel, which had no path from provenance to the swatch at all.
 */
describe("InspectorPanel — the colour swatch tracks the live element (F8)", () => {
  /** rgb(255,171,171) infers as `rose-300`; the colour at inspection time. */
  const STALE_SNAPSHOT = { "background-color": "rgb(255, 171, 171)" }
  /** rgb(34,197,94) is `green-500` exactly; the colour after the edit landed. */
  const GREEN = "rgb(34, 197, 94)"

  function settled(computedValue: string): StyleOrigin {
    return {
      property: "background-color",
      computedValue,
      winningRule: {
        selector: ".org-avatar[data-v-4d808a77]",
        stylesheet: { href: "<style>" },
        declaration: `background-color: ${computedValue}`,
        specificity: [0, 2, 0],
      },
      varChain: [],
    }
  }

  /** The same read, but the value is editor's own live-preview shim. */
  function previewShim(computedValue: string): StyleOrigin {
    return {
      ...settled(computedValue),
      inline: { value: computedValue, important: true, fromPreview: true },
    }
  }

  function avatarSelection(): Selection {
    return {
      targetId: "div.org-avatar",
      selector: "div.org-avatar",
      tagName: "div",
      selectedAsElement: true,
      classes: ["org-avatar"],
      computedStyles: STALE_SNAPSHOT,
      ancestry: [],
    }
  }

  async function renderPanel(origins: Record<string, StyleOrigin>) {
    provenanceStub.result = origins
    provenanceStub.calls.length = 0
    render(
      <InspectorPanel
        selection={avatarSelection()}
        manifest={null}
        onClassesEdit={() => {}}
      />,
    )
    return screen.getByLabelText("Background color")
  }

  afterEach(() => {
    useEditorStore.getState().clearVerifications()
  })

  it("shows the re-fetched computed value, not the inspection-time snapshot", async () => {
    const trigger = await renderPanel({ "background-color": settled(GREEN) })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-green-500"))
    expect(trigger).not.toHaveTextContent("bg-rose-300")
  })

  it("still falls back to the snapshot when provenance has no answer", async () => {
    const trigger = await renderPanel({})
    await waitFor(() => expect(provenanceStub.calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(trigger).toHaveTextContent("bg-rose-300")
  })

  /**
   * L1 — the settle refresh must survive a user-paced delay.
   *
   * The first cut polled until `inline.fromPreview` cleared, on a fixed
   * 8 × 250 ms = 2.0 s budget started at EDIT time. The live run held the
   * mutation-disambiguation dialog open ~4.5 s (a normal reading pace) and then
   * pressed Discard: the budget was already spent, the last read was the shim's,
   * nothing re-read, and the swatch sat on the discarded `bg-amber-500` while the
   * element had reverted — a colour that existed nowhere, indefinitely.
   *
   * The wait below deliberately exceeds both that 2.0 s poll budget and the new
   * post-settle schedule's last offset (2.4 s), so nothing already in flight can
   * make this pass for the wrong reason: the ONLY thing that can refresh the row
   * is the settle event fired afterwards.
   */
  it(
    "refreshes when the override resolves after a delay longer than any poll budget",
    async () => {
      // The read lands while the preview shim is up: the swatch honestly shows
      // the green that is on screen, but the value is PROVISIONAL.
      const trigger = await renderPanel({ "background-color": previewShim(GREEN) })
      await waitFor(() => expect(trigger).toHaveTextContent("bg-green-500"))
      await new Promise((resolve) => setTimeout(resolve, 2600))
      expect(trigger).toHaveTextContent("bg-green-500")
      // Discard: the bridge drops the shim and reverts the element. No source
      // was written and no verification runs, so the resolution itself is the
      // only signal — and it is an EVENT, so the delay above cannot consume it.
      provenanceStub.result = { "background-color": settled("rgb(255, 171, 171)") }
      act(() => {
        useEditorStore.getState().notePreviewSettled()
      })
      await waitFor(() => expect(trigger).toHaveTextContent("bg-rose-300"))
    },
    20_000,
  )

  /**
   * L2 — the refresh budget is per EDIT, not per selection.
   *
   * `previewReadsRef` reset only in an effect keyed on `[selector]`, so once a
   * selection's 8 reads were spent every later edit on that same element got
   * zero. Recovery needed a different element and back: re-clicking the
   * already-selected one re-inspects nothing (the bridge no-ops it) and fetches
   * no provenance. Two successive settles on ONE selection must both land.
   */
  it("refreshes on every successive edit to the same selection, with no reselect", async () => {
    const trigger = await renderPanel({ "background-color": settled(GREEN) })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-green-500"))
    // Edit 1 resolves — violet.
    provenanceStub.result = { "background-color": settled("rgb(139, 92, 246)") }
    act(() => {
      useEditorStore.getState().notePreviewSettled()
    })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-violet-500"))
    // Edit 2 resolves on the SAME selection — sky. Nothing was reselected.
    provenanceStub.result = { "background-color": settled("rgb(14, 165, 233)") }
    act(() => {
      useEditorStore.getState().notePreviewSettled()
    })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-sky-500"))
  })

  it("re-reads when a verification settles (the token lane has no shim to poll on)", async () => {
    const trigger = await renderPanel({
      "background-color": settled("rgb(255, 171, 171)"),
    })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-rose-300"))
    const readsBefore = provenanceStub.calls.length
    // A token edit patched a CSS file; the new value only appears post-HMR, and
    // the verifier's completion is what says "the source settled".
    provenanceStub.result = { "background-color": settled(GREEN) }
    act(() => {
      const store = useEditorStore.getState()
      store.beginVerification("token-edit-1", 'background-color = "#22c55e"', Date.now())
      store.completeVerification("token-edit-1", {
        editId: "token-edit-1",
        status: "pass",
        expectedValue: "#22c55e",
        escalatable: false,
        detail: "Verified",
        durationMs: 12,
      })
    })
    await waitFor(() => expect(trigger).toHaveTextContent("bg-green-500"))
    expect(provenanceStub.calls.length).toBeGreaterThan(readsBefore)
  })
})

/**
 * The DOM section's text inputs.
 *
 * Every case here is a bug Mo hit while daily-driving on 2026-08-14: an error
 * quoting half a word, the panel flickering under the caret, and a field that
 * vanished the moment its text was deleted so there was nothing left to paste
 * into. All three came from committing a source edit on every keystroke.
 */
describe("InspectorPanel — DOM text fields", () => {
  function textSelection(value = "Save changes"): Selection {
    return {
      targetId: "t1",
      selector: ".btn",
      ancestry: [],
      classes: ["btn", "btn-primary"],
      editableTexts: [{ id: "f1", label: "Text", value, kind: "dom-text" }],
    } as unknown as Selection
  }

  it("does not dispatch while the user is typing", () => {
    const onEditTextField = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "S" } })
    fireEvent.change(input, { target: { value: "Sa" } })
    fireEvent.change(input, { target: { value: "Sav" } })

    // The old code sent three edits here. The second carried a `before` the
    // first had already overwritten, which is the "text didn't match" report.
    expect(onEditTextField).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe("Sav")
  })

  it("dispatches once on blur, with the final value", () => {
    const onEditTextField = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "Save it" } })
    fireEvent.blur(input)

    expect(onEditTextField).toHaveBeenCalledTimes(1)
    expect(onEditTextField.mock.calls[0][1]).toBe("Save it")
  })

  it("dispatches on Enter", () => {
    const onEditTextField = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "Done" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onEditTextField).toHaveBeenCalledTimes(1)
    expect(onEditTextField.mock.calls[0][1]).toBe("Done")
  })

  it("reverts on Escape and dispatches nothing", () => {
    const onEditTextField = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "oops" } })
    fireEvent.keyDown(input, { key: "Escape" })

    expect((input as HTMLInputElement).value).toBe("Save changes")
    expect(onEditTextField).not.toHaveBeenCalled()
  })

  it("does not dispatch when the value is unchanged", () => {
    const onEditTextField = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    fireEvent.blur(screen.getByTestId("dom-text-f1"))
    expect(onEditTextField).not.toHaveBeenCalled()
  })

  it("keeps the field after its text is cleared, so a new value can be pasted", () => {
    const onEditTextField = vi.fn()
    const { rerender } = render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(onEditTextField).toHaveBeenCalledWith(expect.anything(), "")

    // The write lands and the bridge re-inspects. With no rendered text there
    // is no editable field to report, which used to delete the row and leave
    // nowhere to paste. Same element, so the input must survive.
    rerender(
      <InspectorPanel
        selection={{ ...textSelection(), editableTexts: [] } as unknown as Selection}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const stillThere = screen.getByTestId("dom-text-f1")
    fireEvent.change(stillThere, { target: { value: "Pasted" } })
    fireEvent.blur(stillThere)
    expect(onEditTextField).toHaveBeenLastCalledWith(expect.anything(), "Pasted")
  })

  it("does not overwrite an in-progress edit when the bridge re-emits", () => {
    const onEditTextField = vi.fn()
    const { rerender } = render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    const input = screen.getByTestId("dom-text-f1")
    fireEvent.change(input, { target: { value: "half typed" } })

    // An unrelated ELEMENT_INSPECTED arrives mid-edit. Re-syncing here is what
    // snapped the value back and bounced the caret to the end.
    rerender(
      <InspectorPanel
        selection={textSelection("Save changes")}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    expect((screen.getByTestId("dom-text-f1") as HTMLInputElement).value).toBe(
      "half typed",
    )
  })

  it("adopts a fresh bridge value for a field the user is NOT editing", () => {
    const { rerender } = render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={vi.fn()}
      />,
    )
    rerender(
      <InspectorPanel
        selection={textSelection("Committed elsewhere")}
        manifest={null}
        onEditTextField={vi.fn()}
      />,
    )
    expect((screen.getByTestId("dom-text-f1") as HTMLInputElement).value).toBe(
      "Committed elsewhere",
    )
  })

  it("drops an uncommitted edit when a different element is selected", () => {
    const onEditTextField = vi.fn()
    const { rerender } = render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    fireEvent.change(screen.getByTestId("dom-text-f1"), {
      target: { value: "for the old element" },
    })
    rerender(
      <InspectorPanel
        selection={
          { ...textSelection("Other"), targetId: "t2" } as unknown as Selection
        }
        manifest={null}
        onEditTextField={onEditTextField}
      />,
    )
    expect((screen.getByTestId("dom-text-f1") as HTMLInputElement).value).toBe(
      "Other",
    )
    expect(onEditTextField).not.toHaveBeenCalled()
  })

  it("commits classes on blur, not per keystroke", () => {
    const onClassesEdit = vi.fn()
    render(
      <InspectorPanel
        selection={textSelection()}
        manifest={null}
        onClassesEdit={onClassesEdit}
      />,
    )
    const input = screen.getByTestId("dom-classes")
    fireEvent.change(input, { target: { value: "btn btn-primary is-l" } })
    fireEvent.change(input, { target: { value: "btn btn-primary is-large" } })
    expect(onClassesEdit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onClassesEdit).toHaveBeenCalledTimes(1)
    expect(onClassesEdit).toHaveBeenCalledWith(["btn", "btn-primary", "is-large"])
  })
})

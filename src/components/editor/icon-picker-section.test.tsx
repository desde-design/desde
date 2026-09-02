/**
 * Smoke tests for IconPickerSection rendering, search, source switching,
 * and pick dispatch. Driven by synthetic icon-set fixtures rather than
 * a real /api/editor/icon-sets fetch.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { IconManifest } from "@/editor/core"
import type { IconSetData } from "@/hooks/useIconSets"
import { IconPickerSection } from "./icon-picker-section"

interface IconSpec {
  id: string
  displayName?: string
  category?: string
  tags?: string[]
}

function makeIcon(spec: IconSpec, importPath: string): IconManifest {
  return {
    id: spec.id,
    displayName: spec.displayName ?? spec.id,
    category: spec.category,
    tags: spec.tags ?? [],
    ref: { kind: "named-component-import", exportName: spec.id, importPath },
    preview: { kind: "svg", markup: `<svg data-testid="svg-${spec.id}"/>` },
  }
}

function makeSet(opts: {
  id: string
  displayName: string
  packageName: string
  icons: IconSpec[]
}): IconSetData {
  return {
    id: opts.id,
    displayName: opts.displayName,
    framework: "vue3",
    usagePattern: { kind: "named-component-import", packageName: opts.packageName },
    icons: opts.icons.map((i) => makeIcon(i, opts.packageName)),
  }
}

describe("IconPickerSection", () => {
  const acme = makeSet({
    id: "acme-icons",
    displayName: "Acme Icons",
    packageName: "@acme/icons",
    icons: [
      { id: "DataObjectIcon", displayName: "Data object", category: "solid" },
      { id: "AddIcon", displayName: "Add", category: "solid" },
      { id: "TrashIcon", displayName: "Trash", category: "solid", tags: ["delete"] },
      { id: "KeyIcon", displayName: "Key", category: "solid" },
    ],
  })

  it("renders nothing when the selection tag does not match any icon", () => {
    const { container } = render(
      <IconPickerSection
        iconSets={[acme]}
        selectionTag="NotARealIcon"
        onPickIcon={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when no sets are registered", () => {
    const { container } = render(
      <IconPickerSection iconSets={[]} selectionTag="AddIcon" onPickIcon={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the active set's icons when the tag matches", () => {
    render(
      <IconPickerSection
        iconSets={[acme]}
        selectionTag="AddIcon"
        onPickIcon={() => {}}
      />,
    )
    expect(screen.getByText("Acme Icons")).toBeDefined()
    expect(screen.getByLabelText("Data object")).toBeDefined()
    expect(screen.getByLabelText("Add")).toBeDefined()
    expect(screen.getByLabelText("Trash")).toBeDefined()
  })

  it("highlights the currently selected icon with aria-current", () => {
    render(
      <IconPickerSection
        iconSets={[acme]}
        selectionTag="AddIcon"
        onPickIcon={() => {}}
      />,
    )
    const add = screen.getByLabelText("Add")
    expect(add.getAttribute("aria-current")).toBe("true")
    const trash = screen.getByLabelText("Trash")
    expect(trash.getAttribute("aria-current")).toBeNull()
  })

  it("filters icons by displayName, id, category, and tag substrings", () => {
    render(
      <IconPickerSection
        iconSets={[acme]}
        selectionTag="AddIcon"
        onPickIcon={() => {}}
      />,
    )
    const search = screen.getByLabelText("Search icons")
    fireEvent.change(search, { target: { value: "delete" } })

    expect(screen.queryByLabelText("Add")).toBeNull()
    expect(screen.getByLabelText("Trash")).toBeDefined()
  })

  it("invokes onPickIcon with sourceId and the chosen icon", () => {
    const onPick = vi.fn()
    render(
      <IconPickerSection
        iconSets={[acme]}
        selectionTag="AddIcon"
        onPickIcon={onPick}
      />,
    )
    fireEvent.click(screen.getByLabelText("Trash"))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(
      "acme-icons",
      expect.objectContaining({ id: "TrashIcon" }),
    )
  })

  it("shows a source switcher when multiple sets are registered", () => {
    const lucide = makeSet({
      id: "lucide-vue-next",
      displayName: "Lucide",
      packageName: "lucide-vue-next",
      icons: [{ id: "KeyIcon", displayName: "Key" }],
    })

    render(
      <IconPickerSection
        iconSets={[acme, lucide]}
        selectionTag="AddIcon"
        onPickIcon={() => {}}
      />,
    )
    // Both set chips render
    expect(screen.getByRole("radio", { name: "Acme Icons" })).toBeDefined()
    expect(screen.getByRole("radio", { name: "Lucide" })).toBeDefined()
  })

  it("switches the visible icons when the user clicks a different source chip", () => {
    const lucide = makeSet({
      id: "lucide-vue-next",
      displayName: "Lucide",
      packageName: "lucide-vue-next",
      icons: [
        { id: "KeyIcon", displayName: "Key" },
        { id: "BoxIcon", displayName: "Box" },
      ],
    })

    render(
      <IconPickerSection
        iconSets={[acme, lucide]}
        selectionTag="AddIcon"
        onPickIcon={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("radio", { name: "Lucide" }))

    expect(screen.getByLabelText("Key")).toBeDefined()
    expect(screen.getByLabelText("Box")).toBeDefined()
    expect(screen.queryByLabelText("Add")).toBeNull()
  })

  it("truncates large sets and exposes a Show all button", () => {
    const big = makeSet({
      id: "big",
      displayName: "Big",
      packageName: "@big/icons",
      icons: Array.from({ length: 100 }, (_, i) => ({
        id: `Icon${i}`,
        displayName: `Icon ${i}`,
      })),
    })

    render(
      <IconPickerSection
        iconSets={[big]}
        selectionTag="Icon0"
        onPickIcon={() => {}}
      />,
    )

    // Default visible cap is 60; "Show all" exposes the rest.
    expect(screen.getByText(/Showing 60 of 100/)).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(screen.queryByText(/Show all/)).toBeNull()
    expect(screen.getByLabelText("Icon 99")).toBeDefined()
  })
})

/**
 * Tests for `<AddDesignSystem>` — extracted from `design-systems-panel.tsx`
 * (Phase 3 attach/refresh, task 3), re-shaped from tabs into a stepped flow.
 * Covers the source step, that each add callback fires with the parsed value
 * (and clears its own field on a truthy result, mirroring the panel's prior
 * behavior), and that `density` switches the compact sizing classes.
 */

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AddDesignSystem } from "./add-design-system"

const suggestion = (over: Partial<{ package: string; componentCount: number; framework: string }> = {}) => ({
  package: "@acme/ui",
  componentCount: 12,
  framework: "vue3",
  ...over,
})

/** Pick a source and advance — the flow's equivalent of the old tab switch. */
function chooseSource(which: "detected" | "npm" | "repo"): void {
  fireEvent.click(screen.getByTestId(`add-design-system-${which}`))
  fireEvent.click(screen.getByTestId("add-design-system-next"))
}

describe("AddDesignSystem", () => {
  it("opens on the source step, offering all three sources", () => {
    render(
      <AddDesignSystem
        suggestions={[suggestion()]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
      />,
    )
    expect(screen.getByTestId("add-design-system-source")).toBeInTheDocument()
    expect(screen.getByText("Already installed here")).toBeInTheDocument()
    expect(screen.getByText("npm package")).toBeInTheDocument()
    expect(screen.getByText("Git repository")).toBeInTheDocument()
    // Nothing is chosen yet, so there is nothing to advance to.
    expect(screen.getByTestId("add-design-system-next")).toBeDisabled()
  })

  it("disables the detected source when the scan found nothing", () => {
    // Offering a route to an empty list is offering a way out that isn't one.
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
      />,
    )
    expect(screen.getByTestId("add-design-system-detected")).toHaveTextContent(
      "Nothing unregistered found in this prototype.",
    )
    expect(screen.getByRole("radio", { name: /Already installed here/ })).toBeDisabled()
  })

  it("shows a scanning message while loading", () => {
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={true}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
      />,
    )
    chooseSource("detected")
    expect(screen.getByText("Scanning…")).toBeInTheDocument()
  })

  it("fires onAddInstalled with the package, and closes the flow on success", async () => {
    // The resolution has to be truthy: a bare `vi.fn()` returns undefined, and
    // this test would then pass even if installed adds never reached the
    // success path at all.
    const onAddInstalled = vi.fn().mockResolvedValue({ package: "@acme/design-system" })
    const onAdded = vi.fn()
    render(
      <AddDesignSystem
        suggestions={[suggestion({ package: "@acme/design-system" })]}
        loading={false}
        busy={false}
        onAddInstalled={onAddInstalled}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        onAdded={onAdded}
      />,
    )
    chooseSource("detected")
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onAddInstalled).toHaveBeenCalledWith("@acme/design-system")
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
  })

  it("still offers a way off a deep-linked form when the host gave no Cancel", () => {
    // `initialSource="detected"` with nothing detected is an empty, disabled
    // form. Preferring the host's Cancel is right when there is one; with none,
    // the picker beats a dead end.
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="detected"
      />,
    )
    fireEvent.click(screen.getByTestId("add-design-system-back"))
    expect(screen.getByTestId("add-design-system-source")).toBeInTheDocument()
  })

  it("fires onAddNpm with the trimmed spec and clears the field on success", async () => {
    const onAddNpm = vi.fn().mockResolvedValue({ package: "@acme/widgets" })
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={onAddNpm}
        onAddRepo={async () => true}
      />,
    )
    chooseSource("npm")
    const input = screen.getByLabelText("Package")
    fireEvent.change(input, { target: { value: "  @acme/widgets@2.0.0  " } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onAddNpm).toHaveBeenCalledWith("@acme/widgets@2.0.0")
    await screen.findByDisplayValue("")
  })

  it("does not clear the npm field when the add callback resolves falsy", async () => {
    const onAddNpm = vi.fn().mockResolvedValue(null)
    const onAdded = vi.fn()
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={onAddNpm}
        onAddRepo={async () => true}
        onAdded={onAdded}
      />,
    )
    chooseSource("npm")
    const input = screen.getByLabelText("Package")
    fireEvent.change(input, { target: { value: "@acme/widgets" } })
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onAddNpm).toHaveBeenCalledWith("@acme/widgets")
    await Promise.resolve()
    await Promise.resolve()
    expect(input).toHaveValue("@acme/widgets")
    // A failed add must not close the flow: the value is still on screen to fix.
    expect(onAdded).not.toHaveBeenCalled()
  })

  it("fires onAddRepo with parsed url/ref/subdir/allowBuild", () => {
    const onAddRepo = vi.fn()
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={onAddRepo}
      />,
    )
    chooseSource("repo")
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: " https://github.com/acme/ui.git " },
    })
    fireEvent.change(screen.getByLabelText("Branch or tag"), { target: { value: " v3 " } })
    fireEvent.change(screen.getByLabelText("Subdirectory"), { target: { value: " packages/ui " } })
    fireEvent.click(screen.getByLabelText("Allow build")) // untoggle the default-true checkbox
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onAddRepo).toHaveBeenCalledWith({
      url: "https://github.com/acme/ui.git",
      ref: "v3",
      subdir: "packages/ui",
      allowBuild: false,
    })
  })

  it("renders the trust-boundary warning copy for the build checkbox", () => {
    const { container } = render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
      />,
    )
    chooseSource("repo")
    expect(container.textContent).toMatch(/only enable it for\s*repos you trust/)
  })

  it("disables all add controls while busy", () => {
    render(
      <AddDesignSystem
        suggestions={[suggestion()]}
        loading={false}
        busy={true}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="detected"
      />,
    )
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
  })

  it("defaults to the compact 'panel' density sizing", () => {
    const { unmount } = render(
      <AddDesignSystem
        suggestions={[suggestion()]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="detected"
      />,
    )
    // The detected list's Add button gets the compact text-xs override; the
    // npm form's Add button additionally gets an h-7 height override (Button's
    // own `size="sm"` is h-6, so h-7 is a signal unique to the override).
    expect(screen.getByRole("button", { name: "Add" }).className).toContain("text-xs")
    unmount()

    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="npm"
      />,
    )
    expect(screen.getByRole("button", { name: "Add" }).className).toContain("h-7")
  })

  it("honors initialSource + initialNpmSpec (Phase 5 Task 5 drift-row deep link)", () => {
    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="npm"
        initialNpmSpec="@acme/ui"
      />,
    )
    // The deep link answered "where from", so the picker is skipped entirely.
    expect(screen.queryByTestId("add-design-system-source")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Package")).toHaveValue("@acme/ui")
  })

  it("goes back to the picker only when the picker is where it came from", () => {
    // A deep link skipped the picker, so 'back' would land somewhere the user
    // was never at. That case gets the host's Cancel instead.
    const onCancel = vi.fn()
    const { unmount } = render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        initialSource="npm"
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId("add-design-system-back"))
    expect(onCancel).toHaveBeenCalled()
    unmount()

    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        onCancel={onCancel}
      />,
    )
    chooseSource("npm")
    fireEvent.click(screen.getByTestId("add-design-system-back"))
    expect(screen.getByTestId("add-design-system-source")).toBeInTheDocument()
  })

  it("drops the compact sizing overrides under 'launcher' density", () => {
    const { unmount } = render(
      <AddDesignSystem
        suggestions={[suggestion()]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        density="launcher"
        initialSource="detected"
      />,
    )
    expect(screen.getByRole("button", { name: "Add" }).className).not.toContain("text-xs")
    unmount()

    render(
      <AddDesignSystem
        suggestions={[]}
        loading={false}
        busy={false}
        onAddInstalled={async () => true}
        onAddNpm={async () => true}
        onAddRepo={async () => true}
        density="launcher"
        initialSource="npm"
      />,
    )
    expect(screen.getByRole("button", { name: "Add" }).className).not.toContain("h-7")
  })
})

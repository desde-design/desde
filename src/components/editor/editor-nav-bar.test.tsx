import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { EditorNavBar } from "./editor-nav-bar"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { BranchesApi } from "@/hooks/useEditorBranches"

// The nav bar's children each reach into stores and the CLI API. This file is
// about the row itself: its name, its slots, and the fact that the toolbar
// renders inside it. Stub the children so none of that is in scope.
vi.mock("./project-breadcrumb", () => ({
  EditorBreadcrumb: () => <div data-testid="stub-breadcrumb" />,
}))
vi.mock("./editor-settings-menu", () => ({
  EditorSettingsMenu: () => <div data-testid="stub-settings" />,
}))
vi.mock("./branch-mode-controls", () => ({
  BranchModeControls: () => <div data-testid="stub-branch-controls" />,
}))

type EditingApi = ReturnType<typeof useEditorEditing>

const editing = {} as unknown as EditingApi
const branches = {} as unknown as BranchesApi

describe("EditorNavBar", () => {
  // The name is the point of this file. This row had no testid at all while
  // the floating toolbar below it was called "editor-top-bar", so asking for
  // a change to "the toolbar" kept landing here instead.
  it("is named editor-nav-bar in the DOM", () => {
    render(
      <EditorNavBar
        editing={editing}
        branches={branches}
        chatSubmitting={false}
      />,
    )
    expect(screen.getByTestId("editor-nav-bar")).toBeTruthy()
  })

  it("renders the toolbar inside itself, because it is the toolbar's positioning context", () => {
    render(
      <EditorNavBar
        editing={editing}
        branches={branches}
        chatSubmitting={false}
      >
        <div data-testid="stub-toolbar" />
      </EditorNavBar>,
    )
    const navBar = screen.getByTestId("editor-nav-bar")
    expect(navBar.contains(screen.getByTestId("stub-toolbar"))).toBe(true)
  })

  // Undo/Redo moved to the toolbar on 2026-08-14, so that every per-edit
  // control sits in one cluster. Nothing stubs them here any more: if they
  // came back to this row, this assertion would catch it.
  it("no longer carries Undo/Redo", () => {
    render(
      <EditorNavBar
        editing={editing}
        branches={branches}
        chatSubmitting={false}
      />,
    )
    expect(screen.queryByTestId("editor-undo")).toBeNull()
    expect(screen.queryByTestId("editor-redo")).toBeNull()
  })

  // The full-screen button moved to the toolbar's right edge on 2026-09-02.
  it("no longer carries the hide-chrome button", () => {
    render(<EditorNavBar editing={editing} branches={branches} chatSubmitting={false} />)
    expect(screen.queryByTestId("editor-hide-chrome")).toBeNull()
  })
})

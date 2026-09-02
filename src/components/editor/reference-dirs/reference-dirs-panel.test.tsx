/**
 * Tests for `<ReferenceDirsPanel>`. It calls `useReferenceDirs` internally, so
 * the hook module is mocked and each test drives a fixed return value —
 * follows the mocked-hook pattern from `design-systems-panel.test.tsx`
 * (`editor-settings-menu.test.tsx` established it first).
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ReferenceDirView, UseReferenceDirs } from "@/hooks/useReferenceDirs"
import { ReferenceDirsPanel } from "./reference-dirs-panel"

// `mock`-prefixed so vitest's hoisted `vi.mock` factory may reference it.
let mockResponse: UseReferenceDirs

vi.mock("@/hooks/useReferenceDirs", () => ({
  useReferenceDirs: () => mockResponse,
}))

function baseResponse(overrides: Partial<UseReferenceDirs> = {}): UseReferenceDirs {
  return {
    roots: null,
    warnings: [],
    busy: false,
    error: null,
    refresh: vi.fn(async () => {}),
    add: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    inspect: vi.fn(async () => null),
    pick: vi.fn(async () => null),
    pickerSupported: true,
    ...overrides,
  }
}

/** The always-present implicit root, shaped as `loadReadRoots` synthesizes it. */
const worktreeRoot: ReferenceDirView = {
  name: "worktree",
  path: "/Users/designer/prototypes/ai-gateway-prototype",
  description: "The editor worktree (the current editing session).",
  isWorktree: true,
  isGit: true,
}

function declaredRoot(overrides: Partial<ReferenceDirView> = {}): ReferenceDirView {
  return {
    name: "billing-web",
    path: "/Users/designer/code/billing-web",
    description: "Production billing UI, match these table patterns",
    isWorktree: false,
    isGit: true,
    ...overrides,
  }
}

describe("ReferenceDirsPanel — loading and empty states", () => {
  it("renders Loading while roots is null", () => {
    mockResponse = baseResponse({ roots: null })
    render(<ReferenceDirsPanel enabled />)
    expect(screen.getByText("Loading")).toBeInTheDocument()
  })

  it("renders an empty state when only the implicit worktree root exists, and never lists the worktree as removable", () => {
    mockResponse = baseResponse({ roots: [worktreeRoot] })
    render(<ReferenceDirsPanel enabled />)

    expect(screen.getByText("No reference folders")).toBeInTheDocument()
    expect(screen.queryByTestId("reference-dirs-list")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Remove worktree")).not.toBeInTheDocument()
  })
})

describe("ReferenceDirsPanel — declared roots list", () => {
  it("lists declared roots with name, path and description", () => {
    mockResponse = baseResponse({ roots: [worktreeRoot, declaredRoot()] })
    render(<ReferenceDirsPanel enabled />)

    const list = screen.getByTestId("reference-dirs-list")
    expect(list).toBeInTheDocument()
    expect(screen.getByText("billing-web")).toBeInTheDocument()
    expect(screen.getByText("/Users/designer/code/billing-web")).toBeInTheDocument()
    expect(
      screen.getByText("Production billing UI, match these table patterns"),
    ).toBeInTheDocument()
  })

  it("shows 'No history' next to a root whose isGit is false, and not for a git one", () => {
    mockResponse = baseResponse({
      roots: [
        worktreeRoot,
        declaredRoot({ name: "billing-web", isGit: true }),
        declaredRoot({
          name: "design-notes",
          path: "/Users/designer/notes",
          description: undefined,
          isGit: false,
        }),
      ],
    })
    render(<ReferenceDirsPanel enabled />)

    expect(screen.getAllByText("No history")).toHaveLength(1)
  })

  it("calls remove with that root's name when its remove button is clicked", () => {
    const remove = vi.fn(async () => true)
    mockResponse = baseResponse({
      roots: [worktreeRoot, declaredRoot({ name: "billing-web" })],
      remove,
    })
    render(<ReferenceDirsPanel enabled />)

    // Remove moved behind the row menu when this list took the design-system
    // shape. Radix opens on pointerDown, not click.
    fireEvent.pointerDown(
      screen.getByTestId("reference-dir-row-menu-billing-web"),
      { button: 0, ctrlKey: false },
    )
    fireEvent.click(screen.getByText("Remove"))
    expect(remove).toHaveBeenCalledWith("billing-web")
  })
})

describe("ReferenceDirsPanel — warnings and errors", () => {
  it("renders reference-dirs-warnings when the hook reports warnings", () => {
    mockResponse = baseResponse({
      roots: [worktreeRoot],
      warnings: ["billing-web no longer resolves and was skipped."],
    })
    render(<ReferenceDirsPanel enabled />)

    expect(screen.getByTestId("reference-dirs-warnings")).toHaveTextContent(
      "billing-web no longer resolves and was skipped.",
    )
  })

  it("renders the hook's error with role=\"alert\"", () => {
    mockResponse = baseResponse({
      roots: [worktreeRoot],
      error: "Couldn't load the reference directories.",
    })
    render(<ReferenceDirsPanel enabled />)

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load the reference directories.",
    )
  })
})

describe("ReferenceDirsPanel — feeds takenNames into the add form", () => {
  it("passes existing root names as takenNames, so typing a duplicate shows the name-taken error", () => {
    mockResponse = baseResponse({
      roots: [worktreeRoot, declaredRoot({ name: "billing-web" })],
    })
    render(<ReferenceDirsPanel enabled />)

    // The add form lives in a modal now, not under the list.
    fireEvent.click(screen.getByTestId("reference-dir-add-open"))

    fireEvent.change(screen.getByTestId("reference-dir-path"), {
      target: { value: "/some/other/path" },
    })
    fireEvent.change(screen.getByTestId("reference-dir-name"), {
      target: { value: "billing-web" },
    })

    expect(
      screen.getByText("That name is already used by another reference directory."),
    ).toBeInTheDocument()
    expect(screen.getByTestId("reference-dir-add")).toBeDisabled()
  })
})

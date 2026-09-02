/**
 * EditorBreadcrumb composes home → project → branch. The child menus
 * (ProjectMenu / BranchMenu) and the home-navigation util are mocked so
 * these tests exercise only the breadcrumb's own composition: the home
 * affordance and the branch segment.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { BranchesApi } from "@/hooks/useEditorBranches"

const goToEditorHome = vi.fn(async () => {})
vi.mock("@/lib/editor-home", () => ({
  goToEditorHome: () => goToEditorHome(),
}))
vi.mock("./project-menu", () => ({
  ProjectMenu: () => <div data-testid="stub-project-menu" />,
}))
vi.mock("./branch-menu", () => ({
  BranchMenu: () => <div data-testid="stub-branch-menu" />,
}))

import { EditorBreadcrumb } from "./project-breadcrumb"

const branches = (): BranchesApi => ({}) as unknown as BranchesApi

afterEach(() => {
  cleanup()
  goToEditorHome.mockClear()
})

describe("EditorBreadcrumb", () => {
  it("renders the home affordance and the project segment", () => {
    render(<EditorBreadcrumb branches={branches()} />)
    expect(screen.getByTestId("breadcrumb-home")).toBeInTheDocument()
    expect(screen.getByTestId("stub-project-menu")).toBeInTheDocument()
  })

  it("navigates home when the home icon is clicked", async () => {
    render(<EditorBreadcrumb branches={branches()} />)
    fireEvent.click(screen.getByTestId("breadcrumb-home"))
    await waitFor(() => expect(goToEditorHome).toHaveBeenCalledTimes(1))
  })

  it("always shows the branch segment (branch mode is the only substrate)", () => {
    render(<EditorBreadcrumb branches={branches()} />)
    expect(screen.getByTestId("stub-branch-menu")).toBeInTheDocument()
  })
})

import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

// Radix DropdownMenu doesn't open under jsdom's fireEvent (needs pointer
// events) and portals its content — same faithful inline swap the
// branch-mode-controls tests use. The dialog under test is real.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    [key: string]: unknown
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      {...rest}
    >
      {children}
    </div>
  ),
}))

import { BranchMenu } from "./branch-menu"
import type { BranchesApi } from "@/hooks/useEditorBranches"

function makeBranches(overrides: Partial<BranchesApi> = {}): BranchesApi {
  return {
    branches: [
      { name: "main", current: false, isDefault: true },
      { name: "feat/x", current: true, isDefault: false },
    ],
    current: "feat/x",
    defaultBranch: "main",
    dirty: false,
    changes: [],
    ahead: 1,
    behind: 0,
    hasRemote: true,
    unpushed: false,
    loading: false,
    error: null,
    refresh: vi.fn(),
    switchBranch: vi.fn().mockResolvedValue({ ok: true }),
    createBranch: vi.fn().mockResolvedValue({ ok: true }),
    renameBranch: vi.fn().mockResolvedValue({ ok: true }),
    publishBranch: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as BranchesApi
}

describe("BranchMenu — publish conflict", () => {
  beforeEach(() => vi.clearAllMocks())

  it("names the conflicted files as a mono list inside the publish dialog", async () => {
    const branches = makeBranches({
      publishBranch: vi.fn().mockResolvedValue({
        ok: false,
        reason:
          "Publishing 'feat/x' conflicts with 'main'. Update this branch from 'main', resolve the conflicts, then publish again.",
        conflictFiles: ["src/App.vue", "src/pages/Pricing.vue"],
      }),
    })
    render(<BranchMenu branches={branches} />)

    fireEvent.click(screen.getByTestId("branch-publish"))
    // The dialog opens; submit the publish.
    await screen.findByTestId("branch-name-input")
    fireEvent.click(screen.getByRole("button", { name: "Publish" }))

    await waitFor(() =>
      expect(screen.getByTestId("branch-name-error")).toHaveTextContent(
        /conflicts with 'main'/,
      ),
    )
    const list = screen.getByTestId("branch-conflict-files")
    expect(within(list).getByText("src/App.vue")).toBeInTheDocument()
    expect(within(list).getByText("src/pages/Pricing.vue")).toBeInTheDocument()
    expect(within(list).getByText("src/App.vue").className).toContain("font-mono")
  })

  it("renders no file list on a non-conflict failure", async () => {
    const branches = makeBranches({
      publishBranch: vi.fn().mockResolvedValue({
        ok: false,
        reason: "Nothing to publish.",
      }),
    })
    render(<BranchMenu branches={branches} />)
    fireEvent.click(screen.getByTestId("branch-publish"))
    await screen.findByTestId("branch-name-input")
    fireEvent.click(screen.getByRole("button", { name: "Publish" }))

    await waitFor(() =>
      expect(screen.getByTestId("branch-name-error")).toHaveTextContent(
        "Nothing to publish.",
      ),
    )
    expect(screen.queryByTestId("branch-conflict-files")).not.toBeInTheDocument()
  })
})

import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

// sonner's toast is a side effect we don't assert on here.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    // Real sonner has this and the repo uses it in five other places. Its
    // absence here surfaced as an unhandled rejection rather than a failure,
    // which is exactly the kind of gap a partial mock hides.
    info: vi.fn(),
  },
}))

// Radix DropdownMenu doesn't open under jsdom's fireEvent (needs pointer
// events) and portals its content. Swap it for a faithful inline version:
// content always rendered, `disabled` → aria-disabled + swallows onSelect.
// The enable/disable logic under test is ours, not Radix's.
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

import { toast } from "sonner"
import { BranchModeControls } from "./branch-mode-controls"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { BranchesApi } from "@/hooks/useEditorBranches"

type EditingApi = ReturnType<typeof useEditorEditing>

function makeEditing(overrides: Partial<EditingApi> = {}): EditingApi {
  return {
    aiQueueCount: 0,
    saving: false,
    handleSaveAll: vi.fn(),
    ...overrides,
  } as unknown as EditingApi
}

function makeBranches(overrides: Partial<BranchesApi> = {}): BranchesApi {
  return {
    branches: [],
    current: "feat/x",
    defaultBranch: "main",
    dirty: false,
    changes: [],
    ahead: 0,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    unpushed: false,
    loading: false,
    error: null,
    refresh: vi.fn(),
    switchBranch: vi.fn(),
    createBranch: vi.fn(),
    renameBranch: vi.fn(),
    publishBranch: vi.fn().mockResolvedValue({ ok: true }),
    commitWorkingTree: vi.fn().mockResolvedValue({ ok: true }),
    pushBranch: vi.fn().mockResolvedValue({ ok: true }),
    fetchRemote: vi.fn().mockResolvedValue(undefined),
    updateFromDefault: vi.fn().mockResolvedValue({ ok: true }),
    pullRemote: vi.fn().mockResolvedValue({ ok: true }),
    mergeAndPush: vi.fn().mockResolvedValue({ ok: true, pushed: true }),
    preflightPullRequest: vi.fn().mockResolvedValue({
      ok: true,
      target: {
        repoRef: "acme/proto",
        nameWithOwner: "acme/proto",
        base: "main",
        head: "feat/x",
        crossRepo: false,
        existing: null,
        suggestedTitle: "X",
      },
    }),
    createPullRequest: vi.fn().mockResolvedValue({
      ok: true,
      url: "https://github.com/acme/proto/pull/1",
    }),
    ...overrides,
  } as unknown as BranchesApi
}

function openMenu() {
  fireEvent.click(screen.getByTestId("branch-merge-menu"))
}

describe("BranchModeControls", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the Apply-with-AI button when the LLM queue is non-empty", () => {
    render(
      <BranchModeControls
        editing={makeEditing({ aiQueueCount: 3 })}
        branches={makeBranches()}
      />,
    )
    expect(screen.getByTestId("branch-apply-ai")).toHaveTextContent(
      "Apply 3 with AI",
    )
    expect(screen.queryByTestId("branch-merge-menu")).not.toBeInTheDocument()
  })

  it("Commit is disabled and unnumbered on a clean tree", () => {
    render(
      <BranchModeControls editing={makeEditing()} branches={makeBranches()} />,
    )
    const commit = screen.getByTestId("branch-commit")
    expect(commit).toBeDisabled()
    expect(commit).toHaveTextContent("Commit")
    expect(commit).not.toHaveTextContent("(")
  })

  it("Commit shows the changed-file count when dirty", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({
          dirty: true,
          changes: [
            { path: "a.vue", status: "modified" },
            { path: "b.txt", status: "added" },
          ],
        })}
      />,
    )
    expect(screen.getByTestId("branch-commit")).toHaveTextContent("Commit (2)")
  })

  it("disables all remote actions when there is no origin remote", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ hasRemote: false, dirty: true, ahead: 1 })}
      />,
    )
    openMenu()
    expect(screen.getByTestId("branch-push")).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.getByTestId("branch-merge-push")).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    // Local merge does NOT need a remote — it stays enabled.
    expect(screen.getByTestId("branch-merge-local")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(
      within(screen.getByTestId("branch-push")).getByText(
        "No GitHub remote configured",
      ),
    ).toBeInTheDocument()
  })

  it("disables merge actions on the default branch", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({
          current: "main",
          defaultBranch: "main",
          dirty: true,
        })}
      />,
    )
    openMenu()
    expect(screen.getByTestId("branch-merge-local")).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(screen.getByTestId("branch-merge-push")).toHaveAttribute(
      "aria-disabled",
      "true",
    )
    expect(
      within(screen.getByTestId("branch-merge-local")).getByText(
        "You're on main",
      ),
    ).toBeInTheDocument()
  })

  it("enables Push when there is unpushed work and calls pushBranch", () => {
    const branches = makeBranches({ unpushed: true })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    const push = screen.getByTestId("branch-push")
    expect(push).not.toHaveAttribute("aria-disabled", "true")
    fireEvent.click(push)
    expect(branches.pushBranch).toHaveBeenCalledTimes(1)
  })

  it("opens the merge-&-push dialog with GitHub-updating copy", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ ahead: 1 })}
      />,
    )
    openMenu()
    fireEvent.click(screen.getByTestId("branch-merge-push"))
    // The dialog is distinguishable from the menu item by its unique
    // confirm button + message input.
    expect(screen.getByTestId("branch-message-input")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Merge & push" }),
    ).toBeInTheDocument()
  })

  it("offers Open pull request on a branch with a remote", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ dirty: true, ahead: 1 })}
      />,
    )
    openMenu()
    const pr = screen.getByTestId("branch-open-pr")
    expect(pr).not.toHaveAttribute("aria-disabled", "true")
    // The old copy promised a GitHub sign-in that is deliberately never coming.
    expect(pr).not.toHaveTextContent("coming soon")
  })

  it.each([
    ["on the default branch", { current: "main" }, /Switch to another branch/],
    ["with no origin remote", { hasRemote: false }, /no origin remote/],
  ])("disables Open pull request %s and says why", (_label, overrides, copy) => {
    render(
      <BranchModeControls editing={makeEditing()} branches={makeBranches(overrides)} />,
    )
    openMenu()
    const pr = screen.getByTestId("branch-open-pr")
    expect(pr).toHaveAttribute("aria-disabled", "true")
    expect(pr).toHaveTextContent(copy)
  })

  it("resolves the destination before opening the dialog, and shows it", async () => {
    const branches = makeBranches({ dirty: true, ahead: 1 })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-open-pr"))

    // The preflight runs FIRST. The dialog's job is to show where the pull
    // request goes, so it must not appear before there is an answer.
    await waitFor(() => expect(branches.preflightPullRequest).toHaveBeenCalled())
    expect(await screen.findByTestId("pull-request-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("pull-request-target")).toHaveTextContent("acme/proto")
    expect(branches.createPullRequest).not.toHaveBeenCalled()
  })

  it("warns out loud when gh resolved a repo that is not our origin", async () => {
    // THE safety case. A remote named `upstream` outranks `origin` in gh's base
    // repo resolution, which is the ordinary layout of every fork. Without this
    // the user opens a pull request on a stranger's repo and finds out from the
    // URL afterwards.
    const branches = makeBranches({
      dirty: true,
      ahead: 1,
      preflightPullRequest: vi.fn().mockResolvedValue({
        ok: true,
        target: {
          repoRef: "cli/cli",
          nameWithOwner: "cli/cli",
          base: "trunk",
          head: "feat/x",
          crossRepo: true,
          existing: null,
          suggestedTitle: "X",
        },
      }),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-open-pr"))

    const warning = await screen.findByTestId("pull-request-cross-repo")
    expect(warning).toHaveTextContent("cli/cli")
    expect(warning).toHaveAttribute("role", "alert")
  })

  it("creates against the repo it showed, not a re-resolved one", async () => {
    const branches = makeBranches({ dirty: true, ahead: 1 })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-open-pr"))
    await screen.findByTestId("pull-request-dialog")

    fireEvent.click(screen.getByTestId("pull-request-submit"))
    await waitFor(() => expect(branches.createPullRequest).toHaveBeenCalled())
    expect(branches.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ repoRef: "acme/proto", base: "main", head: "feat/x" }),
    )
  })

  it("shows Behind by N on Pull remote changes only when behind > 0", () => {
    const { unmount } = render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ behind: 2 })}
      />,
    )
    openMenu()
    expect(
      within(screen.getByTestId("branch-pull-remote")).getByText(
        "Behind by 2 commits on GitHub",
      ),
    ).toBeInTheDocument()
    unmount()

    render(
      <BranchModeControls editing={makeEditing()} branches={makeBranches()} />,
    )
    openMenu()
    expect(screen.queryByText(/Behind by/)).not.toBeInTheDocument()
  })

  it("Pull remote changes runs pullRemote and cannot double-fire while in flight", async () => {
    let resolvePull: (v: { ok: boolean }) => void = () => {}
    const branches = makeBranches({
      pullRemote: vi.fn().mockImplementation(
        () => new Promise((r) => (resolvePull = r)),
      ),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    const pull = screen.getByTestId("branch-pull-remote")
    fireEvent.click(pull)
    // In flight: the item disables, so a second click is swallowed.
    await waitFor(() =>
      expect(screen.getByTestId("branch-pull-remote")).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    )
    fireEvent.click(screen.getByTestId("branch-pull-remote"))
    resolvePull({ ok: true })
    await waitFor(() => expect(branches.pullRemote).toHaveBeenCalledTimes(1))
  })

  it("disables Update from main on the default branch and says why", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ current: "main" })}
      />,
    )
    openMenu()
    const update = screen.getByTestId("branch-update-default")
    expect(update).toHaveAttribute("aria-disabled", "true")
    expect(within(update).getByText("You're on main")).toBeInTheDocument()
  })

  it("disables Pull remote changes when the branch has no upstream and says why", () => {
    render(
      <BranchModeControls
        editing={makeEditing()}
        branches={makeBranches({ hasUpstream: false })}
      />,
    )
    openMenu()
    const pull = screen.getByTestId("branch-pull-remote")
    expect(pull).toHaveAttribute("aria-disabled", "true")
    expect(pull).toHaveTextContent(/No remote branch to pull from/)
  })

  // Branch mode's contract is that edits stay uncommitted until the user
  // commits them. Both sync actions auto-commit a dirty tree before the
  // merge, so from a dirty tree they must confirm the commit FIRST, not
  // fire silently from the menu.
  it("a dirty tree asks before committing on Update from main, then runs on confirm", async () => {
    const branches = makeBranches({
      dirty: true,
      changes: [{ path: "a.vue", status: "modified" }],
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-update-default"))

    // Nothing ran yet; the dialog says a commit will happen first.
    expect(branches.updateFromDefault).not.toHaveBeenCalled()
    const dialog = await screen.findByTestId("branch-sync-commit-dialog")
    expect(dialog).toHaveTextContent(/will be committed first/i)

    fireEvent.click(screen.getByTestId("branch-sync-commit-confirm"))
    await waitFor(() => expect(branches.updateFromDefault).toHaveBeenCalledTimes(1))
  })

  it("a dirty tree asks before committing on Pull remote changes, and Cancel runs nothing", async () => {
    const branches = makeBranches({
      dirty: true,
      changes: [{ path: "a.vue", status: "modified" }],
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-pull-remote"))

    expect(branches.pullRemote).not.toHaveBeenCalled()
    await screen.findByTestId("branch-sync-commit-dialog")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByTestId("branch-sync-commit-dialog")).not.toBeInTheDocument(),
    )
    expect(branches.pullRemote).not.toHaveBeenCalled()
  })

  it("a clean tree runs Update from main directly, no confirmation", async () => {
    const branches = makeBranches()
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-update-default"))
    await waitFor(() => expect(branches.updateFromDefault).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("branch-sync-commit-dialog")).not.toBeInTheDocument()
  })

  it("says the auto-commit happened when an up-to-date result carried one", async () => {
    const branches = makeBranches({
      updateFromDefault: vi
        .fn()
        .mockResolvedValue({ ok: true, upToDate: true, committedBranch: true }),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-update-default"))
    await waitFor(() => expect(toast.info).toHaveBeenCalled())
    // The old toast said "already has the latest" with no mention of the
    // commit the action just created — the silent-commit finding.
    expect(vi.mocked(toast.info).mock.calls[0][0]).toMatch(/Committed your edits/)
  })

  it("a conflicting update opens the conflict dialog naming the files in mono", async () => {
    const branches = makeBranches({
      updateFromDefault: vi.fn().mockResolvedValue({
        ok: false,
        reason: "Merging 'main' into 'feat/x' hit conflicts. Nothing was changed.",
        conflictFiles: ["src/App.vue", "src/pages/Pricing.vue"],
      }),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-update-default"))

    expect(await screen.findByTestId("branch-conflict-dialog")).toBeInTheDocument()
    const list = screen.getByTestId("branch-conflict-files")
    expect(within(list).getByText("src/App.vue")).toBeInTheDocument()
    expect(within(list).getByText("src/pages/Pricing.vue")).toBeInTheDocument()
    // Paths are code: mono at the mono floor, never a raw git block.
    expect(within(list).getByText("src/App.vue").className).toContain("font-mono")
    expect(within(list).getByText("src/App.vue").className).toContain("text-code")
  })

  it("a conflicting merge names its files inside the merge dialog", async () => {
    const branches = makeBranches({
      ahead: 1,
      publishBranch: vi.fn().mockResolvedValue({
        ok: false,
        reason: "Publishing 'feat/x' conflicts with 'main'.",
        conflictFiles: ["src/App.vue"],
      }),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-merge-local"))
    fireEvent.click(screen.getByRole("button", { name: "Merge" }))

    await waitFor(() =>
      expect(screen.getByTestId("branch-message-error")).toHaveTextContent(
        /conflicts/,
      ),
    )
    expect(
      within(screen.getByTestId("branch-conflict-files")).getByText("src/App.vue"),
    ).toBeInTheDocument()
  })

  it("points at the existing pull request instead of opening a second", async () => {
    const branches = makeBranches({
      dirty: true,
      ahead: 1,
      preflightPullRequest: vi.fn().mockResolvedValue({
        ok: true,
        target: {
          repoRef: "acme/proto",
          nameWithOwner: "acme/proto",
          base: "main",
          head: "feat/x",
          crossRepo: false,
          existing: { number: 7, url: "https://github.com/acme/proto/pull/7" },
          suggestedTitle: "X",
        },
      }),
    })
    render(<BranchModeControls editing={makeEditing()} branches={branches} />)
    openMenu()
    fireEvent.click(screen.getByTestId("branch-open-pr"))

    await waitFor(() => expect(branches.preflightPullRequest).toHaveBeenCalled())
    expect(screen.queryByTestId("pull-request-dialog")).not.toBeInTheDocument()
  })
})

/**
 * Plan B, Task 5 — the Activity detail dialog.
 *
 * Written against the not-yet-existing `ActivityDetailDialog` contract
 * first (TDD): these tests failed with "Cannot find module" until the
 * component existed, then failed on missing testids/text until the
 * implementation matched. See task-5-report.md for the red-run evidence
 * and the mutation-testing results.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"

import { ActivityDetailDialog } from "./activity-detail-dialog"
import { undoAvailability } from "./activity-row"
import type { ActivityRow as ActivityRowModel } from "./activity-rows"
import type { LedgerRow } from "@/hooks/useEditorLedger"
import type { VerificationRecord } from "@/stores/editor-slice"

function ledgerRow(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "ledger-1",
    at: "2026-08-19T10:00:00.000Z",
    kind: "prop",
    lane: "direct",
    files: ["src/App.vue"],
    backupDir: ".desde/backups/1-abc",
    afterHashes: { "src/App.vue": "HASH_AFTER" },
    description: 'label = "Submit"',
    committed: false,
    ...over,
  }
}

function ledgerActivityRow(
  over: Partial<LedgerRow> = {},
): Extract<ActivityRowModel, { source: "ledger" }> {
  const row = ledgerRow(over)
  return { source: "ledger", id: row.id, row }
}

function gitActivityRow(
  over: Partial<{
    path: string
    status: "added" | "modified" | "deleted" | "renamed"
    from: string
  }> = {},
): Extract<ActivityRowModel, { source: "git" }> {
  const path = over.path ?? "src/Stray.vue"
  const status = over.status ?? "modified"
  return {
    source: "git",
    id: path,
    path,
    status,
    ...(over.from !== undefined ? { from: over.from } : {}),
  }
}

function passVerification(over: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    editId: "client-edit-1",
    label: 'label = "Submit"',
    phase: "done",
    startedAt: Date.now(),
    result: {
      editId: "client-edit-1",
      status: "pass",
      expectedValue: "Submit",
      observedValue: "Submit",
      escalatable: false,
      detail: "DOM text matched the written value.",
      durationMs: 10,
    },
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"))
})

describe("ActivityDetailDialog", () => {
  it("renders all three sections from a full row: what changed, where it landed, verification", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={ledgerActivityRow({
          description: 'label = "Submit"',
          committed: true,
          sha: "a1b2c3d",
          at: "2026-08-19T10:00:00.000Z", // 2h before the faked "now"
        })}
        verification={passVerification({
          result: {
            editId: "client-edit-1",
            status: "fail",
            failedAt: "L2",
            expectedValue: "Submit",
            observedValue: "Cancel",
            cause: "bound-binding",
            escalatable: true,
            detail: "It still shows Cancel, not Submit.",
            durationMs: 10,
          },
        })}
        onUndoRequested={vi.fn()}
      />,
    )

    const dialog = screen.getByTestId("activity-detail-dialog")

    // Section 1 — what changed: description as title, kind + when under it.
    expect(within(dialog).getByText('label = "Submit"')).toBeInTheDocument()
    expect(screen.getByText("Changed, 2h ago.")).toBeInTheDocument()

    // Section 2 — where it landed: path readout + commit sha and state.
    const location = screen.getByTestId("activity-detail-path")
    expect(within(location).getByText("src/App.vue")).toBeInTheDocument()
    const commitState = screen.getByTestId("activity-detail-commit-state")
    expect(commitState).toHaveTextContent("Committed as")
    expect(commitState).toHaveTextContent("a1b2c3d")

    // Section 3 — verification: status, expected vs. observed, cause, detail.
    const verificationSection = screen.getByTestId("activity-detail-verification")
    expect(within(verificationSection).getByText("Didn't take effect")).toBeInTheDocument()
    expect(verificationSection).toHaveTextContent("Expected")
    expect(verificationSection).toHaveTextContent("Submit")
    expect(verificationSection).toHaveTextContent("observed")
    expect(verificationSection).toHaveTextContent("Cancel")
    expect(verificationSection).toHaveTextContent(
      "It still shows Cancel, not Submit.",
    )
    // The raw FailureCause enum value never renders — only its plain-word
    // explanation does (the copy rule against printing an identifier the
    // reader didn't type).
    expect(verificationSection).not.toHaveTextContent("bound-binding")
    expect(verificationSection).toHaveTextContent(
      "The value comes from a dynamic binding, not a fixed one.",
    )
  })

  it("shows no verification section when the row has no verification record — omitted, not rendered empty", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={ledgerActivityRow()}
        onUndoRequested={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId("activity-detail-verification"),
    ).not.toBeInTheDocument()
  })

  it("Undo in the footer is disabled with the exact same reason undoAvailability gives the menu", () => {
    const row = ledgerActivityRow({
      kind: "delete_file",
      afterHashes: {},
      description: "Deleted App.vue",
    })
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={row}
        onUndoRequested={vi.fn()}
      />,
    )
    const undoButton = screen.getByTestId("activity-detail-undo")
    expect(undoButton).toBeDisabled()

    const expectedReason = undoAvailability(row).reason
    expect(expectedReason).toBeDefined()
    expect(expectedReason).toMatch(/deleted the file/)
    expect(screen.getByTestId("activity-detail-undo-reason")).toHaveTextContent(
      expectedReason!,
    )
  })

  it("disables Undo for a git-only row with the same 'no record to undo' reason as the menu", () => {
    const row = gitActivityRow()
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={row}
        onUndoRequested={vi.fn()}
      />,
    )
    expect(screen.getByTestId("activity-detail-undo")).toBeDisabled()
    expect(screen.getByTestId("activity-detail-undo-reason")).toHaveTextContent(
      undoAvailability(row).reason!,
    )
    // A git-only row never has a verification record.
    expect(
      screen.queryByTestId("activity-detail-verification"),
    ).not.toBeInTheDocument()
  })

  it("leaves Undo enabled for an ordinary edit and fires onUndoRequested with the row, closing itself", () => {
    const onUndoRequested = vi.fn()
    const onOpenChange = vi.fn()
    const row = ledgerActivityRow({ id: "edit-42" })
    render(
      <ActivityDetailDialog
        open
        onOpenChange={onOpenChange}
        row={row}
        onUndoRequested={onUndoRequested}
      />,
    )
    const undoButton = screen.getByTestId("activity-detail-undo")
    expect(undoButton).not.toBeDisabled()
    expect(
      screen.queryByTestId("activity-detail-undo-reason"),
    ).not.toBeInTheDocument()

    fireEvent.click(undoButton)
    expect(onUndoRequested).toHaveBeenCalledWith(row)
    // Closes itself first — Undo reaches the SAME shared confirm dialog the
    // row's menu opens, so this dialog shouldn't stack behind it.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("a disabled Undo button does not fire onUndoRequested when clicked", () => {
    const onUndoRequested = vi.fn()
    const row = ledgerActivityRow({ kind: "delete_file", afterHashes: {} })
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={row}
        onUndoRequested={onUndoRequested}
      />,
    )
    fireEvent.click(screen.getByTestId("activity-detail-undo"))
    expect(onUndoRequested).not.toHaveBeenCalled()
  })

  it("Close closes: clicking it calls onOpenChange(false)", () => {
    const onOpenChange = vi.fn()
    render(
      <ActivityDetailDialog
        open
        onOpenChange={onOpenChange}
        row={ledgerActivityRow()}
        onUndoRequested={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("activity-detail-close"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders nothing when closed", () => {
    render(
      <ActivityDetailDialog
        open={false}
        onOpenChange={vi.fn()}
        row={ledgerActivityRow()}
        onUndoRequested={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("activity-detail-dialog")).not.toBeInTheDocument()
  })

  it("lists every touched file on a multi-file ledger entry", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={ledgerActivityRow({
          files: ["src/App.vue", "src/Other.vue"],
          afterHashes: { "src/App.vue": "H1", "src/Other.vue": "H2" },
        })}
        onUndoRequested={vi.fn()}
      />,
    )
    const location = screen.getByTestId("activity-detail-path")
    expect(within(location).getByText("Paths")).toBeInTheDocument()
    expect(within(location).getByText("src/App.vue")).toBeInTheDocument()
    expect(within(location).getByText("src/Other.vue")).toBeInTheDocument()
  })

  // P2-2 (codex review finding, 2026-08-20): a repo-relative path may
  // legally contain ", " (e.g. a filename with a comma in it, which is
  // valid on every filesystem this product targets). The dialog used to
  // build its path list via `pathForRow(row).split(", ")` — round-
  // tripping through the SAME separator `pathForRow` joins multi-file
  // rows with — so a single file whose own name contains ", " was split
  // into two entries with the wrong text. This drives that exact case: a
  // SINGLE-file ledger row whose one path contains ", ".
  it("shows a single file whose path contains ', ' as one path, not two", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={ledgerActivityRow({
          files: ["src/Foo, Bar.vue"],
          afterHashes: { "src/Foo, Bar.vue": "H1" },
        })}
        onUndoRequested={vi.fn()}
      />,
    )
    const location = screen.getByTestId("activity-detail-path")
    // Singular label: this is ONE path, even though it contains ", ".
    expect(within(location).getByText("Path")).toBeInTheDocument()
    expect(within(location).getByText("src/Foo, Bar.vue")).toBeInTheDocument()
    // The load-bearing assertion: a buggy split would have produced TWO
    // spans ("src/Foo" and "Bar.vue") instead of one.
    expect(within(location).queryByText("src/Foo")).not.toBeInTheDocument()
    expect(within(location).queryByText("Bar.vue")).not.toBeInTheDocument()
  })

  // F4 (codex review round 4, 2026-08-20): `WorkingTreeChange.from` used to
  // be dropped entirely for a git-only rename, so the dialog said a file
  // moved but never said where from — a regression against the panel that
  // shipped before this branch, which showed "old.vue → new.vue".
  it("lists both paths for a git-only rename, not just the destination", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={gitActivityRow({ path: "src/Header.vue", from: "src/TopBar.vue", status: "renamed" })}
        onUndoRequested={vi.fn()}
      />,
    )
    const location = screen.getByTestId("activity-detail-path")
    expect(within(location).getByText("Paths")).toBeInTheDocument()
    expect(within(location).getByText("src/TopBar.vue")).toBeInTheDocument()
    expect(within(location).getByText("src/Header.vue")).toBeInTheDocument()
  })

  it("reads 'Not committed' for an uncommitted ledger row and never mentions a sha", () => {
    render(
      <ActivityDetailDialog
        open
        onOpenChange={vi.fn()}
        row={ledgerActivityRow({ committed: false, sha: undefined })}
        onUndoRequested={vi.fn()}
      />,
    )
    const commitState = screen.getByTestId("activity-detail-commit-state")
    expect(commitState).toHaveTextContent("Not committed.")
  })
})

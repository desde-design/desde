/**
 * Rewritten from scratch for Plan B, Task 4 — the panel's contract changed
 * (two stacked sections -> one merged list backed by the edit ledger, an
 * `onDiscard` callback -> a ledger `undo`), so extending the old file would
 * have carried assumptions ("a row is a `WorkingTreeChange`", "there is a
 * discard affordance") that no longer hold.
 *
 * Radix `DropdownMenu` doesn't reliably open under jsdom's `fireEvent` (it
 * wants real pointer-capture, and this repo has no
 * `@testing-library/user-event`) — swapped for the same faithful inline
 * stand-in `chat-session-menu.test.tsx` / `branch-mode-controls.test.tsx`
 * already use: content always rendered, `disabled` -> `aria-disabled` and a
 * swallowed `onSelect`. The row logic under test is ours, not Radix's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: {
    children: ReactNode
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
import { ActivityPanel } from "./activity-panel"
import type { WorkingTreeChange } from "@/hooks/useEditorBranches"
import type { LedgerRow, UndoResult } from "@/hooks/useEditorLedger"
import { useEditorStore } from "@/stores/editor-only"

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

// Cleared BEFORE each test (not after): the store is global, and clearing it
// while a panel is still mounted triggers an un-acted React update.
beforeEach(() => {
  useEditorStore.getState().clearVerifications()
  vi.clearAllMocks()
})

// The F2 (round 4) settle-guard test below opts into fake timers — real
// ones by default for every other test in this file, restored here so a
// failure mid-test can't leak fake timers into whatever runs next.
afterEach(() => {
  vi.useRealTimers()
})

describe("ActivityPanel", () => {
  it("renders the clean-tree explainer when the ledger and working tree are both empty", () => {
    render(<ActivityPanel changes={[]} rows={[]} undo={vi.fn()} />)
    expect(
      screen.queryByTestId("activity-changes-list"),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument()
  })

  it("renders a ledger row's description, path, change type and commit state", () => {
    render(
      <ActivityPanel
        changes={[]}
        rows={[ledgerRow({ description: 'label = "Submit"', files: ["src/App.vue"] })]}
        undo={vi.fn()}
      />,
    )
    const list = screen.getByTestId("activity-changes-list")
    expect(list).toBeInTheDocument()
    expect(screen.getByText('label = "Submit"')).toBeInTheDocument()
    // Line two: `<path> · <change type> · <commit state>`, plain words —
    // never an A/M/D/R git letter.
    expect(
      screen.getByText("src/App.vue · Changed · Not committed"),
    ).toBeInTheDocument()
  })

  it("renders a committed ledger row's commit state as 'Committed'", () => {
    render(
      <ActivityPanel
        changes={[]}
        rows={[ledgerRow({ committed: true })]}
        undo={vi.fn()}
      />,
    )
    expect(
      screen.getByText("src/App.vue · Changed · Committed"),
    ).toBeInTheDocument()
  })

  it("renders a git-only row as 'Changed outside the editor'", () => {
    const changes: WorkingTreeChange[] = [{ path: "src/Stray.vue", status: "modified" }]
    render(<ActivityPanel changes={changes} rows={[]} undo={vi.fn()} />)
    expect(screen.getByText("Changed outside the editor")).toBeInTheDocument()
    expect(
      screen.getByText("src/Stray.vue · Changed · Not committed"),
    ).toBeInTheDocument()
  })

  // F3 (codex review round 8, 2026-08-20): the caller (`editor-right-rail.tsx`)
  // used to pass `rows` straight through and drop `useEditorLedger`'s own
  // `error`/`loading` on the floor. When the ledger's INITIAL request
  // fails, `rows` is `[]` — indistinguishable, from `rows` alone, from a
  // genuinely empty ledger. Without `ledgerError` threaded through, a real
  // Editor edit sitting in `changes` got rendered as a confident "Changed
  // outside the editor," losing its description, verification and Undo.
  // This asserts the false label is never shown while the ledger is known
  // to be unavailable, and that the row says something honestly uncertain
  // instead.
  it("does not label a change 'Changed outside the editor' while the ledger's initial request has failed", () => {
    const changes: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    render(
      <ActivityPanel
        changes={changes}
        rows={[]}
        ledgerError="Failed to load the edit ledger (500)"
        undo={vi.fn()}
      />,
    )
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()
    expect(screen.getByText("Not checked yet")).toBeInTheDocument()
    // The panel says WHY, rather than staying silent about the gap.
    expect(
      screen.getByText(/have not been checked yet/),
    ).toBeInTheDocument()
  })

  it("does not label a change 'Changed outside the editor' while the ledger's initial request is still loading", () => {
    const changes: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    render(
      <ActivityPanel changes={changes} rows={[]} ledgerLoading undo={vi.fn()} />,
    )
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()
    expect(screen.getByText("Not checked yet")).toBeInTheDocument()
  })

  it("goes back to the confirmed 'Changed outside the editor' label once the ledger has loaded at least once, even if a LATER poll fails", () => {
    const changes: WorkingTreeChange[] = [{ path: "src/Stray.vue", status: "modified" }]
    // `rows` has held something before (a prior successful load) — a
    // later, unrelated poll failure must not make an already-explained
    // working tree read as unexplained again.
    render(
      <ActivityPanel
        changes={changes}
        rows={[ledgerRow({ id: "l1", files: ["src/Other.vue"] })]}
        ledgerError="Failed to load the edit ledger (500)"
        undo={vi.fn()}
      />,
    )
    expect(screen.getByText("Changed outside the editor")).toBeInTheDocument()
    expect(screen.queryByText("Not checked yet")).not.toBeInTheDocument()
  })

  it("disables Undo with an honest reason for a row that only exists because the ledger is unavailable", () => {
    const changes: WorkingTreeChange[] = [{ path: "src/App.vue", status: "modified" }]
    render(
      <ActivityPanel
        changes={changes}
        rows={[]}
        ledgerError="Failed to load the edit ledger (500)"
        undo={vi.fn()}
      />,
    )
    const menuItem = screen.getByText("Undo").closest('[role="menuitem"]')
    expect(menuItem).toHaveAttribute("aria-disabled", "true")
    expect(
      screen.getByText("This hasn't been checked yet, so it can't be undone here."),
    ).toBeInTheDocument()
  })

  // F2 (codex review round 4, 2026-08-20): `rows` (the edit ledger) and
  // `changes` (the working tree) are two independent poll results — even
  // launched on the SAME shared tick, each lands in its own `setState`
  // call at its own time. A plain recompute-on-either-change would
  // briefly render a list built from a stale half and a fresh half: if
  // `changes` reports a path dirty before `rows` has picked up the
  // ledger entry that explains it, the panel would show "Changed outside
  // the editor" for that path before correcting itself a moment later.
  // This drives that exact race at the prop level (this panel receives
  // both as props already resolved; the pollers' own timing is
  // `useEditorLedger`'s/`useEditorBranches`' concern) and asserts the
  // OBSERVABLE property the task calls for: the wrong label is never in
  // the DOM at any point along the way, not merely that it disappears
  // quickly. A test that only checked the two hooks shared a timer (the
  // round-2 mistake this finding names) would pass even with the flicker
  // still happening.
  it("never renders a ledger-backed path as 'Changed outside the editor', even when the branches half of an update lands before the ledger half", async () => {
    vi.useFakeTimers()
    const ledgerDescription = 'label = "Submit"'
    const { rerender } = render(<ActivityPanel changes={[]} rows={[]} undo={vi.fn()} />)
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()

    // `changes` lands first — the working tree already shows the file
    // dirty, but the ledger entry that explains it hasn't arrived yet.
    rerender(
      <ActivityPanel
        changes={[{ path: "src/App.vue", status: "modified" }]}
        rows={[]}
        undo={vi.fn()}
      />,
    )
    // Still the OLD (empty) merged list — the settle guard holds it, so
    // the half-updated pair never reaches the DOM.
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()
    expect(screen.queryByTestId("activity-changes-list")).not.toBeInTheDocument()

    // Well within the settle window, `rows` lands too — the ordinary
    // case for two fetches to the same local server, launched together.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    rerender(
      <ActivityPanel
        changes={[{ path: "src/App.vue", status: "modified" }]}
        rows={[ledgerRow({ description: ledgerDescription, files: ["src/App.vue"] })]}
        undo={vi.fn()}
      />,
    )
    // Still the OLD state — this second change reset the settle timer.
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()
    expect(screen.queryByText(ledgerDescription)).not.toBeInTheDocument()

    // Let the settle window fully elapse from THIS latest change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // The final, fully-consistent state — and the wrong label was never
    // shown at any point getting here.
    expect(screen.getByText(ledgerDescription)).toBeInTheDocument()
    expect(screen.queryByText("Changed outside the editor")).not.toBeInTheDocument()
  })

  // F3 (codex review round 4, 2026-08-20): round 3 taught the UNDO planner
  // that a missing `backupDir` does NOT prove an edit created its files —
  // `manage_package` rewrites an EXISTING lockfile with no backup. This row
  // never got the same treatment: it still read the missing `backupDir` as
  // "New file", mislabeling an unbacked MODIFICATION as a creation. Same
  // shape as the "disables Undo... for an entry with no backup that isn't
  // recorded as a creation" case in the "Undo availability" describe block
  // below — this asserts the CHANGE TYPE label, that one asserts Undo.
  it("labels an unbacked entry 'Changed', not 'New file', when it isn't recorded as a creation", () => {
    render(
      <ActivityPanel
        changes={[]}
        rows={[
          ledgerRow({
            kind: "manage_package",
            backupDir: undefined,
            files: ["package-lock.json"],
            afterHashes: { "package-lock.json": "H" },
            description: "Added lodash@4.0.0",
          }),
        ]}
        undo={vi.fn()}
      />,
    )
    expect(
      screen.getByText("package-lock.json · Changed · Not committed"),
    ).toBeInTheDocument()
    expect(screen.queryByText(/New file/)).not.toBeInTheDocument()
  })

  it("labels an unbacked entry 'New file' when it IS recorded as a creation", () => {
    render(
      <ActivityPanel
        changes={[]}
        rows={[
          ledgerRow({
            kind: "insert_component",
            backupDir: undefined,
            createdFiles: ["src/New.vue"],
            files: ["src/New.vue"],
            afterHashes: { "src/New.vue": "H" },
            description: "Created New.vue",
          }),
        ]}
        undo={vi.fn()}
      />,
    )
    expect(
      screen.getByText("src/New.vue · New file · Not committed"),
    ).toBeInTheDocument()
  })

  // F4 (codex review round 4, 2026-08-20): `WorkingTreeChange.from` used to
  // be dropped entirely for a git-only rename, so the row said a file moved
  // but never said where from — a regression against the pre-rebuild panel,
  // which showed "old.vue → new.vue".
  it("shows both paths for a git-only rename, not just the destination", () => {
    const changes: WorkingTreeChange[] = [
      { path: "src/Header.vue", from: "src/TopBar.vue", status: "renamed" },
    ]
    render(<ActivityPanel changes={changes} rows={[]} undo={vi.fn()} />)
    expect(
      screen.getByText("src/TopBar.vue → src/Header.vue · Renamed · Not committed"),
    ).toBeInTheDocument()
  })

  it("renders the value-shaped kinds in mono and prose kinds in the UI font", () => {
    render(
      <ActivityPanel
        changes={[]}
        rows={[
          ledgerRow({ id: "l1", kind: "prop", description: 'label = "Submit"', files: ["a.vue"] }),
          ledgerRow({ id: "l2", kind: "delete_file", description: "Deleted a.vue", files: ["a.vue"], afterHashes: {} }),
        ]}
        undo={vi.fn()}
      />,
    )
    expect(screen.getByText('label = "Submit"')).toHaveClass("font-mono")
    expect(screen.getByText("Deleted a.vue")).not.toHaveClass("font-mono")
  })

  describe("verification pill", () => {
    it("shows no pill when no verification record matches the row", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ id: "l1" })]}
          undo={vi.fn()}
        />,
      )
      const row = screen.getByTestId("activity-row")
      // No StatusPill text anywhere in the row.
      expect(
        within(row).queryByText(/Verified|Didn.t take effect|Not checked|Checking/),
      ).not.toBeInTheDocument()
    })

    it("shows a pill only for the row whose correlationId matches the verification's editId — NOT the ledger row's own id", () => {
      // Task 4b: the join key is `row.correlationId` (the CLIENT's edit
      // id, echoed back on the ledger row), never `row.id` (a server-minted
      // `randomUUID()` the client never sees). Each row's `id` here
      // deliberately does NOT equal the verification's `editId`, so this
      // test fails if the join ever regresses to comparing `id`.
      useEditorStore.getState().beginVerification("client-edit-1", 'label = "Submit"', Date.now())
      useEditorStore.getState().completeVerification("client-edit-1", {
        editId: "client-edit-1",
        status: "pass",
        expectedValue: "Submit",
        observedValue: "Submit",
        escalatable: false,
        detail: "DOM text matched the written value.",
        durationMs: 10,
      })
      render(
        <ActivityPanel
          changes={[]}
          rows={[
            ledgerRow({
              id: "server-uuid-1",
              correlationId: "client-edit-1",
              description: 'label = "Submit"',
            }),
            ledgerRow({
              id: "server-uuid-2",
              correlationId: "client-edit-2",
              description: 'title = "Other"',
              files: ["b.vue"],
            }),
          ]}
          undo={vi.fn()}
        />,
      )
      const rows = screen.getAllByTestId("activity-row")
      expect(rows).toHaveLength(2)
      expect(within(rows[0]).getByText("Verified")).toBeInTheDocument()
      expect(within(rows[1]).queryByText("Verified")).not.toBeInTheDocument()
    })

    it("shows no pill for a row with no correlationId, even when a verification exists for another row", () => {
      // The chat/SDK-tool write lanes (and an older client) never send a
      // correlationId — that row must simply have no pill, not crash and
      // not accidentally join to an unrelated verification.
      useEditorStore.getState().beginVerification("client-edit-1", "x", Date.now())
      useEditorStore.getState().completeVerification("client-edit-1", {
        editId: "client-edit-1",
        status: "pass",
        expectedValue: "x",
        observedValue: "x",
        escalatable: false,
        detail: "matched",
        durationMs: 10,
      })
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ id: "server-uuid-1" })]}
          undo={vi.fn()}
        />,
      )
      const row = screen.getByTestId("activity-row")
      expect(within(row).queryByText("Verified")).not.toBeInTheDocument()
    })

    it("tints a failed row's background but leaves other rows untinted", () => {
      useEditorStore.getState().beginVerification("client-edit-1", "x", Date.now())
      useEditorStore.getState().completeVerification("client-edit-1", {
        editId: "client-edit-1",
        status: "fail",
        failedAt: "L2",
        expectedValue: "x",
        observedValue: "y",
        cause: "bound-binding",
        escalatable: true,
        detail: "It still shows y, not x.",
        durationMs: 10,
      })
      render(
        <ActivityPanel
          changes={[]}
          rows={[
            ledgerRow({ id: "server-uuid-1", correlationId: "client-edit-1" }),
            ledgerRow({ id: "server-uuid-2", correlationId: "client-edit-2", files: ["b.vue"] }),
          ]}
          undo={vi.fn()}
        />,
      )
      const rows = screen.getAllByTestId("activity-row")
      // `ListRow asChild` merges its className directly onto this div (no
      // separate wrapper element), so the tint lands on the row itself.
      expect(rows[0]).toHaveClass("bg-destructive/10")
      expect(rows[1]).not.toHaveClass("bg-destructive/10")
    })
  })

  describe("Undo availability", () => {
    it("disables Undo with a reason for a git-only row (no ledger entry)", () => {
      render(
        <ActivityPanel
          changes={[{ path: "src/Stray.vue", status: "modified" }]}
          rows={[]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(/no record to undo/)
    })

    it("disables Undo with a reason for a whole-file delete", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ kind: "delete_file", afterHashes: {}, description: "Deleted App.vue" })]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(/deleted the file/)
    })

    it("disables Undo with a reason for a whole-file rename", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[
            ledgerRow({
              kind: "rename_file",
              files: ["b.vue"],
              afterHashes: { "b.vue": "H" },
              description: "a.vue → b.vue",
            }),
          ]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(/renamed the file/)
    })

    it("disables Undo with a reason when the entry has no recorded hashes", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ kind: "overwrite", afterHashes: {}, description: "Rewrote App.vue" })]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(/no recorded file hashes/)
    })

    it("leaves Undo enabled for an ordinary edit with a backup and hashes", () => {
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow()]} undo={vi.fn()} />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).not.toHaveAttribute("aria-disabled", "true")
    })

    // P1-1 (codex review round 3, 2026-08-20): an entry with no backup
    // at all (`backupDir: undefined`) whose `createdFiles` doesn't cover
    // every touched file is GUARANTEED to refuse server-side with
    // `unbacked` — a `manage_package` lockfile-tracking append is the
    // running example. Pre-disable it up front rather than let the user
    // click into a dead end, same treatment as delete_file/rename_file
    // above.
    it("disables Undo with a reason for an entry with no backup that isn't recorded as a creation", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[
            ledgerRow({
              kind: "manage_package",
              backupDir: undefined,
              files: ["package-lock.json"],
              afterHashes: { "package-lock.json": "H" },
              description: "Added lodash@4.0.0",
            }),
          ]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(/No backup was recorded/)
    })

    it("leaves Undo enabled for an entry with no backup when it IS recorded as a creation", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[
            ledgerRow({
              kind: "insert_component",
              backupDir: undefined,
              createdFiles: ["src/New.vue"],
              files: ["src/New.vue"],
              afterHashes: { "src/New.vue": "H" },
              description: "Created New.vue",
            }),
          ]}
          undo={vi.fn()}
        />,
      )
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).not.toHaveAttribute("aria-disabled", "true")
    })
  })

  describe("undo confirm dialog", () => {
    it("confirming Undo calls the hook with the row id", async () => {
      const undo = vi.fn().mockResolvedValue({ ok: true } satisfies UndoResult)
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ id: "edit-42" })]}
          undo={undo}
        />,
      )
      fireEvent.click(screen.getByText("Undo"))
      const dialog = await screen.findByTestId("activity-undo-dialog")
      expect(dialog).toHaveTextContent("src/App.vue")

      fireEvent.click(screen.getByTestId("activity-undo-confirm"))
      await waitFor(() => expect(undo).toHaveBeenCalledWith("edit-42"))
      await waitFor(() =>
        expect(screen.queryByTestId("activity-undo-dialog")).not.toBeInTheDocument(),
      )
    })

    it("cancel does not call undo and closes the dialog", () => {
      const undo = vi.fn()
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow()]} undo={undo} />,
      )
      fireEvent.click(screen.getByText("Undo"))
      expect(screen.getByTestId("activity-undo-dialog")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("activity-undo-cancel"))
      expect(undo).not.toHaveBeenCalled()
      expect(
        screen.queryByTestId("activity-undo-dialog"),
      ).not.toBeInTheDocument()
    })

    it("branches the copy on commit state: uncommitted discards, committed restores and says history is untouched", () => {
      const { unmount } = render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ committed: false })]}
          undo={vi.fn()}
        />,
      )
      fireEvent.click(screen.getByText("Undo"))
      expect(screen.getByTestId("activity-undo-dialog")).toHaveTextContent(
        "This discards the changes to",
      )
      unmount()

      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ committed: true })]}
          undo={vi.fn()}
        />,
      )
      fireEvent.click(screen.getByText("Undo"))
      const dialog = screen.getByTestId("activity-undo-dialog")
      expect(dialog).toHaveTextContent("It becomes a new uncommitted change")
      expect(dialog).toHaveTextContent("the commit history is not modified")
    })

    it("a refused undo toasts the server's reason verbatim and disables Undo on that row afterward, for a PERMANENT refusal code", async () => {
      // `backup-gone` (unlike `drifted`/`wrong-branch` — see the P2-1
      // round-3 test below) is a durable fact about the entry itself, so
      // caching it is correct: it can never become un-true.
      const undo = vi.fn().mockResolvedValue({
        ok: false,
        code: "backup-gone",
        reason: "The backup for this edit is gone, so it can't be undone.",
      } satisfies UndoResult)
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow({ id: "edit-1" })]} undo={undo} />,
      )
      fireEvent.click(screen.getByText("Undo"))
      fireEvent.click(screen.getByTestId("activity-undo-confirm"))

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "The backup for this edit is gone, so it can't be undone.",
        ),
      )
      await waitFor(() =>
        expect(screen.queryByTestId("activity-undo-dialog")).not.toBeInTheDocument(),
      )

      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).toHaveAttribute("aria-disabled", "true")
      expect(menu).toHaveTextContent(
        "The backup for this edit is gone, so it can't be undone.",
      )
    })

    // P2-1 (codex review round 3, 2026-08-20): `drifted` and
    // `wrong-branch` are recognized codes, but they describe CURRENT
    // file/branch state, not a durable fact about the entry. Caching
    // them the way P1-1's original fix cached every recognized code
    // reproduced the exact failure the finding named: edits A then B
    // touch one file; undoing A first gets `drifted` (B's write is what
    // the file currently holds); undoing B afterward makes A's undo
    // valid again, but a cached `drifted` reason would keep A's row
    // disabled regardless. This test doesn't need the two-edit setup to
    // discriminate the fix — it only needs to show `drifted` behaves
    // like the codeless case (P2-2) rather than like `backup-gone`
    // above: not cached, row stays retryable.
    it("a drifted undo refusal toasts but leaves the row retryable, since a later change can make it valid again", async () => {
      const undo = vi.fn().mockResolvedValue({
        ok: false,
        code: "drifted",
        reason: "'src/App.vue' changed after this edit, so it can't be undone.",
      } satisfies UndoResult)
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow({ id: "edit-1" })]} undo={undo} />,
      )
      fireEvent.click(screen.getByText("Undo"))
      fireEvent.click(screen.getByTestId("activity-undo-confirm"))

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "'src/App.vue' changed after this edit, so it can't be undone.",
        ),
      )
      await waitFor(() =>
        expect(screen.queryByTestId("activity-undo-dialog")).not.toBeInTheDocument(),
      )

      // Not disabled, and not carrying the stale reason as a cached
      // refusal — the very next click reopens the confirm dialog rather
      // than an already-known-refused menu item.
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).not.toHaveAttribute("aria-disabled", "true")
      fireEvent.click(screen.getByText("Undo"))
      expect(await screen.findByTestId("activity-undo-dialog")).toBeInTheDocument()
    })

    // P2-2 (codex review finding, 2026-08-20): a failure with NO `code`
    // — a network error, or a 500 the server didn't model as a
    // recognized refusal — is not a durable fact about the row. It must
    // not be cached: the row stays enabled so a retry (which might
    // genuinely succeed) is one click away, not permanently disabled for
    // the rest of the session.
    it("an unrecognized (codeless) undo failure toasts but leaves the row retryable", async () => {
      const undo = vi.fn().mockResolvedValue({
        ok: false,
        reason: "Failed to fetch",
      } satisfies UndoResult)
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow({ id: "edit-1" })]} undo={undo} />,
      )
      fireEvent.click(screen.getByText("Undo"))
      fireEvent.click(screen.getByTestId("activity-undo-confirm"))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to fetch"))
      await waitFor(() =>
        expect(screen.queryByTestId("activity-undo-dialog")).not.toBeInTheDocument(),
      )

      // Not disabled, and not carrying the stale reason as a cached
      // refusal — the very next click reopens the confirm dialog rather
      // than an already-known-refused menu item.
      const menu = screen.getByText("Undo").closest('[role="menuitem"]')
      expect(menu).not.toHaveAttribute("aria-disabled", "true")
      fireEvent.click(screen.getByText("Undo"))
      expect(await screen.findByTestId("activity-undo-dialog")).toBeInTheDocument()
    })
  })

  it("namespaces row keys so a ledger id and a git path never collide", () => {
    // A pathological but structurally-possible case: a ledger row's id
    // happens to equal a git-only row's path string. Both must render as
    // two distinct rows, not collapse into one via a shared React key.
    const sharedId = "src/Shared.vue"
    render(
      <ActivityPanel
        changes={[{ path: sharedId, status: "modified" }]}
        rows={[ledgerRow({ id: sharedId, description: "Ledger entry", files: ["a.vue"] })]}
        undo={vi.fn()}
      />,
    )
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2)
    expect(screen.getByText("Ledger entry")).toBeInTheDocument()
    expect(screen.getByText("Changed outside the editor")).toBeInTheDocument()
  })

  it("does not let a removed row's DOM identity (and whatever was focused on it) bleed onto a surviving row that shares its unnamespaced id", async () => {
    // Reviewer finding: a `toHaveLength(2)` check at first mount can't tell
    // a namespaced key apart from a bare `row.id`, because React has
    // nothing to reconcile against on the very first render — the bug only
    // shows up on an UPDATE, once a real fiber (and its DOM node) already
    // exists for a key and React has to decide whether a new child "is" it.
    //
    // Reproduces the real scenario the collision guards against: a ledger
    // entry ages out of the poll (committed, pruned past the 200-row cap,
    // or reconciled away some other way) while the underlying file is
    // still dirty — so the row COUNT drops from 2 to 1, and the survivor
    // is the git-only row that happens to share the departing ledger
    // row's id.
    //
    // The observable is DOM node identity, not React internal state: with
    // a bare `id` key, React treats the surviving element as the SAME
    // node as the one that's disappearing (same key = "this is still that
    // element" to the reconciler) and reuses its underlying `<button>` in
    // place — so whatever the BROWSER attached to that physical node
    // (focus, here) rides along onto content that is now a completely
    // different row. With the namespaced key, the departing row's button
    // is genuinely unmounted and a fresh one mounted for the survivor, so
    // focus is lost exactly like removing any other focused element.
    //
    // Confirmed empirically both directions: reverting the namespaced key
    // to plain `row.id` in activity-panel.tsx and rerunning this exact
    // test flips `remainingButton === document.activeElement` from
    // `false` to `true` — i.e. this assertion goes red without the fix,
    // unlike the `toHaveLength(2)` test above.
    const sharedId = "shared-id"
    const { rerender } = render(
      <ActivityPanel
        rows={[ledgerRow({ id: sharedId, description: "Ledger entry", files: ["a.vue"] })]}
        changes={[{ path: sharedId, status: "modified" }]}
        undo={vi.fn()}
      />,
    )
    const [ledgerButton] = screen.getAllByRole("button", { name: /^Actions for/ })
    ledgerButton.focus()
    expect(document.activeElement).toBe(ledgerButton)

    // The ledger entry ages out; only the git-only row (same id) remains.
    rerender(
      <ActivityPanel
        rows={[]}
        changes={[{ path: sharedId, status: "modified" }]}
        undo={vi.fn()}
      />,
    )

    // F2 (codex review round 4, 2026-08-20): the panel now holds the
    // PREVIOUS merged list for a short settle window after `rows`/`changes`
    // change (see `useSettledActivityRows`'s doc comment) — a real
    // `setTimeout`, so this rerender's effect is not synchronous anymore.
    // `waitFor` is the fix, not a fake-timer advance: this test cares about
    // the FINAL DOM state, not the timing itself.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Actions for/ })).not.toBe(ledgerButton)
    })

    const remainingButton = screen.getByRole("button", { name: /^Actions for/ })
    expect(remainingButton).not.toBe(ledgerButton)
    expect(document.activeElement).not.toBe(remainingButton)
  })

  it("copies the row's path to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(
      <ActivityPanel
        changes={[]}
        rows={[ledgerRow({ files: ["src/App.vue"] })]}
        undo={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText("Copy path"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/App.vue"))
  })

  // Task 5 — added alongside `activity-detail-dialog.test.tsx`, which covers
  // the dialog's own contract in isolation. These exercise the actual wiring
  // in `activity-row.tsx`: a real row, in a real list, being clicked — which
  // an isolated dialog test can never do, since it never mounts the row's
  // own onClick/stopPropagation handlers at all.
  describe("row click opens the detail dialog", () => {
    it("clicking a row opens its detail dialog, and the row itself does not expand", () => {
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ description: 'label = "Submit"' })]}
          undo={vi.fn()}
        />,
      )
      expect(
        screen.queryByTestId("activity-detail-dialog"),
      ).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId("activity-row"))

      const dialog = screen.getByTestId("activity-detail-dialog")
      expect(within(dialog).getByText('label = "Submit"')).toBeInTheDocument()
      // "No longer expands": the row is still exactly the two lines it was
      // before the click — nothing new rendered inside `activity-row`
      // itself, only the separate dialog.
      expect(
        within(screen.getByTestId("activity-row")).queryByTestId(
          "activity-detail-dialog",
        ),
      ).not.toBeInTheDocument()
    })

    it("clicking the row's Actions button does not also open the detail dialog", () => {
      render(
        <ActivityPanel changes={[]} rows={[ledgerRow()]} undo={vi.fn()} />,
      )
      fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }))
      expect(
        screen.queryByTestId("activity-detail-dialog"),
      ).not.toBeInTheDocument()
    })

    it("Undo in the detail dialog's footer opens the SAME shared confirm dialog the row's menu opens", async () => {
      const undo = vi.fn().mockResolvedValue({ ok: true } satisfies UndoResult)
      render(
        <ActivityPanel
          changes={[]}
          rows={[ledgerRow({ id: "edit-42" })]}
          undo={undo}
        />,
      )
      fireEvent.click(screen.getByTestId("activity-row"))
      fireEvent.click(screen.getByTestId("activity-detail-undo"))

      // The detail dialog closes itself, and the panel's one shared confirm
      // dialog (already covered by "undo confirm dialog" above) opens.
      expect(
        screen.queryByTestId("activity-detail-dialog"),
      ).not.toBeInTheDocument()
      const confirmDialog = await screen.findByTestId("activity-undo-dialog")
      expect(confirmDialog).toHaveTextContent("src/App.vue")

      fireEvent.click(screen.getByTestId("activity-undo-confirm"))
      await waitFor(() => expect(undo).toHaveBeenCalledWith("edit-42"))
    })
  })
})

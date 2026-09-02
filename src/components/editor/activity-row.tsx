"use client"

/**
 * One row of the merged Activity list (Plan B, Task 4; click-to-detail added
 * Task 5). Renders either source `buildActivityRows` produces
 * (`activity-rows.ts`): a ledger entry (an edit editor made) or a
 * `git`-only row (a dirty file no ledger entry claims — "changed outside
 * the editor").
 *
 * Two lines, no section headers (Mo: the old A/M/D/R-letter file list
 * "expects a deep knowledge of Git"):
 *  - Line 1: the description (mono for a value-shaped edit, UI font for
 *    prose), the verification pill when one exists, and a `⋮` menu revealed
 *    on hover/focus.
 *  - Line 2, muted: `<path> · <change type> · <commit state>`, all in
 *    plain words, never a git status letter.
 *
 * Clicking anywhere on the row (outside the `⋮` menu) opens
 * `ActivityDetailDialog` — the row itself never expands; see that file's
 * doc comment for the three-section layout and what it shares with this one.
 *
 * ## Why `ListRow asChild` wraps a `<div>`, not a `<button>`
 *
 * The row has to contain a REAL `<button>` (the `⋮` trigger, and — via
 * `DropdownMenu` — its portal). `ListRow`'s default element IS a `<button>`,
 * and a `<button>` can't legally contain another `<button>` (the browser
 * closes the outer one at the inner tag, corrupting the row's DOM). Every
 * existing case in this codebase that nests a real `<Button>` inside a
 * `ListRow` (`editor-canvas-surface.tsx`'s `CanvasPickerRow`) resolves this
 * the same way: `asChild` onto a `<div>`. That is also why the click-to-open
 * handler below lives on the `<div>` with `role="button"`/`tabIndex` rather
 * than as a native `<button>`: the row already contains one, and can't
 * contain two. The actions area stops its own click AND keydown from
 * bubbling to this handler, so opening the `⋮` menu (mouse or keyboard)
 * never also opens the detail dialog.
 *
 * ## Undo-disabled classification — the carried-forward findings
 *
 * `undoAvailability` below is where Task 1's review finding is fixed
 * client-side (Task 1's own file list was server-only, so this is the
 * first place UI can act on it): a ledger entry for a whole-file DELETE
 * (`kind: 'delete_file'`) always refuses server-side with `unverifiable`
 * ("no recorded file hashes"), and a whole-file RENAME (`kind:
 * 'rename_file'`) always refuses with `drifted` — in both cases even
 * though nothing actually drifted; the file's absence at that path is
 * exactly what the edit itself produced. Shipping either message into a
 * user-visible menu would read as "something went wrong," when nothing
 * did. Rather than let the user click Undo and receive that misleading
 * refusal, these two kinds are disabled UP FRONT with an honest reason
 * that names the real limitation (undo can't prove nothing else has
 * touched a path that no longer exists) — the skill's own rule is to
 * prevent the dead end, not explain it after the fact.
 *
 * A THIRD case joined them at P1-1 (codex review round 3, 2026-08-20): an
 * entry with `backupDir === undefined` (no backup was ever taken for
 * this write) whose `createdFiles` doesn't cover every touched file is
 * ALSO guaranteed to refuse server-side (`unbacked` — see
 * `planLedgerUndo`'s doc comment), for the identical reason: the server
 * can prove ahead of time, from data already on the row, that this
 * click can only ever fail.
 *
 * A prior FAILED undo attempt (any code — drifted, backup-gone,
 * unbacked, or a genuine `unverifiable`) is cached by the panel and
 * passed back in here as `cachedRefusalReason`, so a row that has
 * already told the user why it can't be undone doesn't invite a second,
 * identical round trip. The very first click on any given row is still
 * optimistic — the client has no file to hash, so it cannot know about
 * drift or a swept backup ahead of time; the server's answer is what the
 * panel remembers.
 */

import * as React from "react"
import { useState } from "react"
import { MoreVertical } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ListRow, StatusPill } from "@/components/blocks"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { describeState, stateOf } from "@/components/editor/verification-checks-list"
import { ActivityDetailDialog } from "@/components/editor/activity-detail-dialog"
import type { ActivityRow as ActivityRowModel } from "@/components/editor/activity-rows"
import type { VerificationRecord } from "@/stores/editor-slice"

/**
 * Ledger edit kinds whose `description` IS a literal authored value (`prop
 * = "value"`, a token assignment, replacement text) rather than a sentence
 * about what happened. Mirrors `describeLedgerEntry`'s own cases for these
 * three kinds (`src/editor/ledger/describe-entry.ts`) — everything else
 * that function renders is prose ("Deleted App.vue", "Moved element",
 * "Changed outside the editor").
 */
const VALUE_SHAPED_KINDS: ReadonlySet<string> = new Set([
  "prop",
  "token-value",
  "text-branch",
])

export type ActivityChangeType = "New file" | "Changed" | "Deleted" | "Renamed"

/**
 * Vocabulary rule: words, not git status letters. Derived purely from data
 * the row already carries — no extra fetch, no per-design-system branching.
 */
export function changeTypeForRow(row: ActivityRowModel): ActivityChangeType {
  if (row.source === "git") {
    switch (row.status) {
      case "added":
        return "New file"
      case "modified":
        return "Changed"
      case "deleted":
        return "Deleted"
      case "renamed":
        return "Renamed"
    }
  }
  const entry = row.row
  if (entry.kind === "delete_file") return "Deleted"
  if (entry.kind === "rename_file") return "Renamed"
  // F3 (codex review round 4, 2026-08-20): a missing `backupDir` does
  // NOT prove this edit created its files — `manage_package` appends an
  // entry with no `backupDir` for a lockfile rewrite even when the
  // lockfile already existed (see `undo-entry.ts`'s module doc comment,
  // the same fact P1-1/round 3 already taught the undo planner beside
  // this function). `createdFiles` is the entry's own explicit statement
  // of which touched files it created — "New file" only when EVERY
  // touched file is one of them, matching the old ALL-files reading of
  // `backupDir`'s absence, just off the signal that's actually true.
  if (entry.files.length > 0 && entry.files.every((f) => entry.createdFiles?.includes(f))) {
    return "New file"
  }
  return "Changed"
}

/**
 * The path(s) a row is about, as an array — one per file. Never derive
 * this by splitting {@link pathForRow}'s joined string back apart: a
 * repo-relative path may legally CONTAIN `", "` (e.g. `src/Foo, Bar.vue`
 * is a valid filename), and a single-file row whose one path contains
 * `", "` round-trips through `.join(", ").split(", ")` as TWO paths
 * instead of one — P2-2, codex review finding, 2026-08-20. Read the
 * source arrays directly instead.
 *
 * F4 (codex review round 4, 2026-08-20): a git-only RENAME is about TWO
 * real repo-relative paths, `from` and `path` — `WorkingTreeChange.from`
 * used to be dropped here entirely, so the row said a file moved but
 * never said where from. A ledger-sourced rename already names both
 * sides in `entry.files` (see `fs-structural-tools.ts`'s `rename_file`
 * handler); this puts a git-only rename on the same "one array entry per
 * real path" terms, rather than inventing a display string here.
 */
export function pathsForRow(row: ActivityRowModel): string[] {
  if (row.source === "git") {
    return row.from !== undefined ? [row.from, row.path] : [row.path]
  }
  return row.row.files
}

/**
 * The path(s) a row is about, joined for display and for "Copy path".
 *
 * A git-only rename reads as an arrow, not a comma list — F4 (codex
 * review round 4, 2026-08-20) restores the wording the panel used before
 * this branch's rebuild ("old.vue → new.vue"): a plain join would read
 * "old.vue, new.vue", which looks like two unrelated changes rather than
 * one file that moved.
 */
export function pathForRow(row: ActivityRowModel): string {
  if (row.source === "git" && row.from !== undefined) {
    return `${row.from} → ${row.path}`
  }
  return pathsForRow(row).join(", ")
}

/**
 * Exported for `ActivityDetailDialog` (Task 5), which shows the same commit
 * state alongside the sha — one deriver, not a second reading of the row.
 */
export function commitStateLabel(row: ActivityRowModel): "Committed" | "Not committed" {
  // A `git`-sourced row IS an uncommitted working-tree change by
  // definition (`useEditorBranches` only reports dirty paths) — it can
  // never read "Committed."
  return row.source === "ledger" && row.row.committed
    ? "Committed"
    : "Not committed"
}

/**
 * Exported for `ActivityDetailDialog` (Task 5), whose header title is this
 * same description — the row's line one and the dialog's title must never
 * drift into two different readings of the same row.
 */
export function descriptionForRow(row: ActivityRowModel): { text: string; mono: boolean } {
  if (row.source === "git") {
    // F3 (codex review round 8, 2026-08-20): `row.ledgerUnavailable` means
    // this row is only unclaimed because the ledger couldn't be read yet —
    // not because it was read and came back without a claim. "Changed
    // outside the editor" is a specific, confident claim this row has no
    // basis for in that state; a real edit made just now would get the
    // identical row, so the wording has to stay honestly uncertain instead.
    if (row.ledgerUnavailable) {
      return { text: "Not checked yet", mono: false }
    }
    // Same wording `describeLedgerEntry` uses for a ledger entry with no
    // description (`kind: 'unknown'`) — both describe the identical fact
    // from the reader's point of view: a change editor didn't make.
    return { text: "Changed outside the editor", mono: false }
  }
  return {
    text: row.row.description,
    mono: VALUE_SHAPED_KINDS.has(row.row.kind),
  }
}

export interface UndoAvailability {
  disabled: boolean
  /** Always present when `disabled` — absent only for the enabled state. */
  reason?: string
}

/**
 * The Undo-disabled rule. See the module doc comment above for why
 * `delete_file` / `rename_file` are refused HERE rather than left to the
 * server's own (accurate but misleading-sounding, for these two kinds)
 * refusal.
 *
 * `cachedRefusalReason` is the panel's memory of a PRIOR failed undo
 * attempt on this exact row — pass it once the server has actually said
 * so; never invent one. The reason surfaces verbatim, matching
 * `useEditorLedger`'s own contract for `UndoResult.reason`.
 */
export function undoAvailability(
  row: ActivityRowModel,
  cachedRefusalReason?: string,
): UndoAvailability {
  if (row.source === "git") {
    // F3 (codex review round 8, 2026-08-20): mirrors `descriptionForRow`'s
    // same split — while the ledger hasn't loaded, this row isn't known to
    // be outside change; it just has no answer yet, so the refusal reason
    // has to say that instead of the confident claim below.
    if (row.ledgerUnavailable) {
      return {
        disabled: true,
        reason: "This hasn't been checked yet, so it can't be undone here.",
      }
    }
    return {
      disabled: true,
      reason:
        "This change wasn't made through an edit, so there's no record to undo.",
    }
  }
  const entry = row.row
  if (entry.kind === "delete_file") {
    return {
      disabled: true,
      reason:
        "This edit deleted the file. Undo can't confirm nothing else has touched it since, so it isn't offered here.",
    }
  }
  if (entry.kind === "rename_file") {
    return {
      disabled: true,
      reason:
        "This edit renamed the file. Undo can't confirm the original path is unaffected, so it isn't offered here.",
    }
  }
  if (Object.keys(entry.afterHashes).length === 0) {
    // Matches `planLedgerUndo`'s own `unverifiable` reason
    // (`src/editor/ledger/undo-entry.ts`) verbatim — for every OTHER kind
    // this really is the reason: nothing was recorded to prove safety
    // against, not (as with the two kinds above) a systematic effect of
    // the edit itself.
    return {
      disabled: true,
      reason: "This edit has no recorded file hashes, so it can't be undone.",
    }
  }
  // P1-1 (codex review round 3, 2026-08-20): an entry with NO backup at
  // all (`backupDir === undefined`) can only be undone by DELETING a
  // file it explicitly recorded as having created — see
  // `planLedgerUndo`'s `unbacked` refusal. A `manage_package` lockfile
  // append is the running example: it appends an entry with an
  // `afterHash` but no backup, even when the lockfile already existed.
  // If any touched file is missing from `createdFiles`, the server is
  // GUARANTEED to refuse — pre-disable rather than let the user click
  // into a dead end, same reasoning as `delete_file`/`rename_file` above.
  if (
    entry.backupDir === undefined &&
    entry.files.some((f) => !entry.createdFiles?.includes(f))
  ) {
    return {
      disabled: true,
      reason: "No backup was recorded for this edit, so it can't be undone.",
    }
  }
  if (cachedRefusalReason) {
    return { disabled: true, reason: cachedRefusalReason }
  }
  return { disabled: false }
}

function copyPath(path: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    toast.error("Couldn't copy to clipboard")
    return
  }
  void navigator.clipboard
    .writeText(path)
    .then(() => toast.success("Path copied"))
    .catch(() => toast.error("Couldn't copy to clipboard"))
}

export interface ActivityRowProps {
  row: ActivityRowModel
  /** The verification record for this row's edit, if one exists. Absent
   *  is the common case — see the module contract on `describeState`'s
   *  caller below: no record, no pill. */
  verification?: VerificationRecord
  /** A prior failed-undo reason for this exact row, remembered by the
   *  panel. See `undoAvailability`'s doc comment. */
  cachedUndoRefusalReason?: string
  /** Fires when the user picks "Undo" on an ENABLED row. Never called for
   *  a disabled item. */
  onUndoRequested: (row: ActivityRowModel) => void
}

export function ActivityRow({
  row,
  verification,
  cachedUndoRefusalReason,
  onUndoRequested,
}: ActivityRowProps) {
  const { text: description, mono } = descriptionForRow(row)
  const path = pathForRow(row)
  const changeType = changeTypeForRow(row)
  const committedLabel = commitStateLabel(row)
  const undo = undoAvailability(row, cachedUndoRefusalReason)
  // The detail dialog (Task 5) is owned locally — one row, one dialog, no
  // panel-level state to thread. It gets exactly the same `verification` /
  // `cachedUndoRefusalReason` / `onUndoRequested` this row already has, so
  // its Undo footer button reaches the panel's shared confirm dialog
  // through the identical callback the `⋮` menu item uses.
  const [detailOpen, setDetailOpen] = useState(false)

  // No pill when there is no verification record — most edits are not
  // verifiable, and a "Not checked" label on every one of them would be
  // noise. Reuses `verification-checks-list.tsx`'s `stateOf`/`describeState`
  // so this row and `ActivityDetailDialog` never drift into two vocabularies
  // for the same four states.
  const isFailure = verification ? stateOf(verification) === "fail" : false
  const pill = verification ? describeState(verification) : null

  return (
    <>
      <ListRow
        asChild
        className={cn(
          "group flex-col items-stretch gap-0.5 rounded-none px-3 py-2 cursor-pointer",
          // Failures keep the destructive tint — the one state that wants
          // attention, carried over from the Checks list's own treatment.
          isFailure && "bg-destructive/10 hover:bg-destructive/15",
        )}
      >
        {/*
         * Clicking the row opens the detail dialog (Task 5) — the row
         * itself never expands; an expanding row and a click-to-open modal
         * would be two interactions competing for one click. `role="button"`
         * + `tabIndex`/`onKeyDown` give this the same activation contract a
         * real `<button>` would, which it can't literally be: it already
         * contains one (the `⋮` trigger below), and a `<button>` can't
         * legally nest another. The actions area stops its own clicks (and
         * keydowns, so Enter on the trigger doesn't ALSO fire this) from
         * bubbling up to this handler.
         */}
        <div
          data-testid="activity-row"
          data-source={row.source}
          role="button"
          tabIndex={0}
          onClick={() => setDetailOpen(true)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            setDetailOpen(true)
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-foreground",
                mono ? "font-mono text-code" : "text-xs",
              )}
            >
              {description}
            </span>
            {pill ? (
              <StatusPill tone={pill.tone} pulse={pill.pulse} className="shrink-0 text-xs">
                {pill.label}
              </StatusPill>
            ) : null}
            <div
              className="shrink-0"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Actions for ${path}`}
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={undo.disabled}
                    className={cn(undo.disabled && "flex-col items-start gap-0.5")}
                    onSelect={() => {
                      if (undo.disabled) return
                      onUndoRequested(row)
                    }}
                  >
                    <span>Undo</span>
                    {/* Visible, not hover-only: the reason a destructive
                        action is unavailable shouldn't require a second
                        interaction to discover — see the module doc comment. */}
                    {undo.disabled && undo.reason ? (
                      <span className="text-2xs whitespace-normal text-muted-foreground">
                        {undo.reason}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => copyPath(path)}>
                    Copy path
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <div className="truncate text-2xs text-muted-foreground">
            {path} · {changeType} · {committedLabel}
          </div>
        </div>
      </ListRow>
      <ActivityDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        row={row}
        verification={verification}
        cachedUndoRefusalReason={cachedUndoRefusalReason}
        onUndoRequested={onUndoRequested}
      />
    </>
  )
}

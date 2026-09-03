"use client"

/**
 * Activity panel (Plan B, Task 4) — one merged list, not two stacked
 * sections. Mo, looking at the old panel (verification checks on top, a
 * `git status` file list below): "I don't currently like the current way
 * the items are split and their display. It is confusing and expects a
 * deep knowledge of Git."
 *
 * `buildActivityRows` (`activity-rows.ts`, Task 3) merges `rows` (the edit
 * ledger, `useEditorLedger`) with `changes` (the working tree,
 * `useEditorBranches`) into one newest-first list: one row per ledger
 * entry, then one row per dirty path no ledger entry claims — a change
 * made outside the editor. `ActivityRow` (Task 4) renders each one; this
 * file owns the list shell, the empty state, and the single shared Undo
 * confirmation dialog.
 *
 * Per-edit verification results do NOT get a section of their own. Mo's
 * complaint was about the split itself — a `VerificationChecksList` strip
 * above this list would repeat every verified/failed row a second time,
 * which is the exact "two stacked sections" problem this file exists to
 * remove. A verification verdict instead feeds two things already on the
 * row: the pill (`verificationByEditId` below, joined via `row.row.correlationId`)
 * and the destructive tint on a failure. The full detail — expected vs.
 * observed, cause, the cascade-owner explanation — lives one click away in
 * `ActivityDetailDialog`'s own verification section. `stateOf` /
 * `describeState` (`verification-checks-list.tsx`) are the shared
 * vocabulary both this row and that dialog read from, so the four states
 * (`Checking…` / `Verified` / `Didn't take effect` / `Not checked`) can
 * never drift into two different readings.
 *
 * ## The verification join key (Task 4b)
 *
 * A row's pill used to be looked up by `row.row.id === verification.editId`.
 * That never matched anything real: `row.row.id` is a `randomUUID()` the
 * server mints inside `brokeredWrite` and never sends back, while
 * `verification.editId` is the CLIENT's own edit id — two disjoint id
 * spaces. The fix is `row.row.correlationId`: the client's edit id, sent
 * to the server as an opaque join key on `POST /api/editor/edit`
 * (`build-edit-request.ts`) and echoed back verbatim on the resulting
 * ledger row. `verificationForLedgerRow` (`activity-verification-join.ts`)
 * does the actual lookup and is the one place that guards the join —
 * `row.row.correlationId` is `undefined` for any edit lane that doesn't
 * send one (chat, the SDK's structural tools, an older client), and that
 * must read as "no pill," never as a match against some OTHER id-less
 * row or record.
 *
 * ## React keys are namespaced by source
 *
 * A ledger row's id is a server `randomUUID()`; a git-only row's id is its
 * repo-relative path (`activity-rows.ts`). Two different id spaces sharing
 * one `<ul>` means a bare `id` is not safe as a React key — a collision
 * doesn't crash, it silently misattributes state between two unrelated
 * rows, which is worse to diagnose than a crash. The key below is
 * `${row.source}:${row.id}`, which makes a cross-space collision
 * structurally impossible rather than merely unlikely.
 *
 * ## The undo-refusal cache
 *
 * `refusals` remembers the server's `reason` for any row whose undo has
 * already been tried and refused with a code that is PERMANENT for that
 * row (`backup-gone`, `unverifiable`, `unbacked` — see
 * `CACHEABLE_UNDO_REFUSAL_CODES` below). The FIRST attempt on a row is
 * always optimistic — the client has no file to hash, so it cannot know
 * ahead of time whether a backup still exists (`ActivityRow`'s
 * `undoAvailability` has the rest of this rule). Once the server has
 * answered with one of those codes, there is no reason to spend a second
 * identical round trip offering the same dead click again, so that row's
 * menu item goes from optimistically-enabled to disabled-with-a-reason
 * from then on, for this session.
 *
 * P2-2 (codex review finding, 2026-08-20): a result with NO code — a
 * network error, or a 500 the server didn't model as one of the codes
 * above — is NOT cached. Those are not durable facts about the row: a
 * retry might genuinely succeed. Caching them anyway used to disable
 * Undo on that row for the rest of the session over what could have been
 * a transient blip; now they surface as a toast only, and the row stays
 * clickable.
 *
 * P2-1 (codex review round 3, 2026-08-20): `drifted` and `wrong-branch`
 * used to be cached too, and that was wrong for the same reason as
 * P2-2's fix, just less obviously — those two ARE recognized semantic
 * codes, but they are not DURABLE facts about the row. Failure scenario:
 * edits A then B touch the same file. The user tries A first and gets
 * `drifted` (B's write is what the file currently holds); that gets
 * cached. They then undo B — the file now matches A's `afterHashes`
 * again, and the server would happily accept A's undo — but the cached
 * reason keeps A's row disabled for the rest of the session, even though
 * the thing it was refused for is no longer true. A branch switch makes
 * a cached `wrong-branch` stale the same way. `backup-gone`,
 * `unverifiable`, and `unbacked` don't have this problem: each is a fact
 * about the ENTRY itself (its backup was swept, it never recorded
 * hashes, it never recorded a backup) that cannot become un-true once
 * observed, so caching them forever is correct rather than merely
 * convenient. `drifted`/`wrong-branch` are facts about the CURRENT state
 * of the file/branch, which the next edit or the next checkout can
 * change out from under the cache — so they are never cached; every
 * click re-asks the server, exactly like an unrecognized failure already
 * did after P2-2.
 */

import * as React from "react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Callout } from "@/components/blocks"
import { ActivityRow, pathForRow } from "@/components/editor/activity-row"
import { verificationForLedgerRow } from "@/components/editor/activity-verification-join"
import {
  buildActivityRows,
  type ActivityRow as ActivityRowModel,
} from "@/components/editor/activity-rows"
import type { WorkingTreeChange } from "@/hooks/useEditorBranches"
import type { LedgerRow, LedgerUndoRefusal, UndoResult } from "@/hooks/useEditorLedger"
import { useEditorStore } from "@/stores/editor-only"
import type { VerificationRecord } from "@/stores/editor-slice"

type PendingUndo = Extract<ActivityRowModel, { source: "ledger" }>

/**
 * The refusal codes worth remembering for a whole session — see the
 * module doc comment's "undo-refusal cache" section (P2-2, P2-1 round
 * 3). Every code here is a PERMANENT fact about the ENTRY itself, never
 * about the current state of the file or the checked-out branch:
 *
 *  - `backup-gone` — this entry's backup was swept by retention GC.
 *  - `unverifiable` — this entry never recorded file hashes.
 *  - `unbacked` — this entry never recorded a backup for a touched file,
 *    and never recorded the file as one it created either.
 *
 * `drifted` and `wrong-branch` are deliberately NOT in this set (P2-1,
 * codex review round 3, 2026-08-20) — both describe the CURRENT state of
 * the file or the checked-out branch, which a later undo of a DIFFERENT
 * entry, or a branch switch, can change out from under a cached
 * refusal. See the module doc comment for the concrete failure this
 * caused. Every OTHER `UndoResult` (no `code` at all: a network error,
 * or a 500 the server didn't model as one of these) is likewise treated
 * as transient and left retryable.
 */
const CACHEABLE_UNDO_REFUSAL_CODES: ReadonlySet<LedgerUndoRefusal> = new Set([
  "backup-gone",
  "unverifiable",
  "unbacked",
])

/**
 * How long this panel waits, after `rows` or `changes` last changed,
 * before showing the new merged list (F2, codex review round 4,
 * 2026-08-20).
 *
 * `rows` (the edit ledger, `useEditorLedger`) and `changes` (the working
 * tree, `useEditorBranches`) are two independent poll results. Even
 * sharing the SAME tick (`subscribeToPollTick`, `useEditorBranches.ts`)
 * only starts their two fetches together — each is its own network round
 * trip to the CLI server, and each lands in its own `setState` call at
 * its own time. Recomputing `buildActivityRows` the instant EITHER prop
 * changes (a plain `useMemo(fn, [rows, changes])`, what this replaced)
 * briefly renders a list built from a stale half and a fresh half: right
 * after an edit, if `changes` reports the file dirty before `rows` has
 * picked up the ledger entry that explains it, the panel shows "Changed
 * outside the editor" for a split second before the real description
 * replaces it. That is the exact flicker the shared tick was supposed to
 * close and didn't — sharing the CLOCK the two fetches start on says
 * nothing about when either one FINISHES, and the same gap shows up on
 * first mount too (both hooks' very first fetches are independent calls
 * from their own mount effects, before either has subscribed to any
 * tick).
 */
const SETTLE_DELAY_MS = 150

/**
 * Options weighed:
 *
 * 1. **A true barrier inside the pollers** — `subscribeToPollTick` awaits
 *    both hooks' fetches (`Promise.allSettled`) and only then fires both
 *    `setState` calls, back to back, so React batches them into one
 *    render. Exact for the PERIODIC tick, but it does nothing for "on
 *    first mount": each hook's very first fetch runs before either has
 *    subscribed to the shared tick at all, and the two hooks mount from
 *    unrelated ancestors — `useEditorBranches` in `editor-surface.tsx`,
 *    `useEditorLedger` inside the child `editor-right-rail.tsx` (see that
 *    hook's own module doc comment) — so there is no shared instant to
 *    barrier the first fetch against. It would also mean reworking both
 *    hooks' internals (splitting `refresh` into a fetch phase and a
 *    commit phase) to serve ONE consumer of the two, when neither hook's
 *    several OTHER consumers (branch menu, commit button, chat grounding,
 *    …) need this at all.
 * 2. **A "generation" counter each hook stamps onto its own state**, with
 *    this panel only trusting a pair once both generations agree. Also
 *    exact, but it grows `LedgerApi`/`BranchesApi` a field neither hook's
 *    other consumers need, and it STILL needs a rule for what to render
 *    while the generations disagree — which is this same guard, just
 *    moved one layer up and duplicated across two hooks instead of owned
 *    once where `rows` and `changes` already meet.
 * 3. **(chosen) A settle guard right here**, where the two already meet
 *    as plain props. It covers the tick AND the mount race with one
 *    rule, touches neither hook, and both hooks' own referential-
 *    stability tricks (`sameLedgerRows`, `sameChanges`) mean the effect
 *    below only ever resets on an ACTUAL content change — an unchanged
 *    poll already hands back the same array reference and never touches
 *    this timer.
 *
 * Not mathematically exact — a change arriving MORE than
 * {@link SETTLE_DELAY_MS} after its pair could still show a momentary
 * half-state — but 150ms is generous against a localhost round trip and
 * tiny against the 2500ms poll period. It never blocks on a promise: a
 * source that stops updating (a hung or permanently failing fetch) just
 * holds ITS side of the pair still, exactly as the `useMemo` this
 * replaces already would, so this introduces no new stall — only a
 * small, constant, bounded delay on top of every update, whether or not
 * it was actually racing anything.
 */
function useSettledActivityRows(
  rows: LedgerRow[],
  changes: WorkingTreeChange[],
  ledgerAvailable: boolean,
): ActivityRowModel[] {
  const [settled, setSettled] = useState<ActivityRowModel[]>(() =>
    buildActivityRows(rows, changes, ledgerAvailable),
  )

  useEffect(() => {
    // No ref needed to track "the latest props": this effect itself
    // RE-RUNS (cleanup + a fresh closure) every time `rows`/`changes`
    // change identity, since they're this effect's own dependency array.
    // The most recent run's closure already IS the latest pair — a
    // second change arriving before the timer fires cancels this run's
    // timer (the cleanup below) and schedules a brand new one over the
    // newer values, rather than racing a stale read against a mutable
    // ref. `ledgerAvailable` joins the same dependency array (F3, codex
    // review round 8, 2026-08-20) so the moment the ledger's first load
    // resolves, this recomputes on the same settle timer rather than
    // reading a stale `ledgerAvailable` closure.
    const timer = setTimeout(() => {
      setSettled(buildActivityRows(rows, changes, ledgerAvailable))
    }, SETTLE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [rows, changes, ledgerAvailable])

  return settled
}

function ActivityPanelImpl({
  changes = [],
  rows = [],
  ledgerLoading = false,
  ledgerError = null,
  undo,
}: {
  /** Uncommitted working-tree changes from useEditorBranches. */
  changes?: WorkingTreeChange[]
  /** The edit ledger from useEditorLedger, newest first. */
  rows?: LedgerRow[]
  /** `useEditorLedger`'s own `loading` — true while its request is in
   *  flight. See `ledgerUnavailable` below. */
  ledgerLoading?: boolean
  /** `useEditorLedger`'s own `error`. See `ledgerUnavailable` below. */
  ledgerError?: string | null
  /** Per-entry undo from useEditorLedger. */
  undo: (id: string) => Promise<UndoResult>
}) {
  const verifications = useEditorStore((s) => s.verifications)
  const [pending, setPending] = useState<PendingUndo | null>(null)
  const [undoing, setUndoing] = useState(false)
  // See the module doc comment's "undo-refusal cache" section.
  const [refusals, setRefusals] = useState<Record<string, string>>({})

  /**
   * True only while the ledger has never successfully loaded this
   * session: still loading, or every request so far has failed.
   *
   * F3 (codex review round 8, 2026-08-20): the caller used to pass `rows`
   * straight through and drop `error`/`loading` on the floor. When the
   * INITIAL ledger request fails, `rows` stays `[]` (its documented
   * failure behavior — see `useEditorLedger`'s own module doc comment),
   * which is exactly what a genuinely empty ledger also looks like. Every
   * dirty path then rendered as a confident "Changed outside the editor"
   * for a change that may well have been made right here, moments ago.
   * `rows.length === 0` alone can't tell "confirmed empty" from "unknown"
   * apart; `ledgerLoading`/`ledgerError` are what make the two
   * distinguishable.
   *
   * Once `rows` has held anything, this can never flip back on for a
   * LATER transient poll failure — `useEditorLedger` already keeps stale
   * `rows` around rather than clearing them on a failed poll, and that
   * stale (if imperfect) data is still a real basis for claiming a path
   * external, unlike having nothing at all.
   */
  const ledgerUnavailable = rows.length === 0 && (ledgerLoading || ledgerError !== null)

  const activityRows = useSettledActivityRows(rows, changes, !ledgerUnavailable)

  const verificationByEditId = useMemo(() => {
    const map = new Map<string, VerificationRecord>()
    for (const record of verifications) map.set(record.editId, record)
    return map
  }, [verifications])

  const handleUndoRequested = useCallback((row: ActivityRowModel) => {
    if (row.source !== "ledger") return
    setPending(row)
  }, [])

  const closeDialog = useCallback(() => {
    if (undoing) return
    setPending(null)
  }, [undoing])

  const confirmUndo = useCallback(async () => {
    if (!pending) return
    setUndoing(true)
    try {
      const result = await undo(pending.row.id)
      if (!result.ok) {
        // Refused — surface the server's reason verbatim (never rewrite
        // it). Only remember it (disabling this row's menu item for the
        // rest of the session) when the server classified the refusal
        // with a code that is PERMANENT for this entry — see the module
        // doc comment's "undo-refusal cache" section (P2-2, P2-1 round
        // 3) and `CACHEABLE_UNDO_REFUSAL_CODES`'s own doc comment. An
        // unclassified failure (network error, an unmodeled 500) or a
        // code describing CURRENT file/branch state (`drifted`,
        // `wrong-branch`) might not hold true on retry, so both surface
        // as a toast only and the row stays clickable.
        const reason = result.reason ?? "Couldn't undo this edit."
        toast.error(reason)
        if (result.code && CACHEABLE_UNDO_REFUSAL_CODES.has(result.code)) {
          setRefusals((prev) => ({ ...prev, [pending.row.id]: reason }))
        }
      }
      setPending(null)
    } finally {
      setUndoing(false)
    }
  }, [pending, undo])

  const pendingPath = pending ? pathForRow(pending) : ""
  const pendingCommitted = pending?.row.committed ?? false

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="activity-panel-branch"
    >
      {/*
       * F3 (codex review round 8, 2026-08-20): only worth saying when
       * there's something below it that the banner explains — an empty
       * working tree with an unavailable ledger has nothing to hedge.
       */}
      {ledgerUnavailable && changes.length > 0 ? (
        <Callout
          tone="warning"
          className="m-3 mb-0"
          data-testid="activity-ledger-unavailable"
        >
          Recent changes below have not been checked yet. This updates on
          its own once they have.
        </Callout>
      ) : null}
      {activityRows.length > 0 ? (
        /*
          The same group the Comments tab and the Viewer's comment list use
          (Mo, 2026-09-02: "Activity should also be similarly styled"): a
          bordered, rounded box inset 8px from the card, rows divided by
          their `<li>`s, the last divider dropped because the group's own
          bottom edge ends the list. The scroll stays on the outer column so
          the group grows with its rows rather than clipping them.
        */
        <div className="min-h-0 flex-1 overflow-y-auto">
        <ul
          className="mx-2 my-2 flex flex-col overflow-hidden rounded-md border border-border"
          data-testid="activity-changes-list"
        >
          {activityRows.map((row) => (
            <li
              key={`${row.source}:${row.id}`}
              className="border-b border-border last:border-b-0"
            >
              <ActivityRow
                row={row}
                verification={
                  row.source === "ledger"
                    ? verificationForLedgerRow(row.row.correlationId, verificationByEditId)
                    : undefined
                }
                cachedUndoRefusalReason={
                  row.source === "ledger" ? refusals[row.row.id] : undefined
                }
                onUndoRequested={handleUndoRequested}
              />
            </li>
          ))}
        </ul>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3 text-sm text-muted-foreground">
          <p>
            Edits are written to the checked-out branch directly. They apply
            immediately and show up here as{" "}
            <span className="text-foreground">uncommitted changes</span> until
            you commit them.
          </p>
          <p>
            Use the <span className="text-foreground">Commit</span> button (or
            your own git) when you&rsquo;re ready.
          </p>
        </div>
      )}

      <Dialog open={!!pending} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent size="md" data-testid="activity-undo-dialog">
          <DialogHeader>
            <DialogTitle>Undo this edit?</DialogTitle>
            <DialogDescription>
              {pendingCommitted ? (
                <>
                  This restores{" "}
                  <span className="font-mono text-foreground">{pendingPath}</span>{" "}
                  to how it was before this edit. It becomes a new uncommitted
                  change; the commit history is not modified.
                </>
              ) : (
                <>
                  This discards the changes to{" "}
                  <span className="font-mono text-foreground">{pendingPath}</span>.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={closeDialog}
              disabled={undoing}
              data-testid="activity-undo-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void confirmUndo()}
              disabled={undoing}
              data-testid="activity-undo-confirm"
            >
              {undoing ? "Undoing" : "Undo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Memoized. `rows`/`changes` only change identity when their respective
 * polls (`useEditorLedger`, `useEditorBranches`) return different state, so
 * the forceMounted Activity tab no longer re-renders with the rail.
 */
export const ActivityPanel = memo(ActivityPanelImpl)
ActivityPanel.displayName = "ActivityPanel"

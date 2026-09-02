"use client"

/**
 * Branch-management hook — the client side of Phase 2 of
 * tasks/branches-vs-worktree.md. Branch mode is the only editor edit
 * substrate (worktree-session mode was fully removed 2026-07-21 — see
 * tasks/worktree-mode-decommission.md), so the user always lists,
 * switches, creates, renames, and publishes git branches straight from
 * the shell. This hook wraps the `/api/editor/branches*` endpoints and
 * keeps a live view of the branch list + current HEAD.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"

export interface Branch {
  name: string
  current: boolean
  /** True for the resolved default branch (e.g. `main`). */
  isDefault: boolean
}

export interface BranchMutationResult {
  ok: boolean
  reason?: string
  /**
   * The files a merge conflicted on (publish, update-from-default, or
   * pull-remote), passed through from the server so the UI can NAME the
   * conflict instead of just reporting one. Absent on success and on
   * non-conflict failures.
   */
  conflictFiles?: string[]
  /**
   * True when an update action found nothing to merge — the branch already
   * contains the source. No merge changes reached the tree, but check
   * `committedBranch` before saying nothing happened: the pre-merge
   * auto-commit can have run.
   */
  upToDate?: boolean
  /**
   * True when the update action committed the user's uncommitted edits
   * onto the branch before merging (pull-remote / update-from-default).
   * Carried on BOTH success and failure: a conflicting update still
   * created that commit, and the UI must say so rather than claiming
   * nothing changed.
   */
  committedBranch?: boolean
  /**
   * True when a history-mutation failure (`undoEdit`/`redoEdit`) means the
   * step can never be applied from the current on-disk state — mirrors
   * `HistoryActionResult.stranded` from the server (undo/redo follow-ups
   * Task 3). Absent for every non-history mutation and for the transient
   * history refusals (empty stack, id race). Callers use it to offer a
   * "Discard step" affordance instead of a plain retry.
   */
  stranded?: boolean
  /**
   * The id of the step that refused, set alongside `stranded: true` —
   * mirrors `HistoryActionResult.stepId` from the server. Callers pass this
   * back as `discardStep`'s `expectedTopId` so a stranded-toast "Discard
   * step" click can only ever discard the SAME step it warned about, never
   * whatever happens to be on top by the time the user clicks (e.g. a
   * second tab that already discarded/undid it, or a fresh edit that
   * pushed a new step in between).
   */
  stepId?: string
}

/** Merge-&-push result: the merge can land locally while the push fails. */
export interface MergePushResult {
  ok: boolean
  reason?: string
  /** The files the merge conflicted on, when the failure was a conflict. */
  conflictFiles?: string[]
  /** True when the default branch was pushed to origin. */
  pushed?: boolean
  /** Why the push failed, when the local merge landed but the push didn't. */
  pushReason?: string
}

/**
 * Where a pull request from the current branch would go, resolved by `gh`
 * BEFORE anything is created. Mirrors `PullRequestTarget` in the CLI's
 * `github-pull-request.ts`.
 *
 * `crossRepo` is the one field that carries risk rather than information: `gh`
 * picks the base repo from the git remotes, and a remote named `upstream`
 * outranks `origin`, so this can be somebody else's repository. The UI has to
 * say so rather than just proceeding.
 */
export interface PullRequestTargetInfo {
  repoRef: string
  nameWithOwner: string
  base: string
  head: string
  crossRepo: boolean
  existing: { number: number; url: string } | null
  suggestedTitle: string
}

export type PullRequestPreflightResult =
  | { ok: true; target: PullRequestTargetInfo }
  | { ok: false; reason: string; kind?: string }

export type PullRequestCreateResult =
  | { ok: true; url: string }
  | { ok: false; reason: string; kind?: string }

/** One uncommitted working-tree change (mirrors the CLI's
 *  `WorkingTreeChange` from git-branches.ts). */
export interface WorkingTreeChange {
  /** Repo-relative path (the new path for renames). */
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  /** Previous path, for renames only. */
  from?: string
}

/** Toolbar undo/redo affordance state (mirrors the server's edit-history
 *  summary returned alongside `/api/editor/branches`). */
export interface EditHistoryUiState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export interface BranchesApi {
  branches: Branch[]
  current: string | null
  /** The resolved default branch (merge target for publish), or null. */
  defaultBranch: string | null
  /** True when the working tree has uncommitted changes (Commit is enabled). */
  dirty: boolean
  /** The uncommitted working-tree changes (Activity panel + Commit count). */
  changes: WorkingTreeChange[]
  /**
   * Commits on the current branch not yet in the default branch. With
   * `dirty`, drives whether Merge has anything to merge. 0 on the default
   * branch or when there's no resolvable default.
   */
  ahead: number
  /** True when the repo has an `origin` remote (gates Push / Merge-&-push). */
  hasRemote: boolean
  /**
   * True when the current branch has a configured upstream to pull from.
   * Gates "Pull remote changes": a branch with no upstream (never pushed,
   * or pushed without tracking) has nothing to pull, and `behind` reads 0
   * for it, which would otherwise be indistinguishable from up to date.
   */
  hasUpstream: boolean
  /** True when the current branch has commits not yet on origin/<branch>. */
  unpushed: boolean
  /**
   * Commits on origin/<branch> not yet on the branch, per the LAST fetch
   * (the server reads the local remote-tracking ref; `fetchRemote` is what
   * refreshes it). Only worth surfacing when > 0.
   */
  behind: number
  /** Toolbar undo/redo affordance state (per-repo edit history). */
  history: EditHistoryUiState
  loading: boolean
  error: string | null
  refresh: () => void
  switchBranch: (name: string) => Promise<BranchMutationResult>
  createBranch: (name: string, base: "default" | "current") => Promise<BranchMutationResult>
  renameBranch: (from: string, to: string) => Promise<BranchMutationResult>
  /** Squash-merge the current branch into the default branch (local only). */
  publishBranch: (message?: string) => Promise<BranchMutationResult>
  /** Commit the working tree onto the checked-out branch (any branch). */
  commitWorkingTree: (message?: string) => Promise<BranchMutationResult>
  /** Commit pending edits (if any) and push the current branch to origin. */
  pushBranch: () => Promise<BranchMutationResult>
  /** Squash-merge into the default branch AND push the default to origin. */
  mergeAndPush: (message?: string) => Promise<MergePushResult>
  /**
   * `git fetch origin` on the server so `behind` / `unpushed` reflect the
   * actual remote. Network I/O with a server-side timeout. Call it from an
   * explicit user action; the hook also runs it on a long interval. It is
   * NEVER part of the 2.5s poll. Failures are swallowed (the numbers just
   * stay stale), so this never surfaces an error.
   */
  fetchRemote: () => Promise<void>
  /**
   * Merge the default branch into the current branch, all-or-nothing: a
   * conflict changes nothing and reports `conflictFiles`.
   */
  updateFromDefault: () => Promise<BranchMutationResult>
  /**
   * Fetch, then merge origin/<branch> into the current branch,
   * all-or-nothing with the same conflict contract as `updateFromDefault`.
   */
  pullRemote: () => Promise<BranchMutationResult>
  /**
   * Ask where a pull request from the current branch would go. Read-only, and
   * deliberately separate from creating one so the destination can be shown
   * before anything exists.
   */
  preflightPullRequest: () => Promise<PullRequestPreflightResult>
  /**
   * Commit, push, then open the pull request against the repo the user was
   * shown. `repoRef` must come from `preflightPullRequest`.
   */
  createPullRequest: (input: {
    repoRef: string
    base: string
    head: string
    title: string
    body?: string
    draft?: boolean
  }) => Promise<PullRequestCreateResult>
  /**
   * Discard one file's uncommitted changes back to HEAD (undo v1, the
   * Activity panel's per-row "Discard changes"). Mirrors the row's own
   * `status`/`from` from `changes` back to the server.
   */
  discardFile: (
    path: string,
    status: WorkingTreeChange["status"],
    from?: string,
  ) => Promise<BranchMutationResult>
  /** Undo the most recent edit-history entry (rewrites files on disk). */
  undoEdit: () => Promise<BranchMutationResult>
  /** Redo the most recently undone edit-history entry. */
  redoEdit: () => Promise<BranchMutationResult>
  /**
   * Discard the top of the undo/redo stack WITHOUT applying it — the
   * "Discard step" toast action offered when `undoEdit`/`redoEdit` refuses
   * with `stranded: true`. `expectedTopId` should be the refusal's
   * `stepId` — it pins the discard to the exact step the toast warned
   * about, so a stale click (a second tab, or a click that lands after a
   * new step already landed) 409s instead of discarding the wrong step.
   */
  discardStep: (direction: "undo" | "redo", expectedTopId?: string) => Promise<BranchMutationResult>
}

/**
 * How often the hook re-polls the branch list + dirty flag (ms).
 *
 * Exported so `useEditorLedger.ts` can poll the edit ledger on the SAME
 * clock — Task 3 merges this hook's `changes` with the ledger hook's
 * `rows` into one list, and two pollers on independent clocks (even
 * ones that happen to share the same numeric value today) would drift
 * out of sync the moment either constant changed, making the merged
 * list flicker between two truths. There is deliberately only one
 * constant, not two equal ones.
 */
export const POLL_INTERVAL_MS = 2500

/**
 * P2-1 (codex review finding, 2026-08-20): sharing the CONSTANT above is
 * not sharing the CLOCK. This hook and `useEditorLedger` each used to run
 * their own `setInterval(fn, POLL_INTERVAL_MS)` — same period, but
 * started whenever that hook happened to mount, so their ticks land at
 * independent wall-clock offsets. After an edit, whichever hook's next
 * tick fires first shows its half of the story alone: the branch poll's
 * response can arrive a beat before the ledger poll's, and the merged
 * Activity panel briefly renders the file as a git-only "changed outside
 * the editor" row before the real ledger row replaces it a moment later.
 * That is exactly the flicker the shared constant was meant to prevent —
 * it just never actually closed the gap.
 *
 * `subscribeToPollTick` is a module-level pub/sub, not React context:
 * the two hooks don't share a close-enough common ancestor to host one
 * (`useEditorBranches` is instantiated well above `EditorRightRail`;
 * `useEditorLedger` is instantiated inside it — see
 * `editor-right-rail.tsx`), and closing this gap needs no re-render of
 * anything in between, only every subscriber's callback firing from the
 * SAME `setInterval` tick so their fetches start in the same event-loop
 * turn instead of on merely-equal independent timers. The underlying
 * timer is refcounted via the listener set: created on the first
 * subscriber, torn down when the last one unsubscribes, so an idle
 * module (no poller mounted — e.g. between tests) holds no live timer.
 */
let pollTickTimer: ReturnType<typeof setInterval> | null = null
const pollTickListeners = new Set<() => void>()

export function subscribeToPollTick(listener: () => void): () => void {
  pollTickListeners.add(listener)
  if (pollTickTimer === null) {
    pollTickTimer = setInterval(() => {
      for (const l of pollTickListeners) l()
    }, POLL_INTERVAL_MS)
  }
  return () => {
    pollTickListeners.delete(listener)
    if (pollTickListeners.size === 0 && pollTickTimer !== null) {
      clearInterval(pollTickTimer)
      pollTickTimer = null
    }
  }
}

/**
 * How often the hook fetches origin (ms). Deliberately long: the fetch is
 * a NETWORK round trip, so it must never ride the {@link POLL_INTERVAL_MS}
 * poll. Explicit user actions (opening the Merge/Push menu, pulling) fetch
 * on demand in between.
 */
const REMOTE_FETCH_INTERVAL_MS = 60_000

const JSON_HEADERS = { "Content-Type": "application/json" }

/**
 * Structural equality for `WorkingTreeChange[]` (order-sensitive — the
 * server returns `git status` order, which is stable across polls when
 * nothing changed). Used to keep `changes` referentially stable across the
 * {@link POLL_INTERVAL_MS} background poll: every tick was calling
 * `setChanges` with a freshly-parsed array even when the working tree was
 * unchanged, so anything downstream keyed on `changes` (the Activity panel)
 * re-rendered/re-derived every 2.5s for no reason.
 */
export function sameChanges(
  a: readonly WorkingTreeChange[],
  b: readonly WorkingTreeChange[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.path !== y.path || x.status !== y.status || x.from !== y.from) return false
  }
  return true
}

/**
 * Field-wise equality for {@link EditHistoryUiState}, mirroring
 * {@link sameChanges} — keeps `history` referentially stable across the
 * {@link POLL_INTERVAL_MS} background poll so consumers don't re-render
 * every tick when the undo/redo state hasn't actually changed.
 */
function sameHistory(a: EditHistoryUiState, b: EditHistoryUiState): boolean {
  return (
    a === b ||
    (a.canUndo === b.canUndo &&
      a.canRedo === b.canRedo &&
      a.undoLabel === b.undoLabel &&
      a.redoLabel === b.redoLabel)
  )
}

/**
 * @param onChanged fired after a successful switch/create/publish (the
 *   working tree may have changed) so the caller can reload the iframe.
 */
export function useEditorBranches(onChanged?: () => void): BranchesApi {
  const [branches, setBranches] = useState<Branch[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [changes, setChanges] = useState<WorkingTreeChange[]>([])
  const [ahead, setAhead] = useState(0)
  const [hasRemote, setHasRemote] = useState(false)
  const [hasUpstream, setHasUpstream] = useState(false)
  const [unpushed, setUnpushed] = useState(false)
  const [behind, setBehind] = useState(0)
  const [history, setHistory] = useState<EditHistoryUiState>({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep the callback in a ref so it doesn't churn the mutate/refresh deps.
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  // `quiet` skips the loading spinner — used by the background poll so the
  // branch control doesn't flicker every tick.
  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true)
    try {
      const res = await editorFetch("/api/editor/branches", { method: "GET" })
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean
            branches?: Branch[]
            current?: string | null
            defaultBranch?: string | null
            dirty?: boolean
            changes?: WorkingTreeChange[]
            ahead?: number
            behind?: number
            hasRemote?: boolean
            hasUpstream?: boolean
            unpushed?: boolean
            history?: {
              canUndo?: boolean
              canRedo?: boolean
              undoLabel?: string | null
              redoLabel?: string | null
            }
            reason?: string
          }
        | null
      if (!res.ok || !body?.ok) {
        setError(body?.reason ?? `Failed to load branches (${res.status})`)
        return
      }
      setBranches(body.branches ?? [])
      setCurrent(body.current ?? null)
      setDefaultBranch(body.defaultBranch ?? null)
      setDirty(!!body.dirty)
      const nextChanges = Array.isArray(body.changes) ? body.changes : []
      setChanges((prev) => (sameChanges(prev, nextChanges) ? prev : nextChanges))
      setAhead(typeof body.ahead === "number" ? body.ahead : 0)
      setBehind(typeof body.behind === "number" ? body.behind : 0)
      setHasRemote(!!body.hasRemote)
      setHasUpstream(!!body.hasUpstream)
      setUnpushed(!!body.unpushed)
      const h = body.history
      const nextHistory: EditHistoryUiState = {
        canUndo: !!h?.canUndo,
        canRedo: !!h?.canRedo,
        undoLabel: typeof h?.undoLabel === "string" ? h.undoLabel : null,
        redoLabel: typeof h?.redoLabel === "string" ? h.redoLabel : null,
      }
      setHistory((prev) => (sameHistory(prev, nextHistory) ? prev : nextHistory))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (!opts?.quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Poll so the Commit button reflects working-tree edits (editor edits
    // land immediately in branch mode) without a manual refresh. Shared
    // tick (P2-1) — see `subscribeToPollTick`'s doc comment above.
    return subscribeToPollTick(() => void refresh({ quiet: true }))
  }, [refresh])

  const mutate = useCallback(
    async (
      path: string,
      payload: Record<string, unknown>,
      reloadsTree: boolean,
    ): Promise<BranchMutationResult> => {
      try {
        const res = await editorFetch(path, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        })
        const body = (await res.json().catch(() => null)) as
          | {
              ok?: boolean
              reason?: string
              conflictFiles?: string[]
              upToDate?: boolean
              committedBranch?: boolean
            }
          | null
        if (!res.ok || !body?.ok) {
          // A failed update can still have auto-committed the working tree
          // (pull-remote / update-from-default commit BEFORE merging), so
          // the tree state changed even though the action failed — refresh
          // so `dirty` and the Activity panel don't stay stale, and pass
          // `committedBranch` through so the UI can say what happened.
          if (body?.committedBranch === true) await refresh()
          return {
            ok: false,
            reason: body?.reason ?? `Request failed (${res.status})`,
            conflictFiles: Array.isArray(body?.conflictFiles)
              ? body.conflictFiles
              : undefined,
            committedBranch: body?.committedBranch === true ? true : undefined,
          }
        }
        await refresh()
        if (reloadsTree) onChangedRef.current?.()
        return {
          ok: true,
          upToDate: body.upToDate === true ? true : undefined,
          committedBranch: body.committedBranch === true ? true : undefined,
        }
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    },
    [refresh],
  )

  /**
   * Same as {@link mutate} but also refreshes on FAILURE, not just success.
   * Used by `undoEdit`/`redoEdit`: their most common failure is a 409
   * refusal (stack empty, id mismatch, on-disk drift) that itself signals
   * the server-side history state moved — without a refresh here, the
   * toolbar shows a stale `canUndo`/`canRedo` until the next background
   * poll (up to {@link POLL_INTERVAL_MS}).
   */
  const mutateRefreshingOnFailure = useCallback(
    async (
      path: string,
      payload: Record<string, unknown>,
      reloadsTree: boolean,
    ): Promise<BranchMutationResult> => {
      try {
        const res = await editorFetch(path, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        })
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; reason?: string; stranded?: boolean; stepId?: string }
          | null
        if (!res.ok || !body?.ok) {
          await refresh()
          return {
            ok: false,
            reason: body?.reason ?? `Request failed (${res.status})`,
            stranded: body?.stranded,
            stepId: body?.stepId,
          }
        }
        await refresh()
        if (reloadsTree) onChangedRef.current?.()
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    },
    [refresh],
  )

  const switchBranch = useCallback(
    (name: string) => mutate("/api/editor/branches/switch", { name }, true),
    [mutate],
  )
  const createBranch = useCallback(
    (name: string, base: "default" | "current") =>
      mutate("/api/editor/branches/create", { name, base }, true),
    [mutate],
  )
  const renameBranch = useCallback(
    (from: string, to: string) =>
      // Rename doesn't change the working tree, so no iframe reload.
      mutate("/api/editor/branches/rename", { name: from, to }, false),
    [mutate],
  )
  const publishBranch = useCallback(
    (message?: string): Promise<BranchMutationResult> => {
      if (!current) {
        return Promise.resolve({ ok: false, reason: "No current branch to publish." })
      }
      // Publish resets the branch to the default branch. If the default
      // advanced independently (non-conflicting changes not on this branch),
      // that reset pulls those files into the working tree — so reload the
      // iframe. In the common case the content is identical and the reload
      // just re-shows the same view.
      return mutate("/api/editor/branches/publish", { branch: current, message }, true)
    },
    [mutate, current],
  )
  const commitWorkingTree = useCallback(
    // Commit doesn't change file contents (only records them), so no iframe
    // reload — but it flips the tree clean, which `refresh` (run by `mutate`)
    // reflects in `dirty`.
    (message?: string) => mutate("/api/editor/branches/commit", { message }, false),
    [mutate],
  )
  const pushBranch = useCallback(
    // Push commits pending edits then pushes; it doesn't rewrite the working
    // tree, so no iframe reload. `refresh` flips `dirty`/`unpushed`.
    () => mutate("/api/editor/branches/push", {}, false),
    [mutate],
  )
  const fetchRemote = useCallback(async () => {
    try {
      await editorFetch("/api/editor/branches/fetch", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      })
    } catch {
      // Background freshness only. A failed fetch means `behind`/`unpushed`
      // stay stale until the next one; not an error the UI needs to show.
    }
    await refresh({ quiet: true })
  }, [refresh])
  const updateFromDefault = useCallback(
    // A clean update rewrites the working tree (the merge brings the
    // default's files in) — reload the iframe, same as switch/publish.
    () => mutate("/api/editor/branches/update-from-default", {}, true),
    [mutate],
  )
  const pullRemote = useCallback(
    () => mutate("/api/editor/branches/pull-remote", {}, true),
    [mutate],
  )

  // Long-interval remote freshness. Deliberately NOT the 2.5s poll above:
  // fetch is a network round trip. Runs once when a remote is first seen,
  // then every REMOTE_FETCH_INTERVAL_MS while one exists.
  useEffect(() => {
    if (!hasRemote) return
    void fetchRemote()
    const id = setInterval(() => void fetchRemote(), REMOTE_FETCH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hasRemote, fetchRemote])
  const discardFile = useCallback(
    // Discarding rewrites (or removes) the file on disk, same as a
    // switch/create/publish — reload the iframe so it doesn't keep
    // showing the discarded edit.
    (path: string, status: WorkingTreeChange["status"], from?: string) =>
      mutate("/api/editor/branches/discard", { path, status, from }, true),
    [mutate],
  )
  const undoEdit = useCallback(
    // Undo rewrites files on disk, same as discard — reload the iframe.
    // Uses `mutateRefreshingOnFailure`, not `mutate`: a 409 refusal (e.g.
    // "Nothing to undo" from a race with another writer) still needs a
    // refresh, or the toolbar's canUndo/canRedo stays stale until the next
    // 2.5s poll and the button reads as live when it isn't.
    () => mutateRefreshingOnFailure("/api/editor/history/undo", {}, true),
    [mutateRefreshingOnFailure],
  )
  const redoEdit = useCallback(
    () => mutateRefreshingOnFailure("/api/editor/history/redo", {}, true),
    [mutateRefreshingOnFailure],
  )
  const discardStep = useCallback(
    // Discard never touches disk — nothing on disk changes, so no iframe
    // reload. Still uses mutateRefreshingOnFailure so a 409 (e.g. another
    // request already discarded/undid the same step) refreshes the
    // toolbar's canUndo/canRedo instead of leaving it stale.
    (direction: "undo" | "redo", expectedTopId?: string) =>
      mutateRefreshingOnFailure(
        "/api/editor/history/discard",
        { direction, expectedTopId },
        false,
      ),
    [mutateRefreshingOnFailure],
  )
  const mergeAndPush = useCallback(
    async (message?: string): Promise<MergePushResult> => {
      try {
        const res = await editorFetch("/api/editor/branches/merge-push", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ message }),
        })
        const body = (await res.json().catch(() => null)) as
          | {
              ok?: boolean
              reason?: string
              conflictFiles?: string[]
              pushed?: boolean
              pushReason?: string
            }
          | null
        if (!res.ok || !body?.ok) {
          return {
            ok: false,
            reason: body?.reason ?? `Request failed (${res.status})`,
            conflictFiles: Array.isArray(body?.conflictFiles)
              ? body.conflictFiles
              : undefined,
          }
        }
        await refresh()
        // Like publish, the local merge can rebaseline the branch → reload.
        onChangedRef.current?.()
        return { ok: true, pushed: body.pushed, pushReason: body.pushReason }
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    },
    [refresh],
  )

  const preflightPullRequest = useCallback(async (): Promise<PullRequestPreflightResult> => {
    try {
      const res = await editorFetch("/api/editor/branches/pull-request/preflight", {
        method: "POST",
        headers: JSON_HEADERS,
      })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; kind?: string; target?: PullRequestTargetInfo }
        | null
      if (!res.ok || !body?.ok || !body.target) {
        return { ok: false, reason: body?.reason ?? `Request failed (${res.status})`, kind: body?.kind }
      }
      return { ok: true, target: body.target }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }, [])

  const createPullRequest = useCallback(
    async (input: {
      repoRef: string
      base: string
      head: string
      title: string
      body?: string
      draft?: boolean
    }): Promise<PullRequestCreateResult> => {
      try {
        const res = await editorFetch("/api/editor/branches/pull-request", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(input),
        })
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; reason?: string; kind?: string; url?: string }
          | null
        if (!res.ok || !body?.ok || !body.url) {
          return { ok: false, reason: body?.reason ?? `Request failed (${res.status})`, kind: body?.kind }
        }
        // The server commits and pushes on the way, so the toolbar's dirty and
        // unpushed state is stale by the time this returns.
        await refresh()
        return { ok: true, url: body.url }
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    },
    [refresh],
  )

  return {
    branches,
    current,
    defaultBranch,
    dirty,
    changes,
    ahead,
    behind,
    hasRemote,
    hasUpstream,
    unpushed,
    history,
    loading,
    error,
    refresh,
    switchBranch,
    createBranch,
    renameBranch,
    publishBranch,
    commitWorkingTree,
    pushBranch,
    fetchRemote,
    updateFromDefault,
    pullRemote,
    mergeAndPush,
    preflightPullRequest,
    createPullRequest,
    discardFile,
    undoEdit,
    redoEdit,
    discardStep,
  }
}

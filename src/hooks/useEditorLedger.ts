"use client"

/**
 * Ledger hook — Plan B, Task 2. The client side of the append-only edit
 * ledger Plan A shipped (`GET /api/editor/ledger`) plus Plan B Task 1's
 * per-entry undo (`POST /api/editor/ledger/:id/undo`). Later tasks build
 * the Activity panel on top of this hook, merging its `rows` with
 * `useEditorBranches`'s `changes` into one list.
 *
 * Deliberately matches `useEditorBranches.ts`'s shape rather than
 * inventing a second style: same "quiet" background poll that skips the
 * loading spinner, same structural-equality trick to keep the array
 * referentially stable when the payload hasn't changed, and — as of
 * P2-1 (codex review finding, 2026-08-20) — the SAME clock, not just the
 * same interval NUMBER. `subscribeToPollTick` (`useEditorBranches.ts`)
 * is one shared `setInterval`, and every subscriber's callback fires
 * from that ONE tick; this hook's own poll used to run an independent
 * `setInterval(fn, POLL_INTERVAL_MS)`, which shared the period but not
 * the phase, so after an edit the two hooks' responses could land a beat
 * apart and the merged Activity panel would flicker between two partial
 * truths before settling. See `subscribeToPollTick`'s doc comment for
 * the full reasoning.
 *
 * ## Request ordering (F2, codex review round 8, 2026-08-20)
 *
 * `refresh` can be in flight from two different callers at once: the
 * background poll (`subscribeToPollTick`) and a foreground caller like
 * `undo`'s own post-success `await refresh()`. Nothing stopped an OLDER
 * call's response from landing after a NEWER one's and overwriting it —
 * concretely, a poll that started just before an Undo, held up slightly
 * longer than usual by the network, resolving just after the Undo's own
 * refresh already painted the post-undo rows. The poll's stale snapshot
 * would silently replace the fresher one: the just-appended undo entry
 * disappears, and any row it changed reverts to how it looked a moment
 * ago, until the NEXT poll happens to correct it.
 *
 * The fix is a request-generation counter (`requestIdRef`), bumped at the
 * START of every `refresh` call, before its `await`. A response is only
 * applied if its own captured generation still matches the ref when the
 * response lands — i.e. no NEWER `refresh` call has started since. This
 * is ordering by START time, not by RESOLUTION time: it doesn't matter
 * which fetch finishes first, only which one was asked for more recently.
 * `useEditorBranches.ts`'s `refresh` has the identical shape (same shared
 * tick, same `await mutate(...) -> refresh()` pattern for its own
 * mutations) and was not audited or fixed here — see that file's own note
 * where this is flagged, out of scope for this fix.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import { subscribeToPollTick } from "./useEditorBranches"

/**
 * Which lane produced a write. Mirrors the server's `LedgerLane`
 * (`src/editor/ledger/entry.ts`).
 */
export type LedgerLane = "direct" | "chat" | "undo"

/**
 * Why `undo` refused. Mirrors the server's `UndoRefusal`
 * (`src/editor/ledger/undo-entry.ts`): the file drifted since the edit,
 * its backup was swept, the entry carries no hashes to verify against,
 * the entry belongs to a branch other than the one now checked out
 * (`wrong-branch` — produced by the CLI route, not `planLedgerUndo`
 * itself; see that type's doc comment), or the entry never recorded a
 * backup for a file it touched and never recorded the file as one it
 * created either (`unbacked` — P1-1, codex review round 3, 2026-08-20;
 * distinct from `backup-gone`, which means a backup WAS taken and is now
 * missing).
 */
export type LedgerUndoRefusal =
  | "drifted"
  | "backup-gone"
  | "unverifiable"
  | "wrong-branch"
  | "unbacked"

/**
 * One rendered row of `GET /api/editor/ledger`. A client-side mirror of
 * the server's `LedgerRow` (`editor-cli/src/server/http-server.ts`) —
 * defined here, not imported, since the client cannot import from
 * `editor-cli/`.
 *
 * `description` is rendered SERVER-side (`describeLedgerEntry`). Do not
 * re-derive it on the client — having one deriver, not one per consumer,
 * was the point of the design; a second deriver here is exactly the
 * producer/consumer split that produced three separate defects on the
 * previous plan.
 */
export interface LedgerRow {
  id: string
  /** ISO 8601. */
  at: string
  /** The edit kind (`prop`, `swap`, an SDK tool name, …), or `unknown`. */
  kind: string
  lane: LedgerLane
  /** Repo-relative paths this write touched. */
  files: string[]
  /** Repo-relative `.desde/backups/<ts>-<uuid>/`. Absent when the
   *  edit created every file it touched. */
  backupDir?: string
  /** SHA-256 of each file's content AFTER this write, keyed by
   *  repo-relative path. */
  afterHashes: Record<string, string>
  /**
   * Repo-relative paths in `files` that this edit created (see the
   * server's `LedgerEditEntry.createdFiles` doc comment). Used
   * client-side by `undoAvailability` (`activity-row.tsx`) to pre-disable
   * a row that `backupDir === undefined` and NOT every touched file is
   * listed here — that combination is guaranteed to refuse server-side
   * with `unbacked` (P1-1, codex review round 3, 2026-08-20), so the row
   * shouldn't offer an enabled Undo in the first place.
   */
  createdFiles?: string[]
  /** Rendered server-side — see the doc comment above. */
  description: string
  committed: boolean
  /** Absent for a reconciled commit. */
  sha?: string
  /**
   * Opaque join key the CLIENT chose when it made this edit (Task 4b) —
   * the same value `useEditorEditing`'s framework adapter sent as
   * `correlationId` on `POST /api/editor/edit` (see `build-edit-request.ts`;
   * it is that edit's own `StructuralEditBase.id`). Absent whenever the
   * writing client didn't send one — an older client, or the chat/SDK-tool
   * write lanes, which don't go through this request path at all. Absence
   * is not an error: it just means this row has no verification pill to
   * join to.
   */
  correlationId?: string
}

/**
 * Result of `undo`. `reason` is written for the user by the server
 * (`planLedgerUndo` / the route handler) — surface it verbatim, never
 * rewrite it.
 */
export interface UndoResult {
  ok: boolean
  reason?: string
  code?: LedgerUndoRefusal
}

export interface LedgerApi {
  rows: LedgerRow[]
  loading: boolean
  error: string | null
  refresh: () => void
  undo: (id: string) => Promise<UndoResult>
}

// Poll clock: shared with `useEditorBranches` via `subscribeToPollTick`,
// not a private `setInterval` — see the module doc comment above.

const JSON_HEADERS = { "Content-Type": "application/json" }

const LEDGER_URL = "/api/editor/ledger"

/**
 * The hook is the only thing that knows the ledger URLs — nothing
 * downstream should build one itself.
 */
function undoUrl(id: string): string {
  return `${LEDGER_URL}/${encodeURIComponent(id)}/undo`
}

/**
 * Structural equality for `LedgerRow[]` (order-sensitive — the server
 * returns newest-first, stable across polls when nothing changed). Used
 * to keep `rows` referentially stable across the shared-tick background
 * poll, the same trick `useEditorBranches`'s `sameChanges` uses for
 * `changes`: the Activity panel is memoized on this reference, and a
 * freshly-parsed array every tick would defeat that even when nothing in
 * the ledger actually changed.
 */
export function sameLedgerRows(
  a: readonly LedgerRow[],
  b: readonly LedgerRow[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameLedgerRow(a[i], b[i])) return false
  }
  return true
}

function sameLedgerRow(x: LedgerRow, y: LedgerRow): boolean {
  return (
    x.id === y.id &&
    x.at === y.at &&
    x.kind === y.kind &&
    x.lane === y.lane &&
    x.backupDir === y.backupDir &&
    x.description === y.description &&
    x.committed === y.committed &&
    x.sha === y.sha &&
    x.correlationId === y.correlationId &&
    sameStringArray(x.files, y.files) &&
    sameOptionalStringArray(x.createdFiles, y.createdFiles) &&
    sameStringRecord(x.afterHashes, y.afterHashes)
  )
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameOptionalStringArray(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b
  return sameStringArray(a, b)
}

function sameStringRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export function useEditorLedger(): LedgerApi {
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // F2: the generation of the most recently STARTED `refresh` call. A
  // response only gets applied while its own captured generation still
  // matches this — see the module doc comment's "Request ordering"
  // section.
  const requestIdRef = useRef(0)

  // `quiet` skips the loading spinner — used by the background poll so
  // the Activity panel doesn't flicker every tick.
  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    const requestId = ++requestIdRef.current
    if (!opts?.quiet) setLoading(true)
    try {
      const res = await editorFetch(LEDGER_URL, { method: "GET" })
      const body = (await res.json().catch(() => null)) as
        | { entries?: LedgerRow[]; reason?: string }
        | null
      // A newer `refresh` call has started since this one did — its
      // response is the one that should win once it lands, so applying
      // this older one now would clobber it (F2, codex review round 8,
      // 2026-08-20).
      if (requestId !== requestIdRef.current) return
      if (!res.ok) {
        // A transient failure must not blank the panel — leave `rows` as
        // they were and only surface the error.
        setError(body?.reason ?? `Failed to load the edit ledger (${res.status})`)
        return
      }
      const nextRows = Array.isArray(body?.entries) ? body.entries : []
      setRows((prev) => (sameLedgerRows(prev, nextRows) ? prev : nextRows))
      setError(null)
    } catch (e) {
      // Same reasoning: a thrown fetch (network blip) must not blank the
      // panel either — `rows` is left untouched. Still generation-gated:
      // a superseded call's failure must not overwrite a newer call's
      // (possibly successful) outcome either.
      if (requestId === requestIdRef.current) {
        setError((e as Error).message)
      }
    } finally {
      if (!opts?.quiet && requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Shared tick (P2-1) — see `subscribeToPollTick`'s doc comment in
    // `useEditorBranches.ts`.
    return subscribeToPollTick(() => void refresh({ quiet: true }))
  }, [refresh])

  const undo = useCallback(
    async (id: string): Promise<UndoResult> => {
      try {
        const res = await editorFetch(undoUrl(id), {
          method: "POST",
          headers: JSON_HEADERS,
          body: "{}",
        })
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; reason?: string; code?: LedgerUndoRefusal }
          | null
        if (!res.ok || !body?.ok) {
          // Refused (404 unknown id, 409 drifted/backup-gone/unverifiable,
          // or a 500) — surface the server's `reason` verbatim and do NOT
          // refresh: nothing on disk changed, so the ledger has nothing
          // new to say, and refreshing here would race the caller's own
          // read of this result with a background poll's.
          return {
            ok: false,
            reason: body?.reason ?? `Could not undo (${res.status})`,
            code: body?.code,
          }
        }
        // Undo appended a new `undo` entry and (on the common path)
        // rewrote a file — refresh so `rows` reflects both immediately
        // rather than waiting for the next background poll.
        await refresh()
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    },
    [refresh],
  )

  return { rows, loading, error, refresh, undo }
}

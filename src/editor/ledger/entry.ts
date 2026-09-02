/**
 * Edit-ledger entry types.
 *
 * The ledger is an append-only JSONL log at
 * `<canonicalRoot>/.desde/edit-log.jsonl` — the durable, SEMANTIC
 * record of what each Editor mutation meant, alongside the byte-level
 * record `.desde/backups/` already keeps.
 *
 * Deliberately field-structured, never prose: `fields` holds the edit's
 * own values and `describeLedgerEntry` renders them at display time, so
 * copy can change without rewriting history.
 */

/** Which lane produced the write. */
export type LedgerLane = 'direct' | 'chat' | 'undo'

/** One source mutation. */
export interface LedgerEditEntry {
  type: 'edit'
  /** Stable id — the join key for commit state and for Undo. */
  id: string
  /** ISO 8601. */
  at: string
  /** Branch at write time. Absent when it could not be resolved. */
  branch?: string
  /**
   * The edit kind (`prop`, `swap`, an SDK tool name, …), or `unknown`
   * for a write whose caller supplied no description.
   */
  kind: string
  lane: LedgerLane
  /** Repo-relative paths this write touched. */
  files: string[]
  /** Repo-relative `.desde/backups/<ts>-<uuid>/`, when one was written. */
  backupDir?: string
  /**
   * SHA-256 of each file's content AFTER this write, keyed by repo-relative
   * path. Load-bearing: Plan B's Undo refuses unless the file on disk still
   * hashes to this. A deleted file has no entry.
   */
  afterHashes: Record<string, string>
  /**
   * Repo-relative paths in `files` that did NOT exist before this write —
   * i.e. this edit created them. Recorded from `write-broker.ts`'s own
   * pre-batch snapshots (`!snapshot.existed`), which it already reads for
   * every touched path, so this costs no extra I/O at write time.
   *
   * P1-3 (codex review finding, 2026-08-20): Plan B's Undo used to INFER
   * "this file was created by this edit" from `backupHasFile` returning
   * false — but absence from the backup has two causes, not one: a
   * genuine creation, OR a backup directory that survived while one of
   * its children was removed or became unreadable (an interrupted
   * retention GC is the obvious way). The second case is a plain
   * overwrite, and inferring "created" for it makes Undo DELETE the
   * user's current file. This field turns "created" into something the
   * entry STATES, not something the planner guesses.
   *
   * Absent on an entry written before this field existed. `planLedgerUndo`
   * treats that absence as "can't tell" and refuses rather than falling
   * back to the old guess — see its doc comment.
   */
  createdFiles?: string[]
  /** The edit's own semantic values. Shape varies by `kind`. */
  fields?: Record<string, unknown>
  /**
   * Opaque client-supplied join key (Task 4b) — see
   * `EditRequestBody.correlationId` (`validate-edit-request.ts`) for the
   * full contract. Recorded verbatim, never interpreted. Kept as its own
   * field rather than folded into `fields` because `fields` is rendered by
   * `describeLedgerEntry`; a join key is not a display value and has no
   * business in that switch.
   */
  correlationId?: string
  /**
   * The id of the entry this entry reverts, present only on an entry
   * whose `lane` is `'undo'`. Set once, at undo time, by the CLI's undo
   * route (`http-server.ts`'s `handleLedgerUndoRequest`).
   *
   * **P1-2 (codex review round 3, 2026-08-20).** Undoing an uncommitted
   * edit whose pre-edit bytes happen to match HEAD (the common case: the
   * first edit made since the last commit) makes the working tree clean
   * again — not because a commit happened, but because the restore
   * landed on content that was ALREADY what HEAD holds.
   * `reconcileLedger`'s heuristic ("this entry's files are no longer
   * dirty, so something must have committed them") cannot tell that
   * apart from a real external commit, and durably marked BOTH the
   * original edit and the undo entry itself as committed, forever — the
   * append-only log can never take that back.
   *
   * `reconcileLedger` uses `reverts` to recognise the pair and exclude
   * both from that heuristic: the entry named here (the original edit,
   * whose changes were thrown away, never landed in any commit) and any
   * entry that itself carries `reverts` (an undo entry, whose own
   * "clean" state is exactly what ITS write produced, not evidence of a
   * commit that happened after it). See `reconcileLedger`'s doc comment
   * for why this is safe forever, not merely until the next poll: an
   * undone entry's changes cannot retroactively become committed, and an
   * undo entry's own file only stops matching HEAD if something else
   * edits it again — at which point a real, later commit is free to
   * cover it through the normal `commit`-line path
   * (`captureCommitCoverage`), which requires the file to be freshly
   * DIRTY and is unaffected by this field.
   *
   * **Correction (F1, codex review round 4, 2026-08-20): the exclusion
   * above was permanent, and it should not have been.** An undo entry
   * that restores bytes already matching HEAD reads as clean from the
   * moment it lands — but if the user later commits from a terminal
   * (no product `commit` line is ever written for that), `reverts` kept
   * excluding this entry from the "clean tree implies committed"
   * heuristic forever, so it read "Not committed" even after HEAD had
   * genuinely moved past it. See `headAtWrite`'s doc comment for the fix.
   */
  reverts?: string
  /**
   * The resolved `HEAD` COMMIT (`headSha`, `git-branches.ts` — a
   * `git rev-parse HEAD`, not `.git/HEAD`'s raw bytes) at the moment THIS
   * write landed. Present only on an entry whose `lane` is `'undo'` — set
   * once, alongside `reverts`, by `write-broker.ts`'s ledger-append
   * block.
   *
   * **F1 (codex review round 4, 2026-08-20).** `reconcileLedger` cannot
   * tell "this undo entry's file is clean because ITS OWN restore landed
   * on bytes that already matched HEAD" apart from "this undo entry's
   * file is clean because a REAL commit, landed after the undo, now
   * covers it" — both look identical on disk. `reverts` alone (see that
   * field's doc comment) answers the first question but not the second,
   * and excluding the entry forever was the round-3 fix's mistake: an
   * external terminal commit that happens to cover this file writes no
   * `commit` line, so an entry excluded by `reverts` alone could never
   * self-heal.
   *
   * `headAtWrite` closes that gap: as long as the CURRENT tip commit
   * still equals `headAtWrite`, nothing has happened since the undo
   * besides the undo's own write, so the entry stays excluded (identical
   * to round 3's behaviour). The instant they differ — ANY commit landed
   * since, product or terminal — HEAD has demonstrably moved, and the
   * entry falls back to the SAME dirty/ignored check every ordinary
   * entry already gets. This can never mark the entry committed too
   * early: it only takes effect once something has genuinely happened,
   * and it degrades safely (stays excluded, exactly like before)
   * whenever the fingerprint is unavailable or the entry predates this
   * field.
   *
   * **Not `.git/HEAD`'s raw content, and this is load-bearing, not
   * cosmetic.** `.git/HEAD` is a SYMBOLIC ref — `ref: refs/heads/main` —
   * retargeted only by a checkout/switch/rename. An ordinary commit moves
   * the BRANCH's own ref forward without touching that file at all
   * (MEASURED: byte-identical before and after a commit on the same
   * branch). A first attempt at this fix compared `readGitHeadRaw`
   * (`edit-ledger.ts`) readings instead of `headSha`'s, on the reasoning
   * that the branch-scoping guard already pays for that exact read — it
   * shipped a red test: an external terminal commit never flipped the
   * fingerprint, so the undo entry stayed excluded forever, the ORIGINAL
   * bug this field exists to fix. `headSha` resolves the actual tip
   * commit, which DOES move on every commit, and is the one comparison
   * that can tell "a commit landed" from "nothing happened."
   */
  headAtWrite?: string
}

/**
 * A commit the product itself made. Marks EXACTLY the ids named in
 * `committedIds` as committed — a closed list, not a branch-wide sweep.
 *
 * P1 (round-7 whole-branch review finding, 2026-08-19): earlier rounds had
 * this line mark every pending edit on the SAME BRANCH committed, minus an
 * `excludedIds` exception list (F1, round 5). Round 5's own finding named
 * the correct shape — "identify only paths or edit ids actually
 * included" — and then implemented the opposite: an EXCLUSION list, which
 * is opt-OUT. Anything the write site's exclusion check didn't anticipate
 * got swept in by default. That default caught a second, concurrent
 * Editor process on the same repo (the ledger is deliberately lock-free
 * JSONL FOR this reason — see `edit-ledger.ts`'s module doc): process A
 * commits; process B appends a pending edit after A's `git add -A` already
 * ran but before A's marker lands; a branch-wide sweep (even one with an
 * exclusion list) has no way to tell B's edit apart from one that
 * genuinely predates the commit, and durably marks it committed with A's
 * sha even though it never entered git.
 *
 * The fix is inclusion, not exclusion. `committedIds` is the write site's
 * own OBSERVATION of exactly which pending ids existed on this branch,
 * READ FROM THE LEDGER BEFORE `git add -A` ran (see `captureCommitCoverage`
 * in `http-server.ts`), filtered to the ones whose files are not
 * `.gitignore`d (an id that was pending-and-observed is not the same as an
 * id that was actually staged — `git add -A` never stages an ignored
 * path, independent of when it was observed). Nothing arriving after that
 * read — whether from this same process's next edit or a concurrent one
 * — can appear in the list, because the list is a value captured once,
 * not a predicate evaluated at reducer time. `excludedIds` is gone: an
 * inclusion list has no exclusions to carve out of a sweep, because there
 * is no sweep.
 *
 * A pending edit that really was committed but missed this list (the
 * narrow remaining race — a concurrent write landing between the
 * pre-`git add -A` read and `git add -A` itself) is UNDER-counted, not
 * over-counted: it stays "pending" on this marker and self-heals on the
 * next `reconcileLedger` poll once its file reads clean, this time via a
 * `reconcile` line rather than this `commit` line's `sha`. That is the
 * safe direction for an append-only log — an edit wrongly marked
 * committed can never be un-said, but one that stays pending one poll
 * longer costs nothing.
 */
export interface LedgerCommitEntry {
  type: 'commit'
  at: string
  branch?: string
  sha: string
  message: string
  /**
   * The exact pending edit ids this commit covers — see the interface doc
   * above. A closed list: `resolveCommitState` marks exactly these ids
   * and nothing else, with no branch matching or rename retargeting of
   * its own (that resolution already happened once, correctly, at write
   * time, using the same `resolveEditBranches`/`editBelongsToBranch`
   * helpers the reducer used to reimplement here).
   */
  committedIds: string[]
}

/**
 * Catches commits made outside the product (the user's own terminal).
 * Names exactly the edit ids observed clean, rather than marking
 * everything pending — a terminal commit may cover only some files.
 */
export interface LedgerReconcileEntry {
  type: 'reconcile'
  at: string
  committedIds: string[]
}

/**
 * Records a branch rename (the Branch menu's Rename, `git branch -m
 * <from> <to>`). Every earlier `edit`/`commit` line still carries `from`
 * as its `branch` — the log is append-only, nothing gets rewritten — so
 * this is what lets a branch-scoped read (P2-3, whole-branch review
 * finding 2026-08-18) recognise that an entry recorded under the OLD name
 * belongs to the SAME branch under its new one. See
 * `resolveEditBranches` in `rename-aliases.ts`.
 */
export interface LedgerRenameEntry {
  type: 'rename'
  at: string
  from: string
  to: string
}

export type LedgerEntry =
  | LedgerEditEntry
  | LedgerCommitEntry
  | LedgerReconcileEntry
  | LedgerRenameEntry

/** What a caller of `brokeredWrite` supplies. The broker adds the rest. */
export interface EditDescription {
  kind: string
  lane: LedgerLane
  fields?: Record<string, unknown>
  /** See `LedgerEditEntry.correlationId`. */
  correlationId?: string
  /** See `LedgerEditEntry.reverts`. */
  reverts?: string
}

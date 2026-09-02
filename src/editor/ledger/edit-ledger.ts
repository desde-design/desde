/**
 * The edit ledger's disk layer.
 *
 * JSONL, append-only, at `<canonicalRoot>/.desde/edit-log.jsonl` —
 * alongside `backups/` and `chat-sessions/`, and for the same reason the
 * backup journal is per-operation: appends from concurrent Editor
 * processes on one repo must not need a lock. A single `appendFile` of
 * one line under the typical entry size is atomic enough for that; a torn
 * line after a crash is tolerated on read rather than prevented on write.
 *
 * Every function here is best-effort. A ledger failure must never fail a
 * source write (see `brokeredWrite`'s `describe` hook), so `append`
 * swallows its errors and `read` returns what it could parse.
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

import { currentBranch } from '../worktree/git-branches'
import type { LedgerEditEntry, LedgerEntry } from './entry'
import { resolveCommitState } from './commit-state'
import { editBelongsToBranch, resolveEditBranches } from './rename-aliases'
import { normalizeLedgerPath } from './normalize-path'

export function ledgerPath(canonicalRoot: string): string {
  return join(canonicalRoot, '.desde', 'edit-log.jsonl')
}

/** SHA-256 hex of a file's content. The Undo drift check compares these. */
export function hashContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Whether `path` is missing, empty, or already ends in a newline.
 *
 * A crash can leave a torn final line with no trailing newline. Without
 * this check, the next `appendFile` glues its own JSON onto the tail of
 * that torn line, corrupting the NEW entry too — not just the old one.
 * Reads only the final byte, not the whole file.
 */
async function endsWithNewlineOrAbsent(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await handle.read(buf, 0, 1, size - 1)
    return buf.toString('utf8') === '\n'
  } catch {
    // Missing (or otherwise unreadable) — nothing to glue onto.
    return true
  } finally {
    await handle?.close()
  }
}

export async function appendLedgerEntry(
  canonicalRoot: string,
  entry: LedgerEntry,
): Promise<void> {
  try {
    const path = ledgerPath(canonicalRoot)
    await mkdir(dirname(path), { recursive: true })
    const prefix = (await endsWithNewlineOrAbsent(path)) ? '' : '\n'
    await appendFile(path, `${prefix}${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    // Non-fatal by contract: the source write already landed.
    console.warn('edit-ledger: append failed (entry lost):', err)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

/**
 * Validates the fields a consumer actually reaches into, not merely the
 * `type` discriminant. A torn append can survive `JSON.parse` as valid but
 * INCOMPLETE JSON — `{"type":"edit"}` parses fine — and checking only
 * `type` let a line like that reach every reader as a well-formed
 * `LedgerEntry`, TypeScript's static types notwithstanding (this is a
 * runtime boundary; `as LedgerEntry` proves nothing). The edit-ledger
 * route is the first caller that renders an entry (`describeLedgerEntry`
 * reads `entry.files[0]` unconditionally), so a missing `files` used to
 * throw there. Skipping it here, alongside the already-tolerated
 * unparseable line, keeps `readLedger`'s contract the same for both: a
 * corrupt line is dropped, never surfaced as a malformed object.
 */
function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.at !== 'string') return false
  switch (v.type) {
    case 'edit':
      return (
        typeof v.id === 'string' &&
        typeof v.kind === 'string' &&
        typeof v.lane === 'string' &&
        isStringArray(v.files) &&
        typeof v.afterHashes === 'object' &&
        v.afterHashes !== null &&
        !Array.isArray(v.afterHashes) &&
        // P2-2 (codex review round 6, 2026-08-20): `createdFiles` was
        // added (P1-3, round 5) without extending this check, so a
        // malformed line with e.g. `createdFiles: "src/App.vue"` passed
        // straight through as a well-typed `LedgerEntry`. Two consumers
        // trust the field structurally, not just by reading it:
        // `activity-row.tsx`'s `changeTypeForRow`/`undoAvailability` call
        // `.includes()` on it — an OBJECT or NUMBER there crashes the
        // Activity render, and a STRING silently does JS substring
        // matching instead of array membership (`"src/App.vue".includes
        // ("App.vue")` is true), which can misclassify a row AND feed the
        // same bad value into `planLedgerUndo`, where it is exactly the
        // signal that authorizes a DELETE. Required to be `undefined` or
        // a genuine `string[]` — same shape `isStringArray` already
        // enforces for `files`.
        (v.createdFiles === undefined || isStringArray(v.createdFiles))
      )
    case 'commit':
      // `committedIds` is REQUIRED (P1, round-7 whole-branch review
      // finding, 2026-08-19) — a `commit` line with no closed id list has
      // no safe interpretation under the inclusion design
      // (`LedgerCommitEntry`'s doc comment): treating a missing list as
      // "cover everyone pending on this branch" is exactly the exclusion-
      // by-default sweep this round replaced, and treating it as "cover
      // no one" silently invents a claim the line was never asked to
      // make. A pre-round-7 `commit` line (written under the old
      // branch-sweep-plus-`excludedIds` shape) fails this check and is
      // dropped by `readLedger`, same as any other malformed line — the
      // pending edits it used to cover simply fall back to `pending`
      // until `reconcileLedger`'s own from-scratch dirty check catches
      // them (with no sha, same self-heal path an under-counted
      // `committedIds` list already relies on). This product has no
      // durable-format back-compat guarantee across rounds; see
      // CLAUDE.md's product-positioning note on pre-release iteration.
      return typeof v.sha === 'string' && typeof v.message === 'string' && isStringArray(v.committedIds)
    case 'reconcile':
      return isStringArray(v.committedIds)
    case 'rename':
      return typeof v.from === 'string' && typeof v.to === 'string'
    default:
      return false
  }
}

/**
 * Whether `backupDir` — read verbatim from a ledger line, and the ledger
 * file (`.desde/edit-log.jsonl`) lives INSIDE the repository, so
 * every field in it is attacker-controlled for anyone who can get a
 * repo opened in the Editor — lexically resolves inside
 * `<canonicalRoot>/.desde/backups/`.
 *
 * P1 (codex review round 5, 2026-08-20, SECURITY). This is a
 * DEFENSE-IN-DEPTH pre-filter at the ledger's disk layer, not the
 * authoritative guard: it is purely lexical (`path.resolve`, no
 * `fs.realpath`), because `readLedger` runs on every ledger poll and a
 * per-entry filesystem round trip here would multiply that cost for a
 * check that still has to happen again at the point of actual use — a
 * symlink planted inside `.desde/backups/` pointing outside it
 * would pass this check and still needs catching there. The
 * AUTHORITATIVE check (realpath, immediately before any stat/read) lives
 * in `editor-cli/src/server/http-server.ts`'s `createRealUndoDeps` —
 * see its doc comment for the concrete exploit both checks close.
 *
 * This one exists so every OTHER consumer of `readLedger`'s output
 * inherits a truthful value without having to know the escape trick
 * itself: today, the ledger GET route's display of `backupDir` and the
 * client's own `undoAvailability` precomputation (`activity-row.tsx`).
 */
function isBackupDirContained(canonicalRoot: string, backupDir: string): boolean {
  const root = join(canonicalRoot, '.desde', 'backups')
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  const candidate = resolvePath(canonicalRoot, backupDir)
  return candidate === root || candidate.startsWith(rootWithSep)
}

/**
 * Strip `backupDir` from an `edit` entry whose value fails
 * {@link isBackupDirContained}. Every OTHER field is passed through
 * unchanged — a corrupt/hostile `backupDir` doesn't disqualify the rest
 * of the entry (reconciliation, the horizon count, and the Activity row
 * itself all still need it). The result reads exactly like an entry that
 * never took a backup: see `LedgerEditEntry.backupDir`'s doc comment and
 * `undo-entry.ts`'s backup-cases table — `planLedgerUndo` already treats
 * an absent `backupDir` as "prove this was a creation via `createdFiles`,
 * or refuse," which is the correct, safe answer for a value that was
 * never a real backup location to begin with.
 */
function sanitizeLedgerEntry(canonicalRoot: string, entry: LedgerEntry): LedgerEntry {
  if (entry.type !== 'edit' || entry.backupDir === undefined) return entry
  if (isBackupDirContained(canonicalRoot, entry.backupDir)) return entry
  const { backupDir: _escapedBackupDir, ...sanitized } = entry
  return sanitized
}

export async function readLedger(canonicalRoot: string): Promise<LedgerEntry[]> {
  let raw: string
  try {
    raw = await readFile(ledgerPath(canonicalRoot), 'utf8')
  } catch {
    // ENOENT is the ordinary case for a repo that has had no edits yet.
    return []
  }
  const entries: LedgerEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      // A torn append usually survives as unparseable JSON (caught below),
      // but a torn append can also land ON a field boundary and still
      // parse — `{"type":"edit"}` is valid JSON missing everything else.
      // `isLedgerEntry` checks the fields each entry type actually needs,
      // not just `type`, so that case is skipped here too rather than
      // reaching a consumer as a well-formed-looking entry.
      if (isLedgerEntry(parsed)) entries.push(sanitizeLedgerEntry(canonicalRoot, parsed))
    } catch {
      continue
    }
  }
  return entries
}

/**
 * Branch at write time, validated on EVERY call against `.git/HEAD`
 * rather than trusted for a fixed window.
 *
 * P2-1 (round-3 whole-branch review finding, 2026-08-19): the original
 * design cached the resolved name for a flat 5-second TTL and relied on
 * `invalidateBranchCache` (below) firing from the product's OWN branch
 * handlers to clear it early on a switch/create/rename. That closes the
 * in-product case, but a user who runs `git checkout` / `git switch` /
 * `git branch -m` from their OWN terminal triggers no handler at all —
 * for up to 5 seconds afterward, `resolveBranchCached` kept answering
 * with the OLD name. Two "durable decisions" read this function, and
 * both are permanent mistakes once made: an edit lands stamped with the
 * wrong branch (the ledger route's branch filter then hides it forever —
 * the log is append-only, nothing rewrites a bad `branch` field), and a
 * ledger GET's reconcile pass can check an OLD branch's pending edits
 * against the NEW checkout's working-tree cleanliness (the exact
 * cross-branch corruption the branch-scoping fix, round 1's P2-1/P2-3,
 * exists to prevent — reachable again here, through the cache rather
 * than through the reconcile logic itself). TTL expiry repairs neither:
 * by the time it fires, the wrong write already happened.
 *
 * The fix validates freshness against `.git/HEAD` on every single call
 * instead of trusting a time window. `.git/HEAD` is the exact on-disk
 * fact `git symbolic-ref` itself reads to answer "what branch is
 * checked out" — a plain `ref: refs/heads/<name>` line for an ordinary
 * checkout, retargeted the INSTANT a switch, create, or rename (which
 * renames the checked-out ref) changes what's checked out, regardless of
 * whether that happened through this product or a bare terminal command.
 * A branch rename while that branch is checked out also retargets this
 * file (git keeps HEAD pointed at the current branch's new name), so the
 * same check covers renames too. Comparing raw file content this way
 * needs no `git` spawn at all in the common case — a single small file
 * read is far cheaper than a subprocess, which is what actually justifies
 * keeping a cache: this still avoids spawning `git` once per file in a
 * burst of edits (e.g. an llm-patch touching a dozen files at once, all
 * landing between two branch changes), it just no longer trusts a time
 * window to decide whether the last spawn's answer still holds.
 *
 * A read failure — any I/O error reading either HEAD location `readGitHeadRaw`
 * below knows about — degrades to "treat the cache as a miss" and falls
 * through to a real `currentBranch()` spawn, never to a throw: this
 * function's contract is to never throw, and the worst case here is one
 * avoidable spawn, not a wrong answer.
 *
 * A `currentBranch()` FAILURE is a separate case from a read failure
 * above, and needs its own rule (F1, round-9 whole-branch review
 * finding, 2026-08-19). `currentBranch` never throws — it resolves
 * `null` both when HEAD is genuinely detached (there is no branch, and
 * that answer is correct and STABLE) and when its own `git symbolic-ref`
 * spawn merely failed transiently (a git lock, a momentary spawn
 * failure) while a branch is actually checked out. Caching `null`
 * un-conditionally conflated the two: a transient failure landing while
 * HEAD is symbolic got cached against that HEAD's fingerprint exactly
 * like a real detached HEAD would, and every later call returned
 * `undefined` with no retry until HEAD's bytes next changed — which, on
 * an otherwise idle branch, might be never. The two decisions that read
 * this function are both permanent mistakes once made (see the P2-1
 * writeup above), so a whole run of edits could land with no branch
 * recorded, and the ledger route's branch filter treats a no-branch
 * entry as eligible on EVERY branch — permanently un-scoping them.
 *
 * The fix distinguishes the two using the SAME raw HEAD content already
 * read above, at no extra `git` cost: a symbolic HEAD starts with
 * `ref:` (an ordinary checkout, branch genuinely exists); anything else
 * (a bare sha) is detached. `null` is cached, as before, only when HEAD
 * is NOT symbolic. A `null` on a symbolic HEAD is left uncached, so the
 * very next call re-spawns `currentBranch()` instead of trusting a
 * one-off failure forever.
 */
const branchCache = new Map<string, { name: string | null; head: string }>()

/**
 * Raw HEAD content — `ref: refs/heads/<name>\n` for an ordinary checkout,
 * or a bare 40-char sha for a detached HEAD. Retargeted the instant a
 * switch/create/rename/checkout changes what's checked out, so two reads
 * that come back equal are proof nothing moved in between (used by
 * `resolveBranchCached` below, and as a before/after fingerprint by the
 * ledger route's reconcile step — see `handleLedgerRequest` in
 * `http-server.ts`).
 *
 * WORKTREE-AWARE (fixed 2026-08-19, closing a round-8 residual risk).
 * `<root>/.git/HEAD` is only where an ORDINARY checkout keeps HEAD. A
 * linked git worktree (`git worktree add`) instead leaves a `.git` FILE
 * at that path — a single `gitdir: <path>` line pointing at
 * `<main-repo>/.git/worktrees/<name>`, where that worktree's OWN HEAD
 * actually lives. Before this fix, both callers of this function read
 * `<root>/.git/HEAD` directly, got ENOENT in a worktree checkout, and
 * silently treated that as "no change detected" — the branch-freshness
 * check in `resolveBranchCached` always said the cache was fine, and the
 * round-8 before/after fingerprint in the ledger route always said HEAD
 * held still, regardless of whether either was true. This repo itself is
 * a linked worktree, so both guards were inert on this very branch.
 *
 * The fix tries the ordinary path first (zero extra cost for the common,
 * non-worktree case) and falls back to resolving the `gitdir:` pointer
 * only when that fails — the gitdir path git writes is normally
 * absolute, but a relative one is resolved against `root` too.
 *
 * Still returns `undefined` on any read failure, including a genuinely
 * missing/unreadable `.git` — never a throw. A caller comparing two
 * `undefined` reads must NOT treat that as "no change detected" — see
 * the guard in `handleLedgerRequest` (`http-server.ts`), which was
 * tightened alongside this fix to skip reconciliation whenever a
 * fingerprint is unavailable, rather than proceeding on a vacuous match.
 */
export async function readGitHeadRaw(root: string): Promise<string | undefined> {
  try {
    return (await readFile(join(root, '.git', 'HEAD'), 'utf8')).trim()
  } catch {
    // Falls through when `.git` is not an ordinary directory — most
    // likely a linked worktree, where `.git` is a `gitdir:` pointer file.
    try {
      return (await readFile(await resolveWorktreeHeadPath(root), 'utf8')).trim()
    } catch {
      return undefined
    }
  }
}

/**
 * Resolves the on-disk HEAD path for a linked git worktree from its
 * `.git` pointer file's `gitdir: <path>` line. Throws on any failure
 * (missing/malformed pointer, unreadable target) — the sole caller above
 * catches and degrades to `undefined`, matching this module's
 * never-throw contract at the public boundary.
 */
async function resolveWorktreeHeadPath(root: string): Promise<string> {
  const pointer = (await readFile(join(root, '.git'), 'utf8')).trim()
  const match = /^gitdir:\s*(.+)$/.exec(pointer)
  const gitDir = (match ? match[1] : pointer).trim()
  const resolvedGitDir = isAbsolute(gitDir) ? gitDir : join(root, gitDir)
  return join(resolvedGitDir, 'HEAD')
}

/**
 * `resolveBranchCached`'s answer, bundled with the exact `.git/HEAD`
 * fingerprint it was resolved against.
 *
 * F1 (round-10 whole-branch review finding, 2026-08-19): a caller that
 * also needs a HEAD fingerprint to bracket a later status snapshot (the
 * ledger route's reconcile guard — `handleLedgerRequest` in
 * `http-server.ts`) used to call `resolveBranchCached` for the name, then
 * take a SEPARATE `readGitHeadRaw` read afterward as its "before"
 * fingerprint. That left a gap between the two calls — an external
 * checkout (a `git checkout` in the user's own terminal, or a second
 * Editor process) landing in it moved HEAD in a way neither read could
 * see: both the "before" and the later "after" fingerprint ended up
 * reading the NEW checkout, so the bracket's equality check reported
 * "HEAD held still" while `branch` actually named the OLD one. Bundling
 * the name and the fingerprint from the SAME read closes the gap by
 * construction — there is no window between resolving the branch and
 * capturing its fingerprint for a checkout to land in, because they are
 * one call.
 */
export interface BranchResolution {
  readonly name: string | undefined
  readonly head: string | undefined
}

async function resolveBranchCachedInternal(root: string): Promise<BranchResolution> {
  const head = await readGitHeadRaw(root)
  const hit = branchCache.get(root)
  if (hit && head !== undefined && head === hit.head) return { name: hit.name ?? undefined, head }
  const name = await currentBranch(root)
  // F1 (round-9 whole-branch review finding, 2026-08-19): a `null` here
  // on a SYMBOLIC HEAD (`ref: refs/heads/<name>` — a branch genuinely is
  // checked out) means `currentBranch`'s own git spawn failed
  // transiently, not that there is no branch. Caching that would freeze
  // the wrong answer in place until HEAD's bytes next change — see the
  // doc comment above. Leave it uncached so the next call retries; a
  // genuinely detached HEAD (no `ref:` prefix) is unaffected and still
  // caches below, same as before this fix.
  if (name === null && head !== undefined && head.startsWith('ref:')) return { name: undefined, head }
  branchCache.set(root, { name, head: head ?? '' })
  return { name: name ?? undefined, head }
}

export async function resolveBranchCached(root: string): Promise<string | undefined> {
  return (await resolveBranchCachedInternal(root)).name
}

/**
 * Same resolution as `resolveBranchCached`, but also returns the
 * `.git/HEAD` fingerprint it was read against — see `BranchResolution`'s
 * doc comment above for why a caller that needs both must get them from
 * one call, not two.
 */
export async function resolveBranchCachedWithHead(root: string): Promise<BranchResolution> {
  return resolveBranchCachedInternal(root)
}

/**
 * Drop the cached branch for `root` — call this the moment a switch /
 * create / rename actually lands, from the same handler that already
 * calls `invalidateGitStatusCache` for the same mutation (that call is
 * the established precedent this follows).
 *
 * `resolveBranchCached` (above) now validates itself against
 * `.git/HEAD` on every call, so this is no longer the thing standing
 * between a mutation and a correct answer — the very next call already
 * self-corrects, in-product or from a terminal, the instant HEAD's bytes
 * change. This is kept anyway, both because it's harmless (deleting a
 * Map entry that would already be treated as stale costs nothing) and
 * because it makes the very next lookup skip straight to a fresh spawn
 * instead of paying for a `.git/HEAD` read that would only confirm what
 * this call site already knows just happened.
 */
export function invalidateBranchCache(root: string): void {
  branchCache.delete(root)
}

/**
 * Catch commits made outside the product.
 *
 * ## The root inference (LIVE SMOKE FINDING, 2026-08-20)
 *
 * Until this fix, this function decided an edit reached git by asking
 * exactly one question: is the file clean in `git status`? That is not
 * proof. `git checkout -- <file>` also makes a file clean, with no commit
 * anywhere — it just throws the edit's bytes away and restores whatever
 * HEAD already held. Driving the real Editor against a real repo: make an
 * edit, discard it with `git checkout --`, and this function marked it
 * **Committed**. The ledger is append-only, so that false claim was
 * permanent — the Activity panel would say "Committed" about an edit the
 * user's own action had just deleted, forever.
 *
 * Three earlier review rounds each found and fixed one way "clean" can lie
 * without being a commit — an ignored file (see the CORRECTION below), an
 * undo landing back on already-matching content, an untracked directory
 * collapsing in porcelain output (fixed at the `git status` layer, in
 * `listDirtyRepoRelativePaths`, not here). Each fix closed one symptom.
 * None of them closed the actual gap, which is that "clean" was ever being
 * treated as sufficient in the first place — a file can be clean because
 * an edit landed in a commit, or clean because it never did and something
 * else (a checkout, a reset, a stash pop) put it back the way it was
 * before. Those two states are indistinguishable from `git status` alone.
 *
 * The fix: an entry is marked committed only when its files are clean
 * **and** the CURRENT HEAD commit's content for every one of those files
 * hash-equals the entry's own `afterHashes` — i.e. HEAD is not merely
 * silent about the file, it is holding the exact bytes this edit
 * produced. "Clean" narrows the search; `matchesHeadContent` is the actual
 * proof. A discarded edit fails this immediately: HEAD still holds
 * whatever it held before the edit, which — because the deterministic and
 * LLM write lanes both refuse a no-op write (see CLAUDE.md's "No-op write
 * guard") — is never byte-identical to what the edit itself produced.
 *
 * `isDirty` is injected rather than shelled out to, so this is testable
 * without git; the caller supplies it from the working-tree change list
 * it already polls. It stays a REQUIRED precondition alongside
 * `matchesHeadContent`, not replaced by it: "clean" and "HEAD holds this
 * edit's bytes" are two different facts, and requiring both is strictly
 * more conservative than either alone (a file could theoretically read
 * dirty right now because of a LATER, unrelated edit, even though HEAD
 * already captured THIS entry's content in an earlier commit — keeping
 * `isDirty` means that case under-counts rather than over-counts, and
 * under-counting is this function's established safe direction — see the
 * `currentBranch` paragraph below).
 *
 * ## CORRECTION: `isIgnored` is REMOVED, not kept alongside the new check
 *
 * Until this fix, `isIgnored` was a second required predicate (P2, round-4
 * whole-branch review finding, 2026-08-19), added because `git status`
 * never reports an ignored path as dirty, so a `.gitignore`d file used to
 * look "clean" for the same wrong reason a genuinely committed one does.
 *
 * That reasoning was sound, but the fact it was patching is now provably a
 * SUBSET of what `matchesHeadContent` already excludes, not a separate
 * case beside it. MEASURED (2026-08-20, real git): a file `git status
 * --ignored=matching` reports as ignored is *always* untracked — git does
 * not classify an already-tracked path as "ignored" even once a later
 * `.gitignore` rule would otherwise match it; a tracked file that matches
 * a gitignore pattern still shows up as an ordinary modified/clean file,
 * never in the ignored section (verified directly: `git add` + commit a
 * file, gitignore it afterward, edit it — `git status` reports it
 * `modified`, not `ignored`). An untracked path has no blob at HEAD at
 * all, so `matchesHeadContent` — which needs a HEAD blob to compare
 * against — can only ever answer "no" for it. There is no path through
 * which removing the `isIgnored` parameter lets an ignored file slip
 * through as committed; the new check refuses it for an even more direct
 * reason (HEAD has nothing to show) than the old one did (this path is on
 * the ignore list). Keeping a parameter that can no longer change the
 * answer would be exactly the "dead belt-and-braces" this file's own
 * history warns against — every prior special case here EARNED its
 * keep by covering something the general rule didn't. This one no longer
 * does, so it's gone: `isIgnoredPath` itself is untouched and still used
 * elsewhere (the commit-coverage capture in `http-server.ts`), only its
 * use as a SEPARATE gate here is removed.
 *
 * `entries` is CALLER-SUPPLIED, not re-read from disk here (P1, round-4
 * whole-branch review finding, 2026-08-19). This used to call
 * `readLedger` itself, which meant the caller's own read order was:
 * take the `git status` snapshot, THEN call this function, which re-read
 * the ledger AFTER that snapshot. An edit landing in between — the
 * ordinary case, since the panel polls the ledger route continuously —
 * appends its `edit` line after the snapshot was taken, so its file is
 * not in the snapshot's dirty set. The re-read then saw that new entry,
 * checked it against a dirty set that predates its own file write, found
 * it "clean," and durably marked it committed. The log is append-only,
 * so that mistake could never be undone on a later poll.
 *
 * The fix moves entry-reading OUT of this function and onto the caller,
 * with an ordering requirement stated in words because nothing in the
 * types can enforce it: **the caller must read the ledger BEFORE taking
 * the dirty-status snapshot**, then pass that same entry list here.
 * Every producer writes its file(s) to disk and only THEN appends its
 * ledger entry (see e.g. `write-broker.ts`, `edit-handler.ts`'s
 * mini-turn path) — so any entry visible in a read taken before the
 * status snapshot is guaranteed to already have its file's write
 * reflected in that snapshot. An entry appended AFTER the read simply
 * isn't in `entries` at all, so this function never considers it this
 * round — it becomes a candidate on the NEXT poll, once a status
 * snapshot taken after its write can actually see it. Do not "optimise"
 * this back into a re-read: that is exactly the bug.
 *
 * `currentBranch` scopes reconciliation to the checked-out branch — the
 * SAME rule the ledger route already applies when it builds display rows
 * (`editBelongsToBranch`), applied here too so an entry never gets marked
 * committed without ever being shown as such. An entry with no recorded
 * branch is always eligible, since we cannot prove it is foreign; an
 * entry WITH a recorded branch is eligible when it resolves to
 * `currentBranch` through `resolveEditBranches` — which follows a rename
 * only if it happened AFTER the entry, so reusing a freed-up branch name
 * doesn't fold an unrelated branch's edits into this one (P2-3 or B1,
 * whole-branch review findings — a rename must not orphan reconcile's
 * view of a branch's own pending edits any more than it orphans the read
 * route's, and reusing a name must not merge two unrelated branches'
 * history either). An unresolvable `currentBranch` (`undefined`) excludes
 * every branch-tagged entry — same as the route's row filter would.
 * Without any of this, a stash-and-switch would check ANOTHER branch's
 * pending edits against the CURRENT tree's cleanliness and durably mark
 * them committed (whole-branch review finding, 2026-08-18).
 *
 * **The entry an undo reverts is excluded from the "clean means
 * committed" heuristic PERMANENTLY (P1-2, codex review round 3,
 * 2026-08-20).** Undoing an uncommitted edit whose pre-edit bytes happen
 * to already match HEAD (the common case: the first edit since the last
 * commit) makes the file clean again — not because anything was
 * committed, but because the restore landed on content that already
 * equalled HEAD's. `LedgerEditEntry.reverts` (set on an undo entry,
 * naming the entry it reverts) is how this function recognises the
 * REVERTED entry and excludes it: its changes were thrown away and never
 * reached any commit, so no later HEAD movement can ever make that
 * retroactively true. See `LedgerEditEntry.reverts`'s own doc comment.
 *
 * **This guard is very likely subsumed by `matchesHeadContent` too, and is
 * kept anyway.** The reverted entry's own `afterHashes` records the bytes
 * the ORIGINAL edit produced; after the undo, disk (and therefore HEAD,
 * untouched by any of this) holds the PRE-edit bytes instead — a
 * different value, guaranteed by the no-op-write guard every write lane
 * enforces (an edit that changes nothing is refused before it's ever
 * journaled, so a real edit's `afterHashes` can never equal what preceded
 * it). So `matchesHeadContent` should independently refuse the reverted
 * entry on its own. The difference from the `isIgnored` case above: that
 * subsumption is a fact about `git`'s OWN status semantics, directly
 * measured; this one leans on an invariant enforced in a DIFFERENT module
 * (the write lanes' no-op guard, not this file), which this function has
 * no way to see or verify. A guard that costs nothing to keep — this is a
 * plain `Set` built from data already in hand, no extra git call — and
 * that protects against a fact this file can't check for itself is not
 * the "dead belt-and-braces" the `isIgnored` removal above is avoiding;
 * it's a local backstop for a cross-module promise. Kept.
 *
 * **The undo entry ITSELF is excluded only until HEAD moves past it (F1,
 * codex review round 4, 2026-08-20 — a correction to round 3's fix,
 * which excluded it permanently too).** An undo entry's own "clean"
 * state is, at write time, exactly what ITS OWN restore produced — not
 * evidence of a commit. But unlike the reverted entry above, the undo
 * entry's bytes DO stay on disk, and a later commit — including one made
 * from the user's own terminal, which appends no `commit` line at all —
 * can genuinely come to cover them. Permanently skipping it (round 3's
 * fix) meant that case could never self-heal: the entry read "Not
 * committed" forever, even after HEAD had moved on. `headFingerprint`
 * (below) is compared against the fingerprint `write-broker.ts` recorded
 * on the entry as `headAtWrite`: while they still match, nothing has
 * happened since the undo besides the undo's own write, so the old
 * exclusion still applies; the moment they differ, HEAD has genuinely
 * moved, and the entry falls through to the SAME dirty/positive-evidence
 * check every ordinary entry gets. See `LedgerEditEntry.headAtWrite`'s
 * own doc comment for the full reasoning, including why this never marks
 * an entry committed too early.
 *
 * **This one is NOT subsumed by `matchesHeadContent` — it stays load-
 * bearing.** The whole point of an undo's restore is to reproduce content
 * that (in the common case) ALREADY equals HEAD's, since it's putting the
 * file back to what HEAD held before the now-reverted edit. That means
 * the undo entry's OWN `afterHashes` trivially passes `matchesHeadContent`
 * the instant it's written, with no commit involved at all — the exact
 * opposite of the reverted-entry case above, where content divergence is
 * what protects it. Dropping this bracket would make the fix in this
 * function re-introduce, for undo entries specifically, the identical bug
 * it exists to close everywhere else: cleanliness (here, "restored content
 * happens to equal HEAD") standing in for proof of a commit.
 *
 * @param entries The ledger's entries, from a read taken BEFORE the
 *   `isDirty` snapshot was captured — see the ordering note above. The
 *   caller's `matchesHeadContent` closure must also be built from data
 *   read no earlier than that same point (see `handleLedgerRequest` in
 *   `http-server.ts`), for the identical reason: a HEAD read taken before
 *   an entry existed can't prove anything about that entry.
 * @param matchesHeadContent Whether the CURRENT `HEAD` commit's content
 *   for `repoRel` hashes to `expectedHash` (which the caller reads off
 *   the entry's own `afterHashes[file]` before calling this). This is the
 *   POSITIVE evidence described above — see the "root inference" section
 *   for why `isDirty` alone was never enough. Conservative on every axis
 *   that can fail: a path HEAD holds nothing for, a path the caller
 *   couldn't read, or a caller that simply doesn't know yet, must all
 *   answer `false` here — never `true` on a guess. The git access this
 *   needs lives at the call site (`readHeadBlobs`, `git-branches.ts`),
 *   not in this file — see this module's own doc comment on why the
 *   ledger's disk layer stays I/O-free apart from its own JSONL file.
 * @param headFingerprint The CURRENT resolved `HEAD` commit (`headSha`,
 *   `git-branches.ts`) — deliberately NOT `readGitHeadRaw`'s raw
 *   `.git/HEAD` bytes, which name a SYMBOLIC ref and stay byte-identical
 *   across an ordinary commit (MEASURED — see `LedgerEditEntry.headAtWrite`'s
 *   doc comment for the full story, including the first version of this
 *   fix that used the wrong one and shipped a red test). Compared only
 *   against entries carrying `headAtWrite`, which was captured with the
 *   SAME function at write time, so the two are always comparing like
 *   with like. `undefined` (unresolvable, or a caller that hasn't been
 *   updated to pass one) is treated exactly like "HEAD hasn't moved" —
 *   the conservative direction, matching this function's existing rule
 *   that an unprovable fact never advances a durable write.
 * @returns the ids newly marked committed (empty when nothing changed).
 */
export async function reconcileLedger(
  canonicalRoot: string,
  entries: readonly LedgerEntry[],
  isDirty: (repoRel: string) => boolean,
  matchesHeadContent: (repoRel: string, expectedHash: string) => boolean,
  currentBranch?: string,
  headFingerprint?: string,
): Promise<string[]> {
  const state = resolveCommitState(entries)
  const resolvedBranches = resolveEditBranches(entries)
  const newlyCommitted: string[] = []
  // P1-2 (codex review round 3, 2026-08-20): every entry an undo entry
  // names via `reverts` — the ORIGINAL entry whose changes were undone.
  // See the function doc comment's "undo/original pair" section for why
  // this is kept even though `matchesHeadContent` below very likely
  // already excludes the same entries on its own.
  const revertedEntryIds = new Set(
    entries
      .filter((e): e is LedgerEditEntry => e.type === 'edit' && e.reverts !== undefined)
      .map((e) => e.reverts!),
  )

  for (const entry of entries) {
    if (entry.type !== 'edit') continue
    if (!editBelongsToBranch(resolvedBranches.get(entry.id), currentBranch)) continue
    if (state.get(entry.id)?.committed) continue
    if (entry.files.length === 0) continue
    // The reverted entry (the ORIGINAL edit an undo threw away) can
    // never be proven committed from cleanliness — see the function doc
    // comment's first section. This one has no expiry.
    if (revertedEntryIds.has(entry.id)) continue
    // F1 (codex review round 4, 2026-08-20, correcting round 3's P1-2):
    // the undo entry ITSELF stays excluded only while HEAD still matches
    // the fingerprint recorded at its own write time — see the function
    // doc comment's second section and `LedgerEditEntry.headAtWrite`.
    // `undefined` on either side (no current fingerprint, or an entry
    // written before this field existed) is treated as "still matches" —
    // the same conservative default this function already applies
    // everywhere else.
    if (
      entry.reverts !== undefined &&
      (headFingerprint === undefined ||
        entry.headAtWrite === undefined ||
        headFingerprint === entry.headAtWrite)
    ) {
      continue
    }
    // P1-2 (round-3 whole-branch review finding, 2026-08-19): `f` may
    // carry backslash separators from a pre-fix entry written by the
    // OLD, unnormalized `repoRelOf` (Windows) — the append-only log can
    // never be corrected in place. `isDirty`'s own set is git porcelain
    // output, which is always forward-slash regardless of OS, so this
    // normalizes ONLY the ledger side of the comparison. See
    // `normalizeLedgerPath`'s doc comment for the full picture (producer
    // fix + every comparison/display site).
    if (entry.files.some((f) => isDirty(normalizeLedgerPath(f)))) continue
    // LIVE SMOKE FINDING (2026-08-20) — the fix this function exists for.
    // "Clean" narrows the search; this is the actual proof. EVERY file
    // must independently hash-match — partial evidence on a multi-file
    // entry is not evidence for the files that didn't match, and writing
    // "committed" for the whole entry anyway would be exactly the wrong
    // permanent marker this function must never produce. `expected`
    // absent (an entry with no recorded hash for this file at all) is
    // "nothing to prove a match with," not "no expectation, so anything
    // passes" — same conservative default as an unresolvable
    // `currentBranch`/`headFingerprint` above.
    if (
      !entry.files.every((f) => {
        const expected = entry.afterHashes[f]
        return expected !== undefined && matchesHeadContent(normalizeLedgerPath(f), expected)
      })
    ) {
      continue
    }
    newlyCommitted.push(entry.id)
  }

  if (newlyCommitted.length === 0) return []
  await appendLedgerEntry(canonicalRoot, {
    type: 'reconcile',
    at: new Date().toISOString(),
    committedIds: newlyCommitted,
  })
  return newlyCommitted
}

/** Narrowing helper for callers that only care about edits. */
export function editEntries(entries: readonly LedgerEntry[]): LedgerEditEntry[] {
  return entries.filter((e): e is LedgerEditEntry => e.type === 'edit')
}

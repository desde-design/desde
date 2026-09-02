import { sep as platformSep } from 'node:path'

/**
 * Normalize a repo-relative path to forward-slash separators — but only
 * where a backslash actually IS a path separator.
 *
 * P1-2 (round-3 whole-branch review finding, 2026-08-19): every direct-lane
 * ledger path was built with `node:path`'s platform-bound `relative()` —
 * `src/App.vue` on POSIX, `src\App.vue` on Windows. Git's own porcelain
 * output (`git status --porcelain -z`) is ALWAYS forward-slash, on every
 * OS — it's a plumbing format, not a display path. An exact-string
 * comparison between the two (`reconcileLedger`'s `dirty.has(repoRel)`)
 * therefore misses every dirty direct edit on Windows: the ledger path
 * reads `src\App.vue`, the dirty set holds `src/App.vue`, and the
 * comparison finds no match — the file looks clean, and a still-
 * uncommitted edit gets a durable `reconcile` marker calling it
 * committed. The log is append-only, so that marker can never be
 * un-said once it lands.
 *
 * The fix has two sides, both load-bearing:
 *  - The PRODUCER (`repoRelOf` in `editor-cli/src/server/edit-handler.ts`)
 *    normalizes what it writes, so every NEW ledger entry is canonical —
 *    this is the one that matters going forward, since a canonical write
 *    needs no defensive read-side handling at all.
 *  - Every COMPARISON or DISPLAY of a ledger path normalizes defensively
 *    too (`reconcileLedger`'s dirty check; `describeLedgerEntry`'s
 *    filename display), because an entry written before this fix already
 *    has a backslash baked into it forever — the producer fix cannot
 *    reach backward into an append-only log.
 *
 * This mirrors an identical, already-shipped fix in the chat lane:
 * `toRel` (`src/editor/agent-chat-sdk/edit-ack.ts`) has done exactly this
 * — `.split('\\').join('/')` — since the Task 14 review. The direct lane
 * (`edit-handler.ts`'s `repoRelOf`) was the one place that never got it.
 *
 * F2 (P2, round-10 whole-branch review finding, 2026-08-19 — REGRESSION
 * from round 3). The original implementation replaced EVERY backslash,
 * unconditionally. On POSIX, a backslash is a legal filename character —
 * a file genuinely named `foo\bar.vue` is a real, valid path. Blind
 * replacement rewrote it to `foo/bar.vue`, a path that does not exist,
 * while git's own porcelain output for that same file keeps the literal
 * backslash (POSIX git never treats `\` as a separator). So the exact
 * problem this function exists to prevent — a ledger path that no longer
 * string-matches git's dirty set — was reintroduced for a different
 * platform than the one round 3 fixed.
 *
 * The fix: only fold `\` into `/` on a platform where `\` actually IS
 * the path separator. Everywhere else (POSIX), a backslash is data, not
 * structure, and must survive untouched. `sep` defaults to this
 * process's real `node:path` separator but is an explicit parameter —
 * not read from `process.platform` internally — so a test can force
 * either branch deterministically regardless of the OS actually running
 * the suite (see `normalize-path.test.ts`).
 *
 * Still a blind string replace when it DOES apply, not a `path`-module
 * operation: ledger paths are STORAGE KEYS (JSON strings in an
 * append-only log, dirty-set members, display strings), never filesystem
 * calls — nothing here should re-introduce platform path semantics
 * beyond the one separator check this function needs.
 */
export function normalizeLedgerPath(repoRel: string, sep: string = platformSep): string {
  if (sep !== '\\') return repoRel
  return repoRel.split('\\').join('/')
}

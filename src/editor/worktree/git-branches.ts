/**
 * Branch operations for branch mode (Phase 2-3 of
 * tasks/branches-vs-worktree.md).
 *
 * In branch mode Editor edits the user's current working tree in place,
 * and the user manages ordinary git branches from the shell. This module
 * is the pure-git layer behind that surface: list / switch / create /
 * rename / publish over `git`, operating on the real checkout `root` (no
 * worktree, no session).
 *
 * Framework- and design-system-neutral by construction — it is `git`
 * plumbing only, so it scales to any substrate unchanged. All commands go
 * through `execFile` with argument arrays (never a shell), and every
 * would-be branch name is validated with `git check-ref-format` before
 * use, so a hostile name can't smuggle flags or ref expressions.
 *
 * Mutations are meant for branch mode only; the worktree-session model
 * assumes canonical stays on its root branch, so the CLI gates the
 * switch/create/rename/publish routes on branch mode (list is harmless
 * anywhere).
 */

import { execFile, spawn, type ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Force a stable, English, lock-free git environment so parsing + concurrent
// reads behave predictably.
//
// `GIT_LITERAL_PATHSPECS` is a SECURITY pin, not an ergonomics one (audit
// S19). Everywhere this module hands a caller-supplied path to git it is
// handing over a PATHSPEC, not a filesystem path — and a pathspec has its
// own language on top of paths: `*` crosses directory boundaries and a
// leading `:` introduces magic (`:/` means top-of-tree). Both sail straight
// through a `path.resolve`-based containment check, so a single
// `discardFile(root, '*', 'added')` used to expand into `git clean -f -- '*'`
// and delete every untracked file in the tree. Setting this module-wide
// makes git treat every pathspec as a literal path, which also keeps
// legitimate filenames containing `*` / `?` / `[` working. Nothing in this
// module relies on pathspec magic (the only pathspecs it passes are
// caller-supplied file paths), so there is no cost.
// `GIT_TERMINAL_PROMPT` turns a hang into a legible error, and it is the one
// pin here that matters for the NETWORK calls (push, fetch) rather than the
// local ones. `clone-repo.ts` has set it since it was written; this module was
// the half that never did, so the two network paths disagreed.
//
// Nothing that works today stops working. A credential helper (macOS keychain,
// git-credential-*) and an SSH agent both answer without the terminal, so they
// are unaffected. The only path this closes is "git asks a human to type a
// username", and that path cannot succeed here anyway: the push is triggered
// from the browser UI over HTTP, so there is no terminal the user is looking
// at. In the desktop app there is no terminal at all, and a GUI askpass helper
// turns it into an indefinite block on a dialog behind the window. `pushToOrigin`
// passes no timeout, so nothing else ever ends that wait.
//
// Failing fast is strictly better here because `pushToOrigin` already surfaces
// git's stderr verbatim, so the user gets git's own "could not read Username"
// instead of a spinner that never resolves.
const GIT_ENV = {
  ...process.env,
  LC_ALL: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_TERMINAL_PROMPT: '0',
}

// `editor/session-<id>` branches were scaffolding created by worktree-session
// mode (per-session git worktree, promote-to-main via Commit), fully removed
// 2026-07-21 — see tasks/worktree-mode-decommission.md. Nothing creates them
// anymore, but a repo that predates the decommission can still have leftover
// ones on disk, and they were never branches the user created — keep them out
// of the list.
const INTERNAL_BRANCH_PREFIXES = ['editor/session-'] as const

function isInternalBranch(name: string): boolean {
  return INTERNAL_BRANCH_PREFIXES.some((p) => name.startsWith(p))
}

export interface BranchInfo {
  /** Short branch name (e.g. `main`, `feat/x`). */
  name: string
  /** True for the currently checked-out branch. */
  current: boolean
  /** True for the resolved default branch. */
  isDefault: boolean
}

export interface BranchList {
  branches: BranchInfo[]
  /** Short name of the checked-out branch, or null when HEAD is detached. */
  current: string | null
  /** Resolved default branch, or null when it can't be determined. */
  defaultBranch: string | null
}

export type BranchOpResult =
  | { ok: true; current: string | null }
  | { ok: false; reason: string }

/** Where a new branch is created from. */
export type BranchBase = 'default' | 'current'

/**
 * Short name of the checked-out branch, or null when HEAD is detached
 * (or the root isn't a resolvable git repo).
 */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'symbolic-ref', '--short', '--quiet', 'HEAD'],
      { env: GIT_ENV },
    )
    const name = stdout.trim()
    return name || null
  } catch {
    return null
  }
}

/**
 * Resolve the default branch among the local branch `names`. Prefers the
 * remote's advertised default (`origin/HEAD` → `main`), then falls back to
 * a local `main`/`master`. Returns null if none of those exist locally —
 * the UI just won't tag a default in that case.
 */
async function resolveDefaultBranch(
  root: string,
  names: readonly string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'],
      { env: GIT_ENV },
    )
    const target = stdout.trim().replace(/^origin\//, '')
    if (target && names.includes(target)) return target
  } catch {
    // No origin/HEAD — fall through to conventional names.
  }
  for (const candidate of ['main', 'master']) {
    if (names.includes(candidate)) return candidate
  }
  return null
}

/**
 * Local branch names that currently exist (`git for-each-ref refs/heads`),
 * excluding the same internal `editor/session-*` prefix `listBranches`
 * filters out, or `null` if the underlying git call failed.
 *
 * `null` is distinct from `[]` on purpose (P2, round-6 whole-branch
 * review finding, 2026-08-19): `[]` means "asked git, there are
 * genuinely no local branches"; `null` means "couldn't ask." A caller
 * that treats them the same — as `listLocalBranchNames` below does, for
 * callers that only ever want a display list — silently turns a
 * transient git failure into "this repo has no branches," which is the
 * wrong answer for anything that reasons about NONEXISTENCE rather than
 * just rendering a list. The edit ledger's orphaned-branch check
 * (`isOrphanedBranch`, `rename-aliases.ts`) is exactly that: it fails
 * OPEN (shows the row) when a branch name is missing from this list, on
 * the theory that a missing name means the branch was renamed outside
 * the product. A `[]` caused by a failed `git for-each-ref` makes EVERY
 * branch name "missing," so that deliberate fail-open fires for every
 * row on the poll, not just the genuinely orphaned one.
 */
export async function tryListLocalBranchNames(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { env: GIT_ENV },
    )
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((n) => !isInternalBranch(n))
  } catch {
    return null
  }
}

/**
 * Local branch names that currently exist, or `[]` if the underlying git
 * call failed. Best-effort: a non-repo root or missing git yields an
 * empty array rather than throwing, so a display-only caller (like
 * `listBranches` below) degrades to "no branches" instead of erroring
 * the panel.
 *
 * Split out from `listBranches` (F3, round-5 whole-branch review finding,
 * 2026-08-19) so a caller that only needs "does a branch by this name
 * still exist" — the edit ledger's orphaned-branch check
 * (`isOrphanedBranch`, `rename-aliases.ts`) — doesn't also pay for
 * `listBranches`'s `currentBranch` and `resolveDefaultBranch` spawns on
 * every poll of a route that already resolves the current branch its own
 * way.
 *
 * A caller that needs to tell "no branches" apart from "couldn't ask"
 * (P2, round-6 — see `isOrphanedBranch`'s call site) wants
 * `tryListLocalBranchNames` above instead, not this function.
 */
export async function listLocalBranchNames(root: string): Promise<string[]> {
  return (await tryListLocalBranchNames(root)) ?? []
}

/**
 * List local branches, flagging the current + default. Best-effort: a
 * non-repo root or missing git yields an empty list rather than throwing,
 * so the caller degrades to "no branches" instead of erroring the panel.
 */
export async function listBranches(root: string): Promise<BranchList> {
  const current = await currentBranch(root)
  const names = await listLocalBranchNames(root)
  const defaultBranch = await resolveDefaultBranch(root, names)
  const branches: BranchInfo[] = names.map((name) => ({
    name,
    current: name === current,
    isDefault: name === defaultBranch,
  }))
  return { branches, current, defaultBranch }
}

/**
 * Merge-base of HEAD with the resolved default branch — branch mode's
 * answer to "what has this session changed" for `session_status` /
 * `session_diff` (see `agent-tools/git-tools.ts`, wired from those tools'
 * `ctx.rootCommitSha`). There is no worktree-session base commit to pin
 * anymore, so this recomputes fresh on every call instead: branch mode has
 * no session-start snapshot, and the user can switch or rebase branches
 * between chat turns, so a cached value could go stale silently.
 *
 * Returns null (rather than throwing) when there's no resolvable default
 * branch, HEAD is detached, or any git call fails — callers surface their
 * existing "not configured" refusal in that case instead of a wrong answer.
 */
export async function branchModeRootCommitSha(root: string): Promise<string | null> {
  try {
    const { defaultBranch } = await listBranches(root)
    if (!defaultBranch) return null
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'merge-base', 'HEAD', defaultBranch],
      { env: GIT_ENV },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Whether the working tree has uncommitted changes (tracked mods or
 * untracked files). `git status --porcelain` respects `.gitignore`, so
 * Editor's `.desde/` scaffolding and `node_modules` don't count.
 *
 * This is the guard that keeps branches isolated: `git checkout` carries
 * *non-conflicting* uncommitted edits into the target branch, so a
 * dirty-tree switch would bleed one branch's edits onto another. Branch
 * mode has no auto-commit, so we refuse the switch and tell the user to
 * commit (or discard) first, rather than silently mixing branches. (A
 * future enhancement can auto-stash per branch for seamless switching —
 * see tasks/branches-vs-worktree.md.)
 */
export async function isWorkingTreeDirty(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain'],
      { env: GIT_ENV },
    )
    return stdout.trim().length > 0
  } catch {
    // Can't determine — don't hard-block; `git checkout` still refuses on
    // a genuine overwrite conflict below.
    return false
  }
}

export type WorkingTreeChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface WorkingTreeChange {
  /** Repo-relative path (the new path for renames). */
  path: string
  status: WorkingTreeChangeStatus
  /** Previous path, for renames only. */
  from?: string
}

/**
 * The uncommitted working-tree changes as a per-file list — what the
 * Activity panel renders and what the Commit button counts. Same
 * `git status --porcelain` view as `isWorkingTreeDirty` (respects
 * `.gitignore`, so `.desde/` and `node_modules` don't appear), but
 * `-z`-delimited so paths with spaces/quotes parse exactly. Best-effort
 * like the other reads: a non-repo root yields `[]`, not a throw.
 */
export async function listWorkingTreeChanges(
  root: string,
): Promise<WorkingTreeChange[]> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain', '-z'],
      { env: GIT_ENV },
    ))
  } catch {
    return []
  }
  // -z format: NUL-separated entries of `XY <path>`; a rename/copy entry
  // (X = R or C) is followed by one extra NUL-separated token holding the
  // original path.
  const tokens = stdout.split('\0').filter(Boolean)
  const changes: WorkingTreeChange[] = []
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const filePath = entry.slice(3)
    const from = x === 'R' || x === 'C' ? tokens[++i] : undefined
    changes.push({ path: filePath, status: mapChangeStatus(x, y), from })
  }
  return changes
}

/**
 * `git status`'s dirty AND ignored view of the working tree, for exactly
 * one caller: the edit-ledger route's reconcile step (whole-branch review
 * finding, 2026-08-18). Three ways it deliberately differs from
 * `listWorkingTreeChanges`:
 *
 * 1. `--untracked-files=all`, not the default. Plain `git status`
 *    collapses a brand-new directory to one `?? newdir/` entry — a file
 *    created inside it (`download_asset`, `scaffold_route`,
 *    `insert_component`, the allowCreate write path) never appears as its
 *    own path. A ledger entry for that file then looks clean on the
 *    FIRST reconcile poll and gets durably marked `committed: true`
 *    though nothing was ever committed. Fully expanding avoids the
 *    collapse instead of teaching the reconcile call to pattern-match
 *    directory prefixes.
 * 2. It THROWS on a git failure instead of swallowing it. Reconcile marks
 *    ledger entries committed based on what's clean; `[]` and "git
 *    failed" must not look the same to it, or a single transient git
 *    error sweeps every pending edit into a false-committed state. The
 *    caller is expected to catch and skip that reconcile cycle rather
 *    than treat the failure as "nothing is dirty".
 * 3. `--ignored=matching` (P2, round-4 whole-branch review finding,
 *    2026-08-19). `git status` never reports an ignored path as dirty —
 *    that is what "ignored" means — and `git add -A` will not commit one
 *    either. So an edit to an ignored path (an EXISTING ignored file, or
 *    a newly created one matching `.gitignore`) is absent from the dirty
 *    set for the OPPOSITE reason a genuinely-committed file is absent.
 *    Reconcile's "not dirty ⇒ committed" inference cannot tell the two
 *    apart from the dirty set alone, so it read the ignored case as
 *    committed too — durably, since the ledger never un-says a
 *    `reconcile` line. This is not hypothetical: this product's OWN
 *    `.desde/` directory is locally ignored (`ensureLocallyIgnored`),
 *    so anything written there would misclassify this way.
 *
 *    `git check-ignore` is the direct way to ask "is this path ignored,"
 *    but a per-path subprocess spawn on every reconcile poll doesn't
 *    scale with the number of pending entries — even a single BATCHED
 *    `--stdin` call is a second process spawn every poll, on top of the
 *    `git status` this function already runs. Folding `--ignored` into
 *    the SAME status invocation costs no extra spawn — but the DEFAULT
 *    `--ignored` mode (`traditional`) expands an ignored directory to
 *    every file inside it, same as `--untracked-files=all` does for
 *    untracked ones: MEASURED with 3,000 files under a `node_modules/`
 *    (`node_modules/` the only `.gitignore` line), `--ignored` emits
 *    3,000 output entries — one per file — every single poll, on a repo
 *    size this function's own untracked-directory fix (point 1 above)
 *    already has to defend against. `--ignored=matching` reports the
 *    ignored DIRECTORY itself as ONE entry instead of walking inside it
 *    (confirmed empirically: the same 3,000-file tree produces exactly
 *    ONE `node_modules/` line): output size tracks the number of
 *    distinct ignored PATTERNS a repo's `.gitignore` matches, not the
 *    number of files those patterns cover. That is why `matching`, not
 *    the default, is the mode used here. The cost of `matching` is that
 *    a caller checking one file against `ignoredPrefixes` needs a
 *    prefix/directory check, not a `Set.has` — see `isIgnoredPath`.
 *
 * NOT a replacement for `listWorkingTreeChanges` — the Activity panel and
 * the Commit button intentionally keep the collapsed-directory,
 * never-throws view that function provides; widening it would change
 * what those render.
 *
 * 4. Explicit `maxBuffer` (F2, round-8 whole-branch review finding,
 *    2026-08-19). Every entry here costs 4 bytes of format overhead
 *    (`XY ` + trailing NUL) plus the path itself, and `--untracked-files=all`
 *    means that cost is paid once per FILE, not once per top-level entry —
 *    same expansion point 1 above measured for a `node_modules`-shaped
 *    tree. A repo with ~100k dirty/untracked/ignored-prefix paths at a
 *    ~150-byte average nested path is already ~15 MB of output, well past
 *    Node's 1 MiB `execFile` default — and both callers of this function
 *    (reconcile above, and the commit-coverage check that shares it) catch
 *    and skip on any failure, so a `MAXBUFFER` throw here doesn't fail
 *    loudly, it silently strands ledger entries as pending forever (the
 *    log is append-only). `STATUS_MAX_BUFFER_BYTES` gives several times
 *    that headroom without leaving the buffer unbounded.
 */
const STATUS_MAX_BUFFER_BYTES = 32 * 1024 * 1024 // 32 MiB — see point 4 above.

export interface DirtyAndIgnoredStatus {
  /** Repo-relative paths `git status` reports as changed. Exact-match set. */
  dirty: Set<string>
  /**
   * Repo-relative paths `--ignored=matching` reported. An entry ending in
   * `/` is a whole ignored DIRECTORY (nothing inside it is listed
   * separately — see the doc comment above); an entry with no trailing
   * `/` is a single ignored FILE. Test a specific path against this list
   * with `isIgnoredPath`, not a direct `includes`/`Set.has`.
   */
  ignoredPrefixes: string[]
}

export async function listDirtyRepoRelativePaths(root: string): Promise<DirtyAndIgnoredStatus> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching'],
    { env: GIT_ENV, maxBuffer: STATUS_MAX_BUFFER_BYTES },
  )
  const tokens = stdout.split('\0').filter(Boolean)
  const dirty = new Set<string>()
  const ignoredPrefixes: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const p = entry.slice(3)
    if (x === '!' && y === '!') {
      ignoredPrefixes.push(p)
      continue
    }
    dirty.add(p)
    // Rename/copy entries carry one extra NUL-separated token holding the
    // original path — same shape as `listWorkingTreeChanges` above.
    if (x === 'R' || x === 'C') {
      dirty.add(tokens[++i])
    }
  }
  return { dirty, ignoredPrefixes }
}

/**
 * Whether `repoRel` is covered by one of `listDirtyRepoRelativePaths`'s
 * `ignoredPrefixes` — either an exact match against an ignored FILE
 * entry, or nested inside an ignored DIRECTORY entry (which
 * `--ignored=matching` reports once, for the directory, never expanded
 * to the files inside it — see that function's doc comment).
 */
export function isIgnoredPath(repoRel: string, ignoredPrefixes: readonly string[]): boolean {
  return ignoredPrefixes.some(
    (prefix) => repoRel === prefix || (prefix.endsWith('/') && repoRel.startsWith(prefix)),
  )
}

/** Max total bytes `readHeadBlobs` will buffer from `git cat-file --batch`'s stdout. */
const CAT_FILE_BATCH_MAX_BYTES = 32 * 1024 * 1024 // 32 MiB — same headroom as STATUS_MAX_BUFFER_BYTES.

/**
 * HEAD's content for a batch of repo-relative paths, read with ONE `git`
 * subprocess (`git cat-file --batch`) instead of one spawn per path.
 *
 * Written for `reconcileLedger`'s positive-evidence check (`edit-ledger.ts`):
 * proving an edit's content genuinely reached git means comparing HEAD's
 * actual bytes for a path against the edit's own recorded hash, not just
 * asking whether the working tree is clean. That check runs on every
 * ledger poll, against however many files the currently-PENDING edits
 * touch — so reading each one with its own `execFile` would mean one
 * process spawn per pending file, per poll. `cat-file --batch` answers
 * arbitrarily many `<rev>:<path>` queries from one long-lived process: all
 * the paths are written to its stdin up front, one per line, and it
 * streams back one answer per line in the SAME order — so this function
 * costs one spawn no matter how many paths it's asked about. The set this
 * gets called with is bounded by "how many edits are still pending
 * reconciliation," not by the ledger's whole history — see the call site
 * in `http-server.ts`'s `handleLedgerRequest`, which excludes anything
 * `resolveCommitState` already marks committed before building the list.
 *
 * Returns a map from repo-relative path to HEAD's raw bytes for it. A path
 * absent from the map has no blob at HEAD — never committed, or deleted
 * since — which is itself useful information: the caller's positive-
 * evidence check treats "no HEAD content" the same as "content doesn't
 * match," both meaning "not proven committed."
 *
 * Deliberately returns raw `Buffer`s, not hashes. Git's own blob object id
 * is NOT a sha256 of the file's bytes — it's computed over `blob
 * <size>\0<content>`, with an algorithm (sha1 by default; sha256 only in a
 * repo explicitly configured for it) that has nothing to do with
 * `hashContent`'s plain sha256-of-bytes. So a git blob id can never be
 * compared against `LedgerEditEntry.afterHashes` directly — the only
 * correct comparison is to read HEAD's actual content and hash it the
 * SAME way `afterHashes` was computed. That hashing happens at the call
 * site (`hashContent`, from `edit-ledger.ts`), not here — this module is
 * pure git plumbing and has no business knowing the ledger's hash
 * algorithm; keeping that split also avoids a circular import, since
 * `edit-ledger.ts` already imports FROM this module.
 *
 * Throws on a genuine git/spawn failure (binary missing, not a repo, a
 * malformed response) rather than returning a partial or empty map — the
 * caller's contract (mirroring `listDirtyRepoRelativePaths`) is to skip
 * reconciliation for the whole poll when it can't tell what's true, never
 * to treat "couldn't read" as "doesn't match" and definitely never as
 * "matches."
 */
export async function readHeadBlobs(
  root: string,
  paths: readonly string[],
): Promise<Map<string, Buffer>> {
  if (paths.length === 0) return new Map()

  const child = spawn('git', ['-C', root, 'cat-file', '--batch'], {
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let total = 0
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total > CAT_FILE_BATCH_MAX_BYTES) {
      child.kill()
      return
    }
    stdoutChunks.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
  // A write after the process has already died (e.g. `git` binary missing)
  // emits its own 'error' on the stream — swallow it here so it doesn't
  // crash as an unhandled event; `child.on('error', reject)` below is the
  // one path that actually surfaces the failure to the caller.
  child.stdin.on('error', () => {})

  // One query per path, in the SAME order responses come back in — that
  // order is how `readHeadBlobs` matches each answer to its path below,
  // since `cat-file --batch` doesn't echo the query back on a hit (only
  // on a miss). Written and closed up front: without ending stdin, `git`
  // waits indefinitely for more queries and the `close` await below would
  // hang forever.
  child.stdin.end(paths.map((p) => `HEAD:${p}\n`).join(''))

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })

  if (total > CAT_FILE_BATCH_MAX_BYTES) {
    throw new Error(`git cat-file --batch: output exceeded ${CAT_FILE_BATCH_MAX_BYTES} bytes`)
  }
  if (exitCode !== 0) {
    throw new Error(
      `git cat-file --batch exited ${exitCode}: ${Buffer.concat(stderrChunks).toString('utf8')}`,
    )
  }

  const stdout = Buffer.concat(stdoutChunks)
  const result = new Map<string, Buffer>()
  let offset = 0
  for (const p of paths) {
    const headerEnd = stdout.indexOf(0x0a, offset)
    if (headerEnd === -1) {
      throw new Error('git cat-file --batch: truncated response (no header newline)')
    }
    const header = stdout.toString('utf8', offset, headerEnd)
    offset = headerEnd + 1
    // Format for a name git can't resolve: "<object> missing\n" — the
    // object part echoes our query verbatim, so it can itself contain a
    // space (a path with one in it), which is exactly why this checks
    // the SUFFIX rather than splitting the whole line into fields.
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      continue
    }
    // Format for a resolved object: "<sha> <type> <size>\n<content>\n".
    // Neither <sha> nor <type> nor <size> can contain a space, so this
    // split is exact for the success case (unlike the miss case above).
    const parts = header.split(' ')
    if (parts.length !== 3 || parts[1] !== 'blob') {
      throw new Error(`git cat-file --batch: unexpected header "${header}"`)
    }
    const size = Number(parts[2])
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file --batch: unparseable size in header "${header}"`)
    }
    result.set(p, Buffer.from(stdout.subarray(offset, offset + size)))
    offset += size + 1 // the content is followed by its own trailing newline
  }
  return result
}

/**
 * How many commits `branch` has that `base` doesn't (`git rev-list --count
 * base..branch`). Drives whether the Merge button has anything to merge: a
 * feature branch with committed-but-unmerged work is publishable even when
 * its working tree is clean. Best-effort — a bad ref or non-repo yields 0
 * (button stays disabled) rather than throwing.
 */
export async function countCommitsAhead(
  root: string,
  branch: string,
  base: string,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-list', '--count', `${base}..${branch}`],
      { env: GIT_ENV },
    )
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** Collapse a porcelain XY status pair to the display status. Ordered by
 *  what's truest about the file NOW: gone beats renamed beats new. */
function mapChangeStatus(x: string, y: string): WorkingTreeChangeStatus {
  if (x === '?') return 'added' // untracked
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R') return 'renamed'
  if (x === 'A' || x === 'C') return 'added'
  return 'modified'
}

/**
 * Strict validation of a would-be branch name via git's own
 * `check-ref-format`. This is authoritative (rejects `..`, trailing `/`,
 * `.lock`, control chars, etc.) and, run through `execFile`, can't be
 * turned into an injection vector.
 */
async function isValidBranchName(root: string, name: string): Promise<boolean> {
  if (!name || name.length > 255) return false
  // Reject a leading '-' explicitly: `check-ref-format refs/heads/-x` accepts
  // it (valid inside a full refname), but as a bare argument to `git checkout
  // -b -x` / `git branch -m -x` it would be parsed as an option. execFile's
  // arg array stops shell injection, not git's own flag parsing.
  if (name.startsWith('-')) return false
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'check-ref-format', `refs/heads/${name}`],
      { env: GIT_ENV },
    )
    return true
  } catch {
    return false
  }
}

async function branchExists(root: string, name: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`],
      { env: GIT_ENV },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Switch to an existing branch (`git checkout`). On a dirty tree git may
 * refuse if the switch would overwrite local changes — we surface git's
 * message verbatim so the UI can tell the user to commit or stash first
 * (branch mode has no auto-commit, so uncommitted edits are expected).
 */
export async function switchBranch(
  root: string,
  name: string,
): Promise<BranchOpResult> {
  if (!(await isValidBranchName(root, name))) {
    return { ok: false, reason: `Invalid branch name: '${name}'.` }
  }
  if (!(await branchExists(root, name))) {
    return { ok: false, reason: `No branch named '${name}'.` }
  }
  if (await isWorkingTreeDirty(root)) {
    return { ok: false, reason: dirtyTreeReason(await currentBranch(root)) }
  }
  try {
    await execFileAsync('git', ['-C', root, 'checkout', name], { env: GIT_ENV })
    return { ok: true, current: await currentBranch(root) }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  }
}

/**
 * Create a new branch and switch to it (`git checkout -b`). `base` chooses
 * the branch point: `'default'` (branch off the default branch) or
 * `'current'` (duplicate the current branch). The default branch is
 * resolved from the branch list; if it can't be resolved, `'default'`
 * falls back to current HEAD so creation never hard-fails on an
 * unconventional repo.
 */
export async function createBranch(
  root: string,
  name: string,
  base: BranchBase,
): Promise<BranchOpResult> {
  if (!(await isValidBranchName(root, name))) {
    return { ok: false, reason: `Invalid branch name: '${name}'.` }
  }
  if (await branchExists(root, name)) {
    return { ok: false, reason: `A branch named '${name}' already exists.` }
  }
  // Creating a branch also switches to it, so the same dirty-tree carry-over
  // applies — uncommitted edits would move onto the new branch, leaving the
  // current one without them. Refuse for the same reason as switch.
  if (await isWorkingTreeDirty(root)) {
    return { ok: false, reason: dirtyTreeReason(await currentBranch(root)) }
  }
  const args = ['-C', root, 'checkout', '-b', name]
  if (base === 'default') {
    const { defaultBranch } = await listBranches(root)
    // Fall back to HEAD (no explicit start-point) when there's no default.
    if (defaultBranch) args.push(defaultBranch)
  }
  try {
    await execFileAsync('git', args, { env: GIT_ENV })
    return { ok: true, current: await currentBranch(root) }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  }
}

/**
 * Rename a branch (`git branch -m <from> <to>`). Renaming the current
 * branch is allowed (HEAD follows). Refuses if `to` already exists or
 * `from` doesn't.
 */
export async function renameBranch(
  root: string,
  from: string,
  to: string,
): Promise<BranchOpResult> {
  if (!(await isValidBranchName(root, to))) {
    return { ok: false, reason: `Invalid branch name: '${to}'.` }
  }
  if (!(await branchExists(root, from))) {
    return { ok: false, reason: `No branch named '${from}'.` }
  }
  if (from !== to && (await branchExists(root, to))) {
    return { ok: false, reason: `A branch named '${to}' already exists.` }
  }
  try {
    await execFileAsync('git', ['-C', root, 'branch', '-m', from, to], {
      env: GIT_ENV,
    })
    return { ok: true, current: await currentBranch(root) }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  }
}

export type CommitResult =
  | { ok: true; sha: string; branch: string | null; message: string }
  | { ok: false; reason: string }

/**
 * Commit the current working tree onto the checked-out branch — the
 * branch-mode "Commit" boundary (tasks/branches-vs-worktree.md §7). Branch
 * mode has no auto-commit, so editor edits sit as ordinary uncommitted
 * changes until the user commits them; this is the in-UI equivalent of
 * `git add -A && git commit`.
 *
 * Works on any branch, including the default one (unlike Publish, which
 * squash-merges a *feature* branch into the default). Refuses on a clean
 * tree so the UI can disable the button / report "nothing to commit".
 *
 * `--no-verify` mirrors the rest of branch mode's git writes (publish's
 * internal commit, session auto-commit): pre-commit hooks that fail would
 * otherwise strand the edits with a confusing hook error and no clear
 * recovery in the editor chrome.
 *
 * The success result echoes back the message actually used (`msg`, after
 * the trim-and-fallback below) — the edit ledger's `commit` line needs it
 * and the caller's own `message` argument may be empty/undefined, so
 * re-deriving the fallback at the call site would risk drifting from this
 * function's default.
 */
export async function commitWorkingTree(
  root: string,
  message?: string,
): Promise<CommitResult> {
  if (!(await isWorkingTreeDirty(root))) {
    return { ok: false, reason: 'Nothing to commit: your working tree is clean.' }
  }
  const msg = message?.trim() || 'Editor: commit working tree'
  try {
    await execFileAsync('git', ['-C', root, 'add', '-A'], { env: GIT_ENV })
    await execFileAsync('git', ['-C', root, 'commit', '-m', msg, '--no-verify'], {
      env: GIT_ENV,
    })
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', 'HEAD'],
      { env: GIT_ENV },
    )
    return { ok: true, sha: stdout.trim(), branch: await currentBranch(root), message: msg }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  }
}

/**
 * True when TRACKED files have staged or unstaged modifications — the
 * narrower question `isWorkingTreeDirty` deliberately doesn't ask.
 *
 * Untracked files are excluded on purpose: this exists to decide whether a
 * `git reset --hard` would destroy anything, and `reset --hard` leaves
 * untracked files alone. It also has to exclude them for correctness —
 * publish's own ephemeral worktree lands under `.desde/`, which is
 * only *locally* ignored (boot-time `ensureLocallyIgnored`), so counting
 * untracked files would make publish permanently believe the tree moved in
 * any repo where that ignore hasn't been written.
 *
 * Fails CLOSED (`true`) — an unreadable status is not evidence that a
 * destructive reset is safe. That includes a Node `execFile` `maxBuffer`
 * overflow (F2, round-8 whole-branch review finding, 2026-08-19, audited
 * as a sibling of `listDirtyRepoRelativePaths`'s own maxBuffer fix): this
 * call excludes untracked files (`--untracked-files=no`), so its output
 * scales with TRACKED changes only — far smaller in practice than the
 * `--untracked-files=all` case that motivated that fix — and an overflow
 * here already lands on the safe "treat as dirty" branch by construction,
 * so no `maxBuffer` override was added.
 */
async function hasTrackedModifications(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain', '--untracked-files=no'],
      { env: GIT_ENV },
    )
    return stdout.trim().length > 0
  } catch {
    return true
  }
}

/**
 * Resolved `HEAD` commit for `root`, or `null` when it can't be read (an
 * unborn branch in a fresh repo, a detached/broken HEAD). Used as a "has
 * the tree moved under us?" fingerprint — callers must treat `null` as
 * "unknown", never as a value that can match, since two unreadable reads
 * are not evidence that nothing changed.
 *
 * (Doc comment relocated to sit above the function it actually
 * describes — codex review round 4, 2026-08-20; it had drifted one
 * function above during an earlier reorder. No behavior change.)
 *
 * Exported (F1, codex review round 4, 2026-08-20) for `reconcileLedger`'s
 * undo-entry fingerprint (`edit-ledger.ts`, threaded through
 * `handleLedgerRequest` in `http-server.ts`). `readGitHeadRaw`
 * (`edit-ledger.ts`) reads `.git/HEAD`'s raw bytes — a SYMBOLIC ref, only
 * retargeted by a checkout/switch/rename. An ordinary commit moves the
 * BRANCH's own ref forward without touching that file at all (verified:
 * `.git/HEAD` reads byte-identical `ref: refs/heads/main` before and
 * after a commit on `main`), so it cannot tell "a commit landed" from
 * "nothing happened" — this function, which resolves the actual tip
 * commit, is the one that can.
 */
export async function headSha(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      env: GIT_ENV,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export type PublishResult =
  | {
      ok: true
      defaultBranch: string
      sha: string
      committedBranch: boolean
      /**
       * False when the post-publish rebaseline was SKIPPED because the
       * working tree moved under us mid-publish (audit K11). The publish
       * itself landed either way; what's lost is only the branch's baseline
       * advance, so the next publish may report a conflict that a clean
       * rebaseline would have avoided.
       */
      rebaselined?: boolean
    }
  | {
      ok: false
      reason: string
      conflict?: boolean
      /**
       * The exact files the merge conflicted on, read from the ephemeral
       * worktree (`git diff --name-only --diff-filter=U`) before it is torn
       * down. Present only alongside `conflict: true`, and possibly empty
       * when the conflict was not a content conflict (e.g. a modify/delete
       * pair git reports differently). The UI renders these as a list so
       * the user knows WHICH files to resolve, not just that one exists.
       */
      conflictFiles?: string[]
    }

/**
 * The files currently in conflict inside `dir` (an ephemeral merge
 * worktree): unmerged paths per `git diff --name-only --diff-filter=U`.
 * Best-effort — a git failure yields `[]`, never a throw, because this is
 * only ever called while already reporting a conflict.
 */
async function listConflictedFiles(dir: string): Promise<string[]> {
  try {
    // `-z` (NUL-delimited), for the same reason `listWorkingTreeChanges`
    // uses it: without it git C-quotes any path containing a space or a
    // non-ASCII byte, and the UI would render the literal escape string
    // (`"caf\303\251 note.txt"`, quotes included) as the file to go fix.
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, 'diff', '--name-only', '--diff-filter=U', '-z'],
      { env: GIT_ENV },
    )
    return stdout.split('\0').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Publish a branch into the default branch — the "make this real" boundary
 * (Phase 3 of tasks/branches-vs-worktree.md). Squash-merges the branch's
 * changes into the default branch as a single commit, leaving the user on
 * their branch (the default branch just advances).
 *
 * The merge runs in an **ephemeral worktree** checked out on the default
 * branch, so:
 *   - the user's checkout / current branch is never touched, and
 *   - a conflict stays fully isolated (we tear the worktree down and
 *     report; the user's tree keeps its state).
 *
 * Branch mode has no auto-commit, so if the branch being published is the
 * checked-out one and has uncommitted edits, we commit them onto the branch
 * first (that IS the publish boundary) so they're included.
 *
 * Idempotent by construction: the squash is diff-based, so re-publishing
 * an unchanged branch stages nothing → "nothing to publish", and a second
 * publish after more edits carries only the new delta.
 */
export async function publishBranch(
  root: string,
  branch: string,
  message?: string,
): Promise<PublishResult> {
  const { defaultBranch } = await listBranches(root)
  if (!defaultBranch) {
    return { ok: false, reason: 'No default branch found to publish into.' }
  }
  if (branch === defaultBranch) {
    return { ok: false, reason: "You're on the default branch. There's nothing to publish." }
  }
  if (!(await branchExists(root, branch))) {
    return { ok: false, reason: `No branch named '${branch}'.` }
  }

  // Commit uncommitted edits on the branch first — but only if it IS the
  // checked-out branch (only it has a working tree; a dirty tree while
  // publishing some OTHER branch belongs to the current branch, not this one).
  let committedBranch = false
  const current = await currentBranch(root)
  if (branch === current && (await isWorkingTreeDirty(root))) {
    try {
      await execFileAsync('git', ['-C', root, 'add', '-A'], { env: GIT_ENV })
      await execFileAsync(
        'git',
        ['-C', root, 'commit', '-m', 'Editor: edits (publish)', '--no-verify'],
        { env: GIT_ENV },
      )
      committedBranch = true
    } catch (err) {
      return { ok: false, reason: `Couldn't commit edits: ${gitMessage(err)}` }
    }
  }

  // Snapshot the branch tip we are about to publish FROM. The rebaseline at
  // the end of this function is a `git reset --hard`, which discards any
  // modification to a tracked file made after this point — and publish only
  // holds the CLI's tree gate, which the SDK's six structural file-write
  // tools bypass (audit K11). If the tree moved under us, the reset is no
  // longer a rebaseline of what we published; it is data loss.
  const preMergeHead = branch === current ? await headSha(root) : null

  // Ephemeral worktree on the default branch (gitignored under
  // .desde/). Runs the squash-merge in isolation so the user's
  // checkout is untouched.
  const tmp = path.join(root, '.desde', `publish-${randomUUID().slice(0, 8)}`)
  try {
    // `git worktree add` mkdir's the leaf but not `.desde/` itself.
    await fs.mkdir(path.dirname(tmp), { recursive: true })
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '--quiet', tmp, defaultBranch], {
      env: GIT_ENV,
    })
  } catch (err) {
    return { ok: false, reason: `Couldn't prepare publish: ${gitMessage(err)}` }
  }
  try {
    try {
      await execFileAsync('git', ['-C', tmp, 'merge', '--squash', branch], { env: GIT_ENV })
    } catch {
      // The ephemeral worktree is still on disk mid-conflict, so the exact
      // unmerged paths are one cheap read away. Without this the user is
      // told a conflict exists but never which file.
      const conflictFiles = await listConflictedFiles(tmp)
      return {
        ok: false,
        conflict: true,
        conflictFiles,
        // Deliberately points at the user's OWN git tools, not at the
        // in-product "Update from <default>" action: that action is
        // all-or-nothing and refuses on the very conflict that produced
        // this message, so recommending it would send the user in a loop
        // that ends where this message started.
        reason:
          `Publishing '${branch}' conflicts with '${defaultBranch}'. Merge ` +
          `'${defaultBranch}' into '${branch}' with your own git tools, resolve ` +
          `the conflicts, then publish again.`,
      }
    }
    // Empty squash → the branch's changes are already in the default branch.
    try {
      await execFileAsync('git', ['-C', tmp, 'diff', '--cached', '--quiet'], { env: GIT_ENV })
      return {
        ok: false,
        reason: `Nothing to publish: '${branch}' has no changes beyond '${defaultBranch}'.`,
      }
    } catch (diffErr) {
      if ((diffErr as ExecFileException).code !== 1) {
        return { ok: false, reason: `Publish check failed: ${gitMessage(diffErr)}` }
      }
      // exit 1 = staged changes → proceed to commit.
    }
    await execFileAsync(
      'git',
      ['-C', tmp, 'commit', '-m', message?.trim() || `Merge branch '${branch}'`],
      { env: GIT_ENV },
    )
    const { stdout } = await execFileAsync('git', ['-C', tmp, 'rev-parse', 'HEAD'], {
      env: GIT_ENV,
    })

    // Advance the branch's baseline to the freshly-published default branch.
    // Squash merges lose history, so without this a branch that keeps being
    // edited would re-conflict against the default on the next publish (base
    // v1 vs branch v2); resetting the branch to the default (identical
    // content — we just published it) makes future publishes diff cleanly.
    // Best-effort: the publish already landed regardless.
    let rebaselined = true
    try {
      if (branch === current) {
        // `git reset --hard` is DESTRUCTIVE to tracked-file modifications.
        // It is only safe here because the tree is supposed to be exactly
        // what we just published — so prove that before running it (audit
        // K11: the SDK's structural file-write tools bypass the tree gate
        // publish holds, so a concurrent write CAN land in this window).
        // Untracked files survive a reset either way; the loss this closes
        // is a concurrent modification to a tracked file.
        const settled =
          preMergeHead !== null &&
          (await headSha(root)) === preMergeHead &&
          !(await hasTrackedModifications(root))
        if (settled) {
          await execFileAsync('git', ['-C', root, 'reset', '--hard', defaultBranch], { env: GIT_ENV })
        } else {
          // Refuse rather than reset. The cost is a possible conflict on the
          // NEXT publish, which the user can resolve; the alternative is
          // silently deleting work that landed while we were merging.
          rebaselined = false
        }
      } else {
        await execFileAsync('git', ['-C', root, 'branch', '-f', branch, defaultBranch], { env: GIT_ENV })
      }
    } catch {
      // Branch didn't fast-forward; the publish itself still succeeded.
      rebaselined = false
    }

    return { ok: true, defaultBranch, sha: stdout.trim(), committedBranch, rebaselined }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  } finally {
    // Always tear the ephemeral worktree down (idempotent; --force in case
    // a conflict left it mid-merge).
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', tmp], {
      env: GIT_ENV,
    }).catch(() => {})
  }
}

export type FetchResult = { ok: true } | { ok: false; reason: string }

/**
 * How long a `git fetch` may spend on the network before we kill it (ms).
 * Unlike the local git calls in this module, fetch blocks on a remote — a
 * wedged credential helper or a dead network would otherwise hang the
 * request forever (`GIT_TERMINAL_PROMPT=0` above only closes the
 * ask-a-human hang, not the network one).
 */
const FETCH_TIMEOUT_MS = 30_000

/**
 * `git fetch origin` — updates the remote-tracking refs so `behind` /
 * `unpushed` reflect the actual remote. Callers must treat this as a
 * NETWORK call: trigger it from an explicit user action or a long
 * interval, never a tight poll, and never hold the exclusive tree lock
 * across it (it writes only remote-tracking refs under `.git/`, no
 * working-tree file, so it needs no serialization with edits).
 */
export async function fetchOrigin(root: string): Promise<FetchResult> {
  try {
    await execFileAsync('git', ['-C', root, 'fetch', '--quiet', 'origin'], {
      env: GIT_ENV,
      timeout: FETCH_TIMEOUT_MS,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: describeFetchFailure(err) }
  }
}

/**
 * Git's first line, ending in a full stop.
 *
 * Every failure that reaches a toast goes through this. A raw git failure is
 * a multi-line block whose remaining lines are hints addressed to someone at
 * a terminal, and a toast is not a terminal: the block is unreadable there
 * and it buries the one line that says what went wrong. The rejected-push
 * classifier and `describeFetchFailure` exist for the same reason; this is
 * the floor underneath them for causes nobody has classified yet.
 */
function firstLine(message: string): string {
  const first = message.split('\n')[0].trim().replace(/[.\s]+$/, '')
  return first ? `${first}.` : 'Git did not say why.'
}

/**
 * One plain sentence for a failed fetch. Same treatment `pushToOrigin`
 * gives a rejected push: git's failure here is a multi-line `fatal:` block
 * (host resolution, credentials, host keys), which is useless inside a
 * toast. Classify the common causes and name the next action; anything
 * unrecognized surfaces as its FIRST line only, never the whole block.
 */
function describeFetchFailure(err: unknown): string {
  const e = err as ExecFileException
  const msg = gitMessage(err)
  if (e.killed) {
    return 'The fetch took too long and was stopped. Check your network connection, then try again.'
  }
  if (/could not resolve host|unable to access|connection (refused|timed out|reset)|network is unreachable/i.test(msg)) {
    return "Couldn't reach the remote. Check your network connection, then try again."
  }
  if (/could not read username|could not read password|terminal prompts disabled|authentication failed|permission denied|publickey|host key verification/i.test(msg)) {
    return "Git couldn't sign in to the remote. Check your git credentials (SSH key or credential helper), then try again."
  }
  if (/does not appear to be a git repository|repository.*not found|could not read from remote repository/i.test(msg)) {
    return "The 'origin' remote doesn't point at a reachable git repository."
  }
  const first = msg.split('\n')[0].trim()
  return first ? `Fetch failed: ${first}` : 'Fetch failed.'
}

/**
 * How many commits `base` has that `branch` doesn't (`git rev-list --count
 * branch..base`) — the "behind by N" number. With `base` =
 * `origin/<branch>` this reads the local remote-tracking ref, so it costs
 * no network and reflects the last fetch. Best-effort — a missing ref
 * (never fetched, no remote branch) or non-repo yields 0.
 */
export async function countCommitsBehind(
  root: string,
  branch: string,
  base: string,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-list', '--count', `${branch}..${base}`],
      { env: GIT_ENV },
    )
    const n = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

export type UpdateBranchResult =
  | {
      ok: true
      branch: string
      /**
       * The branch tip after the call. On `upToDate` this is unchanged
       * UNLESS `committedBranch` is set, in which case it is the
       * auto-commit the call created.
       */
      sha: string
      /** True when uncommitted edits were committed onto the branch first. */
      committedBranch: boolean
      /** True when there was nothing to merge. The auto-commit can still
       *  have run — check `committedBranch` before concluding no ref moved. */
      upToDate: boolean
    }
  | {
      ok: false
      reason: string
      conflict?: boolean
      conflictFiles?: string[]
      /**
       * True when the auto-commit ran before the failure. The commit stays
       * on the branch and the tree is now clean — a failure result is NOT
       * evidence that nothing changed. Every failure return carries this so
       * callers (and the UI) can say so instead of guessing.
       */
      committedBranch: boolean
    }

/**
 * How long the local git writes that can run repo hooks or rewrite the
 * working tree may take before we kill them (ms). Unlike a plain ref read
 * these are unbounded in principle (a blocking `post-merge` hook, a
 * wedged filesystem), and the callers hold the exclusive tree lock, so an
 * indefinite wait here freezes every edit in the session.
 */
const MERGE_TIMEOUT_MS = 60_000

/**
 * Merge `sourceRef` into `branch`, all-or-nothing, through the same
 * ephemeral-worktree machinery `publishBranch` uses. This is the engine
 * behind both "Update from <default>" and "Pull remote changes" — they
 * differ only in which ref they merge from.
 *
 * Why an ephemeral worktree and NOT `git merge` in the user's checkout:
 * the CLI's boot preflight (`editor-cli/src/server/canonical-preflight.ts`)
 * refuses to start while `MERGE_HEAD` exists. An in-place merge that
 * conflicts would therefore leave the repo in a state the editor itself
 * declares unopenable, with no in-editor abort. Here the merge happens in
 * a scratch worktree on a detached HEAD; on conflict the worktree is torn
 * down and the user's real tree is byte-identical to before. Only a CLEAN
 * merge ever touches the real checkout, via `git merge --ff-only` onto the
 * merge commit (a fast-forward can't conflict and can't leave markers).
 *
 * Mirrors `publishBranch`'s boundaries: uncommitted edits on the
 * checked-out branch are committed first (a merge needs a committed
 * state), and a concurrent write landing mid-merge makes the final
 * fast-forward refuse rather than clobber (audit K11's reasoning).
 */
export async function updateBranchFromRef(
  root: string,
  branch: string,
  sourceRef: string,
  sourceLabel: string,
): Promise<UpdateBranchResult> {
  if (!(await branchExists(root, branch))) {
    return { ok: false, committedBranch: false, reason: `No branch named '${branch}'.` }
  }
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--verify', '--quiet', `${sourceRef}^{commit}`],
      { env: GIT_ENV },
    )
  } catch {
    return {
      ok: false,
      committedBranch: false,
      reason: `Couldn't find '${sourceLabel}' to merge from.`,
    }
  }

  // Commit uncommitted edits first, publish-style — only when `branch` IS
  // the checked-out branch (only it has a working tree). The UI warns and
  // confirms BEFORE calling this when the tree is dirty; every result
  // after this point (success or failure) reports `committedBranch` so no
  // layer above can claim nothing changed when this commit ran.
  //
  // The commit MUST stay byte-for-byte what `commitWorkingTree` does: the
  // same `add -A` and the same `--no-verify`. Both sweep untracked files in
  // and neither runs the user's hooks, which is worth knowing and is what
  // the confirmation dialog says out loud. Making this path stricter than
  // the Commit button would be the worse bug, not a fix: the same "commit
  // my work" operation would then behave two ways depending on which
  // control the user pressed. If that posture should change, it changes for
  // `commitWorkingTree` first and this follows.
  //
  // This is a fifth commit path with no ledger `commit` line of its own,
  // same as `publishBranch`'s inline commit above: it runs its OWN
  // `git add -A && git commit` here, never through `commitWorkingTree` —
  // so `recordCommitInLedger` (wired at the three `commitWorkingTree` call
  // sites only) never sees it and appends nothing for it. Not a hole: the
  // NEXT ledger read reconciles, and the edit's files are genuinely clean
  // after this commit, so `reconcileLedger`'s "committed outside the
  // product" fallback marks it committed anyway — just via a `reconcile`
  // line (no `sha`) rather than a `commit` line (with one). Documented
  // here so this is the accepted class it already is, not a rediscovery
  // (whole-branch review, 2026-08-18).
  let committedBranch = false
  const current = await currentBranch(root)
  if (branch === current && (await isWorkingTreeDirty(root))) {
    try {
      await execFileAsync('git', ['-C', root, 'add', '-A'], { env: GIT_ENV })
      await execFileAsync(
        'git',
        ['-C', root, 'commit', '-m', `Editor: edits (update from ${sourceLabel})`, '--no-verify'],
        { env: GIT_ENV },
      )
      committedBranch = true
    } catch (err) {
      return {
        ok: false,
        committedBranch: false,
        reason: `Couldn't commit edits: ${gitMessage(err)}`,
      }
    }
  }

  // Every failure message after the auto-commit must tell the truth about
  // it: the edits are committed on the branch, and that commit survives
  // whatever happened to the merge.
  const committedNote = committedBranch
    ? ` Your uncommitted edits were committed onto '${branch}' first, and that commit is still on the branch.`
    : ''

  let branchTip: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', branch], {
      env: GIT_ENV,
    })
    branchTip = stdout.trim()
  } catch (err) {
    return {
      ok: false,
      committedBranch,
      reason: `Couldn't read the tip of '${branch}': ${gitMessage(err)}.${committedNote}`,
    }
  }

  // Already contains the source → nothing to merge, and saying so beats a
  // no-op merge commit. The auto-commit above may still have run, which is
  // why `committedBranch` rides on this result too.
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'merge-base', '--is-ancestor', sourceRef, branch],
      { env: GIT_ENV },
    )
    return { ok: true, branch, sha: branchTip, committedBranch, upToDate: true }
  } catch {
    // Not an ancestor — there is something to merge.
  }

  // Ephemeral worktree on a DETACHED head at the branch tip. Detached on
  // purpose: git refuses to check the checked-out branch into a second
  // worktree, and we don't want the branch ref moving until the merge is
  // known clean anyway.
  const tmp = path.join(root, '.desde', `update-${randomUUID().slice(0, 8)}`)
  try {
    await fs.mkdir(path.dirname(tmp), { recursive: true })
    await execFileAsync(
      'git',
      ['-C', root, 'worktree', 'add', '--quiet', '--detach', tmp, branch],
      { env: GIT_ENV },
    )
  } catch (err) {
    return {
      ok: false,
      committedBranch,
      reason: `Couldn't prepare the update: ${gitMessage(err)}.${committedNote}`,
    }
  }
  try {
    try {
      // `--no-verify` mirrors the rest of branch mode's git writes (see
      // `commitWorkingTree`): unlike publish's `merge --squash`, this
      // merge CREATES a commit, so without it the repo's commit-msg /
      // pre-merge-commit hooks run — and a failing commitlint/husky hook
      // would fail an update the user can't fix from the editor. The
      // timeout bounds what `--no-verify` can't (prepare-commit-msg and
      // post-merge hooks still fire): a hook that blocks instead of
      // failing would otherwise hang the editor while the caller holds
      // the exclusive tree lock.
      await execFileAsync(
        'git',
        ['-C', tmp, 'merge', '--no-verify', '--no-edit', '-m', `Merge ${sourceLabel} into ${branch}`, sourceRef],
        { env: GIT_ENV, timeout: MERGE_TIMEOUT_MS },
      )
    } catch (err) {
      // A failed merge is only a CONFLICT when there are unmerged paths.
      // Anything else (a hook that refused, unrelated histories, a killed
      // process) is a different failure and must carry git's actual
      // reason — reporting it as a conflict with an empty file list sends
      // the user off to resolve nothing.
      const conflictFiles = await listConflictedFiles(tmp)
      if (conflictFiles.length === 0) {
        return {
          ok: false,
          committedBranch,
          reason:
            `Couldn't merge '${sourceLabel}' into '${branch}': ` +
            `${firstLine(gitMessage(err))}${committedNote}`,
        }
      }
      return {
        ok: false,
        conflict: true,
        conflictFiles,
        committedBranch,
        reason:
          `Merging '${sourceLabel}' into '${branch}' hit conflicts, so the merge was ` +
          `abandoned and none of its changes reached your files.${committedNote} ` +
          `Resolve the conflicts with your own git tools, then try again.`,
      }
    }
    const { stdout } = await execFileAsync('git', ['-C', tmp, 'rev-parse', 'HEAD'], {
      env: GIT_ENV,
    })
    const mergeSha = stdout.trim()

    if (branch === current) {
      // Only touch the real checkout when it is still exactly the state we
      // merged from (same K11 discipline as publish's rebaseline): a
      // concurrent write in this window would otherwise be carried or
      // clobbered by the checkout the fast-forward performs.
      const settled =
        (await headSha(root)) === branchTip && !(await hasTrackedModifications(root))
      if (!settled) {
        return {
          ok: false,
          committedBranch,
          reason:
            'The working tree changed while the update was running, so the merge ' +
            `was not applied and none of its changes reached your files.${committedNote} ` +
            'Try again.',
        }
      }
      // `--ff-only` onto the merge commit: advances the branch ref and the
      // working tree in one step, cannot conflict, and refuses outright if
      // anything moved the branch since `branchTip`.
      try {
        await execFileAsync('git', ['-C', root, 'merge', '--ff-only', mergeSha], {
          env: GIT_ENV,
          timeout: MERGE_TIMEOUT_MS,
        })
      } catch (ffErr) {
        // The fast-forward is a multi-file checkout of the REAL working
        // tree, and a checkout that fails part-way (permission denied on
        // one file, disk full) leaves a mix of two commits behind. The
        // tree was verified settled just above (no tracked modifications,
        // HEAD at `branchTip`), so resetting back to the pre-merge tip is
        // a safe restore — untracked files survive a reset.
        let restored = false
        try {
          await execFileAsync('git', ['-C', root, 'reset', '--hard', branchTip], {
            env: GIT_ENV,
          })
          restored = true
        } catch {
          // Fall through to the honest partial-state message.
        }
        return {
          ok: false,
          committedBranch,
          reason: restored
            ? `Couldn't apply the update to your checkout: ${gitMessage(ffErr)}. ` +
              `Your branch was restored to where it was.${committedNote}`
            : `Applying the update failed part-way: ${gitMessage(ffErr)}. Your ` +
              `checkout may mix two commits. Run 'git status' in the repository ` +
              `and check it before continuing.${committedNote}`,
        }
      }
    } else {
      await execFileAsync('git', ['-C', root, 'branch', '-f', branch, mergeSha], {
        env: GIT_ENV,
      })
    }
    return { ok: true, branch, sha: mergeSha, committedBranch, upToDate: false }
  } catch (err) {
    return {
      ok: false,
      committedBranch,
      reason: `${gitMessage(err)}${committedNote}`,
    }
  } finally {
    await execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', tmp], {
      env: GIT_ENV,
    }).catch(() => {})
  }
}

/**
 * "Update from <default>" — merge the default branch into `branch`,
 * all-or-nothing (see {@link updateBranchFromRef}). This is the action the
 * publish-conflict message points at: bring the default's changes into the
 * branch so the next publish diffs cleanly.
 */
export async function updateFromDefault(
  root: string,
  branch: string,
): Promise<UpdateBranchResult> {
  const { defaultBranch } = await listBranches(root)
  if (!defaultBranch) {
    return {
      ok: false,
      committedBranch: false,
      reason: 'No default branch found to update from.',
    }
  }
  if (branch === defaultBranch) {
    return {
      ok: false,
      committedBranch: false,
      reason: "You're on the default branch. There's nothing to update from.",
    }
  }
  return updateBranchFromRef(root, branch, defaultBranch, defaultBranch)
}

/**
 * The branch's CONFIGURED upstream as a short name (`origin/main`, or
 * `origin/other` for a branch pushed under a different name), or null when
 * the branch has no upstream at all. This is what "Pull remote changes"
 * and the `behind` count must key on — hardcoding `origin/<branch>` breaks
 * both for any branch whose remote name differs from its local one, and
 * `behind` then reads 0, which is indistinguishable from up to date.
 */
export async function branchUpstream(
  root: string,
  branch: string,
): Promise<string | null> {
  if (!(await isValidBranchName(root, branch))) return null
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`],
      { env: GIT_ENV },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * "Pull remote changes" — merge the branch's configured upstream into
 * `branch`, all-or-nothing (see {@link updateBranchFromRef}). Reads the
 * REAL upstream (`<branch>@{upstream}`), not `origin/<branch>`: a branch
 * pushed as `origin/other` pulls from `origin/other`. A branch with no
 * upstream is refused by name — the UI disables the action for that case
 * too (`hasUpstream`), so this refusal is the backstop, not the surface.
 * Deliberately does NOT fetch: the caller runs {@link fetchOrigin} first,
 * OUTSIDE any tree lock, because the fetch is network I/O and the merge
 * is not.
 */
export async function updateFromRemote(
  root: string,
  branch: string,
): Promise<UpdateBranchResult> {
  if (!(await isValidBranchName(root, branch))) {
    return { ok: false, committedBranch: false, reason: `Invalid branch name: '${branch}'.` }
  }
  const upstream = await branchUpstream(root, branch)
  if (!upstream) {
    return {
      ok: false,
      committedBranch: false,
      reason: `'${branch}' has no upstream branch to pull from. Push the branch first, then pull.`,
    }
  }
  // Resolve through `@{upstream}` rather than spelling a refs/remotes/ path
  // so an unconventional upstream (a local tracking branch) still resolves.
  return updateBranchFromRef(root, branch, `${branch}@{upstream}`, upstream)
}

export type PushResult =
  | { ok: true; branch: string }
  | {
      ok: false
      reason: string
      /**
       * True when the remote refused a non-fast-forward push — the remote
       * branch has commits this checkout doesn't. The reason is already a
       * single plain sentence in that case (git's raw eight-line hint block
       * is replaced, not surfaced), and the right next action is "Pull
       * remote changes".
       */
      rejected?: boolean
    }

/**
 * Push a branch to `origin` (`git push -u origin <branch>`), setting the
 * upstream so subsequent pushes are bare `git push`. Relies entirely on
 * the user's own git credentials (SSH key / credential helper) — Editor
 * never handles auth. Surfaces git's stdout+stderr verbatim on failure so
 * the UI can show "no upstream / rejected / auth failed" as-is.
 *
 * Pushes committed history only; callers that want uncommitted edits
 * included must commit first (the push handler does, mirroring publish).
 */
export async function pushToOrigin(
  root: string,
  branch: string,
): Promise<PushResult> {
  if (!(await isValidBranchName(root, branch))) {
    return { ok: false, reason: `Invalid branch name: '${branch}'.` }
  }
  if (!(await branchExists(root, branch))) {
    return { ok: false, reason: `No branch named '${branch}'.` }
  }
  try {
    await execFileAsync('git', ['-C', root, 'push', '-u', 'origin', branch], {
      env: GIT_ENV,
    })
    return { ok: true, branch }
  } catch (err) {
    const msg = gitMessage(err)
    // A rejected push is ~8 lines of git output, five of them "hint:" —
    // useless in a toast. Classify it and say the one thing that matters
    // plus the action that fixes it (which is a real button now).
    if (/\[rejected\]|fetch first|non-fast-forward/i.test(msg)) {
      return {
        ok: false,
        rejected: true,
        reason:
          `GitHub has commits on '${branch}' that this checkout doesn't. ` +
          'Pull remote changes first, then push again.',
      }
    }
    return { ok: false, reason: msg }
  }
}

/**
 * Whether `branch` has commits not on its `origin/<branch>` remote-tracking
 * ref — i.e. there's something to push. Uses the local tracking ref (no
 * network), so it reflects the last fetch, which is accurate enough to
 * enable/disable the Push action. A branch that was never pushed (no
 * tracking ref) counts as unpushed. Best-effort → false on any git error.
 */
export async function hasUnpushedCommits(
  root: string,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      { env: GIT_ENV },
    )
  } catch {
    // No remote-tracking ref → never pushed; anything on the branch is new.
    return true
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'rev-list', '--count', `refs/remotes/origin/${branch}..${branch}`],
      { env: GIT_ENV },
    )
    return Number.parseInt(stdout.trim(), 10) > 0
  } catch {
    return false
  }
}

export type DiscardResult = { ok: true } | { ok: false; reason: string }

/**
 * Glob characters that make a git pathspec match MORE than the string it
 * spells. `path.resolve` happily turns `*` into `<root>/*` — a value that
 * is neither the root nor outside it, so a filesystem-path containment
 * check waves it through — and git then expands it tree-wide (audit S19).
 * `GIT_LITERAL_PATHSPECS` above already defuses this at the git boundary;
 * this is the second, lexical layer, so that a future call site that
 * forgets `GIT_ENV` doesn't silently re-open a tree-wide wipe.
 */
const PATHSPEC_MAGIC_RE = /[*?[\]]/

/**
 * One refusal wording for both halves of {@link resolveRepoRelative} —
 * escaping the root and spelling pathspec magic are different faults but
 * the same answer, and the UI shows this string verbatim.
 */
function discardRefusal(value: string): string {
  return `Not a plain file path inside the repo: '${value}'.`
}

/**
 * Lexical path-traversal guard for a caller-supplied repo-relative path.
 * Mirrors the first-line check the CLI handlers use — DELIBERATELY
 * divergent, not a missed dedup target: `editor-cli/src/server/
 * resolve-editable-path.ts` is the shared helper those handlers
 * (`edit-handler.ts`, `edit-iteration-handler.ts`, `file-read-handler.ts`,
 * `llm-fallback-handler.ts`, `text-branches-handler.ts`) now all go
 * through (audit Task 20 dedup), but every one of its call sites follows
 * the lexical check with `fs.realpath`, which assumes the target exists.
 * `discardFile` legitimately targets paths that don't exist right now (a
 * deleted file being restored, or a rename's original path before it's
 * recreated), so this stays pure string math with no realpath step.
 * `git`'s own pathspec resolution independently refuses paths outside the
 * repository as a second, redundant layer.
 */
function resolveRepoRelative(root: string, relativePath: string): string | null {
  // Refuse pathspec magic BEFORE the filesystem math, because the
  // filesystem math cannot see it: `*`, `?` and `[…]` are glob syntax, and
  // a leading `:` is pathspec magic (`:/` = top of tree, `:(glob)**` =
  // explicit glob mode). Both are legal filename characters, which is
  // exactly why they survive `path.resolve` — and why the check has to be
  // lexical rather than positional.
  if (relativePath.startsWith(':') || PATHSPEC_MAGIC_RE.test(relativePath)) return null
  const rootResolved = path.resolve(root)
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep
  const candidate = path.resolve(rootResolved, relativePath)
  // STRICTLY inside the root — the repo root itself is rejected. This is a
  // DESTRUCTIVE per-file endpoint: accepting "." / "" / the root as a
  // pathspec would turn `git checkout HEAD -- .` / `git clean -f -- .`
  // into a tree-wide wipe from one authenticated POST (codex P1).
  if (candidate !== rootResolved && candidate.startsWith(rootWithSep)) {
    return candidate
  }
  return null
}

/**
 * Discard one file's uncommitted changes back to HEAD — the Activity
 * panel's per-row "Discard changes" action (undo v1, tasks/*: git-backed,
 * distinct from the edit-service backup journal). `status` + `from` mirror
 * `WorkingTreeChange` (`listWorkingTreeChanges` above) exactly — callers
 * pass the same values that row already carries.
 *
 * Semantics per status:
 *  - `modified` / `deleted` — `git checkout HEAD -- <path>` restores both
 *    the working tree AND the index to HEAD's content in one step, so a
 *    partially-staged edit (`MM`) or a staged deletion discards fully
 *    rather than just falling back to whatever was staged.
 *  - `renamed` — the working tree right now has `from` gone and `path`
 *    present (git mv). `git reset -- <path> <from>` unstages both sides
 *    (restores `from`'s index entry to HEAD, drops `path`'s staged add),
 *    then `git checkout HEAD -- <from>` recreates the original file, then
 *    `git clean -f -- <path>` removes the now-untracked renamed-to file.
 *    Handles a rename with extra content edits on top (`RM`) the same way,
 *    since the checkout/clean steps don't care what `path`'s content was.
 *  - `added` — covers both untracked (`??`) and staged-but-uncommitted
 *    (`A`) files; neither exists in HEAD, so there's nothing to restore.
 *    `git reset -- <path>` unstages if needed (a harmless no-op on an
 *    already-untracked file), then `git clean -f -- <path>` removes it.
 *
 * Best-effort like the rest of this module's mutations: any git failure
 * (including a bad/missing path) is caught and reported as `{ ok: false }`
 * rather than thrown.
 */
export async function discardFile(
  root: string,
  relativePath: string,
  status: WorkingTreeChangeStatus,
  from?: string,
): Promise<DiscardResult> {
  if (resolveRepoRelative(root, relativePath) === null) {
    return { ok: false, reason: discardRefusal(relativePath) }
  }
  if (status === 'renamed') {
    if (!from) {
      return { ok: false, reason: "Missing original path for a renamed file." }
    }
    if (resolveRepoRelative(root, from) === null) {
      return { ok: false, reason: discardRefusal(from) }
    }
  }
  try {
    switch (status) {
      case 'modified':
      case 'deleted':
        await execFileAsync(
          'git',
          ['-C', root, 'checkout', 'HEAD', '--', relativePath],
          { env: GIT_ENV },
        )
        break
      case 'renamed':
        await execFileAsync(
          'git',
          ['-C', root, 'reset', '--', relativePath, from as string],
          { env: GIT_ENV },
        )
        await execFileAsync(
          'git',
          ['-C', root, 'checkout', 'HEAD', '--', from as string],
          { env: GIT_ENV },
        )
        await execFileAsync('git', ['-C', root, 'clean', '-f', '--', relativePath], {
          env: GIT_ENV,
        })
        break
      case 'added':
        await execFileAsync('git', ['-C', root, 'reset', '--', relativePath], {
          env: GIT_ENV,
        })
        await execFileAsync('git', ['-C', root, 'clean', '-f', '--', relativePath], {
          env: GIT_ENV,
        })
        break
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: gitMessage(err) }
  }
}

function dirtyTreeReason(current: string | null): string {
  const where = current ? `on '${current}'` : 'in your working tree'
  return (
    `You have uncommitted changes ${where}. Switching branches would carry ` +
    'them across. Commit them first (git commit -am "…") or discard them, ' +
    'then try again.'
  )
}

/** Combine git's stdout + stderr (git writes conflict/overwrite notices to
 *  stdout) into a single human-readable line for the UI. */
function gitMessage(err: unknown): string {
  const e = err as ExecFileException
  const stdout = typeof e.stdout === 'string' ? e.stdout : String(e.stdout ?? '')
  const stderr = typeof e.stderr === 'string' ? e.stderr : String(e.stderr ?? '')
  const combined = [stderr, stdout].filter(Boolean).join('\n').trim()
  return combined || (e.message ?? 'git command failed')
}

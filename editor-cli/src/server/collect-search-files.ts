/**
 * Collect the files the unique-text step is allowed to search: walk the
 * prototype's source tree (honoring `.gitignore` when it is a git repo),
 * apply the fixed exclusion list and extension allowlist, and read each
 * surviving file's contents, subject to a file-count limit, a per-file
 * size limit and a wall-clock budget.
 *
 * See `docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`
 * (section "Scope and limits") for the rules this file encodes, and
 * `docs/superpowers/plans/2026-09-21-unique-text-edit-plan.md` for the
 * fixed interface.
 *
 * This is the I/O half of the unique-text step; `find-unique-text.ts`
 * and `apply-unique-text-edit.ts` (`src/editor/edit-service/`) are the
 * pure halves that consume `SearchFile[]`.
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// Same rationale as `git-remote.ts`: deterministic, locale-independent
// output, and never block on another git process holding the lock file
// (we're only reading).
const GIT_ENV = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }

/**
 * One file the unique-text search can look at. `path` is repo-relative,
 * POSIX-separated. Duplicated from `find-unique-text.ts`
 * (`src/editor/edit-service/`) rather than imported: a static import
 * across the root/`editor-cli` package boundary doesn't resolve under
 * `npx tsx src/cli.ts` (see the `loadValidator` comment at the top of
 * `edit-handler.ts` for the general problem). Keep this shape in sync
 * with `find-unique-text.ts`'s `SearchFile` by hand.
 */
export interface SearchFile {
  path: string
  content: string
}

export interface CollectLimits {
  maxFiles: number
  maxFileBytes: number
  budgetMs: number
}

export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxFiles: 5000,
  maxFileBytes: 1_048_576,
  budgetMs: 1500,
}

export type CollectResult =
  | { ok: true; files: SearchFile[]; skippedLarge: number }
  | { ok: false; reason: string }

/**
 * Extensions the unique-text step will read. Duplicated from
 * `formatsForPath` in `src/editor/edit-service/text-encodings.ts` (the
 * source of truth for which extensions carry a known text format) —
 * not imported, for the same cross-package reason as `SearchFile`
 * above. Keep in sync by hand.
 */
const SEARCHABLE_EXTENSIONS = new Set([
  "json",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
  "html",
  "md",
  "mdx",
  "yml",
  "yaml",
])

// Directory names skipped at any depth, regardless of dot-prefix. Dot-files
// and dot-directories (`.git`, `.desde`, `.astro`, ...) are handled
// separately below by the leading-`.` rule, so most of the spec's
// build-output directories land there instead of here.
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  "__tests__",
  "__snapshots__",
  "__mocks__",
  "tests",
  "test",
  "e2e",
  "cypress",
  "playwright",
  "docs",
])

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
])

const TEST_BASENAME_RE = /\.(test|spec)\./
const CONFIG_BASENAME_RE = /\.config\./
const TSCONFIG_BASENAME_RE = /^tsconfig.*\.json$/i
const DOC_BASENAME_RE = /^(readme|changelog|license|contributing)(\.|-|$)/i

function toPosix(p: string): string {
  return p.split(path.sep).join("/")
}

function basenameOf(relPosixPath: string): string {
  const segments = relPosixPath.split("/")
  return segments[segments.length - 1] ?? ""
}

/**
 * Applies the spec's exclusion list to a repo-relative, POSIX-separated
 * path. Used on BOTH the git-sourced list and the walked list — git
 * ls-files honors `.gitignore` but knows nothing about `docs/`, tests,
 * or config files, so this always runs regardless of source.
 */
function isExcludedRelativePath(relPosixPath: string): boolean {
  const segments = relPosixPath.split("/").filter((seg) => seg.length > 0)
  if (segments.length === 0) return true

  // Dot-files and dot-directories are skipped at any depth, including
  // the file itself.
  if (segments.some((seg) => seg.startsWith("."))) return true

  // Excluded directory names, at any depth. Checking every segment
  // (including the basename) — not just ancestors — means a walk can
  // prune e.g. a top-level `node_modules/` entry before ever opening
  // it, rather than only excluding files discovered one level in.
  for (const seg of segments) {
    if (EXCLUDED_DIR_NAMES.has(seg)) return true
  }

  const basename = segments[segments.length - 1]
  if (LOCKFILE_NAMES.has(basename)) return true
  if (basename === "package.json") return true
  if (TSCONFIG_BASENAME_RE.test(basename)) return true
  if (CONFIG_BASENAME_RE.test(basename)) return true
  if (TEST_BASENAME_RE.test(basename)) return true
  if (DOC_BASENAME_RE.test(basename)) return true

  return false
}

function hasSearchableExtension(relPosixPath: string): boolean {
  const basename = basenameOf(relPosixPath)
  const dot = basename.lastIndexOf(".")
  if (dot <= 0) return false // no extension, or a dotfile with no name
  const ext = basename.slice(dot + 1).toLowerCase()
  return SEARCHABLE_EXTENSIONS.has(ext)
}

/**
 * True when `rootReal` is inside a git work tree — checked with
 * `git rev-parse --show-toplevel` run AT `rootReal`. Succeeds whether
 * `rootReal` IS the toplevel or a subdirectory of it; either way
 * `git -C rootReal ls-files` below naturally scopes its output to
 * `rootReal` (paths relative to it), so the caller doesn't need to
 * know which case it is.
 */
async function isInsideGitWorkTree(rootReal: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", rootReal, "rev-parse", "--show-toplevel"], {
      env: GIT_ENV,
    })
    return true
  } catch {
    return false
  }
}

/**
 * `git ls-files --cached --others --exclude-standard -z`, run at
 * `rootReal`. `--cached` lists tracked files, `--others
 * --exclude-standard` adds untracked-but-not-ignored files — together
 * this is "everything `.gitignore` would let you `git add`". `-z`
 * NUL-delimits so filenames with spaces or newlines survive.
 */
async function listGitFiles(rootReal: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", rootReal, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 },
  )
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(toPosix)
}

/**
 * Recursively walks `dir` collecting relative file paths, for the
 * non-git case. Excluded directories are pruned before recursing
 * (never descended into), and symlinks — files or directories — are
 * never followed: `fs.lstat` is the source of truth for entry type, so
 * a symlink that points outside `rootReal` is skipped rather than
 * silently walked into.
 */
async function walkDir(dir: string, rootReal: string, out: string[]): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = path.join(dir, name)
    const rel = toPosix(path.relative(rootReal, abs))
    if (isExcludedRelativePath(rel)) continue

    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(abs)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await walkDir(abs, rootReal, out)
    } else if (stat.isFile()) {
      out.push(rel)
    }
  }
}

async function listCandidatePaths(rootReal: string): Promise<string[]> {
  const raw = (await isInsideGitWorkTree(rootReal))
    ? await listGitFiles(rootReal)
    : await (async () => {
        const out: string[] = []
        await walkDir(rootReal, rootReal, out)
        return out
      })()
  return raw.filter((rel) => !isExcludedRelativePath(rel) && hasSearchableExtension(rel))
}

/**
 * Collects and reads the files the unique-text step is allowed to
 * search. Returns `{ok:false}` with a plain-English reason when a
 * limit is exceeded; otherwise the file contents, sorted by path for
 * determinism, plus a count of files skipped for being too large.
 *
 * `now` is injectable so tests can simulate the wall-clock budget
 * without a real 1.5s sleep.
 */
export async function collectSearchFiles(
  rootReal: string,
  limits: CollectLimits = DEFAULT_COLLECT_LIMITS,
  now: () => number = Date.now,
): Promise<CollectResult> {
  const start = now()

  const candidates = await listCandidatePaths(rootReal)
  if (candidates.length > limits.maxFiles) {
    return { ok: false, reason: `Too many files to search (over ${limits.maxFiles.toLocaleString("en-US")}).` }
  }
  candidates.sort()

  // Checkpoint: the walk (or `git ls-files`) that built `candidates` can
  // itself be slow on a large repo, so the budget is checked before any
  // file is read, not only between reads.
  if (now() - start > limits.budgetMs) {
    return { ok: false, reason: "Searching the project took too long." }
  }

  const files: SearchFile[] = []
  let skippedLarge = 0

  for (const rel of candidates) {
    if (now() - start > limits.budgetMs) {
      return { ok: false, reason: "Searching the project took too long." }
    }

    const abs = path.join(rootReal, rel)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(abs)
    } catch {
      // Vanished between listing and reading — skip silently.
      continue
    }
    if (stat.isSymbolicLink()) continue // never follow a symlink out of the root
    if (!stat.isFile()) continue

    if (stat.size > limits.maxFileBytes) {
      skippedLarge++
      continue
    }

    let content: string
    try {
      content = await fs.readFile(abs, "utf-8")
    } catch {
      // EACCES, a broken symlink that slipped past lstat, etc. — skip
      // silently rather than fail the whole search over one file.
      continue
    }

    files.push({ path: rel, content })
  }

  // Checkpoint: the last file's read can itself push past the budget, and
  // there's no further loop iteration left to catch that.
  if (now() - start > limits.budgetMs) {
    return { ok: false, reason: "Searching the project took too long." }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ok: true, files, skippedLarge }
}

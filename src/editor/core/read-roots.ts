/**
 * Read-roots — declared external repos a Editor session can read.
 *
 * The worktree is always implicit (name: `worktree`). Users add additional
 * read-only roots in `desde.config.json` at the repo root.
 * Common use case: pointing the agent at the production codebase the
 * prototype mirrors, so it can reference how a component is actually used.
 *
 * Rules (enforced here, not in the tools):
 *   - The worktree is always present and cannot be redefined.
 *   - Root names match /^[a-z][a-z0-9-]{0,30}$/ so they're safe to log
 *     and pass through tool args.
 *   - Paths resolve to absolute, with symlinks followed once at load time.
 *   - A declared root may be any directory. Whether it is a git repo is
 *     RECORDED (`isGit`), not required — see below.
 *
 * Two kinds of problem, deliberately given different severities:
 *
 *   - A **config** problem is fatal. A bad name, a reserved name, a missing
 *     `path` field, a path that points at a file, or a path that points at
 *     the worktree itself are all typos the user must fix, so they fail the
 *     session start loudly rather than silently dropping grounding.
 *   - An **environment** problem is a warning. A path that does not resolve —
 *     an unmounted drive, a repo the user moved or deleted — skips that one
 *     root and lets the session start. Until 2026-08-13 this aborted the whole
 *     CLI boot, which meant unplugging a drive made the editor unopenable.
 *
 * `isGit` exists because the read tools are not uniform: the git-backed ones
 * (`list_commits`, `diff_file`) can only work on a repo, while reading and
 * searching work on any directory through a plain-filesystem path. The tools
 * branch on this flag rather than probing for themselves.
 *
 * Pure, in the sense that the only I/O it does is read the config file
 * and invoke `git rev-parse` for validation. No tools call this — they
 * receive the resolved registry through `ToolContext.readRoots`.
 */

import { execFile } from 'node:child_process'
import { access, constants, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** A root the agent can read. Worktree is one of these too (synthesized). */
export interface ReadRoot {
  /** Stable name the model uses to reference this root in tool args. */
  name: string
  /** Absolute filesystem path, symlinks resolved. */
  path: string
  /** Free-form description shown to the model via `list_read_roots`. */
  description?: string
  /** True for the always-present worktree root; false for declared externals. */
  isWorktree: boolean
  /**
   * Whether this root is a git repository. Decides which access path the read
   * tools take: git-backed reads at a ref, or plain filesystem reads. The
   * commit-history tools refuse a root where this is false.
   */
  isGit: boolean
  /**
   * Where this root sits inside its git repo, as a repo-relative path with a
   * trailing slash. Empty for a repo root, `"packages/ui/"` for a folder
   * inside one.
   *
   * It is load-bearing, not informational. `git rev-parse` succeeds anywhere
   * inside a checkout, so pointing at a subdirectory yields `isGit: true`, and
   * `git show <ref>:<path>` resolves its path from the REPO ROOT regardless of
   * the working directory. MEASURED: a root of `/repo/packages/ui` asked for
   * `Button.ts` returned `/repo/Button.ts` — the wrong file, from outside the
   * folder the user granted. Every `ref:path` must therefore be prefixed with
   * this. (Pathspecs are cwd-relative and need no such treatment, which is why
   * `git grep` was already correctly scoped.)
   */
  gitPrefix: string
}

/** Resolved registry handed to tools via `ToolContext.readRoots`. */
export interface ReadRootRegistry {
  /** All readable roots, including the implicit `worktree`. */
  roots: readonly ReadRoot[]
  /** Look up a root by name. Returns `undefined` for unknown names. */
  resolve(name: string): ReadRoot | undefined
}

/**
 * Root names are passed through tool arguments and logged, so they stay to a
 * short lowercase slug. Exported so the config WRITER
 * (`read-root-declarations.ts`) validates against the same rule the LOADER
 * enforces — a writer that accepted a name this rejects would produce a config
 * that fails at the next boot.
 */
export const READ_ROOT_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
/** Names the loader synthesizes itself and a declaration may not claim. */
export const RESERVED_READ_ROOT_NAMES: ReadonlySet<string> = new Set(['worktree'])

const NAME_RE = READ_ROOT_NAME_RE
const RESERVED_NAMES = RESERVED_READ_ROOT_NAMES
/** Exported so sibling config-block loaders (e.g. design-system-declarations.ts) reuse the same filename constant instead of redeclaring it. */
export const CONFIG_FILENAME = 'desde.config.json'

interface RawConfig {
  readRoots?: Record<string, { path?: string; description?: string } | undefined>
}

export type LoadReadRootsResult =
  | { ok: true; registry: ReadRootRegistry; warnings: string[] }
  | { ok: false; errors: string[] }

/**
 * Load the read-roots registry for a worktree. Returns the registry on
 * success or a list of errors on failure (caller surfaces these to the
 * CLI / API client). Always succeeds with just the worktree root when no
 * config file is present — that's the unconfigured default.
 */
export async function loadReadRoots(opts: {
  worktreeRoot: string
  /** Pre-resolved git-repo check, for tests. Defaults to `git rev-parse`. */
  isGitRepo?: (absPath: string) => Promise<boolean>
}): Promise<LoadReadRootsResult> {
  const isGitRepo = opts.isGitRepo ?? defaultIsGitRepo
  const errors: string[] = []
  const warnings: string[] = []

  let worktreeAbs: string
  try {
    worktreeAbs = await realpath(opts.worktreeRoot)
  } catch (err) {
    return { ok: false, errors: [`worktree not accessible: ${(err as Error).message}`] }
  }

  // Worktree must itself be a git repo — editor-cli guarantees this
  // by construction (it boots from a git worktree), but check anyway so
  // future callers can't accidentally pass a non-repo.
  if (!(await isGitRepo(worktreeAbs))) {
    return {
      ok: false,
      errors: [`worktree root is not a git repo: ${worktreeAbs}`],
    }
  }

  const worktreeRoot: ReadRoot = {
    name: 'worktree',
    path: worktreeAbs,
    description: 'The editor worktree (the current editing session).',
    isWorktree: true,
    isGit: true, // guaranteed by the check immediately above
    gitPrefix: '',
  }

  const configPath = join(worktreeAbs, CONFIG_FILENAME)
  let raw: RawConfig | null
  try {
    raw = await readConfigFile(configPath)
  } catch (err) {
    return { ok: false, errors: [`${CONFIG_FILENAME}: ${(err as Error).message}`] }
  }

  if (!raw || !raw.readRoots) {
    return { ok: true, registry: makeRegistry([worktreeRoot]), warnings }
  }

  const declared: ReadRoot[] = []
  const seenPaths = new Map<string, string>() // absPath -> name (dedupe)

  for (const [name, entry] of Object.entries(raw.readRoots)) {
    if (!NAME_RE.test(name)) {
      errors.push(
        `${CONFIG_FILENAME}: invalid root name "${name}": must match /^[a-z][a-z0-9-]{0,30}$/`,
      )
      continue
    }
    if (RESERVED_NAMES.has(name)) {
      errors.push(`${CONFIG_FILENAME}: root name "${name}" is reserved`)
      continue
    }
    const rawPath = entry?.path
    if (!rawPath || typeof rawPath !== 'string') {
      errors.push(`${CONFIG_FILENAME}: root "${name}" is missing a "path"`)
      continue
    }

    // Resolve relative to the worktree, then follow symlinks once.
    const lexical = isAbsolute(rawPath) ? rawPath : resolvePath(worktreeAbs, rawPath)
    let absolute: string
    let entryStat: Awaited<ReturnType<typeof stat>>
    try {
      absolute = await realpath(lexical)
      entryStat = await stat(absolute)
      // A directory can exist and still be unusable: no read/execute permission
      // means every later read and search fails one at a time, with the root
      // presented to the agent as available. Better to skip it here and say so.
      if (entryStat.isDirectory()) await access(absolute, constants.R_OK | constants.X_OK)
    } catch {
      // Environment, not config: an unmounted drive or a moved repo skips this
      // root instead of aborting the session. See the severity split up top.
      warnings.push(
        `${CONFIG_FILENAME}: root "${name}" path not found or not readable, skipping it: ${lexical}`,
      )
      continue
    }

    if (!entryStat.isDirectory()) {
      errors.push(`${CONFIG_FILENAME}: root "${name}" is not a directory: ${absolute}`)
      continue
    }

    const dupName = seenPaths.get(absolute)
    if (dupName) {
      warnings.push(
        `${CONFIG_FILENAME}: root "${name}" points at the same path as "${dupName}" (${absolute}); keeping both`,
      )
    }
    seenPaths.set(absolute, name)

    if (absolute === worktreeAbs) {
      errors.push(
        `${CONFIG_FILENAME}: root "${name}" points at the worktree itself; use the implicit "worktree" root instead`,
      )
      continue
    }

    // Not a gate — a capability probe. A plain directory is a valid reference
    // root; it just reads through the filesystem path instead of through git.
    const gitBacked = await isGitRepo(absolute)

    declared.push({
      name,
      path: absolute,
      description: typeof entry?.description === 'string' ? entry.description : undefined,
      isWorktree: false,
      isGit: gitBacked,
      gitPrefix: gitBacked ? await gitPrefixOf(absolute) : '',
    })
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true, registry: makeRegistry([worktreeRoot, ...declared]), warnings }
}

function makeRegistry(roots: ReadRoot[]): ReadRootRegistry {
  const byName = new Map(roots.map((r) => [r.name, r]))
  return {
    roots: Object.freeze(roots.slice()),
    resolve(name) {
      return byName.get(name)
    },
  }
}

async function readConfigFile(absPath: string): Promise<RawConfig | null> {
  let text: string
  try {
    text = await readFile(absPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text) as RawConfig
  } catch (err) {
    throw new Error(`failed to parse: ${(err as Error).message}`)
  }
}

/**
 * Is this directory a git repository?
 *
 * Exported because the launcher's inspect route asks the same question when
 * the user picks a reference directory, and the answer must match what the
 * loader will decide at the next boot. Two probes could disagree — this one
 * runs with a sanitized environment and a timeout, which a naive
 * `existsSync('.git')` would not (it would also miss worktrees and submodules,
 * where `.git` is a file).
 */
export async function isGitRepository(absPath: string): Promise<boolean> {
  return defaultIsGitRepo(absPath)
}

/**
 * Where `absPath` sits inside its repo, per `git rev-parse --show-prefix`:
 * `""` at the root, `"packages/ui/"` in a subdirectory. Best-effort — an empty
 * string on failure means "treat it as the root", which is the behaviour that
 * existed before this was tracked.
 */
async function gitPrefixOf(absPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', absPath, 'rev-parse', '--show-prefix'], {
      timeout: 5_000,
      env: sanitizedGitEnv(),
    })
    // Only the line terminator. `trim()` would also eat a LEADING space, and
    // a directory may legally have one: `/repo/ ui` reports `" ui/"`, which
    // trimmed becomes `"ui/"` — a different, possibly existing sibling, so
    // reads would silently leave the folder the user granted. MEASURED.
    return stdout.replace(/\r?\n$/, '')
  } catch {
    return ''
  }
}

async function defaultIsGitRepo(absPath: string): Promise<boolean> {
  try {
    await execFileP('git', ['-C', absPath, 'rev-parse', '--git-dir'], {
      timeout: 5_000,
      env: sanitizedGitEnv(),
    })
    return true
  } catch {
    return false
  }
}

/**
 * Strip env vars that would let the parent process redirect git's view
 * of which repo it operates on. Used both here and in `git-runner.ts`.
 * Exported so the runner imports the same sanitizer rather than
 * duplicating the list.
 */
export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_CONFIG
  delete env.GIT_CONFIG_GLOBAL
  delete env.GIT_CONFIG_SYSTEM
  delete env.GIT_INDEX_FILE
  return env
}

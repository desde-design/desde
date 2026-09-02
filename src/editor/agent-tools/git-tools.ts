/**
 * Git-history + external-repo read tools.
 *
 * Five tools, all read-only, all using narrow `git` subcommands via
 * `git-runner.ts`. Will move into the in-process MCP server as
 * `mcp__editor__*` in Phase 1 of the SDK migration; for now they're
 * plain entries in the orchestrator's tool registry.
 *
 *   - list_read_roots         — discoverability for the agent
 *   - list_commits            — history listing, defaults to worktree
 *   - read_file_at_commit     — read a file at any commit (sha='HEAD'
 *                                gives current state of an external repo)
 *   - diff_file               — single-file unified diff between refs
 *   - search_external_files   — git grep, scoped to a declared external
 *                                root (worktree uses built-in search_files)
 *
 * Every tool that takes a `root` argument validates it against
 * `ctx.readRoots` before any subprocess starts. Unknown roots return a
 * structured error that lists the valid names — the model never sees
 * raw filesystem paths.
 */

import type { ReadRoot, ReadRootRegistry } from '../core/read-roots'
import { GitRunnerError, runGit, validateRef, validateSha } from './git-runner'
import { readFileFromRoot } from './read-root-fs'
import type { ToolContext, ToolEntry, ToolResult } from './types'

const DEFAULT_ROOT = 'worktree'

// Byte separators used in the `git log --pretty=format:%x1f / %x00` output.
// Source uses fromCharCode so no literal NUL appears in this file (Write
// tooling tends to strip embedded control bytes).
const FIELD_SEP = String.fromCharCode(0x1f)
const RECORD_SEP = String.fromCharCode(0x00)

/** Bytes for a single `read_file_at_commit` response — same as `read_file`. */
const READ_FILE_AT_COMMIT_MAX_BYTES = 200 * 1024
/** Max commits returned by `list_commits` in one call. */
const LIST_COMMITS_HARD_CAP = 100
const LIST_COMMITS_DEFAULT = 30
/** Max lines `diff_file` emits before truncating. */
const DIFF_FILE_LINE_CAP = 500
/** Max bytes the git grep tool's output can return. */
const GREP_MAX_BYTES = 256 * 1024
/** Max grep matches returned to the model. */
const GREP_MAX_MATCHES = 200
/**
 * Noise never worth searching in a reference directory, applied only on the
 * `--no-index` path. The git path needs none of this: it searches tracked
 * files at HEAD, so build output and dependencies are already absent.
 */
const PLAIN_SEARCH_EXCLUDES = [
  // Every pattern is `glob`-magic and anchored with `**/`, which matches zero
  // or more leading directories. Plain `:(exclude)node_modules` only excludes
  // the TOP-LEVEL one, so a monorepo reference checkout still walked
  // `packages/app/node_modules` and could exhaust the output cap before
  // reaching a real match.
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob)**/vendor/**',
  // Dot-entries: the second pattern covers directories, the first covers files
  // such as a root `.env`, which the directory pattern alone leaves searchable.
  ':(exclude,glob)**/.*',
  ':(exclude,glob)**/.*/**',
]

// ─── Shared helpers ─────────────────────────────────────────────────

function resolveRoot(
  ctx: ToolContext,
  name: string | undefined,
): { ok: true; root: ReadRoot } | { ok: false; error: string } {
  const registry = ctx.readRoots
  if (!registry) {
    return {
      ok: false,
      error:
        'read roots are not configured for this session. Git tools are unavailable. Add a desde.config.json to the worktree to declare external repos.',
    }
  }
  const which = name && name.length > 0 ? name : DEFAULT_ROOT
  const root = registry.resolve(which)
  if (!root) {
    return {
      ok: false,
      error: `unknown read root "${which}". Available: ${describeRoots(registry)}`,
    }
  }
  return { ok: true, root }
}

/**
 * Refusal for a tool that only has meaning on a git repo, when the root is a
 * plain directory.
 *
 * Stated as a capability of the ROOT rather than a failure of the call, and it
 * names what still works. A reference directory the user added on purpose
 * should not read to the agent as broken just because it has no history — the
 * next move is `read_file_at_commit` or `search_external_files`, both of which
 * work fine on it.
 */
function refuseNonGitRoot(root: ReadRoot, tool: string): ToolResult {
  return {
    ok: false,
    error: `read root "${root.name}" is a plain directory, not a git repository, so ${tool} does not apply to it. Its files are still readable. Use read_file_at_commit (the ref is ignored) or search_external_files.`,
  }
}

/**
 * Strip a root's absolute path out of a git error before the model sees it.
 *
 * `git` names the directory it failed on: a moved or unmounted reference
 * folder yields `fatal: cannot change to '/Users/…/production-web'`. That is
 * the one place the user's filesystem layout escapes, and the read-root tools
 * withhold paths everywhere else on purpose (`list_read_roots` returns names
 * and descriptions only). Substituting the root's NAME keeps the message
 * actionable without turning an I/O failure into a disclosure.
 */
function redactRootPath(root: ReadRoot, message: string): string {
  if (root.path.length === 0) return message
  return message.split(root.path).join(`<read root "${root.name}">`)
}

function describeRoots(registry: ReadRootRegistry): string {
  return registry.roots.map((r) => `"${r.name}"`).join(', ')
}

/**
 * Reject control chars (U+0000 through U+001F, plus U+007F) in paths.
 * A charCodeAt scan is robust against source-text mangling that strips
 * literal control bytes from regex character classes.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function validatePath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty string' }
  }
  if (hasControlChar(path)) {
    return { ok: false, error: 'path contains control characters' }
  }
  // Leading `-` is fine — every git invocation that takes a path passes
  // `--` before it, so paths cannot be interpreted as flags.
  return { ok: true, path }
}

// ─── list_read_roots ────────────────────────────────────────────────

interface ListReadRootsOutput {
  roots: Array<{
    name: string
    description?: string
    isWorktree: boolean
    isGit: boolean
    usage: string
  }>
}

/**
 * What to CALL for this root, in words, not a flag to reason from.
 *
 * MEASURED 2026-08-14, driving a real chat turn: given `isGit: false` and a
 * tool named `read_file_at_commit`, the agent concluded the tool "requires a
 * git ref" and that "there's no other tool available to read files from
 * non-git external roots", then gave up WITHOUT CALLING IT. The capability was
 * live the whole time. A boolean states a fact about the root; the model has to
 * infer the affordance from it, and against a tool name that says "at commit"
 * it inferred the wrong one.
 */
function usageFor(root: ReadRoot): string {
  if (root.isGit) {
    return 'Git-backed: read_file_at_commit, search_external_files, list_commits and diff_file all work.'
  }
  return (
    'Plain directory, NOT a git repo. Reading and searching still work: call ' +
    'read_file_at_commit with sha="HEAD" (the sha is ignored and the file is read live from ' +
    'disk), and search_external_files to search it. Only the history tools (list_commits, ' +
    'diff_file) do not apply.'
  )
}

export const listReadRootsTool: ToolEntry<Record<string, never>> = {
  def: {
    name: 'list_read_roots',
    description:
      'List every readable root for this session — the implicit "worktree" plus any reference directories declared in desde.config.json. Returns names + descriptions only, never raw filesystem paths. Call this first if you plan to read from a non-worktree root. Every root is readable and searchable; each one carries a `usage` string naming exactly which tools to call for it. Follow `usage` rather than inferring from `isGit` — a root with isGit false is still fully readable, it just has no commit history.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const registry = ctx.readRoots
    if (!registry) {
      return { ok: false, error: 'read roots are not configured for this session' }
    }
    const output: ListReadRootsOutput = {
      roots: registry.roots.map((r) => ({
        name: r.name,
        description: r.description,
        isWorktree: r.isWorktree,
        // Tells the model which tools apply before it calls one and gets
        // refused: history needs a repo, reading and searching do not.
        isGit: r.isGit,
        usage: usageFor(r),
      })),
    }
    return { ok: true, output }
  },
}

// ─── list_commits ───────────────────────────────────────────────────

interface ListCommitsInput {
  root?: string
  limit?: number
  sinceRef?: string
  path?: string
  grep?: string
  author?: string
}

interface CommitSummary {
  sha: string
  shortSha: string
  author: string
  date: string
  subject: string
}

export const listCommitsTool: ToolEntry<ListCommitsInput> = {
  def: {
    name: 'list_commits',
    description: `List commits in a read root (default "worktree"). Returns oldest-to-newest, up to ${LIST_COMMITS_HARD_CAP} entries. Use this to see what's changed recently, find the commit that introduced a bug, or browse history before drilling in with diff_file / read_file_at_commit. For external repos (declared in desde.config.json) this is how you discover refs to read at.`,
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        root: {
          type: 'string' as const,
          description: 'Read root name (default "worktree"). Call list_read_roots to see what is available.',
        },
        limit: {
          type: 'number' as const,
          description: `Max commits to return. Default ${LIST_COMMITS_DEFAULT}, hard cap ${LIST_COMMITS_HARD_CAP}.`,
        },
        sinceRef: {
          type: 'string' as const,
          description:
            'Only return commits reachable from HEAD but NOT from this ref. E.g. "main" to see commits the current branch has that main does not.',
        },
        path: {
          type: 'string' as const,
          description: 'Restrict to commits that touched this repo-relative path.',
        },
        grep: { type: 'string' as const, description: 'Filter by commit-message substring.' },
        author: { type: 'string' as const, description: 'Filter by author substring.' },
      },
    },
  },
  async run(input, ctx) {
    const rootResult = resolveRoot(ctx, input.root)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root
    if (!root.isGit) return refuseNonGitRoot(root, 'list_commits')

    const limit = clampInt(input.limit ?? LIST_COMMITS_DEFAULT, 1, LIST_COMMITS_HARD_CAP)

    // Field separator: 0x1f (US). Record separator: 0x00 (NUL).
    // Both are bytes that never appear in shas, names, dates, or
    // single-line subjects, so they are unambiguous splitters.
    const args: string[] = [
      'log',
      `--max-count=${limit}`,
      '--reverse',
      '--no-color',
      '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x00',
    ]
    if (input.sinceRef) {
      try {
        args.push(`${validateRef(input.sinceRef)}..HEAD`)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
    if (input.grep) args.push(`--grep=${input.grep}`)
    if (input.author) args.push(`--author=${input.author}`)
    if (input.path) {
      const p = validatePath(input.path)
      if (!p.ok) return { ok: false, error: p.error }
      args.push('--', p.path)
    }

    let stdout: string
    try {
      stdout = await runGit(root.path, args, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 })
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    // `git log --pretty=format:` joins records with a literal newline,
    // so the second-and-later records start with a leading '\n' once we
    // split on the NUL terminator. Strip it before splitting fields.
    const commits: CommitSummary[] = []
    for (const raw of stdout.split(RECORD_SEP)) {
      const record = raw.startsWith('\n') ? raw.slice(1) : raw
      if (!record) continue
      const parts = record.split(FIELD_SEP)
      if (parts.length < 5) continue
      commits.push({
        sha: parts[0],
        shortSha: parts[1],
        author: parts[2],
        date: parts[3],
        subject: parts.slice(4).join(FIELD_SEP),
      })
    }

    return {
      ok: true,
      output: {
        root: root.name,
        count: commits.length,
        commits,
      },
    }
  },
}

// ─── read_file_at_commit ────────────────────────────────────────────

interface ReadFileAtCommitInput {
  root?: string
  path: string
  sha: string
}

export const readFileAtCommitTool: ToolEntry<ReadFileAtCommitInput> = {
  def: {
    name: 'read_file_at_commit',
    description: `Read a file out of any read root. Despite the name this is NOT git-only: it is the single way to read a file from a non-worktree root, and it works on plain directories as well as git repos. For a git-backed root the file is read at the given commit (use sha="HEAD" for current state). For a plain directory (isGit false in list_read_roots) pass sha="HEAD" and the file is read live from disk with the sha ignored, which the result says in a note. Up to ${READ_FILE_AT_COMMIT_MAX_BYTES} bytes; oversized files return an error with the actual size so you can decide whether to drill in with diff_file instead.`,
    inputSchema: {
      type: 'object' as const,
      required: ['path', 'sha'],
      additionalProperties: false,
      properties: {
        root: {
          type: 'string' as const,
          description: 'Read root name (default "worktree").',
        },
        path: {
          type: 'string' as const,
          description: 'Repo-relative path to read.',
        },
        sha: {
          type: 'string' as const,
          description: 'Commit sha or named ref (HEAD, HEAD~1, branch name, tag).',
        },
      },
    },
  },
  async run(input, ctx) {
    const rootResult = resolveRoot(ctx, input.root)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root

    const pathResult = validatePath(input.path)
    if (!pathResult.ok) return { ok: false, error: pathResult.error }

    // A plain reference directory has no refs. Read it live from disk and say
    // so, rather than refusing: reading a file is exactly what the user added
    // the directory for, and `sha` is the only part of the request that has no
    // meaning here.
    if (!root.isGit) {
      const fsResult = await readFileFromRoot(
        root.path,
        pathResult.path,
        READ_FILE_AT_COMMIT_MAX_BYTES,
      )
      if (!fsResult.ok) return { ok: false, error: fsResult.error }
      return {
        ok: true,
        output: {
          root: root.name,
          path: pathResult.path,
          sha: null,
          content: fsResult.content,
          bytes: fsResult.bytes,
          note: 'This read root is a plain directory, not a git repository. The file was read live from disk and the requested sha was ignored.',
        },
      }
    }

    let ref: string
    try {
      // Accept either a sha or a named ref; the model uses sha='HEAD' a lot.
      ref = /^[0-9a-f]{4,64}$/.test(input.sha) ? validateSha(input.sha) : validateRef(input.sha)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    // Repo-root-relative, because that is how git resolves `<ref>:<path>` no
    // matter what the working directory is. Without the prefix a root of
    // `/repo/packages/ui` asked for `Button.ts` returns `/repo/Button.ts`:
    // the wrong file, from outside the folder the user granted.
    const refPath = `${root.gitPrefix}${pathResult.path}`

    // Pre-flight size check via `cat-file -s` — cheap, lets us refuse
    // oversized reads without buffering megabytes through Node.
    let size: number
    try {
      const sizeStr = (
        await runGit(root.path, ['cat-file', '-s', `${ref}:${refPath}`], {
          signal: ctx.signal,
          maxBytes: 256,
        })
      ).trim()
      size = parseInt(sizeStr, 10)
      if (!Number.isFinite(size)) {
        return { ok: false, error: `could not determine size of ${pathResult.path} at ${ref}` }
      }
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    if (size > READ_FILE_AT_COMMIT_MAX_BYTES) {
      return {
        ok: false,
        error: `file is ${size} bytes; max is ${READ_FILE_AT_COMMIT_MAX_BYTES}. Use diff_file to see what changed, or read a smaller file.`,
      }
    }

    let content: string
    try {
      content = await runGit(root.path, ['show', `${ref}:${refPath}`], {
        signal: ctx.signal,
        maxBytes: READ_FILE_AT_COMMIT_MAX_BYTES + 1024,
      })
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    return {
      ok: true,
      output: {
        root: root.name,
        path: pathResult.path,
        sha: ref,
        content,
        bytes: size,
      },
    }
  },
}

// ─── diff_file ──────────────────────────────────────────────────────

interface DiffFileInput {
  root?: string
  path: string
  fromRef?: string
  toRef?: string
}

export const diffFileTool: ToolEntry<DiffFileInput> = {
  def: {
    name: 'diff_file',
    description: `Single-file unified diff between two refs in a read root. Defaults: fromRef = previous commit (HEAD~1), toRef = HEAD. Use this to see what changed in a file across a commit, branch, or arbitrary range. Output is capped at ${DIFF_FILE_LINE_CAP} lines; longer diffs are truncated with a marker.`,
    inputSchema: {
      type: 'object' as const,
      required: ['path'],
      additionalProperties: false,
      properties: {
        root: { type: 'string' as const, description: 'Read root name (default "worktree").' },
        path: {
          type: 'string' as const,
          description: 'Repo-relative path of the file to diff.',
        },
        fromRef: {
          type: 'string' as const,
          description: 'Starting ref (default "HEAD~1").',
        },
        toRef: {
          type: 'string' as const,
          description: 'Ending ref (default "HEAD").',
        },
      },
    },
  },
  async run(input, ctx) {
    const rootResult = resolveRoot(ctx, input.root)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root
    if (!root.isGit) return refuseNonGitRoot(root, 'diff_file')

    const pathResult = validatePath(input.path)
    if (!pathResult.ok) return { ok: false, error: pathResult.error }

    let fromRef: string
    let toRef: string
    try {
      fromRef = validateRef(input.fromRef ?? 'HEAD~1')
      toRef = validateRef(input.toRef ?? 'HEAD')
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    let stdout: string
    try {
      stdout = await runGit(
        root.path,
        ['diff', '--no-color', `${fromRef}..${toRef}`, '--', pathResult.path],
        { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 },
      )
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    const lines = stdout.split('\n')
    const truncated = lines.length > DIFF_FILE_LINE_CAP
    const head = truncated
      ? lines.slice(0, DIFF_FILE_LINE_CAP).join('\n') + '\n…[truncated]'
      : stdout

    return {
      ok: true,
      output: {
        root: root.name,
        path: pathResult.path,
        fromRef,
        toRef,
        diff: head,
        truncated,
        totalLines: lines.length,
      },
    }
  },
}

// ─── search_external_files ──────────────────────────────────────────

interface SearchExternalFilesInput {
  root: string
  query: string
  paths?: string[]
}

export const searchExternalFilesTool: ToolEntry<SearchExternalFilesInput> = {
  def: {
    name: 'search_external_files',
    description:
      "Search files in a declared reference directory for a regex pattern. On a git-backed root this is `git grep` over the tracked files at HEAD; on a plain directory it is a filesystem walk that skips node_modules, build output and dot-directories. For the worktree, use the built-in search_files tool instead — it already works. Use this when you want to find how a component is used in production source, or pull patterns from a reference codebase.",
    inputSchema: {
      type: 'object' as const,
      required: ['root', 'query'],
      additionalProperties: false,
      properties: {
        root: {
          type: 'string' as const,
          description: 'Read root name (must NOT be "worktree" — use search_files for that).',
        },
        query: {
          type: 'string' as const,
          description: 'Regex pattern to search for.',
        },
        paths: {
          type: 'array' as const,
          description:
            'Optional pathspec list to narrow the search (e.g. ["src/components/**"]). Repo-relative.',
          items: { type: 'string' as const },
        },
      },
    },
  },
  async run(input, ctx) {
    const rootResult = resolveRoot(ctx, input.root)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root
    if (root.isWorktree) {
      return {
        ok: false,
        error:
          'search_external_files does not operate on the worktree. Use the built-in search_files tool for that.',
      }
    }
    if (typeof input.query !== 'string' || input.query.length === 0) {
      return { ok: false, error: 'query must be a non-empty string' }
    }
    if (input.query.length > 500) {
      return { ok: false, error: 'query too long (max 500 chars)' }
    }
    const paths = Array.isArray(input.paths) ? input.paths : []
    for (const p of paths) {
      const v = validatePath(p)
      if (!v.ok) return { ok: false, error: v.error }
    }
    // Refuse a leading-dash query outright, even though `-e` below already
    // stops git from parsing it as an option. This is defense in depth: a
    // model that requests `-f/etc/passwd` or `--open-files-in-pager=...`
    // is exhibiting attack behavior worth surfacing as a refusal, not
    // silently neutralizing and running anyway.
    if (input.query.startsWith('-')) {
      return { ok: false, error: 'query must not start with "-": that could be parsed as a git option' }
    }


    // `git grep -n -E --no-color -e <query> HEAD -- <paths>`. The `HEAD`
    // tree-ish is load-bearing: without it `git grep` searches the
    // working tree, which on an external repo may contain dirty /
    // unreproducible state — defeating the "external reads are
    // commit-bound" invariant the SDK runtime relies on. With a
    // tree-ish, output lines are prefixed `HEAD:<path>:…` which the
    // parser below strips. `-E` forces extended regex. `-e <query>`
    // (not a bare positional) is what protects the QUERY — it tells
    // git's option parser to treat the next argv slot as a pattern no
    // matter what it starts with, so an agent-supplied query can never
    // be parsed as a flag (e.g. `--open-files-in-pager=…`, `-f<path>`).
    // `--` separates options from pathspecs and is what protects PATHS,
    // which are validated above via validatePath — it does nothing for
    // query, which sits before it.
    // A plain directory has no HEAD to scope to, so `--no-index` searches the
    // directory itself. Deliberately still `git grep` and not a JS regex walk:
    // `RegExp.test` backtracks, so a pattern like `^(a+)+$` against one long
    // line blocks the whole Editor process, and neither the query-length cap
    // nor an AbortSignal can interrupt a single synchronous evaluation. POSIX
    // ERE in a subprocess is linear-time and killable, and it keeps one output
    // format (and one parser) for both kinds of root.
    const tree = root.isGit ? 'HEAD' : null
    // `-I` skips binary files. Without it git emits `Binary file <path>
    // matches`, which has no line number and no text, so the parser below
    // turns it into an unstructured `{ raw }` entry that still counts toward
    // the match cap: one binary asset can crowd out real source results.
    // Applied to both kinds of root, because the two should answer the same
    // shape of result.
    const args = ['grep', '-n', '-E', '-I', '--no-color', '--full-name', '-e', input.query]
    if (tree) {
      args.push(tree)
      if (paths.length > 0) args.push('--', ...paths)
    } else {
      // Index 1, not 0: `git-runner.ts` reads args[0] as the subcommand and
      // checks it against an allowlist, so unshifting the flag made the
      // runner refuse `--no-index` as an unknown subcommand.
      args.splice(1, 0, '--no-index')
      // The exclusions are unconditional here: a reference checkout is often a
      // whole production repo, and without a `.gitignore` of its own
      // `--no-index` would search its `node_modules` and drown real matches.
      args.push('--', ...(paths.length > 0 ? paths : ['.']), ...PLAIN_SEARCH_EXCLUDES)
    }

    let stdout: string
    try {
      stdout = await runGit(root.path, args, { signal: ctx.signal, maxBytes: GREP_MAX_BYTES })
    } catch (err) {
      // `git grep` exits 1 when there are no matches — surface that as
      // a successful empty result, not a tool error.
      if (err instanceof GitRunnerError && err.code === 1 && !err.stderr) {
        return { ok: true, output: { root: root.name, query: input.query, matches: [], count: 0 } }
      }
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    const treePrefix = tree ? `${tree}:` : ''
    const matches = stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .map((line) => {
        // Format with tree-ish: `<tree>:<path>:<lineno>:<text>`. Strip
        // the tree prefix before applying the no-tree parser below so
        // the model never sees `HEAD:` polluting the path field.
        let stripped =
          treePrefix.length > 0 && line.startsWith(treePrefix)
            ? line.slice(treePrefix.length)
            : line
        // Then strip the root's own position inside its repo. `--full-name`
        // reports repo-root-relative paths, so a root of `/repo/packages/ui`
        // yields `packages/ui/Button.ts` — which `read_file_at_commit` would
        // prefix AGAIN, asking for `packages/ui/packages/ui/Button.ts`. Every
        // path the model sees must be relative to the folder it was granted,
        // so search-then-read round-trips.
        if (root.gitPrefix.length > 0 && stripped.startsWith(root.gitPrefix)) {
          stripped = stripped.slice(root.gitPrefix.length)
        }
        const firstColon = stripped.indexOf(':')
        const secondColon = firstColon >= 0 ? stripped.indexOf(':', firstColon + 1) : -1
        if (firstColon < 0 || secondColon < 0) return { raw: stripped }
        return {
          path: stripped.slice(0, firstColon),
          line: parseInt(stripped.slice(firstColon + 1, secondColon), 10),
          text: stripped.slice(secondColon + 1),
        }
      })

    return {
      ok: true,
      output: {
        root: root.name,
        query: input.query,
        count: matches.length,
        matches: matches.slice(0, GREP_MAX_MATCHES),
        truncated: matches.length > GREP_MAX_MATCHES,
      },
    }
  },
}

// ─── session_status ─────────────────────────────────────────────────
//
// Answers "what has THIS editing session changed?" against the session's
// pinned `rootCommitSha`. Unlike `list_commits`, this also surfaces the
// dirty (uncommitted) tree state — the agent's most common ask after
// running a verification command that produced no output.
//
// Requires `ctx.rootCommitSha` — in branch mode this is the merge-base of
// HEAD with the default branch, recomputed per turn. Contexts that can't
// resolve one get a
// clean error instead of a phantom result.

interface SessionStatusOutput {
  branch: string
  rootCommitSha: string
  headSha: string
  commitsAheadOfRoot: number
  dirtyFiles: Array<{ path: string; status: string }>
}

export const sessionStatusTool: ToolEntry<Record<string, never>> = {
  def: {
    name: 'session_status',
    description:
      "Snapshot of the current branch: name, base commit (merge-base with the default branch), HEAD, how many commits are on the branch, and any uncommitted dirty files. Use this to answer 'what have I changed?'. In branch mode edits land UNCOMMITTED in the working tree by default — there is no auto-commit — so the dirty-file list is normally where your work shows up. Read-only.",
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  async run(_input, ctx) {
    const rootResult = resolveRoot(ctx, DEFAULT_ROOT)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root
    if (!root.isWorktree) {
      return { ok: false, error: 'session_status only operates on the implicit "worktree" root' }
    }
    if (!ctx.rootCommitSha) {
      return {
        ok: false,
        error:
          'session_status could not resolve a base commit for this branch. Usually a detached HEAD, no resolvable default branch, or a git error. See branchModeRootCommitSha in src/editor/worktree/git-branches.ts.',
      }
    }

    let branch = ''
    try {
      branch = (await runGit(root.path, ['rev-parse', '--abbrev-ref', 'HEAD'], {
        signal: ctx.signal,
        maxBytes: 4096,
      })).trim()
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    let headSha = ''
    try {
      headSha = (await runGit(root.path, ['rev-parse', 'HEAD'], {
        signal: ctx.signal,
        maxBytes: 4096,
      })).trim()
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    let commitsAheadOfRoot = 0
    try {
      const rev = validateSha(ctx.rootCommitSha)
      const out = (
        await runGit(root.path, ['rev-list', '--count', `${rev}..HEAD`], {
          signal: ctx.signal,
          maxBytes: 1024,
        })
      ).trim()
      commitsAheadOfRoot = parseInt(out, 10)
      if (!Number.isFinite(commitsAheadOfRoot)) commitsAheadOfRoot = 0
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    // `--porcelain=v1 -z` emits NUL-separated entries: `XY <path>\0`
    // (or `XY <new>\0<old>\0` for renames). Use the NUL parse rather
    // than the porcelain v2 to keep the output format identical to
    // the existing session-log shape.
    let dirtyFiles: Array<{ path: string; status: string }> = []
    try {
      const out = await runGit(root.path, ['status', '--porcelain=v1', '-z'], {
        signal: ctx.signal,
        maxBytes: 512 * 1024,
      })
      dirtyFiles = parsePorcelainV1(out)
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    const output: SessionStatusOutput = {
      branch,
      rootCommitSha: ctx.rootCommitSha,
      headSha,
      commitsAheadOfRoot,
      dirtyFiles,
    }
    return { ok: true, output }
  },
}

/**
 * Parse `git status --porcelain=v1 -z` output into a flat list of
 * `{path, status}`. Rename entries (`R` / `C`) emit two NUL-terminated
 * fields per entry — `<new>\0<old>` — so the parser advances twice for
 * those. Skips entries where the leading two-char status is malformed,
 * which shouldn't happen for v1 output but defends against truncation.
 */
function parsePorcelainV1(raw: string): Array<{ path: string; status: string }> {
  const out: Array<{ path: string; status: string }> = []
  const entries = raw.split(RECORD_SEP)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3) // skip "XY "
    out.push({ path, status: collapseStatus(xy) })
    // Rename / copy: the next NUL field is the old path; consume it.
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++
    }
  }
  return out
}

/**
 * Collapse the 2-char porcelain status into a single uppercase letter
 * the model can reason about: `A`/`M`/`D`/`R`/`C`/`U`/`?` (untracked).
 * Working-tree state (column 2) is preferred over index state when
 * they differ, so a file the agent just wrote shows as `M`/`A` rather
 * than the staged value `space`, which is not yet committed.
 */
function collapseStatus(xy: string): string {
  if (xy === '??') return '?'
  const x = xy[0]
  const y = xy[1]
  if (y && y !== ' ') return y.toUpperCase()
  if (x && x !== ' ') return x.toUpperCase()
  return '?'
}

// ─── session_diff ───────────────────────────────────────────────────
//
// Unified diff between the session's base commit and the current state
// of the worktree (committed + uncommitted). Mirrors what the Activity
// panel uses (collectSessionLog) but returns the full diff text the
// agent can reason about rather than just file-level statuses.

interface SessionDiffInput {
  path?: string
  maxLines?: number
}

interface SessionDiffOutput {
  rootCommitSha: string
  path: string | null
  diff: string
  truncated: boolean
  totalLines: number
}

export const sessionDiffTool: ToolEntry<SessionDiffInput> = {
  def: {
    name: 'session_diff',
    description: `Unified diff of what the current editing session has changed against its base commit (committed + uncommitted). Pass no \`path\` for the full session diff across all files; pass a worktree-relative path to scope it. Output capped at ${DIFF_FILE_LINE_CAP} lines by default; raise via \`maxLines\` (hard cap ${DIFF_FILE_LINE_CAP * 4}).`,
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        path: {
          type: 'string' as const,
          description: 'Optional worktree-relative path to limit the diff to a single file.',
        },
        maxLines: {
          type: 'number' as const,
          description: `Override the default cap of ${DIFF_FILE_LINE_CAP} diff lines. Hard ceiling ${DIFF_FILE_LINE_CAP * 4}.`,
        },
      },
    },
  },
  async run(input, ctx) {
    const rootResult = resolveRoot(ctx, DEFAULT_ROOT)
    if (!rootResult.ok) return { ok: false, error: rootResult.error }
    const root = rootResult.root
    if (!root.isWorktree) {
      return { ok: false, error: 'session_diff only operates on the implicit "worktree" root' }
    }
    if (!ctx.rootCommitSha) {
      return {
        ok: false,
        error:
          'session_diff could not resolve a base commit for this branch. Usually a detached HEAD, no resolvable default branch, or a git error. See branchModeRootCommitSha in src/editor/worktree/git-branches.ts.',
      }
    }

    let rev: string
    try {
      rev = validateSha(ctx.rootCommitSha)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    let pathArg: string | null = null
    if (input.path !== undefined && input.path !== null) {
      const p = validatePath(input.path)
      if (!p.ok) return { ok: false, error: p.error }
      pathArg = p.path
    }

    // No second commit passed → diff against the working tree, so the
    // result includes uncommitted edits. Matches collectSessionLog's
    // behavior (session-log.ts) so the agent and the Activity panel
    // see the same set of files.
    const args = ['diff', '--no-color', rev]
    if (pathArg !== null) args.push('--', pathArg)

    let stdout: string
    try {
      stdout = await runGit(root.path, args, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 })
    } catch (err) {
      return { ok: false, error: redactRootPath(root, gitErrorMessage(err)) }
    }

    const requestedMax = clampInt(
      input.maxLines ?? DIFF_FILE_LINE_CAP,
      50,
      DIFF_FILE_LINE_CAP * 4,
    )
    const lines = stdout.split('\n')
    const truncated = lines.length > requestedMax
    const head = truncated
      ? lines.slice(0, requestedMax).join('\n') + '\n…[truncated]'
      : stdout

    const output: SessionDiffOutput = {
      rootCommitSha: rev,
      path: pathArg,
      diff: head,
      truncated,
      totalLines: lines.length,
    }
    return { ok: true, output }
  },
}

// ─── Helpers ────────────────────────────────────────────────────────

function clampInt(n: unknown, min: number, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : min
  return Math.max(min, Math.min(max, v))
}

function gitErrorMessage(err: unknown): string {
  if (err instanceof GitRunnerError) {
    return err.stderr ? err.stderr : err.message
  }
  return (err as Error).message
}

export function toolResultIsError(r: ToolResult): r is { ok: false; error: string } {
  return r.ok === false
}

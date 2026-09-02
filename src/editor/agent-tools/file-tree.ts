/**
 * Phase 4 read tool: `list_files`.
 *
 * Lists files under a repo-relative directory. Skips a small set of
 * always-noise paths (`node_modules`, `.git`, `dist`, build outputs)
 * so the agent doesn't waste a turn paginating through them. NOT a
 * gitignore-aware listing — that would need a real ignore parser. The
 * agent can fall back to `search_files` (ripgrep, which IS gitignore-
 * aware) when it needs precision.
 *
 * Returns up to `MAX_ENTRIES` per call. The agent paginates by passing
 * deeper `dir` paths.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveRepoPath } from './read-tools'
import type { ToolEntry, ToolResult } from './types'

const LIST_FILES_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    dir: {
      type: 'string' as const,
      description:
        'Repo-relative directory to list (e.g. "src/components"). Empty string lists the repo root.',
    },
    depth: {
      type: 'number' as const,
      description:
        'Max recursion depth. 1 = direct children only (default). Larger values list deeper subtrees.',
    },
  },
}

interface ListFilesInput {
  dir?: string
  depth?: number
}

const MAX_ENTRIES = 500
const DEFAULT_DEPTH = 1

/**
 * Hardcoded skip list for directories that are noise in 99% of
 * agent-prompt sessions. Keep this conservative — anything skipped
 * here is invisible to the agent even when explicitly requested.
 */
const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  'coverage',
  '.DS_Store',
])

export const listFilesTool: ToolEntry<ListFilesInput> = {
  def: {
    name: 'list_files',
    description: `List files and directories under a repo-relative path. Returns up to ${MAX_ENTRIES} entries (sorted, directories first). Skips node_modules, .git, dist, build, and similar noise paths. For full-text search across the repo use search_files instead.`,
    inputSchema: LIST_FILES_SCHEMA,
  },
  async run(input, ctx): Promise<ToolResult> {
    const dir = input.dir ?? ''
    const depth =
      typeof input.depth === 'number' && input.depth > 0 ? Math.min(input.depth, 5) : DEFAULT_DEPTH

    // Empty dir → list repo root. Don't reject — it's a useful default.
    const resolved =
      dir.length === 0
        ? { ok: true as const, absolute: ctx.repoRoot }
        : await resolveRepoPath(ctx.repoRoot, dir)
    if (!resolved.ok) return { ok: false, error: resolved.reason }

    const entries: Array<{ path: string; type: 'file' | 'dir' }> = []
    try {
      await walk(resolved.absolute, dir, depth, entries)
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno === 'ENOENT') {
        return { ok: false, error: `directory not found: ${dir || '(repo root)'}` }
      }
      if (errno === 'ENOTDIR') {
        return { ok: false, error: `not a directory: ${dir}` }
      }
      return { ok: false, error: (err as Error).message }
    }
    const truncated = entries.length > MAX_ENTRIES
    return {
      ok: true,
      output: {
        dir: dir || '(repo root)',
        entries: entries.slice(0, MAX_ENTRIES),
        truncated,
        totalSeen: entries.length,
      },
    }
  },
}

async function walk(
  absolute: string,
  relative: string,
  remainingDepth: number,
  out: Array<{ path: string; type: 'file' | 'dir' }>,
): Promise<void> {
  if (remainingDepth <= 0) return
  if (out.length >= MAX_ENTRIES) return
  const children = await readdir(absolute, { withFileTypes: true })
  // Sort: directories first (alphabetical), then files (alphabetical).
  // Makes the output predictable for both the LLM and tests.
  children.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1
    const bDir = b.isDirectory() ? 0 : 1
    if (aDir !== bDir) return aDir - bDir
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  for (const child of children) {
    if (out.length >= MAX_ENTRIES) return
    if (ALWAYS_SKIP.has(child.name)) continue
    const childRel = relative ? `${relative}/${child.name}` : child.name
    const childAbs = join(absolute, child.name)
    if (child.isDirectory()) {
      out.push({ path: childRel, type: 'dir' })
      if (remainingDepth > 1) {
        await walk(childAbs, childRel, remainingDepth - 1, out)
      }
    } else if (child.isFile()) {
      out.push({ path: childRel, type: 'file' })
    }
    // Symlinks intentionally not followed — `resolveRepoPath` already
    // refuses files that resolve outside the repo, but inside-repo
    // symlinks could create cycles. Skip them.
  }
}

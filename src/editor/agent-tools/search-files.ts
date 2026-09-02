/**
 * Phase 4 read tool: `search_files`.
 *
 * Ripgrep wrapper. Spawns `rg` as a subprocess scoped to `repoRoot`
 * and returns matches as `{ file, line, text }` entries. Honors the
 * project's .gitignore for free (rg's default behavior), so the agent
 * doesn't have to special-case `node_modules` / `.git` / etc.
 *
 * If `rg` isn't installed, surfaces a clear error so the agent can
 * fall back to `list_files` + `read_file`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ToolEntry, ToolResult } from './types'

const SEARCH_FILES_SCHEMA = {
  type: 'object' as const,
  required: ['pattern'],
  additionalProperties: false,
  properties: {
    pattern: {
      type: 'string' as const,
      description:
        'Regex or literal substring to search for. Ripgrep regex syntax (Rust). Use `\\b` for word boundaries.',
    },
    glob: {
      type: 'string' as const,
      description:
        'Optional ripgrep glob to scope the search (e.g. "*.vue", "src/**/*.ts"). Multiple globs not supported in this V1; use list_files first to narrow if needed.',
    },
    fixed: {
      type: 'boolean' as const,
      description:
        'When true, treat `pattern` as a literal string (no regex). Default false.',
    },
    maxResults: {
      type: 'number' as const,
      description: 'Max match lines returned. Default 100, hard cap 500.',
    },
  },
}

interface SearchFilesInput {
  pattern: string
  glob?: string
  fixed?: boolean
  maxResults?: number
}

interface SearchHit {
  file: string
  line: number
  text: string
}

const DEFAULT_MAX = 100
const HARD_CAP = 500

export const searchFilesTool: ToolEntry<SearchFilesInput> = {
  def: {
    name: 'search_files',
    description: `Search for a pattern across the repo via ripgrep. Returns match lines with file:line:text. Honors .gitignore. Use this before propose_overwrite if you need to find where a component is used, where a string appears, or what files reference a symbol. Default ${DEFAULT_MAX} match cap, hard ${HARD_CAP}.`,
    inputSchema: SEARCH_FILES_SCHEMA,
  },
  async run(input, ctx): Promise<ToolResult> {
    if (typeof input.pattern !== 'string' || input.pattern.length === 0) {
      return { ok: false, error: 'pattern must be a non-empty string' }
    }
    const max = Math.min(
      typeof input.maxResults === 'number' && input.maxResults > 0
        ? input.maxResults
        : DEFAULT_MAX,
      HARD_CAP,
    )
    const args = ['--json', '--max-count', String(max)]
    if (input.fixed) args.push('--fixed-strings')
    if (input.glob) {
      args.push('--glob', input.glob)
    }
    args.push('--', input.pattern)

    return new Promise<ToolResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child: ChildProcessWithoutNullStreams = spawn('rg', args, {
        cwd: ctx.repoRoot,
        // Pass only PATH so ripgrep can be located but other env
        // doesn't leak. Cast to ProcessEnv because Node's strict type
        // demands NODE_ENV; rg doesn't read it.
        env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv,
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          resolve({
            ok: false,
            error: 'ripgrep (rg) not installed; cannot search. Use list_files + read_file instead.',
          })
          return
        }
        resolve({ ok: false, error: `rg failed: ${err.message}` })
      })
      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8')
        // Soft circuit-breaker: 2 MB of JSON output is ~20k hits; cap
        // long before the agent's context blows up.
        if (stdout.length > 2 * 1024 * 1024) {
          child.kill('SIGTERM')
        }
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8')
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
        if (code === 2) {
          resolve({ ok: false, error: `rg error: ${stderr.trim() || 'exit 2'}` })
          return
        }
        const hits = parseRipgrepJson(stdout, max)
        resolve({
          ok: true,
          output: {
            pattern: input.pattern,
            hits,
            truncated: hits.length >= max,
          },
        })
      })

      ctx.signal?.addEventListener(
        'abort',
        () => {
          if (settled) return
          child.kill('SIGTERM')
        },
        { once: true },
      )
    })
  },
}

/**
 * Parse ripgrep's NDJSON output. We only care about `type === "match"`
 * entries; `begin`, `end`, `context`, etc. are dropped.
 */
function parseRipgrepJson(raw: string, max: number): SearchHit[] {
  const hits: SearchHit[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0 || hits.length >= max) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const obj = parsed as { type?: string; data?: unknown }
    if (obj.type !== 'match' || !obj.data) continue
    const data = obj.data as {
      path?: { text?: string }
      line_number?: number
      lines?: { text?: string }
    }
    const path = data.path?.text
    const lineNum = data.line_number
    const text = data.lines?.text
    if (typeof path !== 'string' || typeof lineNum !== 'number' || typeof text !== 'string') {
      continue
    }
    hits.push({
      file: path,
      line: lineNum,
      text: text.replace(/\n$/, ''),
    })
  }
  return hits
}

/**
 * Phase 1 read tools: `get_selection`, `get_page_info`, `read_file`.
 *
 * `get_selection` and `get_page_info` round-trip through the bridge
 * (the shell handles them by reading its Zustand store / iframe state).
 * `read_file` is local to editor-cli's filesystem (path-traversal
 * checked against `repoRoot`). Each tool is a pure async function;
 * errors are returned, never thrown.
 */

import { realpath } from 'node:fs/promises'
import { readFile as fsReadFile } from 'node:fs/promises'
import { resolve as resolvePath, relative as pathRelative, sep as pathSep } from 'node:path'

import type { ToolContext, ToolEntry, ToolResult } from './types'

// ─── get_selection ──────────────────────────────────────────────────

const GET_SELECTION_SCHEMA = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
}

type GetSelectionInput = Record<string, never>

export const getSelectionTool: ToolEntry<GetSelectionInput> = {
  def: {
    name: 'get_selection',
    description:
      "Get the user's current selection in the editor: the selected component, the source file it lives in, its props, its position in the component tree, and the surrounding ancestry. Returns null when nothing is selected. Always check this first when the user refers to 'this', 'the button', 'this component', etc.",
    inputSchema: GET_SELECTION_SCHEMA,
  },
  async run(_input, ctx) {
    try {
      const result = await ctx.bridge.send('chat:get_selection', undefined, {
        signal: ctx.signal,
      })
      return { ok: true, output: result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── get_page_info ──────────────────────────────────────────────────

const GET_PAGE_INFO_SCHEMA = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
}

type GetPageInfoInput = Record<string, never>

// ─── pin_selections (Phase 6 multi-select) ──────────────────────────

const PIN_SELECTIONS_SCHEMA = {
  type: 'object' as const,
  required: ['selectors'],
  additionalProperties: false,
  properties: {
    selectors: {
      type: 'array' as const,
      description:
        'CSS selectors to pin as a multi-selection. Each is resolved via the bridge; unresolvable selectors are silently skipped. Pass an empty array to clear multi-select.',
      items: { type: 'string' as const },
    },
  },
}

interface PinSelectionsInput {
  selectors: string[]
}

export const pinSelectionsTool: ToolEntry<PinSelectionsInput> = {
  def: {
    name: 'pin_selections',
    description:
      "Pin multiple elements as a simultaneous selection (the chat header will show 'N selected'). Use when the user refers to 'these buttons' / 'the cards in this row' and you need to keep them all in scope across the turn. Subsequent get_selection calls will return all pinned selections.",
    inputSchema: PIN_SELECTIONS_SCHEMA,
  },
  async run(input, ctx) {
    if (!Array.isArray(input.selectors)) {
      return { ok: false, error: 'selectors must be an array of CSS strings' }
    }
    try {
      const result = await ctx.bridge.send(
        'chat:pin_selections',
        { selectors: input.selectors },
        { signal: ctx.signal },
      )
      return { ok: true, output: result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

export const getPageInfoTool: ToolEntry<GetPageInfoInput> = {
  def: {
    name: 'get_page_info',
    description:
      "Get information about the page the user is currently viewing in the iframe: the URL, the route (pathname), the detected framework (e.g. 'vue3', 'react'), and the page title if available. Use this to understand which page the user is working on before reading source files.",
    inputSchema: GET_PAGE_INFO_SCHEMA,
  },
  async run(_input, ctx) {
    try {
      const result = await ctx.bridge.send('chat:get_page_info', undefined, {
        signal: ctx.signal,
      })
      return { ok: true, output: result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── read_file ──────────────────────────────────────────────────────

const READ_FILE_SCHEMA = {
  type: 'object' as const,
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: {
      type: 'string' as const,
      description: 'Repo-relative path to the file to read (e.g. "src/components/Button.vue").',
    },
  },
}

interface ReadFileInput {
  path: string
}

/**
 * Repo-relative path resolution with traversal protection. Returns the
 * absolute path if `path` resolves inside `repoRoot`; rejects with a
 * reason otherwise. Follows the same pattern as
 * `editor-cli/src/server/edit-handler.ts`'s file guard so future
 * write tools (Phase 2/4) share the same boundary check.
 *
 * **Symlink escape defense:** we `realpath` BOTH the repo root AND the
 * resolved target (when it exists) before the containment check.
 * Without this, a symlink inside the repo pointing at `/Users/X/.ssh/`
 * would pass the lexical check (the link itself lives under the root)
 * but `fs.readFile` follows the link and reads outside-repo bytes.
 * When the target doesn't exist yet (no symlink to follow), fall back
 * to the lexical resolution — the caller's `readFile` will return
 * ENOENT and we surface it cleanly.
 */
export async function resolveRepoPath(
  repoRoot: string,
  inputPath: string,
): Promise<{ ok: true; absolute: string } | { ok: false; reason: string }> {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, reason: 'path must be a non-empty string' }
  }
  let resolvedRoot: string
  try {
    resolvedRoot = await realpath(repoRoot)
  } catch (err) {
    return { ok: false, reason: `repo root not accessible: ${(err as Error).message}` }
  }
  const lexical = resolvePath(resolvedRoot, inputPath)
  // Lexical check first — catches `..` traversal without touching the fs.
  const lexRel = pathRelative(resolvedRoot, lexical)
  if (lexRel === '..' || lexRel.startsWith('..' + pathSep) || lexRel.startsWith('../')) {
    return { ok: false, reason: `path '${inputPath}' escapes repo root` }
  }
  // Now follow symlinks on the actual target. If realpath fails with
  // ENOENT, the target doesn't exist yet — the read will surface that
  // and there are no symlinks to follow, so the lexical check is
  // sufficient. Any other error (permissions, EACCES) propagates.
  let resolvedTarget = lexical
  try {
    resolvedTarget = await realpath(lexical)
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code
    if (errno !== 'ENOENT') {
      return { ok: false, reason: `path not accessible: ${(err as Error).message}` }
    }
  }
  const targetRel = pathRelative(resolvedRoot, resolvedTarget)
  if (targetRel === '..' || targetRel.startsWith('..' + pathSep) || targetRel.startsWith('../')) {
    return { ok: false, reason: `path '${inputPath}' resolves outside repo root via symlink` }
  }
  return { ok: true, absolute: resolvedTarget }
}

/**
 * Max bytes returned in a single `read_file` call. The LLM has limited
 * context; large files should be sampled in pieces by future
 * tools (e.g. `read_file_range`). 200 KB is enough for the typical
 * SFC and well within Claude's input budget even when several files
 * are read in one turn.
 */
export const READ_FILE_MAX_BYTES = 200 * 1024

export const readFileTool: ToolEntry<ReadFileInput> = {
  def: {
    name: 'read_file',
    description: `Read the contents of a file in the repo. Path is repo-relative. Returns up to ${READ_FILE_MAX_BYTES} bytes; larger files are truncated with a notice.`,
    inputSchema: READ_FILE_SCHEMA,
  },
  async run(input, ctx) {
    const resolved = await resolveRepoPath(ctx.repoRoot, input.path)
    if (!resolved.ok) {
      return { ok: false, error: resolved.reason }
    }
    try {
      // Read as Buffer first so we can truncate at the byte level; the
      // alternative (read as string and slice) doesn't honor the byte
      // cap when the file contains multi-byte chars.
      const buf = await fsReadFile(resolved.absolute)
      const truncated = buf.length > READ_FILE_MAX_BYTES
      const slice = truncated ? buf.subarray(0, READ_FILE_MAX_BYTES) : buf
      const content = slice.toString('utf8')
      return {
        ok: true,
        output: {
          path: input.path,
          content,
          truncated,
          totalBytes: buf.length,
        },
      }
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno === 'ENOENT') {
        return { ok: false, error: `file not found: ${input.path}` }
      }
      if (errno === 'EISDIR') {
        return { ok: false, error: `not a file: ${input.path}` }
      }
      return { ok: false, error: (err as Error).message }
    }
  },
}

/**
 * Dispatch a tool call by name. Returns an error result if the name
 * isn't registered — the orchestrator surfaces this back to the LLM as
 * a tool_result so the model can correct the next call.
 */
export async function runTool(
  registry: ReadonlyArray<ToolEntry>,
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entry = registry.find((t) => t.def.name === name)
  if (!entry) {
    return { ok: false, error: `unknown tool: '${name}'` }
  }
  return entry.run(input, ctx)
}

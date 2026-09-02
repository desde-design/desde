/**
 * Read-root / git / verification tool handlers: `list_read_roots`,
 * `list_commits`, `read_file_at_commit`, `diff_file`,
 * `search_external_files`, `session_status`, `session_diff`, and
 * `run_verification`. Split out of `editor-tool-handlers.ts` (Phase 4
 * mechanical split, share-readiness) — all eight are thin adapters over the
 * legacy `agent-tools/git-tools.ts` + `agent-tools/verification-tools.ts`
 * `ToolEntry` registries, dispatched through the one shared
 * {@link dispatchReadRootTool} helper, so they're colocated with it here
 * rather than split across two files.
 *
 * `editor-tools.ts` keeps the `tool()` schema declarations and wires them
 * to the handlers exported here — same pattern as `save-screenshot-plan-tool.ts`
 * / `heal-plan-step-tool.ts` / `fs-structural-tools.ts`.
 */
import {
  diffFileTool,
  listCommitsTool,
  listReadRootsTool,
  readFileAtCommitTool,
  searchExternalFilesTool,
  sessionDiffTool,
  sessionStatusTool,
} from '../agent-tools/git-tools'
import type { ToolContext, ToolEntry, ToolResult } from '../agent-tools/types'
import { runVerificationTool } from '../agent-tools/verification-tools'
import type { ReadRootRegistry } from '../core/read-roots'
import type { VerificationAdapter, VerificationCheck } from '../core/verification-adapter'

import type { EditorToolContext, EditorToolResult } from './editor-tool-handlers'

// ─── Git / external-root handlers ──────────────────────────────────
//
// All eight share the same shape: build a ToolContext with the
// session's readRoots, dispatch to the legacy ToolEntry, translate
// the result to EditorToolResult.
//
// The underlying tools never touch `ctx.bridge` — they shell out to
// `git` via runGit. We pass the real bridge through so the type
// matches; a stub would also work but the indirection is free.

export interface ReadRootToolContext extends EditorToolContext {
  /**
   * Read-root registry for the session. Optional so callers without
   * a config file get a clean "not configured" error from each tool
   * rather than a type error at the call site.
   */
  readRoots?: ReadRootRegistry
  /**
   * Session's pinned base commit. Required by `session_status` /
   * `session_diff` (which scope to "what THIS editing session has
   * changed"). Absent for non-worktree-session contexts — those tools
   * surface a clear error to the model.
   */
  rootCommitSha?: string
  /**
   * Substrate-neutral verification runner. Powers `run_verification`.
   * Absent in non-CLI contexts; the tool then surfaces a clean
   * "not configured" error.
   */
  verificationAdapter?: VerificationAdapter
}

export interface ListCommitsInput {
  root?: string
  limit?: number
  sinceRef?: string
  path?: string
  grep?: string
  author?: string
}

export interface ReadFileAtCommitInput {
  root?: string
  path: string
  sha: string
}

export interface DiffFileInput {
  root?: string
  path: string
  fromRef?: string
  toRef?: string
}

export interface SearchExternalFilesInput {
  root: string
  query: string
  paths?: string[]
}

export interface SessionDiffInput {
  path?: string
  maxLines?: number
}

export function listReadRoots(
  ctx: ReadRootToolContext,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(listReadRootsTool, {}, ctx)
}

export function listCommits(
  ctx: ReadRootToolContext,
  input: ListCommitsInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(listCommitsTool, input, ctx)
}

export function readFileAtCommit(
  ctx: ReadRootToolContext,
  input: ReadFileAtCommitInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(readFileAtCommitTool, input, ctx)
}

export function diffFile(
  ctx: ReadRootToolContext,
  input: DiffFileInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(diffFileTool, input, ctx)
}

export function searchExternalFiles(
  ctx: ReadRootToolContext,
  input: SearchExternalFilesInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(searchExternalFilesTool, input, ctx)
}

export function sessionStatus(
  ctx: ReadRootToolContext,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(sessionStatusTool, {}, ctx)
}

export function sessionDiff(
  ctx: ReadRootToolContext,
  input: SessionDiffInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(sessionDiffTool, input, ctx)
}

export interface RunVerificationInput {
  check: VerificationCheck
}

export function runVerification(
  ctx: ReadRootToolContext,
  input: RunVerificationInput,
): Promise<EditorToolResult> {
  return dispatchReadRootTool(runVerificationTool, input, ctx)
}

async function dispatchReadRootTool<Input>(
  entry: ToolEntry<Input>,
  input: Input,
  ctx: ReadRootToolContext,
): Promise<EditorToolResult> {
  // ToolContext requires `repoRoot`; the git tools never read it
  // (they read root paths from the registry) so an empty string is
  // fine. Sentinel value rather than undefined so a future tool that
  // accidentally reads `repoRoot` gets a deterministic failure.
  const toolCtx: ToolContext = {
    bridge: ctx.bridge,
    repoRoot: '',
    readRoots: ctx.readRoots,
    rootCommitSha: ctx.rootCommitSha,
    verificationAdapter: ctx.verificationAdapter,
    signal: ctx.signal,
  }
  let result: ToolResult
  try {
    result = await entry.run(input, toolCtx)
  } catch (err) {
    return {
      content: [{ type: 'text', text: (err as Error).message }],
      isError: true,
    }
  }
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.output) }],
  }
}

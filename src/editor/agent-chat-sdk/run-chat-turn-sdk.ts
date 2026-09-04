/**
 * SDK-backed chat orchestrator — the only chat runtime (the legacy in-house
 * orchestrator was removed 2026-07-21; see `tasks/worktree-mode-decommission.md`).
 * Runs one user turn through the Claude Agent SDK and emits `ChatStreamEvent`s
 * the chat UI consumes.
 *
 * Built-in `Read`/`Edit`/`Write`/`Glob`/`Grep` plus the in-process MCP tools
 * from `editor-tools.ts` (bridge round-trips, `propose_prop_edit`, the
 * read-root/verification family, the filesystem-structural write tools, and
 * design-system grounding queries). `canUseTool` translates each Write/Edit
 * into an `edit_proposed` SSE event with reconstructed `newSource` +
 * `baseHash`. The system prompt uses `{preset: 'claude_code', append: ...}`
 * so the model keeps Claude Code's built-in tool descriptions and the
 * Editor-specific append only carries net-new content (domain framing,
 * MCP tools, branch-mode lifecycle, context envelope, project conventions —
 * see `system-prompt.ts`). SDK session resume: the first turn captures
 * `session_id` from the SDKSystemMessage init event; subsequent turns pass
 * it back via `options.resume` so the SDK rebuilds full conversation state
 * from its own JSONL store — Editor's session record links to it via
 * `ChatSession.sdkSessionId`.
 */

import { randomUUID } from 'node:crypto'
import { join as joinPath } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'

import type {
  BridgeClient,
  EditProposalPayload,
} from '../agent-tools/types'
import {
  AUTH_REAUTH_MESSAGE,
  extractRetryAfterFromError,
  isAuthError,
} from '../agent-chat/classify-turn-error'
import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import type {
  ChatAssistantBlock,
  ChatConflictRecord,
  ChatFileReadRecord,
  ChatPageSnapshot,
  ChatSelectionSnapshot,
  ChatSession,
  ChatSteeredMessage,
  ChatToolResult,
  ChatTurn,
} from '../agent-chat/types'
import type { ProjectKnowledge } from '../core/project-knowledge'
import type { GroundingService } from '../core/grounding'
import type { ReadRootRegistry } from '../core/read-roots'
import type { EffortLevel } from '../core/model-catalog'
import { costOfTurn } from '../llm-providers/rate-cards'

import { runWithChatSession } from '../edit-service/chat-session-context'
import { getSharedEditHistory } from '../edit-service/edit-history'
import { findRecentWriterForFile } from '../agent-chat/session-store'
import { branchModeRootCommitSha } from '../worktree/git-branches'
import {
  assertClaudeRuntimeReady,
  DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE,
  resolveClaudeExecutablePath,
} from '../llm-providers/resolve-claude-executable'

import type { ModelImageContent } from './media-content'
import { buildEditorToolServer } from './editor-tools'
import {
  lookupRecentCrossSessionWriter,
  recordCrossSessionWrite,
} from './cross-session-write-log'
import { buildCanUseTool, type OverwriteConflictDetected } from './edit-ack'
import { createReadSnapshotHook, type FileReadRecord } from './file-read-snapshot'
import { createSdkWriteGuard, type AcquireWriteLock } from './sdk-write-guard'
import type { AcquireTreeGate } from './write-broker'
import { createWriteInvalidateHook } from './write-invalidate-hook'
import { writeProposalBlob } from './proposal-blob-store'
import { createSdkEventAdapter } from './sdk-event-adapter'
import { flattenSdkMessage } from './sdk-message-flatten'
import {
  createTurnInputChannel,
  readAssistantMessageBoundaryId,
  type TurnInputChannel,
} from './turn-input-channel'
import { buildSdkSystemPrompt } from './system-prompt'
import { buildGroundingDigest } from './grounding-tools'

/** Built-in tools we expose to the model on the SDK runtime. */
const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch'] as const

/** SDK default model when none is specified. Exported so the model
 * catalog can assert it stays in sync (anthropic-model-catalog.test.ts). */
export const DEFAULT_SDK_MODEL = 'claude-opus-4-8'

export interface RunChatTurnSdkOpts {
  bridge: BridgeClient
  /** Repo root the SDK edits (branch mode: the user's working tree). SDK runs against this as `cwd`. */
  worktreeRoot: string
  /**
   * Deterministically replays a editor write into the Vite dev
   * pipeline (the CLI wires `invalidateViteModules`). Passed through
   * to the structural write tools (insert_component, scaffold_route,
   * delete_file, …) AND to a PostToolUse hook on the SDK's built-in
   * Write/Edit (write-invalidate-hook.ts), so the dev server re-serves
   * an edited file immediately instead of waiting on the OS watcher.
   * Optional — tests / non-CLI callers omit it.
   */
  invalidateFiles?: (files: string[]) => void
  /**
   * Acquires the CLI's per-file edit lock for a repo-relative path and
   * resolves with its release function (`acquireFileEditLock` in
   * editor-cli/src/server/session-lock.ts). Injected rather than imported so
   * this package stays free of `editor-cli/` dependencies while chat writes
   * still land in the SAME lock namespace as `/api/editor/edit` writes.
   *
   * Wired by the CLI chat route for FOREGROUND turns only. Deliberately
   * absent for the edit-fix mini-turn, which the edit route already runs under
   * the EXCLUSIVE tree gate (`withTreeLock`) — acquiring the SHARED gate from
   * inside that exclusive holder would self-deadlock. Without it the write
   * guard still journals originals; serialization comes from the tree gate.
   *
   * See `sdk-write-guard.ts` for the hold window and release paths.
   */
  acquireWriteLock?: AcquireWriteLock
  /**
   * Acquires the repo's SHARED tree gate for the structural write tools'
   * `brokeredWrite` calls (`acquireTreeGateShared` in
   * editor-cli/src/server/session-lock.ts) — A2, round-2 whole-branch
   * review finding, 2026-08-19. Injected for the SAME reason
   * `acquireWriteLock` is: this package stays free of `editor-cli/`
   * dependencies (see `AcquireTreeGate`'s doc comment in
   * `write-broker.ts`).
   *
   * Wired by the CLI chat route for FOREGROUND turns only — SAME
   * restriction as `acquireWriteLock` above, and for the identical
   * reason: the edit-fix mini-turn already runs under the EXCLUSIVE tree
   * gate (`withTreeLock`, held by the CLI edit route around
   * `tryPropEditLLMFallback`), so acquiring the SHARED gate from inside
   * that exclusive holder would self-deadlock — the exclusive holder
   * cannot release until the inner call returns, and the inner shared
   * acquisition cannot proceed until the exclusive holder releases.
   * Without it, structural-tool ledger appends from the mini-turn fall
   * back to the pre-A2 behavior (unordered against a concurrent tree
   * op) — an acceptable narrowing, since the mini-turn's own caller
   * already holds the exclusive gate for its whole duration, which is a
   * STRONGER guarantee than the shared-gate ordering this option adds.
   */
  acquireTreeGate?: AcquireTreeGate
  /**
   * Whether the SDK write guard should record undo/redo history steps for
   * this turn's built-in Write/Edit calls. Default `true`. The edit-fix
   * mini-turn passes `false`: its writes are provisional until the CLI
   * handler's post-turn validation passes (`tryPropEditLLMFallback` in
   * editor-cli/src/server/edit-handler.ts) — a refused/unparseable
   * outcome rolls the working tree back via `cleanupAllWrites`, and a step
   * recorded from the guard's PostToolUse would capture the now-reverted
   * bytes as its "after", jamming `undo` forever (it would never see the
   * disk state it expects). The handler records its OWN consolidated step
   * on the SUCCESS path instead, once the write is verified durable — see
   * the `getSharedEditHistory().record(...)` call at the end of
   * `tryPropEditLLMFallback`.
   */
  recordHistory?: boolean
  session: ChatSession
  userMessage: string
  /**
   * Validated, in-budget user-supplied images for this turn (paste /
   * drag-drop / attach in the chat input). Each rides into the SDK turn
   * as a vision content block on the turn's first user message — see
   * `turn-input-channel.ts`. The CLI route validates + caps these via
   * the shared media-content service (`imageFromDataUrl`) BEFORE they
   * reach here, so this is already a trusted, decoded-byte-capped list;
   * `runChatTurnSdk` does not re-validate. Absent/empty ⇒ that message
   * carries a text block only; the prompt SHAPE is the same either way.
   *
   * NOT persisted on the `ChatTurn` (base64 would bloat the session
   * JSON); the SDK's own JSONL transcript retains them for resume.
   */
  images?: ModelImageContent[]
  selection?: ChatSelectionSnapshot
  page?: ChatPageSnapshot
  projectKnowledge?: ProjectKnowledge
  /**
   * Lazily resolves the shared design-system {@link GroundingService} (the
   * SAME memoized instance the inspector endpoints use; the CLI binds it to
   * the canonical root). When provided, the agent's read-only grounding query
   * tools are registered and the grounding system-prompt guidance is appended.
   * Absent → no design-system grounding for this turn.
   */
  getGrounding?: () => Promise<GroundingService>
  /**
   * Read-root registry for the session. Wired into both the MCP
   * tools (so the agent can call `read_file_at_commit` etc. on
   * declared externals) and `canUseTool` (so a denied Read pointing
   * at an external root yields an actionable error suggesting the
   * right tool + root name). When undefined, externals are
   * unreachable and the deny message falls back to the generic
   * "use a repo-relative path" hint.
   */
  readRoots?: ReadRootRegistry
  /**
   * Substrate-neutral verification runner. Powers `run_verification`.
   * The CLI wires a Node/npm adapter at boot; the web route currently
   * passes none — verification is CLI-only for v1.
   */
  verificationAdapter?: import('../core/verification-adapter').VerificationAdapter
  /**
   * Substrate-neutral package-manager adapter. Powers `manage_package`.
   * Same scope/wiring story as `verificationAdapter`.
   */
  packageManagerAdapter?: import('../core/package-manager-adapter').PackageManagerAdapter
  /**
   * Web-tool security policy. Powers `canUseTool`'s WebFetch /
   * WebSearch branches. Omitted ⇒ both tools surface deny messages
   * pointing at desde.config.json. Loaded per turn so
   * config edits take effect on the next user message.
   */
  webPolicy?: import('../core/web-policy').WebPolicy
  /**
   * Figma MCP integration config. When present, the customer-supplied
   * stdio MCP server is registered alongside the in-process `editor`
   * server (visible to the agent as `mcpServers.figma`). When omitted,
   * no Figma tools are visible to the agent. Loaded per turn so config
   * edits take effect on the next user message.
   */
  figmaConfig?: import('../core/figma-config').FigmaConfig
  /**
   * The agent's isolated review surface (CLI: a headless Playwright sidecar).
   * When present, the view+drive tools (navigate / interact / capture_screenshot)
   * and the verify_edit / verify_goal DOM reads run against this surface instead
   * of the bridge → the user's live iframe — so the agent reviewing its own work
   * never disrupts the page the user is watching. Absent (web/tests, or when the
   * CLI is forced to the bridge path) → the bridge, preserving prior behavior.
   * See [src/editor/core/review-surface.ts].
   */
  reviewSurface?: import('../core/review-surface').ReviewSurface
  /**
   * `verify_goal`'s translate step — the only LLM touch reachable from a
   * chat turn. The CLI resolves this once per turn from the project's
   * `llm` block and forwards it into `buildEditorToolServer`. Absent
   * (web/tests) falls back to the registry's own default.
   */
  resolveLlmProvider?: () => import('../llm-providers/types').CompletionProvider
  /**
   * Gate for the canvas + screenshot-plan surface (the `save_screenshot_plan`
   * / `heal_plan_step` tools + their system-prompt discipline block).
   * DORMANT by product decision 2026-08-04 — undertested, default OFF (see
   * CLAUDE.md § "Screenshot Capture"). The CLI computes this from
   * `editor.canvas` in `.desde/config.json` OR `EDITOR_CANVAS=1`
   * (either enables) and threads it through here; web/tests that omit it
   * get the tools-off behavior. Passed straight through to
   * `buildEditorToolServer` and `buildSdkSystemPrompt`.
   */
  canvasEnabled?: boolean
  emit: (event: ChatStreamEvent) => void
  /**
   * The channel this turn's input runs on, supplied by the CALLER so it can be
   * registered as steerable before the turn exists. The CLI keeps a
   * `sessionId → channel` registry that `POST /api/editor/chat/steer` pushes
   * into; it creates the channel and registers it in the same breath as taking
   * the per-session turn lock, then hands it here.
   *
   * Caller-supplied rather than handed back, because handing it back cannot
   * close the registration window. Everything between the lock and this call —
   * session load, project knowledge, web policy, the concurrency-cap queue — is
   * time in which the lock says "a turn is running" while the registry has
   * nothing to steer, and any callback from in here happens on the far side of
   * all of it.
   *
   * Ownership follows: a caller that supplies a channel owns closing it and
   * reporting its undelivered steers on every path that never reaches this
   * function (the cost-ceiling refusal returns before the turn starts, and the
   * CLI's own setup can fail or be abandoned first). This function still closes
   * and reconciles on every path it does own — closing is idempotent and the
   * steer drain is one-shot, so doing it at both levels double-reports nothing.
   *
   * Omitted → a private channel is created here. That is the shape used by
   * direct callers with no steering surface (the edit-fix mini-turn, the live
   * smoke harness), and it behaves exactly as it did before steering existed.
   */
  inputChannel?: TurnInputChannel
  /**
   * Await the shell's ack for a `propose_prop_edit` proposal. Prop
   * edits have no underlying disk write — the shell applies them as
   * DOM overlays — so the model must learn about selection drift
   * or rejection via this ack. SDK `Write`/`Edit` do NOT go through
   * this path; the SDK itself writes after `canUseTool` resolves,
   * and we just emit the `edit_proposed` event for diff display.
   */
  awaitEditAck?: (editId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  signal?: AbortSignal
  /**
   * Optional model override. Defaults to `DEFAULT_SDK_MODEL`
   * (`claude-opus-4-8`).
   */
  model?: string
  /**
   * Optional reasoning-effort override, forwarded to the SDK `query()`
   * options. The SDK silently downgrades levels the model doesn't
   * support. Omitted → SDK/provider default.
   */
  effort?: EffortLevel
  /**
   * Whether `model` takes adaptive thinking, when the catalog that offered
   * it knows (`ModelOption.adaptiveThinking`). A live list can offer aliases
   * such as `default` or `sonnet`, whose family the id does not name, and a
   * fixed thinking budget on a current-generation model is a 400. Omitted →
   * decided from the id's family, as before.
   */
  adaptiveThinking?: boolean
  /**
   * Session-cumulative dollar ceiling. Translated to a per-query
   * `maxBudgetUsd` after subtracting prior-turn costs from this
   * session. Undefined → no ceiling.
   */
  costCeilingUsd?: number
  /**
   * Hard cap on SDK conversation turns (WS4 mini-turn budget). Undefined →
   * SDK default (unbounded). Foreground chat leaves this unset; headless
   * mini-turns MUST bound it — nothing else stops a tool-loop runaway.
   */
  maxTurns?: number
  /**
   * Tool names removed from the model's context entirely (SDK
   * `disallowedTools` — works for MCP-namespaced names, unlike `tools`).
   * WS4 mini-turns use it to strip interactive/irrelevant tools
   * (`mcp__editor__ask_user_question`, structural scaffolding, …).
   */
  disallowedTools?: string[]
  /**
   * Override the built-in tool set (`tools` option — built-ins ONLY; MCP
   * names are no-ops there). Defaults to BUILTIN_TOOLS. Mini-turns narrow
   * this to Read/Edit/Write/Glob/Grep.
   */
  builtinTools?: string[]
  /**
   * Customer-declared MCP extensions for this prototype, from
   * `loadExtensions`. Registered alongside the in-process `editor` server;
   * their read-only policy rides separately into `canUseTool`.
   */
  extensions?: ReadonlyArray<import('../core/extensions-config').EditorExtension>
  /**
   * System-prompt section naming capabilities that are available but OFF
   * (from `describeDisabledCapabilities`). Null/omitted when everything is
   * enabled. Without it the model cannot know an unconfigured capability
   * exists — an unregistered MCP server is invisible, not denied.
   */
  disabledCapabilities?: string | null
}

export interface RunChatTurnSdkResult {
  session: ChatSession
  turn: ChatTurn
}

export async function runChatTurnSdk(
  opts: RunChatTurnSdkOpts,
): Promise<RunChatTurnSdkResult> {
  // Phase 3 follow-up of tasks/editor-detached-sessions.md: scope
  // every withWriteLock call made during this turn to the session
  // so the FileLockManager's persistence sink routes events to
  // <worktreeRoot>/.desde/chat-sessions/<sessionId>/lock-events.jsonl.
  // Direct bridge mutations that fire DURING the turn inherit this scope
  // and show up on the timeline.
  //
  // The SDK's BUILT-IN Write/Edit still execute inside the SDK runtime, so
  // they never reach FileLockManager.withWriteLock and won't appear on that
  // timeline — but they are no longer unguarded (audit Task 13): a
  // PreToolUse hook journals the original to .desde/backups/ and holds
  // the CLI's per-file edit lock across the tool's execution. See
  // `sdk-write-guard.ts`.
  return runWithChatSession(
    { sessionId: opts.session.id.sessionId, repoRoot: opts.worktreeRoot },
    () => runChatTurnSdkInner(opts),
  )
}

async function runChatTurnSdkInner(
  opts: RunChatTurnSdkOpts,
): Promise<RunChatTurnSdkResult> {
  const turnId = randomUUID()
  const startedAt = new Date().toISOString()
  const model = opts.model ?? DEFAULT_SDK_MODEL

  // ── Cost-ceiling pre-check ─────────────────────────────────────────
  // Mirrors the legacy orchestrator's "refuse before starting" gate.
  // For SDK turns we use the vendor-reported `costUsd` when present
  // and fall back to the rate-card estimate for legacy turns and any
  // SDK turn that didn't capture cost.
  if (typeof opts.costCeilingUsd === 'number') {
    const priorCost = computeSessionCost(opts.session)
    if (priorCost >= opts.costCeilingUsd) {
      const reason = `Session cost ceiling reached ($${priorCost.toFixed(2)} of $${opts.costCeilingUsd}). Start a new session or raise the ceiling.`
      opts.emit({ kind: 'error', turnId, reason })
      opts.emit({ kind: 'turn_complete', turnId, stopReason: 'error' })
      const refusal: ChatTurn = {
        id: turnId,
        startedAt,
        completedAt: new Date().toISOString(),
        userMessage: opts.userMessage,
        selection: opts.selection,
        page: opts.page,
        assistantContent: [],
        toolResults: {},
        editProposals: [],
        error: reason,
        model,
      }
      return {
        session: {
          ...opts.session,
          updatedAt: refusal.completedAt!,
          turns: [...opts.session.turns, refusal],
        },
        turn: refusal,
      }
    }
  }

  // ── Edit-proposal plumbing ─────────────────────────────────────────
  // Two emit paths because the two surfaces have different semantics:
  //
  //   - `canUseTool` Write/Edit: SDK does the disk write after we
  //     return `allow`. We fire-and-forget the SSE event for diff
  //     display and mark the carrier `appliedByAgent: true` so the
  //     shell skips its own `adapter.applyEdit` write (which would
  //     race the SDK's).
  //
  //   - `propose_prop_edit` MCP tool: no underlying disk write — the
  //     shell applies prop edits as DOM overlays. The model needs to
  //     learn about selection drift or shell rejection, so this path
  //     awaits the shell's ack (same plumbing as the legacy
  //     orchestrator's `awaitEditAck`).
  const editProposalRefs: ChatTurn['editProposals'] = []
  const recordProposal = (editId: string, payload: EditProposalPayload): void => {
    let kind: ChatTurn['editProposals'][number]['kind']
    let files: string[] = []
    switch (payload.type) {
      case 'prop_edit':
        kind = 'prop_edit'
        break
      case 'overwrite':
        kind = 'overwrite'
        files = [payload.file]
        break
      case 'file_delete':
        kind = 'file_delete'
        files = [payload.file]
        break
      case 'file_rename':
        kind = 'file_rename'
        files = [payload.fromFile, payload.toFile]
        break
    }
    editProposalRefs.push({
      editId,
      kind,
      files,
      proposedAt: new Date().toISOString(),
    })
  }

  const emitWriteEditProposal = async (
    payload: EditProposalPayload,
  ): Promise<{ ok: true; editId: string }> => {
    const editId = randomUUID()
    // Phase 4 §4 of tasks/editor-detached-sessions.md — persist
    // the proposed newSource to disk BEFORE the SSE event fires so
    // a "Use mine" click in the save dialog can always recover the
    // loser-session's intended content (the working tree carries
    // only the last writer's output). The blob is keyed by editId
    // which is also baked into the edit-proposal record persisted
    // on the session, so the save dialog finds the right blob via
    // a simple file read. See proposal-blob-store.ts.
    //
    // Best-effort: a blob-write failure is logged via console.warn
    // but does NOT block the SSE emit — losing a blob means "Use
    // mine" can't recover that specific edit; everything else
    // still works (diff display, save dialog enumeration, etc.).
    if (payload.type === 'overwrite' && typeof payload.newSource === 'string') {
      try {
        await writeProposalBlob(
          opts.worktreeRoot,
          opts.session.id.sessionId,
          editId,
          payload.newSource,
        )
      } catch (err) {
        console.warn(
          `[runChatTurnSdk] failed to persist proposal blob for editId=${editId}: ${
            (err as Error).message
          }`,
        )
      }
    }
    opts.emit({ kind: 'edit_proposed', turnId, editId, edit: payload })
    recordProposal(editId, payload)
    return { ok: true, editId }
  }

  const emitPropEditProposal = async (
    payload: EditProposalPayload,
  ): Promise<{ ok: true; editId: string } | { ok: false; reason: string }> => {
    const editId = randomUUID()
    opts.emit({ kind: 'edit_proposed', turnId, editId, edit: payload })
    if (!opts.awaitEditAck) {
      // No round-trip configured — auto-accept (matches the legacy
      // orchestrator's behavior for unit-test callers).
      recordProposal(editId, payload)
      return { ok: true, editId }
    }
    const ack = await opts.awaitEditAck(editId)
    if (!ack.ok) {
      return { ok: false, reason: ack.reason }
    }
    recordProposal(editId, payload)
    return { ok: true, editId }
  }

  // ── SDK option assembly ────────────────────────────────────────────
  // Branch mode has no pinned worktree-session base commit, so
  // `session_status`/`session_diff` ("what have I changed?") resolve
  // against the merge-base with the default branch instead — recomputed
  // fresh each turn since the user can switch branches between turns.
  // Undefined (no default branch, detached HEAD, git error) leaves those
  // tools registered but refusing with their existing "not configured"
  // error rather than a wrong answer.
  const rootCommitSha = (await branchModeRootCommitSha(opts.worktreeRoot)) ?? undefined
  const editorToolServer = buildEditorToolServer({
    bridge: opts.bridge,
    signal: opts.signal,
    emitEdit: emitPropEditProposal,
    readRoots: opts.readRoots,
    rootCommitSha,
    verificationAdapter: opts.verificationAdapter,
    worktreeRoot: opts.worktreeRoot,
    invalidateFiles: opts.invalidateFiles,
    // download_asset reuses the WebFetch host allowlist — same trust
    // boundary, deliberately not a wider one.
    ...(opts.webPolicy ? { webPolicy: opts.webPolicy } : {}),
    packageManagerAdapter: opts.packageManagerAdapter,
    getGrounding: opts.getGrounding,
    reviewSurface: opts.reviewSurface,
    // `verify_goal`'s translate step. Pass-through only; the SDK runtime never
    // calls it itself.
    resolveLlmProvider: opts.resolveLlmProvider,
    canvasEnabled: opts.canvasEnabled,
    acquireTreeGate: opts.acquireTreeGate,
  })

  // Phase 4a §2 — per-turn fileReads accumulator. Seeded from any
  // pre-existing session.fileReads so a prior turn's Reads still count
  // as the base for this turn's Writes. Mutated by the PreToolUse hook
  // (Read → snapshot) and queried by canUseTool (Write/Edit →
  // conflict check).
  const fileReads: Record<string, ChatFileReadRecord> = {
    ...(opts.session.fileReads ?? {}),
  }
  // Conflicts detected during this turn. Phase 4a §1.
  const conflicts: Record<string, ChatConflictRecord> = {
    ...(opts.session.conflicts ?? {}),
  }

  const readSnapshotHook = createReadSnapshotHook({
    worktreeRoot: opts.worktreeRoot,
    snapshotRoot: joinPath(
      opts.worktreeRoot,
      '.desde',
      'chat-sessions',
      opts.session.id.sessionId,
    ),
    onReadObserved: (record: FileReadRecord) => {
      fileReads[record.absolutePath] = {
        hashAtRead: record.hashAtRead,
        baseContentPath: record.baseContentPath,
        readAt: record.readAt,
      }
    },
  })

  // Audit Task 13 — write safety for the SDK's BUILT-IN Write/Edit, which
  // execute inside the SDK runtime and so bypass FileLockManager and the
  // backup journal every other Editor lane goes through. The guard
  // journals the original + holds the CLI's per-file edit lock across each
  // individual tool execution (a short window — NOT the whole turn, which
  // would block Commit for minutes). See sdk-write-guard.ts.
  const writeGuard = createSdkWriteGuard({
    worktreeRoot: opts.worktreeRoot,
    ...(opts.acquireWriteLock ? { acquireWriteLock: opts.acquireWriteLock } : {}),
    // Toolbar undo/redo (Task 5) — a successful built-in Write/Edit records
    // an undo step the same way every other editor mutation lane does.
    // This is the only production call site for `createSdkWriteGuard`, and
    // by default the edit-fix mini-turn (edit-fix-mini-turn.ts) would pick
    // this up too by re-entering through `runChatTurnSdk` — but its writes
    // are PROVISIONAL until the handler's post-turn validation passes (see
    // `recordHistory` above), so it explicitly opts out with
    // `recordHistory: false` and records its own consolidated step once a
    // fix is verified durable.
    ...(opts.recordHistory !== false ? { history: getSharedEditHistory() } : {}),
  })

  const onConflictDetected = async (
    detected: OverwriteConflictDetected,
  ): Promise<void> => {
    conflicts[detected.absolutePath] = {
      detectedAt: new Date().toISOString(),
      hashAtRead: detected.hashAtRead,
      hashAtWrite: detected.hashAtWrite,
    }
    // Look up which OTHER chat session most recently touched this
    // file so the chat banner can name the conflicting session.
    //
    // Two-tier lookup:
    //   1. In-memory cross-session write log (PR3) — catches the case
    //      we actually care about: another chat session is mid-stream,
    //      its write just landed, and its turn hasn't finished
    //      `saveSession`'ing. The persisted scan misses this.
    //   2. Persisted scan (PR2) — falls back when the log is empty
    //      (process restart since the conflicting write, or the
    //      writer's process was different — though in practice all
    //      chat sessions in one edit session share a process).
    //
    // Either result is decorative; a `null` outcome just means the
    // banner fires without naming the conflicting session.
    let attribution:
      | { sessionId: string; firstUserMessagePreview?: string }
      | null = null
    try {
      const live = lookupRecentCrossSessionWriter(
        detected.absolutePath,
        opts.session.id.sessionId,
      )
      if (live) {
        attribution = {
          sessionId: live.sessionId,
          ...(live.firstUserMessagePreview
            ? { firstUserMessagePreview: live.firstUserMessagePreview }
            : {}),
        }
      } else {
        attribution = await findRecentWriterForFile(
          opts.worktreeRoot,
          opts.session.id.sessionId,
          detected.file,
        )
      }
    } catch {
      // Attribution is decorative; never block the warning on a
      // failed lookup.
    }
    opts.emit({
      kind: 'edit_overwrite_warning',
      turnId,
      file: detected.file,
      hashAtRead: detected.hashAtRead,
      hashAtWrite: detected.hashAtWrite,
      ...(attribution
        ? {
            conflictingSessionId: attribution.sessionId,
            ...(attribution.firstUserMessagePreview
              ? { conflictingSessionPrompt: attribution.firstUserMessagePreview }
              : {}),
          }
        : {}),
    })
  }

  const canUseTool = buildCanUseTool({
    worktreeRoot: opts.worktreeRoot,
    emitEditProposal: emitWriteEditProposal,
    readRoots: opts.readRoots,
    webPolicy: opts.webPolicy,
    figmaAllowedToolPrefixes: opts.figmaConfig?.allowedToolPrefixes,
    // Per-extension read-only policy, keyed by MCP namespace id. Built from
    // the SAME list that gets registered above, so a server can never be
    // reachable without a policy governing it.
    extensionToolPolicy: new Map(
      (opts.extensions ?? []).map((e) => [e.id, e.allowedToolPrefixes]),
    ),
    getFileReads: () => fileReads,
    onConflictDetected,
    // Codex round-1 fix for finding #2: after every allowed Write/Edit,
    // overwrite the per-file baseline with the post-write hash so a
    // subsequent same-session write isn't false-flagged. The path key
    // mirrors what `createReadSnapshotHook` uses (post-`resolveRepoPath`
    // absolute), so the entry replaces the prior Read snapshot cleanly.
    //
    // PR3: also record the write in the process-global cross-session
    // log so OTHER concurrent sessions can attribute their conflict
    // warnings against us BEFORE our turn persists. The log entry is
    // small (sessionId + first-message preview + timestamp) and the
    // log itself is FIFO-bounded per file.
    recordOwnWrite: (absPath, nextHash) => {
      fileReads[absPath] = {
        hashAtRead: nextHash,
        baseContentPath: fileReads[absPath]?.baseContentPath ?? '',
        readAt: new Date().toISOString(),
      }
      // Mirror the "first user message" semantic of
      // `findRecentWriterForFile` so the in-memory log's attribution
      // looks identical to the persisted-scan path. On the FIRST
      // turn `opts.session.turns` is empty (the current turn hasn't
      // been appended yet), so fall back to `opts.userMessage`
      // — that's what will become `turns[0]` once the turn persists.
      const firstUserMessageRaw =
        typeof opts.session.turns[0]?.userMessage === 'string'
          ? opts.session.turns[0].userMessage
          : opts.userMessage
      const firstUserMessage = firstUserMessageRaw
        ? firstUserMessageRaw.slice(0, 60)
        : undefined
      recordCrossSessionWrite(absPath, {
        sessionId: opts.session.id.sessionId,
        ...(firstUserMessage ? { firstUserMessagePreview: firstUserMessage } : {}),
        at: new Date().toISOString(),
      })
    },
  })

  // Phase 2: pass Editor-specific instructions as `append` to the
  // SDK's `claude_code` preset rather than overriding the whole
  // system prompt. The preset keeps Claude Code's tool-use guidance
  // for the built-ins (Read/Edit/Write/Glob/Grep/TodoWrite); our
  // append covers domain context + the 4 MCP tools + worktree-
  // session edit lifecycle + envelope warning + project conventions.
  // Per-session design-system discovery digest (component names + token
  // categories). Best-effort + byte-stable; the grounding sources are memoized
  // so this is ~instant after the first build. Computed before the prompt so it
  // can be injected as cache-stable context.
  const groundingDigest = opts.getGrounding
    ? await buildGroundingDigest(opts.getGrounding)
    : null
  const sdkAppend = buildSdkSystemPrompt({
    projectKnowledge: opts.projectKnowledge,
    // BUG FIX: this was `opts.figmaConfig !== undefined`, i.e. the LEGACY
    // `figma` block only. A `figma` server declared the modern way in
    // `.mcp.json` is registered and callable but got no prompt section at
    // all, so the model was never told how to use it.
    figmaEnabled:
      opts.figmaConfig !== undefined ||
      (opts.extensions ?? []).some((e) => e.id === 'figma'),
    disabledCapabilities: opts.disabledCapabilities ?? null,
    groundingEnabled: opts.getGrounding !== undefined,
    groundingDigest: groundingDigest ?? undefined,
    canvasEnabled: opts.canvasEnabled === true,
  })

  const userMessageWithContext = buildUserMessageWithContext(
    opts.userMessage,
    opts.selection,
    opts.page,
  )

  // Declared here rather than with the rest of the turn-execution state below
  // because the channel's accept hook stamps a steer's position against its
  // current length, and a closure over a not-yet-declared const would be a
  // trap waiting for the first steer that arrives early.
  const assistantContent: ChatAssistantBlock[] = []

  // The assistant message currently STREAMING, which `assistantContent` cannot
  // see: blocks only land there when a COMPLETE `assistant` message is
  // flattened, so for the whole body of a long reply the persisted list lags
  // what the user is reading by that entire message.
  //
  // Stamping a steer against `assistantContent.length` alone therefore recorded
  // it as sitting BEFORE text the user had already watched stream in above
  // their own bubble. Live the bubble sat under that text; after a reload it
  // jumped above it. That is the same live-versus-hydrated disagreement this
  // feature already fixed once, surviving in a narrower window.
  //
  // `streamedText` is what the client has on screen for that message;
  // `committedStreamedChars` is how much of it a steer split has already
  // written into `assistantContent`.
  let streamedText = ''
  let committedStreamedChars = 0
  const resetStreamedText = (): void => {
    streamedText = ''
    committedStreamedChars = 0
  }
  /**
   * Close off the part of the in-flight message the user has already seen, as
   * its own block, so `assistantContent.length` IS the position the live
   * renderer used at this instant.
   *
   * The split is real rather than bookkeeping: the client cut its assistant
   * bubble at exactly this character, because it had received exactly these
   * deltas when the `steered` frame landed on the same stream. A transcript
   * that did not carry the same cut could not reproduce that reading.
   */
  const commitStreamedPrefix = (): void => {
    const pending = streamedText.slice(committedStreamedChars)
    if (pending.length === 0) return
    assistantContent.push({ type: 'text', text: pending })
    committedStreamedChars = streamedText.length
  }

  // Every steer this turn accepted, in accept order, in the shape the persisted
  // transcript needs. Filled from the channel's accept hook — the same accepted
  // -steer bookkeeping the undelivered-steer reconciliation reads, not a second
  // list of our own — because `turn.userMessage` holds the OPENING prompt only.
  // Without this the model's answer to a steered message survives a re-hydrate
  // and the user's question does not.
  const steerRecords: ChatSteeredMessage[] = []

  // The turn's input channel — see `turn-input-channel.ts`. It carries the
  // initial user message and stays open so a message typed mid-turn reaches the
  // model at the next model boundary. Resolved BEFORE the try block so the
  // finally below can always close it. The caller normally supplies it, already
  // registered as steerable — see `inputChannel` for why that direction.
  const turnChannel = opts.inputChannel ?? createTurnInputChannel()
  turnChannel.begin(
    {
      text: userMessageWithContext,
      ...(opts.images?.length ? { images: opts.images } : {}),
    },
    {
      onAccepted: (steer) => {
        // FIRST, so the reply-in-progress is cut where the user actually
        // interrupted it. Without this the position counts only messages the
        // model has already finished — see `commitStreamedPrefix`.
        commitStreamedPrefix()
        steerRecords.push({
          text: steer.text,
          ...(steer.images?.length ? { hadImages: true } : {}),
          // Position, not timestamp: the transcript is rendered as an ordered
          // list of assistant blocks, so "after this many blocks" is the only
          // thing a renderer can act on. Image BYTES are deliberately dropped
          // here — same rule as the turn's own opening images.
          afterAssistantBlocks: assistantContent.length,
        })
      },
    },
  )

  /**
   * Close the channel, then tell the client about every steer we cannot show
   * reached the model, so it can send those messages again.
   *
   * Close-then-drain, never the reverse: a steer accepted between the drain and
   * the close would be closed away with nobody told, which is the exact loss
   * this reconciliation exists to prevent. (Nothing is awaited between the two,
   * so in practice the pair is atomic — the ordering is written down because
   * getting it backwards is silently wrong.)
   *
   * Safe to call more than once. `close()` is idempotent and
   * `takeUndeliveredSteers()` drains its tracking list, so the second call
   * reports nothing rather than asking for a duplicate resubmit.
   *
   * Best-effort on the wire: if the client has already disconnected, `emit`
   * writes into a closed SSE stream and drops. Nothing can be delivered to a
   * client that is gone; the client's own steer-failure fallback covers the
   * disconnect case.
   */
  const closeChannelAndReportUndelivered = (): void => {
    turnChannel.close()
    for (const steer of turnChannel.takeUndeliveredSteers()) {
      opts.emit({
        kind: 'resubmit_required',
        sessionId: opts.session.id.sessionId,
        userMessage: steer.text,
        ...(steer.images ? { images: steer.images } : {}),
      })
    }
  }

  // Abort runs the FULL close-and-report, not a bare close, and it runs here
  // rather than leaning on the finally. Two reasons, and the second is why this
  // is not merely belt-and-braces:
  //
  //  1. If the SDK's abort path ever waits for stdin to end before finishing
  //     its message stream, the `for await` below never returns and the finally
  //     never runs. Closing from the listener is what breaks that deadlock —
  //     and a close that did not also report would leave the steers inside a
  //     channel nobody will drain.
  //  2. Stop is the MOST likely way a steer dies unconsumed: the user typed a
  //     correction and then decided the agent was going the wrong way anyway.
  //     Reporting only on the paths that unwind cleanly would leave the single
  //     most common loss as the one path that stays silent.
  //
  // Best-effort on the wire when abort came from the client disconnecting —
  // `emit` writes into a dead SSE stream and drops. Nothing can reach a client
  // that is gone; its own steer-failure fallback covers that case.
  if (opts.signal) {
    if (opts.signal.aborted) closeChannelAndReportUndelivered()
    else {
      opts.signal.addEventListener('abort', () => closeChannelAndReportUndelivered(), {
        once: true,
      })
    }
  }

  const maxBudgetUsd =
    typeof opts.costCeilingUsd === 'number'
      ? Math.max(0, opts.costCeilingUsd - computeSessionCost(opts.session))
      : undefined

  // Per-turn adapter holds state for partial-stream dedupe so
  // tool_use_start fires once per tool_use regardless of whether the
  // SDK surfaces it via content_block_start partials or via the
  // assistant message.
  const adapter = createSdkEventAdapter(turnId)

  opts.emit({ kind: 'turn_start', turnId })

  // ── Turn execution ────────────────────────────────────────────────
  // (`assistantContent` is declared above, next to the input channel.)
  const toolResults: Record<string, ChatToolResult> = {}
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | undefined
  let vendorStopReason: string | undefined
  let stopReason: 'end_turn' | 'error' = 'end_turn'
  let errorMessage: string | undefined
  // Captured from the SDKSystemMessage init event on the first turn
  // and persisted to the session record so subsequent turns can
  // resume. Stays undefined on a successful resume turn (the SDK
  // emits init with the SAME session_id, which is harmless to
  // re-write but we treat it as a no-op).
  let sdkSessionId: string | undefined = opts.session.sdkSessionId

  try {
    // Desktop-app seam (tasks/electron-app.md "fetch the claude binary on
    // first run"): `undefined` on the terminal CLI, unchanged from before —
    // the SDK falls through to its own default resolution. Inside the try
    // so a not-ready desktop runtime is reported through the SAME
    // error/turn_complete path as any other query failure, not an unhandled
    // throw. See resolve-claude-executable.ts's module doc comment.
    const claudeExecutablePath = resolveClaudeExecutablePath()
    assertClaudeRuntimeReady(claudeExecutablePath)

    const q = query({
      prompt: turnChannel.stream(),
      options: {
        cwd: opts.worktreeRoot,
        model,
        ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
        // Extended thinking — surfaced to the chat UI as a collapsible
        // "reasoning" block (see sdk-event-adapter `reasoning_delta`). Adaptive
        // (Opus 4.6+) lets the model decide when/how much to think (it skips
        // trivial turns, so there's no fixed per-turn overhead); other models
        // get a bounded fixed budget. `summarized` keeps the surfaced reasoning
        // concise rather than dumping the full raw chain.
        thinking: resolveAnthropicThinkingConfig(model, opts.adaptiveThinking),
        ...(opts.effort ? { effort: opts.effort } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: sdkAppend },
        // `tools` only filters built-in tools (sdk.d.ts:1257 — "the
        // base set of available built-in tools"). MCP-namespaced
        // names there are no-ops. Our 4 custom tools are exposed
        // purely via mcpServers.editor registration below.
        tools: [...(opts.builtinTools ?? BUILTIN_TOOLS)],
        ...(opts.disallowedTools?.length
          ? { disallowedTools: [...opts.disallowedTools] }
          : {}),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        mcpServers: {
          editor: editorToolServer,
          // Customer-supplied Figma MCP server, opt-in per
          // desde.config.json. Read-only by contract
          // (see system-prompt). Tools register under the `figma`
          // namespace; the SDK's tool-deferral default means the
          // model only loads them via tool-search when the user
          // refers to a Figma file.
          ...(opts.figmaConfig
            ? { figma: opts.figmaConfig.mcpServer }
            : {}),
          // Customer-declared extensions from `.mcp.json` (see
          // extensions-config.ts). Registered under their own ids; the
          // SDK's tool-deferral default means the model only loads their
          // tools via tool-search when a turn actually calls for them, so a
          // long list costs nothing per turn. Read-only enforcement is in
          // canUseTool, not here.
          ...Object.fromEntries(
            (opts.extensions ?? []).map((e) => [e.id, e.mcpServer]),
          ),
        },
        canUseTool,
        // Phase 4a §2: PreToolUse hook on Read snapshots the file the
        // SDK is about to read. We use the snapshot as the conflict-
        // detection base for any subsequent Write/Edit to the same
        // file. The hook is pure-observation — always continues — so
        // it can't break the SDK's Read path.
        //
        // PostToolUse hook on Write/Edit deterministically replays each
        // successful built-in write into the Vite dev pipeline
        // (write-invalidate-hook.ts) — same fsevents-independence the
        // CLI edit lane and the editor structural tools already have.
        // Registered only when the CLI wired `invalidateFiles`.
        //
        // Branch mode edits the working tree in place with no per-write
        // auto-commit — the user commits via the nav bar's Commit action.
        //
        // The Write|Edit brackets are the audit Task 13 write guard:
        // PreToolUse journals the original + takes the per-file edit lock,
        // and the three terminal events release it (PostToolUse on success,
        // PostToolUseFailure on a failed execution, PermissionDenied when
        // canUseTool refuses — a routine outcome here). `releaseAll()` in the
        // finally below is the backstop for anything that fires none of them.
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [readSnapshotHook] },
            {
              matcher: 'Write|Edit',
              hooks: [writeGuard.preToolUse],
              // SECONDS (HookCallbackMatcher.timeout). Set explicitly and well
              // ABOVE the guard's own 10s lock-acquisition budget so the
              // degradation path is defined by OUR code: the guard gives up
              // waiting for the lock and proceeds journal-only with a warning,
              // rather than the SDK timing the hook out — which would run the
              // tool unserialized AND leave the late acquisition orphaned.
              timeout: 60,
            },
          ],
          PostToolUse: [
            {
              matcher: 'Write|Edit',
              hooks: [
                ...(opts.invalidateFiles
                  ? [
                      createWriteInvalidateHook({
                        worktreeRoot: opts.worktreeRoot,
                        invalidateFiles: opts.invalidateFiles,
                      }),
                    ]
                  : []),
                writeGuard.release,
              ],
            },
          ],
          PostToolUseFailure: [
            { matcher: 'Write|Edit', hooks: [writeGuard.release] },
          ],
          // Deliberately UNMATCHED: PermissionDenied is a less-trodden hook
          // event than PostToolUse, and we'd rather it fire for every tool
          // than risk a matcher semantic that silently never matches — the
          // callback is a no-op for any tool_use_id it isn't holding.
          PermissionDenied: [{ hooks: [writeGuard.release] }],
        },
        // permissionMode 'default' fires canUseTool for every Write/
        // Edit. `acceptEdits` mode would auto-approve and skip the
        // callback, dropping our `edit_proposed` events.
        permissionMode: 'default',
        // NO settings sources at all.
        //
        // This was `['project']`, to scope settings to the prototype's own
        // `.claude/` and keep the host machine's `~/.claude/` out of the
        // model's context. That second goal is still met by `[]` — more
        // completely, in fact.
        //
        // What `['project']` also did, and what the 2026-08-09 audit found as
        // B6, is load the PROTOTYPE's `.claude/settings.json` — a file that
        // can declare `hooks`, which the SDK executes as shell commands. In a
        // runtime that deliberately withholds `Bash` from the agent (see the
        // `disallowedTools` list above), that handed back arbitrary command
        // execution as the developer to anything that could write one file.
        // Two adversaries reach it: prompt-injected content steering the agent
        // into writing it (now also blocked by `protected-paths.ts`), and a
        // malicious prototype repo that simply ships one, which no write guard
        // can stop because the file is already there when the repo is opened.
        //
        // `[]` closes the second, which is the one no other control covers.
        //
        // Consequence handled elsewhere: `CLAUDE.md` was previously reaching
        // the model via this setting, so `chat-handler.ts` excluded it from
        // the project-knowledge digest to avoid double-injection. That
        // exclusion is now removed — the rule file reaches the model through
        // the digest's existing untrusted-content fence instead, which is
        // where repo-authored text belongs.
        settingSources: [],
        includePartialMessages: true,
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
        ...(opts.signal ? { abortController: toAbortController(opts.signal) } : {}),
        // Phase 3: resume the SDK session if one has been recorded
        // on this ChatSession. Without resume, every turn looks
        // like the start of a new conversation from the model's
        // POV — multi-turn dialogue breaks. The SDK loads prior
        // history from its JSONL store (`.claude/projects/...`)
        // and injects it before our prompt.
        ...(opts.session.sdkSessionId
          ? { resume: opts.session.sdkSessionId }
          : {}),
      },
    })

    for await (const msg of q) {
      // A new assistant MESSAGE — i.e. a new inference request. Recorded
      // against the channel because it is the only observable evidence that the
      // model has read a message we pushed mid-turn (see
      // `turn-input-channel.ts` § takeUndeliveredSteers).
      //
      // Message boundaries, not output events. This used to fire on every
      // `assistant` OR `stream_event`, and `includePartialMessages: true` below
      // means each streamed token is its own `stream_event` — so the partials
      // of a message that was ALREADY IN FLIGHT when a steer arrived were
      // counted as evidence the model had read it, which it cannot have been:
      // that message's request was assembled before the steer existed. The
      // evidential half of the reconciliation was inert outside a
      // sub-millisecond window.
      //
      // Read off the raw SDK message rather than the adapter's events on
      // purpose: the adapter emits `text_delta` only from partial messages, so
      // a turn without partials would look request-free and every steer on it
      // would be reported for resubmission.
      const boundaryMessageId = readAssistantMessageBoundaryId(msg)
      if (boundaryMessageId !== null) {
        turnChannel.noteAssistantMessage(boundaryMessageId)
      }
      // Streamed-text bookkeeping for the steer position (see
      // `commitStreamedPrefix`). A `message_start` opens a message nothing of
      // which is committed yet; each text delta extends what the client has on
      // screen for it.
      const streamedSignal = readStreamedTextSignal(msg)
      if (streamedSignal?.kind === 'message-start') {
        resetStreamedText()
      } else if (streamedSignal?.kind === 'text-delta') {
        streamedText += streamedSignal.delta
      }
      // Capture turn-state side effects: track assistant blocks +
      // tool results for persistence; track usage / cost from the
      // result message. The SSE adapter is purely transport-side.
      capturePersistenceState({
        msg,
        assistantContent,
        toolResults,
        alreadyCommittedTextChars: committedStreamedChars,
      })
      // The completed message has now landed in `assistantContent` in full, so
      // none of it is in flight any more. Reset AFTER the capture, which needs
      // the committed count to avoid writing the prefix twice.
      if (isCompletedAssistantMessage(msg)) {
        resetStreamedText()
      }
      // First-turn-of-session signal: the init event carries the
      // SDK's session_id. Stash so we persist it after the turn.
      const initId = extractInitSessionId(msg)
      if (initId && !sdkSessionId) {
        sdkSessionId = initId
      }
      const resultPayload = extractResultPayload(msg)
      if (resultPayload) {
        inputTokens = resultPayload.inputTokens
        outputTokens = resultPayload.outputTokens
        costUsd = resultPayload.costUsd
        vendorStopReason = resultPayload.vendorStopReason
        if (resultPayload.subtype !== 'success') {
          stopReason = 'error'
          // Same auth-failure mapping as the catch arm: a non-success
          // result can carry the raw 401 string in errorReason.
          errorMessage = isAuthError(resultPayload.errorReason)
            ? AUTH_REAUTH_MESSAGE
            : resultPayload.errorReason
        }
        // We own termination: a held-open generator never self-closes, because
        // the SDK auto-closes stdin only for a single-turn query. `result` is
        // the turn ending, so this is where we close it — unconditionally, and
        // with every steer we cannot account for reported back for resubmission.
        //
        // This USED to be gated on `pendingCount === 0` ("don't close on a
        // result that races a steer"). That guard was dead by construction and
        // measured the wrong thing. Dead: the SDK's consumer is an eager
        // `for await (const m of stream) await transport.write(m)`
        // (`Query.streamInput`, node_modules/@anthropic-ai/claude-agent-sdk/
        // sdk.mjs) that never stops pulling, so the queue empties within a
        // microtask of the push while the `result` branch runs a macrotask
        // later — the count was always 0. Wrong thing: "still in our array" is
        // not the risky state. The risky state is "written to the child's stdin
        // but never folded into the model's context", which no queue length can
        // see. A steer pushed during a tool call, written to stdin, and
        // followed by a model that decides it is done leaves nothing pending
        // and reaches nobody.
        closeChannelAndReportUndelivered()
      }
      for (const event of adapter.adapt(msg)) {
        opts.emit(event)
      }
    }
  } catch (err) {
    if (opts.signal?.aborted) {
      errorMessage = 'turn aborted'
    } else if ((err as Error).message === DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE) {
      // Our own assertClaudeRuntimeReady() throw, not an SDK failure — say
      // it plainly rather than wrapping it in "SDK query failed: …", which
      // would misattribute a desktop-install-in-progress state to the SDK.
      errorMessage = DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE
    } else {
      // Phase 5 rate-limit codex round-1 #1: extract retry-after from
      // the error's HTTP response header (if any) and embed it in a
      // shape the downstream classifier already parses. The SDK
      // surfaces structured `api_retry` / `rate_limit_event` SDK
      // messages with finer-grained timing — wiring those is a
      // separate piece (codex #2; deferred — see verdict). For now
      // the header extract covers the common case where the API
      // returned a 429 with retry-after set.
      const retryAfter = extractRetryAfterFromError(err)
      const retryHint = retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ''
      const rawMessage = (err as Error).message
      // Auth failures (expired/invalid local `claude` CLI credentials)
      // surface as a raw "Failed to authenticate. API Error: 401 …"
      // string — accurate but non-actionable. Swap in the re-login hint
      // so the chat UI tells the user how to recover.
      errorMessage = isAuthError(rawMessage)
        ? AUTH_REAUTH_MESSAGE
        : `SDK query failed: ${rawMessage}${retryHint}`
    }
    stopReason = 'error'
    opts.emit({ kind: 'error', turnId, reason: errorMessage })
    opts.emit({ kind: 'turn_complete', turnId, stopReason: 'error' })
  } finally {
    // Task 13 safety net: a per-file edit lock must NEVER outlive the turn
    // that took it. A turn that crashes, is aborted mid-write, or is killed
    // by the SDK fires no PostToolUse — without this sweep the file would
    // stay locked for the life of the CLI process.
    writeGuard.releaseAll('turn end')
    // Backstop for every path that reaches neither the result close nor the
    // abort listener: a thrown query, a stream that ends without a result, a
    // turn killed by the SDK. Closing twice is a no-op and the steer drain is
    // one-shot, so the common case (already reconciled on `result` or at abort)
    // costs nothing — while a turn that died holding a steer still reports it
    // rather than swallowing it.
    closeChannelAndReportUndelivered()
  }

  const completedAt = new Date().toISOString()
  const turn: ChatTurn = {
    id: turnId,
    startedAt,
    completedAt,
    userMessage: opts.userMessage,
    selection: opts.selection,
    page: opts.page,
    assistantContent,
    toolResults,
    editProposals: editProposalRefs,
    // Omitted entirely when nothing was steered, so a turn that took no steers
    // serializes exactly as it did before this field existed.
    ...(steerRecords.length > 0 ? { steers: steerRecords } : {}),
    usage:
      inputTokens > 0 || outputTokens > 0
        ? { inputTokens, outputTokens }
        : undefined,
    costUsd,
    model,
    ...(opts.effort ? { effort: opts.effort } : {}),
    error: errorMessage,
  }
/**
 * Turn the vendor's stop reason into a sentence a designer can act on.
 *
 * Added 2026-08-18. This used to be `vendorStopReason ?? 'SDK turn ended with
 * an error'`, so the banner said things like **"max_tokens"** — Mo's reaction
 * was "I have no idea where max_tokens is coming from and what I should do
 * next", which is the whole problem: it is the name of a request parameter,
 * printed to someone who never set one. The fallback was no better; "SDK" is
 * our dependency, not a fact about their work.
 *
 * Each branch says what happened to the TURN and what to do about it. An
 * unrecognised reason keeps the raw string, on purpose — a stop reason nobody
 * has written copy for is a case we do not understand, and swallowing it into
 * "something went wrong" would delete the only clue in a bug report.
 */
function describeVendorStop(reason: string | undefined): string {
  switch (reason) {
    case 'max_tokens':
      return 'The reply hit its length limit and stopped partway. Ask for the rest, or ask for it in smaller pieces.'
    case 'refusal':
      return 'The model declined to answer this one. Rephrasing the request usually gets past it.'
    case 'pause_turn':
      return 'The turn paused partway through. Send the message again to pick it up.'
    case 'aborted':
      return 'The turn was stopped before it finished.'
    case undefined:
      return 'The turn ended without finishing, and no reason was given. Sending it again is the fastest way to find out whether it repeats.'
    default:
      return `The turn ended without finishing (${reason}).`
  }
}

  if (stopReason === 'error' && !errorMessage) {
    turn.error = describeVendorStop(vendorStopReason)
  }

  const updatedSession: ChatSession = {
    ...opts.session,
    ...(sdkSessionId ? { sdkSessionId } : {}),
    updatedAt: completedAt,
    turns: [...opts.session.turns, turn],
    // Phase 4a — persist the accumulated fileReads + conflicts so the
    // save dialog can render conflict UI after the turn ends and so
    // a subsequent turn's reads still count as the base for the
    // current set of writes. Only emit the keys when there's
    // something to persist; otherwise leave undefined to match the
    // pre-Phase-4 shape and keep on-disk files small.
    ...(Object.keys(fileReads).length > 0 ? { fileReads } : {}),
    ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}),
  }

  return { session: updatedSession, turn }
}

/**
 * What a raw SDK message says about the assistant message currently streaming.
 *
 * Only two things matter for the steer position: a message STARTED (nothing of
 * it is on the client's screen yet) and a message GREW by this much text (that
 * text is on screen now). Everything else — a thinking delta, a content-block
 * boundary, a tool result, a completed message — returns null.
 *
 * It reads the same `content_block_delta` / `text_delta` shape the SSE adapter
 * turns into a `text_delta` event (`sdk-event-adapter.ts` § fromPartial). That
 * is deliberate and load bearing: the client's on-screen text IS those events,
 * so counting anything else here would count characters the user cannot see.
 */
type StreamedTextSignal =
  | { kind: 'message-start' }
  | { kind: 'text-delta'; delta: string }

function readStreamedTextSignal(msg: unknown): StreamedTextSignal | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { type?: unknown; event?: unknown }
  if (m.type !== 'stream_event' || !m.event || typeof m.event !== 'object') return null
  const event = m.event as {
    type?: unknown
    delta?: { type?: unknown; text?: unknown }
  }
  if (event.type === 'message_start') return { kind: 'message-start' }
  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'text_delta' &&
    typeof event.delta.text === 'string' &&
    event.delta.text.length > 0
  ) {
    return { kind: 'text-delta', delta: event.delta.text }
  }
  return null
}

/** A finished `assistant` message — the point its blocks reach `assistantContent`. */
function isCompletedAssistantMessage(msg: unknown): boolean {
  return (
    !!msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'assistant'
  )
}

function extractInitSessionId(msg: unknown): string | undefined {
  if (!msg || typeof msg !== 'object') return undefined
  const m = msg as { type?: unknown; subtype?: unknown; session_id?: unknown }
  if (m.type !== 'system' || m.subtype !== 'init') return undefined
  return typeof m.session_id === 'string' ? m.session_id : undefined
}

interface ResultPayload {
  subtype: 'success' | string
  inputTokens: number
  outputTokens: number
  costUsd?: number
  vendorStopReason?: string
  errorReason?: string
}

function extractResultPayload(msg: unknown): ResultPayload | null {
  if (!isResultMessage(msg)) return null
  return {
    subtype: msg.subtype,
    inputTokens: msg.usage?.input_tokens ?? 0,
    outputTokens: msg.usage?.output_tokens ?? 0,
    costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
    vendorStopReason: msg.stop_reason ?? undefined,
    errorReason:
      msg.subtype !== 'success'
        ? msg.errors && msg.errors.length > 0
          ? msg.errors.join('; ')
          : `SDK turn ended with subtype '${msg.subtype}'`
        : undefined,
  }
}

interface CapturePersistenceArgs {
  msg: unknown
  assistantContent: ChatAssistantBlock[]
  toolResults: Record<string, ChatToolResult>
  /**
   * How many leading characters of THIS message's text a steer split has
   * already pushed onto `assistantContent` (see `commitStreamedPrefix` in
   * `runChatTurnSdk`). They are skipped here, so the message's text ends up
   * split across two blocks at the point the user interrupted it instead of
   * being written twice.
   *
   * Zero on every message nobody steered into, which is the overwhelming
   * majority — the branch below is then a no-op and the output is identical
   * to what it was before steering existed.
   */
  alreadyCommittedTextChars?: number
}

function capturePersistenceState(args: CapturePersistenceArgs): void {
  const { msg, assistantContent, toolResults } = args
  const flattened = flattenSdkMessage(msg)

  // Text and tool_use blocks are collected into separate lists (tagged with
  // their original position) so the interleaving from `message.content` —
  // which matters for the persisted transcript's read order — survives the
  // flattener's split.
  type Ordered = { index: number; block: ChatAssistantBlock }
  const ordered: Ordered[] = [
    ...flattened.textBlocks.map((t): Ordered => ({ index: t.index, block: { type: 'text', text: t.text } })),
    ...flattened.toolUseBlocks.map(
      (tu): Ordered => ({
        index: tu.index,
        block: { type: 'tool_use', toolUseId: tu.id, name: tu.name, input: tu.input },
      }),
    ),
  ]
  ordered.sort((a, b) => a.index - b.index)
  // Consumed across text blocks in content order, so a message whose text was
  // committed piecewise by several steers drops exactly what was written.
  let charsToDrop = args.alreadyCommittedTextChars ?? 0
  for (const { block } of ordered) {
    if (charsToDrop > 0 && block.type === 'text') {
      const drop = Math.min(charsToDrop, block.text.length)
      charsToDrop -= drop
      const rest = block.text.slice(drop)
      // A block the steer split consumed entirely leaves nothing to add. An
      // empty text block would render as a blank paragraph and would shift
      // every later steer's recorded position by one.
      if (rest.length === 0) continue
      assistantContent.push({ type: 'text', text: rest })
      continue
    }
    assistantContent.push(block)
  }

  for (const result of flattened.toolResults) {
    toolResults[result.toolUseId] = result.ok
      ? { ok: true, output: result.output }
      : { ok: false, error: result.error }
  }
}

function isResultMessage(msg: unknown): msg is {
  type: 'result'
  subtype: string
  stop_reason: string | null
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  errors?: string[]
} {
  return (
    !!msg &&
    typeof msg === 'object' &&
    (msg as { type?: unknown }).type === 'result'
  )
}

function computeSessionCost(session: ChatSession): number {
  // Audit Task 15 — `saveSession` archives the oldest turns off `turns`
  // once the retention cap is exceeded (`session-turns-archive.ts`).
  // `archivedCostUsd` carries the summed cost of everything that rolled
  // off the head so a long session's cost-ceiling check doesn't
  // silently reset once its early turns archive out.
  //
  // Audit Task 15, codex round 4 — per-turn cost goes through the
  // SHARED `costOfTurn` (`rate-cards.ts`), the same formula
  // `sumTurnCostUsd` (`session-turns-archive.ts`) uses to fold an
  // archived turn's cost into `archivedCostUsd`. The two must never
  // drift: a usage-only turn (no vendor `costUsd`) has to price
  // identically whether it's still in `session.turns` or has already
  // rolled into `archivedCostUsd`, or a long session's ceiling check
  // silently undercounts once its early turns archive out.
  let total = session.archivedCostUsd ?? 0
  for (const turn of session.turns) {
    total += costOfTurn(turn)
  }
  return total
}

/**
 * Mirror of the legacy orchestrator's context envelope. Keeps the
 * agent grounded on what the user is looking at without forcing a
 * tool call. Per-turn random tag so a malicious page title can't
 * close the envelope and inject into the user-prompt position.
 */
function buildUserMessageWithContext(
  userMessage: string,
  selection: ChatSelectionSnapshot | undefined,
  page: ChatPageSnapshot | undefined,
): string {
  const lines: string[] = []
  if (page) {
    const parts: string[] = []
    if (page.route) parts.push(`route=${JSON.stringify(page.route)}`)
    if (page.framework)
      parts.push(`framework=${JSON.stringify(page.framework)}`)
    if (page.title) parts.push(`title=${JSON.stringify(page.title)}`)
    if (parts.length > 0) lines.push(`Page: ${parts.join(', ')}`)
  }
  if (selection) {
    const parts: string[] = []
    if (selection.componentName)
      parts.push(`component=${JSON.stringify(selection.componentName)}`)
    if (selection.componentFile)
      parts.push(`file=${JSON.stringify(selection.componentFile)}`)
    if (selection.editTarget) {
      parts.push(
        `at=${JSON.stringify(
          `${selection.editTarget.file}:${selection.editTarget.line}:${selection.editTarget.column}`,
        )}`,
      )
    }
    parts.push(`selector=${JSON.stringify(selection.selector)}`)
    if (parts.length > 0) lines.push(`Selection: ${parts.join(', ')}`)
  }
  if (lines.length === 0) return userMessage
  const tag = `context-${randomUUID().slice(0, 8)}`
  return `<${tag}>\n${lines.join('\n')}\n</${tag}>\n\n${userMessage}`
}

/**
 * Model families that support ADAPTIVE thinking — the model decides when and
 * how much to think, with no fixed per-turn token budget. This is the current
 * generation's only supported mode: on these models a fixed `budgetTokens`
 * is deprecated (4.6) or rejected outright (4.7+), and adaptive is what the
 * `effort` parameter modulates. Anything NOT listed here is an older-
 * generation model that still takes a fixed budget.
 *
 * Data, not a pattern — an entry per family, matched exactly or as the stem
 * of a dated snapshot (`claude-opus-5-20260401`). Adding a model to
 * `ANTHROPIC_MODEL_CATALOG` without adding it here (or deliberately leaving
 * it out, as with Haiku 4.5) fails the colocated
 * `resolve-thinking-config.test.ts` coverage assertion.
 */
const ADAPTIVE_THINKING_MODELS: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
]

/**
 * True when `model` is one of the adaptive-thinking Claude families above.
 * Tolerates a dated-snapshot suffix (`-20260401`) but never matches a
 * different family by prefix.
 *
 * Anthropic-scoped BY NAME as of the multi-provider work: adaptive versus
 * fixed-budget thinking is Anthropic's own two-mode system, and this function
 * is consulted for the SDK lane and for the Anthropic catalog's effort
 * fallback. Another provider's reasoning knob is its descriptor's
 * `effort.toRequest`, not this.
 */
export function supportsAnthropicAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_MODELS.some(
    (family) => model === family || model.startsWith(`${family}-`),
  )
}

/**
 * Pick the extended-thinking config for an ANTHROPIC model. Adaptive-thinking
 * models get `{type:'adaptive'}`, which is what `effort` modulates; older
 * generations get a bounded fixed budget so thinking still surfaces.
 *
 * Not reachable for a non-Anthropic session: the SDK runtime is the only
 * caller, and `resolveChatRuntime` only routes `claude-agent-sdk` descriptors
 * to it.
 */
export function resolveAnthropicThinkingConfig(
  model: string,
  adaptiveHint?: boolean,
):
  | { type: 'adaptive'; display: 'summarized' }
  | { type: 'enabled'; budgetTokens: number; display: 'summarized' } {
  // The catalog's own answer wins over the family rule: a live source that
  // says `sonnet` thinks adaptively knows which Sonnet it means.
  if (adaptiveHint ?? supportsAnthropicAdaptiveThinking(model)) {
    return { type: 'adaptive', display: 'summarized' }
  }
  return { type: 'enabled', budgetTokens: 4000, display: 'summarized' }
}

/*
 * `buildSdkPrompt` used to live here. It branched: a plain string for a text
 * turn, a yields-once-then-returns generator for an image turn. Both are gone,
 * and the prompt is now always `turnChannel.stream()`.
 *
 * The branch was the danger, not either shape on its own. Measured against SDK
 * 0.3.143 (`tasks/scripts/sdk-steering-probe.mts`), a generator that returns
 * drops a mid-turn pushed message SILENTLY — `streamInput` resolves, no error,
 * the model never sees it. Keeping the branch would therefore have shipped
 * steering that works on text turns and destroys the user's message on image
 * turns, with nothing at any layer reporting it. One shape, always, is what
 * makes that class of bug unreachable rather than merely guarded against.
 *
 * The message-building itself (context-enveloped text block, empty text block
 * omitted because the Messages API rejects it, one vision block per image) moved
 * verbatim into `turn-input-channel.ts` — same bytes, same envelope, now used
 * for pushed messages too.
 */

/**
 * Adapt the route's AbortSignal to the AbortController the SDK
 * expects. SDK's `Options.abortController` is the entry point for
 * upstream cancellation.
 */
function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
    return controller
  }
  signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

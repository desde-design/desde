/**
 * The neutral chat runtime. One user turn, on the `LLMProvider` seam.
 *
 * Desde owns the loop, so it owns what the Claude Agent SDK owns on the other
 * lane: which tools exist, when they run, what happens when one is refused,
 * when the turn ends, and what reaches the transcript. Three things follow,
 * and each is a simplification rather than a cost.
 *
 *  1. The permission gate runs for EVERY tool, Read included. Under
 *     `permissionMode: 'default'` the SDK never fires `canUseTool` for Read
 *     (MEASURED, see `file-read-snapshot.ts`), which is why that lane needs a
 *     PreToolUse hook to observe reads at all.
 *  2. There is no write guard, no read-snapshot hook and no invalidate hook.
 *     Those three modules exist only because the SDK executes Write, Edit and
 *     Read inside its own runtime. Here the tools are ours and call
 *     `brokeredWrite`, which already journals, locks, rolls back, invalidates
 *     and appends to the ledger.
 *  3. Steer delivery is OBSERVED, not inferred. The loop appends a steer as a
 *     user message itself, so it knows the message reached the request rather
 *     than watching for assistant-message boundaries as evidence.
 *
 * What is genuinely lost is named in the spec and enforced by tests: no
 * mid-generation steering (delivery is at a step boundary), no SDK context
 * compaction (this truncates instead), no vendor in-flight budget stop (the
 * loop stops between steps), and no `rate_limit_warning`.
 *
 * This runtime NEVER sets `session.sdkSessionId`, and it does not persist the
 * session. It returns `{ session, turn }` and `chat-handler.ts` saves, exactly
 * as it does for the SDK lane.
 *
 * Scope of THIS task: one turn, read-only tools, no history replay, no cost
 * ceiling, no steering. Each of those is its own task and its own tests.
 */

import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import {
  AUTH_REAUTH_MESSAGE,
  extractRetryAfterFromError,
  isAuthError,
} from '../agent-chat/classify-turn-error'
import type {
  RunChatTurnOpts,
  RunChatTurnResult,
} from '../agent-chat/run-chat-turn'
import { toToolDefs, type ToolHandlerResult, type ToolSpec } from '../agent-chat/tool-spec'
import type {
  ChatAssistantBlock,
  ChatConflictRecord,
  ChatFileReadRecord,
  ChatPageSnapshot,
  ChatSelectionSnapshot,
  ChatSession,
  ChatToolResult,
  ChatTurn,
} from '../agent-chat/types'
import type { ToolPermissionGate } from '../agent-chat/tool-permission'
import { buildToolPermissionGate } from '../agent-chat-sdk/edit-ack'
import { buildGroundingDigest } from '../agent-chat-sdk/grounding-tools'
import type { EditProposalPayload } from '../agent-tools/types'
import type { EffortLevel } from '../core/model-catalog'
import { runWithChatSession } from '../edit-service/chat-session-context'
import type { ProviderDescriptor } from '../llm-providers/provider-descriptor'
import {
  getDescriptor,
  isCredentialedFromEnv,
  resolveDefaultProviderId,
} from '../llm-providers/provider-registry'
import type {
  AssistantContent,
  ChatUserContent,
  LLMProvider,
  Message,
  ProviderEvent,
  StreamOpts,
  Usage,
} from '../llm-providers/types'
import { branchModeRootCommitSha } from '../worktree/git-branches'

import {
  createNeutralEventAdapter,
  toolResultContent,
  toolResultEvent,
} from './neutral-event-adapter'
import { buildNeutralSystemPrompt } from './system-prompt-neutral'
import { buildNeutralToolCatalog } from './tool-catalog'

/**
 * Hard cap on model steps in one turn. Nothing else stops a tool-loop
 * runaway: a model that keeps calling Read would otherwise spend the session's
 * whole budget with no output. `opts.maxTurns` narrows it (the edit-fix
 * mini-turn passes 12); it can never widen it.
 */
export const MAX_NEUTRAL_STEPS = 40

/** Retries per step on a transient failure, before the turn fails. */
export const API_RETRY_MAX_ATTEMPTS = 3

export interface RunChatTurnNeutralDeps {
  /**
   * Build the provider for this turn. Defaults to the descriptor's own
   * `buildProvider`, reading the key from the environment that
   * `applyLlmCredentialsToEnv` already populated. Injected by tests and by the
   * parity harness, never in production.
   */
  buildProvider?: (input: { providerId: string; model?: string }) => LLMProvider
}

export async function runChatTurnNeutral(
  opts: RunChatTurnOpts,
  deps: RunChatTurnNeutralDeps = {},
): Promise<RunChatTurnResult> {
  return runWithChatSession(
    { sessionId: opts.session.id.sessionId, repoRoot: opts.worktreeRoot },
    () => runInner(opts, deps),
  )
}

async function runInner(
  opts: RunChatTurnOpts,
  deps: RunChatTurnNeutralDeps,
): Promise<RunChatTurnResult> {
  const turnId = randomUUID()
  const startedAt = new Date().toISOString()

  const providerId =
    opts.providerId ??
    opts.session.modelConfig?.provider ??
    resolveDefaultProviderId({
      env: process.env,
      // The registry's own predicate. Re-deriving "is this provider usable"
      // here is exactly the drift the descriptor table exists to remove.
      isCredentialed: (d) => isCredentialedFromEnv(d, process.env),
    })
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    return failFast(opts, turnId, startedAt, `No provider named '${providerId}' is configured.`)
  }
  const model = opts.model ?? descriptor.staticCatalog.models.find((m) => m.isDefault)?.id
  const provider =
    deps.buildProvider?.({ providerId, ...(model ? { model } : {}) }) ??
    descriptor.buildProvider({ ...(model ? { model } : {}) })

  // ── Edit-proposal plumbing (identical semantics to the SDK lane) ─────
  const editProposalRefs: ChatTurn['editProposals'] = []
  const fileReads: Record<string, ChatFileReadRecord> = { ...(opts.session.fileReads ?? {}) }
  const conflicts: Record<string, ChatConflictRecord> = { ...(opts.session.conflicts ?? {}) }

  const rootCommitSha = (await branchModeRootCommitSha(opts.worktreeRoot)) ?? undefined
  const groundingDigest = opts.getGrounding ? await buildGroundingDigest(opts.getGrounding) : null

  const catalog = buildNeutralToolCatalog({
    worktreeRoot: opts.worktreeRoot,
    onFileRead: (r) => {
      fileReads[r.absolutePath] = {
        hashAtRead: r.hashAtRead,
        baseContentPath: '',
        readAt: r.readAt,
      }
    },
    editorToolOpts: {
      bridge: opts.bridge,
      signal: opts.signal,
      emitEdit: async (payload) => {
        const editId = randomUUID()
        opts.emit({ kind: 'edit_proposed', turnId, editId, edit: payload })
        if (opts.awaitEditAck) {
          const ack = await opts.awaitEditAck(editId)
          if (!ack.ok) return { ok: false, reason: ack.reason }
        }
        editProposalRefs.push({
          editId,
          kind: payload.type,
          files: filesOf(payload),
          proposedAt: new Date().toISOString(),
        })
        return { ok: true, editId }
      },
      readRoots: opts.readRoots,
      rootCommitSha,
      verificationAdapter: opts.verificationAdapter,
      worktreeRoot: opts.worktreeRoot,
      invalidateFiles: opts.invalidateFiles,
      ...(opts.webPolicy ? { webPolicy: opts.webPolicy } : {}),
      packageManagerAdapter: opts.packageManagerAdapter,
      getGrounding: opts.getGrounding,
      reviewSurface: opts.reviewSurface,
      // `verify_goal`'s translate step. Pass-through only, exactly as on the
      // SDK lane: this runtime never calls it itself.
      resolveLlmProvider: opts.resolveLlmProvider,
      canvasEnabled: opts.canvasEnabled,
      acquireTreeGate: opts.acquireTreeGate,
    },
    ...(opts.builtinTools ? { builtinTools: opts.builtinTools } : {}),
    ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
  })
  const byName = new Map(catalog.map((spec) => [spec.name, spec]))

  const gate = buildToolPermissionGate({
    worktreeRoot: opts.worktreeRoot,
    // A gate built for the neutral lane never emits: on this lane the write
    // tools call `brokeredWrite`, whose own `emit` is the single source of the
    // `edit_proposed` event. A second emit here would double every diff card.
    emitEditProposal: async () => ({ ok: true, editId: '' }),
    readRoots: opts.readRoots,
    webPolicy: opts.webPolicy,
    getFileReads: () => fileReads,
    onConflictDetected: (detected) => {
      conflicts[detected.absolutePath] = {
        detectedAt: new Date().toISOString(),
        hashAtRead: detected.hashAtRead,
        hashAtWrite: detected.hashAtWrite,
      }
      opts.emit({
        kind: 'edit_overwrite_warning',
        turnId,
        file: detected.file,
        hashAtRead: detected.hashAtRead,
        hashAtWrite: detected.hashAtWrite,
      })
    },
    recordOwnWrite: (absPath, nextHash) => {
      fileReads[absPath] = {
        hashAtRead: nextHash,
        baseContentPath: fileReads[absPath]?.baseContentPath ?? '',
        readAt: new Date().toISOString(),
      }
    },
  })

  const system = buildNeutralSystemPrompt({
    writeToolsEnabled: byName.has('Write'),
    groundingEnabled: opts.getGrounding !== undefined,
    ...(groundingDigest ? { groundingDigest } : {}),
    canvasEnabled: opts.canvasEnabled === true,
    ...(opts.projectKnowledge ? { projectKnowledge: opts.projectKnowledge } : {}),
    disabledCapabilities: opts.disabledCapabilities ?? null,
  })
  const tools = toToolDefs(catalog)

  const messages: Message[] = [
    {
      role: 'user',
      content: buildOpeningContent(opts.userMessage, opts.selection, opts.page, opts.images),
    },
  ]

  const adapter = createNeutralEventAdapter(turnId)
  const assistantContent: ChatAssistantBlock[] = []
  const toolResults: Record<string, ChatToolResult> = {}
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: 'end_turn' | 'error' = 'end_turn'
  let vendorStopReason: string | undefined
  let errorMessage: string | undefined

  opts.emit({ kind: 'turn_start', turnId })

  const stepCap = Math.min(MAX_NEUTRAL_STEPS, opts.maxTurns ?? MAX_NEUTRAL_STEPS)

  // Everything about a step's request except the conversation so far. Built
  // once so the stable prefix is byte-identical across steps, which is what a
  // provider with automatic prompt caching needs to keep hitting.
  const stepRequest = {
    system,
    tools,
    ...(model ? { model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...providerOptionsFor(descriptor, opts.effort),
  }

  try {
    for (let step = 0; ; step++) {
      if (opts.signal?.aborted) {
        stopReason = 'error'
        errorMessage = 'turn aborted'
        break
      }
      if (step >= stepCap) {
        stopReason = 'error'
        errorMessage = `The turn hit its step limit of ${stepCap} without finishing. Ask for a smaller piece of the work.`
        break
      }
      const pending: Array<{ id: string; name: string; input: unknown }> = []
      let assistantMessage: { role: 'assistant'; content: readonly AssistantContent[] } | null =
        null
      let finalUsage: Usage | undefined
      let streamedIn = 0
      let streamedOut = 0
      let lastStep = false

      const streamOpts: StreamOpts = {
        ...stepRequest,
        // A snapshot, not the live array. `messages` grows after this step
        // hands it over, and a provider that read it lazily (or a caller that
        // recorded it) would otherwise see a conversation from the future.
        messages: [...messages],
      }
      for await (const ev of streamStepWithRetry(provider, streamOpts, opts.emit)) {
        for (const out of adapter.adapt(ev)) opts.emit(out)
        if (ev.kind === 'tool_use') {
          pending.push({ id: ev.id, name: ev.name, input: ev.input })
        } else if (ev.kind === 'usage') {
          streamedIn += ev.inputTokens
          streamedOut += ev.outputTokens
          inputTokens += ev.inputTokens
          outputTokens += ev.outputTokens
        } else if (ev.kind === 'message_complete') {
          assistantMessage = ev.message
          finalUsage = ev.usage
          if (ev.stopReason !== 'tool_use') {
            lastStep = true
            if (ev.stopReason !== 'end_turn') {
              stopReason = 'error'
              vendorStopReason = ev.vendorStopReason ?? ev.stopReason
              // Name the reason. "The turn did not finish" tells the user
              // nothing they can act on, and 'max_tokens' and 'refusal' are
              // two very different next steps.
              errorMessage = `The model stopped before finishing the turn: ${vendorStopReason}.`
            }
          }
        }
      }

      if (assistantMessage === null) {
        stopReason = 'error'
        errorMessage = 'The provider ended the stream without completing a message.'
        break
      }

      for (const block of assistantMessage.content) assistantContent.push(toChatBlock(block))
      messages.push(assistantMessage)

      // A `tool_use` stop with no calls in it is a malformed step, not a
      // reason to ask the same question again: treat it as the end.
      if (pending.length === 0) lastStep = true

      if (!lastStep) {
        const results: ChatUserContent[] = []
        for (const call of pending) {
          const result = await runOneTool(call, byName, gate, opts.signal)
          toolResults[call.id] =
            result.isError === true
              ? { ok: false, error: toolResultContent(result) }
              : { ok: true, output: toolResultContent(result) }
          opts.emit(toolResultEvent(turnId, call.id, result))
          results.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: toolResultContent(result),
            // Stated on every result, `undefined` for a success. Both shipped
            // providers drop an undefined flag on the way to the wire, and
            // one shape for both outcomes is one less thing to read wrong.
            isError: result.isError === true ? true : undefined,
          })
        }
        messages.push({ role: 'user', content: results })
      }

      // The step's accounting closes here, after its tool results, so the
      // transcript shows a step's cost attached to the end of that step.
      //
      // Only the SHORTFALL is emitted. `message_complete.usage` is the
      // authoritative figure for the step, but a provider that already
      // streamed `usage` events during the step has reported those tokens
      // once already (both shipped providers do exactly that), and adding
      // the final figure on top would double every turn's count. A provider
      // that reports usage only on its final message still gets counted,
      // which is the case this exists for.
      const extraIn = Math.max(0, (finalUsage?.inputTokens ?? 0) - streamedIn)
      const extraOut = Math.max(0, (finalUsage?.outputTokens ?? 0) - streamedOut)
      if (extraIn > 0 || extraOut > 0) {
        inputTokens += extraIn
        outputTokens += extraOut
        opts.emit({ kind: 'usage', turnId, inputTokens: extraIn, outputTokens: extraOut })
      }

      if (lastStep) break
    }
  } catch (err) {
    stopReason = 'error'
    if (opts.signal?.aborted) {
      errorMessage = 'turn aborted'
    } else {
      const retryAfter = extractRetryAfterFromError(err)
      const hint = retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ''
      const raw = err instanceof Error ? err.message : String(err)
      errorMessage = isAuthError(raw) ? AUTH_REAUTH_MESSAGE : `${raw}${hint}`
    }
  }

  if (stopReason === 'error') {
    opts.emit({ kind: 'error', turnId, reason: errorMessage ?? 'The turn did not finish.' })
  }
  opts.emit({
    kind: 'turn_complete',
    turnId,
    stopReason: stopReason === 'error' ? 'error' : 'end_turn',
    ...(vendorStopReason ? { vendorStopReason } : {}),
  })

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
    usage: inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined,
    model,
    ...(opts.effort ? { effort: opts.effort } : {}),
    error: errorMessage,
  }
  const session: ChatSession = {
    ...opts.session,
    updatedAt: completedAt,
    turns: [...opts.session.turns, turn],
    ...(Object.keys(fileReads).length > 0 ? { fileReads } : {}),
    ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}),
  }
  return { session, turn }
}

/**
 * Run one tool call: gate, then validate, then execute. That order is the
 * contract. A denial and a bad-argument refusal both come back as an
 * `isError` tool_result the model can read and correct from, never as a throw,
 * because a throw ends the turn and the model learns nothing.
 */
async function runOneTool(
  call: { id: string; name: string; input: unknown },
  byName: ReadonlyMap<string, ToolSpec>,
  gate: ToolPermissionGate,
  signal: AbortSignal | undefined,
): Promise<ToolHandlerResult> {
  const input =
    call.input && typeof call.input === 'object'
      ? (call.input as Record<string, unknown>)
      : {}
  const spec = byName.get(call.name)
  if (!spec) {
    return errResult(
      `There is no tool named '${call.name}' in this session. Use one of the tools listed in your instructions.`,
    )
  }
  const decision = await gate(call.name, input, {
    ...(signal ? { signal } : {}),
    toolUseId: call.id,
  })
  if (decision.behavior === 'deny') return errResult(decision.message)
  const parsed = z.object(spec.inputShape).safeParse(input)
  if (!parsed.success) {
    return errResult(
      `${call.name} was called with invalid arguments: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    )
  }
  try {
    return await spec.handler(parsed.data as Record<string, unknown>, {
      ...(signal ? { signal } : {}),
      toolUseId: call.id,
    })
  } catch (err) {
    return errResult(
      `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * One model step, with a bounded backoff on a transient failure.
 *
 * The SDK emits `api_retry` from inside its own retry loop. Here the loop is
 * ours, so the event carries real numbers rather than an estimate. Retries
 * only fire before any event has been yielded for the step: once text is on
 * the user's screen, restarting would duplicate it.
 */
async function* streamStepWithRetry(
  provider: LLMProvider,
  streamOpts: StreamOpts,
  emit: (event: ChatStreamEvent) => void,
): AsyncGenerator<ProviderEvent> {
  for (let attempt = 1; ; attempt++) {
    let yielded = false
    try {
      for await (const ev of provider.streamConversation(streamOpts)) {
        yielded = true
        yield ev
      }
      return
    } catch (err) {
      if (streamOpts.signal?.aborted) throw err
      const status = httpStatusOf(err)
      const retriable = status === 429 || (status !== null && status >= 500)
      if (yielded || !retriable || attempt >= API_RETRY_MAX_ATTEMPTS) throw err
      const retryDelayMs = (extractRetryAfterFromError(err) ?? 2 ** attempt) * 1000
      emit({
        kind: 'api_retry',
        retryDelayMs,
        attempt,
        maxRetries: API_RETRY_MAX_ATTEMPTS,
        errorStatus: status,
      })
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
}

/** The HTTP status inside a provider error, when there is one. */
function httpStatusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status === 'number') return status
  const message = err instanceof Error ? err.message : ''
  const match = /\b(4\d\d|5\d\d)\b/.exec(message)
  return match ? Number(match[1]) : null
}

function providerOptionsFor(
  descriptor: ProviderDescriptor,
  effort: EffortLevel | undefined,
): { providerOptions?: Record<string, unknown> } {
  const fields = descriptor.effort.toRequest(effort)
  return Object.keys(fields).length > 0 ? { providerOptions: fields } : {}
}

function toChatBlock(block: AssistantContent): ChatAssistantBlock {
  return block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'tool_use', toolUseId: block.id, name: block.name, input: block.input }
}

function filesOf(payload: EditProposalPayload): string[] {
  switch (payload.type) {
    case 'prop_edit':
      return []
    case 'overwrite':
    case 'file_delete':
      return [payload.file]
    case 'file_rename':
      return [payload.fromFile, payload.toFile]
  }
}

/**
 * The opening user message: the context envelope, then the user's own words,
 * then any images.
 *
 * The envelope is built the same way the SDK lane builds it, with a per-turn
 * random tag, so a malicious page title cannot close it and inject into the
 * user-prompt position. The user's authoritative request is whatever follows
 * the closing tag, which is what the prompt's envelope section tells the model.
 */
function buildOpeningContent(
  userMessage: string,
  selection: ChatSelectionSnapshot | undefined,
  page: ChatPageSnapshot | undefined,
  images: RunChatTurnOpts['images'],
): ChatUserContent[] {
  const lines: string[] = []
  if (page) {
    const parts: string[] = []
    if (page.route) parts.push(`route=${JSON.stringify(page.route)}`)
    if (page.framework) parts.push(`framework=${JSON.stringify(page.framework)}`)
    if (page.title) parts.push(`title=${JSON.stringify(page.title)}`)
    if (parts.length > 0) lines.push(`Page: ${parts.join(', ')}`)
  }
  if (selection) {
    const parts: string[] = []
    if (selection.componentName) parts.push(`component=${JSON.stringify(selection.componentName)}`)
    if (selection.componentFile) parts.push(`file=${JSON.stringify(selection.componentFile)}`)
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
  const text =
    lines.length === 0
      ? userMessage
      : (() => {
          const tag = `context-${randomUUID().slice(0, 8)}`
          return `<${tag}>\n${lines.join('\n')}\n</${tag}>\n\n${userMessage}`
        })()
  const content: ChatUserContent[] = [{ type: 'text', text }]
  for (const image of images ?? []) {
    content.push({ type: 'image', mediaType: image.mimeType, data: image.data })
  }
  return content
}

function errResult(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** A refusal that never started a model call: emit, record, return. */
function failFast(
  opts: RunChatTurnOpts,
  turnId: string,
  startedAt: string,
  reason: string,
): RunChatTurnResult {
  opts.emit({ kind: 'error', turnId, reason })
  opts.emit({ kind: 'turn_complete', turnId, stopReason: 'error' })
  const completedAt = new Date().toISOString()
  const turn: ChatTurn = {
    id: turnId,
    startedAt,
    completedAt,
    userMessage: opts.userMessage,
    selection: opts.selection,
    page: opts.page,
    assistantContent: [],
    toolResults: {},
    editProposals: [],
    error: reason,
    model: opts.model,
  }
  return {
    session: { ...opts.session, updatedAt: completedAt, turns: [...opts.session.turns, turn] },
    turn,
  }
}

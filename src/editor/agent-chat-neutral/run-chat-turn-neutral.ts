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
 * History replay and the cost ceiling are wired in (`history-replay.ts`,
 * `cost-guard.ts`). Steering is not: each of those was its own task and its
 * own tests.
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
  ChatSteeredMessage,
  ChatToolResult,
  ChatTurn,
} from '../agent-chat/types'
import type { ToolPermissionGate } from '../agent-chat/tool-permission'
import { buildToolPermissionGate } from '../agent-chat-sdk/edit-ack'
import { captureReadSnapshot } from '../agent-chat-sdk/file-read-snapshot'
import { buildGroundingDigest } from '../agent-chat-sdk/grounding-tools'
import { writeProposalBlob } from '../agent-chat-sdk/proposal-blob-store'
import {
  attachSteerReconciliation,
  createTurnInputChannel,
} from '../agent-chat-sdk/turn-input-channel'
import type { EditProposalPayload } from '../agent-tools/types'
import { computeSessionCost } from '../agent-chat/session-cost'
import type { EffortLevel } from '../core/model-catalog'
import { runWithChatSession } from '../edit-service/chat-session-context'
import type { ProviderDescriptor } from '../llm-providers/provider-descriptor'
import {
  credentialsFromEnv,
  getDescriptor,
  isCredentialedFromEnv,
  resolveDefaultProviderId,
} from '../llm-providers/provider-registry'
import { chatCredentialsMessage } from '../llm-providers/assert-chat-credentials'
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

import { applyContextBudget } from './context-budget'
import { createCostGuard } from './cost-guard'
import { replayHistory } from './history-replay'
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

/**
 * Ceiling on one retry wait. `extractRetryAfterFromError` reports a vendor's
 * own `retry-after` up to an hour, and sleeping that literally would park the
 * turn with nothing on screen for an hour. Waiting a minute and trying again is
 * behaviour a user can sit through, and the emitted `api_retry` reports the
 * capped number, because that is the wait that actually happens.
 */
export const MAX_RETRY_SLEEP_MS = 60_000

export interface RunChatTurnNeutralDeps {
  /**
   * Build the provider for this turn. Defaults to reading the descriptor's
   * key and base URL from the environment through `credentialsFromEnv` and
   * calling the descriptor's own `buildProvider` with them. Only tests inject
   * this, so they can drive a scripted provider without touching the real
   * environment; production never sets it.
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
  let provider: LLMProvider
  if (deps.buildProvider) {
    provider = deps.buildProvider({ providerId, ...(model ? { model } : {}) })
  } else {
    // The Anthropic descriptor only reaches this default path under the dev
    // subscription override, where `hasSubscriptionRuntime` covers a missing
    // key. Every other provider needs its own key: fail fast with the
    // provider's own remediation message rather than build a provider with an
    // empty bearer token.
    const credentials = credentialsFromEnv(descriptor, process.env)
    if (!credentials.apiKey && !descriptor.credentials.hasSubscriptionRuntime) {
      return failFast(opts, turnId, startedAt, chatCredentialsMessage(descriptor))
    }
    provider = descriptor.buildProvider({ ...credentials, ...(model ? { model } : {}) })
  }

  // ── Cost ceiling (pre-turn) ───────────────────────────────────────
  // Refuse before spending a single token if the session is already over.
  const priorCostUsd = computeSessionCost(opts.session)
  if (typeof opts.costCeilingUsd === 'number' && priorCostUsd >= opts.costCeilingUsd) {
    return failFast(
      opts,
      turnId,
      startedAt,
      `Session cost ceiling reached ($${priorCostUsd.toFixed(2)} of $${opts.costCeilingUsd}). Start a new session or raise the ceiling.`,
    )
  }
  const costGuard = createCostGuard({
    model: model ?? 'unknown-model',
    priorCostUsd,
    ...(typeof opts.costCeilingUsd === 'number' ? { ceilingUsd: opts.costCeilingUsd } : {}),
  })

  // ── Edit-proposal plumbing (identical semantics to the SDK lane) ─────
  const editProposalRefs: ChatTurn['editProposals'] = []
  const fileReads: Record<string, ChatFileReadRecord> = { ...(opts.session.fileReads ?? {}) }
  const conflicts: Record<string, ChatConflictRecord> = { ...(opts.session.conflicts ?? {}) }

  const rootCommitSha = (await branchModeRootCommitSha(opts.worktreeRoot)) ?? undefined
  const groundingDigest = opts.getGrounding ? await buildGroundingDigest(opts.getGrounding) : null

  // Hoisted above the catalog because the editor tools and the built-in write
  // tools must fire the SAME closure: one turn's `editProposals` list, one
  // `edit_proposed` event shape, one ack round-trip.
  const emitEditProposal = async (
    payload: EditProposalPayload,
  ): Promise<{ ok: true; editId: string } | { ok: false; reason: string }> => {
    const editId = randomUUID()
    // What this session MEANT to write, persisted before the event fires and
    // keyed by the same `editId` the proposal record carries. The working tree
    // keeps only the last writer's bytes, so this blob is the only thing "Use
    // mine" can recover from after another session overwrites the file.
    //
    // Best-effort, exactly as on the SDK lane (`run-chat-turn-sdk.ts`): a
    // failure to persist costs recovery of this one edit and must not take
    // down the edit that is otherwise fine.
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
          `[runChatTurnNeutral] failed to persist proposal blob for editId=${editId}: ${
            (err as Error).message
          }`,
        )
      }
    }
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
  }

  const catalog = buildNeutralToolCatalog({
    worktreeRoot: opts.worktreeRoot,
    onFileRead: async (r) => {
      // The read-time base, written to the SAME layout the SDK lane writes it
      // to. Without it `resolve-conflict.ts` has nothing to merge against and
      // refuses "Merge" with a message about base capture not being enabled —
      // which would be true of this lane and of no other.
      const snapshot = await captureReadSnapshot(r.repoRel, {
        worktreeRoot: opts.worktreeRoot,
        sessionId: opts.session.id.sessionId,
      })
      fileReads[r.absolutePath] = {
        hashAtRead: r.hashAtRead,
        // The snapshot file is named for the hash of the bytes IT read, and
        // the resolver looks the base up by the `hashAtRead` recorded here. If
        // the file changed between the tool's read and the snapshot's, the two
        // no longer describe the same content, so record no base rather than
        // one that is not the base the model was shown.
        baseContentPath:
          snapshot !== null && snapshot.hashAtRead === r.hashAtRead
            ? snapshot.baseContentPath
            : '',
        readAt: r.readAt,
      }
    },
    writeToolsEnabled: true,
    writeOpts: {
      worktreeRoot: opts.worktreeRoot,
      emitEdit: emitEditProposal,
      ...(opts.invalidateFiles ? { invalidateFiles: opts.invalidateFiles } : {}),
      ...(opts.acquireTreeGate ? { acquireTreeGate: opts.acquireTreeGate } : {}),
      ...(opts.recordHistory !== undefined ? { recordHistory: opts.recordHistory } : {}),
      // acquireWriteLock is NOT threaded here, on purpose.
      //
      // On the SDK lane it is the ONLY serialization available: the SDK
      // performs the write inside its own runtime, so `sdk-write-guard.ts` has
      // to bracket the tool call with the CLI's own lock. This lane performs
      // the write itself, and `brokeredWrite` already takes a FileLockManager
      // lock per path, keyed on the REAL resolved path, held across the whole
      // batch. The CLI edit route funnels through the same `brokeredWrite`, so
      // its writes and ours serialize against each other at that inner layer
      // regardless of what either one holds outside it. `session-lock.ts` says
      // as much about its own coarser key namespace: "the worst case for a
      // divergent spelling is losing the outer (coarse) serialization while
      // the inner write lock still prevents interleaved writes to the same
      // bytes."
      //
      // Adding it would not merely be redundant, it would deadlock. The CLI's
      // `acquireFileEditLock` takes the repo's tree gate SHARED (see the
      // "Parallel batch + a concurrent tree op" note in `sdk-write-guard.ts`),
      // and `acquireTreeGate` above is already holding the shared gate across
      // this entire call. Under session-lock's anti-starvation rule a PENDING
      // exclusive blocks new shared acquisitions, so a Commit or Publish
      // arriving between the two acquisitions parks the second one behind an
      // exclusive that is waiting on the first, which we hold. The SDK lane
      // survives that shape because its guard has a 15s watchdog. This lane
      // has none, and should not grow one to make an unnecessary lock safe.
      //
      // What the outer lock would have bought and how it is bought instead: a
      // stale read between reconstruction and the write is closed by the
      // `preconditions` entry in `builtin-edit.ts`, checked under the batch's
      // OWN locks; ordering against Commit, Publish and branch mutation,
      // including the ledger append, is `acquireTreeGate`.
      //
      // The edit-fix mini-turn is the one caller that supplies neither: it
      // already runs inside `withTreeLock`'s EXCLUSIVE hold, so acquiring the
      // shared gate from within it would self-deadlock for the same reason. It
      // needs nothing here, because an exclusive holder is a strictly stronger
      // guarantee than either lock.
    },
    editorToolOpts: {
      bridge: opts.bridge,
      signal: opts.signal,
      emitEdit: emitEditProposal,
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

  const history = await replayHistory({
    session: opts.session,
    repoRoot: opts.worktreeRoot,
  })
  const opening: Message = {
    role: 'user',
    content: buildOpeningContent(opts.userMessage, opts.selection, opts.page, opts.images),
  }
  const budgeted = applyContextBudget([...history, opening])
  const messages: Message[] = budgeted.messages
  // The notice rides on the SYSTEM prompt rather than as a message, because a
  // synthetic user message would replay into the next turn's history as
  // something the user said.
  const systemWithNotice = budgeted.notice ? `${system}\n\n${budgeted.notice}` : system

  const adapter = createNeutralEventAdapter(turnId)
  const assistantContent: ChatAssistantBlock[] = []
  const toolResults: Record<string, ChatToolResult> = {}

  const steerRecords: ChatSteeredMessage[] = []
  const turnChannel = opts.inputChannel ?? createTurnInputChannel()
  // Seeded so the channel's own lifecycle matches the SDK lane's: steers
  // accepted before the runtime was reached are already queued behind it, and
  // `begin` puts the opening prompt at the head of that queue.
  turnChannel.begin(
    {
      text: opts.userMessage,
      ...(opts.images?.length ? { images: opts.images } : {}),
    },
    // No `onAccepted`: this lane records a steer where it delivers it, in the
    // boundary-delivery block below, not at accept time. Accept time is not
    // useful here — a steer can be accepted before the turn's first request
    // is even built, and this lane knows the position it will actually land
    // at because it appends the message itself.
  )

  // Shared with the SDK lane: see `attachSteerReconciliation` in
  // `turn-input-channel.ts` for the close-then-drain rule and why abort
  // reports too, not just a bare close.
  const closeChannelAndReportUndelivered = attachSteerReconciliation({
    channel: turnChannel,
    sessionId: opts.session.id.sessionId,
    emit: opts.emit,
    signal: opts.signal,
  })
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
    system: systemWithNotice,
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
      if (costGuard.exceeded) {
        stopReason = 'error'
        errorMessage = costGuard.refusalMessage()
        break
      }

      // Boundary delivery. Drain before the step is assembled, so anything the
      // user typed during the previous step is part of THIS request. Step 0
      // has no previous step — its request is the turn's opening prompt,
      // already built above — so nothing is drained until step 1.
      if (step > 0) {
        for (const steer of turnChannel.drainSteers()) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: steer.text },
              ...(steer.images ?? []).map((image) => ({
                type: 'image' as const,
                mediaType: image.mimeType,
                data: image.data,
              })),
            ],
          })
          // Recorded here, at delivery, rather than at accept time: this lane
          // OBSERVES delivery (it appends the message itself), so the position
          // it can report is exact, not an approximation from whenever the
          // steer was accepted.
          //
          // This lane emits `steered` ITSELF, and the steer route suppresses
          // its own frame for a neutral turn (`chat-handler.ts`, keyed on
          // `LiveTurn.runtimeEmitsSteered`) so exactly one frame reaches the
          // client per steer. The emitter has to be the side that knows WHERE
          // the steer landed: the client cuts its transcript on this frame,
          // and the position recorded a line above is stamped at this same
          // moment. Emitting from the route instead moves the live cut to
          // accept time, which is a different moment from the position
          // hydration replays — the live transcript then disagrees with the
          // re-hydrated one, which `useEditorChat-turn-ordering.test.ts`
          // catches as the "steer at a tool boundary" row.
          steerRecords.push({
            text: steer.text,
            ...(steer.images?.length ? { hadImages: true } : {}),
            afterAssistantBlocks: assistantContent.length,
          })
          opts.emit({
            kind: 'steered',
            sessionId: opts.session.id.sessionId,
            userMessage: steer.text,
            imageCount: steer.images?.length ?? 0,
          })
        }
        // Everything just drained is now in `messages` AND in `steerRecords`,
        // which is persisted on the turn even if this step then fails, and
        // replayed as a user message on the next turn. So the channel must
        // stop reporting these for resubmission: the user acting on that
        // prompt would send the same message a second time (2026-09-04
        // adversarial review, P3-4). Anything still queued is untouched.
        turnChannel.noteSteersRecorded()
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
          costGuard.record({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens })
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

      // The observable "a new request was assembled" marker the channel's
      // undelivered-steer rule reads. On the SDK lane this comes off the
      // wire; here the loop IS the thing that assembles requests, so it can
      // simply say so.
      turnChannel.noteAssistantMessage(randomUUID())

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
        costGuard.record({ inputTokens: extraIn, outputTokens: extraOut })
        opts.emit({ kind: 'usage', turnId, inputTokens: extraIn, outputTokens: extraOut })
      }

      if (lastStep) break
    }
  } catch (err) {
    stopReason = 'error'
    if (opts.signal?.aborted) {
      errorMessage = 'turn aborted'
    } else {
      // Unwrapped first: the SDK's `RetryError` envelope carries no headers,
      // and its message prefixes the vendor's own wording with "Failed after
      // N attempts", which is this loop's business and not the user's.
      const cause = unwrapProviderError(err)
      const retryAfter = extractRetryAfterFromError(cause)
      const hint = retryAfter !== undefined ? ` (retry after ${retryAfter}s)` : ''
      const raw = cause instanceof Error ? cause.message : String(cause)
      errorMessage = isAuthError(raw, { errorPatterns: descriptor.errorPatterns })
        ? (descriptor.errorPatterns?.reauthMessage ?? AUTH_REAUTH_MESSAGE)
        : `${raw}${hint}`
    }
  } finally {
    // Backstop for every path that reaches neither the abort listener nor a
    // clean end of the loop. Closing twice is a no-op and the steer drain is
    // one-shot, so the common case (already reconciled at abort) costs
    // nothing, while a turn that died holding a steer still reports it.
    closeChannelAndReportUndelivered()
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
    // Omitted entirely when nothing was steered, so a turn that took no
    // steers serializes exactly as it did before this field existed.
    ...(steerRecords.length > 0 ? { steers: steerRecords } : {}),
    usage: inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : undefined,
    costUsd: costGuard.turnCostUsd > 0 ? costGuard.turnCostUsd : undefined,
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
  // The gate is INSIDE the same try as the handler, and that is the contract
  // above rather than tidiness. It reconstructs the write to decide, so it
  // touches the filesystem, and a `Write` whose `file_path` names a directory
  // used to throw EISDIR straight out of here and end the whole turn with a
  // raw errno string in the banner (2026-09-04 adversarial review, P2-1).
  // Aiming Write at a directory is an ordinary model slip, not an attack, and
  // the model can correct from a tool result.
  try {
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
      const retriable =
        isRetryableError(err) || status === 429 || (status !== null && status >= 500)
      if (yielded || !retriable || attempt >= API_RETRY_MAX_ATTEMPTS) throw err
      const requestedMs =
        (extractRetryAfterFromError(unwrapProviderError(err)) ?? 2 ** attempt) * 1000
      const retryDelayMs = Math.min(requestedMs, MAX_RETRY_SLEEP_MS)
      emit({
        kind: 'api_retry',
        retryDelayMs,
        attempt,
        maxRetries: API_RETRY_MAX_ATTEMPTS,
        errorStatus: status,
      })
      await waitOrAbort(retryDelayMs, streamOpts.signal)
      // The wait is the one blocking point long enough for a user to give up
      // during, so it ends on abort and the turn stops here rather than paying
      // for another request.
      if (streamOpts.signal?.aborted) throw err
    }
  }
}

/**
 * Sleep for `ms`, or return the moment the turn is aborted, whichever is first.
 * The listener is removed either way, so a long turn cannot accumulate one per
 * retry on the caller's signal.
 */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Guard against a cyclic `lastError` chain parking the unwrap in a loop. */
const MAX_ERROR_UNWRAP_DEPTH = 8

/**
 * The error a provider actually failed with, dug out of any envelope wrapped
 * around it.
 *
 * The AI SDK's own retry loop replaces the vendor's `APICallError` with a
 * `RetryError` once its attempts run out, and that envelope carries no
 * `statusCode`, no `status`, no `headers` and no `isRetryable` — only
 * `lastError` and `errors`. Classifying the envelope therefore answered "not
 * retriable, no status" for every 429 and 5xx, which is the whole class of
 * failure the retry path exists for. `maxRetries: 0` in
 * `ai-sdk-provider.ts` stops that envelope being built on the chat lane at
 * all; this unwrap is what makes the classification correct anyway, for a
 * gateway or a future transport that still wraps.
 *
 * Structural on purpose: reading `lastError` / `errors` costs nothing and
 * needs no import of the SDK, which this file is fenced out of.
 */
function unwrapProviderError(err: unknown): unknown {
  let current = err
  for (let depth = 0; depth < MAX_ERROR_UNWRAP_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return current
    const envelope = current as { lastError?: unknown; errors?: unknown }
    const inner =
      envelope.lastError ??
      (Array.isArray(envelope.errors) && envelope.errors.length > 0
        ? envelope.errors[envelope.errors.length - 1]
        : undefined)
    if (inner === undefined || inner === null || inner === current) return current
    current = inner
  }
  return current
}

/**
 * The HTTP status inside a provider error, when there is one.
 *
 * The AI SDK's `APICallError` exposes `statusCode`, not `status` — reading
 * `status` left this always `null` for a real OpenAI error and fell through
 * to a message-text regex that a typical 429 body does not match (final
 * review I4). `status` stays as a fallback for a hand-shaped or third-party
 * error that happens to use the more common field name. The error is
 * unwrapped first, because the envelope carries neither field.
 */
function httpStatusOf(err: unknown): number | null {
  const cause = unwrapProviderError(err)
  const candidate = cause as { statusCode?: unknown; status?: unknown } | null
  const status = candidate?.statusCode ?? candidate?.status
  if (typeof status === 'number') return status
  const message = cause instanceof Error ? cause.message : ''
  const match = /\b(4\d\d|5\d\d)\b/.exec(message)
  return match ? Number(match[1]) : null
}

/**
 * `APICallError.isRetryable`, when the error carries one. A gateway can mark
 * an error retriable at a status this code would not otherwise recognize
 * (or without a status at all), and that flag is more authoritative than the
 * regex fallback in `httpStatusOf`. Unwrapped first, for the same reason.
 */
function isRetryableError(err: unknown): boolean {
  return (unwrapProviderError(err) as { isRetryable?: unknown } | null)?.isRetryable === true
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

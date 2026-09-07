/**
 * Turn input channel — the ONE prompt shape every SDK chat turn runs on.
 *
 * A chat turn used to hand `query()` either a plain string (text turns) or a
 * generator that yielded once and returned (image turns). Both shapes work for
 * a turn nobody talks to. Neither works for steering — sending a second message
 * while the agent is still working — and they fail differently, which is what
 * makes a channel the only safe answer. Measured 2026-08-14 against
 * `@anthropic-ai/claude-agent-sdk` 0.3.143 by
 * `tasks/scripts/sdk-steering-probe.mts`:
 *
 * - A generator that yields once and RETURNS drops a pushed message SILENTLY.
 *   `streamInput` resolves, no error is raised, and the model never sees it.
 *   Branching on images would therefore have shipped a feature that works on
 *   text turns and destroys the user's message on image turns.
 * - Calling `streamInput()` a second time in the same turn is silently
 *   discarded too. ALPHA (pushed at 4.0s) arrived at 9.6s; BRAVO (pushed at
 *   12.0s, with two model boundaries left before the turn ended at 22.3s) never
 *   arrived. Two quick corrections in a row is ordinary user behaviour, so the
 *   obvious "one streamInput call per message" implementation ships as data
 *   loss. Pushing into ONE long-lived generator delivered both (9.5s, 15.3s).
 *
 * So: one channel per turn, always, images or not, steer or not. Its first
 * yield is the initial user message; after that it yields whatever is pushed.
 *
 * Construction and the opening message are DELIBERATELY two steps
 * ({@link createTurnInputChannel} then {@link TurnInputChannel.begin}). The
 * channel is registered as steerable the instant the per-session turn lock is
 * taken, and the turn runtime is only reached many awaits later — session load,
 * project knowledge, web policy, the concurrency-cap queue. One step would put
 * the opening message's construction (selection/page context, which only the
 * runtime knows) on the critical path of that registration, and every
 * millisecond of that path is a millisecond in which the lock says "a turn is
 * running" while the registry says "nothing to steer" and the route answers
 * 409. Two steps make the window not exist rather than making it small.
 *
 * The cost, named honestly: a held-open generator does NOT self-terminate. The
 * SDK closes stdin only for a single-turn query (`isSingleUserTurn`, latched
 * from `typeof prompt === "string"`), so owning the channel means owning
 * termination — see `close()`. Measured cost of an explicit close: 156-206ms to
 * iterator completion. That converts an impossible failure into a possible one,
 * and it is still the right trade because of the SHAPE of the two failures. A
 * dropped message is silent and destroys the user's work. A channel we forget
 * to close is loud (the SSE stream never ends) and destroys nothing.
 *
 * Owning termination also means owning the ACCOUNTING. Handing a message to the
 * SDK is not the same as the model reading it, and the gap between the two is
 * where a steer can vanish: the SDK writes it to the child's stdin, the model
 * decides it is finished, and `result` arrives with the message never folded
 * into any request. Nothing in that sequence reports an error. So the channel
 * tracks every accepted steer against what we can observe — see
 * {@link TurnInputChannel.noteAssistantMessage} and
 * {@link TurnInputChannel.takeUndeliveredSteers} — and the turn runtime reports
 * the unaccounted-for ones back to the client for resubmission.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'

import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import type { ModelImageContent } from './media-content'

/**
 * A steer the channel accepted, in the form needed to send it again.
 *
 * The text and the images are kept verbatim — not a summary, not an id — so a
 * client handed one back can resubmit exactly what the user typed. Anything
 * lossier would turn "we could not deliver this" into "we could not deliver
 * this and you cannot have it back", which is the loss it exists to prevent.
 */
export interface SteeredMessage {
  text: string
  images?: ModelImageContent[]
}

export interface TurnInputChannel {
  /**
   * Seed the turn's OPENING message and attach the accept observer. Called
   * once, by the turn runtime, immediately before `query()`.
   *
   * The opening message goes to the HEAD of the queue, not the tail. A steer
   * accepted between registration and this call is already queued, and the
   * user's original prompt still has to be the first thing the model sees —
   * appending would hand the agent a correction to work it has not been given.
   *
   * Steers accepted before this call are replayed to `options.onAccepted` in
   * accept order, so a message typed during the turn's setup is recorded on the
   * persisted transcript exactly like one typed mid-reply.
   *
   * THROWS if called twice, and THROWS if the channel is already closed —
   * seeding a closed channel would queue the user's opening prompt where
   * nothing will ever read it, which is the silent drop this module exists to
   * design out, applied to the most important message of the turn.
   */
  begin(
    first: { text: string; images?: ModelImageContent[] },
    options?: TurnInputChannelOptions,
  ): void
  /**
   * Queue another user message for the running turn. It reaches the model at
   * the next model boundary inside the turn (measured: pushed at 4.0s, the
   * in-flight tool result returned at 8.5s, consumed at 10.2s) — before the
   * turn's `result`.
   *
   * Legal BEFORE {@link begin} — that is the whole point of the two-step
   * lifecycle. Such a message waits behind the opening prompt and is accounted
   * for like any other steer: if the turn never starts, nothing pulled it, and
   * {@link takeUndeliveredSteers} reports it for resubmission.
   *
   * THROWS if the channel is already closed. That is deliberate: a closed
   * channel can no longer deliver, and returning quietly would recreate the
   * silent drop this whole module exists to design out. Callers hold a live
   * channel from a registry that outlives the close by a tick, so check
   * `closed` immediately before pushing — the check and the push are atomic
   * with respect to `close()` as long as nothing is awaited between them.
   */
  push(text: string, images?: ModelImageContent[]): void
  /**
   * End the stream. Anything already queued is yielded FIRST; the generator
   * returns only once the queue is drained. A close that threw away a queued
   * message would be the same silent loss in a different costume — this time
   * caused by us rather than by the SDK.
   *
   * The one exception is a close before {@link begin}: the turn never started,
   * so nothing is yielded at all. Those messages are not lost, they are
   * REPORTED — nothing pulled them, so {@link takeUndeliveredSteers} hands them
   * back for resubmission.
   *
   * Idempotent: the turn runtime closes on `result`, on abort, and again in
   * its finally block, and the CLI handler closes again in the finally that
   * releases the turn lock. All four may fire for one turn.
   */
  close(): void
  readonly closed: boolean
  /**
   * Record that a new assistant MESSAGE started — which is to say, a new
   * inference request was made. Called by the turn runtime for every main-loop
   * assistant message boundary the SDK streams back, identified by that
   * message's id. See {@link readAssistantMessageBoundaryId} for how a
   * boundary is recognised.
   *
   * Repeated calls with the SAME id count once. That is the whole point of
   * taking an id rather than being a bare counter: with
   * `includePartialMessages: true` (which the turn runtime sets) every streamed
   * token arrives as its own `stream_event`, and a bare counter counted those
   * as evidence.
   *
   * This is the ONLY observable proxy we have for "the model has read its
   * pending input". We cannot see the model's context, and the SDK gives us no
   * acknowledgement that a stdin message was folded into a request. What we CAN
   * say is that a request assembled before a steer existed cannot contain it,
   * and a request assembled after the hand-off probably does. A new assistant
   * message id is that second request. See {@link takeUndeliveredSteers}.
   */
  noteAssistantMessage(messageId: string): void
  /**
   * Every accepted steer this channel cannot prove the model saw, drained from
   * the tracking list so a second call reports nothing.
   *
   * A steer counts as undelivered when either
   *   - the SDK never pulled it out of the queue (definitive: those bytes never
   *     reached the child process at all), or
   *   - the SDK pulled it but no NEW assistant message has begun since
   *     (evidential: no inference request that could have contained it was ever
   *     started, so there is no sign the model read it).
   *
   * The second test used to count model-output EVENTS, and that made it inert.
   * `includePartialMessages: true` turns every streamed token into its own
   * `stream_event`, so the partials of a message that was already in flight
   * when the steer arrived were counted as evidence the model had read it —
   * even though that message's request was assembled before the steer existed.
   * The measured repro, now a permanent test below: a steer lands mid-tool-call,
   * the tool returns, the model finishes answering the ORIGINAL task inside the
   * SAME message, `result`. Every partial of that answer bumped the counter, so
   * the steer was reported delivered and the user's message was silently gone —
   * precisely the interleaving the guard was written to catch.
   *
   * The second test is still a heuristic, and it is still deliberately biased.
   * A new message that began after the hand-off may have been assembled from a
   * request the SDK had already built, in which case we call an undelivered
   * steer delivered; more often we go the other way and call a delivered steer
   * undelivered, and the user's message gets sent twice. **When the evidence is
   * ambiguous we report for resubmission: delivering twice is a visible
   * annoyance, losing once destroys the user's work silently. Repeat over drop,
   * always.**
   *
   * The caller must close the channel BEFORE draining. Draining first leaves a
   * window where a steer can be accepted (channel still open) and then closed
   * away unreported — exactly the silent loss this method exists to surface.
   */
  takeUndeliveredSteers(): SteeredMessage[]
  /**
   * Declare that every steer already pulled out of this channel is recorded
   * somewhere durable, so {@link takeUndeliveredSteers} must stop reporting
   * them however the turn ends.
   *
   * For the SELF-DRIVEN lane only, and it is not a weakening of the evidence
   * rule above — it is a different kind of evidence. That lane appends a
   * drained steer into the request itself and records it on the turn it
   * returns, and the turn is persisted even when the step then fails, so
   * `history-replay.ts` replays the steer as a user message on the very next
   * turn. The message is therefore not lost, and asking the user to send it
   * again would put it in the transcript twice (2026-09-04 adversarial review,
   * P3-4). Steers still QUEUED are untouched: nothing recorded those, and they
   * are still reported.
   *
   * The SDK lane must never call this. There, "pulled" only means the bytes
   * reached the child process, which is exactly the ambiguity the rule above
   * resolves toward reporting.
   */
  noteSteersRecorded(): void
  /**
   * Take every message currently queued, without blocking and without closing.
   *
   * The generator in {@link stream} is the SDK lane's way in: the SDK pulls,
   * and parks when the queue is dry. A runtime that drives its OWN loop cannot
   * park, because there is no other consumer to wake it. So it pulls here, at
   * a step boundary, and gets whatever is waiting.
   *
   * Each returned steer is stamped handed-off at the current assistant-message
   * count, exactly as the generator stamps one, so
   * {@link takeUndeliveredSteers} applies the SAME evidential rule to both
   * lanes: a steer with no new assistant message after it is reported for
   * resubmission. The self-driven caller marks each step with
   * {@link noteAssistantMessage}.
   *
   * A queued entry with no steer record is the turn's OPENING message, which
   * `begin` puts at the head. A self-driven caller has already built its own
   * opening message from the same text, so that entry is discarded here rather
   * than returned. Returning it would make the loop send the prompt twice.
   */
  drainSteers(): SteeredMessage[]
  /**
   * The generator handed to `query({ prompt })`. Repeated calls return the SAME
   * iterator — two consumers pulling from one queue would split the messages
   * between them, which is not a mode anything wants.
   */
  stream(): AsyncGenerator<SDKUserMessage>
}

/**
 * One accepted steer, plus the bookkeeping that decides whether the model
 * probably saw it.
 *
 * `handedOffAtMessageCount` is the count of DISTINCT main-loop assistant
 * messages seen at the moment the SDK PULLED this message out of the queue, or
 * null while it is still queued. Two choices are load-bearing here.
 *
 * Pull time is the reference point rather than accept time, because those are
 * not the same instant: between `push()` and the SDK's next pull the message is
 * still entirely ours, so anything the model does in that window is no evidence
 * at all about this message. Stamping at accept time would count it as evidence
 * and could classify a never-delivered steer as delivered — a drop.
 *
 * The quantity is a MESSAGE count, not an output-event count. An in-flight
 * message's remaining tokens say nothing, because that message's request was
 * assembled before the steer existed. Only a request started after the hand-off
 * can contain it, and a new assistant message id is the observable form of a
 * new request.
 */
interface TrackedSteer {
  text: string
  images?: ModelImageContent[]
  handedOffAtMessageCount: number | null
}

/** A queued message plus its tracking record; the initial message has none. */
interface QueueEntry {
  message: SDKUserMessage
  steer: TrackedSteer | null
}

/** Options for {@link TurnInputChannel.begin}. */
export interface TurnInputChannelOptions {
  /**
   * Called once per accepted steer with the message the channel took on —
   * synchronously inside `push()` for anything accepted after `begin()`, and
   * replayed in accept order inside `begin()` for anything accepted before it.
   * Either way, exactly once per steer. The turn runtime uses it to record the
   * steer on the persisted `ChatTurn` — a steered message is text the user
   * typed, so it has to survive into their transcript, not only into the
   * model's context.
   *
   * An observer rather than a second list on the channel, because the position
   * a message occupies in the transcript is the runtime's knowledge (it owns
   * `assistantContent`), not the channel's. The channel still has exactly one
   * record of accepted steers; this hands the same event to the one consumer
   * that needs to stamp it.
   *
   * Invoked AFTER the message is queued and the consumer woken, so an observer
   * that throws cannot stop a delivery that was already committed. The throw
   * is not swallowed: it surfaces to the pushing caller (the steer route),
   * which reports a failed steer, and the client resubmits. That is a repeat,
   * never a drop.
   */
  onAccepted?: (steer: SteeredMessage) => void
}

export function createTurnInputChannel(): TurnInputChannel {
  // Starts EMPTY. The opening message arrives in `begin()` — see the module
  // docblock for why those are two steps.
  const queue: QueueEntry[] = []
  const steers: TrackedSteer[] = []
  let begun = false
  let onAccepted: TurnInputChannelOptions['onAccepted']
  // Monotonic marker, never reset. Comparing a stamped value against the
  // current one answers "has a NEW inference request started since?" without
  // keeping any per-message flags in sync.
  let assistantMessageCount = 0
  // Ids already counted. A message arrives many times over — one `stream_event`
  // per streamed token, then the completed `assistant` message — and only its
  // FIRST appearance is a new request. Bounded by the number of assistant
  // messages in one turn, so the set is a few hundred entries at worst.
  const seenAssistantMessageIds = new Set<string>()
  let closed = false
  // Wake latch, not a poll: the consumer parks on this promise when the queue
  // runs dry and `push`/`close` resolve it. A poll would trade a fixed latency
  // floor on every steer for nothing.
  let wake: (() => void) | null = null

  const notify = (): void => {
    const resolve = wake
    wake = null
    resolve?.()
  }

  const iterator = (async function* (): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      // Drain before looking at `closed` — that ordering IS the no-discard
      // guarantee described on `close()`.
      //
      // `begun` gates the drain because a steer can be accepted before the
      // opening message exists (the channel is registered as steerable at
      // lock time). Without the gate, a consumer that started early would
      // yield that steer AS the turn's opening prompt — the agent would be
      // handed a correction to work it had never been asked to do.
      while (begun && queue.length > 0) {
        const entry = queue.shift()!
        // Stamped before the yield: from here on the message is the SDK's, so
        // any inference request started after this point is evidence about
        // THIS message.
        if (entry.steer) entry.steer.handedOffAtMessageCount = assistantMessageCount
        yield entry.message
      }
      if (closed) return
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  })()

  return {
    begin(
      first: { text: string; images?: ModelImageContent[] },
      options: TurnInputChannelOptions = {},
    ): void {
      if (begun) {
        throw new Error('TurnInputChannel.begin() called twice; one channel serves one turn.')
      }
      if (closed) {
        throw new Error(
          'TurnInputChannel.begin() on a closed channel; the opening message would never be read.',
        )
      }
      begun = true
      onAccepted = options.onAccepted
      // HEAD, not tail — see `begin`'s contract. Anything already queued was
      // typed while the turn was still starting up and belongs after the prompt.
      queue.unshift({ message: buildUserMessage(first.text, first.images), steer: null })
      // Replay in accept order. A steer accepted before the runtime attached its
      // observer is still text the user typed, and the transcript rule is the
      // same as for delivery: it must survive. Not wrapped in a try — an
      // observer that throws here fails the turn loudly, and the handler's
      // close-and-reconcile then reports these messages for resubmission.
      // Repeat over drop.
      for (const s of steers) {
        onAccepted?.({ text: s.text, ...(s.images ? { images: s.images } : {}) })
      }
      notify()
    },
    push(text: string, images?: ModelImageContent[]): void {
      if (closed) {
        throw new Error(
          'TurnInputChannel is closed; the turn it belonged to has ended. Check `closed` before pushing and fall back to a new turn.',
        )
      }
      const steer: TrackedSteer = {
        text,
        ...(images ? { images } : {}),
        handedOffAtMessageCount: null,
      }
      steers.push(steer)
      queue.push({ message: buildUserMessage(text, images), steer })
      notify()
      // Last, and outside the delivery path — see `onAccepted`'s contract.
      // Undefined before `begin()`; those pushes are replayed to the observer
      // there instead, so no accepted steer goes unobserved either way.
      onAccepted?.({ text, ...(images ? { images } : {}) })
    },
    close(): void {
      if (closed) return
      closed = true
      notify()
    },
    get closed(): boolean {
      return closed
    },
    noteAssistantMessage(messageId: string): void {
      if (seenAssistantMessageIds.has(messageId)) return
      seenAssistantMessageIds.add(messageId)
      assistantMessageCount += 1
    },
    takeUndeliveredSteers(): SteeredMessage[] {
      // Ambiguity resolves to "report it". `handedOffAtMessageCount === null`
      // means nothing ever pulled it (definitive); equality with the current
      // count means no new inference request began after the hand-off, so
      // nothing that could have carried the message was ever built.
      const undelivered = steers.filter(
        (s) =>
          s.handedOffAtMessageCount === null ||
          s.handedOffAtMessageCount === assistantMessageCount,
      )
      // Drain ALL of them, not just the ones being returned: the runtime calls
      // this on `result` and again in its finally, and a steer reported twice
      // would have the client resubmit it twice.
      steers.length = 0
      return undelivered.map((s) => ({
        text: s.text,
        ...(s.images ? { images: s.images } : {}),
      }))
    },
    noteSteersRecorded(): void {
      for (let i = steers.length - 1; i >= 0; i--) {
        if (steers[i]!.handedOffAtMessageCount !== null) steers.splice(i, 1)
      }
    },
    drainSteers(): SteeredMessage[] {
      const out: SteeredMessage[] = []
      while (queue.length > 0) {
        const entry = queue.shift()!
        if (!entry.steer) continue
        entry.steer.handedOffAtMessageCount = assistantMessageCount
        out.push({
          text: entry.steer.text,
          ...(entry.steer.images ? { images: entry.steer.images } : {}),
        })
      }
      return out
    },
    stream(): AsyncGenerator<SDKUserMessage> {
      return iterator
    },
  }
}

/**
 * Close a turn's input channel and tell the client about every steer we
 * cannot show reached the model, so it can send those messages again.
 *
 * Both chat runtimes (the SDK lane and the neutral lane) need this exact
 * behaviour at the exact same two call sites — once in a `finally` after the
 * turn's own loop, and once from an abort listener registered up front — so
 * it lives here, next to the channel it closes, instead of being copied into
 * each runtime.
 *
 * Close-then-drain, never the reverse: a steer accepted between the drain and
 * the close would be closed away with nobody told, which is the exact loss
 * this reconciliation exists to prevent. (Nothing is awaited between the two,
 * so in practice the pair is atomic — the ordering is written down because
 * getting it backwards is silently wrong.)
 *
 * Safe to call more than once. `close()` is idempotent and
 * `takeUndeliveredSteers()` drains its tracking list, so a second call
 * reports nothing rather than asking for a duplicate resubmit.
 *
 * Best-effort on the wire: if the client has already disconnected, `emit`
 * writes into a closed SSE stream and drops. Nothing can be delivered to a
 * client that is gone; the client's own steer-failure fallback covers the
 * disconnect case.
 *
 * Also wires the abort path: if `signal` is given, this same close-and-report
 * runs when the signal fires (immediately, if it is already aborted). Abort
 * runs the FULL close-and-report, not a bare close, and it runs from the
 * listener rather than leaning on the caller's own `finally`. Two reasons,
 * and the second is why this is not merely belt-and-braces:
 *
 *  1. If a runtime's abort path ever waits for its own input stream to end
 *     before finishing, the code that would reach the `finally` never runs.
 *     Closing from the listener is what breaks that deadlock — and a close
 *     that did not also report would leave the steers inside a channel
 *     nobody will drain.
 *  2. Stop is the MOST likely way a steer dies unconsumed: the user typed a
 *     correction and then decided the agent was going the wrong way anyway.
 *     Reporting only on the paths that unwind cleanly would leave the single
 *     most common loss as the one path that stays silent.
 *
 * Returns the close-and-report function itself, so the caller can also invoke
 * it directly from its own `finally` (the two triggers race safely — see
 * "safe to call more than once" above).
 */
export function attachSteerReconciliation(params: {
  channel: TurnInputChannel
  sessionId: string
  emit: (event: ChatStreamEvent) => void
  signal?: AbortSignal
}): () => void {
  const { channel, sessionId, emit, signal } = params

  const closeChannelAndReportUndelivered = (): void => {
    channel.close()
    for (const steer of channel.takeUndeliveredSteers()) {
      emit({
        kind: 'resubmit_required',
        sessionId,
        userMessage: steer.text,
        ...(steer.images ? { images: steer.images } : {}),
      })
    }
  }

  if (signal) {
    if (signal.aborted) closeChannelAndReportUndelivered()
    else {
      signal.addEventListener('abort', () => closeChannelAndReportUndelivered(), {
        once: true,
      })
    }
  }

  return closeChannelAndReportUndelivered
}

/**
 * The id of the assistant message an SDK message belongs to, when that message
 * can mark a NEW inference request — otherwise null.
 *
 * Lives here rather than in the turn runtime because it IS the evidence rule
 * that {@link TurnInputChannel.takeUndeliveredSteers} depends on, and splitting
 * the rule from the accounting it feeds is how the previous version went wrong.
 *
 * Two SDK shapes are read, and reading both is deliberate:
 *
 *  - `stream_event` with `event.type === 'message_start'` — the earliest
 *    signal, and the only one that arrives before a long message finishes.
 *    Present only because the turn runtime sets `includePartialMessages: true`.
 *  - a completed `assistant` message — the backstop for any message the SDK
 *    surfaces without partials (an error message, a replayed one, a future
 *    non-streaming path). Without it such a turn would look request-free and
 *    every steer on it would be resubmitted.
 *
 * Reading both costs nothing because the caller de-duplicates by id: the
 * `message_start` and the completed `assistant` for one message share an id and
 * count once. Every OTHER `stream_event` (`content_block_delta` and friends) is
 * a partial of a message already counted and returns null here — that is the
 * defect this function exists to close.
 *
 * Subagent output is excluded by `parent_tool_use_id !== null` (the SDK's
 * `forwardSubagentText` option describes exactly this tagging). A subagent's
 * request is assembled from the SUBAGENT's context, which never contains a
 * steer sent to the main loop, so counting it would call a steer delivered on
 * evidence about a different conversation. Excluding it can only cause a
 * resubmit, which is the direction to be wrong in.
 */
export function readAssistantMessageBoundaryId(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    return msg.parent_tool_use_id === null ? msg.message.id : null
  }
  if (msg.type === 'stream_event' && msg.event.type === 'message_start') {
    return msg.parent_tool_use_id === null ? msg.event.message.id : null
  }
  return null
}

/**
 * Reshape a validated media-content image into the Anthropic
 * `ImageBlockParam` a user message carries. `media-content.ts` already
 * produced the MCP image-block shape (`{type:'image', data, mimeType}`)
 * with the base64 payload stripped of its `data:` prefix; here we map it
 * to the base64-source form the Messages API expects on a USER message.
 * Same bytes, different envelope — there is no second image path.
 */
function toImageBlockParam(
  image: ModelImageContent,
): Extract<MessageParam['content'], unknown[]>[number] {
  return {
    type: 'image',
    source: {
      type: 'base64',
      // media-content only ever emits SUPPORTED_IMAGE_MIME_TYPES, which is
      // exactly the set Base64ImageSource['media_type'] accepts.
      media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: image.data,
    },
  }
}

/**
 * Build one `SDKUserMessage`: the text followed by one vision block per image.
 *
 * The empty-text omission is load-bearing, not tidiness — the Messages API
 * rejects `{type:'text', text:''}`, and an image-only message (the user
 * attached a screenshot with no prompt) is a real turn we have to be able to
 * send.
 */
function buildUserMessage(
  text: string,
  images: ModelImageContent[] | undefined,
): SDKUserMessage {
  const content: Extract<MessageParam['content'], unknown[]> = [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...(images ?? []).map(toImageBlockParam),
  ]
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
}

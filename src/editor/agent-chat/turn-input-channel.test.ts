/**
 * Unit coverage for the turn input channel.
 *
 * The multiple-pushes test is the one that matters most: it is measured
 * finding 4 from `tasks/scripts/sdk-steering-probe.mts` in unit form. Against
 * the live SDK, a second `streamInput()` call in the same turn is discarded
 * with no error, so "two corrections in a row" — ordinary user behaviour —
 * silently loses the second one. Pushing into one long-lived generator is what
 * fixes that, and this file pins the generator's half of the contract.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import {
  createTurnInputChannel,
  readAssistantMessageBoundaryId,
} from './turn-input-channel'

/**
 * Narrow an SDK-message-shaped literal to `SDKMessage`.
 *
 * A real `BetaMessage` carries a dozen fields (usage, model, container, …) that
 * `readAssistantMessageBoundaryId` never reads, and spelling them out would
 * make each case unreadable without testing anything more. The cast is scoped
 * to this helper so no test body carries one.
 */
function asSdkMessage(shape: Record<string, unknown>): SDKMessage {
  return shape as unknown as SDKMessage
}

/** Shorthand for the content array of a yielded user message. */
function contentOf(msg: { message: { content: unknown } }): unknown {
  return msg.message.content
}

/**
 * The ordinary lifecycle in one line: create, then seed the opening message.
 * The two are separate in production because the channel is registered as
 * steerable before the opening message can be built (see the module docblock);
 * tests that are not about that ordering should not have to spell it out.
 */
function openChannel(text: string): ReturnType<typeof createTurnInputChannel> {
  const channel = createTurnInputChannel()
  channel.begin({ text })
  return channel
}

describe('createTurnInputChannel', () => {
  it('yields the first message with text only', async () => {
    const channel = openChannel('hello there')
    const it = channel.stream()

    const first = await it.next()

    expect(first.done).toBe(false)
    expect(first.value.type).toBe('user')
    expect(first.value.parent_tool_use_id).toBeNull()
    expect(first.value.message.role).toBe('user')
    expect(contentOf(first.value)).toEqual([{ type: 'text', text: 'hello there' }])
  })

  it('yields the first message with images, and omits the empty text block', async () => {
    // Image-only turn: the user attached a screenshot with no prompt. The
    // Messages API rejects `{type:'text', text:''}`, so no text block at all.
    const channel = createTurnInputChannel()
    channel.begin({
      text: '',
      images: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
      ],
    })

    const first = await channel.stream().next()

    expect(contentOf(first.value)).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ])
  })

  it('keeps the text block ahead of the images when both are present', async () => {
    const channel = createTurnInputChannel()
    channel.begin({
      text: 'match this',
      images: [{ type: 'image', data: 'CCCC', mimeType: 'image/webp' }],
    })

    const first = await channel.stream().next()

    expect(contentOf(first.value)).toEqual([
      { type: 'text', text: 'match this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } },
    ])
  })

  it('yields a push that lands while the consumer is parked', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    // Consumer is awaiting the wake latch before the push arrives — the case
    // that actually happens mid-turn.
    const pending = it.next()
    channel.push('steered')

    const second = await pending
    expect(second.done).toBe(false)
    expect(contentOf(second.value)).toEqual([{ type: 'text', text: 'steered' }])
  })

  it('yields a push that landed before the consumer asked for it', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('steered')
    const second = await it.next()

    expect(contentOf(second.value)).toEqual([{ type: 'text', text: 'steered' }])
  })

  it('yields MULTIPLE pushes, all of them, in order', async () => {
    // Measured finding 4 in unit form. Against the live SDK a second
    // `streamInput()` call vanishes; one generator has to deliver every push.
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('alpha')
    channel.push('bravo')
    channel.push('charlie')

    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'alpha' }])
    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'bravo' }])
    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'charlie' }])
  })

  it('yields multiple pushes interleaved with consumption, in order', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('alpha')
    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'alpha' }])

    const parked = it.next()
    channel.push('bravo')
    expect(contentOf((await parked).value)).toEqual([{ type: 'text', text: 'bravo' }])
  })

  it('carries images on a pushed message too', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('look at this', [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }])

    expect(contentOf((await it.next()).value)).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'DDDD' } },
    ])
  })

  it('close() after a push still yields that push before returning', async () => {
    // The no-discard guarantee. A close that dropped the queue would be the
    // same silent loss as the SDK's, just authored by us.
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('landed just before close')
    channel.close()

    const drained = await it.next()
    expect(drained.done).toBe(false)
    expect(contentOf(drained.value)).toEqual([
      { type: 'text', text: 'landed just before close' },
    ])
    expect((await it.next()).done).toBe(true)
  })

  it('close() drains a multi-message queue before returning', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.push('alpha')
    channel.push('bravo')
    channel.close()

    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'alpha' }])
    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'bravo' }])
    expect((await it.next()).done).toBe(true)
  })

  it('close() with nothing pending returns immediately', async () => {
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.close()

    expect((await it.next()).done).toBe(true)
  })

  it('close() wakes a consumer that is already parked', async () => {
    // Proves the wake latch, not a poll: the consumer is suspended on the
    // promise when close() fires and still completes.
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    const parked = it.next()
    channel.close()

    expect((await parked).done).toBe(true)
  })

  it('still yields the first message when closed before consumption starts', async () => {
    // A turn that aborts before the SDK reads stdin: the initial message is
    // queued, so the no-discard rule covers it like any other pending message.
    const channel = openChannel('first')
    channel.close()

    const it = channel.stream()
    expect(contentOf((await it.next()).value)).toEqual([{ type: 'text', text: 'first' }])
    expect((await it.next()).done).toBe(true)
  })

  it('reports closed', async () => {
    const channel = openChannel('first')
    expect(channel.closed).toBe(false)

    const it = channel.stream()
    await it.next()
    expect(channel.closed).toBe(false)

    channel.close()
    expect(channel.closed).toBe(true)
  })

  it('close() is idempotent', async () => {
    // The turn runtime closes on `result`, on abort, and again in its finally.
    const channel = openChannel('first')
    const it = channel.stream()
    await it.next()

    channel.close()
    channel.close()
    channel.close()

    expect(channel.closed).toBe(true)
    expect((await it.next()).done).toBe(true)
  })

  it('throws on push after close instead of swallowing the message', async () => {
    const channel = openChannel('first')
    channel.close()

    expect(() => channel.push('too late')).toThrow(/closed/)
  })

  describe('two-phase lifecycle — steerable before the turn has an opening message', () => {
    // This is the registration window in unit form. The CLI registers the
    // channel the instant it takes the per-session turn lock, and the turn
    // runtime only reaches `begin()` many awaits later. Everything in between
    // has to work, or the window is merely smaller rather than gone.

    it('accepts a push before begin() and yields it AFTER the opening message', async () => {
      // Order is the whole point. Appending would hand the agent a correction
      // to work it has not been given yet.
      const channel = createTurnInputChannel()
      channel.push('typed while the turn was still starting up')
      channel.begin({ text: 'the original prompt' })

      const it = channel.stream()
      expect(contentOf((await it.next()).value)).toEqual([
        { type: 'text', text: 'the original prompt' },
      ])
      expect(contentOf((await it.next()).value)).toEqual([
        { type: 'text', text: 'typed while the turn was still starting up' },
      ])
    })

    it('yields NOTHING before begin(), even with messages queued', async () => {
      // A consumer that started early must not be handed a steer as the turn's
      // opening prompt. Nothing consumes before `query()` in production, so
      // this is a guard against a future caller rather than a live bug.
      const channel = createTurnInputChannel()
      channel.push('a steer')

      const it = channel.stream()
      const parked = it.next()
      let settled = false
      void parked.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)

      channel.begin({ text: 'the original prompt' })
      expect(contentOf((await parked).value)).toEqual([
        { type: 'text', text: 'the original prompt' },
      ])
    })

    it('replays pre-begin steers to onAccepted, in order, exactly once', async () => {
      // A message typed during the turn's setup is text the user typed, so it
      // has to reach the transcript like any other steer. The observer belongs
      // to the runtime and does not exist yet when the push lands.
      const channel = createTurnInputChannel()
      channel.push('alpha')
      channel.push('bravo')

      const accepted: string[] = []
      channel.begin({ text: 'first' }, { onAccepted: (s) => accepted.push(s.text) })
      channel.push('charlie')

      expect(accepted).toEqual(['alpha', 'bravo', 'charlie'])
    })

    it('replays the images along with the text', async () => {
      const channel = createTurnInputChannel()
      channel.push('match this', [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }])

      const accepted: Array<{ text: string; images?: unknown }> = []
      channel.begin({ text: 'first' }, { onAccepted: (s) => accepted.push(s) })

      expect(accepted).toEqual([
        {
          text: 'match this',
          images: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }],
        },
      ])
    })

    it('reports a pre-begin steer for resubmission when the turn never starts', async () => {
      // The cost-ceiling refusal, a cancelled session, a concurrency-cap
      // failure: the lock was taken, the user typed, and the turn never ran.
      // Nothing pulled the message, so it is definitively undelivered.
      const channel = createTurnInputChannel()
      channel.push('typed while the turn was starting')
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([
        { text: 'typed while the turn was starting' },
      ])
    })

    it('throws on begin() twice — one channel serves one turn', () => {
      const channel = createTurnInputChannel()
      channel.begin({ text: 'first' })

      expect(() => channel.begin({ text: 'again' })).toThrow(/twice/)
    })

    it('throws on begin() after close instead of queueing the opening message nowhere', () => {
      // Silently accepting would drop the most important message of the turn.
      const channel = createTurnInputChannel()
      channel.close()

      expect(() => channel.begin({ text: 'first' })).toThrow(/closed/)
    })
  })

  describe('undelivered-steer reconciliation', () => {
    it('reports nothing when no steer was ever accepted', async () => {
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()
      channel.noteAssistantMessage('msg_a')
      channel.close()

      // The INITIAL message is not a steer. It rides the same queue, but the
      // client already has it in the thread — reporting it would ask the user
      // to send their own prompt a second time.
      expect(channel.takeUndeliveredSteers()).toEqual([])
    })

    it('treats a steer followed by a NEW assistant message as delivered', async () => {
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()
      channel.noteAssistantMessage('msg_in_flight')

      channel.push('also fix the header')
      await it.next() // the SDK pulls it — this is the hand-off
      // A different message id: a new inference request, which is the only
      // thing that can have folded the steer into the model's context.
      channel.noteAssistantMessage('msg_after_the_steer')
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([])
    })

    it('reports a steer the SDK pulled but that started no new assistant message', async () => {
      // The uncovered interleaving: the message reached the child's stdin, the
      // model decided it was done, and `result` arrived with nothing since.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()
      channel.noteAssistantMessage('msg_a')

      channel.push('also fix the header')
      await it.next()
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([{ text: 'also fix the header' }])
    })

    it('reports a steer the SDK never pulled', async () => {
      // Definitive, not evidential: those bytes never left this process. Model
      // activity after the push is irrelevant, which is why the hand-off — not
      // the accept — is the reference point.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      channel.push('never read')
      channel.noteAssistantMessage('msg_a')
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([{ text: 'never read' }])
    })

    it('carries the images so the client can resubmit verbatim', async () => {
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      channel.push('match this', [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }])
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([
        {
          text: 'match this',
          images: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }],
        },
      ])
    })

    it('classifies several steers independently', async () => {
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      channel.push('alpha')
      await it.next()
      channel.noteAssistantMessage('msg_answering_alpha') // alpha is answered

      channel.push('bravo')
      await it.next() // pulled, but no new request follows

      channel.push('charlie') // never pulled at all
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([
        { text: 'bravo' },
        { text: 'charlie' },
      ])
    })

    it('drains, so a second call cannot ask for the same resubmit twice', async () => {
      // The turn runtime reconciles on `result` AND again in its finally.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      channel.push('alpha')
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([{ text: 'alpha' }])
      expect(channel.takeUndeliveredSteers()).toEqual([])
    })

    it('drains delivered steers too, so a later call cannot resurrect them', async () => {
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      channel.push('alpha')
      await it.next()
      channel.noteAssistantMessage('msg_answering_alpha')

      expect(channel.takeUndeliveredSteers()).toEqual([])
      // No further message begins before the turn's finally re-reconciles. If
      // `alpha` were still tracked, `handedOffAtMessageCount ===
      // assistantMessageCount` would now hold and it would be reported after
      // all — as delivered-then-not.
      channel.close()
      expect(channel.takeUndeliveredSteers()).toEqual([])
    })
  })

  describe('message boundaries, not output events — the two reviewer repros', () => {
    // Both of these went red before the fix and are the permanent guard for a
    // mistake that has now been made twice: counting evidence that cannot bear
    // on the steer. `includePartialMessages: true` (set by the turn runtime)
    // turns every streamed token into its own `stream_event`, so an
    // output-event counter was bumped by the tail of a message whose request
    // was assembled BEFORE the steer existed.

    it('reports a steer when only MORE PARTIALS of the same in-flight message follow', async () => {
      // Reviewer repro 1. The model is mid-answer when the user steers. Every
      // token that follows belongs to that same message, so nothing that could
      // have carried the steer was ever requested.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()

      // The message that is already streaming when the steer arrives.
      channel.noteAssistantMessage('msg_in_flight')

      channel.push('actually, use the other endpoint')
      await it.next() // hand-off

      // Its remaining tokens: same message id, arriving as separate SDK
      // `stream_event`s. The old counter treated each of these as proof the
      // model had read the steer.
      channel.noteAssistantMessage('msg_in_flight')
      channel.noteAssistantMessage('msg_in_flight')
      channel.noteAssistantMessage('msg_in_flight')
      channel.close() // then `result`

      expect(channel.takeUndeliveredSteers()).toEqual([
        { text: 'actually, use the other endpoint' },
      ])
    })

    it('reports a steer sent mid-tool-call when the model then answers the ORIGINAL task', async () => {
      // Reviewer repro 2, measured: turn is mid-Bash tool call, the user
      // steers, the tool returns, and the model finishes its answer to the
      // ORIGINAL task inside the SAME assistant message before `result`. The
      // old check (`handedOffAt === modelOutputCount`) was false because that
      // final answer bumped the count, so the steer was reported delivered and
      // silently dropped.
      const channel = openChannel('run the build and summarise the failures')
      const it = channel.stream()
      await it.next()

      // The assistant message carrying the tool_use is in flight.
      channel.noteAssistantMessage('msg_with_the_tool_call')
      channel.noteAssistantMessage('msg_with_the_tool_call') // its partials

      channel.push('stop, check the lockfile instead')
      await it.next() // hand-off, mid-tool-call

      // Tool result comes back and the SAME message finishes the original
      // task. Same id ⇒ same request ⇒ no evidence at all.
      channel.noteAssistantMessage('msg_with_the_tool_call')
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([
        { text: 'stop, check the lockfile instead' },
      ])
    })

    it('does NOT count a tool_use that belongs to the message already streaming', async () => {
      // A tool_use block is not special. What decides is the message it sits
      // in, and msg_a's request predates the steer.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()
      channel.noteAssistantMessage('msg_a')

      channel.push('during msg_a')
      await it.next()
      channel.noteAssistantMessage('msg_a') // msg_a's own tool_use block
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([{ text: 'during msg_a' }])
    })

    it('DOES count a tool_use that arrives in a new message', async () => {
      // The other half of the pair. A new message is a new request, whatever
      // block kind it happens to carry.
      const channel = openChannel('first')
      const it = channel.stream()
      await it.next()
      channel.noteAssistantMessage('msg_a')

      channel.push('during msg_a')
      await it.next()
      channel.noteAssistantMessage('msg_b') // a new request, carrying a tool_use
      channel.close()

      expect(channel.takeUndeliveredSteers()).toEqual([])
    })
  })

  describe('readAssistantMessageBoundaryId', () => {
    it('reads the id off a message_start stream event', () => {
      expect(
        readAssistantMessageBoundaryId(
          asSdkMessage({
            type: 'stream_event',
            parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'msg_01' } },
          }),
        ),
      ).toBe('msg_01')
    })

    it('reads the id off a completed assistant message', () => {
      // The backstop for a message the SDK surfaces without partials. Same id
      // as its own `message_start`, so the channel counts the pair once.
      expect(
        readAssistantMessageBoundaryId(
          asSdkMessage({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { id: 'msg_01' },
          }),
        ),
      ).toBe('msg_01')
    })

    it('returns null for every other stream event — this IS the defect', () => {
      // A token delta is a partial of a message already counted. Treating it
      // as a boundary is exactly what made the evidential half inert.
      for (const type of [
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]) {
        expect(
          readAssistantMessageBoundaryId(
            asSdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type } }),
          ),
        ).toBeNull()
      }
    })

    it('returns null for subagent output, on both shapes', () => {
      // A subagent's request is built from the SUBAGENT's context, which never
      // holds a steer sent to the main loop. Excluding it can only cause a
      // resubmit — the direction to be wrong in.
      expect(
        readAssistantMessageBoundaryId(
          asSdkMessage({
            type: 'assistant',
            parent_tool_use_id: 'toolu_task_01',
            message: { id: 'msg_sub' },
          }),
        ),
      ).toBeNull()
      expect(
        readAssistantMessageBoundaryId(
          asSdkMessage({
            type: 'stream_event',
            parent_tool_use_id: 'toolu_task_01',
            event: { type: 'message_start', message: { id: 'msg_sub' } },
          }),
        ),
      ).toBeNull()
    })

    it('returns null for non-assistant messages', () => {
      for (const type of ['user', 'result', 'system']) {
        expect(
          readAssistantMessageBoundaryId(asSdkMessage({ type, parent_tool_use_id: null })),
        ).toBeNull()
      }
    })
  })

  it('hands back the same iterator on every stream() call', async () => {
    // Two consumers over one queue would split messages between them.
    const channel = openChannel('first')
    expect(channel.stream()).toBe(channel.stream())

    const first = await channel.stream().next()
    expect(contentOf(first.value)).toEqual([{ type: 'text', text: 'first' }])
    // The second stream() call hands back the SAME iterator, so it resumes
    // where the first left off rather than replaying the initial message.
    channel.close()
    expect((await channel.stream().next()).done).toBe(true)
  })
})

describe('drainSteers: the non-blocking pull a self-driven loop needs', () => {
  it('returns nothing when nothing was pushed', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    expect(channel.drainSteers()).toEqual([])
  })

  it('returns queued steers in push order and empties the queue', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    channel.push('one')
    channel.push('two')
    expect(channel.drainSteers()).toEqual([{ text: 'one' }, { text: 'two' }])
    expect(channel.drainSteers()).toEqual([])
  })

  it('carries images verbatim', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    const images = [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }]
    channel.push('look', images)
    expect(channel.drainSteers()).toEqual([{ text: 'look', images }])
  })

  it('discards the opening message, which the self-driven caller built itself', () => {
    const channel = createTurnInputChannel()
    channel.push('typed during setup')
    channel.begin({ text: 'the opening prompt' })
    // `begin` puts the opening message at the HEAD, ahead of the early steer.
    expect(channel.drainSteers()).toEqual([{ text: 'typed during setup' }])
  })

  it('leaves the channel open, unlike takeUndeliveredSteers', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    channel.drainSteers()
    expect(channel.closed).toBe(false)
    expect(() => channel.push('still works')).not.toThrow()
  })

  it('marks drained steers handed off, so a step that follows counts as delivery', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    channel.push('one')
    channel.drainSteers()
    channel.noteAssistantMessage('m1')
    channel.close()
    expect(channel.takeUndeliveredSteers()).toEqual([])
  })

  it('reports a drained steer that no step followed, because nothing read it', () => {
    const channel = createTurnInputChannel()
    channel.begin({ text: 'first' })
    channel.push('one')
    channel.drainSteers()
    channel.close()
    expect(channel.takeUndeliveredSteers()).toEqual([{ text: 'one' }])
  })
})

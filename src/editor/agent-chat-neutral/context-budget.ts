/**
 * Keep the replayed history inside a size the model will accept.
 *
 * The SDK compacts by summarizing. This truncates, and it says so out loud:
 * on a very long session this lane loses earlier detail more bluntly than the
 * other one. That is a named cost, not a defect discovered later.
 *
 * The order is chosen so the bluntness lands where it hurts least. Tool
 * OUTPUT is elided first: it is the bulk of a long session by a wide margin
 * and the least re-referenced, because the model has usually already acted on
 * it. Only when every tool output is a stub does it start dropping whole
 * leading messages. Assistant text is never elided in place, and the final
 * message is never dropped: it is the turn the user just sent.
 *
 * The budget is counted in characters rather than tokens because there is no
 * tokenizer on this seam and one would be per-vendor. Characters over-count
 * for code and under-count for prose; the constant is set low enough that
 * either way the request fits.
 */

import type { ImageContent, Message, TextContent } from '../llm-providers/types'

/** Roughly 150k tokens of headroom at four characters per token. */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 600_000

export const ELIDED_TOOL_OUTPUT = '[older tool output elided]'

export interface ContextBudgetResult {
  messages: Message[]
  trimmed: boolean
  /**
   * A line to show the model when history was cut, so it does not treat the
   * gap as evidence that something never happened. Absent when nothing moved.
   */
  notice?: string
}

export function applyContextBudget(
  messages: readonly Message[],
  opts: { maxChars?: number } = {},
): ContextBudgetResult {
  const max = opts.maxChars ?? DEFAULT_CONTEXT_BUDGET_CHARS
  let working = messages.map(cloneMessage)
  if (sizeOf(working) <= max) return { messages: working, trimmed: false }

  let elided = 0
  for (const message of working) {
    if (sizeOf(working) <= max) break
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      if (block.content === ELIDED_TOOL_OUTPUT) continue
      ;(block as { content: string }).content = ELIDED_TOOL_OUTPUT
      elided++
    }
  }

  let dropped = 0
  while (sizeOf(working) > max && working.length > 1) {
    working = working.slice(1)
    dropped++
  }

  // The drop loop above slices one whole message at a time with no regard
  // for `tool_use` / `tool_result` pairing. Roughly half of its stopping
  // points leave a leading user message whose `tool_result` block still
  // references a `tool_use` that was in the assistant message just dropped.
  // `history-replay.ts`'s header states the invariant: every `tool_use`
  // needs its matching `tool_result` in the next user message, or the
  // request is a 400 from both vendors (final review I6). Strip any
  // orphaned `tool_result` here, dropping a message that empties out.
  //
  // Only when the drop loop actually removed a message: `history-replay.ts`
  // guarantees the invariant holds on input, so the only way it can break
  // here is a message THIS loop just sliced off. Running this pass
  // unconditionally would also "fix" an elision-only history whose fixture
  // never had a matching `tool_use` in the first place, changing a case
  // that was never broken.
  //
  // The set of "available" ids is built POSITIONALLY, walking `working` in
  // the order the messages actually appear, and each id is consumed the
  // moment a `tool_result` claims it. That is deliberate: a vendor id can in
  // principle be reused by a LATER assistant message, and a `tool_result`
  // must only survive by pairing with the `tool_use` immediately before it,
  // not with a same-valued id that happens to show up further down the
  // transcript. A global "was this id ever produced" set (the earlier
  // shape) cannot tell those apart, and would let a `tool_result` whose own
  // `tool_use` was dropped survive on a stranger's id.
  if (dropped > 0) {
    const availableToolUseIds = new Set<string>()
    const withoutOrphans: Message[] = []
    for (const message of working) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool_use') availableToolUseIds.add(block.id)
        }
        withoutOrphans.push(message)
        continue
      }
      if (typeof message.content === 'string') {
        withoutOrphans.push(message)
        continue
      }
      const content = message.content.filter((block) => {
        if (block.type !== 'tool_result') return true
        return availableToolUseIds.delete(block.toolUseId)
      })
      if (content.length === 0) {
        dropped++
        continue
      }
      withoutOrphans.push(
        content.length === message.content.length ? message : { ...message, content },
      )
    }
    working = withoutOrphans
  }

  // Anthropic's Messages API rejects a request whose FIRST message is an
  // assistant message: `messages: first message must use the "user" role`.
  // Nothing above enforces that — the drop loop slices on size alone, and the
  // orphan pass can empty a leading user message and remove it, exposing the
  // assistant message behind it. Anthropic reaches this lane whenever
  // `chatRuntimeOverride(env) === 'neutral'`, which is how the lane is
  // exercised today, and the failure would be PERMANENT for that session:
  // every later turn replays the same over-budget history. OpenAI accepts the
  // shape, so this rule is one vendor's and is applied to both.
  //
  // A loop rather than a single slice: dropping a leading assistant message
  // strands the `tool_result` blocks in the user message behind it, since
  // nothing precedes them any more. Those are stripped, and stripping can
  // empty that message in turn.
  while (working.length > 1) {
    const head = working[0]
    if (head.role !== 'user') {
      working = working.slice(1)
      dropped++
      continue
    }
    if (typeof head.content === 'string') break
    const content = head.content.filter((block) => block.type !== 'tool_result')
    if (content.length === head.content.length) break
    if (content.length === 0) {
      working = working.slice(1)
      dropped++
      continue
    }
    working = [{ ...head, content } as Message, ...working.slice(1)]
    break
  }

  const parts: string[] = []
  if (elided > 0) parts.push(`${elided} older tool result${elided === 1 ? '' : 's'} replaced with a placeholder`)
  if (dropped > 0) parts.push(`${dropped} older message${dropped === 1 ? '' : 's'} dropped`)
  return {
    messages: working,
    trimmed: true,
    notice:
      parts.length > 0
        ? `Note: the earlier part of this conversation was shortened to fit (${parts.join(', ')}). Ask the user rather than assuming something did not happen.`
        : undefined,
  }
}

/**
 * Ceiling on the base64 image bytes a single request may carry, counted
 * across every tool result in it.
 *
 * FX16 item 3 (2026-09-05). Nothing re-ran the budget inside the step loop, so
 * accumulated tool-result images were unbounded. The adversarial verifier's
 * numbers: `DEFAULT_MAX_IMAGE_BYTES` caps ONE image at 4.5 MB decoded (about
 * 6.0 MB of base64 on the wire) and `MAX_NEUTRAL_STEPS` caps a turn at 40
 * steps, so the ceiling was 180 MB decoded resident in one request, and
 * because every step re-sends the whole array, about 4.9 GB uploaded across a
 * turn — each re-send re-billed as image input. At a realistic 0.5 MB
 * screenshot it was still ~20 MB per request and ~410 MB per turn.
 *
 * This is the direct consequence of the change that lets a tool result's
 * image reach the model, and that change stays: `capture_screenshot` is the
 * agent's only sight of the running prototype, and before it the model was
 * handed the sentence "[image/png image returned]" and asked to judge what it
 * showed. So the cap keeps the NEWEST image unconditionally, whatever its
 * size, and elides backwards from there. A turn that captures once still sees
 * its screenshot; a turn that captures thirty times sees the recent ones.
 *
 * 4 MB of base64 is roughly six 0.5 MB screenshots, which comfortably covers
 * the several parallel captures a single step can make plus the before/after
 * pair a turn compares.
 */
export const MAX_TURN_IMAGE_BYTES = 4_000_000

export const ELIDED_TOOL_IMAGE = '[older screenshot elided to keep the request within its size budget]'

/**
 * Elide older tool-result images, newest first, until the rest fit.
 *
 * Mutates `messages` in place, exactly as the tool-output elision above does,
 * because the loop re-sends the SAME array every step: replacing a part once
 * removes it from every later request too.
 *
 * Only `tool_result` images are touched. An `image` block on a user message is
 * something the USER attached to their question, so eliding it would answer a
 * question about a picture nobody can see any more.
 */
export function capToolResultImageBytes(
  messages: readonly Message[],
  opts: { maxBytes?: number } = {},
): { elided: number } {
  const max = opts.maxBytes ?? MAX_TURN_IMAGE_BYTES
  let used = 0
  let kept = 0
  let elided = 0
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b]
      if (block.type !== 'tool_result' || typeof block.content === 'string') continue
      const parts = block.content
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i]
        if (part.type !== 'image') continue
        const bytes = part.data.length
        // The newest image is kept whatever it costs. A cap that could drop
        // the only picture in the turn would put the model back to guessing.
        if (kept === 0 || used + bytes <= max) {
          used += bytes
          kept++
          continue
        }
        ;(parts as (TextContent | ImageContent)[])[i] = {
          type: 'text',
          text: ELIDED_TOOL_IMAGE,
        }
        elided++
      }
    }
  }
  return { elided }
}

function cloneMessage(message: Message): Message {
  return typeof message.content === 'string'
    ? { ...message }
    : ({ ...message, content: message.content.map((b) => ({ ...b })) } as Message)
}

function sizeOf(messages: readonly Message[]): number {
  let total = 0
  for (const m of messages) {
    total +=
      typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length
  }
  return total
}

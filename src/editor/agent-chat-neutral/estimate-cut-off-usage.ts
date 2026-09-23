/**
 * A usage figure for a step that was cut off before its transport reported
 * one.
 *
 * The AI SDK transport learns a step's usage only from the vendor's `finish`
 * part. A steer or Stop aborts the stream before that part arrives, so the
 * provider reports 0/0 for a request the vendor still billed. (The direct
 * Anthropic provider does not have this gap: it reads `message_start.usage`,
 * which arrives first.) Recording nothing would let the cost display, the
 * turn's `costUsd` and the cost ceiling all read $0 for that request.
 *
 * So the loop records an estimate instead, flagged `estimated: true` so it is
 * never mistaken for a vendor figure:
 *
 * - Input: the previous completed step's input in this turn, cache tokens
 *   included. The cut-off request carried the same prefix and more, so this
 *   is a floor. With no earlier step, the request's own size in characters
 *   over four.
 * - Output: the characters the step produced (text, reasoning, tool
 *   arguments) over four.
 *
 * All of it is counted as plain input and output. That prices cache reads at
 * the full input rate, which over-estimates. For a spending ceiling,
 * over-estimating is the safe direction.
 */

import type { StreamOpts, Usage } from '../llm-providers/types'

/** Characters per token, the usual rough figure for English text and code. */
const CHARS_PER_TOKEN = 4

/**
 * Tokens charged per image or document block when sizing a request by its
 * characters. The block's base64 bytes are left out of the character count:
 * a vendor charges an image by its pixels, not by its encoded length, and
 * counting the base64 would price one screenshot at hundreds of thousands of
 * tokens. 1,600 is about what Anthropic charges for one image at the size it
 * resizes to.
 */
const BINARY_BLOCK_TOKENS = 1_600

export interface CutOffStepFacts {
  /** What the step sent. Only its system prompt, messages and tools are read. */
  request: Pick<StreamOpts, 'system' | 'messages' | 'tools'>
  /**
   * Input plus cache tokens of the last step in this turn that completed
   * with a reported figure. Undefined when there was none.
   */
  previousStepInput: number | undefined
  /** Characters the step produced before it was cut off. */
  producedChars: number
}

export function estimateCutOffStepUsage(facts: CutOffStepFacts): Usage & { estimated: true } {
  const inputTokens =
    facts.previousStepInput !== undefined && facts.previousStepInput > 0
      ? facts.previousStepInput
      : requestTokenEstimate(facts.request)
  return {
    inputTokens,
    outputTokens: Math.ceil(facts.producedChars / CHARS_PER_TOKEN),
    estimated: true,
  }
}

function requestTokenEstimate(request: CutOffStepFacts['request']): number {
  let binaryBlocks = 0
  const json = JSON.stringify(
    { system: request.system, messages: request.messages, tools: request.tools },
    function (this: unknown, key: string, value: unknown): unknown {
      if (key === 'data' && typeof value === 'string' && isBinaryBlock(this)) {
        binaryBlocks++
        return ''
      }
      return value
    },
  )
  return Math.ceil(json.length / CHARS_PER_TOKEN) + binaryBlocks * BINARY_BLOCK_TOKENS
}

function isBinaryBlock(holder: unknown): boolean {
  if (typeof holder !== 'object' || holder === null) return false
  const type = (holder as { type?: unknown }).type
  return type === 'image' || type === 'document'
}

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

import type { Message } from '../llm-providers/types'

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

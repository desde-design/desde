/**
 * The session transcript, replayed as provider messages.
 *
 * The SDK lane delegates the model's context entirely to the SDK's own JSONL
 * store via `options.resume`. This lane has no such store, and does not need
 * one: `ChatSession.turns` already persists `assistantContent` (text and
 * tool_use blocks, in order) and `toolResults` keyed by `toolUseId`, for every
 * provider, with overflow in the append-only `.archive.jsonl` sidecar. So
 * resume here is a new READER of an existing subsystem, not a new subsystem.
 *
 * Two invariants the wire formats enforce and this function therefore must:
 *
 *  1. Every `tool_use` needs a matching `tool_result` in the very next user
 *     message. A turn that was aborted mid-tool has a `tool_use` with no
 *     result on it, and replaying that verbatim is a 400 from both vendors. A
 *     synthetic error result is substituted, which is also true: that call
 *     never produced anything.
 *  2. An assistant message with no content blocks is rejected. A turn that
 *     errored before the model said anything has exactly that shape, so it
 *     contributes its user message and nothing else.
 *
 * Server tools (the vendor-run web search and fetch) follow a different rule.
 * Their call AND result are both assistant content, replayed inside the
 * assistant message exactly as the vendor produced them, and never as a user
 * `tool_result`: Desde did not run them, and the vendor would read a user
 * result as the answer to a function call it never made. A server call with
 * no result on the turn (the user stopped it mid-search) is dropped, because
 * the vendor rejects an unpaired one the same way it rejects an orphan
 * `tool_use`.
 *
 * A server block written by a DIFFERENT provider is dropped too, both halves
 * together, keeping the text around it. Each vendor validates a replayed
 * payload against its own schema: an OpenAI search result replayed into
 * Anthropic failed with a type validation error before any request was sent,
 * and since the last twenty turns are replayed every time, one switch of
 * model broke the session for good. A block with no `provider` recorded is
 * treated as foreign, so an unattributed payload is never sent anywhere.
 */

import type { ChatSession, ChatTurn } from '../agent-chat/types'
import { readArchivedTurns } from '../agent-chat/session-turns-archive'
import type { AssistantContent, ChatUserContent, Message } from '../llm-providers/types'

/**
 * How many recent turns are replayed in full. Twenty is enough for the
 * conversational reach a design session actually uses and short enough that
 * the request stays cheap; `context-budget.ts` is what handles the case where
 * twenty turns are still too much.
 */
export const DEFAULT_REPLAY_TURNS = 20

export interface ReplayHistoryInput {
  session: ChatSession
  repoRoot: string
  maxTurns?: number
  /**
   * The provider this replay is FOR. Server blocks tagged with any other
   * provider, or with none, are left out. Absent means no server block is
   * replayed at all.
   */
  providerId?: string
}

export async function replayHistory(input: ReplayHistoryInput): Promise<Message[]> {
  const window = input.maxTurns ?? DEFAULT_REPLAY_TURNS
  const turns = [...input.session.turns]
  // The head file holds only what has not yet rolled off. Reach for the
  // sidecar only when the window is not already full — a session whose head
  // file already meets the window has nothing more to gain from the archive,
  // so the common case (a long-lived session) costs no file read.
  if (turns.length < window) {
    const archived = await readArchivedTurns(input.repoRoot, input.session.id.sessionId)
    turns.unshift(...archived)
  }
  const recent = turns.slice(-window)
  // The session's FIRST user message is kept even when it falls outside the
  // window, because it is usually what the whole session is about.
  const first = turns[0]
  const head =
    first !== undefined && !recent.includes(first)
      ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: first.userMessage }] }]
      : []
  return [...head, ...recent.flatMap((turn) => replayTurn(turn, input.providerId))]
}

function replayTurn(turn: ChatTurn, providerId: string | undefined): Message[] {
  const out: Message[] = [
    { role: 'user', content: [{ type: 'text', text: turn.userMessage }] },
  ]
  const assistant: AssistantContent[] = []
  const pendingResults: ChatUserContent[] = []
  const flush = (): void => {
    if (assistant.length > 0) {
      out.push({ role: 'assistant', content: [...assistant] })
      assistant.length = 0
    }
    if (pendingResults.length > 0) {
      out.push({ role: 'user', content: [...pendingResults] })
      pendingResults.length = 0
    }
  }
  // Server calls that got a result on this turn, both halves written by the
  // provider this replay is for. Anything else is dropped below: a call with
  // no result, a result with no call, and a pair from another provider.
  const ours = (b: { provider?: string }): boolean =>
    providerId !== undefined && b.provider === providerId
  const serverCalls = new Set(
    turn.assistantContent.flatMap((b) =>
      b.type === 'server_tool_use' && ours(b) ? [b.toolUseId] : [],
    ),
  )
  const pairedServerIds = new Set(
    turn.assistantContent.flatMap((b) =>
      b.type === 'server_tool_result' && ours(b) && serverCalls.has(b.toolUseId)
        ? [b.toolUseId]
        : [],
    ),
  )
  for (const block of turn.assistantContent) {
    if (block.type === 'server_tool_use' || block.type === 'server_tool_result') {
      if (!pairedServerIds.has(block.toolUseId)) continue
      // Same step rule as text: after a function tool's result, anything the
      // model produced came from a LATER step and opens a new message.
      if (pendingResults.length > 0) flush()
      assistant.push(
        block.type === 'server_tool_use'
          ? {
              type: 'server_tool_use',
              id: block.toolUseId,
              name: block.name,
              input: block.input,
              ...(block.providerMetadata ? { providerMetadata: block.providerMetadata } : {}),
            }
          : {
              type: 'server_tool_result',
              toolUseId: block.toolUseId,
              name: block.name,
              output: block.output,
              ...(block.isError ? { isError: true } : {}),
              ...(block.providerMetadata ? { providerMetadata: block.providerMetadata } : {}),
            },
      )
      continue
    }
    if (block.type === 'text') {
      // A text block after a tool result opens a NEW assistant message: the
      // model produced it in a later step, and collapsing the two would put
      // text before the tool call that caused it.
      if (pendingResults.length > 0) flush()
      assistant.push({ type: 'text', text: block.text })
      continue
    }
    assistant.push({
      type: 'tool_use',
      id: block.toolUseId,
      name: block.name,
      input: block.input,
    })
    const result = turn.toolResults[block.toolUseId]
    pendingResults.push(
      result === undefined
        ? {
            type: 'tool_result',
            toolUseId: block.toolUseId,
            content: 'This tool call did not complete. The turn ended before it returned.',
            isError: true,
          }
        : result.ok
          ? {
              type: 'tool_result',
              toolUseId: block.toolUseId,
              content: stringify(result.output),
            }
          : {
              type: 'tool_result',
              toolUseId: block.toolUseId,
              content: result.error ?? 'The tool call failed with no reported reason.',
              isError: true,
            },
    )
  }
  flush()
  // Steers the user typed during the turn are their own words and belong in
  // the transcript, at the end of the turn they were answered in.
  for (const steer of turn.steers ?? []) {
    out.push({ role: 'user', content: [{ type: 'text', text: steer.text }] })
  }
  return out
}

function stringify(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output)
}

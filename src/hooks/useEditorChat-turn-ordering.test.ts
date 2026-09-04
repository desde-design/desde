import { act, renderHook } from "@testing-library/react"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ONE invariant, over a table of interleavings.
 *
 * For any mix of assistant text, tool calls and steers inside a single turn,
 * the message list the LIVE stream builds must equal the message list
 * hydration builds from the same turn after a reload, and neither may contain
 * an empty assistant bubble.
 *
 * Why a table and not more hand-written cases: two rounds of this feature
 * shipped ordering bugs whose tests passed, because each test hand-built one
 * interleaving AND hand-built the persisted turn it was compared against. A
 * hand-built `ChatTurn` cannot disagree with the live path, so it proved
 * nothing about the code that writes one. Here the persisted turn is produced
 * by the REAL turn runtime (`runChatTurnSdk`) from a scripted SDK message
 * stream, and the live list is produced by the REAL hook from the SSE events
 * that same run emitted. Both halves come from one script, so a new
 * interleaving is one row rather than one test.
 *
 * ---------------------------------------------------------------------------
 * TWO TABLES. The split is the point, so read the names.
 * ---------------------------------------------------------------------------
 *
 * `EQUAL_CASES` — "steering must not break this". Live must EQUAL hydrated.
 *   Rows whose name starts with `control:` carry NO steer at all. They are the
 *   baseline. Without them this file cannot tell "steering broke ordering"
 *   apart from "ordering was already like this" — it would credit steering for
 *   a defect it did not cause, or blame it for one it did not introduce. A red
 *   control row means the defect is NOT in steering, because no steering
 *   happened in it.
 *
 * `KNOWN_DIVERGENCES` — "this is how it already was". Live and hydrated
 *   disagree. Each row asserts the CURRENT shape of BOTH lists rather than an
 *   equality that would fail today, so it is a tripwire: if the behaviour
 *   moves, the row goes red and somebody has to look. Each row carries a
 *   `why` — what diverges, and why it is tolerated. A red row here is not
 *   automatically a bug. Investigate, then either fix it and move the row into
 *   `EQUAL_CASES`, or update the row and write down what changed.
 *
 * Nothing may move from `EQUAL_CASES` into `KNOWN_DIVERGENCES`. That direction
 * is a regression being written down as if it were history.
 *
 * ---------------------------------------------------------------------------
 * "Pre-existing" here is MEASURED, not assumed.
 * ---------------------------------------------------------------------------
 *
 * Every claim of that word below was checked by reverting the two product
 * files this branch changed (`useEditorChat.ts`, `run-chat-turn-sdk.ts`) to
 * HEAD and re-running this file. Result, 2026-08-16:
 *
 *   - Both `control:` rows in EQUAL_CASES: GREEN at HEAD, GREEN now. That is
 *     what makes them controls. They measure the baseline, not the fix.
 *   - 5 of the 8 steered rows in EQUAL_CASES: RED at HEAD, GREEN now. That is
 *     the fix.
 *   - The first three KNOWN_DIVERGENCES rows: GREEN at HEAD, with the SAME
 *     literal shapes on both sides. Untouched by the fix.
 *   - The fourth row is the exception and says so on itself: its live half is
 *     unchanged, its hydrated half is not.
 *
 * If you add a row and call it pre-existing, run it the same way first.
 *
 * ---------------------------------------------------------------------------
 * What this test deliberately does NOT cover, and why.
 * ---------------------------------------------------------------------------
 *
 * `resubmit_required`. It starts a NEW turn; this file is about ordering
 * WITHIN one. `useEditorChat-steering.test.ts` owns the resubmit ledger.
 *
 * Reasoning blocks are no longer excluded by a blanket note. They are MEASURED
 * in `KNOWN_DIVERGENCES` instead. The old note said extended thinking is never
 * written to `ChatTurn.assistantContent`, "a product decision about what a
 * session file stores". That sentence is true and it explains only half of
 * what happens, so it was hiding a second effect behind a first one:
 *
 *  1. Reasoning is ephemeral by declaration (see `AssistantBlockUi`). A live
 *     transcript shows a reasoning bubble; a reloaded one does not. Any turn
 *     with any reasoning at all diverges by exactly that one block. This IS
 *     what a session file stores, and no steer is needed to produce it.
 *  2. A steer that lands after thinking has streamed but before any answer
 *     text ALSO diverges the assistant SEGMENT ID, which "what a session file
 *     stores" does not explain. Live, `segmentHasBlocks` counts the reasoning
 *     block, so the reply is cut and the answer opens as `<turnId>:cont-1`.
 *     Persisted, the steer's `afterAssistantBlocks` counts only persisted
 *     blocks — reasoning is not one — so it records position 0, hydration cuts
 *     nothing, and the answer is segment 0, the bare turn id.
 *
 * Effect 2 is the single most likely real-world steering moment: the user
 * watches "thinking…" and types. Extended thinking is ON by default for
 * Opus/Sonnet in this product, so it is not a corner. Three reasoning rows
 * separate the two effects instead of one note covering both: a reasoning turn
 * with NO steer (effect 1 alone), a steer during reasoning (effect 2 on top of
 * effect 1), and a steer after BOTH reasoning and text have streamed — which
 * shows the segment ids agreeing again, so effect 2 is scoped to "no text yet"
 * rather than to reasoning in general.
 */

// ---------------------------------------------------------------------------
// SDK mock — the turn runtime's `query()` is driven from a script below.
// ---------------------------------------------------------------------------

type QueryArgs = { prompt: unknown; options?: Record<string, unknown> }

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(args: QueryArgs) => AsyncGenerator<unknown, void, void>>(),
}))

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "editor", instance: {} })),
  tool: vi.fn((name: string) => ({ name })),
}))

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import type { BridgeClient } from "@/editor/agent-tools/types"
import type { ChatStreamEvent } from "@/editor/agent-chat/chat-stream-events"
import type { ChatTurn } from "@/editor/agent-chat/types"
import { makeEmptySession } from "@/editor/agent-chat/types"
import { runChatTurnSdk } from "@/editor/agent-chat-sdk/run-chat-turn-sdk"
import { createTurnInputChannel } from "@/editor/agent-chat-sdk/turn-input-channel"
import { runChatTurnNeutral } from "@/editor/agent-chat-neutral/run-chat-turn-neutral"
import type { LLMProvider, ProviderEvent } from "@/editor/llm-providers/types"

import {
  useEditorChat,
  type AssistantBlockUi,
  type ChatMessage,
  type UseEditorChatOptions,
} from "./useEditorChat"

// ---------------------------------------------------------------------------
// The script DSL
// ---------------------------------------------------------------------------

/** One piece of an assistant message, in the order the SDK streams it. */
type MessagePart =
  | { part: "delta"; text: string }
  /** An extended-thinking delta. Streams as `thinking_delta`, persists nowhere. */
  | { part: "reasoning"; text: string }
  | { part: "tool"; id: string; name: string }
  /** The user hits Enter at exactly this point in the stream. */
  | { part: "steer"; text: string }

type ScriptStep =
  | { step: "message"; id: string; parts: MessagePart[] }
  | { step: "toolResult"; id: string }
  | { step: "steer"; text: string }

const SESSION_ID = "s1"

/** Yields to the event loop so the channel's eager consumer runs. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const RESULT = {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "end_turn",
} as const

function messageStart(id: string): Record<string, unknown> {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id } },
  }
}

function textDelta(text: string): Record<string, unknown> {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }
}

function thinkingDelta(thinking: string): Record<string, unknown> {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
  }
}

function toolResultMessage(toolUseId: string): Record<string, unknown> {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: "done", is_error: false },
      ],
    },
  }
}

/**
 * The `message.content` array of the COMPLETED assistant message, built from
 * the same parts that streamed.
 *
 * Two rules, and both mirror the real API rather than the DSL:
 *
 *  - Consecutive deltas of one kind collapse into ONE block, because the model
 *    emits one content block and streams it in pieces. A tool call between two
 *    text runs therefore yields two text blocks, which is the whole point of
 *    the `text -> tool_use -> text` control row.
 *  - A `steer` part contributes nothing. The user typing does not add a block
 *    to what the model produced; the split it causes is recorded separately,
 *    as the steer's position.
 */
function completedContent(parts: readonly MessagePart[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  for (const part of parts) {
    if (part.part === "steer") continue
    if (part.part === "tool") {
      content.push({ type: "tool_use", id: part.id, name: part.name, input: {} })
      continue
    }
    const last = content.length > 0 ? content[content.length - 1] : undefined
    if (part.part === "delta") {
      if (last?.type === "text") {
        last.text = `${String(last.text)}${part.text}`
        continue
      }
      content.push({ type: "text", text: part.text })
      continue
    }
    if (last?.type === "thinking") {
      last.thinking = `${String(last.thinking)}${part.text}`
      continue
    }
    content.push({ type: "thinking", thinking: part.text })
  }
  return content
}

// ---------------------------------------------------------------------------
// Server half — run the real turn runtime over the script
// ---------------------------------------------------------------------------

interface ServerRun {
  events: ChatStreamEvent[]
  turn: ChatTurn
}

/**
 * Push a steer the way `handleSteerRequest` does: enqueue on the turn's input
 * channel, then announce it on the SAME stream the turn's own events go out
 * on. The two lines are adjacent and synchronous in the route
 * (`editor-cli/src/server/chat-handler.ts`), and that adjacency is what makes
 * the announcement land at the exact stream position the runtime stamped —
 * so it is reproduced here rather than stubbed. The route's own validation
 * and 409 handling are covered by the CLI suite.
 */
function steerNow(
  channel: ReturnType<typeof createTurnInputChannel>,
  events: ChatStreamEvent[],
  text: string,
): void {
  channel.push(text)
  events.push({
    kind: "steered",
    sessionId: SESSION_ID,
    userMessage: text,
    imageCount: 0,
  })
}

async function runServer(script: ScriptStep[], repoRoot: string): Promise<ServerRun> {
  const channel = createTurnInputChannel()
  const events: ChatStreamEvent[] = []

  queryMock.mockImplementationOnce((args) =>
    (async function* () {
      // The SDK's own consumer is an eager `for await` that never stops
      // pulling; anything lazier changes the channel's hand-off accounting.
      const consumed = (async () => {
        for await (const _m of args.prompt as AsyncIterable<unknown>) {
          void _m
        }
      })()

      for (const step of script) {
        if (step.step === "steer") {
          steerNow(channel, events, step.text)
          await settle()
          continue
        }
        if (step.step === "toolResult") {
          yield toolResultMessage(step.id)
          continue
        }
        yield messageStart(step.id)
        for (const part of step.parts) {
          if (part.part === "delta") {
            yield textDelta(part.text)
            continue
          }
          if (part.part === "reasoning") {
            yield thinkingDelta(part.text)
            continue
          }
          if (part.part === "steer") {
            steerNow(channel, events, part.text)
            await settle()
            continue
          }
          // A `tool` part streams no partial: `tool_use_start` is emitted from
          // the completed message, where the input is resolved.
        }
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: step.id, content: completedContent(step.parts) },
        }
      }
      yield RESULT
      await consumed
    })(),
  )

  const result = await runChatTurnSdk({
    bridge: { send: vi.fn(async () => null) } satisfies BridgeClient,
    worktreeRoot: repoRoot,
    session: makeEmptySession("proj-1"),
    userMessage: "first",
    inputChannel: channel,
    emit: (e) => events.push(e),
  })

  return { events, turn: result.turn }
}

/**
 * The neutral lane over the same script DSL.
 *
 * Two shapes cannot occur on this lane, and the table says so by not carrying
 * rows for them rather than by carrying rows that assert something false:
 *
 *  - `{ part: "steer" }` inside a message. On this lane a steer cannot land
 *    mid-generation; it lands at the next step boundary. A mid-message row
 *    would be testing a delivery mode that does not exist here.
 *  - `{ part: "reasoning" }` interleaved with a steer. Same reason.
 *
 * `{ step: "steer" }` BETWEEN messages is the boundary case and is covered.
 */
function neutralProvider(script: ScriptStep[], channel: ReturnType<typeof createTurnInputChannel>): LLMProvider {
  const steps: ScriptStep[][] = []
  let current: ScriptStep[] = []
  for (const step of script) {
    if (step.step === "steer") {
      // Unlike the SDK lane's `steerNow`, this does NOT also synthesize a
      // `steered` event. On this lane `steered` is emitted by the RUNTIME
      // ITSELF, only at the step boundary where it actually drains the
      // channel (`run-chat-turn-neutral.ts`: "nothing is drained until step
      // 1"). Faking the event here would desync `live` from `hydrated` for
      // any steer this lane cannot yet deliver within the turn — exactly the
      // divergence this test exists to catch, not paper over.
      channel.push(step.text)
      continue
    }
    current.push(step)
    if (step.step === "message" && step.parts.some((p) => p.part === "tool")) {
      steps.push(current)
      current = []
    }
  }
  if (current.length > 0) steps.push(current)
  let i = 0
  return {
    name: "scripted",
    defaultModel: "x",
    complete: async () => ({ text: "", stopReason: "end_turn" }),
    streamConversation: () =>
      (async function* (): AsyncGenerator<ProviderEvent> {
        const group = steps[i++] ?? []
        const content: Array<Record<string, unknown>> = []
        let sawTool = false
        for (const step of group) {
          if (step.step !== "message") continue
          for (const part of step.parts) {
            if (part.part === "delta") {
              yield { kind: "text_delta", delta: part.text }
              content.push({ type: "text", text: part.text })
            } else if (part.part === "reasoning") {
              yield { kind: "reasoning_delta", delta: part.text }
            } else if (part.part === "tool") {
              sawTool = true
              yield { kind: "tool_use", id: part.id, name: part.name, input: {} }
              content.push({ type: "tool_use", id: part.id, name: part.name, input: {} })
            }
          }
        }
        yield {
          kind: "message_complete",
          stopReason: sawTool ? "tool_use" : "end_turn",
          message: { role: "assistant", content: content as never },
        }
      })(),
  }
}

async function runNeutralServer(script: ScriptStep[], repoRoot: string): Promise<ServerRun> {
  const channel = createTurnInputChannel()
  const events: ChatStreamEvent[] = []
  const result = await runChatTurnNeutral(
    {
      bridge: { send: vi.fn(async () => null) } satisfies BridgeClient,
      worktreeRoot: repoRoot,
      session: makeEmptySession("proj-1"),
      userMessage: "first",
      providerId: "anthropic",
      inputChannel: channel,
      emit: (e: ChatStreamEvent) => events.push(e),
    } as never,
    { buildProvider: () => neutralProvider(script, channel) },
  )
  return { events, turn: result.turn }
}

// ---------------------------------------------------------------------------
// Client half — replay those events through the real hook
// ---------------------------------------------------------------------------

interface LiveStream {
  response: Response
  push(event: object): void
  close(): void
}

function liveSse(): LiveStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    response: { ok: true, body, text: async () => "" } as unknown as Response,
    push(event) {
      controller.enqueue(encoder.encode(`data:${JSON.stringify(event)}\n\n`))
    },
    close() {
      controller.close()
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** Solo/branch-mode wiring: no session tracking, one bucket. */
const soloOptions: UseEditorChatOptions = {
  bridgeHandlers: {},
  getChatSessionId: () => null,
  getVisibleSessionId: () => null,
  onSessionEvent: () => {},
  getSessionReKeyEnabled: () => false,
}

/** Let queued microtasks + the stream reader make progress. */
async function drain(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

type MessageShape =
  | { kind: "user"; text: string }
  | { kind: "assistant"; id: string; blocks: string[] }
  | { kind: string }

/**
 * Adjacent text blocks are merged before comparing. The live path coalesces
 * consecutive text deltas into one block by construction while persistence
 * keeps one block per SDK content block, so two adjacent text blocks and one
 * merged block are the same rendered paragraph — a difference in this
 * dimension is not an ordering defect. Everything that DOES carry order —
 * where a text run ends, where a tool block sits, where a bubble falls — is
 * still compared exactly.
 *
 * Only ADJACENT text merges. Text separated by a tool block does not, which is
 * why the `text -> tool_use -> text` row can show a real divergence here.
 */
function blockShapes(blocks: readonly AssistantBlockUi[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (b.type === "text") {
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined && last.startsWith("text:")) {
        out[out.length - 1] = last + b.text
        continue
      }
      out.push(`text:${b.text}`)
      continue
    }
    if (b.type === "reasoning") {
      out.push(`reasoning:${b.text}`)
      continue
    }
    if (b.type === "tool_use") {
      const state = b.result === undefined ? "pending" : b.result.ok ? "ok" : "err"
      out.push(`tool:${b.toolUseId}:${state}`)
      continue
    }
    // Exhaustive over `AssistantBlockUi`. Adding a block type is a type error
    // here rather than a silent fallthrough, because a block this function
    // cannot name is a block the table cannot compare — and it would look like
    // agreement, not like a gap.
    const unhandled: never = b
    throw new Error(`unhandled assistant block: ${JSON.stringify(unhandled)}`)
  }
  return out
}

/**
 * User-bubble IDs differ between the two paths by construction — the live one
 * is a local id minted when the user typed, the hydrated one is derived from
 * the turn id — so users compare by text. Assistant segment IDs are compared
 * exactly: they are the seam the two paths agree on (`assistantSegmentId`),
 * and a mismatch would re-key every rendered message on reload.
 */
function shapeOf(messages: readonly ChatMessage[]): MessageShape[] {
  return messages.map((m) => {
    if (m.kind === "user") return { kind: "user", text: m.text }
    if (m.kind === "assistant") {
      return { kind: "assistant", id: m.id, blocks: blockShapes(m.blocks) }
    }
    return { kind: m.kind }
  })
}

function emptyAssistants(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.kind === "assistant" && m.blocks.length === 0)
}

/** Shorthand for the expected-shape literals in `KNOWN_DIVERGENCES`. */
function user(text: string): MessageShape {
  return { kind: "user", text }
}

function assistant(id: string, ...blocks: string[]): MessageShape {
  return { kind: "assistant", id, blocks }
}

// ---------------------------------------------------------------------------
// The run: one script -> the live list and the hydrated list
// ---------------------------------------------------------------------------

interface RunResult {
  /** The runtime-minted turn id. Segment ids are derived from it. */
  turnId: string
  live: MessageShape[]
  hydrated: MessageShape[]
  liveEmpties: ChatMessage[]
  hydratedEmpties: ChatMessage[]
}

async function runScript(
  script: ScriptStep[],
  repoRoot: string,
  server: (script: ScriptStep[], repoRoot: string) => Promise<ServerRun> = runServer,
): Promise<RunResult> {
  const { events, turn } = await server(script, repoRoot)

  // The resubmit ledger is a different concern (see the file header): a
  // `resubmit_required` would start a SECOND turn and append its messages
  // to the same list.
  const replayable = events.filter((e) => e.kind !== "resubmit_required")

  const stream = liveSse()
  const chatResponses: Response[] = [stream.response]
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/editor/chat/steer") {
      return Promise.resolve(jsonResponse(200, { accepted: true }))
    }
    if (url === "/api/editor/chat") {
      const next = chatResponses.shift()
      if (!next) return Promise.reject(new Error("unexpected extra POST /api/editor/chat"))
      return Promise.resolve(next)
    }
    return Promise.resolve(jsonResponse(200, { ok: true }))
  })

  const { result } = renderHook(() => useEditorChat(soloOptions))

  let running!: Promise<void>
  await act(async () => {
    running = result.current.submit("first")
    await drain()
  })
  // Solo mode learns the sessionId only from this event, and `/steer`
  // refuses to default one.
  await act(async () => {
    stream.push({ kind: "session", sessionId: SESSION_ID, projectId: "p1" })
    await drain()
  })

  for (const event of replayable) {
    if (event.kind === "steered") {
      // The client's own POST is what CAUSED this frame, so it happens
      // first — that ordering is the whole point.
      await act(async () => {
        await result.current.steer(event.userMessage)
        await drain()
      })
    }
    await act(async () => {
      stream.push(event)
      await drain()
    })
  }

  await act(async () => {
    stream.close()
    await running
  })

  const live = shapeOf(result.current.messages)
  const liveEmpties = emptyAssistants(result.current.messages)

  act(() => {
    result.current.hydrateFromTranscript([turn])
  })
  const hydrated = shapeOf(result.current.messages)
  const hydratedEmpties = emptyAssistants(result.current.messages)

  return { turnId: turn.id, live, hydrated, liveEmpties, hydratedEmpties }
}

// ---------------------------------------------------------------------------
// Table 1 — live must EQUAL hydrated
// ---------------------------------------------------------------------------

const EQUAL_CASES: Array<{ name: string; script: ScriptStep[] }> = [
  // --- Controls: no steer anywhere. These say what ordering does WITHOUT the
  // --- feature this file exists to police. If one goes red, steering is not
  // --- the suspect.
  {
    name: "control: one message, text only",
    script: [
      { step: "message", id: "m1", parts: [{ part: "delta", text: "done" }] },
    ],
  },
  {
    name: "control: text, a tool call, its result, then a second message",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "reading the file" },
          { part: "tool", id: "tu_1", name: "Read" },
        ],
      },
      { step: "toolResult", id: "tu_1" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "found it" }] },
    ],
  },
  // --- Steered rows: the invariant this file was built for.
  {
    name: "steer before any output",
    script: [
      { step: "steer", text: "actually use the sidebar" },
      { step: "message", id: "m1", parts: [{ part: "delta", text: "on it" }] },
    ],
  },
  {
    name: "two steers before any output",
    script: [
      { step: "steer", text: "wait" },
      { step: "steer", text: "no, the sidebar" },
      { step: "message", id: "m1", parts: [{ part: "delta", text: "on it" }] },
    ],
  },
  {
    name: "steer mid-text",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "Chang" },
          { part: "steer", text: "make it 12px" },
          { part: "delta", text: "ing the padding now." },
        ],
      },
    ],
  },
  {
    name: "two steers in one message",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "Chang" },
          { part: "steer", text: "make it 12px" },
          { part: "delta", text: "ing the " },
          { part: "steer", text: "and the radius" },
          { part: "delta", text: "padding now." },
        ],
      },
    ],
  },
  {
    name: "steer between a tool_use and its result",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "reading the file" },
          { part: "tool", id: "tu_1", name: "Read" },
        ],
      },
      { step: "steer", text: "stop, wrong file" },
      { step: "toolResult", id: "tu_1" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "understood" }] },
    ],
  },
  {
    name: "steer after a complete message",
    script: [
      { step: "message", id: "m1", parts: [{ part: "delta", text: "first pass" }] },
      { step: "steer", text: "also the header" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "second pass" }] },
    ],
  },
  {
    name: "steer mid-text in a message that then calls a tool",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "look" },
          { part: "steer", text: "check App.vue too" },
          { part: "delta", text: "ing" },
          { part: "tool", id: "tu_1", name: "Read" },
        ],
      },
      { step: "toolResult", id: "tu_1" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "found it" }] },
    ],
  },
  {
    name: "steer as the very last event",
    script: [
      { step: "message", id: "m1", parts: [{ part: "delta", text: "all of it" }] },
      { step: "steer", text: "one more thing" },
    ],
  },
]

// ---------------------------------------------------------------------------
// Table 2 — live and hydrated already disagree
// ---------------------------------------------------------------------------

interface DivergenceCase {
  name: string
  /** What diverges, why it is tolerated, and what would make it a real bug. */
  why: string
  script: ScriptStep[]
  /** The measured CURRENT shape of both lists, keyed off the minted turn id. */
  shapes(turnId: string): { live: MessageShape[]; hydrated: MessageShape[] }
}

const KNOWN_DIVERGENCES: DivergenceCase[] = [
  {
    name: "no steer: text, then a tool_use, then more text in ONE message",
    why:
      "PRE-EXISTING and currently UNREACHABLE through the Anthropic API. An " +
      "assistant turn stops at `tool_use`, so text never follows a tool_use " +
      "inside one message. If it ever could: `tool_use_start` is emitted only " +
      "from the COMPLETED assistant message (`fromAssistant` in " +
      "sdk-event-adapter.ts), so live it appends after text that already " +
      "streamed, while `capturePersistenceState` preserves `message.content` " +
      "order. Nothing to fix while the shape cannot occur — but the row must " +
      "exist, because it is a divergence with NO steer in it, and without it " +
      "this file could blame mid-turn steering for it.",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "aaa" },
          { part: "tool", id: "tu_1", name: "Read" },
          { part: "delta", text: "bbb" },
        ],
      },
      { step: "toolResult", id: "tu_1" },
    ],
    shapes: (turnId) => ({
      // Live: both text runs streamed before the completed message arrived, so
      // they coalesced into one block and the tool landed after them.
      live: [user("first"), assistant(turnId, "text:aaabbb", "tool:tu_1:ok")],
      // Hydrated: `message.content` order, so the tool sits BETWEEN the runs.
      hydrated: [
        user("first"),
        assistant(turnId, "text:aaa", "tool:tu_1:ok", "text:bbb"),
      ],
    }),
  },
  {
    name: "no steer: reasoning then text",
    why:
      "PRE-EXISTING, and effect 1 from the file header ON ITS OWN — no steer " +
      "involved. `ChatTurn.assistantContent` never stores reasoning, so the " +
      "live list carries one block the hydrated list does not, and nothing " +
      "else differs: same message count, same ids, same text. This row is the " +
      "control for the two reasoning rows below. It is what a reasoning turn " +
      "does WITHOUT steering, so a change here is not a steering change.",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "reasoning", text: "weighing the options" },
          { part: "delta", text: "12px it is" },
        ],
      },
    ],
    shapes: (turnId) => ({
      live: [
        user("first"),
        assistant(turnId, "reasoning:weighing the options", "text:12px it is"),
      ],
      hydrated: [user("first"), assistant(turnId, "text:12px it is")],
    }),
  },
  {
    name: "steer during reasoning, before any answer text",
    why:
      "PRE-EXISTING. The SEGMENT ID diverges; the content order does not. " +
      "Live, `segmentHasBlocks` counts the reasoning block, so the reply is " +
      "cut and the answer opens as `<turnId>:cont-1`. Persisted, the steer's " +
      "`afterAssistantBlocks` counts only persisted blocks and reasoning is " +
      "never persisted, so it records 0, hydration cuts nothing, and the " +
      "answer is segment 0 — the bare turn id. Tolerated because the " +
      "CONVERSATION reads identically either way: opening message, steer " +
      "bubble, then the answer, in that order, on both sides. What a reload " +
      "loses is the reasoning bubble (ephemeral by declaration) and what it " +
      "changes is one React key. Closing it means persisting reasoning, which " +
      "is a decision about what a session file stores, not an ordering fix. " +
      "This matters because it is the LIKELIEST steering moment in real use: " +
      "the user sees 'thinking…' and types, and extended thinking is on by " +
      "default for Opus/Sonnet here.",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "reasoning", text: "weighing the options" },
          { part: "steer", text: "make it 12px" },
          { part: "delta", text: "on it" },
        ],
      },
    ],
    shapes: (turnId) => ({
      live: [
        user("first"),
        assistant(turnId, "reasoning:weighing the options"),
        user("make it 12px"),
        assistant(`${turnId}:cont-1`, "text:on it"),
      ],
      hydrated: [user("first"), user("make it 12px"), assistant(turnId, "text:on it")],
    }),
  },
  {
    name: "steer after BOTH reasoning and text have streamed",
    why:
      "The row that SCOPES the one above. Once any answer text has streamed, " +
      "the steer's recorded position is non-zero, hydration cuts the reply, " +
      "and the segment ids agree again — `<turnId>` then `<turnId>:cont-1` on " +
      "both sides, with the steer bubble in the same place. All that is left " +
      "is effect 1: the live segment 0 carries a reasoning block. So the " +
      "segment-id divergence above belongs to 'a steer arrived before any " +
      "text', not to 'the turn had reasoning' — which is why the two are " +
      "separate rows rather than one exclusion. " +
      "READ THE PROVENANCE CAREFULLY, it is mixed and the other three rows " +
      "are not. The residual divergence (one live-only reasoning block) is " +
      "pre-existing. The rest of the shape is NOT: measured against HEAD, the " +
      "live list is identical but the hydrated one is " +
      "`[first] [steer] [assistant: 'Changing the padding now.']` — the " +
      "pre-fix bug where the recorded position could not see the reply in " +
      "progress. This branch fixed that, which is why the cut and the ids now " +
      "line up. So this row is a tripwire on effect 1 only; the ordering half " +
      "of it is guarded by `steer mid-text` in EQUAL_CASES.",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "reasoning", text: "weighing the options" },
          { part: "delta", text: "Chang" },
          { part: "steer", text: "make it 12px" },
          { part: "delta", text: "ing the padding now." },
        ],
      },
    ],
    shapes: (turnId) => ({
      live: [
        user("first"),
        assistant(turnId, "reasoning:weighing the options", "text:Chang"),
        user("make it 12px"),
        assistant(`${turnId}:cont-1`, "text:ing the padding now."),
      ],
      hydrated: [
        user("first"),
        assistant(turnId, "text:Chang"),
        user("make it 12px"),
        assistant(`${turnId}:cont-1`, "text:ing the padding now."),
      ],
    }),
  },
]

// ---------------------------------------------------------------------------

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "editor-turn-order-")))
  queryMock.mockReset()
  fetchMock.mockReset()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("one turn's message order: live stream === re-hydrated transcript", () => {
  it.each(EQUAL_CASES)("$name", async ({ script }) => {
    const run = await runScript(script, root)

    expect(run.liveEmpties).toEqual([])
    expect(run.hydratedEmpties).toEqual([])
    expect(run.hydrated).toEqual(run.live)
  })
})

describe("known divergences: live and hydrated already disagree", () => {
  it.each(KNOWN_DIVERGENCES)("$name", async ({ script, shapes }) => {
    const run = await runScript(script, root)
    const expected = shapes(run.turnId)

    // Assert BOTH lists exactly. Asserting only the inequality would let the
    // shapes drift to anything at all and still pass.
    expect(run.live).toEqual(expected.live)
    expect(run.hydrated).toEqual(expected.hydrated)
    // Stated outright so the row's purpose survives a careless edit to the
    // literals above: these two are NOT equal, and that is the finding.
    expect(run.hydrated).not.toEqual(run.live)

    // Divergence is not licence. Neither path may render a blank bubble.
    expect(run.liveEmpties).toEqual([])
    expect(run.hydratedEmpties).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Table 3 — the neutral lane, over the same invariant
// ---------------------------------------------------------------------------

const NEUTRAL_EQUAL_CASES: Array<{ name: string; script: ScriptStep[] }> = [
  {
    name: "control: one message, text only",
    script: [{ step: "message", id: "m1", parts: [{ part: "delta", text: "done" }] }],
  },
  {
    name: "control: text, a tool call, its result, then a second message",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "reading the file" },
          { part: "tool", id: "tu_1", name: "Read" },
        ],
      },
      { step: "toolResult", id: "tu_1" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "found it" }] },
    ],
  },
  {
    name: "steer before any output",
    script: [
      { step: "steer", text: "actually use the sidebar" },
      { step: "message", id: "m1", parts: [{ part: "delta", text: "on it" }] },
    ],
  },
  {
    name: "steer at a tool boundary",
    script: [
      {
        step: "message",
        id: "m1",
        parts: [
          { part: "delta", text: "reading the file" },
          { part: "tool", id: "tu_1", name: "Read" },
        ],
      },
      { step: "steer", text: "stop, wrong file" },
      { step: "toolResult", id: "tu_1" },
      { step: "message", id: "m2", parts: [{ part: "delta", text: "understood" }] },
    ],
  },
]

describe("neutral lane: live stream === re-hydrated transcript", () => {
  it.each(NEUTRAL_EQUAL_CASES)("$name", async ({ script }) => {
    const run = await runScript(script, root, runNeutralServer)
    expect(run.liveEmpties).toEqual([])
    expect(run.hydratedEmpties).toEqual([])
    expect(run.hydrated).toEqual(run.live)
  })
})

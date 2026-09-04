/**
 * Mock chat fixtures for the self-host harness.
 *
 * Two surfaces, fed by `mock-backend.ts`:
 *
 *  1. **Persisted transcript** (`GET /api/editor/chat/sessions/:id`) —
 *     a fully-shaped `ChatSession` so clicking a session tab hydrates an
 *     example conversation: user turns, assistant text, and a `Grep`
 *     tool-use container with its result. (Reasoning/thinking is NOT
 *     persisted on a turn — it's ephemeral chain-of-thought — so the
 *     *live* thinking state comes from the stream below, not from here.)
 *
 *  2. **Live "thinking" stream** (`POST /api/editor/chat`) — an SSE
 *     `ReadableStream` that emits a reasoning (thinking) block, a `Grep`
 *     tool-use + result, then a little more reasoning, and HOLDS THE
 *     STREAM OPEN. Because the submit loop never sees `turn_complete`,
 *     `chat.submitting` stays true → the runtime reports `isRunning` →
 *     the chat renders the pulsing "Thinking…" disclosure indefinitely,
 *     exactly as if the agent were still working. The harness auto-fires
 *     one submit on boot (see `main.tsx`) so this is visible without the
 *     user typing anything.
 */

import type {
  ChatSession,
  ChatTurn,
} from "@/editor/agent-chat/types"
import type { ChatStreamEvent } from "@/editor/agent-chat/chat-stream-events"

const PROJECT_ID = "self-host-harness"

/**
 * The model the example transcript claims to have run on. Named rather than
 * inline because the picker groups by provider now, and a fixture that can only
 * ever say "Anthropic" cannot show that.
 */
export const MOCK_CHAT_MODEL = "claude-opus-4-8"
export const MOCK_CHAT_PROVIDER = "anthropic"

/** A completed turn with assistant text + a Grep tool-use container. */
function exampleTurn(
  id: string,
  userMessage: string,
  assistantText: string,
  grepPattern: string,
  model: string = MOCK_CHAT_MODEL,
): ChatTurn {
  const toolUseId = `toolu_${id}`
  return {
    id,
    startedAt: "2026-06-22T09:00:00.000Z",
    completedAt: "2026-06-22T09:00:12.000Z",
    userMessage,
    assistantContent: [
      { type: "text", text: assistantText },
      {
        type: "tool_use",
        toolUseId,
        name: "Grep",
        input: {
          pattern: grepPattern,
          path: "src/components/editor",
          output_mode: "files_with_matches",
        },
      },
    ],
    toolResults: {
      [toolUseId]: {
        ok: true,
        output:
          "src/components/editor/commit-push-controls.tsx\n" +
          "src/components/editor/chat-session-tabs.tsx",
      },
    },
    editProposals: [],
    usage: { inputTokens: 4120, outputTokens: 388 },
    model,
  }
}

/**
 * Sessions whose turns should carry an OpenAI fixture model instead of the
 * default Anthropic one, so switching between sessions in the self-host page
 * shows the picker's provider grouping rather than a single vendor.
 */
const OPENAI_SESSION_IDS = new Set(["sess-bbbb2222"])

/**
 * Build the example persisted session for a given sessionId. Every tab
 * resolves to a transcript so switching sessions always shows content.
 */
export function mockChatSession(sessionId: string): ChatSession {
  const model = OPENAI_SESSION_IDS.has(sessionId) ? "gpt-5.6" : MOCK_CHAT_MODEL
  return {
    schemaVersion: 1,
    id: { projectId: PROJECT_ID, sessionId },
    createdAt: "2026-06-22T09:00:00.000Z",
    updatedAt: "2026-06-22T09:12:00.000Z",
    status: "idle",
    turns: [
      exampleTurn(
        `${sessionId}-t1`,
        "Where does the commit button live?",
        "Let me search the editor chrome for the commit controls.",
        "Commit|commitPush",
        model,
      ),
      exampleTurn(
        `${sessionId}-t2`,
        "Tighten the spacing on the commit dialog",
        "I'll find the commit dialog markup before adjusting its padding.",
        "commit-dialog|CommitDialog",
        model,
      ),
    ],
  }
}

/** Encode one SSE frame the way `parseSseStream` expects (`data: …\n\n`). */
function frame(event: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * The live "still thinking" SSE stream. Emits a reasoning block, a Grep
 * tool-use + result, and more reasoning, spaced out to look like a real
 * stream — then never closes, so the UI parks on "Thinking…".
 */
export function mockThinkingStream(sessionId: string): Response {
  const turnId = `${sessionId}-live`
  const toolUseId = `toolu_${turnId}`

  // Ordered script of (delayMs, event) pairs. After the last one the
  // controller is intentionally left open.
  const script: Array<[number, ChatStreamEvent]> = [
    [0, { kind: "session", sessionId, projectId: PROJECT_ID }],
    [120, { kind: "turn_start", turnId }],
    [
      150,
      {
        kind: "reasoning_delta",
        turnId,
        delta:
          "The user wants the Save button to use our brand token. ",
      },
    ],
    [
      450,
      {
        kind: "reasoning_delta",
        turnId,
        delta:
          "First I need to find where that button and its color classes are defined, ",
      },
    ],
    [
      750,
      {
        kind: "reasoning_delta",
        turnId,
        delta: "so let me grep the editor chrome for the primary button.",
      },
    ],
    [
      1100,
      {
        kind: "tool_use_start",
        turnId,
        toolUseId,
        name: "Grep",
        input: {
          pattern: "btn\\.primary|bg-primary",
          path: "src/components/editor",
          output_mode: "files_with_matches",
        },
      },
    ],
    [
      1900,
      {
        kind: "tool_result",
        turnId,
        toolUseId,
        ok: true,
        output:
          "src/components/editor/commit-push-controls.tsx\n" +
          "src/components/editor/editor-chat-panel.tsx",
      },
    ],
    [
      2200,
      {
        kind: "reasoning_delta",
        turnId,
        delta:
          " Found it in commit-push-controls.tsx. Now let me read that file and check which design token maps to our brand color before editing…",
      },
    ],
  ]

  // Shared between start() and cancel() so the Stop button / unmount
  // (which cancels the reader) stops the timers from enqueuing into a
  // closed controller.
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const run = async () => {
        for (const [delay, event] of script) {
          if (cancelled) return
          if (delay > 0) await new Promise((r) => setTimeout(r, delay))
          if (cancelled) return
          controller.enqueue(frame(event))
        }
        // Deliberately do NOT close — the turn never completes, so the
        // chat stays in its "Thinking…" running state. A heartbeat
        // comment keeps the connection from looking idle to proxies.
        const heartbeat = () => {
          if (cancelled) return
          controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"))
          setTimeout(heartbeat, 15_000)
        }
        setTimeout(heartbeat, 15_000)
      }
      void run()
    },
    cancel() {
      cancelled = true
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  })
}

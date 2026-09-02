/**
 * Unit tests for `convertEditorMessage` from useEditorChatRuntime.
 *
 * Focus areas:
 *   1. User message → correct ThreadMessageLike shape.
 *   2. Assistant text blocks → text parts.
 *   3. Assistant tool_use blocks (no result / ok result / error result).
 *   4. Stable identity: same `id` and `toolCallId` survive a streaming delta
 *      (simulated by converting two versions of the same message with the
 *      same id but more content).
 *   5. Multiple blocks preserve order.
 *   6. Non-conversational kinds throw (programming-error guard).
 */

import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { AppendMessage } from "@assistant-ui/react"
import {
  convertEditorMessage,
  createImageAttachmentAdapter,
  extractImageDataUrls,
  useEditorChatRuntime,
} from "./useEditorChatRuntime"
import type {
  ChatMessage,
  AssistantBlockUi,
  UseEditorChatReturn,
} from "./useEditorChat"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides?: Partial<Extract<ChatMessage, { kind: "user" }>>): Extract<ChatMessage, { kind: "user" }> {
  return { kind: "user", id: "u1", text: "Hello", ...overrides }
}

function makeAssistant(
  blocks: AssistantBlockUi[],
  id = "a1",
): Extract<ChatMessage, { kind: "assistant" }> {
  return { kind: "assistant", id, blocks }
}

// ---------------------------------------------------------------------------
// user → ThreadMessageLike
// ---------------------------------------------------------------------------

describe("convertEditorMessage — user", () => {
  it("maps to role:user with a text part", () => {
    const result = convertEditorMessage(makeUser({ text: "Hi there" }), 0)
    expect(result.role).toBe("user")
    expect(result.id).toBe("u1")
    expect(result.content).toEqual([{ type: "text", text: "Hi there" }])
  })

  it("carries the id from the source message", () => {
    const result = convertEditorMessage(makeUser({ id: "u-abc-123" }), 0)
    expect(result.id).toBe("u-abc-123")
  })
})

// ---------------------------------------------------------------------------
// assistant text blocks
// ---------------------------------------------------------------------------

describe("convertEditorMessage — assistant text blocks", () => {
  it("maps a single text block to a text part", () => {
    const result = convertEditorMessage(
      makeAssistant([{ type: "text", text: "Hello world" }]),
      0,
    )
    expect(result.role).toBe("assistant")
    expect(result.id).toBe("a1")
    const content = result.content as unknown as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: "text", text: "Hello world" })
  })

  it("maps multiple text blocks preserving order", () => {
    const result = convertEditorMessage(
      makeAssistant([
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ]),
      0,
    )
    const content = result.content as unknown as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: "text", text: "First" })
    expect(content[1]).toMatchObject({ type: "text", text: "Second" })
  })
})

// ---------------------------------------------------------------------------
// assistant tool_use blocks
// ---------------------------------------------------------------------------

describe("convertEditorMessage — reasoning blocks", () => {
  it("maps a reasoning block to a reasoning part", () => {
    const result = convertEditorMessage(
      makeAssistant([
        { type: "reasoning", text: "let me think about this" },
        { type: "text", text: "the answer" },
      ]),
      0,
    )
    const content = result.content as unknown as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "reasoning", text: "let me think about this" })
    expect(content[1]).toMatchObject({ type: "text", text: "the answer" })
  })
})

describe("convertEditorMessage — assistant tool_use blocks", () => {
  it("maps a tool_use block with no result to a tool-call part (running state)", () => {
    const result = convertEditorMessage(
      makeAssistant([
        {
          type: "tool_use",
          toolUseId: "tc-1",
          name: "get_selection",
          input: { includeProps: true },
        },
      ]),
      0,
    )
    const content = result.content as unknown as Array<Record<string, unknown>>
    expect(content).toHaveLength(1)
    const part = content[0]
    expect(part.type).toBe("tool-call")
    expect(part.toolCallId).toBe("tc-1")
    expect(part.toolName).toBe("get_selection")
    expect(part.args).toEqual({ includeProps: true })
    expect(part.result).toBeUndefined()
    expect(part.isError).toBeUndefined()
  })

  it("maps a tool_use block with ok result (isError:false)", () => {
    const result = convertEditorMessage(
      makeAssistant([
        {
          type: "tool_use",
          toolUseId: "tc-2",
          name: "read_file",
          input: { path: "src/App.vue" },
          result: { ok: true, output: { content: "<template>…</template>" } },
        },
      ]),
      0,
    )
    const content = result.content as unknown as Array<Record<string, unknown>>
    const part = content[0]
    expect(part.result).toEqual({ content: "<template>…</template>" })
    expect(part.isError).toBe(false)
  })

  it("maps a tool_use block with error result (isError:true)", () => {
    const result = convertEditorMessage(
      makeAssistant([
        {
          type: "tool_use",
          toolUseId: "tc-3",
          name: "write_file",
          input: {},
          result: { ok: false, error: "Permission denied" },
        },
      ]),
      0,
    )
    const content = result.content as unknown as Array<Record<string, unknown>>
    const part = content[0]
    expect(part.result).toBe("Permission denied")
    expect(part.isError).toBe(true)
  })

  it("preserves toolCallId stable across a simulated tool_result patch", () => {
    const toolUseId = "tc-stable"

    // Version 1 — tool_use started, no result yet
    const v1 = makeAssistant(
      [
        {
          type: "tool_use",
          toolUseId,
          name: "apply_edit",
          input: { prop: "label", value: "New label" },
        },
      ],
      "msg-42",
    )

    // Version 2 — same id, same toolUseId, result patched in
    const v2 = makeAssistant(
      [
        {
          type: "tool_use",
          toolUseId,
          name: "apply_edit",
          input: { prop: "label", value: "New label" },
          result: { ok: true, output: "ok" },
        },
      ],
      "msg-42",
    )

    const r1 = convertEditorMessage(v1, 0)
    const r2 = convertEditorMessage(v2, 0)

    // Message-level identity
    expect(r1.id).toBe("msg-42")
    expect(r2.id).toBe("msg-42")

    // Tool-call part identity
    const p1 = (r1.content as unknown as Array<Record<string, unknown>>)[0]
    const p2 = (r2.content as unknown as Array<Record<string, unknown>>)[0]
    expect(p1.toolCallId).toBe(toolUseId)
    expect(p2.toolCallId).toBe(toolUseId)
  })
})

// ---------------------------------------------------------------------------
// Stable identity under streaming (text delta simulation)
// ---------------------------------------------------------------------------

describe("convertEditorMessage — streaming identity stability", () => {
  it("same id on initial + extended text versions of the same message", () => {
    const id = "stream-1"
    const initial = makeAssistant([{ type: "text", text: "Hello" }], id)
    const extended = makeAssistant(
      [{ type: "text", text: "Hello, world!" }],
      id,
    )

    const r1 = convertEditorMessage(initial, 0)
    const r2 = convertEditorMessage(extended, 0)

    expect(r1.id).toBe(id)
    expect(r2.id).toBe(id)
  })
})

// ---------------------------------------------------------------------------
// Multiple blocks preserve order
// ---------------------------------------------------------------------------

describe("convertEditorMessage — block ordering", () => {
  it("preserves text → tool → text order", () => {
    const result = convertEditorMessage(
      makeAssistant([
        { type: "text", text: "Before" },
        {
          type: "tool_use",
          toolUseId: "tc-x",
          name: "some_tool",
          input: {},
          result: { ok: true, output: null },
        },
        { type: "text", text: "After" },
      ]),
      0,
    )
    const content = result.content as unknown as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)
    expect(content[0].type).toBe("text")
    expect(content[1].type).toBe("tool-call")
    expect(content[2].type).toBe("text")
    expect((content[0] as unknown as { text: string }).text).toBe("Before")
    expect((content[2] as unknown as { text: string }).text).toBe("After")
  })
})

// ---------------------------------------------------------------------------
// extractImageDataUrls — image attachment extraction
// ---------------------------------------------------------------------------

describe("extractImageDataUrls", () => {
  // Build an AppendMessage carrying attachments. Only the attachments field
  // matters here; the rest is cast to satisfy the type.
  function withAttachments(attachments: unknown): AppendMessage {
    return { role: "user", content: [], attachments } as unknown as AppendMessage
  }

  it("returns [] when there are no attachments", () => {
    expect(extractImageDataUrls(withAttachments(undefined))).toEqual([])
    expect(extractImageDataUrls(withAttachments([]))).toEqual([])
  })

  it("extracts the data URL from a single image attachment", () => {
    const m = withAttachments([
      {
        id: "a1",
        type: "image",
        name: "shot.png",
        status: { type: "complete" },
        content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
      },
    ])
    expect(extractImageDataUrls(m)).toEqual(["data:image/png;base64,AAAA"])
  })

  it("collects multiple image parts across multiple attachments, preserving order", () => {
    const m = withAttachments([
      {
        id: "a1",
        type: "image",
        name: "one.png",
        status: { type: "complete" },
        content: [{ type: "image", image: "data:image/png;base64,ONE" }],
      },
      {
        id: "a2",
        type: "image",
        name: "two.jpg",
        status: { type: "complete" },
        content: [{ type: "image", image: "data:image/jpeg;base64,TWO" }],
      },
    ])
    expect(extractImageDataUrls(m)).toEqual([
      "data:image/png;base64,ONE",
      "data:image/jpeg;base64,TWO",
    ])
  })

  it("ignores non-image attachment parts (e.g. text/file)", () => {
    const m = withAttachments([
      {
        id: "doc",
        type: "document",
        name: "notes.txt",
        status: { type: "complete" },
        content: [{ type: "text", text: "<attachment>…</attachment>" }],
      },
      {
        id: "img",
        type: "image",
        name: "ok.png",
        status: { type: "complete" },
        content: [{ type: "image", image: "data:image/png;base64,KEEP" }],
      },
    ])
    expect(extractImageDataUrls(m)).toEqual(["data:image/png;base64,KEEP"])
  })
})

// ---------------------------------------------------------------------------
// createImageAttachmentAdapter — narrowed accept + unique ids
// ---------------------------------------------------------------------------

describe("createImageAttachmentAdapter", () => {
  it("narrows accept to the four server-supported image types", () => {
    const adapter = createImageAttachmentAdapter()
    expect(adapter.accept).toBe("image/png,image/jpeg,image/webp,image/gif")
  })

  it("assigns a UNIQUE id to two same-named files (clipboard-screenshot collision)", async () => {
    const adapter = createImageAttachmentAdapter()
    const f1 = new File([new Uint8Array([1])], "image.png", { type: "image/png" })
    const f2 = new File([new Uint8Array([2])], "image.png", { type: "image/png" })
    const a1 = await adapter.add({ file: f1 })
    const a2 = await adapter.add({ file: f2 })
    // The stock adapter would give both id "image.png" and the editor
    // runtime would upsert the second over the first; the unique suffix
    // keeps them distinct so both survive to the turn.
    expect(a1.id).not.toBe(a2.id)
    expect(a1.name).toBe("image.png")
    expect(a2.name).toBe("image.png")
  })
})

// ---------------------------------------------------------------------------
// Programming-error guard for non-conversational kinds
// ---------------------------------------------------------------------------

describe("convertEditorMessage — non-conversational kinds throw", () => {
  const nonConversational: ChatMessage[] = [
    { kind: "error", id: "e1", reason: "oops" },
    { kind: "queued", id: "q1", queuePosition: 1 },
    {
      kind: "overwrite_warning",
      id: "ow1",
      file: "src/App.vue",
      hashAtRead: "aaa",
      hashAtWrite: "bbb",
    },
    {
      kind: "rate_limit_warning",
      id: "rl1",
      status: "allowed_warning",
    },
    {
      kind: "api_retry",
      id: "ar1",
      retryDelayMs: 5000,
      attempt: 1,
      maxRetries: 3,
      errorStatus: 429,
    },
  ]

  for (const m of nonConversational) {
    it(`throws for kind "${m.kind}"`, () => {
      expect(() => convertEditorMessage(m, 0)).toThrow(
        /unexpected kind/,
      )
    })
  }
})

// ---------------------------------------------------------------------------
// onNew routing — steer while a turn runs, submit while idle
// ---------------------------------------------------------------------------

/**
 * The composer no longer refuses input mid-turn, so `onNew` fires in BOTH
 * states and has to pick the right delivery path. `submit` aborts an in-flight
 * turn on the same bucket by design, so routing a mid-turn message to it would
 * cancel the very work the user is commenting on.
 */
function stubChat(submitting: boolean): {
  chat: UseEditorChatReturn
  submitted: string[][]
  steered: string[][]
} {
  const submitted: string[][] = []
  const steered: string[][] = []
  const chat = {
    messages: [],
    submitting,
    error: null,
    submit: async (text: string, images?: string[]) => {
      submitted.push([text, ...(images ?? [])])
    },
    steer: async (text: string, images?: string[]) => {
      steered.push([text, ...(images ?? [])])
    },
    resendingSteers: [],
    abort: () => {},
    clearLocal: () => {},
    dismissMessage: () => {},
    hydrateFromTranscript: () => {},
    hasSessionBucket: () => false,
    modelConfig: null,
    setModelConfig: () => {},
    seedModelConfig: () => {},
  } satisfies UseEditorChatReturn
  return { chat, submitted, steered }
}

describe("useEditorChatRuntime onNew routing", () => {
  it("submits when no turn is running", async () => {
    const { chat, submitted, steered } = stubChat(false)
    const { result } = renderHook(() => useEditorChatRuntime(chat))
    await act(async () => {
      await result.current.runtime.thread.append({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      })
    })
    expect(submitted).toEqual([["hello"]])
    expect(steered).toEqual([])
  })

  it("steers into the running turn instead of aborting it", async () => {
    const { chat, submitted, steered } = stubChat(true)
    const { result } = renderHook(() => useEditorChatRuntime(chat))
    await act(async () => {
      await result.current.runtime.thread.append({
        role: "user",
        content: [{ type: "text", text: "also do this" }],
      })
    })
    expect(steered).toEqual([["also do this"]])
    expect(submitted).toEqual([])
  })
})

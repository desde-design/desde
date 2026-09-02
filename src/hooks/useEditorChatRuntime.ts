/**
 * Phase 1 of the assistant-ui chat migration.
 *
 * Provides the external-store runtime adapter that bridges
 * `UseEditorChatReturn` (our message state + submit/abort surface) into the
 * `AssistantRuntime` that `AssistantRuntimeProvider` / `ThreadPrimitive.*`
 * consume.
 *
 * Key design decisions carried forward from the Phase 0 spike:
 *   - Only `user` + `assistant` messages reach the runtime. The 5 status kinds
 *     (`error`, `queued`, `overwrite_warning`, `rate_limit_warning`,
 *     `api_retry`) render in the separate `<ChatStatusBanners>` strip so that
 *     the runtime's timeline stays a clean conversation — spec decision #1.
 *   - Stable identity: each ThreadMessage is keyed by `message.id`; tool-call
 *     parts are keyed by `toolUseId`. This is load-bearing for streaming — rapid
 *     `text_delta` mutations would cause flicker/remount without it.
 */

import { useMemo } from "react"
import {
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import type {
  ChatMessage,
  AssistantBlockUi,
  UseEditorChatReturn,
} from "@/hooks/useEditorChat"

// ---------------------------------------------------------------------------
// Converter — pure function, no allocations beyond the mapped array.
// ---------------------------------------------------------------------------

type ToolCallPart = {
  type: "tool-call"
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  isError?: boolean
}

type TextPart = { type: "text"; text: string }
type ReasoningPart = { type: "reasoning"; text: string }
type ContentPart = TextPart | ReasoningPart | ToolCallPart

function blockToContentPart(block: AssistantBlockUi): ContentPart {
  if (block.type === "text") {
    return { type: "text", text: block.text }
  }
  if (block.type === "reasoning") {
    // assistant-ui renders this via the MessagePrimitive.Content `Reasoning` slot.
    return { type: "reasoning", text: block.text }
  }
  // tool_use → tool-call
  const part: ToolCallPart = {
    type: "tool-call",
    toolCallId: block.toolUseId,
    toolName: block.name,
    args: (block.input ?? {}) as Record<string, unknown>,
  }
  if (block.result !== undefined) {
    part.result = block.result.ok ? block.result.output : block.result.error
    part.isError = !block.result.ok
  }
  return part
}

/**
 * Convert a single `ChatMessage` (user or assistant only) into the
 * `ThreadMessageLike` shape consumed by `useExternalStoreRuntime`.
 *
 * The 5 status kinds are NEVER passed here — they are filtered out upstream
 * in `useEditorChatRuntime`. If one is passed, this is a programming error;
 * we throw with a clear message rather than silently returning garbage.
 */
export function convertEditorMessage(
  m: ChatMessage,
   
  _idx: number,
): ThreadMessageLike {
  if (m.kind === "user") {
    return {
      role: "user",
      id: m.id,
      content: [{ type: "text", text: m.text }],
    }
  }

  if (m.kind === "assistant") {
    const content = m.blocks.map(blockToContentPart) as ContentPart[]
    return {
      role: "assistant",
      id: m.id,
      content: content as ThreadMessageLike["content"],
    }
  }

  // Exhaustive guard — none of the 5 status kinds should reach here.
  throw new Error(
    `convertEditorMessage: unexpected kind "${(m as ChatMessage).kind}". ` +
      "Only user/assistant messages should reach the runtime; filter status kinds before calling convertMessage.",
  )
}

// ---------------------------------------------------------------------------
// Text extractor — pulls plain text out of an AppendMessage's content parts.
// ---------------------------------------------------------------------------

function extractText(m: AppendMessage): string {
  if (typeof m.content === "string") return m.content
  return (m.content as ReadonlyArray<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
}

/**
 * Pull image data URLs out of an AppendMessage's attachments. The
 * `SimpleImageAttachmentAdapter` resolves each sent image attachment into a
 * content part `{ type: "image", image: <dataURL> }` (FileReader
 * readAsDataURL); we collect those data URLs to forward to the chat submit
 * → server, where they're validated + capped and ride into the agent turn
 * as vision. Non-image attachments are ignored (files are deferred).
 */
/** Monotonic counter making every attachment id unique within a session. */
let attachmentSeq = 0

/**
 * Build the editor's image attachment adapter. Two deviations from the
 * stock `SimpleImageAttachmentAdapter`:
 *
 *  1. `accept` is narrowed from the default `image/*` to exactly the MIME
 *     types the server's media-content validator accepts, so the picker /
 *     drop / paste can't attach an SVG/AVIF/BMP that would 400 the whole turn
 *     server-side (losing the user's text with it).
 *  2. Each added attachment gets a UNIQUE id. The stock adapter uses
 *     `file.name` as the id, and the editor runtime upserts attachments by
 *     id — so two clipboard screenshots (commonly both named `image.png`)
 *     would collide and only the last would survive to the turn, despite this
 *     feature supporting multiple images. A monotonic suffix keeps every
 *     pasted/dropped image distinct.
 */
export function createImageAttachmentAdapter(): SimpleImageAttachmentAdapter {
  const adapter = new SimpleImageAttachmentAdapter()
  adapter.accept = "image/png,image/jpeg,image/webp,image/gif"
  const originalAdd = adapter.add.bind(adapter)
  adapter.add = async (state: { file: File }) => {
    const pending = await originalAdd(state)
    return { ...pending, id: `${pending.id}#${++attachmentSeq}` }
  }
  return adapter
}

export function extractImageDataUrls(m: AppendMessage): string[] {
  const out: string[] = []
  for (const att of m.attachments ?? []) {
    for (const part of att.content ?? []) {
      if (part.type === "image" && typeof part.image === "string") {
        out.push(part.image)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Wraps `UseEditorChatReturn` in an `AssistantRuntime` for use with
 * `AssistantRuntimeProvider`.
 *
 * Returns `{ runtime }` — the caller passes `runtime` to
 * `<AssistantRuntimeProvider runtime={runtime}>`.
 *
 * Usage:
 * ```tsx
 * const { runtime } = useEditorChatRuntime(chat)
 * return (
 *   <AssistantRuntimeProvider runtime={runtime}>
 *     …
 *   </AssistantRuntimeProvider>
 * )
 * ```
 */
export function useEditorChatRuntime(chat: UseEditorChatReturn): {
  runtime: ReturnType<typeof useExternalStoreRuntime>
} {
  // Filter to the 2 conversational kinds. This is the sole filter point —
  // the 5 status kinds NEVER reach `convertEditorMessage`.
  const conversational = useMemo(
    () =>
      chat.messages.filter(
        (m): m is Extract<ChatMessage, { kind: "user" | "assistant" }> =>
          m.kind === "user" || m.kind === "assistant",
      ),
    [chat.messages],
  )

  // Image attachment adapter — enables paste / drag-drop / the attach button
  // in the editor (files deferred). One instance for the hook's lifetime.
  const attachmentAdapter = useMemo(() => createImageAttachmentAdapter(), [])

  const runtime = useExternalStoreRuntime<
    Extract<ChatMessage, { kind: "user" | "assistant" }>
  >({
    messages: conversational,
    isRunning: chat.submitting,
    adapters: { attachments: attachmentAdapter },
    convertMessage: convertEditorMessage as (
      m: Extract<ChatMessage, { kind: "user" | "assistant" }>,
      idx: number,
    ) => ThreadMessageLike,
    onNew: async (m: AppendMessage) => {
      const text = extractText(m)
      const images = extractImageDataUrls(m)
      // An image-only turn (no text) is valid — submit/steer both gate on text
      // OR images. Pass undefined for the no-image case so the body stays lean.
      if (text || images.length > 0) {
        const payload = images.length > 0 ? images : undefined
        // Route on turn state. While a turn is running the message is
        // DELIVERED INTO it — the agent decides whether it is an interruption —
        // rather than going through `submit`, which aborts the in-flight turn
        // on the same bucket and starts over.
        //
        // `chat.submitting` is the VISIBLE bucket's flag, and the composer that
        // produced this message is bound to the visible session, so it is the
        // right one to read. Getting the route wrong is not lossy either way:
        // a steer with no live turn falls back to a normal submit through the
        // pending-steer ledger.
        if (chat.submitting) {
          await chat.steer(text, payload)
        } else {
          await chat.submit(text, payload)
        }
      }
    },
    onCancel: async () => {
      chat.abort()
    },
  })

  return { runtime }
}

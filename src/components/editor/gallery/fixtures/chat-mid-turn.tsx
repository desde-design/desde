"use client"

import type { ReactNode } from "react"
import { EditorChatPanel } from "@/components/editor/editor-chat-panel"
import type { ChatMessage, UseEditorChatReturn } from "@/hooks/useEditorChat"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"

/**
 * The chat panel while a turn is streaming — the state
 * `tasks/chat-input-steering.md` exists to build.
 *
 * Before that work, the composer replaced Send with Stop the moment a turn
 * started (`ThreadPrimitive.If running` swapped one for the other in
 * editor-chat-panel.tsx) and `submit()` refused a second call on the same
 * session bucket (useEditorChat.ts's "concurrent submits on the same
 * session aren't supported"). So the only way to say anything else was to
 * cancel first. Mo, 2026-08-14: "We shouldn't block sending additional
 * messages on hitting the stop button."
 *
 * This fixture is the state that proves the fix: Send stays mounted next to
 * Stop, and the composer keeps accepting text — no cancel required.
 *
 * `chat.submitting: true` is the one flag this needs to set. It is the ONLY
 * source `useEditorChatRuntime` reads for `thread.isRunning`
 * (useEditorChatRuntime.ts:212), which is what keeps Stop mounted
 * (`ThreadPrimitive.If running` in editor-chat-panel.tsx) and, on a send
 * while it's true, routes through `chat.steer` instead of `chat.submit`
 * (`onNew`, same file). Everything else below is ordinary transcript data —
 * an edit the agent already applied, and a reply still mid-sentence.
 */

const MESSAGES: ChatMessage[] = [
  {
    kind: "user",
    id: "msg-user-1",
    text: "Can you make the pricing card CTA buttons a bit bigger and match the hero button's corner radius?",
  },
  {
    kind: "assistant",
    id: "msg-assistant-1",
    blocks: [
      {
        type: "tool_use",
        toolUseId: "tool-1",
        name: "Edit",
        input: {
          file_path: "src/components/PricingCard.vue",
          old_string: 'class="cta-button px-4 py-2 rounded-md"',
          new_string: 'class="cta-button px-5 py-2.5 rounded-lg"',
        },
        result: {
          ok: true,
          output: "Applied 1 edit to src/components/PricingCard.vue",
        },
      },
      {
        // No trailing punctuation — this block is still growing. Same
        // convention `save-progress.tsx`'s `streamingText` fixtures use: a
        // snapshot of a reply mid-stream, not a finished one.
        type: "text",
        text: "Bumped the CTA button padding, and I'm matching the corner radius to the hero button's 8px now, so",
      },
    ],
  },
]

/**
 * A fixed-size rail frame, not `InlineFrame`. `EditorChatPanel` is built on
 * `h-full` — it fills whatever height its real caller
 * (`editor-right-rail.tsx`'s chat `TabsContent`) gives it — and
 * `InlineFrame` sizes to its content with no declared height, so `h-full`
 * inside it would resolve against nothing and collapse to zero.
 * `activity-panel.tsx`'s `RailFrame` measured that exact failure for a
 * different rail panel and fixed it the same way: a fixed `h-[640px] w-80`.
 * `px-3` mirrors the real mount's `TabsContent` padding.
 */
function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="fixed left-4 top-4 z-40 h-[640px] w-80 overflow-hidden rounded-lg border border-border bg-background px-3 shadow-lg">
      {children}
    </div>
  )
}

/**
 * Every callback logs through `ctx` rather than doing nothing, so the
 * picker's Calls panel shows exactly what a click on Stop, or a submit from
 * the composer, would have invoked — same rationale as
 * `chat-pending-question.tsx`'s `resolve` passthrough.
 */
function buildChat(
  ctx: SurfaceRenderContext,
  overrides: Partial<UseEditorChatReturn> = {},
): UseEditorChatReturn {
  return {
    messages: MESSAGES,
    submitting: true,
    error: null,
    submit: async (text, images) => ctx.log("submit", text, images),
    steer: async (text, images) => ctx.log("steer", text, images),
    resendingSteers: [],
    abort: () => ctx.log("abort"),
    clearLocal: () => ctx.log("clearLocal"),
    dismissMessage: (id) => ctx.log("dismissMessage", id),
    hydrateFromTranscript: (turns, sessionId) =>
      ctx.log("hydrateFromTranscript", turns, sessionId),
    hasSessionBucket: () => false,
    modelConfig: null,
    setModelConfig: (config) => ctx.log("setModelConfig", config),
    seedModelConfig: (sessionId, config) =>
      ctx.log("seedModelConfig", sessionId, config),
    ...overrides,
  }
}

export const CHAT_MID_TURN_SURFACE: SurfaceEntry = {
  id: "chat-mid-turn",
  title: "Chat panel mid-turn",
  kind: "inline",
  sourceFile: "src/components/editor/editor-chat-panel.tsx",
  states: [
    {
      id: "chat-mid-turn/streaming",
      label: "Streaming reply — Send and Stop both live, input still open",
      render: (ctx) => (
        <PanelFrame>
          <EditorChatPanel chat={buildChat(ctx)} />
        </PanelFrame>
      ),
    },
    {
      /**
       * The recovery after a stopped turn, which used to be entirely silent.
       * Measured live: about 25 seconds of nothing while the ledger resubmitted
       * a steered message behind a still-held server turn lock — long enough
       * that the person watching concluded the message was lost.
       *
       * Two rows on purpose. The first is the common case (one attempt, no
       * number shown); the second has retried, which is the only condition
       * that surfaces an attempt count. `submitting: false` because this state
       * happens AFTER the turn ended.
       */
      id: "chat-mid-turn/resending-steer",
      label: "Resending a steered message after Stop",
      render: (ctx) => (
        <PanelFrame>
          <EditorChatPanel
            chat={buildChat(ctx, {
              submitting: false,
              resendingSteers: [
                {
                  id: "steer-1",
                  text: "Actually make it 12px, not 8px.",
                  attempt: 1,
                },
                {
                  id: "steer-2",
                  text: "And leave the hero button alone, I only meant the pricing cards on the marketing page.",
                  attempt: 3,
                },
              ],
            })}
          />
        </PanelFrame>
      ),
    },
  ],
}

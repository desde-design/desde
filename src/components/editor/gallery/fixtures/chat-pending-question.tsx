"use client"

import {
  ChatPendingQuestion,
  type PendingQuestion,
} from "@/components/editor/chat-pending-question"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { InlineFrame } from "./inline-frame"

/**
 * The card the agent's `ask_user_question` tool puts in front of the designer
 * mid-turn. It is a decision surface in the strictest sense — the turn is
 * blocked until it is answered — and it is hard to summon deliberately,
 * because reaching it means getting the agent to genuinely need a choice.
 *
 * `resolve` is the tool's own callback. The fixtures log through it rather
 * than dropping it, so the picker's Calls panel shows the exact shape the tool
 * receives (`{ ok: true, output: { selected } }`), which is as much a part of
 * this surface's design as the layout.
 */
function question(
  ctx: SurfaceRenderContext,
  over: Partial<PendingQuestion>,
): PendingQuestion {
  return {
    question: "Which spacing scale should the pricing cards use?",
    options: ["Compact (8px)", "Default (12px)", "Roomy (16px)"],
    multiSelect: false,
    resolve: (r) => ctx.log("resolve", r),
    ...over,
  }
}

function card(ctx: SurfaceRenderContext, pending: PendingQuestion) {
  return (
    <InlineFrame>
      <ChatPendingQuestion
        pending={pending}
        onAnswer={(selected) => ctx.log("onAnswer", selected)}
        onDismiss={() => ctx.log("onDismiss")}
      />
    </InlineFrame>
  )
}

export const CHAT_PENDING_QUESTION_SURFACE: SurfaceEntry = {
  id: "chat-pending-question",
  title: "Agent is asking a question",
  kind: "inline",
  sourceFile: "src/components/editor/chat-pending-question.tsx",
  states: [
    {
      id: "chat-pending-question/single-select",
      label: "Single select: three options",
      render: (ctx) => card(ctx, question(ctx, {})),
    },
    {
      id: "chat-pending-question/multi-select",
      label: "Multi select",
      render: (ctx) =>
        card(
          ctx,
          question(ctx, {
            question: "Which surfaces should get the new empty state?",
            options: ["Models list", "Gateways list", "Policies list", "Audit log"],
            multiSelect: true,
          }),
        ),
    },
    {
      id: "chat-pending-question/two-options",
      label: "Two options: the minimum a choice can be",
      render: (ctx) =>
        card(
          ctx,
          question(ctx, {
            question: "The rename touches 14 call sites. Apply everywhere, or just this one?",
            options: ["Apply to all 14", "This call site only"],
          }),
        ),
    },
    {
      id: "chat-pending-question/long-copy",
      label: "Long question and long options",
      render: (ctx) =>
        card(
          ctx,
          question(ctx, {
            question:
              "The design system ships two components that could render this row: KTableRow (sortable, virtualised, heavier) and KListRow (static, lighter, no sort affordance). Which should the pricing table use?",
            options: [
              "KTableRow, keeps sorting and virtualisation for long lists",
              "KListRow, lighter, but drops sorting entirely",
              "Neither, keep the hand-rolled markup for now",
            ],
          }),
        ),
    },
  ],
}

"use client"

import { ChatDisclosure, ChatToolStatus } from "@/components/editor/chat-disclosure"
import { DiffView } from "@/components/editor/diff-view"
import type { SurfaceEntry } from "../types"

/**
 * The chat transcript's collapsible rows — reasoning, tool calls, diffs.
 *
 * Added 2026-08-18 alongside the restructure that moved the header INSIDE the
 * card. The run of three exists specifically to review the fusing: adjacent
 * disclosures share one border and sit flush, so a sequence of tool calls
 * reads as one accordion rather than a stack of separately-bordered boxes.
 *
 * Nothing here is mocked behind a fetch — these are pure presentational
 * components taking strings.
 */

const BEFORE = `<button class="cta-button px-4 py-2 rounded-md">
  Start free trial
</button>`

const AFTER = `<button class="cta-button px-5 py-2.5 rounded-lg">
  Start free trial
</button>`

function Frame({ children }: { children: React.ReactNode }) {
  // The chat column's own width and ground, so the cards are reviewed at the
  // size they actually render — the fused border is a 1px decision and reads
  // differently stretched across a gallery frame.
  return <div className="w-full max-w-md bg-background p-3">{children}</div>
}

function DiffRow({ file, label }: { file: string; label?: string }) {
  const dir = file.slice(0, file.lastIndexOf("/") + 1)
  const base = file.slice(file.lastIndexOf("/") + 1)
  return (
    <ChatDisclosure
      defaultOpen
      data-testid="diff-card"
      label={
        <span className="font-mono">
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-semibold text-foreground">{base}</span>
        </span>
      }
      status={
        <span className="flex items-center gap-1.5">
          {label ? (
            <span className="rounded bg-muted px-1 py-px text-2xs text-muted-foreground">
              {label}
            </span>
          ) : null}
          <ChatToolStatus statusType="complete" />
        </span>
      }
    >
      <DiffView before={BEFORE} after={AFTER} className="max-h-60 overflow-auto" />
    </ChatDisclosure>
  )
}

export const CHAT_DISCLOSURE_SURFACE: SurfaceEntry = {
  id: "chat-disclosure",
  title: "Chat disclosures (header inside the card)",
  kind: "inline",
  sourceFile: "src/components/editor/chat-disclosure.tsx",
  states: [
    {
      id: "chat-disclosure/open",
      label: "One diff, open",
      readyWhen: '[data-testid="diff-card"]',
      render: () => (
        <Frame>
          <DiffRow file="src/components/PricingCard.vue" />
        </Frame>
      ),
    },
    {
      id: "chat-disclosure/closed",
      label: "One diff, collapsed",
      readyWhen: '[data-testid="diff-card"]',
      render: () => (
        <Frame>
          <ChatDisclosure
            data-testid="diff-card"
            label={<span className="font-mono">src/components/PricingCard.vue</span>}
            status={<ChatToolStatus statusType="complete" />}
          >
            <DiffView before={BEFORE} after={AFTER} />
          </ChatDisclosure>
        </Frame>
      ),
    },
    {
      id: "chat-disclosure/run",
      label: "Three in a row, fused",
      readyWhen: '[data-testid="diff-card"]',
      render: () => (
        <Frame>
          <DiffRow file="src/components/PricingCard.vue" label="edit" />
          <DiffRow file="src/components/PricingTable.vue" label="edit" />
          <DiffRow file="src/styles/pricing.css" label="write" />
        </Frame>
      ),
    },
    {
      id: "chat-disclosure/mixed",
      label: "Open and collapsed, mixed",
      readyWhen: '[data-testid="diff-card"]',
      render: () => (
        <Frame>
          <ChatDisclosure
            data-testid="diff-card"
            label={<span className="font-mono">grep</span>}
            status={<ChatToolStatus statusType="complete" />}
            bodyClassName="px-2 py-1.5 font-mono text-code leading-snug"
          >
            <pre className="whitespace-pre-wrap">no matches</pre>
          </ChatDisclosure>
          <DiffRow file="src/components/PricingCard.vue" label="edit" />
          <ChatDisclosure
            label={<span className="font-mono">read_file</span>}
            status={<ChatToolStatus statusType="running" />}
            bodyClassName="px-2 py-1.5 font-mono text-code leading-snug"
          >
            <pre className="whitespace-pre-wrap">…</pre>
          </ChatDisclosure>
        </Frame>
      ),
    },
  ],
}

"use client"

/**
 * Phase 2 of the assistant-ui chat migration.
 *
 * The assistant-ui transcript body — ThreadPrimitive composition adapted
 * from the Phase 0 spike (src/app/dev/assistant-ui-spike/thread.tsx) for
 * the rail's compact density ([11px]/[12px], tight padding).
 *
 * assistant-ui ships primitives only in 0.14.x (no ready-made <Thread>).
 * Composition verified against installed .d.ts in Phase 0:
 *   - ThreadPrimitive.Root / .Viewport / .Messages / .ScrollToBottom
 *   - MessagePrimitive.Root / .Content (Content = Parts)
 *   - MarkdownTextPrimitive reads text from the current message-part
 *     context — must be used as the Text slot of MessagePrimitive.Content
 *
 * Phase 2 follow-ups (polish):
 *   - Syntax highlighting via @assistant-ui/react-syntax-highlighter + one-dark theme
 *   - Copy-to-clipboard via MarkdownTextPrimitive components.CodeHeader slot
 *   - ScrollToBottom button repositioned to float above content (not overlap it)
 */

import { useState } from "react"
import {
  ThreadPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  useMessagePartText,
} from "@assistant-ui/react"
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown"
import { makePrismSyntaxHighlighter } from "@assistant-ui/react-syntax-highlighter/full"
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark"
import type { SyntaxHighlighterProps, CodeHeaderProps } from "@assistant-ui/react-markdown"
import { ChevronDown, Copy, Check } from "lucide-react"
import { AnimatedEllipsis } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  ChatDisclosure,
  chatDisclosureStatusClass,
  ChatToolStatus,
} from "@/components/editor/chat-disclosure"
import type { FC } from "react"

// ---------------------------------------------------------------------------
// Syntax highlighting — one-dark theme via @assistant-ui/react-syntax-highlighter
//
// makePrismSyntaxHighlighter wraps react-syntax-highlighter's Prism renderer,
// accepts any SyntaxHighlighterProps (minus language/children) as static config,
// and returns a ComponentType<SyntaxHighlighterProps> compatible with
// MarkdownTextPrimitive's components.SyntaxHighlighter slot.
//
// one-dark: neutral dark base (#282c34) — high token contrast on the rail's
// dark background. Tokens: keywords blue, strings green, comments grey.
// Background is overridden to match the panel's --muted to avoid a floating-box
// appearance; padding is set to match the rail's compact density.
// ---------------------------------------------------------------------------

const SyntaxHighlighter: FC<SyntaxHighlighterProps> = makePrismSyntaxHighlighter({
  style: oneDark,
  customStyle: {
    margin: 0,
    borderRadius: "0 0 6px 6px",
    fontSize: "11px",
    lineHeight: "1.5",
    // Override one-dark's background so it matches the panel's muted surface.
    // Tokens are bare color values (oklch) in this repo — use var() directly,
    // NOT hsl(var(--muted)) (that wraps a color in hsl() → invalid → ignored).
    background: "var(--muted)",
    padding: "8px 10px",
    // Soft border closes the card off from the surrounding prose so the block
    // reads as a deliberate inset rather than a floating slab.
    border: "1px solid var(--border)",
    borderTop: "none",
  },
  codeTagProps: {
    style: { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  },
})

// ---------------------------------------------------------------------------
// CodeHeader — language label + copy-to-clipboard button
//
// Renders as a compact strip above each fenced code block. Matches the
// rail's tight density (text-xs, h-6 strip).
// ---------------------------------------------------------------------------

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex items-center justify-between rounded-t-md border border-b-0 bg-muted px-2.5 py-1 text-code text-muted-foreground">
      <span className="font-mono">{language ?? "text"}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleCopy}
        aria-label="Copy code"
        className="gap-1"
      >
        {copied ? (
          <>
            <Check className="text-success" />
            <span className="text-success">copied</span>
          </>
        ) : (
          <>
            <Copy />
            <span>copy</span>
          </>
        )}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------

/**
 * Plain-text renderer for user messages — no markdown needed, just preserve
 * whitespace.
 */
const UserTextPart: FC = () => (
  <MessagePartPrimitive.Text className="whitespace-pre-wrap break-words" />
)

/**
 * Markdown renderer for assistant messages. MarkdownTextPrimitive reads
 * the current part's text from context — it must be the `Text` slot inside
 * MessagePrimitive.Content's part iteration.
 *
 * `smooth` enables the incremental-render mode that streams characters in
 * rather than re-flashing the whole block on each delta (important for the
 * rail's compact density to avoid visible layout churn).
 *
 * SyntaxHighlighter + CodeHeader slots add highlighted code blocks with
 * a copy button. Both are passed as `components` to MarkdownTextPrimitive;
 * the CodeHeader renders above each fenced block, SyntaxHighlighter below.
 */
const AssistantMarkdownPart: FC = () => {
  // A part with no text renders nothing, not an empty prose block. Such a
  // part between two tool rows would keep them from fusing and add two
  // margins where there should be none.
  const { text } = useMessagePartText()
  if (text.length === 0) return null
  return (
  <MarkdownTextPrimitive
    smooth
    // `text-base` is load-bearing, not decoration: `prose-sm` sets its own
    // 14px, which is off the ramp entirely and made the assistant's markdown
    // the only text in the app that answered to the typography plugin instead
    // of to us. The utility wins over the plugin's layer, and prose's spacing
    // is em-based, so the whole block rescales to 13px with it.
    className="prose prose-sm max-w-none break-words font-normal text-base [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-code [&_li]:leading-snug [&_p]:my-0 [&_p+p]:mt-2.5 [&_p]:leading-snug"
    components={{
      SyntaxHighlighter,
      CodeHeader,
    }}
  />
  )
}

// ---------------------------------------------------------------------------
// Reasoning (extended-thinking) part — a collapsible chain-of-thought
//
// Rendered via MessagePrimitive.Content's `Reasoning` slot. Always starts
// collapsed; the header still shows a pulsing "Thinking…" label while the model
// runs, so the activity stays visible without stealing vertical space from the
// answer. Clicking the header opens it. Styled muted/italic so it reads as
// secondary to the answer.
// ---------------------------------------------------------------------------

interface ReasoningPartProps {
  text: string
  status?: { type: "running" | "complete" | "incomplete" | "requires-action" }
}

const ReasoningPart: FC<ReasoningPartProps> = ({ text, status }) => {
  const isRunning = status?.type === "running"
  // Collapsed by default, running or not. Auto-opening while the model thought
  // pushed the actual answer off-screen mid-turn and then yanked it back on
  // completion. `null` = no explicit user choice yet, which now resolves to
  // closed; true/false = the user clicked the header.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? false

  return (
    <ChatDisclosure
      open={open}
      onOpenChange={setUserOpen}
      label={
        isRunning ? (
          <span>
            Thinking
            <AnimatedEllipsis />
          </span>
        ) : (
          <span>Reasoning</span>
        )
      }
      bodyClassName="whitespace-pre-wrap px-2 py-1.5 italic leading-snug text-muted-foreground/90"
    >
      {text}
    </ChatDisclosure>
  )
}

// ---------------------------------------------------------------------------
// Tool-call fallback row — ports V1's ToolCallRow
// ---------------------------------------------------------------------------

/**
 * Generic collapsible tool-call row. Receives render props from
 * MessagePrimitive.Content's `tools.Fallback` slot.
 *
 * The `toolName`, `args`, `result`, `isError`, `status` fields match the
 * shape verified in Phase 0 against 0.14.11 installed types.
 */
interface ToolFallbackProps {
  toolName: string
  args: Record<string, unknown>
  result?: unknown
  isError?: boolean
  status: { type: "running" | "complete" | "incomplete" | "requires-action" }
  argsText?: string
}

/**
 * Turn an image content block into a renderable `data:` URL. Handles both the
 * MCP shape a editor tool returns (`{ data: <base64>, mimeType }`, base64
 * WITHOUT the `data:` prefix — see `capture_screenshot`) and the Anthropic
 * message shape the SDK may echo (`{ source: { type: "base64", media_type,
 * data } }`). A value already carrying a `data:` prefix is passed through.
 */
function imageBlockToDataUrl(block: unknown): string | null {
  if (!block || typeof block !== "object") return null
  const b = block as {
    data?: unknown
    mimeType?: unknown
    source?: { type?: unknown; media_type?: unknown; data?: unknown }
  }
  const encode = (data: string, mime: string) =>
    data.startsWith("data:") ? data : `data:${mime};base64,${data}`

  if (typeof b.data === "string") {
    return encode(b.data, typeof b.mimeType === "string" ? b.mimeType : "image/png")
  }
  const src = b.source
  if (src && typeof src.data === "string") {
    return encode(
      src.data,
      typeof src.media_type === "string" ? src.media_type : "image/png",
    )
  }
  return null
}

/**
 * Split a tool result into inline-renderable images plus the leftover
 * (non-image) output. Tools like `capture_screenshot` return an MCP content
 * array `[{ type: "text" }, { type: "image", … }]`; dumping that through
 * JSON.stringify spills a base64 blob into the transcript instead of showing
 * the screenshot. When no image block is present, `rest` is the original
 * result so every other tool renders exactly as before.
 */
function partitionToolResult(result: unknown): {
  images: string[]
  rest: unknown
} {
  const blocks = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : null
  if (!blocks) return { images: [], rest: result }

  const images: string[] = []
  const rest: unknown[] = []
  for (const block of blocks) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const url = imageBlockToDataUrl(block)
      if (url) {
        images.push(url)
        continue
      }
    }
    rest.push(block)
  }
  if (images.length === 0) return { images: [], rest: result }
  return { images, rest }
}

/** Render the non-image remainder of a tool result as plain text. */
function toolResultText(rest: unknown): string {
  if (typeof rest === "string") return rest
  if (Array.isArray(rest)) {
    return rest
      .map((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : JSON.stringify(block, null, 2),
      )
      .join("\n")
  }
  return JSON.stringify(rest, null, 2)
}

function ToolFallback({ toolName, args, result, isError, status }: ToolFallbackProps) {
  const hasError = isError || status.type === "incomplete"
  const { images, rest } = partitionToolResult(result)
  const restText = images.length > 0 ? toolResultText(rest) : null

  return (
    <ChatDisclosure
      label={
        <span className={cn("font-mono", chatDisclosureStatusClass(isError))}>
          {toolName}
        </span>
      }
      status={<ChatToolStatus statusType={status.type} isError={isError} />}
      bodyClassName="px-2 py-1.5 font-mono text-code leading-snug"
    >
      <div className="mb-1 text-muted-foreground">input</div>
      <pre className="mb-2 whitespace-pre-wrap break-all">
        {JSON.stringify(args, null, 2)}
      </pre>
      {result !== undefined ? (
        <>
          <div className="mb-1 text-muted-foreground">
            {hasError ? "error" : "output"}
          </div>
          {images.length > 0 ? (
            <>
              {images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt="Tool screenshot"
                  className="mb-2 max-h-80 max-w-full rounded border"
                />
              ))}
              {restText ? (
                <pre className="whitespace-pre-wrap break-all">{restText}</pre>
              ) : null}
            </>
          ) : (
            <pre className="whitespace-pre-wrap break-all">
              {typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)}
            </pre>
          )}
        </>
      ) : null}
    </ChatDisclosure>
  )
}

// ---------------------------------------------------------------------------
// Per-role message components
// ---------------------------------------------------------------------------

/**
 * User message — right-aligned bubble with a faint `bg-primary/8` tint so
 * "you vs. agent" stays color-coded without a heavy fill.
 */
const UserMessage: FC = () => (
  <MessagePrimitive.Root className="mb-3 flex justify-end">
    <div className="max-w-[88%] break-words rounded-lg bg-primary/8 px-3 py-1.5 text-base font-normal leading-snug text-foreground">
      <MessagePrimitive.Content
        components={{
          Text: UserTextPart,
        }}
      />
    </div>
  </MessagePrimitive.Root>
)

/**
 * Assistant message — markdown body. Tool-call rows are handled by the
 * Fallback slot (makeAssistantToolUI registrations are also picked up
 * automatically via context).
 */
const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="mb-3 flex">
    <div className="min-w-0 flex-1 space-y-3 text-base font-normal">
      <MessagePrimitive.Content
        components={{
          Text: AssistantMarkdownPart,
          Reasoning: ReasoningPart as FC,
          tools: {
            Fallback: ToolFallback as FC,
          },
        }}
      />
    </div>
  </MessagePrimitive.Root>
)

/**
 * Working indicator — the in-thread "agent is doing something" row, rendered
 * via `ThreadPrimitive.If running` so it sits directly under the last message
 * inside the scroll viewport (the old indicator floated below the viewport and
 * read as absent). Animated bouncing dots + a live phase label (`label`,
 * derived from the latest in-flight tool by the panel) make "is it frozen?"
 * legible as "it's working, and here's on what".
 */
const WorkingIndicator: FC<{ label?: string }> = ({ label }) => (
  <div className="mb-3 flex" data-testid="editor-chat-working">
    {/*
      No spinner (Mo, 2026-08-18). The animated dots ARE the activity, and a
      spinner beside them was a second object saying the same thing.

      `label` is the live phase (the in-flight tool name) when there is one, and
      it arrives already complete — only the default gets dots appended, since
      "Reading src/App.vue…" is a sentence and "Reading src/App.vue..." with
      three pulsing dots after it is not.
    */}
    <div className="flex items-center text-sm text-muted-foreground">
      {label ? (
        <span>{label}</span>
      ) : (
        <span>
          Thinking
          <AnimatedEllipsis />
        </span>
      )}
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

/**
 * The assistant-ui transcript body. Wrap in `<AssistantRuntimeProvider>`
 * before mounting — this component reads the runtime from context.
 *
 * Layout:
 *   ThreadPrimitive.Root (flex col, fills parent, relative)
 *     └── ThreadPrimitive.Viewport (overflow-auto, fills available space, pb-8 for button clearance)
 *           └── ThreadPrimitive.Messages (renders UserMessage / AssistantMessage per role)
 *     └── ThreadPrimitive.ScrollToBottom (absolute bottom-center icon button, floats above content)
 *
 * ScrollToBottom: a compact circular icon button anchored bottom-center
 * (absolute, z-10, solid bg + subtle shadow), with pb-8 on the Viewport for
 * clearance. The solid background makes it read as a deliberate control when it
 * floats over the transcript mid-scroll. assistant-ui hides it at the bottom.
 */
export const EditorChatThread: FC<{ workingLabel?: string }> = ({
  workingLabel,
}) => (
  <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col">
    {/* pb-8 reserves clearance below the last message so ScrollToBottom never overlaps text */}
    <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto py-2 pb-8">
      <ThreadPrimitive.Messages
        components={{
          UserMessage,
          AssistantMessage,
        }}
      />
      {/* Working indicator — only while the runtime is running (isRunning =
          chat.submitting). Lives inside the viewport so it pins under the last
          message and scrolls with the transcript. */}
      <ThreadPrimitive.If running>
        <WorkingIndicator label={workingLabel} />
      </ThreadPrimitive.If>
    </ThreadPrimitive.Viewport>

    {/* Scroll-to-bottom affordance — a compact circular icon button anchored
        bottom-center with a solid background + subtle shadow, so when it floats
        over the transcript mid-scroll it reads as a deliberate control rather than
        a pill dropped onto a sentence. assistant-ui hides it at the bottom. */}
    <ThreadPrimitive.ScrollToBottom
      aria-label="Scroll to latest"
      className="absolute bottom-2 left-1/2 z-10 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:bg-muted"
    >
      <ChevronDown className="h-3.5 w-3.5" />
    </ThreadPrimitive.ScrollToBottom>
  </ThreadPrimitive.Root>
)

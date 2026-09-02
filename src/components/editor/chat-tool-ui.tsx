"use client"

/**
 * makeAssistantToolUI registrations for the `Edit` and `Write` built-in
 * Claude Code tools. These render agent edit proposals as inline diffs
 * in the chat transcript, replacing the generic `ToolFallback` JSON
 * dump for those two tools.
 *
 * Architecture:
 *   - `EditToolUI`  — toolName "Edit"  — old_string → new_string diff
 *   - `WriteToolUI` — toolName "Write" — new-file content as all-added diff
 *
 * Both are mounted inside `<AssistantRuntimeProvider>` in
 * `editor-chat-panel.tsx` and render null — the `makeAssistantToolUI`
 * pattern registers the renderer via context; the actual card renders in
 * place of `ToolFallback` whenever a matching toolName appears.
 *
 * All other tools (get_selection, ask_user_question, …) continue to use
 * the generic `ToolFallback` defined in chat-thread.tsx.
 *
 * DiffView API: `before: string, after: string, caption?: string, className?: string`
 * For Write, before="" (empty) renders the content as all-added lines.
 * Collapsing: default collapsed when the diff exceeds COLLAPSE_THRESHOLD lines;
 * a "show diff / hide diff" toggle expands/collapses in place.
 */

import { makeAssistantToolUI } from "@assistant-ui/react"
import {
  ChatDisclosure,
  chatDisclosureStatusClass,
  ChatToolStatus,
} from "@/components/editor/chat-disclosure"
import { DiffView } from "@/components/editor/diff-view"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lines above which the diff defaults to collapsed. */
const COLLAPSE_THRESHOLD = 8

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the basename from a file path (e.g. "src/App.vue" → "App.vue"). */
function basename(filePath: string): string {
  return filePath.split("/").pop() ?? filePath
}

/** Directory portion of path for the compact label (e.g. "src/App.vue" → "src/"). */
function dirPart(filePath: string): string {
  const parts = filePath.split("/")
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/") + "/"
}

/** Count the number of lines that are added or removed in a diff body. */
function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  // Rough upper-bound: max of the two sides. The actual diff may be fewer,
  // but for the collapse threshold this is cheap and conservative.
  return Math.max(beforeLines.length, afterLines.length)
}

// ---------------------------------------------------------------------------
// Shared card layout
// ---------------------------------------------------------------------------

interface DiffCardProps {
  filePath: string
  before: string
  after: string
  statusType: string
  isError?: boolean
  label?: string // e.g. "new file" for Write
}

function DiffCard({ filePath, before, after, statusType, isError, label }: DiffCardProps) {
  const lineCount = countChangedLines(before, after)
  const defaultCollapsed = lineCount > COLLAPSE_THRESHOLD

  return (
    <ChatDisclosure
      defaultOpen={!defaultCollapsed}
      data-testid="diff-card"
      label={
        // Failure is the label going red, not a glyph beside it. The whole
        // path turns, dir and basename together — a red basename after a
        // muted directory reads as a highlight on the filename rather than a
        // state for the row.
        <span className={cn("font-mono", chatDisclosureStatusClass(isError))}>
          {isError ? (
            <>
              {dirPart(filePath)}
              <span className="font-semibold">{basename(filePath)}</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">{dirPart(filePath)}</span>
              <span className="font-semibold text-foreground">
                {basename(filePath)}
              </span>
            </>
          )}
        </span>
      }
      status={
        <span className="flex items-center gap-1.5">
          {label ? (
            <span className="rounded bg-muted px-1 py-px text-2xs text-muted-foreground">
              {label}
            </span>
          ) : null}
          <ChatToolStatus statusType={statusType} isError={isError} />
        </span>
      }
    >
      <DiffView
        before={before}
        after={after}
        className="max-h-60 overflow-auto"
      />
    </ChatDisclosure>
  )
}

// ---------------------------------------------------------------------------
// Tool input shapes (Claude Code built-in tools)
// ---------------------------------------------------------------------------

interface EditArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface WriteArgs {
  file_path: string
  content: string
}

// ---------------------------------------------------------------------------
// EditToolUI — toolName "Edit"
// ---------------------------------------------------------------------------

export const EditToolUI = makeAssistantToolUI<EditArgs, unknown>({
  toolName: "Edit",
  render: ({ args, status, isError }) => {
    const filePath = args?.file_path ?? ""
    const before = args?.old_string ?? ""
    const after = args?.new_string ?? ""

    return (
      <DiffCard
        filePath={filePath}
        before={before}
        after={after}
        statusType={status.type}
        isError={isError}
      />
    )
  },
})

// ---------------------------------------------------------------------------
// WriteToolUI — toolName "Write"
// ---------------------------------------------------------------------------

export const WriteToolUI = makeAssistantToolUI<WriteArgs, unknown>({
  toolName: "Write",
  render: ({ args, status, isError }) => {
    const filePath = args?.file_path ?? ""
    // Write creates/overwrites a whole file: show content as all-added diff.
    const content = args?.content ?? ""

    return (
      <DiffCard
        filePath={filePath}
        before=""
        after={content}
        statusType={status.type}
        isError={isError}
        label="new file"
      />
    )
  },
})

"use client"

/**
 * Chat-session switcher — a compact bar with a "recents" menu and a
 * "New chat" button. Replaces the horizontal tab strip
 * (`chat-session-tabs.tsx`): tabs didn't scale past a handful of sessions
 * and competed with the page/selection chips for rail width.
 *
 * Layout:
 *   [⌥ recents (N) •] ............................ [+ New]
 *
 *   - The recents button (MessageCircleMore) carries a count of all chats
 *     and a status dot when any chat is in-flight (pending) or has an
 *     error/conflict. Clicking it opens a Claude-recents-style list to
 *     switch chats (the active chat is highlighted there).
 *   - "+ New" starts a fresh detached session.
 *
 * Gating: `actionsDisabled` (a turn is streaming) disables "+ New" and the
 * list items so a prior stream can't write into a switched-away UI.
 *
 * THE CURRENT CHAT IS ALWAYS A ROW, even before it exists on disk.
 * Opening a project mints a session id, and a minted session has no file
 * until its first turn, so it is absent from `sessions`. Rendering only
 * the persisted rows left the list with nothing marked current and a
 * count that excluded the chat the user was sitting in — a list that
 * disagrees with the pane in front of it. So when `currentSessionId`
 * names no row, one is synthesised at the top, labelled and marked as
 * the current chat, and the count includes it. The alternative (leave it
 * out and let the count mean "saved chats") reads as a bug every time,
 * because the user has no way to know the distinction the count is
 * drawing. The row is derived, not a prop: "is the current id in the
 * listing?" is the whole question, and the caller already passes both
 * halves of it.
 */

import { MessageCircleMore, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Eyebrow, StatusDot } from "@/components/blocks"
import { cn } from "@/lib/utils"
import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"

export interface ChatSessionMenuProps {
  sessions: ChatSessionSummary[]
  /** null means "next submit mints a fresh sessionId". */
  currentSessionId: string | null
  onSelectSession: (summary: ChatSessionSummary) => void
  onNewSession: () => void
  /**
   * Disable mutators (switch chat, + New) while a turn is streaming so
   * the prior stream can't write into a cleared UI. The recents list
   * still opens for viewing; its items no-op.
   */
  actionsDisabled?: boolean
  actionsDisabledReason?: string
  className?: string
}

export function ChatSessionMenu({
  sessions,
  currentSessionId,
  onSelectSession,
  onNewSession,
  actionsDisabled,
  actionsDisabledReason,
  className,
}: ChatSessionMenuProps) {
  const status = aggregateStatus(sessions)
  const disabledTitle = actionsDisabled ? actionsDisabledReason : undefined
  // The current chat has no file on disk until its first turn, so it is
  // missing from `sessions` on every fresh open. See the header note.
  const currentIsUnsaved =
    currentSessionId !== null &&
    !sessions.some((s) => s.sessionId === currentSessionId)
  const totalCount = sessions.length + (currentIsUnsaved ? 1 : 0)

  return (
    <div
      className={cn(
        "flex h-9 min-h-9 shrink-0 items-center gap-1 bg-muted/10",
        className,
      )}
      data-testid="chat-session-menu"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="relative shrink-0 gap-1 px-1.5 text-muted-foreground"
            disabled={totalCount === 0}
            aria-label={`Chat history (${totalCount})`}
            title="Chat history"
            data-testid="chat-session-menu-trigger"
          >
            <MessageCircleMore className="h-4 w-4" />
            <span
              className="text-xs tabular-nums"
              data-testid="chat-session-menu-count"
            >
              {totalCount}
            </span>
            {status ? (
              <StatusDot
                tone={status === "error" ? "destructive" : "info"}
                size="sm"
                pulse={status !== "error"}
                className="absolute right-0.5 top-0.5"
                data-testid="chat-session-menu-status"
                data-status={status}
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 p-1">
          <DropdownMenuLabel className="px-2 py-1">
            <Eyebrow as="span" size="sm">
              Recents
            </Eyebrow>
          </DropdownMenuLabel>
          <div className="max-h-80 overflow-y-auto">
            {currentIsUnsaved ? (
              <DropdownMenuItem
                disabled={actionsDisabled}
                onSelect={() => {}}
                className="flex items-center gap-2 bg-accent"
                data-current
                data-testid="chat-session-item-unsaved"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">
                    New chat
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    Not saved yet
                  </div>
                </div>
              </DropdownMenuItem>
            ) : null}
            {sessions.map((s) => {
              const isCurrent = s.sessionId === currentSessionId
              const inFlight = s.status === "in-flight"
              const failed = s.status === "failed"
              const conflicts = s.conflictCount ?? 0
              return (
                <DropdownMenuItem
                  key={s.sessionId}
                  disabled={actionsDisabled}
                  onSelect={() => {
                    if (!isCurrent && !actionsDisabled) onSelectSession(s)
                  }}
                  className={cn("flex items-center gap-2", isCurrent && "bg-accent")}
                  data-current={isCurrent || undefined}
                  data-testid={`chat-session-item-${s.sessionId}`}
                >
                  {inFlight ? (
                    <StatusDot
                      tone="info"
                      size="sm"
                      pulse
                      className="shrink-0"
                      aria-hidden={false}
                      aria-label="In flight"
                      data-testid={`chat-session-item-${s.sessionId}-inflight`}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {formatSessionLabel(s)}
                    </div>
                    <div className="text-2xs text-muted-foreground">
                      {relativeTime(s.updatedAt)}
                    </div>
                  </div>
                  {failed ? (
                    <Badge variant="destructive" className="shrink-0">
                      Failed
                    </Badge>
                  ) : null}
                  {conflicts > 0 ? (
                    <Badge
                      variant="destructive"
                      className="shrink-0"
                      data-testid={`chat-session-item-${s.sessionId}-conflicts`}
                    >
                      {conflicts}
                    </Badge>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0 gap-1 text-muted-foreground"
        onClick={() => {
          if (!actionsDisabled) onNewSession()
        }}
        disabled={actionsDisabled}
        title={disabledTitle ?? "Start a new chat"}
        data-testid="chat-session-new"
      >
        <Plus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">New</span>
      </Button>
    </div>
  )
}

/**
 * Row / current-title label: the first user message preview, falling back to
 * the last message preview, then a stable `Session <prefix>`. Overflow is
 * handled by CSS truncation at the call site, so no manual slicing here.
 */
export function formatSessionLabel(summary: ChatSessionSummary): string {
  return (
    summary.firstUserMessagePreview?.trim() ||
    summary.lastUserMessagePreview?.trim() ||
    `Session ${summary.sessionId.slice(0, 6)}`
  )
}

/**
 * Aggregate status across all chats for the recents-button dot. Error
 * (a failed turn or unresolved conflicts) outranks pending (in-flight);
 * returns null when every chat is idle.
 */
export function aggregateStatus(
  sessions: ChatSessionSummary[],
): "error" | "pending" | null {
  let pending = false
  for (const s of sessions) {
    if (s.status === "failed" || (s.conflictCount ?? 0) > 0) return "error"
    if (s.status === "in-flight") pending = true
  }
  return pending ? "pending" : null
}

/** Compact relative time ("just now", "5m ago", "yesterday", "Mar 4"). */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ""
  const deltaSec = Math.round((Date.now() - then) / 1000)
  if (deltaSec < 45) return "just now"
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`
  const days = Math.floor(deltaSec / 86400)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

// Faithful inline DropdownMenu (content always rendered) — Radix's
// portal-based menu only mounts its content on open, and it does not open
// reliably under jsdom's fireEvent (it wants real pointer-capture) with no
// @testing-library/user-event in this repo. Same stand-in as
// model-picker-chip.test.tsx. The row logic under test is ours.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
    [key: string]: unknown
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      {...rest}
    >
      {children}
    </div>
  ),
}))

import {
  ChatSessionMenu,
  aggregateStatus,
  formatSessionLabel,
  relativeTime,
} from "./chat-session-menu"
import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<ChatSessionSummary> = {},
): ChatSessionSummary {
  return {
    sessionId: "s1",
    projectId: "p1",
    createdAt: "2026-06-30T11:00:00.000Z",
    updatedAt: "2026-06-30T11:00:00.000Z",
    turnCount: 1,
    firstUserMessagePreview: "First chat",
    ...overrides,
  }
}

// The bar (title, New, recents trigger, status dot) renders always; the
// list renders through the dropdown stand-in above. The label/status
// helpers are also covered directly as pure functions below.

describe("ChatSessionMenu — bar", () => {
  it("renders the chat count on the recents trigger", () => {
    render(
      <ChatSessionMenu
        sessions={[
          makeSession({ sessionId: "s1" }),
          makeSession({ sessionId: "s2" }),
          makeSession({ sessionId: "s3" }),
        ]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByTestId("chat-session-menu-count")).toHaveTextContent("3")
  })

  it("calls onNewSession when + New is clicked", () => {
    const onNewSession = vi.fn()
    render(
      <ChatSessionMenu
        sessions={[makeSession()]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={onNewSession}
      />,
    )
    fireEvent.click(screen.getByTestId("chat-session-new"))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it("disables + New and suppresses onNewSession when actionsDisabled", () => {
    const onNewSession = vi.fn()
    render(
      <ChatSessionMenu
        sessions={[makeSession()]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={onNewSession}
        actionsDisabled
        actionsDisabledReason="A turn is running"
      />,
    )
    const newBtn = screen.getByTestId("chat-session-new")
    expect(newBtn).toBeDisabled()
    fireEvent.click(newBtn)
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it("disables the recents trigger when there are no chats", () => {
    render(
      <ChatSessionMenu
        sessions={[]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByTestId("chat-session-menu-trigger")).toBeDisabled()
  })

  // ── The chat the user is in is always in the list ───────────────────
  //
  // A freshly minted chat has no file on disk until its first turn, so
  // it is absent from `sessions`. Rendering only the saved rows left the
  // list with nothing marked current and a count that excluded the chat
  // the user was looking at.

  it("counts the current chat even before it has been saved", () => {
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1" })]}
        currentSessionId="minted-1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByTestId("chat-session-menu-count")).toHaveTextContent("2")
    expect(
      screen.getByTestId("chat-session-menu-trigger"),
    ).toHaveAccessibleName("Chat history (2)")
  })

  it("shows the unsaved current chat as a row and marks it current", () => {
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1" })]}
        currentSessionId="minted-1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    const row = screen.getByTestId("chat-session-item-unsaved")
    expect(row).toHaveAttribute("data-current", "true")
    expect(row).toHaveTextContent("New chat")
    expect(row).toHaveTextContent("Not saved yet")
    // And the saved row is not the current one.
    expect(screen.getByTestId("chat-session-item-s1")).not.toHaveAttribute(
      "data-current",
    )
  })

  it("opens the list for a project whose only chat is the unsaved one", () => {
    render(
      <ChatSessionMenu
        sessions={[]}
        currentSessionId="minted-1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByTestId("chat-session-menu-trigger")).not.toBeDisabled()
    expect(screen.getByTestId("chat-session-menu-count")).toHaveTextContent("1")
    expect(
      screen.getByTestId("chat-session-item-unsaved"),
    ).toBeInTheDocument()
  })

  it("adds no extra row once the current chat has been saved", () => {
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1" })]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.getByTestId("chat-session-menu-count")).toHaveTextContent("1")
    expect(screen.queryByTestId("chat-session-item-unsaved")).toBeNull()
    expect(screen.getByTestId("chat-session-item-s1")).toHaveAttribute(
      "data-current",
      "true",
    )
  })

  it("does not switch chats when the current row is clicked", () => {
    const onSelectSession = vi.fn()
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1" })]}
        currentSessionId="minted-1"
        onSelectSession={onSelectSession}
        onNewSession={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("chat-session-item-unsaved"))
    expect(onSelectSession).not.toHaveBeenCalled()
    // A different row still switches.
    fireEvent.click(screen.getByTestId("chat-session-item-s1"))
    expect(onSelectSession).toHaveBeenCalledTimes(1)
  })

  it("shows a destructive status dot when any chat has an error/conflict", () => {
    render(
      <ChatSessionMenu
        sessions={[
          makeSession({ sessionId: "s1" }),
          makeSession({ sessionId: "s2", conflictCount: 2 }),
        ]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    const dot = screen.getByTestId("chat-session-menu-status")
    expect(dot).toHaveAttribute("data-status", "error")
    expect(dot).toHaveClass("bg-destructive")
  })

  it("shows a pending status dot when a chat is in-flight (and none errored)", () => {
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1", status: "in-flight" })]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    const dot = screen.getByTestId("chat-session-menu-status")
    expect(dot).toHaveAttribute("data-status", "pending")
    expect(dot).toHaveClass("bg-info")
  })

  it("renders no status dot when every chat is idle", () => {
    render(
      <ChatSessionMenu
        sessions={[makeSession({ sessionId: "s1", status: "idle" })]}
        currentSessionId="s1"
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("chat-session-menu-status")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("formatSessionLabel", () => {
  it("prefers the first user message preview", () => {
    expect(
      formatSessionLabel(
        makeSession({
          firstUserMessagePreview: "Make the button bigger",
          lastUserMessagePreview: "later message",
        }),
      ),
    ).toBe("Make the button bigger")
  })

  it("falls back to the last message preview, then a stable session prefix", () => {
    expect(
      formatSessionLabel(
        makeSession({
          firstUserMessagePreview: undefined,
          lastUserMessagePreview: "only this",
        }),
      ),
    ).toBe("only this")
    expect(
      formatSessionLabel(
        makeSession({
          sessionId: "abcd1234-5678",
          firstUserMessagePreview: undefined,
          lastUserMessagePreview: undefined,
        }),
      ),
    ).toBe("Session abcd12")
  })
})

describe("aggregateStatus", () => {
  it("returns 'error' when any session failed or has conflicts (outranks pending)", () => {
    expect(
      aggregateStatus([
        makeSession({ sessionId: "a", status: "in-flight" }),
        makeSession({ sessionId: "b", status: "failed" }),
      ]),
    ).toBe("error")
    expect(
      aggregateStatus([makeSession({ sessionId: "c", conflictCount: 1 })]),
    ).toBe("error")
  })

  it("returns 'pending' when a session is in-flight and none errored", () => {
    expect(
      aggregateStatus([makeSession({ sessionId: "a", status: "in-flight" })]),
    ).toBe("pending")
  })

  it("returns null when all sessions are idle", () => {
    expect(
      aggregateStatus([
        makeSession({ sessionId: "a", status: "idle" }),
        makeSession({ sessionId: "b" }),
      ]),
    ).toBeNull()
  })
})

describe("relativeTime", () => {
  it("renders recent timestamps as 'just now' / minutes / hours", () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 10_000).toISOString())).toBe("just now")
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe(
      "5m ago",
    )
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe(
      "3h ago",
    )
  })

  it("renders a day ago as 'yesterday' and older as 'Nd ago'", () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 86_400_000).toISOString())).toBe(
      "yesterday",
    )
    expect(relativeTime(new Date(now - 3 * 86_400_000).toISOString())).toBe(
      "3d ago",
    )
  })

  it("returns an empty string for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date")).toBe("")
  })
})

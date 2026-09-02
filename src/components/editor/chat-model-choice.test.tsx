/**
 * The model choice has to survive closing and reopening the project.
 *
 * Why this suite exists as a separate file: the pieces that make the
 * choice survive are split across three units that each look correct on
 * their own. `useChatSessions` mints a session on open, so the chat the
 * user lands in has no persisted choice. `ModelPickerChip` adopts the
 * project's last chosen model for exactly that case. `useEditorChat`
 * pins the visible bucket's choice onto the turn it sends. A unit test
 * of any one of them passes while the chain is broken, which is how a
 * fix that never worked in production shipped twice.
 *
 * So this runs the REAL hooks and the REAL chip against a small
 * in-memory stand-in for the CLI, and asserts on what the client would
 * actually put on the wire. The stand-in never invents a model: the only
 * way `lastChosenModel` becomes non-null is a turn that production code
 * sent with one. A test fixture that hands the answer in is precisely
 * what made the previous fix look closed.
 *
 * The wiring in `Harness` mirrors `editor-right-rail.tsx`. The rail's
 * own suite pins that it passes these props; this one pins what happens
 * when it does.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, useContext, type ReactNode } from "react"

import { useChatSessions } from "@/hooks/useChatSessions"
import { useEditorChat } from "@/hooks/useEditorChat"
import type { SessionModelConfig } from "@/editor/core/model-catalog"

/**
 * Stand-in for the CLI, holding the state the CLI holds on disk.
 *
 * `vi.hoisted` because the `editorFetch` mock factory below is hoisted
 * above the imports, and because it must survive the `vi.resetModules()`
 * that stands in for a page reload — the mock is re-created, the server
 * behind it is not.
 */
const server = vi.hoisted(() => {
  /** One record per saved chat session, in save order (newest last). */
  const saved: { sessionId: string; modelConfig: unknown }[] = []
  /** Every POST body the client sent, for wire-level assertions. */
  const posted: Record<string, unknown>[] = []

  const CATALOGS = [
    {
      providerId: "anthropic",
      models: [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          effortLevels: ["low", "medium", "high"],
          isDefault: true,
        },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", effortLevels: null },
      ],
    },
  ]

  function save(sessionId: string, modelConfig: unknown): void {
    const existing = saved.findIndex((s) => s.sessionId === sessionId)
    if (existing >= 0) saved.splice(existing, 1)
    saved.push({ sessionId, modelConfig })
  }

  function json(body: unknown) {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  return {
    saved,
    posted,
    reset(): void {
      saved.length = 0
      posted.length = 0
    },
    /** Seed a chat that already exists on disk, as a prior run would leave it. */
    seed: save,
    async handle(url: string, init?: RequestInit): Promise<Response> {
      if (url === "/api/editor/chat/sessions") {
        return json({
          ok: true,
          // The CLI lists most-recently-touched first.
          sessions: [...saved].reverse().map((s, i) => ({
            sessionId: s.sessionId,
            projectId: "p",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: `2026-08-${String(20 - i).padStart(2, "0")}T00:00:00.000Z`,
            turnCount: 1,
          })),
        })
      }
      if (url === "/api/editor/chat/model-catalog") {
        // The same rule the CLI's model-catalog-handler applies: the
        // newest saved chat that carries a choice. Derived from what
        // the client sent, never from a literal in a test.
        const withChoice = [...saved].reverse().find((s) => s.modelConfig)
        return json({
          catalogs: CATALOGS,
          default: { provider: "anthropic", model: "claude-opus-4-8" },
          lastChosenModel: withChoice?.modelConfig ?? null,
        })
      }
      if (url === "/api/editor/chat") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >
        posted.push(body)
        save(String(body.sessionId), body.modelConfig ?? null)
        // A turn that streams nothing still closes the loop the hook
        // cares about: the stream ends and `onStreamComplete` fires.
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
        } as unknown as Response
      }
      // Transcript fetches (tab-switch hydration) — no turns.
      return json({ ok: true, session: { turns: [] } })
    },
  }
})

vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (url: string, init?: RequestInit) => server.handle(url, init),
}))

// Radix's DropdownMenu doesn't open under jsdom's fireEvent (it needs real
// pointer-capture semantics) and this repo has no @testing-library/user-event.
// Same faithful inline stand-in as model-picker-chip.test.tsx: content always
// rendered, radio groups wired through context. The behaviour under test is
// ours, not Radix's.
const RadioGroupContext = createContext<{
  value: string
  onValueChange: (value: string) => void
} | null>(null)

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
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuRadioGroup: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      {children}
    </RadioGroupContext.Provider>
  ),
  DropdownMenuRadioItem: ({
    value,
    children,
    ...rest
  }: {
    value: string
    children: ReactNode
    [key: string]: unknown
  }) => {
    const Item = () => {
      const ctx = useContext(RadioGroupContext)
      return (
        <div
          role="menuitemradio"
          aria-checked={ctx?.value === value}
          onClick={() => ctx?.onValueChange(value)}
          {...rest}
        >
          {children}
        </div>
      )
    }
    return <Item />
  },
}))

type ChatApi = ReturnType<typeof useEditorChat>
type SessionsApi = ReturnType<typeof useChatSessions>

/** Live handles onto the hooks, refreshed on every render. */
const live: { chat: ChatApi | null; sessions: SessionsApi | null } = {
  chat: null,
  sessions: null,
}

/**
 * Build the harness against a specific chip module. The chip caches its
 * catalog at module scope, so "reopen the project" means importing it
 * fresh — exactly what a page reload does to it.
 */
function makeHarness(
  ModelPickerChip: typeof import("./model-picker-chip").ModelPickerChip,
) {
  return function Harness() {
    const chatSessions = useChatSessions({ enabled: true })
    const chat = useEditorChat({
      bridgeHandlers: {},
      getChatSessionId: chatSessions.getChatSessionId,
      getVisibleSessionId: () => chatSessions.currentSessionId,
      onSessionEvent: chatSessions.onSessionEvent,
      onStreamComplete: chatSessions.onStreamComplete,
    })
    live.chat = chat
    live.sessions = chatSessions

    // Verbatim shape of editor-right-rail.tsx's `seedLastChosenModel`:
    // a seed-only writer, named to the exact session, and only for a
    // session this client minted.
    const id = chatSessions.currentSessionId
    const seed =
      chatSessions.enabled && chatSessions.currentSessionIsNew && id !== null
        ? (config: SessionModelConfig) => chat.seedModelConfig(id, config)
        : undefined

    return (
      <ModelPickerChip
        value={chat.modelConfig}
        onChange={chat.setModelConfig}
        sessionId={id}
        onAdoptLastChosenModel={seed}
      />
    )
  }
}

/** Open the project: fresh module registry, fresh chip, fresh mount. */
async function openProject() {
  vi.resetModules()
  const { ModelPickerChip } = await import("./model-picker-chip")
  const Harness = makeHarness(ModelPickerChip)
  const view = render(<Harness />)
  await waitFor(() => expect(screen.getByTestId("editor-model-chip")).toBeInTheDocument())
  await waitFor(() => expect(live.sessions?.currentSessionId).not.toBeNull())
  return view
}

function pickModel(label: string): void {
  fireEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(label) }))
}

/** Send a turn the way the chat panel does, and let the stream close. */
async function sendTurn(text: string): Promise<void> {
  await act(async () => {
    await live.chat?.submit(text)
  })
}

beforeEach(() => {
  server.reset()
  live.chat = null
  live.sessions = null
})

afterEach(() => {
  vi.resetModules()
})

describe("the chat model choice across a project reopen", () => {
  it("a new chat runs on the model the user last chose", async () => {
    const first = await openProject()
    // Nothing chosen yet anywhere, so the chip shows the runtime default.
    expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
      "Opus 4.8",
    )

    pickModel("Haiku 4.5")
    await waitFor(() =>
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Haiku 4.5",
      ),
    )
    await sendTurn("do the thing")
    const firstSessionId = live.sessions?.currentSessionId
    expect(server.posted.at(-1)?.modelConfig).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })

    // Close the project.
    first.unmount()

    // Reopen it. A brand-new session is minted, which is what broke the
    // old fix: the chat has no persisted choice of its own.
    await openProject()
    const reopenedSessionId = live.sessions?.currentSessionId
    expect(reopenedSessionId).not.toBe(firstSessionId)

    // Production state, not a fixture: the chat hook's choice for the
    // session the next turn will target.
    await waitFor(() =>
      expect(live.chat?.modelConfig).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    )
    expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
      "Haiku 4.5",
    )

    // And what actually goes on the wire for that new session.
    await sendTurn("carry on")
    expect(server.posted.at(-1)).toMatchObject({
      sessionId: reopenedSessionId,
      modelConfig: { provider: "anthropic", model: "claude-haiku-4-5" },
    })
  })

  it("a chat started mid-session inherits the pick made moments earlier", async () => {
    // The catalog is fetched once per mount, so the server's copy of
    // "last chosen" is only current as of the open. Picking a model and
    // then hitting "+ New" must not hand the new chat the older value.
    server.seed("yesterday", {
      provider: "anthropic",
      model: "claude-opus-4-8",
    })
    await openProject()
    await waitFor(() =>
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Opus 4.8",
      ),
    )

    pickModel("Haiku 4.5")
    await waitFor(() =>
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Haiku 4.5",
      ),
    )

    act(() => {
      live.sessions?.newSession()
    })

    await waitFor(() =>
      expect(live.chat?.modelConfig).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    )
  })

  it("does not write the project's model onto an existing chat", async () => {
    // This chat ran turns and never carried a choice, so it legitimately
    // runs on the runtime default. Another chat's model must not be
    // written onto it: the user would have silently changed a setting
    // they never touched, on a conversation they only clicked into.
    server.seed("ran-on-the-default", null)
    server.seed("chose-haiku", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
    await openProject()

    // The minted chat DOES inherit it, which is what makes the negative
    // below meaningful rather than vacuous.
    await waitFor(() =>
      expect(live.chat?.modelConfig).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    )

    act(() => {
      live.sessions?.selectSession("ran-on-the-default")
    })

    await waitFor(() =>
      expect(live.sessions?.currentSessionId).toBe("ran-on-the-default"),
    )
    // Give the chip's sync effect every chance to fire before asserting
    // that it did not.
    await waitFor(() =>
      expect(screen.getByTestId("editor-model-chip")).toHaveTextContent(
        "Opus 4.8",
      ),
    )
    expect(live.chat?.modelConfig).toBeNull()

    // And the turn it sends carries no override, so the server applies
    // that session's own record.
    await sendTurn("continue where we left off")
    expect(server.posted.at(-1)).toMatchObject({
      sessionId: "ran-on-the-default",
    })
    expect(server.posted.at(-1)).not.toHaveProperty("modelConfig")
  })
})

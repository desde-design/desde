import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// The rail fetches a session transcript when it adopts a session on
// mount. Hoisted so the `vi.mock` factory below can close over it.
const { editorFetchMock } = vi.hoisted(() => ({
  editorFetchMock: vi.fn(),
}))
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => editorFetchMock(...args),
}))

// Mock the comments panel so the right-rail test stays focused on
// tab structure. (The original reason was that the container pulled in
// useAuth -> Firebase, which threw in the test env; that chain was
// deleted 2026-08-08. The mock stays because keeping this test scoped
// to tab structure is still worth it — the dedicated
// comments-container test exercises the real path.)
vi.mock("@/components/editor/comments-panel", () => ({
  CommentsPanel: () => (
    <div data-testid="comments-panel-stub">[comments]</div>
  ),
}))

// The detached-sessions switcher is exercised by its own dedicated test
// (chat-session-menu.test.tsx). Stub it here so this test stays focused
// on tab/split structure and doesn't pull in the Radix dropdown portal.
// The stub still calls back with the row the caller asked for, because
// "a prior session is reachable from the menu" is rail wiring: the rail
// owns the select-then-hydrate path the menu triggers.
vi.mock("@/components/editor/chat-session-menu", () => ({
  ChatSessionMenu: ({
    sessions,
    onSelectSession,
  }: {
    sessions: { sessionId: string }[]
    onSelectSession: (summary: { sessionId: string }) => void
  }) => (
    <div data-testid="chat-session-menu-stub">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          data-testid={`session-row-${s.sessionId}`}
          onClick={() => onSelectSession(s)}
        >
          {s.sessionId}
        </button>
      ))}
    </div>
  ),
}))

// The model picker chip has its own dedicated test suite
// (model-picker-chip.test.tsx) covering the catalog fetch + selection
// behavior. Stub it here so this suite doesn't make a real
// editorFetch call and stays focused on rail/tab structure.
//
// The stub DOES surface `onAdoptLastChosenModel`, because whether that
// prop is present is a rail decision, not a chip one: present means
// "this session was minted by the client and may inherit the model the
// user last chose", absent means "leave it alone". The chip cannot tell
// those apart, so this is where the wiring has to be pinned.
vi.mock("@/components/editor/model-picker-chip", () => ({
  ModelPickerChip: ({
    sessionId,
    onAdoptLastChosenModel,
  }: {
    sessionId?: string | null
    onAdoptLastChosenModel?: (config: {
      provider: string
      model: string
    }) => void
  }) => (
    <div
      data-testid="model-picker-chip-stub"
      data-session-id={sessionId ?? "null"}
      data-can-adopt={onAdoptLastChosenModel ? "yes" : "no"}
    >
      <button
        data-testid="model-picker-adopt"
        onClick={() =>
          onAdoptLastChosenModel?.({
            provider: "anthropic",
            model: "claude-haiku-4-5",
          })
        }
      >
        [model]
      </button>
    </div>
  ),
}))

// Faithful inline DropdownMenu (content always rendered, radio groups wired
// through context) — Radix's portal-based menu doesn't reliably open under
// jsdom's fireEvent, and this repo doesn't have @testing-library/user-event.
// Same approach as branch-mode-controls.test.tsx / model-picker-chip.test.tsx.
// Needed here so the Structure density control (a radio menu inside
// LayersPanel) can be exercised through the rail's real wiring.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createContext, useContext } = await import("react")
  const RadioGroupContext = createContext<{
    value: string
    onValueChange: (value: string) => void
  } | null>(null)
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
      ...rest
    }: {
      children: React.ReactNode
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
    DropdownMenuRadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
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
      children: React.ReactNode
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
  }
})

import {
  EditorRightRail,
  type RightRailTab,
} from "./editor-right-rail"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { useEditorChat } from "@/hooks/useEditorChat"
import type { useChatSessions } from "@/hooks/useChatSessions"
import type { LedgerRow } from "@/hooks/useEditorLedger"

type EditingApi = ReturnType<typeof useEditorEditing>
type ChatApi = ReturnType<typeof useEditorChat>
type ChatSessionsApi = ReturnType<typeof useChatSessions>

beforeEach(() => {
  // localStorage + pointer-capture polyfills live in src/test-setup.ts.
  // Clear any persisted ratios from a prior test in this run.
  window.localStorage.clear()
  editorFetchMock.mockReset()
  editorFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      ok: true,
      session: { turns: [{ id: "t1", userMessage: "earlier work" }] },
    }),
  })
})

function makeSummary(sessionId: string, updatedAt: string) {
  return {
    sessionId,
    projectId: "proj",
    createdAt: updatedAt,
    updatedAt,
    turnCount: 1,
    // Every fixture row carries a pinned page. Re-anchoring is gated on
    // this field, so a row without one would make "mounting does not
    // re-anchor" pass for the wrong reason.
    pinnedPage: { url: "http://localhost:5173/settings", route: "/settings" },
  } as never
}

function makeEditing(overrides: Partial<EditingApi> = {}): EditingApi {
  return {
    editorSelection: null,
    editorManifest: null,
    status: { kind: "ready" },
    layersRoots: null,
    // These three are what the density control wires through. Set them for
    // real: `onDensityChange` gates the control's rendering in LayersPanel,
    // so leaving `setLayersDensity` undefined silently un-renders the
    // dropdown in every test — deleting the rail's wiring entirely would
    // have left this suite green.
    layersRawRoots: null,
    layersDensity: "essentials",
    setLayersDensity: vi.fn(),
    layersError: false,
    layersRefreshing: false,
    refreshLayers: vi.fn(),
    handleLayerSelect: vi.fn(),
    handleLayerHover: vi.fn(),
    handleLayerMove: vi.fn(),
    handleLayerMoveRefused: vi.fn(),
    handleLayerDetach: vi.fn(),
    handleLayerDelete: vi.fn(),
    handleLayerInsert: vi.fn(),
    handleLayerUnwrap: vi.fn(),
    handleLayerFlattenConditional: vi.fn(),
    handlePropEdit: vi.fn(),
    handleInsertElement: vi.fn(),
    beginInsertPlacement: vi.fn(),
    cancelInsertPlacement: vi.fn(),
    handleDetach: vi.fn(),
    handleSwap: vi.fn(),
    handleEditComponent: vi.fn(),
    handleEditTextField: vi.fn(),
    handleClassesEdit: vi.fn(),
    handleScopedStyleEdit: vi.fn(),
    handleTokenStyleEdit: vi.fn(),
    handleEditTextBranch: vi.fn(),
    handlePickIcon: vi.fn(),
    ...overrides,
  } as unknown as EditingApi
}

function makeChat(overrides: Partial<ChatApi> = {}): ChatApi {
  return {
    messages: [],
    submitting: false,
    error: null,
    submit: vi.fn(),
    // Required on the real hook's return: the panel renders one spinner row
    // per steer being resent, so an omitted array crashes the render.
    resendingSteers: [],
    abort: vi.fn(),
    clearLocal: vi.fn(),
    hydrateFromTranscript: vi.fn(),
    hasSessionBucket: vi.fn(() => false),
    modelConfig: null,
    setModelConfig: vi.fn(),
    seedModelConfig: vi.fn(),
    ...overrides,
  } as unknown as ChatApi
}

function makeChatSessions(
  overrides: Partial<ChatSessionsApi> = {},
): ChatSessionsApi {
  return {
    enabled: true,
    sessions: [],
    loading: false,
    error: null,
    currentSessionId: null,
    currentSessionIsNew: false,
    getChatSessionId: () => null,
    onSessionEvent: vi.fn(),
    onStreamComplete: vi.fn(),
    selectSession: vi.fn(),
    newSession: vi.fn(),
    refetch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ChatSessionsApi
}

// The comment bridge + store are mounted by EditorSurface and passed through
// this rail (2026-08-14). CommentsPanel is stubbed above, so these only have
// to satisfy the prop types.
type RailProps = React.ComponentProps<typeof EditorRightRail>
const commentBridge = {} as unknown as RailProps["commentBridge"]
const commentSync = {} as unknown as RailProps["commentSync"]

function renderRail(overrides: Partial<RailProps> = {}): {
  onTabChange: ReturnType<typeof vi.fn>
} {
  const onTabChange = vi.fn()
  render(
    <EditorRightRail
      activeTab={overrides.activeTab ?? ("edit" as RightRailTab)}
      onTabChange={overrides.onTabChange ?? onTabChange}
      editing={overrides.editing ?? makeEditing()}
      chat={overrides.chat ?? makeChat()}
      chatSessions={overrides.chatSessions ?? makeChatSessions()}
      onReAnchorToSession={overrides.onReAnchorToSession}
      selectionMany={overrides.selectionMany ?? null}
      iframeRef={overrides.iframeRef ?? { current: null }}
      commentBridge={overrides.commentBridge ?? commentBridge}
      commentSync={overrides.commentSync ?? commentSync}
      onCommentModeChange={overrides.onCommentModeChange ?? vi.fn()}
      onCommentPinClicked={overrides.onCommentPinClicked}
      branches={overrides.branches}
    />,
  )
  return { onTabChange }
}

describe("EditorRightRail", () => {
  it("renders the top-level tabs including the standalone Chat tab", () => {
    renderRail()
    expect(screen.getByTestId("right-rail-tab-edit")).toBeInTheDocument()
    expect(screen.getByTestId("right-rail-tab-chat")).toBeInTheDocument()
    expect(
      screen.getByTestId("right-rail-tab-comments"),
    ).toBeInTheDocument()
    expect(screen.getByTestId("right-rail-tab-activity")).toBeInTheDocument()
  })

  it("clicking a tab calls onTabChange", () => {
    const { onTabChange } = renderRail()
    const trigger = screen.getByTestId("right-rail-tab-comments")
    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.mouseDown(trigger, { button: 0 })
    fireEvent.click(trigger)
    expect(onTabChange).toHaveBeenCalledWith("comments")
  })

  it("shows the full Layers panel in the Edit tab when nothing is selected", () => {
    renderRail({ editing: makeEditing({ editorSelection: null }) })
    expect(
      screen.getByRole("complementary", { name: "Editor layers" }),
    ).toBeInTheDocument()
    // No element selected → no inspector, no split.
    expect(screen.queryByTestId("resizable-vertical-split")).toBeNull()
    expect(
      screen.queryByRole("complementary", { name: "Editor inspector" }),
    ).toBeNull()
  })

  it("wires the Structure density control: renders it, reflects layersDensity, and calls setLayersDensity", () => {
    // The control renders ONLY when LayersPanel receives `onDensityChange`,
    // so this test is what pins the rail's `editing.setLayersDensity` /
    // `editing.layersDensity` threading. Before makeEditing set those
    // fields, the dropdown was absent from every rail test and the wiring
    // could be deleted without a failure.
    const editing = makeEditing()
    renderRail({ editing })

    expect(
      screen.getByLabelText("Choose how much detail the structure shows"),
    ).toBeInTheDocument()

    // The radio group reflects the hook's current density…
    expect(
      screen.getByRole("menuitemradio", { name: "Essentials" }),
    ).toHaveAttribute("aria-checked", "true")

    // …and picking a level calls through to the hook's setter.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Detailed" }))
    expect(
      (editing as unknown as { setLayersDensity: ReturnType<typeof vi.fn> })
        .setLayersDensity,
    ).toHaveBeenCalledWith("detailed")
  })

  it("splits Layers over the Inspector in the Edit tab when an element is selected", () => {
    renderRail({
      editing: makeEditing({
        editorSelection: {
          selector: "#el",
          targetId: "#el",
          componentName: "Div",
        } as unknown as EditingApi["editorSelection"],
      }),
    })
    expect(
      screen.getByTestId("resizable-vertical-split"),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("complementary", { name: "Editor layers" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("complementary", { name: "Editor inspector" }),
    ).toBeInTheDocument()
  })

  it("activates the comments panel when activeTab === 'comments'", () => {
    renderRail({ activeTab: "comments" })
    const panel = screen.getByTestId("comments-panel-stub")
    expect(panel).toBeInTheDocument()
  })

  it("activates the activity panel when activeTab === 'activity'", () => {
    renderRail({ activeTab: "activity" })
    expect(screen.getByTestId("activity-panel-branch")).toBeInTheDocument()
  })

  it("threads working-tree changes from `branches` into the activity panel", () => {
    renderRail({
      activeTab: "activity",
      branches: {
        changes: [{ path: "src/App.vue", status: "modified" }],
        current: "feat/x",
      } as unknown as React.ComponentProps<typeof EditorRightRail>["branches"],
    })
    expect(screen.getByTestId("activity-changes-list")).toBeInTheDocument()
    // Plan B, Task 4: the path lives on the row's second line, alongside
    // the change type and commit state (`<path> · <change type> · <commit
    // state>`), not as a standalone node — hence a substring match rather
    // than an exact one.
    expect(screen.getByText(/src\/App\.vue/)).toBeInTheDocument()
    // The header summary that carried the count and branch is gone. What this
    // test is actually about — changes reaching the panel — is the list and
    // the row above, both still asserted.
    expect(
      screen.queryByText("1 uncommitted change on feat/x"),
    ).not.toBeInTheDocument()
  })

  // P2-2 (codex review round 5, 2026-08-20): a successful ledger Undo used
  // to refresh only `useEditorLedger`'s own rows — the wrapping in
  // `EditorRightRail` (`handleLedgerUndo`) is what also refreshes
  // `branches`, so the toolbar's `dirty`/Commit state doesn't stay stale
  // until the next 2.5s branch poll. This drives the REAL `ActivityPanel`
  // through its actual row → confirm-dialog → confirm click, not a stub,
  // because the wiring under test lives in the callback `EditorRightRail`
  // passes to it, not in `ActivityPanel` itself.
  it("refreshes branches, not just the ledger, after a successful Undo (P2-2)", async () => {
    const undoableRow: LedgerRow = {
      id: "edit-1",
      at: "2026-08-19T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/App.vue"],
      backupDir: ".desde/backups/1-abc",
      afterHashes: { "src/App.vue": "HASH_AFTER" },
      description: 'label = "Submit"',
      committed: false,
    }
    editorFetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url)
      if (path === "/api/editor/ledger") {
        return {
          ok: true,
          json: async () => ({ ok: true, entries: [undoableRow] }),
        }
      }
      if (path === `/api/editor/ledger/${undoableRow.id}/undo`) {
        return { ok: true, json: async () => ({ ok: true }) }
      }
      // Everything else (session hydration, …) keeps the generic
      // beforeEach shape — this test isn't about those calls.
      return {
        ok: true,
        json: async () => ({
          ok: true,
          session: { turns: [{ id: "t1", userMessage: "earlier work" }] },
        }),
      }
    })

    const branchesRefresh = vi.fn()
    renderRail({
      activeTab: "activity",
      branches: {
        changes: [],
        current: "feat/x",
        refresh: branchesRefresh,
      } as unknown as React.ComponentProps<typeof EditorRightRail>["branches"],
    })

    await waitFor(() => expect(screen.getByText("Undo")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Undo"))
    const dialog = await screen.findByTestId("activity-undo-dialog")
    expect(dialog).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("activity-undo-confirm"))

    await waitFor(() =>
      expect(
        screen.queryByTestId("activity-undo-dialog"),
      ).not.toBeInTheDocument(),
    )
    // The fix: a successful undo refreshes `branches` too, not just the
    // ledger. Before it, this stayed at 0 — undo only ever touched
    // `useEditorLedger`'s own refresh.
    expect(branchesRefresh).toHaveBeenCalledTimes(1)
  })

  it("does not refresh branches when Undo is refused", async () => {
    const undoableRow: LedgerRow = {
      id: "edit-1",
      at: "2026-08-19T10:00:00.000Z",
      kind: "prop",
      lane: "direct",
      files: ["src/App.vue"],
      backupDir: ".desde/backups/1-abc",
      afterHashes: { "src/App.vue": "HASH_AFTER" },
      description: 'label = "Submit"',
      committed: false,
    }
    editorFetchMock.mockImplementation(async (url: unknown) => {
      const path = String(url)
      if (path === "/api/editor/ledger") {
        return {
          ok: true,
          json: async () => ({ ok: true, entries: [undoableRow] }),
        }
      }
      if (path === `/api/editor/ledger/${undoableRow.id}/undo`) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ ok: false, code: "drifted", reason: "changed" }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          session: { turns: [{ id: "t1", userMessage: "earlier work" }] },
        }),
      }
    })

    const branchesRefresh = vi.fn()
    renderRail({
      activeTab: "activity",
      branches: {
        changes: [],
        current: "feat/x",
        refresh: branchesRefresh,
      } as unknown as React.ComponentProps<typeof EditorRightRail>["branches"],
    })

    await waitFor(() => expect(screen.getByText("Undo")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Undo"))
    await screen.findByTestId("activity-undo-dialog")
    fireEvent.click(screen.getByTestId("activity-undo-confirm"))

    // A refusal closes the dialog the same way a success does (see
    // `confirmUndo` in activity-panel.tsx — `setPending(null)` runs on
    // both branches); the refusal itself surfaces as a toast, not dialog
    // text. What this test asserts is the OTHER half of the fix: nothing
    // on disk changed, so `branches` must not be refreshed either.
    await waitFor(() =>
      expect(
        screen.queryByTestId("activity-undo-dialog"),
      ).not.toBeInTheDocument(),
    )
    expect(branchesRefresh).not.toHaveBeenCalled()
  })

  // The next two tests cover the detached-sessions integration — the
  // chat panel's tab strip mounts only in worktree-session mode. They
  // live here (not in a separate suite) because the wiring is right-
  // rail-internal: the rail decides when to forward the tabs slot.

  it("mounts the session tabs when chat sessions are enabled", () => {
    // The tab strip gates on `chatSessions.enabled`, so branch mode still
    // shows the tabs when detached sessions are on.
    renderRail({ chatSessions: makeChatSessions({ enabled: true }) })
    expect(screen.getByTestId("chat-session-menu-stub")).toBeInTheDocument()
  })

  it("omits the session tabs when chat sessions are disabled", () => {
    // Detached sessions off (e.g. EDITOR_DETACHED_SESSIONS=false) — the
    // tab strip must NOT mount.
    renderRail({ chatSessions: makeChatSessions({ enabled: false }) })
    expect(screen.queryByTestId("chat-session-menu-stub")).toBeNull()
  })

  // ── Opening a project lands in a NEW chat ───────────────────────────
  //
  // These used to assert the opposite: the rail adopted `sessions[0]` on
  // mount and hydrated the pane from it. They are inverted, not deleted,
  // because the bug that adoption existed for is still real, and these
  // are its regression guard.
  //
  // The bug: `currentSessionId === null` renders as an empty pane, but
  // the SERVER reads a missing sessionId as the project's permanent
  // default session (`chat-handler.ts`: `body.sessionId ?? projectId`),
  // which carries an `sdkSessionId` the SDK resumes. So a blank chat
  // silently continued weeks of prior conversation on the user's first
  // word.
  //
  // What closes it now is `useChatSessions` minting a real sessionId on
  // mount (see useChatSessions.test.ts, "mints a session on mount"), so
  // the empty pane is backed by a real, empty session. The rail's job
  // is the other half: never quietly adopt a prior session behind the
  // user's back. Prior sessions stay one click away in the menu.

  it("does not adopt a prior session on mount", async () => {
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      currentSessionId: null,
      sessions: [
        makeSummary("newest", "2026-08-11T00:00:00.000Z"),
        makeSummary("older", "2026-07-13T00:00:00.000Z"),
      ],
    })
    renderRail({ chat, chatSessions })

    // Give any stray effect a chance to fire before asserting absence.
    await waitFor(() =>
      expect(screen.getByTestId("chat-session-menu-stub")).toBeInTheDocument(),
    )
    expect(chatSessions.selectSession).not.toHaveBeenCalled()
    expect(chat.hydrateFromTranscript).not.toHaveBeenCalled()
    // Scoped to the session-hydration endpoint, not "no fetch at all": the
    // rail also mounts `useEditorLedger` unconditionally now (Plan B, Task
    // 4), which fires its own `GET /api/editor/ledger` on every mount
    // regardless of chat-session state — a real, unrelated call this
    // assertion was never about.
    expect(editorFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/chat/sessions/"),
      expect.anything(),
    )
  })

  it("never re-anchors the iframe on mount", async () => {
    // Re-anchoring is a response to the user PICKING a chat from the
    // menu. Doing it on load would navigate the prototype away from the
    // page they opened, which is the one thing a project open must not
    // do.
    //
    // This assertion predates the mount mint (it guarded the adopt-on-
    // mount path) and was dropped when that path went away. It is
    // restored because the hazard did not: any future mount-time
    // convenience — rehydrating the last chat, restoring a pinned
    // selection — would reintroduce it, and the fixture rows all carry
    // a `pinnedPage` so the call is available to be made wrongly.
    const onReAnchorToSession = vi.fn()
    renderRail({
      chatSessions: makeChatSessions({
        currentSessionId: "minted-1",
        currentSessionIsNew: true,
        sessions: [
          makeSummary("newest", "2026-08-11T00:00:00.000Z"),
          makeSummary("older", "2026-07-13T00:00:00.000Z"),
        ],
      }),
      onReAnchorToSession,
    })

    // Give any stray effect a chance to fire before asserting absence.
    await waitFor(() =>
      expect(screen.getByTestId("chat-session-menu-stub")).toBeInTheDocument(),
    )
    expect(onReAnchorToSession).not.toHaveBeenCalled()

    // Same fixture, same handler: picking a row DOES re-anchor. Without
    // this half, deleting the re-anchor call entirely would leave the
    // assertion above green.
    fireEvent.click(screen.getByTestId("session-row-newest"))
    expect(onReAnchorToSession).toHaveBeenCalledTimes(1)
  })

  it("does not hydrate the freshly minted session", async () => {
    // The hook has already minted an id by the time the rail mounts.
    // That session has no file on disk, so fetching its transcript would
    // be a guaranteed 404 round-trip.
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      currentSessionId: "minted-1",
      currentSessionIsNew: true,
      sessions: [makeSummary("newest", "2026-08-11T00:00:00.000Z")],
    })
    renderRail({ chat, chatSessions })

    await waitFor(() =>
      expect(screen.getByTestId("chat-session-menu-stub")).toBeInTheDocument(),
    )
    // Scoped to the session-hydration endpoint, not "no fetch at all": the
    // rail also mounts `useEditorLedger` unconditionally now (Plan B, Task
    // 4), which fires its own `GET /api/editor/ledger` on every mount
    // regardless of chat-session state — a real, unrelated call this
    // assertion was never about.
    expect(editorFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/chat/sessions/"),
      expect.anything(),
    )
    expect(chat.hydrateFromTranscript).not.toHaveBeenCalled()
  })

  it("does nothing on mount when the project has never been chatted in", () => {
    const chatSessions = makeChatSessions({
      currentSessionId: null,
      sessions: [],
    })
    renderRail({ chatSessions })
    expect(chatSessions.selectSession).not.toHaveBeenCalled()
    // Scoped to the session-hydration endpoint, not "no fetch at all": the
    // rail also mounts `useEditorLedger` unconditionally now (Plan B, Task
    // 4), which fires its own `GET /api/editor/ledger` on every mount
    // regardless of chat-session state — a real, unrelated call this
    // assertion was never about.
    expect(editorFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/chat/sessions/"),
      expect.anything(),
    )
  })

  it("does nothing on mount when detached sessions are disabled", () => {
    const chatSessions = makeChatSessions({
      enabled: false,
      currentSessionId: null,
      sessions: [makeSummary("newest", "2026-08-11T00:00:00.000Z")],
    })
    renderRail({ chatSessions })
    expect(chatSessions.selectSession).not.toHaveBeenCalled()
    // Scoped to the session-hydration endpoint, not "no fetch at all": the
    // rail also mounts `useEditorLedger` unconditionally now (Plan B, Task
    // 4), which fires its own `GET /api/editor/ledger` on every mount
    // regardless of chat-session state — a real, unrelated call this
    // assertion was never about.
    expect(editorFetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/chat/sessions/"),
      expect.anything(),
    )
  })

  // ── Prior sessions stay reachable ───────────────────────────────────

  it("picking a session from the menu selects it and hydrates the pane", async () => {
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      currentSessionId: "minted-1",
      currentSessionIsNew: true,
      sessions: [makeSummary("newest", "2026-08-11T00:00:00.000Z")],
    })
    renderRail({ chat, chatSessions })

    fireEvent.click(screen.getByTestId("session-row-newest"))

    expect(chatSessions.selectSession).toHaveBeenCalledWith("newest")
    await waitFor(() => {
      expect(chat.hydrateFromTranscript).toHaveBeenCalledWith(
        [{ id: "t1", userMessage: "earlier work" }],
        "newest",
      )
    })
  })

  // ── The model choice survives the open ──────────────────────────────
  //
  // The chip adopts the last chosen model only for a chat that has no
  // choice of its own. Before the mint, a fresh open was such a chat by
  // virtue of sending no sessionId at all; now it is a minted one, so
  // the rail has to say so explicitly or the model would silently fall
  // back to the runtime catalog default on every open.
  //
  // These pin the rail's half of the wiring. That the whole chain
  // survives a reopen is chat-model-choice.test.tsx, which runs the real
  // hooks and the real chip.

  it("lets a freshly minted session inherit the last chosen model", () => {
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      currentSessionId: "minted-1",
      currentSessionIsNew: true,
      sessions: [makeSummary("newest", "2026-08-11T00:00:00.000Z")],
    })
    renderRail({ chat, chatSessions })

    const chip = screen.getByTestId("model-picker-chip-stub")
    expect(chip).toHaveAttribute("data-session-id", "minted-1")
    expect(chip).toHaveAttribute("data-can-adopt", "yes")

    // And the adopt writes into THAT session, through the seed-only
    // setter — which no-ops on a bucket that already holds a choice.
    fireEvent.click(screen.getByTestId("model-picker-adopt"))
    expect(chat.seedModelConfig).toHaveBeenCalledWith("minted-1", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })
  })

  it("does not offer the last chosen model to a session picked from the listing", () => {
    // An existing session with no persisted choice legitimately runs on
    // the runtime default. Writing another chat's model onto it would
    // persist a choice its owner never made.
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      currentSessionId: "newest",
      currentSessionIsNew: false,
      sessions: [makeSummary("newest", "2026-08-11T00:00:00.000Z")],
    })
    renderRail({ chat, chatSessions })

    const chip = screen.getByTestId("model-picker-chip-stub")
    expect(chip).toHaveAttribute("data-session-id", "newest")
    expect(chip).toHaveAttribute("data-can-adopt", "no")
    fireEvent.click(screen.getByTestId("model-picker-adopt"))
    expect(chat.seedModelConfig).not.toHaveBeenCalled()
  })

  it("does not offer a seeder when detached sessions are disabled", () => {
    // The chip's own `sessionId === null` branch covers this case: the
    // next turn sends no id, so the server resolves the project-default
    // session, and the chip applies the last chosen model directly.
    const chat = makeChat()
    const chatSessions = makeChatSessions({
      enabled: false,
      currentSessionId: null,
      currentSessionIsNew: false,
    })
    renderRail({ chat, chatSessions })

    const chip = screen.getByTestId("model-picker-chip-stub")
    expect(chip).toHaveAttribute("data-session-id", "null")
    expect(chip).toHaveAttribute("data-can-adopt", "no")
  })
})

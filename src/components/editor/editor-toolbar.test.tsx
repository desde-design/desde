import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { EditorToolbar } from "./editor-toolbar"
import { requestCommentMode } from "./request-comment-mode"
import { useEditorToolMode } from "@/hooks/useEditorToolMode"
import type { SegmentedToggleOption } from "./segmented-toggle"
import type { ActiveBreakpoint } from "./tailwind-classes"
import { useAppStore } from "@/stores"
import type { EditorToolMode } from "@/stores/tool-mode-slice"
import type { BranchesApi, EditHistoryUiState } from "@/hooks/useEditorBranches"

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

const BREAKPOINT_OPTIONS: ReadonlyArray<SegmentedToggleOption<ActiveBreakpoint>> = [
  { value: "base", label: "Auto" },
  { value: "md", label: "md" },
]

function makeHistory(overrides: Partial<EditHistoryUiState> = {}): EditHistoryUiState {
  return {
    canUndo: true,
    canRedo: true,
    undoLabel: null,
    redoLabel: null,
    ...overrides,
  }
}

function makeBranches(overrides: Partial<BranchesApi> = {}): BranchesApi {
  return {
    branches: [],
    current: "feat/x",
    defaultBranch: "main",
    dirty: false,
    changes: [],
    history: makeHistory(),
    loading: false,
    error: null,
    undoEdit: vi.fn().mockResolvedValue({ ok: true }),
    redoEdit: vi.fn().mockResolvedValue({ ok: true }),
    discardStep: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as BranchesApi
}

function renderToolbar(overrides: Partial<Parameters<typeof EditorToolbar>[0]> = {}) {
  return render(
    <EditorToolbar
      view="editor"
      onViewChange={vi.fn()}
      canvasMode="read"
      onCanvasModeChange={vi.fn()}
      toolMode="navigate"
      onToolModeChange={vi.fn()}
      branches={makeBranches()}
      onPinsHiddenChange={vi.fn()}
      onHideChrome={vi.fn()}
      showIframe
      activeBreakpoint="base"
      breakpointOptions={BREAKPOINT_OPTIONS}
      onBreakpointChange={vi.fn()}
      captureScreenshot={vi.fn()}
      captureRoute="/"
      prototypeUrl="http://localhost:5173"
      captureEnabled
      {...overrides}
    />,
  )
}

/**
 * The tool picker's own tablist. Every tab query in this file goes through
 * it, never through `screen`: the toolbar renders a SECOND tablist (the
 * Workspace view switcher) whenever `EDITOR_CANVAS` is on, and a third in
 * Canvas view. An unscoped `getAllByRole("tab")` therefore passes only while
 * the canvas surface stays dormant, and a dormant lane whose tests rot is a
 * lane that cannot be un-dormanted.
 */
function picker() {
  return within(screen.getByRole("tablist", { name: "Prototype tool" }))
}

/** The picker's three segments, by their accessible names. */
function tool(name: "Navigate" | "Select" | "Comment"): HTMLElement {
  return picker().getByRole("tab", { name: new RegExp(`^${name}$`, "i") })
}

beforeEach(() => {
  useAppStore.setState({ toolMode: "navigate" })
})

afterEach(() => {
  useAppStore.setState({ toolMode: "navigate" })
})

describe("EditorToolbar", () => {
  // The name is the point of this file. The floating pill used to carry
  // `data-testid="editor-top-bar"` while the full-width row above it had no
  // testid at all, so "the toolbar" and "the top bar" pointed at each other.
  it("is named editor-toolbar in the DOM", () => {
    renderToolbar()
    expect(screen.getByTestId("editor-toolbar")).toBeTruthy()
  })

  it("renders the breakpoint menu and the tool picker while the iframe is showing", () => {
    renderToolbar()
    expect(screen.getByTestId("editor-breakpoint-menu")).toBeTruthy()
    expect(screen.getByRole("tablist", { name: "Prototype tool" })).toBeTruthy()
  })

  it("drops the iframe-only controls when the iframe is not the foreground surface", () => {
    renderToolbar({ showIframe: false })
    expect(screen.queryByTestId("editor-breakpoint-menu")).toBeNull()
    expect(screen.queryByRole("tablist", { name: "Prototype tool" })).toBeNull()
  })

  it("renders the exit button only when there is something to exit back to", () => {
    const { unmount } = renderToolbar()
    expect(screen.queryByTestId("editor-exit")).toBeNull()
    unmount()
    renderToolbar({ onExitCompose: vi.fn() })
    expect(screen.getByTestId("editor-exit")).toBeTruthy()
  })

  // Undo/Redo moved here from the nav bar on 2026-08-14.
  it("carries Undo and Redo, in the toolbar and not the nav bar", () => {
    renderToolbar()
    expect(screen.getByTestId("editor-undo")).toBeTruthy()
    expect(screen.getByTestId("editor-redo")).toBeTruthy()
  })

  // The asked-for reading order, left to right.
  it("orders its tools: the picker, then Undo, Redo, Sizing", () => {
    renderToolbar()
    const order = [
      screen.getByRole("tablist", { name: "Prototype tool" }),
      screen.getByTestId("editor-undo"),
      screen.getByTestId("editor-redo"),
      screen.getByTestId("editor-breakpoint-menu"),
    ]
    for (let i = 1; i < order.length; i += 1) {
      // Node.DOCUMENT_POSITION_FOLLOWING === 4: the argument comes after.
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })

  describe("the tool picker", () => {
    it("offers exactly Navigate, Select and Comment", () => {
      renderToolbar()
      expect(
        picker()
          .getAllByRole("tab")
          .map((el) => el.textContent?.trim()),
      ).toEqual(["Navigate", "Select", "Comment"])
    })

    // Proof that the queries in this file are scoped to the picker rather
    // than to the whole toolbar. `showIframe` with `view="canvas"` is a
    // synthetic prop pairing — the surface derives one from the other — and
    // its only job here is to put a SECOND tablist on screen, which is what
    // the dormant `EDITOR_CANVAS` surface does for real. An unscoped
    // `getAllByRole("tab")` would see five tabs and both of the assertions
    // below would break the day that flag is flipped.
    it("stays addressable when the toolbar carries another tablist", () => {
      renderToolbar({ view: "canvas" })
      expect(screen.getAllByRole("tablist").length).toBeGreaterThan(1)
      expect(
        picker()
          .getAllByRole("tab")
          .map((el) => el.textContent?.trim()),
      ).toEqual(["Navigate", "Select", "Comment"])
    })

    // The word is Mo's. "Inspect" is what the old switch said, and it is not
    // what the stored value has ever been called.
    it("labels the middle option Select, never Inspect", () => {
      renderToolbar()
      expect(tool("Select")).toBeTruthy()
      expect(screen.queryByText(/inspect/i)).toBeNull()
    })

    it.each([
      ["navigate", "Navigate"],
      ["select", "Select"],
      ["comment", "Comment"],
    ] as ReadonlyArray<[EditorToolMode, "Navigate" | "Select" | "Comment"]>)(
      "shows %s as the live mode",
      (mode, label) => {
        renderToolbar({ toolMode: mode })
        expect(tool(label).getAttribute("data-state")).toBe("active")
      },
    )

    it.each([
      ["Select", "select"],
      ["Comment", "comment"],
    ] as ReadonlyArray<["Navigate" | "Select" | "Comment", EditorToolMode]>)(
      "asks for %s by its stored value",
      (label, value) => {
        const onToolModeChange = vi.fn()
        renderToolbar({ toolMode: "navigate", onToolModeChange })
        fireEvent.mouseDown(tool(label))
        expect(onToolModeChange).toHaveBeenCalledWith(value)
      },
    )

    // Radix's Tabs default is `activationMode="automatic"`: the segment that
    // receives focus is selected. On a tab strip that costs a panel render.
    // Here every segment posts real messages into the user's running
    // prototype, so arrowing from Navigate to Comment would arm and disarm
    // the inspector on the way past Select. `SegmentedToggle` sets manual
    // activation for every caller; this is the assertion that keeps it.
    it("does not pick a tool merely because focus lands on it", () => {
      const onToolModeChange = vi.fn()
      renderToolbar({ toolMode: "navigate", onToolModeChange })

      act(() => tool("Select").focus())
      expect(onToolModeChange).not.toHaveBeenCalled()

      // Enter still commits, so the control is reachable by keyboard.
      fireEvent.keyDown(tool("Select"), { key: "Enter" })
      expect(onToolModeChange).toHaveBeenCalledWith("select")
    })

    it("asks for Navigate from another tool", () => {
      const onToolModeChange = vi.fn()
      renderToolbar({ toolMode: "comment", onToolModeChange })
      fireEvent.mouseDown(tool("Navigate"))
      expect(onToolModeChange).toHaveBeenCalledWith("navigate")
    })
  })

  // Wired the way EditorSurface wires it, through the real
  // `useEditorToolMode` and `requestCommentMode`, so this covers the actual
  // chain rather than a restatement of it.
  //
  // The picker cannot express "Select and Comment are both on", so what is
  // worth asserting here is the WIRE: picking a tool has to arm and disarm
  // the right bridge overlays. The old two-boolean shape let the shell claim
  // a mode the bridge had already left.
  describe("picking a tool arms the bridge to match", () => {
    function Harness({
      enterCommentMode = vi.fn(),
      exitCommentMode = vi.fn(),
      setEditorActive = vi.fn(async () => {}),
    }: {
      enterCommentMode?: () => void
      exitCommentMode?: () => void
      setEditorActive?: (active: boolean) => Promise<void>
    }) {
      const { toolMode, requestToolMode } = useEditorToolMode({
        setEditorActive,
        enterCommentMode,
        exitCommentMode,
      })
      return (
        <EditorToolbar
          view="editor"
          onViewChange={vi.fn()}
          canvasMode="read"
          onCanvasModeChange={vi.fn()}
          toolMode={toolMode}
          onToolModeChange={(next) => {
            if (next !== "comment") {
              requestToolMode(next)
              return
            }
            requestCommentMode({
              resolving: false,
              resolveFailed: false,
              setToolMode: requestToolMode,
            })
          }}
          branches={makeBranches()}
          onPinsHiddenChange={vi.fn()}
          onHideChrome={vi.fn()}
          showIframe
          activeBreakpoint="base"
          breakpointOptions={BREAKPOINT_OPTIONS}
          onBreakpointChange={vi.fn()}
          captureScreenshot={vi.fn()}
          captureRoute="/"
          prototypeUrl="http://localhost:5173"
          captureEnabled
        />
      )
    }

    it("picking Comment arms comment placement and drops the inspector", () => {
      const enterCommentMode = vi.fn()
      const setEditorActive = vi.fn(async () => {})
      useAppStore.setState({ toolMode: "select" })
      render(<Harness enterCommentMode={enterCommentMode} setEditorActive={setEditorActive} />)

      expect(tool("Select").getAttribute("data-state")).toBe("active")
      fireEvent.mouseDown(tool("Comment"))

      expect(enterCommentMode).toHaveBeenCalledTimes(1)
      expect(setEditorActive).toHaveBeenLastCalledWith(false)
      expect(tool("Comment").getAttribute("data-state")).toBe("active")
      expect(tool("Select").getAttribute("data-state")).toBe("inactive")
    })

    it("picking Select disarms comment placement", () => {
      const exitCommentMode = vi.fn()
      const setEditorActive = vi.fn(async () => {})
      useAppStore.setState({ toolMode: "comment" })
      render(<Harness exitCommentMode={exitCommentMode} setEditorActive={setEditorActive} />)

      fireEvent.mouseDown(tool("Select"))

      // The segment goes dark AND the bridge is told, so the shell is not
      // just quietly agreeing with something it never said.
      expect(exitCommentMode).toHaveBeenCalledTimes(1)
      expect(setEditorActive).toHaveBeenLastCalledWith(true)
      expect(tool("Comment").getAttribute("data-state")).toBe("inactive")
      expect(tool("Select").getAttribute("data-state")).toBe("active")
    })

    it("picking Navigate disarms both", () => {
      const exitCommentMode = vi.fn()
      const setEditorActive = vi.fn(async () => {})
      useAppStore.setState({ toolMode: "comment" })
      render(<Harness exitCommentMode={exitCommentMode} setEditorActive={setEditorActive} />)

      fireEvent.mouseDown(tool("Navigate"))

      expect(exitCommentMode).toHaveBeenCalledTimes(1)
      expect(setEditorActive).toHaveBeenLastCalledWith(false)
      expect(tool("Navigate").getAttribute("data-state")).toBe("active")
    })

    it("never shows two tools picked at once", () => {
      render(<Harness />)
      const active = () =>
        picker()
          .getAllByRole("tab")
          .filter((el) => el.getAttribute("data-state") === "active")

      for (const label of ["Comment", "Select", "Navigate", "Comment"] as const) {
        fireEvent.mouseDown(tool(label))
        expect(active()).toHaveLength(1)
      }
    })
  })
})

/**
 * The hide-comments toggle, after Undo and Redo (Mo, 2026-09-02). It moved
 * here from the Comments panel's "Hide" switch, and it is the ONLY control
 * for the pins now, so it has to do both halves: the store (which the panel
 * and the pin bridge read) and the bridge callback (which posts to the
 * iframe).
 */
describe("EditorToolbar — hide comments", () => {
  beforeEach(() => {
    useAppStore.setState({ pinsHidden: false })
  })

  it("flips pinsHidden in the store and tells the bridge", () => {
    const onPinsHiddenChange = vi.fn()
    renderToolbar({ onPinsHiddenChange })
    const toggle = screen.getByTestId("editor-pins-hidden")
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    expect(toggle).toHaveAccessibleName("Hide comments")

    fireEvent.click(toggle)
    expect(useAppStore.getState().pinsHidden).toBe(true)
    expect(onPinsHiddenChange).toHaveBeenCalledWith(true)
    expect(screen.getByTestId("editor-pins-hidden")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("editor-pins-hidden")).toHaveAccessibleName("Show comments")

    fireEvent.click(screen.getByTestId("editor-pins-hidden"))
    expect(useAppStore.getState().pinsHidden).toBe(false)
    expect(onPinsHiddenChange).toHaveBeenLastCalledWith(false)
  })

  it("is not rendered without the prototype iframe", () => {
    renderToolbar({ showIframe: false })
    expect(screen.queryByTestId("editor-pins-hidden")).not.toBeInTheDocument()
  })
})

/** Full screen is the toolbar's LAST control (Mo, 2026-09-02). */
describe("EditorToolbar — hide chrome", () => {
  it("fires onHideChrome and sits at the right edge", () => {
    const onHideChrome = vi.fn()
    renderToolbar({ onHideChrome })
    const toolbar = screen.getByTestId("editor-toolbar")
    const button = screen.getByTestId("editor-hide-chrome")
    expect(toolbar.lastElementChild).toBe(button)
    fireEvent.click(button)
    expect(onHideChrome).toHaveBeenCalledTimes(1)
  })
})

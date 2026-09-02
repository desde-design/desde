import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

// sonner's toast is a side effect we don't assert on except in the failure case.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

import { toast } from "sonner"
import { UndoRedoControls } from "./undo-redo-controls"
import type { BranchesApi, EditHistoryUiState } from "@/hooks/useEditorBranches"

function makeHistory(overrides: Partial<EditHistoryUiState> = {}): EditHistoryUiState {
  return {
    canUndo: false,
    canRedo: false,
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
    ahead: 0,
    hasRemote: true,
    unpushed: false,
    history: makeHistory(),
    loading: false,
    error: null,
    refresh: vi.fn(),
    switchBranch: vi.fn(),
    createBranch: vi.fn(),
    renameBranch: vi.fn(),
    publishBranch: vi.fn().mockResolvedValue({ ok: true }),
    commitWorkingTree: vi.fn().mockResolvedValue({ ok: true }),
    pushBranch: vi.fn().mockResolvedValue({ ok: true }),
    mergeAndPush: vi.fn().mockResolvedValue({ ok: true, pushed: true }),
    discardFile: vi.fn().mockResolvedValue({ ok: true }),
    undoEdit: vi.fn().mockResolvedValue({ ok: true }),
    redoEdit: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as BranchesApi
}

describe("UndoRedoControls", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders Undo + Redo buttons, both disabled when history is empty", () => {
    render(<UndoRedoControls branches={makeBranches()} />)
    expect(screen.getByTestId("editor-undo")).toBeDisabled()
    expect(screen.getByTestId("editor-redo")).toBeDisabled()
  })

  it('enables Undo when canUndo; tooltip/aria reflects the label ("Undo: prop: src/App.vue")', () => {
    render(
      <UndoRedoControls
        branches={makeBranches({
          history: makeHistory({ canUndo: true, undoLabel: "prop: src/App.vue" }),
        })}
      />,
    )
    const undo = screen.getByTestId("editor-undo")
    expect(undo).not.toBeDisabled()
    expect(undo).toHaveAttribute("aria-label", "Undo: prop: src/App.vue")
  })

  it("enables Redo only when canRedo", () => {
    const { rerender } = render(
      <UndoRedoControls branches={makeBranches({ history: makeHistory({ canRedo: false }) })} />,
    )
    expect(screen.getByTestId("editor-redo")).toBeDisabled()

    rerender(
      <UndoRedoControls
        branches={makeBranches({
          history: makeHistory({ canRedo: true, redoLabel: "move: KCard" }),
        })}
      />,
    )
    const redo = screen.getByTestId("editor-redo")
    expect(redo).not.toBeDisabled()
    expect(redo).toHaveAttribute("aria-label", "Redo: move: KCard")
  })

  it("clicking Undo calls branches.undoEdit once and disables both while in flight", async () => {
    let resolveUndo: (value: { ok: boolean }) => void = () => {}
    const undoEdit = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveUndo = resolve
        }),
    )
    const branches = makeBranches({
      history: makeHistory({ canUndo: true, canRedo: true, redoLabel: "x" }),
      undoEdit,
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-undo"))

    expect(undoEdit).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByTestId("editor-undo")).toBeDisabled()
      expect(screen.getByTestId("editor-redo")).toBeDisabled()
    })

    resolveUndo({ ok: true })
    await waitFor(() => expect(screen.getByTestId("editor-undo")).not.toBeDisabled())
  })

  it("a failed undo surfaces the reason via toast", async () => {
    const branches = makeBranches({
      history: makeHistory({ canUndo: true }),
      undoEdit: vi.fn().mockResolvedValue({ ok: false, reason: "Nothing to undo." }),
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-undo"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Nothing to undo.")
    })
  })

  it("a stranded undo failure's toast carries a 'Discard step' action that calls discardStep('undo', stepId)", async () => {
    const discardStep = vi.fn().mockResolvedValue({ ok: true })
    const branches = makeBranches({
      history: makeHistory({ canUndo: true }),
      undoEdit: vi.fn().mockResolvedValue({
        ok: false,
        reason: "'a.vue' changed on disk.",
        stranded: true,
        stepId: "step-undo-123",
      }),
      discardStep,
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-undo"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "'a.vue' changed on disk.",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Discard step" }),
        }),
      )
    })

    const call = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = call[1] as { action: { onClick: () => void } }
    options.action.onClick()
    // The action's onClick must forward the SAME stepId the refusal
    // carried — not just the direction — so a stale click from another
    // tab (or a click after a new step already landed) can't blindly pop
    // whatever is on top now.
    expect(discardStep).toHaveBeenCalledWith("undo", "step-undo-123")
  })

  it("a stranded redo failure's toast action calls discardStep('redo', stepId)", async () => {
    const discardStep = vi.fn().mockResolvedValue({ ok: true })
    const branches = makeBranches({
      history: makeHistory({ canRedo: true }),
      redoEdit: vi.fn().mockResolvedValue({
        ok: false,
        reason: "'a.vue' changed on disk.",
        stranded: true,
        stepId: "step-redo-456",
      }),
      discardStep,
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-redo"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "'a.vue' changed on disk.",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Discard step" }),
        }),
      )
    })

    const call = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = call[1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(discardStep).toHaveBeenCalledWith("redo", "step-redo-456")
  })

  it("when the discard action itself refuses (stale id), surfaces a plain toast with that reason", async () => {
    const discardStep = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "History changed. Try again." })
    const branches = makeBranches({
      history: makeHistory({ canUndo: true }),
      undoEdit: vi.fn().mockResolvedValue({
        ok: false,
        reason: "'a.vue' changed on disk.",
        stranded: true,
        stepId: "step-undo-123",
      }),
      discardStep,
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-undo"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "'a.vue' changed on disk.",
        expect.objectContaining({ action: expect.anything() }),
      )
    })

    const firstCall = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = firstCall[1] as { action: { onClick: () => void } }
    options.action.onClick()

    // Tab B's user sees why the discard itself didn't work — not silence.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("History changed. Try again.")
    })
  })

  it("a non-stranded failure's toast carries no action", async () => {
    const branches = makeBranches({
      history: makeHistory({ canUndo: true }),
      undoEdit: vi.fn().mockResolvedValue({ ok: false, reason: "Nothing to undo." }),
    })
    render(<UndoRedoControls branches={branches} />)

    fireEvent.click(screen.getByTestId("editor-undo"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
    })
    const call = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1]).toBeUndefined()
  })
})

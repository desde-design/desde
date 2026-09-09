import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { SaveLLMTrace } from "@/editor/core"
import {
  SAVE_HANDOFF_TIMEOUT_STATUS,
  handOffFailureStatus,
} from "@/hooks/pending-iteration-edit"
import { SaveProgressDialog } from "./save-progress-dialog"

function makeTrace(overrides: Partial<SaveLLMTrace> = {}): SaveLLMTrace {
  return {
    outcome: "applied",
    model: "claude-opus-4-7",
    latencyMs: 12345,
    mutationCount: 1,
    mutationSummary: [
      {
        id: "m-1",
        kind: "text",
        sourceLoc: "src/Card.vue:10:5",
        target: undefined,
        before: "Default ACL",
        after: "Welcome",
      },
    ],
    truncated: false,
    perMutationOutcomes: [{ mutationId: "m-1", outcome: "applied" }],
    notes: undefined,
    ...overrides,
  }
}

describe("SaveProgressDialog", () => {
  it("does not render anything when there is no save activity", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  // There is deliberately no success state: a plain deterministic save is
  // sub-100ms and is announced by the save-status toast in `BannerToasts`
  // (banner-toasts.tsx), not by a backdrop-dimming modal. These three pin
  // that decision — the middle one is the trap, since "Cannot save: …"
  // is a FAILURE that the failure regex does not match.
  it("stays closed on a plain successful save (the toast announces it)", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus="Saved 2 DOM mutation(s)."
      />,
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("stays closed — and never says 'Saved' — when the pre-save gate blocks", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={
          "Cannot save: 2 edits still need a scope choice. Choose how to apply the pending edit in the dialog, then save again. Dismissing the dialog discards the edits."
        }
      />,
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("holds the dialog open on the structured conflict prop, not the status wording", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        // Deliberately does NOT contain "conflict"/"failed"/"error".
        saveStatus="Working tree changed since these edits were captured."
        conflict={{
          files: [{ file: "src/Card.vue", expected: "aaa", actual: "bbb" }],
          pendingMutations: [],
        }}
        onForceOverwrite={() => {}}
        onReloadAfterConflict={() => {}}
        onDismissConflict={() => {}}
      />,
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("save-dialog-conflict")).toBeInTheDocument()
    expect(screen.getByTestId("save-dialog-conflict-force")).toBeInTheDocument()
  })

  it("shows 'Saving' for the deterministic fast-path (saving, no pending LLM input)", () => {
    render(
      <SaveProgressDialog
        saving={true}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/^Saving$/)).toBeInTheDocument()
  })

  it("shows 'Asking AI…' with the mutation summary while the LLM is in flight", () => {
    render(
      <SaveProgressDialog
        saving={true}
        pendingLLMInput={[
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "src/Card.vue:10:5",
            target: undefined,
            before: "Default ACL",
            after: "Welcome",
          },
        ]}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.getByText(/Asking AI to interpret the edits/)).toBeInTheDocument()
    expect(screen.getByText(/What the AI is being asked to apply/)).toBeInTheDocument()
    expect(screen.getByText("Default ACL")).toBeInTheDocument()
    expect(screen.getByText("Welcome")).toBeInTheDocument()
  })

  it("shows the trace after the LLM completes", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={makeTrace()}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.getByText(/AI applied the edits/)).toBeInTheDocument()
    // Model + latency + edit count surface.
    expect(screen.getByText("claude-opus-4-7")).toBeInTheDocument()
    expect(screen.getByText(/12\.3s/)).toBeInTheDocument()
    expect(screen.getByText(/1 applied/)).toBeInTheDocument()
  })

  it("surfaces failure status with the error message", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus="Save failed at DOM mutations: file not found"
      />,
    )
    // Title shows the failed state; body shows the verbatim error.
    expect(
      screen.getAllByText(/Save failed/).length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/file not found/)).toBeInTheDocument()
  })

  /**
   * The hand-off's two dead ends. A save that handed its edits to chat can end
   * refused or unanswered, and neither sentence uses the word "failed" - they
   * are written for the designer, not for a regex. Both leave the mutations in
   * the buffer with nothing on disk, so both are failures the dialog has to
   * show rather than closing over. They arrive as `failureReason`, not as
   * wording on the shared `saveStatus` channel: the iteration lane writes the
   * same sentences there with no save in flight (see the pair of cases at the
   * end of this block).
   */
  it("treats an unanswered chat hand-off as a failure, and lets it be closed", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={SAVE_HANDOFF_TIMEOUT_STATUS}
        failureReason={SAVE_HANDOFF_TIMEOUT_STATUS}
      />,
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("save-dialog-error")).toHaveTextContent(
      /Chat did not answer in time/,
    )
    // A failed save is not in flight, so it carries a way out. Without one the
    // designer is stuck in front of a modal describing something that is over.
    // Two of them: the header's X and the footer's button. Both are gated on
    // the same `inFlight` check, and either one dismisses.
    const closers = screen.getAllByRole("button", { name: "Close" })
    expect(closers.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(closers[closers.length - 1]!)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("treats a refused chat hand-off as a failure too", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={null}
        streamingText=""
        saveStatus={null}
        failureReason="These 3 edits could not be sent to chat. Nothing was discarded; try again when the chat finishes."
      />,
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("save-dialog-error")).toBeInTheDocument()
  })

  it("shows truncation notice when mutationSummary is partial", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={makeTrace({
          mutationCount: 25,
          truncated: true,
        })}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.getByText(/Showing first 1 of 25\./)).toBeInTheDocument()
  })

  it("renders the live streaming response while the LLM is in flight", () => {
    render(
      <SaveProgressDialog
        saving={true}
        pendingLLMInput={[
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "src/Card.vue:10:5",
            before: "X",
            after: "Y",
          },
        ]}
        lastLLMTrace={null}
        streamingText='{"newSource":"<template>...'
        saveStatus={null}
      />,
    )
    expect(screen.getByText(/AI response \(streaming\)/)).toBeInTheDocument()
    expect(screen.getByText(/"newSource"/)).toBeInTheDocument()
  })

  it("hides the streaming block once the final trace lands", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={makeTrace()}
        streamingText='{"newSource":"<template>final"}'
        saveStatus={null}
      />,
    )
    // The trace replaces the streaming view (per-mutation outcomes are
    // the authoritative post-completion display).
    expect(screen.queryByText(/AI response \(streaming\)/)).toBeNull()
    expect(screen.getByText(/AI applied the edits/)).toBeInTheDocument()
  })

  it("renders refused outcomes distinctly", () => {
    render(
      <SaveProgressDialog
        saving={false}
        pendingLLMInput={null}
        lastLLMTrace={makeTrace({
          mutationCount: 2,
          mutationSummary: [
            {
              id: "m-1",
              kind: "text",
              sourceLoc: "src/Card.vue:10:5",
              before: "Default ACL",
              after: "Welcome",
            },
            {
              id: "m-2",
              kind: "text",
              sourceLoc: "src/Card.vue:20:5",
              before: "x",
              after: "y",
            },
          ],
          perMutationOutcomes: [
            { mutationId: "m-1", outcome: "applied" },
            {
              mutationId: "m-2",
              outcome: "refused",
              reason: "bound expression",
            },
          ],
        })}
        streamingText=""
        saveStatus={null}
      />,
    )
    expect(screen.getByText(/1 applied/)).toBeInTheDocument()
    expect(screen.getByText(/1 refused/)).toBeInTheDocument()
    expect(screen.getByText(/bound expression/)).toBeInTheDocument()
  })
  /**
   * The iteration lane writes its own hand-off sentences to the SAME
   * `saveStatus` channel, with no save in flight and a scope or
   * disambiguation dialog already open asking the designer to answer. When
   * this dialog decided failure by wording, those four sentences opened a
   * "Save failed" modal on top of the question. The wording heuristic is
   * narrow again and the save's own failures come in structurally, so the
   * only thing that can open this dialog with nothing saving is
   * `failureReason`.
   */
  describe("the shared saveStatus channel", () => {
    const iterationStatuses: [string, string][] = [
      ["timed out, parked", handOffFailureStatus("timed-out").parked],
      ["timed out, released", handOffFailureStatus("timed-out").released],
      ["refused, parked", handOffFailureStatus("refused").parked],
      ["refused, released", handOffFailureStatus("refused").released],
    ]

    it.each(iterationStatuses)(
      "stays shut for an iteration-lane status (%s) with no save failure",
      (_label, status) => {
        render(
          <SaveProgressDialog
            saving={false}
            pendingLLMInput={null}
            lastLLMTrace={null}
            streamingText=""
            saveStatus={status}
          />,
        )
        expect(screen.queryByRole("dialog")).toBeNull()
      },
    )

    it("opens on a failureReason even when the status reads like nothing", () => {
      render(
        <SaveProgressDialog
          saving={false}
          pendingLLMInput={null}
          lastLLMTrace={null}
          streamingText=""
          saveStatus="Saved 2 DOM mutation(s)."
          failureReason="Chat did not answer in time. Nothing was discarded; try again when the chat is free."
        />,
      )
      expect(screen.getByRole("dialog")).toBeInTheDocument()
      // The structured reason is what the dialog reports, not the stale
      // status string that happens to be on the shared channel.
      expect(screen.getByTestId("save-dialog-error")).toHaveTextContent(
        /did not answer in time/,
      )
      expect(screen.queryByText(/Saved 2 DOM mutation/)).toBeNull()
    })

    it("still opens on the legacy prose failures it always covered", () => {
      render(
        <SaveProgressDialog
          saving={false}
          pendingLLMInput={null}
          lastLLMTrace={null}
          streamingText=""
          saveStatus="Save threw: boom"
        />,
      )
      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByTestId("save-dialog-error")).toHaveTextContent(/boom/)
    })
  })
})

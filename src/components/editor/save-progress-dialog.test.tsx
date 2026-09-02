import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import type { SaveLLMTrace } from "@/editor/core"
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
          'Cannot save: 2 edits still need a v-for scope choice. Resolve the "Resolve ambiguous edit" dialog (or dismiss it to discard) before saving.'
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
})

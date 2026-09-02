/**
 * Regression cover for stale probe results in the connect-viewer flow.
 *
 * Found by codex review 2026-08-09. The dialog kept `projects` and `origin`
 * from a SUCCESSFUL probe across a subsequent FAILED one, so the old project
 * list stayed on screen and clickable under freshly edited inputs. Clicking
 * one stored the CURRENT token against the OLD origin and linked to a project
 * from the previous viewer — a credential and a project link both landing
 * somewhere the user never chose.
 *
 * Stale results are worse than none precisely because they read as an answer
 * to the question just asked.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const editorFetch = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({ editorFetch: (...a: unknown[]) => editorFetch(...a) }))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), success: vi.fn() }),
}))

import { ConnectViewerDialog } from "./connect-viewer-dialog"

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

const VALID_TOKEN = `dsv_${"a".repeat(16)}_${"b".repeat(43)}`

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function clickConnect() {
  fireEvent.click(screen.getByRole("button", { name: /^connect$/i }))
}

function clickBack() {
  fireEvent.click(screen.getByRole("button", { name: /^back$/i }))
}

describe("ConnectViewerDialog — stale probe results", () => {
  beforeEach(() => {
    editorFetch.mockReset()
  })

  /**
   * The hazard these cover: a project row outliving the credentials that
   * produced it. Clicking such a row stores the CURRENTLY typed token against
   * the PREVIOUSLY probed origin, linking the repo to a project on a viewer the
   * user did not choose.
   *
   * The dialog is two steps now, which removes most of the window by
   * construction: the URL and token fields are not on screen while the list is,
   * so they cannot be edited underneath it. What remains reachable is Back, and
   * that is what these exercise.
   */
  it("drops the project list when you go back to the credentials", async () => {
    editorFetch.mockImplementationOnce(() =>
      json({ ok: true, origin: "http://first.example", projects: [{ id: "p1", slug: "one", name: "First Project" }] }),
    )

    render(<ConnectViewerDialog open onOpenChange={() => {}} />)
    typeInto(/viewer url/i, "http://first.example")
    typeInto(/access token/i, VALID_TOKEN)
    clickConnect()

    await waitFor(() => expect(screen.getByText("First Project")).toBeInTheDocument())

    clickBack()
    // Back on the credentials step, and the rows are gone rather than merely
    // hidden: while they are in the DOM they are selectable.
    expect(screen.queryByText("First Project")).not.toBeInTheDocument()
    expect(screen.getByLabelText(/viewer url/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeInTheDocument()
  })

  it("clears a previous project list when a later probe fails", async () => {
    editorFetch.mockImplementationOnce(() =>
      json({ ok: true, origin: "http://first.example", projects: [{ id: "p1", slug: "one", name: "First Project" }] }),
    )

    render(<ConnectViewerDialog open onOpenChange={() => {}} />)
    typeInto(/viewer url/i, "http://first.example")
    typeInto(/access token/i, VALID_TOKEN)
    clickConnect()
    await waitFor(() => expect(screen.getByText("First Project")).toBeInTheDocument())

    // Second probe against different inputs, this time refused.
    editorFetch.mockImplementationOnce(() => json({ ok: false, reason: "That token was rejected." }, 401))
    clickBack()
    typeInto(/viewer url/i, "http://second.example")
    clickConnect()

    await waitFor(() => expect(screen.getByText(/rejected/i)).toBeInTheDocument())
    expect(screen.queryByText("First Project")).not.toBeInTheDocument()
  })

  it("discards the project list when the TOKEN changes too", async () => {
    editorFetch.mockImplementationOnce(() =>
      json({ ok: true, origin: "http://first.example", projects: [{ id: "p1", slug: "one", name: "First Project" }] }),
    )

    render(<ConnectViewerDialog open onOpenChange={() => {}} />)
    typeInto(/viewer url/i, "http://first.example")
    typeInto(/access token/i, VALID_TOKEN)
    clickConnect()
    await waitFor(() => expect(screen.getByText("First Project")).toBeInTheDocument())

    clickBack()
    typeInto(/access token/i, `dsv_${"c".repeat(16)}_${"d".repeat(43)}`)
    expect(screen.queryByText("First Project")).not.toBeInTheDocument()
  })
})

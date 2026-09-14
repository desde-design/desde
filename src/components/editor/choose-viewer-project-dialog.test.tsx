/**
 * This repo has no `@testing-library/user-event` dependency (see the note in
 * `activity-panel.test.tsx`), so clicks use `fireEvent` instead. `OptionCard`
 * renders its `<label>` with the `data-testid` passed to it, and clicking a
 * label forwards to its associated radio the same way a real click does, so
 * `fireEvent.click` on the testid is the faithful stand-in `delete-scope-
 * dialog.test.tsx` already uses for the same `OptionCard` primitive.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { ChooseViewerProjectDialog } from "./choose-viewer-project-dialog"
import type { ViewerAuthStatus } from "@/hooks/useViewerAuthStatus"

const linkProjectOnDisk = vi.fn()
vi.mock("@/services/editor-project-link", () => ({
  linkProjectOnDisk: (input: unknown) => linkProjectOnDisk(input),
}))
const editorFetch = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => editorFetch(...args),
}))

function status(overrides: Partial<ViewerAuthStatus> = {}): ViewerAuthStatus {
  return {
    configured: false,
    baseUrl: null,
    projectId: null,
    hasToken: true,
    source: null,
    defaultOrigin: "https://viewer.test",
    matchDismissed: false,
    link: {
      status: "ambiguous",
      origin: "https://viewer.test",
      candidates: [
        {
          projectId: "a",
          slug: "main-build",
          name: "Birchline",
          branch: "main",
          lastBuiltAt: "2026-09-12T09:00:00.000Z",
        },
        {
          projectId: "b",
          slug: "review",
          name: "Birchline review",
          branch: "design-review",
          lastBuiltAt: null,
        },
      ],
    },
    ...overrides,
  }
}

beforeEach(() => {
  linkProjectOnDisk.mockReset().mockResolvedValue({ ok: true })
  editorFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
})

describe("ChooseViewerProjectDialog", () => {
  it("lists every candidate with the branch it builds", () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(screen.getByText("Birchline")).toBeInTheDocument()
    expect(screen.getByText(/Builds main/)).toBeInTheDocument()
    expect(screen.getByText(/Builds design-review/)).toBeInTheDocument()
  })

  it("says comments are local until a choice is made", () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(screen.getByText(/Comments stay on this computer/)).toBeInTheDocument()
  })

  it("cannot link until a row is chosen", () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled()
    fireEvent.click(screen.getByTestId("viewer-candidate-review"))
    expect(screen.getByRole("button", { name: "Link" })).toBeEnabled()
  })

  it("links the chosen prototype, not the first one", async () => {
    const onLinked = vi.fn()
    render(<ChooseViewerProjectDialog status={status()} onLinked={onLinked} />)
    fireEvent.click(screen.getByTestId("viewer-candidate-review"))
    fireEvent.click(screen.getByRole("button", { name: "Link" }))
    await waitFor(() =>
      expect(linkProjectOnDisk).toHaveBeenCalledWith({
        projectId: "b",
        slug: "review",
        platformBaseUrl: "https://viewer.test",
      }),
    )
    expect(onLinked).toHaveBeenCalled()
  })

  it("records the dismissal when comments are kept local", async () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Keep comments local" }))
    await waitFor(() =>
      expect(editorFetch).toHaveBeenCalledWith(
        "/api/editor/viewer-auth/dismiss-match",
        expect.objectContaining({ method: "POST" }),
      ),
    )
    expect(linkProjectOnDisk).not.toHaveBeenCalled()
  })

  it("does not open once dismissed", () => {
    render(
      <ChooseViewerProjectDialog status={status({ matchDismissed: true })} onLinked={vi.fn()} />,
    )
    expect(screen.queryByText("Choose a prototype")).not.toBeInTheDocument()
  })

  it("does not open when a committed link already answers the question", () => {
    // A committed link outranks any resolution, so there is nothing to ask.
    render(
      <ChooseViewerProjectDialog
        status={status({ source: "committed", configured: true, projectId: "chosen" })}
        onLinked={vi.fn()}
      />,
    )
    expect(screen.queryByText("Choose a prototype")).not.toBeInTheDocument()
  })

  it("does not open for an unambiguous link", () => {
    render(
      <ChooseViewerProjectDialog
        status={status({
          link: { status: "linked", origin: "https://viewer.test", projectId: "a", slug: "a", name: "A" },
        })}
        onLinked={vi.fn()}
      />,
    )
    expect(screen.queryByText("Choose a prototype")).not.toBeInTheDocument()
  })
})

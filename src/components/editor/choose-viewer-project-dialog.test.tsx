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
        },
        {
          projectId: "b",
          slug: "review",
          name: "Birchline review",
          branch: "design-review",
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
    expect(screen.getByText("Branch: main")).toBeInTheDocument()
    expect(screen.getByText("Branch: design-review")).toBeInTheDocument()
  })

  it("says comments do not sync until a project is chosen", () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(
      screen.getByText(/Comments are not synced with the Viewer until a project is chosen/),
    ).toBeInTheDocument()
  })

  it("cannot link until a row is chosen", () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Link" })).toBeDisabled()
    fireEvent.click(screen.getByTestId("viewer-candidate-review"))
    expect(screen.getByRole("button", { name: "Link" })).toBeEnabled()
  })

  it("links the chosen project, not the first one", async () => {
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

  it("records the dismissal when cancelled", async () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(editorFetch).toHaveBeenCalledWith(
        "/api/editor/viewer-auth/dismiss-match",
        expect.objectContaining({ method: "POST" }),
      ),
    )
    expect(linkProjectOnDisk).not.toHaveBeenCalled()
  })

  /**
   * Escape records, exactly as Cancel does.
   *
   * They were split while the button read "Keep comments local": that label
   * stated the permanent consequence and a reflexive Escape did not, so only
   * the button made it stick. With the label now reading "Cancel"
   * (Mo, 2026-09-14) nothing distinguishes them to a reader, and a dismissal
   * that depended on which control their hand reached for would be worse than
   * either rule on its own.
   */
  it("records the dismissal on Escape too, matching Cancel", async () => {
    render(<ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />)
    expect(screen.getByText("Choose a project")).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() =>
      expect(screen.queryByText("Choose a project")).not.toBeInTheDocument(),
    )
    expect(editorFetch).toHaveBeenCalledWith(
      "/api/editor/viewer-auth/dismiss-match",
      expect.objectContaining({ method: "POST" }),
    )
  })

  /**
   * The local "closed" state has to be scoped to the origin it was closed
   * for, matching how the server scopes a real dismissal. Before this fix it
   * was a bare boolean: closing the dialog for one viewer suppressed it for
   * every viewer afterwards, including a different one the Editor pointed at
   * later in the same session.
   */
  it("re-opens for a different viewer origin after being closed for one", async () => {
    const { rerender } = render(
      <ChooseViewerProjectDialog status={status()} onLinked={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByText("Choose a project")).not.toBeInTheDocument(),
    )

    rerender(
      <ChooseViewerProjectDialog
        status={status({
          matchDismissed: false,
          link: {
            status: "ambiguous",
            origin: "https://other-viewer.test",
            candidates: [
              {
                projectId: "c",
                slug: "other",
                name: "Other viewer's prototype",
                branch: "main",
              },
            ],
          },
        })}
        onLinked={vi.fn()}
      />,
    )

    expect(screen.getByText("Choose a project")).toBeInTheDocument()
  })

  it("does not open once dismissed", () => {
    render(
      <ChooseViewerProjectDialog status={status({ matchDismissed: true })} onLinked={vi.fn()} />,
    )
    expect(screen.queryByText("Choose a project")).not.toBeInTheDocument()
  })

  it("does not open when a committed link already answers the question", () => {
    // A committed link outranks any resolution, so there is nothing to ask.
    render(
      <ChooseViewerProjectDialog
        status={status({ source: "committed", configured: true, projectId: "chosen" })}
        onLinked={vi.fn()}
      />,
    )
    expect(screen.queryByText("Choose a project")).not.toBeInTheDocument()
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
    expect(screen.queryByText("Choose a project")).not.toBeInTheDocument()
  })
})

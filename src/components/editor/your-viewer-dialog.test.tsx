import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { YourViewerDialog, summarizeViewerLink } from "./your-viewer-dialog"

/**
 * What the machine's viewer made of the open repo, in one line.
 *
 * This is the only visible consequence of setting a viewer, so each branch is
 * pinned: without it "Viewer saved" is a claim the reader cannot check.
 */
describe("summarizeViewerLink", () => {
  it("names the project when the viewer recognised this repo", () => {
    expect(
      summarizeViewerLink({
        status: "linked",
        origin: "https://v.example.com",
        projectId: "p1",
        slug: "checkout",
        name: "Checkout redesign",
      }),
    ).toBe('This project is linked to "Checkout redesign" on your viewer.')
  })

  it("says where comments go when there is no match, and names no control", () => {
    const text = summarizeViewerLink({ status: "unlinked", origin: "https://v.example.com" })
    expect(text).toBe(
      "Your viewer does not have this project yet, so comments stay on this computer.",
    )
    // Creating a project from the Editor is not built. Copy must not send
    // someone looking for a button that does not exist.
    expect(text).not.toMatch(/create/i)
  })

  it("passes a conflict through verbatim", () => {
    // The viewer withholds the other prototype's name on purpose, so there is
    // nothing to add and nothing to rephrase.
    const reason = "That id is already claimed by another prototype."
    expect(
      summarizeViewerLink({ status: "conflict", origin: "https://v.example.com", reason }),
    ).toBe(reason)
  })

  it("distinguishes a rejected token from an unreachable viewer", () => {
    expect(summarizeViewerLink({ status: "no-token", origin: "https://v.example.com" })).toMatch(
      /will not accept/i,
    )
    expect(
      summarizeViewerLink({
        status: "error",
        origin: "https://v.example.com",
        reason: "Could not reach the viewer.",
      }),
    ).toBe("Could not reach the viewer.")
  })

  it("says nothing when no viewer is set", () => {
    // The dialog is already asking for one; a line saying "no viewer" under
    // the field that sets it is the same sentence twice.
    expect(summarizeViewerLink({ status: "no-viewer" })).toBeNull()
  })
})

/**
 * Both settings menus mount this dialog unconditionally, before
 * `useViewerAuthStatus` has an answer. `defaultOrigin` starts `null` and
 * arrives later as a prop change, not at first mount — so seeding the field
 * with `useState(defaultOrigin ?? "")` (which reads its argument once) left
 * the field permanently empty on a machine that already had a viewer set
 * (codex P2, `7ed76c8`). The fix re-seeds on the render where `defaultOrigin`
 * first turns non-null, tracked against the last value it seeded so a later
 * render carrying the SAME origin does not stomp on something the user is
 * mid-typing.
 */
describe("YourViewerDialog — seeding the URL field from the stored default", () => {
  it("shows the origin once it arrives, and never clobbers a typed edit afterward", () => {
    const { rerender } = render(
      <YourViewerDialog open onOpenChange={() => {}} defaultOrigin={null} link={null} />,
    )
    // Mounted before the status probe answered: nothing to seed yet.
    expect(screen.getByLabelText(/viewer url/i)).toHaveValue("")

    // The probe resolves and the parent re-renders with the origin it found.
    rerender(
      <YourViewerDialog
        open
        onOpenChange={() => {}}
        defaultOrigin="https://viewer.test"
        link={null}
      />,
    )
    expect(screen.getByLabelText(/viewer url/i)).toHaveValue("https://viewer.test")

    // The user edits the field. A later render carrying the SAME origin (a
    // second probe returning the same answer, say) must leave it alone.
    fireEvent.change(screen.getByLabelText(/viewer url/i), {
      target: { value: "https://typed-over.test" },
    })
    rerender(
      <YourViewerDialog
        open
        onOpenChange={() => {}}
        defaultOrigin="https://viewer.test"
        link={null}
      />,
    )
    expect(screen.getByLabelText(/viewer url/i)).toHaveValue("https://typed-over.test")
  })
})

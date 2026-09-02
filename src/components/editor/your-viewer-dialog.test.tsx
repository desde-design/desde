import { describe, expect, it } from "vitest"
import { summarizeViewerLink } from "./your-viewer-dialog"

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

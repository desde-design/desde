import { describe, expect, it } from "vitest"
import { describeCommentError } from "./comment-error-copy"

/** The exact shape `viewer-http-comment-store.ts` throws. */
function apiError(status: number, body: unknown): string {
  return `Comment API GET ${status}: ${JSON.stringify(body)}`
}

describe("describeCommentError", () => {
  it("names the viewer that could not be reached, and drops the status code", () => {
    // The reported case: the headline was a verb, a status code and a JSON
    // blob, and said "failed to load" and "could not reach" at once.
    const copy = describeCommentError(
      apiError(502, { error: "Could not reach the viewer at http://localhost:3100" }),
    )
    expect(copy.title).toBe(
      "Could not reach your viewer at localhost:3100. Check that it is running.",
    )
    expect(copy.title).not.toContain("502")
    expect(copy.title).not.toContain("{")
  })

  it("keeps the original message as a quotable detail", () => {
    // Never thrown away: a bug report wants the verb, the status and the body.
    const raw = apiError(502, { error: "Could not reach the viewer at http://localhost:3100" })
    expect(describeCommentError(raw).detail).toBe(raw)
  })

  it("tells a rejected token from an unreachable viewer", () => {
    const copy = describeCommentError(
      apiError(401, { error: "No viewer token stored. Add one in Viewer project." }),
    )
    expect(copy.title).toContain("would not accept this editor's access token")
    expect(copy.title).toContain("Viewer project")
  })

  it("says a repo has no viewer set up, rather than that something failed", () => {
    const copy = describeCommentError(
      apiError(503, { error: "No viewer is configured for this repo." }),
    )
    expect(copy.title).toContain("No viewer is set up for this repo")
  })

  it("points a missing project at the chooser", () => {
    expect(describeCommentError(apiError(404, { error: "Project not found" })).title).toContain(
      "not on your viewer any more",
    )
  })

  it("explains a refusal as an access problem", () => {
    expect(describeCommentError(apiError(403, { error: "nope" })).title).toContain("refused")
  })

  it("falls back without throwing on a message it does not recognise", () => {
    // Network failures arrive as a bare `fetch` message with no status and no
    // JSON at all, so the parser must not assume either.
    const copy = describeCommentError("Failed to fetch")
    expect(copy.title).toBe("Could not load comments from your viewer.")
    expect(copy.detail).toBe("Failed to fetch")
  })

  it("survives a body that is not JSON", () => {
    const copy = describeCommentError("Comment API GET 500: <html>gateway</html>")
    expect(copy.title).toBe("Could not load comments from your viewer.")
    expect(copy.detail).toContain("<html>")
  })

  it("survives an unparseable address rather than dropping the message", () => {
    const copy = describeCommentError(
      apiError(502, { error: "Could not reach the viewer at not-a-url" }),
    )
    expect(copy.title).toContain("not-a-url")
  })
})

import { describe, expect, it } from "vitest"
import { effectiveViewerConfig } from "../viewer-link-state"

describe("effectiveViewerConfig", () => {
  it("yields no link for an ambiguous resolution", () => {
    // This is what keeps comments local while the chooser is open, and what
    // keeps them local after a dismiss. Falling back to a candidate here
    // would put the arbitrary pick straight back.
    expect(
      effectiveViewerConfig(
        { baseUrl: null, projectId: null },
        {
          status: "ambiguous",
          origin: "https://viewer.test",
          candidates: [
            { projectId: "a", slug: "a", name: "A", branch: "main", lastBuiltAt: null },
            { projectId: "b", slug: "b", name: "B", branch: "review", lastBuiltAt: null },
          ],
        },
      ),
    ).toEqual({ baseUrl: null, projectId: null, source: null })
  })

  it("still lets a committed link win over an ambiguous resolution", () => {
    expect(
      effectiveViewerConfig(
        { baseUrl: "https://viewer.test", projectId: "chosen" },
        { status: "ambiguous", origin: "https://viewer.test", candidates: [] },
      ),
    ).toEqual({ baseUrl: "https://viewer.test", projectId: "chosen", source: "committed" })
  })
})

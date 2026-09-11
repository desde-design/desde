import { describe, expect, it } from "vitest"
import { decidePrototypeEmbed } from "../review/[slug]/prototype-embed-decision"

describe("decidePrototypeEmbed", () => {
  it("embeds a static prototype in every mode", () => {
    for (const mode of ["loopback", "subdomain", "prototype-origin", "fallback"] as const) {
      expect(decidePrototypeEmbed({ mode, serve: "static" })).toEqual({ kind: "embed" })
    }
  })
  it("needs an origin for a server prototype in path mode or on the shared prototype origin", () => {
    expect(decidePrototypeEmbed({ mode: "fallback", serve: "server" })).toEqual({ kind: "needs-origin" })
    expect(decidePrototypeEmbed({ mode: "prototype-origin", serve: "server" })).toEqual({
      kind: "needs-origin",
    })
  })
  it("embeds a server prototype on its own origin whatever the process state, except crashed", () => {
    expect(
      decidePrototypeEmbed({ mode: "loopback", serve: "server", process: { state: "stopped" } }),
    ).toEqual({ kind: "embed" })
    expect(
      decidePrototypeEmbed({
        mode: "subdomain",
        serve: "server",
        process: { state: "running", port: 1, since: "" },
      }),
    ).toEqual({ kind: "embed" })
  })
  it("shows the crash instead of a frame that would 503", () => {
    expect(
      decidePrototypeEmbed({
        mode: "loopback",
        serve: "server",
        process: { state: "crashed", exitCode: 1, restarts: 3, reason: "The server kept exiting.", retryable: false },
      }),
    ).toEqual({ kind: "crashed", reason: "The server kept exiting." })
  })
  it("reports exhausted ports ahead of everything", () => {
    expect(decidePrototypeEmbed({ mode: "fallback", serve: "static", reason: "ports-exhausted" })).toEqual({
      kind: "ports-exhausted",
    })
  })
})

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
        process: { state: "running", port: 1, since: "", generation: 1 },
      }),
    ).toEqual({ kind: "embed" })
  })
  it("shows a crash the manager would NOT retry, instead of a frame that would 503", () => {
    expect(
      decidePrototypeEmbed({
        mode: "loopback",
        serve: "server",
        process: { state: "crashed", exitCode: 1, restarts: 3, reason: "The server kept exiting.", retryable: false },
      }),
    ).toEqual({ kind: "crashed", reason: "The server kept exiting." })
  })
  /**
   * One transient exit is not a dead end. The manager restarts on the next
   * `ensure`, and the iframe's own request IS that ensure, so embedding is
   * both faster (seconds) and more honest than a panel whose only offer is a
   * multi-minute rebuild.
   */
  it("embeds a crash the manager would retry", () => {
    expect(
      decidePrototypeEmbed({
        mode: "loopback",
        serve: "server",
        process: { state: "crashed", exitCode: 1, restarts: 1, reason: "The server exited.", retryable: true },
      }),
    ).toEqual({ kind: "embed" })
  })
  /**
   * Exhausted ports stop a SERVER prototype only. A static one is served
   * from the asset store in path mode with no listener at all, which is
   * exactly what the fallback shape the page builds already points at — so
   * blanking it would be a regression against the pre-branch behaviour.
   */
  it("reports exhausted ports for a server prototype and embeds a static one anyway", () => {
    expect(
      decidePrototypeEmbed({ mode: "fallback", serve: "server", reason: "ports-exhausted" }),
    ).toEqual({ kind: "ports-exhausted", count: null })
    expect(
      decidePrototypeEmbed({ mode: "fallback", serve: "static", reason: "ports-exhausted" }),
    ).toEqual({ kind: "embed" })
  })
  it("names how many ports there are when the server reported the range", () => {
    expect(
      decidePrototypeEmbed({
        mode: "fallback",
        serve: "server",
        reason: "ports-exhausted",
        range: { from: 3101, to: 3120 },
      }),
    ).toEqual({ kind: "ports-exhausted", count: 20 })
  })

  /**
   * Codex round 6, Fix 2. `reason: "listener-failed"` is the generic 503 —
   * any `ensure()` failure other than exhausted ports. Same rule as
   * ports-exhausted: a SERVER deployment has no other way to get an origin,
   * so it gets a panel; a STATIC one still loads from the shell's own path
   * prefix in fallback mode, so embedding it is unaffected.
   */
  it("shows a panel for a server prototype whose listener failed, and embeds a static one anyway", () => {
    expect(
      decidePrototypeEmbed({ mode: "fallback", serve: "server", reason: "listener-failed" }),
    ).toEqual({ kind: "listener-failed" })
    expect(
      decidePrototypeEmbed({ mode: "fallback", serve: "static", reason: "listener-failed" }),
    ).toEqual({ kind: "embed" })
  })
})

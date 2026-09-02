/**
 * The ladder — what happens after verification, and the one rung that does not
 * exist: there is no outcome that boots and continues with a known-broken
 * stamper.
 *
 * The load-bearing asymmetry under test is between the two non-`stamped`
 * verdicts. `indeterminate` must leave the server up (a client-rendered app
 * produces it on every single boot, so tearing down there would refuse to run
 * every SPA); `unstamped` must tear it down (the server is healthy and every
 * edit would be refused, so leaving it up hands the user an inspect-only
 * session they will discover mid-click).
 */
import { describe, expect, it, vi } from "vitest"
import { applyStampGate, decide, type HostDescriptor, type StampGateInput } from "../ladder.js"
import type { HostFailure, StampEvidence } from "../types.js"

const HOST: HostDescriptor = { id: "next", displayName: "Next.js", devCommand: "npx next dev" }

const SEAM_FAILURE: HostFailure = {
  code: "seam-missing",
  summary: "Editor could not boot your Next.js dev server in-process.",
  seam: {
    id: "next/dist/server/config",
    stability: "private",
    expression: 'require("next/dist/server/config").default',
    buys: "the only in-memory channel for the source-code stamper",
  },
  cause: "Cannot find module 'next/dist/server/config'",
  remediation: ["Re-run with --attach <url>."],
  attachCovers: true,
}

const INJECTION_FAILURE: HostFailure = {
  code: "injection-not-observed",
  summary:
    "Editor booted your Next.js dev server, but the source-code stamper is not running. " +
    "The server is healthy; every edit would have been refused.",
  cause: "Checked http://127.0.0.1:45100/ … Found 0 data-desde-src attributes.",
  remediation: ["Start the project's own dev server and re-run Editor with --attach <url>."],
  attachCovers: true,
}

function gateInput(overrides: Partial<StampGateInput> = {}): StampGateInput {
  return {
    evidence: { verdict: "stamped", how: "served HTML", sample: "src/App.vue:1:1", count: 1 },
    mode: "auto",
    skipVerify: false,
    host: HOST,
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("decide", () => {
  it("runs in-process when nothing failed", () => {
    expect(decide("auto", null, HOST)).toEqual({ action: "run-in-process" })
  })

  it("routes an auto-mode failure to attach, naming the seam and both commands", () => {
    const decision = decide("auto", SEAM_FAILURE, HOST)

    expect(decision.action).toBe("require-attach")
    if (decision.action === "run-in-process") throw new Error("unreachable")
    // Greppable, not archaeological: the seam id and the literal expression.
    expect(decision.message).toContain("next/dist/server/config")
    expect(decision.message).toContain('require("next/dist/server/config").default')
    expect(decision.message).toContain("Cannot find module")
    // The user's OWN dev command, so they know which server is meant. Our
    // binary is deliberately NOT named: this text is relayed into the
    // launcher's failure block, where the reader has no terminal.
    expect(decision.message).toContain("npx next dev")
    expect(decision.message).not.toContain("desde")
    // "Your project is fine" — true for every private-seam break, and the
    // opposite of what the reader assumes.
    expect(decision.message).toContain("Nothing is wrong with your project")
    expect(decision.message).toContain("--host-mode=in-process")
  })

  it("fails instead of degrading when --host-mode=in-process was explicit", () => {
    const decision = decide("in-process", SEAM_FAILURE, HOST)

    expect(decision.action).toBe("fail")
    if (decision.action === "run-in-process") throw new Error("unreachable")
    // The attach commands stay — the user still wants to know the way out,
    // they just asked not to be routed onto it automatically.
    expect(decision.message).toContain("npx next dev")
    expect(decision.message).toContain("--host-mode=in-process was passed")
  })

  it("offers --skip-stamp-verify only for the injection-not-observed class", () => {
    expect(decide("auto", INJECTION_FAILURE, HOST)).toMatchObject({
      message: expect.stringContaining("--skip-stamp-verify"),
    })
    expect(decide("auto", INJECTION_FAILURE, HOST)).toMatchObject({
      message: expect.stringContaining("has been shut down"),
    })
    // A seam that never booted has no stamping verdict to override, so
    // offering the flag would be advice that does nothing.
    const seamDecision = decide("auto", SEAM_FAILURE, HOST)
    if (seamDecision.action === "run-in-process") throw new Error("unreachable")
    expect(seamDecision.message).not.toContain("--skip-stamp-verify")
  })

  it("fails rather than advising attach when attach cannot cover the failure", () => {
    // § 1 marks this unreachable (it is FrameworkUnsupportedError's job). If an
    // upstream gate ever misses it, printing "use attach mode" would be advice
    // that cannot work.
    const decision = decide("auto", { ...SEAM_FAILURE, attachCovers: false }, HOST)
    expect(decision.action).toBe("fail")
  })
})

describe("applyStampGate — indeterminate does NOT close the server", () => {
  it("continues, with the reason surfaced as a warning", async () => {
    const close = vi.fn(async () => undefined)
    const outcome = await applyStampGate(
      gateInput({
        evidence: { verdict: "indeterminate", reason: "this app renders on the client" },
        close,
      }),
    )

    expect(outcome.kind).toBe("continue")
    if (outcome.kind !== "continue") throw new Error("unreachable")
    expect(outcome.warning).toContain("this app renders on the client")
    // The whole reason the verdict is three-valued.
    expect(close).not.toHaveBeenCalled()
  })
})

describe("applyStampGate — unstamped closes the server", () => {
  const unstamped: StampEvidence = {
    verdict: "unstamped",
    how: "served HTML at http://127.0.0.1:45100/",
    failure: INJECTION_FAILURE,
  }

  it("closes before returning the decision, and the decision is a refusal", async () => {
    const close = vi.fn(async () => undefined)
    const outcome = await applyStampGate(gateInput({ evidence: unstamped, close }))

    expect(close).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe("refuse")
    if (outcome.kind !== "refuse") throw new Error("unreachable")
    expect(outcome.decision.action).toBe("require-attach")
    expect(outcome.decision.failure.code).toBe("injection-not-observed")
  })

  it("refuses with the in-process action, not attach, under --host-mode=in-process", async () => {
    const outcome = await applyStampGate(
      gateInput({ evidence: unstamped, mode: "in-process" }),
    )

    if (outcome.kind !== "refuse") throw new Error("expected refuse")
    expect(outcome.decision.action).toBe("fail")
  })

  it("leaves the server up under --skip-stamp-verify, and says exactly what it overrode", async () => {
    const close = vi.fn(async () => undefined)
    const outcome = await applyStampGate(
      gateInput({ evidence: unstamped, skipVerify: true, close }),
    )

    expect(outcome.kind).toBe("continue")
    if (outcome.kind !== "continue") throw new Error("unreachable")
    expect(close).not.toHaveBeenCalled()
    // A silent skip would be a worse failure than the one it bypasses.
    expect(outcome.warning).toContain("--skip-stamp-verify")
    expect(outcome.warning).toContain("Edits will be refused")
  })
})

describe("applyStampGate — stamped", () => {
  it("continues with no warning at all", async () => {
    const close = vi.fn(async () => undefined)
    const outcome = await applyStampGate(gateInput({ close }))

    expect(outcome).toEqual({ kind: "continue", warning: null })
    expect(close).not.toHaveBeenCalled()
  })
})

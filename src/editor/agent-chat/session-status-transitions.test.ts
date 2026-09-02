import { describe, expect, it } from "vitest"

import {
  detectSessionStatusTransitions,
  latestPromptFromSummary,
} from "./session-status-transitions"
import type { ChatSessionSummary } from "./session-store"

function summary(over: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    sessionId: "s1",
    projectId: "p",
    createdAt: "2026-05-23T00:00:00Z",
    updatedAt: "2026-05-23T00:00:01Z",
    turnCount: 1,
    ...over,
  }
}

describe("detectSessionStatusTransitions", () => {
  it("returns no transitions on first fetch (empty prev)", () => {
    expect(
      detectSessionStatusTransitions([], [summary({ status: "idle" })]),
    ).toEqual([])
  })

  it("emits a transition when in-flight flips to idle", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [summary({ sessionId: "a", status: "idle" })]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out).toEqual([
      { sessionId: "a", preview: "Session a", toStatus: "idle" },
    ])
  })

  it("emits a transition when in-flight flips to failed and carries statusReason", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [
      summary({
        sessionId: "a",
        status: "failed",
        statusReason: "Anthropic 429",
      }),
    ]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out).toEqual([
      {
        sessionId: "a",
        preview: "Session a",
        toStatus: "failed",
        statusReason: "Anthropic 429",
      },
    ])
  })

  it("does not emit when status stayed in-flight", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [summary({ sessionId: "a", status: "in-flight" })]
    expect(detectSessionStatusTransitions(prev, next)).toEqual([])
  })

  it("does not emit when the session was idle in prev (no in-flight baseline)", () => {
    const prev = [summary({ sessionId: "a", status: "idle" })]
    const next = [summary({ sessionId: "a", status: "idle" })]
    expect(detectSessionStatusTransitions(prev, next)).toEqual([])
  })

  it("does not emit when prev had no status field (pre-Phase-5 record)", () => {
    const prev = [summary({ sessionId: "a" })]
    const next = [summary({ sessionId: "a", status: "idle" })]
    expect(detectSessionStatusTransitions(prev, next)).toEqual([])
  })

  it("does not emit when a session is missing from next (e.g. cancelled by restart-clear)", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next: ChatSessionSummary[] = []
    expect(detectSessionStatusTransitions(prev, next)).toEqual([])
  })

  it("does not emit for new sessions that appear with idle status", () => {
    const prev = [summary({ sessionId: "a", status: "idle" })]
    const next = [
      summary({ sessionId: "a", status: "idle" }),
      summary({ sessionId: "b", status: "idle" }),
    ]
    expect(detectSessionStatusTransitions(prev, next)).toEqual([])
  })

  it("emits multiple transitions in the order they appear in next", () => {
    const prev = [
      summary({ sessionId: "a", status: "in-flight" }),
      summary({ sessionId: "b", status: "in-flight" }),
      summary({ sessionId: "c", status: "in-flight" }),
    ]
    const next = [
      summary({ sessionId: "c", status: "idle" }),
      summary({ sessionId: "b", status: "failed", statusReason: "oops" }),
      summary({ sessionId: "a", status: "in-flight" }),
    ]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out.map((t) => t.sessionId)).toEqual(["c", "b"])
    expect(out[0].toStatus).toBe("idle")
    expect(out[1].toStatus).toBe("failed")
    expect(out[1].statusReason).toBe("oops")
  })

  it("uses firstUserMessagePreview when available", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [
      summary({
        sessionId: "a",
        status: "idle",
        firstUserMessagePreview: "Make this button blue",
      }),
    ]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out[0].preview).toBe("Make this button blue")
  })
})

describe("detectSessionStatusTransitions — rate-limited", () => {
  it("carries failureKind: rate-limited through the transition", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [
      summary({
        sessionId: "a",
        status: "failed",
        statusReason: "429 too many requests",
        statusFailureKind: "rate-limited",
        statusRetryAfterSeconds: 30,
      }),
    ]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out).toEqual([
      {
        sessionId: "a",
        preview: "Session a",
        toStatus: "failed",
        statusReason: "429 too many requests",
        failureKind: "rate-limited",
        retryAfterSeconds: 30,
      },
    ])
  })

  it("omits failureKind when not on a failed transition", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [summary({ sessionId: "a", status: "idle" })]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out[0]).not.toHaveProperty("failureKind")
    expect(out[0]).not.toHaveProperty("retryAfterSeconds")
  })

  it("omits retryAfterSeconds when failureKind is 'other'", () => {
    const prev = [summary({ sessionId: "a", status: "in-flight" })]
    const next = [
      summary({
        sessionId: "a",
        status: "failed",
        statusReason: "bridge timeout",
        statusFailureKind: "other",
      }),
    ]
    const out = detectSessionStatusTransitions(prev, next)
    expect(out[0].failureKind).toBe("other")
    expect(out[0]).not.toHaveProperty("retryAfterSeconds")
  })
})

describe("latestPromptFromSummary", () => {
  /**
   * The bug: this read `firstUserMessagePreview`, the session's OPENING
   * message. Mo hit a cost ceiling on a turn where he typed "hello" and
   * the toast quoted a prompt from earlier in the same session.
   */
  it("names the turn that just ran, not the one that opened the session", () => {
    expect(
      latestPromptFromSummary(
        summary({
          firstUserMessagePreview: "Move the chevron to the right",
          lastUserMessagePreview: "hello",
        }),
      ),
    ).toBe("hello")
  })

  it("falls back to the opening message when there is only one turn's worth", () => {
    expect(
      latestPromptFromSummary(
        summary({ firstUserMessagePreview: "Add a confirm dialog" }),
      ),
    ).toBe("Add a confirm dialog")
  })

  it("cuts a long last message to the width the store cuts a first one to", () => {
    // lastUserMessagePreview is stored at 200 chars, firstUserMessagePreview
    // at 60. Without the cut, switching to `last` would have let a long
    // prompt stretch the toast.
    expect(latestPromptFromSummary(summary({ lastUserMessagePreview: "x".repeat(300) })))
      .toHaveLength(60)
  })

  it("falls back to Session <prefix> when preview is missing", () => {
    expect(latestPromptFromSummary(summary({ sessionId: "abcdef1234" }))).toBe(
      "Session abcdef",
    )
  })
  it("falls back when preview is an empty string", () => {
    expect(
      latestPromptFromSummary(
        summary({
          sessionId: "abc123",
          firstUserMessagePreview: "",
          lastUserMessagePreview: "",
        }),
      ),
    ).toBe("Session abc123")
  })
})

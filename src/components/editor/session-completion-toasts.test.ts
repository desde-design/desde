import { describe, expect, it } from "vitest"
import type { SessionStatusTransition } from "@/editor/agent-chat/session-status-transitions"
import { buildSessionCompletionToasts } from "./session-completion-toasts"

const PROMPT = "Move the chevron to the right"

function t(over: Partial<SessionStatusTransition> = {}): SessionStatusTransition {
  return { sessionId: "s1", preview: PROMPT, toStatus: "idle", ...over }
}

/**
 * The bug these pin: Mo hit a session cost ceiling and got a failure toast
 * whose whole description was "Move the chevron to the right" — an old prompt,
 * presented as if it were the product's message about what went wrong.
 *
 * `statusReason` is spread onto a transition only when the server reports one,
 * so the no-reason branch was `description: t.preview` and nothing else.
 */
describe("session completion toasts", () => {
  it("never describes a failure with the prompt alone", () => {
    const [toast] = buildSessionCompletionToasts([
      t({ toStatus: "failed" }), // no statusReason — the reported case
    ])
    expect(toast.level).toBe("error")
    expect(toast.description).not.toBe(PROMPT)
    // Silence about the cause is what let the prompt read as the message.
    expect(toast.description).toContain("the server did not say why")
  })

  it("quotes the prompt so it reads as a quotation, not as prose", () => {
    for (const toast of buildSessionCompletionToasts([
      t(),
      t({ sessionId: "s2", toStatus: "failed", statusReason: "boom" }),
      t({ sessionId: "s3", toStatus: "failed", failureKind: "rate-limited" }),
    ])) {
      expect(toast.description).toContain(`“${PROMPT}”`)
    }
  })

  it("states the reason when the server gives one", () => {
    const [toast] = buildSessionCompletionToasts([
      t({ toStatus: "failed", statusReason: "session cost ceiling reached" }),
    ])
    expect(toast.description).toBe(
      `“${PROMPT}” · session cost ceiling reached`,
    )
  })

  it("truncates an unbounded reason instead of filling the viewport", () => {
    const [toast] = buildSessionCompletionToasts([
      t({ toStatus: "failed", statusReason: "x".repeat(400) }),
    ])
    expect(toast.description!.length).toBeLessThan(200)
    expect(toast.description).toContain("…")
  })

  it("carries the retry window on a rate-limited session", () => {
    const [under] = buildSessionCompletionToasts([
      t({ toStatus: "failed", failureKind: "rate-limited", retryAfterSeconds: 45 }),
    ])
    expect(under.level).toBe("warning")
    expect(under.description).toContain("try again in 45s")

    const [over] = buildSessionCompletionToasts([
      t({ toStatus: "failed", failureKind: "rate-limited", retryAfterSeconds: 240 }),
    ])
    expect(over.description).toContain("try again in 4m")
  })

  it("gives one toast per session up to three", () => {
    const toasts = buildSessionCompletionToasts([
      t({ sessionId: "a" }),
      t({ sessionId: "b" }),
      t({ sessionId: "c", toStatus: "failed", statusReason: "boom" }),
    ])
    expect(toasts).toHaveLength(3)
  })

  it("collapses a bigger batch per outcome, keeping rate-limited its own", () => {
    const toasts = buildSessionCompletionToasts([
      t({ sessionId: "a" }),
      t({ sessionId: "b" }),
      t({ sessionId: "c", toStatus: "failed", statusReason: "boom" }),
      t({ sessionId: "d", toStatus: "failed", failureKind: "rate-limited" }),
    ])
    expect(toasts.map((x) => x.level)).toEqual(["success", "warning", "error"])
    expect(toasts[0].title).toBe("2 chat sessions done")
    // Lumping the recoverable one in with the generic failure buries the only
    // affordance that says "this will work if you wait".
    expect(toasts[1].title).toBe("Chat session rate-limited")
  })

  it("says how many it left out of a collapsed stack", () => {
    const toasts = buildSessionCompletionToasts(
      ["a", "b", "c", "d"].map((sessionId) => t({ sessionId })),
    )
    expect(toasts[0].description).toContain("…")
  })
})

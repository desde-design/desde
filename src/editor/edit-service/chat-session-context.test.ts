/**
 * Tests for the AsyncLocalStorage chat-session scope primitive.
 * Pins: scope inheritance across async boundaries, sibling isolation,
 * input validation, and nested-scope behavior.
 */

import { describe, expect, it } from "vitest"

import {
  getChatSessionScope,
  runWithChatSession,
} from "./chat-session-context"

const validScope = { sessionId: "session-a", repoRoot: "/tmp/proto-x" }

describe("runWithChatSession", () => {
  it("makes the scope visible synchronously to the body", async () => {
    await runWithChatSession(validScope, async () => {
      expect(getChatSessionScope()).toEqual(validScope)
    })
  })

  it("propagates scope across awaited Promises", async () => {
    await runWithChatSession(validScope, async () => {
      await Promise.resolve()
      expect(getChatSessionScope()).toEqual(validScope)
      await new Promise<void>((res) => setTimeout(res, 1))
      expect(getChatSessionScope()).toEqual(validScope)
    })
  })

  it("propagates through chained microtasks", async () => {
    await runWithChatSession(validScope, async () => {
      const captured: (typeof validScope | undefined)[] = []
      await Promise.resolve()
        .then(() => {
          captured.push(getChatSessionScope())
        })
        .then(() => {
          captured.push(getChatSessionScope())
        })
      expect(captured).toEqual([validScope, validScope])
    })
  })

  it("clears scope outside the run", async () => {
    expect(getChatSessionScope()).toBeUndefined()
    await runWithChatSession(validScope, async () => {})
    expect(getChatSessionScope()).toBeUndefined()
  })

  it("isolates sibling scopes (parallel runs do not bleed)", async () => {
    const captured: Record<string, string> = {}
    await Promise.all([
      runWithChatSession(
        { sessionId: "s1", repoRoot: "/tmp/r1" },
        async () => {
          await new Promise((r) => setTimeout(r, 5))
          captured.a = getChatSessionScope()!.sessionId
        },
      ),
      runWithChatSession(
        { sessionId: "s2", repoRoot: "/tmp/r2" },
        async () => {
          await new Promise((r) => setTimeout(r, 5))
          captured.b = getChatSessionScope()!.sessionId
        },
      ),
    ])
    expect(captured).toEqual({ a: "s1", b: "s2" })
  })

  it("nested run replaces scope for the body and restores on exit", async () => {
    await runWithChatSession({ sessionId: "outer", repoRoot: "/tmp/o" }, async () => {
      expect(getChatSessionScope()?.sessionId).toBe("outer")
      await runWithChatSession({ sessionId: "inner", repoRoot: "/tmp/i" }, async () => {
        expect(getChatSessionScope()?.sessionId).toBe("inner")
      })
      expect(getChatSessionScope()?.sessionId).toBe("outer")
    })
  })

  it("returns the body's return value", async () => {
    const result = await runWithChatSession(validScope, async () => 42)
    expect(result).toBe(42)
  })

  it("rethrows the body's error after clearing scope", async () => {
    await expect(
      runWithChatSession(validScope, async () => {
        throw new Error("body boom")
      }),
    ).rejects.toThrow("body boom")
    expect(getChatSessionScope()).toBeUndefined()
  })

  it("rejects invalid sessionId synchronously", () => {
    expect(() =>
      runWithChatSession({ sessionId: "../escape", repoRoot: "/tmp" }, async () => {}),
    ).toThrow(/sessionId must match/i)
    expect(() =>
      runWithChatSession({ sessionId: "", repoRoot: "/tmp" }, async () => {}),
    ).toThrow(/sessionId must match/i)
  })

  it("rejects empty repoRoot synchronously", () => {
    expect(() =>
      runWithChatSession({ sessionId: "s1", repoRoot: "" }, async () => {}),
    ).toThrow(/repoRoot/i)
  })
})

describe("getChatSessionScope", () => {
  it("is undefined when no scope is active", () => {
    expect(getChatSessionScope()).toBeUndefined()
  })
})

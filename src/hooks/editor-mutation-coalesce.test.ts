/**
 * Tests for the direct-manipulation edit-buffer coalescing + capture-
 * scheduler suppression helpers (Phase 4 of the edit-lane queue work).
 *
 * These cover the queue invariants the hook relies on:
 *  - one on-screen field (one identity) → one buffered entry;
 *  - the FIRST `before` is preserved across keystrokes;
 *  - v-for siblings sharing a sourceLoc stay distinct;
 *  - the capture scheduler is suppressed for queued (and in-flight) ids.
 *
 * See tasks/editor-edit-queue-and-fanout.md § Phase 4.
 */

import { describe, expect, it } from "vitest"
import type { Mutation } from "@/editor/core/edit"
import {
  coalesceCapturedMutation,
  mutationIdentity,
  shouldProbeTextMutation,
} from "./editor-mutation-coalesce"

function makeMutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: "m-1",
    kind: "text",
    sourceLoc: "src/App.vue:12:4",
    resolutionKind: "direct",
    scope: "definition",
    callsiteLoc: null,
    instancePath: "[0]",
    selector: '[data-testid="title"]',
    before: "Hello",
    after: "Hi",
    ...overrides,
  }
}

describe("mutationIdentity", () => {
  it("is stable across keystrokes on the same field (before/after/id ignored)", () => {
    const a = makeMutation({ id: "m-1", before: "H", after: "He" })
    const b = makeMutation({ id: "m-2", before: "He", after: "Hel" })
    expect(mutationIdentity(a)).toBe(mutationIdentity(b))
  })

  it("differs when sourceLoc / instancePath / kind / target differ", () => {
    const base = makeMutation()
    expect(mutationIdentity(base)).not.toBe(
      mutationIdentity(makeMutation({ sourceLoc: "src/App.vue:99:1" })),
    )
    expect(mutationIdentity(base)).not.toBe(
      mutationIdentity(makeMutation({ instancePath: "[1]" })),
    )
    expect(mutationIdentity(base)).not.toBe(
      mutationIdentity(makeMutation({ kind: "attr", target: "title" })),
    )
    expect(mutationIdentity(makeMutation({ kind: "attr", target: "a" }))).not.toBe(
      mutationIdentity(makeMutation({ kind: "attr", target: "b" })),
    )
  })
})

describe("coalesceCapturedMutation", () => {
  it("appends a new identity", () => {
    const first = makeMutation({ id: "m-1", sourceLoc: "src/A.vue:1:1" })
    const second = makeMutation({ id: "m-2", sourceLoc: "src/B.vue:1:1" })
    const buf = coalesceCapturedMutation([first], second)
    expect(buf).toHaveLength(2)
    expect(buf[1]).toBe(second)
  })

  it("collapses repeated edits to one entry: latest after, ORIGINAL before", () => {
    // Keystroke 1: "Hello" → "Hell". Keystroke 2: live DOM `before` is now
    // "Hell"; user types to "He". The merged entry must keep before="Hello".
    const k1 = makeMutation({ before: "Hello", after: "Hell" })
    let buf = coalesceCapturedMutation([], k1)
    const k2 = makeMutation({ before: "Hell", after: "He" })
    buf = coalesceCapturedMutation(buf, k2)
    expect(buf).toHaveLength(1)
    expect(buf[0].before).toBe("Hello")
    expect(buf[0].after).toBe("He")
  })

  it("keeps v-for siblings (same sourceLoc, different instancePath) distinct", () => {
    const i0 = makeMutation({ instancePath: "[0]", after: "Zero" })
    const i1 = makeMutation({ instancePath: "[1]", after: "One" })
    let buf = coalesceCapturedMutation([], i0)
    buf = coalesceCapturedMutation(buf, i1)
    expect(buf).toHaveLength(2)
    expect(buf.map((m) => m.after)).toEqual(["Zero", "One"])
  })

  it("does not mutate the previous buffer (pure)", () => {
    const prev = [makeMutation({ before: "Hello", after: "Hell" })]
    const snapshot = JSON.stringify(prev)
    coalesceCapturedMutation(prev, makeMutation({ before: "Hell", after: "H" }))
    expect(JSON.stringify(prev)).toBe(snapshot)
  })
})

describe("shouldProbeTextMutation (capture-scheduler suppression)", () => {
  const empty = { inFlight: new Set<string>(), queued: new Set<string>() }

  it("schedules a fresh text/attr/style edit", () => {
    expect(shouldProbeTextMutation(makeMutation({ kind: "text" }), empty)).toBe(true)
    expect(
      shouldProbeTextMutation(makeMutation({ kind: "attr", target: "t" }), empty),
    ).toBe(true)
    expect(shouldProbeTextMutation(makeMutation({ kind: "style" }), empty)).toBe(true)
  })

  it("does NOT schedule class edits (different applicator lane)", () => {
    expect(shouldProbeTextMutation(makeMutation({ kind: "class" }), empty)).toBe(false)
  })

  it("suppresses scheduling for an identity already QUEUED for the AI", () => {
    const m = makeMutation()
    const queued = new Set([mutationIdentity(m)])
    expect(
      shouldProbeTextMutation(m, { inFlight: new Set(), queued }),
    ).toBe(false)
  })

  it("suppresses scheduling for an identity with a dispatch already in flight", () => {
    const m = makeMutation()
    const inFlight = new Set([mutationIdentity(m)])
    expect(
      shouldProbeTextMutation(m, { inFlight, queued: new Set() }),
    ).toBe(false)
  })
})

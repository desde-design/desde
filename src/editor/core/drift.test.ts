import { describe, expect, it } from "vitest"
import { createDriftLog, driftKey, DRIFT_KINDS, type DriftSignal } from "./drift"

function signal(overrides: Partial<DriftSignal> = {}): DriftSignal {
  return {
    kind: "hint-miss",
    component: "UiButton",
    at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

describe("driftKey", () => {
  it("combines component + importPath", () => {
    expect(driftKey("UiButton", "@acme/design-system")).toBe("UiButton::@acme/design-system")
  })

  it("defaults importPath to empty string", () => {
    expect(driftKey("UiButton")).toBe("UiButton::")
  })
})

describe("createDriftLog", () => {
  it("records a first-seen signal as a new entry", () => {
    const log = createDriftLog()
    const entry = log.record(signal())

    expect(entry.key).toBe(driftKey("UiButton"))
    expect(entry.component).toBe("UiButton")
    expect(entry.kinds).toEqual(["hint-miss"])
    expect(entry.count).toBe(1)
    expect(entry.firstSeen).toBe("2026-07-29T00:00:00.000Z")
    expect(entry.lastSeen).toBe("2026-07-29T00:00:00.000Z")
  })

  it("coalesces a repeat signal for the same key: increments count, dedupes kinds, advances lastSeen", () => {
    const log = createDriftLog()
    log.record(signal({ at: "2026-07-29T00:00:00.000Z", kind: "hint-miss" }))
    const second = log.record(
      signal({ at: "2026-07-29T00:05:00.000Z", kind: "hint-miss", detail: "second sighting" }),
    )
    // `record()` returns the SAME stored (mutable) entry on every coalesced
    // call, so snapshot the fields we care about before the next `record()`
    // mutates them further.
    const secondCount = second.count
    const secondKinds = [...second.kinds]
    const third = log.record(
      signal({ at: "2026-07-29T00:10:00.000Z", kind: "unknown-props", detail: "prop foo" }),
    )

    expect(secondCount).toBe(2)
    expect(secondKinds).toEqual(["hint-miss"])
    expect(third.count).toBe(3)
    // distinct kinds, insertion-ordered
    expect(third.kinds).toEqual(["hint-miss", "unknown-props"])
    expect(third.firstSeen).toBe("2026-07-29T00:00:00.000Z")
    expect(third.lastSeen).toBe("2026-07-29T00:10:00.000Z")
    expect(third.lastDetail).toBe("prop foo")
    // record() returns the SAME stored object identity for coalesced signals
    expect(log.get(driftKey("UiButton"))).toBe(third)
  })

  it("treats different importPath as a distinct key even for the same component name", () => {
    const log = createDriftLog()
    log.record(signal({ component: "Button", importPath: "@acme/ui" }))
    log.record(signal({ component: "Button", importPath: "@other/ui" }))

    expect(log.list()).toHaveLength(2)
  })

  it("updates designSystem on a later signal that resolves it, without clobbering with undefined", () => {
    const log = createDriftLog()
    log.record(signal({ designSystem: undefined }))
    const updated = log.record(signal({ at: "2026-07-29T00:05:00.000Z", designSystem: "acme-ds" }))
    expect(updated.designSystem).toBe("acme-ds")

    const notClobbered = log.record(signal({ at: "2026-07-29T00:10:00.000Z", designSystem: undefined }))
    expect(notClobbered.designSystem).toBe("acme-ds")
  })

  it("list() returns entries lastSeen descending", () => {
    const log = createDriftLog()
    log.record(signal({ component: "A", at: "2026-07-29T00:00:00.000Z" }))
    log.record(signal({ component: "B", at: "2026-07-29T00:10:00.000Z" }))
    log.record(signal({ component: "C", at: "2026-07-29T00:05:00.000Z" }))

    expect(log.list().map((e) => e.component)).toEqual(["B", "C", "A"])
  })

  it("get() returns undefined for an unknown key", () => {
    const log = createDriftLog()
    expect(log.get("nope::")).toBeUndefined()
  })

  it("clear(key) removes just that entry", () => {
    const log = createDriftLog()
    log.record(signal({ component: "A" }))
    log.record(signal({ component: "B" }))

    log.clear(driftKey("A"))

    expect(log.get(driftKey("A"))).toBeUndefined()
    expect(log.get(driftKey("B"))).toBeDefined()
    expect(log.list()).toHaveLength(1)
  })

  it("clear() with no key removes every entry", () => {
    const log = createDriftLog()
    log.record(signal({ component: "A" }))
    log.record(signal({ component: "B" }))

    log.clear()

    expect(log.list()).toEqual([])
  })

  it("evicts the oldest distinct key once past maxEntries", () => {
    const log = createDriftLog({ maxEntries: 2 })
    log.record(signal({ component: "A", at: "2026-07-29T00:00:00.000Z" }))
    log.record(signal({ component: "B", at: "2026-07-29T00:01:00.000Z" }))
    // A brand-new third key should evict A (the oldest-tracked), not B.
    log.record(signal({ component: "C", at: "2026-07-29T00:02:00.000Z" }))

    expect(log.get(driftKey("A"))).toBeUndefined()
    expect(log.get(driftKey("B"))).toBeDefined()
    expect(log.get(driftKey("C"))).toBeDefined()
    expect(log.list()).toHaveLength(2)
  })

  it("does not evict on a repeat signal for an already-tracked key, even at capacity", () => {
    const log = createDriftLog({ maxEntries: 2 })
    log.record(signal({ component: "A", at: "2026-07-29T00:00:00.000Z" }))
    log.record(signal({ component: "B", at: "2026-07-29T00:01:00.000Z" }))
    // Repeat sighting of A — still at capacity (2 keys), must not evict B.
    log.record(signal({ component: "A", at: "2026-07-29T00:02:00.000Z" }))

    expect(log.get(driftKey("A"))).toBeDefined()
    expect(log.get(driftKey("B"))).toBeDefined()
    expect(log.list()).toHaveLength(2)
  })

  it("defaults maxEntries to 200", () => {
    const log = createDriftLog()
    expect(log.maxEntries).toBe(200)
  })

  it("DRIFT_KINDS enumerates every DriftKind", () => {
    expect(DRIFT_KINDS).toEqual([
      "hint-miss",
      "selector-ambiguous",
      "unknown-component",
      "unknown-props",
      "manifest-value-mismatch",
    ])
  })
})

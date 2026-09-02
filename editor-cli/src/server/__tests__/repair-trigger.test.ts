/**
 * Unit tests for `triggerRepairForEntry` — the repair-triggering logic
 * extracted out of `drift-handler.ts` so BOTH the client-facing
 * `POST /api/editor/drift` route and the server-side
 * `manifest-value-mismatch` producer (`manifest-value-mismatch-drift.ts`)
 * route through the exact same guards/queue/invalidation-delivery. The
 * POST-route behavior (outcome variants, single-flight queue, dedupe,
 * `onRegistryChange` gating) is already exercised end-to-end via
 * `drift-handler.test.ts`, which now calls this same function transitively
 * — those tests staying green is the parity proof for that path. This file
 * covers the function directly, closing the one gap that mattered for the
 * extraction: a non-repairable kind must trigger nothing no matter which
 * producer recorded it.
 */
import { describe, expect, it } from "vitest"
import { createDriftLog, type DriftEntry } from "../../../../src/editor/core"
import type { RepairDeps, RepairOutcome } from "../../../../src/editor/drift/repair-component.js"
import { createRepairQueue } from "../repair-queue.js"
import { createPendingInvalidationQueue } from "../pending-invalidation-queue.js"
import { triggerRepairForEntry } from "../repair-trigger.js"

function fakeRepairDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    reextractVue: overrides.reextractVue ?? (async () => null),
    reextractReact: overrides.reextractReact ?? (async () => null),
    patchCache: overrides.patchCache ?? (() => false),
    readCache: overrides.readCache ?? (() => null),
    invalidate: overrides.invalidate ?? (() => {}),
    findRegisteredEntry: overrides.findRegisteredEntry ?? (async () => null),
    discoverVueDtsComponents: overrides.discoverVueDtsComponents ?? (async () => []),
    discoverReactDtsEntries: overrides.discoverReactDtsEntries ?? (() => []),
    resolveTsconfigPath: overrides.resolveTsconfigPath ?? (async () => null),
    resolvePackageVersion: overrides.resolvePackageVersion ?? (() => null),
    fingerprintFile: overrides.fingerprintFile ?? (() => ""),
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

function entryFor(kind: "hint-miss" | "unknown-component" | "manifest-value-mismatch", overrides: Partial<DriftEntry> = {}): DriftEntry {
  const driftLog = createDriftLog()
  const entry = driftLog.record({
    kind,
    component: "UiButton",
    importPath: "@acme/design-system",
    at: "2026-07-30T00:00:00.000Z",
  })
  Object.assign(entry, overrides)
  return entry
}

describe("triggerRepairForEntry", () => {
  it("does nothing when the signal's kind is not repairable", async () => {
    const entry = entryFor("unknown-component")
    const calls: string[] = []
    const deps = fakeRepairDeps({
      reextractVue: async () => {
        calls.push("reextract")
        return null
      },
    })

    triggerRepairForEntry("unknown-component", entry, {
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
      pendingInvalidations: createPendingInvalidationQueue(),
    })
    await flushMicrotasks()

    expect(calls).toEqual([])
    expect(entry.repair).toBeUndefined()
  })

  it("does nothing when ctx.repair is omitted", async () => {
    const entry = entryFor("hint-miss")
    triggerRepairForEntry("hint-miss", entry, {})
    await flushMicrotasks()
    expect(entry.repair).toBeUndefined()
  })

  it("does nothing on a second call for an entry that already has a repair attempt recorded", async () => {
    const entry = entryFor("hint-miss")
    const calls: string[] = []
    const deps = fakeRepairDeps({
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => {
        calls.push("reextract")
        return { id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }
      },
    })
    const queue = createRepairQueue()

    triggerRepairForEntry("hint-miss", entry, { repair: { prototypeRoot: "/proto", deps, queue } })
    await flushMicrotasks()
    expect(calls).toEqual(["reextract"])
    expect(entry.repair?.outcome).toBe("seeded")

    triggerRepairForEntry("hint-miss", entry, { repair: { prototypeRoot: "/proto", deps, queue } })
    await flushMicrotasks()
    expect(calls).toEqual(["reextract"]) // not called again
  })

  it("triggers exactly one repair for a repairable kind, enqueues its invalidation on settle, and calls onRegistryChange", async () => {
    const entry = entryFor("manifest-value-mismatch")
    const calls: string[] = []
    const deps = fakeRepairDeps({
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => {
        calls.push("reextract")
        return { id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }
      },
    })
    const pendingInvalidations = createPendingInvalidationQueue()
    let registryChanges = 0

    triggerRepairForEntry("manifest-value-mismatch", entry, {
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          registryChanges += 1
        },
      },
      pendingInvalidations,
    })
    await flushMicrotasks()

    expect(calls).toEqual(["reextract"])
    expect(entry.repair?.outcome).toBe("seeded")
    expect(registryChanges).toBe(1)
    expect(pendingInvalidations.drain()).toEqual([
      { name: "UiButton", importPath: "@acme/design-system", attemptedAt: entry.repair?.attemptedAt },
    ])
  })

  it("enqueues nothing and never calls onRegistryChange for an outcome that wrote nothing (e.g. 'unsupported')", async () => {
    const entry = entryFor("hint-miss")
    // A resolvable tsconfig but no *.vue.d.ts and no React entry discovered
    // for the package — `repairComponent` reports `unsupported`.
    const deps = fakeRepairDeps({ resolveTsconfigPath: async () => "/proto/tsconfig.json" })
    const pendingInvalidations = createPendingInvalidationQueue()
    let registryChanges = 0

    triggerRepairForEntry("hint-miss", entry, {
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          registryChanges += 1
        },
      },
      pendingInvalidations,
    })
    await flushMicrotasks()

    expect(entry.repair?.outcome).toBe("unsupported" as RepairOutcome["outcome"])
    expect(registryChanges).toBe(0)
    expect(pendingInvalidations.drain()).toEqual([])
  })
})

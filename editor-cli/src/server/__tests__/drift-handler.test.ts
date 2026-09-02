/**
 * Unit tests for the CLI drift-log routes (`POST`/`GET /api/editor/drift`).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Readable } from "node:stream"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { IncomingMessage, ServerResponse } from "node:http"
import { createDriftLog, type ComponentManifest, type ComponentManifestSource, type DriftEntry, type DriftSignal } from "../../../../src/editor/core"
import type { RepairDeps } from "../../../../src/editor/drift/repair-component.js"
import { createRepairQueue } from "../repair-queue.js"
import { createPendingInvalidationQueue } from "../pending-invalidation-queue.js"
import {
  createLocalRegistryStore,
  type RegisteredDesignSystem,
} from "../../../../src/editor/onboarding/index.js"
import type { ProbePage } from "../../../../src/editor/hints/probe-driver.js"
import { CACHE_DIR_NAME } from "../../../../src/editor/adapters/cached/index.js"
import { hintCacheFilePath, readHintCache } from "../../../../src/editor/adapters/hints-cache/index.js"
import {
  handleDriftRequest,
  matchesDriftRoute,
  MAX_SIGNALS_PER_REQUEST,
  DRIFT_ROUTE,
} from "../drift-handler.js"

/** Deferred promise, so tests can control exactly when a fake repair "settles". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

function mockReq(method: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body)
  const stream = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  stream.method = method
  stream.headers = {}
  return stream
}

/** Like `mockReq`, but with an explicit `.url` — needed for the `…/:key/regenerate-hints` sub-route, which the handler distinguishes from the base route via `req.url`. */
function mockReqAt(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body)
  const stream = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  stream.method = method
  stream.url = url
  stream.headers = {}
  return stream
}

interface CapturedRes {
  res: ServerResponse
  status: () => number
  json: () => unknown
}

function mockRes(): CapturedRes {
  let statusCode = 200
  let body = ""
  const emitter = new EventEmitter()
  Object.defineProperty(emitter, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v
    },
  })
  Object.assign(emitter, {
    setHeader: () => {},
    end: (chunk?: string) => {
      if (chunk) body = chunk
    },
  })
  const res = emitter as unknown as ServerResponse
  return {
    res,
    status: () => statusCode,
    json: () => (body ? JSON.parse(body) : undefined),
  }
}

function baseSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "hint-miss",
    component: "UiButton",
    at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

describe("matchesDriftRoute", () => {
  it("matches the base route and any sub-path under it (per-key DELETE dismiss, regenerate-hints); `handleDriftRequest` itself narrows by method", () => {
    expect(matchesDriftRoute(DRIFT_ROUTE)).toBe(true)
    expect(matchesDriftRoute(`${DRIFT_ROUTE}/foo`)).toBe(true)
    expect(matchesDriftRoute(`${DRIFT_ROUTE}/foo/regenerate-hints`)).toBe(true)
    expect(matchesDriftRoute("/api/editor/other")).toBe(false)
  })
})

describe("handleDriftRequest — POST", () => {
  it("records a valid batch and returns the updated entries", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", { signals: [baseSignal(), baseSignal({ component: "UiInput" })] })
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; recorded: number; skipped: number; entries: DriftEntry[] }
    expect(body.ok).toBe(true)
    expect(body.recorded).toBe(2)
    expect(body.skipped).toBe(0)
    expect(body.entries).toHaveLength(2)
    expect(body.entries.map((e) => e.component).sort()).toEqual(["UiButton", "UiInput"])
  })

  it("coalesces repeat signals for the same component/importPath", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", {
      signals: [
        baseSignal({ at: "2026-07-29T00:00:00.000Z" }),
        baseSignal({ at: "2026-07-29T00:01:00.000Z" }),
      ],
    })
    const { res, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    const body = json() as { entries: DriftEntry[] }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].count).toBe(2)
  })

  it("rejects a batch over the 50-signal cap with 400", async () => {
    const driftLog = createDriftLog()
    const signals = Array.from({ length: MAX_SIGNALS_PER_REQUEST + 1 }, (_, i) =>
      baseSignal({ component: `C${i}` }),
    )
    const req = mockReq("POST", { signals })
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(400)
    expect((json() as { ok: boolean }).ok).toBe(false)
    expect(driftLog.list()).toHaveLength(0)
  })

  it("skips a malformed signal without failing the request", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", {
      signals: [
        baseSignal(), // valid
        { kind: "not-a-real-kind", component: "X", at: "2026-07-29T00:00:00.000Z" }, // unknown kind
        { kind: "hint-miss", component: "", at: "2026-07-29T00:00:00.000Z" }, // empty component
        { kind: "hint-miss", component: "Y" }, // missing `at` — still recorded (server stamps it)
        { kind: "hint-miss", component: "Z", detail: "baddetail" }, // control char in detail
        "not-even-an-object",
      ],
    })
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; recorded: number; skipped: number; entries: DriftEntry[] }
    expect(body.ok).toBe(true)
    // valid signal (UiButton) + the one missing `at` (Y) both record.
    expect(body.recorded).toBe(2)
    expect(body.skipped).toBe(4)
    expect(body.entries.map((e) => e.component).sort()).toEqual(["UiButton", "Y"])
  })

  it("skips a signal whose `at` is a clean string but not a parseable timestamp", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", {
      signals: [
        baseSignal(), // valid
        baseSignal({ component: "KBad", at: "not-a-real-date" }),
      ],
    })
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; recorded: number; skipped: number; entries: DriftEntry[] }
    expect(body.recorded).toBe(1)
    expect(body.skipped).toBe(1)
    expect(body.entries.map((e) => e.component)).toEqual(["UiButton"])
  })

  it("rejects a non-array `signals` field with 400", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", { signals: "nope" })
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(400)
    expect((json() as { ok: boolean }).ok).toBe(false)
  })

  it("returns 400 on invalid JSON body", async () => {
    const driftLog = createDriftLog()
    const stream = Readable.from([Buffer.from("{ not json")]) as unknown as IncomingMessage
    stream.method = "POST"
    stream.headers = {}
    const { res, status, json } = mockRes()

    await handleDriftRequest(stream, res, { driftLog })

    expect(status()).toBe(400)
    expect((json() as { ok: boolean }).ok).toBe(false)
  })

  it("returns 413 (not 400) when the request body exceeds the size cap", async () => {
    const driftLog = createDriftLog()
    // `readJsonBody`'s default cap is 256 KiB (`DEFAULT_BODY_MAX_BYTES`) —
    // comfortably exceeded by a component name well over that.
    const oversized = JSON.stringify({
      signals: [baseSignal({ component: "X".repeat(300 * 1024) })],
    })
    const stream = Readable.from([Buffer.from(oversized)]) as unknown as IncomingMessage
    stream.method = "POST"
    stream.headers = {}
    const { res, status, json } = mockRes()

    await handleDriftRequest(stream, res, { driftLog })

    expect(status()).toBe(413)
    expect((json() as { ok: boolean }).ok).toBe(false)
  })
})

describe("handleDriftRequest — GET", () => {
  it("lists recorded entries", async () => {
    const driftLog = createDriftLog()
    driftLog.record({ kind: "hint-miss", component: "UiButton", at: "2026-07-29T00:00:00.000Z" })

    const req = mockReq("GET")
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; entries: DriftEntry[] }
    expect(body.ok).toBe(true)
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].component).toBe("UiButton")
  })

  it("lists an empty array when nothing has been recorded", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("GET")
    const { res, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect((json() as { entries: DriftEntry[] }).entries).toEqual([])
  })
})

describe("handleDriftRequest — POST triggers granular repair (Task 4)", () => {
  it("never blocks the response — resolves before the fake re-extract settles", async () => {
    const driftLog = createDriftLog()
    const gate = deferred<null>()
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      reextractVue: () => gate.promise, // never resolves during this test
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res, status, json } = mockRes()

    // If the trigger awaited the repair, this would hang the test (vitest's
    // default timeout would fail it). It doesn't hang — proving the POST
    // handler never awaits the fire-and-forget repair.
    await handleDriftRequest(req, res, { driftLog, repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() } })

    expect(status()).toBe(200)
    const body = json() as { entries: DriftEntry[] }
    expect(body.entries[0].repair?.outcome).toBe("pending")

    gate.resolve(null) // let the still-pending repair settle so it doesn't leak into other tests
  })

  it("triggers repair once for a repairable-kind signal; no prior cache settles as 'seeded', not 'repaired', and still appears in invalidate", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const calls: string[] = []
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      // No prior cached entry for this component — repairComponent has
      // nothing to compare the re-extraction against, so the correct
      // outcome is `seeded`, not `repaired` (which would falsely claim a
      // stale manifest was found and fixed).
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => {
        calls.push("reextract")
        return { id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }
      },
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    // Flush the fire-and-forget chain (a couple of microtask turns covers
    // the awaited helpers inside repairComponent + the `.then` write-back).
    await flushMicrotasks()

    expect(calls).toEqual(["reextract"])
    const entry = driftLog.get("UiButton::@acme/design-system")
    expect(entry?.repair?.outcome).toBe("seeded")

    const getReq = mockReq("GET")
    const getRes = mockRes()
    await handleDriftRequest(getReq, getRes.res, { driftLog, pendingInvalidations })
    const body = getRes.json() as {
      invalidate: Array<{ name: string; importPath?: string; attemptedAt: string }>
    }
    // A `seeded` outcome still wrote a fresh manifest to disk, so it belongs
    // in the invalidate list exactly like `repaired` does — the shell's
    // in-memory lookup is stale either way. `attemptedAt` carries the
    // repair's OWN timestamp (Task 5 fix — the shell dedupes on this, not
    // just component+importPath, so a component that drifts again after a
    // dismiss still gets invalidated).
    expect(body.invalidate).toEqual([
      { name: "UiButton", importPath: "@acme/design-system", attemptedAt: entry?.repair?.attemptedAt },
    ])

    // A second POST for the SAME entry must NOT trigger a second re-extract.
    const req2 = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res: res2 } = mockRes()
    await handleDriftRequest(req2, res2, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    await flushMicrotasks()
    expect(calls).toEqual(["reextract"]) // still just once
  })

  it("records 'repaired' (not 'seeded') and lists it in invalidate when a prior cached manifest existed and differed", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => ({
        id: "x",
        name: "UiButton",
        framework: "vue3",
        designSystem: "acme-ds",
        props: [{ name: "old-only-prop" }] as never,
      }),
      patchCache: () => true,
      reextractVue: async () => ({
        id: "x",
        name: "UiButton",
        framework: "vue3",
        designSystem: "acme-ds",
        props: [{ name: "appearance" }] as never,
      }),
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    await flushMicrotasks()

    const entry = driftLog.get("UiButton::@acme/design-system")
    expect(entry?.repair?.outcome).toBe("repaired")

    const getReq = mockReq("GET")
    const getRes = mockRes()
    await handleDriftRequest(getReq, getRes.res, { driftLog, pendingInvalidations })
    const body = getRes.json() as {
      invalidate: Array<{ name: string; importPath?: string; attemptedAt: string }>
    }
    expect(body.invalidate).toEqual([
      { name: "UiButton", importPath: "@acme/design-system", attemptedAt: entry?.repair?.attemptedAt },
    ])
  })

  it("does not trigger repair for a non-repairable kind (e.g. unknown-component)", async () => {
    const driftLog = createDriftLog()
    let called = false
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => {
        called = true
        return "/proto/tsconfig.json"
      },
    })
    const req = mockReq(
      "POST",
      { signals: [baseSignal({ kind: "unknown-component", importPath: "@acme/design-system" })] },
    )
    const { res } = mockRes()

    await handleDriftRequest(req, res, { driftLog, repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() } })
    await flushMicrotasks()

    expect(called).toBe(false)
    expect(driftLog.get("UiButton::@acme/design-system")?.repair).toBeUndefined()
  })

  it("does nothing when ctx.repair is omitted (repair is opt-in, never required)", async () => {
    const driftLog = createDriftLog()
    const req = mockReq("POST", { signals: [baseSignal()] })
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog })
    await flushMicrotasks()

    expect(status()).toBe(200)
    expect(driftLog.get("UiButton::")?.repair).toBeUndefined()
  })

  it("a failed repair is recorded and never retried, and is excluded from `invalidate`", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => null, // repairComponent will report `failed`
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    await flushMicrotasks() // let the fire-and-forget repair settle

    // Read the SETTLED state via a fresh GET — the original POST response
    // was already sent while the repair was still `pending` (that's the
    // point: the trigger never blocks the response it was recorded on).
    const getReq = mockReq("GET")
    const { res: getRes, json } = mockRes()
    await handleDriftRequest(getReq, getRes, { driftLog, pendingInvalidations })

    const body = json() as { entries: DriftEntry[]; invalidate: unknown[] }
    expect(body.entries[0].repair?.outcome).toBe("failed")
    expect(body.invalidate).toEqual([])
  })
})

describe("handleDriftRequest — POST triggers granular repair — server grounding cache reset (codex P2 fix, 2026-07-30)", () => {
  it("calls repair.onRegistryChange exactly once when a repair settles 'seeded'", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    let onRegistryChangeCalls = 0
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null, // no prior cache entry ⇒ 'seeded'
      patchCache: () => true,
      reextractVue: async () => ({ id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }),
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          onRegistryChangeCalls += 1
        },
      },
    })
    await flushMicrotasks()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("seeded")
    expect(onRegistryChangeCalls).toBe(1)
  })

  it("calls repair.onRegistryChange exactly once when a repair settles 'repaired'", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    let onRegistryChangeCalls = 0
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => ({
        id: "x",
        name: "UiButton",
        framework: "vue3",
        designSystem: "acme-ds",
        props: [{ name: "old-only-prop" }] as never,
      }),
      patchCache: () => true,
      reextractVue: async () => ({
        id: "x",
        name: "UiButton",
        framework: "vue3",
        designSystem: "acme-ds",
        props: [{ name: "appearance" }] as never,
      }),
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          onRegistryChangeCalls += 1
        },
      },
    })
    await flushMicrotasks()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("repaired")
    expect(onRegistryChangeCalls).toBe(1)
  })

  it("does NOT call repair.onRegistryChange for 'unchanged' (re-extracted manifest matches the cache — nothing written)", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    let onRegistryChangeCalls = 0
    const sameManifest = {
      id: "x",
      name: "UiButton",
      framework: "vue3" as const,
      designSystem: "acme-ds",
      props: [{ name: "appearance" }] as never,
    }
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => sameManifest,
      reextractVue: async () => sameManifest,
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          onRegistryChangeCalls += 1
        },
      },
    })
    await flushMicrotasks()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("unchanged")
    expect(onRegistryChangeCalls).toBe(0)
  })

  it("does NOT call repair.onRegistryChange for 'failed'", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    let onRegistryChangeCalls = 0
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => null, // repairComponent will report `failed`
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          onRegistryChangeCalls += 1
        },
      },
    })
    await flushMicrotasks()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("failed")
    expect(onRegistryChangeCalls).toBe(0)
  })

  it("does NOT call repair.onRegistryChange for 'unsupported' (no *.vue.d.ts discovered)", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    let onRegistryChangeCalls = 0
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [], // nothing discovered ⇒ 'unsupported'
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          onRegistryChangeCalls += 1
        },
      },
    })
    await flushMicrotasks()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("unsupported")
    expect(onRegistryChangeCalls).toBe(0)
  })

  it("omitting repair.onRegistryChange doesn't throw on a 'seeded' settle (optional field)", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => ({ id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }),
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() }, // no onRegistryChange
    })
    await expect(flushMicrotasks()).resolves.toBeUndefined()

    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("seeded")
  })
})

describe("handleDriftRequest — POST triggers granular repair — single-flight queue (final review fix wave)", () => {
  it("serializes repairs across distinct components (never concurrent) and all settle; a submission past the queue cap records a queue-full reason", async () => {
    const driftLog = createDriftLog()
    // A deliberately small cap (prod default is `REPAIR_QUEUE_CAP` = 10) so
    // this one batch can also exercise "queue full" without needing a dozen
    // fake signals: C0 runs immediately, C1-C4 fill the 4-slot pending
    // queue, and C5 arrives already at capacity.
    const queue = createRepairQueue(4)
    let concurrent = 0
    let maxConcurrent = 0
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () =>
        Array.from({ length: 5 }, (_, i) => ({
          componentName: `C${i}`,
          declarationFile: `/x/C${i}.vue.d.ts`,
        })),
      resolvePackageVersion: () => "1.0.0",
      reextractVue: async ({ componentName }) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        // A couple of microtask hops (not a real timer) — enough to prove
        // the queue holds `runningCount` at 1 across an async gap, without
        // making the test depend on wall-clock time.
        await Promise.resolve()
        await Promise.resolve()
        concurrent -= 1
        return {
          id: componentName,
          name: componentName,
          framework: "vue3",
          designSystem: "acme-ds",
          props: [],
        }
      },
    })

    const signals = Array.from({ length: 6 }, (_, i) =>
      baseSignal({ component: `C${i}`, importPath: "@acme/design-system" }),
    )
    const req = mockReq("POST", { signals })
    const { res } = mockRes()

    await handleDriftRequest(req, res, { driftLog, repair: { prototypeRoot: "/proto", deps, queue } })
    // 5 sequential repairs, several microtask hops each — flush generously.
    for (let i = 0; i < 40; i++) await Promise.resolve()

    expect(maxConcurrent).toBe(1)
    for (let i = 0; i < 5; i++) {
      const outcome = driftLog.get(`C${i}::@acme/design-system`)?.repair?.outcome
      expect(outcome).toBeDefined()
      expect(outcome).not.toBe("pending")
    }
    // C5 was submitted to the queue while 4 (the cap) were already pending
    // behind the running C0 — rejected synchronously, never actually run.
    expect(driftLog.get("C5::@acme/design-system")?.repair?.outcome).toBe("failed")
    expect(driftLog.get("C5::@acme/design-system")?.repair?.reason).toMatch(/queue full/i)
  })

  it("never blocks the response even when the queue itself has work already in flight", async () => {
    const driftLog = createDriftLog()
    const queue = createRepairQueue()
    const gate = deferred<null>()
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      reextractVue: () => gate.promise,
    })
    const req = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog, repair: { prototypeRoot: "/proto", deps, queue } })
    expect(status()).toBe(200)

    gate.resolve(null)
  })
})

/** Flush a handful of microtask turns — enough for `repairComponent`'s internal `await` chain plus its `.then` write-back to complete once its own promises have already resolved. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

describe("handleDriftRequest — POST …/:key/regenerate-hints (Task 5)", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drift-handler-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const registered = (over: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem => ({
    id: "@acme/ui",
    source: { kind: "installed", package: "@acme/ui" },
    package: "@acme/ui",
    version: "1.0.0",
    framework: "vue3",
    designSystem: "@acme/ui",
    importPath: "@acme/ui",
    addedAt: "2026-06-10T00:00:00.000Z",
    ...over,
  })

  const kButtonManifest = (): ComponentManifest => ({
    id: "@acme/ui:UiButton",
    name: "UiButton",
    framework: "vue3",
    designSystem: "@acme/ui",
    importPath: "@acme/ui",
    props: [{ name: "label", type: "string", required: false, control: { kind: "text" } }],
  })

  /** A minimal fake manifest source — the fallback path `resolveOneComponent` reaches when the bare tmpdir has no real tsconfig/installed package for `buildSource` to succeed against. */
  function fakeManifestSource(components: ComponentManifest[]): ComponentManifestSource {
    return {
      id: "fake",
      framework: "vue3",
      designSystem: "fake",
      async listComponents() {
        return components
      },
      async getComponent(name: string) {
        return components.find((c) => c.name === name) ?? null
      },
    }
  }

  /** A fake `ProbePage` returning canned RAW probe results in call order, matching `design-systems-handler.test.ts`'s own fake — see that file for the shape's provenance. */
  function fakeProbePage(rawResults: unknown[]): ProbePage & { __wasClosed: () => boolean } {
    let i = 0
    let closed = false
    return {
      async goto() {},
      async evaluate<T>(): Promise<T> {
        const r = rawResults[i] ?? { ok: false, reason: "no more fake results" }
        i++
        return r as T
      },
      async close() {
        closed = true
      },
      __wasClosed: () => closed,
    }
  }

  function regenCtx(overrides: {
    getManifestSource?: () => Promise<ComponentManifestSource | null>
    createProbePage?: () => Promise<ProbePage | null>
    viteBaseUrl?: string
    onRegistryChange?: () => void
  } = {}) {
    return {
      canonicalRoot: root,
      getManifestSource: overrides.getManifestSource ?? (async () => null),
      createProbePage: overrides.createProbePage ?? (async () => null),
      viteBaseUrl: overrides.viteBaseUrl ?? "http://127.0.0.1:5173",
      onRegistryChange: overrides.onRegistryChange ?? (() => {}),
    }
  }

  function recordEntry(driftLog: ReturnType<typeof createDriftLog>, over: Partial<DriftSignal> = {}): DriftEntry {
    return driftLog.record({
      kind: "hint-miss",
      component: "UiButton",
      importPath: "@acme/ui",
      designSystem: "@acme/ui",
      at: "2026-07-29T00:00:00.000Z",
      ...over,
    })
  }

  it("404s for an unknown drift key", async () => {
    const driftLog = createDriftLog()
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog, regenerateHints: regenCtx() })

    expect(status()).toBe(404)
    expect((json() as { ok: boolean }).ok).toBe(false)
  })

  it("404s when regenerateHints wiring is omitted (route not available on this server)", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(404)
  })

  it("422s when the entry has no resolved design system", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog, { designSystem: undefined, importPath: undefined })
    const key = driftLog.list()[0].key
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/${encodeURIComponent(key)}/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog, regenerateHints: regenCtx() })

    expect(status()).toBe(422)
    expect((json() as { reason: string }).reason).toMatch(/no resolved design system/i)
  })

  it("422s when no registered design system matches the entry", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog, regenerateHints: regenCtx() })

    expect(status()).toBe(422)
    expect((json() as { reason: string }).reason).toMatch(/no registered design system/i)
  })

  it("422s when the registered package isn't installed (packageRoot set, not repo-ingested)", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(
      registered({ packageRoot: ".desde/ingested/@acme/ui" }),
    )
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog, regenerateHints: regenCtx() })

    expect(status()).toBe(422)
    expect((json() as { reason: string }).reason).toMatch(/not installed/i)
  })

  it("422s when the component can't be resolved in the design system's manifest source", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(
      req,
      res,
      { driftLog, regenerateHints: regenCtx({ getManifestSource: async () => fakeManifestSource([]) }) },
    )

    expect(status()).toBe(422)
    expect((json() as { reason: string }).reason).toMatch(/not found/i)
  })

  it("runs generateHintsRun with a ONE-ELEMENT components array, writes the hint file, and invalidates grounding on success", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const page = fakeProbePage([
      {
        ok: true,
        findings: [
          { sentinel: "x", kind: "prop", name: "label", matches: [{ selector: ":root", field: "textContent" }] },
        ],
      },
    ])
    let registryChanged = false
    const onRegistryChange = () => {
      registryChanged = true
    }
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      regenerateHints: regenCtx({
        getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
        createProbePage: async () => page,
        onRegistryChange,
      }),
    })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; result: { probed: number; hinted: number } }
    expect(body.ok).toBe(true)
    expect(body.result.probed).toBe(1)
    expect(body.result.hinted).toBe(1)
    expect(registryChanged).toBe(true)
    expect(page.__wasClosed()).toBe(true)

    const cacheFile = hintCacheFilePath(join(root, CACHE_DIR_NAME), "@acme/ui", "1.0.0")
    const cache = readHintCache(cacheFile)
    expect(cache?.hints.UiButton).toBeDefined()
  })

  it("422s (non-stream) and closes the probe page when generateHintsRun throws", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, {
      driftLog,
      regenerateHints: regenCtx({
        getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
        createProbePage: async () => null, // no headless browser available
      }),
    })

    expect(status()).toBe(422)
    expect((json() as { reason: string }).reason).toMatch(/no headless browser/i)
  })

  it("streams SSE progress + result when the client asks for text/event-stream", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const page = fakeProbePage([
      {
        ok: true,
        findings: [
          { sentinel: "x", kind: "prop", name: "label", matches: [{ selector: ":root", field: "textContent" }] },
        ],
      },
    ])
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    req.headers = { accept: "text/event-stream" }
    const frames: string[] = []
    const { res } = mockRes()
    ;(res as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      frames.push(chunk)
      return true
    }
    ;(res as unknown as { setHeader: () => void }).setHeader = () => {}
    ;(res as unknown as { flushHeaders: () => void }).flushHeaders = () => {}

    await handleDriftRequest(req, res, {
      driftLog,
      regenerateHints: regenCtx({
        getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
        createProbePage: async () => page,
      }),
    })

    const joined = frames.join("")
    expect(joined).toContain('"type":"result"')
  })

  it("includes an invalidate entry for the regenerated component in the SSE result frame (codex P2, 2026-07-30)", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const page = fakeProbePage([
      {
        ok: true,
        findings: [
          { sentinel: "x", kind: "prop", name: "label", matches: [{ selector: ":root", field: "textContent" }] },
        ],
      },
    ])
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    req.headers = { accept: "text/event-stream" }
    const frames: string[] = []
    const { res } = mockRes()
    ;(res as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      frames.push(chunk)
      return true
    }
    ;(res as unknown as { setHeader: () => void }).setHeader = () => {}
    ;(res as unknown as { flushHeaders: () => void }).flushHeaders = () => {}

    await handleDriftRequest(req, res, {
      driftLog,
      regenerateHints: regenCtx({
        getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
        createProbePage: async () => page,
      }),
    })

    const resultFrame = parseSseResultFrame(frames.join(""))
    expect(resultFrame.invalidate).toEqual([
      { name: "UiButton", importPath: "@acme/ui", attemptedAt: expect.any(String) },
    ])
  })

  it("emits no invalidate entry (non-stream) when the run never wrote the hint cache", async () => {
    const driftLog = createDriftLog()
    recordEntry(driftLog)
    await createLocalRegistryStore(root).add(registered())
    const req = mockReqAt("POST", `${DRIFT_ROUTE}/UiButton%3A%3A%40acme%2Fui/regenerate-hints`)
    const { res, status, json } = mockRes()

    // No probe page and no source inference wired ⇒ nothing is mounted or
    // inferred for UiButton, so `generateHintsRun` never writes the cache
    // (`wroteCache: false`) — mirrors `invalidateList`'s "a write happened,
    // go re-read it" posture: nothing changed on disk, nothing to invalidate.
    await handleDriftRequest(req, res, {
      driftLog,
      regenerateHints: regenCtx({
        getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
        createProbePage: async () => fakeProbePage([{ ok: false, reason: "mount failed" }]),
      }),
    })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; result: { wroteCache: boolean }; invalidate: unknown[] }
    expect(body.result.wroteCache).toBe(false)
    expect(body.invalidate).toEqual([])
  })
})

/** Extract the `{"type":"result", ...}` frame's parsed JSON from a joined SSE response body. */
function parseSseResultFrame(joined: string): { invalidate?: unknown[] } {
  const frame = joined
    .split("\n\n")
    .find((f) => f.includes('"type":"result"'))
  if (!frame) throw new Error("no result frame found in SSE response")
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
  return JSON.parse(dataLines.join("\n"))
}

describe("handleDriftRequest — other methods", () => {
  it("returns 405 for an unsupported method", async () => {
    const driftLog = createDriftLog()
    // DELETE is now a supported method on the base route (Phase 5 Task 5 —
    // "Clear all"), so exercise a genuinely unrecognized one instead.
    const req = mockReq("PATCH")
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(405)
  })
})

describe("handleDriftRequest — DELETE (Task 5 dismiss/clear-all)", () => {
  it("DELETE …/:key dismisses one entry, leaving others intact", async () => {
    const driftLog = createDriftLog()
    driftLog.record({ kind: "hint-miss", component: "UiButton", at: "2026-07-29T00:00:00.000Z" })
    driftLog.record({ kind: "hint-miss", component: "UiInput", at: "2026-07-29T00:00:00.000Z" })

    const req = mockReqAt("DELETE", `${DRIFT_ROUTE}/${encodeURIComponent("UiButton::")}`)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    const body = json() as { ok: boolean; entries: DriftEntry[] }
    expect(body.ok).toBe(true)
    expect(body.entries.map((e) => e.component)).toEqual(["UiInput"])
    expect(driftLog.list()).toHaveLength(1)
  })

  it("DELETE …/:key on an unknown key is a no-op 200 (idempotent dismiss)", async () => {
    const driftLog = createDriftLog()
    driftLog.record({ kind: "hint-miss", component: "UiButton", at: "2026-07-29T00:00:00.000Z" })
    const req = mockReqAt("DELETE", `${DRIFT_ROUTE}/${encodeURIComponent("Nope::")}`)
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    expect(driftLog.list()).toHaveLength(1)
  })

  it("DELETE the base route clears every entry", async () => {
    const driftLog = createDriftLog()
    driftLog.record({ kind: "hint-miss", component: "UiButton", at: "2026-07-29T00:00:00.000Z" })
    driftLog.record({ kind: "hint-miss", component: "UiInput", at: "2026-07-29T00:00:00.000Z" })

    const req = mockReqAt("DELETE", DRIFT_ROUTE)
    const { res, status, json } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(200)
    expect((json() as { entries: DriftEntry[] }).entries).toEqual([])
    expect(driftLog.list()).toHaveLength(0)
  })

  it("DELETE …/:key with a malformed percent-encoding 400s", async () => {
    const driftLog = createDriftLog()
    const req = mockReqAt("DELETE", `${DRIFT_ROUTE}/%E0%A4%A`)
    const { res, status } = mockRes()

    await handleDriftRequest(req, res, { driftLog })

    expect(status()).toBe(400)
  })
})

describe("handleDriftRequest — invalidation delivery survives dismiss/clear-all (Phase 5 Task 2 root-cause fix, 2026-07-30)", () => {
  /** A repair whose settle timing the test controls, via the deferred-gate pattern used elsewhere in this file. */
  function fakeRepairDepsWithGate(gate: { promise: Promise<ComponentManifest | null> }): RepairDeps {
    return fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [{ componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" }],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null, // no prior cache ⇒ a successful re-extract settles as 'seeded'
      patchCache: () => true,
      reextractVue: () => gate.promise,
    })
  }

  it("a repair that settles AFTER its entry was dismissed (`DELETE …/:key`) is still delivered on the next GET — the exact gap the old per-entry derivation could never close", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const gate = deferred<ComponentManifest | null>()
    const deps = fakeRepairDepsWithGate(gate)

    const postReq = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res: postRes } = mockRes()
    await handleDriftRequest(postReq, postRes, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    expect(driftLog.get("UiButton::@acme/design-system")?.repair?.outcome).toBe("pending")

    // Dismiss the row WHILE the repair is still pending — the entry is gone
    // from the log before its repair has anything to report.
    const dismissReq = mockReqAt("DELETE", `${DRIFT_ROUTE}/${encodeURIComponent("UiButton::@acme/design-system")}`)
    const { res: dismissRes, json: dismissJson } = mockRes()
    await handleDriftRequest(dismissReq, dismissRes, { driftLog, pendingInvalidations })
    expect(driftLog.list()).toHaveLength(0) // entry really is gone
    expect((dismissJson() as { invalidate: unknown[] }).invalidate).toEqual([]) // nothing settled yet

    // NOW the repair settles — its `.then` enqueues onto `pendingInvalidations`
    // directly, independent of the (now-empty) drift log.
    gate.resolve({ id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] })
    await flushMicrotasks()

    const getReq = mockReq("GET")
    const { res: getRes, json: getJson } = mockRes()
    await handleDriftRequest(getReq, getRes, { driftLog, pendingInvalidations })
    expect(getJson() as { invalidate: Array<{ name: string; importPath?: string; attemptedAt: string }> }).toMatchObject({
      invalidate: [{ name: "UiButton", importPath: "@acme/design-system" }],
    })
  })

  it("clear-all (`DELETE` base route) doesn't lose a still-pending repair's eventual invalidation", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const gate = deferred<ComponentManifest | null>()
    const deps = fakeRepairDepsWithGate(gate)

    const postReq = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res: postRes } = mockRes()
    await handleDriftRequest(postReq, postRes, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })

    // Clear-all wipes the log while the repair is still pending.
    const clearReq = mockReqAt("DELETE", DRIFT_ROUTE)
    const { res: clearRes, json: clearJson } = mockRes()
    await handleDriftRequest(clearReq, clearRes, { driftLog, pendingInvalidations })
    expect(driftLog.list()).toHaveLength(0)
    expect((clearJson() as { invalidate: unknown[] }).invalidate).toEqual([])

    gate.resolve({ id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] })
    await flushMicrotasks()

    const postReq2 = mockReq("POST", { signals: [] })
    const { res: postRes2, json: postJson2 } = mockRes()
    await handleDriftRequest(postReq2, postRes2, { driftLog, pendingInvalidations })
    expect(postJson2() as { invalidate: Array<{ name: string; importPath?: string }> }).toMatchObject({
      invalidate: [{ name: "UiButton", importPath: "@acme/design-system" }],
    })
  })

  it("a settled repair's invalidation is delivered exactly ONCE — drained, not re-sent on a later response", async () => {
    const driftLog = createDriftLog()
    const pendingInvalidations = createPendingInvalidationQueue()
    const gate = deferred<ComponentManifest | null>()
    const deps = fakeRepairDepsWithGate(gate)

    const postReq = mockReq("POST", { signals: [baseSignal({ importPath: "@acme/design-system" })] })
    const { res: postRes } = mockRes()
    await handleDriftRequest(postReq, postRes, {
      driftLog,
      pendingInvalidations,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    gate.resolve({ id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] })
    await flushMicrotasks()

    const getReq1 = mockReq("GET")
    const { res: getRes1, json: getJson1 } = mockRes()
    await handleDriftRequest(getReq1, getRes1, { driftLog, pendingInvalidations })
    expect((getJson1() as { invalidate: unknown[] }).invalidate).toHaveLength(1)

    // A second response after the drain must NOT re-report the same settle.
    const getReq2 = mockReq("GET")
    const { res: getRes2, json: getJson2 } = mockRes()
    await handleDriftRequest(getReq2, getRes2, { driftLog, pendingInvalidations })
    expect((getJson2() as { invalidate: unknown[] }).invalidate).toEqual([])
  })
})

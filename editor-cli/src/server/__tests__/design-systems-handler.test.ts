/**
 * Unit tests for the CLI design-systems onboarding routes. The heavy success
 * path (real TS extraction) is covered by the orchestrator's own tests; here we
 * exercise routing, validation, the registry list/delete round-trip, and the
 * real orchestrator wiring up to its deterministic "package not installed"
 * refusal (no real package needed).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { handleDesignSystemsRequest, type StalenessCache } from "../design-systems-handler.js"
import { createLocalRegistryStore } from "../../../../src/editor/onboarding/index.js"
import type {
  OnboardRequest,
  RegisteredDesignSystem,
  ReconcileStatus,
  StalenessResult,
} from "../../../../src/editor/onboarding/index.js"
import type { ComponentManifest, ComponentManifestSource, GroundingHealth } from "../../../../src/editor/core"
import type { ProbePage } from "../../../../src/editor/hints/probe-driver.js"
import type { CompleteOpts, CompleteResult, CompletionProvider } from "../../../../src/editor/llm-providers/types.js"
import { CACHE_DIR_NAME } from "../../../../src/editor/adapters/cached/index.js"
import {
  hintCacheFilePath,
  readHintCache,
  writeHintCache,
  HINTS_SCHEMA_VERSION,
} from "../../../../src/editor/adapters/hints-cache/index.js"

// Wraps the real `onboardDesignSystem` so every existing test in this file
// keeps exercising the real orchestrator by default — only the dedicated
// allowBuild-consent test below overrides it (once) to capture the request
// the handler builds, without running a real clone/install.
vi.mock("../../../../src/editor/onboarding/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/editor/onboarding/index.js")>()
  return {
    ...actual,
    onboardDesignSystem: vi.fn(actual.onboardDesignSystem),
  }
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ds-handler-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * `withSocket: true` attaches a fake `.socket` (a plain `EventEmitter`) to
 * the returned request, matching the shape `watchClientDisconnect`
 * (`../sse.js`) prefers for client-disconnect detection over the request
 * stream's own `close` (see the disconnect tests in the generate-hints
 * describe block below). The request itself is a real `Readable` — Node
 * streams are `EventEmitter`s — so `.emit('close')` on it directly is also
 * available for tests that want to exercise the socket-less fallback path.
 */
function mockReq(
  method: string,
  opts: { body?: unknown; accept?: string; url?: string; withSocket?: boolean } = {},
): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body)
  const stream = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  stream.method = method
  stream.headers = opts.accept ? { accept: opts.accept } : {}
  stream.url = opts.url
  if (opts.withSocket) {
    // Cast away `IncomingMessage.socket`'s real `Socket` type — the fake
    // only needs to be an `EventEmitter` for `attachDisconnectListener`
    // (`../sse.js`), which only ever calls `.once('close', …)` / `.off(…)`
    // on it.
    ;(stream as unknown as { socket: EventEmitter }).socket = new EventEmitter()
  }
  return stream
}

/** Reads back the fake `.socket` `EventEmitter` attached by `mockReq({ withSocket: true })`. */
function fakeSocket(req: IncomingMessage): EventEmitter {
  return (req as unknown as { socket: EventEmitter }).socket
}

interface CapturedRes {
  res: ServerResponse
  status: () => number
  json: () => unknown
  frames: () => string[]
  ended: () => boolean
  /** Emits 'close' on the fake response — simulates the client disconnecting
   *  (or the underlying connection tearing down) from the response side. */
  emitClose: () => void
}

function mockRes(): CapturedRes {
  let statusCode = 200
  let body = ""
  const frames: string[] = []
  let ended = false
  const emitter = new EventEmitter()
  Object.defineProperty(emitter, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v
    },
  })
  Object.assign(emitter, {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    end: (chunk?: string) => {
      if (chunk) body = chunk
      ended = true
    },
  })
  const res = emitter as unknown as ServerResponse
  return {
    res,
    status: () => statusCode,
    json: () => (body ? JSON.parse(body) : undefined),
    frames: () => frames,
    ended: () => ended,
    emitClose: () => emitter.emit("close"),
  }
}

const entry = (over: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem => ({
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

/**
 * A minimal but REAL onboardable Vue library: a prototype-root tsconfig +
 * an installed package shipping one self-contained `*.vue.d.ts` under
 * `dist/types` (a `detectFramework`/`discoverVueDtsComponents` probe root).
 * Used by the `…/refresh` round-trip tests, which exercise the real
 * orchestrator (no mocking) end-to-end — refresh re-runs the SAME
 * extraction path as a first-time onboard.
 */
function writeMinimalVuePackage(protoRoot: string, pkg: string): void {
  writeFileSync(
    join(protoRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ["esnext"],
      },
    }),
  )
  const pkgDir = join(protoRoot, "node_modules", pkg)
  mkdirSync(join(pkgDir, "dist/types"), { recursive: true })
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }))
  writeFileSync(
    join(pkgDir, "dist/types/Widget.vue.d.ts"),
    [
      "export interface WidgetProps {",
      "  /** Visible label text. */",
      "  label?: string;",
      "  /** Size variant. */",
      "  size?: 'sm' | 'lg';",
      "}",
      "declare const _default: new () => { $props: WidgetProps };",
      "export default _default;",
      "",
    ].join("\n"),
  )
}

interface StalenessOverrides {
  getStalenessCache?: () => StalenessCache | null
  setStalenessCache?: (cache: StalenessCache) => void
  checkStaleness?: (entry: RegisteredDesignSystem) => Promise<StalenessResult>
}

/**
 * Phase 4 Task 3 (probe-derived hints) ctx seams. Defaults model "hint
 * generation unavailable" (no manifest source, no launchable browser) —
 * the SAME degrade-gracefully shape production wiring falls back to when
 * e.g. no Playwright browser is installed. Tests exercising the
 * generate-hints route override these with fakes.
 */
interface HintsOverrides {
  getManifestSource?: () => Promise<ComponentManifestSource | null>
  createProbePage?: () => Promise<ProbePage | null>
  viteBaseUrl?: string
  /** Phase 4 Task 5 — injected fake LLM provider; tests exercising `useLlm` override this. */
  getLlmProvider?: () => CompletionProvider
}

const ctx = (
  onChange = vi.fn(),
  getGroundingHealth: () => Promise<GroundingHealth | null> = vi.fn(async () => null),
  getReconciliationStatus: () => ReconcileStatus | null = () => null,
  staleness: StalenessOverrides = {},
  hints: HintsOverrides = {},
) => {
  // Independent per-call in-memory cache by default — tests that want to
  // observe caching ACROSS two requests build one `ctx(...)` and reuse it.
  let cache: StalenessCache | null = null
  return {
    canonicalRoot: root,
    onRegistryChange: onChange,
    getGroundingHealth,
    getReconciliationStatus,
    getStalenessCache: staleness.getStalenessCache ?? (() => cache),
    setStalenessCache:
      staleness.setStalenessCache ??
      ((c: StalenessCache) => {
        cache = c
      }),
    checkStaleness:
      staleness.checkStaleness ??
      (async (entry: RegisteredDesignSystem): Promise<StalenessResult> => ({
        id: entry.id,
        state: "fresh" as const,
      })),
    getManifestSource: hints.getManifestSource ?? (async () => null),
    createProbePage: hints.createProbePage ?? (async () => null),
    viteBaseUrl: hints.viteBaseUrl ?? "http://127.0.0.1:5173",
    getLlmProvider: hints.getLlmProvider,
  }
}

describe("handleDesignSystemsRequest", () => {
  it("GET lists registered systems (empty, then populated) with health:null when ungrounded", async () => {
    let r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    expect(r.status()).toBe(200)
    expect(r.json()).toEqual({ ok: true, designSystems: [], health: null, reconciliation: null })

    await createLocalRegistryStore(root).add(entry())
    r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    expect((r.json() as { designSystems: unknown[] }).designSystems).toHaveLength(1)
    expect((r.json() as { health: unknown }).health).toBeNull()
  })

  it("GET marks `declared` per entry from desde.config.json", async () => {
    await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
    await createLocalRegistryStore(root).add(
      entry({ id: "@acme/other", package: "@acme/other", designSystem: "@acme/other" }),
    )
    writeFileSync(
      join(root, "desde.config.json"),
      JSON.stringify({ designSystems: [{ kind: "installed", package: "@acme/ui" }] }),
    )

    const r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    expect(r.status()).toBe(200)
    const body = r.json() as { designSystems: Array<{ id: string; declared: boolean }> }
    const declared = Object.fromEntries(body.designSystems.map((e) => [e.id, e.declared]))
    expect(declared["@acme/ui"]).toBe(true)
    expect(declared["@acme/other"]).toBe(false)
  })

  it("GET surfaces `declarationsError` (and still lists registry entries) when the config is syntactically broken", async () => {
    await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
    // Not valid JSON — simulates a hand-edit gone wrong AFTER boot (the
    // boot-time load already happened and won't log again; this must not go
    // silent on subsequent GETs).
    writeFileSync(join(root, "desde.config.json"), "{ this is not json")

    const r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    expect(r.status()).toBe(200)
    const body = r.json() as {
      designSystems: Array<{ id: string; declared: boolean }>
      declarationsError?: string
    }
    expect(body.designSystems).toHaveLength(1)
    expect(body.designSystems[0].declared).toBe(false)
    expect(typeof body.declarationsError).toBe("string")
    expect(body.declarationsError!.length).toBeGreaterThan(0)
  })

  it("GET surfaces the reconciliation status from the ctx getter, defaulting to null", async () => {
    const status: ReconcileStatus = {
      startedAt: "2026-07-26T00:00:00.000Z",
      entries: [{ identity: "@acme/ui", label: "@acme/ui", kind: "installed", state: "done", registryEntryId: "@acme/ui" }],
    }
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("GET"),
      r.res,
      "/api/editor/design-systems",
      ctx(vi.fn(), vi.fn(async () => null), () => status),
    )
    expect((r.json() as { reconciliation: ReconcileStatus }).reconciliation).toEqual(status)
  })

  it("GET surfaces the health object when the ctx getter resolves one", async () => {
    const health: GroundingHealth = {
      root,
      builtAt: "2026-07-25T00:00:00.000Z",
      sources: [{ step: "storybook", sourceId: "storybook", discovered: 0, status: "ok" }],
      runtimeErrors: [],
    }
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("GET"),
      r.res,
      "/api/editor/design-systems",
      ctx(vi.fn(), vi.fn(async () => health)),
    )
    expect(r.status()).toBe(200)
    expect((r.json() as { health: GroundingHealth }).health).toEqual(health)
  })

  it("GET degrades health to null (still 200 with the designSystems list) when getGroundingHealth rejects", async () => {
    // Health is diagnostic-only and nullable — a rejecting health lookup must
    // never fail the registry listing itself.
    await createLocalRegistryStore(root).add(entry())
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("GET"),
      r.res,
      "/api/editor/design-systems",
      ctx(vi.fn(), vi.fn(async () => {
        throw new Error("grounding service unavailable")
      })),
    )
    expect(r.status()).toBe(200)
    const body = r.json() as { ok: boolean; designSystems: unknown[]; health: unknown }
    expect(body.ok).toBe(true)
    expect(body.health).toBeNull()
    expect(body.designSystems).toHaveLength(1)
  })

  it("GET /suggestions returns an ok shape", async () => {
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("GET"),
      r.res,
      "/api/editor/design-systems/suggestions",
      ctx(),
    )
    expect(r.status()).toBe(200)
    expect(r.json()).toMatchObject({ ok: true })
    expect(Array.isArray((r.json() as { suggestions: unknown[] }).suggestions)).toBe(true)
  })

  it("DELETE removes an entry and invalidates the grounding cache", async () => {
    const store = createLocalRegistryStore(root)
    await store.add(entry())
    const onChange = vi.fn()
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("DELETE"),
      r.res,
      "/api/editor/design-systems/%40acme%2Fui",
      ctx(onChange),
    )
    expect(r.status()).toBe(200)
    expect(r.json()).toEqual({ ok: true, removed: "@acme/ui" })
    expect(onChange).toHaveBeenCalledOnce()
    expect(await store.list()).toHaveLength(0)
  })

  it("POST rejects an invalid source shape with 400 (before any I/O)", async () => {
    const onChange = vi.fn()
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("POST", { body: { source: { kind: "installed" } } }),
      r.res,
      "/api/editor/design-systems",
      ctx(onChange),
    )
    expect(r.status()).toBe(400)
    expect((r.json() as { reason: string }).reason).toMatch(/Invalid 'source'/)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("POST a not-installed package surfaces 422 and does NOT register/invalidate", async () => {
    const onChange = vi.fn()
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("POST", { body: { source: { kind: "installed", package: "@nope/not-installed" } } }),
      r.res,
      "/api/editor/design-systems",
      ctx(onChange),
    )
    expect(r.status()).toBe(422)
    expect((r.json() as { reason: string }).reason).toMatch(/not installed/i)
    expect(onChange).not.toHaveBeenCalled()
    expect(await createLocalRegistryStore(root).list()).toHaveLength(0)
  })

  it("POST with Accept: text/event-stream streams progress then an error frame", async () => {
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("POST", {
        body: { source: { kind: "installed", package: "@nope/missing" } },
        accept: "text/event-stream",
      }),
      r.res,
      "/api/editor/design-systems",
      ctx(),
    )
    const frames = r.frames().join("")
    expect(frames).toContain('"type":"progress"')
    expect(frames).toContain('"stage":"ingesting"')
    expect(frames).toContain('"type":"error"')
    expect(r.ended()).toBe(true)
  })

  it("requires a real prototype tsconfig before extraction (installed path)", async () => {
    // A package present in node_modules but no tsconfig → the orchestrator's
    // tsconfig guard fires. Proves the handler runs the real resolver.
    mkdirSync(join(root, "node_modules/@acme/ui"), { recursive: true })
    writeFileSync(
      join(root, "node_modules/@acme/ui/package.json"),
      JSON.stringify({ name: "@acme/ui", version: "1.0.0" }),
    )
    const r = mockRes()
    await handleDesignSystemsRequest(
      mockReq("POST", { body: { source: { kind: "installed", package: "@acme/ui" } } }),
      r.res,
      "/api/editor/design-systems",
      ctx(),
    )
    expect(r.status()).toBe(422)
    expect((r.json() as { reason: string }).reason).toMatch(/tsconfig/i)
  })

  describe("POST …/:id/share", () => {
    it("appends a declaration for the registered entry's source and returns declared:true", async () => {
      await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/share",
        ctx(),
      )
      expect(r.status()).toBe(200)
      expect(r.json()).toEqual({ ok: true, declared: true })

      const configPath = join(root, "desde.config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      expect(config.designSystems).toEqual([{ kind: "installed", package: "@acme/ui" }])
    })

    it("404s for an unknown registry id", async () => {
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40nope%2Fmissing/share",
        ctx(),
      )
      expect(r.status()).toBe(404)
    })

    it("409s when the declaration already exists (repeat share)", async () => {
      await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
      const first = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        first.res,
        "/api/editor/design-systems/%40acme%2Fui/share",
        ctx(),
      )
      expect(first.status()).toBe(200)

      const second = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        second.res,
        "/api/editor/design-systems/%40acme%2Fui/share",
        ctx(),
      )
      expect(second.status()).toBe(409)
    })

    it("carries a declined build consent (allowBuild:false) through to the written declaration", async () => {
      // A repo entry onboarded with allowBuild:false must share as
      // allowBuild:false explicitly — omitting the field would let boot
      // reconciliation's `decl.allowBuild ?? true` default silently
      // reinstate build consent for a teammate's fresh boot.
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/repo-ds",
          source: { kind: "repo", url: "https://github.com/acme/repo-ds" },
          package: "@acme/repo-ds",
          designSystem: "@acme/repo-ds",
          allowBuild: false,
        }),
      )

      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Frepo-ds/share",
        ctx(),
      )
      expect(r.status()).toBe(200)
      expect(r.json()).toEqual({ ok: true, declared: true })

      const configPath = join(root, "desde.config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      expect(config.designSystems).toEqual([
        { kind: "repo", url: "https://github.com/acme/repo-ds", allowBuild: false },
      ])
    })

    it("preserves the original npm spec on share, and a subsequent GET flips the entry to declared:true", async () => {
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/ds",
          source: { kind: "npm", spec: "@acme/ds@^2" },
          package: "@acme/ds",
          designSystem: "@acme/ds",
        }),
      )

      const shareRes = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        shareRes.res,
        "/api/editor/design-systems/%40acme%2Fds/share",
        ctx(),
      )
      expect(shareRes.status()).toBe(200)
      expect(shareRes.json()).toEqual({ ok: true, declared: true })

      const configPath = join(root, "desde.config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      expect(config.designSystems).toEqual([{ kind: "npm", spec: "@acme/ds@^2" }])

      const getRes = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), getRes.res, "/api/editor/design-systems", ctx())
      const body = getRes.json() as { designSystems: Array<{ id: string; declared: boolean }> }
      const declared = Object.fromEntries(body.designSystems.map((e) => [e.id, e.declared]))
      expect(declared["@acme/ds"]).toBe(true)
    })
  })

  describe("GET …/updates (Phase 3 refresh — staleness)", () => {
    it("caches results across two GETs (one underlying check per entry)", async () => {
      await createLocalRegistryStore(root).add(entry())
      const checkStaleness = vi.fn(
        async (e: RegisteredDesignSystem): Promise<StalenessResult> => ({ id: e.id, state: "fresh" }),
      )
      const c = ctx(vi.fn(), vi.fn(async () => null), () => null, { checkStaleness })

      const r1 = mockRes()
      await handleDesignSystemsRequest(
        mockReq("GET"),
        r1.res,
        "/api/editor/design-systems/updates",
        c,
      )
      expect(r1.status()).toBe(200)
      expect((r1.json() as { updates: Record<string, StalenessResult> }).updates["@acme/ui"]).toEqual({
        id: "@acme/ui",
        state: "fresh",
      })
      expect(checkStaleness).toHaveBeenCalledTimes(1)

      const r2 = mockRes()
      await handleDesignSystemsRequest(
        mockReq("GET"),
        r2.res,
        "/api/editor/design-systems/updates",
        c,
      )
      expect(r2.status()).toBe(200)
      expect(checkStaleness).toHaveBeenCalledTimes(1) // cached — no second underlying check
      expect((r2.json() as { updates: Record<string, StalenessResult> }).updates).toEqual(
        (r1.json() as { updates: Record<string, StalenessResult> }).updates,
      )
    })

    it("treats a cache missing a newly-added entry as a miss and recomputes (includes the new id)", async () => {
      await createLocalRegistryStore(root).add(entry({ id: "@acme/a", package: "@acme/a" }))
      const checkStaleness = vi.fn(
        async (e: RegisteredDesignSystem): Promise<StalenessResult> => ({ id: e.id, state: "fresh" }),
      )
      const c = ctx(vi.fn(), vi.fn(async () => null), () => null, { checkStaleness })

      // Warm the cache with just @acme/a.
      const r1 = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), r1.res, "/api/editor/design-systems/updates", c)
      expect(checkStaleness).toHaveBeenCalledTimes(1)
      expect(Object.keys((r1.json() as { updates: Record<string, StalenessResult> }).updates)).toEqual([
        "@acme/a",
      ])

      // A second design system is registered AFTER the cache was written —
      // the cache no longer covers the full current registry.
      await createLocalRegistryStore(root).add(entry({ id: "@acme/b", package: "@acme/b" }))

      const r2 = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), r2.res, "/api/editor/design-systems/updates", c)
      expect(r2.status()).toBe(200)
      // Missing-id miss recomputes the WHOLE batch (not merely the new id).
      expect(checkStaleness).toHaveBeenCalledTimes(3)
      const body2 = (r2.json() as { updates: Record<string, StalenessResult> }).updates
      expect(Object.keys(body2).sort()).toEqual(["@acme/a", "@acme/b"])
    })

    it("busts the cache when a same-id entry's content changed underneath it (post-refresh reload)", async () => {
      // Mirrors what `POST …/:id/refresh` does: `store.add` replaces the
      // registry entry IN PLACE — same id, new `resolvedCommit`. A coverage
      // check keyed on id alone would keep serving the verdict computed
      // against the OLD commit for up to the TTL.
      const store = createLocalRegistryStore(root)
      await store.add(
        entry({
          id: "@acme/repo-ds",
          source: { kind: "repo", url: "https://github.com/acme/repo-ds" },
          package: "@acme/repo-ds",
          designSystem: "@acme/repo-ds",
          resolvedCommit: "aaa111",
        }),
      )
      const checkStaleness = vi.fn(
        async (e: RegisteredDesignSystem): Promise<StalenessResult> => ({
          id: e.id,
          state: e.resolvedCommit === "bbb222" ? "fresh" : "update-available",
          current: e.resolvedCommit,
          latest: "bbb222",
        }),
      )
      const c = ctx(vi.fn(), vi.fn(async () => null), () => null, { checkStaleness })

      const r1 = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), r1.res, "/api/editor/design-systems/updates", c)
      expect(checkStaleness).toHaveBeenCalledTimes(1)
      expect(
        (r1.json() as { updates: Record<string, StalenessResult> }).updates["@acme/repo-ds"],
      ).toMatchObject({ state: "update-available", current: "aaa111" })

      // A refresh completes: same id, entry replaced with the NEW resolvedCommit.
      await store.add(
        entry({
          id: "@acme/repo-ds",
          source: { kind: "repo", url: "https://github.com/acme/repo-ds" },
          package: "@acme/repo-ds",
          designSystem: "@acme/repo-ds",
          resolvedCommit: "bbb222",
        }),
      )

      const r2 = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), r2.res, "/api/editor/design-systems/updates", c)
      expect(r2.status()).toBe(200)
      // Content-aware coverage check treats this as a miss — recomputes
      // rather than serving the stale 'update-available' verdict.
      expect(checkStaleness).toHaveBeenCalledTimes(2)
      expect(
        (r2.json() as { updates: Record<string, StalenessResult> }).updates["@acme/repo-ds"],
      ).toMatchObject({ state: "fresh", current: "bbb222" })
    })

    it("?force=1 bypasses the cache and re-runs the checker", async () => {
      await createLocalRegistryStore(root).add(entry())
      const checkStaleness = vi.fn(
        async (e: RegisteredDesignSystem): Promise<StalenessResult> => ({ id: e.id, state: "fresh" }),
      )
      const c = ctx(vi.fn(), vi.fn(async () => null), () => null, { checkStaleness })

      await handleDesignSystemsRequest(
        mockReq("GET"),
        mockRes().res,
        "/api/editor/design-systems/updates",
        c,
      )
      expect(checkStaleness).toHaveBeenCalledTimes(1)

      const r2 = mockRes()
      await handleDesignSystemsRequest(
        mockReq("GET", { url: "/api/editor/design-systems/updates?force=1" }),
        r2.res,
        "/api/editor/design-systems/updates",
        c,
      )
      expect(r2.status()).toBe(200)
      expect(checkStaleness).toHaveBeenCalledTimes(2)
    })

    it("checks every registered entry concurrently", async () => {
      await createLocalRegistryStore(root).add(entry({ id: "@acme/a", package: "@acme/a" }))
      await createLocalRegistryStore(root).add(entry({ id: "@acme/b", package: "@acme/b" }))
      const checkStaleness = vi.fn(
        async (e: RegisteredDesignSystem): Promise<StalenessResult> => ({
          id: e.id,
          state: "update-available",
          latest: "9.9.9",
        }),
      )
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("GET"),
        r.res,
        "/api/editor/design-systems/updates",
        ctx(vi.fn(), vi.fn(async () => null), () => null, { checkStaleness }),
      )
      expect(r.status()).toBe(200)
      const body = r.json() as { updates: Record<string, StalenessResult> }
      expect(Object.keys(body.updates).sort()).toEqual(["@acme/a", "@acme/b"])
      expect(checkStaleness).toHaveBeenCalledTimes(2)
    })
  })

  describe("POST …/:id/refresh (Phase 3 refresh — re-onboard)", () => {
    it("404s for an unknown registry id", async () => {
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40nope%2Fmissing/refresh",
        ctx(),
      )
      expect(r.status()).toBe(404)
      expect((r.json() as { reason: string }).reason).toMatch(/No design system registered/)
    })

    it("re-onboards a registered entry from its ORIGINAL source and replaces it in the registry", async () => {
      writeMinimalVuePackage(root, "@acme/ui")
      const onChange = vi.fn()
      const addRes = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { body: { source: { kind: "installed", package: "@acme/ui" } } }),
        addRes.res,
        "/api/editor/design-systems",
        ctx(onChange),
      )
      expect(addRes.status()).toBe(200)
      expect(await createLocalRegistryStore(root).list()).toHaveLength(1)

      const refreshRes = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        refreshRes.res,
        "/api/editor/design-systems/%40acme%2Fui/refresh",
        ctx(onChange),
      )
      expect(refreshRes.status()).toBe(200)
      expect((refreshRes.json() as { ok: boolean }).ok).toBe(true)

      // Replaced by id, not duplicated.
      const list = await createLocalRegistryStore(root).list()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe("@acme/ui")
      expect(list[0].source).toEqual({ kind: "installed", package: "@acme/ui" })
    })

    it("streams SSE progress + result for a refresh, same as the add route", async () => {
      writeMinimalVuePackage(root, "@acme/ui")
      await handleDesignSystemsRequest(
        mockReq("POST", { body: { source: { kind: "installed", package: "@acme/ui" } } }),
        mockRes().res,
        "/api/editor/design-systems",
        ctx(),
      )

      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { accept: "text/event-stream" }),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/refresh",
        ctx(),
      )
      const frames = r.frames().join("")
      expect(frames).toContain('"type":"progress"')
      expect(frames).toContain('"stage":"ingesting"')
      expect(frames).toContain('"type":"result"')
      expect(r.ended()).toBe(true)
    })

    it("streams an error frame and does NOT replace the registry entry when re-onboarding fails", async () => {
      writeMinimalVuePackage(root, "@acme/ui")
      await handleDesignSystemsRequest(
        mockReq("POST", { body: { source: { kind: "installed", package: "@acme/ui" } } }),
        mockRes().res,
        "/api/editor/design-systems",
        ctx(),
      )
      // Remove the package after registering so re-onboarding fails deterministically.
      rmSync(join(root, "node_modules/@acme/ui"), { recursive: true, force: true })

      const onChange = vi.fn()
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { accept: "text/event-stream" }),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/refresh",
        ctx(onChange),
      )
      const frames = r.frames().join("")
      expect(frames).toContain('"type":"error"')
      expect(onChange).not.toHaveBeenCalled()
    })

    it("reuses the entry's recorded allowBuild:false when the refresh body doesn't override", async () => {
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/repo-ds",
          source: { kind: "repo", url: "https://github.com/acme/repo-ds" },
          package: "@acme/repo-ds",
          designSystem: "@acme/repo-ds",
          allowBuild: false,
        }),
      )

      const { onboardDesignSystem } = await import("../../../../src/editor/onboarding/index.js")
      let captured: OnboardRequest | undefined
      vi.mocked(onboardDesignSystem).mockImplementationOnce(async (req) => {
        captured = req
        return {
          package: "@acme/repo-ds",
          version: "1.0.0",
          framework: "vue3",
          designSystem: "@acme/repo-ds",
          importPath: "@acme/repo-ds",
          coverage: { discovered: 0, extracted: 0, empty: 0, failedComponents: [], sampleProps: {} },
          registryEntryId: "@acme/repo-ds",
        }
      })

      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"), // no body — refresh must not re-default to true
        r.res,
        "/api/editor/design-systems/%40acme%2Frepo-ds/refresh",
        ctx(),
      )
      expect(r.status()).toBe(200)
      expect(captured?.allowBuild).toBe(false)
    })

    it("still lets an explicit body allowBuild override the entry's recorded consent", async () => {
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/repo-ds",
          source: { kind: "repo", url: "https://github.com/acme/repo-ds" },
          package: "@acme/repo-ds",
          designSystem: "@acme/repo-ds",
          allowBuild: false,
        }),
      )

      const { onboardDesignSystem } = await import("../../../../src/editor/onboarding/index.js")
      let captured: OnboardRequest | undefined
      vi.mocked(onboardDesignSystem).mockImplementationOnce(async (req) => {
        captured = req
        return {
          package: "@acme/repo-ds",
          version: "1.0.0",
          framework: "vue3",
          designSystem: "@acme/repo-ds",
          importPath: "@acme/repo-ds",
          coverage: { discovered: 0, extracted: 0, empty: 0, failedComponents: [], sampleProps: {} },
          registryEntryId: "@acme/repo-ds",
        }
      })

      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { body: { allowBuild: true } }),
        r.res,
        "/api/editor/design-systems/%40acme%2Frepo-ds/refresh",
        ctx(),
      )
      expect(r.status()).toBe(200)
      expect(captured?.allowBuild).toBe(true)
    })
  })

  describe("POST …/:id/generate-hints (Phase 4 Task 3 — probe-derived hints)", () => {
    /** A minimal fake manifest source — `listComponents()` is all this route needs. */
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

    /**
     * A fake `ProbePage` returning canned RAW probe results (the shape
     * `probeComponent`'s in-page script would produce) in call order — one
     * per `evaluate()` call, matching `generateHintsRun`'s sequential,
     * per-component processing order. `goto`/`close` are no-ops; this
     * exercises the REAL `generateHintsRun` → `deriveHintsForComponent` →
     * `probeComponent` pipeline end-to-end, with only the "browser" faked.
     */
    function fakeProbePage(rawResults: unknown[]): ProbePage {
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
      } as ProbePage & { __wasClosed: () => boolean }
    }

    const kButtonManifest = (): ComponentManifest => ({
      id: "@acme/ui:KButton",
      name: "KButton",
      framework: "vue3",
      designSystem: "@acme/ui",
      importPath: "@acme/ui",
      props: [
        {
          name: "label",
          type: "string",
          required: false,
          control: { kind: "text" },
        },
      ],
    })

    it("404s for an unknown registry id", async () => {
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40nope%2Fmissing/generate-hints",
        ctx(),
      )
      expect(r.status()).toBe(404)
    })

    // Probing (Task 3) mounts each component in an isolation page that only
    // ever renders Vue — see `src/editor/hints/probe-capability.ts`, the
    // SAME predicate `design-systems-panel.tsx` reads to decide whether to
    // offer the "Generate hints" button at all. Without this guard a react
    // entry ran the probe lane anyway and silently reported
    // `probed: 0, hinted: 0, verified: 0` (see that file's history for the
    // measured defect).
    it("422s for a react entry with a reason naming the framework — probing is Vue-only", async () => {
      await createLocalRegistryStore(root).add(entry({ framework: "react" }))
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(),
      )
      expect(r.status()).toBe(422)
      const reason = (r.json() as { reason: string }).reason
      expect(reason).toMatch(/Vue-only/i)
      expect(reason).toContain('"react"')
    })

    it("422s for an entry ingested outside node_modules (packageRoot set) with the V1 reason", async () => {
      await createLocalRegistryStore(root).add(
        entry({ id: "@acme/ui", package: "@acme/ui", packageRoot: ".desde/ingested/@acme/ui" }),
      )
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(),
      )
      expect(r.status()).toBe(422)
      expect((r.json() as { reason: string }).reason).toMatch(/not installed/i)
    })

    it("422s for an npm-scratch-ingested entry (source.kind:'npm', packageRoot set) — the 422 remains for this kind (Phase 4 Task 4)", async () => {
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/ui",
          package: "@acme/ui",
          source: { kind: "npm", spec: "@acme/ui@1.0.0" },
          packageRoot: ".desde/ingested/@acme-ui-abcd1234",
        }),
      )
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(),
      )
      expect(r.status()).toBe(422)
      expect((r.json() as { reason: string }).reason).toMatch(/not installed/i)
    })

    describe("repo-ingested entries (Phase 4 Task 4 — source-inference-only path)", () => {
      /** Writes a `.desde/ingested/<slug>/repo/<Name>.vue` fixture the
       *  handler's `resolveIngestedSourceRoot` + `buildComponentFileIndex`
       *  can walk, mirroring what `ingestRepo` actually leaves on disk. */
      function writeIngestedVueSource(protoRoot: string, relPackageRoot: string, name: string, template: string): void {
        const sourceDir = join(protoRoot, relPackageRoot)
        mkdirSync(sourceDir, { recursive: true })
        writeFileSync(join(sourceDir, `${name}.vue`), `<template>${template}</template>`)
      }

      it("accepts a repo-kind packageRoot entry: no probe page is opened, inferred (unverified) hints are written, and the response carries the inference-only note", async () => {
        const relRoot = ".desde/ingested/@acme-ui-deadbeef/repo"
        writeIngestedVueSource(root, relRoot, "KButton", '<h2 class="title">{{ label }}</h2>')
        await createLocalRegistryStore(root).add(
          entry({
            id: "@acme/ui",
            package: "@acme/ui",
            version: "1.0.0",
            designSystem: "@acme/ui",
            source: { kind: "repo", url: "https://example.com/acme/ui.git" },
            packageRoot: relRoot,
          }),
        )
        const createProbePage = vi.fn(async (): Promise<ProbePage | null> => null)
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST"),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage,
            },
          ),
        )
        expect(r.status()).toBe(200)
        const body = r.json() as {
          ok: boolean
          note?: string
          result: { probed: number; hinted: number; verified: number; skipped: unknown[] }
        }
        expect(body.note).toMatch(/inference only/i)
        expect(body.result.probed).toBe(0) // never mounted — no probe attempted at all
        expect(body.result.hinted).toBe(1)
        expect(body.result.verified).toBe(0) // inferred hints are unverified by construction
        expect(createProbePage).not.toHaveBeenCalled()

        // The GET route's coverage line reflects the written (unverified) hints too.
        const getRes = mockRes()
        await handleDesignSystemsRequest(mockReq("GET"), getRes.res, "/api/editor/design-systems", ctx())
        const list = (getRes.json() as { designSystems: Array<{ id: string; hintCoverage: unknown }> })
          .designSystems
        expect(list.find((s) => s.id === "@acme/ui")?.hintCoverage).toEqual({
          hinted: 1,
          verified: 0,
          total: 1,
        })
      })

      it("streams the inference-only note in the SSE result frame too", async () => {
        const relRoot = ".desde/ingested/@acme-ui-deadbeef/repo"
        writeIngestedVueSource(root, relRoot, "KButton", '<h2 class="title">{{ label }}</h2>')
        await createLocalRegistryStore(root).add(
          entry({
            id: "@acme/ui",
            package: "@acme/ui",
            designSystem: "@acme/ui",
            source: { kind: "repo", url: "https://example.com/acme/ui.git" },
            packageRoot: relRoot,
          }),
        )
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST", { accept: "text/event-stream" }),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            { getManifestSource: async () => fakeManifestSource([kButtonManifest()]) },
          ),
        )
        const frames = r.frames().join("")
        expect(frames).toContain('"type":"result"')
        expect(frames).toMatch(/"note":"inference only/)
      })

      it("degrades gracefully (no throw, empty inference) when a repo-kind entry's packageRoot escapes .desde/ingested", async () => {
        const escapedRel = "some-other-dir/acme-ui"
        writeIngestedVueSource(root, escapedRel, "KButton", "<div>{{ label }}</div>")
        await createLocalRegistryStore(root).add(
          entry({
            id: "@acme/ui",
            package: "@acme/ui",
            designSystem: "@acme/ui",
            source: { kind: "repo", url: "https://example.com/acme/ui.git" },
            packageRoot: escapedRel,
          }),
        )
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST"),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            { getManifestSource: async () => fakeManifestSource([kButtonManifest()]) },
          ),
        )
        expect(r.status()).toBe(200)
        const body = r.json() as {
          result: { probed: number; hinted: number; skipped: Array<{ name: string; reason: string }> }
        }
        expect(body.result.probed).toBe(0)
        expect(body.result.hinted).toBe(0)
        expect(body.result.skipped).toEqual([
          { name: "KButton", reason: "probe failed and no inference available" },
        ])
      })
    })

    it("422s (non-stream) when no manifest source is available", async () => {
      await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(vi.fn(), vi.fn(async () => null), () => null, {}, { getManifestSource: async () => null }),
      )
      expect(r.status()).toBe(422)
      expect((r.json() as { reason: string }).reason).toMatch(/[Mm]anifest source unavailable/)
    })

    it("422s (non-stream) when no headless browser can launch", async () => {
      await createLocalRegistryStore(root).add(
        entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
      )
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(
          vi.fn(),
          vi.fn(async () => null),
          () => null,
          {},
          {
            getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
            createProbePage: async () => null,
          },
        ),
      )
      expect(r.status()).toBe(422)
      expect((r.json() as { reason: string }).reason).toMatch(/[Nn]o headless browser/)
    })

    it("runs the real engine end-to-end (fake page + fake manifest source): writes a hint file, invalidates grounding, returns the run summary", async () => {
      await createLocalRegistryStore(root).add(
        entry({
          id: "@acme/ui",
          package: "@acme/ui",
          version: "1.2.3",
          designSystem: "@acme/ui",
        }),
      )
      const page = fakeProbePage([
        {
          ok: true,
          findings: [
            {
              sentinel: "x",
              kind: "prop",
              name: "label",
              matches: [{ selector: ":root", field: "textContent" }],
            },
            { sentinel: "y", kind: "slot", name: "default", matches: [] },
          ],
        },
      ])
      const onChange = vi.fn()
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(
          onChange,
          vi.fn(async () => null),
          () => null,
          {},
          {
            getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
            createProbePage: async () => page,
          },
        ),
      )
      expect(r.status()).toBe(200)
      const body = r.json() as {
        ok: boolean
        result: {
          probed: number
          hinted: number
          verified: number
          skipped: unknown[]
          wroteCache: boolean
          carriedForward: number
        }
      }
      expect(body.ok).toBe(true)
      expect(body.result).toEqual({
        probed: 1,
        hinted: 1,
        verified: 1,
        skipped: [],
        wroteCache: true,
        carriedForward: 0,
      })
      expect(onChange).toHaveBeenCalledOnce()
      expect((page as unknown as { __wasClosed: () => boolean }).__wasClosed()).toBe(true)

      // A subsequent GET reflects the freshly-written hint file's coverage.
      const getRes = mockRes()
      await handleDesignSystemsRequest(mockReq("GET"), getRes.res, "/api/editor/design-systems", ctx())
      const list = (getRes.json() as { designSystems: Array<{ id: string; hintCoverage: unknown }> })
        .designSystems
      expect(list.find((s) => s.id === "@acme/ui")?.hintCoverage).toEqual({
        hinted: 1,
        verified: 1,
        total: 1,
      })
    })

    it("writes the hint file keyed by the LIVE installed version, not the onboard-time registry version (write/read key parity)", async () => {
      // Registered at 1.0.0, but node_modules now reports 2.0.0 (an
      // `npm install` upgrade the user never ran /refresh after) — the
      // route must key the written file the SAME way
      // `build-manifest-source.ts`'s reader resolves it, or the file it
      // just wrote is never picked up.
      mkdirSync(join(root, "node_modules/@acme/ui"), { recursive: true })
      writeFileSync(
        join(root, "node_modules/@acme/ui/package.json"),
        JSON.stringify({ name: "@acme/ui", version: "2.0.0" }),
      )
      await createLocalRegistryStore(root).add(
        entry({ id: "@acme/ui", package: "@acme/ui", version: "1.0.0", designSystem: "@acme/ui" }),
      )
      const page = fakeProbePage([{ ok: true, findings: [] }])
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST"),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(
          vi.fn(),
          vi.fn(async () => null),
          () => null,
          {},
          {
            getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
            createProbePage: async () => page,
          },
        ),
      )
      expect(r.status()).toBe(200)

      const cacheDir = join(root, CACHE_DIR_NAME)
      const liveKeyed = readHintCache(hintCacheFilePath(cacheDir, "@acme/ui", "2.0.0"))
      expect(liveKeyed).not.toBeNull()
      expect(liveKeyed?.packageVersion).toBe("2.0.0")

      const staleKeyed = readHintCache(hintCacheFilePath(cacheDir, "@acme/ui", "1.0.0"))
      expect(staleKeyed).toBeNull()
    })

    it("streams SSE progress + result, same shape as onboard/refresh", async () => {
      await createLocalRegistryStore(root).add(
        entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
      )
      const page = fakeProbePage([{ ok: true, findings: [] }])
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { accept: "text/event-stream" }),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(
          vi.fn(),
          vi.fn(async () => null),
          () => null,
          {},
          {
            getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
            createProbePage: async () => page,
          },
        ),
      )
      const frames = r.frames().join("")
      expect(frames).toContain('"type":"progress"')
      expect(frames).toContain('"component":"KButton"')
      expect(frames).toContain('"type":"result"')
      expect(r.ended()).toBe(true)
    })

    it("streams an error frame (and does not invalidate grounding) when the engine throws", async () => {
      await createLocalRegistryStore(root).add(
        entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
      )
      const onChange = vi.fn()
      const r = mockRes()
      await handleDesignSystemsRequest(
        mockReq("POST", { accept: "text/event-stream" }),
        r.res,
        "/api/editor/design-systems/%40acme%2Fui/generate-hints",
        ctx(onChange, vi.fn(async () => null), () => null, {}, { getManifestSource: async () => null }),
      )
      const frames = r.frames().join("")
      expect(frames).toContain('"type":"error"')
      expect(onChange).not.toHaveBeenCalled()
    })

    describe("useLlm (Phase 4 Task 5 — opt-in LLM lane)", () => {
      function fakeLlmProvider(respond: (opts: CompleteOpts) => unknown[] | Error): CompletionProvider {
        const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
          const r = respond(opts)
          if (r instanceof Error) throw r
          const body = { hints: r }
          return {
            text: JSON.stringify(body),
            parsed: body,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }
        })
        return { name: "fake", defaultModel: "fake-model", complete }
      }

      it("never calls the LLM provider when useLlm is omitted from the body", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const page = fakeProbePage([{ ok: true, findings: [] }])
        const provider = fakeLlmProvider(() => [])
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST"),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => page,
              getLlmProvider: () => provider,
            },
          ),
        )
        expect(r.status()).toBe(200)
        expect(provider.complete).not.toHaveBeenCalled()
      })

      it("calls the LLM provider for a zero-hint component when the body sets useLlm:true, and folds validated hints into the run summary", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        // The probe finds nothing for KButton's sentinel mount — zero hints
        // from probe+inference, so it reaches the LLM lane.
        const page = fakeProbePage([{ ok: true, findings: [] }])
        const provider = fakeLlmProvider(() => [
          { source: { kind: "prop", name: "label" }, domTarget: { selector: ".title", field: "textContent" } },
        ])
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST", { body: { useLlm: true } }),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => page,
              getLlmProvider: () => provider,
            },
          ),
        )
        expect(r.status()).toBe(200)
        const body = r.json() as {
          result: { probed: number; hinted: number; verified: number; skipped: unknown[] }
        }
        expect(provider.complete).toHaveBeenCalledOnce()
        expect(body.result.hinted).toBe(1)
        // Post-generation probe verification isn't exercised by this fake
        // page (it always returns empty findings), so the hint stays
        // unverified — the important assertion is that it's present at all.
        expect(body.result.verified).toBe(0)

        const getRes = mockRes()
        await handleDesignSystemsRequest(mockReq("GET"), getRes.res, "/api/editor/design-systems", ctx())
        const list = (getRes.json() as { designSystems: Array<{ id: string; hintCoverage: unknown }> })
          .designSystems
        expect(list.find((s) => s.id === "@acme/ui")?.hintCoverage).toEqual({
          hinted: 1,
          verified: 0,
          total: 1,
        })
      })

      it("still refuses (422) for an entry with no headless browser even when useLlm:true is requested (the LLM lane needs a manifest source regardless)", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST", { body: { useLlm: true } }),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => null,
            },
          ),
        )
        expect(r.status()).toBe(422)
      })

      it("400s when the body is present but not valid JSON", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const stream = Readable.from([Buffer.from("not json")]) as unknown as IncomingMessage
        stream.method = "POST"
        stream.headers = {}
        const r = mockRes()
        await handleDesignSystemsRequest(
          stream,
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(),
        )
        expect(r.status()).toBe(400)
      })
    })

    describe("client-disconnect abort (P2 fix — cancel via response/socket lifecycle, not request-stream close)", () => {
      /**
       * A `CompletionProvider` whose `complete()` hangs until the test
       * releases it — lets the test fire a disconnect signal WHILE the
       * (paid, in real life) LLM call is in flight and observe whether the
       * `AbortSignal` threaded into it reacts.
       */
      function pendingLlmProvider(): {
        provider: CompletionProvider
        awaitInvoked: () => Promise<AbortSignal | undefined>
        release: (hints: unknown[]) => void
      } {
        let invokedResolve: (signal: AbortSignal | undefined) => void
        const invoked = new Promise<AbortSignal | undefined>((resolve) => {
          invokedResolve = resolve
        })
        let releaseResolve: (hints: unknown[]) => void
        const pending = new Promise<unknown[]>((resolve) => {
          releaseResolve = resolve
        })
        const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
          invokedResolve(opts.signal)
          const hints = await pending
          const body = { hints }
          return {
            text: JSON.stringify(body),
            parsed: body,
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "end_turn",
          }
        })
        return {
          provider: { name: "fake", defaultModel: "fake-model", complete },
          awaitInvoked: () => invoked,
          release: (hints) => releaseResolve(hints),
        }
      }

      it("aborts the in-flight LLM call when the client disconnects mid-run (SSE, socket close)", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const page = fakeProbePage([{ ok: true, findings: [] }])
        const { provider, awaitInvoked, release } = pendingLlmProvider()
        const req = mockReq("POST", { body: { useLlm: true }, accept: "text/event-stream", withSocket: true })
        const r = mockRes()

        const done = handleDesignSystemsRequest(
          req,
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => page,
              getLlmProvider: () => provider,
            },
          ),
        )

        const signal = await awaitInvoked()
        expect(signal?.aborted).toBe(false)

        // The request stream's OWN 'close' (fired e.g. once its body has
        // been fully read) must NOT be read as a disconnect — this is the
        // exact bug the P2 finding flagged (`req.on('close')` fires on
        // body-stream-end, not client lifetime).
        ;(req as unknown as EventEmitter).emit("close")
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(signal?.aborted).toBe(false)

        // The socket closing IS the authoritative disconnect signal.
        fakeSocket(req).emit("close")
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(signal?.aborted).toBe(true)

        release([])
        await done
      })

      it("aborts the in-flight LLM call when the response closes mid-run (no socket available)", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const page = fakeProbePage([{ ok: true, findings: [] }])
        const { provider, awaitInvoked, release } = pendingLlmProvider()
        const r = mockRes()

        const done = handleDesignSystemsRequest(
          mockReq("POST", { body: { useLlm: true }, accept: "text/event-stream" }),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => page,
              getLlmProvider: () => provider,
            },
          ),
        )

        const signal = await awaitInvoked()
        expect(signal?.aborted).toBe(false)

        r.emitClose()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(signal?.aborted).toBe(true)

        release([])
        await done
      })

      it("does NOT abort the signal on a normal completed run", async () => {
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui" }),
        )
        const page = fakeProbePage([{ ok: true, findings: [] }])
        const { provider, awaitInvoked, release } = pendingLlmProvider()
        const req = mockReq("POST", { body: { useLlm: true }, accept: "text/event-stream", withSocket: true })
        const r = mockRes()

        const done = handleDesignSystemsRequest(
          req,
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(
            vi.fn(),
            vi.fn(async () => null),
            () => null,
            {},
            {
              getManifestSource: async () => fakeManifestSource([kButtonManifest()]),
              createProbePage: async () => page,
              getLlmProvider: () => provider,
            },
          ),
        )

        const signal = await awaitInvoked()
        release([
          { source: { kind: "prop", name: "label" }, domTarget: { selector: ".title", field: "textContent" } },
        ])
        await done

        expect(signal?.aborted).toBe(false)
        expect(r.status()).toBe(200)
        const frames = r.frames().join("")
        expect(frames).toContain('"type":"result"')
      })
    })

    describe("cross-package same-name collision (P2 fix — enumerate from the package's OWN source)", () => {
      /**
       * A real installed Vue package on disk shipping ONE `*.vue.d.ts`
       * component under `dist/types`, so `createDefaultOnboardDeps(root)
       * .buildSource` (the real per-package extractor, not a fake) actually
       * builds a working source for it — exercising the FIX's primary path
       * rather than the `ctx.getManifestSource()` fallback every other test
       * in this file relies on (they use a bare tmpdir with no real
       * package, so the fallback is what they've always exercised).
       */
      function writeRealVuePackage(
        protoRoot: string,
        pkg: string,
        componentName: string,
        propName: string,
      ): void {
        const pkgDir = join(protoRoot, "node_modules", pkg)
        mkdirSync(join(pkgDir, "dist/types"), { recursive: true })
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }))
        writeFileSync(
          join(pkgDir, `dist/types/${componentName}.vue.d.ts`),
          [
            `export interface ${componentName}Props {`,
            `  /** distinguishing prop for ${pkg} */`,
            `  ${propName}?: string;`,
            `}`,
            `declare const _default: new () => { $props: ${componentName}Props };`,
            "export default _default;",
            "",
          ].join("\n"),
        )
      }

      it("enumerates and hints the SECOND package's own same-named component (previously zero/missing via the deduped composite)", async () => {
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "esnext",
              module: "esnext",
              moduleResolution: "bundler",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              lib: ["esnext"],
            },
          }),
        )
        // Two DIFFERENT packages, each exporting a component literally named
        // "Button" — the exact shape the composite's first-source-wins
        // listComponents() dedupe would collapse to one, silently dropping
        // the second package's Button from any catalog built off it.
        writeRealVuePackage(root, "@acme/one", "Button", "labelOne")
        writeRealVuePackage(root, "@acme/two", "Button", "labelTwo")
        await createLocalRegistryStore(root).add(
          entry({
            id: "@acme/one",
            package: "@acme/one",
            designSystem: "@acme/one",
            importPath: "@acme/one",
          }),
        )
        await createLocalRegistryStore(root).add(
          entry({
            id: "@acme/two",
            package: "@acme/two",
            designSystem: "@acme/two",
            importPath: "@acme/two",
          }),
        )

        const page = fakeProbePage([{ ok: true, findings: [] }])
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST"),
          r.res,
          "/api/editor/design-systems/%40acme%2Ftwo/generate-hints",
          // No `getManifestSource` override needed — the fix's primary path
          // builds `@acme/two`'s own source directly from the REAL package
          // on disk above, so the composite-derived fallback (which would
          // have deduped this exact collision away) is never consulted.
          ctx(vi.fn(), vi.fn(async () => null), () => null, {}, { createProbePage: async () => page }),
        )

        expect(r.status()).toBe(200)
        const body = r.json() as { ok: boolean; result: { probed: number; skipped: unknown[] } }
        expect(body.ok).toBe(true)
        // Package B's Button was actually enumerated and probed — NOT
        // silently dropped by a name-based dedupe against package A's Button.
        expect(body.result.probed).toBe(1)
        expect(body.result.skipped).toEqual([])
      })

      it("single-package case is unchanged: a lone registered package still enumerates and hints its own component via the real per-package source", async () => {
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "esnext",
              module: "esnext",
              moduleResolution: "bundler",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              lib: ["esnext"],
            },
          }),
        )
        writeRealVuePackage(root, "@acme/ui", "Button", "label")
        await createLocalRegistryStore(root).add(
          entry({ id: "@acme/ui", package: "@acme/ui", designSystem: "@acme/ui", importPath: "@acme/ui" }),
        )

        const page = fakeProbePage([{ ok: true, findings: [] }])
        const r = mockRes()
        await handleDesignSystemsRequest(
          mockReq("POST"),
          r.res,
          "/api/editor/design-systems/%40acme%2Fui/generate-hints",
          ctx(vi.fn(), vi.fn(async () => null), () => null, {}, { createProbePage: async () => page }),
        )

        expect(r.status()).toBe(200)
        const body = r.json() as { ok: boolean; result: { probed: number; skipped: unknown[] } }
        expect(body.ok).toBe(true)
        expect(body.result.probed).toBe(1)
        expect(body.result.skipped).toEqual([])
      })
    })
  })
})

describe("GET …/design-systems hintCoverage (Phase 4 Task 3)", () => {
  it("is null for a registered entry with no hint file yet", async () => {
    await createLocalRegistryStore(root).add(entry({ id: "@acme/ui", package: "@acme/ui" }))
    const r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    const body = r.json() as { designSystems: Array<{ id: string; hintCoverage: unknown }> }
    expect(body.designSystems[0].hintCoverage).toBeNull()
  })

  it("uses the LIVE installed version (resolveHintsCacheVersion), not the stale registry version, to find the hint file", async () => {
    // Entry recorded at 1.0.0, node_modules now reports 2.0.0 (an `npm
    // install` upgrade the user never ran /refresh after), and the hint
    // file on disk was written under 2.0.0 — exactly what the writer
    // (`runGenerateHintsFor`) and the manifest-serving reader
    // (`build-manifest-source.ts`) both key by. Reading under the stale
    // `entry.version` (1.0.0) would never find it and always report null.
    mkdirSync(join(root, "node_modules/@acme/ui"), { recursive: true })
    writeFileSync(
      join(root, "node_modules/@acme/ui/package.json"),
      JSON.stringify({ name: "@acme/ui", version: "2.0.0" }),
    )
    await createLocalRegistryStore(root).add(
      entry({ id: "@acme/ui", package: "@acme/ui", version: "1.0.0", designSystem: "@acme/ui" }),
    )
    const cacheDir = join(root, CACHE_DIR_NAME)
    writeHintCache(hintCacheFilePath(cacheDir, "@acme/ui", "2.0.0"), {
      schema: HINTS_SCHEMA_VERSION,
      packageName: "@acme/ui",
      packageVersion: "2.0.0",
      generatedAt: new Date().toISOString(),
      hints: { Button: [] },
    })

    const r = mockRes()
    await handleDesignSystemsRequest(mockReq("GET"), r.res, "/api/editor/design-systems", ctx())
    const body = r.json() as { designSystems: Array<{ id: string; hintCoverage: unknown }> }
    expect(body.designSystems.find((s) => s.id === "@acme/ui")?.hintCoverage).not.toBeNull()
  })
})

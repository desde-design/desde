/**
 * The boot walk, and the property the per-module report rests on: it ATTEMPTS
 * every first-party source module rather than stopping at the first success.
 *
 * ── The measurement that forced the change ──────────────────────────────────
 *
 * MEASURED 2026-08-11 with the loop instrumented and the shipped CLI booted
 * against a three-module React fixture whose refusing file was `Card.tsx`, two
 * levels below the entry. Verbatim, in the order printed:
 *
 *     [walk] visit /src/main.tsx cached=true
 *     [walk] STOP at /src/main.tsx
 *     ▸ Smoke check passed (bridge tag + data-desde-src present in served output)
 *     [stamp] src/components/Card.tsx … This file stays inspect-only …
 *
 * ONE module compiled before the gate rendered. The refusal landed after the
 * entire boot summary, compiled by Vite's own background `preTransformRequests`.
 * Move the same refusal up to `App.tsx` — a DIRECT import of the entry, which
 * Vite pre-transforms first — and the `[stamp]` line arrives BEFORE the summary
 * instead. Same code, same fixture shape, opposite observation: reading a stamp
 * ledger at gate time without driving the walk is a race, not a check.
 *
 * A fake `ViteDevServer` is used deliberately. The thing under test is which
 * modules get compiled and in what conditions the loop stops — a real Vite
 * would answer that only through timing, which is exactly the property that
 * made the old behaviour undetectable.
 */
import { describe, expect, it, vi } from "vitest"
import type { ViteDevServer } from "vite"
import { anyStampedModuleHasDataPtSrc } from "../vite/module-graph-evidence.js"

/** What one module in the fake graph is: its compiled text, and what it imports. */
interface FakeModule {
  /** Compiled output. `null` = registered but not yet transformed. */
  code: string | null
  /** Registered into the graph when this module is transformed. */
  imports?: string[]
}

interface FakeServer {
  server: ViteDevServer
  transformed: string[]
}

/**
 * A module graph that grows the way Vite's does: `transformRequest` runs import
 * analysis, which REGISTERS the module's imports without compiling them. A walk
 * that scans the map once therefore stops at whatever depth happened to be
 * registered when it started — the defect above, in miniature.
 */
function fakeServer(modules: Record<string, FakeModule>, registered: string[]): FakeServer {
  const urlToModuleMap = new Map<string, { transformResult: { code: string } | null }>()
  const transformed: string[] = []
  const register = (url: string) => {
    if (!urlToModuleMap.has(url)) urlToModuleMap.set(url, { transformResult: null })
  }
  for (const url of registered) register(url)

  const transformRequest = async (url: string) => {
    const mod = modules[url]
    if (!mod) return null
    transformed.push(url)
    register(url)
    for (const imported of mod.imports ?? []) register(imported)
    const entry = urlToModuleMap.get(url)
    if (entry && mod.code !== null) entry.transformResult = { code: mod.code }
    return mod.code === null ? null : { code: mod.code }
  }

  return {
    transformed,
    server: { moduleGraph: { urlToModuleMap }, transformRequest } as unknown as ViteDevServer,
  }
}

/** `discoverEntryModules` fetches `/` — this is the only network the walk does. */
function stubIndexHtml(entry: string): void {
  vi.stubGlobal("fetch", async () => ({
    text: async () => `<html><script type="module" src="${entry}"></script></html>`,
  }))
}

const STAMPED = 'h("div",{"data-desde-src":"src/x.tsx:1:0"})'
const UNSTAMPED = 'h("div",{})'

describe("anyStampedModuleHasDataPtSrc — completeness", () => {
  it("compiles a module two levels below the entry, after already finding a stamp", () => {
    stubIndexHtml("/src/main.tsx")
    const { server, transformed } = fakeServer(
      {
        // The entry stamps, so the OLD loop returned here and never looked lower.
        "/src/main.tsx": { code: STAMPED, imports: ["/src/App.tsx"] },
        "/src/App.tsx": { code: STAMPED, imports: ["/src/components/Card.tsx"] },
        // The refusing file: reachable only by compiling the two above it.
        "/src/components/Card.tsx": { code: UNSTAMPED },
      },
      ["/src/main.tsx"],
    )

    return anyStampedModuleHasDataPtSrc(server, "http://x").then((any) => {
      expect(any).toBe(true)
      expect(transformed).toContain("/src/components/Card.tsx")
    })
  })

  it("still answers true, and still answers false, on the same evidence as before", async () => {
    stubIndexHtml("/src/main.tsx")
    const stamped = fakeServer({ "/src/main.tsx": { code: STAMPED } }, ["/src/main.tsx"])
    const bare = fakeServer({ "/src/main.tsx": { code: UNSTAMPED } }, ["/src/main.tsx"])

    expect(await anyStampedModuleHasDataPtSrc(stamped.server, "http://x")).toBe(true)
    expect(await anyStampedModuleHasDataPtSrc(bare.server, "http://x")).toBe(false)
  })

  it("finds a stamp that lives BELOW an unstamped entry", async () => {
    // The evidence half, on the path where completeness was always required:
    // the old loop had no early exit when nothing matched, so this worked then
    // too. Held so the concurrency rewrite cannot quietly lose it.
    stubIndexHtml("/src/main.tsx")
    const { server } = fakeServer(
      {
        "/src/main.tsx": { code: UNSTAMPED, imports: ["/src/App.vue"] },
        "/src/App.vue": { code: STAMPED },
      },
      ["/src/main.tsx"],
    )
    expect(await anyStampedModuleHasDataPtSrc(server, "http://x")).toBe(true)
  })

  it("does not compile installed dependencies", async () => {
    // Both stampers refuse a `node_modules` path outright, so nothing under
    // there can carry a stamp we wrote — and a vendored `data-desde-src` reported
    // as proof our stamper runs would be a false positive. Skipping is also
    // where the completed walk's cost would otherwise have gone.
    stubIndexHtml("/src/main.tsx")
    const { server, transformed } = fakeServer(
      {
        "/src/main.tsx": { code: UNSTAMPED, imports: ["/node_modules/lib/dist/Widget.vue"] },
        "/node_modules/lib/dist/Widget.vue": { code: STAMPED },
      },
      ["/src/main.tsx"],
    )

    expect(await anyStampedModuleHasDataPtSrc(server, "http://x")).toBe(false)
    expect(transformed).not.toContain("/node_modules/lib/dist/Widget.vue")
  })

  it("ignores modules no stamper claims", async () => {
    stubIndexHtml("/src/main.ts")
    const { server, transformed } = fakeServer(
      {
        "/src/main.ts": { code: UNSTAMPED, imports: ["/src/util.ts", "/src/App.tsx"] },
        "/src/util.ts": { code: UNSTAMPED },
        "/src/App.tsx": { code: STAMPED },
      },
      ["/src/main.ts"],
    )

    expect(await anyStampedModuleHasDataPtSrc(server, "http://x")).toBe(true)
    // `/src/main.ts` is transformed as the ENTRY; `/src/util.ts` is never a
    // stamper's business and is not compiled on its account.
    expect(transformed).not.toContain("/src/util.ts")
  })
})

describe("anyStampedModuleHasDataPtSrc — the budget cannot weaken the verdict", () => {
  /** A chain long enough that any nonzero per-module cost exhausts a 0ms budget. */
  function chain(length: number, stampedAt: number | null) {
    const modules: Record<string, FakeModule> = {}
    for (let i = 0; i < length; i++) {
      modules[`/src/m${i}.tsx`] = {
        code: i === stampedAt ? STAMPED : UNSTAMPED,
        ...(i + 1 < length ? { imports: [`/src/m${i + 1}.tsx`] } : {}),
      }
    }
    return modules
  }

  it("runs to completion with a zero budget while nothing has matched yet", async () => {
    // The regression this forbids: a wall-clock budget on a walk that feeds a
    // TEARDOWN gate is a way to shut a healthy dev server down on a slow
    // machine. Miss the one stamped module and `moduleGraphEvidence` answers
    // false, which on a server-rendered host completes § 6's conjunction. So
    // the deadline is only ever consulted AFTER a match exists.
    stubIndexHtml("/src/m0.tsx")
    const { server } = fakeServer(chain(40, 39), ["/src/m0.tsx"])
    expect(await anyStampedModuleHasDataPtSrc(server, "http://x", 0)).toBe(true)
  })

  it("stops early once it has an answer, because the rest is only a report", async () => {
    stubIndexHtml("/src/m0.tsx")
    const { server, transformed } = fakeServer(chain(200, 0), ["/src/m0.tsx"])
    expect(await anyStampedModuleHasDataPtSrc(server, "http://x", 0)).toBe(true)
    expect(transformed.length).toBeLessThan(200)
  })

  it("visits everything when the budget is the real one", async () => {
    stubIndexHtml("/src/m0.tsx")
    const { server, transformed } = fakeServer(chain(60, 0), ["/src/m0.tsx"])
    expect(await anyStampedModuleHasDataPtSrc(server, "http://x")).toBe(true)
    expect(new Set(transformed).size).toBe(60)
  })
})

import type { ViteDevServer } from "vite"

/**
 * The deepest evidence a Vite-family host can give that the source stamper is
 * running: a module in Vite's own graph whose COMPILED output carries
 * `data-desde-src`.
 *
 * Moved here verbatim from `core.ts`, where it was the supervised half of
 * `runSmokeCheck`. It has two consumers now — that smoke check, unchanged, and
 * the `vite` host's `HostBoot.moduleGraphEvidence()`, which
 * `tasks/dev-server-hosts.md` § 3 specifies as "today's
 * `anyStampedModuleHasDataPtSrc` walk verbatim". Keeping one implementation is
 * the point: the verdict the boot gate reports and the verdict the smoke report
 * prints must not be able to disagree.
 *
 * Why this is evidence rather than proof-of-absence: it may only PROMOTE a
 * verdict to "stamped", never on its own produce "unstamped" (§ 1,
 * `HostBoot.moduleGraphEvidence`). A cold graph legitimately contains nothing.
 *
 * ── It no longer stops at the first stamp, and that is a product change ─────
 *
 * MEASURED, 2026-08-11, with the loop instrumented and the shipped CLI booted
 * against a three-module React fixture: the walk visited `/src/main.tsx`,
 * matched, and returned. ONE module. Everything else in the graph — including
 * `src/components/Card.tsx`, which was refusing to stamp under
 * `styled-jsx/babel` — was compiled a second or two later by Vite's own
 * background `preTransformRequests`, which is to say AFTER the CLI had already
 * printed its boot summary. Verbatim, in that order:
 *
 *     [walk] visit /src/main.tsx cached=true
 *     [walk] STOP at /src/main.tsx
 *     ▸ Smoke check passed (bridge tag + data-desde-src present in served output)
 *     [stamp] src/components/Card.tsx … This file stays inspect-only …
 *
 * That ordering is why the boot report could not name a refused file: at the
 * moment it renders, one module has been compiled and the stampers have had one
 * chance to speak. Reading a ledger at that point is not a check, it is a race.
 *
 * **And the race is worse than the terminal makes it look.** ISOLATED by
 * reverting ONLY this file while keeping the ledger and the boot report: on the
 * `styled-jsx` fixture the `[stamp]` warning printed on line 3 and
 * `▸ Smoke check passed` on line 9 — the warning visibly ahead of the gate — and
 * the boot report was STILL empty. `runSmokeCheck` snapshots the ledger inside
 * `startCore`; every `▸` line is printed by `cli.ts` afterwards. So a refusal
 * that lands in Vite's background pre-transform between those two points appears
 * ABOVE the summary while having been unavailable to it. "The warning already
 * prints three lines up, so the gate need only consult it" is true of the screen
 * and false of the code.
 *
 * Driving the walk is what removes the ordering from the question.
 *
 * So the walk now attempts every first-party stampable module, and the boot
 * report's per-module half (`hosts/stamp-notices.ts`) is built on facts the
 * stampers declared while it did. The existential answer is derived from the
 * same pass — one walk, one source of truth, which is what the paragraph above
 * has always demanded.
 *
 * ── What it costs, measured rather than estimated ───────────────────────────
 *
 * On a purpose-built 304-module React fixture (macOS, warm dep cache, four
 * boots each): the walk itself takes 443ms at concurrency 8 (569ms at 16 —
 * Babel is CPU-bound, so more lanes lose), and boot-to-summary goes from a
 * 2086ms median to 2465ms. On a three-module fixture the walk takes 47ms and
 * the difference disappears into run-to-run noise. Most of that work is not
 * new: Vite's own `preTransformRequests` compiles the same modules moments
 * later, so what changed is mostly WHEN, not WHETHER.
 *
 * ── The budget cannot weaken the verdict, by construction ───────────────────
 *
 * A wall-clock budget on a walk that feeds a TEARDOWN gate is a way to shut a
 * healthy dev server down on a slow machine: miss the one stamped module and
 * `moduleGraphEvidence` answers `false`, which on a server-rendered host
 * completes § 6's conjunction. So the deadline is only consulted AFTER a stamp
 * has been found. Until then the walk runs to completion — exactly as it did
 * before, since the old loop was unbounded too. The budget therefore only ever
 * truncates work that is purely reportorial, and the set of modules visited
 * before the first match is a SUPERSET of the set the old early-returning loop
 * visited.
 */

function isStampableModuleUrl(url: string): boolean {
  return url.endsWith(".vue") || url.endsWith(".tsx") || url.endsWith(".jsx")
}

/**
 * Installed dependencies are skipped, and this is a strict improvement rather
 * than a corner cut. Both stampers refuse a `node_modules` path outright
 * (`hosts/stamp-policy.ts`), so no module under here can carry a stamp WE
 * wrote; a `data-desde-src` found in one would be a vendored artifact reported as
 * proof that our stamper is running, which is a false positive. Skipping them
 * also keeps the completed walk off a library's own `.vue` sources, which is
 * where the transform cost would actually have hurt.
 */
function isFirstPartyModuleUrl(url: string): boolean {
  return !url.includes("/node_modules/")
}

/** How many transforms run at once. 8 beat 16 in the measurement above. */
const WALK_CONCURRENCY = 8

/**
 * How long the walk may keep going AFTER it already has its answer, purely to
 * finish populating the stamp ledger. At the measured ~1.45ms/module this
 * covers on the order of a thousand modules — far past any prototype, and short
 * enough that a pathological monorepo cannot stall boot.
 */
const REPORT_BUDGET_MS = 2000

/**
 * Compile every first-party `.vue`/`.tsx`/`.jsx` module reachable from the
 * entry, and report whether any of them came out carrying `data-desde-src`.
 *
 * Vite compiles lazily, driven by *browser* requests — a server-side fetch of
 * `/` returns the index HTML but does NOT transform the entry script or its
 * transitive imports, so the graph starts empty on a cold boot. The earlier
 * implementation relied on a browser having loaded modules first; under
 * `--no-open` (no browser to drive it) that never happened and the check
 * false-warned that the source-tag plugin was skipped. We populate the graph
 * ourselves: discover the entry module(s) from the served HTML, transform them,
 * and keep re-scanning the graph as import analysis registers what they pulled
 * in.
 */
export async function anyStampedModuleHasDataPtSrc(
  server: ViteDevServer,
  prototypeUrl: string,
  budgetMs: number = REPORT_BUDGET_MS,
): Promise<boolean> {
  const moduleGraph = server.moduleGraph

  // Transforming the entry script pulls its direct imports (incl. the
  // root `.vue`) into the graph. Do this before walking; the graph is
  // otherwise empty without a browser.
  for (const entry of await discoverEntryModules(prototypeUrl)) {
    await server.transformRequest(entry).catch(() => null)
  }

  const settled = new Set<string>()
  let any = false
  let deadline: number | null = null

  for (;;) {
    // Re-scanned every round rather than iterated once: forcing a transform is
    // what makes import analysis register that module's own imports, so the map
    // grows underneath us and a single pass would stop at whatever depth
    // happened to be registered when it started.
    const batch: string[] = []
    for (const url of moduleGraph.urlToModuleMap.keys()) {
      if (settled.has(url)) continue
      if (!isStampableModuleUrl(url) || !isFirstPartyModuleUrl(url)) {
        settled.add(url)
        continue
      }
      batch.push(url)
      if (batch.length >= WALK_CONCURRENCY) break
    }
    if (batch.length === 0) break
    // Consulted at batch boundaries, and only once an answer exists — see the
    // header. `any === false` keeps the walk unbounded, which is the old
    // behaviour on the path where the old behaviour mattered.
    if (deadline !== null && Date.now() > deadline) break

    const results = await Promise.all(
      batch.map(async (url) => {
        settled.add(url)
        // A `.vue` may have been registered (via import-analysis) but not yet
        // transformed, so force its transform when `transformResult` is null.
        const cached = moduleGraph.urlToModuleMap.get(url)?.transformResult?.code ?? null
        const compiled = cached ?? (await server.transformRequest(url).catch(() => null))?.code
        return compiled != null && compiled.includes("data-desde-src")
      }),
    )
    if (!any && results.some(Boolean)) {
      any = true
      deadline = Date.now() + budgetMs
    }
  }

  return any
}

/**
 * Pull the local module-script entry points out of the served index
 * HTML (e.g. `<script type="module" src="/src/main.ts">`). Only same-
 * origin paths are returned — external/CDN scripts can't be transformed
 * by Vite and aren't where the user's `.vue` tree lives. Falls back to
 * the conventional Vite entry if the HTML can't be read or names none.
 */
async function discoverEntryModules(viteUrl: string): Promise<string[]> {
  const fallback = ["/src/main.ts", "/src/main.js", "/src/main.tsx", "/src/main.jsx"]
  try {
    const html = await (await fetch(viteUrl + "/")).text()
    const entries: string[] = []
    const re = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const src = m[1]
      // Same-origin only: leading-slash path, or a bare relative path.
      if (/^https?:\/\//i.test(src)) continue
      entries.push(src.startsWith("/") ? src : `/${src}`)
    }
    return entries.length > 0 ? entries : fallback
  } catch {
    return fallback
  }
}

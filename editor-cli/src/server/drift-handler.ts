/**
 * CLI HTTP handler for the live grounding drift log (Phase 5 Task 1 of
 * the grounding rearchitecture):
 *
 *   POST /api/editor/drift                          — record a batch of drift signals
 *   GET  /api/editor/drift                          — list the live drift log
 *   POST /api/editor/drift/:key/regenerate-hints    — Task 5: user-initiated
 *                                                         probe re-run for ONE
 *                                                         drift entry's component
 *
 * Advisory-first, mirroring `src/editor/core/drift.ts`'s own posture: a
 * malformed signal inside a POST batch is skipped and counted, never
 * fatal to the request — a caller reporting drift shouldn't be able to
 * break the very diagnostic meant to surface OTHER breakage. Auth/Origin
 * discipline and body-parsing follow the sibling `design-systems-handler.ts`
 * (`readJsonBody` / `sendJson`, 400 on a malformed request body).
 *
 * The `DriftLog` instance itself is process-lifetime state created once
 * per canonical root by `http-server.ts` (same pattern as the artifact
 * stores) and threaded in via `ctx.driftLog` — this module never
 * constructs or persists one itself.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { join, resolve, sep } from "node:path"
import {
  DRIFT_KINDS,
  type ComponentManifest,
  type ComponentManifestSource,
  type DriftEntry,
  type DriftLog,
  type DriftSignal,
} from "../../../src/editor/core"
import { triggerRepairForEntry, type RepairTriggerCtx } from "./repair-trigger.js"
import {
  createDefaultOnboardDeps,
  createLocalRegistryStore,
  type RegisteredDesignSystem,
} from "../../../src/editor/onboarding/index.js"
import { CACHE_DIR_NAME, resolveHintsCacheVersion } from "../../../src/editor/adapters/cached/index.js"
import { generateHintsRun, type GenerateHintsRunResult } from "../../../src/editor/hints/generate-hints-run.js"
import { probeComponent, type ProbePage } from "../../../src/editor/hints/probe-driver.js"
import {
  buildComponentFileIndex,
  inferRenderingHintsFromSource,
} from "../../../src/editor/hints/infer-from-source.js"
import { BodyTooLargeError, readJsonBody, sendJson } from "./artifact-http.js"
import { openSseStream, watchClientDisconnect } from "./sse.js"

export const DRIFT_ROUTE = "/api/editor/drift"
const REGENERATE_HINTS_SUFFIX = "/regenerate-hints"

/** Reject a POST batch larger than this many signals in one request (400). */
export const MAX_SIGNALS_PER_REQUEST = 50

/**
 * Matches the base route, the `…/:key/regenerate-hints` sub-route, and
 * (Phase 5 Task 5) `…/:key` for the per-entry DELETE dismiss route — any
 * path under `DRIFT_ROUTE` is ours; `handleDriftRequest` itself narrows by
 * method + exact suffix and 404s a combination it doesn't recognize (e.g. a
 * GET or POST straight to `…/:key`).
 */
export function matchesDriftRoute(pathname: string): boolean {
  return pathname === DRIFT_ROUTE || pathname.startsWith(`${DRIFT_ROUTE}/`)
}

/**
 * `repair` and `pendingInvalidations` are now defined once on the shared
 * `RepairTriggerCtx` (`repair-trigger.ts`) — extracted 2026-07-30 so the
 * server-side `manifest-value-mismatch` producer
 * (`manifest-value-mismatch-drift.ts`) can trigger repairs through the
 * exact same `triggerRepairForEntry` this handler's POST route uses,
 * rather than a POST-only code path leaving that producer's entries never
 * repaired. See that module's doc comment for the full semantics of both
 * fields (single-flight queue, once-per-entry guard, invalidation
 * delivery, `onRegistryChange`).
 */
export interface DriftHandlerCtx extends RepairTriggerCtx {
  driftLog: DriftLog
  /**
   * Phase 5 Task 5 wiring for `POST …/:key/regenerate-hints` — the
   * user-initiated "Regenerate hints" panel action. Omitted (e.g. a
   * deployment/test that never wires a canonical root) ⇒ the route 404s with
   * a clear reason rather than the whole `handleDriftRequest` throwing;
   * mirrors `repair` being optional above.
   */
  regenerateHints?: {
    canonicalRoot: string
    /**
     * Resolves the CURRENT manifest source, building it if not yet memoized
     * — the SAME seam `DesignSystemsHandlerCtx.getManifestSource` uses for
     * the sibling Phase 4 route. Only reached as a fallback when the
     * targeted registered entry's OWN per-package source can't be built
     * (see `resolveOneComponent`'s doc comment).
     */
    getManifestSource: () => Promise<ComponentManifestSource | null>
    /** Same seam as the Phase 4 generate-hints route — one probe page per run, closed by this handler. */
    createProbePage: () => Promise<ProbePage | null>
    /** Origin of the supervised Vite dev server the probe navigates against. */
    viteBaseUrl: string
    /** Invalidate the memoized grounding service so serving picks up the freshly-written hint cache. */
    onRegistryChange: () => void
  }
}

export async function handleDriftRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DriftHandlerCtx,
): Promise<void> {
  // Every existing caller (production `http-server.ts`, and every test in
  // this module's suite) hits this handler only for requests already routed
  // through `matchesDriftRoute` — `req.url` is always the real request path
  // in production. Tests that don't set `.url` (the base GET/POST suite,
  // predating this route) fall back to the base route, preserving their
  // exact prior behavior.
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : DRIFT_ROUTE

  if (
    req.method === "POST" &&
    pathname.startsWith(`${DRIFT_ROUTE}/`) &&
    pathname.endsWith(REGENERATE_HINTS_SUFFIX)
  ) {
    await handleRegenerateHints(req, res, pathname, ctx)
    return
  }

  // `DELETE …/:key` (Phase 5 Task 5) — dismiss ONE entry (the panel row's
  // "Dismiss" action). Checked before the `pathname !== DRIFT_ROUTE` 404
  // guard below since a per-key DELETE's pathname is never exactly
  // `DRIFT_ROUTE`. A GET/POST straight to `…/:key` (no recognized suffix)
  // still falls through to that guard and 404s, unchanged.
  if (
    req.method === "DELETE" &&
    pathname.startsWith(`${DRIFT_ROUTE}/`) &&
    !pathname.endsWith(REGENERATE_HINTS_SUFFIX)
  ) {
    const middle = pathname.slice(`${DRIFT_ROUTE}/`.length)
    let key: string
    try {
      key = decodeURIComponent(middle)
    } catch {
      sendJson(res, 400, { ok: false, reason: "Malformed drift key." })
      return
    }
    if (!key) {
      sendJson(res, 400, { ok: false, reason: "Invalid drift key." })
      return
    }
    // Dismissal no longer needs to capture anything from the entry before
    // removing it — Phase 5 Task 2 root-cause fix (2026-07-30). A repair's
    // invalidation is enqueued onto `ctx.pendingInvalidations` at SETTLE
    // time (see `triggerRepairForEntry` in `repair-trigger.ts`), independent of the drift log,
    // so it survives this `clear(key)` regardless of whether the repair had
    // already settled by the time the user dismissed this row. See
    // `pending-invalidation-queue.ts`'s doc comment for the full history —
    // this replaces two prior narrow patches that each captured the
    // ABOUT-TO-BE-DELETED entry's invalidation before clearing it, which
    // still lost a repair that was still `pending` (no outcome yet to
    // capture) at dismiss time.
    ctx.driftLog.clear(key)
    sendJson(res, 200, {
      ok: true,
      entries: ctx.driftLog.list(),
      invalidate: ctx.pendingInvalidations?.drain() ?? [],
    })
    return
  }

  if (pathname !== DRIFT_ROUTE) {
    sendJson(res, 404, { ok: false, reason: "Unknown drift route." })
    return
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      entries: ctx.driftLog.list(),
      invalidate: ctx.pendingInvalidations?.drain() ?? [],
    })
    return
  }

  if (req.method === "POST") {
    let body: { signals?: unknown }
    try {
      body = await readJsonBody(req)
    } catch (err) {
      // Mirrors the sibling artifact-store handlers' `sendStoreError`
      // convention: an oversized body is a 413, not a generic 400 — the
      // request was well-formed, just too large.
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { ok: false, reason: err.message })
        return
      }
      sendJson(res, 400, { ok: false, reason: errorMessage(err) })
      return
    }

    if (!Array.isArray(body.signals)) {
      sendJson(res, 400, { ok: false, reason: "`signals` must be an array." })
      return
    }
    if (body.signals.length > MAX_SIGNALS_PER_REQUEST) {
      sendJson(res, 400, {
        ok: false,
        reason: `\`signals\` exceeds the ${MAX_SIGNALS_PER_REQUEST}-per-request cap (got ${body.signals.length}).`,
      })
      return
    }

    let recorded = 0
    let skipped = 0
    for (const raw of body.signals) {
      const validated = validateSignal(raw)
      if (!validated) {
        skipped += 1
        continue
      }
      const entry = ctx.driftLog.record(validated)
      recorded += 1
      triggerRepairForEntry(validated.kind, entry, ctx)
    }

    sendJson(res, 200, {
      ok: true,
      recorded,
      skipped,
      entries: ctx.driftLog.list(),
      invalidate: ctx.pendingInvalidations?.drain() ?? [],
    })
    return
  }

  // `DELETE` on the base route (Phase 5 Task 5) — the panel's "Clear all"
  // header action. Draining `pendingInvalidations` (rather than deriving
  // from the log) means clearing every entry can never lose a pending
  // repair's eventual invalidation — see the ctx field's doc comment.
  if (req.method === "DELETE") {
    ctx.driftLog.clear()
    sendJson(res, 200, {
      ok: true,
      entries: ctx.driftLog.list(),
      invalidate: ctx.pendingInvalidations?.drain() ?? [],
    })
    return
  }

  sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
}

/**
 * `POST …/:key/regenerate-hints` (Phase 5 Task 5) — the panel's "Regenerate
 * hints" row action: re-run the SAME probe/inference engine Phase 4's
 * `POST …/:id/generate-hints` uses, but scoped to the ONE component this
 * drift entry names, via a one-element `components` array —
 * `generateHintsRun`'s existing carry-forward rule (every OTHER component's
 * prior hint-cache entry is preserved verbatim, see that module's doc
 * comment) means this never needs its own merge logic.
 *
 * Guards, mirroring the Phase 4 route:
 *   - 404 unknown drift key.
 *   - 422 when the entry has no resolved `designSystem` (nothing to look up).
 *   - 422 when no REGISTERED design system matches (nothing attached/onboarded
 *     for this component — the user needs to add one first, not regenerate).
 *   - 422 when the registered package isn't installed and isn't repo-ingested
 *     (same "probing supports installed packages only (V1)" reason the
 *     Phase 4 route uses).
 *   - 422 when the component itself can't be resolved to a manifest (neither
 *     the per-package source nor the composite catalog knows it).
 *
 * Streams the same progress/result/error SSE envelope as the Phase 4 route
 * when the client asks for it (`Accept: text/event-stream`).
 */
async function handleRegenerateHints(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: DriftHandlerCtx,
): Promise<void> {
  const middle = pathname.slice(
    `${DRIFT_ROUTE}/`.length,
    pathname.length - REGENERATE_HINTS_SUFFIX.length,
  )
  let key: string
  try {
    key = decodeURIComponent(middle)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Malformed drift key." })
    return
  }
  if (!key) {
    sendJson(res, 400, { ok: false, reason: "Invalid drift key." })
    return
  }

  const entry = ctx.driftLog.get(key)
  if (!entry) {
    sendJson(res, 404, { ok: false, reason: `No drift entry with key '${key}'.` })
    return
  }

  if (!ctx.regenerateHints) {
    sendJson(res, 404, { ok: false, reason: "regenerate-hints is not available on this server." })
    return
  }
  const { canonicalRoot, getManifestSource, createProbePage, viteBaseUrl, onRegistryChange } =
    ctx.regenerateHints

  if (!entry.designSystem) {
    sendJson(res, 422, {
      ok: false,
      reason: "drift entry has no resolved design system, so hints cannot be regenerated for it.",
    })
    return
  }

  const registered = await createLocalRegistryStore(canonicalRoot).list()
  const found = registered.find(
    (r) =>
      r.designSystem === entry.designSystem &&
      (entry.importPath === undefined || r.importPath === entry.importPath),
  )
  if (!found) {
    sendJson(res, 422, {
      ok: false,
      reason: `No registered design system found for '${entry.designSystem}'. Add it first.`,
    })
    return
  }

  const repoIngested = !!found.packageRoot && found.source.kind === "repo"
  if (found.packageRoot && !repoIngested) {
    sendJson(res, 422, {
      ok: false,
      reason:
        "package not installed in the prototype; probing supports installed packages only (V1)",
    })
    return
  }

  const target = await resolveOneComponent(entry.component, found, canonicalRoot, getManifestSource)
  if (!target) {
    sendJson(res, 422, {
      ok: false,
      reason: `component "${entry.component}" not found in "${found.package}"'s manifest source.`,
    })
    return
  }

  const runEntry = {
    packageName: found.package,
    packageVersion: resolveHintsCacheVersion(resolve(canonicalRoot), found),
    designSystem: found.designSystem,
    importPath: found.importPath,
  }
  const cacheDir = join(canonicalRoot, CACHE_DIR_NAME)
  const components = [target]

  const disconnect = watchClientDisconnect(req, res)
  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream")

  const run = (
    onProgress?: (progress: { component: string; index: number; total: number }) => void,
  ): Promise<GenerateHintsRunResult> =>
    runOneComponentRegen({
      found,
      repoIngested,
      canonicalRoot,
      runEntry,
      cacheDir,
      components,
      createProbePage,
      viteBaseUrl,
      onProgress,
    })

  if (!wantsStream) {
    let result: GenerateHintsRunResult
    try {
      result = await run()
    } catch (err) {
      disconnect.dispose()
      sendJson(res, 422, { ok: false, reason: errorMessage(err) })
      return
    }
    disconnect.dispose()
    onRegistryChange()
    sendJson(res, 200, { ok: true, result, invalidate: regenerateInvalidateEntries(entry, result) })
    return
  }

  const stream = openSseStream(req, res)
  try {
    const result = await run((progress) => stream.send({ type: "progress", progress }))
    disconnect.dispose()
    onRegistryChange()
    stream.send({ type: "result", result, invalidate: regenerateInvalidateEntries(entry, result) })
  } catch (err) {
    disconnect.dispose()
    stream.send({ type: "error", message: errorMessage(err) })
  } finally {
    stream.close()
  }
}

/**
 * Codex P2 fix (2026-07-30): a successful "Regenerate hints" run writes a
 * fresh on-disk hint cache for `entry.component` and resets the server's
 * memoized grounding service (`onRegistryChange()` above), but until this
 * fix the route's result carried NO invalidation for the shell's
 * `CachedManifestLookup` — `useDriftEntries.regenerateHints()` only reloaded
 * the drift log afterward, and THAT reload's `invalidate` list
 * (`invalidateList` below) covers Task 4 auto-repair outcomes only
 * (`repair?.outcome === 'repaired' | 'seeded'`); a user-initiated regenerate
 * never touches `entry.repair`, so it was silently excluded. Attribution
 * kept using the stale cached manifest with the OLD `rendering` hints until
 * some unrelated invalidation fired, or a session reload.
 *
 * Returns one entry in the SAME `{name, importPath?, attemptedAt}` shape
 * `invalidateList` emits, so the shell applies it through the SAME shared
 * `applyInvalidateList`/`invalidationDedupeKey` helper
 * (`src/hooks/drift-manifest-invalidation.ts`) the reporter and reload path
 * already use — not a forked parsing path.
 *
 * `attemptedAt` is stamped HERE, at run completion, rather than reusing
 * `entry.repair?.attemptedAt` (which may not even be set) — a regenerate
 * isn't a repair, so it needs its OWN identity distinct from any repair the
 * dedupe helper may have already seen for this `(name, importPath)` pair.
 * The dedupe key is `(name, importPath, attemptedAt)`; a shared/stale
 * timestamp would make a genuinely new regenerate collide with a prior
 * repair (or a prior regenerate) and get silently swallowed.
 *
 * Empty when `result.wroteCache` is `false` — mirrors `invalidateList`'s own
 * "a write happened, go re-read it" posture: a run that touched nothing on
 * disk has nothing for the shell to re-fetch.
 */
function regenerateInvalidateEntries(
  entry: DriftEntry,
  result: GenerateHintsRunResult,
): Array<{ name: string; importPath?: string; attemptedAt: string }> {
  if (!result.wroteCache) return []
  return [
    {
      name: entry.component,
      ...(entry.importPath !== undefined ? { importPath: entry.importPath } : {}),
      attemptedAt: new Date().toISOString(),
    },
  ]
}

/**
 * Resolve `componentName`'s CURRENT manifest, preferring the registered
 * entry's OWN per-package source (built fresh via the SAME
 * `createDefaultOnboardDeps().buildSource` the Phase 4 route's
 * `enumerateOwnPackageComponents` uses — see that function's doc comment on
 * why the deduped composite catalog can silently drop a same-named
 * component from a different package) and falling back to
 * `getManifestSource()`'s composite only when the dedicated per-package
 * source can't be built at all (no tsconfig resolvable, package no longer on
 * disk, etc. — the same degrade-gracefully posture the Phase 4 route uses).
 */
async function resolveOneComponent(
  componentName: string,
  found: RegisteredDesignSystem,
  canonicalRoot: string,
  getManifestSource: () => Promise<ComponentManifestSource | null>,
): Promise<ComponentManifest | null> {
  const onboardDeps = await createDefaultOnboardDeps(canonicalRoot)
  const tsconfigPath = (await onboardDeps.resolveTsconfig(canonicalRoot)) ?? ""
  const packageSource = onboardDeps.buildSource(found, canonicalRoot, tsconfigPath)
  if (packageSource) {
    return packageSource.getComponent(componentName)
  }
  const manifestSource = await getManifestSource()
  if (!manifestSource) return null
  return manifestSource.getComponent(componentName)
}

/**
 * Resolve `packageRoot` for a repo-ingested entry's retained clone, the SAME
 * containment rule the Phase 4 route's `resolveIngestedSourceRoot` applies
 * (contained inside `<root>/.desde/ingested`, not merely inside the
 * prototype root) — duplicated here rather than imported since that helper
 * is private to `design-systems-handler.ts`.
 */
function resolveIngestedSourceRoot(root: string, entry: RegisteredDesignSystem): string | null {
  if (!entry.packageRoot) return null
  const realRoot = resolve(root)
  const ingestedRoot = join(realRoot, ".desde", "ingested")
  const resolved = resolve(realRoot, entry.packageRoot)
  if (resolved !== ingestedRoot && !resolved.startsWith(ingestedRoot + sep)) return null
  return resolved
}

/**
 * Runs `generateHintsRun` for exactly the one-element `components` array —
 * probe path for an installed package (opens ONE probe page, closed in
 * `finally`), inference path for a repo-ingested one (never opens a probe
 * page — mirrors the Phase 4 route's `runGenerateHintsFor`).
 */
async function runOneComponentRegen(args: {
  found: RegisteredDesignSystem
  repoIngested: boolean
  canonicalRoot: string
  runEntry: { packageName: string; packageVersion: string; designSystem: string; importPath?: string }
  cacheDir: string
  components: ComponentManifest[]
  createProbePage: () => Promise<ProbePage | null>
  viteBaseUrl: string
  onProgress?: (progress: { component: string; index: number; total: number }) => void
}): Promise<GenerateHintsRunResult> {
  const { found, repoIngested, canonicalRoot, runEntry, cacheDir, components, createProbePage, viteBaseUrl, onProgress } =
    args

  if (repoIngested) {
    const sourceRoot = resolveIngestedSourceRoot(canonicalRoot, found)
    const fileIndex = sourceRoot ? buildComponentFileIndex(sourceRoot) : null
    return generateHintsRun({
      entry: runEntry,
      cacheDir,
      components,
      inferHints: fileIndex
        ? (manifest) => inferRenderingHintsFromSource(manifest, fileIndex)
        : undefined,
      onProgress,
    })
  }

  const page = await createProbePage()
  if (!page) {
    throw new Error(
      "No headless browser available for probing (install Playwright browsers or a system Chrome).",
    )
  }
  try {
    return await generateHintsRun({
      entry: runEntry,
      cacheDir,
      components,
      probe: (spec) => probeComponent({ baseUrl: viteBaseUrl, spec, page }),
      onProgress,
    })
  } finally {
    await page.close()
  }
}

// Repair triggering itself now lives in `triggerRepairForEntry`
// (`repair-trigger.ts`) — extracted 2026-07-30 so the server-side
// `manifest-value-mismatch` producer can share it. See that module's doc
// comment for the full behavior (single-flight queue, once-per-entry
// guard, invalidation delivery, `onRegistryChange`) previously documented
// here.

const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/

function isCleanString(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHAR_PATTERN.test(value)
}

/**
 * Validate one raw signal from the POST body into a well-typed
 * `DriftSignal`, or `null` when it's malformed (unknown `kind`, missing/
 * empty `component`, a non-string optional field, or any string carrying
 * a control character). Never throws — an unexpected shape is just
 * another reason to return `null`, which the caller counts as `skipped`
 * rather than failing the whole batch.
 */
function validateSignal(raw: unknown): DriftSignal | null {
  if (!raw || typeof raw !== "object") return null
  const s = raw as Record<string, unknown>

  if (typeof s.kind !== "string" || !(DRIFT_KINDS as readonly string[]).includes(s.kind)) return null
  if (!isCleanString(s.component) || s.component.trim().length === 0) return null

  if (s.importPath !== undefined && !isCleanString(s.importPath)) return null
  if (s.designSystem !== undefined && !isCleanString(s.designSystem)) return null
  if (s.detail !== undefined && !isCleanString(s.detail)) return null
  // `at` is validated as a real timestamp, not just a clean string — a
  // malformed value (garbage text, a clean-but-unparseable string) would
  // corrupt `DriftEntry.lastSeen` ordering downstream (Task 5's rendering).
  // Skip the whole signal rather than silently substituting a stamped
  // time, matching this function's "malformed ⇒ skipped" posture for
  // every other field.
  if (s.at !== undefined && (!isCleanString(s.at) || Number.isNaN(Date.parse(s.at)))) return null

  return {
    kind: s.kind as DriftSignal["kind"],
    component: s.component,
    ...(s.importPath !== undefined ? { importPath: s.importPath as string } : {}),
    ...(s.designSystem !== undefined ? { designSystem: s.designSystem as string } : {}),
    ...(s.detail !== undefined ? { detail: s.detail as string } : {}),
    // `at` is required on `DriftSignal`; a caller that omits it still gets
    // a usable entry rather than being dropped over a field that carries
    // no diagnostic value of its own — stamp it server-side.
    at: typeof s.at === "string" ? s.at : new Date().toISOString(),
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

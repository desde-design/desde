/**
 * CLI routes for the "add a design system" self-serve onboarding flow
 * (tasks/design-system-onboarding-app-flow-spec.md, milestone 6.3b). All
 * routes operate on the CANONICAL repo root (the durable checkout that owns
 * `.desde/design-systems.json` + node_modules + tsconfig), NOT the
 * ephemeral per-session worktree — so a registered system survives sessions
 * and is visible to manifest serving (which also builds against canonical).
 *
 *   GET    /api/editor/design-systems              → list registered systems
 *   GET    /api/editor/design-systems/suggestions  → suggest installed libs
 *   GET    /api/editor/design-systems/updates      → staleness check per entry
 *                                                        (Phase 3 refresh; TTL-cached)
 *   POST   /api/editor/design-systems              → onboard (SSE progress)
 *   DELETE /api/editor/design-systems/:id          → remove a registration
 *   POST   /api/editor/design-systems/:id/share    → declare a registered
 *                                                        entry so future boots
 *                                                        re-onboard it (Phase 3
 *                                                        attach/refresh)
 *   POST   /api/editor/design-systems/:id/refresh  → re-onboard a registered
 *                                                        entry from its ORIGINAL
 *                                                        source (SSE progress,
 *                                                        Phase 3 attach/refresh)
 *   POST   /api/editor/design-systems/:id/generate-hints
 *                                                     → probe-derive rendering
 *                                                        hints (SSE progress,
 *                                                        Phase 4 Task 3);
 *                                                        repo-ingested entries
 *                                                        run an inference-only
 *                                                        variant instead of
 *                                                        probing (Phase 4
 *                                                        Task 4 — see
 *                                                        `handleGenerateHints`)
 *
 * `prototypeRoot` is ALWAYS the server's canonical root — never read from the
 * request body — so a caller can't redirect extraction/registration elsewhere.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { join, resolve, sep } from "node:path"
import {
  createLocalRegistryStore,
  onboardDesignSystem,
  createDefaultOnboardDeps,
  suggestDesignSystems,
  registryEntryIdentity,
  type DesignSystemSource,
  type OnboardRequest,
  type ReconcileStatus,
  type RegisteredDesignSystem,
  type RegistryStore,
  type StalenessResult,
} from "../../../src/editor/onboarding/index.js"
import type { ComponentManifest, ComponentManifestSource, GroundingHealth } from "../../../src/editor/core"
import { desdePath, desdePathOrNull } from "../../../src/editor/worktree/desde-dir.js"
import {
  loadDesignSystemDeclarations,
  appendDesignSystemDeclaration,
  declarationIdentity,
  type DesignSystemDeclaration,
} from "../../../src/editor/core/design-system-declarations.js"
import { CONFIG_FILENAME } from "../../../src/editor/core/read-roots.js"
import { withFileEditLocks } from "./session-lock.js"
import { resolveHintsCacheVersion } from "../../../src/editor/adapters/cached/index.js"
import { readHintCache, hintCacheFilePath } from "../../../src/editor/adapters/hints-cache/index.js"
import {
  generateHintsRun,
  computeHintCoverage,
  type GenerateHintsRunResult,
  type HintCoverage,
} from "../../../src/editor/hints/generate-hints-run.js"
import { supportsProbeHints } from "../../../src/editor/hints/probe-capability.js"
import { probeComponent, type ProbePage } from "../../../src/editor/hints/probe-driver.js"
import {
  buildComponentFileIndex,
  inferRenderingHintsFromSource,
} from "../../../src/editor/hints/infer-from-source.js"
import { resolveDistExcerpt } from "../../../src/editor/hints/llm-generate-hints.js"
import type { CompletionProvider } from "../../../src/editor/llm-providers/types.js"
import { readJsonBody, sendJson } from "./artifact-http.js"
import { openSseStream, watchClientDisconnect } from "./sse.js"

const ROUTE_PREFIX = "/api/editor/design-systems"
const SHARE_SUFFIX = "/share"
const REFRESH_SUFFIX = "/refresh"
const GENERATE_HINTS_SUFFIX = "/generate-hints"
const UPDATES_ROUTE = `${ROUTE_PREFIX}/updates`

/** Per-process TTL for the `GET …/updates` staleness cache. */
export const STALENESS_CACHE_TTL_MS = 5 * 60 * 1000

/** Snapshot the TTL cache holds: when it was computed + one result per entry id. */
export interface StalenessCache {
  at: number
  results: Record<string, StalenessResult>
}

/**
 * Mutable box the CLI boot sequence creates BEFORE calling `startHttpServer`
 * and writes into AFTER the boot-time reconciliation pass (`core.ts`) — the
 * same pattern as `ReconciliationStatusHolder`. `ctx.getStalenessCache` /
 * `setStalenessCache` read/write `.current`; the boot-time warm-up writes it
 * directly.
 */
export interface StalenessCacheHolder {
  current: StalenessCache | null
}

export function matchesDesignSystemsRoute(pathname: string): boolean {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)
}

export interface DesignSystemsHandlerCtx {
  canonicalRoot: string
  /** Invalidate the memoized grounding service so serving picks up the change. */
  onRegistryChange: () => void
  /**
   * Health of the most recently built manifest bundle, or null when the
   * grounding service hasn't built one yet this session. The GET route
   * surfaces this as-is — it must NEVER force a build just to answer this
   * request.
   */
  getGroundingHealth: () => Promise<GroundingHealth | null>
  /**
   * Current boot-time reconciliation status (Phase 3 attach/refresh) — null
   * before any declarations exist, or before the boot-kicked-off async
   * reconciliation has produced its first snapshot. The GET route surfaces
   * this as-is; it never triggers reconciliation itself.
   */
  getReconciliationStatus: () => ReconcileStatus | null
  /**
   * Phase 3 refresh — read the per-process TTL cache `GET …/updates` serves
   * from. http-server.ts wires this to a small holder object created at CLI
   * boot (the SAME holder the boot-time staleness pass warms — see
   * `core.ts`), so the panel's first GET after boot is already populated.
   * Tests inject an in-memory holder.
   */
  getStalenessCache: () => StalenessCache | null
  /** Write a fresh snapshot into the same holder `getStalenessCache` reads. */
  setStalenessCache: (cache: StalenessCache) => void
  /**
   * Runs one entry's staleness check. Defaults to the real
   * `checkDesignSystemStaleness` in production wiring; tests inject a
   * counting/stubbed fake to assert the TTL cache actually short-circuits
   * repeat network calls.
   */
  checkStaleness: (entry: RegisteredDesignSystem) => Promise<StalenessResult>
  /**
   * Phase 4 Task 3 (probe-derived hints) — resolves the CURRENT manifest
   * source, building it if not yet memoized. Unlike `getGroundingHealth`
   * (read-only, never builds), this MAY trigger a build: it's only ever
   * called from the explicit "Generate hints" action (never a passive GET),
   * so paying for a build here — to enumerate the design system's
   * components to probe — is the right tradeoff.
   */
  getManifestSource: () => Promise<ComponentManifestSource | null>
  /**
   * Creates a fresh, isolated headless-browser `ProbePage` for hint
   * generation (Phase 4 Task 3), or `null` when no launchable browser is
   * available (no system Chrome, no installed Playwright browsers). The
   * CALLER (this handler) owns closing it — ONE page per run, reused across
   * every component in that design system (concurrency 1 — see
   * `generate-hints-run.ts`).
   */
  createProbePage: () => Promise<ProbePage | null>
  /**
   * Origin of the supervised Vite dev server the probe navigates against
   * (Phase 4 Task 3) — the same value `http-server.ts`'s `ctx.viteUrl`
   * carries.
   */
  viteBaseUrl: string
  /**
   * The project's resolved provider for the LLM hint-generation lane
   * (`src/editor/hints/llm-generate-hints.ts`). Wired in production now,
   * not only in tests: `http-server.ts` builds this from the same
   * per-request `resolveLlmConfig` every other non-chat lane uses, so a
   * project that names a provider in `.desde/config.json` reaches this
   * lane too. Absent (older callers/tests) falls back to the registry's
   * own default (`getProvider()`).
   */
  getLlmProvider?: () => CompletionProvider
}

export async function handleDesignSystemsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: DesignSystemsHandlerCtx,
): Promise<void> {
  const root = ctx.canonicalRoot
  const store = createLocalRegistryStore(root)

  try {
    // GET …/suggestions — installed libraries worth onboarding.
    if (req.method === "GET" && pathname === `${ROUTE_PREFIX}/suggestions`) {
      const suggestions = await suggestDesignSystems(root)
      sendJson(res, 200, { ok: true, suggestions })
      return
    }

    // GET …/updates — per-entry staleness (Phase 3 refresh), TTL-cached.
    // Checked before the generic GET list route below since it's a distinct
    // exact path under the same prefix.
    if (req.method === "GET" && pathname === UPDATES_ROUTE) {
      await handleUpdates(req, res, store, ctx)
      return
    }

    // GET … — the registered systems.
    if (req.method === "GET" && pathname === ROUTE_PREFIX) {
      const designSystems = await store.list()
      let health: GroundingHealth | null = null
      try {
        health = await ctx.getGroundingHealth()
      } catch {
        // Diagnostic only — never block the registry listing.
      }

      // Recomputed per request — cheap (one small config read), and the
      // config is the source of truth for "does the user still want this
      // onboarded", which can drift from the registry independent of any
      // boot-time reconciliation pass.
      const { identities: declaredIdentities, declarationsError } = await loadDeclaredIdentities(root)
      const designSystemsWithDeclared = designSystems.map((entry) => ({
        ...entry,
        declared: declaredIdentities.has(registryEntryIdentity(entry)),
        // Phase 4 Task 3: cheap fs read of the hint cache file, if any —
        // never triggers a build (same posture as `health` above). `null`
        // means "hints never generated for this entry."
        hintCoverage: readHintCoverage(root, entry),
      }))

      sendJson(res, 200, {
        ok: true,
        designSystems: designSystemsWithDeclared,
        health,
        reconciliation: ctx.getReconciliationStatus(),
        ...(declarationsError ? { declarationsError } : {}),
      })
      return
    }

    // POST …/:id/share — write a registered entry's source back as a
    // declaration, so it re-onboards on future boots (e.g. after a clone).
    // Checked before the generic DELETE/POST-onboard routes below since it
    // shares the `${ROUTE_PREFIX}/` prefix with both.
    if (req.method === "POST" && pathname.startsWith(`${ROUTE_PREFIX}/`) && pathname.endsWith(SHARE_SUFFIX)) {
      await handleShare(res, root, store, pathname)
      return
    }

    // POST …/:id/refresh — re-onboard a registered entry from its ORIGINAL
    // source (SSE progress, same plumbing as the add route). Checked before
    // DELETE/POST-onboard for the same reason as …/share above.
    if (
      req.method === "POST" &&
      pathname.startsWith(`${ROUTE_PREFIX}/`) &&
      pathname.endsWith(REFRESH_SUFFIX)
    ) {
      await handleRefresh(req, res, root, store, pathname, ctx.onRegistryChange)
      return
    }

    // POST …/:id/generate-hints — probe-derive rendering hints (Phase 4
    // Task 3): mounts each of the entry's components in a headless page,
    // writes ONE hint cache file, refreshes grounding. Checked before
    // DELETE/POST-onboard for the same reason as …/share and …/refresh above.
    if (
      req.method === "POST" &&
      pathname.startsWith(`${ROUTE_PREFIX}/`) &&
      pathname.endsWith(GENERATE_HINTS_SUFFIX)
    ) {
      await handleGenerateHints(req, res, root, store, pathname, ctx)
      return
    }

    // DELETE …/:id — remove a registration.
    if (req.method === "DELETE" && pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      // The id is a registry key (string equality in store.remove), never a
      // filesystem path — a scoped name like `@acme/ui` legitimately contains a
      // slash, so the only invalid case is empty. decodeURIComponent can throw
      // on a malformed `%`-sequence; treat that as a bad id.
      let id: string
      try {
        id = decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/`.length))
      } catch {
        sendJson(res, 400, { ok: false, reason: "Malformed design-system id." })
        return
      }
      if (!id) {
        sendJson(res, 400, { ok: false, reason: "Invalid design-system id." })
        return
      }
      await store.remove(id)
      ctx.onRegistryChange()
      sendJson(res, 200, { ok: true, removed: id })
      return
    }

    // POST … — onboard. Streams SSE progress when the client opts in.
    if (req.method === "POST" && pathname === ROUTE_PREFIX) {
      await handleOnboard(req, res, root, ctx.onRegistryChange)
      return
    }

    sendJson(res, 404, { ok: false, reason: "Unknown design-systems route." })
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: errorMessage(err) })
  }
}

async function handleOnboard(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  onRegistryChange: () => void,
): Promise<void> {
  let body: { source?: unknown; designSystem?: unknown; allowBuild?: unknown }
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: errorMessage(err) })
    return
  }

  const source = parseSource(body.source)
  if (!source) {
    sendJson(res, 400, {
      ok: false,
      reason:
        "Invalid 'source'. Expected { kind:'installed', package } | { kind:'npm', spec } | { kind:'repo', url }.",
    })
    return
  }
  const designSystem =
    typeof body.designSystem === "string" && body.designSystem.trim()
      ? body.designSystem.trim()
      : undefined
  // Editor is local: the repo is the user's own/trusted code on their own
  // machine, so building it to emit types is allowed by default (spec §7).
  // Only an explicit `allowBuild: false` disables it.
  const allowBuild = body.allowBuild !== false

  const onboardRequest: OnboardRequest = { source, prototypeRoot: root, designSystem, allowBuild }
  await runOnboardStream(req, res, onboardRequest, onRegistryChange)
}

/**
 * `POST …/:id/refresh` — the re-onboard half of Phase 3 attach/refresh:
 * given an already-registered entry, re-run the SAME orchestrator against
 * its ORIGINAL `source` (never something a caller supplies) so a mutable npm
 * range or repo ref gets re-resolved to whatever is current. `store.add`
 * replaces by id, so a successful refresh atomically swaps the entry in
 * place — `resolvedCommit`/`version` update via the normal orchestrator path,
 * exactly like a first-time onboard.
 */
async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  store: RegistryStore,
  pathname: string,
  onRegistryChange: () => void,
): Promise<void> {
  const middle = pathname.slice(`${ROUTE_PREFIX}/`.length, pathname.length - REFRESH_SUFFIX.length)
  let id: string
  try {
    id = decodeURIComponent(middle)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Malformed design-system id." })
    return
  }
  if (!id) {
    sendJson(res, 400, { ok: false, reason: "Invalid design-system id." })
    return
  }

  const registered = await store.list()
  const found = registered.find((entry) => entry.id === id)
  if (!found) {
    sendJson(res, 404, { ok: false, reason: `No design system registered with id '${id}'.` })
    return
  }

  let body: { allowBuild?: unknown } = {}
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: errorMessage(err) })
    return
  }
  // Reuse the consent recorded at onboard time (`found.allowBuild`) rather
  // than re-defaulting to true — a repo the user previously said "don't
  // build" for shouldn't silently start building on refresh just because
  // the caller sent an empty body. An explicit `allowBuild` in the body
  // (true OR false) still overrides.
  const allowBuild = typeof body.allowBuild === "boolean" ? body.allowBuild : (found.allowBuild ?? true)

  const onboardRequest: OnboardRequest = {
    source: found.source,
    prototypeRoot: root,
    designSystem: found.designSystem,
    allowBuild,
  }
  await runOnboardStream(req, res, onboardRequest, onRegistryChange)
}

/**
 * Shared SSE-progress plumbing for both `POST …` (add) and `POST …/:id/refresh`
 * — same non-stream/stream branching, same `progress`/`result`/`error` frame
 * shapes. Refactored out (Phase 3 refresh) so the two routes can't drift.
 */
async function runOnboardStream(
  req: IncomingMessage,
  res: ServerResponse,
  onboardRequest: OnboardRequest,
  onRegistryChange: () => void,
): Promise<void> {
  const deps = await createDefaultOnboardDeps(onboardRequest.prototypeRoot)

  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream")
  if (!wantsStream) {
    try {
      const result = await onboardDesignSystem(onboardRequest, deps)
      onRegistryChange()
      sendJson(res, 200, { ok: true, result })
    } catch (err) {
      sendJson(res, 422, { ok: false, reason: errorMessage(err) })
    }
    return
  }

  const stream = openSseStream(req, res)
  try {
    const result = await onboardDesignSystem(onboardRequest, deps, (stage) =>
      stream.send({ type: "progress", stage }),
    )
    onRegistryChange()
    stream.send({ type: "result", result })
  } catch (err) {
    stream.send({ type: "error", message: errorMessage(err) })
  } finally {
    stream.close()
  }
}

/**
 * The identity fingerprint a cached {@link StalenessResult} is good for:
 * `resolvedCommit` for repo entries, `version` for npm entries — exactly the
 * value `staleness.ts` compares against the remote and echoes back as
 * `StalenessResult.current`. Installed entries are always `'fresh'`
 * regardless of version (`staleness.ts`), so they have no fingerprint;
 * `undefined` deliberately matches `undefined` there.
 *
 * Used to make the `…/updates` cache content-aware: `POST …/:id/refresh`
 * replaces a registry entry IN PLACE (same `id`, new `version`/
 * `resolvedCommit`), so an id-only coverage check would keep serving a
 * verdict computed against the OLD content for up to `STALENESS_CACHE_TTL_MS`
 * after a successful refresh.
 */
function stalenessFingerprint(entry: RegisteredDesignSystem): string | undefined {
  if (entry.source.kind === "repo") return entry.resolvedCommit
  if (entry.source.kind === "npm") return entry.version
  return undefined
}

/**
 * `GET …/updates` — per-entry staleness (Phase 3 refresh). Runs every
 * registered entry's check CONCURRENTLY (independent network calls) and
 * caches the combined result for `STALENESS_CACHE_TTL_MS` (per-process,
 * hand-rolled `{ at, results }` — no new deps). `?force=1` bypasses the
 * cache. The cache holder is shared with the boot-time warm-up (`core.ts`)
 * via `ctx.getStalenessCache`/`setStalenessCache`, so the panel's first GET
 * after boot is often already warm.
 *
 * The cache is only a hit when it covers EVERY currently-registered entry
 * WITH MATCHING CONTENT: an id missing from `cached.results` (a design
 * system added since the cache was written) OR whose cached result's
 * `current` fingerprint no longer matches the entry's live
 * `resolvedCommit`/`version` (a completed refresh swapped the entry in
 * place) is treated as a miss and recomputes the whole batch, rather than
 * silently serving a stale verdict until the TTL expires.
 */
async function handleUpdates(
  req: IncomingMessage,
  res: ServerResponse,
  store: RegistryStore,
  ctx: DesignSystemsHandlerCtx,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const force = url.searchParams.get("force") === "1"

  const entries = await store.list()

  if (!force) {
    const cached = ctx.getStalenessCache()
    const coversEveryEntry =
      cached !== null &&
      entries.every((entry) => {
        const r = cached.results[entry.id]
        return r !== undefined && r.current === stalenessFingerprint(entry)
      })
    if (cached && coversEveryEntry && Date.now() - cached.at < STALENESS_CACHE_TTL_MS) {
      sendJson(res, 200, { ok: true, updates: cached.results })
      return
    }
  }

  const checked = await Promise.all(entries.map((entry) => ctx.checkStaleness(entry)))
  const results: Record<string, StalenessResult> = {}
  for (const r of checked) results[r.id] = r

  ctx.setStalenessCache({ at: Date.now(), results })
  sendJson(res, 200, { ok: true, updates: results })
}

/**
 * The set of declaration identities currently on disk, plus a joined error
 * string when the config is malformed. A malformed config (loader `ok:false`)
 * degrades `identities` to an empty set rather than failing the GET — the
 * loud-at-boot posture belongs to session start (`core.ts`'s `loadReadRoots`
 * precedent), not a read-only status recompute — but the error is still
 * surfaced via `declarationsError` so a config broken AFTER boot (when the
 * boot-time log already fired and won't fire again) doesn't go silent: every
 * subsequent GET would otherwise report `declared: false` everywhere with no
 * indication why.
 */
async function loadDeclaredIdentities(
  root: string,
): Promise<{ identities: Set<string>; declarationsError?: string }> {
  const result = await loadDesignSystemDeclarations(root)
  if (!result.ok) return { identities: new Set(), declarationsError: result.errors.join("\n") }
  return { identities: new Set(result.declarations.map((decl) => declarationIdentity(decl.source))) }
}

/**
 * Cheap fs-read coverage summary for one registered entry — the GET route's
 * per-entry `hintCoverage` field (Phase 4 Task 3). Never triggers a build or
 * a probe; reads the hint cache file if one exists, else `null` ("hints
 * never generated for this entry" — distinct from an all-zero coverage,
 * which would mean a run happened but found nothing to probe).
 *
 * Uses `resolveHintsCacheVersion` — the SAME live-version rule the writer
 * (`runGenerateHintsFor`, below) and the manifest-serving reader
 * (`build-manifest-source.ts`) both apply — rather than the registry's
 * onboard-time `entry.version` snapshot. Reading under the stale version
 * would report `null` coverage forever once the user `npm install`s an
 * upgrade without hitting the explicit `/refresh` route, even though the
 * hint file the LAST generate-hints run actually wrote (keyed by the live
 * version) is sitting right there on disk.
 */
function readHintCoverage(root: string, entry: RegisteredDesignSystem): HintCoverage | null {
  const packageVersion = resolveHintsCacheVersion(resolve(root), entry)
  // Through the `.desde` guard: a linked-away `.desde` has no coverage to
  // report, rather than coverage read from outside the working tree.
  const cacheDir = desdePathOrNull(root, "manifests")
  if (cacheDir === null) return null
  const file = hintCacheFilePath(cacheDir, entry.package, packageVersion)
  const cache = readHintCache(file)
  if (!cache) return null
  return computeHintCoverage(cache.hints)
}

/**
 * Note surfaced on the generate-hints response (JSON `result` sibling field,
 * and the SSE `result` frame) when the run took the Task 4 inference-only
 * path — see {@link isRepoIngestedEntry}.
 */
const INFERENCE_ONLY_NOTE =
  "inference only: package not installed, probe verification unavailable"

/**
 * Whether a registered entry is eligible for the Task 4 source-inference
 * lane: an ingested (non-`node_modules`) package whose ORIGINAL source was a
 * git repo clone. An `npm`-ingested entry ALSO carries a `packageRoot` (its
 * scratch install also lives outside `node_modules`), but that ingest only
 * ever materializes the shipped `.d.ts` needed for type extraction — the
 * npm tarball's component SOURCE files (`.vue`/`.tsx`) generally aren't even
 * present, and even when they are there's no reason to trust a scratch
 * install's source layout — so `npm`-kind entries stay 422 exactly as they
 * did before this task (see `handleGenerateHints`). A `repo`-kind ingest
 * keeps its clone around after extraction (`src/editor/ingest/git-repo.ts`),
 * which is what `infer-from-source.ts` reads from.
 */
function isRepoIngestedEntry(entry: RegisteredDesignSystem): boolean {
  return !!entry.packageRoot && entry.source.kind === "repo"
}

/**
 * Resolve a repo-ingested entry's `packageRoot` to an absolute directory,
 * containment-checked to fall INSIDE `<root>/.desde/ingested` — not
 * merely inside the prototype root (the looser check
 * `build-registered-sources.ts` uses for arbitrary registered packages).
 * The source-inference lane only ever reads from what the ingest pipeline
 * itself wrote there; a hand-edited entry whose `packageRoot` points
 * somewhere else (even somewhere else inside the prototype) gets `null`
 * rather than an inference walk over arbitrary prototype files. Returns
 * `null` for a missing/escaping `packageRoot` — the caller degrades to "no
 * inference for this run" rather than throwing.
 */
function resolveIngestedSourceRoot(root: string, entry: RegisteredDesignSystem): string | null {
  if (!entry.packageRoot) return null
  const realRoot = resolve(root)
  // Through the `.desde` guard: on a repo whose `.desde` is a symlink there
  // is no containment to check, so the entry resolves to nothing rather than
  // to a directory outside the working tree.
  let ingestedRoot: string
  try {
    ingestedRoot = desdePath(realRoot, "ingested")
  } catch {
    return null
  }
  const resolved = resolve(realRoot, entry.packageRoot)
  if (resolved !== ingestedRoot && !resolved.startsWith(ingestedRoot + sep)) return null
  return resolved
}

/**
 * Resolve the package root the Phase 4 Task 5 LLM lane reads its best-effort
 * dist-source excerpt from: `entry.packageRoot` when the entry overrides it
 * (an ingested npm/repo package — same field `resolveIngestedSourceRoot`
 * reads, but containment-checked only against the PROTOTYPE root here, not
 * specifically `.desde/ingested`, since an installed entry's default
 * `node_modules/<package>` also needs to pass), else the standard
 * `node_modules/<package>` layout. Returns `null` (never throws) when a
 * hand-edited `packageRoot` escapes the prototype root — the caller
 * degrades to "no dist excerpt for this run" rather than reading arbitrary
 * filesystem paths.
 */
function resolvePackageRootForDist(root: string, entry: RegisteredDesignSystem): string | null {
  const realRoot = resolve(root)
  if (!entry.packageRoot) return join(realRoot, "node_modules", entry.package)
  const resolved = resolve(realRoot, entry.packageRoot)
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) return null
  return resolved
}

/**
 * `POST …/:id/generate-hints` — Phase 4: probe-derive rendering hints for a
 * registered design system's components (Task 3: a headless-browser mount
 * per component, sentinel props/slot, observe where they land), OR, for a
 * `repo`-ingested entry (Task 4), infer hints directly from the retained
 * clone's source instead — probing is never attempted for those, since
 * Vite can't `import` a package that isn't under `node_modules` by bare
 * specifier (V1 bound — see
 * `docs/superpowers/plans/2026-07-26-grounding-phase4-rendering-hints.md`).
 * Never runs automatically — this is the ONLY trigger for either lane.
 *
 * Guards: 404 unknown id; 422 for an entry whose framework can't produce
 * probe-derived hints at all (see {@link supportsProbeHints} —
 * `src/editor/hints/probe-capability.ts`, today Vue-only; the SAME check
 * the client uses to decide whether to offer this action, so a stale
 * client/hand-built request can't reach a run that only ever reports
 * zeros); 422 for an entry whose package has NO usable source for either
 * lane — an `npm`-ingested (or otherwise non-`repo`) `packageRoot` entry
 * (see {@link isRepoIngestedEntry}).
 *
 * A `repo`-ingested run's response carries an extra `note` field
 * ({@link INFERENCE_ONLY_NOTE}) alongside `result`, making the degraded
 * (unverified-only) nature of that run's hints explicit to the caller
 * rather than silently returning the SAME shape a full probe run would.
 *
 * Streams the SAME progress/result/error SSE shape as onboard/refresh when
 * the client asks for it (`runOnboardStream`'s sibling, not a shared
 * function — the payload shapes differ: `GenerateHintsProgress` objects vs.
 * `OnboardStage` strings).
 */
async function handleGenerateHints(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  store: RegistryStore,
  pathname: string,
  ctx: DesignSystemsHandlerCtx,
): Promise<void> {
  const middle = pathname.slice(
    `${ROUTE_PREFIX}/`.length,
    pathname.length - GENERATE_HINTS_SUFFIX.length,
  )
  let id: string
  try {
    id = decodeURIComponent(middle)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Malformed design-system id." })
    return
  }
  if (!id) {
    sendJson(res, 400, { ok: false, reason: "Invalid design-system id." })
    return
  }

  const registered = await store.list()
  const found = registered.find((entry) => entry.id === id)
  if (!found) {
    sendJson(res, 404, { ok: false, reason: `No design system registered with id '${id}'.` })
    return
  }

  // Refuse rather than run and report zeros. Probing mounts the component
  // in an isolation page that only ever renders Vue (see
  // `src/editor/hints/probe-capability.ts` for both reasons why, and why
  // this is the SAME check `design-systems-panel.tsx` uses to decide
  // whether to offer the button at all — both ends must agree, per
  // CLAUDE.md's "lanes" gating rule, or a stale client gets a control that
  // fails on click). Without this guard a React entry silently produced
  // `probed: 0, hinted: 0, verified: 0` — or, with the opt-in LLM checkbox
  // on, a hint file stamped `verified: false` that the attribution trust
  // gate (`isTrustedHint`) always rejects — a dead control reporting a
  // misleading success number.
  if (!supportsProbeHints(found.framework)) {
    sendJson(res, 422, {
      ok: false,
      reason:
        `Rendering-hint generation is Vue-only today; "${found.framework}" isn't supported yet. ` +
        "Probing mounts each component in an isolation page whose mount script only knows how " +
        "to render Vue, and that page isn't even served for a non-Vue host. See " +
        "src/editor/hints/probe-capability.ts for the full reason and what unblocks it.",
    })
    return
  }

  const repoIngested = isRepoIngestedEntry(found)
  if (found.packageRoot && !repoIngested) {
    sendJson(res, 422, {
      ok: false,
      reason:
        "package not installed in the prototype; probing supports installed packages only (V1)",
    })
    return
  }

  // Phase 4 Task 5 — opt-in LLM lane. Read from the JSON body (empty body
  // ⇒ `{}` ⇒ `useLlm` stays falsy, so pre-Task-5 callers that POST with no
  // body at all keep the old probe/inference-only behavior unchanged).
  let body: { useLlm?: unknown } = {}
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: errorMessage(err) })
    return
  }
  const useLlm = body.useLlm === true

  // Thread an AbortSignal that fires on client disconnect through to the
  // LLM lane — a client that navigates away mid-run shouldn't keep paying
  // for in-flight LLM calls it'll never see the result of. `req.on('close')`
  // is NOT a reliable disconnect signal here: it can fire as soon as the
  // request body finishes being read (see `readJsonBody` above), well
  // before the response — SSE or not — is actually done, so it does not
  // represent the client connection's lifetime. `watchClientDisconnect`
  // (mirrors `openSseStream`'s own client-disconnect detection) watches the
  // RESPONSE/socket lifecycle instead. Disposed as soon as the run settles,
  // before this handler's own response completion (`sendJson` /
  // `stream.close()`) — so a normal finish is never misread as a
  // disconnect.
  const disconnect = watchClientDisconnect(req, res)

  const wantsStream = (req.headers.accept ?? "").includes("text/event-stream")

  const run = (
    onProgress?: (progress: { component: string; index: number; total: number }) => void,
  ): Promise<GenerateHintsRunResult> =>
    runGenerateHintsFor(found, root, ctx, onProgress, useLlm, disconnect.signal)

  const extra = repoIngested ? { note: INFERENCE_ONLY_NOTE } : {}

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
    ctx.onRegistryChange()
    sendJson(res, 200, { ok: true, result, ...extra })
    return
  }

  const stream = openSseStream(req, res)
  try {
    const result = await run((progress) => stream.send({ type: "progress", progress }))
    disconnect.dispose()
    ctx.onRegistryChange()
    stream.send({ type: "result", result, ...extra })
  } catch (err) {
    disconnect.dispose()
    stream.send({ type: "error", message: errorMessage(err) })
  } finally {
    stream.close()
  }
}

/**
 * Wires the pure `generateHintsRun` engine to this request's ctx: enumerates
 * the entry's own components via {@link enumerateOwnPackageComponents} (the
 * package's OWN manifest source, not the deduped composite catalog — see
 * that function's doc comment) and, as defense in depth, `generateHintsRun`
 * itself still filters to `entry.designSystem` AND `entry.importPath` (see
 * its own doc comment on the cross-package contamination guard). `found.package`
 * plus the LIVE resolved version (`resolveHintsCacheVersion` —
 * `adapters/cached`, the SAME rule `build-manifest-source.ts`'s reader
 * applies) become the written `HintCacheFile`'s identity — the SAME pair
 * `hintCacheFilePath` keys manifest serving's lookup with, so a successful
 * run is picked up by the very next `getComponent` call after
 * `ctx.onRegistryChange()` invalidates the memoized grounding service. Using
 * `entry.version` (the onboard-time snapshot) here instead would write under
 * a key the reader never looks under once the package has been `npm
 * install`-upgraded without an explicit `/refresh`.
 *
 * Branches on {@link isRepoIngestedEntry} (Task 4):
 *   - `repo`-ingested: NO probe page is opened (V1 never attempts to mount
 *     these — see `handleGenerateHints`'s doc comment). When the entry's
 *     `packageRoot` resolves cleanly (`resolveIngestedSourceRoot`), an
 *     `inferHints` closure walks the retained clone's source ONCE
 *     (`buildComponentFileIndex`) and looks up each component against it.
 *     When it doesn't resolve (a hand-edited/escaping `packageRoot`), the
 *     run still proceeds with neither `probe` nor `inferHints` — every
 *     component ends up in `skipped`, rather than throwing and failing the
 *     whole request over one bad field.
 *   - otherwise (installed, no `packageRoot`): Task 3's probe path,
 *     unchanged — opens ONE probe page for the whole run (closed in
 *     `finally` regardless of outcome, per `generate-hints-run.ts`'s
 *     concurrency-1 contract) and points `probeComponent` at the supervised
 *     Vite server.
 *
 * `useLlm`/`signal` (Phase 4 Task 5) thread straight through to
 * `generateHintsRun`'s own `useLlm`/`llm` options in BOTH branches — the
 * LLM lane only ever engages for components that end up with zero hints
 * from whichever of probe/inference this entry is eligible for, so there's
 * no need to special-case it here beyond supplying `resolveDistExcerpt`
 * (this handler owns the package-root → filesystem resolution;
 * `generate-hints-run.ts` has no filesystem opinion of its own).
 */
async function runGenerateHintsFor(
  entry: RegisteredDesignSystem,
  root: string,
  ctx: DesignSystemsHandlerCtx,
  onProgress?: (progress: { component: string; index: number; total: number }) => void,
  useLlm?: boolean,
  signal?: AbortSignal,
): Promise<GenerateHintsRunResult> {
  const components = await enumerateOwnPackageComponents(entry, root, ctx)

  const runEntry = {
    packageName: entry.package,
    packageVersion: resolveHintsCacheVersion(resolve(root), entry),
    designSystem: entry.designSystem,
    importPath: entry.importPath,
  }
  // Throws `DesdeDirSymlinkError` on a repo whose `.desde` is a symbolic
  // link, which this route reports like any other run failure. A generate
  // run WRITES the hint cache, so skipping quietly would report success
  // with nothing written.
  const cacheDir = desdePath(root, "manifests")

  const packageRootForDist = resolvePackageRootForDist(root, entry)
  const llm = useLlm
    ? {
        signal,
        provider: ctx.getLlmProvider?.(),
        ...(packageRootForDist
          ? { resolveDistExcerpt: (m: ComponentManifest) => resolveDistExcerpt(packageRootForDist, m.name) }
          : {}),
      }
    : undefined

  if (isRepoIngestedEntry(entry)) {
    const sourceRoot = resolveIngestedSourceRoot(root, entry)
    const fileIndex = sourceRoot ? buildComponentFileIndex(sourceRoot) : null
    return generateHintsRun({
      entry: runEntry,
      cacheDir,
      components,
      // No `probe` — repo-ingested packages are never mounted in V1.
      inferHints: fileIndex
        ? (manifest) => inferRenderingHintsFromSource(manifest, fileIndex)
        : undefined,
      onProgress,
      useLlm,
      llm,
    })
  }

  const page = await ctx.createProbePage()
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
      probe: (spec) => probeComponent({ baseUrl: ctx.viteBaseUrl, spec, page }),
      onProgress,
      useLlm,
      llm,
    })
  } finally {
    await page.close()
  }
}

/**
 * Enumerate the target design system's components from ITS OWN manifest
 * source — NOT `ctx.getManifestSource()`'s deduped composite catalog (fix
 * for a P2 finding, 2026-07-29). `CompositeManifestSource.listComponents()`
 * merges every registered/auto-scanned source first-source-wins BY
 * COMPONENT NAME (see `src/editor/adapters/composite/index.ts`): when two
 * registered packages both export a component with the same name (e.g. two
 * libraries each shipping a "Button"), the composite's list silently drops
 * the LATER package's same-named component entirely. `generateHintsRun`
 * itself filters the components handed to it down to `entry.designSystem`
 * (+ `entry.importPath`), but that filter runs AFTER the name-based dedupe
 * already happened — so the later package's run could see zero targets and
 * write an empty/incomplete hint cache with no error surfaced.
 *
 * `createDefaultOnboardDeps(root).buildSource` is the SAME per-entry source
 * builder onboarding uses to compute a freshly-onboarded entry's coverage
 * (`src/editor/onboarding/orchestrator.ts`'s `onboardDesignSystem` →
 * `deps.buildSource`, itself a thin wrapper over
 * `buildRegisteredSources({ registry: [entry], ... })`) — reusing it here
 * guarantees this run always enumerates exactly THIS package's own
 * components, never another package's same-named ones, regardless of what
 * else is registered.
 *
 * Falls back to `ctx.getManifestSource()`'s composite only when the
 * dedicated per-package source can't be built at all (e.g. no tsconfig
 * resolvable under `root`, or the package no longer resolves on disk) — the
 * same degrade-gracefully posture the rest of this route already uses. A
 * properly registered, still-installed entry always builds successfully via
 * the primary path, so this fallback never re-introduces the dedupe bug for
 * a real collision; it only preserves the prior "manifest source
 * unavailable" behavior for the genuinely-broken case (also what the
 * existing unit tests exercise via the `getManifestSource` ctx seam — they
 * run against a bare tmpdir with no real installed package, so the
 * per-package build always returns null there and this falls through to the
 * test's fake).
 */
async function enumerateOwnPackageComponents(
  entry: RegisteredDesignSystem,
  root: string,
  ctx: DesignSystemsHandlerCtx,
): Promise<ComponentManifest[]> {
  const onboardDeps = await createDefaultOnboardDeps(root)
  const tsconfigPath = (await onboardDeps.resolveTsconfig(root)) ?? ""
  const packageSource = onboardDeps.buildSource(entry, root, tsconfigPath)
  if (packageSource) {
    return packageSource.listComponents()
  }

  const manifestSource = await ctx.getManifestSource()
  if (!manifestSource) {
    throw new Error("Manifest source unavailable. Cannot enumerate components to probe.")
  }
  return manifestSource.listComponents()
}

/**
 * `POST …/:id/share` — the inverse of onboarding: given an already-registered
 * design system, persist its `source` as a `designSystems` declaration so a
 * future boot (fresh clone, teammate's checkout) re-onboards it automatically
 * via reconciliation. Mirrors the DELETE route's id-decoding: everything
 * between the route prefix and the trailing `/share` is the id, matched
 * suffix-first because scoped package ids (`@acme/ui`) legitimately contain
 * `/` themselves.
 */
async function handleShare(
  res: ServerResponse,
  root: string,
  store: RegistryStore,
  pathname: string,
): Promise<void> {
  const middle = pathname.slice(`${ROUTE_PREFIX}/`.length, pathname.length - SHARE_SUFFIX.length)
  let id: string
  try {
    id = decodeURIComponent(middle)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Malformed design-system id." })
    return
  }
  if (!id) {
    sendJson(res, 400, { ok: false, reason: "Invalid design-system id." })
    return
  }

  const registered = await store.list()
  const found = registered.find((entry) => entry.id === id)
  if (!found) {
    sendJson(res, 404, { ok: false, reason: `No design system registered with id '${id}'.` })
    return
  }

  const declaration: DesignSystemDeclaration = {
    source: found.source,
    // Only carry the label when it's a genuine override — the default
    // downstream is the package name, so writing it unconditionally would
    // just be noise in the hand-authored config.
    ...(found.designSystem !== found.package ? { designSystem: found.designSystem } : {}),
    // Carry recorded build consent through VERBATIM, including an explicit
    // `false`. Writing it out is still correct after the 2026-08-09 security
    // fix, but the reason inverted: boot reconciliation now defaults an ABSENT
    // `allowBuild` to `false` (`reconcile.ts`, audit S13 — automatic
    // materialization must not execute code named by the opened repo's own
    // config). So an omitted field no longer silently GRANTS build consent;
    // it silently WITHHOLDS it. Round-tripping the recorded value verbatim is
    // what keeps a shared entry behaving the same on a teammate's fresh boot
    // in both directions.
    ...(found.allowBuild !== undefined ? { allowBuild: found.allowBuild } : {}),
  }

  // Task 7c (final audit-fixes wave): serialize the read-modify-write of
  // desde.config.json under the same per-file edit lock the
  // rest of the CLI uses, so a concurrent share/onboard racing on this file
  // can't clobber the other's declaration.
  const result = await withFileEditLocks(root, [CONFIG_FILENAME], () =>
    appendDesignSystemDeclaration(root, declaration),
  )
  if (!result.ok) {
    // The only realistic failure for a source that came straight off the
    // registry is the identity-dedupe check (already declared) — surface it
    // as a conflict rather than a generic error.
    sendJson(res, 409, { ok: false, reason: result.reason })
    return
  }

  sendJson(res, 200, { ok: true, declared: true })
}

/** Validate the request `source` into a typed {@link DesignSystemSource}. */
function parseSource(value: unknown): DesignSystemSource | null {
  if (!value || typeof value !== "object") return null
  const s = value as Record<string, unknown>
  if (s.kind === "installed" && typeof s.package === "string" && s.package.trim()) {
    return { kind: "installed", package: s.package.trim() }
  }
  if (s.kind === "npm" && typeof s.spec === "string" && s.spec.trim()) {
    return { kind: "npm", spec: s.spec.trim() }
  }
  if (s.kind === "repo" && typeof s.url === "string" && s.url.trim()) {
    return {
      kind: "repo",
      url: s.url.trim(),
      ...(typeof s.ref === "string" ? { ref: s.ref } : {}),
      ...(typeof s.subdir === "string" ? { subdir: s.subdir } : {}),
    }
  }
  return null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

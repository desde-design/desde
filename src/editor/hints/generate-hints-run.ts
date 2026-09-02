/**
 * Per-design-system generate-hints run — Phase 4 "rendering hints at scale"
 * (Task 3). Enumerates a design system's known components, probes each in
 * turn (concurrency 1: ONE `ProbePage`, sequential mounts — see
 * `probe-driver.ts`'s module doc comment on why lifecycle stays out of that
 * layer), collects the results, and writes ONE `HintCacheFile` for the
 * package at the end.
 *
 * This is the explicit, user-triggered action the Phase 4 plan requires —
 * hint generation NEVER runs automatically at boot or on any passive read.
 * The caller (`editor-cli/src/server/design-systems-handler.ts`) wires a
 * REAL `ProbeFn` (closed over `probeComponent` + a live `ProbePage`) and a
 * REAL component catalog (the grounding service's manifest source); this
 * module's own dependencies are plain parameters, so it is unit-testable
 * with fakes for both (see `generate-hints-run.test.ts`).
 *
 * ── Per-component failure isolation ──
 *
 * A component that fails to mount (or whose derivation throws) is SKIPPED,
 * counted in `skipped`, and the run continues — never fatal. A component
 * that mounts successfully is recorded in the written file's `hints` map
 * EVEN WHEN it produced zero hints (an empty array) — see
 * {@link computeHintCoverage}'s doc comment for why that's load-bearing for
 * the panel's coverage line.
 *
 * A SKIPPED component's PRIOR hint-cache entry (from an earlier successful
 * run) is carried forward into this run's written file unchanged — see the
 * carry-forward comment in the write step near the bottom of
 * {@link generateHintsRun} for the full rule and why it doesn't fight the
 * round-5 "never write an empty file over a real one" guard.
 *
 * ── Source inference (Task 4) ──
 *
 * `opts.probe` is now OPTIONAL: a repo-ingested design system's package
 * isn't resolvable by Vite's bare-specifier import from the prototype (V1
 * bound — see `editor-cli/src/server/design-systems-handler.ts`'s
 * `generate-hints` route doc comment), so the caller omits `probe` entirely
 * for those entries rather than attempting (and always failing) a mount.
 * `opts.inferHints` (`./infer-from-source.ts`) is the alternative lane for
 * exactly that case: it reads the component's SOURCE FILE directly (only
 * available for a `repo`-kind ingest, which keeps the clone around) instead
 * of mounting it. Both lanes are attempted independently for every targeted
 * component — a component can be probed, inferred, both, or neither:
 *
 *   - Both succeed: {@link mergeRenderingHints} combines them, preferring the
 *     probe-derived hint on any site collision (it's `verified: true` by
 *     construction — the probe already confirmed exactly what the inferred
 *     hint only guessed at from source).
 *   - Probe succeeds, inference doesn't apply (installed package, no
 *     source): unchanged from Task 3's behavior.
 *   - Probe fails/unavailable, inference succeeds: the component still gets
 *     an entry in the written `hints` map (unverified) — NOT dropped, per
 *     the Task 4 brief: unmountable components used to be skipped with no
 *     trace in the file; now their inferred hints are written and stay
 *     visible for the panel/coverage line, even though `verified: false`
 *     keeps them out of the deterministic attribution lane
 *     (`isTrustedHint` in `src/editor/attribution/attribute.ts`). Such a
 *     component is still recorded in `skipped` (it was never PROBED — the
 *     unverified status is exactly why) — `skipped` and "has a hints-map
 *     entry" are independent now, not mutually exclusive.
 *   - Neither succeeds: skipped exactly as in Task 3.
 */

import { randomBytes } from 'node:crypto'
import type { ComponentManifest, DesignSystemId, RenderingHint } from '../core/manifest'
import type { CompletionProvider } from '../llm-providers/types'
import {
  HINTS_SCHEMA_VERSION,
  hintCacheFilePath,
  readHintCache,
  writeHintCache,
  type HintCacheFile,
} from '../adapters/hints-cache'
import { deriveHintsForComponent, dropCollidingHints, type ProbeFn } from './derive-hints'
import type { InferFromSourceOutcome } from './infer-from-source'
import { runLlmHintsLane } from './llm-generate-hints'

/** Identity of the package a run targets — the subset of `RegisteredDesignSystem` the engine needs. */
export interface GenerateHintsRunEntry {
  packageName: string
  packageVersion: string
  designSystem: DesignSystemId
  /**
   * The package's module specifier (`RegisteredDesignSystem.importPath`) —
   * used to disambiguate the target filter below when two DIFFERENT
   * packages are registered under the SAME `designSystem` label (e.g. a
   * re-stamped `PACKAGE_OVERRIDES.designSystem`). Optional for backward
   * compatibility with callers/tests that only ever target one package per
   * label; when present, the filter requires an exact match and excludes
   * any candidate component with a missing or different `importPath`.
   */
  importPath?: string
}

export interface GenerateHintsProgress {
  /** 0-based index of the component currently being probed. */
  index: number
  total: number
  component: string
}

export interface GenerateHintsSkip {
  name: string
  reason: string
}

/** Run summary — per the task-3 brief's exact shape. */
export interface GenerateHintsRunResult {
  /** Components successfully mounted (whether or not any sentinel matched). */
  probed: number
  /** Of those probed, how many produced ≥1 hint. */
  hinted: number
  /** Of the hinted components, how many have EVERY hint verified (always true in V1 — see doc comment on `deriveHintsForComponent`). */
  verified: number
  skipped: GenerateHintsSkip[]
  /**
   * Whether this run actually wrote the on-disk `HintCacheFile`. `false`
   * means every existing hint file for this package (if any) was left
   * completely untouched — the run produced zero hints across every
   * targeted component (isolation route unavailable, Vite not serving the
   * mount, every mount failing, an entry with no `probe`/`inferHints` lane
   * applicable, etc.). This mirrors the guard in
   * `src/editor/adapters/cached/index.ts` ("Don't freeze a transient
   * empty extraction; let the next boot retry.") applied to hint files: a
   * transient failure must never silently delete previously-verified hints
   * by overwriting the file with an empty one.
   */
  wroteCache: boolean
  /**
   * Set whenever `wroteCache` is `false`, so callers (the SSE result the
   * design-systems panel renders) can surface WHY nothing changed instead of
   * silently reporting success with no visible effect.
   */
  note?: string
  /**
   * Count of components whose PRIOR hint-cache entry was carried forward
   * unchanged into the written file because this run never evaluated them
   * (codex P2 fix, 2026-07-29 — see the write-step doc comment below for the
   * full carry-forward rule). `0` whenever nothing was carried forward,
   * including whenever `wroteCache` is `false` (no write happened at all).
   */
  carriedForward: number
}

/** A source-inference function, fully decoupled from filesystem-walk concerns — see module doc comment and `./infer-from-source.ts`. */
export type InferHintsFn = (manifest: ComponentManifest) => Promise<InferFromSourceOutcome>

export interface GenerateHintsRunOptions {
  entry: GenerateHintsRunEntry
  /** Directory hint cache files live under (typically `.desde/manifests`). */
  cacheDir: string
  /**
   * The FULL catalog (every design system, as `CompositeManifestSource.
   * listComponents()` returns it) — this run filters to `entry.designSystem`
   * (AND `entry.importPath`, when supplied — see `GenerateHintsRunEntry`'s
   * doc comment) itself, so callers don't need to pre-filter.
   */
  components: ComponentManifest[]
  /**
   * Mounts a component in a live browser and reports where its sentinel
   * values surfaced (Task 3). OPTIONAL as of Task 4 — see the module doc
   * comment's "Source inference" section for when the caller omits it.
   */
  probe?: ProbeFn
  /**
   * Source-inference lane (Task 4, `./infer-from-source.ts`) — attempted for
   * EVERY targeted component, independent of `probe`'s presence or success.
   * Absent ⇒ the run behaves exactly as it did in Task 3 (probe-only).
   */
  inferHints?: InferHintsFn
  onProgress?: (progress: GenerateHintsProgress) => void
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  now?: () => Date
  /**
   * Shared across every component probed in this run (see `derive-hints.ts`'s
   * sentinel-naming doc comment). Injectable for deterministic tests;
   * defaults to a fresh random hex string per run.
   */
  sentinelSuffix?: string
  /**
   * Phase 4 Task 5 — opt-in gate for the LLM one-shot hint-generation lane
   * (`./llm-generate-hints.ts`). Defaults to `false`: the run behaves
   * exactly as it did before Task 5 (probe + inference only). When `true`,
   * runs LAST, and ONLY for components that ended this run with ZERO hints
   * from probe+inference — never re-attempted for a component that already
   * has ≥1 hint from either earlier lane. Costs a real LLM call per
   * targeted component, which is why it's never on by default.
   */
  useLlm?: boolean
  /** Knobs for the LLM lane. Ignored when `useLlm` is falsy. */
  llm?: {
    /** Injected for tests; defaults to the registry's default provider. */
    provider?: CompletionProvider
    /** Defaults to `provider.defaultModel` — never hardcode a model id. */
    model?: string
    /** Default 100 — components beyond the cap are skipped with reason 'llm budget'. */
    maxComponents?: number
    /** Default 4 — bounds concurrent LLM calls. */
    maxConcurrency?: number
    /**
     * Best-effort resolver for a component's compiled dist source (up to
     * 8KB, handed to the model as grounding context) — see
     * `./llm-generate-hints.ts`'s `resolveDistExcerpt`. The caller
     * (`design-systems-handler.ts`) closes over the package's resolved
     * root; this module has no filesystem opinion about where packages
     * live.
     */
    resolveDistExcerpt?: (manifest: ComponentManifest) => string | undefined
    signal?: AbortSignal
  }
}

export async function generateHintsRun(
  opts: GenerateHintsRunOptions,
): Promise<GenerateHintsRunResult> {
  const suffix = opts.sentinelSuffix ?? randomBytes(4).toString('hex')
  // Cross-package contamination guard: `designSystem` alone isn't a unique
  // package identity — two packages registered under the SAME label (e.g. a
  // re-stamped `PACKAGE_OVERRIDES.designSystem`) would otherwise have this
  // run probe the OTHER package's components too, writing hints for them
  // into THIS package's hint file (which the overlay guard's
  // designSystem-only match would then graft back onto the wrong
  // component). When the entry carries an `importPath`, also require the
  // candidate manifest's `importPath` to match it exactly — a missing or
  // different `importPath` excludes the component. `opts.entry.importPath`
  // is optional only so existing single-package-per-label callers/tests
  // don't have to supply it; the real caller
  // (`design-systems-handler.ts`) always does.
  const targets = opts.components.filter((c) => {
    if (c.designSystem !== opts.entry.designSystem) return false
    if (opts.entry.importPath !== undefined) return c.importPath === opts.entry.importPath
    return true
  })
  const total = targets.length

  const hints: Record<string, RenderingHint[]> = {}
  const skipped: GenerateHintsSkip[] = []
  let probed = 0
  let hinted = 0
  let verified = 0

  // Phase 4 Task 5: components that end this loop with ZERO hints from
  // probe+inference — the LLM lane's candidate pool (see the post-loop
  // block below). `mounted: true` means the ORIGINAL probe pass already
  // confirmed a live mount (just found nothing) — those are eligible for
  // the LLM lane's post-generation probe re-verification; `mounted: false`
  // components can still get an LLM hint, but it can never be verified.
  const llmEligible: Array<{ manifest: ComponentManifest; mounted: boolean }> = []

  // Concurrency 1: sequential — the caller's `probe` closes over ONE
  // `ProbePage`, reused mount-after-mount (see module doc comment).
  for (let i = 0; i < targets.length; i++) {
    const manifest = targets[i]
    opts.onProgress?.({ index: i, total, component: manifest.name })

    let mounted = false
    let mountFailReason: string | undefined
    let generatedHints: RenderingHint[] = []
    if (opts.probe) {
      try {
        const outcome = await deriveHintsForComponent(manifest, opts.probe, suffix)
        if (outcome.ok) {
          mounted = true
          generatedHints = outcome.hints
        } else {
          mountFailReason = outcome.reason ?? 'probe failed'
        }
      } catch (err) {
        // deriveHintsForComponent already catches probe failures internally;
        // this is a defense-in-depth guard against a bug in the engine
        // itself still isolating one component's failure from the rest of
        // the run.
        mountFailReason = errMessage(err)
      }
    }

    let inferredHints: RenderingHint[] = []
    let inferFailReason: string | undefined
    if (opts.inferHints) {
      try {
        const outcome = await opts.inferHints(manifest)
        if (outcome.ok) inferredHints = outcome.hints
        else inferFailReason = outcome.reason ?? 'source inference failed'
      } catch (err) {
        inferFailReason = errMessage(err)
      }
    }

    // C1 safety guard: `mergeRenderingHints` only dedupes per-SOURCE
    // collisions (probe vs. inferred hint for the SAME prop/slot); it can
    // still hand back two DIFFERENT sources both claiming the identical
    // rendering site (e.g. a probe hint for prop A and an inferred hint for
    // prop B that happen to land on the same element). Drop those before
    // they're ever written — see `dropCollidingHints`'s doc comment.
    const merged = dropCollidingHints(mergeRenderingHints(generatedHints, inferredHints))

    if (mounted) {
      probed++
      hints[manifest.name] = merged
      if (merged.length > 0) {
        hinted++
        if (merged.every((h) => h.verified === true)) verified++
      } else {
        llmEligible.push({ manifest, mounted: true })
      }
      continue
    }

    if (merged.length > 0) {
      // Task 4: the component couldn't be mounted (no probe supplied for
      // this run, or the mount itself failed), but source inference still
      // produced hints — write them (unverified) rather than dropping the
      // component entirely. See the module doc comment's "Source
      // inference" section.
      hints[manifest.name] = merged
      hinted++
      skipped.push({
        name: manifest.name,
        reason: mountFailReason ?? 'not probed (no probe supplied for this run)',
      })
      continue
    }

    skipped.push({
      name: manifest.name,
      reason: mountFailReason ?? inferFailReason ?? 'probe failed and no inference available',
    })
    llmEligible.push({ manifest, mounted: false })
  }

  // Phase 4 Task 5 — the opt-in LLM lane. Runs LAST, ONLY for components
  // that got NOTHING from probe+inference above, and ONLY when the caller
  // explicitly asked (`useLlm`). Never on by default: this is the one lane
  // that costs a real LLM call per component.
  if (opts.useLlm && llmEligible.length > 0) {
    const llmResult = await runLlmHintsLane({
      targets: llmEligible.map((e) => e.manifest),
      mountable: new Set(llmEligible.filter((e) => e.mounted).map((e) => e.manifest.name)),
      probe: opts.probe,
      resolveDistExcerpt: opts.llm?.resolveDistExcerpt,
      provider: opts.llm?.provider,
      model: opts.llm?.model,
      maxComponents: opts.llm?.maxComponents,
      maxConcurrency: opts.llm?.maxConcurrency,
      sentinelSuffix: suffix,
      signal: opts.llm?.signal,
    })

    for (const [name, llmHints] of Object.entries(llmResult.hints)) {
      hints[name] = llmHints
      if (llmHints.length > 0) {
        hinted++
        if (llmHints.every((h) => h.verified === true)) verified++
      }
    }

    // Merge the lane's own skip reasons into the run's `skipped` list. A
    // name already present there (the `mounted: false` branch above always
    // pushes one) gets its reason ANNOTATED rather than duplicated; a name
    // with no prior entry (the `mounted: true`-but-zero-hints branch never
    // pushes one) gets a fresh entry — mirroring how a mounted-but-hinted
    // component is never in `skipped` at all, an LLM-hinted formerly-
    // mounted component doesn't magically become "skipped" either (see the
    // loop below: only components the LLM lane itself reports skipped are
    // touched here).
    for (const skip of llmResult.skipped) {
      const existingIndex = skipped.findIndex((s) => s.name === skip.name)
      if (existingIndex === -1) {
        skipped.push(skip)
      } else {
        skipped[existingIndex] = {
          name: skip.name,
          reason: `${skipped[existingIndex].reason}; llm: ${skip.reason}`,
        }
      }
    }
  }

  // Only write when at least one component actually produced hints. A
  // zero-target run (the design system's catalog came back empty — almost
  // always a wiring bug: wrong `designSystem` id, or the manifest source
  // hasn't discovered the package at all) is one way `hints` ends up empty,
  // but NOT the only one: `total > 0` with every component mount-failing (a
  // transient failure — isolation route unavailable, Vite not serving the
  // mount, a React package where the probe/inference lanes are skipped) also
  // leaves `hints` empty. Gating on `Object.keys(hints).length > 0` instead
  // of `total > 0` covers both — never write an empty file over whatever
  // hints already exist on disk from a prior successful run. Mirrors the
  // established rule in `src/editor/adapters/cached/index.ts`: "Don't
  // freeze a transient empty extraction; let the next boot retry."
  // The write gate is unchanged from the round-5 fix (codex P2, see the test
  // titled "does NOT overwrite an existing hint cache file when a later run
  // produces zero hints"): a run that evaluated NOTHING (every target
  // mount-failed with no inference, or the catalog filter matched zero
  // components) must leave a real prior file completely untouched — no
  // read, no write, no bumped `generatedAt`. Gating on the run's OWN
  // `hints` (not the carry-forward-merged map below) is what preserves that
  // guarantee: `merged` is always a superset of `hints`, so `hints` empty
  // implies `merged` would be empty too — there is no reachable state where
  // we'd want to write a file containing ONLY carried-forward entries and
  // nothing this run actually learned.
  const wroteCache = Object.keys(hints).length > 0
  let carriedForward = 0
  if (wroteCache) {
    // ── Carry-forward rule (codex P2 fix, 2026-07-29) ──
    //
    // A prior run may have written verified hints for components this run
    // never got a determinate answer for (a transient mount/probe failure
    // — see `GenerateHintsSkip`). Naively writing `hints` alone would
    // silently erase that prior knowledge for every such component, even
    // though nothing about ITS trustworthiness changed — only that THIS run
    // didn't re-confirm it. So: read the existing file for the SAME cache
    // key (packageName+packageVersion — a different version's file is a
    // different path and is never consulted, see `hintCacheFilePath`), and
    // for every component name it has an entry for that this run did NOT
    // evaluate (i.e. it's absent from `hints` — every evaluated component,
    // mounted or inference-only, always has a `hints` entry, even an empty
    // array; see the per-component loop above), carry the PRIOR entry
    // forward verbatim into the written file.
    //
    // The flip side — and the reason this is "replace at component
    // granularity", never a per-hint merge — is that a component THIS run
    // DID evaluate always keeps this run's result, even when that result is
    // zero hints: the collision guard (`dropCollidingHints`) or an empty
    // sentinel match is CURRENT evidence there's no trustworthy site
    // anymore, so a stale non-empty prior entry must not survive under it.
    // Concretely: prior file has `{A: [hint]}`; this run evaluates A and
    // finds nothing → the written file has `{A: []}`, not `{A: [hint]}`.
    // `[]` and "no entry at all" are equivalent to every downstream reader
    // (`HintsCacheManifestSource.getComponent` treats `!hints.length` as
    // "no hint", same as a missing key) — so the write-gate above, which
    // only looks at whether `hints` (this run's own results) has ANY key,
    // never mistakes this legitimate zero-hint overwrite for the
    // "evaluated nothing" case the guard exists to protect against, even
    // though both end up putting an empty-ish value on disk for that one
    // component.
    const cacheFilePath = hintCacheFilePath(
      opts.cacheDir,
      opts.entry.packageName,
      opts.entry.packageVersion,
    )
    const priorFile = readHintCache(cacheFilePath)
    const merged: Record<string, RenderingHint[]> = { ...hints }
    if (priorFile) {
      for (const [name, priorHints] of Object.entries(priorFile.hints)) {
        if (name in hints) continue // evaluated this run — its result wins, per the rule above
        merged[name] = priorHints
        carriedForward++
      }
    }

    const file: HintCacheFile = {
      schema: HINTS_SCHEMA_VERSION,
      packageName: opts.entry.packageName,
      packageVersion: opts.entry.packageVersion,
      generatedAt: (opts.now?.() ?? new Date()).toISOString(),
      hints: merged,
    }
    writeHintCache(cacheFilePath, file)
  }

  return {
    probed,
    hinted,
    verified,
    skipped,
    wroteCache,
    note: wroteCache ? undefined : 'no hints produced. Existing hint cache left unchanged.',
    carriedForward,
  }
}

/**
 * Combine one component's probe-derived hints with its source-inferred
 * hints (Task 4), deduping on the site each hint describes:
 * `(source.kind, source.name, domTarget.selector, domTarget.field,
 * domTarget.attribute ?? '')` — two hints at that same key describe the SAME
 * rendering site two different ways. The attribute must be part of the key:
 * a component can render the SAME prop into two DIFFERENT attributes on the
 * SAME element (e.g. `label` → both `aria-label` and `title`), and those are
 * two distinct sites, not one. A probe-derived hint always wins a collision: it's
 * `verified: true` by construction (the probe IS the verification — see
 * `derive-hints.ts`), so a source-inferred hint for the identical site is
 * redundant once the probe has independently confirmed it. Both lanes only
 * ever emit `kind: 'dom'` hints (`derive-hints.ts` / `infer-from-source.ts`
 * — neither produces `forward` hints), so `domTarget` is always present on
 * every input hint here.
 *
 * Order: probe-derived hints first, then any source-inferred hints whose
 * site the probe did NOT also find. Callers should assert on set
 * membership, not array position, for the inferred tail.
 *
 * Exported for direct unit testing of the dedupe/collision policy.
 */
export function mergeRenderingHints(
  generated: RenderingHint[],
  inferred: RenderingHint[],
): RenderingHint[] {
  const bySite = new Map<string, RenderingHint>()
  for (const hint of generated) bySite.set(hintSiteKey(hint), hint)
  for (const hint of inferred) {
    const key = hintSiteKey(hint)
    if (!bySite.has(key)) bySite.set(key, hint)
  }
  return [...bySite.values()]
}

/**
 * Sibling key to `siteKey` in `derive-hints.ts` — that one dedupes DIFFERENT
 * sources at the SAME site (the collision guard); this one dedupes the SAME
 * source at the SAME site (the merge). Both must agree on what counts as "the
 * same site", so both include the attribute name: keep them in sync if either
 * changes.
 *
 * Forward hints have no `domTarget`, so they key on their source alone
 * (`prop:label:undefined:undefined:`). That is correct for a MERGE — two
 * hints for the same source ARE the same hint, whatever their destination —
 * but it means two forward hints for one source with DIFFERENT destinations
 * would collapse to the first. The probe cannot currently produce that pair
 * (a source resolves to at most one destination per component), so this is a
 * bound to know about rather than a live defect. An earlier version of this
 * comment claimed neither lane produces forward hints at all; that stopped
 * being true on 2026-08-16.
 */
function hintSiteKey(hint: RenderingHint): string {
  const dom = (hint as Extract<RenderingHint, { kind: 'dom' }>).domTarget
  return `${hint.source.kind}:${hint.source.name}:${dom?.selector}:${dom?.field}:${dom?.attribute ?? ''}`
}

/** Coverage summary the design-systems panel renders as "H of N components hinted (V verified)". */
export interface HintCoverage {
  /** Components with ≥1 generated hint. */
  hinted: number
  /** Of the hinted components, how many have every hint verified. */
  verified: number
  /**
   * Components successfully probed in the last run (whether hinted or not)
   * — see doc comment below for why this, not "every component in the
   * design system's full catalog", is what `total` means.
   */
  total: number
}

/**
 * Computes {@link HintCoverage} from an already-loaded `HintCacheFile`'s
 * `hints` map — a pure, cheap function over in-memory data (no fs I/O
 * itself; the caller, `design-systems-handler.ts`'s GET route, does the one
 * `readHintCache` fs read).
 *
 * `total` is `Object.keys(hints).length` — the count of components with SOME
 * representation in the written file: every successfully MOUNTED component
 * (see this module's per-component loop: every probed component gets an
 * entry, even an empty array, and only mount FAILURES with no inferred
 * hints are excluded), PLUS, as of Task 4, any component that couldn't be
 * mounted but whose SOURCE-INFERRED hints were written instead (unverified,
 * but still present in the file — see the module doc comment's "Source
 * inference" section). This is deliberately NOT "every component in the
 * design system's full catalog": computing that denominator would
 * require a live manifest build (`getManifestSource()`), which the passive
 * GET route must never trigger (the same constraint `getGroundingHealth`
 * already documents) — the hint file itself is the only thing a cheap fs
 * read can answer from.
 */
export function computeHintCoverage(hints: HintCacheFile['hints']): HintCoverage {
  const names = Object.keys(hints)
  let hintedCount = 0
  let verifiedCount = 0
  for (const name of names) {
    const componentHints = hints[name] ?? []
    if (componentHints.length === 0) continue
    hintedCount++
    if (componentHints.every((h) => h.verified === true)) verifiedCount++
  }
  return { hinted: hintedCount, verified: verifiedCount, total: names.length }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

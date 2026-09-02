/**
 * Drift signal model + live drift log (Phase 5 Task 1 of the grounding
 * rearchitecture — `.superpowers/sdd/2026-07-29-grounding-phase5-drift/task-1-brief.md`).
 *
 * A "drift signal" is a shell-side observation that the grounding data
 * (manifests, rendering hints) didn't line up with what actually rendered:
 * a component's hints existed but none matched the clicked element, a
 * selector matched more than one element, a runtime component has no
 * catalog entry, or the consumer passed props the manifest doesn't
 * declare. These are ADVISORY — they degrade attribution quality, not
 * correctness — so the log that accumulates them must never throw and
 * must never grow unbounded.
 *
 * Framework-neutral by design, same posture as `grounding-health.ts`: no
 * imports from `src/editor/adapters/*` or `src/editor/onboarding/*`,
 * only plain types + a pure factory.
 *
 * **Distinct from `GroundingHealth`.** `GroundingHealth` is a BOOT
 * SNAPSHOT — one report per manifest-bundle build, memoized for the
 * process lifetime by the grounding service (`getGroundingService`
 * caches it; see `editor-cli/src/server/grounding-context.ts`). Bolting
 * live signals onto that object would mean every drift signal recorded
 * after the bundle was built either mutates a supposedly-frozen snapshot
 * or is silently lost. `DriftLog` is a SEPARATE, LIVE, process-lifetime
 * log: it accumulates signals for as long as the CLI process runs,
 * independent of when (or how many times) a manifest bundle was built.
 */

/** The kinds of grounding drift the bridge/shell can observe at runtime. */
export type DriftKind =
  | "hint-miss" // component has trusted hints; none matched the clicked element
  | "selector-ambiguous" // clicked element's canonical selector matches >1 element in the mount root
  | "unknown-component" // runtime component absent from the catalog
  | "unknown-props" // consumer passed props the manifest doesn't declare
  | "manifest-value-mismatch" // an edit set a finite-choice prop to a value the manifest doesn't declare

/** Runtime-enumerable list of every {@link DriftKind} — the validation surface for callers that receive untyped input (e.g. the HTTP handler). */
export const DRIFT_KINDS: readonly DriftKind[] = [
  "hint-miss",
  "selector-ambiguous",
  "unknown-component",
  "unknown-props",
  "manifest-value-mismatch",
]

/**
 * Kinds a granular manifest re-extract (Phase 5 Task 4, `repairComponent`)
 * can plausibly fix: both point at a component's PROPS being wrong or
 * incomplete relative to what a fresh extraction would produce.
 * `selector-ambiguous` (a DOM-shape/hint problem, not a props problem) and
 * `unknown-component` (no catalog entry to re-extract AT ALL — there's no
 * existing package/import identity to re-run discovery against) are
 * deliberately excluded; both need a different remediation (Task 5/6).
 *
 * `manifest-value-mismatch` (carry-forward (g), landed 2026-07-30) joins
 * `unknown-props` here for the same reason: an off-manifest value on a
 * `finite-choice` prop is exactly as ambiguous as an off-manifest prop
 * NAME — either the value is bad, or the installed package grew a variant
 * the cached manifest doesn't know about yet. A fresh extraction resolves
 * that ambiguity the same way it resolves `unknown-props`: if the value
 * shows up in the re-extracted `options`, the manifest was stale; if it
 * still doesn't, the manifest was right and the edit was wrong. See
 * `src/editor/drift/detect-manifest-value-mismatch.ts` for why this is
 * advisory-only and never blocks the edit that triggered it.
 */
export const REPAIRABLE_DRIFT_KINDS: readonly DriftKind[] = [
  "hint-miss",
  "unknown-props",
  "manifest-value-mismatch",
]

/** One observed instance of drift, as reported by the caller. */
export interface DriftSignal {
  kind: DriftKind
  /** Runtime component name (always present). */
  component: string
  /** Best-effort; absent for pre-compiled libs. */
  importPath?: string
  /** Resolved shell-side when the manifest is known. */
  designSystem?: string
  /**
   * e.g. the unmatched selector, the unknown prop names joined, or (for
   * `manifest-value-mismatch`) the offending value plus a bounded preview
   * of the declared options.
   */
  detail?: string
  /** ISO timestamp. */
  at: string
}

/** Coalesced drift for one `(component, importPath)` pair. */
export interface DriftEntry {
  /** `${component}::${importPath ?? ''}` */
  key: string
  component: string
  importPath?: string
  designSystem?: string
  /** Distinct kinds seen, insertion-ordered. */
  kinds: DriftKind[]
  /**
   * Total signals coalesced into this entry — i.e. how many times this
   * `(component, importPath)` pair's drift was OBSERVED, not how many
   * times it was edited. Since the 2026-07-30 widening (`detectDrift` now
   * runs at inspection time as well as text-edit commit time — see
   * `docs/grounding-pipeline.md` § "Drift Detection — Phase 5"), a single
   * click-then-commit on the same element can report twice (once per call
   * site) and increments this the same as two independent observations.
   */
  count: number
  firstSeen: string
  lastSeen: string
  lastDetail?: string
  /**
   * Set by Task 4's `repairComponent` when a deterministic single-component
   * re-extract ran (or was attempted) for this entry. Written twice per
   * attempt: `'pending'` synchronously (claims the "at most once per
   * process" guard BEFORE the async re-extract starts, closing the race
   * where two signals for the same entry arrive before the first repair
   * settles), then overwritten with the final outcome once
   * `repairComponent`'s promise resolves. `'unsupported'` covers inputs
   * `repairComponent` can't act on in V1 (no per-component React re-extract,
   * no importPath to resolve a package from, package doesn't look like a
   * Vue library) — distinct from `'failed'` (a Vue re-extract was
   * attempted and didn't produce a usable, changed result). `'seeded'` is
   * distinct from `'repaired'`: both wrote a fresh manifest to the on-disk
   * cache, but `'seeded'` means there was NO prior cached entry to compare
   * against (a cache miss), so — unlike `'repaired'` — it is NOT evidence
   * that a stale manifest was actually found and corrected. See
   * `RepairOutcome` in `src/editor/drift/repair-component.ts` for the
   * full three-way distinction consumers must preserve.
   */
  repair?: {
    attemptedAt: string
    outcome: "pending" | "repaired" | "unchanged" | "seeded" | "failed" | "unsupported"
    reason?: string
  }
}

/** A live, process-lifetime log of coalesced drift signals. */
export interface DriftLog {
  /** Coalesce `signal` into its entry (creating one if this is the first sighting of its key) and return the stored entry. */
  record(signal: DriftSignal): DriftEntry
  /** All entries, `lastSeen` descending (most recent drift first). */
  list(): DriftEntry[]
  /** Look up one entry by its `driftKey`. */
  get(key: string): DriftEntry | undefined
  /** Remove one entry by key, or every entry when `key` is omitted. */
  clear(key?: string): void
  /** Bounded: oldest entries evicted past this many keys. */
  readonly maxEntries: number
}

const DEFAULT_MAX_ENTRIES = 200

/** The coalescing key for a `(component, importPath)` pair — same rule `DriftEntry.key` and `record()` use. */
export function driftKey(component: string, importPath?: string): string {
  return `${component}::${importPath ?? ""}`
}

/**
 * Create a fresh, empty `DriftLog`. `maxEntries` bounds the number of
 * DISTINCT keys retained — once at capacity, recording a signal for a
 * brand-new key evicts the oldest existing entry (by insertion order,
 * i.e. the key that has been tracked the longest) to make room. Repeat
 * signals for an already-tracked key never trigger eviction and never
 * change that key's place in the eviction order — only genuinely new
 * keys compete for the bounded capacity.
 */
export function createDriftLog(opts?: { maxEntries?: number }): DriftLog {
  const maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES
  // Map preserves insertion order — iterating `.keys()` yields the
  // oldest-tracked key first, which is exactly what eviction needs.
  const entries = new Map<string, DriftEntry>()

  return {
    maxEntries,

    record(signal: DriftSignal): DriftEntry {
      const key = driftKey(signal.component, signal.importPath)
      const existing = entries.get(key)

      if (existing) {
        if (!existing.kinds.includes(signal.kind)) existing.kinds.push(signal.kind)
        existing.count += 1
        existing.lastSeen = signal.at
        if (signal.detail !== undefined) existing.lastDetail = signal.detail
        // A later signal that resolves the designSystem (e.g. the first
        // sighting predates manifest resolution) should update the entry;
        // don't clobber a known value with `undefined` from a later signal
        // that didn't carry one.
        if (signal.designSystem !== undefined) existing.designSystem = signal.designSystem
        return existing
      }

      if (entries.size >= maxEntries) {
        const oldestKey = entries.keys().next().value
        if (oldestKey !== undefined) entries.delete(oldestKey)
      }

      const created: DriftEntry = {
        key,
        component: signal.component,
        importPath: signal.importPath,
        designSystem: signal.designSystem,
        kinds: [signal.kind],
        count: 1,
        firstSeen: signal.at,
        lastSeen: signal.at,
        lastDetail: signal.detail,
      }
      entries.set(key, created)
      return created
    },

    list(): DriftEntry[] {
      return [...entries.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
    },

    get(key: string): DriftEntry | undefined {
      return entries.get(key)
    },

    clear(key?: string): void {
      if (key === undefined) {
        entries.clear()
        return
      }
      entries.delete(key)
    },
  }
}

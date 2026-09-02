/**
 * Shell-side data hook for the "Design Systems" panel (onboarding milestone
 * 6.4). Reads the registered design systems + installed-library suggestions
 * from the CLI, and drives onboarding (installed package or npm spec) through
 * the SSE-progress POST so the panel can show "Installing… / Extracting…".
 *
 * Imports onboarding TYPES only — the runtime onboarding modules pull `node:fs`
 * (detect/extract), which must never enter the browser bundle.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import { parseSseStream } from "@/lib/sse"
import type {
  DesignSystemSource,
  OnboardResult,
  OnboardStage,
  RegisteredDesignSystem,
} from "@/editor/onboarding/types"
import type { DesignSystemSuggestion } from "@/editor/onboarding/suggest"
import type { ReconcileStatus } from "@/editor/onboarding/reconcile"
import type { StalenessResult } from "@/editor/onboarding/staleness"
import type { GroundingHealth } from "@/editor/core"

const ROUTE = "/api/editor/design-systems"

/**
 * Coverage summary for probe-derived rendering hints (Phase 4 Task 3),
 * served per-entry in the GET response's `hintCoverage` field — `null` when
 * no hint file exists yet for that entry (hints never generated). Defined
 * locally (not imported from `src/editor/hints/generate-hints-run.ts`)
 * because that module pulls in `node:crypto` — this hook stays fs/runtime
 * free, matching the file's own "types only" doc comment above.
 */
export interface HintCoverage {
  /** Components with ≥1 generated hint. */
  hinted: number
  /** Of the hinted components, how many have every hint verified. */
  verified: number
  /** Components successfully probed in the last generate-hints run. */
  total: number
}

/** A registered system plus whether it has a matching `designSystems` declaration on disk, and its hint coverage. */
export type RegisteredDesignSystemWithDeclared = RegisteredDesignSystem & {
  declared: boolean
  hintCoverage: HintCoverage | null
}

/** Live progress while a `generateHints` run streams (Phase 4 Task 3). */
export interface HintGenerationProgress {
  component: string
  index: number
  total: number
}

export interface HintGenerationSkip {
  name: string
  reason: string
}

/** Run summary returned by `generateHints` — mirrors `GenerateHintsRunResult`. */
export interface HintGenerationResult {
  probed: number
  hinted: number
  verified: number
  skipped: HintGenerationSkip[]
  /**
   * Whether the run actually wrote the on-disk hint cache file. `false`
   * means an existing hint file (if any) was left untouched because this
   * run produced zero hints — see `note` and
   * `generate-hints-run.ts`'s `GenerateHintsRunResult` doc comment.
   */
  wroteCache: boolean
  /** Present when `wroteCache` is `false`, explaining why nothing was written. */
  note?: string
  /**
   * Count of components whose PRIOR hint-cache entry was carried forward
   * unchanged because this run never evaluated them (codex P2 fix,
   * 2026-07-29 — see `generate-hints-run.ts`'s write-step doc comment).
   * Optional so existing fakes/mocks that predate this field stay valid;
   * a real server response always includes it.
   */
  carriedForward?: number
}

export interface UseDesignSystems {
  systems: RegisteredDesignSystemWithDeclared[]
  suggestions: DesignSystemSuggestion[]
  /**
   * Health of the most recently built manifest bundle, or null when the
   * grounding service hasn't built one yet this session (not an error —
   * simply nothing to report).
   */
  health: GroundingHealth | null
  /**
   * Boot-time reconciliation of declared-but-unregistered systems (Phase 3
   * attach/refresh), or null before any declarations exist / before the
   * async pass has produced its first snapshot.
   */
  reconciliation: ReconcileStatus | null
  /** Set when `desde.config.json`'s `designSystems` block is malformed. */
  declarationsError: string | null
  /**
   * Staleness per registered entry id (Phase 3 refresh) — populated from
   * `GET …/updates` alongside every {@link reload}. Absent entries simply
   * haven't been checked yet (e.g. the fetch failed); that's not an error
   * worth surfacing, the badge just doesn't render.
   */
  updates: Record<string, StalenessResult>
  loading: boolean
  error: string | null
  /** An add/remove/refresh is in flight (disables further mutations). */
  busy: boolean
  /** Current onboarding stage while an add or refresh streams, else null. */
  progress: OnboardStage | null
  /** Current probe progress while a `generateHints` run streams, else null. */
  hintProgress: HintGenerationProgress | null
  addInstalled: (pkg: string, designSystem?: string) => Promise<OnboardResult | null>
  addNpm: (spec: string, designSystem?: string) => Promise<OnboardResult | null>
  addRepo: (
    repo: { url: string; ref?: string; subdir?: string; allowBuild?: boolean },
    designSystem?: string,
  ) => Promise<OnboardResult | null>
  remove: (id: string) => Promise<void>
  /** Declare an already-registered system so future boots re-onboard it. Returns success. */
  share: (id: string) => Promise<boolean>
  /** Reload the registered list + suggestions + staleness from the server. */
  reload: () => Promise<void>
  /** Re-run `GET …/updates`; `force` bypasses the server's TTL cache. */
  checkUpdates: (force?: boolean) => Promise<void>
  /** Re-onboard a registered entry from its ORIGINAL source. Returns success. */
  refresh: (id: string) => Promise<boolean>
  /**
   * Probe-derive rendering hints for a registered system (Phase 4 Task 3) —
   * mounts each of its components in a headless page and writes a hint
   * cache file. `useLlm` (Phase 4 Task 5, default false) additionally
   * engages the opt-in LLM one-shot lane for whatever's left with ZERO
   * hints after probe+inference — costs a real LLM call per such
   * component, which is why it's never on unless the caller opts in.
   * Returns the run summary, or `null` on failure.
   */
  generateHints: (id: string, useLlm?: boolean) => Promise<HintGenerationResult | null>
  /** Dismiss the current error banner. */
  clearError: () => void
}

export function useDesignSystems(): UseDesignSystems {
  const [systems, setSystems] = useState<RegisteredDesignSystemWithDeclared[]>([])
  const [suggestions, setSuggestions] = useState<DesignSystemSuggestion[]>([])
  const [health, setHealth] = useState<GroundingHealth | null>(null)
  const [reconciliation, setReconciliation] = useState<ReconcileStatus | null>(null)
  const [declarationsError, setDeclarationsError] = useState<string | null>(null)
  const [updates, setUpdates] = useState<Record<string, StalenessResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<OnboardStage | null>(null)
  const [hintProgress, setHintProgress] = useState<HintGenerationProgress | null>(null)
  // Guard against a state update after unmount (onboarding can run 10–60s).
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Generation counter: only the LATEST reload applies its results. The
  // initial mount's reload waits on a slow node_modules scan; an onboard's
  // own reload can finish first, so without this the slow initial reload
  // would clobber the fresh list with its pre-add snapshot.
  const refreshGen = useRef(0)

  const reload = useCallback(async () => {
    const gen = ++refreshGen.current
    const live = () => mounted.current && gen === refreshGen.current
    try {
      const [listRes, sugRes] = await Promise.all([
        editorFetch(ROUTE, { cache: "no-store" }),
        editorFetch(`${ROUTE}/suggestions`, { cache: "no-store" }),
      ])
      // A non-OK response is a real backend failure (e.g. a malformed registry
      // file). Surface it and KEEP previously-loaded data — never silently
      // replace the list with an empty "all clear" that hides the error.
      let failure: string | null = null
      if (listRes.ok) {
        const j = await listRes.json().catch(() => null)
        if (live() && Array.isArray(j?.designSystems)) setSystems(j.designSystems)
        if (live() && (j?.health === null || (j?.health && typeof j.health === "object"))) {
          setHealth(j.health as GroundingHealth | null)
        }
        if (live()) {
          setReconciliation((j?.reconciliation ?? null) as ReconcileStatus | null)
          setDeclarationsError(typeof j?.declarationsError === "string" ? j.declarationsError : null)
        }
      } else {
        failure = await reasonOf(listRes, "load registered design systems")
      }
      if (sugRes.ok) {
        const j = await sugRes.json().catch(() => null)
        if (live() && Array.isArray(j?.suggestions)) setSuggestions(j.suggestions)
      } else {
        failure = failure ?? (await reasonOf(sugRes, "load suggestions"))
      }
      if (failure && live()) setError(failure)
    } catch (err) {
      if (live()) setError(messageOf(err))
    } finally {
      if (live()) setLoading(false)
    }

    // Staleness is supplementary UI polish (a badge), not core data, and its
    // checks can be genuinely slow on a cold cache (`npm view` / `git
    // ls-remote` per entry) — fired AFTER list+suggestions settle, and NOT
    // awaited, so a slow or hung `…/updates` can never hold `loading` true
    // and block the rest of the panel. Fire-and-forget: a failed/errored
    // fetch here is silently ignored, same posture as before; `live()` still
    // guards against a stale response landing after a newer `reload()`.
    void editorFetch(`${ROUTE}/updates`, { cache: "no-store" })
      .then(async (updRes) => {
        if (!updRes.ok) return
        const j = await updRes.json().catch(() => null)
        if (live() && j?.updates && typeof j.updates === "object") {
          setUpdates(j.updates as Record<string, StalenessResult>)
        }
      })
      .catch(() => {
        // Best-effort — the panel's badges simply don't refresh.
      })
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const checkUpdates = useCallback(async (force?: boolean): Promise<void> => {
    try {
      const res = await editorFetch(`${ROUTE}/updates${force ? "?force=1" : ""}`, {
        cache: "no-store",
      })
      if (!res.ok) return
      const j = await res.json().catch(() => null)
      if (mounted.current && j?.updates && typeof j.updates === "object") {
        setUpdates(j.updates as Record<string, StalenessResult>)
      }
    } catch {
      // Best-effort — the panel's badges simply don't refresh.
    }
  }, [])

  const onboard = useCallback(
    async (
      source: DesignSystemSource,
      designSystem?: string,
      allowBuild?: boolean,
    ): Promise<OnboardResult | null> => {
      if (busy) return null
      setBusy(true)
      setError(null)
      setProgress(null)
      try {
        const res = await editorFetch(ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ source, designSystem, allowBuild }),
        })
        if (!res.ok || !res.body) {
          // Non-stream error (e.g. 400/422 JSON).
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Onboarding failed (HTTP ${res.status}).`)
        }
        let result: OnboardResult | null = null
        for await (const ev of parseSseStream<OnboardSseEvent>(res.body)) {
          if (ev.type === "progress" && ev.stage) {
            if (mounted.current) setProgress(ev.stage)
          } else if (ev.type === "result") {
            result = ev.result ?? null
          } else if (ev.type === "error") {
            throw new Error(ev.message || "Onboarding failed.")
          }
        }
        if (!result) throw new Error("Onboarding ended without a result.")
        await reload()
        return result
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
        return null
      } finally {
        if (mounted.current) {
          setBusy(false)
          setProgress(null)
        }
      }
    },
    [busy, reload],
  )

  const addInstalled = useCallback(
    (pkg: string, designSystem?: string) => onboard({ kind: "installed", package: pkg }, designSystem),
    [onboard],
  )
  const addNpm = useCallback(
    (spec: string, designSystem?: string) => onboard({ kind: "npm", spec }, designSystem),
    [onboard],
  )
  const addRepo = useCallback(
    (
      repo: { url: string; ref?: string; subdir?: string; allowBuild?: boolean },
      designSystem?: string,
    ) =>
      onboard(
        { kind: "repo", url: repo.url, ref: repo.ref, subdir: repo.subdir },
        designSystem,
        repo.allowBuild,
      ),
    [onboard],
  )

  const remove = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" })
        if (!res.ok) {
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Remove failed (HTTP ${res.status}).`)
        }
        await reload()
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [busy, reload],
  )

  const share = useCallback(
    async (id: string): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      setError(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(id)}/share`, { method: "POST" })
        if (!res.ok) {
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Share failed (HTTP ${res.status}).`)
        }
        await reload()
        return true
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
        return false
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [busy, reload],
  )

  const refresh = useCallback(
    async (id: string): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      setError(null)
      setProgress(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(id)}/refresh`, {
          method: "POST",
          headers: { Accept: "text/event-stream" },
        })
        if (!res.ok || !res.body) {
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Refresh failed (HTTP ${res.status}).`)
        }
        let succeeded = false
        for await (const ev of parseSseStream<OnboardSseEvent>(res.body)) {
          if (ev.type === "progress" && ev.stage) {
            if (mounted.current) setProgress(ev.stage)
          } else if (ev.type === "result") {
            succeeded = true
          } else if (ev.type === "error") {
            throw new Error(ev.message || "Refresh failed.")
          }
        }
        if (!succeeded) throw new Error("Refresh ended without a result.")
        await reload()
        return true
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
        return false
      } finally {
        if (mounted.current) {
          setBusy(false)
          setProgress(null)
        }
      }
    },
    [busy, reload],
  )

  const generateHints = useCallback(
    async (id: string, useLlm?: boolean): Promise<HintGenerationResult | null> => {
      if (busy) return null
      setBusy(true)
      setError(null)
      setHintProgress(null)
      try {
        const res = await editorFetch(`${ROUTE}/${encodeURIComponent(id)}/generate-hints`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ useLlm: useLlm === true }),
        })
        if (!res.ok || !res.body) {
          const reason = await res.json().then((j) => j?.reason).catch(() => null)
          throw new Error(reason || `Generate hints failed (HTTP ${res.status}).`)
        }
        let result: HintGenerationResult | null = null
        for await (const ev of parseSseStream<GenerateHintsSseEvent>(res.body)) {
          if (ev.type === "progress" && ev.progress) {
            if (mounted.current) setHintProgress(ev.progress)
          } else if (ev.type === "result") {
            result = ev.result ?? null
          } else if (ev.type === "error") {
            throw new Error(ev.message || "Generate hints failed.")
          }
        }
        if (!result) throw new Error("Generate hints ended without a result.")
        await reload()
        return result
      } catch (err) {
        if (mounted.current) setError(messageOf(err))
        return null
      } finally {
        if (mounted.current) {
          setBusy(false)
          setHintProgress(null)
        }
      }
    },
    [busy, reload],
  )

  return {
    systems,
    suggestions,
    health,
    reconciliation,
    declarationsError,
    updates,
    loading,
    error,
    busy,
    progress,
    hintProgress,
    addInstalled,
    addNpm,
    addRepo,
    remove,
    share,
    reload,
    checkUpdates,
    refresh,
    generateHints,
    clearError: useCallback(() => setError(null), []),
  }
}

/** SSE frame from the onboarding POST. */
interface OnboardSseEvent {
  type: "progress" | "result" | "error"
  stage?: OnboardStage
  result?: OnboardResult
  message?: string
}

/** SSE frame from the `…/generate-hints` POST (Phase 4 Task 3) — same envelope shape, different progress/result payloads. */
interface GenerateHintsSseEvent {
  type: "progress" | "result" | "error"
  progress?: HintGenerationProgress
  result?: HintGenerationResult
  message?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Best-effort reason from a non-OK JSON response, else an HTTP-status fallback. */
async function reasonOf(res: Response, what: string): Promise<string> {
  const reason = await res
    .json()
    .then((j) => (j && typeof j.reason === "string" ? j.reason : null))
    .catch(() => null)
  return reason ?? `Failed to ${what} (HTTP ${res.status}).`
}

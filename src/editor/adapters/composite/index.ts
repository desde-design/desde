/**
 * `CompositeManifestSource` orchestrates multiple `ComponentManifestSource`
 * instances and resolves manifests across them in priority order.
 *
 * Why this exists: per-project editor setups need to consult multiple
 * sources of truth (Storybook for the design system, local SFC parser
 * for first-party components, optional explicit registry for legacy
 * components). The shell shouldn't know about the source mix; it
 * queries one source and gets back a manifest.
 *
 * Resolution policy:
 * - `getComponent(name)` walks `sources` in order; the first non-null
 *   result **that `deprioritizeCandidate` does not reject** wins for
 *   props/slots/events (with no policy configured, that is simply the
 *   first non-null result, unchanged). `rendering` hints are composed
 *   separately: if the props winner carries none, later sources are
 *   consulted and the first non-empty `rendering` is overlaid onto the
 *   winner. This is load-bearing because the source with the best props
 *   isn't always the one with rendering hints — e.g. the `vue-dts-meta`
 *   extractor resolves a library's full prop schema from `.d.ts` but has
 *   no notion of where a prop renders, while `HintsCacheManifestSource`
 *   (probe-derived/inferred/generated hints, `../hints-cache/`) carries
 *   the hints. Without the overlay, the props winner would
 *   shadow the hints and attribution would silently fall back to
 *   heuristics. (Same shape for first-party: vue-component-meta props +
 *   local-vue inferred hints.)
 * - `listComponents()` walks every source and merges the results;
 *   duplicate component names are resolved first-source-wins, mirroring
 *   `getComponent`'s props policy. (Rendering hints aren't composed here —
 *   the catalog is for swap/variant-grid, which don't consume them.)
 *
 * Error handling: a source that throws is logged and skipped — one bad
 * adapter must not poison the whole resolution. Errors from the final
 * surviving source still propagate to the caller via the empty-result
 * path (a `null` from `getComponent`, an empty list from
 * `listComponents`).
 */
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'

export interface CompositeManifestSourceOptions {
  /**
   * Sources in priority order. First non-null match wins for
   * `getComponent`; first-source-wins on duplicate names for
   * `listComponents`. The list itself is captured by reference; do not
   * mutate it after construction.
   */
  sources: readonly ComponentManifestSource[]
  /**
   * Framework id reported by `composite.framework`. Defaults to the
   * framework of the first source. Composing mixed-framework sources
   * is allowed but the consumer is responsible for handling that —
   * the composite reflects, it doesn't enforce homogeneity.
   */
  framework?: FrameworkId
  /**
   * Design-system id reported by `composite.designSystem`. Defaults to
   * `'composite'`.
   */
  designSystem?: DesignSystemId
  /**
   * Optional logger for source-level errors. Defaults to
   * `console.warn`. Pass `() => {}` to silence.
   */
  onSourceError?: (sourceId: string, methodName: string, error: unknown) => void
  /**
   * Optional per-candidate demotion policy for `getComponent`. Return `true`
   * for a manifest that is a POSSIBLE but improbable answer for this bare
   * name, and it steps aside for any later candidate the policy accepts.
   *
   * Why the composite needs a hook here at all: source order is per-SOURCE,
   * and some collisions are only decidable per-NAME. Measured on a real
   * React app carrying an icon package alongside a component library:
   * `lucide-react` contributed 5279 of the catalogue's 5722 components and
   * won the bare name `Link` — even though the app imports `Link` from
   * `react-router` in every file that uses one, and imports nothing but
   * `*Icon`/`Chevron*` names from lucide. No ordering of the two packages
   * fixes that: whichever loses would be wrong for a different name.
   *
   * The composite stays policy-free — it does not know what "improbable"
   * means. `buildManifestSource` supplies the concrete rule.
   *
   * Bounds, deliberately: this only REORDERS candidates. If every candidate
   * is demoted, the first one still wins, so a policy can never make a name
   * unresolvable, and a source with no competitor is unaffected.
   */
  deprioritizeCandidate?: (manifest: ComponentManifest, name: string) => boolean
}

export class CompositeManifestSource implements ComponentManifestSource {
  readonly id = 'composite'
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly sources: readonly ComponentManifestSource[]
  private readonly deprioritizeCandidate: CompositeManifestSourceOptions['deprioritizeCandidate']
  private readonly onSourceError: NonNullable<
    CompositeManifestSourceOptions['onSourceError']
  >

  constructor(options: CompositeManifestSourceOptions) {
    this.sources = options.sources
    this.framework = options.framework ?? options.sources[0]?.framework ?? 'vue3'
    this.designSystem = options.designSystem ?? 'composite'
    this.deprioritizeCandidate = options.deprioritizeCandidate
    this.onSourceError =
      options.onSourceError ??
      ((sourceId, methodName, error) => {
        const msg =
          error instanceof Error ? error.message : String(error)
         
        console.warn(
          `[CompositeManifestSource] source ${sourceId}.${methodName} threw: ${msg}`,
        )
      })
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    let winner: ComponentManifest | null = null
    // Candidates the policy stepped past, in source order. Only consulted if
    // NOTHING was accepted — demotion reorders, it never removes.
    const demoted: ComponentManifest[] = []
    for (const source of this.sources) {
      let result: ComponentManifest | null = null
      try {
        result = await source.getComponent(name)
      } catch (err) {
        this.onSourceError(source.id, 'getComponent', err)
        continue
      }
      if (!result) continue
      if (!winner && this.deprioritizeCandidate?.(result, name)) {
        demoted.push(result)
        continue
      }
      if (!winner) {
        // First non-null wins for props/slots/events. If it already
        // carries rendering hints, no later source can improve it.
        winner = result
        if (hasRenderingHints(winner)) return winner
        continue
      }
      // The props winner lacked rendering hints; keep scanning ONLY to
      // recover hints from a lower-priority source, then overlay and
      // return. Props provenance stays with the winner.
      //
      // I2 safety guard: only graft when `result` is plausibly describing
      // the SAME component as `winner` — same design system, or same
      // import path. Without this, a same-NAME component from a totally
      // different package/design system (e.g. two libraries both
      // exporting "Button") could have its rendering hints silently
      // grafted onto the wrong package's props winner. Neither field is
      // guaranteed present on every source (first-party components often
      // have no `importPath`), so a match requires both sides to actually
      // declare the SAME non-empty value — two absent fields never count
      // as a match.
      if (hasRenderingHints(result) && isPlausiblySameComponent(winner, result)) {
        return { ...winner, rendering: result.rendering }
      }
    }
    if (winner) return winner
    // Every candidate was demoted (or there were none). Fall back to source
    // order over the demoted set, with the same hint overlay — a policy must
    // never turn a resolvable name into `null`.
    return overlayHints(demoted)
  }

  /**
   * Every source's non-null match for `name`, in source-priority order —
   * the raw candidates `getComponent` picks its single winner from. Added
   * for `manifest-value-mismatch-drift.ts` (2026-07-30): unlike
   * `getComponent`, which always returns the FIRST source's manifest, a
   * caller that knows the edited file's actual import path needs to pick
   * the RIGHT source out of a same-name collision — that requires seeing
   * every candidate, not just the winner. No hint-overlay logic here
   * (unlike `getComponent`) — callers disambiguating by import path only
   * need props/importPath/designSystem, all already correct per-source.
   * Same per-source error handling as `getComponent`/`listComponents`: a
   * source that throws is logged and skipped, never aborts the batch.
   */
  async getComponentCandidates(name: string): Promise<ComponentManifest[]> {
    const results: ComponentManifest[] = []
    for (const source of this.sources) {
      let result: ComponentManifest | null = null
      try {
        result = await source.getComponent(name)
      } catch (err) {
        this.onSourceError(source.id, 'getComponent', err)
        continue
      }
      if (result) results.push(result)
    }
    return results
  }

  async listComponents(): Promise<ComponentManifest[]> {
    const merged = new Map<string, ComponentManifest>()
    for (const source of this.sources) {
      let list: ComponentManifest[] = []
      try {
        list = await source.listComponents()
      } catch (err) {
        this.onSourceError(source.id, 'listComponents', err)
        continue
      }
      for (const manifest of list) {
        if (!merged.has(manifest.name)) {
          // First-source-wins: skip components an earlier source has
          // already provided. Mirrors `getComponent`'s short-circuit.
          merged.set(manifest.name, manifest)
        }
      }
    }
    return Array.from(merged.values())
  }
}

/** First entry wins for props; the first later entry that both carries
 *  rendering hints and passes the identity guard donates them. Mirrors the
 *  streaming logic in `getComponent` for an already-collected list. */
function overlayHints(candidates: readonly ComponentManifest[]): ComponentManifest | null {
  const winner = candidates[0]
  if (!winner) return null
  if (hasRenderingHints(winner)) return winner
  for (const candidate of candidates.slice(1)) {
    if (hasRenderingHints(candidate) && isPlausiblySameComponent(winner, candidate)) {
      return { ...winner, rendering: candidate.rendering }
    }
  }
  return winner
}

function hasRenderingHints(manifest: ComponentManifest): boolean {
  return Array.isArray(manifest.rendering) && manifest.rendering.length > 0
}

/**
 * I2 identity guard for the rendering-hint overlay: `true` only when `a`
 * and `b` both declare the SAME non-empty `designSystem`, or both declare
 * the SAME non-empty `importPath`. This is deliberately conservative in
 * the "unknown" direction — two manifests that are simply missing the
 * field on both sides are NOT treated as a match, since there is no
 * positive identity signal to trust. The case that must keep working
 * (`vue-dts-meta`'s auto-scanned props winner for a library component,
 * overlaid with that same package's generated hints from the on-disk hint
 * cache) matches on `importPath` — both sides stamp the package name.
 *
 * `importPath` is checked FIRST and, when both sides declare one, is
 * authoritative — including to DISPROVE a match. With per-package manifest
 * sources (`HintsCacheManifestSource`), two different packages can share a
 * `designSystem` label and a component name (e.g. two internal libraries
 * both stamped `designSystem: 'acme'` that each export an `Input`).
 * If both manifests name a concrete, non-empty `importPath` and those
 * differ, that is a positive signal they are NOT the same component —
 * matching designSystem alone must not override it, or the earlier
 * package's hints would graft onto the later package's props winner and
 * attribution would emit selectors for the wrong package. The
 * `designSystem` comparison is only consulted as a fallback when at least
 * one side is missing an `importPath` (the common first-party case).
 */
function isPlausiblySameComponent(a: ComponentManifest, b: ComponentManifest): boolean {
  if (a.importPath && b.importPath) return a.importPath === b.importPath
  if (a.designSystem && b.designSystem && a.designSystem === b.designSystem) return true
  return false
}

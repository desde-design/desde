/**
 * GroundingService — the single bundle of design-system grounding sources.
 *
 * Composes the three grounding seams so a consumer gets ONE handle to all of
 * "what does this design system offer":
 *   - component manifest (props / variants / rendering hints) — `ComponentManifestSource`
 *   - design tokens (color / space / type / radii / shadow) — `DesignTokenSource`
 *   - project conventions + doc index — `ProjectKnowledge`
 *
 * The point is a single source of truth: the inspector and the agent consume
 * the SAME sources, so they can't drift into divergent copies. Concrete
 * assembly (which manifest/token packages, which conventions) lives in a
 * composition root (`grounding/create-grounding-service.ts`); this interface
 * stays neutral.
 *
 * Lifecycle: `getManifestSource()` is async + memoized (building the composite
 * manifest is expensive); `tokens` is a ready source (its reads are async);
 * `getProjectKnowledge()` is sync over the process-cached loader.
 */
import type { ComponentManifestSource } from './manifest'
import type { DesignTokenSource } from './design-tokens'
import type { GroundingHealth } from './grounding-health'
import type { ProjectKnowledge } from './project-knowledge'

export interface GroundingService {
  /**
   * The composite component-manifest source (over the prototype's installed
   * libraries). Memoized; resolves to null when no root/manifest is available.
   */
  getManifestSource(): Promise<ComponentManifestSource | null>
  /** The composite design-token source (over the prototype's token packages). */
  readonly tokens: DesignTokenSource
  /** Project conventions + doc index (CLAUDE.md / AGENTS.md / .cursorrules). */
  getProjectKnowledge(): ProjectKnowledge
  /**
   * Health of the manifest bundle from the most recent `getManifestSource()`
   * build (per-source discovered/skipped/failed + runtime errors). Resolves
   * `null` when the manifest source hasn't been built yet this session —
   * callers must NOT force a build just to read health.
   */
  getGroundingHealth(): Promise<GroundingHealth | null>
}

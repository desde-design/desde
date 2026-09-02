/**
 * Shared types for the "add a design system" self-serve onboarding flow
 * (tasks/design-system-onboarding-app-flow-spec.md, Phase 6).
 *
 * The onboarding pipeline turns the already-shipped deterministic extraction
 * core (vue-dts-meta / react-dts-meta over installed `.d.ts`) into a
 * user-facing capability: a user points Desde at a design system (an
 * installed package, an npm spec, or a git repo) and the platform extracts
 * component manifests and lights up the inspector — with no per-library code.
 *
 * This file is the single contract every surface (orchestrator, registry,
 * API, UI) shares. Milestone 6.1 uses the registry types; the orchestrator /
 * coverage types are defined here too so later milestones extend one contract.
 */

import type { FrameworkId, DesignSystemId } from '@/editor/core/manifest'

/**
 * Where a design system's types come from. The orchestrator's `ingest` step
 * resolves each into a concrete `{ packageRoot, version, tsconfigPath }`.
 */
export type DesignSystemSource =
  /** Already present in the prototype's node_modules. */
  | { kind: 'installed'; package: string }
  /** Installed on demand from npm — `'name'` or `'name@version'`. */
  | { kind: 'npm'; spec: string }
  /** A git source — cloned + (optionally) built to emit `.d.ts`. */
  | { kind: 'repo'; url: string; ref?: string; subdir?: string }

/**
 * A design system the user has registered for this prototype. Layered over the
 * static defaults by `build-manifest-source.ts` so the inspector serves it.
 * `id` is the stable handle for list/remove; the orchestrator mints it.
 */
export interface RegisteredDesignSystem {
  /** Stable handle (list/remove). Re-adding the same id replaces the entry. */
  id: string
  /** How this system was added (for re-extraction / display). */
  source: DesignSystemSource
  /** npm package name, e.g. `@acme/design-system`. */
  package: string
  /** Resolved package version (cache key). */
  version: string
  framework: FrameworkId
  designSystem: DesignSystemId
  /** Module specifier the inspector/edit pipeline imports from. */
  importPath: string
  /**
   * Prototype-root-relative path to the package's ROOT, when it does NOT live
   * at `node_modules/<package>` — e.g. an `npm`-ingested package under
   * `.desde/ingested/…`. Omitted → resolve from `node_modules/<package>`.
   * Must resolve to a path INSIDE the prototype root.
   */
  packageRoot?: string
  /**
   * Prototype-root-relative tsconfig to extract THIS entry with, when the
   * prototype's own tsconfig can't resolve the package's deps — e.g. an
   * `npm`-ingested package carries the scratch install's own tsconfig. Omitted
   * → serving uses the prototype tsconfig. Must resolve INSIDE the prototype
   * root. Without this, a cache-miss re-extraction at serve time would use the
   * prototype tsconfig and fail to resolve the scratch package.
   */
  tsconfigPath?: string
  /**
   * Package-root-relative locations of the `.d.ts`. Vue: directories that
   * contain `*.vue.d.ts`. React: explicit `.d.ts` ENTRY FILE paths (a directory
   * is ignored — there's no source file for the checker). Omitted (or no valid
   * React file) → the extractor's default discovery (Vue: scan from package
   * root; React: resolve the package's declared types entry).
   */
  dtsRoots?: string[]
  /**
   * Full commit SHA the repo source was materialized from (repo-kind sources
   * only). Freshness groundwork: staleness checks compare this against the
   * remote ref. npm/installed entries never set it.
   */
  resolvedCommit?: string
  /**
   * repo-kind: whether the user consented to running the repo's build.
   * Recorded from the `OnboardRequest` at onboard time so a later refresh
   * can reuse the SAME consent without re-asking (the request body may still
   * override it explicitly). npm/installed entries never set it — the flag
   * is only meaningful for a `repo` source (§7 trust boundary).
   */
  allowBuild?: boolean
  /** ISO timestamp the entry was added. */
  addedAt: string
}

/**
 * Per-project, user-mutable registry of design systems, layered over the
 * static checked-in defaults. The local (editor) impl persists to
 * `.desde/design-systems.json`; the cloud (viewer) impl is Firestore.
 */
export interface RegistryStore {
  list(): Promise<RegisteredDesignSystem[]>
  /** Add or replace (by `id`) an entry. Idempotent on re-add. */
  add(entry: RegisteredDesignSystem): Promise<void>
  remove(id: string): Promise<void>
}

/** Outcome of running `listComponents()` once over a freshly-extracted source. */
export interface CoverageReport {
  /** Components the discovery step found. */
  discovered: number
  /** Components with ≥1 editable prop (the useful ones). */
  extracted: number
  /** Components found but with no own props after filtering. */
  empty: number
  /** Component names that were analyzed and threw. */
  failedComponents: string[]
  /** A few `component → [propNames]` samples, for a sanity-check in the UI. */
  sampleProps: Record<string, string[]>
}

/** A request to onboard a design system (the orchestrator's input — 6.3). */
export interface OnboardRequest {
  source: DesignSystemSource
  /** Prototype root whose tsconfig + node_modules anchor resolution. */
  prototypeRoot: string
  /** Display label; defaults to the package name. */
  designSystem?: DesignSystemId
  /** Permit running an untrusted repo's build (§7 trust boundary). */
  allowBuild?: boolean
}

/**
 * Coarse onboarding stages, in order. The API streams these as SSE `progress`
 * events so the UI can show "Installing… / Extracting…" during the (sometimes
 * 10–60s) npm-install + TS-checker walk.
 */
export type OnboardStage =
  | 'ingesting'
  | 'detecting'
  | 'extracting'
  | 'computing-coverage'
  | 'registering'

/** The orchestrator's result (6.3). */
export interface OnboardResult {
  package: string
  version: string
  framework: FrameworkId
  designSystem: DesignSystemId
  importPath: string
  coverage: CoverageReport
  /** Handle for list/remove (mirrors the registry entry id). */
  registryEntryId: string
}

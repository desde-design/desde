/**
 * Public surface of the design-system onboarding module
 * (tasks/design-system-onboarding-app-flow-spec.md, Phase 6). The CLI/viewer
 * route handlers import from here rather than reaching into individual files.
 */

export * from './types'
export { createLocalRegistryStore, LocalRegistryStore, REGISTRY_FILE_PATH } from './registry-store'
export { onboardDesignSystem, createDefaultOnboardDeps, type OnboardDeps } from './orchestrator'
export { detectFramework, findVueDtsRoot, type FrameworkDetection } from './detect-framework'
export {
  detectSubstrateStyleCapabilities,
  type DetectStyleCapabilitiesResult,
} from './detect-style-capabilities'
export { suggestDesignSystems, extractPackageName } from './suggest'
export { computeCoverage, type ComputeCoverageOptions } from './coverage'
export {
  buildRegisteredSources,
  type RegisteredSourceDeps,
  type BuildRegisteredSourcesArgs,
} from './build-registered-sources'
export {
  reconcileDesignSystems,
  registryEntryIdentity,
  type ReconcileEntryStatus,
  type ReconcileStatus,
  type ReconcileDeps,
  type ReconciliationStatusHolder,
} from './reconcile'
export {
  checkDesignSystemStaleness,
  type StalenessResult,
  type CheckDesignSystemStalenessDeps,
} from './staleness'

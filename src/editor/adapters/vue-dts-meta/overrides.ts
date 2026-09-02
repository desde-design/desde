/**
 * Per-package overrides for the auto-scanned `vue-dts-meta` sources.
 *
 * Auto-scan is the primary discovery mechanism — most installed Vue
 * libraries need zero entries here. This map is the *escape hatch* for:
 *
 *   1. Layouts that the default scan misses (custom `dist` roots).
 *   2. Packages that bleed internal helpers into `*.vue.d.ts` and need
 *      an `include`/`exclude` filter.
 *   3. Packages we want to suppress entirely (`enabled: false`).
 *   4. Packages whose extraction cost makes eager population unwanted
 *      on cold boots (`lazy: true` — defers checker-program build until
 *      the package's components are actually requested).
 *   5. Renaming the stamped `designSystem` away from the npm package
 *      name (so attribution / overlay sources can target it).
 *
 * Conventional keying: scoped npm name (`@org/pkg`) or bare name.
 */
import type { DesignSystemId } from '../../core'
import type { GenericVueDtsDiscoveryOptions } from './presets'

export interface PackageOverride {
  /** Skip this package entirely. Default: `true`. */
  enabled?: boolean
  /**
   * Override discovery options (dtsRoots / include / exclude / name
   * derivation). When omitted, the auto-scan picks the dtsRoot and
   * default-derives the name from the basename.
   */
  discovery?: GenericVueDtsDiscoveryOptions
  /**
   * Stamped `designSystem` id on every produced manifest. When omitted,
   * defaults to the package name. Override when the design-system
   * identity differs from the npm name — e.g. Acme DS is
   * `'acme-ds'`, not `'@acme/design-system'`.
   */
  designSystem?: DesignSystemId
  /**
   * Defer extraction until a component from this package is actually
   * requested. Trades a slower first request for a much faster boot
   * — relevant for very large catalogs (`@acme/icons` is ~530
   * components in a single TS program).
   *
   * Surfaces the bit; the wiring in `build-manifest-source.ts` decides
   * whether to honor it (today: it tags the source; the underlying
   * `VueDtsMetaManifestSource` already populates lazily on first
   * `listComponents()` / `getComponent()` call, so the practical effect
   * is a hint for future eager-prebuild optimizations).
   */
  lazy?: boolean
}

export const PACKAGE_OVERRIDES: Record<string, PackageOverride> = {
  /** Vue Flow — props extract cleanly from the deep `dist/container/**` tree. */
  '@vue-flow/core': { designSystem: 'vue-flow' },
}

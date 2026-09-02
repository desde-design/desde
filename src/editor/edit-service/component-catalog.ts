/**
 * Component catalog projection (Phase F1).
 *
 * Produces a slimmer view of `ComponentManifest`s tailored for the
 * Swap (F2) and Edit-component (F4) UIs. The "variant hints" field is
 * the load-bearing addition: each prop with a finite choice (enum,
 * boolean) becomes a variant axis; F3's isolation route renders one
 * cell per cartesian-product variant.
 *
 * Pure function. The web route + CLI handler both call it.
 */

import type {
  ComponentManifest,
  ComponentPropManifest,
} from '../core/manifest'

export interface VariantAxis {
  /** Prop name driving this axis. */
  prop: string
  /** Discrete values to render in the variant grid. */
  values: ReadonlyArray<string | number | boolean>
  /** Designer-facing label. Falls back to the prop name. */
  label?: string
}

export interface CatalogEntry {
  /** Stable id from the manifest. */
  id: string
  /** PascalCase Vue component name. */
  name: string
  /** Source file path relative to prototype root (when known). */
  file?: string
  /** Package name when provided by a design-system source. */
  packageName?: string
  /** True when sourced from a design-system manifest source. */
  isDesignSystem: boolean
  /** Free-form description from the manifest. */
  description?: string
  /** Full manifest. F2's Swap picker reads `props` for compatibility scoring. */
  manifest: ComponentManifest
  /**
   * Best-effort variant-axis discovery. F3's isolation route fans this
   * out into a grid (one row per axis, one cell per value). Empty when
   * no enumerable props exist.
   */
  variantHints: VariantAxis[]
}

/**
 * Project a manifest into a catalog entry. Pure; no I/O.
 *
 * Variant discovery rules:
 * - **Enum / union of literals** (control.kind === 'enum' OR
 *   control.options is a non-empty array): each option becomes a value.
 * - **Boolean**: `[false, true]` (false first so the "default off"
 *   visual reads first). Skipped if a default of `true` would make the
 *   "off" cell dead — currently we render both regardless; the F3 grid
 *   is a designer tool, not a docs page.
 * - **Required props with no obvious choice surface** are skipped — we
 *   can't pick a sensible default value for the variant grid without
 *   guessing.
 *
 * V1 punt list (deliberate):
 * - Doesn't read `*.stories.ts` for hand-curated variant sets. The
 *   storybook source already feeds the manifest; if a story enumerates
 *   variants, those land in `manifest.props[].control.options` already.
 * - Doesn't combine axes; F3 renders cartesian product on its end.
 * - String props are NOT used as variant axes — too open-ended.
 */
export function buildCatalogEntry(
  manifest: ComponentManifest,
): CatalogEntry {
  const isDesignSystem =
    manifest.designSystem !== 'first-party' &&
    manifest.designSystem !== 'unknown'

  const variantHints: VariantAxis[] = []
  for (const prop of manifest.props) {
    const axis = propToVariantAxis(prop)
    if (axis) variantHints.push(axis)
  }

  // File path lives on the manifest's source.declarations array. The
  // first declaration is conventionally the component-level one; for
  // adapters that emit one declaration per prop (vue-component-meta
  // sometimes does), we still want the component's own file, which
  // typically appears as the most-cited file across declarations.
  // First-decl heuristic is good enough for V1 — F4 refuses anything
  // in node_modules anyway.
  const file = manifest.source?.declarations?.[0]?.file

  return {
    id: manifest.id,
    name: manifest.name,
    file,
    packageName: manifest.importPath,
    isDesignSystem,
    description: manifest.description,
    manifest,
    variantHints,
  }
}

function propToVariantAxis(
  prop: ComponentPropManifest,
): VariantAxis | null {
  // Boolean props: always two-cell axis.
  if (prop.control?.kind === 'boolean' || prop.type === 'boolean') {
    return {
      prop: prop.name,
      values: [false, true],
      label: prop.name,
    }
  }

  // Finite-choice (enum) — control.options is the canonical source.
  if (prop.control?.kind === 'finite-choice') {
    const options = prop.control.options
    if (Array.isArray(options) && options.length > 0) {
      // Each ControlOption.value is a ManifestValue; filter to
      // primitives that the variant grid can pass as a prop. Objects
      // and arrays exist in some manifests (e.g. preset configurations)
      // but V1 doesn't support rendering them as variants.
      const primitive: Array<string | number | boolean> = []
      for (const opt of options) {
        const v = opt.value
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          primitive.push(v)
        }
      }
      if (primitive.length > 0 && primitive.length <= 12) {
        // Cap at 12 to avoid grid explosion. A 12-cell axis is already
        // chunky; if a designer needs more they can scroll the manifest
        // surface directly via the Inspector.
        return { prop: prop.name, values: primitive, label: prop.name }
      }
    }
  }

  return null
}

/** Build a catalog from an ordered list of manifests. */
export function buildCatalog(
  manifests: readonly ComponentManifest[],
): CatalogEntry[] {
  return manifests.map(buildCatalogEntry)
}

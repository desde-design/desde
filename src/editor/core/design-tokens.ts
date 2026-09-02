/**
 * Design-token grounding — the neutral seam.
 *
 * Sibling to {@link ComponentManifestSource} (manifest.ts), deliberately NOT
 * part of it: the manifest models per-component shape (props / variants /
 * rendering hints); this models the design system's GLOBAL primitives
 * (color / space / type / radii / shadow). Different shape, different
 * lifecycle — so a parallel interface, composed alongside the manifest, is the
 * right factoring (forcing tokens into the manifest extractor distorts both).
 *
 * One concrete impl per design-system token package (the package first), composed by
 * `CompositeDesignTokenSource`. Consumed by the inspector today (via the
 * `/api/editor/design-tokens` endpoint) and by the agent's grounding tools
 * once the GroundingService façade lands (see tasks/editor-grounding.md).
 *
 * Framework-neutral by nature — tokens are CSS custom properties, so unlike
 * `ComponentManifestSource` there is no `framework` field.
 */
import type { DesignSystemId } from './manifest'

export type TokenCategory =
  | 'color'
  | 'space'
  | 'font-size'
  | 'font-weight'
  | 'line-height'
  | 'border-radius'
  | 'border-width'
  | 'shadow'
  | 'other'

export interface DesignToken {
  /** Canonical name with leading dashes — `--acme-color-background-primary`. */
  name: string
  /** Resolved value as written in the source — `#0044f4`, `12px`, `rgba(...)`. */
  value: string
  /** Coarse category. */
  category: TokenCategory
  /**
   * Subcategory for grouping in the inspector — for color: `background`,
   * `text`, or `border`. For other categories may be empty.
   */
  subcategory?: string
  /** Human-readable description from the source comment, when present. */
  description?: string
  /** Source package this token came from (e.g. `@acme/design-tokens`). */
  source: string
}

/**
 * A source of design tokens for one design system. Mirrors
 * {@link ComponentManifestSource}'s list/get shape so the GroundingService
 * façade and any composite/cached wrappers treat both seams uniformly.
 */
export interface DesignTokenSource {
  /** Stable identifier for this source (e.g. `'acme-design-tokens'`, `'composite'`). */
  id: string
  /** Design system these tokens belong to (pairs with the manifest's `designSystem`). */
  designSystem: DesignSystemId
  /** All tokens this source provides. Empty (not an error) when the package is absent. */
  listTokens(): Promise<DesignToken[]>
  /** One token by canonical name (leading dashes included), or null if absent. */
  getToken(name: string): Promise<DesignToken | null>
}

/**
 * Design-token discovery — the ONE pinned composition path, mirroring how
 * `build-manifest-source.ts` pins `MANIFEST_SOURCE_ORDER` for manifests.
 *
 * The token data model and the `DesignTokenSource` seam live in the neutral
 * core + adapters:
 *   - {@link DesignToken} / {@link TokenCategory} / `DesignTokenSource` — `core/design-tokens.ts`
 *   - `CssCustomPropertiesTokenSource` (+ discovery) — `adapters/css-custom-properties/`
 *   - `CompositeDesignTokenSource` — `adapters/composite-tokens/`
 *
 * This module keeps the `loadDesignTokens({ prototypeRoot })` entry the
 * inspector endpoint (`/api/editor/design-tokens`) calls, and re-exports the
 * types + parser its existing consumers and tests import — so the relocation is
 * behavior-identical. New code (the GroundingService façade, agent grounding
 * tools) should depend on the `DesignTokenSource` seam directly, via
 * {@link buildDesignTokenSources} or the {@link DeferredDesignTokenSource}
 * wrapper.
 */
import { CompositeDesignTokenSource } from '../adapters/composite-tokens'
import { CssCustomPropertiesTokenSource } from '../adapters/css-custom-properties'
import { discoverTokenStylesheets } from '../adapters/css-custom-properties/discover'
import type { DesignToken, DesignTokenSource } from '../core/design-tokens'
import type { DesignSystemId } from '../core/manifest'

// Re-exports for backward compatibility — every current importer pulls these
// from here (`color-section.tsx`, `useDesignTokens.ts`, the CLI handler, and
// `design-tokens-source.test.ts`).
export type {
  DesignToken,
  TokenCategory,
  DesignTokenSource,
} from '../core/design-tokens'

/**
 * Token sources in load-bearing priority order. `CompositeDesignTokenSource`
 * is first-source-wins, so this order is the actual precedence ladder —
 * the prototype's own stylesheets shadow a package's declaration of the same
 * token name (a project re-declaring a library token wins, which is what the
 * cascade does at runtime too).
 */
export const TOKEN_SOURCE_ORDER = ['app-stylesheets', 'package-css'] as const

export type TokenSourceStep = (typeof TOKEN_SOURCE_ORDER)[number]

/**
 * Build the token-source stack for a prototype, in {@link TOKEN_SOURCE_ORDER}.
 * Pure discovery + construction — no composition, no error handling; callers
 * (`loadDesignTokens`, `DeferredDesignTokenSource`) wrap the result in a
 * `CompositeDesignTokenSource` with whatever error policy they need (default:
 * warn + skip a bad source, never blank the rest).
 */
export async function buildDesignTokenSources(
  prototypeRoot: string,
): Promise<DesignTokenSource[]> {
  const sources: DesignTokenSource[] = []

  const { appCssFiles, packageCss } = await discoverTokenStylesheets(prototypeRoot)

  // app-stylesheets — only constructed when there's something to read.
  if (appCssFiles.length > 0) {
    sources.push(
      new CssCustomPropertiesTokenSource({
        id: 'app-stylesheets',
        designSystem: 'first-party',
        cssFiles: appCssFiles,
        sourceLabel: 'app-stylesheets',
      }),
    )
  }

  // package-css — one source per discovered package.
  for (const { packageName, cssFiles } of packageCss) {
    sources.push(
      new CssCustomPropertiesTokenSource({
        id: `${packageName}-css`,
        designSystem: packageName,
        cssFiles,
        sourceLabel: packageName,
      }),
    )
  }

  return sources
}

interface LoadDesignTokensOptions {
  /** Absolute path to the prototype root (the dir containing `package.json`). */
  prototypeRoot: string
}

/**
 * Discover and parse the design tokens declared by the prototype.
 *
 * Builds the pinned composite token-source stack ({@link buildDesignTokenSources})
 * and returns its flat token list. Returns an empty array (not an error) when
 * no recognized token package is installed — design-token support is opt-in.
 *
 * Uses the composite's DEFAULT error handling (warn + skip): a single bad
 * source (a stylesheet that fails to read/parse) is dropped, not fatal to the
 * rest of the token set. This replaces the previous fail-loud override — with
 * three independently-discovered sources instead of one fixed vendor source,
 * "one bad app CSS file 500s the whole design-tokens endpoint" is a worse
 * failure mode than "one bad source's tokens are silently missing, logged to
 * the console."
 */
export async function loadDesignTokens(
  options: LoadDesignTokensOptions,
): Promise<DesignToken[]> {
  const source = new CompositeDesignTokenSource({
    sources: await buildDesignTokenSources(options.prototypeRoot),
  })
  return source.listTokens()
}

/**
 * Lazily-built `DesignTokenSource` wrapping {@link buildDesignTokenSources}.
 *
 * `buildDesignTokenSources` is async (stylesheet discovery reads the
 * registry store + walks the tree), but `GroundingService.tokens` must stay a
 * synchronous `DesignTokenSource` value (see `core/grounding.ts` — unchanged
 * by this task). This defers the async build to the first `listTokens()`/
 * `getToken()` call, composes the result with the composite's default
 * (warn + skip) error handling, and memoizes success — a failed build drops
 * the cached rejection so a transient failure doesn't wedge every later call.
 */
export class DeferredDesignTokenSource implements DesignTokenSource {
  readonly id = 'deferred-composite'
  readonly designSystem: DesignSystemId = 'composite'

  private readonly prototypeRoot: string
  private composite: Promise<CompositeDesignTokenSource> | null = null

  constructor(prototypeRoot: string) {
    this.prototypeRoot = prototypeRoot
  }

  private getComposite(): Promise<CompositeDesignTokenSource> {
    if (!this.composite) {
      this.composite = buildDesignTokenSources(this.prototypeRoot)
        .then((sources) => new CompositeDesignTokenSource({ sources }))
        .catch((err) => {
          this.composite = null
          throw err
        })
    }
    return this.composite
  }

  async listTokens(): Promise<DesignToken[]> {
    const composite = await this.getComposite()
    return composite.listTokens()
  }

  async getToken(name: string): Promise<DesignToken | null> {
    const composite = await this.getComposite()
    return composite.getToken(name)
  }
}

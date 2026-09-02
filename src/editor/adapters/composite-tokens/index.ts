/**
 * Composite `DesignTokenSource` — composes multiple token sources in priority
 * order. The token analogue of `adapters/composite/CompositeManifestSource`.
 *
 * - `listTokens()` walks every source and merges by token name, first-source-
 *   wins on duplicates (priority = array order).
 * - `getToken()` returns the first non-null match.
 * - A source that throws is logged via `onSourceError` and skipped — one bad
 *   package never blanks the whole token set.
 *
 * This is the neutrality seam: a project mixing a design-system package's
 * token CSS with its own local tokens file (or any number of further
 * packages) composes here with no consumer change, and the GroundingService
 * façade plugs into one uniform source.
 */
import type { DesignSystemId } from '../../core/manifest'
import type { DesignToken, DesignTokenSource } from '../../core/design-tokens'

export interface CompositeDesignTokenSourceOptions {
  /** Sources in priority order. First-source-wins on duplicate token names. */
  sources: readonly DesignTokenSource[]
  /** Design-system id reported by the composite. Defaults to the first source's. */
  designSystem?: DesignSystemId
  /** Optional logger for source-level errors. Defaults to console.warn. */
  onSourceError?: (sourceId: string, methodName: string, error: unknown) => void
}

export class CompositeDesignTokenSource implements DesignTokenSource {
  readonly id = 'composite'
  readonly designSystem: DesignSystemId

  private readonly sources: readonly DesignTokenSource[]
  private readonly onSourceError: NonNullable<
    CompositeDesignTokenSourceOptions['onSourceError']
  >

  constructor(options: CompositeDesignTokenSourceOptions) {
    this.sources = options.sources
    this.designSystem =
      options.designSystem ?? options.sources[0]?.designSystem ?? 'composite'
    this.onSourceError =
      options.onSourceError ??
      ((sourceId, methodName, error) => {
        console.warn(
          `[composite-tokens] ${sourceId}.${methodName} failed; skipping source:`,
          error,
        )
      })
  }

  async listTokens(): Promise<DesignToken[]> {
    const byName = new Map<string, DesignToken>()
    for (const source of this.sources) {
      let tokens: DesignToken[]
      try {
        tokens = await source.listTokens()
      } catch (error) {
        this.onSourceError(source.id, 'listTokens', error)
        continue
      }
      for (const token of tokens) {
        // First-source-wins: an earlier (higher-priority) source's token is
        // not overwritten by a later source declaring the same name.
        if (!byName.has(token.name)) byName.set(token.name, token)
      }
    }
    return Array.from(byName.values())
  }

  async getToken(name: string): Promise<DesignToken | null> {
    for (const source of this.sources) {
      try {
        const token = await source.getToken(name)
        if (token) return token
      } catch (error) {
        this.onSourceError(source.id, 'getToken', error)
      }
    }
    return null
  }
}

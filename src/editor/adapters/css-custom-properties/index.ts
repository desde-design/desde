/**
 * Generic `DesignTokenSource` over arbitrary prototype CSS custom
 * properties — THE token source (there is no per-design-system preset).
 *
 * It reads whatever CSS files a prototype declares (its own `:root`/`html`/Tailwind `@theme` stylesheets)
 * via the block-aware parser in `./parser` and classifies each declaration
 * with the keyword/namespace heuristics in `./classify`.
 *
 * Pure I/O against the given `cssFiles`; no network, no shell state. A
 * missing or unreadable file contributes no tokens (not an error) — token
 * support degrades gracefully per-file rather than failing the whole source:
 * "package not installed → []" is the contract, never an error.
 */
import * as fs from 'fs'
import type { DesignSystemId } from '../../core/manifest'
import type { DesignToken, DesignTokenSource } from '../../core/design-tokens'
import { parseCustomProperties } from './parser'
import { genericClassifier, tailwindThemeClassifier, type TokenClassifier } from './classify'

export { parseCustomProperties } from './parser'
export type { ParsedCustomProperty } from './parser'
export { genericClassifier, tailwindThemeClassifier } from './classify'
export type { Classification, TokenClassifier } from './classify'

export interface CssCustomPropertiesTokenSourceOptions {
  /** Stable identifier for this source instance. */
  id: string
  /** Design system these tokens belong to (pairs with the manifest's `designSystem`). */
  designSystem: DesignSystemId
  /** Absolute paths of stylesheets to read. Missing files are skipped silently. */
  cssFiles: readonly string[]
  /** Stamped on `DesignToken.source` (e.g. package name or `'app-stylesheets'`). */
  sourceLabel: string
  /**
   * Overrides the default per-declaration classifier selection
   * (`tailwindThemeClassifier` for `block === 'theme'`, else
   * `genericClassifier`) for every declaration in every file.
   */
  classifier?: TokenClassifier
}

/**
 * Reads a fixed set of CSS files, parses their `:root`/`html`/`@theme`
 * custom-property declarations, and classifies them into `DesignToken`s.
 *
 * `listTokens()` is memoized per instance, but
 * with mtime+size self-invalidation (Phase 2 carry-forward I1): a SUCCESSFUL
 * load is cached (the source can be long-lived, e.g. held by a
 * process-memoized `GroundingService`), but a rejection is dropped so a
 * transient read/parse failure doesn't wedge every later call until restart.
 * On every call the fingerprint of the known `cssFiles` (mtimeMs+size per
 * file, via a cheap `statSync` — microseconds for the handful of stylesheets
 * a prototype declares) is recomputed; a mismatch against the fingerprint the
 * cache was built from reloads instead of serving stale tokens. This only
 * catches edits to ALREADY-KNOWN files — a brand-new CSS file (one
 * `discoverTokenStylesheets` hadn't found yet) still requires a process
 * restart to be picked up, since the file list itself isn't re-discovered
 * here.
 */
export class CssCustomPropertiesTokenSource implements DesignTokenSource {
  readonly id: string
  readonly designSystem: DesignSystemId

  private readonly cssFiles: readonly string[]
  private readonly sourceLabel: string
  private readonly classifierOverride: TokenClassifier | undefined
  private loaded: Promise<DesignToken[]> | null = null
  private loadedFingerprint = ''

  constructor(options: CssCustomPropertiesTokenSourceOptions) {
    this.id = options.id
    this.designSystem = options.designSystem
    this.cssFiles = options.cssFiles
    this.sourceLabel = options.sourceLabel
    this.classifierOverride = options.classifier
  }

  /**
   * Cheap per-file `mtimeMs:size` fingerprint of `cssFiles`, joined into one
   * string — computed fresh on every call (statSync on a handful of known
   * files is microseconds). A missing/unreadable file contributes `0` (not
   * an error), matching `load()`'s "missing file → no tokens" contract; a
   * file going missing between loads still changes the fingerprint (real
   * `mtimeMs:size` vs `0`), so that transition is caught too. New CSS FILES
   * `discoverTokenStylesheets` hasn't found yet are out of scope — the file
   * LIST here is fixed at construction, so a brand-new stylesheet still
   * needs a process restart to be picked up.
   *
   * Public so a composing caller (e.g. the CLI edit-handler's style-context
   * memo) can key its own cache on token freshness without re-reading the
   * files itself.
   */
  fingerprint(): string {
    return this.cssFiles
      .map((f) => {
        try {
          const stat = fs.statSync(f)
          return `${stat.mtimeMs}:${stat.size}`
        } catch {
          return '0'
        }
      })
      .join(',')
  }

  async listTokens(): Promise<DesignToken[]> {
    const fingerprint = this.fingerprint()
    if (!this.loaded || fingerprint !== this.loadedFingerprint) {
      this.loadedFingerprint = fingerprint
      this.loaded = this.load().catch((err) => {
        this.loaded = null
        this.loadedFingerprint = ''
        throw err
      })
    }
    return this.loaded
  }

  async getToken(name: string): Promise<DesignToken | null> {
    const tokens = await this.listTokens()
    return tokens.find((t) => t.name === name) ?? null
  }

  private async load(): Promise<DesignToken[]> {
    const tokens: DesignToken[] = []
    for (const cssFile of this.cssFiles) {
      if (!fs.existsSync(cssFile)) continue
      const content = await fs.promises.readFile(cssFile, 'utf-8')
      for (const prop of parseCustomProperties(content)) {
        const classify =
          this.classifierOverride ??
          (prop.block === 'theme' ? tailwindThemeClassifier : genericClassifier)
        const { category, subcategory } = classify(prop.name, prop.value)
        tokens.push({
          name: prop.name,
          value: prop.value,
          category,
          ...(subcategory ? { subcategory } : {}),
          ...(prop.description ? { description: prop.description } : {}),
          source: this.sourceLabel,
        })
      }
    }
    return tokens
  }
}

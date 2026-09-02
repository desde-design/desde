/**
 * `StorybookUrlManifestSource` — fetches a deployed Storybook's
 * `index.json` and emits **stub** manifests, one per discovered
 * component. Useful as a *discovery* pass for design systems that
 * already publish a Storybook on the public web; it is **not** a
 * full schema source.
 *
 * Why "discovery only": Storybook 7+ exposes `index.json` (or
 * `stories.json` in v6) listing every story with its `id`, `title`,
 * `name`, `tags`, and (since v7) `componentPath`/`importPath`. It does
 * NOT expose `argTypes` / `args` over HTTP — those are computed at
 * preview-render time inside the iframe and only reachable by
 * executing the JS bundle in a browser. Without a headless browser we
 * cannot extract prop schemas from a deployed Storybook reliably
 * across versions.
 *
 * What this adapter does:
 * - Fetches the Storybook's `index.json` (falls back to `stories.json`
 *   for v6 deployments).
 * - Groups entries by `title`'s last segment (e.g. `"Components/Button"`
 *   → component name `"Button"`); skips MDX docs entries.
 * - Emits one `ComponentManifest` per unique component with empty
 *   `props`/`slots`/`events`. The inspector then knows the component
 *   exists (no more "no manifest available" warning) but has no
 *   editable schema yet — full schema requires CSF in the prototype
 *   repo or a TS-declaration preset.
 *
 * What this adapter does NOT do:
 * - Parse `argTypes`/`args` from the deployed bundle (would need a
 *   headless browser; brittle across Storybook versions).
 * - Auto-author CSF on the customer's behalf.
 *
 * Caching: the manifest route currently reconstructs adapter
 * instances per request. To prevent every inspector click from
 * triggering a fresh outbound fetch, this module keeps a process-wide
 * cache keyed by `<baseUrl>::<ttlMs>`. Two source instances pointed
 * at the same URL share entries; clearing happens automatically on
 * TTL expiry. Tests pass `ttlMs: 0` to disable the cache and a
 * `fetch` stub for determinism.
 */
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'
import { kebabCase } from '../kebab-case'

export interface StorybookUrlManifestSourceOptions {
  /**
   * Base URL of the deployed Storybook (e.g.
   * `https://acme-ds.example.com`). The adapter probes
   * `<url>/index.json` and falls back to `<url>/stories.json`.
   */
  baseUrl: string
  /** Framework id stamped on produced manifests. Defaults to `'vue3'`. */
  framework?: FrameworkId
  /** Design-system id stamped on produced manifests (required). */
  designSystem: DesignSystemId
  /**
   * Optional bare-import path baked into manifests. Customer-supplied
   * because the Storybook deployment doesn't tell us how to import
   * the components in the prototype's source code.
   */
  importPath?: string
  /**
   * Cache TTL for the fetched index. Defaults to 60s; set to 0 to
   * disable caching. Tests pass `Infinity` to memoize across runs and
   * `fetch: () => ...` to provide deterministic input.
   */
  ttlMs?: number
  /**
   * Override the underlying fetch implementation. Defaults to the
   * global `fetch`. Tests pass a stub.
   */
  fetch?: typeof fetch
}

/**
 * Subset of the Storybook v7+ `index.json` schema we rely on.
 * Documented at https://storybook.js.org/docs/api/main-config-stories
 * (look for `IndexEntry`).
 */
interface StorybookIndexEntry {
  id: string
  title: string
  name?: string
  type?: 'story' | 'docs'
  tags?: string[]
  importPath?: string
  componentPath?: string
}

interface StorybookV7Index {
  v: number
  entries: Record<string, StorybookIndexEntry>
}

/**
 * Subset of the Storybook v6 `stories.json` schema we rely on.
 * Same essential shape; renamed in v7.
 */
interface StorybookV6Index {
  v: number
  stories: Record<string, StorybookIndexEntry>
}

const DEFAULT_TTL_MS = 60_000

/**
 * Process-wide cache shared by all `StorybookUrlManifestSource`
 * instances. Keyed by `<baseUrl>::<ttlMs>` so two sources with the
 * same URL but different TTLs (unusual, but possible) don't collide.
 *
 * Why module scope: the manifest route reconstructs adapter instances
 * per request. Without a shared cache, every inspector click would
 * trigger a fresh outbound HTTP fetch — both wasteful and visibly
 * laggy.
 */
const sharedFetchCache = new Map<
  string,
  { at: number; entries: Map<string, ComponentManifest> }
>()

/**
 * In-flight fetch promises, keyed identically to `sharedFetchCache`.
 * Coalesces concurrent cache misses: if two requests hit the same URL
 * before either has finished fetching, the second awaits the first
 * rather than firing a duplicate outbound request. Closes the codex
 * re-review's P3 (cache thunder under bursty inspector usage).
 */
const inFlightFetches = new Map<string, Promise<Map<string, ComponentManifest>>>()

/**
 * Test helper: reset the module-wide caches between tests so per-test
 * fetch counts are predictable. Production code does not need this.
 */
export function _resetStorybookUrlCacheForTests(): void {
  sharedFetchCache.clear()
  inFlightFetches.clear()
}

export class StorybookUrlManifestSource implements ComponentManifestSource {
  readonly id = 'storybook-url'
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly options: StorybookUrlManifestSourceOptions
  private readonly fetchImpl: typeof fetch
  private readonly ttlMs: number

  constructor(options: StorybookUrlManifestSourceOptions) {
    this.options = options
    this.framework = options.framework ?? 'vue3'
    this.designSystem = options.designSystem
    this.fetchImpl = options.fetch ?? fetch
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  async listComponents(): Promise<ComponentManifest[]> {
    const entries = await this.populate()
    return Array.from(entries.values())
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    const entries = await this.populate()
    return entries.get(name) ?? null
  }

  invalidate(): void {
    sharedFetchCache.delete(this.cacheKey())
  }

  private cacheKey(): string {
    return `${this.options.baseUrl}::${this.ttlMs}`
  }

  private async populate(): Promise<Map<string, ComponentManifest>> {
    const key = this.cacheKey()
    if (this.ttlMs !== 0) {
      const cached = sharedFetchCache.get(key)
      if (cached && Date.now() - cached.at < this.ttlMs) {
        return cached.entries
      }
      // Coalesce concurrent misses: if a fetch is already in flight
      // for this key, await it rather than firing a duplicate request.
      const inFlight = inFlightFetches.get(key)
      if (inFlight) return inFlight
    }
    const promise = this.fetchAndBuild()
      .then((entries) => {
        if (this.ttlMs !== 0) {
          sharedFetchCache.set(key, { at: Date.now(), entries })
        }
        return entries
      })
      .finally(() => {
        // Always clear the in-flight slot after settle so future
        // cache misses (post-TTL) can fetch again. Keeping the
        // promise around past settle would deadlock the next miss.
        if (this.ttlMs !== 0) inFlightFetches.delete(key)
      })
    if (this.ttlMs !== 0) inFlightFetches.set(key, promise)
    return promise
  }

  private async fetchAndBuild(): Promise<Map<string, ComponentManifest>> {
    const out = new Map<string, ComponentManifest>()
    const index = await this.fetchIndex()
    if (!index) return out

    const entries = isV7(index) ? index.entries : index.stories

    // Group story entries by component. We use the last segment of
    // `title` as the canonical component name (e.g.
    // `"Forms/Inputs/Button"` → `"Button"`). This matches Vue's
    // runtime registration name for most well-organized Storybooks
    // and is the same name the bridge resolves selections against.
    const byComponent = new Map<string, StorybookIndexEntry[]>()
    for (const entry of Object.values(entries)) {
      // Skip MDX docs pages and tag-only entries — we want story-shaped
      // entries that correspond to actual components.
      if (entry.type === 'docs') continue
      const componentName = lastTitleSegment(entry.title)
      if (!componentName) continue
      const bucket = byComponent.get(componentName)
      if (bucket) bucket.push(entry)
      else byComponent.set(componentName, [entry])
    }

    for (const [componentName, group] of byComponent) {
      const manifest: ComponentManifest = {
        id: `${this.designSystem}.${kebabCase(componentName)}`,
        name: componentName,
        framework: this.framework,
        designSystem: this.designSystem,
        importPath: this.options.importPath,
        // Empty props by design — see file header. The inspector will
        // render the component identity + DOM editing without warning.
        props: [],
        slots: [],
        events: [],
        extensions: {
          // Surface the Storybook URL so a future "open in Storybook"
          // button has somewhere to point. No behavioral effect today.
          docsUrl: `${this.options.baseUrl.replace(/\/$/, '')}/?path=/story/${group[0].id}`,
          storybookId: group[0].id,
        },
        source: {
          framework: this.framework,
          designSystem: this.designSystem,
          extractor: 'storybook-url',
          declarations: group[0].importPath
            ? [{ file: group[0].importPath }]
            : undefined,
        },
      }
      out.set(componentName, manifest)
    }

    return out
  }

  private async fetchIndex(): Promise<StorybookV7Index | StorybookV6Index | null> {
    const base = this.options.baseUrl.replace(/\/$/, '')
    // v7+ first; fall back to v6.
    for (const path of ['/index.json', '/stories.json']) {
      const url = `${base}${path}`
      try {
        const res = await this.fetchImpl(url)
        if (!res.ok) continue
        const data = (await res.json()) as unknown
        if (isV7(data) || isV6(data)) return data
      } catch {
        // Network/JSON error — try the next probe.
      }
    }
    return null
  }
}

function isV7(data: unknown): data is StorybookV7Index {
  return (
    typeof data === 'object' &&
    data !== null &&
    'entries' in data &&
    typeof (data as { entries: unknown }).entries === 'object'
  )
}

function isV6(data: unknown): data is StorybookV6Index {
  return (
    typeof data === 'object' &&
    data !== null &&
    'stories' in data &&
    typeof (data as { stories: unknown }).stories === 'object'
  )
}

function lastTitleSegment(title: string): string | null {
  const parts = title.split('/').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  return parts[parts.length - 1]
}


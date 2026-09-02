/**
 * `RemoteManifestSource` — client-side adapter that proxies manifest
 * lookups to a server endpoint. Lets the editor page run as a "use
 * client" component while the heavy ingestion sources (LocalVue,
 * Storybook static parsing, etc.) execute in Node on the server where
 * `node:fs` is available.
 *
 * Wire format:
 *   GET <endpoint>             → ComponentManifest[]
 *   GET <endpoint>?name=Foo    → ComponentManifest | null (404 → null)
 *
 * The server is expected to construct a `CompositeManifestSource` with
 * whatever sources it wants (LocalVue, Storybook, bundled Acme DS)
 * and forward to it.
 */
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'
import { isIdentifyingComponentName } from '../../attribution/types'

export interface RemoteManifestSourceOptions {
  /** API endpoint URL. Examples: `/api/editor/manifest`, full URL for cross-origin. */
  endpoint: string
  /** Framework id reported by `source.framework`. Defaults to 'vue3'. */
  framework?: FrameworkId
  /** Design-system id reported by `source.designSystem`. Defaults to 'remote'. */
  designSystem?: DesignSystemId
  /**
   * Custom fetch implementation. Defaults to the global `fetch`. Useful
   * for testing (inject a stub) or for adding auth headers via a
   * wrapper.
   */
  fetchFn?: typeof fetch
}

export class RemoteManifestSource implements ComponentManifestSource {
  readonly id = 'remote'
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly endpoint: string
  private readonly fetchFn: typeof fetch

  constructor(options: RemoteManifestSourceOptions) {
    this.endpoint = options.endpoint
    this.framework = options.framework ?? 'vue3'
    this.designSystem = options.designSystem ?? 'remote'
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async listComponents(): Promise<ComponentManifest[]> {
    const res = await this.fetchFn(this.endpoint, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(
        `RemoteManifestSource: GET ${this.endpoint} returned ${res.status}`,
      )
    }
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) {
      throw new Error(
        `RemoteManifestSource: GET ${this.endpoint} returned non-array`,
      )
    }
    return body as ComponentManifest[]
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    // A name that cannot identify a component (the bridge's `<anonymous>`
    // placeholder, or blank) can never match a manifest, so the request is a
    // guaranteed 404 — pure waste on the wire and a console error the user reads
    // as a real failure (F9). Guarded at the network boundary so no call path
    // can reintroduce it; `null` is the same answer the 404 produced.
    if (!isIdentifyingComponentName(name)) return null
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}`
    const res = await this.fetchFn(url, {
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(
        `RemoteManifestSource: GET ${url} returned ${res.status}`,
      )
    }
    const body = (await res.json()) as unknown
    if (body === null) return null
    return body as ComponentManifest
  }
}

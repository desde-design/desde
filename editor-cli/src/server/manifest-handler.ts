/**
 * Manifest and catalog handlers for the CLI HTTP server
 * (`GET /api/editor/manifest` and `GET /api/editor/catalog`).
 *
 * These read-only GET endpoints drive the shell's `RemoteManifestSource`
 * (inspector "Variants and props") and the catalog fetch (Swap /
 * Edit-component variant grid). Without them every component falls back
 * to DOM-only editing: the inspector shows "No manifest available …
 * only DOM properties are editable" even for components whose props are
 * fully introspectable. Both endpoints reuse `buildManifestSource()`.
 *
 * The source is built against the CANONICAL repo root, not the session
 * worktree: the prototype's `node_modules` and its tsconfig
 * live in the user's checked-out repo, not the per-session worktree
 * branch, so building against the worktree would discover no library
 * manifests.
 *
 * Caching: the composite source is memoized by the GroundingService (keyed by
 * canonical root, lifted up from this handler in the Phase 2 grounding refactor)
 * so the Volar program backing first-party extraction isn't reconstructed on
 * every inspector click. The tradeoff: a component file ADDED mid-session
 * isn't discovered until restart. Acceptable —
 * the inspector resolves by clicking already-rendered components, and
 * library prop schemas (the common case) don't change at runtime.
 */

import type {
  ComponentManifestSource,
  GroundingService,
} from "../../../src/editor/core"

export interface ManifestHandlerResult {
  status: number
  body: unknown
  /** Extra response headers (e.g. Cache-Control). */
  headers?: Record<string, string>
}

const NO_STORE = { "Cache-Control": "no-store" } as const

/**
 * `GET /api/editor/manifest` and `…?name=<Component>`.
 *   - no name → `ComponentManifest[]`
 *   - name, found → `ComponentManifest`
 *   - name, not found → 404 with `null` body
 *
 * The manifest source comes from the shared {@link GroundingService} (one
 * source of truth, also consumed by the agent), not built here. `getGrounding`
 * is resolved INSIDE the try so a grounding-construction failure produces this
 * endpoint's JSON 500 (`failed-to-build-source`), not the server's generic 500.
 */
export async function handleManifestRequest(
  getGrounding: () => Promise<GroundingService>,
  name: string | null,
): Promise<ManifestHandlerResult> {
  let source: ComponentManifestSource | null
  try {
    const grounding = await getGrounding()
    source = await grounding.getManifestSource()
  } catch (err) {
    return {
      status: 500,
      body: { error: "failed-to-build-source", detail: (err as Error).message },
    }
  }
  if (!source) {
    return {
      status: 503,
      body: { error: "Manifest source unavailable (prototype root unreadable)" },
    }
  }

  try {
    if (name) {
      const manifest = await source.getComponent(name)
      if (!manifest) {
        return { status: 404, body: null, headers: { ...NO_STORE } }
      }
      return { status: 200, body: manifest, headers: { ...NO_STORE } }
    }
    const list = await source.listComponents()
    return { status: 200, body: list, headers: { ...NO_STORE } }
  } catch (err) {
    return {
      status: 500,
      body: {
        error: "manifest-resolution-failed",
        detail: (err as Error).message,
      },
    }
  }
}

/** `GET /api/editor/catalog` → `CatalogEntry[]`. */
export async function handleCatalogRequest(
  getGrounding: () => Promise<GroundingService>,
): Promise<ManifestHandlerResult> {
  let source: ComponentManifestSource | null
  try {
    const grounding = await getGrounding()
    source = await grounding.getManifestSource()
  } catch (err) {
    return {
      status: 500,
      body: { error: "failed-to-build-source", detail: (err as Error).message },
    }
  }
  if (!source) {
    return {
      status: 503,
      body: { error: "Manifest source unavailable (prototype root unreadable)" },
    }
  }

  try {
    const { buildCatalog } = await import(
      "../../../src/editor/edit-service/component-catalog.js"
    )
    const manifests = await source.listComponents()
    return { status: 200, body: buildCatalog(manifests), headers: { ...NO_STORE } }
  } catch (err) {
    return {
      status: 500,
      body: { error: "catalog-build-failed", detail: (err as Error).message },
    }
  }
}

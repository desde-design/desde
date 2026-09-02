/**
 * Built-prototype asset storage seam.
 *
 * Assets are addressed by `(deploymentId, relPath)` — the deployment id
 * IS the storage key, so nothing needs to persist a path. One impl per
 * profile: local disk (selfhost) and GCS (gcp, Phase 4).
 */

export interface StoredAsset {
  body: Buffer
  contentType: string
}

/**
 * Thrown by an `AssetStore` when a `deploymentId`/`relPath` pair fails path
 * validation (traversal, absolute path, bad deployment id, etc.) — as
 * opposed to a genuine I/O fault (permissions, disk error). Callers that
 * need to answer a request (e.g. the serve router) use this to distinguish
 * "attacker-controlled bad input" (400) from "server fault" (500): only
 * `UnsafePathError` should ever be turned into a 4xx.
 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafePathError"
  }
}

export interface AssetStore {
  put(deploymentId: string, relPath: string, body: Buffer): Promise<void>
  /**
   * Resolves null when the asset does not exist; rejects with
   * `UnsafePathError` on an unsafe path (callers use this to distinguish a
   * client-fault 400 from any other, genuine I/O fault, which should
   * propagate as a 5xx instead).
   */
  get(deploymentId: string, relPath: string): Promise<StoredAsset | null>
  deleteDeployment(deploymentId: string): Promise<void>
}

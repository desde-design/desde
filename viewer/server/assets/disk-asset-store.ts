import { chmodSync, mkdirSync, promises as fs } from "node:fs"
import { dirname, join, normalize, resolve, sep } from "node:path"
import { contentTypeFor } from "../serve/mime"
import { UnsafePathError, type AssetStore, type StoredAsset } from "./types"

/**
 * Default (selfhost) AssetStore: `<rootDir>/<deploymentId>/<relPath>`.
 *
 * Every path is validated before it touches the filesystem — the input
 * comes from tar entries and from URLs, both attacker-influenced.
 */
/**
 * File mode for stored assets, and directory mode for the tree holding
 * them (audit K10). A private project's built prototype is its source
 * compiled — on a shared machine the process umask made every byte of it
 * readable by any local account, while the HTTP layer above was carefully
 * enforcing member-only access to the same content. 0700/0600 makes the
 * filesystem agree with `authorize.ts`.
 */
const ASSET_DIR_MODE = 0o700
const ASSET_FILE_MODE = 0o600

export class DiskAssetStore implements AssetStore {
  constructor(private readonly rootDir: string) {
    // Create the root ONCE, with the mode we want, rather than letting the
    // first `put` create it as a side effect — `mkdir`'s `mode` applies only
    // on creation, so whoever makes the directory first decides its mode for
    // good. Sync in the constructor so no request can race it.
    mkdirSync(rootDir, { recursive: true, mode: ASSET_DIR_MODE })
    try {
      // Tighten a root that already existed (upgrade, mounted volume).
      // Best-effort: a foreign-owned mount is a deployment choice, not a
      // reason to refuse to boot.
      chmodSync(rootDir, ASSET_DIR_MODE)
    } catch {
      // Ignore — see above.
    }
  }

  /**
   * Validates that deploymentId is a safe identifier using a positive allowlist.
   * Rejects any id that could escape the per-deployment sandbox, including ".",
   * "", "..", or paths with separators.
   */
  private assertValidDeploymentId(deploymentId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(deploymentId)) {
      throw new UnsafePathError(`Invalid asset path: bad deployment id "${deploymentId}"`)
    }
  }

  private resolveSafe(deploymentId: string, relPath: string): string {
    this.assertValidDeploymentId(deploymentId)

    const normalizedPath = normalize(relPath)
    // Remove leading .. components to prevent upward traversal.
    // Backslash traversal is rejected as a side effect of the mismatch check below:
    // path.normalize treats backslash as a literal character on POSIX systems.
    const cleaned = normalizedPath.replace(/^(\.\.(\/|\\|$))+/, "")

    // Reject if the path was modified by normalization (traversal attempt) or starts with absolute separator.
    if (relPath.startsWith("/") || relPath.startsWith("\\") || cleaned !== normalizedPath) {
      throw new UnsafePathError(`Invalid asset path: ${relPath}`)
    }

    // Reject paths that normalize to "." or empty (would target the deployment dir itself).
    if (cleaned === "." || cleaned === "") {
      throw new UnsafePathError(`Invalid asset path: ${relPath}`)
    }

    const base = resolve(this.rootDir, deploymentId)
    const target = resolve(base, cleaned)
    // Ensure target is strictly inside the deployment directory.
    // Reject the deployment directory itself and any path outside it.
    if (!target.startsWith(base + sep)) {
      throw new UnsafePathError(`Invalid asset path: ${relPath}`)
    }
    return target
  }

  async put(deploymentId: string, relPath: string, body: Buffer): Promise<void> {
    const target = this.resolveSafe(deploymentId, relPath)
    await fs.mkdir(dirname(target), { recursive: true, mode: ASSET_DIR_MODE })
    // `mode` on writeFile applies only on creation, so a redeploy that
    // overwrites an existing asset would keep the old (umask) mode. Chmod
    // explicitly — the same reason the Editor's session-info writer does.
    await fs.writeFile(target, body, { mode: ASSET_FILE_MODE })
    await fs.chmod(target, ASSET_FILE_MODE)
  }

  async get(deploymentId: string, relPath: string): Promise<StoredAsset | null> {
    const target = this.resolveSafe(deploymentId, relPath)
    try {
      const body = await fs.readFile(target)
      return { body, contentType: contentTypeFor(relPath) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "EISDIR") return null
      throw error
    }
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    this.assertValidDeploymentId(deploymentId)
    await fs.rm(join(this.rootDir, deploymentId), { recursive: true, force: true })
  }
}

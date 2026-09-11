import { cp, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { StorageAdapter } from "../storage/types"

/**
 * Where a server deployment's checkout lives: `<dataDir>/checkouts/<id>/`.
 * The id is storage's UUID, but the path is still refused when it is not a
 * single plain segment, so this can never be asked to write outside the root.
 */
export function checkoutDirFor(checkoutsRoot: string, deploymentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(deploymentId)) {
    throw new Error(`Refusing a checkout path for deployment id "${deploymentId}"`)
  }
  return resolve(join(checkoutsRoot, deploymentId))
}

/**
 * Moves a finished checkout into place. A rename when the temp dir and the
 * data dir share a filesystem; a copy then delete when they do not (Docker's
 * `/tmp` and `/data` volume usually do not). Replaces whatever was there.
 */
export async function keepCheckout(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  await rm(to, { recursive: true, force: true })
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await cp(from, to, { recursive: true, verbatimSymlinks: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Checkouts carry `node_modules`, so they keep fewer than assets
 * (`DEPLOYMENT_RETENTION_COUNT` is 5): the active one plus the newest other.
 */
export const CHECKOUT_RETENTION_COUNT = 2

/**
 * Same shape as `pruneSupersededDeploymentAssets`: best effort, one failure
 * does not stop the sweep, the active id is always kept. `beforeRemove` lets
 * the process manager stop a process whose directory is about to go.
 */
export async function pruneSupersededCheckouts(
  storage: Pick<StorageAdapter, "listDeployments">,
  checkoutsRoot: string,
  projectId: string,
  keepActiveId: string,
  beforeRemove?: (deploymentId: string) => Promise<void>,
): Promise<void> {
  const deployments = await storage.listDeployments(projectId)
  const rest = deployments.filter((d) => d.id !== keepActiveId)
  const stale = rest.slice(CHECKOUT_RETENTION_COUNT - 1)
  for (const d of stale) {
    try {
      await beforeRemove?.(d.id)
      await rm(checkoutDirFor(checkoutsRoot, d.id), { recursive: true, force: true })
    } catch (error) {
      console.error(`[viewer] failed to prune checkout for deployment ${d.id}:`, error)
    }
  }
}

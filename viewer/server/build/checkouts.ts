import { cp, mkdir, rename, rm, stat } from "node:fs/promises"
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
 * the process manager stop a process whose directory is about to go;
 * `afterRemove` lets it forget that id entirely once the directory is
 * actually gone.
 *
 * `listDeployments` returns a project's WHOLE history, so every deployment
 * outside the retention window reaches this loop again on every later
 * activation — including ones whose checkout was already removed by a
 * PREVIOUS prune. Without the stat check below, `beforeRemove` (wired to the
 * process manager's `retire()`) ran for every one of those every time: a
 * permanent map entry created per id, forever, for quadratic and pointless
 * work (codex round 3, item 4). Stating first and skipping both hooks when
 * there is nothing there closes that: past the first prune that actually
 * removes a given id's directory, `afterRemove` (wired to `forget()`) drops
 * the map entry, and every later visit to that same id finds no directory
 * and does nothing at all.
 */
export async function pruneSupersededCheckouts(
  storage: Pick<StorageAdapter, "listDeployments">,
  checkoutsRoot: string,
  projectId: string,
  keepActiveId: string,
  beforeRemove?: (deploymentId: string) => Promise<void>,
  afterRemove?: (deploymentId: string) => Promise<void>,
): Promise<void> {
  const deployments = await storage.listDeployments(projectId)
  // Only deployments that HAVE a checkout count toward the window (codex
  // round 9). A failed build or a static one has none, and when such a row
  // was newer than the previous server build it took the retained slot on
  // paper while the real previous checkout was pruned: a pinned review of
  // it broke and there was nothing to roll back to. The stat here is the
  // same one the loop below used to do; it simply moved ahead of the slice.
  const rest: string[] = []
  for (const d of deployments) {
    if (d.id === keepActiveId) continue
    const present = await stat(checkoutDirFor(checkoutsRoot, d.id)).then(
      () => true,
      () => false,
    )
    if (present) rest.push(d.id)
  }
  const stale = rest.slice(CHECKOUT_RETENTION_COUNT - 1)
  for (const id of stale) {
    const dir = checkoutDirFor(checkoutsRoot, id)
    try {
      await beforeRemove?.(id)
      await rm(dir, { recursive: true, force: true })
      await afterRemove?.(id)
    } catch (error) {
      console.error(`[viewer] failed to prune checkout for deployment ${id}:`, error)
    }
  }
}

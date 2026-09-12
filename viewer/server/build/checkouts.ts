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
 * (`DEPLOYMENT_RETENTION_COUNT` is 5): the active one plus the newest other
 * deployment that actually finished.
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
  // The listing and the presence checks are best effort too, same as the
  // removal loop below (codex round 11, Fix 3). Both callers of this
  // function await it AFTER marking a deployment deployed and active, so a
  // rejection here used to unwind a successful activation: the upload route
  // marked the deployment failed and deleted the assets it had just
  // published, and the build queue rewrote a successful build as failed. A
  // transient storage error must not be able to do either.
  let deployments: Awaited<ReturnType<StorageAdapter["listDeployments"]>>
  try {
    deployments = await storage.listDeployments(projectId)
  } catch (error) {
    console.error(`[viewer] failed to prune checkouts for project ${projectId}:`, error)
    return
  }
  // Two conditions decide whether a deployment can hold the retained slot.
  //
  // It must HAVE a checkout (codex round 9). A failed build or a static one
  // has none, and when such a row was newer than the previous server build it
  // took the retained slot on paper while the real previous checkout was
  // pruned: a pinned review of it broke and there was nothing to roll back to.
  //
  // And it must have FINISHED (codex round 13). The runner moves a server
  // build's checkout into place before the deployment and project rows are
  // written, so a failure at either write leaves a directory behind under a
  // row that never went live. The presence check alone read that as the
  // retained previous checkout — newer than the last good one, so it took the
  // slot and the last good one was deleted. A row that is not `deployed` is
  // nobody's rollback target, so it is swept rather than kept.
  const retainable: string[] = []
  const unfinished: string[] = []
  try {
    for (const d of deployments) {
      if (d.id === keepActiveId) continue
      const present = await stat(checkoutDirFor(checkoutsRoot, d.id)).then(
        () => true,
        () => false,
      )
      if (!present) continue
      // A build in flight owns its checkout: the runner has already moved
      // it into place and is about to activate it. An upload activating at
      // that moment must leave it alone (codex round 21: it was swept as
      // unfinished, and the build failed mid-copy or went live with no
      // checkout). Uploads do not go through the build queue, so the two
      // are not serialised; this is the rule that keeps them apart.
      if (d.status === "building") continue
      if (d.status === "deployed") retainable.push(d.id)
      else unfinished.push(d.id)
    }
  } catch (error) {
    console.error(`[viewer] failed to prune checkouts for project ${projectId}:`, error)
    return
  }
  // The active deployment takes one of the retained slots only when it has
  // a checkout of its own. An active static upload has none, and reserving
  // a slot for it pruned one more server checkout than the rule allows
  // (codex round 18).
  const activeHasCheckout = await stat(checkoutDirFor(checkoutsRoot, keepActiveId)).then(
    () => true,
    () => false,
  )
  const retainOthers = CHECKOUT_RETENTION_COUNT - (activeHasCheckout ? 1 : 0)
  const stale = [...unfinished, ...retainable.slice(retainOthers)]
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

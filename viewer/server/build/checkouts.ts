import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Deployment, StorageAdapter } from "../storage/types"

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
 * Removes every checkout under `checkoutsRoot` whose deployment never went
 * live, and answers how many (codex round 33). The runner moves a server
 * build's checkout into place BEFORE the deployment and project rows are
 * written; a Viewer killed between the two leaves a directory, `node_modules`
 * and all, under a row that boot marks `failed` (or under no row at all),
 * and nothing revisited it: `pruneSupersededCheckouts` runs only when that
 * project next activates, which a project nobody builds again never does.
 * `server/index.ts` awaits this at boot, after `markInterruptedBuildsFailed`
 * and after the process manager's orphan reap, so no child can be running
 * out of a directory this removes. Best effort per directory.
 */
export async function reconcileCheckouts(
  storage: Pick<StorageAdapter, "getDeployment" | "getProject" | "updateDeployment">,
  checkoutsRoot: string,
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(checkoutsRoot)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    try {
      const dir = checkoutDirFor(checkoutsRoot, name)
      const row = await storage.getDeployment(name)
      if (row !== null && row.status === "deployed" && (await wentLive(storage, row))) continue
      await rm(dir, { recursive: true, force: true })
      removed++
      if (row !== null && row.status === "deployed") {
        // Marked `deployed` but never activated (codex round 43): the Viewer
        // stopped between the two writes. Left as `deployed`, it read as the
        // retained previous checkout at the next prune and displaced the
        // real one.
        await storage.updateDeployment(row.id, {
          status: "failed",
          buildLog: `${row.buildLog}\nThe Viewer stopped before this build went live. Rebuild it.\n`,
        })
      }
    } catch (error) {
      console.error(`[viewer] failed to reconcile the checkout for ${name}:`, error)
    }
  }
  return removed
}

/**
 * Whether a `deployed` row ever became its project's active deployment: it
 * is the current one, or it carries the `activatedAt` stamp activation
 * writes right after the project's `activeDeploymentId` (codex round 48).
 * Creation order cannot say (round 43's rule): an upload can go live while
 * an older build is still running, and a Viewer killed as that build was
 * marked `deployed` left a row older than the active one that never went
 * live. A row that is active but not yet stamped is a kill between the two
 * activation writes, and it IS live.
 */
async function wentLive(storage: Pick<StorageAdapter, "getProject">, row: Deployment): Promise<boolean> {
  if (row.activatedAt !== null) return true
  const project = await storage.getProject(row.projectId)
  return (project?.activeDeploymentId ?? null) === row.id
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

/**
 * First-boot demo project.
 *
 * A freshly started viewer used to show an empty dashboard whose only
 * call to action required a GitHub App. Seeding a real, served, commentable
 * prototype turns "install this and then go configure GitHub" into "install
 * this and start reviewing", which is the entire point of the onboarding
 * work this belongs to.
 *
 * Two independent skip conditions, and they answer different questions:
 *
 * - `demoSeededAt` in the runtime config answers "have we ever done this?"
 *   It survives the demo being DELETED, which is what stops a user who threw
 *   the demo away from finding it back on the next restart.
 * - a non-empty project list answers "is this actually a fresh install?"
 *   It covers an existing deployment that predates this feature, whose
 *   runtime config has no marker but which plainly does not want a demo.
 *
 * A missing fixture directory is a skip, never a throw. The demo is a nicety;
 * refusing to boot without it would be a spectacular over-reaction, and it
 * WILL be missing for anyone who cleans build output aggressively.
 *
 * A mid-seed FAILURE (disk full, one unreadable fixture file) is neither of
 * the above — it is not a graceful "there is nothing to seed" state, it is
 * a half-built project + deployment already sitting in storage. Left alone,
 * the marker is never written, but the NEXT boot's "any project exists"
 * skip (below) fires on that half-built project and writes the marker
 * anyway — silently freezing a broken demo in place forever. So the write
 * phase below is wrapped: on failure it best-effort deletes whatever it
 * created and RETHROWS the original error, so the boot wrapper logs it and
 * the next boot retries on a genuinely clean slate.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, posix, relative, sep } from "node:path"
import type { AssetStore } from "../assets/types"
import { loadRuntimeConfig, updateRuntimeConfig } from "../runtime-config"
import type { Deployment, Project, StorageAdapter } from "../storage/types"

export const DEMO_SLUG = "demo"
const DEMO_NAME = "Demo prototype"

export interface SeedDemoDeps {
  storage: StorageAdapter
  assets: AssetStore
  /** Where the runtime config (and therefore the seeded marker) lives. */
  dataDir: string
  /** The built demo, i.e. `viewer/fixtures/demo-react/dist`. */
  fixtureDir: string
  /**
   * Seed this user onto the demo's access list. In local mode the boot path
   * passes the operator's user id (the row exists before anyone signs in —
   * see `ensureLocalOperatorUser`).
   *
   * Named `seedMemberUserId` since the M2 review fix. It was `ownerUserId`,
   * which described a concept this product no longer has: `ProjectMember` lost
   * its `role` field in Task 9, and since Authorization v2 a membership row
   * grants no authority at all. Uploads to the demo are admitted by the
   * caller's INSTANCE role — the local operator is `role: "admin"` by
   * definition — and readability comes from `access: "public-link"`, not from
   * membership. So the row is an access-list entry and nothing more; the field
   * name now says that. Absent on GitHub-configured deployments, where the
   * demo stays memberless.
   */
  seedMemberUserId?: string
}

/** Every file under `dir`, as paths relative to it, POSIX-separated for the asset store. */
async function listFiles(dir: string, root = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, root)))
    } else if (entry.isFile()) {
      files.push(relative(root, full).split(sep).join(posix.sep))
    }
  }
  return files
}

export async function seedDemoProject(deps: SeedDemoDeps): Promise<"seeded" | "skipped"> {
  if (loadRuntimeConfig(deps.dataDir).demoSeededAt) return "skipped"
  if ((await deps.storage.listProjects()).length > 0) {
    // Mark it, so an existing deployment is not re-checked on every boot.
    updateRuntimeConfig(deps.dataDir, { demoSeededAt: new Date().toISOString() })
    return "skipped"
  }

  try {
    if (!(await stat(deps.fixtureDir)).isDirectory()) return "skipped"
  } catch {
    return "skipped"
  }

  const files = await listFiles(deps.fixtureDir)
  if (!files.includes("index.html")) return "skipped"

  let project: Project | undefined
  let deployment: Deployment | undefined
  try {
    project = await deps.storage.createProject({
      slug: DEMO_SLUG,
      name: DEMO_NAME,
      // Anonymous-readable on purpose. The demo exists to be opened
      // immediately, including from a link pasted to a colleague, and a
      // locked-down access value would gate it behind an invite the
      // operator has no reason to send.
      access: "public-link",
    })
    if (deps.seedMemberUserId) {
      await deps.storage.addProjectMember({
        projectId: project.id,
        userId: deps.seedMemberUserId,
      })
    }
    deployment = await deps.storage.createDeployment({ projectId: project.id })

    for (const relPath of files) {
      await deps.assets.put(deployment.id, relPath, await readFile(join(deps.fixtureDir, relPath)))
    }

    await deps.storage.updateDeployment(deployment.id, {
      status: "deployed",
      buildLog: "Seeded from the bundled demo prototype.\n",
    })
    await deps.storage.updateProject(project.id, { activeDeploymentId: deployment.id })
    updateRuntimeConfig(deps.dataDir, { demoSeededAt: new Date().toISOString() })
    return "seeded"
  } catch (error) {
    // Best-effort cleanup so a failed seed leaves a clean slate: no
    // `demoSeededAt` marker was written above, so the "any project exists"
    // skip at the top of this function does not fire on a half-built demo,
    // and the next boot genuinely retries. Each step is its own try/catch
    // — a cleanup failure must never SHADOW the original error, which is
    // what the caller (and the boot log) needs to see.
    //
    // Residual, accepted: if a cleanup step also fails, a stale half-built
    // demo project can be left behind. The next boot's "any project
    // exists" check then treats that leftover the same as a real
    // pre-existing deployment and marks `demoSeededAt` without ever
    // seeding a working demo. Doubly-degraded (both the seed and its own
    // cleanup failed) — accepted rather than engineered around here.
    if (deployment) {
      try {
        await deps.assets.deleteDeployment(deployment.id)
      } catch {
        // See residual note above.
      }
    }
    if (project) {
      try {
        await deps.storage.deleteProject(project.id)
      } catch {
        // See residual note above.
      }
    }
    throw error
  }
}

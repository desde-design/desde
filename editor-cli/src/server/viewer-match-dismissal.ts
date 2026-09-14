import { patchProjectRegistryEntry, readProjectsRegistry, upsertProjectRegistryEntry } from "./projects-registry.js"
import { normalizeOrigin } from "./viewer-token-store.js"

/**
 * Whether this machine has dismissed the "several prototypes match this repo"
 * chooser, for this repo and this viewer.
 *
 * Machine-local, deliberately. The alternative home is
 * `.desde/config.json`, which is committed and shared, so a dismissal there
 * would answer the question on behalf of everyone who clones the repo.
 *
 * Keyed on the viewer ORIGIN as well as the path: pointing the Editor at a
 * different viewer poses a different question and should be asked.
 */
export async function isViewerMatchDismissed(
  repoRoot: string,
  origin: string,
): Promise<boolean> {
  const registry = await readProjectsRegistry()
  const entry = registry.projects.find((p) => p.path === repoRoot)
  return entry?.dismissedMatchOrigins?.includes(normalizeOrigin(origin)) ?? false
}

/**
 * Record a dismissal. Idempotent.
 *
 * Patches in place rather than upserting, so dismissing does not move the
 * project to the front of the launcher's recents list. Dismissing a dialog is
 * not opening a project.
 */
export async function dismissViewerMatch(repoRoot: string, origin: string): Promise<void> {
  const key = normalizeOrigin(origin)
  const registry = await readProjectsRegistry()
  const entry = registry.projects.find((p) => p.path === repoRoot)
  const next = [...new Set([...(entry?.dismissedMatchOrigins ?? []), key])]

  // A repo with no registry entry yet still has to be able to record this —
  // `patch` writes nothing when there is no entry to patch.
  if (!entry) {
    await upsertProjectRegistryEntry({ path: repoRoot, dismissedMatchOrigins: next })
    return
  }
  await patchProjectRegistryEntry(repoRoot, { dismissedMatchOrigins: next })
}

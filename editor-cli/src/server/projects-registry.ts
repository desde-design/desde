/**
 * Per-user project registry at `~/.desde/projects.json`.
 *
 * A machine-local index of "which local checkouts map to which
 * Desde projects" — populated on every editor-cli boot. It
 * backs the launcher's recent-projects list and "switch project"
 * (a running editor can offer to focus / spawn another checkout
 * without the user re-typing paths).
 *
 * This is a CACHE, never a source of truth. The authoritative link
 * is `<repo>/.desde/config.json` (committed, shared across the
 * team). A lost or stale registry entry is re-created on the next
 * boot of that repo. Because separate editor processes (one per
 * open project) can write concurrently, writes are last-writer-wins
 * over an atomic temp+rename — a simultaneous double-boot could drop
 * one entry from the index, which the next boot repairs. That's an
 * acceptable trade for a recents cache; we don't add cross-process
 * file locking here.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { resolve as resolvePath, dirname } from "node:path"
import { randomUUID } from "node:crypto"

const REGISTRY_VERSION = 1

export interface ProjectRegistryEntry {
  /** Canonical repo root (absolute path) — the registry key. */
  path: string
  /** Cloud project id, if this checkout is linked. */
  projectId?: string
  /** Project slug, if known. */
  slug?: string
  /** ISO timestamp of the most recent boot against this path. */
  lastOpenedAt: string
  /** Port the editor last bound to for this path. */
  lastPort?: number
  /** Full shell URL the editor last served for this path. */
  lastUrl?: string
}

export interface ProjectsRegistry {
  version: number
  projects: ProjectRegistryEntry[]
}

/** Absolute path to the registry file. */
export function projectsRegistryPath(): string {
  return resolvePath(homedir(), ".desde", "projects.json")
}

function emptyRegistry(): ProjectsRegistry {
  return { version: REGISTRY_VERSION, projects: [] }
}

/**
 * Read the registry, returning an empty one when absent or malformed.
 * A corrupt file is treated as empty rather than thrown — a recents
 * cache should never block boot. Entries are validated shallowly and
 * bad ones dropped.
 */
export async function readProjectsRegistry(): Promise<ProjectsRegistry> {
  let raw: string
  try {
    raw = await fs.readFile(projectsRegistryPath(), "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry()
    // Unreadable for another reason (permissions, etc.) — degrade to empty.
    return emptyRegistry()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyRegistry()
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    return emptyRegistry()
  }

  const projects: ProjectRegistryEntry[] = []
  for (const item of (parsed as { projects: unknown[] }).projects) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as ProjectRegistryEntry).path === "string" &&
      (item as ProjectRegistryEntry).path.length > 0
    ) {
      const e = item as Record<string, unknown>
      projects.push({
        path: e.path as string,
        ...(typeof e.projectId === "string" ? { projectId: e.projectId } : {}),
        ...(typeof e.slug === "string" ? { slug: e.slug } : {}),
        lastOpenedAt:
          typeof e.lastOpenedAt === "string"
            ? e.lastOpenedAt
            : new Date(0).toISOString(),
        ...(typeof e.lastPort === "number" ? { lastPort: e.lastPort } : {}),
        ...(typeof e.lastUrl === "string" ? { lastUrl: e.lastUrl } : {}),
      })
    }
  }
  return { version: REGISTRY_VERSION, projects }
}

/**
 * Insert or update the entry for `entry.path`, then persist. Keyed by
 * canonical path. Later boots overwrite the same entry (bumping
 * `lastOpenedAt` / port / url and any newly-known project id/slug).
 * The list is kept most-recently-opened first so the launcher can
 * render it directly.
 *
 * Best-effort: a write failure is swallowed by the caller (boot must
 * not fail because a recents cache couldn't be written).
 */
export async function upsertProjectRegistryEntry(
  entry: Omit<ProjectRegistryEntry, "lastOpenedAt"> & { lastOpenedAt?: string },
): Promise<void> {
  const registry = await readProjectsRegistry()
  const now = entry.lastOpenedAt ?? new Date().toISOString()
  const existing = registry.projects.find((p) => p.path === entry.path)

  const merged: ProjectRegistryEntry = {
    path: entry.path,
    // Prefer freshly-supplied values, fall back to what we already knew.
    projectId: entry.projectId ?? existing?.projectId,
    slug: entry.slug ?? existing?.slug,
    lastOpenedAt: now,
    lastPort: entry.lastPort ?? existing?.lastPort,
    lastUrl: entry.lastUrl ?? existing?.lastUrl,
  }
  // Drop undefined keys so the JSON stays clean.
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as unknown as ProjectRegistryEntry

  const others = registry.projects.filter((p) => p.path !== entry.path)
  const next: ProjectsRegistry = {
    version: REGISTRY_VERSION,
    projects: [cleaned, ...others],
  }
  await writeRegistryAtomic(next)
}

/**
 * Drop the entry for `path` from the registry.
 *
 * This forgets a project, it does NOT delete anything the user owns. The
 * registry is a recents cache; the authoritative link is the repo's own
 * `.desde/config.json`, which stays exactly where it is. Booting that
 * repo again re-creates the entry, which is the intended way back.
 *
 * Returns whether an entry was actually removed, so a caller can tell a real
 * removal from a no-op on a path that was never in the list.
 */
export async function removeProjectRegistryEntry(path: string): Promise<boolean> {
  const registry = await readProjectsRegistry()
  const remaining = registry.projects.filter((p) => p.path !== path)
  if (remaining.length === registry.projects.length) return false
  await writeRegistryAtomic({ version: REGISTRY_VERSION, projects: remaining })
  return true
}

async function writeRegistryAtomic(registry: ProjectsRegistry): Promise<void> {
  const path = projectsRegistryPath()
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), "utf-8")
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

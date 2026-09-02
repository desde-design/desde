/**
 * Project identity — the one thing the Viewer and the Editor must agree on.
 *
 * Identity lives in the prototype repo (`.desde/config.json`), not in any
 * server, so a project works with zero servers: a viewer-only user hosts and
 * comments without ever running the Editor, and an Editor-only user prototypes
 * locally with no hosting. Neither surface may be degraded by the other's
 * absence.
 *
 * **Format only — deliberately no behaviour.** Reconcile logic lives in the
 * Viewer's API, not here. The two surfaces are independently deployed
 * artifacts (an app on a laptop, a container on a server, updated on unrelated
 * schedules), so shared source gives compile-time agreement inside a monorepo
 * checkout and nothing at all at runtime between Editor v1.2 and Viewer v1.9.
 * Since a wrong reconcile answer destroys comments, the decision is made by
 * the side holding both the projects-by-repo index and the comments at risk.
 * A file format, by contrast, is versioned and evolves additively — that is
 * safe to share. See
 * `docs/superpowers/specs/2026-08-07-project-identity-design.md`.
 *
 * Deliberately NOT under `src/editor/`: that tree becomes `src/editor/`, and
 * the Viewer must not import from an Editor-named directory.
 */

/** Max slug length — matches the viewer's SLUG_PATTERN upper bound. */
const SLUG_MAX = 63

export interface ProjectIdentity {
  /** Stable opaque id, minted once and never changed. THE join key. */
  id: string
  /** Human label. */
  name: string
  /**
   * Routing PREFERENCE, not identity. The viewer owns slug uniqueness within
   * its own instance and may suffix on collision, so this is what the project
   * would like to be served at — never a claim. Two teams will both want
   * `checkout`; only one can have it, and neither loses its identity over it.
   */
  slug: string
  /** Viewer this project syncs review state with. Absent ⇒ local-only. */
  viewerUrl?: string
}

/**
 * Mint a stable project id. Uses `crypto.randomUUID` where available (browser
 * and modern Node), falling back to random hex so this module stays usable in
 * whatever runtime either surface runs in.
 */
export function mintProjectId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  let out = ""
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

/**
 * Best-effort slug from a display name. Only has to be a reasonable starting
 * point — the viewer re-validates and may suffix for uniqueness.
 */
export function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    // Slicing can leave a trailing hyphen that the earlier trim didn't see.
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : "project"
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function nonBlank(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== ""
}

export function parseProjectIdentity(
  raw: unknown,
): { ok: true; identity: ProjectIdentity } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "project must be an object" }
  if (!nonBlank(raw.id)) return { ok: false, reason: "project.id is required" }
  if (!nonBlank(raw.name)) {
    return { ok: false, reason: "project.name is required" }
  }
  const name = raw.name.trim()
  const identity: ProjectIdentity = {
    id: raw.id.trim(),
    name,
    // A missing slug is derivable, so it isn't worth failing a whole config
    // over — and the viewer re-validates it regardless.
    slug: nonBlank(raw.slug) ? raw.slug.trim() : deriveSlug(name),
  }
  if (nonBlank(raw.viewerUrl)) identity.viewerUrl = raw.viewerUrl.trim()
  return { ok: true, identity }
}

/**
 * Read identity out of an already-parsed config object.
 *
 * Returns null for a v1 config (no `project` block) AND for a malformed one:
 * callers treat "no identity yet" and "identity unreadable" identically —
 * offer to mint on the next explicit action. Never throws, because this runs
 * on a boot path where a bad config must degrade rather than block.
 */
export function readIdentityFromConfig(config: unknown): ProjectIdentity | null {
  if (!isRecord(config)) return null
  if (!("project" in config)) return null
  const parsed = parseProjectIdentity(config.project)
  return parsed.ok ? parsed.identity : null
}

/**
 * Return a COPY of `config` carrying `identity`, at schema version 2.
 *
 * Every other key round-trips untouched — including keys this build has never
 * heard of. Config evolves additively across independently deployed surfaces,
 * so an older writer must never drop a newer peer's fields; that is the whole
 * compatibility story between two artifacts on unrelated release schedules.
 */
export function writeIdentityIntoConfig<T extends object>(
  config: T,
  identity: ProjectIdentity,
): T {
  const project: Record<string, string> = {
    id: identity.id,
    name: identity.name,
    slug: identity.slug,
  }
  // Only write viewerUrl when genuinely set: an empty string would round-trip
  // as a real (and wrong) value rather than as "absent".
  if (identity.viewerUrl) project.viewerUrl = identity.viewerUrl
  return { ...config, version: 2, project } as T
}

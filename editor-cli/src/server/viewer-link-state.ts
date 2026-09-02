import { resolveViewerLink, type ViewerLinkState } from "./viewer-resolve.js"

/**
 * The process's view of "is this repo linked to a viewer, and how".
 *
 * Two ways a repo can be linked, and they are NOT equal:
 *
 *  1. **Committed** — `platformBaseUrl` + `projectId` in `.desde/config.json`.
 *     Put there by the connect dialog. Travels with the repo, so a teammate
 *     who clones it is already pointed at the right prototype.
 *  2. **Resolved** — the machine's default viewer recognised this repo, by its
 *     embedded identity or its git remote. Runtime only; nothing is written.
 *
 * **The committed link WINS.** A repo that states which viewer it belongs to
 * is making a claim on behalf of everyone who clones it, and one person's
 * machine default must not quietly override it. The resolved link only fills
 * a gap; it never replaces an answer the repo already gave.
 *
 * Cached per process, because it costs a network round-trip and the inputs
 * (a committed config, a git remote, a machine setting) do not change under
 * a running editor without a deliberate action — and every such action calls
 * `invalidateViewerLink`.
 */
let cached: Promise<ViewerLinkState> | null = null

export function getViewerLink(repoRoot: string): Promise<ViewerLinkState> {
  cached ??= resolveViewerLink(repoRoot)
  return cached
}

/**
 * Drop the cached resolution.
 *
 * Called when the machine's viewer changes, and after a repo is linked or
 * unlinked by hand — anything that could change the answer.
 */
export function invalidateViewerLink(): void {
  cached = null
}

export interface EffectiveViewerConfig {
  baseUrl: string | null
  projectId: string | null
  /** Which of the two links above produced this. `null` when unlinked. */
  source: "committed" | "resolved" | null
}

/**
 * The link the proxy should actually use, given what the repo committed and
 * what the viewer resolved.
 *
 * Both halves of a committed link must be present to count. A repo carrying a
 * `projectId` with no `platformBaseUrl` (or the reverse) is not a usable link,
 * and treating it as one would send this repo's comments to whichever viewer
 * happened to be the machine default — which is precisely the silent
 * mis-routing the precedence rule exists to prevent.
 */
export function effectiveViewerConfig(
  committed: { baseUrl: string | null; projectId: string | null },
  resolved: ViewerLinkState | null,
): EffectiveViewerConfig {
  if (committed.baseUrl && committed.projectId) {
    return { baseUrl: committed.baseUrl, projectId: committed.projectId, source: "committed" }
  }
  if (resolved && resolved.status === "linked") {
    return { baseUrl: resolved.origin, projectId: resolved.projectId, source: "resolved" }
  }
  return { baseUrl: null, projectId: null, source: null }
}

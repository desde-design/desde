/**
 * Icon-sets handler for the CLI HTTP server (`GET /api/editor/icon-sets`).
 *
 * Returns the full enumeration of icon sets registered against the
 * open project, with each set's icons + previews. The inspector
 * picker fetches this once per session and renders client-side.
 *
 * Read-only — no security-sensitive side effects. Same auth gating
 * as the rest of `/api/*` (token + Origin) per http-server.ts policy.
 */

import type {
  IconManifest,
  IconSetRegistry,
  IconSetSource,
} from "../../../src/editor/core"

export type IconSetsResult =
  | { ok: true; status: 200; sets: SerializedIconSet[] }
  | { ok: false; status: number; reason: string }

export interface SerializedIconSet {
  id: string
  displayName: string
  framework: string
  usagePattern: IconSetSource["usagePattern"]
  icons: IconManifest[]
}

export async function getIconSets(
  registry: IconSetRegistry | null,
): Promise<IconSetsResult> {
  if (!registry) {
    return {
      ok: false,
      status: 503,
      reason:
        "Icon set registry not configured. CLI bootstrap did not wire one: auto-detect produced no matches, or the registry option was omitted.",
    }
  }

  // Per-source try/catch: one broken adapter (missing types entry,
  // unreadable node_modules, package import failure) must not 500
  // the whole endpoint. Failed sources are logged + omitted; the
  // picker degrades to the sets that did load.
  const sets: SerializedIconSet[] = []
  for (const source of registry.list()) {
    try {
      const icons = await source.listIcons()
      sets.push({
        id: source.id,
        displayName: source.displayName,
        framework: source.framework,
        usagePattern: source.usagePattern,
        icons,
      })
    } catch (err) {
       
      console.warn(
        `[icon-sets-handler] source "${source.id}" failed to enumerate: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { ok: true, status: 200, sets }
}

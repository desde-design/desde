"use client"

/**
 * Whether this repo is linked to a Desde **viewer**, and whether this
 * machine holds an access token for it.
 *
 * Deliberately reports PRESENCE, never the token itself — the credential
 * lives in the CLI process and is attached by its proxy, so it must not be
 * fetched into a page that also renders a live prototype. See
 * `editor-cli/src/server/viewer-proxy.ts` for why.
 */

import { useCallback, useEffect, useState } from "react"

/**
 * What the CLI resolved this repo to against the machine's default viewer.
 * Mirrors `ViewerLinkState` in `editor-cli/src/server/viewer-resolve.ts`.
 */
export type ViewerLinkState =
  | { status: "no-viewer" }
  | { status: "no-token"; origin: string }
  | { status: "linked"; origin: string; projectId: string; slug: string; name: string }
  | { status: "unlinked"; origin: string }
  | { status: "conflict"; origin: string; reason: string }
  | { status: "error"; origin: string; reason: string }

export interface ViewerAuthStatus {
  /** A usable link exists — from the repo's config OR resolved against the machine's viewer. */
  configured: boolean
  baseUrl: string | null
  projectId: string | null
  hasToken: boolean
  /**
   * Which link produced `baseUrl`/`projectId`. `"committed"` means the repo
   * says so in `.desde/config.json`; `"resolved"` means the machine's
   * viewer recognised this repo. Null when unlinked.
   *
   * The UI has to tell these apart: a committed link is a fact about the repo
   * that a teammate shares, a resolved one is a fact about this machine.
   */
  source: "committed" | "resolved" | null
  /** The machine's default viewer origin, or null when none is set. */
  defaultOrigin: string | null
  /** The raw resolution, so the UI can show a conflict or an unreachable viewer. */
  link: ViewerLinkState
}

export interface UseViewerAuthStatusResult {
  status: ViewerAuthStatus | null
  loading: boolean
  refresh: () => Promise<void>
}

export function useViewerAuthStatus(): UseViewerAuthStatusResult {
  const [status, setStatus] = useState<ViewerAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/editor/viewer-auth")
      if (!res.ok) {
        // A failed probe must not be reported as "no viewer configured" —
        // that would silently drop the panel into local-only mode and the
        // user's comments would land somewhere they did not choose. Leave
        // the last known status in place instead.
        return
      }
      setStatus((await res.json()) as ViewerAuthStatus)
    } catch {
      // Same reasoning: keep the last known status rather than blanking it.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, loading, refresh }
}

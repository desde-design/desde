import type { StateCreator } from "zustand"

/**
 * Tracks the source file + route the iframe is currently showing,
 * derived from the bridge's `ROUTE_CHANGED` handshake. Consumed by
 * the comment/note bridges (page-scoped anchoring) and the editing
 * hook (attribution's page-level source-file fallback), not just the
 * editor surface that sets it.
 *
 * Was `page-status-slice.ts` / `PageStatusSlice` — that file also
 * carried a `pageStatuses` (Concept / In design / Dev ready) CRUD
 * slice for a viewer-side feature that was never wired to any
 * reachable UI. That dead slice was deleted (audit T1); this file
 * was renamed to reflect what actually survives: current-page
 * tracking, which several live call sites depend on.
 */
export interface CurrentPageSlice {
  currentSourceFile: string | null
  currentDisplayRoute: string | null
  /**
   * Raw iframe URL last reported by the bridge's ROUTE_CHANGED event.
   * `currentDisplayRoute` is normalized (`:id` substitution) for
   * display; this field preserves the literal URL so consumers that
   * need the real route (chat context, deep links) can use it.
   */
  currentPageUrl: string | null
  setCurrentPageInfo: (sourceFile: string | null, url: string) => void
}

function normalizeRoute(url: string): string {
  try {
    const parsed = new URL(url, "http://x")
    const segments = parsed.pathname.split("/").map((seg) => {
      if (/^\d+$/.test(seg)) return ":id"
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id"
      return seg
    })
    return segments.join("/") || "/"
  } catch {
    return url
  }
}

export const createCurrentPageSlice: StateCreator<CurrentPageSlice> = (set) => ({
  currentSourceFile: null,
  currentDisplayRoute: null,
  currentPageUrl: null,

  setCurrentPageInfo: (sourceFile, url) =>
    set({
      currentSourceFile: sourceFile,
      currentDisplayRoute: normalizeRoute(url),
      currentPageUrl: url,
    }),
})

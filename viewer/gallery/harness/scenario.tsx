"use client"

import type { ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"

/**
 * Answer a set of endpoints for as long as this subtree is mounted.
 *
 * Each key is a path prefix, optionally with a method: `"/api/v1/projects"`,
 * `"POST /api/v1/tokens"`. Longest path wins, so a specific route is never
 * shadowed by a prefix of itself. Anything not named here falls through to the
 * harness's baseline backend (`./mock-backend.ts`), which is what keeps a
 * fixture down to the two or three endpoints its own state depends on.
 *
 * Registration happens during RENDER, inside `useFetchOverride`. That is not
 * an oversight: the component under review fetches from its own mount effect,
 * and a child's effect runs before its parent's, so registering from an effect
 * here would lose that race and the surface would sometimes show the
 * un-overridden response.
 */
export function Scenario({
  routes,
  children,
}: {
  routes: Record<string, FetchOverrideResult | (() => FetchOverrideResult)>
  children: ReactNode
}) {
  useFetchOverride(routeTable(routes))
  return <>{children}</>
}

/**
 * Container for a surface that is a PANEL rather than a screen — the build
 * panel, the repo panel, the members list.
 *
 * These never appear on their own in the product: they sit inside a dialog on
 * the review screen, or in a column on a settings page. Rendered bare against
 * a full-width viewport their copy line-wraps in a way it never does in situ,
 * which flatters text that is actually too long. So they get a realistic
 * width to sit in.
 */
const PANEL_FRAME_WIDTHS = {
  /** The review screen's dialogs. */
  dialog: "max-w-lg",
  /** A settings column. */
  wide: "max-w-2xl",
  /**
   * The review rail, which is 320px in the product.
   *
   * Load-bearing rather than cosmetic: a panel that ships in the rail and is
   * reviewed at `dialog` width is reviewed 60% wider than it will ever be, so
   * its rows fit here and truncate there. That is exactly what happened to
   * the build panel when it moved into the rail (2026-08-21) and kept the
   * dialog frame it had while it lived in the repo dialog.
   */
  rail: "max-w-80",
} as const

export function PanelFrame({
  children,
  width = "dialog",
}: {
  children: ReactNode
  width?: keyof typeof PANEL_FRAME_WIDTHS
}) {
  return (
    <div className="flex min-h-full justify-center p-8">
      <div
        className={`h-fit w-full rounded-lg border border-border bg-card p-4 shadow-sm ${PANEL_FRAME_WIDTHS[width]}`}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * The real `Dialog` shell two panels are mounted in on the review screen
 * (`review-shell.tsx` wraps `ProjectAccess` and `ProjectRepoPanel` this way).
 * Fixtures for those panels use this rather than `PanelFrame`, so what gets
 * reviewed is the panel inside the scrim, header and width it actually ships
 * in.
 *
 * `open` is pinned and `onOpenChange` only reports, so an outside click cannot
 * dismiss the surface out from under the reviewer.
 */
export function DialogFrame({
  title,
  description,
  children,
  onOpenChange,
  size = "lg",
}: {
  title: string
  /** The host dialog's `DialogDescription`, when its real mount carries one. */
  description?: ReactNode
  children: ReactNode
  onOpenChange?: (open: boolean) => void
  /**
   * `"lg"` matches the Repo dialog's real mount. The Access dialog mounts at
   * `"xl"` instead (a decision dialog with option cards) — its fixture
   * passes that explicitly.
   */
  size?: "lg" | "xl"
}) {
  /*
    No footer here (2026-08-29). Both panels this frame hosts —
    `ProjectRepoPanel` and `ProjectAccess` — render their own `DialogFooter`
    now, so a Close added by the frame was a second footer under theirs. It
    had one for a few hours, added when only the real hosts carried one; the
    panels taking that job over is what made it redundant.
  */
  return (
    <Dialog open onOpenChange={(next) => onOpenChange?.(next)}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

"use client"

import { Fragment, useCallback, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Eyebrow } from "@/components/blocks"
import { useSurfaceGallery } from "@/components/gallery/use-surface-gallery"
import type { SurfaceKind } from "@/components/gallery/types"
import { cn } from "@/lib/utils"
import { SURFACE_REGISTRY } from "./registry"

const KIND_ORDER: readonly SurfaceKind[] = ["modal", "page", "inline", "toast"]

interface GalleryOverlayProps {
  /** `""` = gallery on, nothing selected. */
  initialStateId?: string | null
  initialTheme?: "light" | "dark"
}

/**
 * Floating picker for the Editor's surface gallery.
 *
 * Rendered into its own body-level portal with `pointer-events: auto` so it
 * stays clickable while a Radix Dialog has set `pointer-events: none` on
 * `<body>`. Clicking it does reach the dialog's dismissable layer, but every
 * fixture pins `open` and only logs its close callback, so nothing can
 * actually be dismissed out from under you.
 *
 * It FLOATS rather than reserving space because every surface it catalogs is
 * a modal, banner or toast that appears over the editor chrome — the backdrop
 * is part of the subject. The Viewer's gallery catalogs whole screens and
 * reserves a rail beside them instead. What the two share is the machinery
 * underneath: `useSurfaceGallery`.
 */
export function GalleryOverlay({
  initialStateId = "",
  initialTheme = "light",
}: GalleryOverlayProps) {
  // `toast.dismiss()` with no argument clears ALL toasts, including any the
  // ambient chrome fired — which is what we want, since a stray chrome toast
  // is noise attributed to the surface under review.
  const dismissToasts = useCallback(() => toast.dismiss(), [])
  const [collapsed, setCollapsed] = useState(false)

  const { selectedId, select, theme, setTheme, actions, log, found } = useSurfaceGallery({
    registry: SURFACE_REGISTRY,
    initialStateId,
    initialTheme,
    onFireCleanup: dismissToasts,
  })

  const picker = (
    <div
      data-gallery-picker
      className="fixed right-3 top-3 z-100 flex max-h-[92vh] w-72 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-popover p-2 shadow-lg pointer-events-auto"
    >
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Surface gallery</Eyebrow>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "Dark" : "Light"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? "Show" : "Hide"}
          </Button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/*
            Scroll this list ourselves whenever a dialog holds the scroll lock.

            Radix's modal dialogs mount `react-remove-scroll`, which puts
            `data-scroll-locked` on <body> and preventDefaults wheel events
            outside the dialog subtree. This picker lives outside it, so with a
            modal state selected the wheel did nothing here and the page behind
            appeared to move instead. Measured: the event still reaches this
            element and propagation is intact; only the default action is
            cancelled, and assigning `scrollTop` works fine.

            So translate the wheel by hand, and only while the lock is on. With
            no dialog open the browser scrolls natively and this stays out of
            the way, which keeps us from double-scrolling.
          */}
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            onWheel={(event) => {
              if (!document.body.hasAttribute("data-scroll-locked")) return
              event.currentTarget.scrollTop += event.deltaY
            }}
          >
            {KIND_ORDER.map((kind) => {
              const entries = SURFACE_REGISTRY.filter((e) => e.kind === kind)
              if (entries.length === 0) return null
              return (
                <div key={kind} className="mb-2">
                  <Eyebrow className="px-1">{kind}</Eyebrow>
                  {entries.map((entry) => (
                    <div key={entry.id} className="mb-1">
                      <p className="px-1 text-xs font-medium text-foreground">
                        {entry.title}
                      </p>
                      <p className="px-1 text-2xs text-muted-foreground">
                        {entry.sourceFile}
                      </p>
                      {entry.states.map((state) => (
                        <Button
                          key={state.id}
                          variant="ghost"
                          size="xs"
                          data-testid={`gallery-pick-${state.id}`}
                          onClick={() => select(state.id)}
                          className={cn(
                            "h-auto w-full justify-start rounded px-1 py-0.5 text-xs font-normal",
                            state.id === selectedId
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {state.label}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>

          <div
            data-testid="gallery-action-log"
            className="max-h-24 shrink-0 overflow-y-auto rounded border border-border bg-muted/50 p-1"
          >
            <Eyebrow className="px-0.5">Calls</Eyebrow>
            {actions.length === 0 ? (
              <p className="px-0.5 text-2xs text-muted-foreground">
                Callbacks the surface invokes appear here.
              </p>
            ) : (
              actions.map((action, index) => (
                <p key={index} className="px-0.5 font-mono text-code text-foreground">
                  {action}
                </p>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )

  return (
    <>
      {found && (
        // Keyed on state id AND theme.
        //
        // The id half remounts when switching between two states (e.g. via
        // `[`/`]`) rather than reusing the fixture's component instance —
        // otherwise internal state (like a dialog's "remember" checkbox)
        // carries over from the previous state.
        //
        // The theme half exists because a DRIVEN fixture only performs its
        // interaction once, in a mount effect. Without it, toggling the theme
        // left the already-mounted fixture untouched while `select()` cleared
        // the action log — so every driven state's dark screenshot showed an
        // empty "Calls" panel where its light twin showed the calls, and the
        // two halves of a contact-sheet pair weren't comparable.
        <Fragment key={`${found.state.id}::${theme}`}>
          {found.state.render?.({ log })}
          <div data-gallery-ready={found.state.id} hidden />
        </Fragment>
      )}
      {typeof document !== "undefined" && createPortal(picker, document.body)}
    </>
  )
}

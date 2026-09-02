"use client"

import { Fragment, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Eyebrow } from "@/components/blocks"
import { useSurfaceGallery } from "@/components/gallery/use-surface-gallery"
import type { SurfaceEntry, SurfaceKind } from "@/components/gallery/types"
import { cn } from "@/lib/utils"

const KIND_ORDER: readonly SurfaceKind[] = ["page", "modal", "inline", "toast"]

const KIND_LABEL: Record<SurfaceKind, string> = {
  page: "Screens",
  modal: "Dialogs",
  inline: "Panels",
  toast: "Toasts",
}

export interface GalleryShellProps {
  registry: readonly SurfaceEntry[]
  initialStateId?: string | null
  initialTheme?: "light" | "dark"
}

/**
 * The Viewer gallery's picker.
 *
 * It RESERVES a rail rather than floating over the page, which is the one way
 * it differs from the Editor's equivalent (`src/components/editor/gallery/
 * gallery-overlay.tsx`). The reason is what each catalog holds. The Editor's
 * surfaces are modals and banners that appear over a fixed backdrop, so a
 * floating panel covers nothing that matters. The Viewer's surfaces are whole
 * screens — the review screen's comment rail is itself on the right — and a
 * floating picker would sit exactly on top of the part being reviewed.
 *
 * Everything below the layout is shared with the Editor's picker through
 * `useSurfaceGallery`: selection, the `?gallery=…&theme=…` URL contract, the
 * `[`/`]` walk, and the action log.
 *
 * A dialog fixture still portals itself to `document.body` and will overlap
 * this rail. That is intentional and matches production, where a dialog covers
 * the screen behind it; the rail keeps `pointer-events: auto` and a z-index
 * above the dialog layer so it stays clickable regardless.
 */
export function GalleryShell({
  registry,
  initialStateId = "",
  initialTheme = "light",
}: GalleryShellProps) {
  const { selectedId, select, theme, setTheme, actions, log, found } = useSurfaceGallery({
    registry,
    initialStateId,
    initialTheme,
  })
  const [filter, setFilter] = useState("")

  const totalStates = useMemo(
    () => registry.reduce((count, entry) => count + entry.states.length, 0),
    [registry],
  )

  // Filter on the entry title, the state label AND the state id, so both
  // "how it reads" and "how it is addressed" find a surface. An entry whose
  // title matches keeps all its states, which is what makes typing a surface
  // name a way to browse it rather than a way to hide half of it.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return registry
    return registry
      .map((entry) => {
        if (entry.title.toLowerCase().includes(needle)) return entry
        const states = entry.states.filter(
          (state) =>
            state.label.toLowerCase().includes(needle) ||
            state.id.toLowerCase().includes(needle),
        )
        return states.length > 0 ? { ...entry, states } : null
      })
      .filter((entry): entry is SurfaceEntry => entry !== null)
  }, [registry, filter])

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <main
        data-gallery-stage
        className="relative min-w-0 flex-1 overflow-auto bg-background"
      >
        {found ? (
          // Keyed on state id AND theme, so switching states remounts the
          // fixture instead of reusing its component instance — otherwise a
          // dialog's internal state (a typed field, a checked box) carries
          // over from whatever was selected before it.
          <Fragment key={`${found.state.id}::${theme}`}>
            {found.state.render?.({ log })}
            <div data-gallery-ready={found.state.id} hidden />
          </Fragment>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
            <p className="text-base font-medium text-foreground">Viewer surface gallery</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Pick a surface on the right to render it with fixture data. `[` and `]`
              step through the whole catalog.
            </p>
          </div>
        )}
      </main>

      <aside className="z-100 flex h-screen w-80 flex-none flex-col gap-2 border-l border-border bg-popover p-2 pointer-events-auto">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>Viewer gallery</Eyebrow>
          <div className="flex items-center gap-1">
            <span className="text-2xs text-muted-foreground">{totalStates}</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "Dark" : "Light"}
            </Button>
          </div>
        </div>

        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter surfaces…"
          className="h-7 text-xs"
          data-testid="gallery-filter"
        />

        {/*
          Scroll this list ourselves whenever a dialog holds the scroll lock.

          Radix's modal dialogs mount `react-remove-scroll`, which sets
          `data-scroll-locked` on <body> and preventDefaults wheel events
          outside the dialog's subtree. This rail is outside it, so with a
          dialog state selected the wheel did nothing here. Propagation is
          intact and assigning `scrollTop` works, so translate the wheel by
          hand — and only while the lock is on, or we would double-scroll.
        */}
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onWheel={(event) => {
            if (!document.body.hasAttribute("data-scroll-locked")) return
            event.currentTarget.scrollTop += event.deltaY
          }}
        >
          {KIND_ORDER.map((kind) => {
            const entries = visible.filter((entry) => entry.kind === kind)
            if (entries.length === 0) return null
            return (
              <div key={kind} className="mb-3">
                <Eyebrow className="px-1">{KIND_LABEL[kind]}</Eyebrow>
                {entries.map((entry) => (
                  <div key={entry.id} className="mb-2">
                    <p className="px-1 text-xs font-medium text-foreground">{entry.title}</p>
                    <p className="px-1 pb-0.5 text-2xs text-muted-foreground">
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
                          "h-auto w-full justify-start rounded px-1 py-0.5 text-left text-xs font-normal whitespace-normal",
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
          {visible.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              Nothing matches “{filter}”.
            </p>
          ) : null}
        </div>

        <div
          data-testid="gallery-action-log"
          className="max-h-28 shrink-0 overflow-y-auto rounded border border-border bg-muted/50 p-1"
        >
          <Eyebrow className="px-0.5">Calls</Eyebrow>
          {actions.length === 0 ? (
            <p className="px-0.5 text-2xs text-muted-foreground">
              Callbacks the surface invokes appear here.
            </p>
          ) : (
            actions.map((action, index) => (
              <p key={index} className="px-0.5 font-mono text-code break-all text-foreground">
                {action}
              </p>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}

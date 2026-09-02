"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { findStateInRegistry, type SurfaceEntry, type SurfaceKind, type SurfaceState } from "./types"

declare global {
  interface Window {
    /** Published for tasks/scripts/surface-gallery-shots.mts. */
    __SURFACE_GALLERY_IDS__?: Array<{
      id: string
      kind: SurfaceKind
      title: string
      label: string
      /** Present for driven states — see `SurfaceState.readyWhen`. */
      readyWhen?: string
    }>
    /** In-page state switch — avoids a full reload per screenshot. */
    __SURFACE_GALLERY_SELECT__?: (id: string, theme?: "light" | "dark") => void
  }
}

export interface UseSurfaceGalleryOptions {
  registry: readonly SurfaceEntry[]
  /** `""` = gallery on, nothing selected. */
  initialStateId?: string | null
  initialTheme?: "light" | "dark"
  /**
   * Run when a `fire` state is replaced or unmounted.
   *
   * `fire` states pin themselves open — an auto-dismissing surface cannot be
   * looked at — so nothing else will ever take them down, and without a
   * cleanup every one visited stacks on top of the last. The Editor passes
   * `toast.dismiss`. The Viewer has no toasts and passes nothing, which is
   * why this is a callback rather than a `sonner` import in here.
   */
  onFireCleanup?: () => void
}

export interface SurfaceGalleryController {
  selectedId: string
  select: (id: string, nextTheme?: "light" | "dark") => void
  theme: "light" | "dark"
  setTheme: (theme: "light" | "dark") => void
  /** Human-readable record of the callbacks the current surface has invoked. */
  actions: string[]
  log: (callback: string, ...args: unknown[]) => void
  found: { entry: SurfaceEntry; state: SurfaceState } | null
}

/**
 * Everything a surface picker needs except its layout.
 *
 * The two galleries present differently on purpose — the Editor's floats over
 * a live `EditorPage`, because every surface it catalogs appears over exactly
 * that backdrop; the Viewer's reserves a rail beside a stage, because its
 * surfaces are whole screens and a floating panel would sit on top of the one
 * region worth looking at. Everything BELOW the layout is the same in both,
 * and this hook is that part: selection, theme, the URL contract, the
 * keyboard walk, the action log, and the globals a driving script reads.
 */
export function useSurfaceGallery({
  registry,
  initialStateId = "",
  initialTheme = "light",
  onFireCleanup,
}: UseSurfaceGalleryOptions): SurfaceGalleryController {
  const [selectedId, setSelectedId] = useState(initialStateId ?? "")
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme)
  const [actions, setActions] = useState<string[]>([])

  const flatIds = useMemo(
    () => registry.flatMap((entry) => entry.states.map((s) => s.id)),
    [registry],
  )

  const select = useCallback((id: string, nextTheme?: "light" | "dark") => {
    setSelectedId(id)
    setActions([])
    if (nextTheme) setTheme(nextTheme)
  }, [])

  // Theme is a class on <html> (`@custom-variant dark (&:is(.dark *))` at
  // src/styles/globals.css:6), so the toggle writes there rather than into
  // React state that some provider would own.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  // Keep the URL in step so any state is shareable and reloadable.
  useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    params.set("gallery", selectedId)
    params.set("theme", theme)
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`)
  }, [selectedId, theme])

  // Publish the catalog + a selector for any script driving this page. Reading
  // ids off the page keeps one source of truth without Node ever importing JSX.
  useEffect(() => {
    window.__SURFACE_GALLERY_IDS__ = registry.flatMap((entry) =>
      entry.states.map((state) => ({
        id: state.id,
        kind: entry.kind,
        title: entry.title,
        label: state.label,
        readyWhen: state.readyWhen,
      })),
    )
    window.__SURFACE_GALLERY_SELECT__ = select
    return () => {
      delete window.__SURFACE_GALLERY_IDS__
      delete window.__SURFACE_GALLERY_SELECT__
    }
  }, [registry, select])

  // Capture phase so the shortcuts fire ahead of a dialog's focus trap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" && event.key !== "]") return
      // Don't steal the key from a field the designer is typing into. Several
      // fixtures have real inputs (a viewer URL, a branch name), and a URL like
      // `http://[::1]:8080` would otherwise remount the surface mid-word
      // instead of typing a bracket.
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return
      }
      const at = flatIds.indexOf(selectedId)
      // `at` is -1 when nothing is selected. Treat that as "just before the
      // first entry" for `]` (lands on index 0) and "just after the last
      // entry" for `[` (lands on the last id) — without this, `[` from
      // nothing-selected landed one entry short of the last.
      const from = at === -1 && event.key === "[" ? flatIds.length : at
      const next =
        event.key === "]"
          ? flatIds[(from + 1) % flatIds.length]
          : flatIds[(from - 1 + flatIds.length) % flatIds.length]
      event.preventDefault()
      select(next)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [flatIds, selectedId, select])

  // Held in a ref, and deliberately NOT a dependency of the fire effect
  // below. A caller that passes an inline arrow (`() => toast.dismiss()`)
  // hands us a new function identity on every render, so as a dependency it
  // would tear down and re-run the effect on every keystroke and every log
  // append — which for a `fire` state means dismissing and re-firing the
  // surface continuously.
  const fireCleanupRef = useRef(onFireCleanup)
  useEffect(() => {
    fireCleanupRef.current = onFireCleanup
  }, [onFireCleanup])

  const log = useCallback((callback: string, ...args: unknown[]) => {
    const rendered = args.map((a) => JSON.stringify(a) ?? String(a)).join(", ")
    setActions((prev) => [...prev, `${callback}(${rendered})`])
  }, [])

  // Imperative states fire rather than rendering a node.
  //
  // Keyed on `selectedId` + `theme`, NOT on the resolved state:
  // `findStateInRegistry` returns a fresh object every render, so depending on
  // it would re-fire on every keystroke and every log append. `theme` IS a
  // dependency because a driving script may visit each state once per theme —
  // without it the dark pass would show whatever the light pass left behind.
  useEffect(() => {
    if (!selectedId) return
    const state = findStateInRegistry(registry, selectedId)?.state
    if (!state?.fire) return
    state.fire({ log })
    return () => {
      fireCleanupRef.current?.()
    }
  }, [registry, selectedId, theme, log])

  const found = selectedId ? findStateInRegistry(registry, selectedId) : null

  return { selectedId, select, theme, setTheme, actions, log, found }
}

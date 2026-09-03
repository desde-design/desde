"use client"

/**
 * Right-side rail with a draggable left edge. The rail's width is
 * persisted to localStorage per `storageKey` so a user's preferred
 * width survives reloads. The handle sits on the rail's left edge;
 * dragging left widens, dragging right narrows. Width is clamped to
 * [minWidth, maxWidth] so the rail can't swallow the iframe or collapse.
 *
 * The default width is a FRACTION of the viewport, not a fixed 320px (Mo,
 * 2026-09-02: "the default width of the panel is a bit thin on big screens,
 * make it 20% of screen width by default", then 25% the same day after
 * seeing it). A fixed default is one size for
 * every monitor, and 320 on a 2560px display is an eighth of the screen. The
 * fraction is read once, on mount, and then clamped like any other width; it
 * does not track the window afterwards, because a rail that resizes itself
 * under a drag the user just made is worse than one that started narrow.
 * A stored width still wins over it: a default is only for the first visit.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

/** A fixed width, or one derived from the viewport width at mount. */
type DefaultWidth = number | ((viewportWidth: number) => number)

const DEFAULT_WIDTH_FRACTION = 0.25
/** With no window to measure (a server render), the old fixed default. */
const SSR_FALLBACK_WIDTH = 320

function defaultRailWidth(viewportWidth: number): number {
  return Math.round(viewportWidth * DEFAULT_WIDTH_FRACTION)
}

function resolveDefaultWidth(defaultWidth: DefaultWidth): number {
  if (typeof defaultWidth === "number") return defaultWidth
  if (typeof window === "undefined") return SSR_FALLBACK_WIDTH
  return defaultWidth(window.innerWidth)
}

interface ResizableRailProps {
  children: React.ReactNode
  storageKey?: string
  defaultWidth?: DefaultWidth
  minWidth?: number
  maxWidth?: number
  className?: string
}

export function ResizableRail({
  children,
  storageKey,
  defaultWidth = defaultRailWidth,
  minWidth = 280,
  maxWidth = 640,
  className,
}: ResizableRailProps) {
  const clamp = React.useCallback(
    (w: number) => Math.min(maxWidth, Math.max(minWidth, w)),
    [minWidth, maxWidth],
  )

  const [width, setWidth] = React.useState<number>(() => {
    const stored = readStoredWidth(storageKey)
    return clamp(stored ?? resolveDefaultWidth(defaultWidth))
  })
  const [dragging, setDragging] = React.useState(false)

  // Capture the gesture's starting point so width tracks the delta
  // regardless of where the rail sits in the layout.
  const dragStartRef = React.useRef<{ x: number; width: number } | null>(null)

  // The divider that captures the pointer. Pointer capture (set in
  // onPointerDown below) retargets every subsequent pointermove/up for this
  // pointerId to THIS element regardless of hit-testing — including while
  // the cursor is over the prototype iframe, which would otherwise swallow
  // plain mousemove/mouseup (widen stalls, and a mouseup inside the iframe
  // never reaches `document`, leaving `dragging` stuck true).
  const handleRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!dragging) return
    const handle = handleRef.current
    if (!handle) return
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current
      if (!start) return
      // Rail is on the right: moving the cursor left (smaller clientX)
      // widens the rail, so subtract the delta.
      const next = clamp(start.width + (start.x - e.clientX))
      setWidth(next)
      if (storageKey && typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, next.toString())
      }
    }
    const onUp = (e: PointerEvent) => {
      if (handle.hasPointerCapture(e.pointerId)) {
        handle.releasePointerCapture(e.pointerId)
      }
      setDragging(false)
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
    // Safety net: if capture is lost some other way (e.g. browser revokes
    // it), stop dragging instead of leaving the flag stuck armed.
    handle.addEventListener("lostpointercapture", onUp)
    return () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      handle.removeEventListener("lostpointercapture", onUp)
    }
  }, [dragging, storageKey, clamp])

  return (
    <>
      <div
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className={cn(
          "relative w-px shrink-0 cursor-col-resize select-none bg-transparent transition-colors hover:bg-foreground/20",
          dragging && "bg-foreground/30",
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          dragStartRef.current = { x: e.clientX, width }
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        data-testid="resizable-rail-handle"
      >
        {/* Wider invisible hitbox so the 1px bar is easy to grab. */}
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>
      <aside
        className={cn(
          "flex min-w-0 flex-col",
          className,
        )}
        style={{ width, transition: dragging ? undefined : "width 150ms ease-out" }}
      >
        {children}
      </aside>
    </>
  )
}

function readStoredWidth(storageKey: string | undefined): number | null {
  if (!storageKey || typeof window === "undefined") return null
  const stored = window.localStorage.getItem(storageKey)
  if (stored === null) return null
  const parsed = parseFloat(stored)
  return Number.isFinite(parsed) ? parsed : null
}

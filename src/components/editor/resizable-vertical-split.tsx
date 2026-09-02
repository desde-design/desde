"use client"

/**
 * Two-pane vertical split with a draggable handle. Top pane gets a
 * fraction of the available height; bottom takes the rest. The ratio
 * is persisted to localStorage per `storageKey` so a user's preferred
 * inspector-vs-chat split survives reloads.
 *
 * Phase 1 hosts the per-element inspector (top) and the chat panel
 * (bottom) in the editor's right rail. Both panes are scrollable
 * independently — the inspector typically fits, the chat grows.
 *
 * Min/max clamps prevent either pane from collapsing entirely; users
 * who want a pane out of the way collapse it via the parent's own UI.
 *
 * Phase 1c: an optional `targetRatio` lets the caller suggest a
 * default that varies with context (e.g. chat-favored when chat is
 * active). The user's manual drag always wins — once they've dragged,
 * `targetRatio` is ignored for this storageKey. Without a drag,
 * `targetRatio` overrides `defaultRatio` and re-applies whenever
 * it changes.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

const MIN_TOP_RATIO = 0.15
const MAX_TOP_RATIO = 0.85

interface ResizableVerticalSplitProps {
  top: React.ReactNode
  bottom: React.ReactNode
  /** Persist key. Same key from two callers shares one persisted ratio. */
  storageKey?: string
  /** Initial split ratio (top pane / total). Default 0.5. */
  defaultRatio?: number
  /**
   * Phase 1c: caller-driven target ratio. Used when the parent wants
   * the split to shift based on context (e.g. chat-active vs idle).
   * The user's manual drag always wins; once they drag, this prop is
   * ignored. If undefined, falls back to `defaultRatio`.
   */
  targetRatio?: number
  className?: string
}

export function ResizableVerticalSplit({
  top,
  bottom,
  storageKey,
  defaultRatio = 0.5,
  targetRatio,
  className,
}: ResizableVerticalSplitProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  // Read localStorage once into a state initializer so we don't hit
  // it on every render. `userOverrideRef` is set lazily by the same
  // initializer's side effect so both refs see consistent state.
  //
  // The `useRef(null)` + assign-on-first-init pattern is intentional:
  // a `useRef(readStoredRatio(...))` argument runs the read on every
  // render even though the result is discarded — wasteful in a
  // frequently-rendered component.
  const userOverrideRef = React.useRef<boolean | null>(null)
  const [ratio, setRatio] = React.useState<number>(() => {
    const stored = readStoredRatio(storageKey)
    if (userOverrideRef.current === null) {
      userOverrideRef.current = stored !== null
    }
    if (stored !== null) return stored
    return clamp(targetRatio ?? defaultRatio)
  })
  const [dragging, setDragging] = React.useState(false)

  // Apply targetRatio when it changes — but only if the user hasn't
  // manually overridden. Drag flips `userOverrideRef`, so once the
  // user touches the handle, this effect goes inert.
  React.useEffect(() => {
    if (userOverrideRef.current) return
    if (typeof targetRatio !== "number") return
    setRatio(clamp(targetRatio))
  }, [targetRatio])

  // The handle that captures the pointer. Pointer capture (set in
  // onPointerDown below) retargets every subsequent pointermove/up for this
  // pointerId to THIS element regardless of hit-testing — including while
  // the cursor is over the prototype iframe, which would otherwise swallow
  // plain mousemove/mouseup (drag stalls, and a mouseup inside the iframe
  // never reaches `document`, leaving `dragging` stuck true).
  const handleRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!dragging) return
    const handle = handleRef.current
    if (!handle) return
    const onMove = (e: PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const y = e.clientY - rect.top
      const next = clamp(y / rect.height)
      // Manual drag — record as user override and persist.
      userOverrideRef.current = true
      setRatio(next)
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
  }, [dragging, storageKey])

  const topStyle: React.CSSProperties = {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: `${ratio * 100}%`,
    transition: dragging ? undefined : "flex-basis 200ms ease-out",
  }
  const bottomStyle: React.CSSProperties = {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  }

  return (
    <div
      ref={containerRef}
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="resizable-vertical-split"
      data-ratio={ratio.toFixed(3)}
    >
      <div className="min-h-0 overflow-auto" style={topStyle}>
        {top}
      </div>
      <div
        ref={handleRef}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize chat / inspector split"
        className={cn(
          "relative h-px shrink-0 cursor-row-resize select-none bg-border transition-colors hover:bg-foreground/20",
          dragging && "bg-foreground/30",
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        data-testid="resizable-vertical-split-handle"
      >
        {/* Wider invisible hitbox above + below the visible 1px bar so
            users don't have to be pixel-perfect to grab the handle. */}
        <div className="absolute inset-x-0 -top-1.5 -bottom-1.5" />
      </div>
      <div className="min-h-0 overflow-auto" style={bottomStyle}>
        {bottom}
      </div>
    </div>
  )
}

function readStoredRatio(storageKey: string | undefined): number | null {
  if (!storageKey || typeof window === "undefined") return null
  const stored = window.localStorage.getItem(storageKey)
  if (stored === null) return null
  const parsed = parseFloat(stored)
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_TOP_RATIO ||
    parsed > MAX_TOP_RATIO
  ) {
    return null
  }
  return parsed
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value < MIN_TOP_RATIO) return MIN_TOP_RATIO
  if (value > MAX_TOP_RATIO) return MAX_TOP_RATIO
  return value
}

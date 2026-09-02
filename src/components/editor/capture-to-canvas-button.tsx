"use client"

/**
 * "Screenshot → canvas" — capture the page the user is currently viewing (the
 * live iframe, NOT the canvas) and add it as a frame on a canvas of their
 * choosing, or a brand-new canvas. The manual counterpart to the LLM-generated
 * screenshot flows: same canvas frames, sourced from a one-off capture.
 */

import { useCallback, useState } from "react"
import { Camera, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Eyebrow, Field, ListRow } from "@/components/blocks"
import { useAppStore } from "@/stores"
import { useLocalCanvases } from "@/hooks/useLocalCanvases"
import { cn } from "@/lib/utils"
import type { ScreenshotPlan } from "@/editor/core/screenshot-plan"
import type { CaptureScreenshotResult } from "@/hooks/useIframeScreenshotCapture"

interface CapturedShot {
  dataUrl: string
  width: number
  height: number
}

interface CaptureToCanvasButtonProps {
  /** Capture the current viewport. Resolves a tagged result carrying the
   *  failure reason (so we can surface why instead of a generic "failed"). */
  capture: () => Promise<CaptureScreenshotResult>
  /** Route (pathname + hash) of the page being captured. */
  currentRoute: string
  /** Prototype origin (base URL) the capture was taken against. */
  baseUrl: string
  /** Whether the bridge is ready (gates the button). */
  enabled?: boolean
  /** Render as an icon-only button (no label) — used in the compact
   *  prototype header. */
  iconOnly?: boolean
  className?: string
}

/** A trivial single-capture "plan" so we reuse addScreenshotPlanToCanvas.
 * `planName` becomes a NEW canvas's name; `frameLabel` is the frame's label. */
function singleCapturePlan(
  shot: CapturedShot,
  currentRoute: string,
  baseUrl: string,
  frameLabel: string,
  planName: string,
): { plan: ScreenshotPlan; screenshots: { stepIndex: number; dataUrl: string; width: number; height: number }[] } {
  const plan: ScreenshotPlan = {
    id: crypto.randomUUID(),
    name: planName,
    baseUrl,
    source: "prompt",
    createdAt: new Date().toISOString(),
    steps: [
      { intent: `Open ${currentRoute}`, kind: "navigate", route: currentRoute },
      { intent: `Capture ${frameLabel}`, kind: "capture", capture: { scope: "viewport", label: frameLabel } },
    ],
  }
  return {
    plan,
    screenshots: [{ stepIndex: 1, dataUrl: shot.dataUrl, width: shot.width, height: shot.height }],
  }
}

export function CaptureToCanvasButton({
  capture,
  currentRoute,
  baseUrl,
  enabled = true,
  iconOnly = false,
  className,
}: CaptureToCanvasButtonProps) {
  const canvases = useAppStore((s) => s.canvases)
  const setActiveCanvasId = useAppStore((s) => s.setActiveCanvasId)
  const { refresh, loadCanvas, addScreenshotPlanToCanvas } = useLocalCanvases({
    enabled,
  })

  const [open, setOpen] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [shot, setShot] = useState<CapturedShot | null>(null)
  const [label, setLabel] = useState("")
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)

  const onCapture = useCallback(async () => {
    setCapturing(true)
    try {
      const result = await capture()
      if (!result.ok) {
        toast.error(`Screenshot capture failed: ${result.message}`)
        return
      }
      setShot(result.shot)
      setLabel(currentRoute || "Screenshot")
      setNewName("")
      await refresh()
      setOpen(true)
    } finally {
      setCapturing(false)
    }
  }, [capture, currentRoute, refresh])

  const addTo = useCallback(
    async (canvasId?: string) => {
      if (!shot) return
      setBusy(true)
      try {
        const frameLabel = label.trim() || currentRoute || "Screenshot"
        // New canvas → use the typed name (else the frame label); appending →
        // name is irrelevant.
        const planName = canvasId ? frameLabel : newName.trim() || frameLabel
        const { plan, screenshots } = singleCapturePlan(
          shot,
          currentRoute,
          baseUrl,
          frameLabel,
          planName,
        )
        const targetId = await addScreenshotPlanToCanvas(
          plan,
          screenshots,
          canvasId ? { canvasId } : undefined,
        )
        if (targetId) {
          toast.success("Screenshot added to canvas.")
          setActiveCanvasId(targetId)
          void loadCanvas(targetId)
          setOpen(false)
          setShot(null)
        } else {
          // addScreenshotPlanToCanvas resolves null on failure (the hook
          // records the reason in its own error state) — without this branch
          // a failed add (e.g. the server rejecting the frame payload) left
          // the dialog open with NO feedback at all (Phase 6 works pass).
          toast.error(
            "Couldn't add the screenshot to the canvas: the server rejected the save. Try again; if it persists, check the CLI logs.",
          )
        }
      } finally {
        setBusy(false)
      }
    },
    [shot, currentRoute, baseUrl, label, newName, addScreenshotPlanToCanvas, setActiveCanvasId, loadCanvas],
  )

  return (
    <>
      <Button
        size={iconOnly ? "icon" : "lg"}
        variant={iconOnly ? "ghost" : "outline"}
        onClick={() => void onCapture()}
        disabled={!enabled || capturing}
        className={cn(!iconOnly && "gap-1.5", className)}
        title="Capture this screen and add it to a canvas"
        aria-label={iconOnly ? "Screenshot → canvas" : undefined}
      >
        {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
        {iconOnly ? null : "Screenshot → canvas"}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Add screenshot to a canvas</DialogTitle>
            <DialogDescription>
              Pick a canvas to drop this screen onto, or start a new one. You can
              then connect it to other screens with arrows.
            </DialogDescription>
          </DialogHeader>

          {/*
            What you are filing: the captured screen and the name it will carry.
            One block, because the label names the thing directly above it.
          */}
          <div className="flex flex-col gap-2 rounded-md border p-3">
            {shot ? (
              <img
                src={shot.dataUrl}
                alt="Captured screen"
                className="max-h-44 w-full rounded border bg-muted/30 object-contain"
              />
            ) : null}
            <Field label="Frame label" htmlFor="capture-frame-label">
              <Input
                id="capture-frame-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Models list"
                disabled={busy}
              />
            </Field>
          </div>

          {/*
            Where it goes. The existing-canvas list and the new-canvas row are
            two answers to one question, so they are rows of one container
            rather than two blocks separated by a rule.
          */}
          <div className="divide-y rounded-md border">
            {canvases.length > 0 ? (
              <div className="flex flex-col gap-1.5 p-3">
                <Eyebrow>Add to an existing canvas</Eyebrow>
                {/*
                  ListRow, not ghost Buttons: a left-aligned ghost button with
                  no border and no icon renders as plain text, so the canvas
                  names did not read as pickable at all. ListRow is the house
                  block for a clickable row in a list and carries the hover
                  state that says so.
                */}
                <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                  {canvases.map((c) => (
                    <ListRow
                      key={c.id}
                      density="dense"
                      disabled={busy}
                      onClick={() => void addTo(c.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    </ListRow>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5 p-3">
              <Eyebrow>
                {canvases.length > 0 ? "Or create a new canvas" : "Create a canvas"}
              </Eyebrow>
              <div className="flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New canvas name (optional)"
                  disabled={busy}
                />
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void addTo()}
                  className="shrink-0 gap-1"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  New canvas
                </Button>
              </div>
            </div>
          </div>
          {/*
            An explicit Close. The header `X` alone is a 16px glyph in a corner
            and the last thing in the reading order. See docs/design.md
            § "Every modal can be dismissed".
          */}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

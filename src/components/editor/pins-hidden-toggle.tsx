"use client"

/**
 * The "hide comments" toggle in the floating toolbar: a pin with a line
 * through it, after Undo and Redo (Mo, 2026-09-02). It hides every comment
 * pin in the prototype without leaving the tool the user is holding.
 *
 * It lived in the Comments panel as a "Hide" switch until then. Hiding pins
 * is something people do while WORKING in the prototype, with whatever tab
 * is open, so the control that does it belongs beside the other per-edit
 * controls and not two clicks away in a panel that may not be showing.
 *
 * Pressed state, not an icon swap. The glyph is the crossed-out pin either
 * way: it names the action, and `aria-pressed` plus the secondary fill say
 * whether it is currently in effect, the same shape `CommentModeButton` uses
 * for its own armed state. Two different pins for the two states would ask
 * the reader to work out which one means "click me to hide".
 *
 * Notes (dormant since 2026-08-14) are not covered here. The panel's old
 * switch hid both kinds together; when Notes wake up, this is where the note
 * bridge's `setNotesHidden` joins the comment one.
 */

import { useCallback } from "react"
import { MapPinOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAppStore } from "@/stores"

export interface PinsHiddenToggleProps {
  /** Tell the comment bridge; the store update happens here. */
  onPinsHiddenChange: (hidden: boolean) => void
}

export function PinsHiddenToggle({ onPinsHiddenChange }: PinsHiddenToggleProps) {
  const pinsHidden = useAppStore((s) => s.pinsHidden)
  const setPinsHidden = useAppStore((s) => s.setPinsHidden)

  const handleClick = useCallback(() => {
    const next = !pinsHidden
    setPinsHidden(next)
    onPinsHiddenChange(next)
  }, [pinsHidden, setPinsHidden, onPinsHiddenChange])

  const label = pinsHidden ? "Show comments" : "Hide comments"

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={pinsHidden ? "secondary" : "ghost"}
            size="icon-sm"
            aria-pressed={pinsHidden}
            aria-label={label}
            data-testid="editor-pins-hidden"
            onClick={handleClick}
          >
            <MapPinOff />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

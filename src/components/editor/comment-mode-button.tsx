"use client"

/**
 * The Comments panel header's Comment control. ONE mount site today
 * (`comments-list-panel.tsx`).
 *
 * It used to have a twin in the toolbar, and the two disagreed on all three
 * things a control can disagree on. The toolbar's was an icon-only toggle
 * (MessageSquarePlus) that lit up while the mode was on; this one was a
 * labelled primary button (MessageCirclePlus) that could only enter the mode,
 * never leave it, and never showed that it was already in it. Since they sit
 * one panel apart, the user could turn comment mode on from one and find no
 * way to turn it off from the other. They were merged onto this component, and
 * then the toolbar's half was replaced by the `Navigate | Select | Comment`
 * picker (2026-08-14), which is why only one caller is left.
 *
 * It reads the mode off `toolMode` (`src/stores/tool-mode-slice.ts`) rather
 * than being told about it, so it cannot drift from the picker. It CAN show a
 * state the bridge is not in, and that is deliberate: `toolMode` is which tool
 * is picked, not what the bridge is armed with. While a new-comment composer
 * is open the bridge is un-armed and this button stays lit, because the user
 * has not put the tool down. Do not "fix" that by writing `navigate` when a
 * pin lands; that is the line sticky placement removed, and it ended the tool
 * after one comment.
 */

import { MessageCirclePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores"
import { selectCommentMode } from "@/stores/tool-mode-slice"

interface CommentModeButtonProps {
  /**
   * Toggle comment placement mode. `true` asks for it (and can be refused,
   * e.g. while the comment store is still deciding where comments go);
   * `false` leaves it.
   */
  onCommentModeChange: (next: boolean) => void
  /** Surface-specific test id, so each mount stays addressable. */
  testId?: string
  className?: string
}

export function CommentModeButton({
  onCommentModeChange,
  testId,
  className,
}: CommentModeButtonProps) {
  const commentMode = useAppStore(selectCommentMode)

  return (
    <Button
      // The Viewer's button, exactly (Mo, 2026-09-02: "same icon and say
      // Add comment"): tertiary at rest, PRIMARY fill while the mode is
      // armed, so the one active control in a row is the loudest thing in
      // it, and colour carries the state as well as weight.
      variant={commentMode ? "default" : "ghost"}
      size="sm"
      onClick={() => onCommentModeChange(!commentMode)}
      title={commentMode ? "Exit comment mode" : "Add comment"}
      aria-pressed={commentMode}
      data-testid={testId}
      className={cn(className)}
    >
      <MessageCirclePlus data-icon="inline-start" />
      Add comment
    </Button>
  )
}

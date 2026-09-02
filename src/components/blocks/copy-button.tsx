"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Copy a string to the clipboard, and say so.
 *
 * Extracted 2026-08-28 from three hand-assembled copies of the same button —
 * the one-time token in `viewer/app/settings/tokens-panel.tsx`, and the invite
 * link and the sign-in link in `viewer/app/settings/members-panel.tsx`. Each
 * carried its own `copyOk` state, its own `handleCopy` callback, and its own
 * `<Copy />{copyOk ? "Copied" : "Copy"}` label. Three is past the promotion
 * rule's threshold of two.
 *
 * ## The icon changes with the label (Mo, 2026-08-28)
 *
 * All three showed the copy glyph in BOTH states, so the successful button
 * read "⧉ Copied" — the icon still offering the action the words said had
 * already happened. The glyph is the faster of the two to read, so leaving it
 * on `Copy` meant the slower half carried the whole message. It swaps to a
 * check.
 *
 * ## Why success expires
 *
 * The three call sites never reset: `copyOk` flipped true and stayed true
 * until the surface went away. A button parked on "Copied ✓" has stopped
 * describing what it will do if pressed, which matters most here, where these
 * values are shown once and a failed paste means the user wants to press it
 * again. After `resetAfterMs` it goes back to offering the action.
 *
 * The timer is cleared on unmount AND replaced on every press, so a
 * double-press cannot leave an earlier timeout to reset the label while the
 * later copy is still fresh.
 *
 * ## A failed copy stays silent, deliberately
 *
 * `navigator.clipboard.writeText` rejects on an insecure origin or a denied
 * permission. The button simply does not flip to "Copied" — it never claims a
 * success that did not happen. It does not raise an error either, and that is
 * the same call the three originals made: the value is on screen and
 * selectable in every one of these surfaces, so the fallback is right there
 * and a banner over it would be louder than the problem. Revisit if a call
 * site ever renders the value in a way that cannot be selected by hand.
 */
export interface CopyButtonProps {
  /** The string written to the clipboard. */
  value: string
  /** Resting label. `"Copied"` replaces it on success. */
  label?: string
  /** Success label. */
  copiedLabel?: string
  /** How long the success state lasts, in milliseconds. */
  resetAfterMs?: number
  variant?: "outline" | "ghost" | "secondary"
  size?: "sm" | "xs" | "default"
  className?: string
  /** Called after a successful write, for a caller that tracks its own state. */
  onCopied?: () => void
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  resetAfterMs = 2000,
  variant = "outline",
  size = "sm",
  className,
  onCopied,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  // A new `value` clears the success state, during render.
  //
  // Without this, a surface that swaps one secret for another under a mounted
  // button leaves "Copied ✓" standing over a string the clipboard does not
  // hold. `members-panel.tsx` does exactly that: regenerating an invite, or
  // creating a second one, replaces `revealed.url` in place. Its hand-rolled
  // predecessors each reset their own `copyOk` at all three of those call
  // sites, so collapsing them into this block would have dropped that
  // guarantee silently — and a label claiming a copy that never happened is
  // the one failure mode here that actually costs the user something.
  //
  // This is React's "adjust state when a prop changes" pattern, not an
  // effect: setting state during render re-runs this component immediately
  // and commits once, whereas `useEffect` would paint the stale "Copied" for
  // a frame first (and trips `react-hooks/set-state-in-effect`).
  //
  // No timer clearing needed alongside it. A stale timeout can only call
  // `setCopied(false)` on state that is already false, and the one case where
  // it could fire early — copying the new value before the old timer lands —
  // is already covered by `handleCopy` clearing the timer before it sets its
  // own.
  const [copiedValue, setCopiedValue] = useState(value)
  if (copiedValue !== value) {
    setCopiedValue(value)
    setCopied(false)
  }

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Never flip to a success the write did not earn. See the header.
      return
    }
    setCopied(true)
    onCopied?.()
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), resetAfterMs)
  }, [value, onCopied, resetAfterMs])

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(className)}
      onClick={() => void handleCopy()}
      data-copied={copied ? "true" : undefined}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? copiedLabel : label}
    </Button>
  )
}

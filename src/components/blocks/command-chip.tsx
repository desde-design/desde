"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * CommandChip — a shell command inside prose, as a light grey chip you can copy.
 *
 * Any command we tell the user to run is something they have to reproduce
 * exactly in a terminal. Rendered as bare `<code>` inside a sentence, the only
 * way to do that is to select it with the mouse, and a double-click stops at
 * the first space, so `gh auth login` takes a careful drag. The chip makes it
 * one click and marks the command as a thing to act on rather than a phrase to
 * read.
 *
 * Sized to sit inline in a hint or a description without changing the line
 * height around it: `text-code` (11px, the mono floor) on a `bg-muted` ground,
 * with an `icon-xs` ghost button. Mono never takes a sans size class, which is
 * why this is `text-code` and not `text-xs`.
 *
 * ## Scope
 *
 * For a command the user runs THEMSELVES, in their own terminal. Not for
 * showing a file path, a package name, or a value: those are identifiers and
 * `<code className="font-mono">` is right for them, because there is nothing to
 * execute and a copy button would be noise on every one of them.
 *
 * ## The clipboard call can reject
 *
 * `navigator.clipboard.writeText` rejects on an insecure origin and when the
 * document is not focused. The existing chat copy button
 * (`chat-thread.tsx CodeHeader`) chains `.then()` with no `.catch`, so a
 * rejection there is an unhandled promise rejection and the button silently
 * does nothing. This one keeps the button honest instead: the label falls back
 * to selecting the text so a keyboard copy still works, and the failure is not
 * swallowed.
 */
export interface CommandChipProps {
  /** The exact command, copied verbatim. */
  command: string
  /** Accessible label for the copy button. Defaults to naming the command. */
  copyLabel?: string
  className?: string
}

export function CommandChip({ command, copyLabel, className }: CommandChipProps) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const codeRef = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear on unmount: without this a chip copied and then closed with its
  // dialog sets state on an unmounted component 1.5s later.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const flash = (ok: boolean) => {
    setCopied(ok)
    setFailed(!ok)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, 1500)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      flash(true)
    } catch {
      // Insecure origin, or the document lost focus. Select the text so the
      // user's own copy shortcut still works, rather than leaving a button
      // that appears to do nothing.
      const node = codeRef.current
      if (node) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      flash(false)
    }
  }

  return (
    <span
      // Tight. The chip sits inside a running sentence, so vertical padding is
      // what pushes the line apart from the ones above and below it: `py-0`
      // lets the `icon-xs` button's own height set the box. Horizontal is
      // `pl-1` / `pr-0`, the button carrying its own right-hand space.
      className={cn(
        "inline-flex items-center gap-0.5 rounded border bg-muted py-0 pr-0 pl-1 align-middle",
        className,
      )}
    >
      <code ref={codeRef} className="font-mono text-code text-foreground">
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => void handleCopy()}
        aria-label={copyLabel ?? `Copy ${command}`}
        data-testid="command-chip-copy"
      >
        {copied ? (
          <Check className="text-success" />
        ) : (
          <Copy className={cn(failed && "text-destructive")} />
        )}
      </Button>
      {/*
        The flash is a colour change on a 12px glyph, which a screen reader
        never sees and a colourblind user may not either. Announce it.
      */}
      <span role="status" className="sr-only">
        {copied ? "Copied" : failed ? "Couldn't copy, the command is selected" : ""}
      </span>
    </span>
  )
}

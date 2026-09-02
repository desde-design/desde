"use client"

/**
 * Renders the per-element right-click menu produced by the bridge's
 * inspector overlay. Same positioning + dropdown shape as the
 * table-edge menu — a zero-size invisible Radix trigger pinned at the
 * shell-translated anchor coordinates.
 *
 * Items:
 *  - "Open in editor" → in-app code editor view, scoped to the file
 *    the element was authored in (`authoredAt.file`). Disabled when
 *    the bridge couldn't attribute the click to a source location.
 *  - "Open in VS Code" → `vscode://file/...` jump to the same file
 *    + line. Disabled when the CLI didn't provide a repo root
 *    (`EDITOR_REPO_ROOT` absent — web shell or an older bootstrap; no
 *    absolute path to build the URL from).
 *  - Inline chat field (bottom) → starts a fresh chat session in the
 *    normal chat panel, seeded with the typed prompt. The right-clicked
 *    element is already the editor selection (the same `contextmenu`
 *    handler that opened this menu emitted `ELEMENT_INSPECTED`), so the
 *    agent receives it as selection context automatically.
 */

import { useEffect, useRef, useState } from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Code, ExternalLink, SendHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { UseElementContextMenuReturn } from "@/hooks/useElementContextMenu"

interface ElementContextMenuProps {
  controller: UseElementContextMenuReturn
  /**
   * Open the in-app code view on a source position.
   *
   * OPTIONAL, and its absence is the gate: the code view is dormant
   * (`EDITOR_CODE_VIEW`), and when it is off the surface passes nothing
   * and the "Open in editor" item is not rendered at all. Same rule the
   * dormant edit lanes use, so the flag stays out of this component.
   * "Open in VS Code" below is a separate affordance with its own gate
   * (`onOpenInVscode`), never this one.
   */
  onOpenFileEditor?: (target: {
    filePath: string
    line?: number
    column?: number
  }) => void
  /**
   * Whether to offer "Open in VS Code". Dormant by default
   * (`EDITOR_VSCODE_LINK`, product decision 2026-08-18): the item assumes
   * an editor choice the product otherwise never makes for the user, and
   * silently does nothing for anyone without VS Code and its protocol
   * handler registered.
   *
   * A BOOLEAN, where `onOpenFileEditor` above is a handler whose absence
   * gates it, and the difference is real rather than inconsistency. The
   * code view needs the surface to open a pane, so the surface must supply
   * something; this item needs nothing from the surface at all — it builds
   * a `vscode://` URL from props it already holds and assigns
   * `window.location.href`. A handler here would be a callback invented
   * solely to be absent.
   */
  vscodeLinkEnabled?: boolean
  /**
   * Start a new chat session seeded with `prompt`. Called when the user
   * submits the inline chat field. No-op-safe: the surface gates on the
   * edit session being active and toasts if it isn't.
   */
  onStartChat: (prompt: string) => void
}

function getRepoRoot(): string | null {
  if (typeof window === "undefined") return null
  const cli = (
    window as unknown as {
      __DESDE_CLI__?: { repoRoot?: string | null }
    }
  ).__DESDE_CLI__
  return cli?.repoRoot ?? null
}

/**
 * Inline "start a chat about this element" field. Lives in its own
 * component so its `useState` isn't subject to the parent's early
 * return, and so it's mounted fresh (empty draft) each time the menu
 * opens.
 *
 * Radix Menu nuances handled here:
 *  - keydown is stopped from bubbling to the menu root so the built-in
 *    typeahead / arrow-key roving doesn't swallow keystrokes (Escape is
 *    let through so it still closes the menu).
 *  - pointerdown is stopped so clicking into the field doesn't trigger
 *    menu item focus/selection.
 */
function StartChatField({
  label,
  onSubmit,
}: {
  label: string
  onSubmit: (prompt: string) => void
}) {
  const [value, setValue] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = value.trim()

  // Radix Menu's focus scope focuses the first item on open; defer our
  // focus to the next frame so it wins and the user can type immediately.
  useEffect(() => {
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])

  const submit = () => {
    if (trimmed.length === 0) return
    onSubmit(trimmed)
  }

  return (
    <div
      className="px-1 pt-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") return
        e.stopPropagation()
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          submit()
        }
      }}
    >
      <div className="flex items-end gap-1">
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={`Ask about this ${label}…`}
          className="min-h-0 flex-1 resize-none rounded-sm border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={submit}
          disabled={trimmed.length === 0}
          aria-label="Start chat"
          className="shrink-0"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="px-0.5 pt-1 text-2xs text-muted-foreground">
        Enter to start a new chat · Shift+Enter for newline
      </p>
    </div>
  )
}

export function ElementContextMenu({
  controller,
  onOpenFileEditor,
  vscodeLinkEnabled = false,
  onStartChat,
}: ElementContextMenuProps) {
  const { menu, dismiss } = controller
  if (!menu) return null

  const { payload, shellAnchor } = menu
  const authoredAt = payload.inspection.authoredAt
  const headerLabel =
    payload.inspection.directComponent?.name ??
    payload.inspection.component?.name ??
    payload.inspection.tagName

  const repoRoot = getRepoRoot()
  const openEditorDisabled = !authoredAt
  const openVscodeDisabled = !authoredAt || !repoRoot

  const handleOpenInEditor = () => {
    if (!authoredAt || !onOpenFileEditor) return
    onOpenFileEditor({
      filePath: authoredAt.file,
      line: authoredAt.line,
      column: authoredAt.column,
    })
  }

  const handleOpenInVscode = () => {
    if (!authoredAt || !repoRoot || !vscodeLinkEnabled) return
    // `vscode://file/<abs>:<line>:<col>` is the documented launch URL.
    // Works whenever the user has VS Code installed and registered the
    // protocol handler.
    //
    // The bridge's `authoredAt.file` is supposed to be relative to the
    // Vite root (== the repo root in branch mode). Defend against:
    //   - absolute paths sneaking in (would break the join + change scope)
    //   - `..` segments (would resolve outside the repo)
    //   - special chars (spaces, `#`, `?`) that break URL parsing
    // First two are validation; the third is URI encoding.
    const relFile = authoredAt.file
    if (relFile.length === 0 || relFile.startsWith("/") || relFile.includes("..")) {
      toast.error("Open in VS Code refused", {
        description: `Suspicious path: ${relFile}`,
      })
      return
    }
    const sep = repoRoot.endsWith("/") ? "" : "/"
    const abs = `${repoRoot}${sep}${relFile}`
    // Encode each segment so spaces / `#` / `?` / `%` survive. Keep
    // path separators intact.
    const encodedAbs = abs.split("/").map(encodeURIComponent).join("/")
    const url = `vscode://file${encodedAbs.startsWith("/") ? "" : "/"}${encodedAbs}:${authoredAt.line}:${authoredAt.column}`
    try {
      window.location.href = url
    } catch (err) {
      toast.error("Open in VS Code failed", {
        description: (err as Error).message,
      })
    }
  }

  const shortFile = authoredAt ? authoredAt.file.split("/").pop() ?? "" : ""

  return (
    <DropdownMenuPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DropdownMenuPrimitive.Trigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: "fixed",
            left: shellAnchor.x,
            top: shellAnchor.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="min-w-[16rem]"
      >
        <DropdownMenuLabel className="truncate text-sm text-muted-foreground">
          {headerLabel}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onOpenFileEditor ? (
          <DropdownMenuItem
            onSelect={handleOpenInEditor}
            disabled={openEditorDisabled}
          >
            <Code className="h-3.5 w-3.5" />
            Open in editor
            {!openEditorDisabled ? (
              <span className="ml-auto truncate font-mono text-code text-muted-foreground">
                {shortFile}:{authoredAt!.line}
              </span>
            ) : null}
          </DropdownMenuItem>
        ) : null}
        {vscodeLinkEnabled ? (
          <DropdownMenuItem
            onSelect={handleOpenInVscode}
            disabled={openVscodeDisabled}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in VS Code
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <StartChatField
          label={headerLabel}
          onSubmit={(prompt) => {
            onStartChat(prompt)
            dismiss()
          }}
        />
      </DropdownMenuContent>
    </DropdownMenuPrimitive.Root>
  )
}

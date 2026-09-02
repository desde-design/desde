"use client"

/**
 * Renders the row/column right-click menu produced by the bridge's
 * table-edge overlay. Positions itself in the shell viewport at the
 * coordinates the hook translates from iframe-local space.
 *
 * Uses the radix DropdownMenu with a controlled `open` state and a
 * zero-size invisible trigger pinned at the anchor coordinates — radix
 * computes side / collision-avoidance from there.
 */

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  actionLabel,
  type TableEdgeAction,
} from "@/lib/table-edge-instruction"
import type { UseTableEdgeMenuReturn } from "@/hooks/useTableEdgeMenu"

interface TableEdgeMenuProps {
  controller: UseTableEdgeMenuReturn
}

export function TableEdgeMenu({ controller }: TableEdgeMenuProps) {
  const { menu, dismiss, runAction } = controller
  if (!menu) return null

  const { payload, shellAnchor } = menu
  const kind = payload.kind
  const actions: TableEdgeAction[] = ["delete", "addBefore", "addAfter", "duplicate"]

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
      <DropdownMenuContent align="start" sideOffset={2} className="min-w-[12rem]">
        <DropdownMenuLabel className="text-sm text-muted-foreground">
          {kind === "row"
            ? `Row ${payload.index + 1} of ${payload.totalBands}`
            : `Column ${payload.index + 1} of ${payload.totalBands}`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {actions.map((action) => (
          <DropdownMenuItem
            key={action}
            onSelect={() => runAction(action)}
            variant={action === "delete" ? "destructive" : "default"}
          >
            {actionLabel(action, kind)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuPrimitive.Root>
  )
}

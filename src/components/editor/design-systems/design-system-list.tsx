"use client"

/**
 * The design systems declared for a project, as a list you add to and remove
 * from.
 *
 * Replaces the chips-plus-inline-form shape (Mo, 2026-08-17). Chips were wrong
 * for this on two counts: they read as tags on something else rather than as
 * the contents of the step, and they gave every entry exactly one affordance
 * (remove) when an entry a person typed also needs editing.
 *
 * ## Detected entries are seeded, not chosen
 *
 * Anything already installed in the prototype but not registered arrives here
 * automatically. It carries a "detected" marker so the list says where each
 * row came from — a row someone typed and a row we found are different facts,
 * and only the typed one can be edited.
 *
 * A detected row is still removable. Being found is not consent, and the
 * scan is a heuristic over `node_modules`; the user has to be able to say no.
 *
 * ## Purely presentational
 *
 * The caller owns the entries and the mutations, same contract as
 * `AddDesignSystem` before it, so the New Project step and the settings panel
 * can share this without either owning the other's data.
 */

import { MoreVertical, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/blocks"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"

export interface DesignSystemListEntry {
  /** Stable identity, from `pendingIdentity`. */
  id: string
  /** What to show: the package name, the spec, or the repo URL. */
  label: string
  /**
   * Seeded from the installed-but-unregistered scan rather than typed. Not
   * editable — there are no fields behind it, only the package it was found
   * as — but still removable.
   */
  detected: boolean
  declaration: DesignSystemDeclaration
}

export interface DesignSystemListProps {
  entries: readonly DesignSystemListEntry[]
  loading?: boolean
  busy?: boolean
  onAdd: () => void
  onEdit: (entry: DesignSystemListEntry) => void
  onRemove: (id: string) => void
}

export function DesignSystemList({
  entries,
  loading = false,
  busy = false,
  onAdd,
  onEdit,
  onRemove,
}: DesignSystemListProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="design-system-list">
      {loading && entries.length === 0 ? (
        <p className="text-base text-muted-foreground" data-testid="design-system-list-loading">
          Looking for design systems already installed here
        </p>
      ) : entries.length === 0 ? (
        <EmptyState
          size="sm"
          title="No design systems"
          description="Add one so the agent builds with its components instead of inventing its own."
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 px-3 py-2"
              data-testid={`design-system-row-${entry.id}`}
            >
              {/*
                The marker sits BESIDE the name, not right-aligned against the
                menu. It qualifies the name — "this one we found" — and pushed
                to the far edge it read as a column of its own, which invited
                scanning it as a status you act on rather than a note about
                where the row came from.
              */}
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-base">{entry.label}</span>
                {entry.detected ? (
                  <Badge variant="outline" className="shrink-0">
                    Detected
                  </Badge>
                ) : null}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    aria-label={`More actions for ${entry.label}`}
                    data-testid={`design-system-row-menu-${entry.id}`}
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/*
                    Edit is offered only where there is something to edit. A
                    detected entry is a package name we found, with no spec,
                    ref or subdir behind it, so an Edit there would open a form
                    with nothing in it.
                  */}
                  {entry.detected ? null : (
                    <DropdownMenuItem onSelect={() => onEdit(entry)}>Edit</DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onRemove(entry.id)}
                  >
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      {/*
        Under the list, which is where the brief puts it and where it belongs:
        the button acts on the list, so it follows it. `outline`, not the
        primary — the step's primary action is in the page footer, and two
        filled buttons on one screen would compete over which one continues.
      */}
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          disabled={busy}
          data-testid="design-system-add"
        >
          <Plus />
          Add design system
        </Button>
      </div>
    </div>
  )
}

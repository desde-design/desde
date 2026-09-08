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
 * ## Found rows are offered, not seeded
 *
 * A second kind of detection arrived with the React arm of the scan
 * (2026-09-08). `*.vue.d.ts` is a certain marker, so a Vue library found in
 * `node_modules` goes straight into the list above. The React marker is only
 * likely: on a real dashboard it returns a dozen packages the prototype
 * renders from, and no scan can say which of them the user calls a design
 * system. Those arrive as `found` rows under the list, each with its own Add,
 * and nothing is declared until someone clicks. Seeding them would have
 * registered every small UI package on the next boot.
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

/** A library the scan found but is not sure about. Added with a click, never seeded. */
export interface DesignSystemFoundEntry {
  /** The package name, which is also what Add declares. */
  id: string
  label: string
  /** What the scan knows about it, e.g. "54 components". */
  caption: string
}

export interface DesignSystemListProps {
  entries: readonly DesignSystemListEntry[]
  found?: readonly DesignSystemFoundEntry[]
  loading?: boolean
  busy?: boolean
  onAdd: () => void
  onEdit: (entry: DesignSystemListEntry) => void
  onRemove: (id: string) => void
  onAddFound?: (id: string) => void
}

export function DesignSystemList({
  entries,
  found = [],
  loading = false,
  busy = false,
  onAdd,
  onEdit,
  onRemove,
  onAddFound,
}: DesignSystemListProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="design-system-list">
      {loading && entries.length === 0 ? (
        <p className="text-base text-muted-foreground" data-testid="design-system-list-loading">
          Looking for libraries this prototype uses
        </p>
      ) : entries.length === 0 ? (
        <EmptyState
          size="sm"
          title="Nothing found to add"
          description="Components written in this repo are picked up on their own. Add a library if this prototype uses one from npm or a Git repository."
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

      {found.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="design-system-found">
          <p className="text-sm text-muted-foreground">
            Also found in this prototype. Add the ones that are its design system.
          </p>
          <ul className="flex flex-col divide-y rounded-md border">
            {found.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 px-3 py-2"
                data-testid={`design-system-found-${entry.id}`}
              >
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="truncate text-base">{entry.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{entry.caption}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => onAddFound?.(entry.id)}
                  data-testid={`design-system-found-add-${entry.id}`}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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

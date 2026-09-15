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
 * The React arm of the scan (2026-09-08) is only "likely" about what it
 * finds: on a real dashboard it returns a dozen packages the prototype renders
 * from. For one afternoon those were OFFERED under the list with their own Add
 * instead of seeded. Mo reversed that the same day: one rule, found means
 * added, remove what is not a design system. The cost of a wrong seed is a
 * removable row and a few seconds of manifest extraction on the next boot; the
 * cost of offering was a screen of Add buttons under an empty list.
 *
 * ## Purely presentational
 *
 * The caller owns the entries and the mutations, same contract as
 * `AddDesignSystem` before it, so the New Project step and the settings panel
 * can share this without either owning the other's data.
 */

import { CircleCheck, MoreVertical, Plus } from "lucide-react"
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
import type { FirstPartyDetection } from "@/editor/onboarding/detect-first-party"

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
  /**
   * What the prototype already has, shown in place of the empty state.
   *
   * An empty list used to read "Nothing found to add", and designers took
   * that to mean nothing was detected, and from there that variants would
   * not work (Mo, 2026-09-15). A shadcn repo is the common case: its
   * components are files in the repo, so there is nothing to register and
   * everything already works. The step has to show the evidence, not just
   * assert it in a caption. `undefined` while the scan is running; `null`
   * when there is genuinely nothing to report.
   */
  firstParty?: FirstPartyDetection | null
  onAdd: () => void
  onEdit: (entry: DesignSystemListEntry) => void
  onRemove: (id: string) => void
}

/**
 * The count is the evidence; the sentence after it is what changes for the
 * reader. A named system needs nothing more said. Without one, the reader
 * still has to be told when adding a library IS the right move.
 */
function firstPartyDescription(detection: FirstPartyDetection): string {
  const n = detection.componentCount
  const count = `${n} ${n === 1 ? "component" : "components"}`
  return detection.system
    ? `${count} in this repo are already available. Nothing to set up.`
    : `${count} are already available. Add a library only if this prototype pulls one from npm or a Git repository.`
}

export function DesignSystemList({
  entries,
  loading = false,
  busy = false,
  firstParty = null,
  onAdd,
  onEdit,
  onRemove,
}: DesignSystemListProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="design-system-list">
      {loading && entries.length === 0 ? (
        <p className="text-base text-muted-foreground" data-testid="design-system-list-loading">
          Looking for libraries this prototype uses
        </p>
      ) : entries.length === 0 ? (
        firstParty ? (
          // A confirmation, not an empty state, so the cat gives way to a
          // check: the picture has to say "found", because the title is
          // the only other thing on screen saying it.
          <EmptyState
            size="sm"
            illustration={false}
            icon={<CircleCheck />}
            title={
              firstParty.system
                ? `${firstParty.system.label} detected`
                : "Using components written in this repo"
            }
            description={firstPartyDescription(firstParty)}
            data-testid="design-system-first-party"
          />
        ) : (
          <EmptyState
            size="sm"
            title="No libraries to add"
            description="Components written in this repo are picked up on their own. Add a library if this prototype uses one from npm or a Git repository."
          />
        )
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
        the button acts on the list, so it follows it. Centred (Mo,
        2026-09-08). `outline`, not the primary: the step's primary action is
        in the page footer, and two filled buttons on one screen would compete
        over which one continues.
      */}
      <div className="flex justify-center">
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

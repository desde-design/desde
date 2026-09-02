"use client"

/**
 * The reference-directories settings surface: what the agent can currently
 * read, plus the form to add another.
 *
 * Lives behind the settings gear, not on the right rail. The rail is capped at
 * four tabs, and the Design systems panel was already moved off it for exactly
 * this reason: a surface used during setup should not spend permanent chrome.
 *
 * The list is not just the config file read back. Each row reports whether the
 * directory still resolves and whether it is a git repo, because a folder
 * declared last month may since have been moved, and the config alone cannot
 * say. A declared directory that no longer resolves appears in `warnings`
 * rather than in the list, which is why the warnings render here rather than
 * being logged and forgotten.
 */

import { MoreVertical, Plus } from "lucide-react"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Callout, EmptyState } from "@/components/blocks"
import { useReferenceDirs } from "@/hooks/useReferenceDirs"
import { cn } from "@/lib/utils"

import { AddReferenceDirectory } from "./add-reference-directory"

export interface ReferenceDirsPanelProps {
  /** Mount-gated by the dialog, so the list refetches every time it opens. */
  enabled: boolean
  className?: string
}

export function ReferenceDirsPanel({ enabled, className }: ReferenceDirsPanelProps) {
  const dirs = useReferenceDirs(enabled)
  const [addOpen, setAddOpen] = useState(false)

  // The worktree is always present and is not a reference directory the user
  // declared, so it is not something they can remove. Filtering it out keeps
  // the list to "what I added".
  const declared = (dirs.roots ?? []).filter((r) => !r.isWorktree)
  const takenNames = (dirs.roots ?? []).map((r) => r.name)

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {dirs.error ? (
        <p className="text-sm text-destructive" role="alert">
          {dirs.error}
        </p>
      ) : null}

      {dirs.warnings.length > 0 ? (
        <Callout tone="warning" data-testid="reference-dirs-warnings">
          {dirs.warnings.join(" ")}
        </Callout>
      ) : null}

      {dirs.roots === null ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : declared.length === 0 ? (
        <EmptyState
          size="sm"
          title="No reference folders"
          description="Point the agent at a production repo, or any other folder this prototype should match."
        />
      ) : (
        // Same shape as `DesignSystemList` (Mo, 2026-08-18: "follow the design
        // systems shape"). Two lists that do the same job — the things you
        // declared, with a way to add and a way to drop each one — had two
        // different row geometries, two type sizes and two affordances.
        <ul className="divide-y rounded-md border" data-testid="reference-dirs-list">
          {declared.map((root) => (
            <li key={root.name} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {/* `text-base`, matching the design-system rows. `text-xs` is
                      the rail size; this is a dialog. */}
                  <span className="truncate text-base">{root.name}</span>
                  {/*
                    "Not found" outranks "no history": a folder that does not
                    resolve has no capabilities at all, so reporting which
                    subset of tools apply to it would be noise.
                  */}
                  {root.resolves === false ? (
                    <Badge variant="destructive" className="shrink-0">
                      Not found
                    </Badge>
                  ) : !root.isGit ? (
                    <Badge variant="outline" className="shrink-0">
                      No history
                    </Badge>
                  ) : null}
                </div>
                {/* Split spans, not one font for the row: the path is code, the
                    description is the user's own words. */}
                <p className="truncate font-mono text-code text-muted-foreground">{root.path}</p>
                {root.description ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{root.description}</p>
                ) : null}
              </div>
              {/*
                A menu, not a bare trash icon. It matches the design-system
                rows, and it puts a destructive action one deliberate step away
                instead of under a single mis-click in a dense list. One item
                today; Edit belongs here when reference folders become
                editable rather than remove-and-re-add.
              */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={dirs.busy}
                    aria-label={`More actions for ${root.name}`}
                    data-testid={`reference-dir-row-menu-${root.name}`}
                  >
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => void dirs.remove(root.name)}
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
        Add is a MODAL now, not a form living under the list (Mo, 2026-08-17:
        "the list and adding isn't in the same modal"). Same move the design
        systems step made, for the same reason `docs/design.md` § "Steps, not
        tabs" gives: inline, the form sat there permanently for everyone,
        including the majority who opened this to glance at the list.
      */}
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setAddOpen(true)}
          disabled={dirs.busy}
          data-testid="reference-dir-add-open"
        >
          <Plus />
          Add reference folder
        </Button>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent size="lg" data-testid="add-reference-dir-dialog">
          <DialogHeader>
            <DialogTitle>Add a reference folder</DialogTitle>
            <DialogDescription>
              A folder the agent may read but never writes to, like a production
              repo this prototype should match.
            </DialogDescription>
          </DialogHeader>
          {/*
            The form owns its own submit, so this dialog contributes no footer
            row of its own — two "Add" buttons a few pixels apart is the
            exact confusion `docs/design.md` warns about for nested flows.
            Cancel rides the form's own action row via `footerStart` instead,
            because a header X alone is not a visible way out (Mo,
            2026-08-29: every modal footer carries a Close or Cancel).
          */}
          <AddReferenceDirectory
            density="launcher"
            busy={dirs.busy}
            takenNames={takenNames}
            onInspect={dirs.inspect}
            onBrowse={dirs.pickerSupported ? dirs.pick : undefined}
            footerStart={
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
            }
            onAdd={async (entry) => {
              const ok = await dirs.add(entry)
              // Only close on success: a refused add (duplicate name, missing
              // folder) has to leave the form up with what was typed.
              if (ok) setAddOpen(false)
              return ok
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

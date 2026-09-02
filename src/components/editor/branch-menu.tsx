"use client"

/**
 * Branch switcher — Phase 2 of tasks/branches-vs-worktree.md. A git-branch
 * dropdown: shows the current branch, lists the others to switch to, and
 * creates / duplicates / renames / publishes branches. Branch mode is the
 * only editor edit substrate, so this always renders.
 */

import * as React from "react"
import { toast } from "sonner"
import { GitBranch, ChevronDown, Check, Plus, Copy, Pencil, Upload } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { BranchesApi } from "@/hooks/useEditorBranches"
import { ConflictFileList } from "@/components/editor/branch-mode-controls"
import { Eyebrow } from "@/components/blocks"

type DialogMode =
  | { kind: "create"; base: "default" | "current" }
  | { kind: "rename"; from: string }
  | { kind: "publish"; branch: string; defaultBranch: string }

export function BranchMenu({
  branches,
  asBreadcrumb = false,
}: {
  branches: BranchesApi
  /** Render the trigger as a breadcrumb segment (ghost text, no box). */
  asBreadcrumb?: boolean
}) {
  const [dialog, setDialog] = React.useState<DialogMode | null>(null)

  const label = branches.current ?? "detached HEAD"

  const onSwitch = async (name: string) => {
    if (name === branches.current) return
    const res = await branches.switchBranch(name)
    if (!res.ok) {
      toast.error(`Couldn't switch branch: ${res.reason ?? "unknown error"}`)
    }
  }

  const onDefault = branches.current && branches.current === branches.defaultBranch

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={asBreadcrumb ? "ghost" : "outline"}
            size="sm"
            className={cn(
              asBreadcrumb
                ? "max-w-48 gap-1 px-1.5 font-normal"
                : "max-w-48 gap-1.5",
            )}
            data-testid="branch-menu-trigger"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>
            <Eyebrow as="span" size="sm">
              Branches
            </Eyebrow>
          </DropdownMenuLabel>
          {branches.branches.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => void onSwitch(b.name)}
              data-testid={`branch-item-${b.name}`}
            >
              <Check className={cn(b.current ? "opacity-100" : "opacity-0")} />
              <span className="flex-1 truncate">{b.name}</span>
              {b.isDefault ? (
                <span className="text-xs text-muted-foreground">default</span>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setDialog({ kind: "create", base: "default" })}
          >
            <Plus />
            New branch{branches.defaultBranch ? ` from ${branches.defaultBranch}` : ""}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDialog({ kind: "create", base: "current" })}
            disabled={!branches.current}
          >
            <Copy />
            Duplicate current branch
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              branches.current && setDialog({ kind: "rename", from: branches.current })
            }
            disabled={!branches.current}
          >
            <Pencil />
            Rename current branch…
          </DropdownMenuItem>
          {branches.current && branches.defaultBranch && !onDefault ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  setDialog({
                    kind: "publish",
                    branch: branches.current!,
                    defaultBranch: branches.defaultBranch!,
                  })
                }
                data-testid="branch-publish"
              >
                <Upload />
                Publish to {branches.defaultBranch}…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <BranchNameDialog
        mode={dialog}
        branches={branches}
        onClose={() => setDialog(null)}
      />
    </>
  )
}

/**
 * Shared create/rename/publish dialog — a single text input that submits
 * to the right branch action based on `mode`. Errors from git (invalid
 * name, duplicate, conflict) render inline instead of closing the dialog.
 */
function BranchNameDialog({
  mode,
  branches,
  onClose,
}: {
  mode: DialogMode | null
  branches: BranchesApi
  onClose: () => void
}) {
  const [value, setValue] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  // A publish conflict names its files — rendered as a mono list under the
  // error, the same shape the Merge/Push dialogs use.
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  // Reset the field each time a dialog opens (mode transitions non-null).
  React.useEffect(() => {
    if (mode) {
      setValue(mode.kind === "rename" ? mode.from : "")
      setError(null)
      setConflictFiles([])
      setBusy(false)
    }
  }, [mode])

  if (!mode) return null

  const title =
    mode.kind === "rename"
      ? "Rename branch"
      : mode.kind === "publish"
        ? `Publish to ${mode.defaultBranch}`
        : mode.base === "current"
          ? "Duplicate current branch"
          : "New branch"

  const placeholder = mode.kind === "publish" ? `branch: ${mode.branch}` : "branch-name"

  const submit = async () => {
    const text = value.trim()
    // Only create/rename require a non-empty name; publish's message is optional.
    if (mode.kind !== "publish" && !text) {
      setError("Enter a branch name.")
      return
    }
    setBusy(true)
    setError(null)
    setConflictFiles([])
    const res =
      mode.kind === "rename"
        ? await branches.renameBranch(mode.from, text)
        : mode.kind === "create"
          ? await branches.createBranch(text, mode.base)
          : await branches.publishBranch(text || undefined)
    setBusy(false)
    if (!res.ok) {
      setError(res.reason ?? "Something went wrong.")
      setConflictFiles(res.conflictFiles ?? [])
      return
    }
    if (mode.kind === "publish") toast.success(`Published to ${mode.defaultBranch}.`)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {/*
            Radix warns when a DialogContent has neither a Description nor an
            explicit `aria-describedby={undefined}`, and this dialog had
            neither — screen-reader users got the title and nothing else. The
            publish copy already existed as a loose <p> below the header; it is
            the description, so it lives here now rather than being duplicated.
          */}
          <DialogDescription>
            {mode.kind === "publish" ? (
              <>
                Squash-merges <span className="text-foreground">{mode.branch}</span> into{" "}
                <span className="text-foreground">{mode.defaultBranch}</span> as one commit. You
                stay on this branch. Add an optional commit message:
              </>
            ) : mode.kind === "rename" ? (
              <>
                Renames <span className="text-foreground">{mode.from}</span>. Uncommitted changes
                stay where they are.
              </>
            ) : (
              // Both create modes switch to the new branch, and `createBranch`
              // refuses outright when the working tree is dirty
              // (git-branches.ts — "the same dirty-tree carry-over applies").
              // So this must NOT promise that uncommitted work comes along; an
              // earlier draft did, which is the opposite of what happens, and
              // a dirty tree is the normal state in branch mode.
              <>
                {mode.base === "current" ? (
                  <>
                    Branches from{" "}
                    <span className="text-foreground">{branches.current}</span> and switches to it.
                  </>
                ) : branches.defaultBranch ? (
                  // Guarded the same way the dropdown label is: with no default
                  // branch resolved, `createBranch` omits the start-point and
                  // branches off HEAD instead.
                  <>
                    Branches from{" "}
                    <span className="text-foreground">{branches.defaultBranch}</span> and switches
                    to it.
                  </>
                ) : (
                  "Branches from the current commit and switches to it."
                )}{" "}
                Commit your changes first: this is refused while the working tree is dirty.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submit()
            }}
            placeholder={placeholder}
            data-testid="branch-name-input"
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive" data-testid="branch-name-error">
              {error}
            </p>
          ) : null}
          <ConflictFileList files={conflictFiles} />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy
              ? "Working…"
              : mode.kind === "rename"
                ? "Rename"
                : mode.kind === "publish"
                  ? "Publish"
                  : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

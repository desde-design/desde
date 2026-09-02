"use client"

/**
 * Branch-mode Commit + Merge/Push controls (tasks/branches-vs-worktree.md).
 *
 * Branch mode edits the working tree in place with no promote/Save step, so
 * the nav-bar slot renders two affordances:
 *
 *  - **Commit** — `git add -A && git commit` of the working tree onto the
 *    checked-out branch (the everyday "save my edits to git" boundary).
 *    Shows the changed-file count and disables on a clean tree.
 *  - **Merge / Push** — a dropdown of the "send my branch somewhere" actions,
 *    since local `main` is usually NOT the destination that matters (the
 *    served prototype lives on the remote). Items, each self-disabling with a
 *    plain-language reason:
 *      1. **Push branch** — commit pending edits + `git push origin <branch>`
 *         (uses the user's own git credentials; no auth handled here).
 *      2. **Merge & push to <default>** — squash-merge into the default
 *         branch locally, then push the default to origin.
 *      3. **Merge to local <default>** — squash-merge locally only; GitHub
 *         untouched (the `publishBranch` op).
 *      4. **Open pull request** — opens `PullRequestDialog` and creates the PR
 *         through the user's own `gh`. Disabled only when there is no origin
 *         remote, no branch, or you are already on the default branch;
 *         `prDesc` carries the reason. (This item WAS deferred for want of
 *         GitHub sign-in and rendered permanently disabled. That is no longer
 *         true, and three docs pages went stale believing this comment.)
 *
 * Not purely a save surface: deterministic inline edits that refuse and need
 * the LLM lane are parked in the AI queue (`aiQueueCount`) and only written
 * to source on flush. Committing before that flush would omit them, so while
 * the queue is non-empty the slot shows an "Apply N with AI" button instead.
 */

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ArrowDownToLine,
  ChevronDown,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Sparkles,
  Upload,
} from "lucide-react"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { BranchesApi, PullRequestTargetInfo } from "@/hooks/useEditorBranches"

type EditingApi = ReturnType<typeof useEditorEditing>
type DialogMode = "commit" | "merge-local" | "merge-push"

export function BranchModeControls({
  editing,
  branches,
}: {
  editing: EditingApi
  branches: BranchesApi
}) {
  const [dialog, setDialog] = React.useState<DialogMode | null>(null)
  const [pushing, setPushing] = React.useState(false)
  const [pulling, setPulling] = React.useState(false)
  const [updating, setUpdating] = React.useState(false)
  /**
   * A merge conflict reported by Pull remote changes or Update from
   * <default>. Those actions run straight from the menu (no message
   * dialog), so a toast is the wrong shape for their one rich failure: the
   * user needs the FILE LIST, which gets its own dialog.
   */
  const [conflict, setConflict] = React.useState<{
    title: string
    reason: string
    files: string[]
  } | null>(null)
  /**
   * "This will commit your edits first" confirmation for Pull remote
   * changes / Update from <default>. Both actions auto-commit a dirty
   * working tree before merging (a merge needs a committed state), which
   * contradicts branch mode's "edits stay uncommitted until you commit"
   * default — so with a dirty tree they must say so and ask BEFORE running,
   * not silently commit from a one-click menu item.
   */
  const [confirmSync, setConfirmSync] = React.useState<"pull" | "update" | null>(null)
  /**
   * The resolved pull-request destination, or "asking". Held here rather than
   * inside the dialog because the preflight runs BEFORE the dialog opens: the
   * dialog's whole job is to show where the pull request is going, so it must
   * not appear until there is an answer to show.
   */
  const [prTarget, setPrTarget] = React.useState<PullRequestTargetInfo | null>(null)
  const [prResolving, setPrResolving] = React.useState(false)

  if (editing.aiQueueCount > 0) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void editing.handleSaveAll()}
        disabled={editing.saving}
        className="gap-1 whitespace-nowrap"
        data-testid="branch-apply-ai"
      >
        <Sparkles className="h-3 w-3" />
        {editing.saving ? "Applying…" : `Apply ${editing.aiQueueCount} with AI`}
      </Button>
    )
  }

  const changeCount = branches.changes.length
  const defaultName = branches.defaultBranch ?? "main"
  const onDefault =
    !!branches.current && branches.current === branches.defaultBranch
  const hasDefault = !!branches.defaultBranch
  // Something to merge = committed-but-unmerged work (`ahead`) OR uncommitted
  // edits (`dirty`, which the merge commits onto the branch first).
  const hasChangesToMerge = branches.ahead > 0 || branches.dirty
  // Something to push = unpushed commits OR uncommitted edits (push commits
  // them first).
  const hasChangesToPush = branches.unpushed || branches.dirty

  const canMergeLocal =
    !!branches.current && hasDefault && !onDefault && hasChangesToMerge
  const canMergePush = canMergeLocal && branches.hasRemote
  const canPush =
    !!branches.current && branches.hasRemote && hasChangesToPush && !pushing

  const canPull =
    !!branches.current && branches.hasRemote && branches.hasUpstream && !pulling
  const canUpdate = !!branches.current && hasDefault && !onDefault && !updating

  const runPush = async () => {
    setPushing(true)
    const res = await branches.pushBranch()
    setPushing(false)
    if (res.ok) toast.success(`Pushed ${branches.current} to GitHub.`)
    else toast.error(res.reason ?? "Push failed.")
  }

  const runPull = async () => {
    setPulling(true)
    const res = await branches.pullRemote()
    setPulling(false)
    // The auto-commit is never silent: on any outcome that included it,
    // the toast (or the conflict dialog's reason, which the server writes)
    // says the edits were committed.
    const committed = res.committedBranch
      ? `Committed your edits onto ${branches.current}. `
      : ""
    if (res.ok) {
      if (res.upToDate) {
        toast.info(`${committed}${branches.current} already has the latest from GitHub.`)
      } else {
        toast.success(`${committed}Pulled the latest ${branches.current} from GitHub.`)
      }
      return
    }
    if (res.conflictFiles && res.conflictFiles.length > 0) {
      setConflict({
        title: "The pull hit conflicts",
        reason: res.reason ?? "The merge conflicted.",
        files: res.conflictFiles,
      })
      return
    }
    toast.error(res.reason ?? "Pull failed.")
  }

  const runUpdate = async () => {
    setUpdating(true)
    const res = await branches.updateFromDefault()
    setUpdating(false)
    const committed = res.committedBranch
      ? `Committed your edits onto ${branches.current}. `
      : ""
    if (res.ok) {
      if (res.upToDate) {
        toast.info(`${committed}${branches.current} already has the latest ${defaultName}.`)
      } else {
        toast.success(`${committed}Updated ${branches.current} from ${defaultName}.`)
      }
      return
    }
    if (res.conflictFiles && res.conflictFiles.length > 0) {
      setConflict({
        title: `Updating from ${defaultName} hit conflicts`,
        reason: res.reason ?? "The merge conflicted.",
        files: res.conflictFiles,
      })
      return
    }
    toast.error(res.reason ?? "Update failed.")
  }

  // Each item's subtitle doubles as its disabled reason, so a designer sees
  // *why* an action is unavailable without a nested tooltip inside the menu.
  /**
   * A pull request needs a branch that is not the default one and a remote to
   * open it against. Whether `gh` is installed and signed in is NOT checked
   * here: that would cost a shell-out on every menu render, and the preflight
   * already reports it in one plain sentence when the user actually asks.
   */
  const canOpenPr =
    !!branches.current && branches.hasRemote && !onDefault && !prResolving

  const prDesc = !branches.hasRemote
    ? "This project has no origin remote."
    : !branches.current
      ? "No branch is checked out."
      : onDefault
        ? `You are on ${defaultName}. Switch to another branch to open a pull request.`
        : prResolving
          ? "Checking where the pull request would go"
          : `Merge ${branches.current} into ${defaultName} on GitHub.`

  const handleOpenPr = async () => {
    setPrResolving(true)
    const res = await branches.preflightPullRequest()
    setPrResolving(false)
    if (!res.ok) {
      toast.error(res.reason)
      return
    }
    if (res.target.existing) {
      // Already open: the useful action is looking at it, not making a second.
      toast.info(`Pull request #${res.target.existing.number} is already open for this branch.`, {
        action: {
          label: "View",
          onClick: () => window.open(res.target.existing!.url, "_blank", "noopener,noreferrer"),
        },
      })
      return
    }
    setPrTarget(res.target)
  }

  const pushDesc = !branches.hasRemote
    ? "No GitHub remote configured"
    : !branches.current
      ? "No branch checked out"
      : pushing
        ? "Pushing…"
        : !hasChangesToPush
          ? "Nothing new to push"
          : "Update this branch on GitHub"

  const pullDesc = !branches.hasRemote
    ? "No GitHub remote configured"
    : !branches.current
      ? "No branch checked out"
      : !branches.hasUpstream
        ? "No remote branch to pull from. Push this branch first."
        : pulling
          ? "Pulling"
          : branches.behind > 0
            ? `Behind by ${branches.behind} ${branches.behind === 1 ? "commit" : "commits"} on GitHub`
            : "Merge new GitHub commits into this branch"

  const updateDesc = !hasDefault
    ? "No default branch to update from"
    : onDefault
      ? `You're on ${defaultName}`
      : updating
        ? "Updating"
        : `Merge the latest ${defaultName} into this branch`

  const mergeReason = !hasDefault
    ? "No default branch to merge into"
    : onDefault
      ? `You're on ${defaultName}`
      : !hasChangesToMerge
        ? `No changes beyond ${defaultName}`
        : null

  const mergePushDesc = mergeReason
    ? mergeReason
    : !branches.hasRemote
      ? "No GitHub remote configured"
      : `Merge into ${defaultName} and update GitHub`
  const mergeLocalDesc = mergeReason ?? "Merge locally, GitHub unchanged"

  const items = [
    {
      key: "push",
      icon: Upload,
      label: "Push branch",
      desc: pushDesc,
      enabled: canPush,
      testid: "branch-push",
      onSelect: () => void runPush(),
    },
    {
      key: "pull-remote",
      icon: ArrowDownToLine,
      label: "Pull remote changes",
      desc: pullDesc,
      enabled: canPull,
      testid: "branch-pull-remote",
      // A dirty tree gets committed onto the branch before the merge, so
      // it must be confirmed out loud first; a clean tree runs directly.
      onSelect: () => (branches.dirty ? setConfirmSync("pull") : void runPull()),
    },
    {
      key: "update-default",
      icon: GitMerge,
      label: `Update from ${defaultName}`,
      desc: updateDesc,
      enabled: canUpdate,
      testid: "branch-update-default",
      onSelect: () => (branches.dirty ? setConfirmSync("update") : void runUpdate()),
    },
    {
      key: "merge-push",
      icon: GitMerge,
      label: `Merge & push to ${defaultName}`,
      desc: mergePushDesc,
      enabled: canMergePush,
      testid: "branch-merge-push",
      onSelect: () => setDialog("merge-push"),
    },
    {
      key: "merge-local",
      icon: GitMerge,
      label: `Merge to local ${defaultName}`,
      desc: mergeLocalDesc,
      enabled: canMergeLocal,
      testid: "branch-merge-local",
      onSelect: () => setDialog("merge-local"),
    },
  ] as const

  return (
    <>
      <TooltipProvider>
        {/* Same gap as the nav bar's cluster in `editor-nav-bar.tsx`. These
            buttons sit in a nested row, so the parent's flex gap cannot
            reach them and the value has to be repeated here. Keep them equal:
            when they drifted, Commit to Merge was 8px and Merge to the
            settings gear was 2px, in one continuous run of controls. */}
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper so the tooltip still fires while the button is
                  disabled (a disabled button swallows pointer events). */}
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog("commit")}
                  disabled={!branches.dirty}
                  className="gap-1 whitespace-nowrap"
                  data-testid="branch-commit"
                >
                  <GitCommitHorizontal className="h-3 w-3" />
                  {changeCount > 0 ? `Commit (${changeCount})` : "Commit"}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {changeCount > 0
                ? `Commit ${changeCount} changed ${changeCount === 1 ? "file" : "files"} onto this branch.`
                : "Nothing to commit: the working tree is clean."}
            </TooltipContent>
          </Tooltip>

          <DropdownMenu
            onOpenChange={(open) => {
              // Refresh remote freshness when the user opens the menu — an
              // explicit action, so this network fetch is allowed here. The
              // menu renders immediately from the last known state; `behind`
              // and `unpushed` update in place when the fetch lands.
              if (open && branches.hasRemote) void branches.fetchRemote()
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 whitespace-nowrap"
                data-testid="branch-merge-menu"
              >
                <GitMerge className="h-3 w-3" />
                Merge / Push
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {items.map((item) => (
                <DropdownMenuItem
                  key={item.key}
                  disabled={!item.enabled}
                  onSelect={item.onSelect}
                  className="flex items-start gap-2"
                  data-testid={item.testid}
                >
                  <item.icon className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="flex flex-col">
                    <span className="text-sm">{item.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.desc}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canOpenPr}
                onSelect={() => void handleOpenPr()}
                className="flex items-start gap-2"
                data-testid="branch-open-pr"
              >
                <GitPullRequest className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="flex flex-col">
                  <span className="text-sm">Open pull request</span>
                  <span className="text-xs text-muted-foreground">{prDesc}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TooltipProvider>

      {prTarget ? (
        <PullRequestDialog
          target={prTarget}
          onClose={() => setPrTarget(null)}
          onCreate={branches.createPullRequest}
        />
      ) : null}

      {dialog ? (
        <BranchMessageDialog
          mode={dialog}
          branches={branches}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {conflict ? (
        <ConflictFilesDialog conflict={conflict} onClose={() => setConflict(null)} />
      ) : null}

      {confirmSync ? (
        <SyncCommitConfirmDialog
          mode={confirmSync}
          current={branches.current}
          defaultName={defaultName}
          changeCount={changeCount}
          onConfirm={() => {
            const mode = confirmSync
            setConfirmSync(null)
            if (mode === "pull") void runPull()
            else void runUpdate()
          }}
          onClose={() => setConfirmSync(null)}
        />
      ) : null}
    </>
  )
}

/**
 * Confirmation shown when Pull remote changes / Update from <default> is
 * clicked with a dirty working tree. Both actions commit the tree onto the
 * branch before merging (a merge needs a committed state), and branch
 * mode's contract is that edits stay uncommitted until the user commits
 * them — so the commit is asked for, never silent. One section (the
 * header); the footer's primary button names both halves of what it does.
 */
function SyncCommitConfirmDialog({
  mode,
  current,
  defaultName,
  changeCount,
  onConfirm,
  onClose,
}: {
  mode: "pull" | "update"
  current: string | null
  defaultName: string
  changeCount: number
  onConfirm: () => void
  onClose: () => void
}) {
  const source = mode === "pull" ? "GitHub" : defaultName
  const files = changeCount === 1 ? "1 changed file" : `${changeCount} changed files`
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" data-testid="branch-sync-commit-dialog">
        <DialogHeader>
          <DialogTitle>
            {mode === "pull" ? "Pull remote changes" : `Update from ${defaultName}`}
          </DialogTitle>
          {/*
            Was five clauses over four lines, in second person, and one of them
            ("the same way the Commit button does it and without running your
            git hooks") described our implementation. Nobody at this dialog is
            deciding anything on the basis of git hooks; they are deciding
            whether to let uncommitted work be committed first.

            Two sentences: what happens, then what happens if it goes wrong.
          */}
          <DialogDescription>
            {files} on{" "}
            <span className="text-foreground">{current ?? "this branch"}</span>{" "}
            will be committed first, then the latest from{" "}
            <span className="text-foreground">{source}</span> merged in. If the
            merge hits conflicts, that commit stays and nothing is merged.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            data-testid="branch-sync-commit-confirm"
          >
            {mode === "pull" ? "Commit and pull" : "Commit and update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A merge conflict from an all-or-nothing update (Pull remote changes /
 * Update from <default>). The whole point is the file LIST: the server
 * already reverted everything, so the user leaves for their own git tools
 * knowing exactly which files to look at. Paths render in mono; the
 * explanation is a sentence, never git's raw output block.
 */
function ConflictFilesDialog({
  conflict,
  onClose,
}: {
  conflict: { title: string; reason: string; files: string[] }
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" data-testid="branch-conflict-dialog">
        <DialogHeader>
          <DialogTitle>{conflict.title}</DialogTitle>
          <DialogDescription>{conflict.reason}</DialogDescription>
        </DialogHeader>
        <ConflictFileList files={conflict.files} />
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The conflicted paths as a mono list — shared by the conflict dialog
 * above, the inline failure area of the merge dialogs, and the branch
 * menu's publish dialog, so a conflict is named the same way wherever it
 * surfaces.
 */
export function ConflictFileList({ files }: { files: string[] }) {
  if (files.length === 0) return null
  return (
    /*
      The label is part of the block, not the call site.
      
      This rendered as a bare bordered box of paths at all three of its call
      sites, and a list of file paths with nothing above it does not say
      whether they are the files that conflicted, the files that will change,
      or the files that were skipped. Putting the label here rather than
      asking each caller to add one is what makes it true everywhere: all
      three sites show conflicting files, so the block can say so once.
    */
    <div className="flex flex-col gap-1" data-testid="branch-conflict-files">
      <span className="text-sm text-muted-foreground">
        {files.length === 1 ? "File with conflicts" : "Files with conflicts"}
      </span>
      <ul className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 p-2">
        {files.map((f) => (
          <li key={f} className="truncate py-0.5 font-mono text-code">
            {f}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Optional-message dialog shared by Commit / Merge-to-local / Merge-&-push —
 * a single message input plus mode-specific copy. Push has no message, so it
 * runs straight from the menu without this dialog.
 */
/**
 * Confirm a pull request, and say where it is going.
 *
 * The destination line is the reason this dialog exists at all. `gh` picks the
 * base repository from the git remotes and a remote named `upstream` outranks
 * `origin`, which is the ordinary layout of every fork. Creating on click would
 * let someone open a pull request on a stranger's repository and only find out
 * from the URL afterwards.
 *
 * Two sections: the header, and the one bordered block holding destination plus
 * title. `crossRepo` adds a third only in the case that has to shout.
 */
function PullRequestDialog({
  target,
  onClose,
  onCreate,
}: {
  target: PullRequestTargetInfo
  onClose: () => void
  onCreate: BranchesApi["createPullRequest"]
}) {
  const [title, setTitle] = React.useState(target.suggestedTitle)
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    const res = await onCreate({
      repoRef: target.repoRef,
      base: target.base,
      head: target.head,
      title: trimmed,
      body: "",
    })
    setSubmitting(false)
    if (!res.ok) {
      toast.error(res.reason)
      return
    }
    onClose()
    toast.success("Pull request opened.", {
      action: {
        label: "View",
        onClick: () => window.open(res.url, "_blank", "noopener,noreferrer"),
      },
    })
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="xl" data-testid="pull-request-dialog">
        <DialogHeader>
          <DialogTitle>Open a pull request</DialogTitle>
          {/* Says the consequential part out loud, the way the sync-commit
              dialog does: this button commits and pushes before it opens
              anything. `handlePullRequestCreateRequest` commits the working
              tree and pushes to origin inside the tree lock, so a user who
              expects "open a PR" to be read-only is wrong in a way they
              cannot undo from here. */}
          {/* "Nothing lands on {base}" rather than "{base} does not change":
              a branch name is lowercase, and opening a sentence with one reads
              as a typo the first time. The sibling dialogs never hit this
              because theirs sit mid-sentence. */}
          <DialogDescription>
            Uncommitted changes are committed onto {target.head} and the branch
            is pushed to GitHub, then the pull request opens. Nothing lands on{" "}
            {target.base} until the pull request is merged.
          </DialogDescription>
        </DialogHeader>

        {target.crossRepo ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-2 text-sm text-destructive"
            data-testid="pull-request-cross-repo"
          >
            This would open a pull request on {target.nameWithOwner}, which is
            not the repository the origin remote points at. Check that is
            intended.
          </p>
        ) : null}

        {/*
          No container. The border wrapped a read-only fact and a text field —
          two unrelated things — and said nothing about either: `docs/design.md`
          § "Count the dialog's sections" calls a bordered box a section, and
          this one was a section whose only job was to hold the rest of the
          dialog.
        */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Destination</span>
            <span className="font-mono text-code" data-testid="pull-request-target">
              {target.nameWithOwner}
            </span>
            <span className="font-mono text-code text-muted-foreground">
              {target.head} into {target.base}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="pull-request-title" className="text-xs text-muted-foreground">
              Title
            </label>
            <Input
              id="pull-request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={submitting || !title.trim()}
            data-testid="pull-request-submit"
          >
            {submitting ? "Opening" : "Open pull request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BranchMessageDialog({
  mode,
  branches,
  onClose,
}: {
  mode: DialogMode
  branches: BranchesApi
  onClose: () => void
}) {
  const [message, setMessage] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // A publish conflict names its files (the server reads them out of the
  // ephemeral merge worktree). Rendered under the error so the user knows
  // WHICH files to resolve, not just that a conflict exists.
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([])

  const defaultName = branches.defaultBranch ?? "the default branch"

  const fail = (res: { reason?: string; conflictFiles?: string[] }) => {
    setError(res.reason ?? "Something went wrong.")
    setConflictFiles(res.conflictFiles ?? [])
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    setConflictFiles([])
    const msg = message.trim() || undefined

    if (mode === "commit") {
      const res = await branches.commitWorkingTree(msg)
      setBusy(false)
      if (!res.ok) return fail(res)
      toast.success("Committed all working-tree changes.")
      return onClose()
    }

    if (mode === "merge-local") {
      const res = await branches.publishBranch(msg)
      setBusy(false)
      if (!res.ok) return fail(res)
      toast.success(`Merged into ${defaultName}.`)
      return onClose()
    }

    // merge-push: the local merge can land while the push fails — report
    // that partial state honestly rather than claiming a full success.
    const res = await branches.mergeAndPush(msg)
    setBusy(false)
    if (!res.ok) return fail(res)
    if (res.pushed === false) {
      toast.warning(
        `Merged into ${defaultName} locally, but the push failed: ${res.pushReason ?? "unknown error"}`,
      )
    } else {
      toast.success(`Merged into ${defaultName} and pushed to GitHub.`)
    }
    onClose()
  }

  const copy = DIALOG_COPY[mode]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{copy.title(defaultName)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {/* The prose was always here; it just wasn't the dialog's DESCRIPTION,
              so Radix had nothing to point `aria-describedby` at and warned once
              per mode. `DialogDescription` renders a `<p>` too, and the
              className restores this dialog's smaller muted weight over the
              primitive's `text-base text-foreground` default — an a11y fix
              should not silently restyle three dialogs. Whether all four branch
              dialogs should share ONE description weight is a design call, and
              a separate one; the other two use the default today. */}
          <DialogDescription className="text-sm text-muted-foreground">
            {copy.body(branches.current, defaultName)}
          </DialogDescription>
          {/*
            A Textarea, not an Input. A commit message is prose that can run to
            a paragraph, and a single-line field says the opposite — it caps
            what you write at what fits, with the start scrolled out of view by
            the time you reach the end.

            The submit shortcut MOVED with it, and had to: Enter is a newline
            in a textarea, so the old `Enter -> submit` would have made the one
            key you press to write a second line fire the commit instead.
            Cmd/Ctrl+Enter is the shortcut everywhere else that has a
            multi-line box and a submit button.
          */}
          <Textarea
            autoFocus
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={
              mode === "commit"
                ? "Commit working tree"
                : `branch: ${branches.current}`
            }
            data-testid="branch-message-input"
          />
          {error ? (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="branch-message-error"
            >
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
            {busy ? "Working…" : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Mode-specific dialog copy for the shared message dialog. */
const DIALOG_COPY: Record<
  DialogMode,
  {
    title: (defaultName: string) => string
    body: (current: string | null, defaultName: string) => React.ReactNode
    confirm: string
  }
> = {
  commit: {
    title: () => "Commit changes",
    // "Add an optional message:" went: the box is right below with a
    // placeholder in it, so the sentence was narrating the next widget.
    body: (current) => (
      <>
        Commits all working-tree changes onto{" "}
        <span className="text-foreground">{current}</span>.
      </>
    ),
    confirm: "Commit",
  },
  "merge-local": {
    title: (defaultName) => `Merge to local ${defaultName}`,
    body: (current, defaultName) => (
      <>
        Squash-merges <span className="text-foreground">{current}</span> into{" "}
        <span className="text-foreground">{defaultName}</span> locally, without
        updating GitHub. <span className="text-foreground">{current}</span>{" "}
        stays checked out.
      </>
    ),
    confirm: "Merge",
  },
  "merge-push": {
    title: (defaultName) => `Merge & push to ${defaultName}`,
    body: (current, defaultName) => (
      <>
        Squash-merges <span className="text-foreground">{current}</span> into{" "}
        <span className="text-foreground">{defaultName}</span> and pushes it to
        GitHub. <span className="text-foreground">{current}</span> stays checked
        out.
      </>
    ),
    confirm: "Merge & push",
  },
}

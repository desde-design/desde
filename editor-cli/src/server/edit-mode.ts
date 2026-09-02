/**
 * CLI edit-substrate mode.
 *
 * Branch mode (tasks/branches-vs-worktree.md) is the ONLY edit substrate:
 * Editor edits the user's current working tree in place on the checked-out
 * branch, so uncommitted state is shared and boot skips `git worktree add`.
 * Undo comes from the per-edit backup journal (`.desde/backups/`), not
 * commits. Branches are first-class "pages" and Publish promotes a page into
 * trunk.
 *
 * Worktree-session mode (per-session worktree, auto-commit, Commit-promotes-
 * to-main) was removed in the worktree-mode decommission
 * (tasks/worktree-mode-decommission.md). The old opt-out env vars
 * (`EDITOR_WORKTREE_MODE`, `EDITOR_BRANCH_MODE`) are no longer honored.
 */

function isTrueish(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true"
}

function isFalseish(v: string | undefined): boolean {
  return v === "0" || v?.toLowerCase() === "false"
}

/**
 * Always true — branch mode is the only edit substrate. Retained as the
 * single call site's seam; warns once if a stale shell/script still sets a
 * retired worktree opt-out flag, so getting branch mode anyway isn't a silent
 * surprise.
 */
export function isBranchMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isTrueish(env.EDITOR_WORKTREE_MODE) || isFalseish(env.EDITOR_BRANCH_MODE)) {
    console.warn(
      "[editor-cli] EDITOR_WORKTREE_MODE / EDITOR_BRANCH_MODE are no longer honored. " +
        "Worktree-session mode was removed; branch mode is the only edit substrate.",
    )
  }
  return true
}

"use client"

import type { WorkingTreeChange } from "@/hooks/useEditorBranches"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import {
  BranchControlsFixture,
  makeBranches,
  openMergeMenuItem,
} from "./branch-controls-harness"
import { clickLikeUser, findButtonByText, waitForElement } from "./dom-interaction"

/**
 * The four `BranchModeControls` dialogs that are not the pull-request one.
 *
 * These are the hardest surfaces in the product to summon and among the most
 * consequential: two of them are the only place a merge conflict is ever named,
 * and one is the confirmation that stands between an uncommitted working tree
 * and an automatic commit. Reproducing any of them for real needs a second
 * clone, a deliberate conflicting edit, and a remote — which is the whole
 * reason this catalog exists.
 *
 * The message dialog (Commit / Merge / Merge & push) is one component with
 * three copy sets, so each mode is a genuinely distinct rendering.
 */

const MESSAGE_INPUT = '[data-testid="branch-message-input"]'
const SYNC_DIALOG = '[data-testid="branch-sync-commit-dialog"]'
const CONFLICT_DIALOG = '[data-testid="branch-conflict-dialog"]'
const MESSAGE_ERROR = '[data-testid="branch-message-error"]'

/**
 * The conflicted paths a real all-or-nothing merge reports. The server reads
 * them out of the ephemeral merge worktree, so they are ordinary repo-relative
 * paths and the list is exactly what the user takes to their own git tools.
 */
const CONFLICT_FILES = [
  "src/pages/Settings.vue",
  "src/components/PricingCard.vue",
  "src/styles/tokens.css",
]

/**
 * The uncommitted files the sync-commit confirmation counts. That dialog says
 * "N changed files", derived from `changes.length` and not from `dirty`, so a
 * fixture that left the array empty would render "0 changed files" on the one
 * dialog whose whole subject is what is about to be committed.
 */
const DIRTY_CHANGES: WorkingTreeChange[] = [
  { path: "src/pages/Settings.vue", status: "modified" },
  { path: "src/components/PricingCard.vue", status: "modified" },
  { path: "src/styles/tokens.css", status: "added" },
]

/** Click the footer's confirm button INSIDE the open dialog. */
async function confirmDialogButton(
  label: RegExp,
  cancelled: () => boolean,
): Promise<void> {
  // Scoped to the dialog, not the document: the fixture's own root still holds
  // a "Merge / Push" trigger button that an unscoped text search matches first.
  const button = await waitForElement(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    return dialog ? findButtonByText(label, dialog) : null
  })
  if (cancelled() || !button) return
  clickLikeUser(button)
}

export const BRANCH_MODE_DIALOGS_SURFACE: SurfaceEntry = {
  id: "branch-mode-dialogs",
  title: "Commit, merge, and their conflicts",
  kind: "modal",
  sourceFile: "src/components/editor/branch-mode-controls.tsx",
  states: [
    {
      id: "branch-mode-dialogs/commit",
      label: "Commit the working tree",
      readyWhen: MESSAGE_INPUT,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            changes: [],
            commitWorkingTree: async (message?: string) => {
              ctx.log("commitWorkingTree", message)
              return { ok: true as const }
            },
          })}
          drive={async (root, cancelled) => {
            const commit = await waitForElement(() =>
              root.querySelector<HTMLButtonElement>('[data-testid="branch-commit"]'),
            )
            if (cancelled() || !commit) return
            clickLikeUser(commit)
          }}
        />
      ),
    },
    {
      id: "branch-mode-dialogs/merge-local",
      label: "Merge to local default (GitHub untouched)",
      readyWhen: MESSAGE_INPUT,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            publishBranch: async (message?: string) => {
              ctx.log("publishBranch", message)
              return { ok: true as const }
            },
          })}
          drive={(root, cancelled) =>
            openMergeMenuItem(root, "branch-merge-local", cancelled).then(() => {})
          }
        />
      ),
    },
    {
      id: "branch-mode-dialogs/merge-push",
      label: "Merge and push to the default branch",
      readyWhen: MESSAGE_INPUT,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            mergeAndPush: async (message?: string) => {
              ctx.log("mergeAndPush", message)
              return { ok: true as const }
            },
          })}
          drive={(root, cancelled) =>
            openMergeMenuItem(root, "branch-merge-push", cancelled).then(() => {})
          }
        />
      ),
    },
    {
      id: "branch-mode-dialogs/merge-conflict",
      label: "Merge refused: conflicting files, named inline",
      // The file list and the error are set in one `fail()` call, so either
      // marks the final state. The error is the higher of the two on screen.
      readyWhen: MESSAGE_ERROR,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            publishBranch: async (message?: string) => {
              ctx.log("publishBranch", message)
              return {
                ok: false as const,
                // The server's own wording for a squash-merge that conflicted
                // in the ephemeral worktree: nothing was applied, the branch is
                // untouched, and resolving happens in the user's branch.
                reason:
                  "The squash merge conflicted, so nothing was merged. Resolve the conflicts on this branch, then try again.",
                conflictFiles: CONFLICT_FILES,
              }
            },
          })}
          drive={async (root, cancelled) => {
            if (!(await openMergeMenuItem(root, "branch-merge-local", cancelled))) return
            if (!(await waitForElement(() => document.querySelector(MESSAGE_INPUT)))) return
            if (cancelled()) return
            await confirmDialogButton(/^Merge$/, cancelled)
          }}
        />
      ),
    },
    {
      id: "branch-mode-dialogs/sync-commit-pull",
      label: "Pull with a dirty tree: commit first?",
      readyWhen: SYNC_DIALOG,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            behind: 3,
            changes: DIRTY_CHANGES,
          })}
          drive={(root, cancelled) =>
            openMergeMenuItem(root, "branch-pull-remote", cancelled).then(() => {})
          }
        />
      ),
    },
    {
      id: "branch-mode-dialogs/sync-commit-update",
      label: "Update from default with a dirty tree",
      readyWhen: SYNC_DIALOG,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          branches={makeBranches(ctx, {
            // The singular branch of `changeCount === 1 ? "1 changed file" : …`,
            // which is the one plural case this dialog gets right and is worth
            // keeping visible next to the ones that don't.
            changes: DIRTY_CHANGES.slice(0, 1),
          })}
          drive={(root, cancelled) =>
            openMergeMenuItem(root, "branch-update-default", cancelled).then(() => {})
          }
        />
      ),
    },
    {
      id: "branch-mode-dialogs/pull-conflict",
      label: "Pull hit conflicts: the file list gets its own dialog",
      readyWhen: CONFLICT_DIALOG,
      render: (ctx: SurfaceRenderContext) => (
        <BranchControlsFixture
          // A CLEAN tree on purpose. A dirty one routes through the sync-commit
          // confirmation above first, and this state is about what happens
          // after the merge, not before it.
          branches={makeBranches(ctx, {
            dirty: false,
            behind: 3,
            pullRemote: async () => {
              ctx.log("pullRemote")
              return {
                ok: false as const,
                reason:
                  "The merge conflicted, so the pull was rolled back and the branch is unchanged.",
                conflictFiles: CONFLICT_FILES,
              }
            },
          })}
          drive={(root, cancelled) =>
            openMergeMenuItem(root, "branch-pull-remote", cancelled).then(() => {})
          }
        />
      ),
    },
  ],
}

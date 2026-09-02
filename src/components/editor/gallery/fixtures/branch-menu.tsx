"use client"

import { useEffect } from "react"
import { BranchMenu } from "@/components/editor/branch-menu"
import type { BranchesApi } from "@/hooks/useEditorBranches"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import {
  clickLikeUser,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "./dom-interaction"

/**
 * `BranchMenu`'s create/rename/publish dialog (`BranchNameDialog`) is an
 * unexported function local to branch-menu.tsx — reachable only by opening
 * the real dropdown and selecting an item, the same as a user would. Do NOT
 * extract it; that's the refactor this task doesn't authorize. `BranchesApi`
 * is a flat data-and-callbacks interface (unlike the ~60-field
 * `EditingApi` `branch-mode-controls.tsx` needs — see that fixture's
 * skip note), so a full literal satisfying it — no cast — is
 * straightforward.
 *
 * The self-host harness's own `EditorPage` chrome ALSO renders a real
 * `BranchMenu` in its top bar (branch mode is always live), sharing the
 * SAME `data-testid="branch-menu-trigger"`. A bare testid lookup found
 * THAT one first and drove its dropdown instead of this fixture's own —
 * confirmed live (`npm run gallery`): the ambient trigger read "detached
 * HEAD", ours "feat/pricing-page", and the click landed on the former. The
 * fix is disambiguating by this fixture's own `branches.current` text
 * (unique across the two), not the shared testid alone. Once THIS trigger
 * is correctly the one clicked, the subsequently-appearing menu items and
 * dialog are unambiguous — only one dropdown/dialog is ever open at a time.
 */
const OWN_BRANCH_LABEL = /feat\/pricing-page/

/** Final-state selectors — see `SurfaceState.readyWhen`. */
const NAME_INPUT = '[data-testid="branch-name-input"]'
const NAME_ERROR = '[data-testid="branch-name-error"]'

/**
 * A name that genuinely collides with an existing branch. Renaming a branch to
 * its OWN name is allowed by `renameBranch` (it guards on `from !== to`), so a
 * refusal fixture has to type a real collision rather than submitting the
 * prefilled value.
 */
const COLLIDING_BRANCH = "main"

function testid<T extends Element = Element>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`)
}

function makeBranches(ctx: SurfaceRenderContext, overrides: Partial<BranchesApi> = {}): BranchesApi {
  return {
    branches: [
      { name: "main", current: false, isDefault: true },
      { name: "feat/pricing-page", current: true, isDefault: false },
      { name: "feat/onboarding-copy", current: false, isDefault: false },
    ],
    current: "feat/pricing-page",
    defaultBranch: "main",
    dirty: true,
    changes: [{ path: "src/components/PricingPage.vue", status: "modified" }],
    ahead: 2,
    hasRemote: true,
    hasUpstream: true,
    unpushed: true,
    behind: 0,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    loading: false,
    error: null,
    refresh: () => ctx.log("refresh"),
    switchBranch: async (name) => {
      ctx.log("switchBranch", name)
      return { ok: true }
    },
    createBranch: async (name, base) => {
      ctx.log("createBranch", name, base)
      return { ok: true }
    },
    renameBranch: async (from, to) => {
      ctx.log("renameBranch", from, to)
      return { ok: true }
    },
    publishBranch: async (message) => {
      ctx.log("publishBranch", message)
      return { ok: true }
    },
    commitWorkingTree: async (message) => {
      ctx.log("commitWorkingTree", message)
      return { ok: true }
    },
    pushBranch: async () => {
      ctx.log("pushBranch")
      return { ok: true }
    },
    fetchRemote: async () => {
      ctx.log("fetchRemote")
    },
    updateFromDefault: async () => {
      ctx.log("updateFromDefault")
      return { ok: true }
    },
    pullRemote: async () => {
      ctx.log("pullRemote")
      return { ok: true }
    },
    mergeAndPush: async (message) => {
      ctx.log("mergeAndPush", message)
      return { ok: true, pushed: true }
    },
    preflightPullRequest: async () => {
      ctx.log("preflightPullRequest")
      return {
        ok: true,
        target: {
          repoRef: "acme/checkout-proto",
          nameWithOwner: "acme/checkout-proto",
          base: "main",
          head: "feat/pricing-page",
          crossRepo: false,
          existing: null,
          suggestedTitle: "Pricing page",
        },
      }
    },
    createPullRequest: async (input) => {
      ctx.log("createPullRequest", input)
      return { ok: true, url: "https://github.com/acme/checkout-proto/pull/42" }
    },
    discardFile: async (path, status, from) => {
      ctx.log("discardFile", path, status, from)
      return { ok: true }
    },
    undoEdit: async () => {
      ctx.log("undoEdit")
      return { ok: true }
    },
    redoEdit: async () => {
      ctx.log("redoEdit")
      return { ok: true }
    },
    discardStep: async (direction, expectedTopId) => {
      ctx.log("discardStep", direction, expectedTopId)
      return { ok: true }
    },
    ...overrides,
  }
}

/** Opens the dropdown, selects the menu item matching `itemPattern`, and —
 *  when `thenSubmit` is set — clicks the resulting dialog's confirm button. */
function DialogFixture({
  itemPattern,
  branches,
  thenSubmit,
  typeName,
}: {
  itemPattern: RegExp
  branches: BranchesApi
  thenSubmit?: RegExp
  /** Replace the prefilled branch name before submitting. */
  typeName?: string
}) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const trigger = await waitForElement(() =>
        findByText<HTMLButtonElement>('[data-testid="branch-menu-trigger"]', OWN_BRANCH_LABEL),
      )
      if (cancelled || !trigger) return
      clickLikeUser(trigger)

      const item = await waitForElement(() =>
        findByText<HTMLElement>('[role="menuitem"]', itemPattern),
      )
      if (cancelled || !item) return
      clickLikeUser(item)

      if (!thenSubmit) return
      const input = await waitForElement(() => testid<HTMLInputElement>("branch-name-input"))
      if (cancelled || !input) return
      if (typeName) setNativeValue(input, typeName)
      const confirm = await waitForElement(() => findByText<HTMLButtonElement>("button", thenSubmit))
      if (cancelled || !confirm) return
      clickLikeUser(confirm)
    })
    return () => {
      cancelled = true
    }
    // `branches`/`itemPattern`/`thenSubmit` are stable per-state literals —
    // this drives the interaction exactly once, matching every other
    // interaction-driven fixture in this catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <BranchMenu branches={branches} />
}

export const BRANCH_MENU_SURFACE: SurfaceEntry = {
  id: "branch-menu",
  title: "Branch menu: create / rename / publish",
  kind: "modal",
  sourceFile: "src/components/editor/branch-menu.tsx",
  states: [
    {
      id: "branch-menu/create-from-default",
      label: "New branch from default",
      readyWhen: NAME_INPUT,
      render: (ctx) => <DialogFixture branches={makeBranches(ctx)} itemPattern={/new branch/i} />,
    },
    {
      id: "branch-menu/duplicate-current",
      label: "Duplicate current branch",
      readyWhen: NAME_INPUT,
      render: (ctx) => (
        <DialogFixture branches={makeBranches(ctx)} itemPattern={/duplicate current branch/i} />
      ),
    },
    {
      id: "branch-menu/rename",
      label: "Rename current branch",
      readyWhen: NAME_INPUT,
      render: (ctx) => (
        <DialogFixture branches={makeBranches(ctx)} itemPattern={/rename current branch/i} />
      ),
    },
    {
      id: "branch-menu/rename-error",
      label: "Rename: refused by git",
      readyWhen: NAME_ERROR,
      render: (ctx) => (
        <DialogFixture
          branches={makeBranches(ctx, {
            renameBranch: async (from, to) => {
              ctx.log("renameBranch", from, to)
              // Single quotes and this exact phrasing match what the server
              // actually emits (`src/editor/worktree/git-branches.ts`), so the
              // screenshot shows real copy rather than an invented paraphrase.
              return { ok: false, reason: `A branch named '${to}' already exists.` }
            },
          })}
          itemPattern={/rename current branch/i}
          // Type a name that genuinely collides. Submitting the prefilled
          // current name would ask git to rename a branch to itself, which
          // `renameBranch` explicitly ALLOWS (`from !== to` guard) — the
          // product cannot produce a refusal from that input, so forcing one
          // would make this fixture show an impossible state.
          typeName={COLLIDING_BRANCH}
          thenSubmit={/^rename$/i}
        />
      ),
    },
    {
      id: "branch-menu/publish",
      label: "Publish to default branch",
      readyWhen: '[role="alertdialog"], [role="dialog"]',
      render: (ctx) => <DialogFixture branches={makeBranches(ctx)} itemPattern={/publish to/i} />,
    },
  ],
}

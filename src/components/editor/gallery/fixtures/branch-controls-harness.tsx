"use client"

import { useEffect } from "react"
import { BranchModeControls } from "@/components/editor/branch-mode-controls"
import type { BranchesApi } from "@/hooks/useEditorBranches"
import type { useEditorEditing } from "@/hooks/useEditorEditing"
import type { SurfaceRenderContext } from "../types"
import { clickLikeUser, runDrivenInteraction, waitForElement } from "./dom-interaction"

type EditingApi = ReturnType<typeof useEditorEditing>

/**
 * Shared harness for every `BranchModeControls` dialog.
 *
 * That one component hosts FIVE dialogs — commit, merge-to-local, merge-&-push,
 * the sync-commit confirmation, and the conflict file list — and not one of them
 * takes a prop that opens it. Each lives behind internal `useState` reached only
 * by clicking the same controls a user clicks, so every fixture for them drives
 * the real interaction. The parts that would otherwise be copied per fixture
 * (the stub API, the fixture root, the click-through runner) live here once.
 */

/** Marks a fixture's own subtree, to tell it from the ambient editor chrome. */
export const BRANCH_FIXTURE_ROOT = "data-branch-fixture-root"

export function makeEditing(): EditingApi {
  return { aiQueueCount: 0, saving: false, handleSaveAll: () => {} } as unknown as EditingApi
}

/**
 * A complete BranchesApi, deliberately NOT cast.
 *
 * This used to end in `as unknown as BranchesApi` over a partial object, and
 * that cast is what broke the gallery: `BranchModeControls` grew a
 * `branches.fetchRemote()` call on menu open, the stub had no such member,
 * and the registry test failed at runtime on a gap the type checker had been
 * silenced about. A partial cast is defensible in a unit test that exercises
 * one control. It is not defensible here, because a gallery fixture's whole
 * job is to render the REAL component in a real state, so the day the
 * component needs a new member is the day this fixture must supply one.
 *
 * Keep it uncast. The compile error is the point.
 *
 * `overrides` is applied last so a state can make one call fail (a conflicting
 * publish, a refused pull) without restating the other twenty members.
 */
export function makeBranches(
  ctx: SurfaceRenderContext,
  overrides: Partial<BranchesApi> = {},
): BranchesApi {
  const noopMutation = async () => ({ ok: true as const })
  return {
    branches: [],
    current: "feat/pricing-page",
    defaultBranch: "main",
    dirty: true,
    changes: [],
    ahead: 2,
    behind: 0,
    hasRemote: true,
    hasUpstream: true,
    unpushed: true,
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    loading: false,
    error: null,
    refresh: () => {},
    switchBranch: noopMutation,
    createBranch: noopMutation,
    renameBranch: noopMutation,
    publishBranch: noopMutation,
    commitWorkingTree: noopMutation,
    pushBranch: noopMutation,
    mergeAndPush: async () => ({ ok: true as const }),
    fetchRemote: async () => {
      ctx.log("fetchRemote")
    },
    updateFromDefault: noopMutation,
    pullRemote: noopMutation,
    discardFile: noopMutation,
    undoEdit: noopMutation,
    redoEdit: noopMutation,
    discardStep: noopMutation,
    preflightPullRequest: async () => {
      ctx.log("preflightPullRequest")
      return {
        ok: true as const,
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
    createPullRequest: async (input: Parameters<BranchesApi["createPullRequest"]>[0]) => {
      ctx.log("createPullRequest", input)
      return { ok: true as const, url: "https://github.com/acme/checkout-proto/pull/42" }
    },
    ...overrides,
  }
}

/**
 * Render the real controls and drive one click sequence against them.
 *
 * `drive` receives THIS fixture's root, never `document`. The self-host harness
 * renders the real editor chrome around the fixture, and that chrome mounts its
 * own `BranchModeControls` with its own real hooks — an unscoped
 * `[data-testid="branch-merge-menu"]` matches the AMBIENT one first, whose
 * items are correctly disabled, so the click does nothing and the state never
 * appears.
 */
export function BranchControlsFixture({
  branches,
  drive,
}: {
  /** Already built by `makeBranches(ctx, …)`, which is where the log lands. */
  branches: BranchesApi
  drive: (root: HTMLElement, cancelled: () => boolean) => Promise<void>
}) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const root = document.querySelector<HTMLElement>(`[${BRANCH_FIXTURE_ROOT}]`)
      if (cancelled || !root) return
      await drive(root, () => cancelled)
    })
    return () => {
      cancelled = true
    }
    // Empty deps on purpose: the body reads only the DOM, so this drives the
    // interaction exactly once, matching every other driven fixture here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div {...{ [BRANCH_FIXTURE_ROOT]: "" }}>
      <BranchModeControls editing={makeEditing()} branches={branches} />
    </div>
  )
}

/**
 * Open the Merge / Push menu and pick one item.
 *
 * The menu CONTENT is portalled out of the fixture root by Radix, so the item
 * lookup is deliberately document-scoped. It is unambiguous by then: only one
 * dropdown is ever open, and the ambient chrome's is not it.
 */
export async function openMergeMenuItem(
  root: HTMLElement,
  testid: string,
  cancelled: () => boolean,
): Promise<boolean> {
  const trigger = await waitForElement(() =>
    root.querySelector<HTMLButtonElement>('[data-testid="branch-merge-menu"]'),
  )
  if (cancelled() || !trigger) return false
  clickLikeUser(trigger)

  const item = await waitForElement(() =>
    document.querySelector<HTMLElement>(`[data-testid="${testid}"]:not([aria-disabled="true"])`),
  )
  if (cancelled() || !item) return false
  clickLikeUser(item)
  return true
}

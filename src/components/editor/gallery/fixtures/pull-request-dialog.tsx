"use client"

import type { PullRequestTargetInfo } from "@/hooks/useEditorBranches"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import {
  BranchControlsFixture,
  makeBranches,
  openMergeMenuItem,
} from "./branch-controls-harness"

/**
 * Final-state selectors. The cross-repo state gates on the WARNING rather than
 * the dialog, because the dialog appears first in both states and gating both
 * on it would let the warning state screenshot before the warning rendered.
 */
const PR_DIALOG = '[data-testid="pull-request-dialog"]'
const PR_CROSS_REPO = '[data-testid="pull-request-cross-repo"]'

const BASE_TARGET: PullRequestTargetInfo = {
  repoRef: "acme/checkout-proto",
  nameWithOwner: "acme/checkout-proto",
  base: "main",
  head: "feat/pricing-page",
  crossRepo: false,
  existing: null,
  suggestedTitle: "Pricing page",
}

/**
 * The dialog only exists behind a real interaction: the Merge/Push menu, then
 * "Open pull request", then an async preflight. There is no prop that opens it
 * directly, and deliberately so, since the preflight is what supplies every
 * value the dialog shows. So this drives the same steps a user does.
 */
function PullRequestFixture({
  ctx,
  target,
}: {
  ctx: SurfaceRenderContext
  target: PullRequestTargetInfo
}) {
  return (
    <BranchControlsFixture
      branches={makeBranches(ctx, {
        preflightPullRequest: async () => {
          ctx.log("preflightPullRequest")
          return { ok: true as const, target }
        },
      })}
      drive={(root, cancelled) => openMergeMenuItem(root, "branch-open-pr", cancelled).then(() => {})}
    />
  )
}

export const PULL_REQUEST_DIALOG_SURFACE: SurfaceEntry = {
  id: "pull-request-dialog",
  title: "Open pull request: confirm where it goes",
  kind: "modal",
  sourceFile: "src/components/editor/branch-mode-controls.tsx",
  states: [
    {
      id: "pull-request-dialog/confirm",
      label: "Confirm the destination",
      readyWhen: PR_DIALOG,
      render: (ctx) => <PullRequestFixture ctx={ctx} target={BASE_TARGET} />,
    },
    {
      id: "pull-request-dialog/cross-repo",
      label: "Destination is not our origin",
      readyWhen: PR_CROSS_REPO,
      render: (ctx) => (
        <PullRequestFixture
          ctx={ctx}
          // The case this whole dialog exists for. `gh` picks the base
          // repository from the git remotes, and a remote named `upstream`
          // outranks `origin` — the ordinary layout of every fork. MEASURED on
          // gh 2.92.0: with origin `mochang/desde` and upstream
          // `cli/cli`, `gh repo view` answers `cli/cli`. Creating on click
          // would file a pull request on a stranger's repository.
          target={{
            ...BASE_TARGET,
            repoRef: "cli/cli",
            nameWithOwner: "cli/cli",
            base: "trunk",
            crossRepo: true,
          }}
        />
      ),
    },
  ],
}

/**
 * Whether a server re-resolve (`router.refresh()`) is due, after a Rebuild
 * click on the crashed-prototype panel.
 *
 * Pure, so every branch is tested
 * (`app/__tests__/rebuild-refresh.test.ts`); `prototype-unavailable.tsx`
 * only carries out the answer.
 *
 * **Why this needs three inputs, not just "is the deployment deployed".**
 * `CrashedControls` mounts on an already-crashed prototype, and that
 * prototype's LATEST DEPLOYMENT — the one `useBuildControls` reads on mount
 * — is almost always already `status: "deployed"`: the BUILD succeeded, the
 * process died some time after. Refreshing the moment that status is read
 * would fire on every mount, not on a rebuild, and it would fire again on
 * this page's own re-render regardless of whether the reader ever clicked
 * Rebuild. So `"deployed"` alone cannot mean "a rebuild just finished" — it
 * has to mean "a rebuild THIS PANEL STARTED finished", which is `requested`
 * (set true by the Rebuild click, before `startBuild()`) and `sawBuilding`
 * (set true once this panel has actually observed the deployment move to
 * `"building"` — proof the NEW attempt, not the old crashed one, is the one
 * reaching `"deployed"`), both true, together with the current status being
 * `"deployed"`.
 */

export function shouldRefreshAfterRebuild(input: {
  /** The Rebuild button was clicked, and its `startBuild()` call has been made. */
  requested: boolean
  /** This panel has observed `status === "building"` since that click. */
  sawBuilding: boolean
  status: "building" | "deployed" | "failed" | null | undefined
}): boolean {
  return input.requested && input.sawBuilding && input.status === "deployed"
}

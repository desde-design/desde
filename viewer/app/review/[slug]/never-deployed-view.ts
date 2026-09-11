/**
 * What the review route shows a manager for a prototype with no finished
 * build. Pure, so every branch is tested
 * (`app/__tests__/never-deployed-view.test.ts`); `never-deployed.tsx` only
 * carries out the answer. Same split as `decideInitialFlowMode`, for the
 * reason that function records: an effect that decides wrongly and one that
 * correctly decides to wait look identical from outside.
 */

export interface NeverDeployedInput {
  /** The project record has answered. It is what carries `repoConfig`. */
  detailLoaded: boolean
  /** The project record failed to load. */
  detailFailed: boolean
  /** A repository is connected. Meaningless until `detailLoaded`. */
  hasRepo: boolean
  /** The newest-build read, and who may build, have both answered. */
  deploymentsLoaded: boolean
  /** The newest build's status, or null when there is none. Meaningless until `deploymentsLoaded`. */
  latestStatus: "building" | "deployed" | "failed" | null
  /**
   * A build was seen RUNNING on this page. A finish is then a transition this
   * page watched, and reloading lands on the review screen. Without it, a
   * finished build with still no active deployment would reload in a loop.
   */
  sawBuilding: boolean
}

export type NeverDeployedView =
  | { kind: "wait" }
  | { kind: "load-failed" }
  | { kind: "connect" }
  | { kind: "deploy" }
  | { kind: "building" }
  | { kind: "failed" }
  | { kind: "deployed"; reload: boolean }

/**
 * Checked in order:
 *
 * 1. The project must have answered, or failed, before anything is read from it.
 * 2. No repository: the only way forward is connecting one.
 * 3. The build list must have answered before its null is read as "no build".
 * 4. Then the newest build decides.
 */
export function decideNeverDeployedView(input: NeverDeployedInput): NeverDeployedView {
  if (!input.detailLoaded) return input.detailFailed ? { kind: "load-failed" } : { kind: "wait" }
  if (!input.hasRepo) return { kind: "connect" }
  if (!input.deploymentsLoaded) return { kind: "wait" }
  switch (input.latestStatus) {
    case null:
      return { kind: "deploy" }
    case "building":
      return { kind: "building" }
    case "failed":
      return { kind: "failed" }
    case "deployed":
      return { kind: "deployed", reload: input.sawBuilding }
  }
}

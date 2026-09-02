/**
 * The `BuildRunner` seam (spec §5). One in-process impl ships today; the
 * `gcp` profile's Cloud Build impl is Phase 4, and the seam is what keeps
 * that from becoming a fork.
 *
 * Progress is reported through a callback rather than returned at the end.
 * A build runs for minutes; a runner that only resolves when it is finished
 * gives the UI nothing to show until it is over, and retrofitting streaming
 * onto a resolve-at-the-end interface means changing every impl. The
 * callback is the interface's shape from the start for that reason.
 */
import type { BuildStep, Deployment, DeploymentWarning, Project, ProjectRepoConfig } from "../storage/types"

/** A chunk of build output, already scrubbed of credentials. */
export interface BuildLogChunk {
  /** `stdout`/`stderr` from a build step, or `runner` for our own narration. */
  stream: "stdout" | "stderr" | "runner"
  text: string
}

export interface BuildRequest {
  project: Project
  repo: ProjectRepoConfig
  deployment: Deployment
  /** Explicit commit to build. When absent, the tip of `repo.branch`. */
  commitSha?: string | null
  onLog: (chunk: BuildLogChunk) => void
  /**
   * The phase list, whole, at every phase boundary.
   *
   * A REPLACEMENT rather than an append, unlike `onLog`. The runner holds the
   * authoritative array and hands over a copy, which is a handful of calls
   * per build rather than the per-chunk traffic that made the log need its
   * own append path in storage.
   *
   * Optional so a caller that does not care (tests, the fake runner) can omit
   * it without the runner branching on undefined at four call sites.
   */
  onSteps?: (steps: BuildStep[]) => void
  /** Aborts the build — wired to process shutdown and to the timeout. */
  signal?: AbortSignal
}

export interface BuildResult {
  ok: boolean
  /** Resolved commit actually built, when the clone got far enough to know. */
  commitSha: string | null
  /** That commit's subject line, resolved beside the sha. */
  commitMessage: string | null
  fileCount: number
  /** Set when `ok` is false. Safe to show a user — never carries a token. */
  failureReason?: string
  /**
   * The deploy-time root-absolute asset scan's result, when `ok` is true —
   * see `root-absolute-scan.ts`. Absent (not merely `null`) on a failed
   * build, since `BuildQueue` never reaches the deployment's terminal
   * `updateDeployment` call in that branch.
   */
  warnings?: DeploymentWarning[] | null
}

export interface BuildRunner {
  run(request: BuildRequest): Promise<BuildResult>
}

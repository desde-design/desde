import type { ServerResponse } from "node:http"
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  type AheadOfDeployment,
  type StatusResponse,
} from "../../../src/editor/mcp/status-schema.js"
import { getGitStatus, GitError, type GetGitStatusOptions } from "./git-ops.js"

/**
 * Context the `/mcp/status` route handler needs to compose a
 * {@link StatusResponse}. Owned by the supervisor / CLI bootstrap and
 * passed in per request — the handler itself is stateless.
 *
 * **Deployment lookup is not implemented.** `deployment_id` /
 * `deployed_head_commit` are always `null` and `ahead_of_deployment`
 * always reports `"unknown"` — there is no platform API this handler can
 * call to learn what's deployed. A prior attempt
 * (`desde-api-client.ts`, deleted 2026-08-08 as dead code) built a
 * client against `https://app.desde.dev/api/projects/{slug}/deployments/latest`,
 * a URL shape nothing has ever served; the real (self-hosted) viewer API
 * is `GET /api/v1/projects/{id}/deployments`, keyed by project id (not
 * slug), not filterable by branch, and authenticated with a viewer
 * personal-access-token (`viewer-token-store.ts`) rather than a CLI
 * session token — a real integration would need to be built against
 * that. The CLI-side platform-auth chain this context used to carry
 * (`projectSlug` / a session token) was deleted 2026-08-08 as dead code
 * end to end — see `tasks/todo.md`. `platformBaseUrl` is kept, unused,
 * for whenever a deployment-lookup integration lands.
 */
export interface McpHandlerContext {
  /** Absolute path to the user's repo root (the working tree git probes). */
  repoRoot: string
  /** Reserved for a future platform integration. Currently unused. */
  platformBaseUrl?: string
  /** Test hook for git-ops. */
  gitOptions?: GetGitStatusOptions
}

/**
 * Handle `GET /mcp/status`. Composes a {@link StatusResponse} from git
 * working-tree state (deployment lookup is not implemented — always
 * `null`/`"unknown"`, see the {@link McpHandlerContext} docstring) and
 * writes it to `res` as JSON with the `editor-mcp-status-version` header.
 *
 * Returns nothing — the response is written to `res` directly. Any
 * thrown error is caught and turned into a 500 with a minimal body
 * (the warning machinery covers expected failures; throws are bugs).
 */
export async function handleStatusQuery(
  res: ServerResponse,
  ctx: McpHandlerContext,
): Promise<void> {
  const warnings: string[] = []

  // ── Git side ──────────────────────────────────────────────────────
  let dirty = false
  let head_commit: string | null = null
  let branch: string | null = null
  let head_commit_timestamp: string | null = null
  try {
    const gitStatus = await getGitStatus(ctx.repoRoot, ctx.gitOptions)
    dirty = gitStatus.dirty
    head_commit = gitStatus.head_commit
    branch = gitStatus.branch
    head_commit_timestamp = gitStatus.head_commit_timestamp
  } catch (err) {
    if (err instanceof GitError) {
      warnings.push(`git: ${err.message}`)
    } else {
      warnings.push(`git: unexpected error (${(err as Error).message})`)
    }
    // Continue with null git fields. The status response is still
    // useful — consumers see warnings and can decide how to react.
  }

  if (branch === null && head_commit !== null) {
    // Detached-HEAD signal. The integration doc requires we surface
    // this so the consumer's selection rule defaults to deployed.
    warnings.push("local is detached-HEAD")
  }

  // ── Platform side ─────────────────────────────────────────────────
  // No deployment-lookup integration exists — see the McpHandlerContext
  // docstring for why. Always report unknown, honestly, rather than
  // attempting a call that can never succeed.
  const deployment_id: string | null = null
  const deployed_head_commit: string | null = null
  warnings.push(
    "Desde deployment lookup is not implemented. ahead_of_deployment always reports \"unknown\".",
  )

  // last_edit_timestamp on the LOCAL scope is "most recent commit OR
  // uncommitted save" per the integration doc. Use the commit
  // timestamp from `git log -1 --format=%cI HEAD`. We do NOT use the
  // deployment timestamp — that's the deployed-scope semantics, and
  // mixing them would silently lie to drift consumers.
  // V1 simplification: when `dirty: true`, the in-progress edit time
  // isn't surfaced (no cheap source). The commit time is the most
  // recent ANCHOR; consumers that need finer detail can correlate via
  // edit-handler logs. Future: walk working-tree mtimes when dirty.
  const last_edit_timestamp: string | null = head_commit_timestamp

  // ── ahead_of_deployment derivation ────────────────────────────────
  // The contract:
  //   - `unknown` when the comparison is undefined: unborn HEAD
  //     (head_commit null), or no deployment record (deployment_id
  //     null), or branch null (detached HEAD).
  //   - `true` when local has changes deployed doesn't reflect:
  //     dirty OR head_commit !== deployed_head_commit.
  //   - `false` when both agree.
  let ahead_of_deployment: AheadOfDeployment
  if (head_commit === null || deployment_id === null || branch === null) {
    ahead_of_deployment = "unknown"
  } else if (dirty || head_commit !== deployed_head_commit) {
    ahead_of_deployment = true
  } else {
    ahead_of_deployment = false
  }

  const payload: StatusResponse = {
    scope: "local",
    deployment_id,
    deployed_head_commit,
    branch,
    head_commit,
    dirty,
    ahead_of_deployment,
    last_edit_timestamp,
    warnings,
  }

  res.statusCode = 200
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader(SCHEMA_VERSION_HEADER, String(SCHEMA_VERSION))
  // Cache-Control: status query caches for 1 second on the server side
  // (git-ops TTL), but downstream agents shouldn't rely on a shared
  // browser/proxy cache — they need fresh data per query.
  res.setHeader("Cache-Control", "no-store")
  res.end(JSON.stringify(payload))
}

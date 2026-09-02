/**
 * Cross-team contract for the `editor-local` (CLI) and
 * `desde-deployed` (platform) MCP servers' `status` query.
 *
 * **Read this alongside [docs/editor-mcp-integration.md § Drift signal —
 * `status` query](../../../docs/editor-mcp-integration.md#drift-signal--status-query).**
 * That doc is the human-readable spec; this module is its machine-
 * readable counterpart that BOTH server implementations import. Without
 * a single source of truth, the two implementations would silently
 * drift — and drift is exactly what the status query is supposed to
 * detect, so a drifting status query is worse than no status query.
 *
 * Both servers MUST:
 *   1. Import {@link StatusResponse} for the response shape.
 *   2. Emit `editor-mcp-status-version: <SCHEMA_VERSION>` HTTP header
 *      on every reply.
 *   3. Pass {@link validateStatusResponse} against the shared fixtures
 *      in `__fixtures__/status-responses.json` as a CI gate.
 *
 * Versioning rules (also in the integration doc):
 *   - Optional / nullable additions ⇒ NON-breaking; keep version.
 *   - Field removal ⇒ BREAKING; bump version by 1; ship migration note.
 *   - Semantic change to existing field (e.g., `dirty` boolean → enum)
 *     ⇒ BREAKING; bump version.
 *   - PRs that touch this schema MUST also update fixtures, AND vice
 *     versa — CI gates against half-baked changes.
 */

/** Wire-format version. Bumped only on breaking changes. See module docstring. */
export const SCHEMA_VERSION = 1

/** HTTP header carrying the wire-format version on every status reply. */
export const SCHEMA_VERSION_HEADER = "editor-mcp-status-version"

/**
 * Which scope produced this response. Distinguishes the two server
 * implementations at the wire level so a drift consumer comparing two
 * payloads can label them without inferring from the response source.
 */
export type StatusScope = "local" | "deployed"

/**
 * Whether the local view differs from the deployed view. Tri-state
 * because the comparison isn't always defined:
 *
 * - `true` — local has changes the deployed scope doesn't reflect
 *   (uncommitted edits OR committed-but-unbuilt commits).
 * - `false` — local and deployed agree (clean tree + matching
 *   `head_commit`).
 * - `"unknown"` — the comparison is undefined: branch never deployed,
 *   unborn HEAD, etc. The selection-rule consumer treats this as
 *   "fall through to whichever scope can answer."
 *
 * The `desde-deployed` server ALWAYS reports `false` — by
 * definition the deployed scope agrees with itself.
 */
export type AheadOfDeployment = boolean | "unknown"

/**
 * The full status payload. Shape is symmetric across scopes — both
 * servers populate every field. The {@link StatusResponse.scope} field
 * tags which side it came from; per-field semantics differ by scope per
 * the table in [editor-mcp-integration.md](../../../docs/editor-mcp-integration.md#response-shape).
 */
export interface StatusResponse {
  scope: StatusScope
  /**
   * On `local`: the latest deployment id this branch is tracking, or
   *   `null` if the branch has never been deployed.
   * On `deployed`: the currently deployed deployment id (always
   *   non-null on this scope; if the project has never deployed, the
   *   deployed scope is unreachable, not "null").
   */
  deployment_id: string | null
  /**
   * The 7-char SHA of the commit `deployment_id` was built from.
   * Null on `local` when `deployment_id` is null.
   */
  deployed_head_commit: string | null
  /**
   * On `local`: git branch the working tree is on. Null in detached-HEAD.
   * On `deployed`: branch the deployed version was built from.
   */
  branch: string | null
  /**
   * On `local`: `git rev-parse --short HEAD`. Null on unborn HEAD.
   * On `deployed`: same as `deployed_head_commit`.
   */
  head_commit: string | null
  /**
   * On `local`: working tree has uncommitted changes per `git status --porcelain`.
   * On `deployed`: ALWAYS `false` (deployed is by definition clean).
   */
  dirty: boolean
  /** See {@link AheadOfDeployment}. */
  ahead_of_deployment: AheadOfDeployment
  /**
   * Most recent edit timestamp.
   * On `local`: most recent commit OR uncommitted save. Null when both absent.
   * On `deployed`: deployment timestamp.
   * Format: ISO-8601 with timezone, e.g., `"2026-05-04T22:18:31Z"`.
   */
  last_edit_timestamp: string | null
  /**
   * Free-text non-fatal notes. Examples: `"vite supervisor crashed; data may be stale"`,
   * `"local is detached-HEAD"`. Empty array when no warnings.
   */
  warnings: string[]
}

/** Result of {@link validateStatusResponse}. */
export interface ValidationResult {
  ok: boolean
  /** One human-readable string per failure. Empty when `ok === true`. */
  errors: string[]
}

/**
 * Validate an unknown payload against the StatusResponse contract.
 *
 * Hand-rolled rather than ajv-backed because the schema is small and a
 * 50KB transitive dependency is a poor trade for a single contract.
 * If a second schema joins later (e.g., `read_component`), revisit.
 *
 * Two layers:
 *   1. Shape — every required key present with the right type.
 *   2. Cross-field invariants — the rules that catch drift even when
 *      the shape is valid (e.g., `deployed` scope MUST have
 *      `dirty: false`).
 */
export function validateStatusResponse(input: unknown): ValidationResult {
  const errors: string[] = []
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["payload is not a JSON object"] }
  }
  const r = input as Record<string, unknown>

  // ── Shape checks ───────────────────────────────────────────────────
  if (r.scope !== "local" && r.scope !== "deployed") {
    errors.push(`scope must be "local" or "deployed", got ${JSON.stringify(r.scope)}`)
  }
  errors.push(...checkStringOrNull(r, "deployment_id"))
  errors.push(...checkStringOrNull(r, "deployed_head_commit"))
  errors.push(...checkStringOrNull(r, "branch"))
  errors.push(...checkStringOrNull(r, "head_commit"))
  if (typeof r.dirty !== "boolean") {
    errors.push(`dirty must be boolean, got ${typeOf(r.dirty)}`)
  }
  if (
    r.ahead_of_deployment !== true &&
    r.ahead_of_deployment !== false &&
    r.ahead_of_deployment !== "unknown"
  ) {
    errors.push(
      `ahead_of_deployment must be boolean or "unknown", got ${JSON.stringify(r.ahead_of_deployment)}`,
    )
  }
  errors.push(...checkStringOrNull(r, "last_edit_timestamp"))
  if (typeof r.last_edit_timestamp === "string" && !isIso8601(r.last_edit_timestamp)) {
    errors.push(
      `last_edit_timestamp must be ISO-8601 with timezone, got ${JSON.stringify(r.last_edit_timestamp)}`,
    )
  }
  if (!Array.isArray(r.warnings) || r.warnings.some((w) => typeof w !== "string")) {
    errors.push("warnings must be an array of strings")
  }

  // If shape is broken, bail before invariant checks — they assume
  // typed access and would throw on a malformed payload.
  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // ── Cross-field invariants ─────────────────────────────────────────
  const v = r as unknown as StatusResponse

  if (v.scope === "deployed") {
    if (v.dirty !== false) {
      errors.push("scope=deployed MUST report dirty: false")
    }
    if (v.ahead_of_deployment !== false) {
      errors.push("scope=deployed MUST report ahead_of_deployment: false")
    }
  }

  // deployed_head_commit is the SHA of deployment_id's build. If
  // deployment_id is null there's no deployment to draw a commit from,
  // so deployed_head_commit must also be null.
  if (v.deployment_id === null && v.deployed_head_commit !== null) {
    errors.push(
      "deployed_head_commit must be null when deployment_id is null",
    )
  }

  // ahead_of_deployment === "unknown" is reserved for cases where the
  // comparison is undefined: unborn HEAD (head_commit: null) OR branch
  // never deployed (deployment_id: null). If both have data, the
  // comparison IS defined and the scope must commit to true/false.
  if (v.ahead_of_deployment === "unknown") {
    const hasLocalCommit = v.head_commit !== null
    const hasDeployment = v.deployment_id !== null
    if (hasLocalCommit && hasDeployment && v.scope === "local") {
      errors.push(
        'ahead_of_deployment cannot be "unknown" when both head_commit and deployment_id are non-null on scope=local',
      )
    }
  }

  // Detached HEAD signal: branch=null is local-only. Deployed always
  // ships from a named branch; null branch on the deployed scope is a
  // bug.
  if (v.scope === "deployed" && v.branch === null) {
    errors.push("scope=deployed MUST report a non-null branch")
  }

  return { ok: errors.length === 0, errors }
}

function checkStringOrNull(
  r: Record<string, unknown>,
  key: string,
): string[] {
  const value = r[key]
  if (value !== null && typeof value !== "string") {
    return [`${key} must be string or null, got ${typeOf(value)}`]
  }
  return []
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Strict ISO-8601 with explicit timezone. `Date.parse()` is too lenient
 * (accepts non-ISO strings, locale formats); we re-validate via regex
 * before delegating to `Date.parse` for round-trip safety.
 */
function isIso8601(value: string): boolean {
  // Match: YYYY-MM-DD T HH:MM:SS(.fff)? (Z or ±HH:MM)
  const ISO_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
  if (!ISO_RE.test(value)) return false
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed)
}

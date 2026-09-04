import { promises as fs } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge"
import { desdePath } from "../../../src/editor/worktree/desde-dir.js"
import {
  deriveSlug,
  mintProjectId,
  readIdentityFromConfig,
  writeIdentityIntoConfig,
  type ProjectIdentity,
} from "../../../src/core/project-identity.js"

/**
 * Reads `<repoRoot>/.desde/config.json` to associate a local repo
 * with a Desde project. Owned by the user (committed to the
 * repo). Boot only ever READS it; the CLI writes it solely through the
 * explicit project link/create flows (merge-preserving — see the
 * project-link handler), never silently at boot.
 *
 * **Why a per-repo file vs. CLI flag.** Two designers on the same
 * project should see the same project association without having to
 * remember a flag. Keeping the file in the repo means
 * `git clone && desde .` Just Works.
 *
 * **Why a separate file vs. inlining into package.json.** Future
 * CLI-only config keys (telemetry opt-in, MCP overrides, etc.)
 * shouldn't pollute package.json. A dedicated dotfile keeps the
 * CLI's blast radius tight.
 *
 * **Schema versioning.** Started at 1. Future fields are additive;
 * remove/rename requires a version bump and a migration.
 */

export interface ProjectConfig {
  /** Schema version. 1 (legacy) or 2 (carries an embedded `project` identity). */
  version: number
  /**
   * Embedded project identity. Present on schema v2. The CLI NEVER mints
   * one at boot — only `ensureProjectIdentity`, called from explicit user
   * actions, writes it. That keeps boot free of writes to someone else's
   * committed repo.
   */
  project?: ProjectIdentity
  /**
   * Desde project slug. The CLI passes this into the platform
   * API client (deployment lookup, future MCP queries).
   *
   * OPTIONAL since schema v2: identity moved to the `project` block, whose
   * `id` is the join key. A v1 repo still carries this and it still works;
   * a v2 repo need not have it at all.
   */
  projectSlug?: string
  /**
   * Desde cloud project id — the viewer's `projects` row id (a
   * UUID, stored in the viewer's SQLite database). This is the
   * authoritative link between this local checkout and the shared
   * cloud project: when the user is signed in, the editor resolves
   * the project's comments + membership by this id, so annotations
   * sync with the viewer. Optional — a repo can carry `projectSlug`
   * for deployment lookup without being wired for cloud annotation
   * sync, and an unlinked repo has neither. Written only by the
   * explicit link/create flows.
   */
  projectId?: string
  /**
   * Override for the Desde platform base URL. Useful for staging,
   * per-project subdomains, or self-hosted deployments. When omitted
   * the platform default applies.
   */
  platformBaseUrl?: string
  /**
   * Phase 5 — editor chat quotas. Optional. Default per-turn caps
   * are reasonable for most workflows; raise for long agentic
   * sessions, lower for cost control.
   */
  chat?: {
    /** Max model calls per turn. Default 10. */
    maxModelCallsPerTurn?: number
    /** Max tool calls per turn. Default 20. */
    maxToolCallsPerTurn?: number
    /**
     * Per-session cumulative cost ceiling in USD. The agent refuses
     * a new turn when the running estimate crosses this.
     *
     * There is NO default: omit the key and foreground chat runs
     * unlimited. A soft $20 default existed until 2026-08-14 and was
     * removed, because nothing in the product ever showed it, so it
     * only surfaced as a refusal mid-session. See
     * `resolveCostCeilingUsd` in `src/editor/core/chat-cost-ceiling.ts`.
     * `null` and `0` also mean unlimited.
     */
    costCeilingUsd?: number | null
    /**
     * Phase 5 of tasks/editor-detached-sessions.md — enable the
     * detached chat sessions UI (session picker, per-session
     * statuses, toast-on-completion). Default: `true`. Set to
     * `false` during stabilization periods to fall back to the
     * legacy "one chat per project" experience without disabling
     * worktree-session mode. Server-side behavior (per-sessionId
     * keying, concurrency cap) is unaffected — the flag only
     * gates the picker UI + the toast-on-completion + the local
     * in-flight tracking that drives those.
     */
    detachedSessions?: boolean
  }
  /**
   * Phase 3 — "Use repo conventions". Controls whether the Editor's AI
   * tiers are grounded in the repo's documented conventions (CLAUDE.md,
   * AGENTS.md, .cursorrules, etc.) and which files to exclude from
   * discovery. Omitted → conventions ON, nothing excluded.
   */
  conventions?: ProjectKnowledgeConfig
  /**
   * Editor runtime tunables. Dogfood-scope flags for shell behavior
   * that aren't tied to chat or conventions.
   */
  editor?: {
    /**
     * Whether the shell should reload the iframe after each successful
     * edit (save / chat turn / conflict reload) as a Vite HMR backstop.
     * Default: true (reload, current behavior).
     *
     * Setting this to false drops the reload entirely — relies on Vite
     * HMR to surface editor-written files. Lets open panels, scroll
     * position, and component state survive edits, at the cost of
     * needing a manual refresh if HMR misses a write. Recommended only
     * for dogfooders measuring HMR reliability — telemetry is exposed
     * as `window.__EDITOR_HMR_STATS__` so users can see hit/miss
     * counts in DevTools.
     */
    reloadBackstop?: boolean
    /**
     * Canvas + screenshot-plan surface gate (workspace Canvas tab,
     * "Screenshot → canvas" button, and the agent's `save_screenshot_plan`
     * / `heal_plan_step` tools). DORMANT by product decision 2026-08-04 —
     * the surface is undertested; default `false` (opt-IN — the inverse
     * of `chat.detachedSessions`' opt-out default). Setting the
     * `EDITOR_CANVAS=1` env var also enables it (either enables). Set
     * `true` here to restore the surface once it's ready for more
     * investment.
     */
    canvas?: boolean
    /**
     * In-app code view gate (the CodeMirror pane reached from the
     * prototype's right-click menu via "Open in editor"). DORMANT by
     * product decision 2026-08-14 — it needs visual work and should not
     * ship half finished; default `false` (opt-IN, same shape as
     * `canvas`). Setting the `EDITOR_CODE_VIEW=1` env var also enables
     * it (either enables). Set `true` here to restore the surface.
     *
     * This gates BOTH ends: the client stops offering the menu item, and
     * `GET /api/editor/file` refuses while it is off, so a stale client
     * cannot read source over the API behind a dormant surface.
     */
    codeView?: boolean
    /**
     * Notes surface gate (the "Note" button, note rows in the Comments
     * list, note pins in the iframe). DORMANT by product decision
     * 2026-08-14; default `false` (opt-IN, same shape as `canvas`).
     * Setting the `EDITOR_NOTES=1` env var also enables it (either
     * enables). Set `true` here to restore the surface.
     *
     * Gates BOTH ends: the client stops offering notes, and
     * `/api/editor/notes/*` refuses while it is off.
     */
    notes?: boolean
    /**
     * "Open in VS Code" gate — the right-click item that launches
     * `vscode://file/<abs>:<line>`. DORMANT by product decision
     * 2026-08-18; default `false` (opt-IN). `EDITOR_VSCODE_LINK=1` also
     * enables it.
     *
     * ONE end, and that is the whole feature: it calls no API, so there
     * is nothing for a server to refuse. See `isVscodeLinkEnabled` in
     * `dormant-surfaces.ts`.
     */
    vscodeLink?: boolean
    // No `neutralChat` key here. The Desde-owned neutral chat runtime gate
    // (every non-Anthropic provider's chat dispatch) is now opt-OUT by
    // default and env-only: `EDITOR_NEUTRAL_CHAT=0` is the only way to turn
    // it off, and there is deliberately no project-config equivalent. See
    // `isNeutralChatEnabled`'s doc comment in `dormant-surfaces.ts` for why
    // a config key here could only ever half-work.
  }
  /**
   * Audit Task 15 — on-disk retention for the growth points that had no
   * GC: the per-edit backup journal (`.desde/backups/`) and the
   * chat-session turns array (unbounded append-only history). Omitted
   * sub-blocks/fields fall back to the documented defaults; the GC
   * sweeps themselves live in `src/editor/agent-chat-sdk/backups-gc.ts`
   * / `read-snapshot-gc.ts` and `src/editor/agent-chat/session-turns-archive.ts`.
   *
   * **Blast radius (codex round 1, deliberate — not a Task 15
   * regression).** This file validates as ONE unit: a type error
   * anywhere inside `retention` (same as anywhere inside `chat` /
   * `conventions` / `editor`) fails `readProjectConfig` entirely,
   * which degrades the WHOLE project association — `projectSlug`,
   * `chatQuotas`, `conventions`, `editor`, `retention`, AND `llm` all fall
   * back to "unset"/degraded mode, not just the offending block. A
   * scoped-degrade (keep the rest of the config, drop only the bad
   * `retention` sub-block with a warning) was considered and rejected:
   * `readProjectConfig` returns on the FIRST validation failure across
   * every block by design, and carving out one block to survive while
   * its siblings don't would be new, asymmetric behavior — not a
   * one-line fix. Flagging because `retention` (unlike `chat`/
   * `conventions`) is the kind of block a user is likely to hand-tune
   * (tightening `keepNewest`/`maxAgeDays`) without realizing a typo
   * there silently disables deployment lookup too.
   */
  retention?: {
    /** `.desde/backups/` sweep. Runs at CLI boot + after each Commit. */
    backups?: {
      /** Keep at most this many newest backup dirs. Default 200. */
      keepNewest?: number
      /** Delete backup dirs older than this many days. Default 14. */
      maxAgeDays?: number
    }
    /**
     * Per-session persisted `turns` array cap. On overflow, the oldest
     * turns move to a `<sessionId>.archive.jsonl` sidecar (never
     * deleted) so the head file (what chat load/save round-trips)
     * stays bounded.
     */
    chatSessionTurns?: {
      /** Max turns kept in the head session file. Default 500. */
      maxTurns?: number
    }
  }
  /**
   * Which model provider the NON-CHAT lanes use, and per-provider overrides.
   *
   * Chat is not configured here: the model picker's choice is per chat
   * session. These lanes (the LLM patch, repair, iteration-data, goal
   * translation and hint-generation lanes) run outside any session, so they
   * need a project-level answer.
   *
   * `defaultProvider` is honoured only when that provider is actually
   * credentialed, so naming a provider whose key is missing degrades to the
   * one that works instead of failing every save.
   *
   * Note the file: this is `.desde/config.json`, the config Desde actually
   * reads. `tasks/NEXT.md` names `desde.config.json` for this block and is
   * wrong there.
   */
  llm?: {
    defaultProvider?: string
    providers?: Record<string, { model?: string; baseUrl?: string; apiKeyEnv?: string }>
  }
}

export type ReadProjectConfigResult =
  | { ok: true; config: ProjectConfig }
  | {
      ok: false
      /** Discriminator so callers can react differently. */
      reason: "missing" | "malformed" | "unsupported-version" | "missing-required"
      /** Human-readable explanation. */
      message: string
    }

/**
 * `<repoRoot>/.desde/config.json`, guarded. `.desde` is joined through
 * `desdeDir` so a prototype that ships it as a symlink cannot make the
 * writers below drop the project config outside the working tree; see
 * `src/editor/worktree/desde-dir.ts`. Throws `DesdeDirSymlinkError` on such
 * a repo — the writers let it surface, and the reader below reports it as an
 * unreadable config.
 */
function configPathFor(repoRoot: string): string {
  return desdePath(repoRoot, "config.json")
}
const SUPPORTED_VERSION = 1
/**
 * Versions this CLI can READ. Writes are always the newest (see
 * `writeIdentityIntoConfig`). Reading both is what lets an older Editor and a
 * newer one share a repo without either dropping the other's data.
 */
const SUPPORTED_VERSIONS = [1, 2]

/**
 * Read and validate the project config. Returns a discriminated
 * union: `ok: true` with the parsed config, OR `ok: false` with a
 * reason. Callers (cli.ts boot) treat `missing` as expected (the user
 * just hasn't set up association yet) and `malformed`/`unsupported`
 * as errors that should be surfaced clearly.
 */
export async function readProjectConfig(
  repoRoot: string,
): Promise<ReadProjectConfigResult> {
  let configPath: string
  try {
    configPath = configPathFor(repoRoot)
  } catch (err) {
    // This runs on the CLI boot path, whose contract is to degrade rather
    // than refuse to start. A repo whose `.desde` is a symlink reads as a
    // config we cannot use, which is exactly what "malformed" means here.
    return {
      ok: false,
      reason: "malformed",
      message: (err as Error).message,
    }
  }

  let raw: string
  try {
    raw = await fs.readFile(configPath, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        ok: false,
        reason: "missing",
        message: `No project config at ${configPath}. Editor will run in degraded mode (no deployment lookup, ahead_of_deployment will report "unknown"). Create the file to associate this repo with a Desde project.`,
      }
    }
    return {
      ok: false,
      reason: "malformed",
      message: `Could not read ${configPath}: ${(err as Error).message}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      message: `Failed to parse ${configPath}: ${(err as Error).message}`,
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "malformed",
      message: `${configPath} must contain a JSON object at the root.`,
    }
  }
  const obj = parsed as Record<string, unknown>

  if (typeof obj.version !== "number") {
    return {
      ok: false,
      reason: "malformed",
      message: `${configPath}: 'version' must be a number.`,
    }
  }
  if (!SUPPORTED_VERSIONS.includes(obj.version)) {
    return {
      ok: false,
      reason: "unsupported-version",
      message: `${configPath}: schema version ${obj.version} is not supported (this CLI supports ${SUPPORTED_VERSIONS.join(", ")}). Update to a newer editor-cli OR adjust the file.`,
    }
  }

  // `projectSlug` is OPTIONAL as of schema v2 — identity lives in the
  // `project` block instead. A file carrying neither is still valid: an
  // un-migrated repo the user hasn't created a project for yet.
  if (obj.projectSlug !== undefined && (typeof obj.projectSlug !== "string" || obj.projectSlug.length === 0)) {
    return {
      ok: false,
      reason: "malformed",
      message: `${configPath}: 'projectSlug', when present, must be a non-empty string.`,
    }
  }
  // Validate the slug matches the platform's allowed pattern. This
  // is the same shape platform-side slugs follow (URL-safe, no spaces);
  // tightening here surfaces typos at config-load time rather than as
  // a 404 from the deployment-lookup API hours later.
  if (typeof obj.projectSlug === "string" && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(obj.projectSlug)) {
    return {
      ok: false,
      reason: "malformed",
      message: `${configPath}: 'projectSlug' must be lowercase alphanumeric with internal hyphens (e.g., "my-app").`,
    }
  }

  // Optional cloud project id. Additive in schema v1 (per the file's
  // versioning policy: new fields don't need a version bump).
  let projectId: string | undefined
  if (obj.projectId !== undefined) {
    if (typeof obj.projectId !== "string" || obj.projectId.length === 0) {
      return {
        ok: false,
        reason: "malformed",
        message: `${configPath}: 'projectId' must be a non-empty string when present.`,
      }
    }
    // The viewer mints ids with `crypto.randomUUID()`. Accept that
    // plus a permissive superset (alphanumerics, hyphen, underscore)
    // so a future id scheme isn't rejected, while still catching
    // obvious garbage (spaces, slashes, dots, control chars) that
    // would break the viewer's `/api/v1/projects/{id}` URL path.
    if (!/^[A-Za-z0-9_-]+$/.test(obj.projectId)) {
      return {
        ok: false,
        reason: "malformed",
        message: `${configPath}: 'projectId' must be alphanumeric with hyphens/underscores (no spaces, slashes, or dots).`,
      }
    }
    projectId = obj.projectId
  }

  let platformBaseUrl: string | undefined
  if (obj.platformBaseUrl !== undefined) {
    if (typeof obj.platformBaseUrl !== "string") {
      return {
        ok: false,
        reason: "malformed",
        message: `${configPath}: 'platformBaseUrl' must be a string when present.`,
      }
    }
    // Reject anything that's not an absolute http(s) URL — the value
    // ends up as the prefix of every API call, so a relative path or
    // a non-http scheme would silently break in confusing ways.
    let parsedUrl: URL
    try {
      parsedUrl = new URL(obj.platformBaseUrl)
    } catch {
      return {
        ok: false,
        reason: "malformed",
        message: `${configPath}: 'platformBaseUrl' must be an absolute URL.`,
      }
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        ok: false,
        reason: "malformed",
        message: `${configPath}: 'platformBaseUrl' must use http: or https:.`,
      }
    }
    platformBaseUrl = obj.platformBaseUrl
  }

  // Phase 5 — chat quotas. Optional and unfiltered for V1 (defensive
  // value clamping happens at the orchestrator boundary). Reject only
  // structurally malformed input (non-object) and obviously-invalid
  // negative numbers; everything else passes through.
  let chat: ProjectConfig['chat']
  if (obj.chat !== undefined) {
    if (typeof obj.chat !== 'object' || obj.chat === null || Array.isArray(obj.chat)) {
      return {
        ok: false,
        reason: 'malformed',
        message: `${configPath}: 'chat' must be an object when provided.`,
      }
    }
    const c = obj.chat as Record<string, unknown>
    const out: NonNullable<ProjectConfig['chat']> = {}
    for (const key of ['maxModelCallsPerTurn', 'maxToolCallsPerTurn'] as const) {
      const v = c[key]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'chat.${key}' must be a positive finite number.`,
        }
      }
      out[key] = v
    }
    // Audit Task 15 — `costCeilingUsd` gets a soft product default (see
    // `resolveCostCeilingUsd`) applied when the key is OMITTED. To let a
    // project explicitly opt OUT of that default (run unlimited), `null`
    // and `0` are both accepted here and normalized to `null` — the
    // resolver downstream treats `null` as "no ceiling".
    if (c.costCeilingUsd !== undefined) {
      if (c.costCeilingUsd === null || c.costCeilingUsd === 0) {
        out.costCeilingUsd = null
      } else if (
        typeof c.costCeilingUsd !== 'number' ||
        !Number.isFinite(c.costCeilingUsd) ||
        c.costCeilingUsd < 0
      ) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'chat.costCeilingUsd' must be a positive finite number, 0, or null.`,
        }
      } else {
        out.costCeilingUsd = c.costCeilingUsd
      }
    }
    // Phase 5 of tasks/editor-detached-sessions.md — opt-out flag
    // for the detached chat sessions UI.
    if (c.detachedSessions !== undefined) {
      if (typeof c.detachedSessions !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'chat.detachedSessions' must be a boolean.`,
        }
      }
      out.detachedSessions = c.detachedSessions
    }
    chat = Object.keys(out).length > 0 ? out : undefined
  }

  // Phase 3 — "Use repo conventions". Optional. `useRepoConventions`
  // defaults to true (omitted = on); `excludeFiles` is repo-relative
  // POSIX paths to drop from rules/docs discovery.
  let conventions: ProjectConfig['conventions']
  if (obj.conventions !== undefined) {
    if (
      typeof obj.conventions !== 'object' ||
      obj.conventions === null ||
      Array.isArray(obj.conventions)
    ) {
      return {
        ok: false,
        reason: 'malformed',
        message: `${configPath}: 'conventions' must be an object when provided.`,
      }
    }
    const cv = obj.conventions as Record<string, unknown>
    const out: { useRepoConventions?: boolean; excludeFiles?: string[] } = {}
    if (cv.useRepoConventions !== undefined) {
      if (typeof cv.useRepoConventions !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'conventions.useRepoConventions' must be a boolean.`,
        }
      }
      out.useRepoConventions = cv.useRepoConventions
    }
    if (cv.excludeFiles !== undefined) {
      if (
        !Array.isArray(cv.excludeFiles) ||
        !cv.excludeFiles.every((f) => typeof f === 'string' && f.length > 0)
      ) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'conventions.excludeFiles' must be an array of non-empty strings.`,
        }
      }
      out.excludeFiles = cv.excludeFiles as string[]
    }
    conventions = Object.keys(out).length > 0 ? out : undefined
  }

  // Editor runtime tunables. Dogfood-scope; expand as needed.
  let editor: ProjectConfig['editor']
  if (obj.editor !== undefined) {
    if (
      typeof obj.editor !== 'object' ||
      obj.editor === null ||
      Array.isArray(obj.editor)
    ) {
      return {
        ok: false,
        reason: 'malformed',
        message: `${configPath}: 'editor' must be an object when provided.`,
      }
    }
    const co = obj.editor as Record<string, unknown>
    const out: NonNullable<ProjectConfig['editor']> = {}
    if (co.reloadBackstop !== undefined) {
      if (typeof co.reloadBackstop !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'editor.reloadBackstop' must be a boolean.`,
        }
      }
      out.reloadBackstop = co.reloadBackstop
    }
    if (co.canvas !== undefined) {
      if (typeof co.canvas !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'editor.canvas' must be a boolean.`,
        }
      }
      out.canvas = co.canvas
    }
    if (co.codeView !== undefined) {
      if (typeof co.codeView !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'editor.codeView' must be a boolean.`,
        }
      }
      out.codeView = co.codeView
    }
    if (co.notes !== undefined) {
      if (typeof co.notes !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'editor.notes' must be a boolean.`,
        }
      }
      out.notes = co.notes
    }
    if (co.vscodeLink !== undefined) {
      // Same explicit refusal as `codeView` / `notes` above, not a silent
      // `typeof` skip: a malformed value here would otherwise read as the
      // default (dormant), which happens to be right and teaches nothing.
      if (typeof co.vscodeLink !== 'boolean') {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'editor.vscodeLink' must be a boolean.`,
        }
      }
      out.vscodeLink = co.vscodeLink
    }
    // No `neutralChat` key: that gate is env-only (`EDITOR_NEUTRAL_CHAT`),
    // with no project-config equivalent — see the type declaration above.
    // A stray `neutralChat` key in an existing `.desde/config.json` is
    // silently ignored here rather than rejected, since it already had no
    // effect before this change either.
    editor = Object.keys(out).length > 0 ? out : undefined
  }

  // Audit Task 15 — retention tunables for backups + chat-session turns.
  // Optional; every sub-field falls back to a documented default when
  // omitted (see the interface doc comments above).
  let retention: ProjectConfig['retention']
  if (obj.retention !== undefined) {
    if (
      typeof obj.retention !== 'object' ||
      obj.retention === null ||
      Array.isArray(obj.retention)
    ) {
      return {
        ok: false,
        reason: 'malformed',
        message: `${configPath}: 'retention' must be an object when provided.`,
      }
    }
    const r = obj.retention as Record<string, unknown>
    const out: NonNullable<ProjectConfig['retention']> = {}

    if (r.backups !== undefined) {
      if (
        typeof r.backups !== 'object' ||
        r.backups === null ||
        Array.isArray(r.backups)
      ) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'retention.backups' must be an object when provided.`,
        }
      }
      const b = r.backups as Record<string, unknown>
      const backupsOut: NonNullable<NonNullable<ProjectConfig['retention']>['backups']> = {}
      if (b.keepNewest !== undefined) {
        if (
          typeof b.keepNewest !== 'number' ||
          !Number.isInteger(b.keepNewest) ||
          b.keepNewest <= 0
        ) {
          return {
            ok: false,
            reason: 'malformed',
            message: `${configPath}: 'retention.backups.keepNewest' must be a positive integer.`,
          }
        }
        backupsOut.keepNewest = b.keepNewest
      }
      if (b.maxAgeDays !== undefined) {
        if (
          typeof b.maxAgeDays !== 'number' ||
          !Number.isFinite(b.maxAgeDays) ||
          b.maxAgeDays <= 0
        ) {
          return {
            ok: false,
            reason: 'malformed',
            message: `${configPath}: 'retention.backups.maxAgeDays' must be a positive finite number.`,
          }
        }
        backupsOut.maxAgeDays = b.maxAgeDays
      }
      if (Object.keys(backupsOut).length > 0) out.backups = backupsOut
    }

    if (r.chatSessionTurns !== undefined) {
      if (
        typeof r.chatSessionTurns !== 'object' ||
        r.chatSessionTurns === null ||
        Array.isArray(r.chatSessionTurns)
      ) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'retention.chatSessionTurns' must be an object when provided.`,
        }
      }
      const t = r.chatSessionTurns as Record<string, unknown>
      const turnsOut: NonNullable<NonNullable<ProjectConfig['retention']>['chatSessionTurns']> = {}
      if (t.maxTurns !== undefined) {
        if (
          typeof t.maxTurns !== 'number' ||
          !Number.isInteger(t.maxTurns) ||
          t.maxTurns <= 0
        ) {
          return {
            ok: false,
            reason: 'malformed',
            message: `${configPath}: 'retention.chatSessionTurns.maxTurns' must be a positive integer.`,
          }
        }
        turnsOut.maxTurns = t.maxTurns
      }
      if (Object.keys(turnsOut).length > 0) out.chatSessionTurns = turnsOut
    }

    retention = Object.keys(out).length > 0 ? out : undefined
  }

  let llm: ProjectConfig['llm']
  if (obj.llm !== undefined) {
    if (typeof obj.llm !== 'object' || obj.llm === null || Array.isArray(obj.llm)) {
      return {
        ok: false,
        reason: 'malformed',
        message: `${configPath}: 'llm' must be an object when provided.`,
      }
    }
    const l = obj.llm as Record<string, unknown>
    const out: NonNullable<ProjectConfig['llm']> = {}
    if (l.defaultProvider !== undefined) {
      if (typeof l.defaultProvider !== 'string' || l.defaultProvider.length === 0) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'llm.defaultProvider' must be a non-empty string.`,
        }
      }
      out.defaultProvider = l.defaultProvider
    }
    if (l.providers !== undefined) {
      if (
        typeof l.providers !== 'object' ||
        l.providers === null ||
        Array.isArray(l.providers)
      ) {
        return {
          ok: false,
          reason: 'malformed',
          message: `${configPath}: 'llm.providers' must be an object when provided.`,
        }
      }
      const providers: NonNullable<NonNullable<ProjectConfig['llm']>['providers']> = {}
      for (const [id, raw] of Object.entries(l.providers as Record<string, unknown>)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return {
            ok: false,
            reason: 'malformed',
            message: `${configPath}: 'llm.providers.${id}' must be an object.`,
          }
        }
        const entry = raw as Record<string, unknown>
        const parsed: { model?: string; baseUrl?: string; apiKeyEnv?: string } = {}
        for (const key of ['model', 'baseUrl', 'apiKeyEnv'] as const) {
          const v = entry[key]
          if (v === undefined) continue
          if (typeof v !== 'string' || v.length === 0) {
            return {
              ok: false,
              reason: 'malformed',
              message: `${configPath}: 'llm.providers.${id}.${key}' must be a non-empty string.`,
            }
          }
          parsed[key] = v
        }
        providers[id] = parsed
      }
      if (Object.keys(providers).length > 0) out.providers = providers
    }
    llm = Object.keys(out).length > 0 ? out : undefined
  }

  return {
    ok: true,
    config: {
      version: obj.version,
      // A malformed identity block degrades to "no identity" rather than
      // failing the whole config — the rest of the file is still usable and
      // boot must never be blocked by it.
      ...(readIdentityFromConfig(obj) ? { project: readIdentityFromConfig(obj)! } : {}),
      ...(typeof obj.projectSlug === "string" ? { projectSlug: obj.projectSlug } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(platformBaseUrl !== undefined ? { platformBaseUrl } : {}),
      ...(chat !== undefined ? { chat } : {}),
      ...(conventions !== undefined ? { conventions } : {}),
      ...(editor !== undefined ? { editor } : {}),
      ...(retention !== undefined ? { retention } : {}),
      ...(llm !== undefined ? { llm } : {}),
    },
  }
}

/** Fields the explicit link/create flow sets on `.desde/config.json`. */
export interface ProjectLinkFields {
  projectSlug: string
  projectId: string
  platformBaseUrl?: string
}

/**
 * Merge-preserving write of `.desde/config.json` — the ONLY path
 * by which the CLI writes this file (boot never does). Reads the
 * existing file (if any), overlays the project-association fields, and
 * writes atomically (temp + rename), preserving every other key the
 * user authored (chat / conventions / editor / unknown-future keys)
 * and forcing `version` to the supported value.
 *
 * Throws if the existing file is present but not a JSON object — we
 * refuse to clobber a file we can't safely merge. Returns the merged
 * object that was written.
 */
export async function writeProjectConfig(
  repoRoot: string,
  fields: ProjectLinkFields,
): Promise<Record<string, unknown>> {
  const configPath = configPathFor(repoRoot)

  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, "utf-8")
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(
          `${configPath} is not a JSON object; refusing to overwrite. Fix or remove it, then re-link.`,
        )
      }
      existing = parsed as Record<string, unknown>
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
    // Missing file → start from empty (a fresh link).
  }

  const merged: Record<string, unknown> = {
    ...existing,
    version: SUPPORTED_VERSION,
    projectSlug: fields.projectSlug,
    projectId: fields.projectId,
    ...(fields.platformBaseUrl !== undefined
      ? { platformBaseUrl: fields.platformBaseUrl }
      : {}),
  }

  await fs.mkdir(dirname(configPath), { recursive: true })
  const tmp = `${configPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8")
    await fs.rename(tmp, configPath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
  return merged
}

/**
 * Read the repo's project identity, minting and PERSISTING one if absent.
 *
 * This is the only writer of identity, and it is reached only from explicit
 * user actions — creating a project in the launcher, linking to a viewer.
 * Never from boot. Migration is explicit-action-only precisely so the CLI
 * never rewrites a user's committed config behind their back; the cost is
 * that an un-migrated repo can't answer the collision-prevention query until
 * someone touches it, which is the better trade.
 *
 * Idempotent: an existing identity comes back unchanged, INCLUDING its name.
 * Renaming is a separate, deliberate operation, so a caller passing a
 * different `name` here can't silently rename a project out from under a
 * teammate who already committed it.
 */
export async function ensureProjectIdentity(
  repoRoot: string,
  opts: { name: string },
): Promise<ProjectIdentity> {
  const configPath = configPathFor(repoRoot)

  let existingText: string | null = null
  try {
    existingText = await fs.readFile(configPath, "utf-8")
  } catch {
    // Missing is the ordinary first-run case — start from an empty object.
  }

  let raw: Record<string, unknown> = {}
  if (existingText !== null && existingText.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(existingText)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      } else {
        throw new Error("not an object")
      }
    } catch {
      // A non-empty file we can't parse is the user's own content. Refuse
      // rather than overwrite it — silently clobbering a committed config
      // is far worse than making them fix a typo.
      throw new Error(
        `${configPath} is not valid JSON. Fix or remove it before creating a project.`,
      )
    }
  }

  const existing = readIdentityFromConfig(raw)
  if (existing) return existing

  const name = opts.name.trim() || "Untitled project"
  const identity: ProjectIdentity = {
    id: mintProjectId(),
    name,
    slug: deriveSlug(name),
  }
  const next = writeIdentityIntoConfig(raw, identity)
  await fs.mkdir(dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(next, null, 2) + "\n", "utf-8")
  return identity
}

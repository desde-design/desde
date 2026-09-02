import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ConflictError, NotFoundError } from "./errors"
import { runMigrations } from "./migrations"
import { omitUndefined } from "./patch-utils"
import { MAX_BUILD_LOG_BYTES, appendBounded, INTERRUPTED_BUILD_LOG_LINE } from "./log-append"
import type {
  BuildStep,
  CreateUserInput,
  Deployment,
  DeploymentCreateInput,
  DeploymentStatus,
  DeploymentUpdatePatch,
  DeploymentWarning,
  DomainRule,
  EnqueueNotificationInput,
  InstanceInvite,
  InstanceRole,
  MachineToken,
  MachineTokenCreateInput,
  MachineTokenScope,
  NotificationOutbox,
  Participant,
  Project,
  ProjectAccess,
  ProjectCreateInput,
  ProjectMember,
  ProjectRepoConfig,
  ProjectUpdatePatch,
  Session,
  SignInToken,
  StorageAdapter,
  StoredCommentInput,
  StoredCommentPatch,
  StoredCommentReplyInput,
  User,
  UserInstallationEntry,
  UserInstallations,
  UserProfilePatch,
  UserStatus,
} from "./types"
import type { Comment, CommentAuthor, CommentReply } from "@/types/bridge"

interface ProjectRow {
  id: string
  slug: string
  name: string
  repo_url: string | null
  access: string
  active_deployment_id: string | null
  created_at: string
}

interface DeploymentRow {
  id: string
  project_id: string
  status: string
  commit_sha: string | null
  commit_message: string | null
  build_log: string
  warnings: string | null
  steps: string | null
  created_at: string
}

interface ParticipantRow {
  id: string
  project_id: string
  email: string
  display_name: string
  status: string
  created_at: string
}

interface NotificationOutboxRow {
  id: string
  project_id: string
  comment_id: string
  reply_id: string | null
  recipient_ids: string
  status: string
  created_at: string
}

interface UserRow {
  id: string
  provider: string
  provider_user_id: string | null
  email: string
  display_name: string
  avatar_url: string
  role: string
  status: string
  created_at: string
}

interface SessionRow {
  id: string
  user_id: string
  created_at: string
  expires_at: string
}

interface ProjectMemberRow {
  project_id: string
  user_id: string
  created_at: string
}

interface ProjectRepoConfigRow {
  project_id: string
  installation_id: number
  owner: string
  name: string
  default_branch: string
  branch: string
  install_command: string
  build_command: string
  output_dir: string
  auto_deploy: number
}

interface MachineTokenRow {
  id: string
  user_id: string
  name: string
  scopes: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

interface InstanceInviteRow {
  id: string
  email: string
  role: string
  token_hash: string
  created_by_user_id: string | null
  created_at: string
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

interface SignInTokenRow {
  id: string
  user_id: string | null
  email: string | null
  token_hash: string
  created_at: string
  expires_at: string
  used_at: string | null
}

interface DomainRuleRow {
  domain: string
  role: string
  created_by_user_id: string | null
  created_at: string
}

const KNOWN_SCOPES: readonly string[] = ["read", "write"]

/**
 * True iff `error` is `node:sqlite`'s shape for "a UNIQUE (or PRIMARY KEY)
 * constraint was violated" (SQLite error code 2067,
 * `SQLITE_CONSTRAINT_UNIQUE`). Shared by every `createX` that ALSO runs a
 * pre-insert SELECT to produce a readable `ConflictError` — the SELECT is
 * what makes the refusal legible (a slug, an email, an identity, named in
 * the message) but is not atomic with the INSERT that follows it, so this
 * is the backstop for the race the check itself cannot close: a concurrent
 * writer that wins between the SELECT and the INSERT surfaces here instead
 * of as a raw, unhandled `SQLITE_ERROR`.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).code === "ERR_SQLITE_ERROR" &&
    (error as Record<string, unknown>).errcode === 2067
  )
}

/**
 * Reads the `machine_tokens.scopes` JSON blob, degrading to `[]` on ANY
 * corruption (unparseable JSON, a non-array, unrecognized scope strings)
 * rather than throwing.
 *
 * A bare `JSON.parse` here was a latent asymmetric failure: `verifyMachineToken`
 * wraps its storage calls in a catch-all, so a corrupt row merely 401'd that
 * one token — but `GET /api/v1/tokens` maps every one of the caller's rows
 * through this converter with no such wrapper, so a single corrupt row 500'd
 * the whole list and locked the user out of the very UI they'd use to revoke
 * it. Degrading is also the SAFE direction: `[]` authorizes strictly less than
 * any real scope set (`lacksWriteScope` refuses it for every write), so a
 * corrupt row can never be read as MORE authority than it had.
 */
function parseScopes(raw: string): MachineTokenScope[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((s): s is MachineTokenScope => typeof s === "string" && KNOWN_SCOPES.includes(s))
}

/**
 * Reads `deployments.warnings` — `NULL` for "no warnings" (the common case),
 * a JSON array of `DeploymentWarning` otherwise. Degrades to `null` on ANY
 * corruption, the same direction `parseScopes` above degrades in: a row a
 * future version wrote in some other shape must not 500 every deployment
 * list, and treating it as "no warning" can never overstate the risk to a
 * reader — it can only under-report one, which the scan simply re-runs on
 * the next deploy.
 */
function parseDeploymentWarnings(raw: string | null): DeploymentWarning[] | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? (parsed as DeploymentWarning[]) : null
}

/** Inverse of `parseDeploymentWarnings` — `null` stays SQL `NULL`, never the string `"null"`. */
function serializeDeploymentWarnings(warnings: DeploymentWarning[] | null): string | null {
  return warnings === null ? null : JSON.stringify(warnings)
}

/** Mirrors `serializeDeploymentWarnings` — `NULL` means "no phases to show". */
function serializeDeploymentSteps(steps: BuildStep[] | null): string | null {
  return steps === null ? null : JSON.stringify(steps)
}

/**
 * Reads `deployments.steps`. A malformed or non-array value degrades to
 * `null` rather than throwing: a deployment row whose step JSON is corrupt
 * should still list, because the log and the status are the parts anyone
 * needs, and the steps are the decoration.
 */
function parseDeploymentSteps(raw: string | null): BuildStep[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BuildStep[]) : null
  } catch {
    return null
  }
}

/**
 * Default (selfhost) StorageAdapter. Uses Node's built-in `node:sqlite`
 * so a self-hosted deployment needs no native module and no external
 * database — `docker run` with a mounted volume is the whole story.
 */
export class SqliteStorage implements StorageAdapter {
  private db: DatabaseSync
  private closed = false

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      // 0700, not the process umask (audit K10). This database holds every
      // session row, every machine-token hash and the full comment record —
      // on a shared machine the default 0755/0644 makes all of it readable
      // by any local account. Mirrors the pattern the Editor already uses
      // for its credential files (editor-cli/src/server/session-info.ts).
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
      // `mode` on mkdirSync applies only on CREATION, so a directory that
      // already existed (an upgrade, a mounted volume, a dir another tool
      // made) keeps whatever mode it had. Tighten it explicitly.
      // Best-effort: a read-only or foreign-owned mount is not a reason to
      // refuse to boot, and the per-file chmod below is the real guard.
      try {
        chmodSync(dirname(dbPath), 0o700)
      } catch {
        // Ignore — see above.
      }
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      -- Without this, a concurrent writer (a second outbox-drain tick racing
      -- claimNotification, a request writing a comment at the same instant)
      -- throws SQLITE_BUSY immediately instead of waiting briefly for the
      -- lock to clear — node:sqlite defaults busy_timeout to 0. 5s is long
      -- enough to ride out a real contended write without masking a
      -- genuinely stuck lock.
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo_url TEXT,
        visibility TEXT NOT NULL,
        active_deployment_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT,
        build_log TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deployments_by_project
        ON deployments (project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        position TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        replies TEXT NOT NULL DEFAULT '[]',
        mentions TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS comments_by_project ON comments (project_id, number);
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS participants_by_project_email ON participants (project_id, email);
      CREATE INDEX IF NOT EXISTS participants_by_project ON participants (project_id, created_at);
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        reply_id TEXT,
        recipient_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON notification_outbox (status, created_at);
      CREATE TABLE IF NOT EXISTS notification_optouts (
        participant_id TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS optout_unique ON notification_optouts (participant_id, ifnull(project_id, ''));
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_by_provider ON users (provider, provider_user_id);
      CREATE INDEX IF NOT EXISTS users_by_email ON users (email);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at);
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS project_members_by_user ON project_members (user_id);
      CREATE INDEX IF NOT EXISTS project_members_by_project ON project_members (project_id, created_at);
      CREATE TABLE IF NOT EXISTS machine_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS machine_tokens_by_user ON machine_tokens (user_id, created_at);
      -- Phase 3c-1: GitHub App repo + build config, one row per project.
      -- A SEPARATE table, not new columns on \`projects\` — every table here
      -- is \`CREATE TABLE IF NOT EXISTS\`, re-declared on every boot, and
      -- there is no migration system. That makes a brand-new table safe on
      -- an existing on-disk database (a no-op if it already exists, a normal
      -- create otherwise) but makes adding a column to an EXISTING table
      -- unsafe: \`CREATE TABLE IF NOT EXISTS projects (...)\` is a no-op
      -- against an already-existing \`projects\` table, so a newly added
      -- column would silently never appear on an upgraded deployment while
      -- passing every test against a fresh database. See
      -- sqlite-storage.test.ts's "opens a pre-existing database" test, which
      -- proves this against a hand-rolled pre-3c-1 schema.
      -- Phase 3c-1b: which GitHub App installations each user could see at
      -- their last sign-in. A SEPARATE table for the same reason
      -- \`project_repo_configs\` is one (see the note below it): there is no
      -- migration system, so a new column on the existing \`users\` table
      -- would silently never appear on an upgraded deployment. One row per
      -- (user, installation) rather than a JSON blob — the only queries are
      -- "the set for this user" and "replace the set for this user", both of
      -- which a relational shape answers without parsing.
      --
      -- \`user_installation_syncs\` records the CAPTURE, separate from the
      -- ids, so that a user who can see NO installations is still
      -- distinguishable from a user who has never been captured at all: the
      -- first has a sync row and zero id rows, the second has neither.
      CREATE TABLE IF NOT EXISTS user_installations (
        user_id TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, installation_id)
      );
      CREATE TABLE IF NOT EXISTS user_installation_syncs (
        user_id TEXT PRIMARY KEY,
        synced_at TEXT NOT NULL
      );
      -- Security audit B4: the repos WITHIN an installation that a specific
      -- user can personally reach, from
      -- \`GET /user/installations/{id}/repositories\` with the USER's token.
      -- Installation visibility is not an access decision — an ordinary org
      -- member typically sees the installation and is denied most of its
      -- repos — so the connect-repo route intersects against this.
      --
      -- TWO tables, for the same reason \`user_installations\` /
      -- \`user_installation_syncs\` are two: "GitHub answered, and this user
      -- can reach no repo here" must stay distinguishable from "we never
      -- asked". The first has a capture row and zero repo rows; the second
      -- has neither, and is treated as authorizing NOTHING. Both are new
      -- tables (never new columns on an existing one) — see the note above.
      CREATE TABLE IF NOT EXISTS user_installation_repos (
        user_id TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        repo_full_name TEXT NOT NULL,
        PRIMARY KEY (user_id, installation_id, repo_full_name)
      );
      CREATE TABLE IF NOT EXISTS user_installation_repo_captures (
        user_id TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, installation_id)
      );
      -- The repo-embedded project id this project has adopted. A SEPARATE
      -- table for exactly the reason \`project_repo_configs\` is one: there is
      -- no migration system here, so a new column on the existing
      -- \`projects\` table would silently never appear on an upgraded
      -- deployment while passing every test against a fresh database.
      -- UNIQUE on embedded_id because two repos carrying one id is the fork
      -- case, and letting the second claim it would silently re-point
      -- whatever hangs off the join key.
      CREATE TABLE IF NOT EXISTS project_embedded_ids (
        project_id TEXT PRIMARY KEY,
        embedded_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS project_repo_configs (
        project_id TEXT PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        install_command TEXT NOT NULL,
        build_command TEXT NOT NULL,
        output_dir TEXT NOT NULL,
        auto_deploy INTEGER NOT NULL
      );
    `)
    // Everything above this line is the frozen baseline schema — every
    // table declared `CREATE TABLE IF NOT EXISTS`, re-declared on every
    // boot, safe to no-op against an existing database but unable to add a
    // column to one or transform existing rows (see the "Phase 3c-1" note
    // earlier in this block, on why that limit forced sibling tables instead
    // of columns). Schema changes that need either of those now go in
    // migrations.ts instead of growing this block.
    runMigrations(this.db)
    if (dbPath !== ":memory:") this.tightenDatabaseFileModes(dbPath)
  }

  /**
   * Chmod the database and its WAL siblings to 0600 (audit K10).
   *
   * Runs AFTER the schema `exec` above deliberately: `PRAGMA journal_mode =
   * WAL` plus the first write is what creates `<db>-wal` and `<db>-shm`, and
   * SQLite creates them with the process umask (measured: 0644). They live
   * for the lifetime of this connection, so one pass here covers the files
   * that actually exist at runtime.
   *
   * Best-effort per file — a sibling that doesn't exist yet is not an error,
   * and a failed chmod must not stop the server booting. The enclosing
   * directory is already 0700, which is the load-bearing guard; this is the
   * second layer for a data dir that was pre-created world-readable by
   * something else.
   */
  private tightenDatabaseFileModes(dbPath: string): void {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        chmodSync(file, 0o600)
      } catch {
        // Not created yet, or not ours to chmod.
      }
    }
  }

  private toProject(row: ProjectRow): Project {
    // A per-project lookup rather than a batch join even in `listProjects`
    // — one extra indexed (PRIMARY KEY) query per project. Simpler to reason
    // about than threading a Map through every call site, and self-host
    // scale (dozens of projects, not thousands) makes the N+1 cost moot.
    const configRow = this.getRepoConfigRow(row.id)
    const embeddedRow = this.db
      .prepare(`SELECT embedded_id FROM project_embedded_ids WHERE project_id = ?`)
      .get(row.id) as { embedded_id: string } | undefined
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      repoUrl: row.repo_url,
      access: row.access as ProjectAccess,
      activeDeploymentId: row.active_deployment_id,
      repoConfig: configRow ? this.toRepoConfig(configRow) : null,
      embeddedId: embeddedRow?.embedded_id ?? null,
      createdAt: row.created_at,
    }
  }

  private getRepoConfigRow(projectId: string): ProjectRepoConfigRow | undefined {
    return this.db
      .prepare(`SELECT * FROM project_repo_configs WHERE project_id = ?`)
      .get(projectId) as ProjectRepoConfigRow | undefined
  }

  private toRepoConfig(row: ProjectRepoConfigRow): ProjectRepoConfig {
    return {
      installationId: row.installation_id,
      owner: row.owner,
      name: row.name,
      defaultBranch: row.default_branch,
      branch: row.branch,
      installCommand: row.install_command,
      buildCommand: row.build_command,
      outputDir: row.output_dir,
      autoDeploy: row.auto_deploy === 1,
    }
  }

  private toDeployment(row: DeploymentRow): Deployment {
    return {
      id: row.id,
      projectId: row.project_id,
      status: row.status as DeploymentStatus,
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      buildLog: row.build_log,
      warnings: parseDeploymentWarnings(row.warnings),
      steps: parseDeploymentSteps(row.steps),
      createdAt: row.created_at,
    }
  }

  private toParticipant(row: ParticipantRow): Participant {
    return {
      id: row.id,
      projectId: row.project_id,
      email: row.email,
      displayName: row.display_name,
      status: row.status as "active" | "pending",
      createdAt: row.created_at,
    }
  }

  private toNotificationOutbox(row: NotificationOutboxRow): NotificationOutbox {
    return {
      id: row.id,
      projectId: row.project_id,
      commentId: row.comment_id,
      replyId: row.reply_id,
      recipientIds: JSON.parse(row.recipient_ids) as string[],
      status: row.status as "pending" | "sending" | "sent" | "error",
      createdAt: row.created_at,
    }
  }

  private toUser(row: UserRow): User {
    return {
      id: row.id,
      provider: row.provider as "github" | "email",
      providerUserId: row.provider_user_id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      role: row.role as InstanceRole,
      status: row.status as UserStatus,
      createdAt: row.created_at,
    }
  }

  private toSession(row: SessionRow): Session {
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  private toProjectMember(row: ProjectMemberRow): ProjectMember {
    return {
      projectId: row.project_id,
      userId: row.user_id,
      createdAt: row.created_at,
    }
  }

  // `scopes` round-trips as a JSON array of MachineTokenScope strings —
  // same convention as `comments.mentions` / `notification_outbox.recipient_ids`
  // elsewhere in this file. Kept as one representation on purpose: the
  // conformance suite proves both storage impls round-trip it identically.
  private toMachineToken(row: MachineTokenRow): MachineToken {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    }
  }

  private toInstanceInvite(row: InstanceInviteRow): InstanceInvite {
    return {
      id: row.id,
      email: row.email,
      role: row.role as InstanceRole,
      tokenHash: row.token_hash,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
    }
  }

  private toSignInToken(row: SignInTokenRow): SignInToken {
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email,
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    }
  }

  private toDomainRule(row: DomainRuleRow): DomainRule {
    return {
      domain: row.domain,
      role: row.role as InstanceRole,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
    }
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    const project: Project = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      repoUrl: input.repoUrl ?? null,
      access: input.access ?? "all-members",
      activeDeploymentId: null,
      // A fresh randomUUID id can't already have a project_repo_configs or
      // project_embedded_ids row — set directly rather than querying
      // (this.toProject queries for the general case; createProject knows the
      // answer without asking).
      repoConfig: null,
      embeddedId: null,
      createdAt: new Date().toISOString(),
    }
    try {
      this.db
        .prepare(
          `INSERT INTO projects
             (id, slug, name, repo_url, access, active_deployment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          project.slug,
          project.name,
          project.repoUrl,
          project.access,
          project.activeDeploymentId,
          project.createdAt,
        )
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(`Project slug already exists: ${input.slug}`)
      }
      throw error
    }
    return project
  }

  async getProject(id: string): Promise<Project | null> {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined
    return row ? this.toProject(row) : null
  }

  async getProjectBySlug(slug: string): Promise<Project | null> {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE slug = ?`)
      .get(slug) as ProjectRow | undefined
    return row ? this.toProject(row) : null
  }

  async listProjects(): Promise<Project[]> {
    // `created_at` alone doesn't guarantee a stable tie-break for two
    // projects created within the same millisecond — `rowid` increases
    // monotonically with insertion order, so pairing it as the secondary
    // sort key satisfies the StorageAdapter.listProjects contract (oldest
    // first, ties broken by creation order). Same pattern as
    // listDeployments below.
    const rows = this.db
      .prepare(`SELECT * FROM projects ORDER BY created_at ASC, rowid ASC`)
      .all() as unknown as ProjectRow[]
    return rows.map((row) => this.toProject(row))
  }

  async updateProject(id: string, patch: ProjectUpdatePatch): Promise<Project> {
    const existing = await this.getProject(id)
    if (!existing) throw new NotFoundError("Project", id)
    const next: Project = { ...existing, ...omitUndefined(patch) }
    this.db
      .prepare(
        `UPDATE projects
            SET name = ?, repo_url = ?, access = ?, active_deployment_id = ?
          WHERE id = ?`,
      )
      .run(next.name, next.repoUrl, next.access, next.activeDeploymentId, id)
    return next
  }

  async deleteProject(id: string): Promise<void> {
    // M4: wrapped in a transaction, same `BEGIN IMMEDIATE` pattern
    // `setUserInstallations` uses. Nine DELETEs across eight tables with no
    // transaction meant a crash (or a process kill) partway through left the
    // project in an undefined in-between state — e.g. `projects` gone but
    // `comments`/`participants` orphaned and never cleaned up, or the
    // reverse: `projects` still present but its `project_members` already
    // wiped, silently locking every member out of a project that still
    // exists. `BEGIN IMMEDIATE` (not a plain `BEGIN`) takes the write lock up
    // front, matching the caller-facing contract that a delete either fully
    // lands or fully doesn't.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(`DELETE FROM comments WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM deployments WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM participants WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM notification_outbox WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM notification_optouts WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM project_members WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM project_repo_configs WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM project_embedded_ids WHERE project_id = ?`).run(id)
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  async setProjectRepoConfig(projectId: string, config: ProjectRepoConfig): Promise<Project> {
    const project = await this.getProject(projectId)
    if (!project) throw new NotFoundError("Project", projectId)

    const result = this.db
      .prepare(
        `INSERT INTO project_repo_configs
           (project_id, installation_id, owner, name, default_branch, branch, install_command, build_command, output_dir, auto_deploy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           installation_id = excluded.installation_id,
           owner = excluded.owner,
           name = excluded.name,
           default_branch = excluded.default_branch,
           branch = excluded.branch,
           install_command = excluded.install_command,
           build_command = excluded.build_command,
           output_dir = excluded.output_dir,
           auto_deploy = excluded.auto_deploy
         RETURNING *`,
      )
      .get(
        projectId,
        config.installationId,
        config.owner,
        config.name,
        config.defaultBranch,
        config.branch,
        config.installCommand,
        config.buildCommand,
        config.outputDir,
        config.autoDeploy ? 1 : 0,
      ) as ProjectRepoConfigRow | undefined

    // Fallback in case RETURNING isn't honored — same defensive pattern as
    // upsertParticipant above.
    const row = result ?? this.getRepoConfigRow(projectId)
    if (!row) throw new Error(`Failed to set repo config for project: ${projectId}`)

    return { ...project, repoConfig: this.toRepoConfig(row) }
  }

  async clearProjectRepoConfig(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId)
    if (!project) throw new NotFoundError("Project", projectId)
    this.db.prepare(`DELETE FROM project_repo_configs WHERE project_id = ?`).run(projectId)
    return { ...project, repoConfig: null }
  }

  async setProjectEmbeddedId(projectId: string, embeddedId: string): Promise<Project> {
    const project = await this.getProject(projectId)
    if (!project) throw new NotFoundError("Project", projectId)

    const claimant = this.db
      .prepare(`SELECT project_id FROM project_embedded_ids WHERE embedded_id = ?`)
      .get(embeddedId) as { project_id: string } | undefined
    // Idempotent for the same project; a different claimant is the fork case.
    if (claimant && claimant.project_id !== projectId) {
      throw new ConflictError(
        `Embedded project id ${embeddedId} is already claimed by project ${claimant.project_id}`,
      )
    }

    this.db
      .prepare(
        `INSERT INTO project_embedded_ids (project_id, embedded_id)
         VALUES (?, ?)
         ON CONFLICT(project_id) DO UPDATE SET embedded_id = excluded.embedded_id`,
      )
      .run(projectId, embeddedId)
    return { ...project, embeddedId }
  }

  async getProjectByEmbeddedId(embeddedId: string): Promise<Project | null> {
    const row = this.db
      .prepare(`SELECT project_id FROM project_embedded_ids WHERE embedded_id = ?`)
      .get(embeddedId) as { project_id: string } | undefined
    return row ? this.getProject(row.project_id) : null
  }

  async getProjectByRepo(owner: string, name: string): Promise<Project | null> {
    // GitHub treats owner/name case-insensitively; a case-SENSITIVE lookup
    // here would mint a duplicate project for the same repo.
    const row = this.db
      .prepare(
        `SELECT project_id FROM project_repo_configs
         WHERE LOWER(owner) = LOWER(?) AND LOWER(name) = LOWER(?)`,
      )
      .get(owner, name) as { project_id: string } | undefined
    return row ? this.getProject(row.project_id) : null
  }

  async createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
    const deployment: Deployment = {
      id: randomUUID(),
      projectId: input.projectId,
      status: input.status ?? "building",
      commitSha: input.commitSha ?? null,
      commitMessage: null,
      buildLog: "",
      warnings: null,
      // `null`, not `[]`: a deployment has no phases until a build records
      // one, and an upload never will.
      steps: null,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO deployments
           (id, project_id, status, commit_sha, commit_message, build_log, warnings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deployment.id,
        deployment.projectId,
        deployment.status,
        deployment.commitSha,
        deployment.commitMessage,
        deployment.buildLog,
        serializeDeploymentWarnings(deployment.warnings),
        deployment.createdAt,
      )
    return deployment
  }

  async getDeployment(id: string): Promise<Deployment | null> {
    const row = this.db
      .prepare(`SELECT * FROM deployments WHERE id = ?`)
      .get(id) as DeploymentRow | undefined
    return row ? this.toDeployment(row) : null
  }

  async listDeployments(projectId: string): Promise<Deployment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM deployments
          WHERE project_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId) as unknown as DeploymentRow[]
    return rows.map((row) => this.toDeployment(row))
  }

  async appendDeploymentLog(id: string, chunk: string, maxBytes: number): Promise<void> {
    const existing = await this.getDeployment(id)
    if (!existing) return
    const next = appendBounded(existing.buildLog, chunk, maxBytes)
    if (next === null) return
    this.db.prepare(`UPDATE deployments SET build_log = ? WHERE id = ?`).run(next, id)
  }

  async markInterruptedBuildsFailed(): Promise<number> {
    // Fix wave 10, item 4: a bulk `build_log = build_log || ?` used to skip
    // `MAX_BUILD_LOG_BYTES` entirely — the cap every OTHER write to
    // `build_log` respects via `appendBounded` — so a log already at (or
    // near) the cap when the server restarted could grow past it. Reading
    // each interrupted row first is what makes routing through
    // `appendBounded` possible; it trades the single bulk UPDATE for one
    // UPDATE per row, which is fine for something that only ever runs once,
    // at boot.
    const rows = this.db
      .prepare(`SELECT * FROM deployments WHERE status = 'building'`)
      .all() as unknown as DeploymentRow[]
    if (rows.length === 0) return 0
    const update = this.db.prepare(
      `UPDATE deployments SET status = 'failed', build_log = ? WHERE id = ?`,
    )
    for (const row of rows) {
      const existing = this.toDeployment(row)
      const bounded = appendBounded(existing.buildLog, INTERRUPTED_BUILD_LOG_LINE, MAX_BUILD_LOG_BYTES)
      // `null` means the log is already at cap and already carries the
      // truncation marker — nothing to append, but the status flip still
      // has to land, so fall back to the unchanged log.
      update.run(bounded ?? existing.buildLog, row.id)
    }
    return rows.length
  }

  async updateDeployment(
    id: string,
    patch: DeploymentUpdatePatch,
  ): Promise<Deployment> {
    const existing = await this.getDeployment(id)
    if (!existing) throw new NotFoundError("Deployment", id)
    const next: Deployment = { ...existing, ...omitUndefined(patch) }
    this.db
      .prepare(
        `UPDATE deployments SET status = ?, build_log = ?, commit_sha = ?, commit_message = ?, warnings = ?, steps = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.buildLog,
        next.commitSha,
        next.commitMessage,
        serializeDeploymentWarnings(next.warnings),
        serializeDeploymentSteps(next.steps),
        id,
      )
    return next
  }

  private toComment(row: Record<string, unknown>): Comment {
    const author = JSON.parse(row.author as string) as CommentAuthor
    const replies = JSON.parse(row.replies as string) as CommentReply[]
    const participantEmails: string[] = []
    for (const email of [author.email, ...replies.map((r) => r.author.email)]) {
      if (email && !participantEmails.includes(email)) participantEmails.push(email)
    }
    return {
      id: row.id as string,
      number: row.number as number,
      position: JSON.parse(row.position as string),
      body: row.body as string,
      author,
      createdAt: row.created_at as string,
      resolved: (row.resolved as number) === 1,
      replies,
      mentions: JSON.parse(row.mentions as string),
      participantEmails,
      projectId: row.project_id as string,
    }
  }

  async listComments(projectId: string): Promise<Comment[]> {
    const rows = this.db
      .prepare("SELECT * FROM comments WHERE project_id = ? ORDER BY number ASC")
      .all(projectId) as unknown as Record<string, unknown>[]
    return rows.map((r) => this.toComment(r))
  }

  async getComment(commentId: string): Promise<Comment | null> {
    const row = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(commentId) as
      | Record<string, unknown>
      | undefined
    return row ? this.toComment(row) : null
  }

  async createComment(projectId: string, input: StoredCommentInput): Promise<Comment> {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const next = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM comments WHERE project_id = ?")
      .get(projectId) as unknown as { n: number }
    this.db
      .prepare(
        "INSERT INTO comments (id, project_id, number, position, body, author, created_at, resolved, replies, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', ?)",
      )
      .run(
        id,
        projectId,
        next.n,
        JSON.stringify(input.position),
        input.body,
        JSON.stringify(input.author),
        createdAt,
        JSON.stringify(input.mentions ?? []),
      )
    return (await this.getComment(id))!
  }

  async updateComment(commentId: string, patch: StoredCommentPatch): Promise<Comment> {
    const existing = await this.getComment(commentId)
    if (!existing) throw new NotFoundError("Comment", commentId)
    const merged = { ...existing, ...omitUndefined({ body: patch.body, resolved: patch.resolved, mentions: patch.mentions }) }
    this.db
      .prepare("UPDATE comments SET body = ?, resolved = ?, mentions = ? WHERE id = ?")
      .run(merged.body, merged.resolved ? 1 : 0, JSON.stringify(merged.mentions), commentId)
    return (await this.getComment(commentId))!
  }

  async addCommentReply(commentId: string, reply: StoredCommentReplyInput): Promise<Comment> {
    const existing = await this.getComment(commentId)
    if (!existing) throw new NotFoundError("Comment", commentId)
    const replies: CommentReply[] = [
      ...existing.replies,
      {
        id: randomUUID(),
        body: reply.body,
        author: reply.author,
        createdAt: new Date().toISOString(),
        mentions: [...(reply.mentions ?? [])],
      },
    ]
    this.db.prepare("UPDATE comments SET replies = ? WHERE id = ?").run(JSON.stringify(replies), commentId)
    return (await this.getComment(commentId))!
  }

  async deleteComment(commentId: string): Promise<void> {
    const result = this.db.prepare("DELETE FROM comments WHERE id = ?").run(commentId)
    if (result.changes === 0) throw new NotFoundError("Comment", commentId)
  }

  async listParticipants(projectId: string): Promise<Participant[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM participants
          WHERE project_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(projectId) as unknown as ParticipantRow[]
    return rows.map((row) => this.toParticipant(row))
  }

  async getParticipant(participantId: string): Promise<Participant | null> {
    const row = this.db
      .prepare(`SELECT * FROM participants WHERE id = ?`)
      .get(participantId) as ParticipantRow | undefined
    return row ? this.toParticipant(row) : null
  }

  async upsertParticipant(
    projectId: string,
    input: { email: string; displayName: string; status: "active" | "pending" },
  ): Promise<Participant> {
    const lowerEmail = input.email.toLowerCase()
    const id = randomUUID()
    const createdAt = new Date().toISOString()

    const result = this.db
      .prepare(
        `INSERT INTO participants (id, project_id, email, display_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, email) DO UPDATE SET
           display_name = excluded.display_name,
           status = CASE WHEN excluded.status = 'active' THEN 'active' ELSE participants.status END
         RETURNING *`,
      )
      .get(id, projectId, lowerEmail, input.displayName, input.status, createdAt) as
      | ParticipantRow
      | undefined

    if (result) {
      return this.toParticipant(result)
    }

    // Fallback: if RETURNING doesn't work, look up the row after write
    const lookupRow = this.db
      .prepare(`SELECT * FROM participants WHERE project_id = ? AND email = ?`)
      .get(projectId, lowerEmail) as ParticipantRow | undefined

    if (lookupRow) {
      return this.toParticipant(lookupRow)
    }

    throw new Error(`Failed to upsert participant: ${projectId}/${lowerEmail}`)
  }

  async enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutbox> {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO notification_outbox
           (id, project_id, comment_id, reply_id, recipient_ids, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.projectId,
        input.commentId,
        input.replyId ?? null,
        JSON.stringify(input.recipientIds),
        createdAt,
      )
    return (await this.getNotification(id))!
  }

  async listPendingNotifications(limit: number): Promise<NotificationOutbox[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_outbox
          WHERE status = 'pending'
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`,
      )
      .all(limit) as unknown as NotificationOutboxRow[]
    return rows.map((row) => this.toNotificationOutbox(row))
  }

  async claimNotification(id: string): Promise<boolean> {
    // Atomically flip pending→sending using UPDATE with WHERE status='pending'.
    // RETURNING returns the row iff the update happened (was pending).
    // This is the exactly-once primitive: a second claim returns false.
    const result = this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'sending'
         WHERE id = ? AND status = 'pending'
         RETURNING id`,
      )
      .get(id) as { id: string } | undefined
    return result !== undefined
  }

  async setNotificationStatus(id: string, status: "sent" | "error"): Promise<void> {
    const result = this.db.prepare(`UPDATE notification_outbox SET status = ? WHERE id = ?`).run(status, id)
    if (result.changes === 0) throw new NotFoundError("Notification", id)
  }

  async getNotification(id: string): Promise<NotificationOutbox | null> {
    const row = this.db
      .prepare(`SELECT * FROM notification_outbox WHERE id = ?`)
      .get(id) as NotificationOutboxRow | undefined
    return row ? this.toNotificationOutbox(row) : null
  }

  async recordOptout(input: { participantId: string; projectId: string | null }): Promise<void> {
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO notification_optouts (participant_id, project_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(participant_id, ifnull(project_id, '')) DO NOTHING`,
      )
      .run(input.participantId, input.projectId, createdAt)
  }

  async isOptedOut(participantId: string, projectId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `SELECT 1 FROM notification_optouts
         WHERE participant_id = ? AND (project_id IS NULL OR project_id = ?)
         LIMIT 1`,
      )
      .get(participantId, projectId) as { "1": number } | undefined
    return result !== undefined
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const lowerEmail = input.email.toLowerCase()

    // Checked here as well as by the UNIQUE indexes so the caller gets a
    // named ConflictError with the address in it, not a raw
    // SQLITE_CONSTRAINT. The indexes are what make the state impossible; this
    // is what makes the refusal legible. Both are wanted: a check without the
    // index loses to a concurrent writer, and an index without the check
    // surfaces as a 500.
    const emailHolder = this.db
      .prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
      .get(lowerEmail) as { id: string } | undefined
    if (emailHolder) {
      throw new ConflictError(
        `Email already belongs to another account: ${lowerEmail}. ` +
          `An operator must remove the stale account before it can be reused.`,
      )
    }
    if (input.providerUserId !== null) {
      const identityHolder = this.db
        .prepare(`SELECT id FROM users WHERE provider = ? AND provider_user_id = ? LIMIT 1`)
        .get(input.provider, input.providerUserId) as { id: string } | undefined
      if (identityHolder) {
        throw new ConflictError(
          `Provider identity already belongs to another account: ${input.provider}/${input.providerUserId}`,
        )
      }
    }

    try {
      this.db
        .prepare(
          `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, role, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.provider,
          input.providerUserId,
          lowerEmail,
          input.displayName,
          input.avatarUrl,
          input.role,
          createdAt,
        )
    } catch (error) {
      // M3: the backstop for the SELECT-then-INSERT race the two checks
      // above cannot close — a concurrent createUser call for the same email
      // or identity that wins between the SELECT and this INSERT. Whichever
      // of the two UNIQUE indexes fired, the underlying fact is the same:
      // someone else's account already holds it.
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(
          `Email or provider identity already belongs to another account: ${lowerEmail}`,
        )
      }
      throw error
    }

    return (await this.getUser(id))!
  }

  async createUserIfInstanceEmpty(input: CreateUserInput): Promise<User | null> {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const lowerEmail = input.email.toLowerCase()

    // Same `BEGIN IMMEDIATE` pattern as `setUserInstallations`/`deleteProject`
    // — see the doc comment on `StorageAdapter.createUserIfInstanceEmpty`.
    // The count-then-insert must be one atomic unit: `createUser`'s plain
    // check-then-insert is fine there because a genuine email/identity
    // collision throws a named `ConflictError`, but "is the instance empty"
    // has no such backstop — two callers who both observe zero would both
    // insert successfully (distinct emails, nothing to collide on), and
    // there would be no error to signal that the second one should have been
    // refused instead.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const countRow = this.db.prepare(`SELECT COUNT(*) AS count FROM users`).get() as {
        count: number
      }
      if (countRow.count > 0) {
        this.db.exec("ROLLBACK")
        return null
      }
      this.db
        .prepare(
          `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, role, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          id,
          input.provider,
          input.providerUserId,
          lowerEmail,
          input.displayName,
          input.avatarUrl,
          input.role,
          createdAt,
        )
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }

    return (await this.getUser(id))!
  }

  async updateUserProfile(userId: string, patch: UserProfilePatch): Promise<User> {
    const existing = await this.getUser(userId)
    if (!existing) throw new NotFoundError("User", userId)

    const clean = omitUndefined(patch)
    const email = clean.email === undefined ? existing.email : clean.email.toLowerCase()

    if (email !== existing.email) {
      const holder = this.db
        .prepare(`SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1`)
        .get(email, userId) as { id: string } | undefined
      if (holder) {
        throw new ConflictError(
          `Email already belongs to another account: ${email}. ` +
            `An operator must remove the stale account before it can be reused.`,
        )
      }
    }

    this.db
      .prepare(`UPDATE users SET email = ?, display_name = ?, avatar_url = ? WHERE id = ?`)
      .run(
        email,
        clean.displayName ?? existing.displayName,
        clean.avatarUrl ?? existing.avatarUrl,
        userId,
      )

    return (await this.getUser(userId))!
  }

  async linkProviderIdentity(
    userId: string,
    provider: "github",
    providerUserId: string,
  ): Promise<User> {
    const existing = await this.getUser(userId)
    if (!existing) throw new NotFoundError("User", userId)

    if (existing.providerUserId !== null) {
      if (existing.provider === provider && existing.providerUserId === providerUserId) {
        return existing // idempotent — signing in twice is not an error
      }
      throw new ConflictError(
        `Account ${userId} is already linked to ${existing.provider}/${existing.providerUserId} ` +
          `and cannot be re-linked to ${provider}/${providerUserId}.`,
      )
    }

    const holder = this.db
      .prepare(`SELECT id FROM users WHERE provider = ? AND provider_user_id = ? LIMIT 1`)
      .get(provider, providerUserId) as { id: string } | undefined
    if (holder) {
      throw new ConflictError(
        `Provider identity already belongs to another account: ${provider}/${providerUserId}`,
      )
    }

    // Compare-and-set on the write itself. The checks above are read-then-
    // decide and cannot, by themselves, stop two concurrent callers from
    // both reading `provider_user_id IS NULL` and both deciding to write —
    // whichever runs its UPDATE second would silently overwrite the first
    // one's identity. Only this WHERE clause is atomic: it can match for at
    // most one of two racing callers, because the first UPDATE to land
    // already flips `provider_user_id` away from NULL.
    //
    // That guard protects one row from a double write, but it does nothing
    // for two DIFFERENT identity-less rows racing to link the SAME
    // (provider, providerUserId): each UPDATE's WHERE clause names its own
    // `id`, so both writes can pass the row-level guard, and it is the
    // `users_by_provider` UNIQUE index — keyed on (provider,
    // providerUserId), not on id — that rejects the second one. Same class
    // of race `createUser` handles above (see the `isUniqueConstraintViolation`
    // doc comment), just tripped by an UPDATE instead of an INSERT: without
    // this catch, the second caller gets a raw, unhandled SQLite constraint
    // error instead of a named `ConflictError`.
    const changed = (() => {
      try {
        return this.db
          .prepare(
            `UPDATE users SET provider = ?, provider_user_id = ? WHERE id = ? AND provider_user_id IS NULL`,
          )
          .run(provider, providerUserId, userId)
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictError(
            `Provider identity already belongs to another account: ${provider}/${providerUserId}`,
          )
        }
        throw error
      }
    })()

    if (changed.changes === 0) {
      // Lost the race: something else linked this row between our read
      // above and this write. Re-read to find out what actually landed.
      const after = await this.getUser(userId)
      if (!after) throw new NotFoundError("User", userId)
      if (after.provider === provider && after.providerUserId === providerUserId) {
        return after // the winner linked the exact identity we were also trying to link
      }
      throw new ConflictError(
        `Account ${userId} is already linked to ${after.provider}/${after.providerUserId} ` +
          `and cannot be re-linked to ${provider}/${providerUserId}.`,
      )
    }

    return (await this.getUser(userId))!
  }

  async updateUserRole(userId: string, role: InstanceRole): Promise<User> {
    const changed = this.db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, userId)
    if (changed.changes === 0) throw new NotFoundError("User", userId)
    return (await this.getUser(userId))!
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<User> {
    const changed = this.db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, userId)
    if (changed.changes === 0) throw new NotFoundError("User", userId)
    return (await this.getUser(userId))!
  }

  async listUsers(): Promise<User[]> {
    // `rowid` is the tie-break: `created_at` has millisecond resolution and
    // is not unique, and the admin list is read as an ordered directory.
    const rows = this.db
      .prepare(`SELECT * FROM users ORDER BY created_at, rowid`)
      .all() as unknown as UserRow[]
    return rows.map((row) => this.toUser(row))
  }

  async countUsers(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM users`).get() as { count: number }
    return row.count
  }

  async getUser(userId: string): Promise<User | null> {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(userId) as UserRow | undefined
    return row ? this.toUser(row) : null
  }

  async getUserByProviderIdentity(
    provider: "github",
    providerUserId: string,
  ): Promise<User | null> {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`)
      .get(provider, providerUserId) as UserRow | undefined
    return row ? this.toUser(row) : null
  }

  async getUserByEmail(email: string): Promise<User | null> {
    // `LIMIT 2`, not `.get()` — audit S18. A bare `.get()` silently returned
    // the LOWEST rowid (the earliest-created account) whenever two rows
    // shared an address, handing a private-project invite to the wrong
    // person. `users_by_email_unique` now makes that state impossible to
    // form, so this is defense in depth: it is what stands if a future
    // migration, a hand-edited database, or a second impl ever lets it back
    // in. Refusing is the only safe answer — the caller cannot tell which
    // account the inviter meant, and neither can we.
    const rows = this.db
      .prepare(`SELECT * FROM users WHERE email = ? ORDER BY rowid LIMIT 2`)
      .all(email.toLowerCase()) as unknown as UserRow[]
    if (rows.length > 1) {
      throw new ConflictError(
        `Email is ambiguous: more than one account holds ${email.toLowerCase()}. ` +
          `An operator must remove the stale account before it can be used.`,
      )
    }
    return rows[0] ? this.toUser(rows[0]) : null
  }

  async setUserInstallations(
    userId: string,
    installations: UserInstallationEntry[],
    syncedAt: string,
  ): Promise<void> {
    const user = await this.getUser(userId)
    if (!user) throw new NotFoundError("User", userId)

    // Delete-then-insert, so an installation (or a repo) the user has LOST
    // access to actually disappears. Wrapped in a transaction: a crash
    // between the delete and the inserts would otherwise leave the user with
    // an empty set and a stale sync stamp — i.e. silently authorized for
    // nothing, with no signal that it happened. The repo half is written
    // inside the SAME transaction so an id can never outlive the repo
    // entitlement captured with it.
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(`DELETE FROM user_installations WHERE user_id = ?`).run(userId)
      this.db.prepare(`DELETE FROM user_installation_repos WHERE user_id = ?`).run(userId)
      this.db.prepare(`DELETE FROM user_installation_repo_captures WHERE user_id = ?`).run(userId)
      const insertInstallation = this.db.prepare(
        `INSERT OR IGNORE INTO user_installations (user_id, installation_id) VALUES (?, ?)`,
      )
      const insertCapture = this.db.prepare(
        `INSERT OR IGNORE INTO user_installation_repo_captures (user_id, installation_id) VALUES (?, ?)`,
      )
      const insertRepo = this.db.prepare(
        `INSERT OR IGNORE INTO user_installation_repos (user_id, installation_id, repo_full_name)
         VALUES (?, ?, ?)`,
      )
      for (const entry of installations) {
        insertInstallation.run(userId, entry.installationId)
        // A `null` repo set records NO capture row, which reads back as
        // `null` and authorizes nothing. `[]` records the capture with no
        // repo rows — "GitHub answered: none" — which also authorizes
        // nothing but means something different to the UI.
        if (entry.repoFullNames === null) continue
        insertCapture.run(userId, entry.installationId)
        for (const fullName of entry.repoFullNames) {
          insertRepo.run(userId, entry.installationId, fullName.toLowerCase())
        }
      }
      this.db
        .prepare(
          `INSERT INTO user_installation_syncs (user_id, synced_at) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET synced_at = excluded.synced_at`,
        )
        .run(userId, syncedAt)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  async getUserInstallations(userId: string): Promise<UserInstallations | null> {
    const sync = this.db
      .prepare(`SELECT synced_at FROM user_installation_syncs WHERE user_id = ?`)
      .get(userId) as { synced_at: string } | undefined
    if (!sync) return null
    const rows = this.db
      .prepare(
        `SELECT installation_id FROM user_installations WHERE user_id = ? ORDER BY installation_id`,
      )
      .all(userId) as unknown as { installation_id: number }[]
    const captured = new Set(
      (
        this.db
          .prepare(
            `SELECT installation_id FROM user_installation_repo_captures WHERE user_id = ?`,
          )
          .all(userId) as unknown as { installation_id: number }[]
      ).map((r) => r.installation_id),
    )
    const repoRows = this.db
      .prepare(
        `SELECT installation_id, repo_full_name FROM user_installation_repos
          WHERE user_id = ? ORDER BY repo_full_name`,
      )
      .all(userId) as unknown as { installation_id: number; repo_full_name: string }[]
    const reposById = new Map<number, string[]>()
    for (const row of repoRows) {
      const list = reposById.get(row.installation_id)
      if (list) list.push(row.repo_full_name)
      else reposById.set(row.installation_id, [row.repo_full_name])
    }
    return {
      installations: rows.map((r) => ({
        installationId: r.installation_id,
        repoFullNames: captured.has(r.installation_id)
          ? (reposById.get(r.installation_id) ?? [])
          : null,
      })),
      syncedAt: sync.synced_at,
    }
  }

  async createSession(input: { userId: string; expiresAt: string }): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      userId: input.userId,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    }
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(session.id, session.userId, session.createdAt, session.expiresAt)
    return session
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined
    return row ? this.toSession(row) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Idempotent: do not throw if session doesn't exist (logout must be safe to double-fire)
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
  }

  async deleteExpiredSessions(now: string): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM sessions WHERE expires_at <= ?`)
      .run(now)
    return Number(result.changes)
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    // Idempotent: zero rows is a normal result, never an error — revocation
    // must be safe to double-fire (mirrors `deleteSession`).
    const result = this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
    return Number(result.changes)
  }

  async addProjectMember(input: { projectId: string; userId: string }): Promise<ProjectMember> {
    const createdAt = new Date().toISOString()

    const result = this.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET
           project_id = project_members.project_id
         RETURNING *`,
      )
      .get(input.projectId, input.userId, createdAt) as ProjectMemberRow | undefined

    if (!result) throw new Error(`Failed to add project member: ${input.projectId}/${input.userId}`)
    return this.toProjectMember(result)
  }

  async listProjectMembers(projectId: string): Promise<ProjectMember[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM project_members
          WHERE project_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(projectId) as unknown as ProjectMemberRow[]
    return rows.map((row) => this.toProjectMember(row))
  }

  async getProjectMember(projectId: string, userId: string): Promise<ProjectMember | null> {
    const row = this.db
      .prepare(`SELECT * FROM project_members WHERE project_id = ? AND user_id = ?`)
      .get(projectId, userId) as ProjectMemberRow | undefined
    return row ? this.toProjectMember(row) : null
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    // Idempotent: do not throw if member doesn't exist
    this.db.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`).run(projectId, userId)
  }

  async listProjectsForUser(userId: string): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT project_id FROM project_members WHERE user_id = ?`)
      .all(userId) as unknown as { project_id: string }[]
    return rows.map((row) => row.project_id)
  }

  async createMachineToken(input: MachineTokenCreateInput): Promise<MachineToken> {
    const token: MachineToken = {
      id: input.id,
      userId: input.userId,
      name: input.name,
      scopes: [...input.scopes],
      tokenHash: input.tokenHash,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
    }
    this.db
      .prepare(
        `INSERT INTO machine_tokens
           (id, user_id, name, scopes, token_hash, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.userId,
        token.name,
        JSON.stringify(token.scopes),
        token.tokenHash,
        token.createdAt,
        token.lastUsedAt,
        token.expiresAt,
      )
    return token
  }

  async getMachineToken(id: string): Promise<MachineToken | null> {
    const row = this.db
      .prepare(`SELECT * FROM machine_tokens WHERE id = ?`)
      .get(id) as MachineTokenRow | undefined
    return row ? this.toMachineToken(row) : null
  }

  async listMachineTokensForUser(userId: string): Promise<MachineToken[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM machine_tokens
          WHERE user_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(userId) as unknown as MachineTokenRow[]
    return rows.map((row) => this.toMachineToken(row))
  }

  async touchMachineToken(id: string, lastUsedAt: string): Promise<void> {
    // No-op on a missing id — mirrors the fire-and-forget contract in
    // machine-token.ts: a storage blip or a raced revoke must never throw.
    this.db.prepare(`UPDATE machine_tokens SET last_used_at = ? WHERE id = ?`).run(lastUsedAt, id)
  }

  async deleteMachineToken(id: string): Promise<void> {
    // Idempotent: does NOT throw on a missing id (mirrors removeProjectMember/deleteSession).
    this.db.prepare(`DELETE FROM machine_tokens WHERE id = ?`).run(id)
  }

  async deleteMachineTokensForUser(userId: string): Promise<void> {
    this.db.prepare(`DELETE FROM machine_tokens WHERE user_id = ?`).run(userId)
  }

  async createInstanceInvite(input: {
    id: string
    email: string
    role: InstanceRole
    tokenHash: string
    createdByUserId: string | null
    expiresAt: string
  }): Promise<InstanceInvite> {
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO instance_invites
           (id, email, role, token_hash, created_by_user_id, created_at, expires_at, used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.email.toLowerCase(),
        input.role,
        input.tokenHash,
        input.createdByUserId,
        createdAt,
        input.expiresAt,
      )
    return (await this.getInstanceInvite(input.id))!
  }

  async getInstanceInvite(id: string): Promise<InstanceInvite | null> {
    const row = this.db
      .prepare(`SELECT * FROM instance_invites WHERE id = ?`)
      .get(id) as InstanceInviteRow | undefined
    return row ? this.toInstanceInvite(row) : null
  }

  async listInstanceInvites(): Promise<InstanceInvite[]> {
    const rows = this.db
      .prepare(`SELECT * FROM instance_invites ORDER BY created_at ASC, rowid ASC`)
      .all() as unknown as InstanceInviteRow[]
    return rows.map((row) => this.toInstanceInvite(row))
  }

  async getPendingInstanceInviteByEmail(email: string): Promise<InstanceInvite | null> {
    const nowIso = new Date().toISOString()
    const row = this.db
      .prepare(
        `SELECT * FROM instance_invites
          WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(email.toLowerCase(), nowIso) as InstanceInviteRow | undefined
    return row ? this.toInstanceInvite(row) : null
  }

  async resetInstanceInviteToken(id: string, tokenHash: string, expiresAt: string): Promise<InstanceInvite> {
    const changed = this.db
      .prepare(
        `UPDATE instance_invites
            SET token_hash = ?, expires_at = ?, used_at = NULL, revoked_at = NULL
          WHERE id = ?`,
      )
      .run(tokenHash, expiresAt, id)
    if (changed.changes === 0) throw new NotFoundError("InstanceInvite", id)
    return (await this.getInstanceInvite(id))!
  }

  async claimInstanceInvite(id: string, usedAt: string): Promise<boolean> {
    // Same exactly-once primitive as `claimNotification`: RETURNING only
    // yields a row when the guarded UPDATE actually matched, so a second
    // claim — or a claim on a revoked invite — returns false.
    const result = this.db
      .prepare(
        `UPDATE instance_invites
            SET used_at = ?
          WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
      )
      .get(usedAt, id) as { id: string } | undefined
    return result !== undefined
  }

  async unclaimInstanceInvite(id: string): Promise<void> {
    // Idempotent: setting an already-NULL used_at back to NULL matches zero
    // or one row either way, and a missing id matches zero rows rather than
    // throwing.
    this.db.prepare(`UPDATE instance_invites SET used_at = NULL WHERE id = ?`).run(id)
  }

  async revokeInstanceInvite(id: string): Promise<void> {
    // Idempotent: COALESCE keeps the FIRST revoke's timestamp, and a
    // missing id matches zero rows rather than throwing.
    const revokedAt = new Date().toISOString()
    this.db
      .prepare(`UPDATE instance_invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
      .run(revokedAt, id)
  }

  async deleteExpiredInstanceInvites(now: string): Promise<number> {
    // USED and REVOKED rows are excluded explicitly — see this method's
    // doc comment on `StorageAdapter`. Not indexed: invites are
    // admin-minted, not an unauthenticated write surface, so this table
    // never grows fast enough for a full-table scan on a periodic sweep to
    // matter the way it does for `signin_tokens`.
    const result = this.db
      .prepare(
        `DELETE FROM instance_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at <= ?`,
      )
      .run(now)
    return Number(result.changes)
  }

  async createSignInToken(input: {
    id: string
    userId: string | null
    email: string | null
    tokenHash: string
    expiresAt: string
  }): Promise<SignInToken> {
    // Enforced here first, with a readable message — the CHECK constraint
    // on `signin_tokens` is the backstop for anything that writes to the
    // table directly (same two-layer pattern as `createUser`'s email
    // uniqueness check alongside the UNIQUE index).
    if ((input.userId === null) === (input.email === null)) {
      throw new Error(
        `SignInToken requires exactly one of userId or email to be set (got userId=${JSON.stringify(input.userId)}, email=${JSON.stringify(input.email)})`,
      )
    }
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO signin_tokens (id, user_id, email, token_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(input.id, input.userId, input.email ? input.email.toLowerCase() : null, input.tokenHash, createdAt, input.expiresAt)
    return (await this.getSignInToken(input.id))!
  }

  async getSignInToken(id: string): Promise<SignInToken | null> {
    const row = this.db
      .prepare(`SELECT * FROM signin_tokens WHERE id = ?`)
      .get(id) as SignInTokenRow | undefined
    return row ? this.toSignInToken(row) : null
  }

  async claimSignInToken(id: string, usedAt: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE signin_tokens
            SET used_at = ?
          WHERE id = ? AND used_at IS NULL
         RETURNING id`,
      )
      .get(usedAt, id) as { id: string } | undefined
    return result !== undefined
  }

  async deleteExpiredSignInTokens(now: string): Promise<number> {
    // Indexed on `expires_at` (migration 4), so this stays a range scan over
    // the doomed rows rather than a full table scan on every sweep tick.
    const result = this.db.prepare(`DELETE FROM signin_tokens WHERE expires_at <= ?`).run(now)
    return Number(result.changes)
  }

  async deleteSignInTokensForUser(userId: string): Promise<number> {
    // `user_id` only — an email-linked (domain-rule) token names no account
    // and must not be touched by a per-user revocation. Indexed on `user_id`
    // (migration 4, `signin_tokens_by_user`).
    const result = this.db.prepare(`DELETE FROM signin_tokens WHERE user_id = ?`).run(userId)
    return Number(result.changes)
  }

  async deleteSignInTokensForEmail(email: string): Promise<number> {
    // `email` only — a userId-linked token has `email = NULL`, which can
    // never equality-match a real address, so this can't touch one by
    // construction. Indexed on `email` (migration 4, `signin_tokens_by_email`).
    const result = this.db
      .prepare(`DELETE FROM signin_tokens WHERE email = ?`)
      .run(email.toLowerCase())
    return Number(result.changes)
  }

  async hasRecentSignInTokenForSubject(
    subject: { userId: string | null; email: string | null },
    window: { now: string; createdAfter: string },
  ): Promise<boolean> {
    // Two statements rather than one with a CASE over the null subject
    // column: each is a plain equality on its own index (migration 4), and
    // the branch is legible. `LIMIT 1` because the answer is existence — see
    // the contract's note on why this returns a boolean and not the row.
    const row =
      subject.userId !== null
        ? (this.db
            .prepare(
              `SELECT 1 FROM signin_tokens
                WHERE user_id = ? AND used_at IS NULL AND expires_at > ? AND created_at > ?
                LIMIT 1`,
            )
            .get(subject.userId, window.now, window.createdAfter) as unknown)
        : (this.db
            .prepare(
              `SELECT 1 FROM signin_tokens
                WHERE email = ? AND used_at IS NULL AND expires_at > ? AND created_at > ?
                LIMIT 1`,
            )
            .get(
              subject.email === null ? "" : subject.email.toLowerCase(),
              window.now,
              window.createdAfter,
            ) as unknown)
    return row !== undefined && row !== null
  }

  async listDomainRules(): Promise<DomainRule[]> {
    const rows = this.db
      .prepare(`SELECT * FROM domain_rules ORDER BY domain ASC`)
      .all() as unknown as DomainRuleRow[]
    return rows.map((row) => this.toDomainRule(row))
  }

  async setDomainRule(input: {
    domain: string
    role: InstanceRole
    createdByUserId: string | null
  }): Promise<DomainRule> {
    const domain = input.domain.toLowerCase()
    const createdAt = new Date().toISOString()
    // Upsert keyed on the lowercased domain. `created_by_user_id`/`created_at`
    // are only written on INSERT — an upsert updates `role` alone, so the
    // rule's creation identity survives a later re-add (mirrors
    // `addProjectMember`'s role-only upgrade on conflict).
    const result = this.db
      .prepare(
        `INSERT INTO domain_rules (domain, role, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET role = excluded.role
         RETURNING *`,
      )
      .get(domain, input.role, input.createdByUserId, createdAt) as DomainRuleRow | undefined

    // Fallback in case RETURNING isn't honored — same defensive pattern as
    // upsertParticipant/setProjectRepoConfig above.
    const row =
      result ?? (this.db.prepare(`SELECT * FROM domain_rules WHERE domain = ?`).get(domain) as DomainRuleRow | undefined)
    if (!row) throw new Error(`Failed to set domain rule: ${domain}`)
    return this.toDomainRule(row)
  }

  async removeDomainRule(domain: string): Promise<void> {
    this.db.prepare(`DELETE FROM domain_rules WHERE domain = ?`).run(domain.toLowerCase())
  }

  async getInstanceSetting(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM instance_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  async setInstanceSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO instance_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

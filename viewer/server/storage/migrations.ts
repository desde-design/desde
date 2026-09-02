import type { DatabaseSync } from "node:sqlite"
import { LOCAL_OPERATOR_PROVIDER_USER_ID } from "../auth/local-operator"

/**
 * One schema change, applied at most once per database.
 *
 * `version` is the value stored in `PRAGMA user_version` once `up` has run
 * successfully. It must be strictly increasing across `MIGRATIONS`, in
 * array order — `runMigrations` validates that before applying anything.
 */
export interface Migration {
  version: number
  description: string
  up(db: DatabaseSync): void
}

/**
 * Rebuild `users` for instance membership (viewer-membership Task 2):
 *
 * - `role` — what the account may do on this INSTANCE. Backfilled `editor`
 *   for everyone except the single oldest HUMAN account, which becomes
 *   `admin`. That one is the closest thing an existing deployment has to an
 *   operator: before this, the first row was whoever first signed in, and
 *   there is nothing else on the row to infer authority from. Guessing NOBODY
 *   is admin would lock the operator out of their own instance; guessing
 *   everybody is admin would hand it to every reviewer.
 *
 *   **The local-operator row is excluded from that choice, and separately
 *   promoted.** On a zero-config deployment `operator@localhost` is the FIRST
 *   row ever written — `ensureLocalOperatorUser` creates it the moment
 *   somebody opens the boot-printed URL, before any human signs in. An
 *   unqualified "oldest account" therefore resolves, on exactly the
 *   deployments this migration exists to rescue, to a synthetic identity
 *   nobody can sign in as once a GitHub App is configured (`/auth/local`
 *   switches itself off the instant a real provider appears). The instance
 *   would end up with one unreachable admin and a roster of editors, which is
 *   the same thing as having no admin at all. The operator row is set to
 *   `admin` as well, because it is admin BY DEFINITION (whoever holds the
 *   stdout token owns the process — see `ensureLocalOperatorUser`), not as a
 *   fallback for the human promotion.
 * - `status` — soft delete, so a removed person's comments still resolve to
 *   a name.
 * - `provider_user_id` becomes NULLABLE: an account can now be created by
 *   email and claimed by a provider later. The uniqueness of the identity
 *   pair therefore moves to a PARTIAL index — several accounts may have no
 *   identity, and "no identity" must not collide with "no identity".
 * - `email` becomes UNIQUE, and is lowercased on the way across. This is the
 *   constraint that makes email THE identity, and it is what finally makes
 *   the audit-S18 ambiguity (two rows, one address) unrepresentable rather
 *   than merely refused at read time.
 *
 * A full table rebuild rather than `ALTER TABLE ... ADD COLUMN` because
 * SQLite cannot relax a `NOT NULL` on an existing column, and because the
 * copy is where the lowercasing happens.
 *
 * REFUSES to migrate a database that already holds two accounts on one
 * address: there is no safe automatic answer (merging picks a winner among
 * two people's memberships, dropping one deletes an account), so it names
 * the addresses and stops. That is S18's own rule — a half-migrated or
 * silently-merged identity table is worse than a viewer that will not boot.
 */
const usersInstanceMembership: Migration = {
  version: 1,
  description: "users: instance role, account status, nullable provider identity, unique email",
  up(db) {
    const duplicates = db
      .prepare(
        `SELECT lower(email) AS email, COUNT(*) AS count
           FROM users
          GROUP BY lower(email)
         HAVING count > 1
          ORDER BY email`,
      )
      .all() as unknown as { email: string; count: number }[]
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot migrate the users table: ${duplicates.length} email address(es) are held by more ` +
          `than one account, and email is now the identity. ` +
          duplicates.map((d) => `${d.email} (${d.count} accounts)`).join(", ") +
          `. An operator must remove the stale account(s) before this viewer can start.`,
      )
    }

    // The oldest HUMAN account, by the same ordering `listUsers` promises.
    // The leading sort key pushes the local-operator row to the very end, so
    // it wins only when it is the sole account — see this migration's doc
    // comment. Resolved here rather than in a correlated subquery so the
    // promotion can be LOGGED: an operator who disagrees needs to know which
    // address just became admin, and a silent grant of instance authority is
    // not something to discover later.
    const oldest = db
      .prepare(
        `SELECT id, email FROM users
          ORDER BY (provider = 'github' AND provider_user_id = ?) ASC, created_at, rowid
          LIMIT 1`,
      )
      .get(LOCAL_OPERATOR_PROVIDER_USER_ID) as { id: string; email: string } | undefined

    // Looked up separately so the second promotion can be logged on its own
    // terms. It is NOT a fallback for `oldest` — when the operator row is the
    // only account the two are the same row, and the log below says so once.
    const operator = db
      .prepare(
        `SELECT id, email FROM users WHERE provider = 'github' AND provider_user_id = ? LIMIT 1`,
      )
      .get(LOCAL_OPERATOR_PROVIDER_USER_ID) as { id: string; email: string } | undefined

    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_user_id TEXT,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO users_new (id, provider, provider_user_id, email, display_name, avatar_url, role, status, created_at)
       SELECT id, provider, provider_user_id, lower(email), display_name, avatar_url,
              CASE
                WHEN id = ? THEN 'admin'
                WHEN provider = 'github' AND provider_user_id = ? THEN 'admin'
                ELSE 'editor'
              END,
              'active',
              created_at
         FROM users`,
    ).run(oldest?.id ?? null, LOCAL_OPERATOR_PROVIDER_USER_ID)
    db.exec(`
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      -- PARTIAL: several accounts may legitimately carry no provider
      -- identity, and those rows must not collide with each other.
      CREATE UNIQUE INDEX users_by_provider ON users (provider, provider_user_id)
        WHERE provider_user_id IS NOT NULL;
      CREATE UNIQUE INDEX users_by_email_unique ON users (email);
      -- Redundant alongside the unique index, but the frozen baseline schema
      -- in sqlite-storage.ts declares it \`IF NOT EXISTS\` on every boot and
      -- would recreate it anyway. Creating it here keeps the post-migration
      -- database identical to the steady state instead of differing for one
      -- boot.
      CREATE INDEX users_by_email ON users (email);
    `)

    if (oldest && oldest.id !== operator?.id) {
      console.warn(
        `[viewer] migration 1: promoted the oldest account (${oldest.email}) to instance admin. ` +
          `Every other existing account became an editor.`,
      )
    }
    if (operator) {
      console.warn(
        `[viewer] migration 1: kept the local-operator account (${operator.email}) at instance admin. ` +
          `It is admin by definition (whoever holds the boot-printed token owns the process), and it ` +
          `is never counted as "the oldest account" when backfilling roles.`,
      )
    }
  },
}

/**
 * Four new tables for instance membership (viewer-membership Task 3):
 * invites, single-use sign-in tokens, domain auto-admit rules, and a flat
 * key/value settings table. All net-new — no existing table changes shape —
 * so this could have gone in the baseline `CREATE TABLE IF NOT EXISTS` block
 * in sqlite-storage.ts. It's a migration instead so the baseline stays
 * frozen (see the note above that block) and every schema change after
 * migration 1 has one place to live.
 *
 * `signin_tokens.user_id`/`email` carry a `CHECK` enforcing that exactly one
 * is non-null — the storage-adapter layer already refuses this with a
 * readable error before the insert; the constraint is the backstop for
 * anything that writes to this table directly.
 */
const instanceMembershipTables: Migration = {
  version: 2,
  description: "instance invites, sign-in tokens, domain rules, instance settings",
  up(db) {
    db.exec(`
      CREATE TABLE instance_invites (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX instance_invites_by_created_at ON instance_invites (created_at);
      CREATE TABLE signin_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        email TEXT,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        CHECK ((user_id IS NULL) != (email IS NULL))
      );
      CREATE TABLE domain_rules (
        domain TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        created_by_user_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE instance_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  },
}

/**
 * Rebuilds `projects` (`visibility` → `access`, a tri-state) and
 * `project_members` (drops `role`) for viewer-membership Task 9.
 *
 * `projects.visibility` was two states, `"members" | "public-link"`, and a
 * `"members"` project's actual readability depended on a RUNTIME fact — did
 * it have any `project_members` rows — that the column itself did not
 * record (`canReadProject`'s "zero-members" migration rule). `access` makes
 * that fact a first-class stored value instead of a derived one, per row,
 * at migration time:
 *
 * - `'public-link'` stays `'public-link'`.
 * - `'members'` with at least one `project_members` row becomes `'invited'`
 *   — the project already had a real access list, so it keeps meaning
 *   "listed members only."
 * - `'members'` with zero `project_members` rows becomes `'all-members'` —
 *   this is exactly the set the old zero-members rule made world-readable,
 *   so the READ behavior this migration ships with is unchanged (Task 10
 *   narrows `'all-members'` to instance members only; see that task's
 *   `ProjectReadPolicy` note).
 *
 * `project_members` is rebuilt without `role` in the SAME migration —
 * per-project ownership is retired along with the column that recorded it;
 * Tasks 10-12 decide manage authority from the caller's INSTANCE role
 * instead. Both tables are full rebuilds (not `ALTER TABLE`) for the same
 * reason migration 1 rebuilds `users`: SQLite cannot drop a column or
 * relax/tighten a constraint on an existing table.
 *
 * Member rows are copied across untouched apart from dropping `role` —
 * `project_id`, `user_id` and `created_at` all survive verbatim, so an
 * existing access list is preserved exactly, just without the role that
 * used to sit on each row.
 */
const projectAccessTriState: Migration = {
  version: 3,
  description: "projects: visibility → access tri-state; project_members loses role",
  up(db) {
    const memberCounts = db
      .prepare(`SELECT project_id, COUNT(*) AS count FROM project_members GROUP BY project_id`)
      .all() as unknown as { project_id: string; count: number }[]
    const projectsWithMembers = new Set(memberCounts.map((r) => r.project_id))

    const projects = db.prepare(`SELECT id, visibility FROM projects`).all() as unknown as {
      id: string
      visibility: string
    }[]

    db.exec(`
      CREATE TABLE projects_new (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo_url TEXT,
        access TEXT NOT NULL,
        active_deployment_id TEXT,
        created_at TEXT NOT NULL
      );
    `)
    const insertProject = db.prepare(
      `INSERT INTO projects_new (id, slug, name, repo_url, access, active_deployment_id, created_at)
       SELECT id, slug, name, repo_url, ?, active_deployment_id, created_at
         FROM projects WHERE id = ?`,
    )
    for (const project of projects) {
      const access =
        project.visibility === "public-link"
          ? "public-link"
          : projectsWithMembers.has(project.id)
            ? "invited"
            : "all-members"
      insertProject.run(access, project.id)
    }
    db.exec(`
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;

      CREATE TABLE project_members_new (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      INSERT INTO project_members_new (project_id, user_id, created_at)
        SELECT project_id, user_id, created_at FROM project_members;
      DROP TABLE project_members;
      ALTER TABLE project_members_new RENAME TO project_members;
      CREATE INDEX IF NOT EXISTS project_members_by_user ON project_members (user_id);
      CREATE INDEX IF NOT EXISTS project_members_by_project ON project_members (project_id, created_at);
    `)
  },
}

/**
 * Three indexes on `signin_tokens`, for viewer-membership Task 14's two new
 * access patterns. Pure DDL — no row is read or written.
 *
 * Migration 2 created the table with a primary key and nothing else, which
 * was right while `getSignInToken(id)` was the only query. Task 14 added two
 * that are not keyed on the id:
 *
 * - `signin_tokens_by_expires_at` — the sweep
 *   (`deleteExpiredSignInTokens`), a range scan run every 6 hours.
 * - `signin_tokens_by_user` / `signin_tokens_by_email` — the per-subject
 *   mint throttle, run on EVERY `POST /auth/magic-link`, which is an
 *   unauthenticated route. Without an index that is a full table scan per
 *   request, over a table an anonymous caller can grow — i.e. the rate
 *   control would itself be the denial-of-service primitive it exists to
 *   blunt.
 *
 * Neither index is unique: a subject legitimately holds several tokens over
 * time (a 24h admin-issued link alongside a 15-minute magic link, say), and
 * expiry is shared by everything minted in the same millisecond.
 */
const signInTokenIndexes: Migration = {
  version: 4,
  description: "signin_tokens indexes for the expiry sweep and the mint throttle",
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS signin_tokens_by_expires_at ON signin_tokens (expires_at);
      CREATE INDEX IF NOT EXISTS signin_tokens_by_user ON signin_tokens (user_id);
      CREATE INDEX IF NOT EXISTS signin_tokens_by_email ON signin_tokens (email);
    `)
  },
}

/**
 * `deployments.warnings` — nullable JSON, the deploy-time root-absolute
 * asset scan's result (viewer-membership row 7; see
 * `build/root-absolute-scan.ts`). `NULL` means "no warnings" (also the
 * default for every deployment ever created before this migration ran —
 * indistinguishable from "scanned, found nothing" until the next build or
 * upload re-scans it, which is the honest reading: nobody claimed to have
 * scanned it).
 *
 * A plain `ALTER TABLE ... ADD COLUMN`, not a table rebuild like migration
 * 3 — SQLite can add a nullable column with no default with no constraint
 * to violate, unlike the `NOT NULL` case migration 1's doc comment
 * describes. `deployments` is one of the FROZEN baseline tables (see the
 * note above `project_repo_configs` in sqlite-storage.ts): its `CREATE
 * TABLE IF NOT EXISTS` is a no-op on every existing database, so the new
 * column only ever arrives through this migration, on both a fresh and an
 * upgraded database alike.
 */
const deploymentWarnings: Migration = {
  version: 5,
  description: "deployments: nullable warnings JSON column (deploy-time root-absolute asset scan)",
  up(db) {
    db.exec(`ALTER TABLE deployments ADD COLUMN warnings TEXT;`)
  },
}

/**
 * Build phases, for the deployment detail's step list.
 *
 * Same shape as `deploymentWarnings` above and for the same reason: a
 * nullable TEXT column holding JSON, so an existing row reads back as `null`
 * ("no phases to show") rather than needing a backfill. Every deployment that
 * predates this migration is either an upload or a build whose phases were
 * never recorded, and both are honestly `null`.
 */
const deploymentSteps: Migration = {
  version: 6,
  description: "deployments: nullable steps JSON column (build phase list)",
  up(db) {
    db.exec(`ALTER TABLE deployments ADD COLUMN steps TEXT;`)
  },
}

/**
 * Same nullable-column shape again: existing rows honestly read back `null`
 * — an upload has no commit, and older builds never captured a message.
 */
const deploymentCommitMessage: Migration = {
  version: 7,
  description: "deployments: nullable commit_message column (built commit's subject line)",
  up(db) {
    db.exec(`ALTER TABLE deployments ADD COLUMN commit_message TEXT;`)
  },
}

/**
 * The real migration list, applied on every boot after the baseline schema
 * `exec` in `SqliteStorage`'s constructor. See the comment above
 * `project_repo_configs` in sqlite-storage.ts for why a versioned mechanism
 * was needed at all: sibling tables can add a capability, but they cannot add
 * a column to an existing table or transform existing rows.
 *
 * `up` must NOT open a transaction of its own — `runMigrations` already runs
 * each one inside a transaction, and a nested `BEGIN` would throw.
 */
export const MIGRATIONS: Migration[] = [
  usersInstanceMembership,
  instanceMembershipTables,
  projectAccessTriState,
  signInTokenIndexes,
  deploymentWarnings,
  deploymentSteps,
  deploymentCommitMessage,
]

/**
 * Applies every migration in `migrations` whose `version` is greater than
 * the database's current `PRAGMA user_version`, in ascending order, each
 * inside its own transaction — then advances `user_version` to that
 * migration's version as part of the same transaction.
 *
 * A fresh database (user_version 0, baseline schema just created by the
 * `CREATE TABLE IF NOT EXISTS` block above it) and a pre-existing database
 * take the same path: this function only ever looks at the gap between
 * `user_version` and each migration's declared version.
 *
 * Throws if a migration's `up` throws — the transaction is rolled back
 * first, so the migration's partial DDL never lands and `user_version` is
 * left exactly where it was. A half-migrated database must not boot; the
 * caller (SqliteStorage's constructor) is expected to let this throw
 * propagate.
 *
 * Also throws — before touching the database at all — if `migrations` is
 * not strictly increasing in version (a duplicate or an out-of-order entry).
 * That is a bug in the caller's migration list, not a runtime condition to
 * degrade from.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  for (let i = 1; i < migrations.length; i++) {
    const previous = migrations[i - 1]
    const current = migrations[i]
    if (current.version <= previous.version) {
      throw new Error(
        `Migrations must have strictly increasing versions: version ${current.version} ` +
          `("${current.description}") does not follow version ${previous.version} ` +
          `("${previous.description}").`,
      )
    }
  }

  const currentVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    db.exec("BEGIN")
    try {
      migration.up(db)
      // Not a prepared-statement parameter — PRAGMA doesn't accept bound
      // parameters for its value, so the version is interpolated directly.
      // Safe: it comes from the trusted MIGRATIONS list, validated above to
      // be a well-formed increasing integer, never from external input.
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  }
}

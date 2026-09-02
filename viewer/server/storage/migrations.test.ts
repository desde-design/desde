import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SqliteStorage } from "./sqlite-storage"
import { MIGRATIONS, runMigrations, type Migration } from "./migrations"

/**
 * The version a fresh boot lands on: the last migration in the real list.
 *
 * Derived, not written out. Every assertion here used to say `toBe(5)`, so
 * landing migration 6 failed five tests that had nothing to do with it — a
 * literal that has to be edited for every future migration is a tripwire, not
 * a test. What these actually mean to assert is "a fresh boot reaches the
 * tip".
 */
const SCHEMA_TIP = MIGRATIONS[MIGRATIONS.length - 1].version

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
  return row.user_version
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
    (r) => r.name,
  )
}

describe("runMigrations", () => {
  it("applies a fake migration to a fresh in-memory db and advances user_version", () => {
    const db = new DatabaseSync(":memory:")
    const migrations: Migration[] = [
      {
        version: 1,
        description: "create t1",
        up: (db) => db.exec("CREATE TABLE t1 (x)"),
      },
    ]

    runMigrations(db, migrations)

    expect(tableNames(db)).toContain("t1")
    expect(userVersion(db)).toBe(1)
  })

  it("running twice applies each migration exactly once", () => {
    const db = new DatabaseSync(":memory:")
    // A plain CREATE TABLE (no IF NOT EXISTS) throws on a second run — the
    // guard against double-application, not an accident of the fixture.
    const migrations: Migration[] = [
      {
        version: 1,
        description: "create t1",
        up: (db) => db.exec("CREATE TABLE t1 (x)"),
      },
    ]

    runMigrations(db, migrations)
    expect(() => runMigrations(db, migrations)).not.toThrow()

    expect(tableNames(db)).toContain("t1")
    expect(userVersion(db)).toBe(1)
  })

  it("a db already at user_version 1 only applies version 2 when the list has both", () => {
    const db = new DatabaseSync(":memory:")
    const migrations: Migration[] = [
      {
        version: 1,
        description: "create t1",
        up: (db) => db.exec("CREATE TABLE t1 (x)"),
      },
      {
        version: 2,
        description: "create t2",
        up: (db) => db.exec("CREATE TABLE t2 (y)"),
      },
    ]

    // Pre-advance the db to version 1 without ever creating t1 — proves
    // version 1's `up` is skipped entirely, not merely idempotent.
    db.exec("PRAGMA user_version = 1")

    runMigrations(db, migrations)

    expect(tableNames(db)).not.toContain("t1")
    expect(tableNames(db)).toContain("t2")
    expect(userVersion(db)).toBe(2)
  })

  it("a migration that throws leaves user_version unchanged and rolls back its partial DDL", () => {
    const db = new DatabaseSync(":memory:")
    const migrations: Migration[] = [
      {
        version: 1,
        description: "partially create t1, then blow up",
        up: (db) => {
          db.exec("CREATE TABLE t1 (x)")
          throw new Error("boom")
        },
      },
    ]

    expect(() => runMigrations(db, migrations)).toThrow("boom")

    expect(tableNames(db)).not.toContain("t1")
    expect(userVersion(db)).toBe(0)
  })

  it("throws before applying anything when versions are out of order", () => {
    const db = new DatabaseSync(":memory:")
    const migrations: Migration[] = [
      {
        version: 2,
        description: "second",
        up: (db) => db.exec("CREATE TABLE t2 (y)"),
      },
      {
        version: 1,
        description: "first",
        up: (db) => db.exec("CREATE TABLE t1 (x)"),
      },
    ]

    expect(() => runMigrations(db, migrations)).toThrow()

    expect(tableNames(db)).not.toContain("t1")
    expect(tableNames(db)).not.toContain("t2")
    expect(userVersion(db)).toBe(0)
  })

  it("throws before applying anything when versions are duplicated", () => {
    const db = new DatabaseSync(":memory:")
    const migrations: Migration[] = [
      {
        version: 1,
        description: "first",
        up: (db) => db.exec("CREATE TABLE t1 (x)"),
      },
      {
        version: 1,
        description: "duplicate of first",
        up: (db) => db.exec("CREATE TABLE t1_dup (x)"),
      },
    ]

    expect(() => runMigrations(db, migrations)).toThrow()

    expect(tableNames(db)).not.toContain("t1")
    expect(tableNames(db)).not.toContain("t1_dup")
    expect(userVersion(db)).toBe(0)
  })
})

/**
 * Migration 1, against databases the PREVIOUS code actually produced.
 *
 * The fixtures below hand-roll the pre-migration `users` schema and insert
 * through a raw `DatabaseSync` rather than through `SqliteStorage`, on
 * purpose: a database built by the current adapter would already be in the
 * new shape, so it would prove that the migration tolerates its own output —
 * not that it converts an old deployment's data. This is the same
 * construction `sqlite-storage.test.ts` uses for the pre-3c-1 upgrade case.
 */
describe("migration 1 — users gain a role, a status, and a unique email", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** A database with the users table exactly as it was before migration 1. */
  function legacyDbPath(rows: { id: string; providerUserId: string; email: string; createdAt: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-1-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX users_by_provider ON users (provider, provider_user_id);
      CREATE INDEX users_by_email ON users (email);
    `)
    for (const row of rows) {
      db.prepare(
        `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, created_at)
         VALUES (?, 'github', ?, ?, ?, '', ?)`,
      ).run(row.id, row.providerUserId, row.email, row.id, row.createdAt)
    }
    db.close()
    return dbPath
  }

  it("promotes the OLDEST account to admin, makes everyone else an editor, and preserves identities", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Inserted newest-FIRST, so rowid order disagrees with created_at order.
    // The oldest account by clock must win, not the first row written.
    const dbPath = legacyDbPath([
      { id: "newer", providerUserId: "gh-newer", email: "newer@example.com", createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "oldest", providerUserId: "gh-oldest", email: "oldest@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "newest", providerUserId: "gh-newest", email: "newest@example.com", createdAt: "2026-03-01T00:00:00.000Z" },
    ])

    const store = new SqliteStorage(dbPath)

    const oldest = await store.getUser("oldest")
    expect(oldest?.role).toBe("admin")
    expect(oldest?.status).toBe("active")
    expect(oldest?.provider).toBe("github")
    expect(oldest?.providerUserId).toBe("gh-oldest")
    expect(oldest?.email).toBe("oldest@example.com")
    expect(oldest?.createdAt).toBe("2026-01-01T00:00:00.000Z")

    expect((await store.getUser("newer"))?.role).toBe("editor")
    expect((await store.getUser("newest"))?.role).toBe("editor")
    expect((await store.getUser("newer"))?.status).toBe("active")

    // The identity index survived the rebuild, so lookups still work.
    expect((await store.getUserByProviderIdentity("github", "gh-newer"))?.id).toBe("newer")
    expect(await store.countUsers()).toBe(3)
    expect((await store.listUsers()).map((u) => u.id)).toEqual(["oldest", "newer", "newest"])

    // A silent grant of instance authority is not something to discover
    // later — the promoted address has to be in the log.
    expect(warn.mock.calls.flat().join(" ")).toContain("oldest@example.com")

    await store.close()
  })

  it("lowercases emails on the way across, so the address really is the identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const dbPath = legacyDbPath([
      { id: "mixed", providerUserId: "gh-mixed", email: "Mixed.Case@Example.COM", createdAt: "2026-01-01T00:00:00.000Z" },
    ])

    const store = new SqliteStorage(dbPath)
    expect((await store.getUser("mixed"))?.email).toBe("mixed.case@example.com")
    expect((await store.getUserByEmail("mixed.case@example.com"))?.id).toBe("mixed")
    await store.close()
  })

  it("refuses to boot a database whose users share an email, naming every duplicated address", () => {
    const dbPath = legacyDbPath([
      { id: "a1", providerUserId: "gh-a1", email: "shared-one@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a2", providerUserId: "gh-a2", email: "shared-one@example.com", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "b1", providerUserId: "gh-b1", email: "shared-two@example.com", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "b2", providerUserId: "gh-b2", email: "shared-two@example.com", createdAt: "2026-01-04T00:00:00.000Z" },
      { id: "ok", providerUserId: "gh-ok", email: "fine@example.com", createdAt: "2026-01-05T00:00:00.000Z" },
    ])

    // Refusing to start beats guessing which of two people an invite meant
    // (audit S18's own rule), so this must throw rather than merge or drop.
    let message = ""
    try {
      new SqliteStorage(dbPath)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("shared-one@example.com")
    expect(message).toContain("shared-two@example.com")
    expect(message).not.toContain("fine@example.com")

    // The failed migration rolled back: nothing was half-converted, every
    // account is still there, and the version did not advance — so the
    // operator can remove the stale row and restart.
    const db = new DatabaseSync(dbPath)
    expect(userVersion(db)).toBe(0)
    expect(tableNames(db)).not.toContain("users_new")
    // Five USER ROWS, unrelated to the schema version that happens to share
    // the number. (A blanket `toBe(5)` → `toBe(SCHEMA_TIP)` rewrite caught
    // this line by accident; the two only agreed by coincidence.)
    expect((db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number }).c).toBe(5)
    db.close()
  })

  it("treats addresses differing only in case as the same duplicate", () => {
    const dbPath = legacyDbPath([
      { id: "c1", providerUserId: "gh-c1", email: "Case@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", providerUserId: "gh-c2", email: "case@EXAMPLE.com", createdAt: "2026-01-02T00:00:00.000Z" },
    ])
    // A plain UNIQUE index would have accepted these two rows and left the
    // instance with one address on two accounts.
    expect(() => new SqliteStorage(dbPath)).toThrow(/case@example\.com/i)
  })

  /**
   * The local-operator row must never be what "the oldest account" means.
   *
   * On a zero-config deployment the FIRST row ever written is
   * `operator@localhost` — `ensureLocalOperatorUser` creates it the moment
   * somebody opens the boot-printed URL, before any human has signed in. So
   * on exactly the deployments this migration exists to rescue, an
   * unqualified "oldest account" resolves to a synthetic identity that
   * NOBODY can sign in as once a GitHub App is configured (`/auth/local`
   * switches itself off), and every real person is left an editor. The
   * instance ends up with an admin row that is unreachable, which is the same
   * outcome as having no admin at all.
   *
   * Two promotions, therefore: the oldest HUMAN account, and the operator row
   * itself — the latter because it is admin by definition (see
   * `ensureLocalOperatorUser`), not as a fallback.
   */
  it("skips the local-operator row when picking the oldest account, and keeps the operator admin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dbPath = legacyDbPath([
      {
        id: "operator",
        providerUserId: "local-operator",
        email: "operator@localhost",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "first-human", providerUserId: "gh-1", email: "first@example.com", createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "second-human", providerUserId: "gh-2", email: "second@example.com", createdAt: "2026-03-01T00:00:00.000Z" },
    ])

    const store = new SqliteStorage(dbPath)

    expect((await store.getUser("first-human"))?.role).toBe("admin")
    expect((await store.getUser("operator"))?.role).toBe("admin")
    expect((await store.getUser("second-human"))?.role).toBe("editor")

    // BOTH promotions are logged — an operator reading the boot output has to
    // be able to see every account that just gained instance authority.
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).toContain("first@example.com")
    expect(logged).toContain("operator@localhost")

    await store.close()
  })

  it("a database holding only the local-operator row leaves it admin, and does not crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dbPath = legacyDbPath([
      {
        id: "operator",
        providerUserId: "local-operator",
        email: "operator@localhost",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ])

    const store = new SqliteStorage(dbPath)
    expect((await store.getUser("operator"))?.role).toBe("admin")
    expect(await store.countUsers()).toBe(1)
    expect(warn.mock.calls.flat().join(" ")).toContain("operator@localhost")
    await store.close()
  })

  it("runs once: reopening the database neither re-promotes nor re-converts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dbPath = legacyDbPath([
      { id: "first", providerUserId: "gh-first", email: "first@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "second", providerUserId: "gh-second", email: "second@example.com", createdAt: "2026-01-02T00:00:00.000Z" },
    ])

    const first = new SqliteStorage(dbPath)
    // Demote the backfilled admin, the way an operator would.
    await first.updateUserRole("first", "viewer")
    await first.close()

    warn.mockClear()
    const second = new SqliteStorage(dbPath)
    expect((await second.getUser("first"))?.role).toBe("viewer") // not re-promoted
    expect(warn.mock.calls.flat().join(" ")).not.toContain("first@example.com")
    await second.close()

    const db = new DatabaseSync(dbPath)
    // Not just 1 — a fresh boot applies EVERY migration, so the tip is
    // whatever the list's last version is. Derived rather than written out:
    // this assertion was `toBe(5)` and broke the moment migration 6 landed,
    // which taught nobody anything. What is worth asserting is "a fresh boot
    // reaches the tip", not which integer the tip happens to be today.
    expect(userVersion(db)).toBe(SCHEMA_TIP)
    db.close()
  })

  it("a fresh database ends up at the current migration version with the new columns in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-1-fresh-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")

    const store = new SqliteStorage(dbPath)
    const user = await store.createUser({
      provider: "email",
      providerUserId: null,
      email: "fresh@example.com",
      displayName: "Fresh",
      avatarUrl: "",
      role: "admin",
    })
    expect(user.role).toBe("admin")
    expect(user.providerUserId).toBeNull()
    await store.close()

    const db = new DatabaseSync(dbPath)
    expect(userVersion(db)).toBe(SCHEMA_TIP)
    db.close()
  })

  /**
   * The second boot is its own hazard. `SqliteStorage`'s FROZEN baseline
   * schema re-declares `users_by_provider` as a plain `CREATE UNIQUE INDEX IF
   * NOT EXISTS ... (provider, provider_user_id)` on every single boot, while
   * migration 1 replaced it with a PARTIAL one. If that re-declaration ever
   * took effect, the accounts that legitimately carry no provider identity
   * would start colliding — and only on an existing deployment's next
   * restart, never in a fresh-database test.
   */
  it("survives a restart with identity-less accounts intact, and still accepts new ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-1-reboot-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")

    const first = new SqliteStorage(dbPath)
    await first.createUser({
      provider: "email",
      providerUserId: null,
      email: "invited-one@example.com",
      displayName: "One",
      avatarUrl: "",
      role: "viewer",
    })
    await first.close()

    const second = new SqliteStorage(dbPath)
    expect((await second.getUserByEmail("invited-one@example.com"))?.providerUserId).toBeNull()
    await expect(
      second.createUser({
        provider: "email",
        providerUserId: null,
        email: "invited-two@example.com",
        displayName: "Two",
        avatarUrl: "",
        role: "viewer",
      }),
    ).resolves.toBeTruthy()
    expect(await second.countUsers()).toBe(2)
    await second.close()
  })
})

/**
 * Migration 3, against a database in the exact PRE-migration-3 shape
 * (viewer-membership Task 9): `projects.visibility` (two states) and
 * `project_members.role`.
 *
 * The fixture hand-rolls that shape directly via `DatabaseSync`, the same
 * construction migration 1's tests use, and starts the database at
 * `PRAGMA user_version = 2` so only migration 3 runs — migrations 1 and 2
 * are exercised by their own describe blocks above, and re-running them here
 * would just be testing them twice under a different name.
 */
describe("migration 3 — projects.visibility becomes access; project_members loses role", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A database in the shape migration 2 leaves behind: `projects` with
   * `visibility`, `project_members` with `role`, `user_version` already at
   * 2. One project of each of the three OLD shapes migration 3's mapping
   * cares about, plus a membership row on the "members, with a member" one.
   */
  function legacyDbPath(): { dbPath: string; memberCreatedAt: string } {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-3-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo_url TEXT,
        visibility TEXT NOT NULL,
        active_deployment_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
      -- Migration 2 created this, so a REAL database stamped user_version 2
      -- always has it. The fixture omitted it while nothing after migration 2
      -- referred to it, and migration 4 (Task 14's signin_tokens indexes)
      -- turned that shortcut into a failure: the fixture claimed to be at
      -- version 2 while missing a table version 2 creates. Declared here so
      -- the fixture models the version it says it is, rather than making
      -- migration 4 defensive about a database shape that cannot exist.
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
    `)
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
    ).run("proj-public", "public-proj", "Public Proj", "public-link", "2026-01-01T00:00:00.000Z")
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
    ).run("proj-locked", "locked-proj", "Locked Proj", "members", "2026-01-02T00:00:00.000Z")
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?)`,
    ).run("proj-empty", "empty-proj", "Empty Proj", "members", "2026-01-03T00:00:00.000Z")
    const memberCreatedAt = "2026-01-02T01:00:00.000Z"
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
    ).run("proj-locked", "user-1", "owner", memberCreatedAt)
    db.exec("PRAGMA user_version = 2")
    db.close()
    return { dbPath, memberCreatedAt }
  }

  it("maps 'public-link' to 'public-link', 'members'-with-members to 'invited', and 'members'-with-zero-members to 'all-members'", async () => {
    const { dbPath } = legacyDbPath()
    const store = new SqliteStorage(dbPath)

    expect((await store.getProject("proj-public"))?.access).toBe("public-link")
    expect((await store.getProject("proj-locked"))?.access).toBe("invited")
    expect((await store.getProject("proj-empty"))?.access).toBe("all-members")

    await store.close()
  })

  it("preserves member rows — projectId, userId and createdAt survive, role does not", async () => {
    const { dbPath, memberCreatedAt } = legacyDbPath()
    const store = new SqliteStorage(dbPath)

    const members = await store.listProjectMembers("proj-locked")
    expect(members).toHaveLength(1)
    expect(members[0]).toEqual({
      projectId: "proj-locked",
      userId: "user-1",
      createdAt: memberCreatedAt,
    })
    expect((members[0] as unknown as Record<string, unknown>).role).toBeUndefined()

    // The project with no member rows really has none — the mapping to
    // "all-members" isn't hiding a member the migration failed to carry
    // over.
    expect(await store.listProjectMembers("proj-empty")).toEqual([])

    await store.close()
  })

  it("advances user_version to the schema tip and leaves other project fields untouched", async () => {
    const { dbPath } = legacyDbPath()
    const store = new SqliteStorage(dbPath)

    const project = await store.getProject("proj-locked")
    expect(project?.slug).toBe("locked-proj")
    expect(project?.name).toBe("Locked Proj")
    expect(project?.createdAt).toBe("2026-01-02T00:00:00.000Z")
    await store.close()

    const db = new DatabaseSync(dbPath)
    expect(userVersion(db)).toBe(SCHEMA_TIP)
    db.close()
  })
})

/**
 * I6: a "very old deployment" — a database that predates EVERY migration in
 * this file, at `user_version 0`, with real data sitting in every table
 * migrations 1 and 3 rewrite AND in every sibling table they must leave
 * alone. Booting `SqliteStorage` against it runs all four migrations in one
 * pass, in order, inside the SAME constructor call — which is the shape a
 * real operator's upgrade actually takes (they don't stop the process
 * between versions), and which none of the migration-specific tests above
 * exercise: each of those hand-rolls only the ONE table its own migration
 * touches, starting already at the version immediately before it.
 *
 * The schema below is copied from two places, deliberately not invented:
 * `users`/`projects`/`project_members` match the "frozen baseline" `CREATE
 * TABLE IF NOT EXISTS` block in `sqlite-storage.ts` (frozen precisely
 * because it IS the pre-migration-1/pre-migration-3 shape — see that
 * block's own comment), and `deployments` / `sessions` /
 * `project_repo_configs` / `project_embedded_ids` match the same block's
 * sibling tables, which no migration here ever touches.
 */
describe("a very old deployment: the FULL pre-branch schema, all five migrations in one boot", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function veryOldDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-very-old-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")
    const db = new DatabaseSync(dbPath)

    // --- users: pre-migration-1 shape (no role, no status, provider_user_id NOT NULL) ---
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX users_by_provider ON users (provider, provider_user_id);
      CREATE INDEX users_by_email ON users (email);
    `)
    // Inserted operator-FIRST, exactly as a real zero-config deployment
    // would have written it: `ensureLocalOperatorUser` creates that row the
    // moment anyone opens the boot-printed URL, before any human signs in.
    // If migration 1 ever regressed to treating "oldest row" as "oldest
    // account" again, THIS fixture — not the isolated one above — is the one
    // that looks like production.
    db.prepare(
      `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, created_at)
       VALUES ('operator', 'github', 'local-operator', 'operator@localhost', 'Local operator', '', '2026-01-01T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, created_at)
       VALUES ('first-human', 'github', 'gh-1', 'first@example.com', 'First', '', '2026-01-02T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, created_at)
       VALUES ('second-human', 'github', 'gh-2', 'second@example.com', 'Second', '', '2026-01-03T00:00:00.000Z')`,
    ).run()

    // --- projects: pre-migration-3 shape (visibility, not access) ---
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo_url TEXT,
        visibility TEXT NOT NULL,
        active_deployment_id TEXT,
        created_at TEXT NOT NULL
      );
    `)
    // All three OLD shapes migration 3's mapping cares about.
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES ('proj-public', 'public-proj', 'Public Proj', NULL, 'public-link', NULL, '2026-02-01T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES ('proj-locked', 'locked-proj', 'Locked Proj', NULL, 'members', NULL, '2026-02-02T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
       VALUES ('proj-empty', 'empty-proj', 'Empty Proj', NULL, 'members', NULL, '2026-02-03T00:00:00.000Z')`,
    ).run()

    // --- project_members: pre-migration-3 shape (carries a role) ---
    db.exec(`
      CREATE TABLE project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );
    `)
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, created_at)
       VALUES ('proj-locked', 'first-human', 'owner', '2026-02-02T01:00:00.000Z')`,
    ).run()

    // --- sibling tables migrations 1-4 never touch, matching the CURRENT
    // baseline in sqlite-storage.ts verbatim ---
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT,
        build_log TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE project_repo_configs (
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
      CREATE TABLE project_embedded_ids (
        project_id TEXT PRIMARY KEY,
        embedded_id TEXT NOT NULL UNIQUE
      );
    `)
    db.prepare(
      `INSERT INTO deployments (id, project_id, status, commit_sha, build_log, created_at)
       VALUES ('deploy-1', 'proj-locked', 'success', 'abc123', 'build ok', '2026-02-02T02:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at)
       VALUES ('session-1', 'first-human', '2026-02-02T03:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
    ).run()
    db.prepare(
      `INSERT INTO project_repo_configs
         (project_id, installation_id, owner, name, default_branch, branch, install_command, build_command, output_dir, auto_deploy)
       VALUES ('proj-locked', 42, 'acme', 'proto', 'main', 'main', 'npm ci', 'npm run build', 'dist', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO project_embedded_ids (project_id, embedded_id) VALUES ('proj-locked', 'embedded-xyz')`,
    ).run()

    // Deliberately no `PRAGMA user_version` — defaults to 0, before ANY
    // migration in this file was ever written.
    db.close()
    return dbPath
  }

  it("backfills roles exactly like the isolated migration-1 fixture, in the presence of every other table", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dbPath = veryOldDbPath()
    const store = new SqliteStorage(dbPath)

    expect((await store.getUser("operator"))?.role).toBe("admin")
    expect((await store.getUser("first-human"))?.role).toBe("admin")
    expect((await store.getUser("second-human"))?.role).toBe("editor")
    const logged = warn.mock.calls.flat().join(" ")
    expect(logged).toContain("first@example.com")
    expect(logged).toContain("operator@localhost")

    await store.close()
  })

  it("maps every project's access exactly like the isolated migration-3 fixture", async () => {
    const dbPath = veryOldDbPath()
    const store = new SqliteStorage(dbPath)

    expect((await store.getProject("proj-public"))?.access).toBe("public-link")
    expect((await store.getProject("proj-locked"))?.access).toBe("invited")
    expect((await store.getProject("proj-empty"))?.access).toBe("all-members")

    await store.close()
  })

  it("preserves the member row — projectId, userId, createdAt survive, role does not", async () => {
    const dbPath = veryOldDbPath()
    const store = new SqliteStorage(dbPath)

    const members = await store.listProjectMembers("proj-locked")
    expect(members).toEqual([
      { projectId: "proj-locked", userId: "first-human", createdAt: "2026-02-02T01:00:00.000Z" },
    ])
    expect((members[0] as unknown as Record<string, unknown>).role).toBeUndefined()
    expect(await store.listProjectMembers("proj-empty")).toEqual([])

    await store.close()
  })

  it("leaves every sibling table exactly as it was — deployments, sessions, repo config, embedded id", async () => {
    const dbPath = veryOldDbPath()
    const store = new SqliteStorage(dbPath)

    const deployment = await store.getDeployment("deploy-1")
    expect(deployment).toEqual({
      id: "deploy-1",
      projectId: "proj-locked",
      status: "success",
      commitSha: "abc123",
      buildLog: "build ok",
      // Migration 5 (viewer-membership row 7) added this column to the
      // pre-existing `deployments` table via ALTER TABLE — an old row that
      // predates the migration reads back as `null`, the same "no warnings
      // recorded" state a fresh deployment starts in.
      warnings: null,
      // Migration 6, same shape and the same reason: an ALTER TABLE onto the
      // existing table, so a row from before it reads back as `null` — "this
      // deployment has no build phases to show", which is exactly true of a
      // deployment that ran before phases were recorded.
      steps: null,
      // Migration 7, same shape again: a pre-field row honestly has no
      // commit message to show.
      commitMessage: null,
      createdAt: "2026-02-02T02:00:00.000Z",
    })

    const session = await store.getSession("session-1")
    expect(session).toEqual({
      id: "session-1",
      userId: "first-human",
      createdAt: "2026-02-02T03:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })

    const project = await store.getProject("proj-locked")
    expect(project?.repoConfig).toEqual({
      installationId: 42,
      owner: "acme",
      name: "proto",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: true,
    })
    expect(project?.embeddedId).toBe("embedded-xyz")

    await store.close()
  })

  it("advances all the way to the current migration version in one boot", async () => {
    const dbPath = veryOldDbPath()
    const store = new SqliteStorage(dbPath)
    await store.close()

    const db = new DatabaseSync(dbPath)
    expect(userVersion(db)).toBe(SCHEMA_TIP)
    db.close()
  })
})

/**
 * Migration 5 in isolation: a pre-migration-5 `deployments` table (the
 * frozen baseline shape in sqlite-storage.ts, no `warnings` column) gains a
 * nullable `warnings` column with every existing row reading back `NULL`.
 */
describe("migration 5 — deployments gains a nullable warnings column", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function preMigration5DbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "viewer-migration-5-"))
    dirs.push(dir)
    const dbPath = join(dir, "viewer.db")
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        commit_sha TEXT,
        build_log TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO deployments (id, project_id, status, commit_sha, build_log, created_at)
       VALUES ('deploy-old', 'proj-1', 'deployed', 'abc123', 'ok', '2026-02-01T00:00:00.000Z')`,
    ).run()
    db.exec(`PRAGMA user_version = 4;`)
    db.close()
    return dbPath
  }

  it("adds the column and every pre-existing row reads back warnings: null", async () => {
    const dbPath = preMigration5DbPath()
    const store = new SqliteStorage(dbPath)

    expect(await store.getDeployment("deploy-old")).toEqual({
      id: "deploy-old",
      projectId: "proj-1",
      status: "deployed",
      commitSha: "abc123",
      buildLog: "ok",
      warnings: null,
      // Migration 6's column, on the same pre-existing row: `null` means
      // "no build phases to show", which is true of every deployment that
      // ran before phases were recorded.
      steps: null,
      // Migration 7's column, same reading: no commit message recorded.
      commitMessage: null,
      createdAt: "2026-02-01T00:00:00.000Z",
    })

    await store.close()
  })

  it("round-trips a warnings array through updateDeployment and back", async () => {
    const dbPath = preMigration5DbPath()
    const store = new SqliteStorage(dbPath)

    const warnings = [
      {
        kind: "root-absolute-assets" as const,
        summary: "1 root-absolute asset reference found in 1 file",
        findings: [{ file: "index.html", kind: "html-attr" as const, sample: '<script src="/assets/x.js">' }],
      },
    ]
    const updated = await store.updateDeployment("deploy-old", { warnings })
    expect(updated.warnings).toEqual(warnings)
    expect((await store.getDeployment("deploy-old"))?.warnings).toEqual(warnings)

    // Clearing back to null is a real, distinct state, not merely "absent".
    const cleared = await store.updateDeployment("deploy-old", { warnings: null })
    expect(cleared.warnings).toBeNull()
    expect((await store.getDeployment("deploy-old"))?.warnings).toBeNull()

    await store.close()
  })
})

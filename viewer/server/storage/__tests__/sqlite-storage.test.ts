import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { ConflictError } from "../errors"
import { SqliteStorage } from "../sqlite-storage"
import { storageAdapterContract } from "./storage-adapter-contract"
import { upsertTestUser } from "../../__tests__/user-fixtures"

const dirs: string[] = []

storageAdapterContract("sqlite", {
  makeStore: () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    dirs.push(dir)
    return new SqliteStorage(join(dir, "viewer.db"))
  },
  cleanup: () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  },
})

/**
 * Fix wave M5. `toMachineToken` used to `JSON.parse(row.scopes)` bare. That
 * failed asymmetrically: `verifyMachineToken` wraps its storage calls in a
 * catch-all, so a corrupt row merely 401'd that one token — but
 * `GET /api/v1/tokens` maps every one of the caller's rows through the same
 * converter with no such wrapper, so a single corrupt row 500'd the whole
 * list and locked the user out of the very UI they'd use to revoke it. It
 * now degrades to `[]`, which is also the SAFE direction: `[]` authorizes
 * strictly less than any real scope set.
 */
describe("SqliteStorage — corrupt machine_tokens.scopes degrades instead of throwing", () => {
  async function withStore(fn: (store: SqliteStorage) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const store = new SqliteStorage(join(dir, "viewer.db"))
    try {
      await fn(store)
    } finally {
      await store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async function seedTokenWithRawScopes(store: SqliteStorage, id: string, rawScopes: string) {
    const user = await upsertTestUser(store, {
      provider: "github",
      providerUserId: `u-${id}`,
      email: `${id}@x.com`,
      displayName: id,
      avatarUrl: "",
    })
    await store.createMachineToken({ id, userId: user.id, name: "t", scopes: ["read", "write"], tokenHash: "h" })
    // Reach past the adapter to corrupt the blob the way a bad migration,
    // a hand-edited DB, or a truncated write would.
    ;(store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
      .prepare(`UPDATE machine_tokens SET scopes = ? WHERE id = ?`)
      .run(rawScopes, id)
    return user
  }

  it.each([
    ["unparseable JSON", "{not json"],
    ["valid JSON that isn't an array", '{"read":true}'],
    ["an empty string", ""],
  ])("getMachineToken degrades %s to [] instead of throwing", async (_label, rawScopes) => {
    await withStore(async (store) => {
      await seedTokenWithRawScopes(store, "c000000000000001", rawScopes)
      const token = await store.getMachineToken("c000000000000001")
      expect(token).not.toBeNull()
      expect(token?.scopes).toEqual([])
    })
  })

  it("drops unrecognized scope strings rather than surfacing them as authority", async () => {
    await withStore(async (store) => {
      await seedTokenWithRawScopes(store, "c000000000000002", '["read","admin","write",7,null]')
      const token = await store.getMachineToken("c000000000000002")
      expect(token?.scopes).toEqual(["read", "write"])
    })
  })

  it("listMachineTokensForUser still returns the corrupt row (so it can be revoked) instead of failing the whole list", async () => {
    await withStore(async (store) => {
      const user = await seedTokenWithRawScopes(store, "c000000000000003", "{not json")
      await store.createMachineToken({
        id: "c000000000000004",
        userId: user.id,
        name: "healthy",
        scopes: ["read"],
        tokenHash: "h2",
      })

      const listed = await store.listMachineTokensForUser(user.id)
      expect(listed).toHaveLength(2)
      expect(listed.find((t) => t.id === "c000000000000003")?.scopes).toEqual([])
      expect(listed.find((t) => t.id === "c000000000000004")?.scopes).toEqual(["read"])
    })
  })
})

/**
 * M3. `createUser`'s pre-insert SELECT checks (email, then provider
 * identity) are what make a refusal LEGIBLE — the address or identity named
 * in the message — but they are not atomic with the INSERT that follows,
 * so a genuinely concurrent `createUser` for the same email can still win
 * the race between this call's SELECT and its INSERT. Before this fix that
 * INSERT's raw `SQLITE_CONSTRAINT` propagated uncaught (a 500, not a 409).
 *
 * The race itself can't be produced by two sequential calls in one test —
 * each `createUser` is a single synchronous SELECT-then-INSERT sequence, so
 * a second call's own pre-check would simply see the first call's row and
 * throw the READABLE ConflictError, never reaching the INSERT at all. So
 * this stubs exactly the next "does this email exist" SELECT to report
 * nothing, simulating what a real race produces: the check ran before the
 * conflicting row existed, and the INSERT is what actually collides.
 */
describe("SqliteStorage — createUser race backstop (M3)", () => {
  it("translates a raw UNIQUE-constraint violation on the INSERT into a ConflictError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const store = new SqliteStorage(join(dir, "viewer.db"))

    await store.createUser({
      provider: "github",
      providerUserId: "already-here",
      email: "race@example.com",
      displayName: "Already Here",
      avatarUrl: "",
      role: "editor",
    })

    const raw = (
      store as unknown as {
        db: { prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown } }
      }
    ).db
    const realPrepare = raw.prepare.bind(raw)
    let stubbed = false
    raw.prepare = ((sql: string) => {
      if (!stubbed && sql.includes("SELECT id FROM users WHERE email")) {
        stubbed = true
        return { get: () => undefined }
      }
      return realPrepare(sql)
    }) as typeof raw.prepare

    await expect(
      store.createUser({
        provider: "github",
        providerUserId: "second",
        email: "race@example.com",
        displayName: "Second",
        avatarUrl: "",
        role: "editor",
      }),
    ).rejects.toThrow(ConflictError)

    // Exactly one account exists — the race was refused, not silently
    // admitted as a second row alongside the first.
    expect(await store.countUsers()).toBe(1)

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("SqliteStorage persistence", () => {
  it("reads back data written by a previous instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const dbPath = join(dir, "viewer.db")

    const first = new SqliteStorage(dbPath)
    const project = await first.createProject({ slug: "acme", name: "Acme" })
    await first.close()

    const second = new SqliteStorage(dbPath)
    expect(await second.getProjectBySlug("acme")).toEqual(project)
    await second.close()

    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * Phase 3c-1: `project_repo_configs` is a brand-new table, NOT a new column
 * on `projects` — every table here is `CREATE TABLE IF NOT EXISTS`,
 * re-declared on every boot, with no migration system behind it. A new
 * table is safe against an existing database (the `IF NOT EXISTS` is a
 * no-op if it's somehow already there, a normal create otherwise); a new
 * COLUMN on an existing table would NOT be — `CREATE TABLE IF NOT EXISTS
 * projects (...)` is a no-op against an already-existing `projects` table,
 * so a newly added column would silently never appear on an upgraded
 * deployment while every test against a FRESH database passed regardless.
 *
 * This test proves the safe case by actually exercising it: build a
 * database using a hand-rolled schema matching `projects` as it existed
 * BEFORE this table was added (no `project_repo_configs` at all), seed a
 * row directly via SQL — bypassing SqliteStorage entirely, so this is a
 * database the OLD code would have produced, not one the new code merely
 * tolerates — close it, then open that same file with the CURRENT
 * `SqliteStorage`.
 */
describe("project_repo_configs — safe on a pre-existing (pre-3c-1) database", () => {
  it("opens without throwing, reads the pre-existing project intact, and the new capability works going forward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-upgrade-"))
    const dbPath = join(dir, "viewer.db")

    const legacyDb = new DatabaseSync(dbPath)
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repo_url TEXT,
        visibility TEXT NOT NULL,
        active_deployment_id TEXT,
        created_at TEXT NOT NULL
      );
    `)
    legacyDb
      .prepare(
        `INSERT INTO projects (id, slug, name, repo_url, visibility, active_deployment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-id-1",
        "legacy",
        "Legacy Project",
        null,
        "members",
        null,
        new Date().toISOString(),
      )
    legacyDb.close()

    // Open the SAME file with the current code, which also declares
    // project_repo_configs. Must not throw.
    const store = new SqliteStorage(dbPath)

    const project = await store.getProjectBySlug("legacy")
    expect(project).not.toBeNull()
    expect(project?.id).toBe("legacy-id-1")
    expect(project?.name).toBe("Legacy Project")
    // No project_repo_configs row exists for it yet — must degrade to
    // null, not throw or return a garbage/partial object.
    expect(project?.repoConfig).toBeNull()

    // And the new capability works going forward on this upgraded database.
    const updated = await store.setProjectRepoConfig(project!.id, {
      installationId: 1,
      owner: "acme",
      name: "proto",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: false,
    })
    expect(updated.repoConfig?.owner).toBe("acme")
    expect((await store.getProject("legacy-id-1"))?.repoConfig?.owner).toBe("acme")

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Phase 3c-1b adds `user_installations` / `user_installation_syncs` on the
   * same terms: new TABLES, never new columns on `users`. This proves the
   * upgrade path against a database that already has a `users` table with
   * rows in it — the shape a deployment that ran 3a/3b actually has, and the
   * shape a column-add would have silently failed against.
   */
  it("user installation tables are safe on a database that already has users, and the pre-existing user reads back as 'never recorded'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-upgrade-users-"))
    const dbPath = join(dir, "viewer.db")

    const legacyDb = new DatabaseSync(dbPath)
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    legacyDb
      .prepare(
        `INSERT INTO users (id, provider, provider_user_id, email, display_name, avatar_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-user-1", "github", "gh-legacy", "legacy@example.com", "Legacy", "", new Date().toISOString())
    legacyDb.close()

    const store = new SqliteStorage(dbPath)

    expect((await store.getUser("legacy-user-1"))?.email).toBe("legacy@example.com")
    // A user who signed in before 3c-1b has no captured set — `null`, which
    // the route layer treats as "authorizes nothing, sign in again", NOT as
    // "can see everything".
    expect(await store.getUserInstallations("legacy-user-1")).toBeNull()

    const syncedAt = new Date().toISOString()
    await store.setUserInstallations(
      "legacy-user-1",
      [{ installationId: 7, repoFullNames: ["acme/repo"] }],
      syncedAt,
    )
    expect(await store.getUserInstallations("legacy-user-1")).toEqual({
      installations: [{ installationId: 7, repoFullNames: ["acme/repo"] }],
      syncedAt,
    })

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("project_repo_configs — deleteProject cascade (whitebox)", () => {
  it("removes the underlying row, not just the project's visibility of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const store = new SqliteStorage(join(dir, "viewer.db"))

    const project = await store.createProject({ slug: "acme", name: "Acme" })
    await store.setProjectRepoConfig(project.id, {
      installationId: 1,
      owner: "acme",
      name: "proto",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: false,
    })

    await store.deleteProject(project.id)

    const row = (
      store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): unknown } } }
    ).db
      .prepare(`SELECT * FROM project_repo_configs WHERE project_id = ?`)
      .get(project.id)
    expect(row).toBeUndefined()

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * M4. `deleteProject` is nine DELETEs across eight tables, now wrapped in
   * one transaction (`BEGIN IMMEDIATE` … `COMMIT`, same pattern
   * `setUserInstallations` uses) so a failure partway through cannot leave
   * the project half-gone — e.g. its `comments` and `deployments` deleted
   * but the `projects` row itself (and everything after it in the cascade)
   * still present, which would silently orphan rows nothing could clean up
   * afterward because the project they belong to no longer resolves.
   *
   * Forces a failure on the LAST delete in the cascade (`project_embedded_ids`)
   * and asserts every EARLIER delete was rolled back too — the property a
   * transaction guarantees and nine independent statements do not.
   */
  it("rolls back the WHOLE cascade if one delete in it fails (M4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const store = new SqliteStorage(join(dir, "viewer.db"))

    const project = await store.createProject({ slug: "atomic", name: "Atomic" })
    const deployment = await store.createDeployment({ projectId: project.id })
    await store.setProjectEmbeddedId(project.id, "embedded-atomic")

    const raw = (
      store as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } }
      }
    ).db
    const realPrepare = raw.prepare.bind(raw)
    raw.prepare = ((sql: string) => {
      if (sql.includes("DELETE FROM project_embedded_ids")) {
        return {
          run: () => {
            throw new Error("simulated failure mid-cascade")
          },
        }
      }
      return realPrepare(sql)
    }) as typeof raw.prepare

    await expect(store.deleteProject(project.id)).rejects.toThrow("simulated failure mid-cascade")

    // Restore the real prepare so the assertions below read through it.
    raw.prepare = realPrepare

    // Every row the cascade would have removed is STILL there — including
    // the ones deleted BEFORE the forced failure, proving the rollback
    // undid them too, not just the statement that threw.
    expect(await store.getProject(project.id)).not.toBeNull()
    expect(await store.getDeployment(deployment.id)).not.toBeNull()

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * Audit K10. The database holds every session row, every machine-token hash
 * and the whole comment record; before this it was created with the process
 * umask (MEASURED: dir 0755, db/-wal/-shm all 0644), so on a shared machine
 * any local account could read all of it. The Editor already gets this
 * right for its credential files — see
 * `editor-cli/src/server/session-info.ts`.
 *
 * POSIX-only: Windows does not model these bits, so the assertions are
 * skipped there rather than asserted loosely.
 */
describe.skipIf(process.platform === "win32")("SqliteStorage — on-disk permissions", () => {
  const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8).padStart(4, "0")

  it("creates the data dir 0700 and the database + WAL siblings 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const dataDir = join(dir, "data")
    const dbPath = join(dataDir, "viewer.db")
    const store = new SqliteStorage(dbPath)
    // A write, so the WAL siblings definitely exist.
    await store.createProject({ slug: "acme", name: "Acme" })

    expect(mode(dataDir)).toBe("0700")
    // -wal and -shm are created by SQLite itself with the process umask;
    // they leak the same rows as the main file and need the same mode.
    for (const file of readdirSync(dataDir)) {
      expect([file, mode(join(dataDir, file))]).toEqual([file, "0600"])
    }

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("tightens a data dir that already existed world-readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-sqlite-"))
    const dataDir = join(dir, "data")
    // mkdirSync's `mode` only applies on CREATION — an upgrade or a mounted
    // volume hands us a directory we did not make.
    mkdirSync(dataDir, { recursive: true, mode: 0o755 })
    chmodSync(dataDir, 0o755)

    const store = new SqliteStorage(join(dataDir, "viewer.db"))
    expect(mode(dataDir)).toBe("0700")

    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

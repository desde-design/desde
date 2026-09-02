import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import request from "supertest"
import { beforeEach, describe, expect, it } from "vitest"
import { createBuildQueue } from "../../build/build-queue"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { DiskAssetStore } from "../../assets/disk-asset-store"
import type { AssetStore, StoredAsset } from "../../assets/types"
import type { ViewerConfig } from "../../config"
import { sessionCookieName, signSessionId } from "../../auth/session-cookie"
import { isSecurePublicUrl } from "../state-cookie"
import { generateMachineToken } from "../../auth/machine-token"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"
import type { InstanceRole, StorageAdapter } from "../../storage/types"

class NullAssetStore implements AssetStore {
  async put(): Promise<void> {}
  async get(): Promise<StoredAsset | null> {
    return null
  }
  async deleteDeployment(): Promise<void> {}
}

/**
 * Wraps a real StorageAdapter but makes `deleteProject` throw — simulates a
 * DB lock/IO failure inside that call's own transaction. Same technique
 * `gate.test.ts`'s `withMethod` and `deployments-routes.test.ts`'s
 * `makeStorageThatFailsMarkingFailedOnce` use.
 */
function makeStorageThatFailsDeletingProject(inner: StorageAdapter): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "deleteProject") {
        return async () => {
          throw new Error("simulated storage failure deleting project")
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Wraps a real StorageAdapter but makes `addProjectMember` throw — simulates
 * a DB failure hitting exactly the write the creator-lockout guard depends
 * on (fix wave 9, item 1). Same technique `makeStorageThatFailsDeletingProject`
 * above uses.
 */
function makeStorageThatFailsAddingProjectMember(inner: StorageAdapter): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "addProjectMember") {
        return async () => {
          throw new Error("simulated storage failure adding a project member")
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Wraps a real StorageAdapter but makes `updateProject` throw — simulates a
 * DB failure hitting the SECOND half of the create-then-flip sequence (fix
 * wave 9, item 1): `addProjectMember` already succeeded, and it is the
 * `access: "invited"` flip itself that fails. Same technique
 * `makeStorageThatFailsDeletingProject` above uses.
 */
function makeStorageThatFailsUpdatingProject(inner: StorageAdapter): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "updateProject") {
        return async () => {
          throw new Error("simulated storage failure updating a project")
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

const config: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  dataDir: ".tmp",
  publicUrl: "https://viewer.example.com",
  adminToken: "test-token",
  serveDomain: null,
  devBundler: "turbopack",
  email: null,
  emailSource: null,
  unsubscribeSecret: null,
  sessionSecret: "test-session-secret",
  githubAuth: null,
  githubApp: null,
  prototypeCsp: null,
  prototypeOrigin: null,
  allowedEmailDomains: null,
  seedDemoProject: true,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
}

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 *
 * `setup()` runs in `beforeEach` and again inside several tests, and nine more
 * tests build an app inline: 25 listening servers per run. One of the two
 * failures in the pre-fix 100-run baseline landed in THIS file.
 *
 * Safe to share: every test uses either the `beforeEach` ctx or exactly one
 * locally-built app, never both. The access-enforcement describe's tests
 * shadow the name `app` but none of them reaches back to `ctx.app`.
 */
const stable = createSwappableApp()

function setup(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    storage: new InMemoryStorage(),
    assets: new NullAssetStore(),
    config,
    bridgeScript: "// bridge",
    github: testGithubRuntime(),
    ...overrides,
  }
  stable.use(createApp(deps))
  return { deps, app: stable.app }
}

const auth = { Authorization: "Bearer test-token" }

const authConfig: ViewerConfig = {
  ...config,
  sessionSecret: "sesh-secret",
  githubAuth: { clientId: "id", clientSecret: "secret" },
}

/** Seeds a user + live session in `storage`, returns a `Cookie` header value for it. */
async function signInAs(storage: InMemoryStorage, email: string, role: InstanceRole = "editor") {
  const user = await upsertTestUser(storage, {
    provider: "github",
    providerUserId: email,
    email,
    displayName: email,
    avatarUrl: "",
    role,
  })
  const session = await storage.createSession({
    userId: user.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const signed = signSessionId(authConfig.sessionSecret, session.id)
  // https config → the live session cookie name carries the __Host- prefix.
  const name = sessionCookieName(isSecurePublicUrl(authConfig.publicUrl))
  return { user, cookie: `${name}=${signed}` }
}

describe("projects API", () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it("reports health without auth", async () => {
    const res = await request(ctx.app).get("/api/v1/health").expect(200)
    expect(res.body).toEqual({ status: "ok", profile: "selfhost" })
  })

  it("creates a project", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "Acme" })
      .expect(201)

    expect(res.body.slug).toBe("acme")
    expect(res.body.access).toBe("all-members")
    expect(res.body.activeDeploymentId).toBeNull()
    expect(res.body.id).toBeTruthy()
  })

  // viewer-membership row 7: `activeDeployment` carries the deploy-time
  // root-absolute asset scan's result, so a reader learns about it from the
  // same project fetch that already tells them what's live — no separate
  // request. Unlike `commitSha`/`buildLog`, `warnings` is safe to include
  // for any reader (see `ActiveDeploymentView.warnings`'s doc comment): it
  // describes asset references already present in what this deployment
  // serves, not anything from a private repo's build log.
  it("GET /projects/:id surfaces the active deployment's warnings", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "Acme" })
      .expect(201)
    const warnings = [
      {
        kind: "root-absolute-assets" as const,
        summary: "1 root-absolute asset reference found in 1 file",
        findings: [{ file: "index.html", kind: "html-attr" as const, sample: '<script src="/a.js">' }],
      },
    ]
    const deployment = await ctx.deps.storage.createDeployment({ projectId: created.body.id, status: "deployed" })
    await ctx.deps.storage.updateDeployment(deployment.id, { warnings })
    await ctx.deps.storage.updateProject(created.body.id, { activeDeploymentId: deployment.id })

    const res = await request(ctx.app).get(`/api/v1/projects/${created.body.id}`).set(auth).expect(200)
    expect(res.body.activeDeployment.warnings).toEqual(warnings)

    const list = await request(ctx.app).get("/api/v1/projects").set(auth).expect(200)
    expect(list.body.projects[0].activeDeployment.warnings).toEqual(warnings)
  })

  // Authorization v2: `POST /projects` routes to `requireInstanceEditor`,
  // which treats "no credential presented" as nothing to REJECT — 401 is
  // reserved for a credential that was presented and did not resolve. So an
  // anonymous create is 403, not 401. (A garbage bearer below is still 401.)
  it("rejects an anonymous write with 403 — no credential to reject, just no authority", async () => {
    await request(ctx.app)
      .post("/api/v1/projects")
      .send({ slug: "acme", name: "Acme" })
      .expect(403)
  })

  it("rejects a write with the wrong token", async () => {
    await request(ctx.app)
      .post("/api/v1/projects")
      .set({ Authorization: "Bearer nope" })
      .send({ slug: "acme", name: "Acme" })
      .expect(401)
  })

  // Phase 3b-2 Task 4: `requireWrite` replaced `requireAdmin`. Writes are no
  // longer categorically "disabled" just because `VIEWER_ADMIN_TOKEN` is
  // unset — a write-scoped machine token can still authorize a write (see
  // the "write-gate relaxation" describe block below) — so an unauthenticated
  // caller now gets the generic 401 every other missing-credential case
  // gets, not a config-specific message.
  it("refuses an unauthenticated write even when no admin token is configured", async () => {
    const open = setup({ config: { ...config, adminToken: null } })
    const res = await request(open.app)
      .post("/api/v1/projects")
      .send({ slug: "acme", name: "Acme" })
      .expect(403)
    expect(res.body.error).toBe("This action requires the editor role")
  })

  it("validates the slug format", async () => {
    for (const slug of ["A", "x", "has space", "-leading", "way$bad"]) {
      const res = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug, name: "n" })
        .expect(400)
      expect(res.body.error).toMatch(/slug/i)
    }
  })

  it("requires a name", async () => {
    await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme" })
      .expect(400)
  })

  /**
   * A duplicate slug used to 409, and the dialog told the caller to invent a
   * variation. Since 2026-08-29 the server suffixes instead (Mo: "can we not
   * be smart and append some digits... just happens transparently in the
   * background"), so the create succeeds at the next free slug.
   */
  it("suffixes a duplicate slug instead of refusing it", async () => {
    await request(ctx.app).post("/api/v1/projects").set(auth).send({ slug: "acme", name: "A" }).expect(201)

    const second = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "B" })
      .expect(201)
    expect(second.body.slug).toBe("acme-2")

    const third = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "C" })
      .expect(201)
    expect(third.body.slug).toBe("acme-3")

    // The originals are untouched — suffixing must never rewrite an existing
    // project's URL out from under the people holding links to it.
    const list = await request(ctx.app).get("/api/v1/projects").set(auth).expect(200)
    expect(list.body.projects.map((p: { slug: string }) => p.slug).sort()).toEqual([
      "acme",
      "acme-2",
      "acme-3",
    ])
  })

  // The route itself requires no credential — it FILTERS. Under
  // Authorization v2 the only thing an anonymous caller can see is a
  // `public-link` project, so this seeds one of each and asserts both halves:
  // 200 with no auth, and exactly the readable project in the payload.
  it("lists projects without auth, filtered to what an anonymous caller may read", async () => {
    await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "A", access: "public-link" })
      .expect(201)
    await request(ctx.app).post("/api/v1/projects").set(auth).send({ slug: "hidden", name: "H" }).expect(201)
    const res = await request(ctx.app).get("/api/v1/projects").expect(200)
    expect(res.body.projects.map((p: { slug: string }) => p.slug)).toEqual(["acme"])
  })

  it("gets one project and 404s an unknown id", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "A", access: "public-link" })
      .expect(201)

    const res = await request(ctx.app).get(`/api/v1/projects/${created.body.id}`).expect(200)
    expect(res.body.slug).toBe("acme")

    await request(ctx.app).get("/api/v1/projects/unknown").expect(404)
  })

  it("updates a project name", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/projects")
      .set(auth)
      .send({ slug: "acme", name: "A" })
      .expect(201)

    const res = await request(ctx.app)
      .patch(`/api/v1/projects/${created.body.id}`)
      .set(auth)
      .send({ name: "Renamed" })
      .expect(200)

    expect(res.body.name).toBe("Renamed")
    expect(res.body.slug).toBe("acme")
  })

  /**
   * Security audit S2. `GET /projects` and `GET /projects/:id` used to
   * answer `{ ...project, effectivelyPublic }` — a whole-entity spread — so
   * every reader, including an anonymous holder of a review link and anyone
   * at all on a zero-member legacy project, received `repoConfig` (GitHub
   * App `installationId`, private repo owner/name, built branch, and the raw
   * install/build command line, which is the only place an operator can put
   * a private-registry credential today) plus the `embeddedId` capability.
   */
  describe("project field scoping — repo config is owner-only (security audit S2)", () => {
    const secretRepoConfig = {
      installationId: 987654,
      owner: "acme-inc",
      name: "secret-prototype",
      defaultBranch: "main",
      branch: "release/q4-pricing",
      installCommand: "npm ci --registry=https://npm.internal.acme.com",
      buildCommand: "npm run build:prod",
      outputDir: "dist",
      autoDeploy: true,
    }

    async function seedConnectedPublicProject(storage: InMemoryStorage) {
      const project = await storage.createProject({
        slug: "acme",
        name: "Acme",
        repoUrl: "https://github.com/acme-inc/secret-prototype",
        access: "public-link",
      })
      await storage.setProjectRepoConfig(project.id, secretRepoConfig)
      await storage.setProjectEmbeddedId(project.id, "emb-capability-token")
      return project
    }

    /** The EXACT keys an outsider may see on a project entity. Adding a field must fail here. */
    const PUBLIC_KEYS = [
      // Status + a start time for the deployment currently served. Public on
      // purpose: both are already implied by what any reader can observe at
      // `/p/{slug}/`. `commitSha` and `buildLog` are deliberately NOT here —
      // the log can carry install/build output, the same class of secret
      // `repoConfig` is owner-gated for.
      "access",
      "activeDeployment",
      "activeDeploymentId",
      "createdAt",
      "id",
      "name",
      "slug",
    ]

    /**
     * `GET /projects/:id` gains one more top-level key than `PUBLIC_KEYS`
     * (Task 11): `publicLinksEnabled`, the instance-wide kill-switch state.
     * It is NOT part of `PUBLIC_KEYS` itself because that constant also
     * describes a project ENTRY inside `GET /projects`' `projects` array,
     * which does not repeat this instance-wide fact per project — see the
     * "list is projected the same way" test below.
     */
    // `canComment` is a fact about the CALLER, not about the project or other
    // people, so it is safe for every reader including an anonymous one. It is
    // in this list rather than the private half for that reason.
    const BY_ID_KEYS = [...PUBLIC_KEYS, "publicLinksEnabled", "canComment"].sort()

    it("GET /projects/:id — anonymous caller gets exactly the public key set", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage })
      const project = await seedConnectedPublicProject(storage)

      const res = await request(app).get(`/api/v1/projects/${project.id}`).expect(200)
      expect(Object.keys(res.body).sort()).toEqual(BY_ID_KEYS)
      const wire = JSON.stringify(res.body)
      expect(wire).not.toContain("secret-prototype")
      expect(wire).not.toContain("987654")
      expect(wire).not.toContain("npm.internal.acme.com")
      expect(wire).not.toContain("emb-capability-token")
    })

    it("GET /projects — the list is projected the same way, minus the instance-wide publicLinksEnabled key", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage })
      await seedConnectedPublicProject(storage)

      const res = await request(app).get("/api/v1/projects").expect(200)
      expect(res.body.projects).toHaveLength(1)
      expect(Object.keys(res.body.projects[0]).sort()).toEqual(PUBLIC_KEYS)
      expect(JSON.stringify(res.body)).not.toContain("npm.internal.acme.com")
    })

    it("a project member still gets repoConfig, repoUrl and embeddedId", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage, config: authConfig })
      const project = await seedConnectedPublicProject(storage)
      const { user, cookie } = await signInAs(storage, "member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })

      const res = await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(200)
      expect(Object.keys(res.body).sort()).toEqual(
        [...BY_ID_KEYS, "embeddedId", "repoConfig", "repoUrl"].sort(),
      )
      expect(res.body.repoConfig).toEqual(secretRepoConfig)
      expect(res.body.embeddedId).toBe("emb-capability-token")
    })

    // Authorization v2 MOVED this boundary. The private half used to be a
    // MEMBERSHIP concern (an access-list row on the project); it is now a
    // MANAGE concern (the caller's instance role), because everything in it —
    // the installation id, the raw build command line, the `embeddedId`
    // capability — is what a manager needs and a reader does not. So the two
    // halves of the boundary are a `viewer` and an `editor`, both signed in,
    // neither holding a membership row.
    it("a signed-in VIEWER does NOT get it — the private half is a manage concern", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage, config: authConfig })
      const project = await seedConnectedPublicProject(storage)
      const { cookie } = await signInAs(storage, "reader@x.com", "viewer")

      const res = await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(200)
      expect(Object.keys(res.body).sort()).toEqual(BY_ID_KEYS)
    })

    it("a signed-in EDITOR DOES get it, with no membership row at all", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage, config: authConfig })
      const project = await seedConnectedPublicProject(storage)
      const { cookie } = await signInAs(storage, "ed@x.com", "editor")

      const res = await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(200)
      expect(res.body.repoConfig).toEqual(secretRepoConfig)
    })

    it("the admin bearer still gets it", async () => {
      const storage = new InMemoryStorage()
      const { app } = setup({ storage })
      const project = await seedConnectedPublicProject(storage)

      const res = await request(app).get(`/api/v1/projects/${project.id}`).set(auth).expect(200)
      expect(res.body.repoConfig).toEqual(secretRepoConfig)
    })
  })

  describe("access enforcement", () => {
    // Authorization v2 INVERTED this. `all-members` means every admitted
    // member of the instance, not everybody — the zero-members world-readable
    // rule is gone, and the anonymous refusal is the byte-identical 404.
    it("GET /projects/:id: default 'all-members' access is NOT readable anonymously, but IS by any signed-in caller", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme" }) // defaults to "all-members"
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const denied = await request(app).get(`/api/v1/projects/${project.id}`).expect(404)
      const missing = await request(app).get(`/api/v1/projects/unknown-id`).expect(404)
      expect(denied.body).toEqual(missing.body)

      const { cookie } = await signInAs(storage, "someone@x.com", "viewer")
      const res = await request(app).get(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(200)
      expect(res.body.slug).toBe("acme")
    })

    it("GET /projects/:id: denies an outsider on an 'invited' project — same 404 shape as an unknown id", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const denied = await request(app).get(`/api/v1/projects/${project.id}`).expect(404)
      const missing = await request(app).get(`/api/v1/projects/unknown-id`).expect(404)
      expect(denied.status).toBe(missing.status)
      expect(denied.body).toEqual(missing.body)
    })

    it("GET /projects/:id: a signed-in member CAN read an 'invited' project they belong to", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const { user, cookie } = await signInAs(storage, "member@x.com")
      await storage.addProjectMember({ projectId: project.id, userId: user.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const res = await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .expect(200)
      expect(res.body.slug).toBe("acme")
    })

    it("GET /projects/:id: an anonymous visitor can always read a 'public-link' project, even one with members", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const res = await request(app).get(`/api/v1/projects/${project.id}`).expect(200)
      expect(res.body.slug).toBe("acme")
    })

    it("GET /projects/:id: the admin bearer reaches an 'invited' project the caller doesn't belong to", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: project.id, userId: owner.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const res = await request(app).get(`/api/v1/projects/${project.id}`).set(auth).expect(200)
      expect(res.body.slug).toBe("acme")
    })

    it("GET /projects: FILTERS an unreadable 'invited' project out of the list rather than 404ing", async () => {
      const storage = new InMemoryStorage()
      // `public-link`, not the default: this test's caller is anonymous, and
      // under Authorization v2 that is the only access value they can read.
      await storage.createProject({ slug: "open", name: "Open", access: "public-link" })
      const locked = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      const owner = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "owner",
        email: "owner@x.com",
        displayName: "Owner",
        avatarUrl: "",
      })
      await storage.addProjectMember({ projectId: locked.id, userId: owner.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const res = await request(app).get("/api/v1/projects").expect(200)
      const slugs = res.body.projects.map((p: { slug: string }) => p.slug)
      expect(slugs).toContain("open")
      expect(slugs).not.toContain("locked")
    })

    it("GET /projects: includes an 'invited' project for a signed-in member, and always includes 'public-link'", async () => {
      const storage = new InMemoryStorage()
      const locked = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
      await storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
      const { user, cookie } = await signInAs(storage, "member@x.com")
      await storage.addProjectMember({ projectId: locked.id, userId: user.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const res = await request(app).get("/api/v1/projects").set("Cookie", cookie).expect(200)
      const slugs = res.body.projects.map((p: { slug: string }) => p.slug)
      expect(slugs).toContain("locked")
      expect(slugs).toContain("pub")
    })
  })

  // Task 11: `POST /projects` no longer adds an owner-member row for every
  // signed-in creator. It only adds the creator when the project would
  // otherwise be unreadable to them — i.e. `access: "invited"` — and only
  // when they don't already hold admin authority (an admin can always read
  // any project, so there is no lockout to prevent).
  describe("creator-lockout guard (Task 11)", () => {
    it("does NOT add the creator when access defaults to 'all-members'", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "creator@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme" })
        .expect(201)

      expect(await storage.listProjectMembers(created.body.id)).toHaveLength(0)
      expect(await storage.getProjectMember(created.body.id, user.id)).toBeNull()
    })

    it("adds a non-admin creator to the access list when creating with access: 'invited'", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "creator@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      const member = await storage.getProjectMember(created.body.id, user.id)
      expect(member).not.toBeNull()
      expect(member?.userId).toBe(user.id)
    })

    it("does NOT add an admin-ROLE creator on access: 'invited' — they can always read", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "boss@x.com", "admin")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      expect(await storage.getProjectMember(created.body.id, user.id)).toBeNull()
    })

    it("leaves the project memberless when created with access: 'invited' via the admin token alone (no session)", async () => {
      const storage = new InMemoryStorage()
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      expect(await storage.listProjectMembers(created.body.id)).toHaveLength(0)
    })

    // M2 review fix — REVERSED from what this test used to assert.
    //
    // The old rule skipped whenever `hasAdminAuthority(ctx)` was true, which
    // folds in `ctx.isAdmin`, i.e. the shared `adminToken` BEARER. So an
    // editor who sent the operator token alongside their own cookie (the
    // Editor CLI's machine path; a curl snippet an operator pastes to a
    // colleague) created an `"invited"` project and was NOT added to it. The
    // bearer is a per-REQUEST capability — it evaporates the moment they open
    // the dashboard in a browser, and the project they just made is a 404 to
    // them. The guard is about what the caller can read TOMORROW, so it now
    // keys on `ctx.user.role`, their account's lasting role.
    it("an admin-bearer request with a non-admin session attached IS auto-added on access: 'invited' — the bearer is not their lasting authority", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "creator@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set(auth)
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      expect(await storage.getProjectMember(created.body.id, user.id)).not.toBeNull()
    })

    // The point of the row, proven end to end rather than by inspecting
    // storage: drop the bearer, come back with the cookie alone — the way a
    // browser reload arrives — and the project is still readable. Without the
    // fix above this request is a 404 on the project the same user just made.
    it("the auto-added editor can still read their 'invited' project on a cookie-ONLY follow-up request", async () => {
      const storage = new InMemoryStorage()
      const { cookie } = await signInAs(storage, "creator@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set(auth)
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      // No `auth` header this time.
      const read = await request(app)
        .get(`/api/v1/projects/${created.body.id}`)
        .set("Cookie", cookie)
        .expect(200)
      expect(read.body.slug).toBe("acme")

      // And it is genuinely still locked — a signed-in stranger cannot read it.
      const { cookie: strangerCookie } = await signInAs(storage, "stranger@x.com", "viewer")
      await request(app)
        .get(`/api/v1/projects/${created.body.id}`)
        .set("Cookie", strangerCookie)
        .expect(404)
    })

    // Unchanged, and now the ONLY reason the adminToken-alone request is a
    // no-op: there is no `ctx.user` to add, not that the bearer confers
    // authority. (Asserted above at "leaves the project memberless … via the
    // admin token alone".)
    it("an admin-ROLE session riding along with the admin bearer is still NOT auto-added", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "boss@x.com", "admin")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set(auth)
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      expect(await storage.getProjectMember(created.body.id, user.id)).toBeNull()
    })

    it("adds a write-scoped PAT holder's user when creating with access: 'invited'", async () => {
      const storage = new InMemoryStorage()
      const { user } = await signInAs(storage, "ed@x.com", "editor")
      const gen = generateMachineToken()
      await storage.createMachineToken({
        id: gen.id,
        userId: user.id,
        name: "t",
        scopes: ["read", "write"],
        tokenHash: gen.tokenHash,
        expiresAt: null,
      })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      const created = await request(app)
        .post("/api/v1/projects")
        .set({ Authorization: `Bearer ${gen.token}` })
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(201)

      expect(await storage.getProjectMember(created.body.id, user.id)).not.toBeNull()
    })

    it("PATCH transitioning access to 'invited' adds the non-admin caller if they aren't already a member", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "ed@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app
      // Default all-members: the editor can manage it without being listed.
      const project = await storage.createProject({ slug: "acme", name: "Acme" })

      await request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .send({ access: "invited" })
        .expect(200)

      expect(await storage.getProjectMember(project.id, user.id)).not.toBeNull()
    })

    it("PATCH transitioning to 'invited' by the admin ROLE does NOT auto-add them", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "boss@x.com", "admin")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app
      const project = await storage.createProject({ slug: "acme", name: "Acme" })

      await request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .send({ access: "invited" })
        .expect(200)

      expect(await storage.getProjectMember(project.id, user.id)).toBeNull()
    })

    it("re-PATCHing an already-invited project with access: 'invited' is idempotent, not an error", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "ed@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      await storage.addProjectMember({ projectId: project.id, userId: user.id })

      await request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .send({ access: "invited" })
        .expect(200)

      expect(await storage.listProjectMembers(project.id)).toHaveLength(1)
    })

    it("PATCH that doesn't touch access at all does not add anyone", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "ed@x.com", "editor")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app
      const project = await storage.createProject({ slug: "acme", name: "Acme" })

      await request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .send({ name: "Renamed" })
        .expect(200)

      expect(await storage.getProjectMember(project.id, user.id)).toBeNull()
    })

    // Fix wave 9, item 1. The OLD order committed the access change first
    // and added the membership row second: an `addProjectMember` failure
    // there left a real, already-committed `"invited"` project with its own
    // creator not on the list — a 500 that doubled as a lockout, since the
    // editor's very next request for the project they just PATCHed 404s.
    // The row now goes in FIRST, so a failure here instead leaves `access`
    // untouched and the 500 names a real failure rather than manufacturing
    // one.
    it("PATCH: an addProjectMember failure 500s and leaves access UNCHANGED", async () => {
      const inner = new InMemoryStorage()
      const { cookie } = await signInAs(inner, "ed@x.com", "editor")
      const project = await inner.createProject({ slug: "acme", name: "Acme" })

      const storage = makeStorageThatFailsAddingProjectMember(inner)
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app)
        .patch(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .send({ access: "invited" })
        .expect(500)

      // `updateProject` was never reached — access is exactly what it was
      // before the PATCH, not flipped to a value the caller can't read.
      const stored = await inner.getProject(project.id)
      expect(stored?.access).toBe("all-members")

      // Still readable by the editor who just PATCHed it — the failure did
      // not strand them outside their own project.
      await request(app)
        .get(`/api/v1/projects/${project.id}`)
        .set("Cookie", cookie)
        .expect(200)
    })

    // Fix wave 11, item 2 (was: "leaves the project on its default access").
    // The post-create steps run after the row exists, so an
    // `addProjectMember` failure used to strand a provisional `all-members`
    // project behind a 500 — readable by every instance member (the exact
    // contents the caller wanted restricted) and squatting the slug. The
    // route now rolls that provisional row back, so the 500 means nothing
    // persisted and the slug is free for a retry.
    it("POST: an addProjectMember failure 500s and rolls the provisional project back", async () => {
      const inner = new InMemoryStorage()
      const { cookie } = await signInAs(inner, "creator@x.com", "editor")
      const storage = makeStorageThatFailsAddingProjectMember(inner)
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme", name: "Acme", access: "invited" })
        .expect(500)

      expect(await inner.listProjects()).toHaveLength(0)
      expect(await inner.getProjectBySlug("acme")).toBeNull()
    })

    /**
     * Fix wave 11, item 2 (was fix wave 10, item 4: "the creator is still
     * listed"). The OTHER half of the create-then-flip sequence:
     * `addCreatorBeforeLockout` already succeeded — the creator row IS in —
     * and it is the `updateProject(..., { access: "invited" })` flip itself
     * that fails. This too left a provisional `all-members` project behind
     * (with the creator on it). It is now rolled back for the same reason:
     * an `invited` project stranded at `all-members` leaks its contents to
     * every member. `deleteProject` cascades to the membership row, so
     * nothing dangles.
     */
    it("POST: an updateProject failure flipping to 'invited' 500s and rolls the provisional project back", async () => {
      const inner = new InMemoryStorage()
      const { cookie } = await signInAs(inner, "creator2@x.com", "editor")
      const storage = makeStorageThatFailsUpdatingProject(inner)
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme2", name: "Acme2", access: "invited" })
        .expect(500)

      // No project remains — and `deleteProject` cascades the creator
      // membership row with it, so nothing dangles.
      expect(await inner.listProjects()).toHaveLength(0)
      expect(await inner.getProjectBySlug("acme2")).toBeNull()
    })

    // The rollback is best-effort: if the cleanup `deleteProject` ALSO
    // fails, the route must still surface the ORIGINAL 500 (not the
    // delete's error), and the stranded row is the pre-fix state — no worse
    // than before item 2.
    it("POST: a rollback whose deleteProject also fails still 500s (best-effort cleanup)", async () => {
      const inner = new InMemoryStorage()
      const { cookie } = await signInAs(inner, "creator3@x.com", "editor")
      const storage = makeStorageThatFailsUpdatingProject(makeStorageThatFailsDeletingProject(inner))
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app)
        .post("/api/v1/projects")
        .set("Cookie", cookie)
        .send({ slug: "acme3", name: "Acme3", access: "invited" })
        .expect(500)

      // The cleanup could not run, so the provisional row survives — but it
      // is still the pre-fix behaviour, not a regression.
      const stranded = await inner.getProjectBySlug("acme3")
      expect(stranded?.access).toBe("all-members")
    })
  })

  describe("public-link kill switch on create/patch (Task 11)", () => {
    it("POST /projects with access: 'public-link' 409s when the kill switch is off", async () => {
      await ctx.deps.storage.setInstanceSetting("allowPublicLinks", "false")
      const res = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A", access: "public-link" })
        .expect(409)
      expect(res.body).toEqual({ error: "Public links are disabled on this viewer" })
    })

    it("POST /projects with access: 'public-link' succeeds when the switch is on (default)", async () => {
      await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A", access: "public-link" })
        .expect(201)
    })

    it("PATCH access: 'public-link' 409s when the kill switch is off", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A" })
        .expect(201)
      await ctx.deps.storage.setInstanceSetting("allowPublicLinks", "false")

      const res = await request(ctx.app)
        .patch(`/api/v1/projects/${created.body.id}`)
        .set(auth)
        .send({ access: "public-link" })
        .expect(409)
      expect(res.body).toEqual({ error: "Public links are disabled on this viewer" })
    })

    it("PATCH access: 'public-link' succeeds when the switch is on", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A" })
        .expect(201)

      const res = await request(ctx.app)
        .patch(`/api/v1/projects/${created.body.id}`)
        .set(auth)
        .send({ access: "public-link" })
        .expect(200)
      expect(res.body.access).toBe("public-link")
    })
  })

  describe("publicLinksEnabled (Task 11)", () => {
    /**
     * Flips the kill switch through the REAL admin route, not by poking
     * `storage.setInstanceSetting` directly (M2 review fix).
     *
     * The setting's reader is cached now — it runs once per prototype ASSET
     * via `loadProjectReadPolicy`, so an uncached read put a database
     * round-trip in front of every image and chunk a prototype loads — and
     * `PATCH /instance/settings` is what invalidates that cache. A test that
     * writes straight to storage after a read has already warmed the cache is
     * asserting against a value the product would never be in, and both of
     * these tests were doing exactly that. Going through the route makes them
     * cover the invalidation wiring as well as the field.
     */
    async function setPublicLinks(enabled: boolean): Promise<void> {
      await request(ctx.app)
        .patch("/api/v1/instance/settings")
        .set(auth)
        .send({ allowPublicLinks: enabled })
        .expect(200)
    }

    it("GET /projects/:id reports the kill-switch state, true by default and false after it's turned off", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A" })
        .expect(201)

      const on = await request(ctx.app).get(`/api/v1/projects/${created.body.id}`).set(auth).expect(200)
      expect(on.body.publicLinksEnabled).toBe(true)

      await setPublicLinks(false)
      const off = await request(ctx.app).get(`/api/v1/projects/${created.body.id}`).set(auth).expect(200)
      expect(off.body.publicLinksEnabled).toBe(false)
    })

    it("GET /projects reports it at the top level only, not per-project", async () => {
      await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A", access: "public-link" })
        .expect(201)

      const on = await request(ctx.app).get("/api/v1/projects").expect(200)
      expect(on.body.publicLinksEnabled).toBe(true)
      expect(on.body.projects[0]).not.toHaveProperty("publicLinksEnabled")

      await setPublicLinks(false)
      const off = await request(ctx.app).get("/api/v1/projects").expect(200)
      expect(off.body.publicLinksEnabled).toBe(false)
    })
  })

  describe("DELETE /projects/:id (Task 11)", () => {
    it("an editor with manage authority deletes a project — 204, then the project 404s", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme", name: "A" })
        .expect(201)

      await request(ctx.app).delete(`/api/v1/projects/${created.body.id}`).set(auth).expect(204)
      await request(ctx.app).get(`/api/v1/projects/${created.body.id}`).set(auth).expect(404)
    })

    it("cascades: project members are gone too", async () => {
      const storage = new InMemoryStorage()
      const { user, cookie } = await signInAs(storage, "ed@x.com", "editor")
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
      await storage.addProjectMember({ projectId: project.id, userId: user.id })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app).delete(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(204)
      expect(await storage.listProjectMembers(project.id)).toHaveLength(0)
    })

    // Review fix (Important): `storage.deleteProject` only ever cleans DB
    // rows — it has no reach into `deps.assets`, which stores each
    // deployment's built files in a directory keyed by DEPLOYMENT id.
    // Nothing else reclaims those directories on a project delete (the only
    // other caller of `deleteDeployment` is `pruneSupersededDeploymentAssets`,
    // which fires on a NEW deployment activating, never on a delete), so
    // without the route doing it itself every deployment directory a
    // deleted project ever had is orphaned on disk forever. Uses a REAL
    // `DiskAssetStore` against a tmp dir — the same fixture pattern
    // `disk-asset-store.test.ts` uses — because the `NullAssetStore` used by
    // every other test in this file is a no-op and could not catch this.
    it("cascades: deployment asset directories on disk are reclaimed, not just the DB rows", async () => {
      const storage = new InMemoryStorage()
      const assetsDir = mkdtempSync(join(tmpdir(), "viewer-assets-delete-"))
      const assets = new DiskAssetStore(assetsDir)
      try {
        const project = await storage.createProject({ slug: "acme", name: "Acme" })
        // `status: "deployed"` explicitly — the fix-wave-7 building-in-flight
        // guard would otherwise refuse this delete, and that is not what
        // this test is checking.
        const dep1 = await storage.createDeployment({ projectId: project.id, status: "deployed" })
        const dep2 = await storage.createDeployment({ projectId: project.id, status: "deployed" })
        await assets.put(dep1.id, "index.html", Buffer.from("<html>1</html>"))
        await assets.put(dep2.id, "index.html", Buffer.from("<html>2</html>"))
        expect(await assets.get(dep1.id, "index.html")).not.toBeNull()
        expect(await assets.get(dep2.id, "index.html")).not.toBeNull()

        stable.use(createApp({ storage, assets, config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
        const app = stable.app

        await request(app).delete(`/api/v1/projects/${project.id}`).set(auth).expect(204)

        expect(await assets.get(dep1.id, "index.html")).toBeNull()
        expect(await assets.get(dep2.id, "index.html")).toBeNull()
        expect(await storage.listDeployments(project.id)).toHaveLength(0)
      } finally {
        rmSync(assetsDir, { recursive: true, force: true })
      }
    })

    // Wave 2, codex round 2: the route used to reclaim the deployment ASSET
    // directories on disk BEFORE calling `storage.deleteProject`. If that DB
    // call then threw (a lock, an IO error), the project row survived with
    // its built files already gone — a project the operator could still see
    // and open, but that would 404 on every asset. The fix is DB first, then
    // best-effort asset cleanup: a DB failure now leaves both the row AND
    // its files exactly as they were.
    it("deletes the DB row before touching assets — a storage failure leaves the asset directories intact and 500s", async () => {
      const inner = new InMemoryStorage()
      const assetsDir = mkdtempSync(join(tmpdir(), "viewer-assets-delete-fail-"))
      const assets = new DiskAssetStore(assetsDir)
      try {
        const project = await inner.createProject({ slug: "acme", name: "Acme" })
        // `status: "deployed"` — same reason as the cascade test above: a
        // `"building"` deployment would trip the fix-wave-7 guard before this
        // test ever reaches the DB-failure path it exists to check.
        const dep1 = await inner.createDeployment({ projectId: project.id, status: "deployed" })
        await assets.put(dep1.id, "index.html", Buffer.from("<html>1</html>"))
        expect(await assets.get(dep1.id, "index.html")).not.toBeNull()

        const storage = makeStorageThatFailsDeletingProject(inner)
        stable.use(createApp({ storage, assets, config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
        const app = stable.app

        await request(app).delete(`/api/v1/projects/${project.id}`).set(auth).expect(500)

        // The project row survives — `deleteProject` threw before anything committed.
        expect(await inner.getProject(project.id)).not.toBeNull()
        // And critically, its asset directory was never touched: the route
        // no longer deletes assets before the DB call has actually succeeded.
        expect(await assets.get(dep1.id, "index.html")).not.toBeNull()
      } finally {
        rmSync(assetsDir, { recursive: true, force: true })
      }
    })

    // Fix wave 7, item 2: a delete used to run straight through a build in
    // progress — the DB cascade and the asset cleanup below both fire
    // unconditionally, so a build finishing its own asset write AFTER the
    // delete had already reclaimed the directory would leave orphaned files
    // pointing at a project that no longer exists. Refusing while any
    // deployment is still `"building"` closes that.
    it("refuses to delete while a deployment is still building — 409, nothing deleted", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme-building", name: "A" })
        .expect(201)
      const building = await ctx.deps.storage.createDeployment({ projectId: created.body.id })

      const res = await request(ctx.app)
        .delete(`/api/v1/projects/${created.body.id}`)
        .set(auth)
        .expect(409)
      expect(res.body).toEqual({
        error: "A build is in progress. Wait for it to finish, then delete the project.",
      })

      expect(await ctx.deps.storage.getProject(created.body.id)).not.toBeNull()
      expect(await ctx.deps.storage.getDeployment(building.id)).not.toBeNull()
    })

    /**
     * Fix wave 10, item 2 — `project-locks.ts`. Before this, a delete and a
     * build start racing on the SAME project could both observe the project
     * as still existing and both proceed: the delete cascades the project's
     * DB rows away while the build queue is mid-`createDeployment`,
     * stranding a deployment (and the asset directory its build eventually
     * writes) under a project id nothing can look up any more.
     * `withProjectLock` makes the two brief "does the project exist, then
     * commit one write" starts serialize.
     *
     * A plain `Promise.all` of both requests would only PROBABLY exercise
     * that race — `InMemoryStorage` has no real I/O gap, so without
     * something forcing an interleaving, one request routinely finishes
     * before the other's handler even starts, which would let a regression
     * slip through undetected. The two tests below instead PIN the order
     * deterministically: a storage method reachable only from inside the
     * lock section under test is made to pause until released, and — while
     * paused — the OTHER request is fired and asserted to still be pending.
     * That is the actual claim this fix makes: the second contender's
     * critical section does not even START until the first one's is done.
     */
    describe("a delete and a build-start racing on one project (deterministic)", () => {
      function buildingRepoConfig() {
        return {
          installationId: 1,
          owner: "acme",
          name: "widget",
          defaultBranch: "main",
          branch: "main",
          installCommand: "npm ci",
          buildCommand: "npm run build",
          outputDir: "dist",
          autoDeploy: false,
        }
      }

      /**
       * Wraps a real StorageAdapter so calling `method` pauses until `gate`
       * resolves, calling `onReached()` the instant the call is entered —
       * before awaiting the gate. That is what lets a test observe "the
       * code under test is now inside its critical section" without
       * guessing at timing.
       */
      function makeStorageThatPausesOn<K extends keyof StorageAdapter>(
        inner: StorageAdapter,
        method: K,
        gate: Promise<void>,
        onReached: () => void,
      ): StorageAdapter {
        return new Proxy(inner, {
          get(target, prop, receiver) {
            if (prop === method) {
              return async (...args: unknown[]) => {
                onReached()
                await gate
                return (
                  Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown
                ).apply(target, args)
              }
            }
            return Reflect.get(target, prop, receiver)
          },
        })
      }

      /** True once `res` has settled — polled after a task-queue flush, never awaited directly (that would just wait for it). */
      async function isSettled(res: Promise<unknown>): Promise<boolean> {
        const sentinel = Symbol("pending")
        const winner = await Promise.race([res, Promise.resolve(sentinel)])
        return winner !== sentinel
      }

      /**
       * A `supertest`/`superagent` `Test` is LAZY — it does not open the
       * socket or reach the route handler until something calls `.then()`
       * on it (MEASURED: constructing one and waiting 50ms without touching
       * it, the handler never ran). `.then()` is what actually sends it, so
       * this fires the request immediately and hands back a plain promise
       * to await or race against later — the two tests below depend on the
       * request having genuinely started before they check whether it is
       * still pending.
       */
      function fire<T>(test: PromiseLike<T>): Promise<T> {
        return Promise.resolve(test)
      }

      /**
       * Polls `predicate` until it is true. A single microtask/macrotask
       * flush is not enough here — an actual supertest request round-trips
       * a real socket (connect, write, the server's own parsing and auth
       * checks) before the route handler's own code starts running, which
       * takes more than one `setImmediate`.
       */
      async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
        const start = Date.now()
        while (!predicate()) {
          if (Date.now() - start > timeoutMs) {
            throw new Error("waitUntil: timed out waiting for the condition")
          }
          await new Promise((r) => setTimeout(r, 5))
        }
      }

      it("build wins the lock first: delete queues behind it and then 409s on the row it committed", async () => {
        const inner = new InMemoryStorage()
        const project = await inner.createProject({ slug: "race-build-wins", name: "Race" })
        await inner.setProjectRepoConfig(project.id, buildingRepoConfig())

        let releaseGate: () => void = () => {}
        const gate = new Promise<void>((r) => (releaseGate = r))
        let buildReachedLock = false
        // `createDeployment` runs ONLY inside the build queue's lock section
        // (`build-queue.ts`), never from the delete route — an exclusive
        // hook into "build is now holding the lock".
        const storage = makeStorageThatPausesOn(inner, "createDeployment", gate, () => {
          buildReachedLock = true
        })

        const buildQueue = createBuildQueue({
          storage,
          assets: new NullAssetStore(),
          // Never resolves on its own — `queue.start()` resolves as soon as
          // the lock section is done, well before `run()` is ever awaited.
          runner: { run: () => new Promise<never>(() => {}) },
        })
        stable.use(
          createApp({
            storage,
            assets: new NullAssetStore(),
            config,
            bridgeScript: "// bridge",
            github: testGithubRuntime({ storage, overrides: { buildQueue } }),
          }),
        )
        const app = stable.app

        const buildReq = fire(
          request(app).post(`/api/v1/projects/${project.id}/deployments/build`).set(auth),
        )
        await waitUntil(() => buildReachedLock)

        // Fired WHILE build is paused holding the lock. It must queue behind
        // build's section rather than run concurrently with it.
        const deleteReq = fire(request(app).delete(`/api/v1/projects/${project.id}`).set(auth))
        // Give the delete request every chance to reach (and finish) its own
        // handler if it were NOT queued behind the lock.
        await new Promise((r) => setTimeout(r, 100))
        expect(await isSettled(deleteReq)).toBe(false)

        releaseGate()
        const [buildRes, deleteRes] = await Promise.all([buildReq, deleteReq])

        expect(buildRes.status).toBe(202)
        expect(deleteRes.status).toBe(409)
        expect(deleteRes.body).toEqual({
          error: "A build is in progress. Wait for it to finish, then delete the project.",
        })
        expect(await inner.getProject(project.id)).not.toBeNull()
        expect((await inner.listDeployments(project.id)).some((d) => d.status === "building")).toBe(
          true,
        )
      })

      it("delete wins the lock first: the build queues behind it and then fails because the project is gone", async () => {
        const inner = new InMemoryStorage()
        const project = await inner.createProject({ slug: "race-delete-wins", name: "Race" })
        await inner.setProjectRepoConfig(project.id, buildingRepoConfig())

        let releaseGate: () => void = () => {}
        const gate = new Promise<void>((r) => (releaseGate = r))
        let deleteReachedLock = false
        // `listDeployments` is the FIRST storage call inside the delete
        // route's lock section, and the delete route is its only caller in
        // this whole race — an exclusive hook into "delete is now holding
        // the lock".
        const storage = makeStorageThatPausesOn(inner, "listDeployments", gate, () => {
          deleteReachedLock = true
        })

        const buildQueue = createBuildQueue({
          storage,
          assets: new NullAssetStore(),
          runner: { run: () => new Promise<never>(() => {}) },
        })
        stable.use(
          createApp({
            storage,
            assets: new NullAssetStore(),
            config,
            bridgeScript: "// bridge",
            github: testGithubRuntime({ storage, overrides: { buildQueue } }),
          }),
        )
        const app = stable.app

        const deleteReq = fire(request(app).delete(`/api/v1/projects/${project.id}`).set(auth))
        await waitUntil(() => deleteReachedLock)

        // Fired WHILE delete is paused holding the lock, and while the
        // project is (from the build route's own up-front `requireProjectManage`
        // check) still readable — exactly the window this fix has to close.
        const buildReq = fire(
          request(app).post(`/api/v1/projects/${project.id}/deployments/build`).set(auth),
        )
        // Give the build request every chance to reach (and finish) its own
        // handler if it were NOT queued behind the lock.
        await new Promise((r) => setTimeout(r, 100))
        expect(await isSettled(buildReq)).toBe(false)

        releaseGate()
        const [deleteRes, buildRes] = await Promise.all([deleteReq, buildReq])

        expect(deleteRes.status).toBe(204)
        expect(await inner.getProject(project.id)).toBeNull()
        // The build's own lock section only ran once the project was
        // already gone, so it never created a deployment row for it.
        expect(await inner.listDeployments(project.id)).toEqual([])
        // Refused rather than started — `requireProjectManage` already found
        // the project before the delete committed, so the refusal comes from
        // inside the lock (queue.start()'s own "Project not found"), which
        // build-routes.ts's catch-all turns into a generic 500, never a 202.
        expect(buildRes.status).toBe(500)
      })
    })

    // Fix wave 9, item 2. A stale `"building"` row (left behind by a crash
    // that skipped the graceful-shutdown path) used to trip the guard above
    // FOREVER — nothing ever moved it out of `"building"` again, so the
    // project became permanently undeletable. `markInterruptedBuildsFailed`
    // is what a real boot calls to reconcile it; this proves the guard
    // actually clears once it has.
    it("a stale 'building' row no longer blocks delete after markInterruptedBuildsFailed reconciles it", async () => {
      const created = await request(ctx.app)
        .post("/api/v1/projects")
        .set(auth)
        .send({ slug: "acme-stale-building", name: "A" })
        .expect(201)
      const stale = await ctx.deps.storage.createDeployment({ projectId: created.body.id })

      // Still blocked before reconciliation — same guard as above.
      await request(ctx.app).delete(`/api/v1/projects/${created.body.id}`).set(auth).expect(409)

      expect(await ctx.deps.storage.markInterruptedBuildsFailed()).toBe(1)
      expect((await ctx.deps.storage.getDeployment(stale.id))?.status).toBe("failed")

      await request(ctx.app).delete(`/api/v1/projects/${created.body.id}`).set(auth).expect(204)
      expect(await ctx.deps.storage.getProject(created.body.id)).toBeNull()
    })

    it.each(["deployed", "failed"] as const)(
      "allows deleting once the in-flight build has finished (status: %s)",
      async (status) => {
        const created = await request(ctx.app)
          .post("/api/v1/projects")
          .set(auth)
          .send({ slug: `acme-${status}`, name: "A" })
          .expect(201)
        const deployment = await ctx.deps.storage.createDeployment({ projectId: created.body.id })
        await ctx.deps.storage.updateDeployment(deployment.id, { status })

        await request(ctx.app).delete(`/api/v1/projects/${created.body.id}`).set(auth).expect(204)
        expect(await ctx.deps.storage.getProject(created.body.id)).toBeNull()
      },
    )

    it("404s an unknown project", async () => {
      await request(ctx.app).delete("/api/v1/projects/unknown").set(auth).expect(404)
    })

    it("a signed-in VIEWER is refused with 403", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme" })
      const { cookie } = await signInAs(storage, "reader@x.com", "viewer")
      stable.use(createApp({ storage, assets: new NullAssetStore(), config: authConfig, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app).delete(`/api/v1/projects/${project.id}`).set("Cookie", cookie).expect(403)
    })

    it("an anonymous caller on a readable (public-link) project is refused with 403, not silently allowed", async () => {
      const storage = new InMemoryStorage()
      const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
      stable.use(createApp({ storage, assets: new NullAssetStore(), config, bridgeScript: "// bridge", github: testGithubRuntime() }))
      const app = stable.app

      await request(app).delete(`/api/v1/projects/${project.id}`).expect(403)
    })
  })
})

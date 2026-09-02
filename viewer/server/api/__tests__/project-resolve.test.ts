import { describe, expect, it } from "vitest"
import {
  decideResolution,
  parseRepoRemote,
  type ResolveLookups,
  type ResolveProjectView,
} from "../project-resolve"
import type { Project, ProjectRepoConfig } from "../../storage/types"

/**
 * What an `adopt` decision may put on the wire — id, slug, name and nothing
 * else. Written out here rather than derived from the fixture so a future
 * widening of the projection has to be asserted deliberately, not inherited.
 */
function view(p: Project): ResolveProjectView {
  return { id: p.id, slug: p.slug, name: p.name }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    slug: "acme",
    name: "Acme",
    repoUrl: null,
    access: "all-members",
    activeDeploymentId: null,
    repoConfig: null,
    embeddedId: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  }
}

function repoConfig(owner: string, name: string): ProjectRepoConfig {
  return {
    installationId: 1,
    owner,
    name,
    defaultBranch: "main",
    branch: "main",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDir: "dist",
    autoDeploy: true,
  }
}

const none: ResolveLookups = { byEmbeddedId: null, byRepo: null }

describe("parseRepoRemote", () => {
  it("handles the three forms a real checkout produces", () => {
    expect(parseRepoRemote("https://github.com/acme/proto.git")).toEqual({
      owner: "acme",
      name: "proto",
    })
    expect(parseRepoRemote("git@github.com:acme/proto.git")).toEqual({
      owner: "acme",
      name: "proto",
    })
    expect(parseRepoRemote("ssh://git@github.com/acme/proto")).toEqual({
      owner: "acme",
      name: "proto",
    })
  })

  it("tolerates a trailing slash and a missing .git", () => {
    expect(parseRepoRemote("https://github.com/acme/proto/")).toEqual({
      owner: "acme",
      name: "proto",
    })
  })

  it("returns null for anything unrecognisable rather than throwing", () => {
    // An exotic remote must degrade to "no match", never to an error — a
    // project with an unusual remote is still a valid project.
    expect(parseRepoRemote("")).toBeNull()
    expect(parseRepoRemote("   ")).toBeNull()
    expect(parseRepoRemote("not-a-url")).toBeNull()
  })
})

describe("decideResolution — the collision matrix", () => {
  it("mints when neither the id nor the repo is known", () => {
    const d = decideResolution({ name: "AI Gateway" }, none)
    expect(d).toEqual({ decision: "mint", suggestedSlug: "ai-gateway" })
  })

  it("mints with a fallback slug when no name is supplied", () => {
    expect(decideResolution({}, none)).toEqual({
      decision: "mint",
      suggestedSlug: "project",
    })
  })

  it("adopts on an embedded-id hit — the id is the join key", () => {
    const existing = project({ id: "p9", embeddedId: "emb-1" })
    const d = decideResolution(
      { embeddedId: "emb-1" },
      { byEmbeddedId: existing, byRepo: null },
    )
    expect(d).toEqual({ decision: "adopt", project: view(existing) })
  })

  it("C3: adopts the repo's project when it has no embedded id yet", () => {
    // The viewer connected this repo first. This is "created in the Editor,
    // then connected in the Viewer" working as intended.
    const existing = project({ id: "p9", embeddedId: null })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "https://github.com/acme/proto.git" },
      { byEmbeddedId: null, byRepo: existing },
    )
    expect(d).toEqual({ decision: "adopt", project: view(existing) })
  })

  it("C1/C4: conflicts when the repo already carries a DIFFERENT embedded id", () => {
    const existing = project({ id: "p9", name: "Acme", embeddedId: "emb-OTHER" })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "https://github.com/acme/proto.git" },
      { byEmbeddedId: null, byRepo: existing },
    )
    // INVERTED deliberately (security audit S1): the conflict branch used
    // to carry the whole `conflictWith` project entity AND name the existing
    // project in `reason`. This route is unauthenticated, so both were
    // disclosure to anyone who could guess an `owner/name` pair. The caller's
    // only useful next step is "mint a new id", which needs neither.
    expect(d.decision).toBe("conflict")
    expect(d).not.toHaveProperty("conflictWith")
    expect(Object.keys(d).sort()).toEqual(["decision", "reason"])
    expect("reason" in d && d.reason).not.toMatch(/Acme/)
  })

  it("C5: conflicts when the same id arrives from a different repo (fork)", () => {
    const existing = project({
      id: "p9",
      embeddedId: "emb-1",
      repoConfig: repoConfig("acme", "proto"),
    })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "https://github.com/someone/fork.git" },
      { byEmbeddedId: existing, byRepo: null },
    )
    expect(d.decision).toBe("conflict")
    // Same inversion as C1/C4: no entity, and the claiming repo's
    // `owner/name` is no longer named in the prose.
    expect(Object.keys(d).sort()).toEqual(["decision", "reason"])
    expect("reason" in d && d.reason).toMatch(/fork/i)
    expect("reason" in d && d.reason).not.toMatch(/acme|proto/i)
  })

  it("C5 does not fire when the id arrives from the SAME repo, case aside", () => {
    // GitHub is case-insensitive; treating a case difference as a fork would
    // reject a legitimate re-open of the very same checkout.
    const existing = project({
      id: "p9",
      embeddedId: "emb-1",
      repoConfig: repoConfig("Acme", "Proto"),
    })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "https://github.com/acme/proto.git" },
      { byEmbeddedId: existing, byRepo: null },
    )
    expect(d).toEqual({ decision: "adopt", project: view(existing) })
  })

  it("adopts rather than conflicting when the incoming remote is unparseable", () => {
    // We cannot prove a fork from a remote we can't read, and an unprovable
    // conflict must not block the user.
    const existing = project({
      id: "p9",
      embeddedId: "emb-1",
      repoConfig: repoConfig("acme", "proto"),
    })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "not-a-url" },
      { byEmbeddedId: existing, byRepo: null },
    )
    expect(d).toEqual({ decision: "adopt", project: view(existing) })
  })

  it("adopts when the claiming project has no repo connected at all", () => {
    const existing = project({ id: "p9", embeddedId: "emb-1", repoConfig: null })
    const d = decideResolution(
      { embeddedId: "emb-1", remoteUrl: "https://github.com/acme/proto.git" },
      { byEmbeddedId: existing, byRepo: null },
    )
    expect(d).toEqual({ decision: "adopt", project: view(existing) })
  })

  it("prefers the embedded-id hit over a repo hit when both exist", () => {
    // The id is the join key; the repo is only a discovery index.
    const byId = project({ id: "by-id", embeddedId: "emb-1" })
    const byRepo = project({ id: "by-repo", embeddedId: "emb-1" })
    const d = decideResolution(
      { embeddedId: "emb-1" },
      { byEmbeddedId: byId, byRepo },
    )
    expect(d).toEqual({ decision: "adopt", project: view(byId) })
  })
})

// ---------------------------------------------------------------------------
// Route level
// ---------------------------------------------------------------------------

import express from "express"
import request from "supertest"
import { beforeEach } from "vitest"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import { createApp } from "../../__tests__/test-app"
import { loadConfig } from "../../config"
import type { AssetStore } from "../../assets/types"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"

/**
 * ONE stable app object for this whole file — see `__tests__/swappable-app.ts`.
 * 6 listening servers per run before this; only one app exists here.
 */
const stable = createSwappableApp()

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

describe("POST /api/v1/projects/resolve", () => {
  let storage: InMemoryStorage
  let app: express.Express

  beforeEach(() => {
    storage = new InMemoryStorage()
    stable.use(
      createApp({
        storage,
        assets: nullAssets,
        config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
        bridgeScript: "// bridge",
        github: testGithubRuntime(),
      }),
    )
    app = stable.app
  })

  it("answers WITHOUT an admin token — the Editor must be able to avoid a duplicate while signed out", async () => {
    const res = await request(app)
      .post("/api/v1/projects/resolve")
      .send({ embeddedId: "emb-1", name: "AI Gateway" })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ decision: "mint", suggestedSlug: "ai-gateway" })
  })

  /**
   * INVERTED DELIBERATELY (security audit S1).
   *
   * This test used to assert `res.body.project.id` and stop there, which
   * meant it passed while the handler shipped the ENTIRE private Project
   * entity to an unauthenticated caller — `repoConfig` with the GitHub App
   * `installationId`, the private repo owner/name, the built branch and the
   * raw install/build command line, plus `embeddedId`, `visibility` and
   * `createdAt`. A `members` project answers a byte-identical 404 to that
   * same caller on every other route, so this one route broke the whole
   * no-existence-oracle invariant.
   *
   * It now asserts the EXACT key set at both levels, which is the only
   * assertion shape that can fail when a field is ADDED. "Does not contain
   * repoConfig" would have gone on passing the day someone adds
   * `buildSecrets`.
   */
  it("adopts with ONLY {id, slug, name} — never the storage entity", async () => {
    const project = await storage.createProject({ slug: "acme", name: "Acme" })
    await storage.setProjectEmbeddedId(project.id, "emb-1")
    await storage.setProjectRepoConfig(project.id, {
      installationId: 987654,
      owner: "acme-inc",
      name: "secret-prototype",
      defaultBranch: "main",
      branch: "release/q4-pricing",
      installCommand: "npm ci --registry=https://npm.internal.acme.com",
      buildCommand: "npm run build:prod",
      outputDir: "dist",
      autoDeploy: true,
    })

    const res = await request(app)
      .post("/api/v1/projects/resolve")
      .send({ embeddedId: "emb-1" })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(["decision", "project"])
    expect(res.body.decision).toBe("adopt")
    expect(Object.keys(res.body.project).sort()).toEqual(["id", "name", "slug"])
    expect(res.body.project).toEqual({ id: project.id, slug: "acme", name: "Acme" })
    // Belt and braces: nothing anywhere in the serialized body names the
    // private repo or the install command, however it got there.
    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain("secret-prototype")
    expect(wire).not.toContain("987654")
    expect(wire).not.toContain("npm.internal.acme.com")
  })

  it("conflicts with ONLY {decision, reason}, naming no project", async () => {
    const project = await storage.createProject({ slug: "acme", name: "Acme" })
    await storage.setProjectEmbeddedId(project.id, "emb-other")
    await storage.setProjectRepoConfig(project.id, {
      installationId: 1,
      owner: "acme-inc",
      name: "secret-prototype",
      defaultBranch: "main",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: true,
    })

    const res = await request(app)
      .post("/api/v1/projects/resolve")
      .send({ embeddedId: "emb-mine", remoteUrl: "https://github.com/acme-inc/secret-prototype.git" })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(["decision", "reason"])
    expect(res.body.decision).toBe("conflict")
    expect(JSON.stringify(res.body)).not.toContain("Acme")
  })

  it("400s when neither an embeddedId nor a remoteUrl is supplied", async () => {
    const res = await request(app).post("/api/v1/projects/resolve").send({ name: "x" })
    expect(res.status).toBe(400)
  })

  it("treats an unparseable remote as 'no match' rather than an error", async () => {
    const res = await request(app)
      .post("/api/v1/projects/resolve")
      .send({ remoteUrl: "not-a-url", name: "Proto" })
    expect(res.status).toBe(200)
    expect(res.body.decision).toBe("mint")
  })

  it("is not shadowed by the POST /projects create route", async () => {
    // `/projects/resolve` and `/projects` are both POST; a route-ordering
    // mistake would send this to create (which requires a write token) and
    // surface as a 401/400 rather than a decision.
    const res = await request(app)
      .post("/api/v1/projects/resolve")
      .send({ embeddedId: "emb-x" })
    expect(res.body).toHaveProperty("decision")
  })
})

import type { Request } from "express"
import { describe, expect, it } from "vitest"
import type { ViewerConfig } from "../config"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type {
  InstanceRole,
  Project,
  ProjectAccess,
  ProjectMember,
  StorageAdapter,
  User,
} from "../storage/types"
import {
  ADMIN_ROLE_REQUIRED,
  canReadProject,
  EDITOR_ROLE_REQUIRED,
  hasAdminAuthority,
  hasProjectManageAuthority,
  isAdminRequest,
  lacksWriteScope,
  loadProjectReadPolicy,
  makeProjectMembership,
  manageRefusal,
  requireInstanceAdmin,
  requireInstanceEditor,
  requireProjectManage,
  requireProjectManageRead,
  requireProjectRead,
  requireProjectWrite,
  resolveReadContext,
  resolveReadContextLenient,
  WRITE_SCOPE_REQUIRED,
  type ProjectMembership,
  type ProjectReadPolicy,
} from "./authorize"
import { generateMachineToken } from "./machine-token"
import { signSessionId } from "./session-cookie"
import { upsertTestUser } from "../__tests__/user-fixtures"
import { invalidateInstanceSettingsCache } from "../instance-settings"

const baseConfig: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  dataDir: ".tmp",
  publicUrl: "http://localhost:3100",
  adminToken: null,
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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    slug: "acme",
    name: "Acme",
    repoUrl: null,
    access: "all-members",
    activeDeploymentId: null,
    repoConfig: null,
    embeddedId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeUser(id: string, role: InstanceRole = "editor"): User {
  return {
    id,
    provider: "github",
    providerUserId: id,
    email: `${id}@example.com`,
    displayName: id,
    avatarUrl: "",
    role,
    status: "active",
    createdAt: new Date().toISOString(),
  }
}

/**
 * A `ProjectMembership` backed by an in-memory list.
 *
 * ONE method, because the interface has one: `hasAnyMember` was deleted with
 * the zero-members world-readable migration rule it existed to feed.
 * Membership answers exactly one question now — "is THIS caller on THIS
 * project's access list" — so there is no second lookup an edge-case `userId`
 * could be misrouted into.
 */
function fakeMembership(members: ProjectMember[]): ProjectMembership {
  return {
    async getMember(projectId, userId) {
      return members.find((m) => m.projectId === projectId && m.userId === userId) ?? null
    },
  }
}

/** The default instance policy: public links on (the absent-setting default). */
const linksOn: ProjectReadPolicy = { allowPublicLinks: true }
/** The kill switch thrown. */
const linksOff: ProjectReadPolicy = { allowPublicLinks: false }

function fakeReq(opts: { cookie?: string; authorization?: string } = {}) {
  return {
    headers: { cookie: opts.cookie },
    get(name: string) {
      if (name.toLowerCase() === "authorization") return opts.authorization
      return undefined
    },
  } as unknown as Pick<Request, "headers" | "get">
}

/** Minimal Express Response double capturing `.status().json()`. */
function fakeRes() {
  let statusCode: number | undefined
  let body: unknown
  const res = {
    status(code: number) {
      statusCode = code
      return res
    },
    json(payload: unknown) {
      body = payload
      return res
    },
  }
  return { res: res as unknown as import("express").Response, get status() { return statusCode }, get body() { return body } }
}

describe("canReadProject v2 — truth table", () => {
  const anonymous = { user: null, isAdmin: false }
  const stranger = { user: makeUser("stranger"), isAdmin: false }

  it("public-link is readable by anyone while the kill switch is on, members or not", async () => {
    const project = makeProject({ access: "public-link" })
    const empty = fakeMembership([])
    const withMembers = fakeMembership([{ projectId: project.id, userId: "someone", createdAt: "" }])
    expect(await canReadProject(anonymous, project, empty, linksOn)).toBe(true)
    expect(await canReadProject(stranger, project, empty, linksOn)).toBe(true)
    expect(await canReadProject(stranger, project, withMembers, linksOn)).toBe(true)
  })

  // Rule 1's second half: the kill switch does not HIDE a public-link
  // project, it demotes it to "all-members". Everyone who could read it by
  // being signed in still can.
  it("public-link with the kill switch OFF behaves exactly as all-members", async () => {
    const project = makeProject({ access: "public-link" })
    const membership = fakeMembership([])
    expect(await canReadProject(anonymous, project, membership, linksOff)).toBe(false)
    expect(await canReadProject(stranger, project, membership, linksOff)).toBe(true)

    const allMembers = makeProject({ id: "p2", access: "all-members" })
    expect(await canReadProject(anonymous, allMembers, membership, linksOff)).toBe(
      await canReadProject(anonymous, project, membership, linksOff),
    )
    expect(await canReadProject(stranger, allMembers, membership, linksOff)).toBe(
      await canReadProject(stranger, project, membership, linksOff),
    )
  })

  it("the adminToken bearer bypasses everything, including an invited project it is not listed on", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([{ projectId: project.id, userId: "someone", createdAt: "" }])
    expect(await canReadProject({ user: null, isAdmin: true }, project, membership, linksOn)).toBe(true)
    expect(await canReadProject({ user: makeUser("x"), isAdmin: true }, project, membership, linksOn)).toBe(true)
  })

  // The M1-review finding this rule closes: an `admin`-ROLE session must see
  // what the shared bearer sees. Same project, same non-membership, both
  // true.
  it("an admin-ROLE session reads an invited project it is not listed on — same as the bearer", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([{ projectId: project.id, userId: "someone", createdAt: "" }])
    const roleAdmin = { user: makeUser("boss", "admin"), isAdmin: false }
    expect(await canReadProject(roleAdmin, project, membership, linksOn)).toBe(true)
    // …and the kill switch cannot lock an admin out of a public-link project.
    expect(
      await canReadProject(roleAdmin, makeProject({ access: "public-link" }), membership, linksOff),
    ).toBe(true)
  })

  it("all-members requires SIGN-IN — the zero-members world-readable rule is deleted", async () => {
    const project = makeProject({ access: "all-members" })
    const membership = fakeMembership([])
    expect(await canReadProject(anonymous, project, membership, linksOn)).toBe(false)
    expect(await canReadProject(stranger, project, membership, linksOn)).toBe(true)
  })

  it("all-members is readable by every instance role, membership irrelevant", async () => {
    const project = makeProject({ access: "all-members" })
    const membership = fakeMembership([])
    for (const role of ["admin", "editor", "viewer"] as const) {
      expect(await canReadProject({ user: makeUser(role, role), isAdmin: false }, project, membership, linksOn)).toBe(
        true,
      )
    }
  })

  it("invited is readable by a listed signed-in caller, at ANY instance role", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([{ projectId: project.id, userId: "u1", createdAt: "" }])
    expect(await canReadProject({ user: makeUser("u1", "viewer"), isAdmin: false }, project, membership, linksOn)).toBe(
      true,
    )
    expect(await canReadProject({ user: makeUser("u1", "editor"), isAdmin: false }, project, membership, linksOn)).toBe(
      true,
    )
  })

  it("denies a signed-out caller, and a signed-in caller who is not listed, on an invited project", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([{ projectId: project.id, userId: "someone", createdAt: "" }])
    expect(await canReadProject(anonymous, project, membership, linksOn)).toBe(false)
    expect(await canReadProject(stranger, project, membership, linksOn)).toBe(false)
  })

  it("an EDITOR is not special-cased into an invited project it is not listed on", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([])
    expect(
      await canReadProject({ user: makeUser("ed", "editor"), isAdmin: false }, project, membership, linksOn),
    ).toBe(false)
  })

  it("membership is looked up per PROJECT — a row on p1 does not open p2", async () => {
    const p1 = makeProject({ id: "p1", access: "invited" })
    const p2 = makeProject({ id: "p2", access: "invited" })
    const membership = fakeMembership([{ projectId: "p1", userId: "u1", createdAt: "" }])
    const caller = { user: makeUser("u1"), isAdmin: false }
    expect(await canReadProject(caller, p1, membership, linksOn)).toBe(true)
    expect(await canReadProject(caller, p2, membership, linksOn)).toBe(false)
  })

  // Regression coverage from the pre-v2 seam: an empty `ctx.user.id` must
  // never be mistaken for "anyone". It no longer CAN be — membership answers
  // one question — but the assertion stays, because the failure it names
  // (a malformed id silently reading as a grant) is the one that shipped.
  it("FAILS CLOSED for an empty-string ctx.user.id on an invited project", async () => {
    const project = makeProject({ access: "invited" })
    const membership = fakeMembership([{ projectId: project.id, userId: "someone", createdAt: "" }])
    expect(await canReadProject({ user: makeUser(""), isAdmin: false }, project, membership, linksOn)).toBe(false)
  })

  /**
   * The fail-CLOSED property of the rule's default branch.
   *
   * The rule was written as `access !== "invited" → true` at first, which was
   * equivalent only because `ProjectAccess` happened to have exactly three
   * values: a fourth would have been readable by every signed-in user, with
   * no compile error and no failing test. The cast here is what a hand-edited
   * database row looks like from inside the function, and it must be refused
   * for a signed-in caller AND for an admin-less anonymous one.
   *
   * The compile-time half of the guarantee (adding a value to `ProjectAccess`
   * breaks the build in `canReadProject`) cannot be asserted from a test —
   * that is the `never` annotation's job, and this covers the runtime half.
   */
  it("FAILS CLOSED on an access value outside the union — a fourth state is never readable by default", async () => {
    const project = makeProject({ access: "some-future-access-value" as ProjectAccess })
    const membership = fakeMembership([{ projectId: project.id, userId: "u1", createdAt: "" }])

    expect(await canReadProject(anonymous, project, membership, linksOn)).toBe(false)
    expect(await canReadProject(stranger, project, membership, linksOn)).toBe(false)
    // Not even for a caller who holds a membership row on it — an unknown
    // access value must not silently fall back to the invited rule either.
    expect(await canReadProject({ user: makeUser("u1"), isAdmin: false }, project, membership, linksOn)).toBe(false)
    // Admin authority still reaches it: that branch is above the switch, and
    // an operator locked out of a corrupted row could not repair it.
    expect(await canReadProject({ user: null, isAdmin: true }, project, membership, linksOn)).toBe(true)
  })

  it("holds over a REAL ProjectMembership backed by StorageAdapter, not just the fake", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "open", name: "Open" }) // access: "all-members"
    const membership = makeProjectMembership(storage)
    expect(await canReadProject({ user: null, isAdmin: false }, project, membership, linksOn)).toBe(false)
    expect(await canReadProject({ user: makeUser("u1"), isAdmin: false }, project, membership, linksOn)).toBe(true)
  })
})

describe("loadProjectReadPolicy", () => {
  it("defaults to allowPublicLinks: true when the setting was never written", async () => {
    expect(await loadProjectReadPolicy(new InMemoryStorage())).toEqual({ allowPublicLinks: true })
  })

  it("reads the exact representation the admin Settings route stores", async () => {
    const storage = new InMemoryStorage()
    await storage.setInstanceSetting("allowPublicLinks", String(false))
    invalidateInstanceSettingsCache(storage)
    expect(await loadProjectReadPolicy(storage)).toEqual({ allowPublicLinks: false })
    await storage.setInstanceSetting("allowPublicLinks", String(true))
    // The reader under this wrapper is cached (`instance-settings.ts`), and a
    // test writing straight to storage is a writer that is not the settings
    // route — so it carries the route's own obligation to invalidate.
    invalidateInstanceSettingsCache(storage)
    expect(await loadProjectReadPolicy(storage)).toEqual({ allowPublicLinks: true })
  })

  // The fail-closed reading of a corrupted row. Pinned exhaustively in
  // `instance-settings.test.ts`; asserted once here so the POLICY wrapper is
  // known to pass it through rather than re-deriving a boolean of its own.
  it("passes an unrecognized stored value through as OFF, not ON", async () => {
    const storage = new InMemoryStorage()
    await storage.setInstanceSetting("allowPublicLinks", "yes")
    expect(await loadProjectReadPolicy(storage)).toEqual({ allowPublicLinks: false })
  })
})

describe("hasAdminAuthority / hasProjectManageAuthority", () => {
  it("hasAdminAuthority is true for the bearer AND for an admin-role user", () => {
    expect(hasAdminAuthority({ user: null, isAdmin: true })).toBe(true)
    expect(hasAdminAuthority({ user: makeUser("boss", "admin"), isAdmin: false })).toBe(true)
  })

  it("hasAdminAuthority is false for editor, viewer and anonymous", () => {
    expect(hasAdminAuthority({ user: makeUser("ed", "editor"), isAdmin: false })).toBe(false)
    expect(hasAdminAuthority({ user: makeUser("vw", "viewer"), isAdmin: false })).toBe(false)
    expect(hasAdminAuthority({ user: null, isAdmin: false })).toBe(false)
  })

  it("hasProjectManageAuthority admits admin authority and the editor role, nothing else", () => {
    expect(hasProjectManageAuthority({ user: null, isAdmin: true })).toBe(true)
    expect(hasProjectManageAuthority({ user: makeUser("boss", "admin"), isAdmin: false })).toBe(true)
    expect(hasProjectManageAuthority({ user: makeUser("ed", "editor"), isAdmin: false })).toBe(true)
    expect(hasProjectManageAuthority({ user: makeUser("vw", "viewer"), isAdmin: false })).toBe(false)
    expect(hasProjectManageAuthority({ user: null, isAdmin: false })).toBe(false)
  })
})

describe("makeProjectMembership (real StorageAdapter)", () => {
  it("getMember finds a specific member and returns null for a non-member", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme" })
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const membership = makeProjectMembership(storage)

    expect((await membership.getMember(project.id, user.id))?.userId).toBe(user.id)
    expect(await membership.getMember(project.id, "someone-else")).toBeNull()
  })

  it("getMember returns null (not a false positive) for an empty-string userId, even on a project with members", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme" })
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const membership = makeProjectMembership(storage)

    expect(await membership.getMember(project.id, "")).toBeNull()
  })

  it("scopes the lookup to the project — a row on one project is not found on another", async () => {
    const storage = new InMemoryStorage()
    const a = await storage.createProject({ slug: "a", name: "A" })
    const b = await storage.createProject({ slug: "b", name: "B" })
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: a.id, userId: user.id })
    const membership = makeProjectMembership(storage)

    expect(await membership.getMember(a.id, user.id)).not.toBeNull()
    expect(await membership.getMember(b.id, user.id)).toBeNull()
  })
})

describe("isAdminRequest", () => {
  it("true for a matching bearer token", () => {
    const config = { adminToken: "secret" }
    expect(isAdminRequest(config, fakeReq({ authorization: "Bearer secret" }))).toBe(true)
  })

  it("false for a wrong token, a missing header, or no admin token configured", () => {
    expect(isAdminRequest({ adminToken: "secret" }, fakeReq({ authorization: "Bearer wrong" }))).toBe(false)
    expect(isAdminRequest({ adminToken: "secret" }, fakeReq())).toBe(false)
    expect(isAdminRequest({ adminToken: null }, fakeReq({ authorization: "Bearer secret" }))).toBe(false)
  })

  // Fix wave I4 — RFC 7235 §2.1: the auth scheme is case-insensitive.
  // `isAdminRequest` and `resolveReadContext` share ONE extraction helper
  // precisely so they can't disagree about this, so both get the same
  // matrix (see the `resolveReadContext` block below).
  it.each(["Bearer", "bearer", "BEARER", "BeArEr"])(
    "matches the %s scheme case-insensitively",
    (scheme) => {
      expect(isAdminRequest({ adminToken: "secret" }, fakeReq({ authorization: `${scheme} secret` }))).toBe(true)
    },
  )

  it("still refuses a non-bearer scheme carrying the admin token as its value", () => {
    expect(isAdminRequest({ adminToken: "secret" }, fakeReq({ authorization: "Basic secret" }))).toBe(false)
  })
})

describe("lacksWriteScope (fix wave C1)", () => {
  it("is false for every NON-machine-token caller — sessions and anonymous keep their pre-3b-2 authority", () => {
    expect(lacksWriteScope({ user: null, isAdmin: false, scopes: null })).toBe(false)
    expect(lacksWriteScope({ user: makeUser("u"), isAdmin: false, scopes: null })).toBe(false)
    expect(lacksWriteScope({ user: null, isAdmin: true, scopes: null })).toBe(false)
  })

  it("is true for a machine token without the write scope", () => {
    expect(lacksWriteScope({ user: makeUser("u"), isAdmin: false, scopes: ["read"] })).toBe(true)
    expect(lacksWriteScope({ user: makeUser("u"), isAdmin: false, scopes: [] })).toBe(true)
  })

  it("is false for a machine token carrying write, alone or alongside read", () => {
    expect(lacksWriteScope({ user: makeUser("u"), isAdmin: false, scopes: ["write"] })).toBe(false)
    expect(lacksWriteScope({ user: makeUser("u"), isAdmin: false, scopes: ["read", "write"] })).toBe(false)
  })
})

describe("resolveReadContext", () => {
  it("isAdmin true from a valid bearer; user null with no session; scopes null (an admin bearer is not a PAT)", async () => {
    const config = { ...baseConfig, adminToken: "secret" }
    const ctx = await resolveReadContext(
      { storage: new InMemoryStorage(), config },
      fakeReq({ authorization: "Bearer secret" }),
    )
    expect(ctx).toEqual({ user: null, isAdmin: true, scopes: null })
  })

  it("resolves the signed-in user from a valid session cookie; scopes null (a session is not scope-limited)", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "secret" },
    }
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)
    const ctx = await resolveReadContext({ storage, config }, fakeReq({ cookie: `viewer_session=${signed}` }))
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) {
      expect(ctx.isAdmin).toBe(false)
      expect(ctx.user?.id).toBe(user.id)
      expect(ctx.scopes).toBeNull()
    }
  })

  it("no bearer, no cookie: fully anonymous, scopes null", async () => {
    const ctx = await resolveReadContext({ storage: new InMemoryStorage(), config: baseConfig }, fakeReq())
    expect(ctx).toEqual({ user: null, isAdmin: false, scopes: null })
  })

  it("bearer step 3: a bearer that verifies as a live machine token resolves the token's OWNING user and its scopes — never the cookie's user", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const storage = new InMemoryStorage()
    const tokenOwner = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "owner",
      email: "owner@x.com",
      displayName: "Owner",
      avatarUrl: "",
    })
    const cookieUser = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "cookie",
      email: "cookie@x.com",
      displayName: "Cookie",
      avatarUrl: "",
    })
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: tokenOwner.id,
      name: "t",
      scopes: ["read", "write"],
      tokenHash: gen.tokenHash,
      expiresAt: null,
    })
    const session = await storage.createSession({
      userId: cookieUser.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)

    const ctx = await resolveReadContext(
      { storage, config },
      fakeReq({ authorization: `Bearer ${gen.token}`, cookie: `viewer_session=${signed}` }),
    )
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) {
      expect(ctx.user?.id).toBe(tokenOwner.id)
      expect(ctx.isAdmin).toBe(false)
      expect(ctx.scopes).toEqual(["read", "write"])
    }
  })

  it("bearer step 4: a garbage bearer resolves to an error and NEVER falls through to a valid session cookie — even with one attached", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      adminToken: "secret",
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)

    const ctx = await resolveReadContext(
      { storage, config },
      fakeReq({ authorization: "Bearer garbage-not-a-real-token", cookie: `viewer_session=${signed}` }),
    )
    expect(ctx).toEqual({ error: "Invalid credentials" })
  })

  it("an expired machine token also lands in the step-4 error branch — not a fallback to the cookie", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "expired",
      scopes: ["read"],
      tokenHash: gen.tokenHash,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const ctx = await resolveReadContext(
      { storage, config },
      fakeReq({ authorization: `Bearer ${gen.token}`, cookie: `viewer_session=${signed}` }),
    )
    expect("error" in ctx).toBe(true)
  })

  it("a header that isn't the Bearer scheme at all is treated as 'no bearer' — falls through to the cookie, unchanged from before Phase 3b-2", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "mo@x.com",
      displayName: "Mo",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)

    const ctx = await resolveReadContext(
      { storage, config },
      fakeReq({ authorization: "Basic dXNlcjpwYXNz", cookie: `viewer_session=${signed}` }),
    )
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) expect(ctx.user?.id).toBe(user.id)
  })
})

describe("requireProjectRead", () => {
  async function setup(): Promise<{ storage: StorageAdapter; config: ViewerConfig }> {
    return { storage: new InMemoryStorage(), config: baseConfig }
  }

  it("returns the project when it exists and is readable (public-link, anonymous)", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const { res } = fakeRes()
    const got = await requireProjectRead({ storage, config }, fakeReq(), res, project.id)
    expect(got?.id).toBe(project.id)
  })

  // Authorization v2: a default-access (`all-members`) project requires
  // SIGN-IN. Before v2 it was world-readable — the inherited zero-members
  // migration rule — and this test asserted the opposite of what it does now.
  it("404s a default-access (all-members) project for an ANONYMOUS caller, and returns it once signed in", async () => {
    const { storage } = await setup()
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const project = await storage.createProject({ slug: "acme", name: "Acme" }) // defaults to "all-members"

    const denied = fakeRes()
    expect(await requireProjectRead({ storage, config }, fakeReq(), denied.res, project.id)).toBeNull()
    expect(denied.status).toBe(404)

    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "someone",
      email: "someone@x.com",
      displayName: "Someone",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const { res } = fakeRes()
    const got = await requireProjectRead(
      { storage, config },
      fakeReq({ cookie: `viewer_session=${signSessionId("sesh", session.id)}` }),
      res,
      project.id,
    )
    expect(got?.id).toBe(project.id)
  })

  it("sends {error: 'Project not found'} 404 and returns null for a nonexistent id", async () => {
    const { storage, config } = await setup()
    const notFound = fakeRes()
    const got = await requireProjectRead({ storage, config }, fakeReq(), notFound.res, "nope")
    expect(got).toBeNull()
    expect(notFound.status).toBe(404)
    expect(notFound.body).toEqual({ error: "Project not found" })
  })

  it("sends the SAME byte-identical 404 for an existing-but-unreadable project (not a 403)", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const owner = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "owner@x.com",
      displayName: "Owner",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: owner.id })

    const denied = fakeRes()
    const gotDenied = await requireProjectRead({ storage, config }, fakeReq(), denied.res, project.id)
    const missing = fakeRes()
    const gotMissing = await requireProjectRead({ storage, config }, fakeReq(), missing.res, "nope")

    expect(gotDenied).toBeNull()
    expect(gotMissing).toBeNull()
    expect(denied.status).toBe(missing.status)
    expect(denied.body).toEqual(missing.body)
  })

  it("admin bearer reaches an invited-access project the caller doesn't belong to", async () => {
    const { storage } = await setup()
    const config = { ...baseConfig, adminToken: "secret" }
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const owner = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "owner@x.com",
      displayName: "Owner",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: owner.id })

    const { res } = fakeRes()
    const got = await requireProjectRead(
      { storage, config },
      fakeReq({ authorization: "Bearer secret" }),
      res,
      project.id,
    )
    expect(got?.id).toBe(project.id)
  })

  it("401s (not 404) an invalid bearer — never silently treated as anonymous", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const denied = fakeRes()
    const got = await requireProjectRead(
      { storage, config },
      fakeReq({ authorization: "Bearer garbage" }),
      denied.res,
      project.id,
    )
    expect(got).toBeNull()
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: "Invalid credentials" })
  })
})

describe("requireProjectManage", () => {
  const managedConfig: ViewerConfig = {
    ...baseConfig,
    sessionSecret: "sesh",
    githubAuth: { clientId: "id", clientSecret: "s" },
  }

  /** Seeds a user at `role` and returns a request carrying their session. */
  async function reqAs(storage: StorageAdapter, id: string, role: InstanceRole) {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: id,
      email: `${id}@x.com`,
      displayName: id,
      avatarUrl: "",
      role,
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    return { user, req: fakeReq({ cookie: `viewer_session=${signSessionId("sesh", session.id)}` }) }
  }

  it("allows the adminToken bearer with no membership and no session", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, adminToken: "secret" }
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const { res } = fakeRes()
    const got = await requireProjectManage(
      { storage, config },
      fakeReq({ authorization: "Bearer secret" }),
      res,
      project.id,
    )
    expect(got?.id).toBe(project.id)
  })

  it("allows an admin-ROLE session on an invited project it is not listed on", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const { req } = await reqAs(storage, "boss", "admin")
    const { res } = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, res, project.id)
    expect(got?.id).toBe(project.id)
  })

  // The shape change from `requireProjectOwnerOrAdmin`: an access-list row is
  // no longer what authorizes. An editor holding NO row manages an
  // all-members project, because nothing distinguishes them from anyone else
  // who could hold one.
  it("allows an EDITOR with no membership row on an all-members project", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "all-members" })
    const { req } = await reqAs(storage, "ed", "editor")
    const { res } = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, res, project.id)
    expect(got?.id).toBe(project.id)
  })

  it("allows an EDITOR on an invited project they ARE listed on", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const { user, req } = await reqAs(storage, "ed", "editor")
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const { res } = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, res, project.id)
    expect(got?.id).toBe(project.id)
  })

  // The ordering rule this guard exists to keep: the read gate answers FIRST.
  // An editor who cannot read an invited project learns nothing about it —
  // not even that it exists.
  it("404s — never 403s — an EDITOR on an invited project they are NOT listed on", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const { req } = await reqAs(storage, "ed", "editor")

    const denied = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, denied.res, project.id)
    const missing = fakeRes()
    await requireProjectManage({ storage, config: managedConfig }, req, missing.res, "nope")

    expect(got).toBeNull()
    expect(denied.status).toBe(404)
    expect(denied.status).toBe(missing.status)
    expect(denied.body).toEqual(missing.body)
  })

  it("403s a VIEWER on a project they can read, with the manage message", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "all-members" })
    const { req } = await reqAs(storage, "vw", "viewer")
    const denied = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, denied.res, project.id, "rename it")
    expect(got).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: "Only editors and admins may rename it" })
    expect(manageRefusal("rename it")).toBe("Only editors and admins may rename it")
  })

  it("403s a VIEWER even on an invited project they ARE listed on — a row is access, not authority", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const { user, req } = await reqAs(storage, "vw", "viewer")
    await storage.addProjectMember({ projectId: project.id, userId: user.id })
    const denied = fakeRes()
    const got = await requireProjectManage({ storage, config: managedConfig }, req, denied.res, project.id)
    expect(got).toBeNull()
    expect(denied.status).toBe(403)
  })

  it("403s an anonymous caller on a readable project (public-link)", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const denied = fakeRes()
    const got = await requireProjectManage({ storage, config: baseConfig }, fakeReq(), denied.res, project.id)
    expect(got).toBeNull()
    expect(denied.status).toBe(403)
  })

  it("404s an anonymous caller on a public-link project once the kill switch is thrown", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    await storage.setInstanceSetting("allowPublicLinks", "false")
    const denied = fakeRes()
    const got = await requireProjectManage({ storage, config: baseConfig }, fakeReq(), denied.res, project.id)
    expect(got).toBeNull()
    expect(denied.status).toBe(404)
  })

  it("sends the SAME byte-identical 404 for a nonexistent id and an unreadable project", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })

    const denied = fakeRes()
    const gotDenied = await requireProjectManage({ storage, config: baseConfig }, fakeReq(), denied.res, project.id)
    const missing = fakeRes()
    const gotMissing = await requireProjectManage({ storage, config: baseConfig }, fakeReq(), missing.res, "nope")

    expect(gotDenied).toBeNull()
    expect(gotMissing).toBeNull()
    expect(denied.status).toBe(404)
    expect(denied.status).toBe(missing.status)
    expect(denied.body).toEqual(missing.body)
  })

  it("401s (not 403, not 404) an invalid bearer, even on a project the caller could otherwise manage", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const denied = fakeRes()
    const got = await requireProjectManage(
      { storage, config: baseConfig },
      fakeReq({ authorization: "Bearer garbage" }),
      denied.res,
      project.id,
    )
    expect(got).toBeNull()
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: "Invalid credentials" })
  })

  it("403s a READ-scoped PAT — an admin's included — before any project lookup", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read"])

    const real = fakeRes()
    await requireProjectManage({ storage, config: baseConfig }, fakeReq({ authorization }), real.res, project.id)
    const bogus = fakeRes()
    await requireProjectManage({ storage, config: baseConfig }, fakeReq({ authorization }), bogus.res, "nope")

    expect(real.status).toBe(403)
    expect(real.body).toEqual({ error: WRITE_SCOPE_REQUIRED })
    // The scope refusal must reveal nothing about the project: same answer
    // for a real id and a bogus one.
    expect(real.status).toBe(bogus.status)
    expect(real.body).toEqual(bogus.body)
  })

  it("allows an admin's WRITE-scoped PAT", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read", "write"])
    const { res } = fakeRes()
    const got = await requireProjectManage({ storage, config: baseConfig }, fakeReq({ authorization }), res, project.id)
    expect(got?.id).toBe(project.id)
  })

  /**
   * `hasAdminAuthority` does NOT re-check `status`, on the documented ground
   * that both credential-resolution paths already refuse a `removed` account
   * before `ctx.user` is populated. That guarantee is upstream of this guard,
   * so nothing inside `authorize.ts` proves it end to end — this does, for
   * both credentials, and it is why the predicate is allowed to stay a
   * one-liner.
   *
   * The two refusals differ on purpose. A session that no longer resolves
   * leaves an ANONYMOUS context (`getCurrentUser` returns null), so the
   * caller is refused by whatever an anonymous caller would get: 403 on a
   * project they can still read, 404 on one they cannot. A PAT that no longer
   * resolves is a presented credential that failed, which is a 401.
   */
  it("refuses a REMOVED admin's SESSION — the row still says admin, the account does not", async () => {
    const storage = new InMemoryStorage()
    const readable = await storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
    const locked = await storage.createProject({ slug: "inv", name: "Inv", access: "invited" })
    const { user, req } = await reqAs(storage, "gone", "admin")
    await storage.setUserStatus(user.id, "removed")

    const onReadable = fakeRes()
    expect(
      await requireProjectManage({ storage, config: managedConfig }, req, onReadable.res, readable.id),
    ).toBeNull()
    expect(onReadable.status).toBe(403)

    const onLocked = fakeRes()
    expect(await requireProjectManage({ storage, config: managedConfig }, req, onLocked.res, locked.id)).toBeNull()
    expect(onLocked.status).toBe(404)
  })

  it("refuses a REMOVED admin's still-live PAT with 401 — a presented credential that no longer resolves", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "pub", name: "Pub", access: "public-link" })
    const admin = await seedUser(storage, { id: "gone", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read", "write"])
    await storage.setUserStatus(admin.id, "removed")

    const denied = fakeRes()
    const got = await requireProjectManage(
      { storage, config: baseConfig },
      fakeReq({ authorization }),
      denied.res,
      project.id,
    )
    expect(got).toBeNull()
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: "Invalid credentials" })
  })
})

/**
 * The GET-shaped manage guard. Everything `requireProjectManage` does, minus
 * the write-scope requirement — see its doc comment for why a GET must not
 * ask that question when a scope-blind read route serves the same bytes.
 */
describe("requireProjectManageRead", () => {
  const managedConfig: ViewerConfig = {
    ...baseConfig,
    sessionSecret: "sesh",
    githubAuth: { clientId: "id", clientSecret: "s" },
  }

  it("ADMITS a read-scoped PAT where requireProjectManage refuses it — the whole difference between the two", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    await storage.addProjectMember({ projectId: project.id, userId: editor.id })
    const authorization = await patHeaderFor(storage, editor.id, ["read"])

    const { res } = fakeRes()
    const allowed = await requireProjectManageRead(
      { storage, config: managedConfig },
      fakeReq({ authorization }),
      res,
      project.id,
    )
    expect(allowed?.id).toBe(project.id)

    const denied = fakeRes()
    const refused = await requireProjectManage(
      { storage, config: managedConfig },
      fakeReq({ authorization }),
      denied.res,
      project.id,
    )
    expect(refused).toBeNull()
    expect(denied.body).toEqual({ error: WRITE_SCOPE_REQUIRED })
  })

  it("still refuses a VIEWER — dropping the scope check does not drop the role check", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "all-members" })
    const reader = await seedUser(storage, { id: "vw", role: "viewer" })
    const authorization = await patHeaderFor(storage, reader.id, ["read"])

    const denied = fakeRes()
    const got = await requireProjectManageRead(
      { storage, config: managedConfig },
      fakeReq({ authorization }),
      denied.res,
      project.id,
      "view the build log",
    )
    expect(got).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: manageRefusal("view the build log") })
  })

  it("still 404s an unreadable project before any 403, and 401s a bad bearer", async () => {
    const storage = new InMemoryStorage()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "invited" })
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    const authorization = await patHeaderFor(storage, editor.id, ["read"])

    const denied = fakeRes()
    await requireProjectManageRead(
      { storage, config: managedConfig },
      fakeReq({ authorization }),
      denied.res,
      project.id,
    )
    const missing = fakeRes()
    await requireProjectManageRead({ storage, config: managedConfig }, fakeReq({ authorization }), missing.res, "nope")
    expect(denied.status).toBe(404)
    expect(denied.body).toEqual(missing.body)

    const badBearer = fakeRes()
    await requireProjectManageRead(
      { storage, config: managedConfig },
      fakeReq({ authorization: "Bearer garbage" }),
      badBearer.res,
      project.id,
    )
    expect(badBearer.status).toBe(401)
  })
})

/**
 * Fix wave C1. `requireProjectRead` is scope-blind by design (reads are
 * fine for a read PAT); every MUTATING route that used it now uses this
 * sibling instead, which adds exactly one thing: the write-scope refusal.
 */
describe("requireProjectWrite (fix wave C1)", () => {
  async function setup(): Promise<{ storage: StorageAdapter; config: ViewerConfig }> {
    return { storage: new InMemoryStorage(), config: baseConfig }
  }

  /** Mints a live PAT for a fresh user and returns its bearer header value. */
  async function patFor(storage: StorageAdapter, scopes: ("read" | "write")[], providerUserId = "pat-user") {
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId,
      email: `${providerUserId}@x.com`,
      displayName: providerUserId,
      avatarUrl: "",
    })
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "t",
      scopes,
      tokenHash: gen.tokenHash,
    })
    return { user, authorization: `Bearer ${gen.token}` }
  }

  it("returns the project AND the resolved ctx for an anonymous caller on a readable project (public-write model preserved)", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const { res } = fakeRes()
    const got = await requireProjectWrite({ storage, config }, fakeReq(), res, project.id)
    expect(got?.project.id).toBe(project.id)
    expect(got?.ctx).toEqual({ user: null, isAdmin: false, scopes: null })
  })

  it("403s a read-scoped PAT with the shared write-scope message", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const { authorization } = await patFor(storage, ["read"])
    const denied = fakeRes()
    const got = await requireProjectWrite({ storage, config }, fakeReq({ authorization }), denied.res, project.id)
    expect(got).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: "This action requires a write-scoped token" })
  })

  it("allows a write-scoped PAT and hands back the TOKEN's user as the resolved identity", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const { user, authorization } = await patFor(storage, ["write"])
    const { res } = fakeRes()
    const got = await requireProjectWrite({ storage, config }, fakeReq({ authorization }), res, project.id)
    expect(got?.project.id).toBe(project.id)
    expect(got?.ctx.user?.id).toBe(user.id)
    expect(got?.ctx.scopes).toEqual(["write"])
  })

  it("401s an invalid bearer before anything else", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const denied = fakeRes()
    const got = await requireProjectWrite(
      { storage, config },
      fakeReq({ authorization: "Bearer garbage" }),
      denied.res,
      project.id,
    )
    expect(got).toBeNull()
    expect(denied.status).toBe(401)
  })

  it("404s an unreadable project identically to a nonexistent one (no existence oracle), for a WRITE-scoped PAT", async () => {
    const { storage } = await setup()
    const config = {
      ...baseConfig,
      sessionSecret: "sesh",
      githubAuth: { clientId: "id", clientSecret: "s" },
    }
    const project = await storage.createProject({ slug: "locked", name: "Locked", access: "invited" })
    const owner = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "owner",
      email: "owner@x.com",
      displayName: "Owner",
      avatarUrl: "",
    })
    await storage.addProjectMember({ projectId: project.id, userId: owner.id })
    const { authorization } = await patFor(storage, ["write"], "outsider")

    const denied = fakeRes()
    await requireProjectWrite({ storage, config }, fakeReq({ authorization }), denied.res, project.id)
    const missing = fakeRes()
    await requireProjectWrite({ storage, config }, fakeReq({ authorization }), missing.res, "nope")

    expect(denied.status).toBe(404)
    expect(denied.status).toBe(missing.status)
    expect(denied.body).toEqual(missing.body)
  })

  it("answers the scope refusal WITHOUT revealing anything about the project — same 403 for a real id and a bogus one", async () => {
    const { storage, config } = await setup()
    const project = await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })
    const { authorization } = await patFor(storage, ["read"])

    const real = fakeRes()
    await requireProjectWrite({ storage, config }, fakeReq({ authorization }), real.res, project.id)
    const bogus = fakeRes()
    await requireProjectWrite({ storage, config }, fakeReq({ authorization }), bogus.res, "no-such-project")

    expect(real.status).toBe(403)
    expect(real.status).toBe(bogus.status)
    expect(real.body).toEqual(bogus.body)
  })
})

/**
 * Fix wave I3. The serve path delivers FILES, not API data — an invalid
 * bearer there is usually a prototype stubbing auth against its own mocked
 * API, and rejecting it reaches the identical authorization outcome as
 * treating it as anonymous (a bad bearer can never grant more than
 * anonymous). So it degrades instead of erroring. Strictness stays on
 * `/api/v1/**` via `resolveReadContext`.
 */
describe("resolveReadContextLenient (fix wave I3)", () => {
  it("degrades an unrecognized bearer to the anonymous context instead of { error }", async () => {
    const ctx = await resolveReadContextLenient(
      { storage: new InMemoryStorage(), config: baseConfig },
      fakeReq({ authorization: "Bearer demo-token" }),
    )
    expect(ctx).toEqual({ user: null, isAdmin: false, scopes: null })
  })

  // The degrade target is the NO-BEARER branch, not "nobody". Without this,
  // a signed-in member viewing a `members` project whose prototype stubs an
  // `Authorization` header loses their cookie identity and 404s on the
  // asset — re-breaking the exact case leniency exists to fix, on the
  // deployment shape most likely to be real. The bad-bearer result must
  // equal what the same request produces with the header omitted.
  it("keeps the session cookie when the bearer is unrecognized (degrades to no-bearer, not to nobody)", async () => {
    const config: ViewerConfig = {
      ...baseConfig,
      sessionSecret: "sesh-secret",
      githubAuth: { clientId: "id", clientSecret: "secret" },
    }
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "1",
      email: "member@x.com",
      displayName: "Member",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const cookie = `viewer_session=${signSessionId(config.sessionSecret, session.id)}`

    const withBadBearer = await resolveReadContextLenient(
      { storage, config },
      fakeReq({ cookie, authorization: "Bearer demo-token" }),
    )
    const withoutHeader = await resolveReadContextLenient({ storage, config }, fakeReq({ cookie }))

    expect(withBadBearer.user?.id).toBe(user.id)
    expect(withBadBearer.isAdmin).toBe(false)
    expect(withBadBearer.scopes).toBeNull()
    expect(withBadBearer).toEqual(withoutHeader)
  })

  it("is identical to resolveReadContext for every credential that DOES resolve", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, adminToken: "secret" }
    const strict = await resolveReadContext({ storage, config }, fakeReq({ authorization: "Bearer secret" }))
    const lenient = await resolveReadContextLenient({ storage, config }, fakeReq({ authorization: "Bearer secret" }))
    expect(lenient).toEqual(strict)
  })

  it("a live PAT still resolves its owner and scopes through the lenient path", async () => {
    const storage = new InMemoryStorage()
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "pat",
      email: "pat@x.com",
      displayName: "Pat",
      avatarUrl: "",
    })
    const gen = generateMachineToken()
    await storage.createMachineToken({
      id: gen.id,
      userId: user.id,
      name: "t",
      scopes: ["read"],
      tokenHash: gen.tokenHash,
    })

    const ctx = await resolveReadContextLenient(
      { storage, config: baseConfig },
      fakeReq({ authorization: `Bearer ${gen.token}` }),
    )
    expect(ctx.user?.id).toBe(user.id)
    expect(ctx.scopes).toEqual(["read"])
  })
})

// ---------------------------------------------------------------------------
// Task 5 — status is the live entitlement, and the two instance-role guards.
// ---------------------------------------------------------------------------

/** A config that can actually carry sessions (signed cookies + a provider). */
const authedConfig: ViewerConfig = {
  ...baseConfig,
  sessionSecret: "sesh-secret",
  githubAuth: { clientId: "id", clientSecret: "s" },
}

/** Seeds a user at a given instance role. */
async function seedUser(
  storage: StorageAdapter,
  opts: { id: string; role: InstanceRole; email?: string },
): Promise<User> {
  return upsertTestUser(storage, {
    provider: "github",
    providerUserId: opts.id,
    email: opts.email ?? `${opts.id}@x.com`,
    displayName: opts.id,
    avatarUrl: "",
    role: opts.role,
  })
}

/** A live session cookie header value for `userId`, signed with `config`. */
async function cookieFor(storage: StorageAdapter, config: ViewerConfig, userId: string) {
  const session = await storage.createSession({
    userId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  return { cookie: `viewer_session=${signSessionId(config.sessionSecret, session.id)}`, session }
}

/** A live PAT for `userId` at the given scopes. */
async function patHeaderFor(
  storage: StorageAdapter,
  userId: string,
  scopes: ("read" | "write")[],
) {
  const gen = generateMachineToken()
  await storage.createMachineToken({
    id: gen.id,
    userId,
    name: "t",
    scopes,
    tokenHash: gen.tokenHash,
  })
  return `Bearer ${gen.token}`
}

/**
 * A PAT is the longer-lived of the two credentials, so it is the one for
 * which "outlives the holder's entitlement" matters most. The check that used
 * to live here re-evaluated `VIEWER_ALLOWED_EMAIL_DOMAINS` (audit K08); the
 * entitlement it defends is now membership status, which an admin can revoke
 * directly and which `removed` sets.
 */
describe("resolveReadContext — status is the live entitlement (Task 5)", () => {
  it("refuses a REMOVED user's still-live PAT as invalid credentials", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, { id: "gone", role: "admin" })
    const authorization = await patHeaderFor(storage, user.id, ["read", "write"])
    await storage.setUserStatus(user.id, "removed")

    const ctx = await resolveReadContext({ storage, config: baseConfig }, fakeReq({ authorization }))
    expect(ctx).toEqual({ error: "Invalid credentials" })
  })

  /**
   * Regression for the Task 4 carried finding, PAT half: the env allowlist is
   * an ADMISSION gate now (it seeds domain rules at boot), so it must not keep
   * killing credentials that were legitimately issued outside it.
   */
  it("still resolves an ACTIVE user's PAT when their email is outside the configured allowlist", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, allowedEmailDomains: ["example.com"] }
    const user = await seedUser(storage, { id: "local", role: "admin", email: "operator@localhost" })
    const authorization = await patHeaderFor(storage, user.id, ["read"])

    const ctx = await resolveReadContext({ storage, config }, fakeReq({ authorization }))
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) expect(ctx.user?.id).toBe(user.id)
  })

  it("a REMOVED user's session resolves to no user at all (not merely to a non-admin)", async () => {
    const storage = new InMemoryStorage()
    const user = await seedUser(storage, { id: "gone", role: "admin" })
    const { cookie } = await cookieFor(storage, authedConfig, user.id)
    await storage.setUserStatus(user.id, "removed")

    const ctx = await resolveReadContext({ storage, config: authedConfig }, fakeReq({ cookie }))
    expect(ctx).toEqual({ user: null, isAdmin: false, scopes: null })
  })
})

describe("requireInstanceAdmin", () => {
  it("admits the adminToken bearer, with no session at all", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, adminToken: "secret" }
    const { res } = fakeRes()
    const ctx = await requireInstanceAdmin(
      { storage, config },
      fakeReq({ authorization: "Bearer secret" }),
      res,
    )
    expect(ctx).toEqual({ user: null, isAdmin: true, scopes: null })
  })

  it("admits an active admin's session and hands back the resolved context", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const { cookie } = await cookieFor(storage, authedConfig, admin.id)
    const { res } = fakeRes()

    const ctx = await requireInstanceAdmin({ storage, config: authedConfig }, fakeReq({ cookie }), res)
    expect(ctx?.user?.id).toBe(admin.id)
    expect(ctx?.isAdmin).toBe(false)
  })

  it("403s an editor's session with the admin-role message", async () => {
    const storage = new InMemoryStorage()
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    const { cookie } = await cookieFor(storage, authedConfig, editor.id)
    const denied = fakeRes()

    const ctx = await requireInstanceAdmin({ storage, config: authedConfig }, fakeReq({ cookie }), denied.res)
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: ADMIN_ROLE_REQUIRED })
    expect(ADMIN_ROLE_REQUIRED).toBe("This action requires the admin role")
  })

  it("403s a viewer's session", async () => {
    const storage = new InMemoryStorage()
    const viewer = await seedUser(storage, { id: "vw", role: "viewer" })
    const { cookie } = await cookieFor(storage, authedConfig, viewer.id)
    const denied = fakeRes()

    const ctx = await requireInstanceAdmin({ storage, config: authedConfig }, fakeReq({ cookie }), denied.res)
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
  })

  it("403s an anonymous caller — no bearer means nothing to 401 about", async () => {
    const denied = fakeRes()
    const ctx = await requireInstanceAdmin(
      { storage: new InMemoryStorage(), config: baseConfig },
      fakeReq(),
      denied.res,
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: ADMIN_ROLE_REQUIRED })
  })

  it("401s a garbage bearer, even on an instance with no admin token configured", async () => {
    const denied = fakeRes()
    const ctx = await requireInstanceAdmin(
      { storage: new InMemoryStorage(), config: baseConfig },
      fakeReq({ authorization: "Bearer nope" }),
      denied.res,
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: "Invalid credentials" })
  })

  it("403s a REMOVED admin's session — the row still says admin, the account does not", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "gone", role: "admin" })
    const { cookie } = await cookieFor(storage, authedConfig, admin.id)
    await storage.setUserStatus(admin.id, "removed")
    const denied = fakeRes()

    const ctx = await requireInstanceAdmin({ storage, config: authedConfig }, fakeReq({ cookie }), denied.res)
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
  })

  it("403s an admin's READ-scoped PAT when requireWriteScope is set, with the write-scope message", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read"])
    const denied = fakeRes()

    const ctx = await requireInstanceAdmin(
      { storage, config: baseConfig },
      fakeReq({ authorization }),
      denied.res,
      { requireWriteScope: true },
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: WRITE_SCOPE_REQUIRED })
  })

  it("admits an admin's WRITE-scoped PAT when requireWriteScope is set", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read", "write"])
    const { res } = fakeRes()

    const ctx = await requireInstanceAdmin(
      { storage, config: baseConfig },
      fakeReq({ authorization }),
      res,
      { requireWriteScope: true },
    )
    expect(ctx?.user?.id).toBe(admin.id)
    expect(ctx?.scopes).toEqual(["read", "write"])
  })

  it("admits an admin's READ-scoped PAT on a read route (requireWriteScope absent)", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const authorization = await patHeaderFor(storage, admin.id, ["read"])
    const { res } = fakeRes()

    const ctx = await requireInstanceAdmin({ storage, config: baseConfig }, fakeReq({ authorization }), res)
    expect(ctx?.user?.id).toBe(admin.id)
  })

  it("403s an EDITOR's write-scoped PAT — a scope is not a role", async () => {
    const storage = new InMemoryStorage()
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    const authorization = await patHeaderFor(storage, editor.id, ["read", "write"])
    const denied = fakeRes()

    const ctx = await requireInstanceAdmin(
      { storage, config: baseConfig },
      fakeReq({ authorization }),
      denied.res,
      { requireWriteScope: true },
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: ADMIN_ROLE_REQUIRED })
  })

  it("admits the adminToken bearer under requireWriteScope — an admin bearer is not a PAT", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, adminToken: "secret" }
    const { res } = fakeRes()

    const ctx = await requireInstanceAdmin(
      { storage, config },
      fakeReq({ authorization: "Bearer secret" }),
      res,
      { requireWriteScope: true },
    )
    expect(ctx?.isAdmin).toBe(true)
  })
})

describe("requireInstanceEditor", () => {
  it("admits an editor's session", async () => {
    const storage = new InMemoryStorage()
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    const { cookie } = await cookieFor(storage, authedConfig, editor.id)
    const { res } = fakeRes()

    const ctx = await requireInstanceEditor({ storage, config: authedConfig }, fakeReq({ cookie }), res)
    expect(ctx?.user?.id).toBe(editor.id)
  })

  it("admits an admin's session — admin is a superset of editor here", async () => {
    const storage = new InMemoryStorage()
    const admin = await seedUser(storage, { id: "boss", role: "admin" })
    const { cookie } = await cookieFor(storage, authedConfig, admin.id)
    const { res } = fakeRes()

    const ctx = await requireInstanceEditor({ storage, config: authedConfig }, fakeReq({ cookie }), res)
    expect(ctx?.user?.id).toBe(admin.id)
  })

  it("403s a viewer's session with the editor-role message", async () => {
    const storage = new InMemoryStorage()
    const viewer = await seedUser(storage, { id: "vw", role: "viewer" })
    const { cookie } = await cookieFor(storage, authedConfig, viewer.id)
    const denied = fakeRes()

    const ctx = await requireInstanceEditor({ storage, config: authedConfig }, fakeReq({ cookie }), denied.res)
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: EDITOR_ROLE_REQUIRED })
    expect(EDITOR_ROLE_REQUIRED).toBe("This action requires the editor role")
  })

  it("admits the adminToken bearer", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, adminToken: "secret" }
    const { res } = fakeRes()

    const ctx = await requireInstanceEditor(
      { storage, config },
      fakeReq({ authorization: "Bearer secret" }),
      res,
    )
    expect(ctx?.isAdmin).toBe(true)
  })

  it("403s a REMOVED editor's session", async () => {
    const storage = new InMemoryStorage()
    const editor = await seedUser(storage, { id: "ed", role: "editor" })
    const { cookie } = await cookieFor(storage, authedConfig, editor.id)
    await storage.setUserStatus(editor.id, "removed")
    const denied = fakeRes()

    const ctx = await requireInstanceEditor({ storage, config: authedConfig }, fakeReq({ cookie }), denied.res)
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
  })

  it("401s a garbage bearer", async () => {
    const denied = fakeRes()
    const ctx = await requireInstanceEditor(
      { storage: new InMemoryStorage(), config: baseConfig },
      fakeReq({ authorization: "Bearer nope" }),
      denied.res,
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(401)
  })

  it("403s a viewer's write-scoped PAT under requireWriteScope", async () => {
    const storage = new InMemoryStorage()
    const viewer = await seedUser(storage, { id: "vw", role: "viewer" })
    const authorization = await patHeaderFor(storage, viewer.id, ["read", "write"])
    const denied = fakeRes()

    const ctx = await requireInstanceEditor(
      { storage, config: baseConfig },
      fakeReq({ authorization }),
      denied.res,
      { requireWriteScope: true },
    )
    expect(ctx).toBeNull()
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: EDITOR_ROLE_REQUIRED })
  })
})

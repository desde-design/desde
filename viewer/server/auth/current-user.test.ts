import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig, type ViewerConfig } from "../config"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { StorageAdapter } from "../storage/types"
import { getCurrentUser } from "./current-user"
import { signSessionId } from "./session-cookie"
import { upsertTestUser } from "../__tests__/user-fixtures"

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
  sessionSecret: "sesh-secret",
  githubAuth: { clientId: "id", clientSecret: "secret" },
  githubApp: null,
  prototypeCsp: null,
  prototypeOrigin: null,
  allowedEmailDomains: null,
  seedDemoProject: true,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
}

function req(cookie?: string) {
  return { headers: { cookie } }
}

/**
 * Wraps a real StorageAdapter but rejects every call to the named method —
 * same `Proxy`-over-a-real-adapter technique as
 * `deployments-routes.test.ts`'s `makeStorageThatFailsMarkingFailedOnce`,
 * used here to prove `getCurrentUser` swallows a storage failure instead of
 * throwing (the load-bearing "never throws" contract).
 */
function makeStorageThatRejects(
  inner: StorageAdapter,
  method: "getSession" | "getUser",
): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async () => {
          throw new Error(`simulated storage failure in ${method}`)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

async function seedUserAndSession(storage: StorageAdapter, expiresAt: string) {
  const user = await upsertTestUser(storage, {
    provider: "github",
    providerUserId: "1",
    email: "Mo@Example.com",
    displayName: "Mo",
    avatarUrl: "https://x/y.png",
  })
  const session = await storage.createSession({ userId: user.id, expiresAt })
  return { user, session }
}

describe("getCurrentUser", () => {
  it("returns null when there is no cookie header", async () => {
    const storage = new InMemoryStorage()
    expect(await getCurrentUser({ storage, config: baseConfig }, req())).toBeNull()
  })

  it("resolves a valid session even when GitHub sign-in is not configured (the defect this removed)", async () => {
    // Before the sessionSecret/githubAuth split, `getCurrentUser` returned
    // null the instant `config.auth` was null, regardless of whether the
    // cookie was valid — a viewer with no GitHub App configured could hold
    // no sessions at all. `githubAuth: null` must no longer block session
    // resolution; only `sessionSecret` (always present) does the signing.
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, githubAuth: null }
    const { user, session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signed = signSessionId(config.sessionSecret, session.id)
    const got = await getCurrentUser({ storage, config }, req(`viewer_session=${signed}`))
    expect(got?.id).toBe(user.id)
  })

  it("still returns null for a garbage cookie when GitHub sign-in is not configured", async () => {
    const storage = new InMemoryStorage()
    const config = { ...baseConfig, githubAuth: null }
    expect(await getCurrentUser({ storage, config }, req("viewer_session=whatever"))).toBeNull()
  })

  it("returns null for a valid signature with no matching session row", async () => {
    const storage = new InMemoryStorage()
    const signed = signSessionId(baseConfig.sessionSecret, "nonexistent-session-id")
    const got = await getCurrentUser(
      { storage, config: baseConfig },
      req(`viewer_session=${signed}`),
    )
    expect(got).toBeNull()
  })

  it("returns null for a tampered/forged signature", async () => {
    const storage = new InMemoryStorage()
    const { session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signed = signSessionId(baseConfig.sessionSecret, session.id)
    const forged = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`
    const got = await getCurrentUser(
      { storage, config: baseConfig },
      req(`viewer_session=${forged}`),
    )
    expect(got).toBeNull()
  })

  it("returns null for a cookie signed with a different secret", async () => {
    const storage = new InMemoryStorage()
    const { session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signedWithWrongSecret = signSessionId("some-other-secret", session.id)
    const got = await getCurrentUser(
      { storage, config: baseConfig },
      req(`viewer_session=${signedWithWrongSecret}`),
    )
    expect(got).toBeNull()
  })

  it("returns null for an expired session AND sweeps the row (opportunistic delete)", async () => {
    const storage = new InMemoryStorage()
    const { session } = await seedUserAndSession(storage, new Date(Date.now() - 1000).toISOString())
    const signed = signSessionId(baseConfig.sessionSecret, session.id)

    const got = await getCurrentUser(
      { storage, config: baseConfig },
      req(`viewer_session=${signed}`),
    )
    expect(got).toBeNull()
    expect(await storage.getSession(session.id)).toBeNull()
  })

  it("returns the user for a valid, live session", async () => {
    const storage = new InMemoryStorage()
    const { user, session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signed = signSessionId(baseConfig.sessionSecret, session.id)

    const got = await getCurrentUser(
      { storage, config: baseConfig },
      req(`viewer_session=${signed}`),
    )
    expect(got?.id).toBe(user.id)
    expect(got?.email).toBe("mo@example.com")
  })

  it("never throws when storage.getSession rejects — resolves to null", async () => {
    const storage = makeStorageThatRejects(new InMemoryStorage(), "getSession")
    const signed = signSessionId(baseConfig.sessionSecret, "some-session-id")

    await expect(
      getCurrentUser({ storage, config: baseConfig }, req(`viewer_session=${signed}`)),
    ).resolves.toBeNull()
  })

  it("never throws when storage.getUser rejects — resolves to null", async () => {
    const inner = new InMemoryStorage()
    const { session } = await seedUserAndSession(inner, new Date(Date.now() + 60_000).toISOString())
    const storage = makeStorageThatRejects(inner, "getUser")
    const signed = signSessionId(baseConfig.sessionSecret, session.id)

    await expect(
      getCurrentUser({ storage, config: baseConfig }, req(`viewer_session=${signed}`)),
    ).resolves.toBeNull()
  })

  /**
   * Status is the LIVE entitlement (Task 5). `removed` is a soft delete —
   * the row survives so old comments still resolve to a name — so the only
   * thing standing between a removed account and its still-unexpired session
   * cookie is this check. The session row is swept for the same reason an
   * expired one is: the next request costs nothing and the browser stops
   * presenting a credential that can no longer work.
   */
  it("returns null for a REMOVED user's live session AND sweeps the session row", async () => {
    const storage = new InMemoryStorage()
    const { user, session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    await storage.setUserStatus(user.id, "removed")
    const signed = signSessionId(baseConfig.sessionSecret, session.id)

    const got = await getCurrentUser({ storage, config: baseConfig }, req(`viewer_session=${signed}`))
    expect(got).toBeNull()
    expect(await storage.getSession(session.id)).toBeNull()
  })

  /**
   * Regression for the Task 4 carried finding. `VIEWER_ALLOWED_EMAIL_DOMAINS`
   * was re-evaluated here on every request (audit K08). Once domain rules
   * became an ADMISSION gate and status became the live entitlement, that
   * re-check was actively wrong: with the env allowlist set and no GitHub App
   * configured, the local operator (`operator@localhost`, in nobody's
   * allowlist) signed in successfully and was then null on the second
   * request — their session dying instantly, with nothing to explain it.
   */
  it("resolves an ACTIVE user whose email is outside VIEWER_ALLOWED_EMAIL_DOMAINS — the allowlist gates admission, not live sessions", async () => {
    const storage = new InMemoryStorage()
    const config: ViewerConfig = {
      ...baseConfig,
      githubAuth: null,
      allowedEmailDomains: ["example.com"],
    }
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "local",
      email: "operator@localhost",
      displayName: "Local operator",
      avatarUrl: "",
      role: "admin",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signed = signSessionId(config.sessionSecret, session.id)

    const got = await getCurrentUser({ storage, config }, req(`viewer_session=${signed}`))
    expect(got?.id).toBe(user.id)
    // And the session survives — the old code swept it on the way out, so a
    // regression here would be silent on the first request and visible only
    // on the second.
    expect(await storage.getSession(session.id)).not.toBeNull()
  })

  /**
   * The `__Host-` cookie hardening. On an https deployment the session cookie
   * is named `__Host-viewer_session`, and the read is a HARD CUTOVER: only that
   * name is honoured. This is the anti-tossing property. Hostile prototype JS
   * on a `{slug}.{serveDomain}` sibling can set `viewer_session=<its own signed
   * value>; Domain=<registrable domain>`, which the browser would deliver to
   * the shell under the plain name. Reading only the `__Host-` name means that
   * tossed cookie is invisible, so it can never fixate a session.
   */
  const secureConfig: ViewerConfig = { ...baseConfig, publicUrl: "https://viewer.example.com" }

  it("on https reads the session ONLY under __Host-viewer_session", async () => {
    const storage = new InMemoryStorage()
    const { user, session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signed = signSessionId(secureConfig.sessionSecret, session.id)

    const got = await getCurrentUser(
      { storage, config: secureConfig },
      req(`__Host-viewer_session=${signed}`),
    )
    expect(got?.id).toBe(user.id)
  })

  it("on https IGNORES a validly-signed unprefixed viewer_session (the tossing vector is closed)", async () => {
    const storage = new InMemoryStorage()
    const { session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    // A perfectly valid, correctly-signed cookie value — the only thing wrong
    // with it is the name. On https that name is no longer read, so an attacker
    // who tosses `viewer_session=<signed>; Domain=…` gets nothing.
    const signed = signSessionId(secureConfig.sessionSecret, session.id)

    const got = await getCurrentUser(
      { storage, config: secureConfig },
      req(`viewer_session=${signed}`),
    )
    expect(got).toBeNull()
  })

  it("on http reads the plain viewer_session name (localhost dev, no __Host- prefix)", async () => {
    const storage = new InMemoryStorage()
    const { user, session } = await seedUserAndSession(
      storage,
      new Date(Date.now() + 60_000).toISOString(),
    )
    const signed = signSessionId(baseConfig.sessionSecret, session.id)

    // The __Host- name is NOT read on http, and the plain name IS.
    expect(
      await getCurrentUser(
        { storage, config: baseConfig },
        req(`__Host-viewer_session=${signed}`),
      ),
    ).toBeNull()
    expect(
      (await getCurrentUser({ storage, config: baseConfig }, req(`viewer_session=${signed}`)))?.id,
    ).toBe(user.id)
  })

  it("resolves a session when no GitHub sign-in is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-current-user-"))
    const storage = new InMemoryStorage()
    const config = loadConfig({ VIEWER_DATA_DIR: dir })
    expect(config.githubAuth).toBeNull()

    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "local",
      email: "operator@localhost",
      displayName: "Local operator",
      avatarUrl: "",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const cookie = `viewer_session=${encodeURIComponent(signSessionId(config.sessionSecret, session.id))}`

    await expect(
      getCurrentUser({ storage, config }, { headers: { cookie } }),
    ).resolves.toMatchObject({ id: user.id })
  })
})

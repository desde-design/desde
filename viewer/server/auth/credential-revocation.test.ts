import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { revokeAllCredentials } from "./credential-revocation"

/** Wraps a real adapter, replacing one method — same technique gate.test.ts's `withMethod` uses. */
function withMethod<K extends keyof InMemoryStorage>(
  inner: InMemoryStorage,
  method: K,
  impl: InMemoryStorage[K],
): InMemoryStorage {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === method) return impl
      return Reflect.get(target, prop, receiver)
    },
  }) as InMemoryStorage
}

describe("revokeAllCredentials", () => {
  it("revokes every credential kind and reports ok on the happy path", async () => {
    const storage = new InMemoryStorage()
    const user = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    const session = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    await storage.createMachineToken({
      id: "fedcba9876543210",
      userId: user.id,
      name: "ci",
      scopes: ["read"],
      tokenHash: "hash",
      expiresAt: null,
    })
    const userLinkedSignIn = await storage.createSignInToken({
      id: "sit-user",
      userId: user.id,
      email: null,
      tokenHash: "hash-a",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const emailLinkedSignIn = await storage.createSignInToken({
      id: "sit-email",
      userId: null,
      email: user.email,
      tokenHash: "hash-b",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const result = await revokeAllCredentials(storage, user)

    expect(result).toEqual({ ok: true, failures: [] })
    expect(await storage.getSession(session.id)).toBeNull()
    expect(await storage.listMachineTokensForUser(user.id)).toHaveLength(0)
    expect(await storage.getSignInToken(userLinkedSignIn.id)).toBeNull()
    expect(await storage.getSignInToken(emailLinkedSignIn.id)).toBeNull()
  })

  it("runs every step even when one throws, and reports exactly which failed", async () => {
    const inner = new InMemoryStorage()
    const user = await inner.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    const session = await inner.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const userLinkedSignIn = await inner.createSignInToken({
      id: "sit-user",
      userId: user.id,
      email: null,
      tokenHash: "hash-a",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const emailLinkedSignIn = await inner.createSignInToken({
      id: "sit-email",
      userId: null,
      email: user.email,
      tokenHash: "hash-b",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const boom = new Error("simulated machine-token deletion failure")
    const storage = withMethod(inner, "deleteMachineTokensForUser", async () => {
      throw boom
    })

    const result = await revokeAllCredentials(storage, user)

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([{ step: "machineTokens", error: boom }])
    // The two calls AFTER the throwing one in call order still ran — the
    // whole point of `Promise.allSettled` over a sequential await chain.
    expect(await inner.getSession(session.id)).toBeNull()
    expect(await inner.getSignInToken(userLinkedSignIn.id)).toBeNull()
    expect(await inner.getSignInToken(emailLinkedSignIn.id)).toBeNull()
  })

  it("reports every failing step, not just the first", async () => {
    const inner = new InMemoryStorage()
    const user = await inner.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })

    const sessionsErr = new Error("sessions boom")
    const emailErr = new Error("email-linked boom")
    let storage: InMemoryStorage = withMethod(inner, "deleteSessionsForUser", async () => {
      throw sessionsErr
    })
    storage = withMethod(storage, "deleteSignInTokensForEmail", async () => {
      throw emailErr
    })

    const result = await revokeAllCredentials(storage, user)

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([
      { step: "sessions", error: sessionsErr },
      { step: "signInTokensForEmail", error: emailErr },
    ])
  })

  it("never throws itself, even when every step fails", async () => {
    const inner = new InMemoryStorage()
    const user = await inner.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    let storage: InMemoryStorage = inner
    for (const method of [
      "deleteSessionsForUser",
      "deleteMachineTokensForUser",
      "deleteSignInTokensForUser",
      "deleteSignInTokensForEmail",
    ] as const) {
      storage = withMethod(storage, method, async () => {
        throw new Error(`${method} boom`)
      })
    }

    const result = await revokeAllCredentials(storage, user)

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(4)
  })
})

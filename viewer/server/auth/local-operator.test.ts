import { describe, expect, it } from "vitest"
import {
  LOCAL_OPERATOR_EMAIL,
  createLocalOperatorToken,
  ensureLocalOperatorUser,
  localOperatorTokensMatch,
  shouldMintLocalOperatorToken,
  signInLocalOperator,
} from "./local-operator"
import { ConflictError } from "../storage/errors"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { StorageAdapter } from "../storage/types"
import type { ViewerConfig } from "../config"

describe("createLocalOperatorToken", () => {
  it("returns 43 base64url characters", () => {
    expect(createLocalOperatorToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("returns a different token each call", () => {
    expect(createLocalOperatorToken()).not.toBe(createLocalOperatorToken())
  })
})

describe("localOperatorTokensMatch", () => {
  it("is true for identical tokens", () => {
    const token = createLocalOperatorToken()
    expect(localOperatorTokensMatch(token, token)).toBe(true)
  })

  it("is false for different tokens, including different lengths", () => {
    expect(localOperatorTokensMatch(createLocalOperatorToken(), "short")).toBe(false)
  })
})

/**
 * Fix wave 6 (codex round 6). `ensureLocalOperatorUser` is a lookup followed
 * by a create, and two callers can be between those two awaits at the same
 * time — the boot banner's URL opened in two tabs is the everyday way to get
 * there. The loser's `createUser` hits the unique constraint on
 * `operator@localhost` and used to surface as a 500 on a sign-in that had
 * actually succeeded for the other tab.
 */
describe("ensureLocalOperatorUser under a creation race", () => {
  /**
   * Storage that loses the race exactly once: the first `createUser` writes
   * the row (the winner's write) and THEN throws `ConflictError`, which is
   * precisely what the loser observes.
   */
  function racingStorage(storage: InMemoryStorage): StorageAdapter {
    let raced = false
    return new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== "createUser") return Reflect.get(target, prop, receiver)
        return async (input: Parameters<StorageAdapter["createUser"]>[0]) => {
          if (raced) return storage.createUser(input)
          raced = true
          await storage.createUser(input)
          throw new ConflictError("email already in use")
        }
      },
    }) as StorageAdapter
  }

  it("returns the row the winner created instead of throwing", async () => {
    const storage = new InMemoryStorage()
    const user = await ensureLocalOperatorUser(racingStorage(storage))
    expect(user.email).toBe(LOCAL_OPERATOR_EMAIL)
    expect(user.role).toBe("admin")
    // One row, not two — the loser adopted the winner's, it did not retry.
    expect(await storage.countUsers()).toBe(1)
  })

  it("rethrows a conflict that is NOT the operator row appearing", async () => {
    const storage = new InMemoryStorage()
    const alwaysConflicts = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== "createUser") return Reflect.get(target, prop, receiver)
        return async () => {
          throw new ConflictError("email already in use")
        }
      },
    }) as StorageAdapter
    await expect(ensureLocalOperatorUser(alwaysConflicts)).rejects.toThrow(ConflictError)
  })
})

describe("signInLocalOperator", () => {
  it("creates the operator user and a live session", async () => {
    const storage = new InMemoryStorage()
    const result = await signInLocalOperator(storage, 3600)
    expect(result.admitted).toBe(true)
    if (!result.admitted) throw new Error("unreachable")
    const session = await storage.getSession(result.sessionId)
    expect(session).not.toBeNull()
    const user = await storage.getUser(session!.userId)
    expect(user?.email).toBe(LOCAL_OPERATOR_EMAIL)
  })

  it("reuses the same user across repeated sign-ins", async () => {
    const storage = new InMemoryStorage()
    const first = await signInLocalOperator(storage, 3600)
    const second = await signInLocalOperator(storage, 3600)
    if (!first.admitted || !second.admitted) throw new Error("unreachable")
    const a = await storage.getSession(first.sessionId)
    const b = await storage.getSession(second.sessionId)
    expect(a!.userId).toBe(b!.userId)
    expect(first.sessionId).not.toBe(second.sessionId)
  })

  /**
   * Fix wave M1 review. The boot token is equivalent to a password for the
   * whole deployment — but that password must stop working the moment an
   * admin explicitly removes the operator's account, exactly like any other
   * removed account's credentials. Before this fix, `signInLocalOperator`
   * found-or-created the row and minted a session unconditionally, so a
   * removed operator could self-readmit forever with nothing but the printed
   * token — the one case `admitSignIn`'s `removed` rung exists to close was
   * unreachable from this path, because it never runs through the gate at
   * all.
   */
  it("refuses to mint a session once the operator row has been removed", async () => {
    const storage = new InMemoryStorage()
    const first = await signInLocalOperator(storage, 3600)
    if (!first.admitted) throw new Error("unreachable")
    const operator = await storage.getUser((await storage.getSession(first.sessionId))!.userId)
    await storage.setUserStatus(operator!.id, "removed")

    const result = await signInLocalOperator(storage, 3600)
    expect(result).toEqual({ admitted: false })
  })
})

/**
 * The boot gate, extracted from `server/index.ts` so it can be tested at all.
 *
 * `index.ts` is the process entry — it calls `next()` and `listen`, so there
 * is no seam to drive it from a test. While the condition lived inline there,
 * a regression would have passed the entire suite.
 *
 * It is ONE condition now. The second conjunct — refuse to mint under
 * `VIEWER_ALLOWED_EMAIL_DOMAINS` — went away with the admission gate
 * (viewer-membership Task 4): that env var is no longer an admission check
 * rechecked on every request, it is converted into stored domain rules at
 * boot, and stored rules have no say over an account that already exists. See
 * `shouldMintLocalOperatorToken`'s doc comment for the full reasoning.
 */
describe("shouldMintLocalOperatorToken", () => {
  it("mints when GitHub sign-in is unconfigured", () => {
    expect(shouldMintLocalOperatorToken({ githubAuth: null })).toBe(true)
  })

  it("refuses when GitHub sign-in IS configured — a real provider must not carry a printed master key", () => {
    expect(
      shouldMintLocalOperatorToken({ githubAuth: { clientId: "id", clientSecret: "secret" } }),
    ).toBe(false)
  })

  /**
   * The regression this replaced test guards against, stated as a property:
   * the sign-in allowlist env var must have NO bearing on whether an
   * unconfigured deployment can be signed into at all. While it did, setting
   * that variable with no GitHub App configured left nobody able to sign in.
   */
  it("still mints when a sign-in allowlist is configured — the env var no longer gates local sign-in", () => {
    // Carries `allowedEmailDomains` deliberately: the function's parameter
    // type no longer names it, and passing a config that HAS it is what shows
    // the value cannot influence the decision.
    const config: Pick<ViewerConfig, "githubAuth" | "allowedEmailDomains"> = {
      githubAuth: null,
      allowedEmailDomains: ["corp.example"],
    }
    expect(shouldMintLocalOperatorToken(config)).toBe(true)
  })
})

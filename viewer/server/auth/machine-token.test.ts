import { beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { StorageAdapter } from "../storage/types"
import {
  LAST_USED_COARSENING_MS,
  generateMachineToken,
  hashTokenSecret,
  parseMachineToken,
  resetTouchFailureWarning,
  verifyMachineToken,
} from "./machine-token"
import { upsertTestUser } from "../__tests__/user-fixtures"

// `touchFailureWarned` is a once-PER-PROCESS flag, and a vitest worker reuses
// the module across every test in this file. Two tests below deliberately fail
// a touch, so anything asserting on the warning has to start from a known
// state. Clearing it here means a future test can assert a call count through
// the ordinary import, instead of discovering the hard way that the count
// depends on which test ran first.
beforeEach(() => {
  resetTouchFailureWarning()
})

const gh = {
  provider: "github" as const,
  providerUserId: "mt-user",
  email: "mo@example.com",
  displayName: "Mo",
  avatarUrl: "https://x/y.png",
}

/**
 * Wraps a real StorageAdapter but rejects every call to the named method —
 * same technique `current-user.test.ts` uses to prove the "never throws"
 * contract holds even when the underlying storage blows up.
 */
function makeStorageThatRejects(
  inner: StorageAdapter,
  method: "getMachineToken" | "getUser",
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

async function seedToken(
  storage: StorageAdapter,
  opts: { scopes?: ("read" | "write")[]; expiresAt?: string | null; lastUsedAt?: string } = {},
) {
  const user = await upsertTestUser(storage, gh)
  const gen = generateMachineToken()
  await storage.createMachineToken({
    id: gen.id,
    userId: user.id,
    name: "t",
    scopes: opts.scopes ?? ["read"],
    tokenHash: gen.tokenHash,
    expiresAt: opts.expiresAt ?? null,
  })
  if (opts.lastUsedAt) {
    await storage.touchMachineToken(gen.id, opts.lastUsedAt)
  }
  return { user, gen }
}

describe("generateMachineToken", () => {
  it("produces a token matching the dsv_<id>_<secret> format and a matching hash", () => {
    const gen = generateMachineToken()
    expect(gen.token).toBe(`dsv_${gen.id}_${gen.secret}`)
    expect(gen.id).toMatch(/^[0-9a-f]{16}$/)
    expect(gen.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(gen.tokenHash).toBe(hashTokenSecret(gen.secret))
  })

  it("never repeats an id or secret across calls (CSPRNG, not Math.random)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const gen = generateMachineToken()
      expect(seen.has(gen.token)).toBe(false)
      seen.add(gen.token)
    }
  })
})

describe("parseMachineToken", () => {
  it("parses a well-formed token back into id + secret", () => {
    const gen = generateMachineToken()
    expect(parseMachineToken(gen.token)).toEqual({ id: gen.id, secret: gen.secret })
  })

  const validId = "0123456789abcdef"
  const validSecret = "A".repeat(43)
  const validToken = `dsv_${validId}_${validSecret}`

  it.each<[string, unknown]>([
    ["empty string", ""],
    ["missing prefix", `${validId}_${validSecret}`],
    ["wrong prefix", `xyz_${validId}_${validSecret}`],
    ["id too short", `dsv_${validId.slice(1)}_${validSecret}`],
    ["id too long", `dsv_${validId}0_${validSecret}`],
    ["id uppercase hex", `dsv_${validId.toUpperCase()}_${validSecret}`],
    ["id non-hex chars", `dsv_${"g".repeat(16)}_${validSecret}`],
    ["secret too short", `dsv_${validId}_${validSecret.slice(1)}`],
    ["secret too long", `dsv_${validId}_${validSecret}A`],
    ["secret has padding char", `dsv_${validId}_${validSecret.slice(0, 42)}=`],
    ["missing separators entirely", `ptv${validId}${validSecret}`],
    ["null", null],
    ["undefined", undefined],
    ["number", 12345],
    ["object", { token: validToken }],
  ])("returns null for %s", (_label, input) => {
    expect(parseMachineToken(input)).toBeNull()
  })

  it("accepts the boundary-valid shape", () => {
    expect(parseMachineToken(validToken)).toEqual({ id: validId, secret: validSecret })
  })
})

describe("verifyMachineToken", () => {
  it("resolves { token, user } for a freshly minted token (happy path)", async () => {
    const storage = new InMemoryStorage()
    const { user, gen } = await seedToken(storage)

    const result = await verifyMachineToken({ storage }, gen.token)

    expect(result).not.toBeNull()
    expect(result?.user.id).toBe(user.id)
    expect(result?.token.id).toBe(gen.id)
  })

  it("returns null for the right id but the wrong secret", async () => {
    const storage = new InMemoryStorage()
    const { gen } = await seedToken(storage)
    const other = generateMachineToken()

    const forged = `dsv_${gen.id}_${other.secret}`
    expect(await verifyMachineToken({ storage }, forged)).toBeNull()
  })

  it("returns null for an unknown id", async () => {
    const storage = new InMemoryStorage()
    await seedToken(storage)
    const unrelated = generateMachineToken()

    expect(await verifyMachineToken({ storage }, unrelated.token)).toBeNull()
  })

  it("returns null for a malformed bearer value", async () => {
    const storage = new InMemoryStorage()
    expect(await verifyMachineToken({ storage }, "not-a-token")).toBeNull()
    expect(await verifyMachineToken({ storage }, "")).toBeNull()
    expect(await verifyMachineToken({ storage }, undefined)).toBeNull()
  })

  it("returns null for an expired token", async () => {
    const storage = new InMemoryStorage()
    const past = new Date(Date.now() - 60_000).toISOString()
    const { gen } = await seedToken(storage, { expiresAt: past })

    expect(await verifyMachineToken({ storage }, gen.token)).toBeNull()
  })

  it("accepts a token with a future expiry", async () => {
    const storage = new InMemoryStorage()
    const future = new Date(Date.now() + 60_000).toISOString()
    const { user, gen } = await seedToken(storage, { expiresAt: future })

    const result = await verifyMachineToken({ storage }, gen.token)
    expect(result?.user.id).toBe(user.id)
  })

  it("returns null when the token's owning user no longer exists", async () => {
    const storage = new InMemoryStorage()
    const { user, gen } = await seedToken(storage)
    // Simulate account deletion by deleting all the user's sessions/tokens
    // and removing the user row isn't directly exposed — emulate the miss
    // with a storage wrapper whose getUser always misses for this id.
    const wrapped = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "getUser") {
          return async (id: string) => (id === user.id ? null : (target as StorageAdapter).getUser(id))
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    expect(await verifyMachineToken({ storage: wrapped }, gen.token)).toBeNull()
  })

  it("never throws when storage.getMachineToken rejects — resolves to null", async () => {
    const storage = makeStorageThatRejects(new InMemoryStorage(), "getMachineToken")
    await expect(
      verifyMachineToken({ storage }, generateMachineToken().token),
    ).resolves.toBeNull()
  })

  it("never throws when storage.getUser rejects — resolves to null", async () => {
    const inner = new InMemoryStorage()
    const { gen } = await seedToken(inner)
    const storage = makeStorageThatRejects(inner, "getUser")

    await expect(verifyMachineToken({ storage }, gen.token)).resolves.toBeNull()
  })

  describe("lastUsedAt coarsening", () => {
    it("touches lastUsedAt when it was never set", async () => {
      const storage = new InMemoryStorage()
      const { gen } = await seedToken(storage)
      const touchSpy = vi.spyOn(storage, "touchMachineToken")

      await verifyMachineToken({ storage }, gen.token)

      expect(touchSpy).toHaveBeenCalledTimes(1)
      expect(touchSpy).toHaveBeenCalledWith(gen.id, expect.any(String))
    })

    it("touches lastUsedAt when it is older than the coarsening window", async () => {
      const storage = new InMemoryStorage()
      const stale = new Date(Date.now() - LAST_USED_COARSENING_MS - 1_000).toISOString()
      const { gen } = await seedToken(storage, { lastUsedAt: stale })
      const touchSpy = vi.spyOn(storage, "touchMachineToken")

      await verifyMachineToken({ storage }, gen.token)

      expect(touchSpy).toHaveBeenCalledTimes(1)
    })

    it("does NOT touch lastUsedAt when it is fresh (within the coarsening window)", async () => {
      const storage = new InMemoryStorage()
      const fresh = new Date(Date.now() - 1_000).toISOString()
      const { gen } = await seedToken(storage, { lastUsedAt: fresh })
      const touchSpy = vi.spyOn(storage, "touchMachineToken")

      await verifyMachineToken({ storage }, gen.token)

      expect(touchSpy).not.toHaveBeenCalled()
    })

    it("resolves without waiting for the lastUsedAt touch to settle", async () => {
      const storage = new InMemoryStorage()
      const { user, gen } = await seedToken(storage)

      let releaseTouch: (() => void) | undefined
      const pendingTouch = new Promise<void>((resolve) => {
        releaseTouch = resolve
      })
      const wrapped = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "touchMachineToken") {
            return () => pendingTouch
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("verifyMachineToken appears to have awaited the touch")), 100)
      })

      const result = await Promise.race([verifyMachineToken({ storage: wrapped }, gen.token), timeout])
      expect((result as { user: { id: string } } | null)?.user.id).toBe(user.id)

      // Let the still-pending touch settle so nothing leaks past this test.
      releaseTouch?.()
    })

    it("a rejecting touch never surfaces as an unhandled rejection or a verify failure", async () => {
      const storage = new InMemoryStorage()
      const { user, gen } = await seedToken(storage)
      const wrapped = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "touchMachineToken") {
            return async () => {
              throw new Error("simulated touch failure")
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      // The rejection is now reported once per process (fix wave M3) rather
      // than swallowed entirely — silenced here so it doesn't look like a
      // real failure in the suite output.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const result = await verifyMachineToken({ storage: wrapped }, gen.token)
        expect(result?.user.id).toBe(user.id)
        // Give the fire-and-forget rejection a tick to (not) blow up.
        await new Promise((resolve) => setTimeout(resolve, 10))
      } finally {
        warn.mockRestore()
      }
    })

    /**
     * Fix wave M3. The touch used to be dispatched INSIDE the function's
     * outer `try`, so a storage impl that threw SYNCHRONOUSLY (before
     * returning a promise — e.g. better-sqlite3's `prepare()` blowing up on
     * a schema problem) was caught by the catch-all and turned an
     * ALREADY-VERIFIED token into `null`, i.e. a 401 on a perfectly valid
     * credential. A bookkeeping write must not be able to revoke a token by
     * failing. The touch now lives after the `try`.
     */
    it("a SYNCHRONOUSLY-throwing touch does not turn a valid token into a 401", async () => {
      const storage = new InMemoryStorage()
      const { user, gen } = await seedToken(storage)
      const wrapped = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "touchMachineToken") {
            // Throws before ever producing a promise — the shape the old
            // in-`try` placement swallowed into a null result.
            return () => {
              throw new Error("simulated synchronous touch failure")
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const result = await verifyMachineToken({ storage: wrapped }, gen.token)
        expect(result).not.toBeNull()
        expect(result?.user.id).toBe(user.id)
      } finally {
        warn.mockRestore()
      }
    })

    /**
     * Fix wave M3, second half. A fully silent `.catch(() => {})` made a
     * PERMANENTLY broken touch path undetectable: every request keeps
     * succeeding while `lastUsedAt` silently never advances, so "when was
     * this token last used" — the field an operator uses to decide what's
     * safe to revoke — quietly reads `Never` forever. One warning per
     * process, not per request: the touch fires on nearly every
     * authenticated request, and a per-request log is just a slower way of
     * being silent.
     */
    it("warns ONCE per process on a failing touch, not per request", async () => {
      // The once-flag is cleared by this file's `beforeEach`. This used to
      // need `vi.resetModules()` and a dynamic re-import instead, because two
      // earlier tests here trip the flag — a workaround that worked but was
      // invisible to anyone adding a second test like this one.
      const storage = new InMemoryStorage()
      const user = await upsertTestUser(storage, gh)
      const g1 = generateMachineToken()
      const g2 = generateMachineToken()
      for (const g of [g1, g2]) {
        await storage.createMachineToken({
          id: g.id,
          userId: user.id,
          name: "t",
          scopes: ["read"],
          tokenHash: g.tokenHash,
        })
      }
      const wrapped = new Proxy(storage, {
        get(target, prop, receiver) {
          if (prop === "touchMachineToken") {
            return async () => {
              throw new Error("simulated touch failure")
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        await verifyMachineToken({ storage: wrapped }, g1.token)
        await verifyMachineToken({ storage: wrapped }, g2.token)
        await new Promise((resolve) => setTimeout(resolve, 10))

        expect(warn).toHaveBeenCalledTimes(1)
        // The warning must never carry the token plaintext or its hash.
        const logged = warn.mock.calls.flat().map(String).join(" ")
        expect(logged).not.toContain(g1.secret)
        expect(logged).not.toContain(g1.tokenHash)
      } finally {
        warn.mockRestore()
      }
    })
  })
})

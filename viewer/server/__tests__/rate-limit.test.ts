import express from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { createApp } from "./test-app"
import { createSwappableApp } from "./swappable-app"
import { loadConfig } from "../config"
import { tmpViewerDataDir } from "./test-config"
import type { AssetStore } from "../assets/types"
import { classifyRateLimitLane, createConcurrencyLimiter, createFixedWindowCounter } from "../rate-limit"
import { testGithubRuntime } from "./test-github-runtime"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

/**
 * ONE stable app object for this whole file — see `./swappable-app.ts`.
 * 3 listening servers per run before this; every test calls `makeApp` once.
 *
 * Note the limiter's own state is per-app-INSTANCE (created inside
 * `createApiRateLimit()`), so each `makeApp` call still gets a fresh budget —
 * only the listening socket is shared. That is what keeps the flood tests
 * independent of each other.
 */
const stable = createSwappableApp()

function makeApp(storage: InMemoryStorage): express.Express {
  stable.use(
    createApp({
      storage,
      assets: nullAssets,
      config: loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() }),
      bridgeScript: "// bridge",
      github: testGithubRuntime(),
    }),
  )
  return stable.app
}

describe("classifyRateLimitLane", () => {
  it("matches exactly the four unauthenticated-abuse lanes", () => {
    expect(classifyRateLimitLane("POST", "/projects/resolve")).toBe("resolve")
    expect(classifyRateLimitLane("POST", "/projects/p1/participants")).toBe("participants")
    expect(classifyRateLimitLane("POST", "/projects/p1/comments")).toBe("comment-write")
    expect(classifyRateLimitLane("PATCH", "/projects/p1/comments/c1")).toBe("comment-write")
    expect(classifyRateLimitLane("DELETE", "/projects/p1/comments/c1")).toBe("comment-write")
    expect(classifyRateLimitLane("POST", "/projects/p1/comments/c1/replies")).toBe("comment-write")
    expect(classifyRateLimitLane("GET", "/auth/github")).toBe("auth")
    expect(classifyRateLimitLane("GET", "/auth/github/callback")).toBe("auth")
    // viewer-membership Task 6: the invite-acceptance link is a GET under
    // /auth/**, already covered by the existing prefix rule — no source
    // change needed, just pinning that it stays covered.
    expect(classifyRateLimitLane("GET", "/auth/invite/dsi_0123456789abcdef_secret")).toBe("auth")
    // Fix wave 6: the GET renders a confirmation page and the POST that
    // page's form performs is what redeems. The lane rule is method-blind
    // under `/auth/**`, so both are covered — pinned because the POST is now
    // the half that spends the credential, and losing it here would leave
    // the only rate limit on redemption pointed at the inert half.
    expect(classifyRateLimitLane("POST", "/auth/invite/dsi_0123456789abcdef_secret")).toBe(
      "auth",
    )
    // viewer-membership Task 14. Same story: both new routes live under
    // /auth/**, so the existing prefix rule already covers them. Pinned here
    // because "covered by an existing rule" is only true until somebody
    // narrows that rule, and these two are the reason it must stay wide —
    // POST /auth/magic-link is the one unauthenticated route that can cause
    // an outbound email, and GET /auth/signin/<token> is a bare-GET
    // credential redemption.
    expect(classifyRateLimitLane("POST", "/auth/magic-link")).toBe("auth")
    expect(classifyRateLimitLane("GET", "/auth/signin/dss_0123456789abcdef_secret")).toBe("auth")
    expect(classifyRateLimitLane("POST", "/auth/signin/dss_0123456789abcdef_secret")).toBe(
      "auth",
    )
    // viewer-membership M1: these three are ADMIN-authenticated (unlike
    // everything else in this lane), but each mints a credential and the two
    // invite routes can trigger an outbound email — the same risk class
    // `auth` already covers, so a compromised or scripted admin session is
    // bounded the same way a credential-stuffing replay of the OAuth
    // callback is.
    expect(classifyRateLimitLane("POST", "/instance/invites")).toBe("auth")
    expect(classifyRateLimitLane("POST", "/instance/invites/inv-1/regenerate")).toBe("auth")
    expect(classifyRateLimitLane("POST", "/instance/members/user-1/signin-link")).toBe("auth")
    // The reads stay unlimited — GET /instance/invites (the list) is not the
    // credential-minting action, only its POST sibling is.
    expect(classifyRateLimitLane("GET", "/instance/invites")).toBeNull()
  })

  /**
   * The property this whole module lives or dies on. An SSE route is a
   * long-lived connection: counting it is useless, and refusing a reconnect
   * storm after a proxy hiccup would break the review surface for everyone.
   * Every non-auth lane above therefore requires a non-GET method, so a
   * future prefix edit cannot sweep a stream in by accident.
   */
  it("NEVER matches a stream, or any other GET outside /auth", () => {
    expect(classifyRateLimitLane("GET", "/projects/p1/comments/stream")).toBeNull()
    expect(classifyRateLimitLane("GET", "/deployments/d1/log/stream")).toBeNull()
    expect(classifyRateLimitLane("GET", "/projects/p1/comments")).toBeNull()
    expect(classifyRateLimitLane("GET", "/projects/p1/participants")).toBeNull()
    expect(classifyRateLimitLane("GET", "/projects")).toBeNull()
    expect(classifyRateLimitLane("HEAD", "/projects/p1/comments")).toBeNull()
  })

  it("leaves the authenticated write surface alone", () => {
    // Deployments, tokens, members, repo connect and webhooks are all
    // credential-gated; a limiter there would be a denial-of-service on the
    // operator, not on an attacker.
    expect(classifyRateLimitLane("POST", "/projects")).toBeNull()
    expect(classifyRateLimitLane("POST", "/projects/p1/deployments")).toBeNull()
    expect(classifyRateLimitLane("POST", "/tokens")).toBeNull()
    expect(classifyRateLimitLane("POST", "/projects/p1/members")).toBeNull()
    expect(classifyRateLimitLane("POST", "/webhooks/github")).toBeNull()
  })
})

describe("createFixedWindowCounter", () => {
  it("allows up to `max` accumulated cost, then refuses", () => {
    const counter = createFixedWindowCounter({ windowMs: 60_000, max: 3 })
    expect(counter.hit("k").allowed).toBe(true)
    expect(counter.hit("k").allowed).toBe(true)
    expect(counter.hit("k").allowed).toBe(true)
    expect(counter.hit("k").allowed).toBe(false)
    // A different key has its own budget.
    expect(counter.hit("other").allowed).toBe(true)
  })

  it("charges `cost` in one go, so a 20-recipient batch counts as 20", () => {
    const counter = createFixedWindowCounter({ windowMs: 60_000, max: 25 })
    expect(counter.hit("project", 20).allowed).toBe(true)
    expect(counter.hit("project", 20).allowed).toBe(false)
  })

  it("reports a Retry-After of at least one second, never zero", () => {
    const counter = createFixedWindowCounter({ windowMs: 1_000, max: 1 })
    counter.hit("k")
    expect(counter.hit("k").retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it("bounds its key map — an attacker-chosen key space cannot grow it forever", () => {
    const counter = createFixedWindowCounter({ windowMs: 60_000, max: 1, maxKeys: 4 })
    for (let i = 0; i < 200; i++) counter.hit(`ip-${i}`)
    // Eviction can only ever FORGIVE, so the observable contract is simply
    // that fresh keys keep being accepted rather than the process growing.
    expect(counter.hit("ip-fresh").allowed).toBe(true)
  })
})

describe("the limiter as mounted (security audit S6)", () => {
  it("429s a resolve flood, with a Retry-After header", async () => {
    const app = makeApp(new InMemoryStorage())
    let limited: request.Response | null = null
    // The default budget is 60/min; 80 probes is a flood by any reading and
    // still runs in well under a second on loopback.
    for (let i = 0; i < 80; i++) {
      const res = await request(app).post("/api/v1/projects/resolve").send({ remoteUrl: `/acme/repo-${i}` })
      if (res.status === 429) {
        limited = res
        break
      }
    }
    expect(limited).not.toBeNull()
    expect(limited!.body).toEqual({ error: "Too many requests" })
    expect(Number(limited!.headers["retry-after"])).toBeGreaterThanOrEqual(1)
  })

  it("does not limit reads — a project list poll is never refused", async () => {
    const app = makeApp(new InMemoryStorage())
    for (let i = 0; i < 80; i++) {
      expect((await request(app).get("/api/v1/projects")).status).toBe(200)
    }
  })

  it("counts each lane separately — a resolve flood does not lock out commenting", async () => {
    const storage = new InMemoryStorage()
    const app = makeApp(storage)
    // `public-link`: this test's caller is anonymous, and under
    // Authorization v2 that is the only access value it can comment on.
    const projectId = (await storage.createProject({ slug: "acme", name: "Acme", access: "public-link" })).id
    for (let i = 0; i < 80; i++) {
      await request(app).post("/api/v1/projects/resolve").send({ remoteUrl: `/acme/repo-${i}` })
    }
    const commented = await request(app)
      .post(`/api/v1/projects/${projectId}/comments`)
      .send({
        position: { anchorSelector: "#x", page: "/" },
        body: "still able to review",
        author: { uid: "viewer:a", displayName: "A", email: "", photoURL: "" },
      })
    expect(commented.status).toBe(201)
  })
})

describe("createConcurrencyLimiter", () => {
  it("allows up to max concurrent holders per key", () => {
    const limiter = createConcurrencyLimiter({ max: 2 })
    expect(limiter.acquire("a")).not.toBeNull()
    expect(limiter.acquire("a")).not.toBeNull()
    expect(limiter.acquire("a")).toBeNull()
  })

  it("keys are independent", () => {
    const limiter = createConcurrencyLimiter({ max: 1 })
    expect(limiter.acquire("a")).not.toBeNull()
    expect(limiter.acquire("b")).not.toBeNull()
  })

  it("frees the slot on release", () => {
    const limiter = createConcurrencyLimiter({ max: 1 })
    const release = limiter.acquire("a")
    expect(limiter.acquire("a")).toBeNull()
    release?.()
    expect(limiter.acquire("a")).not.toBeNull()
  })

  it("release is IDEMPOTENT, so a double teardown cannot leak the cap upward", () => {
    // SSE cleanup is reachable by more than one path (close-before-subscribe
    // vs close-after-subscribe), so a non-idempotent release would decrement a
    // slot the caller no longer owns and the effective cap would drift up.
    const limiter = createConcurrencyLimiter({ max: 1 })
    const release = limiter.acquire("a")
    release?.()
    release?.()
    release?.()
    expect(limiter.countFor("a")).toBe(0)
    expect(limiter.acquire("a")).not.toBeNull()
    expect(limiter.acquire("a")).toBeNull()
  })

  it("forgets a key once its last holder releases, so the map does not grow", () => {
    const limiter = createConcurrencyLimiter({ max: 2 })
    const a = limiter.acquire("k")
    const b = limiter.acquire("k")
    a?.()
    expect(limiter.countFor("k")).toBe(1)
    b?.()
    expect(limiter.countFor("k")).toBe(0)
  })

  it("bounds how many distinct keys it tracks", () => {
    // A map keyed by client address is a memory-exhaustion primitive when the
    // attacker picks the keys. Held slots are never evicted; only idle keys.
    const limiter = createConcurrencyLimiter({ max: 5, maxKeys: 3 })
    const held = ["a", "b", "c"].map((k) => limiter.acquire(k))
    expect(held.every((r) => r !== null)).toBe(true)
    expect(limiter.acquire("d")).toBeNull()
    held[0]?.()
    expect(limiter.acquire("d")).not.toBeNull()
  })
})

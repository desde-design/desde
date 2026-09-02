/**
 * Per-IP request limiting for the viewer's UNAUTHENTICATED write surface
 * (security audit finding S6).
 *
 * Before this there was no counter anywhere in `viewer/server` — measured in
 * the audit as 500 unauthenticated `POST /projects/resolve` probes answered
 * 200 in 220 ms, and 300 anonymous 10 KB comments accepted in a serial loop.
 * That is the multiplier that turns a single-request disclosure (S1) or a
 * single outbound email (B5) into an inventory scan or a mail relay, so the
 * limiter is deliberately mounted in front of exactly those lanes rather than
 * globally:
 *
 *   - `POST /projects/resolve`            — the unauthenticated repo oracle
 *   - `POST /projects/:id/participants`   — the invite lane, i.e. outbound mail
 *   - comment WRITES (POST/PATCH/DELETE)  — anonymous storage growth + mail
 *   - `/auth/**`                          — sign-in / OAuth callback
 *
 * **The SSE streams are never limited, and that is load-bearing, not an
 * omission.** `GET /projects/:id/comments/stream` and the build-log stream are
 * long-lived connections; a limiter in front of them would either count a
 * single stream once (useless) or refuse a reconnect storm that is the normal
 * consequence of a proxy hiccup (harmful). Every lane matched below is
 * therefore either a non-GET method or an explicit `/auth` path, so no GET
 * stream route can ever be swept in by a future prefix edit.
 *
 * Deliberately hand-rolled rather than pulling in `express-rate-limit`: the
 * viewer ships four runtime dependencies on purpose (express, nodemailer, tar,
 * tsx), and what is needed here is one fixed-window counter with a bounded
 * map. A dependency would be more code, not less.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express"

/** One fixed window's state for one key. */
interface WindowState {
  /** Epoch ms at which this window opened. */
  startedAt: number
  count: number
}

export interface FixedWindowCounterOptions {
  windowMs: number
  /** Maximum accumulated cost per key per window. */
  max: number
  /**
   * Hard bound on how many distinct keys are tracked. An unbounded map keyed
   * by client IP is itself a memory-exhaustion primitive — the attacker
   * picks the keys — so the counter evicts rather than grows without limit.
   * Eviction can only ever FORGIVE requests (a forgotten key starts a fresh
   * window), never invent a refusal, which is the correct failure direction
   * for a limiter that sits in front of the sign-in route.
   */
  maxKeys?: number
}

export interface FixedWindowCounter {
  /**
   * Records `cost` against `key` and reports whether it stayed within the
   * limit. `retryAfterSeconds` is the whole number of seconds until the
   * current window closes (never 0, so a `Retry-After: 0` can't tell a
   * client to retry immediately).
   */
  hit(key: string, cost?: number): { allowed: boolean; retryAfterSeconds: number }
}

const DEFAULT_MAX_KEYS = 10_000

/**
 * A fixed-window counter. Fixed window rather than sliding: the burst it
 * permits at a window boundary (up to 2x `max` across the seam) is
 * irrelevant at these limits, and the sliding alternative costs a per-key
 * timestamp list — i.e. attacker-controlled memory — to buy precision
 * nothing here needs.
 */
export function createFixedWindowCounter(options: FixedWindowCounterOptions): FixedWindowCounter {
  const { windowMs, max } = options
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  const windows = new Map<string, WindowState>()

  function prune(now: number): void {
    for (const [key, state] of windows) {
      if (now - state.startedAt >= windowMs) windows.delete(key)
    }
    // Still over budget after dropping every expired window: evict in
    // insertion order (Map iteration order), which is the closest thing to
    // "oldest first" available without a second index.
    if (windows.size > maxKeys) {
      const overflow = windows.size - maxKeys
      let dropped = 0
      for (const key of windows.keys()) {
        windows.delete(key)
        if (++dropped >= overflow) break
      }
    }
  }

  return {
    hit(key, cost = 1) {
      const now = Date.now()
      const existing = windows.get(key)
      const state =
        existing && now - existing.startedAt < windowMs ? existing : { startedAt: now, count: 0 }
      state.count += cost
      windows.set(key, state)
      if (windows.size > maxKeys) prune(now)
      const retryAfterSeconds = Math.max(1, Math.ceil((state.startedAt + windowMs - now) / 1000))
      return { allowed: state.count <= max, retryAfterSeconds }
    },
  }
}

/** The lanes the API limiter recognises. `null` means "not limited". */
export type RateLimitLane = "resolve" | "participants" | "comment-write" | "auth"

export interface ApiRateLimitOptions {
  /** Per-lane overrides; anything omitted uses the default below. */
  limits?: Partial<Record<RateLimitLane, FixedWindowCounterOptions>>
}

/**
 * Defaults are set well above anything a human reviewer produces and well
 * below what makes the abuse in S1/B5 worthwhile. They are per client IP per
 * lane, so a shared office NAT sees them as a shared budget — sized with that
 * in mind (a reviewer posting a comment every 5 seconds for a whole minute
 * still fits).
 */
const DEFAULT_LIMITS: Record<RateLimitLane, FixedWindowCounterOptions> = {
  // The repo-existence oracle. A real Editor calls this once per project
  // open; a wordlist walk needs thousands.
  resolve: { windowMs: 60_000, max: 60 },
  // Every accepted invite is a potential outbound email to an address the
  // caller chose. B5 also requires an identified caller now, so this is the
  // second wall, not the only one.
  participants: { windowMs: 60 * 60_000, max: 60 },
  // Anonymous comment writes grow the SQLite database and can enqueue mail.
  "comment-write": { windowMs: 60_000, max: 120 },
  // Sign-in start + OAuth callback. Limited to blunt credential-stuffing
  // style replay of the callback, not to gate normal sign-in.
  auth: { windowMs: 60_000, max: 60 },
}

/**
 * Classifies a request into a rate-limited lane, or `null` for everything
 * else. `path` is relative to the `/api/v1` mount.
 *
 * Exported for direct testing: the interesting property is not "does a 429
 * happen" but "is the SSE stream excluded", which is a pure question about
 * this function.
 */
export function classifyRateLimitLane(method: string, path: string): RateLimitLane | null {
  const upper = method.toUpperCase()
  // `/auth/github`, `/auth/github/callback`, `/auth/logout`, … — the only
  // lane that intentionally includes GET, because sign-in IS a navigation.
  if (path === "/auth" || path.startsWith("/auth/")) return "auth"

  // Everything below is a mutation. Requiring a non-GET method is what
  // structurally guarantees no SSE stream (`GET …/comments/stream`, `GET
  // …/build/stream`) can ever be matched here.
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return null

  if (upper === "POST" && path === "/projects/resolve") return "resolve"

  // `/projects/<id>/participants` — POST only (the GET is a read).
  if (upper === "POST" && /^\/projects\/[^/]+\/participants$/.test(path)) return "participants"

  // `/projects/<id>/comments`, `…/comments/<id>`, `…/comments/<id>/replies`.
  if (/^\/projects\/[^/]+\/comments(\/|$)/.test(path)) return "comment-write"

  // Instance invites and admin-issued sign-in links (M1) — every one of
  // these mints a credential and, for the two invite routes, can trigger an
  // outbound email, exactly the shape `participants` above is limited for.
  // They are admin-only (`requireInstanceAdmin`), so this is defense in
  // depth against a compromised or scripted admin session rather than an
  // anonymous-caller concern — the same posture `auth` already has for the
  // OAuth callback. Grouped into the `auth` lane rather than a new one: a
  // dedicated lane would need its own limits tuned for essentially the same
  // "credential-minting" risk class `auth` already covers.
  if (upper === "POST" && path === "/instance/invites") return "auth"
  if (upper === "POST" && /^\/instance\/invites\/[^/]+\/regenerate$/.test(path)) return "auth"
  if (upper === "POST" && /^\/instance\/members\/[^/]+\/signin-link$/.test(path)) return "auth"

  return null
}

/**
 * The client key. `req.ip` honours Express's `trust proxy` setting; an
 * operator terminating TLS at a reverse proxy MUST set it (see
 * `viewer/.env.example` / README) or every request keys to the proxy's
 * address and the limits become global rather than per-client. Falls back to
 * the raw socket address, and finally to a constant — a shared bucket is a
 * degraded limit, which is still strictly better than no limit.
 */
function clientKey(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown"
}

/**
 * Express middleware implementing the policy above. Mount it ONCE at
 * `/api/v1` (see `create-app.ts`) — it selects its own lanes, so mounting it
 * per-route would be both noisier and easier to get wrong.
 *
 * State lives in the returned closure, so each `createApp` gets an
 * independent limiter. That keeps tests isolated from one another and means
 * nothing leaks across a hot restart.
 */
export function createApiRateLimit(options: ApiRateLimitOptions = {}): RequestHandler {
  const counters = new Map<RateLimitLane, FixedWindowCounter>()
  for (const lane of Object.keys(DEFAULT_LIMITS) as RateLimitLane[]) {
    counters.set(lane, createFixedWindowCounter(options.limits?.[lane] ?? DEFAULT_LIMITS[lane]))
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const lane = classifyRateLimitLane(req.method, req.path)
    if (!lane) {
      next()
      return
    }
    const counter = counters.get(lane)
    if (!counter) {
      next()
      return
    }
    const { allowed, retryAfterSeconds } = counter.hit(`${lane}:${clientKey(req)}`)
    if (allowed) {
      next()
      return
    }
    res.setHeader("Retry-After", String(retryAfterSeconds))
    res.status(429).json({ error: "Too many requests" })
  }
}

/**
 * Maximum concurrent SSE streams from one client address.
 *
 * A browser opens one per review tab, so a person with several prototypes open
 * uses a handful. Twenty leaves generous room for that (and for a shared office
 * NAT, which this keys as one client the same way the fixed-window lanes do)
 * while bounding what one visitor can hold: each connection costs a file
 * descriptor, a change-bus listener and a 25-second timer, and on a public
 * instance the comments stream is reachable with no credential at all.
 */
export const MAX_CONCURRENT_STREAMS_PER_CLIENT = 20

export interface ConcurrencyLimiter {
  /**
   * Reserves a slot for `key`. Returns a release function, or `null` when the
   * client is already at the limit.
   *
   * The release is IDEMPOTENT. SSE teardown can reach cleanup by more than one
   * path (see the `close`-before-subscribe race in comments-routes.ts), and a
   * double release would decrement a slot the caller no longer owns, letting
   * the count drift below zero and the cap leak upward over time.
   */
  acquire(key: string): (() => void) | null
  /** Test seam: current holder count for `key`. */
  countFor(key: string): number
}

/**
 * A counter of OPEN connections, which is a different control from the
 * fixed-window limiter above and not a substitute for it.
 *
 * The header of this file explains why the streams are not rate-limited: a
 * window counter either counts a single long-lived stream once (useless) or
 * refuses the reconnect storm that follows a proxy hiccup (harmful). Both are
 * true. Neither says anything about how many streams one client may hold at
 * once, which is the actual resource question, and which a reconnect storm
 * does not trip because each reconnect replaces a connection that closed.
 */
export function createConcurrencyLimiter(options: {
  max: number
  maxKeys?: number
}): ConcurrencyLimiter {
  const { max, maxKeys = 10_000 } = options
  const counts = new Map<string, number>()

  return {
    acquire(key: string): (() => void) | null {
      const current = counts.get(key) ?? 0
      if (current >= max) return null
      // Same bound, and the same reasoning, as the window counter's `maxKeys`:
      // a map keyed by client address is itself a memory-exhaustion primitive
      // when the attacker picks the keys. Evicting a zero-count key is always
      // safe, since a zero count is indistinguishable from an absent one.
      if (current === 0 && counts.size >= maxKeys) {
        for (const [k, v] of counts) {
          if (v <= 0) counts.delete(k)
        }
        if (counts.size >= maxKeys) return null
      }
      counts.set(key, current + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const next = (counts.get(key) ?? 1) - 1
        if (next <= 0) counts.delete(key)
        else counts.set(key, next)
      }
    },
    countFor(key: string): number {
      return counts.get(key) ?? 0
    },
  }
}

/** The client key, exported so a stream handler can key on the same value. */
export function clientKeyFor(req: Request): string {
  return clientKey(req)
}

/**
 * Machine tokens (PATs) — mint + verify (Phase 3b-2).
 *
 * A machine token authenticates AS its owning user. It is not a parallel
 * authorization system: `verifyMachineToken` below resolves a raw header
 * value to `{ token, user }`, and callers (T3's `resolveReadContext`) fold
 * that `user` into the exact same `canReadProject` / membership checks a
 * browser session produces — INCLUDING `requireInstanceRole` /
 * `hasAdminAuthority`, so a PAT owned by an instance Admin DOES grant admin
 * authority for the ordinary API surface (managing members, invites, domain
 * rules, any project), exactly as that person's session would. The one
 * deliberate exception is the GitHub App setup flow
 * (`api/setup-routes.ts`'s `requireOperator`), which refuses EVERY PAT
 * regardless of its owner's role — provisioning the App is narrower than
 * instance-admin authority, and the callback leg is a browser navigation
 * anyway, not something a token could complete.
 *
 * Token format: `dsv_<id>_<secret>`
 *   - `dsv_` — fixed, greppable prefix (secret scanners + humans).
 *   - `<id>` — 16 lowercase hex chars (8 random bytes). The storage primary
 *     key. Non-secret; safe to show in UI as `dsv_<id>…`.
 *   - `<secret>` — 32 CSPRNG bytes, base64url, no padding (43 chars).
 *
 * At rest we store `sha256(secret)` and never the token or the raw secret.
 * Plain SHA-256 with no salt and no slow KDF is CORRECT here, not a
 * shortcut: the secret is 256 bits of `randomBytes` entropy, not a
 * human-chosen password, so there is no dictionary to stretch against and
 * per-entry salting buys nothing against a 2^256 search space. (This is
 * what GitHub/GitLab do for their PATs.) Do not "fix" this to bcrypt/argon2.
 *
 * Lookup is by `id`, THEN constant-time compare of the digests — not a
 * lookup keyed on the digest — so there's an explicit `timingSafeEqual` to
 * point at, and a stable non-secret prefix survives for the UI.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { MachineToken, StorageAdapter, User } from "../storage/types"

const TOKEN_PREFIX = "dsv_"
const TOKEN_PATTERN = /^dsv_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/

/**
 * Minimum interval between `lastUsedAt` writes for the same token. Without
 * this, every authenticated request is also a write — see `verifyMachineToken`'s
 * fire-and-forget touch below. (Phase 2b-2 shipped an un-caught version of
 * this exact "background write on every request" bug as a Critical; the
 * `.catch()` there — and here — is load-bearing, not decoration.)
 */
export const LAST_USED_COARSENING_MS = 5 * 60 * 1000

export interface GeneratedMachineToken {
  /** 16 lowercase hex chars — the storage primary key / public id segment. */
  id: string
  /** 32 CSPRNG bytes, base64url, unpadded — NEVER persisted, shown to the user exactly once. */
  secret: string
  /** The full `dsv_<id>_<secret>` string handed to the user. */
  token: string
  /** hex sha256 of `secret` — this is what gets persisted. */
  tokenHash: string
}

/** Hex sha256 of a token secret. Pure; used for both minting and verifying. */
export function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

/**
 * Mint a new machine token. Uses `randomBytes` (CSPRNG) — never `Math.random`,
 * which is not cryptographically secure and must never back a credential.
 */
export function generateMachineToken(): GeneratedMachineToken {
  const id = randomBytes(8).toString("hex") // 16 hex chars
  const secret = randomBytes(32).toString("base64url") // 43 chars, unpadded
  const token = `${TOKEN_PREFIX}${id}_${secret}`
  return { id, secret, token, tokenHash: hashTokenSecret(secret) }
}

/**
 * Parse a raw `Authorization` bearer value into its `{ id, secret }` parts.
 * Strict format match only — anything else (wrong prefix, wrong lengths,
 * wrong charset, not a string) returns `null`. Never throws.
 */
export function parseMachineToken(raw: unknown): { id: string; secret: string } | null {
  if (typeof raw !== "string") return null
  const match = TOKEN_PATTERN.exec(raw)
  if (!match) return null
  return { id: match[1], secret: match[2] }
}

/**
 * Constant-time compare of two hex sha256 digests. Both inputs here are
 * always 64-char hex (32 bytes) in the real flow — `hashTokenSecret`'s
 * output on one side, a stored `tokenHash` on the other — so this converts
 * both to equal-length `Buffer`s and calls `timingSafeEqual` directly
 * (no intermediate re-hash needed, unlike `session-cookie.ts`'s
 * `digestsMatch`, which has to accept arbitrary-length inputs).
 *
 * Defensive guard: `timingSafeEqual` throws on unequal-length buffers. A
 * length mismatch here would only happen if a `tokenHash` row were corrupted
 * (never from this module's own writes) — rather than branching straight to
 * `return false` on that check (a length-driven early-out), a same-length
 * dummy comparison still runs so the function's timing profile doesn't
 * depend on which branch was taken.
 */
function tokenHashesMatch(storedHex: string, computedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex")
  const computed = Buffer.from(computedHex, "hex")
  if (stored.length !== computed.length) {
    timingSafeEqual(computed, computed)
    return false
  }
  return timingSafeEqual(stored, computed)
}

/** Whether `touchMachineToken` should fire, given the token's current `lastUsedAt`. */
function needsTouch(lastUsedAt: string | null, nowMs: number): boolean {
  if (lastUsedAt === null) return true
  const lastMs = Date.parse(lastUsedAt)
  if (Number.isNaN(lastMs)) return true // corrupted timestamp — treat as stale, don't wedge touches off forever
  return nowMs - lastMs >= LAST_USED_COARSENING_MS
}

/**
 * One-time guard for the `lastUsedAt` touch failure log. The touch is
 * fire-and-forget by design, but a FULLY silent `.catch(() => {})` means a
 * permanently broken touch path (bad migration, read-only disk, storage
 * impl bug) is undetectable: every request keeps succeeding while
 * `lastUsedAt` silently never advances, so "when was this token last used"
 * — the field operators use to decide what's safe to revoke — quietly
 * reads `Never` forever. Warning ONCE per process rather than per request
 * is the point: the touch fires on every authenticated request past the
 * coarsening window, so a per-request log would flood the operator's logs
 * with the same line and get filtered out, which is just a slower way of
 * being silent.
 */
let touchFailureWarned = false

/**
 * Test hook: clear the once-per-process flag above.
 *
 * A module-level "warn once" flag survives from one test FILE into the next
 * inside a vitest worker, so without this the only way to assert on the warning
 * is `vi.resetModules()` plus a dynamic re-import — which is what
 * `machine-token.test.ts` had to do, because two earlier tests in the same file
 * already trip the flag.
 *
 * That workaround works but does not compose: it is invisible to the next test
 * someone adds, and a second test asserting a call count through the ordinary
 * top-level import would silently measure whatever the file happened to leave
 * behind. Mirrors `resetGroundingCache()` in editor-cli's grounding-context.
 */
export function resetTouchFailureWarning(): void {
  touchFailureWarned = false
}

function warnTouchFailureOnce(err: unknown): void {
  if (touchFailureWarned) return
  touchFailureWarned = true
  console.warn(
    "[viewer] failed to update a machine token's lastUsedAt (further occurrences suppressed):",
    err,
  )
}

export interface MachineTokenVerifyDeps {
  storage: Pick<StorageAdapter, "getMachineToken" | "getUser" | "touchMachineToken">
}

/**
 * Resolve a raw `Authorization` bearer value to the token row and its
 * owning user. `parse → getMachineToken(id) → timingSafeEqual on the two
 * digests → expiry check → getUser`. Any miss at any step returns `null`.
 *
 * Contract: NEVER throws — same as `getCurrentUser` (`current-user.ts`).
 * "malformed input", "unknown id", "wrong secret", "expired", "owning user
 * gone", and "storage blew up" are all indistinguishable failures from the
 * caller's point of view: fail closed, never 500.
 *
 * Does NOT await the `lastUsedAt` touch — it's fire-and-forget with its own
 * `.catch()`, so a slow or failing storage write on the touch path can never
 * add latency to, or fail, the request that's actually being authenticated.
 * The touch is also dispatched OUTSIDE the `try` below, deliberately: inside
 * it, a storage impl that threw SYNCHRONOUSLY (before returning a promise —
 * e.g. better-sqlite3's `prepare()` on a schema problem) would be caught by
 * the outer `catch` and turn an ALREADY-VERIFIED token into a `null`, i.e. a
 * 401 on a perfectly valid credential. A bookkeeping write must not be able
 * to revoke a token by failing.
 */
export async function verifyMachineToken(
  deps: MachineTokenVerifyDeps,
  raw: unknown,
): Promise<{ token: MachineToken; user: User } | null> {
  let verified: { token: MachineToken; user: User } | null = null
  let touchAt: string | null = null

  try {
    const parsed = parseMachineToken(raw)
    if (!parsed) return null

    const token = await deps.storage.getMachineToken(parsed.id)
    if (!token) return null

    if (!tokenHashesMatch(token.tokenHash, hashTokenSecret(parsed.secret))) return null

    const now = new Date()
    if (token.expiresAt !== null && token.expiresAt <= now.toISOString()) return null

    const user = await deps.storage.getUser(token.userId)
    if (!user) return null

    verified = { token, user }
    if (needsTouch(token.lastUsedAt, now.getTime())) touchAt = now.toISOString()
  } catch {
    return null
  }

  if (verified !== null && touchAt !== null) {
    // Fire-and-forget: never awaited, always caught, and outside the `try`
    // so neither an async rejection NOR a synchronous throw can affect the
    // verification result above. Failures warn once per process rather than
    // vanishing entirely — see `warnTouchFailureOnce`.
    try {
      void deps.storage.touchMachineToken(verified.token.id, touchAt).catch(warnTouchFailureOnce)
    } catch (err) {
      warnTouchFailureOnce(err)
    }
  }

  return verified
}

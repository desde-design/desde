/**
 * One-time tokens — the shared machinery behind instance invites (`dsi_`)
 * and sign-in links (`dss_`).
 *
 * This is `machine-token.ts`'s discipline applied to a second credential
 * family, deliberately copied rather than re-invented. Read that file first;
 * the reasoning below only records what differs.
 *
 * Token format: `<prefix>_<id>_<secret>`
 *   - `<prefix>` — `dsi` (invite) or `dss` (sign-in link). Fixed, greppable,
 *     and part of the hashed material, so an invite token can never verify
 *     against a sign-in token's stored hash even if the two somehow shared an
 *     id and secret. It also keeps these tokens from parsing as a `dsv_`
 *     machine token, which lives in a different table entirely.
 *   - `<id>` — 16 lowercase hex chars (8 random bytes). The storage primary
 *     key. Non-secret; safe to show in a UI or a log line.
 *   - `<secret>` — 32 CSPRNG bytes, base64url, no padding (43 chars).
 *
 * **The plaintext is returned exactly once, by `generateOneTimeToken`, and is
 * never persisted or logged.** What goes to storage is `tokenHash`.
 *
 * Plain SHA-256, no salt and no slow KDF, is CORRECT here for the same reason
 * it is in `machine-token.ts`: the secret is 256 bits of `randomBytes`
 * entropy, not a human-chosen password, so there is no dictionary to stretch
 * against and per-entry salting buys nothing against a 2^256 search space.
 * Do not "fix" this to bcrypt/argon2.
 *
 * One difference from `machine-token.ts` worth naming: the hash covers the
 * WHOLE token string, not just the secret segment. That is the shape the
 * storage rows were designed around (`InstanceInvite.tokenHash` /
 * `SignInToken.tokenHash`), and it costs nothing — the entropy still comes
 * from the secret, and folding the prefix and id in only narrows what a given
 * hash can ever verify.
 *
 * **Caller discipline: parse for the id, look the row up BY THAT ID, then
 * `oneTimeTokenMatches`.** Never look a row up keyed on the hash. A
 * hash-keyed lookup has no explicit comparison to point at, so nothing in the
 * code says the comparison is constant-time, and the non-secret id — the part
 * that is safe to show a user — stops being load-bearing and drifts away.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** `dsi` = instance invite, `dss` = single-use sign-in link. */
export type OneTimeTokenPrefix = "dsi" | "dss"

const TOKEN_PATTERN = /^(dsi|dss)_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/

export interface GeneratedOneTimeToken {
  /** 16 lowercase hex chars — the storage primary key. Non-secret. */
  id: string
  /** The full `<prefix>_<id>_<secret>` string. Handed to the user ONCE; never persisted. */
  token: string
  /** hex sha256 of `token` — this is what gets persisted. */
  tokenHash: string
}

/** Hex sha256 of a full one-time token. Pure; used for both minting and verifying. */
export function hashOneTimeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Mint a one-time token. Uses `randomBytes` (CSPRNG) — never `Math.random`,
 * which is not cryptographically secure and must never back a credential.
 *
 * `existingId` — pass the id of a row being REGENERATED (e.g.
 * `POST /instance/invites/:id/regenerate`), so the fresh secret is minted
 * for the SAME storage primary key rather than a new one. That matters
 * because `resetInstanceInviteToken(id, tokenHash, expiresAt)` updates the
 * row `id` names — it does not (and must not: `id` is a foreign key
 * elsewhere) mint a new one — so the plaintext token handed back has to
 * embed that same id or `parseOneTimeToken` + a lookup-by-id would resolve
 * the wrong row (or none) when the link is used. Omit it for an ordinary
 * fresh mint, which is the overwhelmingly common case and keeps every
 * existing call site unchanged.
 */
export function generateOneTimeToken(
  prefix: OneTimeTokenPrefix,
  existingId?: string,
): GeneratedOneTimeToken {
  const id = existingId ?? randomBytes(8).toString("hex") // 16 hex chars
  const secret = randomBytes(32).toString("base64url") // 43 chars, unpadded
  const token = `${prefix}_${id}_${secret}`
  return { id, token, tokenHash: hashOneTimeToken(token) }
}

/**
 * Parse a token into its non-secret parts: which family it belongs to, and
 * which row to look up. Strict format match only — a wrong prefix, wrong
 * lengths, wrong charset or stray whitespace all return `null`. Never throws.
 *
 * The secret is deliberately NOT returned: nothing downstream needs it,
 * because verification hashes the whole token.
 */
export function parseOneTimeToken(token: string): { prefix: OneTimeTokenPrefix; id: string } | null {
  const match = TOKEN_PATTERN.exec(token)
  if (!match) return null
  return { prefix: match[1] as OneTimeTokenPrefix, id: match[2] }
}

/**
 * Constant-time verification of a presented token against a stored hash.
 *
 * Same hash-both-sides-first construction as `authorize.ts`'s `tokensMatch`:
 * `timingSafeEqual` throws on unequal-length buffers, and `storedHash` comes
 * out of the database — a corrupted row, a hand-edited value, or a hash from
 * some future algorithm must return `false`, not blow up the request that is
 * verifying a credential. Hashing both sides again makes the two buffers
 * equal-length by construction, so there is no length branch to leak on and
 * no throw to guard against.
 */
export function oneTimeTokenMatches(token: string, storedHash: string): boolean {
  const presented = createHash("sha256").update(hashOneTimeToken(token)).digest()
  const stored = createHash("sha256").update(storedHash).digest()
  return timingSafeEqual(presented, stored)
}

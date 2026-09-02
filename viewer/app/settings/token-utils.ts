/**
 * Pure, side-effect-free logic for the settings/token-management panel
 * (`tokens-panel.tsx`) — kept out of the component so it's directly
 * unit-testable without React or a DOM (see `token-utils.test.ts`).
 *
 * The wire shape mirrors `server/api/tokens-routes.ts`'s `MachineTokenView`
 * field-by-field, declared locally rather than imported: server-only code
 * isn't reachable from app code via the `@/*` alias (that alias points at
 * the repo-root `src/`), same reasoning as `project-access.tsx`'s
 * `ProjectMemberView` and `use-current-user.ts`'s `ViewerUser`.
 */

export type MachineTokenScope = "read" | "write"

export interface MachineTokenView {
  id: string
  name: string
  scopes: MachineTokenScope[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export function isMachineTokenScope(v: unknown): v is MachineTokenScope {
  return v === "read" || v === "write"
}

export function isMachineTokenView(v: unknown): v is MachineTokenView {
  if (typeof v !== "object" || v === null) return false
  const t = v as Record<string, unknown>
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    Array.isArray(t.scopes) &&
    t.scopes.every(isMachineTokenScope) &&
    typeof t.createdAt === "string" &&
    (t.lastUsedAt === null || typeof t.lastUsedAt === "string") &&
    (t.expiresAt === null || typeof t.expiresAt === "string")
  )
}

// Mirrors server/api/tokens-routes.ts's validation constants exactly — kept
// as a client-side pre-check only. The server is the sole authority; a
// disagreement here is a bug in THIS file, not a reason to trust the client
// over a 400 the server actually returns (see `formServerError` below).
const MAX_NAME_CHARS = 64
const MIN_EXPIRES_DAYS = 1
const MAX_EXPIRES_DAYS = 365

/** `null` when valid, otherwise a user-facing message. */
export function validateTokenName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) {
    return `Name must be 1-${MAX_NAME_CHARS} characters.`
  }
  return null
}

/** `null` when valid, otherwise a user-facing message. */
export function validateTokenScopes(scopes: readonly MachineTokenScope[]): string | null {
  if (scopes.length === 0) return "Select at least one scope."
  return null
}

/**
 * `days` is `null` when the "no expiry" option is selected — always valid.
 * Otherwise mirrors the server's `1..365` integer bound.
 */
export function validateExpiresInDays(days: number | null): string | null {
  if (days === null) return null
  if (!Number.isInteger(days) || days < MIN_EXPIRES_DAYS || days > MAX_EXPIRES_DAYS) {
    return `Expiry must be a whole number of days between ${MIN_EXPIRES_DAYS} and ${MAX_EXPIRES_DAYS}.`
  }
  return null
}

/**
 * The non-secret display prefix built from `MachineTokenView.id` alone —
 * `id` is the storage primary key and is explicitly documented (plan §
 * "Token format") as safe to show in UI; the response never carries the
 * secret half or the hash. This is NOT the literal prefix of any real
 * token string, just an identifying fragment for the list.
 */
export function tokenDisplayPrefix(id: string): string {
  return `dsv_${id}…`
}

/**
 * `now` is injectable so this stays a pure, deterministic function under
 * test (no `Date.now()` baked in) rather than something that only passes
 * "right now."
 */
export function isTokenExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  if (expiresAt === null) return false
  const t = new Date(expiresAt).getTime()
  if (!Number.isFinite(t)) return false
  return t <= now.getTime()
}

/**
 * Absolute, timezone-independent (UTC) `YYYY-MM-DD` formatting for
 * createdAt/lastUsedAt/expiresAt — deterministic under test and unambiguous
 * in a settings table, unlike a locale-relative string. `fallback` (default
 * `"Never"`) covers both `null` and an unparseable value.
 */
export function formatTimestamp(iso: string | null, fallback = "Never"): string {
  if (iso === null) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toISOString().slice(0, 10)
}

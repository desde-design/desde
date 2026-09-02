import { Router, type Response } from "express"
import type { AppDeps } from "../create-app"
import { requireInstanceAdmin } from "../auth/authorize"
import { loadRuntimeConfig, updateRuntimeConfig } from "../runtime-config"
import { revokeAllCredentials } from "../auth/credential-revocation"
import { generateOneTimeToken } from "../auth/one-time-token"
import { isLocalOperatorUser } from "../auth/local-operator"
import { ADMIN_SIGN_IN_LINK_TTL_HOURS } from "../auth/auth-constants"
import {
  ALLOW_ANONYMOUS_COMMENTS_KEY,
  ALLOW_PUBLIC_LINKS_KEY,
  getAllowAnonymousComments,
  getAllowPublicLinks,
  invalidateInstanceSettingsCache,
} from "../instance-settings"
import { inviteEmail } from "../notify/auth-email"
import { inviteAcceptUrl, signInUrl } from "./auth-urls"
import { normalizeEmailInput } from "./validate-email"
import type { DomainRule, InstanceInvite, InstanceRole, User, UserStatus } from "../storage/types"

const ROLES: readonly InstanceRole[] = ["admin", "editor", "viewer"]

function isInstanceRole(v: unknown): v is InstanceRole {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v)
}

const ROLE_ERROR = `role must be one of ${ROLES.join(", ")}`

/** The exact 409 body the last-admin guard uses on BOTH the demote and the
 * remove path. Not "an instance must keep…" — "instance" is our deployment
 * jargon, not a word the admin clicking Remove used (Mo, 2026-08-31). */
const LAST_ADMIN_ERROR = "There must be at least one admin."

const INVITE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000

/**
 * An ADMIN-ISSUED sign-in link's lifetime, derived from
 * `ADMIN_SIGN_IN_LINK_TTL_HOURS` (`auth/auth-constants.ts`) — 24 hours,
 * against the 15 minutes a self-requested magic link gets (`auth-routes.ts`).
 * The reasoning lives on the route that mints it; the short version is that
 * the recipient is a third party who may be offline, so a 15-minute link
 * would mostly arrive dead.
 */
const ADMIN_SIGN_IN_LINK_EXPIRES_MS = ADMIN_SIGN_IN_LINK_TTL_HOURS * 60 * 60 * 1000

/** The 409 body for issuing a sign-in link to a member who has been removed. */
const REMOVED_MEMBER_ERROR =
  "That member has been removed. Restore them before issuing a sign-in link."

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * The wire shape for an instance member — hand-built field by field (never a
 * spread of `User`), the same discipline `tokens-routes.ts`'s
 * `MachineTokenView` uses: it's what keeps a field added to `User` later from
 * silently starting to round-trip here.
 */
export interface MemberView {
  userId: string
  email: string
  displayName: string
  avatarUrl: string
  role: InstanceRole
  status: UserStatus
  createdAt: string
}

function toMemberView(user: User): MemberView {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  }
}

/**
 * How many ACTIVE admins the instance currently has. The last-admin guard's
 * whole job is keeping this from hitting zero — a `removed` admin's row still
 * says `role: "admin"`, but they cannot sign in, so they must not count
 * toward the floor (otherwise removing every OTHER admin around a single
 * already-removed one would silently strand the instance with nobody able to
 * administer it).
 *
 * **The local-operator row is excluded from the floor whenever GitHub
 * sign-in is configured — UNLESS excluding it would leave nobody counted at
 * all.** `/auth/local` self-disables the instant `deps.github.authProvider`
 * exists (see `local-operator.ts`), so the operator's row stops being an
 * account anyone can sign in as. Counting it toward the floor anyway would
 * let the one admin who CAN still sign in be demoted or removed — the
 * instance would still show an "admin" on paper while nobody could
 * administer it. Before GitHub is configured, `/auth/local` is the only
 * sign-in there is, so the operator row is a perfectly reachable admin and
 * counts like any other.
 *
 * **Fix wave 8, item 1: the exclusion only applies when another counted
 * admin exists.** GitHub can be configured mid-process (the runtime
 * Manifest flow), and that can happen while the operator is still the ONLY
 * admin the instance has. Excluding it unconditionally in that moment made
 * this function return 0 while the operator's own session was still the
 * only door in — which let the operator demote or remove itself, deleting
 * its own live session with `/auth/local` already disabled and no `role:
 * "admin"` row left reachable (short of the separate `adminToken` bearer, if
 * one was configured). So the operator counts whenever it is the ONLY
 * active admin, and stops counting only once a real, OTHER admin exists to
 * hold the floor instead.
 */
async function countActiveAdmins(deps: Pick<AppDeps, "storage" | "github">): Promise<number> {
  const users = await deps.storage.listUsers()
  const activeAdmins = users.filter((u) => u.role === "admin" && u.status === "active")
  if (!deps.github.authProvider) return activeAdmins.length
  const otherActiveAdmins = activeAdmins.filter((u) => !isLocalOperatorUser(u))
  // The operator only stops counting once someone ELSE is there to count instead.
  return otherActiveAdmins.length > 0 ? otherActiveAdmins.length : activeAdmins.length
}

/**
 * The last-admin guard's shared body, extracted from the two near-identical
 * copies it used to have on PATCH and DELETE `/instance/members/:userId`.
 * Each route still decides FOR ITSELF whether an action even touches admin
 * status (PATCH only cares about a real demotion away from `"admin"`; DELETE
 * cares about any active admin being removed at all) — only the "would this
 * leave zero active admins" count-and-refuse was identical, so only that part
 * moved here. Sends the 409 itself and reports whether it fired, so a caller
 * reads as `if (await refuseIfLastActiveAdmin(deps, res)) return`.
 *
 * Accepted TOCTOU window, reviewed and not merely overlooked: this reads
 * `countActiveAdmins` and the caller writes afterward, across an `await`
 * boundary with no transaction or row lock around the pair. Two concurrent
 * demote/remove requests against the last two admins can both observe "2
 * active admins" and both proceed, landing the instance at zero. Left open
 * because the viewer is a single-process self-host deployment (there is no
 * fleet of concurrent admin-panel writers to race against in practice), and
 * because recovery does not depend on any admin ROW surviving anyway: the
 * `adminToken` bearer and the local-operator boot path both grant admin
 * authority independently of how many `role: "admin"` users exist.
 */
async function refuseIfLastActiveAdmin(
  deps: Pick<AppDeps, "storage" | "github">,
  res: Response,
): Promise<boolean> {
  if ((await countActiveAdmins(deps)) > 1) return false
  res.status(409).json({ error: LAST_ADMIN_ERROR })
  return true
}

/**
 * Whether TARGET is one of the rows `countActiveAdmins` is actually
 * counting — i.e. whether an action against them could change that count at
 * all. Mirrors `countActiveAdmins`'s own conditions exactly, because the
 * guard's whole point is to protect THAT count from hitting zero.
 *
 * Fix wave 7, item 1: both call sites used to run the guard for any active
 * admin target, full stop — including a target `countActiveAdmins` was
 * ALREADY excluding. Once GitHub sign-in is configured, the local-operator
 * row stops counting (see that function's doc comment), but removing or
 * demoting the operator itself still tripped the floor: the guard read
 * "count is 1" and refused, even though that 1 was the OTHER admin and would
 * stay 1 either way. Skipping the guard entirely for an uncounted target is
 * what closes that — a target that can never move the count can never be
 * "the last admin."
 *
 * Async as of fix wave 8, item 1: `countActiveAdmins` no longer excludes the
 * operator unconditionally — it stops counting only once another active
 * admin exists — so this can no longer answer from `target` and
 * `deps.github` alone. It reads `storage.listUsers()` itself to ask the
 * same question. That is a second full read alongside `refuseIfLastActiveAdmin`'s
 * (via `countActiveAdmins`), which is the same TOCTOU-tolerant trade-off
 * already accepted there — not a new window, just one more look at data
 * that was already unlocked between the two reads.
 */
async function isCountedActiveAdmin(
  deps: Pick<AppDeps, "storage" | "github">,
  target: Pick<User, "role" | "status" | "provider" | "providerUserId">,
): Promise<boolean> {
  if (target.role !== "admin" || target.status !== "active") return false
  if (!deps.github.authProvider) return true
  if (!isLocalOperatorUser(target)) return true
  // TARGET is the operator row: it counts only when it is the ONLY active
  // admin — i.e. no OTHER active admin exists to hold the floor instead.
  const users = await deps.storage.listUsers()
  const otherActiveAdmins = users.filter(
    (u) => u.role === "admin" && u.status === "active" && !isLocalOperatorUser(u),
  )
  return otherActiveAdmins.length === 0
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** The 409 body when an invite targets an email that already has an ACTIVE account (I1). */
const ACTIVE_MEMBER_INVITE_ERROR =
  "That address already belongs to a member. Mint a sign-in link instead."

/** The 409 body when an invite targets an email that belongs to a REMOVED account (I1). */
const REMOVED_MEMBER_INVITE_ERROR = "That address belongs to a removed member. Restore them instead."

/**
 * I1: refuses to hand out an invite (new or regenerated) for an email that
 * already has an account here — the invite would never do anything useful.
 *
 * `admitSignIn` rung 1 (an existing account) runs BEFORE rung 2 (an invite),
 * so an invite for an address that already has an account is dead on
 * arrival either way:
 *
 * - an ACTIVE account signs straight in at its EXISTING role — the invite's
 *   role is never even consulted, and the invite sits there unclaimed;
 * - a REMOVED account is refused unconditionally — the invite can NEVER be
 *   accepted, no matter what role it names.
 *
 * Pointing the admin at a different tool for each case (a sign-in link vs.
 * restoring the member) is more useful than a 201 that quietly does nothing.
 */
async function invitableEmailConflict(
  deps: Pick<AppDeps, "storage">,
  email: string,
): Promise<{ error: string } | null> {
  const existing = await deps.storage.getUserByEmail(email)
  if (!existing) return null
  if (existing.status === "removed") return { error: REMOVED_MEMBER_INVITE_ERROR }
  return { error: ACTIVE_MEMBER_INVITE_ERROR }
}

export type InviteState = "pending" | "used" | "revoked" | "expired"

/** Never carries `tokenHash` — that is the entire point of this projection. */
export interface InviteView {
  id: string
  email: string
  role: InstanceRole
  createdByUserId: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
  state: InviteState
}

function deriveInviteState(invite: InstanceInvite, nowIso: string): InviteState {
  // `usedAt` wins over `revokedAt`: once a click has claimed an invite an
  // account exists, and that fact is what an admin needs to see even if the
  // invite was (redundantly, and pointlessly for security — see
  // `gate.ts`'s `isClaimable`) also revoked afterward.
  if (invite.usedAt !== null) return "used"
  if (invite.revokedAt !== null) return "revoked"
  if (invite.expiresAt <= nowIso) return "expired"
  return "pending"
}

function toInviteView(invite: InstanceInvite, nowIso: string): InviteView {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdByUserId: invite.createdByUserId,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    usedAt: invite.usedAt,
    revokedAt: invite.revokedAt,
    state: deriveInviteState(invite, nowIso),
  }
}

/*
 * `inviteAcceptUrl` and `signInUrl` live in `./auth-urls.ts`. They moved there
 * when Task 14 added a second one-time-token family that is minted from BOTH
 * routers, so a helper local to this file would have become two copies of one
 * construction. See that file's comment for the 404-in-the-browser bug the
 * single-constant rule exists to prevent.
 */

/**
 * Mails an invite, and reports whether it was actually sent.
 *
 * **Best-effort by design.** The invite itself is created (or regenerated)
 * before this runs and the plaintext URL is in the response either way, so an
 * admin whose SMTP is misconfigured still has a working link to paste into
 * Slack. Failing the request over a mail hiccup would throw away a credential
 * that was already minted — the row exists, and its `409 an unexpired invite
 * already exists` guard would then block the retry.
 *
 * Never throws: `EmailProvider.send` is contracted not to, but this is the
 * boundary where a badly-behaved provider must not become a 500 on a request
 * that already succeeded.
 *
 * The returned boolean is what the routes surface as `emailed`, so the panel
 * can say "invite sent" versus "copy this link" instead of guessing.
 */
async function sendInviteEmail(
  deps: Pick<AppDeps, "email">,
  invite: Pick<InstanceInvite, "email" | "role">,
  url: string,
): Promise<boolean> {
  const provider = deps.email
  if (!provider) return false
  try {
    const { subject, html } = inviteEmail({ inviteUrl: url, role: invite.role })
    const ok = await provider.send(invite.email, subject, html)
    if (!ok) console.error(`[viewer] failed to send an invite email to ${invite.email}`)
    return ok
  } catch (err) {
    console.error(`[viewer] invite email to ${invite.email} threw:`, err)
    return false
  }
}

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

const MAX_DOMAIN_CHARS = 253

/**
 * Route-level input shape, distinct from the STORAGE-level normalization
 * `setDomainRule`/`removeDomainRule` already apply (they lowercase
 * internally — see `in-memory-storage.ts`). This rejects a malformed value
 * outright rather than silently normalizing it, so an admin who fat-fingers
 * `Example.com` gets a 400 telling them so instead of a rule that quietly
 * saved as `example.com` with no confirmation of what was stored.
 */
function isValidDomainParam(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_CHARS) return false
  if (domain !== domain.toLowerCase()) return false
  if (domain.includes("@")) return false
  if (!domain.includes(".")) return false
  return true
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/*
 * `ALLOW_PUBLIC_LINKS_KEY` and `getAllowPublicLinks` live in
 * `../instance-settings.ts`, not here. This route READS and WRITES the
 * setting; `canReadProject` ENFORCES it. A private copy in this file is how
 * the panel and the rule get to disagree about what a stored value means —
 * so there is one reader, imported by both.
 */

/**
 * `/api/v1/instance/**` — members, invites, domain rules, and instance
 * settings (viewer-membership Task 6). Every route is gated by
 * `requireInstanceAdmin`: GETs pass `{ requireWriteScope: false }`, every
 * mutation passes `{ requireWriteScope: true }` — see that function's doc
 * comment in `auth/authorize.ts` for the exact admission ladder (adminToken
 * bearer, or an active `admin`-role session/PAT).
 */
export function createInstanceRoutes(deps: AppDeps): Router {
  const router = Router()

  // ---- Members --------------------------------------------------------

  router.get("/instance/members", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: false })
    if (!ctx) return
    // Removed users are included deliberately (the audit trail) — the
    // client is responsible for labeling `status: "removed"` rows, not this
    // route for filtering them out.
    const users = await deps.storage.listUsers()
    res.json({ members: users.map(toMemberView) })
  })

  router.patch("/instance/members/:userId", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const { role } = (req.body ?? {}) as Record<string, unknown>
    if (!isInstanceRole(role)) {
      res.status(400).json({ error: ROLE_ERROR })
      return
    }

    const userId = String(req.params.userId)
    const target = await deps.storage.getUser(userId)
    if (!target) {
      res.status(404).json({ error: "User not found" })
      return
    }

    // Last-admin guard: only a real DEMOTION away from admin can ever trip
    // it — patching an admin's role to "admin" (a no-op) never does, and
    // that's why this checks `role !== "admin"` rather than "is this user
    // currently the only admin" unconditionally. `isCountedActiveAdmin` is
    // the other half: a target `countActiveAdmins` already excludes (the
    // local-operator row, once another admin exists to take its place)
    // cannot move the count, so demoting IT must never trip the floor either.
    if (role !== "admin" && (await isCountedActiveAdmin(deps, target))) {
      if (await refuseIfLastActiveAdmin(deps, res)) return
    }

    const updated = await deps.storage.updateUserRole(userId, role)
    res.json(toMemberView(updated))
  })

  router.delete("/instance/members/:userId", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const userId = String(req.params.userId)
    const target = await deps.storage.getUser(userId)
    if (!target) {
      res.status(404).json({ error: "User not found" })
      return
    }

    // Same guard as PATCH, including the `isCountedActiveAdmin` half. An
    // already-`removed` target never trips it — it isn't an ACTIVE admin any
    // more — which is exactly what makes this idempotent: a second DELETE on
    // the same user just re-applies the same (now no-op) status write and
    // re-runs the (now empty) revocations.
    if (await isCountedActiveAdmin(deps, target)) {
      if (await refuseIfLastActiveAdmin(deps, res)) return
    }

    await deps.storage.setUserStatus(userId, "removed")
    // Kills the account's standing credentials IMMEDIATELY — a soft delete
    // that left live sessions/tokens running would remove someone from the
    // members list while their browser (or CI token) kept working. Fix wave
    // 10, item 3: the four kinds (sessions, machine tokens, and both
    // sign-in-link flavors — see `revokeAllCredentials`'s own doc comment)
    // now run independently via `Promise.allSettled` rather than as a
    // sequential await chain. A sequential chain that threw partway used to
    // leave whatever came AFTER the throw un-revoked — e.g. a machine-token
    // deletion failure meant the two sign-in-token deletions never even
    // ran — while the response still reported success on an account that
    // was not actually fully locked out.
    const revocation = await revokeAllCredentials(deps.storage, target)
    if (!revocation.ok) {
      for (const failure of revocation.failures) {
        console.error(
          `[viewer] failed to revoke ${failure.step} while removing member ${userId}:`,
          failure.error,
        )
      }
      // Status stays `removed` — a soft delete that fails to fully revoke
      // credentials is still safer left removed (every surface that checks
      // status masks a removed account regardless) than rolled back to
      // active, which would additionally re-open every door `admitSignIn`
      // decides by status.
      res.status(500).json({
        error: "Member was removed, but some credentials could not be revoked. Try again.",
      })
      return
    }
    res.status(204).end()
  })

  router.post("/instance/members/:userId/restore", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const userId = String(req.params.userId)
    const target = await deps.storage.getUser(userId)
    if (!target) {
      res.status(404).json({ error: "User not found" })
      return
    }
    // Fix wave 11, item 3: restore is a no-op for an already-ACTIVE account,
    // and it MUST NOT sweep. The sweep-before-activate below (fix wave 10,
    // item 3) irreversibly deletes the account's PATs and sessions — correct
    // when bringing a genuinely `removed` account back, but a silent
    // credential wipe of a live member if it ran on one that is already
    // active. That happens on a direct call, or on a stale members list
    // where another admin already restored this person and this admin clicks
    // Restore again. A no-op 200 with the current view is friendliest for
    // that stale-list case — the panel simply reconciles to "active" — and
    // the route already returns a member view on success, so the shape
    // matches.
    if (target.status !== "removed") {
      res.json(toMemberView(target))
      return
    }
    // Fix wave 10, item 3: sweep credentials again BEFORE reactivating, and
    // refuse to activate if the sweep itself fails. This is insurance
    // against a PRIOR removal (the route above) that partially failed —
    // without this, restoring that account would reactivate it while it
    // still held a stale live session or machine token nobody ever
    // successfully revoked.
    const revocation = await revokeAllCredentials(deps.storage, target)
    if (!revocation.ok) {
      for (const failure of revocation.failures) {
        console.error(
          `[viewer] failed to revoke ${failure.step} while restoring member ${userId}:`,
          failure.error,
        )
      }
      res.status(500).json({
        error: "Could not restore this member. Some credentials could not be revoked. Try again.",
      })
      return
    }
    const updated = await deps.storage.setUserStatus(userId, "active")
    res.json(toMemberView(updated))
  })

  /**
   * `POST /instance/members/:userId/signin-link` — mint a one-time sign-in
   * link for an existing member, and hand the plaintext back to the admin
   * (viewer-membership Task 14).
   *
   * **This is the zero-SMTP re-authentication path, and that is its whole
   * point.** `POST /auth/magic-link` 409s on a viewer that cannot send mail,
   * and a deployment without a GitHub App has no other door either — so
   * without this route an instance with neither GitHub nor SMTP has exactly
   * one way in (the boot-printed local-operator token, which dies the moment a
   * GitHub provider appears). Here the admin is the delivery channel: they
   * copy the URL and send it however they already talk to the person.
   *
   * **24 hours, deliberately, against the magic link's 15 minutes.** A
   * self-requested link is redeemed within a minute by someone staring at
   * their inbox. This one is issued by a THIRD party who has no idea when the
   * recipient will next look at Slack, so a 15-minute link would mostly be
   * dead on arrival and the admin would mint another, and another. The
   * exposure that buys is real and accepted: a longer-lived credential sitting
   * in a chat log. It is bounded by the same three properties every sign-in
   * link has — single-use, hash-at-rest, and re-decided by the gate on the
   * click, so a member removed in the meantime is refused.
   *
   * A REMOVED member is refused here rather than handed a link the gate will
   * turn away: minting one would let an admin believe they had restored
   * access. There is no oracle concern in saying so — this route is
   * admin-only, and an admin can already read `status` off the members list.
   *
   * The LOCAL-OPERATOR row is deliberately NOT excluded here, where
   * `POST /auth/magic-link` does exclude it. That asymmetry is the point:
   * magic links are unauthenticated and delivered to a mailbox the requester
   * may control, so minting one for the stdout-only operator identity would
   * build a second door into it. This route already requires instance-admin
   * authority, and a caller who holds that gains nothing at all by signing in
   * as the operator — they can already do everything that account can.
   */
  router.post("/instance/members/:userId/signin-link", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const userId = String(req.params.userId)
    const target = await deps.storage.getUser(userId)
    if (!target) {
      res.status(404).json({ error: "User not found" })
      return
    }
    if (target.status !== "active") {
      res.status(409).json({ error: REMOVED_MEMBER_ERROR })
      return
    }

    const gen = generateOneTimeToken("dss")
    const expiresAt = new Date(Date.now() + ADMIN_SIGN_IN_LINK_EXPIRES_MS).toISOString()
    await deps.storage.createSignInToken({
      id: gen.id,
      // The `userId` variant: this link names an ACCOUNT, so it cannot be
      // used to conjure one at a domain rule's role.
      userId: target.id,
      email: null,
      tokenHash: gen.tokenHash,
      expiresAt,
    })

    // The one and only time this plaintext leaves the process. Never logged.
    res.status(201).json({ url: signInUrl(deps, req, gen.token), expiresAt })
  })

  // ---- Invites ----------------------------------------------------------

  router.post("/instance/invites", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const { email: rawEmail, role } = (req.body ?? {}) as Record<string, unknown>
    // X5: `normalizeEmailInput` — trims, refuses whitespace/control
    // characters, runs the shape check, lowercases. Was previously
    // `isValidEmail(rawEmail)` on the RAW value, trimmed only afterward: a
    // caller could satisfy validation with surrounding whitespace that then
    // silently vanished before the value was stored, and an interior
    // control character was never rejected at all.
    const email = normalizeEmailInput(rawEmail)
    if (email === null) {
      res.status(400).json({ error: "email is invalid" })
      return
    }
    if (!isInstanceRole(role)) {
      res.status(400).json({ error: ROLE_ERROR })
      return
    }

    const accountConflict = await invitableEmailConflict(deps, email)
    if (accountConflict) {
      res.status(409).json(accountConflict)
      return
    }

    const nowIso = new Date().toISOString()
    // Accepted TOCTOU window, reviewed and not merely overlooked (same
    // reasoning as `refuseIfLastActiveAdmin` above): this list-then-check has
    // no transaction or row lock around it, so two concurrent POSTs for the
    // same email can both observe "no active invite" and both create one.
    // Worst case is two live invites for one address — both work, and
    // `admitSignIn`'s invite rung claims whichever is clicked first, leaving
    // the other to fail its own (harmless, already-claimed) claim attempt.
    // Not worth closing on a single-process self-host deployment with an
    // admin operator, not a customer-facing race with concurrent adversaries.
    const existingActive = (await deps.storage.listInstanceInvites()).find(
      (i) => i.email === email && i.usedAt === null && i.revokedAt === null && i.expiresAt > nowIso,
    )
    if (existingActive) {
      res.status(409).json({
        error: "An unexpired invite already exists for that email. Regenerate it instead.",
      })
      return
    }

    const gen = generateOneTimeToken("dsi")
    const expiresAt = new Date(Date.now() + INVITE_EXPIRES_MS).toISOString()
    const invite = await deps.storage.createInstanceInvite({
      id: gen.id,
      email,
      role,
      tokenHash: gen.tokenHash,
      // The adminToken bearer resolves to `ctx.user: null` — never invent an
      // id for it. A signed-in admin session/PAT stamps their real id.
      createdByUserId: ctx.user?.id ?? null,
      expiresAt,
    })

    // The ONLY point in this token's lifecycle where the plaintext is ever
    // sent anywhere — same discipline as `tokens-routes.ts`'s `POST /tokens`.
    const url = inviteAcceptUrl(deps, req, gen.token)
    const emailed = await sendInviteEmail(deps, invite, url)
    res.status(201).json({ invite: toInviteView(invite, nowIso), url, emailed })
  })

  router.get("/instance/invites", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: false })
    if (!ctx) return
    const nowIso = new Date().toISOString()
    const invites = await deps.storage.listInstanceInvites()
    res.json({ invites: invites.map((i) => toInviteView(i, nowIso)) })
  })

  router.post("/instance/invites/:id/regenerate", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const id = String(req.params.id)
    const existing = await deps.storage.getInstanceInvite(id)
    if (!existing) {
      res.status(404).json({ error: "Invite not found" })
      return
    }

    // I1: the same guard `POST /instance/invites` applies at creation time —
    // an invite whose email has since gained an account (the person signed
    // up some OTHER way while this invite sat unused) must not be handed a
    // fresh 7-day token either.
    const accountConflict = await invitableEmailConflict(deps, existing.email)
    if (accountConflict) {
      res.status(409).json(accountConflict)
      return
    }

    // Mints a fresh SECRET for the SAME row id — see `generateOneTimeToken`'s
    // `existingId` doc comment for why the id must not change here.
    const gen = generateOneTimeToken("dsi", id)
    const expiresAt = new Date(Date.now() + INVITE_EXPIRES_MS).toISOString()
    const invite = await deps.storage.resetInstanceInviteToken(id, gen.tokenHash, expiresAt)

    const url = inviteAcceptUrl(deps, req, gen.token)
    // The FRESH link, mailed to the address on the stored row — regenerating
    // is how an admin fixes a link the recipient never received, so the send
    // is the point of the route rather than a nicety. `invite` (the row) is
    // the source of both the address and the role; neither comes from a
    // request body here.
    const emailed = await sendInviteEmail(deps, invite, url)
    res.json({ invite: toInviteView(invite, new Date().toISOString()), url, emailed })
  })

  router.delete("/instance/invites/:id", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return
    await deps.storage.revokeInstanceInvite(String(req.params.id))
    res.status(204).end()
  })

  // ---- Domain rules -------------------------------------------------------

  router.get("/instance/domain-rules", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: false })
    if (!ctx) return
    const domainRules = await deps.storage.listDomainRules()
    res.json({ domainRules })
  })

  router.put("/instance/domain-rules/:domain", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const domain = String(req.params.domain)
    if (!isValidDomainParam(domain)) {
      res.status(400).json({
        error: "domain must be lowercase, contain no '@', and include at least one '.'",
      })
      return
    }
    const { role } = (req.body ?? {}) as Record<string, unknown>
    if (!isInstanceRole(role)) {
      res.status(400).json({ error: ROLE_ERROR })
      return
    }

    const rule: DomainRule = await deps.storage.setDomainRule({
      domain,
      role,
      // Ignored by storage on an UPDATE (creation identity survives — see
      // `setDomainRule`'s doc comment); only takes effect the first time
      // this domain is ever set.
      createdByUserId: ctx.user?.id ?? null,
    })
    res.json(rule)
  })

  router.delete("/instance/domain-rules/:domain", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return
    await deps.storage.removeDomainRule(String(req.params.domain))
    res.status(204).end()
  })


/**
 * What the settings page is told about mail. Never the password.
 *
 * Same discipline as `machine-token.ts`: a credential the server holds is
 * reported as PRESENT, never echoed. There is no read path for it anywhere,
 * so a compromised session cannot lift the SMTP password back out of the
 * instance that stores it.
 */
function emailSettingsView(deps: AppDeps): {
  configured: boolean
  source: "env" | "stored" | null
  host: string | null
  port: number | null
  user: string | null
  from: string | null
  hasPassword: boolean
} {
  const email = deps.config.email
  return {
    configured: email !== null,
    source: deps.config.emailSource,
    host: email?.host ?? null,
    port: email?.port ?? null,
    user: email?.user ?? null,
    from: email?.from ?? null,
    hasPassword: Boolean(email?.pass),
  }
}

  // ---- Settings -----------------------------------------------------------

  router.get("/instance/settings", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: false })
    if (!ctx) return
    res.json({
      allowPublicLinks: await getAllowPublicLinks(deps.storage),
      allowAnonymousComments: await getAllowAnonymousComments(deps.storage),
      emailFrom: deps.config.email?.from ?? null,
      email: emailSettingsView(deps),
    })
  })

  /*
    Mail settings, editable here rather than only through the environment
    (Mo, 2026-08-26: "they should not be sent to any settings config, this
    should be editable in the GUI").

    Three things make this safe to accept over HTTP:

    - It is admin-only with a write scope, like every other mutation here.
    - The password is written to the data directory by the server and is
      never returned. `emailSettingsView` reports `hasPassword`, and that is
      the only thing any client learns about it.
    - The environment still WINS. A deployment that sets `VIEWER_SMTP_HOST`
      cannot have it replaced by this route, which refuses with 409 rather
      than storing settings that `loadConfig` would then ignore. Accepting
      the write and silently not applying it is the worse failure.
  */
  router.put("/instance/email", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    if (deps.config.emailSource === "env") {
      res.status(409).json({
        error:
          "This deployment sets its mail server in the environment, so it cannot be changed here.",
      })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
    const host = str(body.host)
    const user = str(body.user)
    const from = str(body.from)
    const pass = typeof body.pass === "string" ? body.pass : ""
    const port = typeof body.port === "number" ? body.port : Number(str(body.port))

    // Every field, not just the host. `loadConfig` treats a partial SMTP
    // record as a hard boot error, so storing one here would leave the next
    // restart refusing to start — a settings form that can brick the server
    // is worse than one that refuses a save.
    const missing = [
      host ? null : "a server address",
      user ? null : "a username",
      from ? null : "a From address",
    ].filter((m): m is string => m !== null)
    if (missing.length > 0) {
      res.status(400).json({ error: `Mail settings need ${missing.join(", ")}.` })
      return
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      res.status(400).json({ error: "Port must be a whole number between 1 and 65535." })
      return
    }

    // An empty password KEEPS the stored one. The form cannot show what is
    // there, so it cannot send it back, and treating blank as "clear it"
    // would wipe the credential every time someone edited the From address.
    const existing = loadRuntimeConfig(deps.config.dataDir).email
    const nextPass = pass !== "" ? pass : (existing?.pass ?? "")
    if (nextPass === "") {
      res.status(400).json({ error: "Mail settings need a password." })
      return
    }

    const next = { host, port, user, pass: nextPass, from }
    updateRuntimeConfig(deps.config.dataDir, { email: next })
    // The running config and the live provider, together. Updating one and
    // not the other is how a save reports success and changes nothing.
    deps.config.email = next
    deps.config.emailSource = "stored"
    deps.email?.reconfigure(next)

    res.json(emailSettingsView(deps))
  })

  /** Turn mail off and forget the credential. */
  router.delete("/instance/email", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return
    if (deps.config.emailSource === "env") {
      res.status(409).json({
        error:
          "This deployment sets its mail server in the environment, so it cannot be changed here.",
      })
      return
    }
    updateRuntimeConfig(deps.config.dataDir, { email: undefined })
    deps.config.email = null
    deps.config.emailSource = null
    deps.email?.reconfigure(null)
    res.json(emailSettingsView(deps))
  })

  router.patch("/instance/settings", async (req, res) => {
    const ctx = await requireInstanceAdmin(deps, req, res, { requireWriteScope: true })
    if (!ctx) return

    const { allowPublicLinks, allowAnonymousComments } = (req.body ?? {}) as Record<string, unknown>
    if (allowPublicLinks !== undefined && typeof allowPublicLinks !== "boolean") {
      res.status(400).json({ error: "allowPublicLinks must be a boolean" })
      return
    }
    if (allowAnonymousComments !== undefined && typeof allowAnonymousComments !== "boolean") {
      res.status(400).json({ error: "allowAnonymousComments must be a boolean" })
      return
    }
    if (allowAnonymousComments !== undefined) {
      await deps.storage.setInstanceSetting(
        ALLOW_ANONYMOUS_COMMENTS_KEY,
        String(allowAnonymousComments),
      )
      invalidateInstanceSettingsCache(deps.storage)
    }
    if (allowPublicLinks !== undefined) {
      await deps.storage.setInstanceSetting(ALLOW_PUBLIC_LINKS_KEY, String(allowPublicLinks))
      // IMMEDIATELY after the write, and before the read below. The reader is
      // cached (`instance-settings.ts`) so that `serve-router.ts` does not hit
      // the database once per prototype asset; this call is what makes the
      // cache correct rather than merely fast. Without it an admin turning
      // public links off would be told, by this route's own response, that
      // they are still on — and every read path would agree with that stale
      // answer for the whole TTL.
      invalidateInstanceSettingsCache(deps.storage)
    }
    // Same shape as the GET, so a client reading either sees one contract.
    res.json({
      allowPublicLinks: await getAllowPublicLinks(deps.storage),
      allowAnonymousComments: await getAllowAnonymousComments(deps.storage),
      emailFrom: deps.config.email?.from ?? null,
      email: emailSettingsView(deps),
    })
  })

  return router
}

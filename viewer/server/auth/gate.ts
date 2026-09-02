/**
 * The admission gate — the ONE place that decides whether a successfully
 * authenticated person may have an account on this instance.
 *
 * Authentication and admission are different questions, and this file exists
 * because the viewer used to answer only the first. `StorageAdapter.upsertUser`
 * created an account as a side effect of looking one up, so proving you
 * control a GitHub account was, by construction, proof that you belonged here.
 * The upsert is gone; every sign-in path now runs `admitSignIn` and either
 * gets a `User` back or gets refused.
 *
 * Two invariants hold across every path below, and every change to this file
 * has to preserve them:
 *
 * 1. **A refusal creates nothing.** No user row, and (for the caller) no
 *    session. A stranger who is turned away leaves no trace for a later
 *    invite, mention or membership to resolve against.
 * 2. **A refusal says as little as possible.** The `reason` is for the
 *    server's own branching (revoking a removed account's credentials, logging)
 *    — the caller's response must not become a membership oracle that tells an
 *    anonymous visitor which addresses have accounts here.
 */

import type { ViewerConfig } from "../config"
import { ConflictError } from "../storage/errors"
import type { DomainRule, InstanceInvite, StorageAdapter, User } from "../storage/types"

/**
 * The identity a completed authentication produced. Provider-neutral on
 * purpose: the GitHub callback, an invite link and a magic link all build one
 * of these, and the gate treats them identically.
 */
export interface SignInProfile {
  provider: "github" | "email"
  /** Null for the email lanes (invite links, magic links) — they carry no provider identity. */
  providerUserId: string | null
  email: string
  displayName: string
  avatarUrl: string
}

export type GateResult =
  | { admitted: true; user: User }
  | { admitted: false; reason: "not-invited" | "removed" | "conflict" }

export interface GateDeps {
  storage: StorageAdapter
}

export interface AdmitOptions {
  /**
   * An invite the CALLER has already verified (parsed, looked up by id, and
   * hash-matched in constant time — see `one-time-token.ts`). The gate checks
   * only what it can decide for itself: that the invite is for this email, and
   * that it is still claimable.
   *
   * Optional for a second reason beyond "no invite was involved": when a
   * caller has no token to verify — GitHub sign-in, a magic link — rung 2
   * looks one up FOR ITSELF by email (`getPendingInstanceInviteByEmail`), so
   * omitting this is how a caller opts into that lookup rather than a sign
   * that no invite applies. Pass one explicitly only when a token was
   * actually verified; that invite is the one the person clicked, which may
   * differ from "whatever is pending for this email" if more than one ever
   * existed.
   */
  invite?: InstanceInvite
  /**
   * Set by the caller when the request's EXISTING session belongs to the local
   * operator — the "configure GitHub later" upgrade. See rung 4.
   */
  localOperatorHandoff?: boolean
}

const REFUSED_NOT_INVITED: GateResult = { admitted: false, reason: "not-invited" }

/**
 * Runs after EVERY successful authentication. The decision ladder, in order:
 *
 * 1. **An existing account** — found by provider identity, or (when that
 *    misses, or the profile carries no identity) by email. `removed` is
 *    refused here and nowhere else, which is what makes removal stick: if a
 *    later rung could admit, removing someone whose domain is auto-admitted
 *    would do nothing at all. Otherwise a missing provider identity is linked
 *    on, and a PROVIDER-backed profile refreshes the stored one.
 * 2. **An invite for this email** — the CALLER-supplied one
 *    (`opts.invite`) if there is one, otherwise whatever pending invite
 *    storage has for this email. Claimed atomically, then the account is
 *    created at the invite's role. Looking one up here — not only accepting
 *    one handed in — is what makes an invite work regardless of which door
 *    the person walks through: an admin's invite must still land at GitHub
 *    sign-in or a self-serve magic link, not only at the emailed
 *    `/auth/invite/<token>` URL itself.
 * 3. **The local-operator handoff** — created at `admin`. Without this rung
 *    the operator's own first GitHub sign-in would be refused: their
 *    `operator@localhost` row makes `countUsers()` nonzero, so rung 4 can
 *    never fire for them.
 * 4. **First-user bootstrap** (`countUsers() === 0`) — created at `admin`.
 *    Covers an instance configured with GitHub from its very first boot, where
 *    no local-operator token was ever minted.
 * 5. **A domain rule for this email's domain** — the account is created at
 *    the rule's role.
 * 6. **Refused.**
 *
 * **Why the two admin rungs sit ABOVE the domain rule.** An empty instance
 * must always end up with an admin. Domain rules used to be checked first, and
 * because `seedDomainRulesFromEnv` writes a `viewer` rule per configured
 * domain at boot, a brand-new instance configured with GitHub AND
 * `VIEWER_ALLOWED_EMAIL_DOMAINS` would create its first user — the person who
 * set the deployment up — at `viewer`, leaving nobody able to administer it
 * short of the `VIEWER_ADMIN_TOKEN` escape hatch. A domain rule is a standing
 * blanket policy; bootstrap and the handoff are one-shot facts about who owns
 * this deployment, and a blanket policy must not outrank them.
 *
 * **Why the invite still outranks both.** An invite is an explicit act naming
 * one address and one role, so it is the most specific intent in the ladder —
 * including on an empty instance, where an `adminToken`-minted invite at
 * `viewer` must produce a `viewer`, not an accidental admin. It is also the
 * only rung whose role someone deliberately chose.
 *
 * `ConflictError` from storage — the audit-S18 shapes: an ambiguous email, an
 * identity that belongs to another account, an email another account holds —
 * is a refusal, never a 500 and never a silent admission. Any OTHER storage
 * failure propagates: converting it to "not invited" would turn a broken
 * database into a deployment that quietly refuses everyone, which is
 * indistinguishable from a working invite-only instance.
 */
export async function admitSignIn(
  deps: GateDeps,
  profile: SignInProfile,
  opts: AdmitOptions = {},
): Promise<GateResult> {
  const { storage } = deps
  // Lowercased at the door so every lookup and every write below agrees.
  // `createUser`/`updateUserProfile` lowercase internally too; doing it here
  // means the reads and the writes cannot disagree via a storage-layer detail.
  const email = profile.email.trim().toLowerCase()

  try {
    // ---- Rung 1: an existing account -------------------------------------
    //
    // The identity lookup runs first because it is the stable key: a person
    // who changed their address on GitHub is still the same account. The email
    // lookup is the fallback, and it is what lets an account invited by email
    // (no identity yet) be claimed by its owner's first real sign-in.
    const identity = providerIdentityOf(profile)
    // The profile as this function will WRITE it: lowercased email, and the
    // same provider identity the lookup below uses. Deriving both from
    // `providerIdentityOf` is what keeps "the identity we search by" and "the
    // identity we store" from drifting apart — a value this function refuses
    // to look up by must never end up on a row as though it were one.
    const normalized: SignInProfile = {
      ...profile,
      email,
      providerUserId: identity?.providerUserId ?? null,
    }

    const byIdentity = identity
      ? await storage.getUserByProviderIdentity(identity.provider, identity.providerUserId)
      : null
    const existing = byIdentity ?? (await storage.getUserByEmail(email))

    if (existing) {
      if (existing.status === "removed") return { admitted: false, reason: "removed" }

      // A supplied invite for this exact email is consumed here too, even
      // though rung 1 is about to admit without needing it. Without this, an
      // invite that resolves to an account that already exists — the
      // duplicate-invite race `POST /instance/invites` documents (two live
      // invites for one address, the first click creates the account, the
      // second lands here) — never gets marked used, and stays a working,
      // clickable credential to that account for its whole remaining TTL.
      // Best-effort: the result is ignored, because an invite that is
      // already used or revoked simply fails this claim, which is fine — and
      // no role change follows from it either way. Rung 1 owns an existing
      // row's role.
      if (opts.invite && opts.invite.email.trim().toLowerCase() === email) {
        await storage.claimInstanceInvite(opts.invite.id, new Date().toISOString())
      }

      let user = existing
      // Linking is attempted whenever the row was NOT the one the identity
      // lookup found — including when it already carries a DIFFERENT identity,
      // which `linkProviderIdentity` refuses. That refusal is audit S18 at the
      // sign-in door: a corporate address reassigned to a second GitHub
      // account must not inherit the first one's row, and with it every
      // membership and comment stamped on that id. Skipping the call when
      // `providerUserId` is already set would turn exactly that case into a
      // silent admission.
      if (identity && byIdentity === null) {
        user = await storage.linkProviderIdentity(
          user.id,
          identity.provider,
          identity.providerUserId,
        )
      }
      // A PROVIDER-backed sign-in refreshes the stored profile, so a display
      // name or avatar changed at the provider shows up here without an admin
      // doing anything. Deliberately NOT the role or the status — "GitHub says
      // this person renamed themselves" must never travel on the same call as
      // "this person may now administer the instance".
      //
      // **An `email` profile refreshes NOTHING.** It is synthetic: the email
      // lanes have no provider to read a real name or avatar from, so they
      // build `displayName` from the address's local part and `avatarUrl: ""`.
      // Writing that over an existing row would mean an already-linked GitHub
      // user who clicks an invite or a magic link has their real name replaced
      // by "mo" and their avatar blanked — a downgrade dressed up as a refresh.
      // Proving control of an address is not evidence about anyone's name.
      // (Nothing is linked either, but that falls out already: an email profile
      // carries no identity, so `identity` is null above.)
      if (profile.provider !== "email") {
        user = await storage.updateUserProfile(user.id, {
          email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
        })
      }

      // The local-operator handoff, when it lands on a row that ALREADY
      // exists. Rung 3 below only fires when no account exists yet, but an
      // operator's GitHub identity — or an email a domain rule already
      // auto-created — can easily have a row here at a role below admin.
      // Without this, that sign-in would silently stay at its old role
      // forever, on the very deployment the operator owns. The caller
      // already vouches for possession of the boot-printed token, which is
      // exactly the evidence rung 3 accepts to create an admin from nothing,
      // so it is enough to PROMOTE an existing row too.
      if (opts.localOperatorHandoff && user.role !== "admin") {
        user = await storage.updateUserRole(user.id, "admin")
      }

      return { admitted: true, user }
    }

    // No account. From here every rung either CREATES one or refuses; nothing
    // below may mutate an existing row.

    // ---- Rung 2: an invite ----------------------------------------------
    //
    // A caller-supplied invite (the `/auth/invite/<token>` route) wins when
    // present — it is hash-verified against the exact token the person
    // clicked. Every OTHER door (GitHub sign-in, a magic link) never carries
    // a token at all, so this falls back to looking one up by email. Without
    // this fallback an admin's invite only ever worked if the recipient
    // clicked the emailed link specifically — choosing "Sign in with GitHub"
    // instead silently dropped it and fell through to a domain rule (or
    // refusal), even though a pending invite named that exact address.
    const invite = opts.invite ?? (await storage.getPendingInstanceInviteByEmail(email))
    if (invite && invite.email.trim().toLowerCase() === email && isClaimable(invite)) {
      // The claim is atomic and it happens HERE, not in the caller, so a
      // double-clicked invite link cannot mint two accounts: the second
      // request's claim returns false and falls through (and once the first
      // has created the account, rung 1 picks it up instead).
      const claimed = await storage.claimInstanceInvite(invite.id, new Date().toISOString())
      if (claimed) {
        try {
          return { admitted: true, user: await createFor(storage, normalized, invite.role) }
        } catch (err) {
          // Compensating action: the claim above already marked the invite
          // used, so a failure here — anything from `createUser` onward —
          // must not leave it spent. Without this, a retry hits the
          // already-used branch and the person is stranded until an admin
          // regenerates the invite. Best-effort: if the rollback itself
          // fails, the ORIGINAL error is still what propagates (or gets
          // classified by the `ConflictError` handling below), never masked
          // by a rollback failure.
          try {
            await storage.unclaimInstanceInvite(invite.id)
          } catch (rollbackErr) {
            console.error(
              `[viewer] failed to roll back invite claim ${invite.id} after account creation failed:`,
              rollbackErr,
            )
          }
          throw err
        }
      }
    }

    // ---- Rung 3: the local-operator handoff ------------------------------
    //
    // The caller vouches for this: possession of a live local-operator session
    // is possession of a token printed to the server's own stdout. Admin is
    // definitional rather than a policy choice — whoever holds that token owns
    // the process.
    if (opts.localOperatorHandoff) {
      return { admitted: true, user: await createFor(storage, normalized, "admin") }
    }

    // ---- Rung 4: first-user bootstrap ------------------------------------
    //
    // Above the domain rule deliberately — see this function's doc comment.
    // An empty instance must always end up with an admin, and a seeded
    // `viewer` domain rule must not be what decides who set the deployment up.
    //
    // `createUserIfInstanceEmpty` does the "is this instance empty" check and
    // the insert as ONE atomic storage operation — not `countUsers()` then
    // `createFor()` as two separate awaits, which is exactly the gap two
    // concurrent first sign-ins could both land in: both observe zero, both
    // get created as admin. Counting removed accounts too (same as
    // `countUsers`) is the storage layer's job now; see that method's doc
    // comment.
    const bootstrapped = await storage.createUserIfInstanceEmpty({
      provider: normalized.provider,
      providerUserId: normalized.providerUserId,
      email: normalized.email,
      displayName: normalized.displayName,
      avatarUrl: normalized.avatarUrl,
      role: "admin",
    })
    if (bootstrapped) {
      return { admitted: true, user: bootstrapped }
    }

    // ---- Rung 5: a domain rule ------------------------------------------
    const rule = await matchDomainRule(storage, email)
    if (rule) {
      return { admitted: true, user: await createFor(storage, normalized, rule.role) }
    }

    // ---- Rung 6 ----------------------------------------------------------
    return REFUSED_NOT_INVITED
  } catch (err) {
    if (err instanceof ConflictError) return { admitted: false, reason: "conflict" }
    throw err
  }
}

/**
 * The provider identity to look up by, or null when this profile has none.
 * Narrowed to `"github"` because that is what `getUserByProviderIdentity` and
 * `linkProviderIdentity` accept — the email lanes deliberately carry no
 * identity, so there is nothing to widen for yet.
 */
function providerIdentityOf(
  profile: SignInProfile,
): { provider: "github"; providerUserId: string } | null {
  if (profile.provider !== "github") return null
  if (profile.providerUserId === null || profile.providerUserId === "") return null
  return { provider: "github", providerUserId: profile.providerUserId }
}

/**
 * Whether an invite can still be claimed. `claimInstanceInvite` enforces
 * unused-and-unrevoked atomically, so those two are re-checked here only to
 * avoid a pointless write; EXPIRY is the one this adds. Callers are expected
 * to check expiry themselves (they own the user-visible "that link is no
 * longer valid" copy), so this is defense in depth — the gate must not admit
 * on an expired invite just because a caller forgot to look.
 */
function isClaimable(invite: InstanceInvite): boolean {
  if (invite.usedAt !== null || invite.revokedAt !== null) return false
  return invite.expiresAt > new Date().toISOString()
}

/**
 * The domain rule for this address, or null.
 *
 * Compares the WHOLE domain, never a suffix: a rule for `example.com` must not
 * admit `evil-example.com`, `example.com.evil.test`, or a subdomain that the
 * rule's author never granted. `lastIndexOf("@")` because the local part of an
 * address may itself contain an `@` in quoted form.
 *
 * **Exported so `POST /auth/magic-link` uses the same one.** That route has to
 * answer "would this address be admitted by a domain rule?" BEFORE any account
 * exists, in order to decide whether to send a self-serve join link at all — a
 * second implementation of the suffix rule would be a second chance to write
 * `endsWith`, and the two would then disagree about `evil-example.com` in
 * opposite directions (a link mailed to an address the gate refuses, or no
 * link mailed to one it would admit). It is a PREDICTION of what the gate will
 * decide, never an authorization: the gate re-decides on the click, which is
 * what makes a rule deleted in between still stick.
 */
export async function matchDomainRule(
  storage: Pick<StorageAdapter, "listDomainRules">,
  lowercasedEmail: string,
): Promise<DomainRule | null> {
  const at = lowercasedEmail.lastIndexOf("@")
  if (at === -1 || at === lowercasedEmail.length - 1) return null
  const domain = lowercasedEmail.slice(at + 1)
  const rules = await storage.listDomainRules()
  return rules.find((rule) => rule.domain.trim().toLowerCase() === domain) ?? null
}

/**
 * The single account-creating call. Every admitting rung past rung 1 goes
 * through it, and it takes the NORMALIZED profile — see `admitSignIn`.
 */
async function createFor(
  storage: StorageAdapter,
  profile: SignInProfile,
  role: User["role"],
): Promise<User> {
  return storage.createUser({
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    role,
  })
}

/** The `instance_settings` key that marks this conversion as having run. See `seedDomainRulesFromEnv`. */
export const DOMAIN_RULES_SEEDED_FROM_ENV_KEY = "domainRulesSeededFromEnv"

/**
 * Boot-time conversion of `VIEWER_ALLOWED_EMAIL_DOMAINS` into stored domain
 * rules — the one-way bridge off the env var.
 *
 * The env var used to be an admission gate all by itself, rechecked on every
 * request. Admission now lives in `admitSignIn` and rules live in the database
 * where an admin can edit them, so on the first boot after the upgrade the
 * configured domains are written in as `viewer` rules and the env var stops
 * meaning anything.
 *
 * Runs ONCE, gated on an explicit marker (`DOMAIN_RULES_SEEDED_FROM_ENV_KEY`
 * in `instance_settings`) — **not** on the table being empty. It used to be
 * row-count-based, and that reopened a hole: an admin who deletes the last
 * domain rule while the env var is still set got every configured domain
 * restored on the next restart, silently undoing a revocation. The marker is
 * set once this function has reached a decision, so a later boot never
 * re-evaluates even if the table is empty again by then.
 *
 * The empty-table check still runs too, but only to decide what a
 * marker-less first run should DO, never to decide whether to run at all:
 * an instance that already had rules before this marker existed (no marker,
 * non-empty table) must defer to them rather than write env-var rules on
 * top, and this is what makes that check still matter. Either way the
 * marker is set at the end, so that decision is itself made only once.
 *
 * It lives in this file, and not inline in `server/index.ts`, for the reason
 * `shouldMintLocalOperatorToken` gives — `index.ts` is the process entry, so a
 * condition written there is unprotected by the entire test suite.
 *
 * **Not every entry converts.** `parseAllowedEmailDomains` accepts an EXACT
 * ADDRESS as well as a domain — an entry containing `@` admitted exactly that
 * person, which let an operator add one outside contractor without opening a
 * whole domain. A domain rule cannot express that (`matchDomainRule` compares
 * against the part after the `@`, which never contains one), so writing such
 * an entry in as a "domain" would store a rule that can never match anything
 * and read, in the settings UI, as though that person still had access. Those
 * entries are skipped and named in their own warning instead: an invite is the
 * thing that replaces them.
 *
 * Known limitation, deliberately not worked around: a PARTIAL failure is
 * sticky. If the second of three writes throws, the first rule exists and the
 * marker is never reached (the throw propagates first), so the next boot
 * sees a non-empty table, defers to it, and never retries the remaining two.
 * The failure direction is closed (a missing rule admits nobody), and the
 * caller logs loudly; the fix is for the admin to add the rule in the
 * product.
 */
export async function seedDomainRulesFromEnv(
  storage: Pick<
    StorageAdapter,
    "listDomainRules" | "setDomainRule" | "getInstanceSetting" | "setInstanceSetting"
  >,
  config: Pick<ViewerConfig, "allowedEmailDomains">,
): Promise<void> {
  const entries = config.allowedEmailDomains
  // An EMPTY array means "allow everyone" (`parseAllowedEmailDomains`
  // normalizes a configured-but-empty value to null precisely so it is never
  // an accidental deny-all), so it must not seed a deny-all here either.
  // Deliberately does NOT set the marker: there is nothing to decide yet, so
  // a later boot where the operator actually configures the env var must
  // still get to make that decision.
  if (!entries || entries.length === 0) return

  // The one-shot guard. Once this is set, nothing below ever runs again.
  if ((await storage.getInstanceSetting(DOMAIN_RULES_SEEDED_FROM_ENV_KEY)) !== null) return

  // Only a marker-less instance with an EMPTY table gets env-var rules
  // written. A marker-less instance that already has rules (it pre-dates
  // this marker) defers to them instead — same as the original row-count
  // gate — but still reaches the `setInstanceSetting` below, so this whole
  // block is never re-entered on a later boot either.
  if ((await storage.listDomainRules()).length === 0) {
    const domains = entries.filter((entry) => !entry.includes("@"))
    const addresses = entries.filter((entry) => entry.includes("@"))

    for (const domain of domains) {
      await storage.setDomainRule({ domain, role: "viewer", createdByUserId: null })
    }

    if (domains.length > 0) {
      console.warn(
        `[viewer] VIEWER_ALLOWED_EMAIL_DOMAINS has been converted into ${domains.length} domain rule(s) ` +
          `(role: viewer): ${domains.join(", ")}. The environment variable is otherwise ignored now. ` +
          "Manage domains from Settings › Domain rules.",
      )
    }
    if (addresses.length > 0) {
      console.warn(
        `[viewer] VIEWER_ALLOWED_EMAIL_DOMAINS lists ${addresses.length} individual address(es) that ` +
          `could NOT be converted into domain rules: ${addresses.join(", ")}. Invite them from the ` +
          "members page instead. Until then, they cannot sign in.",
      )
    }
  }

  await storage.setInstanceSetting(DOMAIN_RULES_SEEDED_FROM_ENV_KEY, "true")
}

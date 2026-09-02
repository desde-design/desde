import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { ConflictError } from "../storage/errors"
import type { InstanceInvite, InstanceRole, StorageAdapter } from "../storage/types"
import {
  admitSignIn,
  DOMAIN_RULES_SEEDED_FROM_ENV_KEY,
  seedDomainRulesFromEnv,
  type SignInProfile,
} from "./gate"
import { generateOneTimeToken } from "./one-time-token"

/** A GitHub sign-in profile, the shape the OAuth callback builds. */
function githubProfile(overrides: Partial<SignInProfile> = {}): SignInProfile {
  return {
    provider: "github",
    providerUserId: "gh-1",
    email: "mo@example.com",
    displayName: "Mo",
    avatarUrl: "https://avatars.example.com/mo.png",
    ...overrides,
  }
}

/** An email sign-in profile (invite link / magic link), which carries no provider identity. */
function emailProfile(overrides: Partial<SignInProfile> = {}): SignInProfile {
  return {
    provider: "email",
    providerUserId: null,
    email: "mo@example.com",
    displayName: "mo",
    avatarUrl: "",
    ...overrides,
  }
}

async function seedInvite(
  storage: StorageAdapter,
  opts: { email: string; role?: InstanceRole; expiresAt?: string },
): Promise<InstanceInvite> {
  const gen = generateOneTimeToken("dsi")
  return storage.createInstanceInvite({
    id: gen.id,
    email: opts.email,
    role: opts.role ?? "editor",
    tokenHash: gen.tokenHash,
    createdByUserId: null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
  })
}

/** Wraps a real adapter, replacing one method. Same technique machine-token.test.ts uses. */
function withMethod<K extends keyof StorageAdapter>(
  inner: StorageAdapter,
  method: K,
  impl: StorageAdapter[K],
): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === method) return impl
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** An existing account, so `countUsers()` is nonzero and the bootstrap rung cannot fire. */
async function seedUnrelatedAccount(storage: StorageAdapter) {
  return storage.createUser({
    provider: "github",
    providerUserId: "someone-else",
    email: "someone@else.test",
    displayName: "Someone",
    avatarUrl: "",
    role: "admin",
  })
}

describe("admitSignIn — rung 1: an existing account", () => {
  it("admits a known provider identity and refreshes its profile", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Old Name",
      avatarUrl: "https://old.example/avatar.png",
      role: "viewer",
    })

    const result = await admitSignIn(
      { storage },
      githubProfile({ displayName: "New Name", avatarUrl: "https://new.example/a.png" }),
    )

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    expect(result.user.displayName).toBe("New Name")
    expect(result.user.avatarUrl).toBe("https://new.example/a.png")
    // The role is NOT re-derived on a returning sign-in — an admin who later
    // matches a `viewer` domain rule must not be silently demoted by it.
    expect(result.user.role).toBe("viewer")
    expect(await storage.countUsers()).toBe(1)
  })

  it("refuses a removed account", async () => {
    const storage = new InMemoryStorage()
    const user = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    await storage.setUserStatus(user.id, "removed")

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result).toEqual({ admitted: false, reason: "removed" })
  })

  /**
   * The rung ordering is what makes "removed" mean removed. If a later rung
   * could admit, then removing someone whose domain is auto-admitted would do
   * nothing at all — they would simply be re-admitted (at the rule's role) on
   * their next sign-in.
   */
  it("keeps a removed account refused even when a domain rule matches their email", async () => {
    const storage = new InMemoryStorage()
    const user = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    await storage.setUserStatus(user.id, "removed")
    await storage.setDomainRule({ domain: "example.com", role: "editor", createdByUserId: null })

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "removed",
    })
    expect((await storage.getUser(user.id))?.status).toBe("removed")
    expect(await storage.countUsers()).toBe(1)
  })

  it("keeps a removed account refused even when they hold a matching invite", async () => {
    const storage = new InMemoryStorage()
    const user = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    await storage.setUserStatus(user.id, "removed")
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })

    expect(await admitSignIn({ storage }, githubProfile(), { invite })).toEqual({
      admitted: false,
      reason: "removed",
    })
    // The invite is left unclaimed — a refusal must not consume it.
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).toBeNull()
  })

  /**
   * The claim-an-email-account branch: invited by email, never signed in, then
   * signs in with GitHub for the first time. ONE row, now carrying both.
   */
  it("links a provider identity onto an email-created account with the same address", async () => {
    const storage = new InMemoryStorage()
    const invited = await storage.createUser({
      provider: "email",
      providerUserId: null,
      email: "mo@example.com",
      displayName: "mo",
      avatarUrl: "",
      role: "editor",
    })

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(invited.id)
    expect(result.user.provider).toBe("github")
    expect(result.user.providerUserId).toBe("gh-1")
    expect(result.user.displayName).toBe("Mo")
    expect(result.user.role).toBe("editor")
    expect(await storage.countUsers()).toBe(1)
  })

  it("matches an existing account case-insensitively on email", async () => {
    const storage = new InMemoryStorage()
    const invited = await storage.createUser({
      provider: "email",
      providerUserId: null,
      email: "mo@example.com",
      displayName: "mo",
      avatarUrl: "",
      role: "viewer",
    })

    const result = await admitSignIn({ storage }, githubProfile({ email: "MO@Example.COM" }))

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(invited.id)
    expect(result.user.email).toBe("mo@example.com")
    expect(await storage.countUsers()).toBe(1)
  })

  /**
   * Audit S18, at the sign-in door. A corporate address reassigned to a SECOND
   * GitHub account must not inherit the first one's row — and with it every
   * membership and every comment that row is stamped on.
   */
  it("refuses with 'conflict' when the email's account already carries a different identity", async () => {
    const storage = new InMemoryStorage()
    const first = await storage.createUser({
      provider: "github",
      providerUserId: "gh-original",
      email: "mo@example.com",
      displayName: "Original",
      avatarUrl: "",
      role: "admin",
    })

    const result = await admitSignIn({ storage }, githubProfile({ providerUserId: "gh-second" }))

    expect(result).toEqual({ admitted: false, reason: "conflict" })
    // Nothing about the original account moved.
    const after = await storage.getUser(first.id)
    expect(after?.providerUserId).toBe("gh-original")
    expect(after?.displayName).toBe("Original")
    expect(await storage.countUsers()).toBe(1)
  })

  it("refuses with 'conflict' when the profile's new email belongs to another account", async () => {
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "old@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "editor",
    })
    await storage.createUser({
      provider: "github",
      providerUserId: "gh-2",
      email: "taken@example.com",
      displayName: "Someone",
      avatarUrl: "",
      role: "editor",
    })

    const result = await admitSignIn({ storage }, githubProfile({ email: "taken@example.com" }))

    expect(result).toEqual({ admitted: false, reason: "conflict" })
    expect(await storage.countUsers()).toBe(2)
  })

  it("refuses with 'conflict' when the email lookup itself is ambiguous (S18)", async () => {
    const inner = new InMemoryStorage()
    await seedUnrelatedAccount(inner)
    const storage = withMethod(inner, "getUserByEmail", async () => {
      throw new ConflictError("multiple accounts hold that email")
    })

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "conflict",
    })
    expect(await inner.countUsers()).toBe(1)
  })

  it("admits an email sign-in for an existing account without touching its identity", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "https://avatars.example.com/mo.png",
      role: "admin",
    })

    const result = await admitSignIn({ storage }, emailProfile())

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    expect(result.user.providerUserId).toBe("gh-1")
    expect(result.user.role).toBe("admin")
  })

  /**
   * A SYNTHETIC profile must never overwrite a real one.
   *
   * The email lanes have no provider to read a name or an avatar from, so they
   * build `displayName` from the address's local part and `avatarUrl: ""` —
   * exactly the shape below. Refreshing on that would mean an already-linked
   * GitHub user who clicks an invite (or, later, a magic link) has their real
   * name replaced by "mo" and their avatar blanked. Proving control of an
   * address is not evidence about anybody's name.
   */
  it("does not let an email profile overwrite a real display name or avatar", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo Chang",
      avatarUrl: "https://avatars.example.com/mo.png",
      role: "editor",
    })

    // The invite-click shape: local part as the name, no avatar.
    const result = await admitSignIn(
      { storage },
      emailProfile({ displayName: "mo", avatarUrl: "" }),
    )

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    expect(result.user.displayName).toBe("Mo Chang")
    expect(result.user.avatarUrl).toBe("https://avatars.example.com/mo.png")
    // …and the stored row, not just what the gate handed back.
    const stored = await storage.getUser(existing.id)
    expect(stored?.displayName).toBe("Mo Chang")
    expect(stored?.avatarUrl).toBe("https://avatars.example.com/mo.png")
  })

  it("still refreshes the profile on a provider-backed sign-in", async () => {
    // The counterpart: GitHub HAS a real name and avatar to report, so it
    // keeps overwriting. Paired with the test above so a future "just stop
    // refreshing" simplification cannot pass.
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Old Name",
      avatarUrl: "https://old.example/a.png",
      role: "editor",
    })

    const result = await admitSignIn({ storage }, githubProfile({ displayName: "Mo Chang" }))

    expect(result.admitted && result.user.displayName).toBe("Mo Chang")
  })

  /**
   * C2a: the local-operator handoff is not only rung 3's "create at admin".
   * An operator's GitHub identity can easily already have an account here —
   * invited earlier, or auto-created by a domain rule — at a role BELOW
   * admin. Rung 3 never fires in that case (rung 1 already found a row), so
   * without this the operator's own handoff sign-in would silently stay
   * "viewer" forever on the very deployment they own.
   */
  it("promotes an existing row to admin when the caller proves an operator session (handoff onto an existing account)", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "viewer",
    })

    const result = await admitSignIn({ storage }, githubProfile(), { localOperatorHandoff: true })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    expect(result.user.role).toBe("admin")
  })

  it("does not touch the role of an existing row when there is no handoff", async () => {
    // The control case: without the flag, an ordinary sign-in must never
    // promote anyone, or every viewer's next GitHub sign-in would silently
    // become an escalation vector.
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "viewer",
    })

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result.admitted && result.user.role).toBe("viewer")
  })

  /**
   * Fix wave 10, item 1. Reachable via the duplicate-invite race
   * `POST /instance/invites` documents: two live invites for the same
   * address, the first click creates the account (rung 2), the second lands
   * here at rung 1 — an existing account. Before this fix rung 1 returned
   * admitted without ever calling `claimInstanceInvite`, so the SECOND
   * invite's `usedAt` stayed null and the link stayed redeemable for its
   * whole remaining TTL even though the account it names already exists.
   */
  it("consumes a supplied invite when the account it resolves to already exists", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "viewer",
    })
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })

    const result = await admitSignIn({ storage }, githubProfile(), { invite })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    // No role change — rung 1 owns an existing row's role, the invite's role
    // is not applied.
    expect(result.user.role).toBe("viewer")

    const stored = await storage.getInstanceInvite(invite.id)
    expect(stored?.usedAt).not.toBeNull()
  })

  it("does not throw or double-admit when the supplied invite is already spent", async () => {
    const storage = new InMemoryStorage()
    const existing = await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "viewer",
    })
    const invite = await seedInvite(storage, { email: "mo@example.com" })
    await storage.claimInstanceInvite(invite.id, new Date().toISOString())

    const result = await admitSignIn({ storage }, githubProfile(), { invite })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.id).toBe(existing.id)
    expect(await storage.countUsers()).toBe(1)
  })

  it("does not consume an invite issued to a different email than the one that matched", async () => {
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "gh-1",
      email: "mo@example.com",
      displayName: "Mo",
      avatarUrl: "",
      role: "viewer",
    })
    const otherInvite = await seedInvite(storage, { email: "someone-else@example.com" })

    const result = await admitSignIn({ storage }, githubProfile(), { invite: otherInvite })

    expect(result.admitted).toBe(true)
    const stored = await storage.getInstanceInvite(otherInvite.id)
    expect(stored?.usedAt).toBeNull()
  })
})

describe("admitSignIn — rung 2: an invite", () => {
  it("claims a matching invite and creates the account at the invite's role", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "editor" })

    const result = await admitSignIn({ storage }, emailProfile(), { invite })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.email).toBe("mo@example.com")
    expect(result.user.role).toBe("editor")
    expect(result.user.provider).toBe("email")
    expect(result.user.providerUserId).toBeNull()
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
  })

  it("carries an admin invite's role through", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })

    const result = await admitSignIn({ storage }, emailProfile(), { invite })

    expect(result.admitted && result.user.role).toBe("admin")
  })

  it("does NOT admit on an invite issued to a different email", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "other@example.com", role: "admin" })

    expect(await admitSignIn({ storage }, emailProfile(), { invite })).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    // And the mismatched invite is left untouched, still usable by its owner.
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).toBeNull()
    expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
  })

  it("matches the invite email case-insensitively", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "MO@Example.com", role: "viewer" })

    const result = await admitSignIn({ storage }, emailProfile({ email: "mo@EXAMPLE.com" }), {
      invite,
    })

    expect(result.admitted && result.user.role).toBe("viewer")
  })

  /**
   * The claim is atomic and lives INSIDE the gate, so a double-clicked invite
   * link cannot mint two accounts. The second pass sees a used invite; with no
   * account yet (this test deletes nothing, it simply re-runs the gate against
   * an already-claimed invite), no rung admits.
   */
  it("does not admit twice on one invite", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "editor" })
    await storage.claimInstanceInvite(invite.id, new Date().toISOString())
    const claimed = (await storage.getInstanceInvite(invite.id))!

    expect(await admitSignIn({ storage }, emailProfile(), { invite: claimed })).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
  })

  it("does not admit on a revoked invite", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, { email: "mo@example.com" })
    await storage.revokeInstanceInvite(invite.id)
    const revoked = (await storage.getInstanceInvite(invite.id))!

    expect(await admitSignIn({ storage }, emailProfile(), { invite: revoked })).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
  })

  it("does not admit on an expired invite", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    const invite = await seedInvite(storage, {
      email: "mo@example.com",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    expect(await admitSignIn({ storage }, emailProfile(), { invite })).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).toBeNull()
  })

  it("prefers the invite's role over a domain rule that also matches", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })

    const result = await admitSignIn({ storage }, emailProfile(), { invite })

    expect(result.admitted && result.user.role).toBe("admin")
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
  })

  /**
   * C3: rung 2 must honour a pending invite on EVERY door, not only the
   * `/auth/invite/<token>` link — GitHub sign-in and a magic link never
   * carry a token to verify, so when the caller supplies no `opts.invite`
   * the gate looks one up by email itself. Without this, an admin's invite
   * only worked if the recipient clicked the exact emailed link; choosing
   * "Sign in with GitHub" instead silently fell through to whatever rung
   * came next (here, a domain rule at a LOWER role).
   */
  describe("a pending invite the caller did not supply", () => {
    it("outranks a domain rule that also matches, on a plain GitHub sign-in", async () => {
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
      const invite = await seedInvite(storage, { email: "mo@example.com", role: "editor" })

      // No `opts.invite` at all — this is what a GitHub callback passes.
      const result = await admitSignIn({ storage }, githubProfile())

      expect(result.admitted).toBe(true)
      if (!result.admitted) return
      expect(result.user.role).toBe("editor")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })

    it("admits a plain GitHub sign-in at the invite's role when no domain rule exists at all", async () => {
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      const invite = await seedInvite(storage, { email: "mo@example.com", role: "viewer" })

      const result = await admitSignIn({ storage }, githubProfile())

      expect(result.admitted).toBe(true)
      if (!result.admitted) return
      expect(result.user.role).toBe("viewer")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })

    it("is honoured on the email lane too (magic-link self-serve), at the invite's role", async () => {
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
      const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })

      const result = await admitSignIn({ storage }, emailProfile())

      expect(result.admitted && result.user.role).toBe("admin")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })

    it("does not fire when no pending invite exists for the address — falls through normally", async () => {
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })

      const result = await admitSignIn({ storage }, githubProfile())

      expect(result.admitted && result.user.role).toBe("viewer")
    })

    it("does not resurrect a USED invite on a later sign-in", async () => {
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      const invite = await seedInvite(storage, { email: "mo@example.com", role: "admin" })
      await storage.claimInstanceInvite(invite.id, new Date().toISOString())

      // No account exists yet for mo@example.com (the invite was claimed
      // without one ever being created — same shape "does not admit twice on
      // one invite" above exercises with a supplied invite). A used invite
      // must not be looked up as though it were still pending.
      expect(await admitSignIn({ storage }, githubProfile())).toEqual({
        admitted: false,
        reason: "not-invited",
      })
    })

    it("an explicitly supplied invite still wins over a lookup, when both are present", async () => {
      // Defensive: a caller that verified a SPECIFIC token must not have its
      // choice overridden by whatever the email lookup would have found —
      // even in the (should-be-impossible) case they disagree.
      const storage = new InMemoryStorage()
      await seedUnrelatedAccount(storage)
      const looked = await seedInvite(storage, { email: "mo@example.com", role: "viewer" })
      const supplied = await storage.createInstanceInvite({
        id: "supplied000000",
        email: "mo@example.com",
        role: "admin",
        tokenHash: "h",
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })

      const result = await admitSignIn({ storage }, emailProfile(), { invite: supplied })

      expect(result.admitted && result.user.role).toBe("admin")
      expect((await storage.getInstanceInvite(supplied.id))?.usedAt).not.toBeNull()
      // The unrelated pending invite is untouched.
      expect((await storage.getInstanceInvite(looked.id))?.usedAt).toBeNull()
    })
  })

  /**
   * Wave 5, codex round 5: the invite was claimed (usedAt set), but account
   * creation threw before this function could return an admission. Without
   * a rollback, the invite stays spent and a retry hits the used-invite
   * branch — the person is stranded until an admin regenerates it.
   */
  it("rolls back the claim when account creation fails, so a retry can succeed", async () => {
    const inner = new InMemoryStorage()
    await seedUnrelatedAccount(inner)
    const invite = await seedInvite(inner, { email: "mo@example.com", role: "editor" })

    let shouldFail = true
    const storage = withMethod(inner, "createUser", async (input) => {
      if (shouldFail) throw new Error("simulated createUser failure")
      return inner.createUser(input)
    })

    await expect(admitSignIn({ storage }, emailProfile(), { invite })).rejects.toThrow(
      "simulated createUser failure",
    )
    // The compensating action: the invite is claimable again, not stranded.
    expect((await inner.getInstanceInvite(invite.id))?.usedAt).toBeNull()

    // A second attempt — this time createUser succeeds — is admitted.
    shouldFail = false
    const refreshed = (await inner.getInstanceInvite(invite.id))!
    const result = await admitSignIn({ storage }, emailProfile(), { invite: refreshed })
    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.email).toBe("mo@example.com")
    expect(result.user.role).toBe("editor")
    expect((await inner.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
  })
})

describe("admitSignIn — rung 5: a domain rule", () => {
  it("admits an unknown address whose domain has a rule, at the rule's role", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.role).toBe("viewer")
    expect(result.user.provider).toBe("github")
    expect(result.user.providerUserId).toBe("gh-1")
    expect(result.user.email).toBe("mo@example.com")
  })

  it("matches the domain case-insensitively", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "editor", createdByUserId: null })

    const result = await admitSignIn({ storage }, githubProfile({ email: "MO@EXAMPLE.COM" }))

    expect(result.admitted && result.user.role).toBe("editor")
  })

  it("does not admit an address at a different domain", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "corp.example", role: "editor", createdByUserId: null })

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "not-invited",
    })
  })

  /**
   * A rule on `example.com` must not admit `mo@evil-example.com` or
   * `mo@example.com.evil.test` — the comparison is on the whole domain, never
   * a suffix or substring.
   */
  it.each([
    "mo@evil-example.com",
    "mo@example.com.evil.test",
    "mo@sub.example.com",
    "mo@xample.com",
    // An embedded `@` must not forge the domain: the real domain of
    // `evil@example.com@attacker.com` is `attacker.com`, which is why
    // `matchDomainRule` splits on the LAST `@` and not the first. Inherited
    // from `isEmailAllowed`'s suite when Task 5 deleted that function — the
    // property outlived its original home.
    "evil@example.com@attacker.com",
  ])("does not admit %s under a rule for example.com", async (email) => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "admin", createdByUserId: null })

    expect(await admitSignIn({ storage }, githubProfile({ email }))).toEqual({
      admitted: false,
      reason: "not-invited",
    })
  })

  /**
   * The paired positive control for the `lastIndexOf` split above. Without it,
   * "split on the last @" could be replaced by something stricter that refuses
   * every address carrying a `+` tag and no test would notice.
   */
  it("admits a +tag address under a rule for its real domain", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })

    const result = await admitSignIn({ storage }, githubProfile({ email: "mo+tag@example.com" }))
    expect(result.admitted).toBe(true)
  })

  it("does not admit an address with no domain at all", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)
    await storage.setDomainRule({ domain: "example.com", role: "admin", createdByUserId: null })

    expect(await admitSignIn({ storage }, githubProfile({ email: "not-an-email" }))).toEqual({
      admitted: false,
      reason: "not-invited",
    })
  })
})

describe("admitSignIn — rung 3: the local-operator handoff", () => {
  /**
   * The "configure GitHub later" upgrade. Without this rung the operator's own
   * first GitHub sign-in is refused: their `operator@localhost` row makes
   * `countUsers()` nonzero, so the bootstrap rung can never fire for them.
   */
  it("creates the GitHub account at admin when the caller proves an operator session", async () => {
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "local-operator",
      email: "operator@localhost",
      displayName: "Local operator",
      avatarUrl: "",
      role: "admin",
    })

    const result = await admitSignIn({ storage }, githubProfile(), { localOperatorHandoff: true })

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.role).toBe("admin")
    expect(await storage.countUsers()).toBe(2)
  })

  it("refuses the same sign-in without the handoff flag", async () => {
    const storage = new InMemoryStorage()
    await storage.createUser({
      provider: "github",
      providerUserId: "local-operator",
      email: "operator@localhost",
      displayName: "Local operator",
      avatarUrl: "",
      role: "admin",
    })

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect(await storage.countUsers()).toBe(1)
  })
})

describe("admitSignIn — rung 4: first-user bootstrap", () => {
  it("makes the very first account an admin", async () => {
    const storage = new InMemoryStorage()
    expect(await storage.countUsers()).toBe(0)

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result.admitted).toBe(true)
    if (!result.admitted) return
    expect(result.user.role).toBe("admin")
    expect(await storage.countUsers()).toBe(1)
  })

  it("does NOT fire once any account exists", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "not-invited",
    })
  })

  /**
   * `countUsers` counts removed accounts too, deliberately. An instance whose
   * only account was removed must not read as empty — otherwise removing the
   * last admin would hand the next visitor through the door full control.
   */
  it("does NOT fire when the only account is a removed one", async () => {
    const storage = new InMemoryStorage()
    const only = await seedUnrelatedAccount(storage)
    await storage.setUserStatus(only.id, "removed")

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect(await storage.countUsers()).toBe(1)
  })

  /**
   * ORDERING — the reason bootstrap sits ABOVE the domain rule.
   *
   * `seedDomainRulesFromEnv` writes a `viewer` rule per configured domain at
   * boot, so a brand-new instance with GitHub sign-in AND
   * `VIEWER_ALLOWED_EMAIL_DOMAINS` has a matching rule waiting before its very
   * first sign-in. With the rule checked first, the person who set the
   * deployment up was created at `viewer` and NOBODY could administer the
   * instance short of the `VIEWER_ADMIN_TOKEN` escape hatch. A standing
   * blanket policy must not outrank the one-shot fact of who owns this
   * deployment.
   */
  it("makes the first account an admin even when a domain rule matches them", async () => {
    const storage = new InMemoryStorage()
    await storage.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })

    const result = await admitSignIn({ storage }, githubProfile())

    expect(result.admitted && result.user.role).toBe("admin")
  })

  /**
   * The other side of that ordering: an invite is rung 2, so it still outranks
   * the bootstrap. It names one address and one role, which makes it the most
   * specific intent in the ladder — and an `adminToken`-minted invite at
   * `viewer`, sent before anyone has signed in, must produce a `viewer` rather
   * than an accidental admin.
   */
  it("lets an invite decide the first account's role, even at a lower role than admin", async () => {
    const storage = new InMemoryStorage()
    expect(await storage.countUsers()).toBe(0)
    const invite = await seedInvite(storage, { email: "mo@example.com", role: "viewer" })

    const result = await admitSignIn({ storage }, emailProfile(), { invite })

    expect(result.admitted && result.user.role).toBe("viewer")
    expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    expect(await storage.countUsers()).toBe(1)
  })

  /**
   * Wave 2, codex round 2: `countUsers() === 0` then `createUser` used to be
   * two separate awaits here, so two concurrent first sign-ins could
   * interleave between them and both see zero — both admitted as admin. The
   * fix moved the check-then-insert into `storage.createUserIfInstanceEmpty`,
   * which does it as one atomic operation. This test would have caught the
   * old bug: with no rules and two distinct emails racing, exactly one may
   * come out an admin and the other must be refused.
   */
  it("admits exactly one of two concurrent first sign-ins as admin", async () => {
    const storage = new InMemoryStorage()
    expect(await storage.countUsers()).toBe(0)

    const [a, b] = await Promise.all([
      admitSignIn({ storage }, githubProfile({ providerUserId: "gh-race-a", email: "race-a@example.com" })),
      admitSignIn({ storage }, githubProfile({ providerUserId: "gh-race-b", email: "race-b@example.com" })),
    ])

    const admitted = [a, b].filter((r) => r.admitted)
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.admitted && admitted[0].user.role).toBe("admin")
    const refused = [a, b].find((r) => !r.admitted)
    expect(refused).toEqual({ admitted: false, reason: "not-invited" })
    expect(await storage.countUsers()).toBe(1)
  })
})

describe("admitSignIn — rung 6: refusal", () => {
  it("refuses a stranger and creates NOTHING", async () => {
    const storage = new InMemoryStorage()
    await seedUnrelatedAccount(storage)

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "not-invited",
    })
    expect(await storage.countUsers()).toBe(1)
    expect(await storage.getUserByEmail("mo@example.com")).toBeNull()
    expect(await storage.getUserByProviderIdentity("github", "gh-1")).toBeNull()
  })

  it("reports a create conflict as 'conflict', not as an admission", async () => {
    const inner = new InMemoryStorage()
    // Rung 4 (first-user bootstrap) no longer goes through `createUser` at
    // all — it uses the atomic `createUserIfInstanceEmpty`, which by
    // construction never throws `ConflictError` (wave 2, codex round 2). So
    // this exercises a rung that still does: seeding an unrelated account
    // keeps rung 4 from firing, and a domain rule (rung 5) is what reaches
    // `createFor`/`storage.createUser` below.
    await seedUnrelatedAccount(inner)
    await inner.setDomainRule({ domain: "example.com", role: "viewer", createdByUserId: null })
    const storage = withMethod(inner, "createUser", async () => {
      // The race the check-then-insert in `createUser` cannot rule out: a
      // concurrent sign-in took this email between the lookup and the write.
      throw new ConflictError("email already in use")
    })

    expect(await admitSignIn({ storage }, githubProfile())).toEqual({
      admitted: false,
      reason: "conflict",
    })
  })

  /**
   * Only `ConflictError` is a refusal. An unexpected storage failure must
   * propagate: silently converting it to "not invited" would turn a broken
   * database into a deployment that quietly refuses everyone, which reads
   * exactly like a working invite-only instance.
   */
  it("propagates an unexpected storage failure rather than refusing", async () => {
    // Rung 4 (first-user bootstrap) is what an empty instance reaches here —
    // `createUserIfInstanceEmpty` is the atomic check-and-insert that
    // replaced the old `countUsers()` + `createUser()` pair (wave 2, codex
    // round 2), so it is now the method on this path whose failure must
    // still propagate rather than read as a refusal.
    const inner = new InMemoryStorage()
    const storage = withMethod(inner, "createUserIfInstanceEmpty", async () => {
      throw new Error("simulated storage failure")
    })

    await expect(admitSignIn({ storage }, githubProfile())).rejects.toThrow(
      "simulated storage failure",
    )
  })
})

describe("admitSignIn — what gets written", () => {
  it("lowercases and trims the email it stores", async () => {
    const storage = new InMemoryStorage()
    const result = await admitSignIn({ storage }, githubProfile({ email: "  MO@Example.COM " }))
    expect(result.admitted && result.user.email).toBe("mo@example.com")
  })

  /**
   * The identity the gate would SEARCH by and the identity it STORES must be
   * the same value. An empty `providerUserId` is not something it will ever
   * look a row up by, so writing one would put a value on a row that no lookup
   * can ever match — and that row could then never be found by identity again.
   */
  it("stores no provider identity when the profile's is unusable as a lookup key", async () => {
    const storage = new InMemoryStorage()
    const result = await admitSignIn({ storage }, githubProfile({ providerUserId: "" }))
    expect(result.admitted && result.user.providerUserId).toBeNull()
  })
})

describe("seedDomainRulesFromEnv", () => {
  // The conversion warns on stdout by design (the operator needs to know their
  // env var stopped meaning anything). Silenced so it doesn't read as a
  // failure in the suite output.
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it("converts a configured allowlist into viewer-role domain rules", async () => {
    const storage = new InMemoryStorage()

    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: ["corp.example", "example.com"] })

    expect(await storage.listDomainRules()).toEqual([
      expect.objectContaining({ domain: "corp.example", role: "viewer", createdByUserId: null }),
      expect.objectContaining({ domain: "example.com", role: "viewer", createdByUserId: null }),
    ])
  })

  it("does nothing when no allowlist is configured", async () => {
    const storage = new InMemoryStorage()
    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: null })
    expect(await storage.listDomainRules()).toEqual([])
  })

  it("does nothing when the allowlist is empty (which means 'allow everyone')", async () => {
    const storage = new InMemoryStorage()
    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: [] })
    expect(await storage.listDomainRules()).toEqual([])
  })

  /**
   * One-shot conversion. Once an admin manages rules in the product, the env
   * var must never re-add one they deliberately deleted.
   */
  it("does not touch existing rules", async () => {
    const storage = new InMemoryStorage()
    await storage.setDomainRule({ domain: "kept.example", role: "admin", createdByUserId: null })

    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: ["corp.example"] })

    expect(await storage.listDomainRules()).toEqual([
      expect.objectContaining({ domain: "kept.example", role: "admin" }),
    ])
  })

  /**
   * `parseAllowedEmailDomains` accepts an EXACT ADDRESS as well as a domain —
   * that is how an operator admitted one outside contractor without opening
   * their whole domain. A domain rule cannot express it, and writing one would
   * store a rule nothing can ever match while showing that person as still
   * having access.
   */
  it("skips individual addresses rather than writing a rule that can never match", async () => {
    const storage = new InMemoryStorage()

    await seedDomainRulesFromEnv(storage, {
      allowedEmailDomains: ["corp.example", "contractor@outside.test"],
    })

    expect((await storage.listDomainRules()).map((r) => r.domain)).toEqual(["corp.example"])
    // And it says so, naming the address, rather than dropping it silently.
    expect(warn.mock.calls.flat().map(String).join(" ")).toContain("contractor@outside.test")
  })

  it("seeds nothing when every entry is an individual address", async () => {
    const storage = new InMemoryStorage()
    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: ["contractor@outside.test"] })
    expect(await storage.listDomainRules()).toEqual([])
  })

  it("never re-seeds on a second boot", async () => {
    const storage = new InMemoryStorage()
    const config = { allowedEmailDomains: ["corp.example"] }
    await seedDomainRulesFromEnv(storage, config)
    await storage.removeDomainRule("corp.example")
    await storage.setDomainRule({ domain: "other.example", role: "editor", createdByUserId: null })

    await seedDomainRulesFromEnv(storage, config)

    expect((await storage.listDomainRules()).map((r) => r.domain)).toEqual(["other.example"])
  })

  /**
   * Wave 2, codex round 2: the "never re-seeds" guard above used to be ONLY
   * "the table is non-empty" — so an admin who deletes the LAST rule while
   * `VIEWER_ALLOWED_EMAIL_DOMAINS` is still set gets every env domain
   * restored on the very next restart. That silently reopens an admission an
   * admin deliberately revoked. These three tests pin the marker-based fix.
   */
  it("seeds on a genuine first boot, and records that it happened", async () => {
    const storage = new InMemoryStorage()
    expect(await storage.getInstanceSetting(DOMAIN_RULES_SEEDED_FROM_ENV_KEY)).toBeNull()

    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: ["corp.example"] })

    expect((await storage.listDomainRules()).map((r) => r.domain)).toEqual(["corp.example"])
    expect(await storage.getInstanceSetting(DOMAIN_RULES_SEEDED_FROM_ENV_KEY)).toBe("true")
  })

  it("does not re-seed after an admin deletes every rule it wrote — the marker is what makes it one-shot, not an empty table", async () => {
    const storage = new InMemoryStorage()
    const config = { allowedEmailDomains: ["corp.example"] }
    await seedDomainRulesFromEnv(storage, config)

    // The admin revokes the domain entirely. The table is now empty again —
    // the exact same shape as a fresh instance.
    await storage.removeDomainRule("corp.example")
    expect(await storage.listDomainRules()).toEqual([])

    await seedDomainRulesFromEnv(storage, config)

    // Must NOT come back. A row-count check alone cannot tell "never seeded"
    // apart from "seeded, then deliberately emptied" — the marker can.
    expect(await storage.listDomainRules()).toEqual([])
  })

  it("on an instance with pre-existing rules but no marker (pre-dates this fix), defers to them and seeds nothing — but still sets the marker", async () => {
    const storage = new InMemoryStorage()
    // An admin-authored rule already exists, and no marker has ever been
    // written — this instance booted before the marker existed.
    await storage.setDomainRule({ domain: "kept.example", role: "admin", createdByUserId: null })

    await seedDomainRulesFromEnv(storage, { allowedEmailDomains: ["corp.example"] })

    // Untouched — nothing from the env var was added on top of it.
    expect(await storage.listDomainRules()).toEqual([
      expect.objectContaining({ domain: "kept.example", role: "admin" }),
    ])
    // But the marker is now set, so a LATER admin deletion of kept.example
    // does not cause some future boot to seed corp.example in its place.
    expect(await storage.getInstanceSetting(DOMAIN_RULES_SEEDED_FROM_ENV_KEY)).toBe("true")
  })
})

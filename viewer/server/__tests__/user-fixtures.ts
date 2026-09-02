import type { InstanceRole, StorageAdapter, User } from "../storage/types"

export interface TestUserInput {
  /**
   * Only `github`, deliberately: an account with NO provider identity is a
   * distinct state with its own semantics (`createUser` + `linkProviderIdentity`),
   * and a fixture that blurred the two would make the identity tests below it
   * meaningless. Tests that want that state build it explicitly.
   */
  provider: "github"
  providerUserId: string
  email: string
  displayName: string
  avatarUrl: string
  /** Defaults to `editor` — the role an ordinary admitted reviewer gets. */
  role?: InstanceRole
}

/**
 * Seed (or refresh) a user, keyed on the provider identity.
 *
 * This is the TEST-ONLY successor to the deleted `StorageAdapter.upsertUser`.
 * Production code no longer has an upsert, and that removal is the point of
 * the change: creating an account as a side effect of looking one up is what
 * made every sign-in an admission decision, so the sign-in path now has to
 * say which of "find", "link" and "create" it means (see
 * `server/api/auth-routes.ts`).
 *
 * Test SETUP has no such question to answer — the ~100 call sites here all
 * mean "make sure this person exists so I can exercise something else" — so
 * the upsert shape survives, in one place, where it cannot be mistaken for a
 * product behaviour.
 *
 * NOT a substitute for the storage contract: `storage-adapter-contract.ts`
 * drives `createUser` / `updateUserProfile` / `linkProviderIdentity`
 * directly, and is the only place their semantics are pinned.
 */
export async function upsertTestUser(storage: StorageAdapter, input: TestUserInput): Promise<User> {
  const existing = await storage.getUserByProviderIdentity(input.provider, input.providerUserId)
  if (existing) {
    return storage.updateUserProfile(existing.id, {
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
    })
  }
  return storage.createUser({
    provider: input.provider,
    providerUserId: input.providerUserId,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    role: input.role ?? "editor",
  })
}

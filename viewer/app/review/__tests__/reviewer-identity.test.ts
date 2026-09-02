import { beforeEach, describe, expect, it } from "vitest"
import {
  getReviewerIdentity,
  saveReviewerIdentity,
  resolveAuthor,
  REVIEWER_IDENTITY_STORAGE_KEY,
} from "../reviewer-identity"
import type { ViewerUser } from "../../use-current-user"

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage
})

describe("reviewer identity", () => {
  it("returns null before any identity is saved", () => {
    expect(getReviewerIdentity()).toBeNull()
  })

  it("saves and round-trips a CommentAuthor with a stable uid", () => {
    const saved = saveReviewerIdentity({ displayName: "Mo", email: "mo@x.com" })
    expect(saved.displayName).toBe("Mo")
    expect(saved.email).toBe("mo@x.com")
    expect(saved.uid.startsWith("viewer:")).toBe(true)
    const read = getReviewerIdentity()
    expect(read).toEqual(saved)
    expect(store.has(REVIEWER_IDENTITY_STORAGE_KEY)).toBe(true)
  })

  it("returns null for corrupted stored JSON instead of throwing", () => {
    store.set(REVIEWER_IDENTITY_STORAGE_KEY, "{not json")
    expect(getReviewerIdentity()).toBeNull()
  })
})

describe("resolveAuthor", () => {
  const user: ViewerUser = {
    id: "u1",
    provider: "github",
    email: "mo@x.com",
    displayName: "Mo GitHub",
    avatarUrl: "https://example.com/avatar.png",
    role: "editor",
    createdAt: "2026-08-07T00:00:00.000Z",
  }

  it("prefers the signed-in user over a stored self-declared identity", () => {
    saveReviewerIdentity({ displayName: "Stored Mo", email: "stored@x.com" })
    expect(resolveAuthor(user)).toEqual({
      uid: "user:u1",
      displayName: "Mo GitHub",
      email: "mo@x.com",
      photoURL: "https://example.com/avatar.png",
    })
  })

  it("falls back to the stored identity when there is no signed-in user", () => {
    const saved = saveReviewerIdentity({ displayName: "Stored Mo", email: "stored@x.com" })
    expect(resolveAuthor(null)).toEqual(saved)
  })

  it("returns null when neither a signed-in user nor a stored identity exists", () => {
    expect(resolveAuthor(null)).toBeNull()
  })
})

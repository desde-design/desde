import { afterEach, describe, expect, it } from "vitest"
import {
  cliBootstrapUserToAuthor,
  getActiveCliUser,
  setActiveCliUser,
} from "./cli-user-identity"

afterEach(() => {
  setActiveCliUser(null)
})

describe("cli-user-identity", () => {
  it("getActiveCliUser returns null before any setter call", () => {
    expect(getActiveCliUser()).toBeNull()
  })

  it("setActiveCliUser stores the provided user", () => {
    setActiveCliUser({
      uid: "cli:mo@mac",
      displayName: "mo",
      email: "",
      photoURL: "",
    })
    expect(getActiveCliUser()?.uid).toBe("cli:mo@mac")
  })

  it("cliBootstrapUserToAuthor formats username + host into uid", () => {
    const author = cliBootstrapUserToAuthor({
      username: "mo",
      hostname: "MacBook-Pro.local",
    })
    expect(author).toEqual({
      uid: "cli:mo@MacBook-Pro.local",
      displayName: "mo",
      email: "",
      photoURL: "",
    })
  })

  it("falls back when fields are missing or empty", () => {
    expect(cliBootstrapUserToAuthor({})).toEqual({
      uid: "cli:local@unknown-host",
      displayName: "local",
      email: "",
      photoURL: "",
    })
    expect(cliBootstrapUserToAuthor({ username: "  ", hostname: "" })).toEqual({
      uid: "cli:local@unknown-host",
      displayName: "local",
      email: "",
      photoURL: "",
    })
  })
})

import { describe, expect, it } from "vitest"
import { encodeMention, extractMentionIds, findActiveMentionToken } from "./mention-encoding"

describe("encodeMention / extractMentionIds", () => {
  it("round-trips a mention through the wire format", () => {
    const body = `hi ${encodeMention("Rin Adeyemi", "p_rin")}`
    expect(body).toBe("hi @[Rin Adeyemi](p_rin)")
    expect(extractMentionIds(body)).toEqual(["p_rin"])
  })

  it("never treats a bare email as a mention", () => {
    expect(extractMentionIds("write to rin@example.com")).toEqual([])
  })

  it("returns each id once, in the order it first appears", () => {
    const body = "hey @[Mo](p_1) and @[Sam](p_2), also @[Mo again](p_1). thoughts?"
    expect(extractMentionIds(body)).toEqual(["p_1", "p_2"])
  })

  it("returns [] for a body with no mentions", () => {
    expect(extractMentionIds("just a plain comment")).toEqual([])
  })
})

describe("findActiveMentionToken", () => {
  it("finds the token the cursor sits in", () => {
    expect(findActiveMentionToken("hey @ri", 7)).toEqual({ start: 4, query: "ri" })
  })

  it("opens on a bare @ so the full directory can be browsed", () => {
    expect(findActiveMentionToken("hey @", 5)).toEqual({ start: 4, query: "" })
  })

  it("is closed by whitespace", () => {
    expect(findActiveMentionToken("hey @rin thanks", 15)).toBeNull()
  })

  it("returns null when there is no @ before the cursor", () => {
    expect(findActiveMentionToken("plain text", 10)).toBeNull()
    // The `@` is AFTER the caret, so it is not the token being typed.
    expect(findActiveMentionToken("plain @rin", 5)).toBeNull()
  })

  // The guard that the Viewer's original scanner lacked. A display name with
  // a space happened to be saved by the whitespace check; a single-word one
  // was not, so clicking to the right of `@[Mo](p_1)` reopened the picker on
  // the already-encoded token and choosing a name spliced a second mention
  // into the middle of the first.
  it("does not reopen inside an already-encoded mention", () => {
    const body = "@[Mo](p_1)"
    expect(findActiveMentionToken(body, body.length)).toBeNull()
  })

  // The caret can sit directly after the `@` of an encoded mention, where the
  // query is empty. Reading the bracket only from the text BEFORE the caret
  // missed that, so the picker opened on a finished mention and choosing a
  // name spliced a second one into the middle of it.
  it("does not reopen with the caret right after an encoded mention's @", () => {
    expect(findActiveMentionToken("@[Mo](p_1)", 1)).toBeNull()
    expect(findActiveMentionToken("hey @[Mo](p_1) there", 5)).toBeNull()
  })

  it("still opens for a NEW token typed after an encoded mention", () => {
    const body = "@[Mo](p_1) and @ri"
    expect(findActiveMentionToken(body, body.length)).toEqual({ start: 15, query: "ri" })
  })
})

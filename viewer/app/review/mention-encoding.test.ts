import { expect, it } from "vitest"
import { encodeMention, extractMentionIds } from "./mention-encoding"

it("encodes a mention as @[name](participantId)", () => {
  expect(encodeMention("Mo Chang", "p_123")).toBe("@[Mo Chang](p_123)")
})

it("extracts unique participant ids in order, ignoring plain text", () => {
  const body = "hey @[Mo](p_1) and @[Sam](p_2), also @[Mo again](p_1) — thoughts?"
  expect(extractMentionIds(body)).toEqual(["p_1", "p_2"])
})

it("returns [] when there are no mentions", () => {
  expect(extractMentionIds("just a plain comment")).toEqual([])
})

it("does not treat a raw email in text as a mention", () => {
  expect(extractMentionIds("email me at a@b.com")).toEqual([])
})

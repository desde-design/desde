import { describe, expect, it } from "vitest"
import {
  CAPABILITY_COOKIE_NAME,
  capabilityCookieName,
} from "../prototype-capability-path"

describe("capabilityCookieName", () => {
  it("prefixes __Host- on https (secure), plain name on http (insecure)", () => {
    expect(capabilityCookieName(true)).toBe(`__Host-${CAPABILITY_COOKIE_NAME}`)
    expect(capabilityCookieName(false)).toBe(CAPABILITY_COOKIE_NAME)
  })
})

import { describe, expect, it } from "vitest"
import { HOME_URL_ENV, homeUrlEnv, readHomeUrl } from "../home-url.js"

describe("home-url: the launcher an editor calls home", () => {
  it("round-trips a launcher origin through the env var", () => {
    const env = homeUrlEnv("http://127.0.0.1:4321")
    expect(env).toEqual({ [HOME_URL_ENV]: "http://127.0.0.1:4321" })
    expect(readHomeUrl(env)).toBe("http://127.0.0.1:4321")
  })

  it("spreads to nothing when the launcher has no origin yet", () => {
    expect(homeUrlEnv(undefined)).toEqual({})
    expect(homeUrlEnv("")).toEqual({})
  })

  it("reads nothing from an unset, blank, or malformed value", () => {
    expect(readHomeUrl({})).toBeUndefined()
    expect(readHomeUrl({ [HOME_URL_ENV]: "   " })).toBeUndefined()
    expect(readHomeUrl({ [HOME_URL_ENV]: "not a url" })).toBeUndefined()
    expect(readHomeUrl({ [HOME_URL_ENV]: "127.0.0.1:4321" })).toBeUndefined()
  })

  it("refuses a non-web scheme: the value is navigated to and trusted downstream", () => {
    expect(readHomeUrl({ [HOME_URL_ENV]: "file:///etc/passwd" })).toBeUndefined()
    expect(readHomeUrl({ [HOME_URL_ENV]: "javascript:alert(1)" })).toBeUndefined()
  })

  it("normalises to a bare origin, dropping any path or hash", () => {
    expect(readHomeUrl({ [HOME_URL_ENV]: "http://127.0.0.1:4321/#/settings?path=x" })).toBe(
      "http://127.0.0.1:4321",
    )
  })
})

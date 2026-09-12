import { describe, expect, it } from "vitest"
import { ChildCookieJar } from "../child-cookie-jar"

/**
 * Codex round 60. A loopback prototype is a cross-site frame, so the browser
 * will not keep the cookies its child sets; the jar keeps them here and
 * replays them. Round 61: keyed by name and path like a browser's jar, with
 * RFC 6265's default path.
 */
describe("ChildCookieJar", () => {
  it("replays what the child set, with the newest value per name and path", () => {
    const jar = new ChildCookieJar()
    jar.absorb(["session=abc; Path=/; HttpOnly", "theme=dark; Path=/"], "/")
    expect(jar.cookieHeaderFor("/")).toBe("session=abc; theme=dark")
    jar.absorb("session=def; Path=/", "/")
    expect(jar.cookieHeaderFor("/account")).toBe("session=def; theme=dark")
  })

  it("keeps the same name on two paths apart, sends the longer path first, and deletes one without the other", () => {
    const jar = new ChildCookieJar()
    jar.absorb("session=root; Path=/", "/")
    jar.absorb("session=admin; Path=/admin", "/admin/login")
    expect(jar.cookieHeaderFor("/")).toBe("session=root")
    expect(jar.cookieHeaderFor("/admin/users")).toBe("session=admin; session=root")
    jar.absorb("session=; Path=/admin; Max-Age=0", "/admin/logout")
    expect(jar.cookieHeaderFor("/admin/users")).toBe("session=root")
  })

  it("defaults a cookie's path to the directory of the request that set it", () => {
    const jar = new ChildCookieJar()
    jar.absorb("admin=1", "/admin/login")
    expect(jar.cookieHeaderFor("/admin/login")).toBe("admin=1")
    expect(jar.cookieHeaderFor("/admin/users")).toBe("admin=1")
    expect(jar.cookieHeaderFor("/")).toBeUndefined()
    expect(jar.cookieHeaderFor("/profile")).toBeUndefined()
    jar.absorb("top=1", "/index")
    expect(jar.cookieHeaderFor("/anything")).toBe("top=1")
  })

  it("scopes a cookie to its Path", () => {
    const jar = new ChildCookieJar()
    jar.absorb("admin=1; Path=/admin", "/")
    expect(jar.cookieHeaderFor("/admin")).toBe("admin=1")
    expect(jar.cookieHeaderFor("/admin/users?x=1")).toBe("admin=1")
    expect(jar.cookieHeaderFor("/administrator")).toBeUndefined()
    expect(jar.cookieHeaderFor("/")).toBeUndefined()
  })

  it("forgets a cookie the child deleted or let expire", () => {
    const jar = new ChildCookieJar()
    const now = Date.parse("2026-09-12T12:00:00.000Z")
    jar.absorb("session=abc; Max-Age=60", "/", now)
    jar.absorb("old=1; Expires=Wed, 01 Jan 2020 00:00:00 GMT", "/", now)
    expect(jar.cookieHeaderFor("/", now)).toBe("session=abc")
    expect(jar.cookieHeaderFor("/", now + 61_000)).toBeUndefined()
    jar.absorb("theme=dark", "/", now)
    jar.absorb("theme=; Max-Age=0", "/", now)
    expect(jar.cookieHeaderFor("/", now)).toBeUndefined()
    expect(jar.size).toBe(0)
  })

  it("ignores a malformed Set-Cookie", () => {
    const jar = new ChildCookieJar()
    jar.absorb(["=novalue", "nameless", ""], "/")
    expect(jar.size).toBe(0)
  })
})

import { describe, expect, it } from "vitest"
import { contentTypeFor, isCss } from "../mime"

describe("contentTypeFor", () => {
  it("maps common prototype asset extensions", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8")
    expect(contentTypeFor("assets/app.js")).toBe("text/javascript; charset=utf-8")
    expect(contentTypeFor("assets/app.css")).toBe("text/css; charset=utf-8")
    expect(contentTypeFor("data.json")).toBe("application/json; charset=utf-8")
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml")
    expect(contentTypeFor("photo.png")).toBe("image/png")
    expect(contentTypeFor("font.woff2")).toBe("font/woff2")
  })

  it("is case-insensitive", () => {
    expect(contentTypeFor("IMAGE.PNG")).toBe("image/png")
  })

  it("falls back to a byte stream for unknown extensions", () => {
    expect(contentTypeFor("weird.xyz")).toBe("application/octet-stream")
    expect(contentTypeFor("noextension")).toBe("application/octet-stream")
  })
})

describe("isCss", () => {
  it("recognizes a CSS content type", () => {
    expect(isCss(contentTypeFor("assets/app.css"))).toBe(true)
  })

  it("rejects everything else", () => {
    expect(isCss(contentTypeFor("index.html"))).toBe(false)
    expect(isCss(contentTypeFor("assets/app.js"))).toBe(false)
    expect(isCss("application/octet-stream")).toBe(false)
  })
})

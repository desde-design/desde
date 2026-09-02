import { describe, it, expect } from "vitest"
import { resolveHtml2canvasGlobal } from "./html2canvas-loader"

describe("resolveHtml2canvasGlobal", () => {
  it("returns the function directly (stock html2canvas UMD shape)", () => {
    const fn = () => Promise.resolve(document.createElement("canvas"))
    expect(resolveHtml2canvasGlobal(fn)).toBe(fn)
  })

  it("unwraps `.default` (html2canvas-pro namespace UMD shape)", () => {
    const fn = () => Promise.resolve(document.createElement("canvas"))
    const namespace = { __esModule: true, default: fn, html2canvas: fn }
    expect(resolveHtml2canvasGlobal(namespace)).toBe(fn)
  })

  it("returns null when the global is missing or malformed", () => {
    expect(resolveHtml2canvasGlobal(undefined)).toBeNull()
    expect(resolveHtml2canvasGlobal(null)).toBeNull()
    expect(resolveHtml2canvasGlobal({})).toBeNull()
    expect(resolveHtml2canvasGlobal({ default: 42 })).toBeNull()
    expect(resolveHtml2canvasGlobal("nope")).toBeNull()
  })
})

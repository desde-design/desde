import { describe, expect, it } from "vitest"
import { assertOutsidePackagedAsar, parseFlag, resolvePayloadRoot } from "../payload-resolve.js"

describe("parseFlag", () => {
  it("reads --name value form", () => {
    expect(parseFlag(["node", "main.js", "--payload", "/tmp/x"], "--payload")).toBe("/tmp/x")
  })

  it("reads --name=value form", () => {
    expect(parseFlag(["node", "main.js", "--payload=/tmp/x"], "--payload")).toBe("/tmp/x")
  })

  it("returns undefined when the flag is absent", () => {
    expect(parseFlag(["node", "main.js"], "--payload")).toBeUndefined()
  })

  it("returns undefined when the flag is the last argv element with no value", () => {
    expect(parseFlag(["node", "main.js", "--payload"], "--payload")).toBeUndefined()
  })

  it("does not treat the NEXT flag as this flag's value", () => {
    expect(parseFlag(["node", "main.js", "--payload", "--no-open"], "--payload")).toBeUndefined()
  })
})

describe("resolvePayloadRoot", () => {
  const DEFAULT_CACHE = "/repo/desktop/.payload-cache"

  it("falls back to the default cache dir when nothing is set", () => {
    expect(resolvePayloadRoot([], {}, DEFAULT_CACHE)).toEqual({
      path: DEFAULT_CACHE,
      explicit: false,
    })
  })

  it("prefers the --payload flag, marked explicit", () => {
    expect(resolvePayloadRoot(["--payload", "/tmp/pt-payload"], {}, DEFAULT_CACHE)).toEqual({
      path: "/tmp/pt-payload",
      explicit: true,
    })
  })

  it("falls back to the env var when no flag is given, marked explicit", () => {
    expect(
      resolvePayloadRoot([], { DESDE_DESKTOP_PAYLOAD: "/tmp/pt-payload" }, DEFAULT_CACHE),
    ).toEqual({ path: "/tmp/pt-payload", explicit: true })
  })

  it("the flag wins over the env var when both are set", () => {
    expect(
      resolvePayloadRoot(
        ["--payload", "/tmp/from-flag"],
        { DESDE_DESKTOP_PAYLOAD: "/tmp/from-env" },
        DEFAULT_CACHE,
      ),
    ).toEqual({ path: "/tmp/from-flag", explicit: true })
  })

  it("treats a blank env var as unset", () => {
    expect(resolvePayloadRoot([], { DESDE_DESKTOP_PAYLOAD: "   " }, DEFAULT_CACHE)).toEqual({
      path: DEFAULT_CACHE,
      explicit: false,
    })
  })

  it("resolves a relative --payload value against the given cwd", () => {
    expect(resolvePayloadRoot(["--payload", "my-payload"], {}, DEFAULT_CACHE, "/home/mo")).toEqual({
      path: "/home/mo/my-payload",
      explicit: true,
    })
  })

  it("leaves an absolute --payload value untouched", () => {
    expect(resolvePayloadRoot(["--payload", "/abs/path"], {}, DEFAULT_CACHE, "/home/mo")).toEqual({
      path: "/abs/path",
      explicit: true,
    })
  })

  it("resolves under <resourcesPath>/server when packaged and nothing explicit is given", () => {
    expect(
      resolvePayloadRoot([], {}, DEFAULT_CACHE, "/home/mo", "/Applications/Desde Editor.app/Contents/Resources"),
    ).toEqual({
      path: "/Applications/Desde Editor.app/Contents/Resources/server",
      // A missing payload in a packaged app is a hard error — there is no
      // toolchain on the user's machine to auto-build one with.
      explicit: true,
    })
  })

  it("an explicit --payload flag still wins over the packaged resources path", () => {
    expect(
      resolvePayloadRoot(
        ["--payload", "/tmp/debug-payload"],
        {},
        DEFAULT_CACHE,
        "/home/mo",
        "/Applications/Desde Editor.app/Contents/Resources",
      ),
    ).toEqual({ path: "/tmp/debug-payload", explicit: true })
  })

  it("an explicit env var still wins over the packaged resources path", () => {
    expect(
      resolvePayloadRoot(
        [],
        { DESDE_DESKTOP_PAYLOAD: "/tmp/debug-payload" },
        DEFAULT_CACHE,
        "/home/mo",
        "/Applications/Desde Editor.app/Contents/Resources",
      ),
    ).toEqual({ path: "/tmp/debug-payload", explicit: true })
  })

  it("falls back to the dev default cache dir when not packaged and nothing explicit is given", () => {
    expect(resolvePayloadRoot([], {}, DEFAULT_CACHE, "/home/mo", null)).toEqual({
      path: DEFAULT_CACHE,
      explicit: false,
    })
  })
})

describe("assertOutsidePackagedAsar", () => {
  it("does not throw for a normal Resources/server path", () => {
    expect(() =>
      assertOutsidePackagedAsar("/Applications/Desde Editor.app/Contents/Resources/server"),
    ).not.toThrow()
  })

  it("does not throw for a dev cache path", () => {
    expect(() => assertOutsidePackagedAsar("/repo/desktop/.payload-cache")).not.toThrow()
  })

  it("throws when the path resolves inside app.asar", () => {
    expect(() =>
      assertOutsidePackagedAsar(
        "/Applications/Desde Editor.app/Contents/Resources/app.asar/server",
      ),
    ).toThrow(/app\.asar/)
  })
})

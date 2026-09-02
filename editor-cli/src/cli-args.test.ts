import { describe, expect, it } from "vitest"
import { normalizeEqualsFlags } from "./cli-args.js"

describe("normalizeEqualsFlags", () => {
  it("splits a long flag's `=` form into two tokens", () => {
    expect(normalizeEqualsFlags(["--host-mode=in-process"])).toEqual(["--host-mode", "in-process"])
  })

  it("is the exact case Editor's own guidance tells users to type", () => {
    // hosts/ladder.ts prints: "To keep the in-process path and fail loudly
    // instead, pass --host-mode=in-process." Before this normalizer that
    // produced `Unknown option: --host-mode=in-process` from the packaged
    // app — the screen and the parser disagreed. Pinning the exact string so
    // they cannot drift apart again.
    const argv = ["/repo", "--host-mode=in-process"]
    expect(normalizeEqualsFlags(argv)).toEqual(["/repo", "--host-mode", "in-process"])
  })

  it("leaves the space form untouched", () => {
    expect(normalizeEqualsFlags(["--host-mode", "in-process"])).toEqual(["--host-mode", "in-process"])
  })

  it("splits on the FIRST `=` so query strings survive", () => {
    expect(normalizeEqualsFlags(["--attach=http://localhost:3000/?a=b&c=d"])).toEqual([
      "--attach",
      "http://localhost:3000/?a=b&c=d",
    ])
  })

  it("passes positionals through even when they contain `=`", () => {
    // A repo path is not a flag. Splitting it would silently retarget the boot.
    expect(normalizeEqualsFlags(["/tmp/weird=dir"])).toEqual(["/tmp/weird=dir"])
  })

  it("leaves short flags alone", () => {
    expect(normalizeEqualsFlags(["-h"])).toEqual(["-h"])
  })

  it("passes a bare `--` through unchanged", () => {
    expect(normalizeEqualsFlags(["--"])).toEqual(["--"])
  })

  it("yields an empty value for a trailing `=`, rather than dropping the flag", () => {
    // `--attach=` must reach parseArgs as an EMPTY attach url, which it
    // treats as "explicitly passed, no value" — dropping the token would make
    // it indistinguishable from "never passed" and silently boot a server.
    expect(normalizeEqualsFlags(["--attach="])).toEqual(["--attach", ""])
  })

  it("handles several flags in one argv", () => {
    expect(normalizeEqualsFlags(["/repo", "--shell-port=4399", "--no-open", "--vite-port", "5399"])).toEqual([
      "/repo",
      "--shell-port",
      "4399",
      "--no-open",
      "--vite-port",
      "5399",
    ])
  })
})

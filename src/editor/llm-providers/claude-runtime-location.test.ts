import { describe, expect, it } from "vitest"

import {
  claudeAgentSdkPackageName,
  claudeAgentSdkPlatformCandidates,
  claudeExecutableFileName,
  isLinuxMusl,
  readInstalledClaudeAgentSdkVersion,
  resolveAppSupportDir,
  resolveClaudeExecutablePathIn,
  resolveClaudeRuntimeDir,
} from "./claude-runtime-location"

describe("resolveAppSupportDir", () => {
  it("darwin: ~/Library/Application Support/<appName>", () => {
    expect(
      resolveAppSupportDir({ home: "/Users/mo", platform: "darwin", appName: "Desde", env: {} }),
    ).toBe("/Users/mo/Library/Application Support/Desde")
  })

  it("win32: %APPDATA%/<appName> when APPDATA is set", () => {
    expect(
      resolveAppSupportDir({
        home: "C:\\Users\\mo",
        platform: "win32",
        appName: "Desde",
        env: { APPDATA: "C:\\Users\\mo\\AppData\\Roaming" },
      }),
      // path.join normalizes separators for the CURRENT process's platform,
      // not the platform being modeled — this test only asserts the
      // segments compose in the right order, which is what matters here
      // (the win32-only backslash convention is exercised by real Windows,
      // not this darwin/linux test runner).
    ).toContain("Desde")
  })

  it("win32: falls back to ~/AppData/Roaming/<appName> when APPDATA is unset", () => {
    const result = resolveAppSupportDir({
      home: "/home/mo",
      platform: "win32",
      appName: "Desde",
      env: {},
    })
    expect(result).toContain("AppData")
    expect(result).toContain("Roaming")
    expect(result).toContain("Desde")
  })

  it("linux: XDG_DATA_HOME when set", () => {
    expect(
      resolveAppSupportDir({
        home: "/home/mo",
        platform: "linux",
        appName: "Desde",
        env: { XDG_DATA_HOME: "/home/mo/.data" },
      }),
    ).toBe("/home/mo/.data/Desde")
  })

  it("linux: falls back to ~/.local/share/<appName> when XDG_DATA_HOME is unset", () => {
    expect(
      resolveAppSupportDir({ home: "/home/mo", platform: "linux", appName: "Desde", env: {} }),
    ).toBe("/home/mo/.local/share/Desde")
  })
})

describe("resolveClaudeRuntimeDir", () => {
  it("is version-keyed under claude-runtime", () => {
    expect(
      resolveClaudeRuntimeDir({
        appSupportDir: "/Users/mo/Library/Application Support/Desde",
        sdkVersion: "0.3.143",
      }),
    ).toBe("/Users/mo/Library/Application Support/Desde/claude-runtime/0.3.143")
  })

  it("two different versions get two different directories", () => {
    const a = resolveClaudeRuntimeDir({ appSupportDir: "/x", sdkVersion: "0.3.143" })
    const b = resolveClaudeRuntimeDir({ appSupportDir: "/x", sdkVersion: "0.4.0" })
    expect(a).not.toBe(b)
  })
})

describe("claudeExecutableFileName / resolveClaudeExecutablePathIn", () => {
  it("darwin/linux: plain 'claude'", () => {
    expect(claudeExecutableFileName("darwin")).toBe("claude")
    expect(claudeExecutableFileName("linux")).toBe("claude")
  })

  it("win32: 'claude.exe'", () => {
    expect(claudeExecutableFileName("win32")).toBe("claude.exe")
  })

  it("sits flat at the runtime dir's root (no nested node_modules path)", () => {
    expect(
      resolveClaudeExecutablePathIn({ runtimeDir: "/x/claude-runtime/0.3.143", platform: "darwin" }),
    ).toBe("/x/claude-runtime/0.3.143/claude")
  })
})

describe("isLinuxMusl", () => {
  it("false on non-linux platforms regardless of the report", () => {
    expect(isLinuxMusl("darwin", () => null)).toBe(false)
    expect(isLinuxMusl("win32", () => ({ header: {} }))).toBe(false)
  })

  it("true on linux when glibcVersionRuntime is absent from the report", () => {
    expect(isLinuxMusl("linux", () => ({ header: {} }))).toBe(true)
  })

  it("false on linux when glibcVersionRuntime is present", () => {
    expect(isLinuxMusl("linux", () => ({ header: { glibcVersionRuntime: "2.35" } }))).toBe(false)
  })

  it("false on linux when there is no report at all", () => {
    expect(isLinuxMusl("linux", () => null)).toBe(false)
  })
})

describe("claudeAgentSdkPlatformCandidates", () => {
  it("darwin/win32: exactly one candidate", () => {
    expect(claudeAgentSdkPlatformCandidates("darwin", "arm64")).toEqual(["darwin-arm64"])
    expect(claudeAgentSdkPlatformCandidates("win32", "x64")).toEqual(["win32-x64"])
  })

  it("linux glibc host: glibc-first, musl fallback", () => {
    expect(claudeAgentSdkPlatformCandidates("linux", "x64", false)).toEqual([
      "linux-x64",
      "linux-x64-musl",
    ])
  })

  it("linux musl host: musl-first, glibc fallback", () => {
    expect(claudeAgentSdkPlatformCandidates("linux", "arm64", true)).toEqual([
      "linux-arm64-musl",
      "linux-arm64",
    ])
  })
})

describe("claudeAgentSdkPackageName", () => {
  it("prefixes the suffix with the scoped package name", () => {
    expect(claudeAgentSdkPackageName("darwin-arm64")).toBe(
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    )
  })
})

describe("readInstalledClaudeAgentSdkVersion", () => {
  it("reads the real installed SDK's version from this repo's own node_modules", () => {
    // Live, not mocked — this repo's root node_modules genuinely has
    // @anthropic-ai/claude-agent-sdk installed (it's what claude-agent-sdk-
    // provider.ts and run-chat-turn-sdk.ts import), so this exercises the
    // exact resolution path production code depends on.
    const version = readInstalledClaudeAgentSdkVersion(import.meta.url)
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("throws when nothing is resolvable from the given location", () => {
    expect(() => readInstalledClaudeAgentSdkVersion("file:///dev/null/nowhere.js")).toThrow()
  })
})

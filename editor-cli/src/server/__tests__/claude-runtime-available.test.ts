import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isClaudeRuntimeResolvable } from "../claude-runtime-available.js"
import { readInstalledClaudeAgentSdkVersion } from "../../../../src/editor/llm-providers/claude-runtime-location.js"

let appSupportDir: string

beforeEach(async () => {
  appSupportDir = await mkdtemp(join(tmpdir(), "claude-rt-"))
})

afterEach(async () => {
  await rm(appSupportDir, { recursive: true, force: true })
})

describe("isClaudeRuntimeResolvable", () => {
  it("is true in a terminal install, where the SDK ships its platform binary", () => {
    // No EDITOR_CLAUDE_RUNTIME_DIR: the terminal branch resolves the platform
    // package out of this repo's own node_modules.
    expect(isClaudeRuntimeResolvable({})).toBe(true)
  })

  it("is false under the desktop app before the runtime is fetched", () => {
    expect(
      isClaudeRuntimeResolvable({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }),
    ).toBe(false)
  })

  it("is true under the desktop app once the binary exists at the version-keyed path", async () => {
    const sdkVersion = readInstalledClaudeAgentSdkVersion(import.meta.url)
    const runtimeDir = join(appSupportDir, "claude-runtime", sdkVersion)
    await mkdir(runtimeDir, { recursive: true })
    const name = process.platform === "win32" ? "claude.exe" : "claude"
    await writeFile(join(runtimeDir, name), "#!/bin/sh\n")
    expect(
      isClaudeRuntimeResolvable({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }),
    ).toBe(true)
  })

  it("is false under the desktop app when a DIFFERENT version is installed", async () => {
    const runtimeDir = join(appSupportDir, "claude-runtime", "0.0.0-not-ours")
    await mkdir(runtimeDir, { recursive: true })
    const name = process.platform === "win32" ? "claude.exe" : "claude"
    await writeFile(join(runtimeDir, name), "#!/bin/sh\n")
    // Version-keyed: a stale install must not read as the current runtime.
    expect(
      isClaudeRuntimeResolvable({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }),
    ).toBe(false)
  })
})

/**
 * Codex review round five: the probe scanned SDK packages only, so a terminal
 * user on the documented `EDITOR_CLAUDE_EXECUTABLE_PATH` escape hatch was
 * reported uncredentialed and got the first-run prompt despite having a
 * working runtime. It now mirrors `resolveClaudeExecutablePath`.
 */
describe("EDITOR_CLAUDE_EXECUTABLE_PATH override", () => {
  it("is honoured in a terminal install", async () => {
    const bin = join(appSupportDir, "my-claude")
    await writeFile(bin, "#!/bin/sh\n")
    await chmod(bin, 0o755)
    expect(isClaudeRuntimeResolvable({ EDITOR_CLAUDE_EXECUTABLE_PATH: bin })).toBe(true)
  })

  it("is ignored when the path is not executable", async () => {
    const bin = join(appSupportDir, "not-executable")
    await writeFile(bin, "text")
    await chmod(bin, 0o644)
    // Falls through to the package scan, which succeeds in this repo, so
    // assert the override itself was rejected rather than the final answer.
    expect(isClaudeRuntimeResolvable({ EDITOR_CLAUDE_EXECUTABLE_PATH: bin })).toBe(
      isClaudeRuntimeResolvable({}),
    )
  })

  it("is ignored under the desktop app, where the verified path is the only route", async () => {
    const bin = join(appSupportDir, "my-claude")
    await writeFile(bin, "#!/bin/sh\n")
    await chmod(bin, 0o755)
    // `EDITOR_CLAUDE_RUNTIME_DIR` set means Desde: an inherited override must
    // not be able to route around content verification.
    expect(
      isClaudeRuntimeResolvable({
        EDITOR_CLAUDE_EXECUTABLE_PATH: bin,
        EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir,
      }),
    ).toBe(false)
  })
})

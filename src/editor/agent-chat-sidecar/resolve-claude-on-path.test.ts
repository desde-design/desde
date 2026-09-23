import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter as pathDelimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { isClaudeOnPath, resolveClaudeOnPath } from "./resolve-claude-on-path"

const FIXTURE_SCRIPT = "#!/bin/sh\necho ok\n"

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-on-path-test-"))
  tempDirs.push(dir)
  return dir
}

function writeExecutable(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, FIXTURE_SCRIPT, { mode: 0o755 })
  return path
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("resolveClaudeOnPath", () => {
  it("finds an executable claude shim on a synthetic PATH", () => {
    const dir = makeTempDir()
    const bin = writeExecutable(dir, "claude")

    expect(resolveClaudeOnPath({ PATH: dir })).toBe(bin)
  })

  it("walks multiple PATH entries, in order", () => {
    const empty = makeTempDir()
    const withBin = makeTempDir()
    const bin = writeExecutable(withBin, "claude")

    expect(
      resolveClaudeOnPath({ PATH: [empty, withBin].join(pathDelimiter) }),
    ).toBe(bin)
  })

  it("returns undefined on an empty PATH", () => {
    expect(resolveClaudeOnPath({ PATH: "" })).toBeUndefined()
  })

  it("returns undefined when PATH is unset", () => {
    expect(resolveClaudeOnPath({})).toBeUndefined()
  })

  it("returns undefined when PATH names only directories with no claude binary", () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "not-claude"), FIXTURE_SCRIPT, { mode: 0o755 })

    expect(resolveClaudeOnPath({ PATH: dir })).toBeUndefined()
  })

  it("skips a same-named file on PATH that is not executable", () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "claude"), FIXTURE_SCRIPT, { mode: 0o644 })

    expect(resolveClaudeOnPath({ PATH: dir })).toBeUndefined()
  })

  it("skips a directory named claude and keeps walking later PATH entries", () => {
    const withDir = makeTempDir()
    mkdirSync(join(withDir, "claude"))

    const withShim = makeTempDir()
    const shim = writeExecutable(withShim, "claude")

    expect(
      resolveClaudeOnPath({ PATH: [withDir, withShim].join(pathDelimiter) }),
    ).toBe(shim)
  })

  it("returns undefined when PATH names only a directory called claude", () => {
    const withDir = makeTempDir()
    mkdirSync(join(withDir, "claude"))

    expect(resolveClaudeOnPath({ PATH: withDir })).toBeUndefined()
  })

  describe("EDITOR_CLAUDE_EXECUTABLE_PATH override", () => {
    it("wins over a PATH lookup", () => {
      const pathDir = makeTempDir()
      writeExecutable(pathDir, "claude")

      const overrideDir = makeTempDir()
      const override = writeExecutable(overrideDir, "my-claude")

      expect(
        resolveClaudeOnPath({
          PATH: pathDir,
          EDITOR_CLAUDE_EXECUTABLE_PATH: override,
        }),
      ).toBe(override)
    })

    it("wins even with no PATH at all", () => {
      const dir = makeTempDir()
      const override = writeExecutable(dir, "my-claude")

      expect(
        resolveClaudeOnPath({ EDITOR_CLAUDE_EXECUTABLE_PATH: override }),
      ).toBe(override)
    })

    it("falls through to PATH when the override is not an executable file", () => {
      const dir = makeTempDir()
      const notExecutable = join(dir, "not-a-binary.txt")
      writeFileSync(notExecutable, "nope", { mode: 0o644 })

      const pathDir = makeTempDir()
      const bin = writeExecutable(pathDir, "claude")

      expect(
        resolveClaudeOnPath({
          PATH: pathDir,
          EDITOR_CLAUDE_EXECUTABLE_PATH: notExecutable,
        }),
      ).toBe(bin)
    })

    it("falls through to PATH when the override path does not exist", () => {
      const pathDir = makeTempDir()
      const bin = writeExecutable(pathDir, "claude")

      expect(
        resolveClaudeOnPath({
          PATH: pathDir,
          EDITOR_CLAUDE_EXECUTABLE_PATH: "/definitely/not/here/claude",
        }),
      ).toBe(bin)
    })
  })
})

describe("isClaudeOnPath", () => {
  it("mirrors resolveClaudeOnPath's presence/absence", () => {
    const dir = makeTempDir()
    writeExecutable(dir, "claude")

    expect(isClaudeOnPath({ PATH: dir })).toBe(true)
    expect(isClaudeOnPath({ PATH: "" })).toBe(false)
  })
})

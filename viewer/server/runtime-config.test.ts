import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRuntimeConfig, updateRuntimeConfig } from "./runtime-config"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "viewer-rc-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("loadRuntimeConfig", () => {
  it("creates the file with a generated session secret on first read", () => {
    const config = loadRuntimeConfig(dir)
    expect(config.sessionSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain(config.sessionSecret)
  })

  it("creates the file with mode 0600", () => {
    loadRuntimeConfig(dir)
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600)
  })

  it("returns the same secret on a second read", () => {
    expect(loadRuntimeConfig(dir).sessionSecret).toBe(loadRuntimeConfig(dir).sessionSecret)
  })

  it("regenerates rather than throwing when the file is corrupt", () => {
    writeFileSync(join(dir, "config.json"), "{not json", { mode: 0o600 })
    expect(loadRuntimeConfig(dir).sessionSecret).toMatch(/^[0-9a-f]{64}$/)
  })

  it("regenerates when the stored secret is not a 64-char hex string", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ sessionSecret: "" }), { mode: 0o600 })
    expect(loadRuntimeConfig(dir).sessionSecret).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("updateRuntimeConfig", () => {
  it("merges a patch and preserves the existing secret", () => {
    const before = loadRuntimeConfig(dir)
    const after = updateRuntimeConfig(dir, { demoSeededAt: "2026-08-19T00:00:00.000Z" })
    expect(after.sessionSecret).toBe(before.sessionSecret)
    expect(after.demoSeededAt).toBe("2026-08-19T00:00:00.000Z")
    expect(loadRuntimeConfig(dir).demoSeededAt).toBe("2026-08-19T00:00:00.000Z")
  })

  it("keeps mode 0600 after an update", () => {
    updateRuntimeConfig(dir, { demoSeededAt: "2026-08-19T00:00:00.000Z" })
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600)
  })
})

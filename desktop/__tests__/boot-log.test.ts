import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createBootLog } from "../boot-log.js"

const dir = mkdtempSync(join(tmpdir(), "desde-boot-log-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("createBootLog", () => {
  it("starts the file over on every boot and appends one timestamped line per call", () => {
    const path = join(dir, "boot.log")
    let tick = 0
    const now = () => new Date(Date.UTC(2026, 8, 2, 12, 35, 37 + tick++))
    const first = createBootLog(path, now)
    first("shell answered")
    first("child spawned")
    expect(readFileSync(path, "utf8")).toBe(
      "2026-09-02T12:35:37.000Z shell answered\n2026-09-02T12:35:38.000Z child spawned\n",
    )

    const second = createBootLog(path, now)
    second("next boot")
    expect(readFileSync(path, "utf8")).toBe("2026-09-02T12:35:39.000Z next boot\n")
  })

  it("never throws when the location cannot be written", () => {
    const log = createBootLog(join(dir, "missing", "deeper", "boot.log"))
    expect(() => log("anything")).not.toThrow()
  })
})

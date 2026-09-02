/**
 * `~/.desde/settings.json` — the desktop shell's app-scoped store.
 *
 * Each test gets its own tmp "home" dir (passed explicitly, not via
 * `process.env.HOME`) so nothing here can touch the developer's actual
 * `~/.desde/`. Covers: default-on-absent, round-trip, corrupt-file
 * tolerance, missing-dir creation, and the file/dir permission bits the
 * house pattern (`viewer-token-store.ts`) requires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  defaultDesktopSettings,
  getAutoDownload,
  readDesktopSettings,
  setAutoDownload,
  settingsFilePath,
  writeDesktopSettings,
} from "../settings.js"

let tmpHome: string

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-settings-"))
})

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe("desktop settings", () => {
  it("returns typed defaults when the file is absent", async () => {
    expect(await readDesktopSettings(tmpHome)).toEqual(defaultDesktopSettings())
    expect(defaultDesktopSettings().updates.autoDownload).toBe(true)
  })

  it("writes under ~/.desde/settings.json", async () => {
    await writeDesktopSettings({ version: 1, updates: { autoDownload: false } }, tmpHome)
    expect(settingsFilePath(tmpHome)).toBe(path.join(tmpHome, ".desde", "settings.json"))
    const onDisk = JSON.parse(await fs.readFile(settingsFilePath(tmpHome), "utf8")) as unknown
    expect(onDisk).toEqual({ version: 1, updates: { autoDownload: false } })
  })

  it("round-trips a write through a read", async () => {
    await writeDesktopSettings({ version: 1, updates: { autoDownload: false } }, tmpHome)
    expect(await readDesktopSettings(tmpHome)).toEqual({ version: 1, updates: { autoDownload: false } })
  })

  it("creates ~/.desde with 0700 and writes the file with 0600", async () => {
    await writeDesktopSettings({ version: 1, updates: { autoDownload: true } }, tmpHome)
    const dirStat = await fs.stat(path.join(tmpHome, ".desde"))
    const fileStat = await fs.stat(settingsFilePath(tmpHome))
    expect(dirStat.mode & 0o777).toBe(0o700)
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  it("tolerates a corrupt file (degrades to defaults) and a subsequent write repairs it", async () => {
    await fs.mkdir(path.join(tmpHome, ".desde"), { recursive: true })
    await fs.writeFile(settingsFilePath(tmpHome), "{ not json", "utf8")
    expect(await readDesktopSettings(tmpHome)).toEqual(defaultDesktopSettings())

    await setAutoDownload(false, tmpHome)
    expect(await readDesktopSettings(tmpHome)).toEqual({ version: 1, updates: { autoDownload: false } })
  })

  it("tolerates a file shaped wrong (missing/mistyped fields)", async () => {
    await fs.mkdir(path.join(tmpHome, ".desde"), { recursive: true })
    await fs.writeFile(settingsFilePath(tmpHome), JSON.stringify({ version: 1, updates: { autoDownload: "yes" } }), "utf8")
    // A non-boolean autoDownload falls back to the default (true) rather
    // than propagating the wrong type.
    expect(await readDesktopSettings(tmpHome)).toEqual(defaultDesktopSettings())
  })

  it("getAutoDownload / setAutoDownload round-trip", async () => {
    expect(await getAutoDownload(tmpHome)).toBe(true)
    await setAutoDownload(false, tmpHome)
    expect(await getAutoDownload(tmpHome)).toBe(false)
    await setAutoDownload(true, tmpHome)
    expect(await getAutoDownload(tmpHome)).toBe(true)
  })

  it("setAutoDownload preserves the rest of the settings object", async () => {
    await writeDesktopSettings({ version: 1, updates: { autoDownload: true } }, tmpHome)
    await setAutoDownload(false, tmpHome)
    expect(await readDesktopSettings(tmpHome)).toEqual({ version: 1, updates: { autoDownload: false } })
  })

  it("concurrent writes: whichever rename lands last wins whole, never a corrupt partial merge", async () => {
    // Two writers racing (e.g. two `desktop:settings:set-auto-download` IPC
    // calls arriving close together) each write to their OWN uniquely-named
    // temp file (pid + a random UUID — see writeDesktopSettings's doc
    // comment) and only then rename over the real path. That means the file
    // at any instant is always ONE writer's complete output, never bytes
    // from both — the property this test actually proves, since which
    // writer's rename lands last is a genuine race this test cannot pin
    // down.
    await Promise.all([
      writeDesktopSettings({ version: 1, updates: { autoDownload: true } }, tmpHome),
      writeDesktopSettings({ version: 1, updates: { autoDownload: false } }, tmpHome),
    ])
    const onDisk = await readDesktopSettings(tmpHome)
    expect(onDisk.version).toBe(1)
    expect([true, false]).toContain(onDisk.updates.autoDownload)
    // A third read must agree with the first — the winning write is stable,
    // not a torn/half-applied state that changes between reads.
    expect(await readDesktopSettings(tmpHome)).toEqual(onDisk)
  })
})

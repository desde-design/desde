import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  manifestPathFor,
  refreshUpdateManifestEntry,
  verifyUpdateManifest,
} from "../scripts/update-manifest.mjs"

/**
 * electron-builder writes latest-mac.yml before our afterAllArtifactBuild hook
 * staples the notarization ticket into the dmg. MEASURED on the 2026-09-01
 * signed build: the manifest said 163309858 bytes, the stapled file was
 * 163311926, and the sha512s disagreed. These tests reproduce that shape with
 * small files: write a manifest that is correct, append bytes to the dmg the
 * way stapling does, and check that verification catches it and refresh
 * repairs it.
 */

function sha512(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("base64")
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "update-manifest-"))
  const dmg = join(dir, "Desde-0.1.0-arm64.dmg")
  const zip = join(dir, "Desde-0.1.0-arm64-mac.zip")
  writeFileSync(dmg, Buffer.from("dmg contents before stapling"))
  writeFileSync(zip, Buffer.from("zip contents, never rewritten"))
  const manifest = join(dir, "latest-mac.yml")
  writeFileSync(
    manifest,
    [
      "version: 0.1.0",
      "files:",
      `  - url: Desde-0.1.0-arm64-mac.zip`,
      `    sha512: ${sha512(zip)}`,
      `    size: ${readFileSync(zip).length}`,
      `  - url: Desde-0.1.0-arm64.dmg`,
      `    sha512: ${sha512(dmg)}`,
      `    size: ${readFileSync(dmg).length}`,
      "path: Desde-0.1.0-arm64-mac.zip",
      `sha512: ${sha512(zip)}`,
      "releaseDate: '2026-09-01T22:19:47.000Z'",
      "",
    ].join("\n"),
  )
  return { dir, dmg, zip, manifest }
}

describe("update manifest", () => {
  it("passes when every entry matches its file", () => {
    const { manifest } = fixture()
    expect(verifyUpdateManifest(manifest).map((c) => c.url)).toEqual([
      "Desde-0.1.0-arm64-mac.zip",
      "Desde-0.1.0-arm64.dmg",
    ])
  })

  it("fails once the dmg is rewritten after the manifest, which is what stapling does", () => {
    const { dmg, manifest } = fixture()
    appendFileSync(dmg, Buffer.alloc(2068, 1)) // the measured staple-ticket growth
    expect(() => verifyUpdateManifest(manifest)).toThrow(/stale for Desde-0\.1\.0-arm64\.dmg/)
    expect(() => verifyUpdateManifest(manifest)).toThrow(/stapling/)
  })

  it("refresh rewrites exactly the stapled artifact's entry and leaves the zip alone", () => {
    const { dmg, zip, manifest } = fixture()
    const zipShaBefore = sha512(zip)
    appendFileSync(dmg, Buffer.alloc(2068, 1))
    const r = refreshUpdateManifestEntry(dmg)
    expect(r?.changed).toBe(true)
    expect(r?.before.size).toBe("dmg contents before stapling".length)
    expect(r?.after.size).toBe("dmg contents before stapling".length + 2068)
    const text = readFileSync(manifest, "utf8")
    expect(text).toContain(`sha512: ${sha512(dmg)}`)
    expect(text).toContain(`sha512: ${zipShaBefore}`)
    // and the file is now verifiable again
    expect(() => verifyUpdateManifest(manifest)).not.toThrow()
  })

  it("refresh is a no-op when nothing changed, and reports that", () => {
    const { dmg } = fixture()
    const r = refreshUpdateManifestEntry(dmg)
    expect(r?.changed).toBe(false)
  })

  it("refresh returns null for an artifact the manifest does not describe", () => {
    const { dir } = fixture()
    const other = join(dir, "Desde-0.1.0-arm64.dmg.blockmap")
    writeFileSync(other, "not in the manifest")
    expect(refreshUpdateManifestEntry(other)).toBeNull()
  })

  it("verification fails on a manifest that names a missing file", () => {
    const { manifest } = fixture()
    appendFileSync(manifest, "  - url: Desde-0.1.0-x64.dmg\n    sha512: AAAA\n    size: 1\n")
    expect(() => verifyUpdateManifest(manifest)).toThrow(/does not exist beside it/)
  })

  it("finds the manifest beside an artifact, or reports none", () => {
    const { dmg, manifest, dir } = fixture()
    expect(manifestPathFor(dmg)).toBe(manifest)
    expect(manifestPathFor(join(dir, "elsewhere", "x.dmg"))).toBeNull()
  })
})

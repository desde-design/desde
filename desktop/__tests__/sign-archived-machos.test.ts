/**
 * The demo's node_modules ship as one `.tgz`, and Apple's notary opens it:
 * an unsigned Mach-O inside the archive fails the whole submission (seen
 * 2026-09-03 on the first signed build after the bundle diet). These tests
 * cover the two halves that do not need a certificate: choosing the keychain
 * identity, and the extract → find → sign → repack loop, driven with a stub
 * signer over a real Mach-O (`/bin/ls`, present on every macOS host) so the
 * scan is the real `file`-based one, not a mock of it.
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { codesignArgs, pickDeveloperIdIdentity, signMachOsInsideArchive } from "../scripts/sign-archived-machos.mjs"

const ONE_IDENTITY = `Policy: Code Signing
  Matching identities
  1) 5EE72CC9B9756081BF7C6F8A84A7250413B2424E "Developer ID Application: Example Person (ABCDE12345)"
     1 identities found

  Valid identities only
  1) 5EE72CC9B9756081BF7C6F8A84A7250413B2424E "Developer ID Application: Example Person (ABCDE12345)"
     1 valid identities found
`

describe("pickDeveloperIdIdentity", () => {
  it("returns the hash and name of the one Developer ID Application identity", () => {
    expect(pickDeveloperIdIdentity(ONE_IDENTITY)).toEqual({
      hash: "5EE72CC9B9756081BF7C6F8A84A7250413B2424E",
      name: "Developer ID Application: Example Person (ABCDE12345)",
    })
  })

  it("ignores identities of other kinds, such as Apple Development", () => {
    const out =
      '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Example Person (ABCDE12345)"\n' +
      '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Example Person (ABCDE12345)"\n'
    expect(pickDeveloperIdIdentity(out).hash).toBe("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
  })

  it("throws when there is no Developer ID Application identity", () => {
    expect(() => pickDeveloperIdIdentity("     0 valid identities found\n")).toThrow(/No "Developer ID Application"/)
  })

  it("throws rather than guess when there are two", () => {
    const out =
      '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: One (ABCDE12345)"\n' +
      '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Two (FGHIJ67890)"\n'
    expect(() => pickDeveloperIdIdentity(out)).toThrow(/2 "Developer ID Application" identities/)
  })
})

describe("codesignArgs", () => {
  it("asks for a secure timestamp and the hardened runtime by default, like osx-sign does", () => {
    expect(codesignArgs({ identityHash: "ABC", file: "/x/a.node" })).toEqual([
      "--sign",
      "ABC",
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "/x/a.node",
    ])
  })

  it("passes the DESDE_DESKTOP_SIGN_TIMESTAMP escape hatch through as --timestamp=<value>", () => {
    expect(codesignArgs({ identityHash: "ABC", timestamp: "none", file: "/x/a.node" })).toContain("--timestamp=none")
  })
})

describe("signMachOsInsideArchive", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function makeArchive(): string {
    dir = mkdtempSync(join(tmpdir(), "desde-sign-archive-test-"))
    const nm = join(dir, "node_modules")
    mkdirSync(join(nm, "native-darwin-arm64"), { recursive: true })
    mkdirSync(join(nm, ".bin"), { recursive: true })
    copyFileSync("/bin/ls", join(nm, "native-darwin-arm64", "native.node"))
    writeFileSync(join(nm, "native-darwin-arm64", "index.js"), "module.exports = require('./native.node')\n")
    writeFileSync(join(nm, "index.js"), "// not a binary\n")
    symlinkSync("../native-darwin-arm64/index.js", join(nm, ".bin", "native"))
    const archive = join(dir, "node_modules.tgz")
    execFileSync("tar", ["-czf", archive, "-C", dir, "node_modules"])
    rmSync(nm, { recursive: true, force: true })
    return archive
  }

  it("signs exactly the Mach-O files inside the archive and repacks it with the same entries", async () => {
    const archive = makeArchive()
    const before = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean).sort()
    const signed: string[] = []

    const result = await signMachOsInsideArchive(archive, {
      identityHash: "ABC",
      signFile: async (file) => {
        signed.push(file)
        // Leave a mark the way codesign changes the bytes, so the repack can be proven to carry the signed file.
        writeFileSync(`${file}.signed-marker`, "")
      },
    })

    expect(result).toEqual(["node_modules/native-darwin-arm64/native.node"])
    expect(signed).toHaveLength(1)
    expect(signed[0].endsWith("/node_modules/native-darwin-arm64/native.node")).toBe(true)

    const after = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter(Boolean).sort()
    expect(after).toEqual([...before, "node_modules/native-darwin-arm64/native.node.signed-marker"].sort())
  })

  it("leaves an archive with no Mach-O inside untouched", async () => {
    dir = mkdtempSync(join(tmpdir(), "desde-sign-archive-test-"))
    mkdirSync(join(dir, "node_modules", "plain"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "plain", "index.js"), "// not a binary\n")
    const archive = join(dir, "node_modules.tgz")
    execFileSync("tar", ["-czf", archive, "-C", dir, "node_modules"])
    const bytesBefore = readFileSync(archive)

    const result = await signMachOsInsideArchive(archive, {
      identityHash: "ABC",
      signFile: async () => {
        throw new Error("should not be called")
      },
    })

    expect(result).toEqual([])
    expect(readFileSync(archive).equals(bytesBefore)).toBe(true)
  })
})

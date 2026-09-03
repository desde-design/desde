#!/usr/bin/env node
// Signs the Mach-O binaries that live INSIDE the demo's `node_modules.tgz`.
//
// Why this exists (MEASURED 2026-09-03, the first signed build after the
// bundle diet): Apple's notary service opens every archive inside the
// submission, tarballs included, and rejects the whole build when a Mach-O
// it finds there carries no Developer ID signature or no secure timestamp:
//
//   "The binary is not signed with a valid Developer ID certificate."
//   "The signature does not include a secure timestamp."
//   …/server/demo/node_modules.tgz/node_modules.tar/node_modules/
//     @tailwindcss/oxide-darwin-arm64/tailwindcss-oxide.darwin-arm64.node
//     lightningcss-darwin-arm64/lightningcss.darwin-arm64.node
//
// @electron/osx-sign walks the bundle's Contents/ tree and signs every binary
// FILE it finds, but a file inside a tarball is not a file on disk, so the
// walk never reaches these two. Before the diet the demo's node_modules was a
// loose tree and osx-sign covered it for free; packing it into one archive
// (see build-server-package.mts's packDemoNodeModules) took those binaries
// out of its reach without anyone noticing until Apple did.
//
// The fix is to sign them BEFORE they are archived, in the staged payload,
// with the same identity, secure timestamp and hardened runtime osx-sign
// would have applied: a Mach-O signature is embedded in the binary itself,
// so it survives tar round-trips and the unpack on the user's machine
// (editor-cli's materialize.ts) exactly as signed.
//
// This runs from scripts/build-desktop-app.mts under `--sign` only, after
// the payload is staged and before electron-builder runs. It is idempotent
// (`--force` re-signs an already-signed file), so reusing a payload with
// `--payload-dir` is fine.
import { execFile, execFileSync } from "node:child_process"
import { mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { findMachOFiles } from "./macho-scan.mjs"

const execFileAsync = promisify(execFile)

/**
 * Picks the one Developer ID Application identity out of
 * `security find-identity -v -p codesigning` output. That is the same
 * keychain search electron-builder runs for its own auto-discovery, so the
 * archive's contents end up signed by the identity the bundle around them
 * will be.
 *
 * Throws when there is none (a signed build cannot proceed) or more than one
 * (guessing would sign the archive with a different certificate than the
 * bundle, which notarization rejects just the same).
 *
 * @param {string} securityOutput
 * @returns {{ hash: string; name: string }}
 */
export function pickDeveloperIdIdentity(securityOutput) {
  // `security` prints every identity twice, once under "Matching identities"
  // and again under "Valid identities only", so the same hash is one identity.
  const byHash = new Map()
  for (const line of securityOutput.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application:[^"]*)"/.exec(line)
    if (m && !byHash.has(m[1])) byHash.set(m[1], { hash: m[1], name: m[2] })
  }
  const matches = [...byHash.values()]
  if (matches.length === 0) {
    throw new Error(
      'No "Developer ID Application" identity in the keychain (security find-identity -v -p codesigning). ' +
        "A signed build needs one; without it the binaries inside the demo archive cannot be signed.",
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} "Developer ID Application" identities in the keychain: ` +
        matches.map((m) => m.name).join("; ") +
        ". Refusing to pick one — the archive's contents must be signed by the same identity as the bundle.",
    )
  }
  return matches[0]
}

/** The keychain's one Developer ID Application identity — see pickDeveloperIdIdentity. */
export function findDeveloperIdIdentity() {
  const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
  return pickDeveloperIdIdentity(out)
}

/**
 * The codesign arguments for one file. Mirrors what @electron/osx-sign
 * emits per file for a hardened-runtime signed build (`--sign <hash>
 * --force --timestamp --options runtime`), minus entitlements, which a
 * native module does not take.
 *
 * `timestamp` follows the same escape hatch as electron-builder.config.mjs's
 * `mac.timestamp` (`DESDE_DESKTOP_SIGN_TIMESTAMP`): unset means Apple's
 * default timestamp server, `"none"` means skip timestamping, anything else
 * is a server URL.
 *
 * @param {{ identityHash: string; timestamp?: string | undefined; file: string }} input
 * @returns {string[]}
 */
export function codesignArgs({ identityHash, timestamp, file }) {
  return [
    "--sign",
    identityHash,
    "--force",
    timestamp ? `--timestamp=${timestamp}` : "--timestamp",
    "--options",
    "runtime",
    file,
  ]
}

/**
 * Signs one Mach-O with codesign, then reads the signature back and refuses
 * to continue unless it names a Team and, when a timestamp was requested,
 * carries one. `codesign -dvvv` prints its report on stderr.
 *
 * @param {{ identityHash: string; timestamp?: string | undefined }} identity
 * @param {string} file
 */
async function codesignAndVerify(identity, file) {
  await execFileAsync("codesign", codesignArgs({ ...identity, file }))
  const { stderr } = await execFileAsync("codesign", ["-dvvv", file])
  if (!/^TeamIdentifier=(?!not set)\S+/m.test(stderr)) {
    throw new Error(`${file}: signed, but codesign -dvvv reports no TeamIdentifier`)
  }
  if (identity.timestamp !== "none" && !/^Timestamp=/m.test(stderr)) {
    throw new Error(`${file}: signed, but codesign -dvvv reports no secure Timestamp`)
  }
}

/**
 * Unpacks `archivePath` (a `.tgz` whose one top-level entry is
 * `node_modules/`), signs every Mach-O inside it, and repacks it in place.
 * Returns the archive-relative paths that were signed, sorted.
 *
 * `tar` is the system one on purpose, the same choice packDemoNodeModules
 * made: `.bin/*` symlinks and file modes round-trip exactly, and it is what
 * unpacks the archive on the user's machine.
 *
 * `signFile` is injectable so the extract → find → sign → repack loop can be
 * tested without a certificate; the default is the real codesign path.
 *
 * @param {string} archivePath
 * @param {{ identityHash: string; timestamp?: string | undefined; signFile?: (file: string) => Promise<void> }} options
 * @returns {Promise<string[]>}
 */
export async function signMachOsInsideArchive(archivePath, options) {
  const identity = { identityHash: options.identityHash, timestamp: options.timestamp }
  const signFile = options.signFile ?? ((file) => codesignAndVerify(identity, file))
  const work = await mkdtemp(join(tmpdir(), "desde-sign-archive-"))
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", work])
    const relPaths = await findMachOFiles(work)
    for (const rel of relPaths) {
      await signFile(join(work, rel))
    }
    if (relPaths.length > 0) {
      const repacked = `${archivePath}.signing`
      await execFileAsync("tar", ["-czf", repacked, "-C", work, "node_modules"])
      await rename(repacked, archivePath)
    }
    return relPaths
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

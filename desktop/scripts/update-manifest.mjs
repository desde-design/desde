// Keeps electron-builder's update manifest (latest-mac.yml) truthful after a
// step that rewrites an artifact it describes.
//
// electron-builder writes latest-mac.yml while producing the artifacts, with
// each file's sha512 and size. Our afterAllArtifactBuild hook then notarizes
// the dmg and STAPLES the ticket into it, which appends about 2 KB. MEASURED
// on the 2026-09-01 signed build: the manifest said 163309858 bytes, the file
// on disk was 163311926, and the sha512s disagreed. Every signed build had
// shipped a manifest that lied about its own dmg.
//
// electron-updater on macOS fetches the zip for updates, and the zip entry was
// correct, so auto-update itself would have worked. That is not a reason to
// ship a manifest whose dmg line is wrong: anything that verifies the dmg
// against it fails, and "the wrong half happens to be unused" is not a
// property worth relying on.
//
// Two functions, both pure text over the yml beside the artifact:
//   refreshUpdateManifestEntry(artifactPath): rewrite that file's sha512+size.
//   verifyUpdateManifest(manifestPath): every url entry matches its file, or
//   throw naming the first that does not.

import { createHash } from "node:crypto"
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const ENTRY = /(- url: (\S+)\n\s+sha512: )(\S+)(\n\s+size: )(\d+)/g

function sha512Base64(path) {
  return createHash("sha512").update(readFileSync(path)).digest("base64")
}

/** The manifest electron-builder writes beside a mac artifact, if present. */
export function manifestPathFor(artifactPath) {
  const p = join(dirname(artifactPath), "latest-mac.yml")
  return existsSync(p) ? p : null
}

/**
 * Rewrites `artifactPath`'s entry in the manifest beside it from the bytes on
 * disk. Returns what changed, or null when the manifest has no entry for it
 * (the zip and the dmg both have one; a caller passing something else gets
 * null rather than a rewrite of nothing).
 */
export function refreshUpdateManifestEntry(artifactPath) {
  const manifest = manifestPathFor(artifactPath)
  if (!manifest) return null
  const name = basename(artifactPath)
  const sha512 = sha512Base64(artifactPath)
  const size = statSync(artifactPath).size
  let before = null
  const text = readFileSync(manifest, "utf8")
  const next = text.replace(ENTRY, (whole, head, url, oldSha, mid, oldSize) => {
    if (url !== name) return whole
    before = { sha512: oldSha, size: Number(oldSize) }
    return `${head}${sha512}${mid}${size}`
  })
  if (before === null) return null
  if (next !== text) writeFileSync(manifest, next)
  return { manifest, url: name, before, after: { sha512, size }, changed: next !== text }
}

/**
 * Every `url:` entry must match the file it names, by sha512 and size. Throws
 * on the first mismatch. Returns the entries checked so a caller can print
 * them; a manifest with zero entries is treated as a failure too, since the
 * whole point is that something was described.
 */
export function verifyUpdateManifest(manifestPath) {
  const text = readFileSync(manifestPath, "utf8")
  const dir = dirname(manifestPath)
  const checked = []
  for (const m of text.matchAll(ENTRY)) {
    const [, , url, sha512, , size] = m
    const file = join(dir, url)
    if (!existsSync(file)) throw new Error(`${basename(manifestPath)} names ${url}, which does not exist beside it`)
    const actualSha = sha512Base64(file)
    const actualSize = statSync(file).size
    if (actualSha !== sha512 || actualSize !== Number(size)) {
      throw new Error(
        `${basename(manifestPath)} is stale for ${url}: manifest says size ${size}, file is ${actualSize}` +
          (actualSha !== sha512 ? "; sha512 differs" : "") +
          ". Something rewrote the artifact after the manifest was generated (stapling a notarization ticket does this).",
      )
    }
    checked.push({ url, size: actualSize })
  }
  if (checked.length === 0) throw new Error(`${basename(manifestPath)} describes no files`)
  return checked
}

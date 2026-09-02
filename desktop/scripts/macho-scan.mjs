#!/usr/bin/env node
// Finds every Mach-O binary under a directory — the literal test the Phase 5
// brief specifies: "Walk the built app bundle and find every Mach-O (`file`
// reports `Mach-O`)". Two callers, both wanting the SAME enumeration logic —
// this file is the single source of truth so neither hand-writes a list:
//
//   1. electron-builder.config.mjs (signed builds only) — derives
//      `mac.binaries` from the STAGED PAYLOAD DIRECTORY before packaging,
//      because at config-eval time the packaged .app does not exist yet.
//      The payload dir's tree lands verbatim under Resources/server (see
//      that config's own doc comment on its two extraResources entries), so
//      a relative path found here maps 1:1 onto
//      Contents/Resources/server/<path> in the built app.
//
//   2. verify-mac-signing.mjs — walks the ACTUAL BUILT .app after packaging
//      (passing the whole bundle as `rootDir`, not just Resources/server)
//      and checks every Mach-O it finds is really signed with the expected
//      identity. This is the check that matters: @electron/osx-sign's own
//      signApp step already walks the entire Contents/ tree and (re-)signs
//      every binary FILE it finds there regardless of `mac.binaries` (read
//      from app-builder-lib's MacTargetHelper + @electron/osx-sign's own
//      walkAsync — both recurse the whole Contents/ directory looking for
//      files `isbinaryfile` calls binary, then codesign every one). So
//      `mac.binaries` turns out to be belt-and-suspenders for a binary that
//      already lives inside Contents/Resources/server, not load-bearing —
//      it is kept anyway because the brief asks for it explicitly, and
//      because it is cheap, honest documentation of exactly which binaries
//      this build knows it ships. The verification pass in (2) is what
//      actually proves coverage.
//
// Performance: MEASURED on the Phase 1 payload (8,479 files) — running
// `file` once per candidate serially would be trivially slow; batching many
// paths into each `file` invocation (it prints one line per argument, in
// argument order) and running a small pool of batches concurrently finished
// in ~11s on this machine. That is the shape below, not a per-file `exec`.
import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const BATCH_SIZE = 200
const CONCURRENCY = 8

/**
 * Every regular file under `rootDir`, as absolute paths. Symlinks are
 * followed for classification (npm lays out `node_modules/.bin/*` as
 * symlinks to real files elsewhere in the tree — e.g. a future `claude` or
 * `esbuild` bin-shim symlink should still be found) but never recursed
 * through: a symlinked DIRECTORY is skipped rather than walked, which is
 * what keeps a self-referential or cyclic link from hanging this function.
 * A symlink whose target no longer exists is silently skipped — there is
 * nothing there to sign.
 */
async function listCandidateFiles(rootDir) {
  const results = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        let resolved
        try {
          resolved = await stat(full) // follows the link
        } catch {
          continue
        }
        if (resolved.isFile()) results.push(full)
        continue
      }
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) results.push(full)
    }
  }
  await walk(rootDir)
  return results
}

/**
 * Classifies one batch of absolute paths via a single `file` invocation.
 * Returns the subset whose `file` output contains "Mach-O".
 *
 * F6 (whole-branch review, Minor): `-L`/`--dereference` is required for a
 * SYMLINK path to classify as anything other than "symbolic link" — `file`
 * without it reports the link itself, never the target, so a symlinked
 * Mach-O (`listCandidateFiles` pushes the symlink's own path, per its doc
 * comment) would silently and permanently fail to be found as one. Harmless
 * today only because the three real Mach-Os this scanner currently sees are
 * all regular files, not symlinks — exactly the future case this flag (and
 * `listCandidateFiles`'s own claim to follow symlinks "for classification")
 * exists to cover.
 */
async function classifyBatch(paths) {
  if (paths.length === 0) return []
  const { stdout } = await execFileAsync("file", ["--brief", "--no-pad", "-L", ...paths], {
    maxBuffer: 64 * 1024 * 1024,
  })
  const lines = stdout.split("\n")
  // `file --brief` prints exactly one line per argument, in argument order —
  // this is what makes positional pairing with `paths` safe.
  return paths.filter((_, i) => (lines[i] ?? "").includes("Mach-O"))
}

/**
 * Every Mach-O binary under `rootDir`. Returns POSIX-style paths relative to
 * `rootDir`, sorted, so the result is stable and diff-friendly regardless of
 * filesystem readdir order.
 *
 * @param {string} rootDir
 * @returns {Promise<string[]>}
 */
export async function findMachOFiles(rootDir) {
  const candidates = await listCandidateFiles(rootDir)
  const batches = []
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE))
  }
  const machoAbs = []
  let cursor = 0
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++]
      machoAbs.push(...(await classifyBatch(batch)))
    }
  }
  const workerCount = Math.min(CONCURRENCY, Math.max(batches.length, 1))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return machoAbs.map((p) => relative(rootDir, p).split(sep).join("/")).sort()
}

// CLI: `node macho-scan.mjs <dir>` — prints one relative path per line,
// useful for ad-hoc inspection (used to produce the Phase 5 verification
// evidence without writing a one-off script).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: node macho-scan.mjs <dir>")
    process.exit(1)
  }
  const found = await findMachOFiles(dir)
  for (const p of found) console.log(p)
  console.error(`\n${found.length} Mach-O file(s) under ${dir}`)
}

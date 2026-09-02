/**
 * Fails when `src/bridge/**` changed on this branch but `BRIDGE_VERSION` did not.
 *
 * WHY THIS EXISTS. Two different staleness bugs are possible, and only one of
 * them was already caught:
 *
 *   1. Source edited, bundle not rebuilt. Covered — `bridge-bundle-version.test.ts`
 *      rebuilds from source with esbuild and asserts byte-identity.
 *   2. Source edited AND rebuilt, but the version string left alone. NOT covered
 *      by anything, because the bundle is perfectly self-consistent. The version
 *      is the cache-buster in `/p/{slug}/__desde/bridge-<version>.js`, so
 *      the failure lands on clients: a browser (or CDN) holding the old URL keeps
 *      running old code with `immutable, max-age=31536000` telling it never to
 *      re-check. Nothing in CI notices, and locally you get the correct new
 *      bridge, so it is invisible exactly to the person who made the change.
 *
 * This happened for real on 2026-08-08 and was caught by eye during an E2E run,
 * not by a gate.
 *
 * Degrades to a PASS with a printed reason whenever the comparison cannot be
 * made honestly (no merge base, shallow clone, detached HEAD). A gate that
 * fires on a CI checkout quirk gets disabled, and then it protects nothing.
 *
 * Run: ./node_modules/.bin/tsx scripts/check-bridge-version.mts
 */
import { execFileSync } from "node:child_process"

const BRIDGE_SRC = "src/bridge/"
const VERSION_FILE = "src/bridge/comment-bridge.ts"
const VERSION_RE = /__DESDE_BRIDGE_VERSION__\s*=\s*["']([^"']+)["']/

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function pass(reason: string): never {
  console.log(`bridge-version OK — ${reason}`)
  process.exit(0)
}

/**
 * The comparison point is the merge base with the PUBLISHED default branch, not
 * with local `main`.
 *
 * Getting this wrong makes the gate a no-op in the exact situation it is meant
 * for. Comparing against local `main` means that when you are ON main —
 * committing directly, as this repo's own sessions have — `merge-base(HEAD,
 * main)` IS HEAD, the diff is empty, and the check passes unconditionally
 * forever. Caught by falsifying it: a deliberate unbumped bridge edit sailed
 * through. `origin/main` keeps unpushed local commits in view.
 */
let base: string
try {
  // `BRIDGE_VERSION_BASE` overrides the comparison point — for CI setups whose
  // default branch is not `main`, and so this gate can be falsified on demand
  // (a gate nobody has watched fail is a gate nobody knows works).
  base = process.env.BRIDGE_VERSION_BASE
    ? git("rev-parse", process.env.BRIDGE_VERSION_BASE)
    : git("merge-base", "HEAD", "origin/main")
} catch {
  try {
    base = git("merge-base", "HEAD", "main")
  } catch {
    pass("no merge base with origin/main or main (shallow clone or detached HEAD)")
  }
}

const changed = git("diff", "--name-only", base, "--", BRIDGE_SRC)
  .split("\n")
  .filter(Boolean)
  // Tests are not shipped in the bundle, so editing one changes no served byte.
  .filter((f) => !f.endsWith(".test.ts"))

if (changed.length === 0) pass("no non-test change under src/bridge/ on this branch")

const versionAt = (ref: string): string | null => {
  try {
    return git("show", `${ref}:${VERSION_FILE}`).match(VERSION_RE)?.[1] ?? null
  } catch {
    return null
  }
}

const before = versionAt(base)
const after = versionAt("HEAD")

if (before === null || after === null) {
  pass(`could not read BRIDGE_VERSION at ${before === null ? "the merge base" : "HEAD"}`)
}

if (before !== after) pass(`bumped ${before} → ${after}`)

console.error(
  `bridge-version FAILED\n\n` +
    `  ${changed.length} file(s) under ${BRIDGE_SRC} changed on this branch, but\n` +
    `  BRIDGE_VERSION is still "${after}".\n\n` +
    changed.map((f) => `    ${f}`).join("\n") +
    `\n\n  The version is the cache-buster in the served bridge URL, which is sent\n` +
    `  with "immutable, max-age=31536000". Shipping new bytes under the old\n` +
    `  version leaves every client that already fetched it running the old\n` +
    `  bridge, with no reason to ever re-check.\n\n` +
    `  Fix: bump the literal in ${VERSION_FILE} (next monotonic suffix — read\n` +
    `  the current value first, do not trust a value quoted in any doc), then\n` +
    `  run 'npm run build:bridge'.\n`,
)
process.exit(1)

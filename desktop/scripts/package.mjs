#!/usr/bin/env node
// Invokes electron-builder's Node API (not its CLI) to produce a packaged,
// unsigned .app + dmg + zip from desktop/dist and a pre-built CLI payload.
// Called by `scripts/build-desktop-app.mts`, the actual entry point —
// this script does no payload/desktop building of its own; it assumes both
// are already current and just does the electron-builder invocation, kept
// separate so it can also be run directly for fast iteration on packaging
// itself (`DESDE_PAYLOAD_DIR=<dir> node scripts/package.mjs`) without
// re-running a multi-minute payload build every time.
//
// The Node API, not the CLI, for one concrete reason: it resolves to an
// array of the artifact paths electron-builder actually produced. The CLI
// only offers that information by parsing stdout or globbing the output
// directory after the fact — both are one indirection layer this script
// doesn't need when the API hands the answer back directly.
//
// Arch is read from `process.arch` — THIS process's own architecture, which
// is also (by construction — see build-desktop-app.mts) the architecture the
// payload at DESDE_PAYLOAD_DIR was staged for. There is no `--arch`
// flag here: cross-arch packaging would silently ship one arch's Electron
// shell wrapped around a DIFFERENT arch's `claude` binary / esbuild / `.node`
// modules (npm only fetches the host's own platform binaries when the
// payload was staged — tasks/electron-app.md's explicit constraint). Asking
// for a specific arch belongs one layer up, in build-desktop-app.mts, where
// it can be validated against the actual host before any building starts.
import { Arch, Platform, build } from "electron-builder"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  checkPayloadFreshness,
  checkPayloadHostMatch,
  isPayloadInputsDirty,
  readPayloadManifest,
} from "./payload-manifest-guard.mjs"
// F9 (whole-branch review, fourth pass, P1 fix): the SAME algorithm
// `scripts/build-server-package.mts` uses to stamp
// `payload-manifest.json` at staging time — see that module's own doc
// comment for the exact boundary of what it fingerprints.
import { computePayloadFingerprint } from "../../scripts/payload-fingerprint.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, "..")
const repoRoot = resolve(desktopRoot, "..")
const configPath = resolve(desktopRoot, "electron-builder.config.mjs")

const payloadDir = process.env.DESDE_PAYLOAD_DIR
if (!payloadDir) {
  console.error(
    "DESDE_PAYLOAD_DIR must be set to an absolute path to a built CLI payload.\n" +
      "Run this via `npm run package:desktop` (scripts/build-desktop-app.mts) instead of " +
      "invoking this script directly, unless you already have a payload staged and just want to " +
      "re-run packaging against it.",
  )
  process.exit(1)
}
if (!existsSync(resolve(payloadDir, "dist", "cli.js"))) {
  console.error(`${resolve(payloadDir, "dist", "cli.js")} does not exist — is DESDE_PAYLOAD_DIR a built payload?`)
  process.exit(1)
}

// `dist/cli.js` existing only proves SOME payload is staged there — it says
// nothing about which architecture it was built for. A stale payload staged
// for the other arch would pass that check and go on to produce a broken
// installer (see this script's header comment and payload-manifest-guard.mjs
// for the full failure mode). This is the single chokepoint for that check:
// build-desktop-app.mts always reaches this script via `npm run package`,
// whether the payload was just built fresh (always host-matching, since it
// was built ON this host) or reused via `--payload-dir` (the case that can
// actually be stale).
const payloadManifest = readPayloadManifest(payloadDir)
const manifestCheck = checkPayloadHostMatch(payloadManifest, process.platform, process.arch, payloadDir)
if (!manifestCheck.ok) {
  console.error(manifestCheck.message)
  process.exit(1)
}

// F2 → F7 → F9 (whole-branch review; P1 fix, now fingerprint-based): a
// stale payload can otherwise be packaged — and even SIGNED — silently. See
// payload-manifest-guard.mjs's checkPayloadFreshness doc comment for the
// full reasoning; this is the one chokepoint that check runs at, same as
// the host-match check just above.
//
// F9: the decision is `current.fingerprint` — computePayloadFingerprint's
// content hash over every file that determines payload bytes, recomputed
// fresh right here and compared against what's stamped in the payload's own
// manifest. `commit`/`dirty` are passed through for the human-readable
// message ONLY now (provenance, not decision) — see that same doc comment
// for why git alone (F2's commit compare, even F7's scoped dirty compare)
// could not see a change to a gitignored built artifact, or to the staging
// recipe itself.
const signing = process.env.DESDE_DESKTOP_SIGN === "1"
const allowStale = process.env.DESDE_DESKTOP_ALLOW_STALE_PAYLOAD === "1"
const currentCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const currentDirty = isPayloadInputsDirty(repoRoot)
const currentFingerprint = computePayloadFingerprint(repoRoot)
const freshnessCheck = checkPayloadFreshness(
  payloadManifest,
  { commit: currentCommit, dirty: currentDirty, fingerprint: currentFingerprint },
  { signing, allowStale },
)
if (!freshnessCheck.ok) {
  console.error(freshnessCheck.message)
  process.exit(1)
}
if (freshnessCheck.warning) {
  console.warn(`\n⚠ ${freshnessCheck.warning}\n`)
}

/** electron-builder's own `Arch` enum only has string KEYS matching Node's `process.arch` for these two. */
const ARCH_BY_NODE_ARCH = { arm64: Arch.arm64, x64: Arch.x64 }
const arch = ARCH_BY_NODE_ARCH[process.arch]
if (!arch) {
  console.error(
    `Unsupported host architecture for packaging: ${process.arch} (Phase 3 supports arm64 and x64 only — ` +
      `see tasks/electron-app.md §5 Phase 3).`,
  )
  process.exit(1)
}

console.log(`Packaging for mac/${process.arch} (dmg + zip), payload: ${payloadDir}`)

try {
  const artifacts = await build({
    targets: Platform.MAC.createTarget(["dmg", "zip"], arch),
    config: configPath,
  })
  console.log("\nBuilt artifact(s):")
  for (const a of artifacts) console.log(`  ${a}`)
} catch (err) {
  console.error("electron-builder failed:", err)
  process.exit(1)
}

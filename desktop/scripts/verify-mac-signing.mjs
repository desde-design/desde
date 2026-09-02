#!/usr/bin/env node
// The Phase 5 signing GATE (tasks/electron-app.md §5 Phase 5 brief, "Derive
// that list... have the build fail loudly if it finds an unsigned Mach-O
// rather than shipping one"). Run against a BUILT `.app` bundle — never the
// pre-package payload directory, which was never signed at all.
//
// Three independent checks, all recorded:
//
//   1. `codesign --verify --deep --strict --verbose=2 <App>.app` — the
//      whole-bundle structural check (nested seals, embedded Info.plists).
//   2. Every Mach-O in the ENTIRE bundle (not just Resources/server —
//      Electron's own Framework, helper apps, and Squirrel.framework are
//      Mach-Os too, and Apple's notarization service checks the whole
//      bundle) is enumerated via macho-scan.mjs's findMachOFiles, then each
//      one's `codesign -dvvv` output is checked for a `TeamIdentifier=`
//      matching the expected team (default: Mo's real Team ID, JWK4LSZPKZ —
//      the Team ID is the stable, locale-independent invariant; the display
//      name isn't). ANY unsigned or wrong-identity Mach-O fails the gate.
//   3. The top-level executable's ENTITLEMENTS contain every entitlement in
//      REQUIRED_ENTITLEMENTS. Added 2026-08-13, after a build that passed
//      checks 1, 2 and notarization shipped anyway and could not open a
//      single project. Cause: the hardened runtime enforces macOS library
//      validation by default, so the app refused to map the user's own
//      `.node` modules (their vite/rollup/fsevents — adhoc-signed by npm,
//      therefore a different Team ID from ours) and vite died with rollup's
//      misleading "npm has a bug related to optional dependencies" message.
//      Checks 1 and 2 are structurally blind to this by construction: they
//      ask whether OUR binaries are signed correctly, and every one of them
//      was. See build/entitlements.mac.plist for the full measurement.
//
//      This check gates because a missing entitlement here is not cosmetic —
//      it is an app that installs, launches, and then cannot do the one
//      thing it is for. Deliberately a hardcoded list and not a diff against
//      the .plist: each of these is a documented decision with a cost, and
//      changing the shipped set should mean editing this list on purpose.
//   4. `spctl --assess --type execute --verbose <App>.app` — recorded but
//      NEVER gates. It is expected to fail on an unnotarized build (the
//      brief: "this WILL fail... That is expected. Record the exact message
//      so the next task can confirm notarization changes it"). Folding this
//      into the pass/fail gate would make an intentionally-unnotarized
//      build unshippable for the wrong reason.
//
// Usage:
//   node verify-mac-signing.mjs <App.app> [--team-id <id>] [--json <path>]
//
// Exits non-zero (throws inside main()) iff check 1, 2 or 3 fails. Check 4
// is informational only and never affects the exit code.
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import { findMachOFiles } from "./macho-scan.mjs"

const execFileAsync = promisify(execFile)

const DEFAULT_TEAM_ID = "JWK4LSZPKZ" // Mo's real Apple Developer Team ID (tasks/electron-app.md §5 Phase 5 brief)

// Must match build/entitlements.mac.plist, which documents WHY each one is
// here. Read that file before adding or removing an entry.
const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  // The one whose absence shipped a signed, notarized app that could not
  // open a project. See check 3 in this file's header comment.
  "com.apple.security.cs.disable-library-validation",
]

function parseArgs(argv) {
  let appPath = null
  let teamId = DEFAULT_TEAM_ID
  let jsonPath = null
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--team-id") teamId = argv[++i]
    else if (a === "--json") jsonPath = argv[++i]
    else if (!appPath) appPath = a
    else throw new Error(`unrecognized argument: ${a}`)
  }
  if (!appPath) throw new Error("usage: node verify-mac-signing.mjs <App.app> [--team-id <id>] [--json <path>]")
  return { appPath: resolve(appPath), teamId, jsonPath }
}

/** Runs a command, never throwing on a non-zero exit — codesign/spctl both use exit codes to signal "not signed"/"rejected", which is DATA here, not a script bug. */
async function runCapture(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? err),
    }
  }
}

/** Whole-bundle structural verification — brief item 1. */
async function verifyDeep(appPath) {
  const result = await runCapture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath])
  return { ...result, pass: result.code === 0 }
}

/** Per-Mach-O signature + identity check — brief item 3. */
async function verifyBinary(filePath, expectedTeamId) {
  const result = await runCapture("codesign", ["-dvvv", filePath])
  const output = `${result.stdout}\n${result.stderr}`
  const unsigned = /code object is not signed at all/.test(output)
  // Captures either a real Team ID ("TeamIdentifier=JWK4LSZPKZ") or the
  // literal "TeamIdentifier=not set" (ad-hoc / no-team signature, e.g. a
  // vendor-signed .node module that never got re-signed) — either way, the
  // raw text after the `=` up to end-of-line is what we compare below.
  const teamMatch = output.match(/TeamIdentifier=([^\n]+)/)
  const teamId = teamMatch ? teamMatch[1].trim() : null
  const hardened = /flags=0x\w*10000\(runtime\)/.test(output)
  const signedByExpectedTeam = teamId === expectedTeamId
  return {
    path: filePath,
    unsigned,
    teamId,
    hardenedRuntime: hardened,
    signedByExpectedTeam,
    pass: !unsigned && signedByExpectedTeam,
    raw: output.trim(),
  }
}

/**
 * Entitlements on the TOP-LEVEL executable — check 3.
 *
 * The top-level bundle is the right (and only) place to look: it is what
 * `mac.entitlements` signs, and it is the process that loads the user's
 * project — `process.execPath` under ELECTRON_RUN_AS_NODE resolves to
 * `Contents/MacOS/<Product>` (desktop/child.ts, main.ts). Nested binaries get
 * entitlements.mac.inherit.plist and deliberately carry a smaller set.
 *
 * `--entitlements :-` emits the raw plist XML (the bare `-` form prints a
 * human-readable dump that is far more annoying to parse). Reading the
 * `<key>` names is enough: every entitlement we require is a boolean-true.
 */
async function verifyEntitlements(appPath, required) {
  const result = await runCapture("codesign", ["-d", "--entitlements", ":-", appPath])
  const output = `${result.stdout}\n${result.stderr}`
  const present = [...output.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1].trim())
  const missing = required.filter((key) => !present.includes(key))
  return {
    pass: result.code === 0 && missing.length === 0,
    required,
    present,
    missing,
    raw: output.trim(),
  }
}

/** Gatekeeper assessment — brief item 4. Informational only; a failure here is EXPECTED pre-notarization and must never fail the gate. */
async function assessSpctl(appPath) {
  const result = await runCapture("spctl", ["--assess", "--type", "execute", "--verbose", appPath])
  return { ...result, accepted: result.code === 0 }
}

export async function verifyMacSigning(
  appPath,
  { teamId = DEFAULT_TEAM_ID, requiredEntitlements = REQUIRED_ENTITLEMENTS } = {},
) {
  if (!isAbsolute(appPath)) throw new Error(`appPath must be absolute, got: ${appPath}`)

  const deep = await verifyDeep(appPath)
  const machoRelPaths = await findMachOFiles(appPath)
  const binaries = []
  for (const rel of machoRelPaths) {
    binaries.push(await verifyBinary(resolve(appPath, rel), teamId))
  }
  const entitlements = await verifyEntitlements(appPath, requiredEntitlements)
  const spctl = await assessSpctl(appPath)

  const failures = binaries.filter((b) => !b.pass)
  const allBinariesSigned = failures.length === 0
  const pass = deep.pass && allBinariesSigned && entitlements.pass

  return {
    appPath,
    teamId,
    machOCount: binaries.length,
    signedCount: binaries.length - failures.length,
    deepVerify: { pass: deep.pass, code: deep.code, output: `${deep.stdout}${deep.stderr}`.trim() },
    binaries,
    failures: failures.map((f) => ({ path: f.path, unsigned: f.unsigned, teamId: f.teamId })),
    entitlements,
    spctl: { accepted: spctl.accepted, code: spctl.code, output: `${spctl.stdout}${spctl.stderr}`.trim() },
    pass,
  }
}

async function main() {
  const { appPath, teamId, jsonPath } = parseArgs(process.argv)

  console.log(`Verifying mac code signing for ${appPath}\n(expected Team ID: ${teamId})\n`)
  const report = await verifyMacSigning(appPath, { teamId })

  console.log("── codesign --verify --deep --strict --verbose=2 ──")
  console.log(report.deepVerify.output || "(no output)")
  console.log(report.deepVerify.pass ? "\nPASS\n" : "\nFAIL\n")

  console.log(`── Mach-O enumeration (${report.machOCount} found) ──`)
  for (const b of report.binaries) {
    const status = b.pass ? "OK " : "FAIL"
    console.log(`[${status}] ${b.path}  (TeamIdentifier=${b.teamId ?? "none"}${b.hardenedRuntime ? ", hardened" : ""})`)
  }
  console.log(`\n${report.signedCount}/${report.machOCount} signed with team ${teamId}\n`)

  console.log("── entitlements on the top-level executable ──")
  for (const key of report.entitlements.required) {
    console.log(`[${report.entitlements.present.includes(key) ? "OK " : "FAIL"}] ${key}`)
  }
  console.log(report.entitlements.pass ? "\nPASS\n" : "\nFAIL\n")

  console.log("── spctl --assess --type execute --verbose (informational — expected to FAIL pre-notarization) ──")
  console.log(report.spctl.output || "(no output)")
  console.log(report.spctl.accepted ? "\nspctl: ACCEPTED\n" : "\nspctl: REJECTED (expected without notarization)\n")

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(`Report written to ${jsonPath}`)
  }

  if (!report.pass) {
    const lines = report.failures.map((f) => `  - ${f.path} (${f.unsigned ? "unsigned" : `TeamIdentifier=${f.teamId ?? "none"}`})`)
    if (report.entitlements.missing.length > 0) {
      lines.push(
        ...report.entitlements.missing.map(
          (key) => `  - MISSING ENTITLEMENT on the app bundle: ${key} (see build/entitlements.mac.plist)`,
        ),
      )
    }
    throw new Error(
      `Signing verification FAILED — ${report.failures.length} of ${report.machOCount} Mach-O binaries are not ` +
        `correctly signed with team ${teamId}, or the whole-bundle deep verify failed (pass=${report.deepVerify.pass}), ` +
        `or a required entitlement is absent (pass=${report.entitlements.pass}):\n` +
        lines.join("\n"),
    )
  }
  console.log("Signing verification PASSED.")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nverify-mac-signing failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}

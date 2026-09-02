#!/usr/bin/env node
// The Job 1 GATE (tasks/electron-app.md §5 Phase 5c, "the dmg is unsigned").
// Complements verify-mac-signing.mjs, which only ever inspected the `.app`
// bundle — Gatekeeper evaluates a downloaded DISK IMAGE's own primary
// signature/ticket separately from whatever's signed and notarized inside
// it (see electron-builder.config.mjs's "DMG notarization" doc comment and
// notarize-dmg.mjs for the full mechanism this verifies).
//
// Two checks, both must pass:
//
//   1. `xcrun stapler validate <dmg>` — the notarization ticket is
//      physically attached to the file (works offline; survives a network
//      failure at the user's install time).
//   2. `spctl -a -t open --context context:primary-signature -v <dmg>` —
//      the EXACT assessment macOS performs on a quarantined, browser-
//      downloaded disk image before mounting it. This is not
//      interchangeable with `spctl --assess --type execute` (used for the
//      `.app` in verify-mac-signing.mjs) — that's the wrong context for a
//      disk image and would misreport either a false pass or an unrelated
//      failure.
//
// Usage:
//   node verify-dmg-notarization.mjs <App.dmg> [--json <path>]
//
// Exits non-zero (throws inside main()) iff either check fails — unlike
// verify-mac-signing.mjs's spctl check, BOTH checks here are load-bearing:
// a dmg that isn't stapled or doesn't pass primary-signature assessment is
// exactly the first-install defect Job 1 exists to close, not an expected
// pre-notarization state.
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Runs a command, never throwing on a non-zero exit — stapler/spctl both use exit codes to signal "not stapled"/"rejected", which is DATA here, not a script bug. */
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

export async function verifyDmgNotarization(dmgPath) {
  if (!isAbsolute(dmgPath)) throw new Error(`dmgPath must be absolute, got: ${dmgPath}`)

  const staple = await runCapture("xcrun", ["stapler", "validate", dmgPath])
  const spctl = await runCapture("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmgPath])
  const pass = staple.code === 0 && spctl.code === 0

  return {
    dmgPath,
    staple: { pass: staple.code === 0, code: staple.code, output: `${staple.stdout}${staple.stderr}`.trim() },
    spctl: { pass: spctl.code === 0, code: spctl.code, output: `${spctl.stdout}${spctl.stderr}`.trim() },
    pass,
  }
}

function parseArgs(argv) {
  let dmgPath = null
  let jsonPath = null
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") jsonPath = argv[++i]
    else if (!dmgPath) dmgPath = a
    else throw new Error(`unrecognized argument: ${a}`)
  }
  if (!dmgPath) throw new Error("usage: node verify-dmg-notarization.mjs <App.dmg> [--json <path>]")
  return { dmgPath: resolve(dmgPath), jsonPath }
}

async function main() {
  const { dmgPath, jsonPath } = parseArgs(process.argv)

  console.log(`Verifying DMG notarization for ${dmgPath}\n`)
  const report = await verifyDmgNotarization(dmgPath)

  console.log("── xcrun stapler validate ──")
  console.log(report.staple.output || "(no output)")
  console.log(report.staple.pass ? "\nPASS\n" : "\nFAIL\n")

  console.log("── spctl -a -t open --context context:primary-signature ──")
  console.log(report.spctl.output || "(no output)")
  console.log(report.spctl.pass ? "\nPASS\n" : "\nFAIL\n")

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(`Report written to ${jsonPath}`)
  }

  if (!report.pass) {
    throw new Error(
      `DMG notarization verification FAILED for ${dmgPath} — stapler pass=${report.staple.pass}, spctl pass=` +
        `${report.spctl.pass}. A user downloading this dmg would hit a Gatekeeper warning on first install.`,
    )
  }
  console.log("DMG notarization verification PASSED.")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nverify-dmg-notarization failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}

/**
 * build-desktop-app — Phase 3 packaging orchestration
 * (`tasks/electron-app.md` §5 Phase 3 task 3): produces a packaged, unsigned
 * Desde `.app` (+ dmg + zip) end to end from a clean checkout —
 * build the Phase 1 CLI payload for THIS machine's architecture, build the
 * `desktop/` shell, then invoke electron-builder.
 *
 * ── Why a script and not a checklist of npm commands ────────────────────────
 *
 * Same reasoning as `payload-gate.mts` and `verify-host.mts`: Phase 5's CI
 * has to run exactly this sequence, unattended, on native arm64 and x64
 * runners, so it needs to be one command with a real failure mode — not a
 * README a human copies commands out of.
 *
 * ── The one constraint this script exists to enforce ────────────────────────
 *
 * **The payload must be staged NATIVELY, per architecture.**
 * `npm install` only fetches optional-dependency binaries matching the HOST
 * machine (the bundled `claude` binary, esbuild's Go binary, six `.node`
 * modules — see `tasks/electron-app.md` C3). An arm64 machine cannot produce
 * a working x64 payload, or vice versa, no matter what `--arch` flag you pass
 * it — there is no cross-compilation path for these binaries. So this script
 * does not attempt one: `--arch`, if given, is a DECLARATION the caller must
 * prove already matches `process.arch` — CI's own value for "which runner am
 * I on", used to catch a workflow-file mistake (the wrong job wired to the
 * wrong runner label) rather than to select behavior. Omit it locally; CI
 * MUST pass it, because a silent host/arch mismatch there would ship a
 * broken installer with no local machine around to notice.
 *
 * ── Run ───────────────────────────────────────────────────────────────────
 *
 *   npm run package:desktop
 *   npm run package:desktop -- --arch arm64          # CI: asserts against process.arch
 *   npm run package:desktop -- --payload-dir <dir>   # reuse an already-built payload
 *   npm run package:desktop -- --skip-desktop-build  # assume desktop/dist is current
 *   npm run package:desktop -- --sign                # Phase 5: real Developer ID signing
 *   npm run package:desktop -- --allow-stale-payload  # F2: package a stale/dirty --payload-dir anyway
 *
 * `--sign` (tasks/electron-app.md §5 Phase 5) threads `DESDE_DESKTOP_SIGN=1`
 * through to `npm run package` (electron-builder.config.mjs reads it — see that
 * file's own doc comment for the full signing design), then runs
 * `desktop/scripts/verify-mac-signing.mjs` against the freshly-built .app and
 * THROWS if it finds any unsigned or wrong-identity Mach-O — "have the build
 * fail loudly on an unsigned Mach-O rather than shipping one" (the brief's own
 * words). Signing needs Mo's real Developer ID Application certificate already
 * present in the login keychain; nothing is imported or prompted for here.
 *
 * `--allow-stale-payload` (F2, whole-branch review) threads
 * `DESDE_DESKTOP_ALLOW_STALE_PAYLOAD=1` through to `npm run package`,
 * which `desktop/scripts/package.mjs` reads via
 * `payload-manifest-guard.mjs`'s `checkPayloadCommitFreshness`: a payload
 * whose staged `gitCommit` doesn't match this checkout's HEAD (or was staged
 * from an uncommitted tree) otherwise only WARNS — but under `--sign` it is a
 * hard refusal unless this flag is also passed. It exists for the same
 * reason `--payload-dir` itself exists: fast iteration on packaging/signing
 * without rebuilding a payload every time, deliberately, with the staleness
 * acknowledged rather than silently shipped.
 *
 * Every artifact this script produces (payload staging dir, desktop/release/)
 * is gitignored — see desktop/.gitignore.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { refreshUpdateManifestEntry, verifyUpdateManifest } from "../desktop/scripts/update-manifest.mjs"
import { findDeveloperIdIdentity, signMachOsInsideArchive } from "../desktop/scripts/sign-archived-machos.mjs"
import { existsSync, readFileSync, statSync, writeFileSync, promises as fs } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const DESKTOP_ROOT = join(REPO_ROOT, "desktop")

interface CliArgs {
  arch: string | null
  payloadDir: string | null
  skipDesktopBuild: boolean
  sign: boolean
  allowStalePayload: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let arch: string | null = null
  let payloadDir: string | null = null
  let skipDesktopBuild = false
  let sign = false
  let allowStalePayload = false
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--arch") arch = argv[++i] ?? null
    else if (a === "--payload-dir") payloadDir = argv[++i] ?? null
    else if (a === "--skip-desktop-build") skipDesktopBuild = true
    else if (a === "--sign") sign = true
    else if (a === "--allow-stale-payload") allowStalePayload = true
    else throw new Error(`unrecognized argument: ${a}`)
  }
  return {
    arch,
    payloadDir: payloadDir ? resolve(process.cwd(), payloadDir) : null,
    skipDesktopBuild,
    sign,
    allowStalePayload,
  }
}

/**
 * Refuses an `--arch` that doesn't match `process.arch` — see the module doc
 * comment's "the one constraint this script exists to enforce". This is a
 * DECLARATION check, not an arch-selection mechanism: the script always
 * builds for `process.arch`, this function only catches the caller having
 * asked for something else.
 */
function assertNoCrossBuild(requestedArch: string | null): void {
  if (requestedArch === null) return
  if (requestedArch !== process.arch) {
    throw new Error(
      `--arch ${requestedArch} was requested, but this machine is ${process.arch}. Refusing to cross-build: ` +
        `npm install only fetches THIS machine's platform binaries (the bundled claude executable, esbuild, ` +
        `six .node modules — see tasks/electron-app.md C3), so an arm64 machine cannot produce a working x64 ` +
        `payload and vice versa. Run this on a native ${requestedArch} machine instead (Phase 5's CI uses one ` +
        `runner per architecture for exactly this reason).`,
    )
  }
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  console.log(`\n▸ ${command} ${args.join(" ")}  (in ${cwd})`)
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: env ?? process.env })
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(" ")}" failed (exit ${String(result.status)}) in ${cwd}`)
  }
}

function isCompletePayload(dir: string): boolean {
  return existsSync(join(dir, "dist", "cli.js")) && existsSync(join(dir, "payload-manifest.json"))
}

/** Recursive byte sum of real files under `dir`, skipping symlinks — same convention as build-server-package.mts's own size measurement (a symlink's target is already counted where it actually lives). */
async function directoryBytes(dir: string): Promise<number> {
  let bytes = 0
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) bytes += await directoryBytes(full)
    else if (entry.isFile()) bytes += (await fs.stat(full)).size
  }
  return bytes
}

/** `du -sk`'s reading of `dir` in bytes — actual disk usage (allocated blocks), which is what "installed size" conventionally means, as opposed to a raw byte sum that ignores filesystem block rounding. */
function diskUsageBytes(dir: string): number {
  const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" })
  const kb = parseInt(out.split("\t")[0], 10)
  if (!Number.isFinite(kb)) throw new Error(`could not parse \`du -sk ${dir}\` output: ${JSON.stringify(out)}`)
  return kb * 1024
}

function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** Every `*.app` directory under `releaseDir`, newest first (mtime of the bundle's own Info.plist, stable and cheap to stat vs walking the whole tree). */
async function findAppBundles(releaseDir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.endsWith(".app")) {
        found.push(full)
        continue // don't descend into the bundle itself
      }
      await walk(full)
    }
  }
  await walk(releaseDir)
  const withMtime = await Promise.all(
    found.map(async (p) => ({ p, mtime: (await fs.stat(p)).mtimeMs })),
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)
  return withMtime.map((x) => x.p)
}

/** Every `*.dmg`/`*.zip` file directly under `releaseDir`'s arch subdirectory tree, newest first. */
async function findInstallers(releaseDir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith(".dmg") || entry.name.endsWith(".zip")) {
        found.push(full)
      }
    }
  }
  await walk(releaseDir)
  const withMtime = await Promise.all(found.map(async (p) => ({ p, mtime: (await fs.stat(p)).mtimeMs })))
  withMtime.sort((a, b) => b.mtime - a.mtime)
  return withMtime.map((x) => x.p)
}

interface SigningReport {
  teamId: string
  machOCount: number
  signedCount: number
  pass: boolean
  deepVerify: { pass: boolean }
  spctl: { accepted: boolean; output: string }
}

interface DmgNotarizationReport {
  dmgPath: string
  staple: { pass: boolean }
  spctl: { pass: boolean }
  pass: boolean
}

interface PackageManifest {
  builtAt: string
  platform: NodeJS.Platform
  arch: string
  desktopGitCommit: string
  payloadDir: string
  payloadManifest: unknown
  appBundle: string
  installedSizeBytesDiskUsage: number
  installedSizeBytesRawSum: number
  installers: { path: string; bytes: number }[]
  signed: boolean
  signing: SigningReport | null
  /**
   * Job 1 (tasks/electron-app.md §5 Phase 5c, "the dmg is unsigned") — one
   * report per `.dmg` artifact this build produced, verifying the DMG
   * CONTAINER itself (not the `.app` inside it) passes the exact Gatekeeper
   * checks a first-time download hits. `null` on an unsigned build (a dmg
   * is never notarized without signing first) or if no `.dmg` was built.
   */
  dmgNotarization: DmgNotarizationReport[] | null
  /**
   * Non-null iff `DESDE_DESKTOP_SIGN_TIMESTAMP` was set for this build
   * (electron-builder.config.mjs's own doc comment on that var). It exists to
   * skip Apple's network secure-timestamp step, which a normal signed build
   * should NOT do — recorded here so a build produced with it set is never
   * mistaken for a normal one when this manifest is read later.
   */
  signTimestampOverride: string | null
}

/**
 * Runs `desktop/scripts/verify-mac-signing.mjs` against the built app and
 * THROWS if it reports failure — see that script's own doc comment for what
 * it checks (whole-bundle `codesign --verify --deep --strict`, every Mach-O
 * individually against Mo's Team ID, plus an informational `spctl` run that
 * never gates). This is the "fail loudly on an unsigned Mach-O rather than
 * shipping one" enforcement point: it runs AFTER packaging and BEFORE this
 * script writes package-manifest.json, so a build that fails verification
 * never gets the "DONE" declaration a caller might otherwise trust.
 */
function verifyMacSigningOrThrow(appBundle: string, releaseDir: string): SigningReport {
  const jsonPath = join(releaseDir, "signing-report.json")
  console.log(`\n▸ node scripts/verify-mac-signing.mjs "${appBundle}" --json "${jsonPath}"  (in ${DESKTOP_ROOT})`)
  const result = spawnSync(
    "node",
    [join(DESKTOP_ROOT, "scripts", "verify-mac-signing.mjs"), appBundle, "--json", jsonPath],
    { cwd: DESKTOP_ROOT, stdio: "inherit" },
  )
  // A missing/unparseable report means the script crashed before writing one
  // (e.g. `codesign`/`file`/`spctl` not on PATH) — that is itself a hard
  // failure, distinct from "it ran and found unsigned binaries".
  if (!existsSync(jsonPath)) {
    throw new Error(
      `verify-mac-signing.mjs did not produce a report at ${jsonPath} (exit ${String(result.status)}) — ` +
        `see its output above for why it didn't run to completion.`,
    )
  }
  const report = JSON.parse(readFileSync(jsonPath, "utf8")) as SigningReport
  if (result.status !== 0 || !report.pass) {
    throw new Error(
      `Signing verification FAILED (see output above) — ${report.signedCount}/${report.machOCount} Mach-O ` +
        `binaries correctly signed with team ${report.teamId}, deep-verify pass=${report.deepVerify.pass}. ` +
        `Refusing to declare this build done: an unsigned or wrong-identity Mach-O in a shipped bundle is ` +
        `exactly the failure mode Apple's notarization service rejects the WHOLE submission for.`,
    )
  }
  return report
}

/**
 * Job 1 (tasks/electron-app.md §5 Phase 5c): runs
 * `desktop/scripts/verify-dmg-notarization.mjs` against every `.dmg` this
 * build produced and THROWS if any fails — verify-mac-signing.mjs above
 * only ever inspected the `.app` bundle, which is not the artifact
 * Gatekeeper evaluates when a user downloads and opens a dmg. Mirrors
 * verifyMacSigningOrThrow's own shape: runs AFTER packaging and BEFORE this
 * script writes package-manifest.json, so a dmg that fails Gatekeeper's own
 * disk-image check never gets a "DONE" declaration a caller might trust.
 *
 * `installerPaths` should already be filtered to THIS build's own batch
 * (see main()'s `installerSizes` — a stale dmg from a previous run sitting
 * in the same `release/` directory must never be silently verified instead
 * of the one this run just produced).
 */
function verifyDmgNotarizationOrThrow(installerPaths: string[], releaseDir: string): DmgNotarizationReport[] {
  const dmgPaths = installerPaths.filter((p) => p.endsWith(".dmg"))
  if (dmgPaths.length === 0) {
    throw new Error(
      `--sign was passed but no .dmg artifact was found among this build's installers under ${releaseDir} — ` +
        `desktop/scripts/package.mjs always requests dmg+zip together, so a missing dmg means that target ` +
        `silently produced no output.`,
    )
  }
  const reports: DmgNotarizationReport[] = []
  for (const dmgPath of dmgPaths) {
    const jsonPath = join(releaseDir, `dmg-notarization-report-${basename(dmgPath)}.json`)
    console.log(
      `\n▸ node scripts/verify-dmg-notarization.mjs "${dmgPath}" --json "${jsonPath}"  (in ${DESKTOP_ROOT})`,
    )
    const result = spawnSync(
      "node",
      [join(DESKTOP_ROOT, "scripts", "verify-dmg-notarization.mjs"), dmgPath, "--json", jsonPath],
      { cwd: DESKTOP_ROOT, stdio: "inherit" },
    )
    if (!existsSync(jsonPath)) {
      throw new Error(
        `verify-dmg-notarization.mjs did not produce a report at ${jsonPath} (exit ${String(result.status)}) — ` +
          `see its output above for why it didn't run to completion.`,
      )
    }
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as DmgNotarizationReport
    if (result.status !== 0 || !report.pass) {
      throw new Error(
        `DMG notarization verification FAILED for ${dmgPath} (see output above) — stapler pass=` +
          `${report.staple.pass}, spctl primary-signature pass=${report.spctl.pass}. Refusing to declare this ` +
          `build done: a user downloading this dmg would hit a Gatekeeper warning on first install.`,
      )
    }
    reports.push(report)
  }
  // The update manifest beside the dmg must describe the STAPLED bytes.
  // electron-builder writes latest-mac.yml before afterAllArtifactBuild
  // staples the ticket; the config hook rewrites the entry, and this is the
  // independent check that it did. A stale manifest here fails the build.
  for (const dmgPath of dmgPaths) {
    const manifest = join(dirname(dmgPath), "latest-mac.yml")
    if (!existsSync(manifest)) continue
    // Refresh HERE, not in electron-builder's afterAllArtifactBuild hook.
    // MEASURED 2026-09-01: the hook stapled the dmg and rewrote the entry to
    // 163317821 bytes, then electron-builder wrote latest-mac.yml AFTER the
    // hook returned, from the post-codesign size it had recorded (163315753),
    // clobbering the refresh. The verify below caught it and failed the build,
    // which is what it is for. Only a step that runs after electron-builder
    // has fully exited can be the last writer, and this is that step.
    const refreshed = refreshUpdateManifestEntry(dmgPath)
    if (refreshed?.changed) {
      console.log(
        `\n▸ ${basename(manifest)}: ${refreshed.url} ${refreshed.before.size} -> ${refreshed.after.size} bytes (stapled)`,
      )
    }
    const checked = verifyUpdateManifest(manifest)
    console.log(`\n▸ ${basename(manifest)} matches its artifacts: ${checked.map((c) => c.url).join(", ")}`)
  }

  return reports

}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  assertNoCrossBuild(args.arch)

  console.log(`Packaging Desde for mac/${process.arch}`)

  // ── Payload ────────────────────────────────────────────────────────────
  let payloadDir: string
  if (args.payloadDir) {
    if (!isCompletePayload(args.payloadDir)) {
      throw new Error(
        `--payload-dir ${args.payloadDir} does not look like a complete payload ` +
          `(dist/cli.js and/or payload-manifest.json missing).`,
      )
    }
    payloadDir = args.payloadDir
    console.log(`\n▸ Reusing existing payload at ${payloadDir} (--payload-dir given, not rebuilding)`)
  } else {
    // Arch-namespaced, not overwritten blindly: a stale x64 build must never
    // silently satisfy an arm64 packaging run just because a directory of
    // that NAME already exists — see build-server-package.mts's own
    // cleanDestination for why "empty or a previous run's own manifest" is
    // the bar for safely overwriting, which this delegates to by just
    // reusing that exact script rather than re-implementing its safety
    // checks here.
    payloadDir = join(DESKTOP_ROOT, ".package-payload", `${process.platform}-${process.arch}`)
    console.log(`\n▸ Building a fresh payload at ${payloadDir}`)
    run("npm", ["run", "build:payload", "--", "--out", payloadDir], REPO_ROOT)
  }

  // ── Sign inside the demo archive (--sign only) ─────────────────────────
  // Apple's notary opens the demo's node_modules.tgz and rejects the build
  // for any unsigned Mach-O it finds there, and @electron/osx-sign's walk of
  // the bundle never sees inside a tarball. So those binaries are signed
  // here, in the staged payload, before electron-builder runs — see
  // desktop/scripts/sign-archived-machos.mjs for the measured failure.
  if (args.sign) {
    const archive = join(payloadDir, "demo", "node_modules.tgz")
    if (existsSync(archive)) {
      const identity = findDeveloperIdIdentity()
      console.log(`\n▸ Signing the Mach-O files inside ${archive}\n  identity: ${identity.name}`)
      const signed = await signMachOsInsideArchive(archive, {
        identityHash: identity.hash,
        timestamp: process.env.DESDE_DESKTOP_SIGN_TIMESTAMP,
      })
      for (const rel of signed) console.log(`  signed ${rel}`)
      console.log(`  ${signed.length} Mach-O file(s) signed and repacked`)
    } else {
      console.log(`\n▸ No demo archive at ${archive}; a loose demo tree is signed by osx-sign's own walk`)
    }
  }

  // ── desktop/ shell ─────────────────────────────────────────────────────
  if (!args.skipDesktopBuild) {
    run("npm", ["run", "build:desktop"], REPO_ROOT)
  } else {
    console.log("\n▸ --skip-desktop-build: assuming desktop/dist is current")
  }

  if (!existsSync(join(DESKTOP_ROOT, "node_modules", "electron-builder"))) {
    throw new Error(
      `desktop/node_modules/electron-builder is missing. Run "cd desktop && npm install" first — ` +
        `desktop/ is a separate package (like editor-cli/), root's npm install does not cover it.`,
    )
  }

  // ── electron-builder ───────────────────────────────────────────────────
  run("npm", ["run", "package"], DESKTOP_ROOT, {
    ...process.env,
    DESDE_PAYLOAD_DIR: payloadDir,
    ...(args.sign ? { DESDE_DESKTOP_SIGN: "1" } : {}),
    ...(args.allowStalePayload ? { DESDE_DESKTOP_ALLOW_STALE_PAYLOAD: "1" } : {}),
  })

  // ── Locate + measure the result ────────────────────────────────────────
  const releaseDir = join(DESKTOP_ROOT, "release")
  const appBundles = await findAppBundles(releaseDir)
  if (appBundles.length === 0) {
    throw new Error(`electron-builder reported success but no *.app bundle was found under ${releaseDir}`)
  }
  const appBundle = appBundles[0] // newest — see findAppBundles
  const installers = await findInstallers(releaseDir)

  // ── Signing verification (--sign only) ────────────────────────────────
  // Runs BEFORE the manifest is written — see verifyMacSigningOrThrow's doc
  // comment for why a failure here must stop this script before "DONE".
  const signing = args.sign ? verifyMacSigningOrThrow(appBundle, releaseDir) : null

  const installedSizeBytesDiskUsage = diskUsageBytes(appBundle)
  const installedSizeBytesRawSum = await directoryBytes(appBundle)

  const installerSizes = installers
    .filter((p) => statSync(p).mtimeMs >= statSync(appBundle).mtimeMs - 5 * 60_000) // same build batch
    .map((p) => ({ path: p, bytes: statSync(p).size }))

  // ── DMG notarization verification (--sign only; Job 1) ─────────────────
  // Also runs BEFORE the manifest is written, same reasoning as signing
  // verification above — see verifyDmgNotarizationOrThrow's own doc comment.
  const dmgNotarization = args.sign
    ? verifyDmgNotarizationOrThrow(
        installerSizes.map((i) => i.path),
        releaseDir,
      )
    : null

  const desktopGitCommit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  const payloadManifestPath = join(payloadDir, "payload-manifest.json")
  const payloadManifest = existsSync(payloadManifestPath)
    ? (JSON.parse(readFileSync(payloadManifestPath, "utf8")) as unknown)
    : null

  const manifest: PackageManifest = {
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    desktopGitCommit,
    payloadDir,
    payloadManifest,
    appBundle,
    installedSizeBytesDiskUsage,
    installedSizeBytesRawSum,
    installers: installerSizes,
    signed: args.sign,
    signing,
    dmgNotarization,
    signTimestampOverride: process.env.DESDE_DESKTOP_SIGN_TIMESTAMP ?? null,
  }
  writeFileSync(join(releaseDir, "package-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

  console.log(`\n${"═".repeat(78)}`)
  console.log("DONE")
  console.log("═".repeat(78))
  console.log(`App bundle:      ${appBundle}`)
  console.log(`Installed size:  ${humanBytes(installedSizeBytesDiskUsage)} (disk usage, du -sk)`)
  console.log(`                 ${humanBytes(installedSizeBytesRawSum)} (raw file byte sum)`)
  for (const { path, bytes } of installerSizes) {
    console.log(`Installer:       ${humanBytes(bytes)}  ${path}`)
  }
  if (signing) {
    console.log(
      `Signed:          ${String(signing.pass)} — ${signing.signedCount}/${signing.machOCount} Mach-O(s) ` +
        `signed with team ${signing.teamId}, deep-verify=${String(signing.deepVerify.pass)}, ` +
        `spctl accepted=${String(signing.spctl.accepted)} (expected false pre-notarization)`,
    )
    if (manifest.signTimestampOverride) {
      console.log(
        `                 ⚠ DESDE_DESKTOP_SIGN_TIMESTAMP=${manifest.signTimestampOverride} — secure ` +
          `timestamping was NOT used for this build. Fine for local verification; do not ship this build.`,
      )
    }
  } else {
    console.log("Signed:          false (unsigned build — pass --sign for a signed build)")
  }
  if (dmgNotarization) {
    for (const r of dmgNotarization) {
      console.log(
        `DMG notarized:   ${String(r.pass)} — ${basename(r.dmgPath)} — stapler=${String(r.staple.pass)}, ` +
          `spctl primary-signature=${String(r.spctl.pass)}`,
      )
    }
  }
  console.log(`\nManifest written to ${join(releaseDir, "package-manifest.json")}`)
}

main().catch((err) => {
  console.error(`\nbuild-desktop-app failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

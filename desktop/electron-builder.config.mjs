// electron-builder config — desktop/electron-builder.config.mjs
//
// A .mjs config (not .yml) so it can read DESDE_PAYLOAD_DIR at build
// time: the payload path varies per invocation (which architecture, which
// staging directory) and electron-builder's own env-var interpolation syntax
// (`${env.FOO}`) does not reliably reach `extraResources.from` across
// versions — a plain Node module that reads `process.env` directly has no
// such ambiguity, and fails LOUDLY (a thrown Error, not a silently-empty
// Resources/server) when the caller forgot to set it. The only intended
// caller is `desktop/scripts/package.mjs`, itself only ever invoked by
// `scripts/build-desktop-app.mts`.
//
// Per tasks/electron-app.md §5 Phase 3 task 1 — what each setting below
// encodes:
//
//   - `asar: true` covers ONLY the desktop shell's own compiled JS
//     (dist/main.js, dist/preload.js — fully bundled by esbuild, see
//     scripts/build.mjs). No node_modules ship inside it: `files` below
//     lists nothing else, because esbuild already inlined everything this
//     process needs except `electron` itself, which Electron's own loader
//     resolves regardless of where main.js sits.
//   - `extraResources` places the Phase-1 CLI payload at Resources/server,
//     OUTSIDE the asar — deliberately, not incidentally. It holds a spawned
//     ~198MB `claude` binary and native `.node` modules, none of which can be
//     `exec()`'d or `dlopen()`'d from inside an asar archive
//     (tasks/electron-app.md C3). `payload-resolve.ts` asserts this invariant
//     at runtime rather than trusting this config alone — see its
//     `assertOutsidePackagedAsar`. C3's original estimate (written before
//     Phase 1 measured the true dependency graph) named "esbuild's Go binary
//     and six `.node` modules" — MEASURED at Phase 5 signing time, the actual
//     count on this payload is smaller: exactly 3 Mach-Os total (`claude`,
//     `lightningcss-darwin-arm64`, `@rolldown/binding-darwin-arm64`), zero
//     esbuild. Vite 8 here is rolldown-vite (native Rolldown, not esbuild,
//     as its bundler) and neither fsevents nor `@tailwindcss/oxide` turned
//     out to be runtime deps of the SERVER payload specifically — don't
//     trust either number by hand; `scripts/macho-scan.mjs` derives the
//     live count from whatever payload is actually staged.
//
//     TWO entries, not one — MEASURED, not a style choice.
//     electron-builder's file copier (`app-builder-lib/out/util/filter.js`,
//     `createFilter`) hardcodes `if (relative === "node_modules") return
//     false` — it silently drops any directory literally named
//     `node_modules` sitting at the ROOT of whatever `from` is, for EVERY
//     copy operation (files, extraResources, extraFiles alike), and no
//     `filter` pattern can override it — the check runs before pattern
//     matching, unconditionally. A single `{ from: payloadDir, to: "server"
//     }` entry copied everything EXCEPT node_modules with no error, no
//     warning: the packaged app measured 271MB instead of the ~600MB the
//     payload (337MB) + Electron (~245MB) implies, and the missing 311MB
//     was silent until `Contents/Resources/server/node_modules` was checked
//     by hand. The fix is the second entry below: pointing `from` AT the
//     node_modules directory itself makes ITS contents the copy root, so
//     the exact-match check never fires for anything inside it (a package
//     would have to be literally named `node_modules` to retrigger it,
//     which npm never allows). The first entry's own `!node_modules{,/**/*}`
//     exclusion is redundant with electron-builder's built-in behavior but
//     documents the split on purpose rather than relying on an undocumented
//     upstream quirk to keep doing the right thing silently.
//   - `npmRebuild: false` — this package's own node_modules hold no native
//     dependencies (electron, esbuild, typescript, vitest, electron-builder
//     are all devDependencies, and `files` excludes node_modules from the
//     packaged app entirely), and the payload's own node_modules are already
//     a PREBUILT, platform-matched install (`build-server-package.mts`).
//     Asking electron-builder to rebuild either is wasted work at best, and
//     at worst rebuilds a native module for the WRONG platform.
//   - `mac.target`'s ARCH is deliberately NOT set here — it's chosen by
//     `desktop/scripts/package.mjs` from `process.arch` at invocation time
//     (see that file's doc comment). The payload this config's
//     `extraResources` maps in is native-arch-only, per
//     tasks/electron-app.md's explicit "the payload must be staged natively
//     per architecture" constraint — choosing arch in exactly ONE place is
//     what keeps that constraint from silently drifting out of sync between
//     two configs that both think they own it.
//
// ── Signing (tasks/electron-app.md §5 Phase 5) ──────────────────────────────
//
// Two modes, selected by `DESDE_DESKTOP_SIGN` — an env var, not a CLI
// flag threaded through package.mjs, so the ONE place that decides "is this
// build signed" is this file, not scattered across every caller that could
// build a config:
//
//   UNSET (default) — Phase 3's original unsigned local build, unchanged:
//     `identity: null` forces electron-builder to skip auto-detecting a
//     Developer ID from the local keychain — a dev machine that happens to
//     have one installed must not produce an accidentally-signed-but-not-
//     notarized build just because it exists. `gatekeeperAssess: false`
//     skips a post-build `spctl --assess` check electron-builder otherwise
//     runs, which fails loudly on a deliberately-unsigned build. On Apple
//     Silicon, electron-builder still applies its OWN ad-hoc signature even
//     with `identity: null`, because arm64 Mach-Os cannot execute AT ALL
//     without at least a self-signature — a kernel requirement, not an
//     electron-builder opinion (verified live in Phase 3's gate).
//
//   `DESDE_DESKTOP_SIGN=1` — sign with Mo's REAL Developer ID
//     Application certificate. It is already installed in the login
//     keychain (`security find-identity -v -p codesigning` —
//     "Developer ID Application: maurice chang (JWK4LSZPKZ)") — nothing is
//     imported here. `identity` is left UNSET (not null, not hardcoded):
//     electron-builder auto-discovers a "Developer ID Application" cert from
//     the keychain whenever `identity` isn't null and
//     `CSC_IDENTITY_AUTO_DISCOVERY` isn't explicitly "false" (both true by
//     default — verified by reading app-builder-lib's own
//     util/flags.js + mac/MacTargetHelper.js). `mac.notarize` is no longer
//     hardcoded `false` here (that was true through Phase 5a, when
//     notarization credentials genuinely didn't exist yet) — see the
//     "── Notarization ──" section below for how it's decided now that they
//     do.
//
//     `mac.binaries` is DERIVED, not hand-written, via
//     `scripts/macho-scan.mjs`'s `findMachOFiles` walking the STAGED PAYLOAD
//     DIRECTORY (the packaged .app doesn't exist yet at config-eval time,
//     but the payload dir's tree lands verbatim under Resources/server — see
//     the extraResources doc comment above — so a relative path found here
//     maps 1:1 onto Contents/Resources/server/<path> in the built app).
//     MEASURED, and worth stating plainly: @electron/osx-sign's own signApp
//     step already walks the WHOLE Contents/ tree (which Resources/server
//     sits inside) and (re-)signs every binary file it finds there
//     regardless of this list (traced through app-builder-lib's
//     MacTargetHelper.buildSignOptions + @electron/osx-sign's walkAsync,
//     both in node_modules) — so `mac.binaries` is belt-and-suspenders here,
//     not load-bearing. It stays because the Phase 5 brief asks for it
//     explicitly and because it costs nothing: worst case a binary gets
//     signed twice in the same pass, which is a no-op the second time.
//     `scripts/verify-mac-signing.mjs` — run against the actual built .app,
//     after packaging — is the check that actually proves coverage.
//
//     `DESDE_DESKTOP_SIGN_TIMESTAMP` — an ESCAPE HATCH, not part of the
//     normal signing story. @electron/osx-sign appends `--timestamp` (a
//     request for Apple's secure timestamp authority, over the network) to
//     EVERY SINGLE per-file `codesign` invocation UNCONDITIONALLY — traced in
//     @electron/osx-sign's sign.js: there is no code path that omits it, only
//     one that swaps in `--timestamp=<url>` when `mac.timestamp` is set.
//     MEASURED in a sandboxed build environment with no route to Apple's
//     timestamp server (`curl -m 5 https://timestamp.apple.com/ts01` → exit 7,
//     "Failed to connect"): the whole build hangs, stuck re-trying the SAME
//     file for 5+ minutes with ~1000+ binary-classified files still to go —
//     not merely slow, genuinely stuck. Setting this env var to `none` sets
//     `mac.timestamp = "none"`, which codesign recognizes as "explicitly skip
//     timestamping" (`--timestamp=none`) rather than "use the default
//     server" — the only way to make @electron/osx-sign emit that flag at
//     all. Leave this UNSET on a real machine with normal network access: a
//     production signed build wants the secure timestamp (it is what keeps
//     the signature valid after the certificate itself expires), and
//     `--timestamp=none` should never be the default for a build meant to
//     ship. This override exists for exactly one situation — proving the
//     signing pipeline works from an environment that cannot reach Apple's
//     timestamp infrastructure — and its use should be called out explicitly
//     wherever a build's provenance is recorded.
//
// ── Notarization (tasks/electron-app.md §5 Phase 5b) ────────────────────────
//
// Only ever computed inside the `if (signBuild)` branch below — never for an
// unsigned build. That isn't merely convention: `mac.identity = null` in the
// unsigned branch already makes electron-builder's own `sign()` return
// before it ever reaches notarization (MEASURED by reading
// `app-builder-lib`'s `macPackager.js`: `sign()` checks `qualifier === null`
// and calls `handleNullIdentity()` FIRST, several lines before the call to
// `notarizeIfProvided()`) — so notarization was already impossible for an
// unsigned build even before this section existed. Keeping the credential
// resolution scoped to `if (signBuild)` anyway makes that ordering explicit
// in THIS file, not just true as a side effect of electron-builder's
// internals — a `--sign`-less build never even evaluates this code.
//
// Two small modules do the real work, both independently unit-tested
// (`desktop/__tests__/signing-env.test.ts`, `notarize-config.test.ts`):
//
//   - `signing-env.mjs`'s `loadSigningEnv` finds and parses
//     `.env.signing.local` — see that file's own doc comment for the full
//     search order (short version: an explicit `DESDE_SIGNING_ENV`
//     override, else the MAIN checkout's root via `git rev-parse
//     --git-common-dir` — the mechanism that lets a git-worktree checkout
//     find the same file the main checkout would — falling back to this
//     checkout's own repo root ONLY when git resolution itself is
//     unavailable, never as a second candidate alongside a resolvable main
//     checkout — see F1 in tasks/electron-app.md §5 Phase 5b for why the
//     order matters: the other way around lets a worktree's own file
//     silently shadow the durable main-checkout one). Returns `{}`, never
//     throws, when no file is found anywhere — that's the ordinary "no
//     credentials configured" case.
//   - `notarize-config.mjs`'s `resolveNotarizeCredentials` decides whether
//     to notarize from whatever's in `process.env` after the merge below: a
//     COMPLETE credential set (API-key: `APPLE_API_KEY` + `APPLE_API_KEY_ID`
//     + `APPLE_API_ISSUER` + `APPLE_TEAM_ID`, or Apple-ID: `APPLE_ID` +
//     `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`) enables it; a
//     TOUCHED-BUT-INCOMPLETE set of EITHER shape THROWS naming exactly
//     what's missing (never a silent fall-back to unnotarized — that would
//     produce a build that looks fine and fails on the user's machine); an
//     EMPTY set disables it with no error, matching today's
//     `notarize: false` default. Apple-ID is checked FIRST, unconditionally
//     — matching electron-builder's OWN precedence exactly (see
//     notarize-config.mjs's doc comment for F2: checking API-key first, as
//     an earlier version of this file did, could return `shape: "api-key"`
//     while electron-builder's real run would actually sign with Apple-ID
//     credentials, making this module's own log line below false). These
//     are the SAME env var names electron-builder's own notarization
//     integration reads directly from `process.env` at packaging time (see
//     notarize-config.mjs's doc comment for the exact source read) —
//     merging the loaded file's values into `process.env`, rather than
//     passing them through `mac.notarize` as an object, is what lets
//     electron-builder's own later signing step see them with no
//     translation layer to keep in sync (this installed electron-builder
//     version's `notarize` option is `boolean` ONLY — verified against
//     `app-builder-lib/out/options/macOptions.d.ts`, an object form isn't
//     supported here).
//
// The merge is ADDITIVE ONLY: `process.env[key]` is set from the loaded file
// ONLY when that key isn't already present, so a real CI-exported secret
// (Phase 5's later GitHub Actions task) always wins over a stray local file,
// and a machine with credentials already exported directly (no file at all)
// still works unchanged.
//
// Nothing here ever logs a credential VALUE — see notarize-config.mjs's own
// doc comment for the one deliberate exception-that-isn't (the
// `APPLE_API_KEY` existence check omits even the path, since a `.p8`'s
// conventional filename can itself encode the key ID).
//
// ── DMG notarization (Job 1 fix, 2026-08-13) ────────────────────────────────
//
// MEASURED against a real signed+notarized build: the `.app` passes every
// Gatekeeper check (`spctl --assess --type execute` → "accepted, source=
// Notarized Developer ID"), but the DMG CONTAINER ITSELF does not —
// `xcrun stapler validate` reports no ticket stapled, and
// `spctl -a -t open --context context:primary-signature` (the exact check a
// browser-downloaded disk image gets) is REJECTED with "no usable
// signature". Gatekeeper evaluates a disk image's own primary signature and
// ticket separately from whatever's notarized inside it — see
// `scripts/notarize-dmg.mjs`'s own doc comment for the full trace through
// electron-builder's source proving this is a genuine gap (its built-in
// notarization integration runs on the `.app` BEFORE the dmg is ever built,
// so it structurally never sees the dmg) and why the fix is NOT simply
// flipping `dmg.sign: true` on its own (electron-builder's own doc comment
// on that option warns it "will lead to unwanted errors in combination with
// notarization requirements" — true when signing isn't paired with
// notarizing, which is exactly what a bare flag flip would do).
//
// The fix is two pieces, both gated on `signBuild` (never for an unsigned
// build) and both required together:
//
//   1. `dmg.sign = true` below — reuses electron-builder's OWN dmg-signing
//      step (dmg-builder's `DmgTarget.signDmg`), which auto-discovers the
//      SAME Developer ID identity from the SAME login keychain already
//      proven (this session) to sign the `.app` without hanging. Signing
//      the dmg is not strictly required by Apple's notary service (Apple
//      DTS staff: "the notary service does not require that your disk
//      image be signed" — Developer Forums thread 675354) but IS what real-
//      world testing found necessary for `context:primary-signature`
//      specifically to pass reliably; see notarize-dmg.mjs for the full
//      citation.
//   2. `notarizeDmg()`, called from `afterAllArtifactBuild` below — submits
//      the (now-signed) dmg to Apple's notary service and staples the
//      ticket, using `@electron/notarize` directly (the same library
//      electron-builder itself uses for the `.app`). This is the piece
//      electron-builder has no built-in equivalent for.
//
// Gated on `mac.notarize === true` (not merely `signBuild`) — if no
// notarization credentials are configured, the `.app` itself already ships
// unnotarized (existing, documented Phase 5a state); leaving the dmg
// unnotarized too in that case is consistent, not a new gap.
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generateThirdPartyNotices } from "./scripts/generate-notices.mjs"
import { findMachOFiles } from "./scripts/macho-scan.mjs"
import { resolveNotarizeCredentials } from "./scripts/notarize-config.mjs"
import { notarizeDmg } from "./scripts/notarize-dmg.mjs"
import { loadSigningEnv } from "./scripts/signing-env.mjs"

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(desktopRoot, "..")

const payloadDir = process.env.DESDE_PAYLOAD_DIR
if (!payloadDir) {
  throw new Error(
    "DESDE_PAYLOAD_DIR must be set to an absolute path to a built CLI payload " +
      "(see scripts/build-desktop-app.mts, the intended entry point — it builds one and " +
      "sets this automatically). Refusing to guess: shipping the wrong payload, or an empty " +
      "Resources/server, is a much worse failure than refusing to build at all.",
  )
}
if (!isAbsolute(payloadDir)) {
  throw new Error(`DESDE_PAYLOAD_DIR must be an absolute path, got: ${JSON.stringify(payloadDir)}`)
}

// ── Licensing + third-party attribution (AGPL-3.0 relicensing) ─────────────
//
// A read-only audit of the packaged .app (see the licensing report this
// commit's task produced) found three attribution gaps, all fixed here:
//
//   1. Electron ships its own `LICENSE` (Electron/Chromium/Node/V8 summary)
//      and `LICENSES.chromium.html` (Chromium's full third-party page,
//      ~12MB) as siblings of `Electron.app` inside the `electron` npm
//      package's own `dist/` — but electron-builder does NOT carry them into
//      a packaged app by default, and nothing in this config asked it to.
//      We ship Chromium, Node, V8, and ffmpeg with zero attribution. Fixed
//      below by adding both files as `extraResources`, resolved via
//      `require.resolve` against the ACTUALLY INSTALLED `electron`
//      devDependency (whatever version that is) rather than a hand-copied
//      path — this is what "fix it at the config level, not by hand-copying
//      into one build" means.
//   2. Every individual npm package's own LICENSE file already ships inside
//      the app (node_modules ships, both under Resources/server and inside
//      app.asar) — scattered across ~174 packages, with no single rolled-up
//      document. `generateThirdPartyNotices` (scripts/generate-notices.mjs)
//      produces exactly that: one file naming every third-party production
//      dependency actually distributed (the CLI payload's deps AND this
//      package's own asar deps), full license text included, Apache-2.0
//      NOTICE files and MPL-2.0 (lightningcss) text preserved automatically,
//      and the two non-open-source @anthropic-ai/claude-agent-sdk* packages
//      called out honestly rather than silently folded in as if they were
//      ordinary OSS.
//   3. Desde's own AGPL-3.0 LICENSE never shipped INSIDE the app bundle
//      itself — only in the source repo. Added below too.
//
// `noticesEnabled` gates ONLY the license-checker scan, not the Electron/
// root-LICENSE resolution: `desktop/__tests__/product-name.test.ts` imports
// this config with `DESDE_PAYLOAD_DIR` pointed at a placeholder path
// that is deliberately never touched on disk (see that test's own doc
// comment) — scanning it with license-checker would throw ENOENT on a
// harmless import-only test run. The Electron dist LICENSE files and the
// repo's own root LICENSE have nothing to do with the payload and resolve
// unconditionally; only the payload-dependent scan needs the guard, mirrored
// on a REAL packaging run (`package.mjs` already validates `payloadDir`
// exists before ever importing this config) where it is always true.
const noticesEnabled = existsSync(payloadDir)

const require = createRequire(import.meta.url)
const electronDistDir = dirname(require.resolve("electron/package.json"))
const electronLicensePath = join(electronDistDir, "dist", "LICENSE")
const electronChromiumLicensesPath = join(electronDistDir, "dist", "LICENSES.chromium.html")
if (!existsSync(electronLicensePath) || !existsSync(electronChromiumLicensesPath)) {
  throw new Error(
    `Electron's own LICENSE/LICENSES.chromium.html not found under ${join(electronDistDir, "dist")} — ` +
      "is the `electron` devDependency actually installed? Run `npm install` in desktop/.",
  )
}
const repoLicensePath = join(repoRoot, "LICENSE")
if (!existsSync(repoLicensePath)) {
  throw new Error(`Repo root LICENSE not found at ${repoLicensePath} — refusing to package without it.`)
}

const noticesPath = join(desktopRoot, "build", "THIRD-PARTY-NOTICES.txt")
if (noticesEnabled) {
  await writeFile(noticesPath, await generateThirdPartyNotices({ payloadDir, desktopRoot }), "utf8")
  console.log(`[electron-builder.config] wrote third-party notices → ${noticesPath}`)
} else {
  console.log(
    "[electron-builder.config] skipping third-party notices generation — payload dir does not exist " +
      "(this is an import-only test run, not a real package build)",
  )
}

const signBuild = process.env.DESDE_DESKTOP_SIGN === "1"

/** @type {import('electron-builder').Configuration['mac']} */
const mac = {
  category: "public.app-category.developer-tools",
  // Version-less artifact names, so GitHub's permanent "latest asset" URL
  // (`/releases/latest/download/Desde-arm64.dmg`) resolves for every release
  // rather than only the one it was written against. The default
  // `${productName}-${version}-${arch}.${ext}` put the version in the
  // filename, and the site's download link went stale the day 0.1.1 shipped
  // after 0.1.0: it pointed at a file the new release did not contain.
  //
  // Mo, 2026-09-02: "the download for macos ... should just download the
  // latest dmg. No need to have users trying to figure out what to download."
  //
  // The version is not lost: it is in the release tag, in `latest-mac.yml`,
  // and in the app's own Info.plist. electron-updater reads the filename out
  // of `latest-mac.yml` per release, so a stable name is fine for updates —
  // each release's assets are its own on GitHub.
  artifactName: "${productName}-${arch}.${ext}",
  // The app icon. Set EXPLICITLY even though electron-builder would find
  // `build/icon.icns` on its own, because implicit discovery is exactly how
  // this was missing in the first place: with no icon anywhere in the repo,
  // every packaging run printed
  //
  //   • default Electron icon is used  reason=application icon is not set
  //
  // and every run's gates passed anyway. An icon is invisible to a signature
  // check, a staple check and a Gatekeeper check, so the log line was the only
  // report and nobody read it. Named here so a future reader sees a path that
  // must exist rather than an absence that means "look elsewhere".
  //
  // Regenerate from the brand with `desktop/scripts/make-icon.py`; see
  // `desktop/build/ICON.md` for the geometry and why it is what it is.
  icon: "build/icon.icns",
  // Runs regardless of signBuild: our OWN internal check (verify-mac-signing.mjs,
  // run explicitly by build-desktop-app.mts after packaging) is what gates a
  // signed build — electron-builder's built-in spctl check would abort the
  // BUILD ITSELF on the unnotarized-rejection that Phase 5's brief says is
  // expected and should be recorded, not treated as a build failure.
  gatekeeperAssess: false,
}

if (signBuild) {
  mac.hardenedRuntime = true
  mac.entitlements = "build/entitlements.mac.plist"
  mac.entitlementsInherit = "build/entitlements.mac.inherit.plist"
  if (process.env.DESDE_DESKTOP_SIGN_TIMESTAMP) {
    mac.timestamp = process.env.DESDE_DESKTOP_SIGN_TIMESTAMP
  }
  const machoRelPaths = await findMachOFiles(payloadDir)
  mac.binaries = machoRelPaths.map((p) => join("Contents", "Resources", "server", p))

  // See the "── Notarization ──" section above for the full design. Additive
  // merge into process.env: a real CI-exported secret always wins over a
  // value loaded from a file.
  const signingEnv = loadSigningEnv()
  for (const [key, value] of Object.entries(signingEnv)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
  const notarizeResolution = resolveNotarizeCredentials(process.env)
  mac.notarize = notarizeResolution.notarize
  if (notarizeResolution.notarize) {
    console.log(
      `[electron-builder.config] notarization ENABLED — ${notarizeResolution.shape} credentials found`,
    )
  } else {
    console.log(`[electron-builder.config] notarization DISABLED — ${notarizeResolution.skipReason}`)
  }
} else {
  mac.identity = null
  // A dedicated line, even though `mac.notarize` is never touched on this
  // branch (see the "── Notarization ──" section above — notarizing an
  // unsigned build is impossible, not merely undesired, so there is no
  // credential logic to run here at all). Printed anyway so "why didn't
  // this build notarize" always has an answer in the log, on EVERY build,
  // not only the ones that got far enough to load credentials.
  console.log("[electron-builder.config] notarization DISABLED — build is unsigned (pass --sign to sign, a prerequisite for notarization)")
}

// See the "── DMG notarization (Job 1 fix) ──" section above for the full
// design. `dmg` stays `undefined` (electron-builder's own default — dmg.sign
// defaults to false) on an unsigned build; only the signed branch turns it
// on, and only ever paired with the afterAllArtifactBuild notarize+staple
// call below.
/** @type {import('electron-builder').Configuration['dmg']} */
const dmg = signBuild ? { sign: true } : undefined

/** @type {import('electron-builder').Configuration} */
const config = {
  // Renamed 2026-08-13, tasks/electron-app.md §5 Phase 5b, Part 1 ("the
  // product is now named Desde"). `appId` is the one field worth calling
  // out: it's the macOS bundle identifier, and changing it AFTER a real
  // release ships breaks that release's ability to recognise its own
  // updates — cheap now, expensive later, so it moved in this same commit
  // as `productName` rather than being deferred. `productName` drives the
  // `.app` bundle name, Info.plist `CFBundleName`/`CFBundleExecutable`, and
  // the dmg/zip artifact filenames (MEASURED against a real packaged build
  // — see product-name.ts's doc comment). Kept in sync BY HAND with
  // `product-name.ts`'s `PRODUCT_NAME` (the desktop shell's own dialog/
  // window-title strings) — `desktop/__tests__/product-name.test.ts`
  // asserts the two agree; see that file's own doc comment for why this
  // literal can't just import the other one.
  appId: "com.desde.editor",
  productName: "Desde",
  // AGPL-3.0 relicensing: written into the Windows `LegalCopyright`
  // version-info field and, on macOS, the `NSHumanReadableCopyright`
  // Info.plist key that the native About panel reads (see `main.ts`'s
  // `app.setAboutPanelOptions` call, which sets the same string at runtime —
  // kept in sync BY HAND, same tradeoff as `productName`/`PRODUCT_NAME`
  // above; `desktop/__tests__/copyright.test.ts` asserts the two agree).
  copyright: "Copyright © 2026 Mo Chang",
  // The update feed. Phase 5, decided 2026-09-01.
  //
  // A SEPARATE public repo holding only installers, never the source. An
  // `electron-updater` GitHub provider reading a PRIVATE repo needs a token
  // embedded in every shipped build, which is a leak by design; a public
  // releases-only repo keeps the source private without that.
  //
  // Named for the EDITOR, not `desde-releases`, so a future
  // `desde-viewer-releases` can sit beside it (Mo). That had to be settled
  // BEFORE the first release rather than after: `electron-builder` compiles
  // this into each build's `Resources/app-update.yml`, so every binary
  // already in the world polls whatever name was chosen here, permanently.
  // GitHub does redirect a renamed repo, but that is a safety net for humans
  // following an old link, not something to leave load-bearing under update
  // infrastructure for years.
  //
  // Setting this also flips `publishConfigured` to true in the packaged
  // stamp (see `stampUpdateFeedStatus` below), which is what stands
  // `update-feed-guard.ts` down: from here on a failed update check is a real
  // failure worth surfacing, not the "no feed configured" case it was
  // deliberately staying quiet about.
  publish: [
    {
      provider: "github",
      owner: "desde-design",
      repo: "desde-editor-releases",
    },
  ],
  directories: {
    output: "release",
  },
  // Only our own compiled output — see the module doc comment for why
  // node_modules never needs to appear here at all.
  files: ["dist/**/*", "package.json"],
  asar: true,
  npmRebuild: false,
  extraResources: [
    // Everything except node_modules — see the module doc comment above for
    // why node_modules is split into its own entry.
    { from: payloadDir, to: "server", filter: ["**/*", "!node_modules{,/**/*}"] },
    // node_modules on its own, `from` pointed AT the directory itself so its
    // contents (not "node_modules" as a name) are the copy root.
    { from: join(payloadDir, "node_modules"), to: "server/node_modules", filter: ["**/*"] },
    // ── Licensing + third-party attribution — see the "── Licensing ──"
    // section above for the full design. Named to avoid any collision: our
    // own AGPL LICENSE keeps its plain name; Electron's summary license is
    // renamed (its own filename, unqualified "LICENSE", would otherwise
    // collide with ours) but its Chromium attribution page keeps ITS
    // upstream name since that's the file users/tools will search for.
    { from: repoLicensePath, to: "LICENSE" },
    { from: electronLicensePath, to: "ELECTRON-LICENSE.txt" },
    { from: electronChromiumLicensesPath, to: "LICENSES.chromium.html" },
    // Only when actually generated this eval — see `noticesEnabled`'s doc
    // comment above for why an import-only test run skips this.
    ...(noticesEnabled ? [{ from: noticesPath, to: "THIRD-PARTY-NOTICES.txt" }] : []),
  ],
  mac,
  dmg,
  afterPack: stampUpdateFeedStatus,
  afterAllArtifactBuild: notarizeDmgArtifacts,
}

// ── Update-feed status stamp (F1, whole-branch review, P1 fix) ─────────────
//
// `desktop/update-feed-guard.ts` (runtime) decides whether to skip a real
// update check by reading THIS stamp, not by checking whether
// `app-update.yml` happens to exist — see that module's doc comment for why
// file-existence can't tell "Phase 0, intentionally unconfigured" apart from
// "Phase 5, configured but the feed broke", and both need OPPOSITE answers.
//
// `publishConfigured` is read straight off `config.publish` — whatever a
// future Phase 5 sets it to — never re-derived a second way, so this stamp
// tracks that field automatically with nothing to remember to update.
//
// `afterPack` is electron-builder's own hook for adding files to a packed
// app: it runs AFTER Contents/Resources is assembled but BEFORE dmg/zip
// packaging, and — unlike a step bolted onto `package.mjs` afterward — it
// runs no matter how packaging was invoked (directly via `npm run package`,
// or via `scripts/build-desktop-app.mts`), so there is no second call
// site that could forget to stamp it.
const UPDATE_FEED_STATUS_FILENAME = "update-feed-status.json"

/** @param {import('electron-builder').AfterPackContext} context */
async function stampUpdateFeedStatus(context) {
  // Mac-only for now — Windows/Linux targets aren't built by this project
  // yet (see package.mjs's own arch gate); their Resources layout differs
  // and needs its own path when a phase adds them.
  if (context.electronPlatformName !== "darwin") return
  const appBundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const status = {
    publishConfigured: Boolean(config.publish),
    packagedAt: new Date().toISOString(),
  }
  await writeFile(
    join(appBundle, "Contents", "Resources", UPDATE_FEED_STATUS_FILENAME),
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8",
  )
}

// ── DMG notarize+staple (Job 1 fix) ─────────────────────────────────────────
//
// `afterAllArtifactBuild` runs once, after EVERY target for this build (dmg
// AND zip) has finished — which matters here because dmg-builder's own
// `dmg.sign` codesigning (set above, signed builds only) happens INSIDE the
// dmg target's own `build()`, so by the time this hook runs the dmg is
// already signed and this only ever needs to submit+staple it. Scoped to
// `.dmg` paths specifically: the zip's contained `.app` is already notarized
// and stapled by electron-builder's own `.app`-level integration (see the
// "── DMG notarization ──" comment above), and the zip container itself was
// never the artifact Job 1 was about — Squirrel.Mac (the auto-updater)
// evaluates the `.app` inside it, not the zip file's own signature.
//
// Gated on `mac.notarize === true`, not merely `signBuild`: if no
// notarization credentials were configured, the `.app` itself already
// shipped unnotarized (the existing, documented Phase 5a state) — leaving
// the dmg unnotarized too in that case is consistent, not a new gap.
//
/** @param {import('electron-builder').BuildResult} buildResult */
async function notarizeDmgArtifacts(buildResult) {
  if (!signBuild || mac.notarize !== true) return buildResult.artifactPaths
  const dmgPaths = buildResult.artifactPaths.filter((p) => p.endsWith(".dmg"))
  for (const dmgPath of dmgPaths) {
    await notarizeDmg(dmgPath, process.env)
    // Do NOT refresh latest-mac.yml here. MEASURED 2026-09-01: electron-builder
    // writes that file AFTER this hook returns, from the post-codesign size it
    // recorded before stapling, so a refresh from inside the hook is silently
    // overwritten. scripts/build-desktop-app.mts refreshes and verifies it
    // once electron-builder has fully exited, which is the only place a last
    // write can be guaranteed.
  }
  return buildResult.artifactPaths
}

export default config

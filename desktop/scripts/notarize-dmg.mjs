#!/usr/bin/env node
// DMG notarization — Job 1 fix, tasks/electron-app.md §5 Phase 5c.
//
// ── The gap this closes ──────────────────────────────────────────────────
//
// MEASURED (2026-08-13, against a real signed+notarized build):
// `xcrun stapler validate <dmg>` reports "does not have a ticket stapled to
// it", and `spctl -a -t open --context context:primary-signature -v <dmg>`
// is REJECTED with "source=no usable signature" — even though the .app
// INSIDE the dmg is fully signed, notarized, and stapled (`spctl --assess
// --type execute` on the .app: "accepted, source=Notarized Developer ID").
//
// The reason: Gatekeeper's disk-image check evaluates the DMG FILE'S OWN
// primary signature/ticket, entirely separately from whatever's notarized
// inside it. Tracing electron-builder's own code confirms this isn't a
// config oversight — it's a genuine gap in what electron-builder does for
// you: `macPackager.sign()` calls `MacTargetHelper.notarizeIfProvided(appPath)`
// (app-builder-lib/out/macPackager.js:318) on the `.app` DURING `doPack()`,
// which runs BEFORE `packageInDistributableFormat()` ever builds the dmg
// (dmg-builder/out/dmg.js's `DmgTarget.build()`) — so by construction,
// electron-builder's built-in notarization integration never sees the dmg
// at all. Nothing "forgot" to wire this; there's no hook that would.
//
// ── Why not just `dmg.sign: true`? ───────────────────────────────────────
//
// That flag (consumed by dmg-builder's own `DmgTarget.signDmg`) runs a bare
// `codesign --sign <identity> <dmg>` — it does not submit the dmg for
// notarization and does not staple a ticket. A signed-but-never-notarized
// dmg is a WORSE Gatekeeper outcome than an unsigned one (Gatekeeper treats
// "signed, but Apple can't vouch for it" as more suspicious than "no
// signature at all") — which is exactly the "unwanted errors" electron-
// builder's own doc comment on `dmg.sign` warns about
// (app-builder-lib/out/options/macOptions.d.ts: "Signing is not required and
// will lead to unwanted errors in combination with notarization
// requirements. @default false"). Flipping that flag alone would reproduce
// the documented failure mode, not fix it.
//
// electron-builder.config.mjs DOES still set `dmg.sign = true` when
// `signBuild` — but only ever paired with the notarize+staple call this
// module performs immediately after, in the SAME build's
// `afterAllArtifactBuild` hook. Signing the dmg is not strictly required by
// Apple's notary service or by Gatekeeper (see below), but real-world
// testing (electron-userland/electron-builder#7424; Apple Developer Forums
// thread 675354) found `spctl -a -t open --context context:primary-
// signature` — the exact check Job 1 must pass — reliably passes only once
// the dmg itself carries BOTH a signature and a stapled ticket; a stapled-
// but-unsigned dmg was not confirmed to satisfy that specific context by
// any Apple engineer in that thread. Given the choice between "confirmed to
// work" and "plausible but unconfirmed for this exact command," this module
// does the confirmed thing.
//
// ── What Apple's notary service actually requires of a DMG ──────────────
//
// Signing the dmg is NOT a prerequisite for notarizing it. Apple DTS
// engineer Quinn "The Eskimo!" on the Apple Developer Forums (thread
// 675354): "The notary service does not require that your disk image be
// signed... It isn't necessary to sign disk images. As I mentioned above,
// the notary service will accept an unsigned disk image and the resulting
// ticket will then cover just the disk image's content" — but adds "I do
// recommend that you sign your disk image" anyway, because a signed dmg's
// ticket additionally covers the image itself, not just its content. This
// matches `@electron/notarize`'s own implementation: `checkSignatures()`
// (lib/check-signature.js) explicitly SKIPS the `codesign --verify`
// precondition for `.dmg`/`.pkg` paths ("skipping codesign check for dmg or
// pkg file") — the same library electron-builder itself uses for the `.app`
// works unmodified on an unsigned dmg.
//
// ── Implementation ────────────────────────────────────────────────────────
//
// Reuses `@electron/notarize` directly — already an installed dependency of
// electron-builder (it's what `notarizeIfProvided` calls for the `.app`),
// and its notarytool path (lib/notarytool.js) already special-cases
// `.dmg`/`.pkg` extensions to upload the file directly (no zipping) and its
// `stapleApp()` (lib/staple.js) is just `xcrun stapler staple`, which works
// on a dmg exactly as it does on a `.app`. No separate `notarytool`/
// `stapler` shell-out to write or maintain — one call does submit-wait-
// staple, identically to how the `.app` itself is already notarized.
//
// `buildNotarizeCredentials` mirrors `MacTargetHelper.getNotarizeOptions`
// (app-builder-lib/out/mac/MacTargetHelper.js) EXACTLY — same env var names,
// same Apple-ID-checked-first precedence (see notarize-config.mjs's own "F2"
// doc comment for why the order matters) — so this can never disagree with
// electron-builder about which credentials/account notarized the build. It
// is deliberately a SEPARATE small function rather than importing
// `resolveNotarizeCredentials` from notarize-config.mjs: that module decides
// the yes/no boolean and never touches credential VALUES (by design — see
// its own doc comment); this module runs only after that decision was
// already "yes" and needs the actual values to hand to `@electron/notarize`.
//
// No credential VALUE is ever logged here — only the dmg path and pass/fail.
import { notarize as electronNotarize } from "@electron/notarize"

/**
 * Builds the credentials object `@electron/notarize` expects, from `env`
 * (normally `process.env`, after electron-builder.config.mjs has merged in
 * `.env.signing.local`). Returns `null` when neither credential shape is
 * fully present — callers should only reach this after
 * `resolveNotarizeCredentials` (notarize-config.mjs) already decided
 * `notarize: true`, so a `null` here would mean the two decisions
 * disagreed, which is itself a bug worth surfacing loudly rather than
 * silently skipping notarization.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ appleId: string, appleIdPassword: string, teamId: string } | { appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string } | null}
 */
export function buildNotarizeCredentials(env) {
  // Apple-ID first, unconditionally — matches MacTargetHelper.getNotarizeOptions
  // and notarize-config.mjs's own resolveNotarizeCredentials precedence.
  const appleId = env.APPLE_ID
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = env.APPLE_TEAM_ID
  if (appleId || appleIdPassword) {
    if (!appleId || !appleIdPassword || !teamId) return null
    return { appleId, appleIdPassword, teamId }
  }
  const appleApiKey = env.APPLE_API_KEY
  const appleApiKeyId = env.APPLE_API_KEY_ID
  const appleApiIssuer = env.APPLE_API_ISSUER
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) return null
    return { appleApiKey, appleApiKeyId, appleApiIssuer }
  }
  return null
}

/**
 * Submits `dmgPath` to Apple's notary service and staples the resulting
 * ticket onto it — waits for completion (can take several minutes; this is
 * expected, not a hang). `notarizeFn` is injectable purely for testing (so
 * the test suite never makes a real network call or touches real
 * credentials) — production callers should never pass it.
 *
 * @param {string} dmgPath
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {typeof electronNotarize} [notarizeFn]
 */
export async function notarizeDmg(dmgPath, env, notarizeFn = electronNotarize) {
  const credentials = buildNotarizeCredentials(env)
  if (!credentials) {
    throw new Error(
      `notarizeDmg: no complete Apple notarization credentials found in process.env for ${dmgPath}. ` +
        "This should be unreachable — electron-builder.config.mjs only calls this after " +
        "resolveNotarizeCredentials (notarize-config.mjs) already decided notarize:true from the SAME env.",
    )
  }
  console.log(`[notarize-dmg] submitting ${dmgPath} to Apple notarization (this can take several minutes)…`)
  await notarizeFn({ appPath: dmgPath, ...credentials })
  console.log(`[notarize-dmg] ${dmgPath} notarized and stapled`)
}

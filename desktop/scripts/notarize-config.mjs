#!/usr/bin/env node
// Decides whether a signed build should notarize, from whatever Apple
// credentials are present in `process.env` — extracted into its own pure(-ish)
// function so the decision is unit-testable independent of electron-builder
// itself (see desktop/__tests__/notarize-config.test.ts). tasks/electron-app.md
// §5 Phase 5b, Part 2.
//
// ── The two supported credential shapes ─────────────────────────────────────
//
// These are the SAME env var names electron-builder's own notarization
// integration reads directly from `process.env` at packaging time (MEASURED
// by reading `app-builder-lib/out/mac/MacTargetHelper.js`'s
// `getNotarizeOptions` in this exact installed version) — using the same
// names means credentials resolved here (see signing-env.mjs) can be handed
// to electron-builder as plain `process.env` entries with no translation:
//
//   - API key:  APPLE_API_KEY (path to a .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_TEAM_ID
//   - Apple ID: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//
// A PARTIAL set (some but not all of one shape's variables) is a hard error
// naming exactly what's missing — never a silent fall-back to unnotarized,
// which would produce a build that looks fine and fails on the user's
// machine.
//
// ── Precedence: Apple-ID-first, matching electron-builder EXACTLY (F2) ──────
//
// `getNotarizeOptions` checks `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` FIRST —
// if EITHER is present at all, it commits to the Apple-ID shape and either
// returns those credentials or throws on an incomplete pair, WITHOUT EVER
// looking at the API-key variables, even if they form a perfectly complete
// set. This module used to check completeness in the other order (API-key
// first, on the reasoning that Apple recommends it for security) — that was
// wrong in a way that mattered: it let a complete API-key set silently mask
// a stray incomplete Apple-ID set (returning `{ shape: "api-key" }` with no
// validation of the Apple-ID leftovers at all), and — worse — when BOTH
// shapes were complete, it reported `shape: "api-key"` while
// electron-builder's own precedence would actually have used the Apple-ID
// credentials to sign, so this module's own log line LIED about which
// account produced the release. Checking Apple-ID first, unconditionally,
// closes both: a touched-but-incomplete Apple-ID set is validated (and
// refused) before API-key is ever consulted, and a simultaneously-complete
// API-key set can never disagree with electron-builder about which
// credentials actually get used, because we now decide it exactly the way
// electron-builder does.
//
// ── Credential handling ──────────────────────────────────────────────────
//
// This module NEVER reads, logs, or includes any credential VALUE in an
// error message or return value — only variable NAMES (safe: "is this set"
// is not "what is it set to") and the classification label ("api-key" /
// "apple-id"). The one filesystem check here (APPLE_API_KEY must point at a
// READABLE REGULAR FILE — not merely a path that exists, see F3: a directory
// or a permission-denied file both pass a bare existence check and would
// otherwise let a build spend several minutes staging, packaging, and
// signing before `notarytool` finally rejects the path) never reads the
// file's CONTENTS, and its own error message deliberately omits the path
// itself (a `.p8` downloaded from Apple is conventionally named
// `AuthKey_<KEY_ID>.p8`, so even the PATH can leak the key ID — treated as
// sensitive here rather than assumed safe).

import { accessSync, constants as fsConstants, statSync } from "node:fs"

export const API_KEY_VARS = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]
export const APPLE_ID_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]

// The variables that are UNIQUE to each shape (excludes the shared
// APPLE_TEAM_ID) — used only to decide whether a shape has been "touched" at
// all. A lone APPLE_TEAM_ID with nothing else set touches NEITHER shape,
// matching electron-builder's own `appleId || appleIdPassword` /
// `appleApiKey || appleApiKeyId || appleApiIssuer` checks, neither of which
// look at team ID to decide intent.
const API_KEY_UNIQUE_VARS = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]
const APPLE_ID_UNIQUE_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"]

function presentVars(env, names) {
  return names.filter((name) => typeof env[name] === "string" && env[name].length > 0)
}

function missingVars(env, names) {
  return names.filter((name) => !(typeof env[name] === "string" && env[name].length > 0))
}

function isTouched(env, uniqueNames) {
  return presentVars(env, uniqueNames).length > 0
}

/**
 * Whether `path` points at a file this process can actually read — a
 * regular file (not a directory, not a socket/FIFO/device node) that passes
 * an access(2) read check. Never reads the file's CONTENTS (F3: existence
 * alone is too weak — a directory or an unreadable file both pass
 * `existsSync` and would let a build proceed for several minutes before
 * `notarytool` rejects the path far later, with far less context).
 *
 * @param {unknown} path
 * @returns {boolean}
 */
function isReadableRegularFile(path) {
  if (typeof path !== "string" || path.length === 0) return false
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Decides whether a signed build should notarize, from `env` (normally
 * `process.env`, after `electron-builder.config.mjs` has merged in
 * `.env.signing.local` via `signing-env.mjs`). THROWS on a touched-but-
 * incomplete credential set (of EITHER shape), or on a complete API-key set
 * whose `APPLE_API_KEY` doesn't point at a readable regular file — all three
 * are the "looks fine, fails on the user's machine" failure mode the brief
 * calls out, and refusing the BUILD is the only way to guarantee it's caught
 * here instead of at Apple's notarization service, much later.
 *
 * Only ever called from the SIGNED branch of electron-builder.config.mjs —
 * see that file's own doc comment for why notarization must never even be
 * considered for an unsigned build.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {{ notarize: true, shape: "api-key" | "apple-id" } | { notarize: false, skipReason: string }}
 */
export function resolveNotarizeCredentials(env) {
  // Apple-ID checked FIRST, unconditionally — see the "── Precedence ──"
  // section above. Touched (any of its own two vars set) commits to this
  // shape and validates it completely before returning OR throwing; the
  // API-key vars are never even inspected once this branch is entered,
  // exactly mirroring electron-builder's own behavior.
  if (isTouched(env, APPLE_ID_UNIQUE_VARS)) {
    const missing = missingVars(env, APPLE_ID_VARS)
    if (missing.length > 0) {
      const apiKeyHint = isTouched(env, API_KEY_UNIQUE_VARS)
        ? " (an API-key credential set is also partially present, but Apple-ID takes precedence whenever " +
          "it's touched at all — matching electron-builder's own behavior — so it is not consulted here; " +
          "remove the Apple-ID variables entirely if you meant to use the API-key set instead)"
        : ""
      throw new Error(
        `Incomplete Apple ID notarization credentials — missing: ${missing.join(", ")}. Set all three ` +
          `(${APPLE_ID_VARS.join(", ")}) or remove the ones that are set; a partial set would otherwise ` +
          `silently ship an unnotarized build.${apiKeyHint}`,
      )
    }
    return { notarize: true, shape: "apple-id" }
  }

  if (isTouched(env, API_KEY_UNIQUE_VARS)) {
    const missing = missingVars(env, API_KEY_VARS)
    if (missing.length > 0) {
      throw new Error(
        `Incomplete Apple API key notarization credentials — missing: ${missing.join(", ")}. Set all ` +
          `four (${API_KEY_VARS.join(", ")}) or remove the ones that are set; a partial set would ` +
          "otherwise silently ship an unnotarized build.",
      )
    }
    if (!isReadableRegularFile(env.APPLE_API_KEY)) {
      throw new Error(
        "APPLE_API_KEY is set, but does not point at a readable regular file. Refusing to build with a " +
          "notarization credential that can't possibly work — double-check the path in your signing " +
          "env file by hand (the value itself is never logged here).",
      )
    }
    return { notarize: true, shape: "api-key" }
  }

  return {
    notarize: false,
    skipReason:
      "no Apple notarization credentials found (neither the API-key set nor the Apple-ID set) — building unnotarized",
  }
}

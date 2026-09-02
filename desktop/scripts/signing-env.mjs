#!/usr/bin/env node
// Locates and parses the Apple signing/notarization credentials file
// (tasks/electron-app.md §5 Phase 5b, Part 2). Returns parsed key/value
// pairs to its caller (electron-builder.config.mjs) — it never logs them,
// never includes them in an error message, and never writes them anywhere;
// see notarize-config.mjs for how the values are actually used.
//
// ── Why the file isn't just "next to the config" ────────────────────────────
//
// The credentials live in `.env.signing.local` at the MAIN CHECKOUT ROOT
// (durable, long-lived), not inside `desktop/` and not inside whatever
// checkout happens to be building right now. That matters because a lot of
// building happens from git worktrees under `.claude/worktrees/` — temporary
// checkouts that get deleted after merge. Putting long-lived credentials
// inside one would lose them the moment the worktree is removed. So "this
// checkout's own repo root" is the WRONG place to look whenever the build is
// running from a worktree, which is exactly the case `resolveMainCheckoutRoot`
// below exists to handle.
//
// ── Search order (documented here because there's more than one candidate) ──
//
//   1. `env[SIGNING_ENV_OVERRIDE_VAR]` (`DESDE_SIGNING_ENV`) — an EXPLICIT
//      absolute path. If set, it is the ONLY candidate tried: a typo here
//      must fail loudly, never silently fall through to "no credentials
//      found" (see loadSigningEnv). Required to be absolute, matching this
//      codebase's existing convention for path-like env vars (see
//      payload-resolve.ts's DESDE_DESKTOP_PAYLOAD) — a relative path's
//      meaning would depend on invocation cwd, which is exactly the kind of
//      ambiguity a credentials-file locator shouldn't have.
//   2. `<mainCheckoutRoot>/.env.signing.local` — `mainCheckoutRoot` is
//      resolved via `git rev-parse --git-common-dir`'s PARENT directory.
//      MEASURED live from a real linked worktree: `--git-common-dir` returns
//      the ORIGINAL repo's shared `.git` (not the worktree's own
//      `.git/worktrees/<name>` gitdir, which is what `--git-dir` returns) —
//      so this resolves to the main checkout's root correctly regardless of
//      which worktree is actually running the build, with no hardcoded
//      machine-specific path anywhere.
//   3. `<repoRoot>/.env.signing.local` — `repoRoot` is THIS checkout's own
//      root (desktop/'s parent, via import.meta.url — never `process.cwd()`,
//      which depends on how the caller was invoked). Tried ONLY when
//      candidate 2 couldn't be computed at all (git unavailable, or `cwd`
//      isn't inside a repo) — never as a second candidate alongside it.
//
// **Candidate 2 wins over candidate 3 whenever BOTH are resolvable — not
// "try 3 first, fall back to 2."** An earlier version of this file tried the
// checkout's own root FIRST and treated the main-checkout root as a
// fallback. That is backwards and was a real bug (found in review, not
// caught by any test — there was no `.env.signing.local` in this worktree at
// the time, so it never actually shadowed anything, which is exactly why it
// would have surfaced at the worst possible moment instead of during
// development): a `.env.signing.local` sitting in a TEMPORARY worktree would
// have loaded INSTEAD OF the durable main-checkout file, silently signing
// with the wrong Apple account or breaking the build the moment a worktree
// ever had its own copy. Main-checkout-first, with the current checkout as a
// git-unavailable fallback ONLY, is the only order under which a worktree
// can never shadow the main checkout's credentials. When candidate 2 IS the
// main checkout (i.e. this checkout isn't a worktree at all), 2 and 3 are
// the same path anyway, so there's nothing to choose between.
//
// No credentials file anywhere (no override, and the one candidate that
// applies doesn't exist) is NOT an error — it's the fully-supported
// "building unnotarized" path (a dev machine with no signing credentials, or
// a CI job that exports the same variables directly into its own
// environment instead of via a file). Only an explicit override that
// doesn't resolve is an error.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(scriptDir, "..")

export const SIGNING_ENV_FILENAME = ".env.signing.local"
export const SIGNING_ENV_OVERRIDE_VAR = "DESDE_SIGNING_ENV"

/**
 * `git rev-parse --git-common-dir`'s parent directory — see the module doc
 * comment for why this correctly finds the MAIN checkout from inside any
 * linked worktree, and why it is tried BEFORE the checkout's own root, not
 * after. Returns `null` (never throws) when git itself isn't available or
 * `cwd` isn't inside a repo at all — in that case `resolveSigningEnvCandidates`
 * falls back to the checkout's own root instead.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolveMainCheckoutRoot(cwd) {
  try {
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (!gitCommonDir) return null
    return dirname(resolve(cwd, gitCommonDir))
  } catch {
    return null
  }
}

/**
 * The ordered list of candidate paths — always exactly ONE entry (besides
 * the override case, which is also exactly one). See the module doc comment
 * for the full search-order rationale, and F1 in
 * tasks/electron-app.md §5 Phase 5b for why this is a single decision
 * rather than a try-this-then-that list: trying the checkout's own root as
 * well as the main checkout's — even as a "second" candidate — reopens the
 * exact shadowing bug this function exists to close, because
 * `loadSigningEnv` stops at the first candidate whose file exists, and a
 * worktree's own file would exist while the main checkout's might not (or
 * vice versa) with no way to tell from the caller's side which one won.
 *
 * `mainCheckoutRootResolver` is injected (defaulting to the real
 * `resolveMainCheckoutRoot`) purely for testability: unit tests fake it
 * rather than depending on the test-runner's own git state.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} repoRoot
 * @param {string} cwd
 * @param {(cwd: string) => string | null} [mainCheckoutRootResolver]
 * @returns {{ path: string, required: boolean }[]}
 */
export function resolveSigningEnvCandidates(
  env,
  repoRoot,
  cwd,
  mainCheckoutRootResolver = resolveMainCheckoutRoot,
) {
  const override = env[SIGNING_ENV_OVERRIDE_VAR]
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `${SIGNING_ENV_OVERRIDE_VAR} must be an absolute path, got: ${JSON.stringify(override)}. A ` +
          "relative path's meaning would depend on which directory the build happened to be invoked " +
          "from — refusing to guess.",
      )
    }
    // Early return, deliberately: an explicit override is the ONLY candidate
    // tried (see the module doc comment) — falling through to the checks
    // below would both contradict that and shell out to git for no reason.
    return [{ path: override, required: true }]
  }
  // Main checkout FIRST, unconditionally — see the module doc comment's "──
  // Search order ──" section for why this is not "try the checkout's own
  // root, then fall back": the checkout's own root is used ONLY when git
  // resolution genuinely fails (no git, or `cwd` isn't inside a repo), never
  // as an additional candidate alongside a resolvable main checkout.
  const mainCheckoutRoot = mainCheckoutRootResolver(cwd)
  const chosenRoot = mainCheckoutRoot ?? repoRoot
  return [{ path: join(chosenRoot, SIGNING_ENV_FILENAME), required: false }]
}

/**
 * Minimal `KEY=VALUE` parser — intentionally not a full dotenv
 * implementation (no multi-line values, no `export` prefix, no variable
 * interpolation): `.env.signing.local` is a file WE control the shape of
 * (four flat keys — see tasks/electron-app.md's Part 2 brief), not
 * user-authored config that needs to tolerate arbitrary shell-env syntax.
 * Blank lines and `#`-prefixed comment lines are skipped; a value wrapped in
 * matching single or double quotes has them stripped, so both `KEY=value`
 * and `KEY="value"` work.
 *
 * @param {string} contents
 * @returns {Record<string, string>}
 */
export function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    if (key) result[key] = value
  }
  return result
}

/**
 * Finds and parses the signing env file, per `resolveSigningEnvCandidates`'s
 * search order. Returns `{}` (never throws) when no candidate exists and no
 * explicit override was given — see the module doc comment: that's the
 * ordinary, fully-supported "no signing credentials configured" case, not a
 * failure.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 * @param {(cwd: string) => string | null} [mainCheckoutRootResolver]
 * @returns {Record<string, string>}
 */
export function loadSigningEnv(
  env = process.env,
  cwd = process.cwd(),
  mainCheckoutRootResolver = resolveMainCheckoutRoot,
  repoRootOverride = null,
) {
  // `repoRoot` is injectable, and it is the seam that was missing.
  //
  // Three of this function's inputs were already injectable and this one was
  // not, so a test asking "what happens when NO candidate exists" could not
  // actually arrange that: `repoRoot` always resolved to the real checkout,
  // and the answer depended on whether the developer happened to have
  // credentials configured. The test asserting `{}` passed on a machine with
  // no `.env.signing.local` and failed the moment someone set signing up,
  // which is the opposite of what a test should do about a feature working.
  //
  // Production callers pass nothing and get the real root, unchanged.
  const repoRoot = repoRootOverride ?? resolve(DESKTOP_ROOT, "..")
  const candidates = resolveSigningEnvCandidates(env, repoRoot, cwd, mainCheckoutRootResolver)
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      if (candidate.required) {
        throw new Error(
          `${SIGNING_ENV_OVERRIDE_VAR} does not point at a file that exists (resolved to ` +
            `${candidate.path}). Refusing to fall back to another location — an explicit override ` +
            "that doesn't resolve is treated as a mistake, not a hint to keep looking.",
        )
      }
      continue
    }
    return parseEnvFile(readFileSync(candidate.path, "utf8"))
  }
  return {}
}

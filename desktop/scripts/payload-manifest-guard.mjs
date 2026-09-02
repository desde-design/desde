#!/usr/bin/env node
// Refuses to package a payload built for the WRONG machine.
//
// `package.mjs` used to only check that `dist/cli.js` existed inside
// `DESDE_PAYLOAD_DIR` — that is true of any complete payload, including
// one staged on a different architecture. electron-builder's own target is
// picked from `process.arch` (this packaging host), so an arm64 host handed
// a stale x64 payload directory would happily wrap an arm64 Electron shell
// around an x64 `claude` binary and x64 `.node` modules: it builds cleanly,
// installs cleanly, and only fails at runtime on the user's machine.
//
// `build-server-package.mts` already writes `payload-manifest.json` at the
// payload root with the `platform`/`arch` it was staged for (read straight
// off `process.platform`/`process.arch` at build time — see that script's
// `writeManifest`). This module is the single place that manifest gets
// checked against the packaging host, so it is imported both by
// `package.mjs` (the actual electron-builder invocation) and by this
// package's `--payload-dir` reuse path — which is really the same path,
// since `build-desktop-app.mts` always shells out to `npm run package`
// (→ `package.mjs`) whether the payload was just built or reused via
// `--payload-dir`. One chokepoint, not two copies of the same check.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const MANIFEST_FILENAME = "payload-manifest.json"

/**
 * Reads `<payloadDir>/payload-manifest.json` and returns a discriminated
 * result — never throws. A missing file and a file that fails to parse (or
 * parses but lacks the string `platform`/`arch` fields this guard needs) are
 * both reported as failures a caller can act on, distinct from a genuine
 * platform/arch MISMATCH, which needs the manifest's own values to explain.
 *
 * @param {string} payloadDir
 * @returns {
 *   | { status: "ok"; manifestPath: string; platform: string; arch: string }
 *   | { status: "missing"; manifestPath: string }
 *   | { status: "malformed"; manifestPath: string; reason: string }
 * }
 */
export function readPayloadManifest(payloadDir) {
  const manifestPath = resolve(payloadDir, MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) {
    return { status: "missing", manifestPath }
  }

  let raw
  try {
    raw = readFileSync(manifestPath, "utf8")
  } catch (err) {
    return { status: "malformed", manifestPath, reason: err instanceof Error ? err.message : String(err) }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { status: "malformed", manifestPath, reason: err instanceof Error ? err.message : String(err) }
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.platform !== "string" ||
    typeof parsed.arch !== "string"
  ) {
    return {
      status: "malformed",
      manifestPath,
      reason: `parsed, but is missing a string "platform" and/or "arch" field: ${JSON.stringify(parsed)}`,
    }
  }

  return {
    status: "ok",
    manifestPath,
    platform: parsed.platform,
    arch: parsed.arch,
    // F2 (whole-branch review): `gitCommit` is written by every manifest
    // `build-server-package.mts` produces (`writeManifest`), but an older
    // cached payload staged before that field existed won't have it —
    // `undefined`, not a hard failure, so `checkPayloadFreshness` below can
    // treat "unknown" as "nothing to compare" rather than refusing a
    // payload for a reason unrelated to staleness. `undefined` (not `null`)
    // so a manifest with no gitCommit still equals the plain
    // `{status, manifestPath, platform, arch}` shape under `toEqual` in this
    // module's existing tests.
    gitCommit: typeof parsed.gitCommit === "string" ? parsed.gitCommit : undefined,
    // F9 (whole-branch review, fourth pass, P1 fix): same "optional, absent
    // on an old manifest" treatment as gitCommit above — see
    // checkPayloadFreshness's doc comment for why THIS field, not gitCommit,
    // is what actually decides staleness now.
    payloadFingerprint: typeof parsed.payloadFingerprint === "string" ? parsed.payloadFingerprint : undefined,
  }
}

/**
 * POSIX shell single-quoting: wraps `value` in `'…'`, escaping any literal
 * single quote as `'\''` (close the quote, an escaped quote, reopen the
 * quote — the standard technique, since a single-quoted string can't contain
 * an unescaped `'` at all). Every rebuild command this module renders runs
 * `value` through this before interpolating it, because `value` is always a
 * filesystem path with no constraint on its characters — a checkout (or a
 * `--out`/`DESDE_PAYLOAD_DIR` value) under something like `~/Proto Tools`
 * is completely ordinary, and an unquoted `--out ${payloadDir}` word-splits
 * on the space: `build-server-package.mts`'s own `parseArgs` (see that file)
 * then sees `Tools` as a stray unrecognized argument and rejects it — a
 * command this guard's whole job is to hand the user working.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.split("'").join(`'\\''`)}'`
}

/**
 * Pure comparison — no filesystem access — so it can be unit-tested against
 * synthetic {@link readPayloadManifest} results without staging a real
 * payload. Returns `{ ok: true }` only when the manifest was readable AND its
 * `platform`/`arch` both match the packaging host; every other case returns
 * `{ ok: false, message }` with a message naming the concrete mismatch, the
 * payload path, and the command to rebuild it for this host. An unidentifiable
 * payload (missing or unparseable manifest) is a refusal, not a pass — it is
 * exactly the case this guard exists for.
 *
 * @param {ReturnType<typeof readPayloadManifest>} manifestResult
 * @param {string} hostPlatform
 * @param {string} hostArch
 * @param {string} payloadDir
 * @returns {{ ok: true } | { ok: false; message: string }}
 */
export function checkPayloadHostMatch(manifestResult, hostPlatform, hostArch, payloadDir) {
  const quotedPayloadDir = shellQuote(payloadDir)
  const rebuildHint =
    `Rebuild the payload for this host with:\n\n` +
    `  npm run build:payload -- --out ${quotedPayloadDir}\n\n` +
    `(from the repo root) — or drop --payload-dir / DESDE_PAYLOAD_DIR and let ` +
    `\`npm run package:desktop\` stage a fresh one for this host automatically.`

  if (manifestResult.status === "missing") {
    // This branch is only ever reached after package.mjs's own check, just
    // above where it calls this function, has already confirmed
    // `${payloadDir}/dist/cli.js` exists — so a MISSING manifest here always
    // means the directory is real and non-empty, just markerless (an
    // interrupted build, or one staged by something other than
    // build-server-package.mts). The generic `rebuildHint` above is NOT safe
    // to hand out unmodified for this branch: that script's own
    // `cleanDestination()` refuses to overwrite a non-empty `--out`
    // directory that has no `payload-manifest.json` in it (see its doc
    // comment) — so running the plain rebuild command would itself fail,
    // and only AFTER the multi-minute build/install steps had already run.
    // Tell the user to clear the path (or pick a fresh one) instead of
    // handing them a command already proven not to work.
    return {
      ok: false,
      message:
        `${manifestResult.manifestPath} does not exist, but ${payloadDir} is not empty (this ` +
        `packaging host already confirmed dist/cli.js is present there). An unidentifiable payload ` +
        `cannot be verified as matching this packaging host (${hostPlatform}/${hostArch}), so it is ` +
        `refused rather than assumed safe.\n\n` +
        `It also can't be rebuilt in place: build-server-package.mts refuses to write into a ` +
        `non-empty --out directory that has no payload-manifest.json marker. Remove it first, then ` +
        `rebuild:\n\n` +
        `  rm -rf ${quotedPayloadDir}\n` +
        `  npm run build:payload -- --out ${quotedPayloadDir}\n\n` +
        `or stage into a fresh path instead, e.g.:\n\n` +
        `  npm run build:payload -- --out ${shellQuote(`${payloadDir}-rebuilt`)}\n\n` +
        `(both from the repo root) — or drop --payload-dir / DESDE_PAYLOAD_DIR and let ` +
        `\`npm run package:desktop\` stage a fresh one for this host automatically.`,
    }
  }
  if (manifestResult.status === "malformed") {
    return {
      ok: false,
      message:
        `${manifestResult.manifestPath} could not be read (${manifestResult.reason}). An unreadable ` +
        `manifest cannot be verified as matching this packaging host (${hostPlatform}/${hostArch}), ` +
        `so it is refused rather than assumed safe.\n\n${rebuildHint}`,
    }
  }
  if (manifestResult.platform !== hostPlatform || manifestResult.arch !== hostArch) {
    return {
      ok: false,
      message:
        `Payload at ${payloadDir} was staged for ${manifestResult.platform}/${manifestResult.arch}, ` +
        `but this packaging host is ${hostPlatform}/${hostArch}. Packaging would produce a ` +
        `${hostArch} Electron shell wrapping a ${manifestResult.arch} \`claude\` binary and native ` +
        `modules — it would build and install cleanly and fail only at runtime, on the user's machine.\n\n${rebuildHint}`,
    }
  }
  return { ok: true }
}

/**
 * F2 (whole-branch review, Important) → F7 (P1 fix, git-scoped) → F9
 * (whole-branch review, fourth pass, P1 fix: FINGERPRINT-based). Compares a
 * payload's staged fingerprint against the PACKAGING checkout's fingerprint
 * of the same inputs RIGHT NOW, and classifies the result. Pure — no `git`
 * invocation, no filesystem access, no hashing — everything is supplied by
 * the caller, so this stays unit-testable the same way
 * {@link checkPayloadHostMatch} is.
 *
 * ── Why fingerprint, not git (F9) ────────────────────────────────────────
 *
 * F2 and F7 both compared git state: F2 compared commit strings, F7 scoped
 * that comparison to the paths that actually feed the payload. Both were
 * real improvements, and both were still asking the WRONG instrument the
 * right-ish question. `git status` answers "what has changed since a
 * commit" — packaging-time freshness needs to answer "do the payload's
 * bytes match what this tree would produce right now", and those are
 * different questions in two concrete, dangerous ways:
 *
 *   1. `scripts/build-server-package.mts` — the staging recipe
 *      ITSELF — sat outside every git pathspec F7 scoped to. Change what
 *      gets copied, or how the manifest is generated, and payload bytes
 *      change while a git-based check still reports clean.
 *   2. `editor-cli/dist/**` / `editor-cli/ui-src/dist/**` — the actual
 *      server and UI bundles copied verbatim into the payload — are
 *      gitignored. `git status` cannot report a change there at ANY scope;
 *      these are the two largest, most-likely-to-drift things in the whole
 *      payload, and they were structurally invisible.
 *
 * `payloadFingerprint` (`scripts/payload-fingerprint.mjs`'s
 * `computePayloadFingerprint` — the SAME function both `writeManifest` at
 * staging time and this check's caller at packaging time import, so there
 * is exactly one algorithm, never two that could drift) reads what is
 * actually on disk, gitignored or not, recipe included. See that module's
 * own doc comment for the precise, deliberately-bounded list of what it
 * covers and what it does not.
 *
 * `gitCommit` and `current.dirty` are NOT part of the decision anymore —
 * they are provenance, folded into the human-readable message only. The
 * fingerprint decides; the commit explains.
 *
 * `checkPayloadHostMatch` already refuses an unidentifiable payload
 * (missing/malformed manifest) before this ever runs. An OLD manifest
 * predating the `payloadFingerprint` field is NOT treated as "nothing to
 * enforce" (F10, whole-branch review, fifth pass, P1 fix — see the
 * dedicated doc comment on the fallback branch below for why "I cannot
 * verify this" must never be the same code path as "this is fine"). Only a
 * manifest with NEITHER `payloadFingerprint` NOR `gitCommit` at all — older
 * than F2 itself, not reachable from any payload this codebase has staged
 * since — has truly nothing to compare and passes silently.
 *
 * This is the same footgun class this branch already fixed for the CLI
 * entry shims (commit 0d7b06a8, "prefer source over a stale bundle in a
 * checkout"): a stale build artifact silently outliving the source it was
 * built from, with no signal anything is wrong. There, a shim ran stale CLI
 * code from `dist/cli.js` after a `src/` edit; here, `--payload-dir
 * <weeks-old-dir>` can package — and even SIGN — a server that's weeks
 * older than the shell wrapping it.
 *
 * @param {ReturnType<typeof readPayloadManifest>} manifestResult
 * @param {{ commit: string; dirty: boolean; fingerprint: string }} current
 *   the packaging checkout's HEAD commit and dirty state (message context,
 *   and the FALLBACK decision when no fingerprint is available — see
 *   below) and its CURRENT payload fingerprint (the primary decision).
 * @param {{ signing: boolean; allowStale: boolean }} options `signing`: this
 *   packaging run has `--sign`/`DESDE_DESKTOP_SIGN=1`. `allowStale`: the
 *   explicit `--allow-stale-payload` override.
 * @returns {{ ok: true; warning: string | null } | { ok: false; message: string }}
 */
export function checkPayloadFreshness(manifestResult, current, options) {
  if (manifestResult.status !== "ok") {
    return { ok: true, warning: null }
  }

  if (typeof manifestResult.payloadFingerprint === "string") {
    return checkFreshnessByFingerprint(manifestResult, current, options)
  }

  if (typeof manifestResult.gitCommit === "string") {
    return checkFreshnessByCommitFallback(manifestResult, current, options)
  }

  // Neither field present — a manifest from before F2 itself, which shipped
  // gitCommit unconditionally. Not reachable from any payload this codebase
  // has staged since; nothing to compare.
  return { ok: true, warning: null }
}

/** The primary, verifiable decision: does the payload's stamped content fingerprint match what this checkout would produce right now. */
function checkFreshnessByFingerprint(manifestResult, current, options) {
  if (manifestResult.payloadFingerprint === current.fingerprint) {
    return { ok: true, warning: null }
  }

  const { manifestPath, gitCommit } = manifestResult
  const provenance =
    (typeof gitCommit === "string" ? `staged from ${gitCommit}; ` : "") +
    `this checkout is now at ${current.commit}${current.dirty ? " (with uncommitted changes)" : ""}`

  const message =
    `Payload at ${manifestPath}: its fingerprint no longer matches what this checkout would produce ` +
    `right now (${provenance}) — the server inside this app may not match the shell it is being ` +
    `packaged with. Rebuild the payload (npm run build:payload), commit or stash pending changes, or ` +
    `point --payload-dir at a fresher one.`

  if (options.signing && !options.allowStale) {
    return {
      ok: false,
      message:
        `${message}\n\nRefusing to SIGN a build with a stale payload — a signed build is the one users ` +
        `actually install, so this is exactly the build where a stale server must not slip through ` +
        `silently (the same footgun class fixed for the CLI entry shims in 0d7b06a8: a stale build ` +
        `artifact silently outliving the source it was built from). Pass --allow-stale-payload if this ` +
        `is deliberate (e.g. verifying signing itself, not shipping the result).`,
    }
  }

  return { ok: true, warning: message }
}

/**
 * F10 (whole-branch review, fifth pass, P1 fix): the fallback for a payload
 * staged BEFORE `payloadFingerprint` existed — `gitCommit` is present,
 * `payloadFingerprint` is not. This is reachable TODAY: `desktop/.payload-cache`
 * (or any `--payload-dir`) may hold exactly such a manifest right now, staged
 * before this commit.
 *
 * The bug this closes: the fingerprint branch above simply returning
 * `{ ok: true, warning: null }` for a manifest with no `payloadFingerprint`
 * field was a TOTAL BYPASS — an arbitrarily old cached payload would package
 * and sign with no warning and no `--allow-stale-payload` gate at all. "I
 * cannot verify this payload" and "this payload is fine" are different
 * answers, and the fingerprint-less case is the FIRST one, never the second.
 *
 * So this falls back to the pre-F9 commit/dirty comparison (F2, scoped by
 * F7) for the message content, but the SIGNING gate does not depend on that
 * fallback finding a discrepancy: an unverifiable payload refuses under
 * `--sign` unconditionally, because the fallback comparison — unlike the
 * fingerprint — cannot see a change to a gitignored built artifact or to
 * the staging recipe itself (F9's own two gaps). A clean-looking commit
 * compare is not proof of freshness here; it is the best available
 * DEGRADED signal, and the message says so explicitly rather than reading
 * like a pass.
 */
function checkFreshnessByCommitFallback(manifestResult, current, options) {
  const { manifestPath, gitCommit } = manifestResult
  const payloadDirty = gitCommit.endsWith("-dirty")
  const payloadCommit = payloadDirty ? gitCommit.slice(0, -"-dirty".length) : gitCommit

  const reasons = []
  if (payloadDirty) {
    reasons.push(`was staged from an UNCOMMITTED working tree (${gitCommit})`)
  }
  if (current.dirty) {
    reasons.push(
      `this checkout currently has UNCOMMITTED changes on top of ${current.commit} — no payload staged ` +
        `from any commit can reflect changes that were never committed`,
    )
  }
  if (!payloadDirty && payloadCommit !== current.commit) {
    reasons.push(`was staged from ${payloadCommit}, but this checkout's HEAD is ${current.commit}`)
  }

  const commitFindings =
    reasons.length > 0
      ? `Additionally, ${reasons.join("; and ")}.`
      : `Its recorded commit and this checkout's HEAD/dirty state show no discrepancy, but that is a ` +
        `degraded signal, not proof: it cannot see a change to a gitignored built artifact ` +
        `(editor-cli/dist, editor-cli/ui-src/dist) or to the staging recipe itself.`

  const message =
    `Payload at ${manifestPath} predates fingerprint-based verification (only its gitCommit is ` +
    `recorded, from before this build gained a content fingerprint) — its bytes cannot be fully ` +
    `verified against this checkout. ${commitFindings} Rebuild the payload (npm run build:payload) to ` +
    `get a verifiable fingerprint, or point --payload-dir at a fresher one.`

  if (options.signing && !options.allowStale) {
    return {
      ok: false,
      message:
        `${message}\n\nRefusing to SIGN an UNVERIFIABLE payload — a signed build is the one users ` +
        `actually install, so this is exactly the build where "I cannot tell if this is stale" must ` +
        `not be treated the same as "this is fine". Pass --allow-stale-payload if this is deliberate ` +
        `(e.g. verifying signing itself, not shipping the result), or rebuild the payload to restore ` +
        `verifiability.`,
    }
  }

  return { ok: true, warning: message }
}

/**
 * F7 (whole-branch review, third pass, P1 fix). F9 (fourth pass) demoted
 * this from the freshness DECISION (now `computePayloadFingerprint`'s job —
 * see `checkPayloadFreshness` above) to PROVENANCE only: `current.dirty`
 * feeds the human-readable "with uncommitted changes" clause in a mismatch
 * warning, nothing more. Still scoped to the paths that actually feed the
 * payload for the same reason it always was — an annotation that itself
 * fires on an unrelated repo change would be exactly the kind of
 * misleading noise this whole review thread has been about closing, even
 * though it can no longer cause a false REFUSAL on its own.
 *
 *   - `editor-cli/`     — its own `dist/` and `ui-src/dist/` (built from
 *                         `editor-cli/src/**` and `editor-cli/ui-src/src/**`),
 *                         plus the raw `attach/stampers/*.entry.ts` +
 *                         `icon-preview/*.mjs` source copied as-is. Its own
 *                         `tsconfig.json` maps `@/*` to `../src/*` — i.e.
 *                         root `src/`, below — so its build can reach
 *                         anything there too.
 *   - `src/`            — root. The shared core (`src/editor/**`,
 *                         `src/bridge/**`, …) editor-cli's server AND its UI
 *                         bundle both pull from via that `@/*` alias —
 *                         CLAUDE.md's own words: "shared code + the Editor
 *                         shell UI (consumed by editor-cli's bundle)".
 *   - `dist/bridge-bundle.js` — copied verbatim into the payload; it is a
 *                         COMMITTED build artifact (nothing rebuilds it as
 *                         part of packaging — see CLAUDE.md), so its own
 *                         content is what matters, not `src/bridge/`'s.
 *   - `public/vendor/html2canvas.min.js` — likewise copied verbatim.
 *
 * NOT covered, BY DESIGN: everything else in the repo — docs/, tasks/,
 * viewer/, mcp-server/, desktop/ itself, root scratch files, an unrelated
 * submodule.
 *
 * This is a DIFFERENT, narrower question than
 * `scripts/build-server-package.mts`'s own `isWorkingTreeDirty` (used
 * for the payload's OWN `-dirty` PROVENANCE stamp at BUILD time, which is
 * deliberately whole-repo, and whose own tests already establish that as
 * the intended contract — changing it is out of scope here).
 */
export const PAYLOAD_INPUT_PATHSPECS = [
  "editor-cli",
  "src",
  "dist/bridge-bundle.js",
  "public/vendor/html2canvas.min.js",
]

/**
 * True when `git status --porcelain -- <PAYLOAD_INPUT_PATHSPECS>` reports
 * any pending change, SCOPED to the paths that actually feed the payload —
 * see {@link PAYLOAD_INPUT_PATHSPECS}'s own doc comment for the exact
 * boundary, why it exists, and why (as of F9) it no longer decides
 * anything on its own. `repoRoot` is a parameter (not read from
 * `process.cwd()`) so tests can point it at a scratch git repo instead of
 * the real checkout — same reasoning `build-server-package.mts`'s own
 * `isWorkingTreeDirty(repoRoot)` documents.
 */
export function isPayloadInputsDirty(repoRoot) {
  const output = execFileSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain", "--", ...PAYLOAD_INPUT_PATHSPECS],
    { encoding: "utf8" },
  )
  return output.trim().length > 0
}

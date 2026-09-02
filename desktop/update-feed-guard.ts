/**
 * F1 (whole-branch review, merge blocker; P1 fix on second pass): decides
 * whether ONE update-check trigger should skip the real check.
 *
 * ── The original bug ──────────────────────────────────────────────────────
 *
 * `electron-builder` only emits `Resources/app-update.yml` when a `publish`
 * provider is configured in `electron-builder.config.mjs` — there isn't one
 * yet (the releases repo is still an open Phase 0 decision, see
 * `tasks/electron-app.md` §5 Phase 0). In a PACKAGED app `app.isPackaged` is
 * true, so `electron-updater`'s real `checkForUpdates()` does a plain
 * `readFile` of that path (verified against the installed electron-updater
 * 6.8.9, `AppUpdater.js:482`'s `loadUpdateConfig()`) — missing, it ENOENTs,
 * the check rejects, and `updater-reducer.ts` correctly (and permanently,
 * every 4h) surfaces `phase: "error"`.
 *
 * ── Why "is app-update.yml missing" was the wrong question (P1 fix) ────────
 *
 * The first version of this guard skipped whenever the feed file was
 * missing, full stop. That conflates two situations that need OPPOSITE
 * answers:
 *
 *   1. Phase 0 today: no publish provider configured AT ALL — skipping is
 *      correct, there is genuinely nothing to check against.
 *   2. A future Phase 5 build where publish IS configured, but the feed file
 *      failed to generate or ship for some other reason (a packaging
 *      defect) — here `app-update.yml` is ALSO missing, but skipping is
 *      WRONG: it hides a real bug behind permanent silence, the opposite
 *      failure to the one this guard was built to fix, and a harder one to
 *      notice (nothing looks broken).
 *
 * A missing file cannot tell these apart — it is the SAME observation in
 * both cases. What CAN tell them apart is a decision made at PACKAGE TIME,
 * when `electron-builder.config.mjs`'s own `publish` field is known for a
 * fact. `electron-builder.config.mjs`'s `afterPack` hook (see its own doc
 * comment) stamps that fact into `Resources/update-feed-status.json` —
 * `{ publishConfigured: true | false }` — read straight off `config.publish`,
 * never re-derived a second way. This module only reads that stamp; it does
 * not touch `app-update.yml` at all, so a feed file that EXISTS but is
 * CORRUPT is completely untouched by this guard and still reaches the real
 * electron-updater check, which still correctly surfaces it as `error` —
 * exactly as it did before this guard existed.
 *
 * The stamp is written by every packaging run — signed or not, whether
 * invoked via `scripts/build-desktop-app.mts` or `desktop/scripts
 * /package.mjs` directly (`afterPack` runs regardless of caller). Skipping
 * requires an EXPLICIT `publishConfigured: false`; a missing, unreadable, or
 * unrecognized stamp all fail toward NOT skipping — the safe direction is
 * "attempt the real check and let a genuine failure surface", never
 * "assume it's fine to stay silent". This is also what makes the guard
 * self-disabling the moment Phase 5 adds a real `publish` config: the stamp
 * flips to `true` automatically, with nothing in this file (or `main.ts`, or
 * `updater.ts`) needing to be remembered or deleted.
 *
 * ── Why per-trigger, not once at boot (P1 fix) ──────────────────────────────
 *
 * The original guard was evaluated once in `boot()` and baked into a
 * `boolean` handed to `createUpdater()` — the 4h timer was never even
 * scheduled, and the on-demand "Check for updates" click was a permanent
 * no-op, for the rest of the process's life. `main.ts` now instead passes
 * `updater.ts` a CALLBACK (`shouldSkipCheck`) that re-invokes this function
 * — re-reading `update-feed-status.json` off disk — on EVERY trigger: the
 * construction-time check, EACH 4h timer fire, and EACH on-demand click. The
 * timer keeps running either way now (a cheap, harmless re-check when
 * nothing has changed); if the answer ever does change, the very next
 * trigger acts on it with no special-casing anywhere for "this was decided
 * once at boot".
 *
 * Pure and dependency-free (no `app.isPackaged`/`fs` calls of its own) so it
 * can be unit-tested without booting a real Electron `app` — the caller
 * supplies both `isPackaged` and a `readFileSync`.
 */
import { join } from "node:path"

export interface UpdateFeedGuardDeps {
  isPackaged: boolean
  /** `process.resourcesPath` — only read when `isPackaged` is true. */
  resourcesPath: string
  /** Reads a file as utf8 text, throwing on any failure (missing, permissions, …) — the shape of `(path) => readFileSync(path, "utf8")`. */
  readFileSync: (path: string) => string
}

/**
 * `Resources/update-feed-status.json` — written by `electron-builder.config.mjs`'s
 * `afterPack` hook (P1 fix) on every packaging run. Kept as a literal string
 * constant in BOTH files rather than a shared import: `electron-builder.config.mjs`
 * is plain, un-typechecked config JS evaluated directly by electron-builder
 * (no build step in that path — see that file's own doc comment), and this
 * module is bundled TypeScript — the same "duplicated literal, not a cross-
 * module import" tradeoff `main.ts` already documents for
 * `PAYLOAD_MANIFEST_FILENAME`.
 */
export const UPDATE_FEED_STATUS_FILENAME = "update-feed-status.json"

/** Exported so the guard's own test (and any future caller) can build the exact path without duplicating the join. */
export function updateFeedStatusPath(resourcesPath: string): string {
  return join(resourcesPath, UPDATE_FEED_STATUS_FILENAME)
}

/**
 * True only when the stamp EXPLICITLY says `publishConfigured: false` for a
 * packaged app. A dev run (`app.isPackaged` false) is never gated here —
 * its own no-feed behavior is the pre-existing, harmless "stays idle" dev
 * no-op `updater.ts`'s `forceDevUpdateConfig` doc comment already
 * describes, not this bug. Missing/unreadable/malformed/unrecognized
 * stamps all resolve to `false` (don't skip) — see the module doc comment
 * for why that's the safe direction.
 */
export function shouldSkipUpdateChecks(deps: UpdateFeedGuardDeps): boolean {
  if (!deps.isPackaged) return false

  let raw: string
  try {
    raw = deps.readFileSync(updateFeedStatusPath(deps.resourcesPath))
  } catch {
    return false
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }

  if (parsed === null || typeof parsed !== "object") return false
  return (parsed as { publishConfigured?: unknown }).publishConfigured === false
}

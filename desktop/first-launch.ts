/**
 * First-launch hygiene: deciding whether to offer a move to /Applications on
 * macOS. Pure, `electron`-free logic — like `payload-resolve.ts` and
 * `navigation-guard.ts` — so it is unit-testable without a real Electron
 * process (`main.ts` calls `app.isPackaged` / `app.isInApplicationsFolder()`
 * itself and passes the results in).
 *
 * **Why this exists at all.** Squirrel.Mac (what `electron-updater` uses for
 * mac auto-update, landing in Phase 4/5 — `tasks/electron-app.md` §4) SILENTLY
 * fails to update an app running outside `/Applications`. That failure mode is
 * a known upstream limitation (documented across electron-builder/Squirrel.Mac
 * issue trackers), not something a later phase can fix from the update side —
 * the fix has to happen at first launch, before the user has any reason to
 * suspect anything is wrong. A user who double-clicks straight out of the
 * Downloads folder (a completely ordinary thing to do) would otherwise get a
 * working app today and a permanently-stuck "Restart to update" badge later,
 * with no error message anywhere pointing at the cause.
 *
 * **A prompt, not a silent move** (`tasks/electron-app.md` §5 Phase 3 task 3,
 * explicit): `app.moveToApplicationsFolder()` itself performs the move with
 * no confirmation of its own — silently relocating a user's application
 * bundle without asking is the kind of surprise this project avoids. Declining
 * must never block boot — see `main.ts`'s `maybePromptMoveToApplications`,
 * which proceeds to spawn the payload regardless of the user's answer (or of
 * the move itself failing).
 */

/**
 * Whether to show the move-to-Applications prompt at all.
 *
 * - Never in dev: `packaged` is `app.isPackaged`, which is `false` for every
 *   dev entry point (`npm run desktop`, `desktop/`'s own `dev`/`start`
 *   scripts all run `electron .` against `desktop/dist`, never a `.app`
 *   bundle) — prompting there would be pure noise on every developer launch.
 * - Never on non-mac: `moveToApplicationsFolder` is a mac-only Electron API:
 *   Squirrel.Windows (the Windows updater) has no equivalent "wrong folder"
 *   failure mode this is working around, and AppImage (Linux) has no
 *   install-location concept at all.
 * - Never when already in Applications: `alreadyInApplications` is
 *   `app.isInApplicationsFolder()` — the common case once a user has done
 *   this once, or dragged the app there from a dmg themselves.
 */
export function shouldPromptMoveToApplications(
  platform: NodeJS.Platform,
  packaged: boolean,
  alreadyInApplications: boolean,
): boolean {
  return platform === "darwin" && packaged && !alreadyInApplications
}

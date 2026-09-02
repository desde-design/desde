/**
 * The directory the user launched the CLI from, captured before anything can
 * change it.
 *
 * WHY THIS EXISTS. On 2026-08-09 `core.ts` started calling
 * `process.chdir(prototypeViteRoot)` so that a user `vite.config.ts` calling
 * `process.cwd()` — the canonical Vite idiom — resolves against the prototype
 * rather than the Desde checkout. That is correct for Vite and wrong for
 * everything else in the process, because `process.cwd()` is global state and
 * the chdir is permanent.
 *
 * The victim is the breadcrumb "home" launcher, which `http-server.ts` starts
 * LAZILY IN THIS SAME PROCESS long after the chdir. Its operations are
 * launch-directory relative by intent:
 *
 *   - `cloneRepo()` resolves an omitted destination against the cwd, so
 *     Home → Clone would create the clone INSIDE the repo currently being
 *     edited.
 *   - `defaultSpawnEditor()` spawns child editors with no `cwd`, so they
 *     inherit the prototype's directory instead of the user's.
 *
 * Captured at module load. Every importer is loaded during startup, before
 * `startCore` runs, so this is the real launch directory and not a snapshot of
 * some later state. Deliberately a frozen constant rather than a setter: a
 * value that can be reassigned is one that will be, from somewhere that has
 * already chdir'd.
 *
 * Found by codex review; see `tasks/scripts/.../tracer-path-prefix.test.ts`
 * for the other half of the chdir's consequences.
 */
const LAUNCH_CWD = process.cwd()

/** The directory the CLI was launched from, unaffected by any later chdir. */
export function launchCwd(): string {
  return LAUNCH_CWD
}

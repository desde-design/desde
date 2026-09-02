/**
 * The launcher an editor process calls "home".
 *
 * An editor is one repo per process, so the breadcrumb's Home button has to
 * leave for a launcher. Before this seam existed, `GET /api/editor/home`
 * always started a NEW launcher on a free port, even when the editor had
 * itself been spawned by one that was still running. In the desktop app that
 * was a real bug, not just a leak: the shell's `will-navigate` guard
 * (`desktop/navigation-guard.ts`) trusts only origins it has been told about,
 * it had been told about the launcher it booted and nothing else, and the
 * breadcrumb's hop to a random-port launcher was handed to the system
 * browser. MEASURED 2026-09-01 in the packaged app: Home from a project opened
 * a browser tab, and "Edit" on a card in that tab is the "settings page in a
 * browser tab" report that followed.
 *
 * The launcher now tells every editor it spawns where home is, through this
 * one env var, and the editor answers Home with that URL instead of starting a
 * second launcher. An editor started by hand (`desde <repo>`) has no parent
 * launcher, sees no env var, and keeps the lazy-start behaviour.
 */

export const HOME_URL_ENV = "DESDE_HOME_URL"

/**
 * The env entry a launcher adds to a spawned editor. Returns an empty object
 * for a missing origin so callers can spread it unconditionally.
 */
export function homeUrlEnv(origin: string | undefined): NodeJS.ProcessEnv {
  return origin ? { [HOME_URL_ENV]: origin } : {}
}

/**
 * Read the parent launcher's URL out of the environment. Only an `http:` or
 * `https:` URL is accepted, and it is returned as a bare origin: the value is
 * navigated to by the browser and echoed to the desktop shell's trust list, so
 * a malformed or non-web value must degrade to "no parent launcher" rather
 * than be passed along.
 */
export function readHomeUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[HOME_URL_ENV]?.trim()
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

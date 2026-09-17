/**
 * Is the launcher an editor calls "home" still there?
 *
 * An editor spawned by a launcher answers `GET /api/editor/home` with the
 * URL its parent handed it in `DESDE_HOME_URL` (see `home-url.ts`). That URL
 * is not a fact about the present: it is what was true at spawn time. The
 * launcher is a separate process and can be gone while this editor keeps
 * running — MEASURED 2026-09-17, where a desktop update path killed the
 * launcher and left the editor alive, and clicking Home pointed the window
 * at a port with nothing behind it.
 *
 * So the URL is probed before it is handed over, and a dead parent falls
 * back to the lazy start that an editor with no parent already uses.
 *
 * ## Why this asks "are you a LAUNCHER" and not "is anything there"
 *
 * A freed port gets reused. If some unrelated dev server has taken it, a
 * bare "did anything answer" check passes and the user's window navigates
 * to a stranger's page — a worse outcome than the dead port, because it
 * looks like it worked. The launcher therefore answers this one route with
 * its role, and nothing else does: an editor serves no such route, so an
 * editor on that port reads as dead, which is the correct answer to the
 * question actually being asked.
 *
 * The probe carries no credential and the answer carries no secret. That is
 * deliberate: identifying the surface must not mean fetching the launcher's
 * bootstrap script, which would pull that launcher's session token into this
 * process for no reason beyond a liveness check.
 *
 * ## What this is NOT
 *
 * `role` is not authentication, and this does not defend against a hostile
 * local process. Anything that can bind the freed port can answer with that
 * JSON. It is guarded against ACCIDENT — the unrelated dev server that took
 * the port — and that is the whole claim.
 *
 * The reason it stops there is a decision this codebase has already made
 * elsewhere: on a loopback port, being local IS the credential. A process
 * that can bind a freed port can also `GET /__desde/bootstrap.js` from the
 * live editor, which is unauthenticated by design because it is what
 * delivers the session token to the page — so such a process already drives
 * the whole editor API, including writes to the user's source. An
 * authenticated challenge here would raise the bar on one route while that
 * one stays open, which is not a threat model, it is a patch. Note also
 * that the code this replaces handed over the same port with NO check at
 * all, so nothing here is a step back.
 *
 * ## The answer is point-in-time, and that gap stays open
 *
 * A launcher can pass this probe and exit before the browser arrives. That
 * is not closable from here: only the navigation itself knows whether it
 * landed, so the real answer is for the shell to recover from a failed hop,
 * which is a separate piece of work. What the probe closes is the case that
 * actually happened — a launcher gone for minutes or hours, with every click
 * failing the same way. The race it leaves is milliseconds wide and self-
 * corrects on the next click.
 */

/** The launcher's unauthenticated liveness route. Served by `launcher-server.ts`. */
export const LAUNCHER_ALIVE_PATH = "/__desde/launcher-alive"

/** What the launcher reports as its role. An editor never reports this. */
export const LAUNCHER_ROLE = "launcher"

export interface LauncherLivenessOptions {
  /** Injected in tests. Default: global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Bound on the whole round trip, body included. A port that accepts and
   * then says nothing must fail the click, not hang it — the caller is a
   * request handler with a user waiting on it.
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 1500

/**
 * True only when `origin` is served by a live Desde launcher right now.
 * Never throws: every failure — refused, timed out, wrong shape, wrong role
 * — is the same answer, because the caller does the same thing with all of
 * them.
 */
export async function isLauncherAlive(
  origin: string,
  opts: LauncherLivenessOptions = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const res = await fetchImpl(`${origin}${LAUNCHER_ALIVE_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      // `fetch` follows redirects by default, which would let this answer a
      // question nobody asked. The caller hands THIS origin to the browser,
      // so "a launcher answered" has to mean "a launcher answered HERE" — a
      // server on the reused port that 302s to a real launcher would
      // otherwise pass the role check on that launcher's behalf and send the
      // window to itself instead.
      redirect: "error",
      // `fetch` follows redirects by default, which would let this answer a
      // question nobody asked. The caller hands THIS origin to the browser,
      // so "a launcher answered" has to mean "a launcher answered HERE" — a
      // server on the reused port that 302s to a real launcher would
      // otherwise pass the role check on that launcher's behalf and send the
      // window to itself instead.
    })
    if (!res.ok) return false
    // `res.json()` on a stranger's endpoint could be anything, including a
    // stream that never ends; the abort signal covers the body read too, so
    // the timeout above bounds this line as well as the headers.
    const body: unknown = await res.json()
    return (body as { role?: unknown } | null)?.role === LAUNCHER_ROLE
  } catch {
    return false
  }
}

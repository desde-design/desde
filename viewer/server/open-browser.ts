/**
 * Opening the browser when the viewer starts.
 *
 * The two surfaces had different on-ramps and only one of them was good. The
 * Editor CLI opens your browser for you (`tryOpenBrowser` in
 * `editor-cli/src/cli.ts`, with `--no-open` to decline). The Viewer printed a
 * URL and waited for you to find the terminal, find the line, and copy it.
 * Mo, 2026-09-01: "we are setting up an expectation that npm run dev opens a
 * tab."
 *
 * So the rule is the plain one: every run opens a tab. What we open depends
 * on what the deployment can offer, and the difference is invisible to the
 * reader either way:
 *
 * - No GitHub sign-in configured, so a local sign-in link was minted: open
 *   THAT, token and all, and the tab lands signed in. Not a new exposure.
 *   The token is already printed to stdout, it is minted only when there is
 *   no other way in, and it means nothing to anyone who cannot already reach
 *   this machine's loopback address.
 * - Otherwise: open the dashboard. GitHub is the way in from there.
 *
 * ## The one thing this must not do
 *
 * `npm run dev` is `tsx watch server/index.ts`. Every file save restarts the
 * server, and a tab per keystroke is worse than the problem this fixes. But
 * "open only once, ever" is not the fix either: it would mean next week's
 * `npm run dev` opens nothing, which is exactly the expectation Mo is asking
 * for.
 *
 * The distinction that matters is a FRESH RUN versus a WATCH RESTART, and
 * the supervisor's pid separates them cleanly. `tsx watch` respawns the
 * server as its own child, so `process.ppid` is stable across every restart
 * within one `npm run dev`, and different the next time you start one. We
 * record the pid we opened for; a boot whose parent already got its tab does
 * not get another.
 *
 * Pid reuse could in principle skip one tab. That is the correct direction
 * to fail in: the URL is on screen either way, and a spurious tab is the
 * thing worth avoiding.
 */

import { spawn } from "node:child_process"

/**
 * Just enough of `spawn` for this file, so a test can hand in a child that
 * fails the way a missing binary really does: asynchronously, by emitting
 * `error`. Injecting the function is the only way to exercise that on a
 * machine where the real opener exists.
 */
export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: "ignore"; detached: boolean },
) => { on: (event: "error", cb: (err: Error) => void) => unknown; unref: () => unknown }

/** What `decideBrowserOpen` needs. Every field is a fact the caller already has. */
export interface BrowserOpenInputs {
  /** Where the viewer is reachable. Always present, and the fallback target. */
  dashboardUrl: string
  /**
   * The boot-printed local sign-in URL when one was minted, else null. Minted
   * only when no GitHub sign-in is configured. Preferred when present because
   * it lands the tab signed in rather than on a sign-in wall.
   */
  signInUrl: string | null
  /** `browserOpenedForPpid` from the runtime config: the supervisor we last opened for. */
  lastOpenedForPpid: number | undefined
  /** This process's parent pid. Stable across `tsx watch` restarts, new per run. */
  currentPpid: number
  /**
   * Whether stdout is a terminal. A viewer under systemd, Docker or CI has no
   * desktop to open onto, and an opener there is at best a wasted process.
   */
  isInteractive: boolean
  /** Raw `VIEWER_OPEN_BROWSER`. `off` declines, matching `VIEWER_DEMO_PROJECT=off`. */
  envValue: string | undefined
}

export type BrowserOpenDecision =
  | { open: true; url: string; ppid: number }
  | { open: false; reason: "disabled" | "not-interactive" | "already-opened-this-run" }

/**
 * Pure: decides whether this boot opens a browser, which URL, and says why not.
 *
 * Split from the spawning so the interesting half is testable without a child
 * process or a desktop. Reasons are returned rather than logged so a test can
 * assert which rule fired, not merely that nothing happened.
 */
export function decideBrowserOpen(inputs: BrowserOpenInputs): BrowserOpenDecision {
  if (inputs.envValue?.trim().toLowerCase() === "off") return { open: false, reason: "disabled" }
  if (!inputs.isInteractive) return { open: false, reason: "not-interactive" }
  if (inputs.lastOpenedForPpid === inputs.currentPpid) {
    return { open: false, reason: "already-opened-this-run" }
  }
  return {
    open: true,
    url: inputs.signInUrl ?? inputs.dashboardUrl,
    ppid: inputs.currentPpid,
  }
}

/**
 * Hands a URL to the platform's opener. Never throws, never blocks shutdown.
 *
 * Same three-platform shape the Editor CLI uses, and deliberately no `open`
 * package for one feature. `detached` + `unref` so a browser outliving this
 * process cannot hold the event loop open, and `stdio: "ignore"` so a chatty
 * opener cannot interleave with the boot banner.
 */
export function openUrl(url: string, spawnFn: SpawnLike = spawn): boolean {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawnFn(cmd, args, { stdio: "ignore", detached: true })
    // REQUIRED, not defensive. A missing binary does not throw here: `spawn`
    // reports `ENOENT` by emitting an `error` event on the child, later, and
    // an `error` event with no listener is re-thrown by EventEmitter as an
    // uncaught exception. So the `catch` below never sees it and the process
    // DIES. On a Linux host with no `xdg-open` (a minimal install, a container,
    // an SSH session) that is the viewer exiting moments after it began
    // listening, for a convenience feature.
    //
    // Found by a codex review of this file, which is worth recording: the
    // `try`/`catch` reads as if it handles this and does not.
    child.on("error", () => {
      // A machine with no opener is not a boot failure. The URL is on screen.
    })
    child.unref()
    return true
  } catch {
    // Kept for the synchronous failures that DO throw here, such as an
    // invalid argument shape.
    return false
  }
}

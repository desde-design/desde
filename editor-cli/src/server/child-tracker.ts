/**
 * Tracks child processes the launcher spawns (per-project editors), so
 * launcher shutdown can terminate them instead of leaving them orphaned.
 *
 * Why this exists: `defaultSpawnEditor` (launcher-server.ts) spawns a child
 * with `detached: false` and then never records it anywhere. In a terminal
 * that is invisible — Ctrl-C sends SIGINT to the whole foreground process
 * group, so the child dies for free. It stops being invisible the moment
 * something signals the launcher's PID specifically, which is exactly what
 * an Electron main process does on app quit: that signal reaches the
 * launcher and nothing else, because Node gives no free ride to
 * grandchildren. The launcher has to remember what it spawned and kill it
 * itself.
 */

import type { ChildProcess } from "node:child_process"

/**
 * Sends one signal to one child. A separate type (not a bare `child.kill`
 * call inlined below) so tests can inject a fake that records calls and
 * drives a fake child's `exit` event, instead of spawning a real process and
 * waiting out a real grace period to prove escalation happens.
 */
export type Killer = (child: ChildProcess, signal: NodeJS.Signals) => void

const defaultKiller: Killer = (child, signal) => {
  try {
    child.kill(signal)
  } catch {
    // A child that exited in the window between "still tracked" and "signal
    // sent" throws ESRCH here. It is already gone, which is the outcome we
    // wanted, so there is nothing to do.
  }
}

/**
 * Grace period between SIGTERM and the SIGKILL escalation.
 *
 * A supervised dev server needs a moment to close its listen sockets and any
 * open HMR websockets cleanly — the Next host's own `close()`
 * (`src/hosts/next/host.ts`) exists BECAUSE a bare `server.close()` can wait
 * on a keep-alive connection, and calls `closeAllConnections()` first to
 * avoid exactly that stall. 4 seconds is comfortably above what a clean
 * close takes in practice, while staying well under a duration a person
 * watching an app quit would call "hung."
 */
export const DEFAULT_KILL_GRACE_MS = 4000

export interface ChildTrackerOptions {
  /** Defaults to real `child.kill(signal)`. Override in tests. */
  killer?: Killer
  /** Defaults to {@link DEFAULT_KILL_GRACE_MS}. Override in tests. */
  graceMs?: number
}

export interface ChildTracker {
  /**
   * Start tracking a freshly spawned child. Stops tracking it on its own,
   * the moment it exits — a child that already died needs no signal later,
   * and holding onto its handle past that point risks the tracker one day
   * signaling a PID the OS has since recycled for an unrelated process.
   *
   * Once {@link ChildTracker.shutdown} has begun, a child handed to `track`
   * is NOT added to the tracked set — `shutdown()` already took its
   * snapshot and nothing will ever iterate over this set again, so adding
   * to it would just leak the handle silently. Instead the child is
   * terminated immediately, via the same SIGTERM→SIGKILL escalation
   * `shutdown()` itself uses. This closes a narrower version of the exact
   * leak the tracker exists to prevent: `defaultSpawnEditor`
   * (launcher-server.ts) can be mid-flight — past its last `await`, e.g.
   * still inside `pickFreePort()` — when `shutdown()` runs; without this,
   * its eventual `track(child)` call would add a handle to a set nobody
   * will ever look at again, orphaning the child forever.
   */
  track(child: ChildProcess): void
  /**
   * Terminate every still-tracked child: SIGTERM first, then SIGKILL for
   * anyone still alive after the grace period. Resolves once every child
   * this call started with has exited (or was already dead). Safe with zero
   * tracked children, and safe to call more than once — a second call has
   * nothing left to do and resolves immediately.
   *
   * Sets the tracker into its closing state as the FIRST thing it does,
   * synchronously, before any `await` — see {@link track}'s doc comment.
   * Because Node never interleaves synchronous code, any `track()` call
   * that has not already run to completion by the time `shutdown()` is
   * invoked is guaranteed to observe the closing state, however long that
   * `track()` call's own caller takes to reach it.
   */
  shutdown(): Promise<void>
  /**
   * True once `shutdown()` has been called (even if it hasn't resolved
   * yet). A spawn path can check this immediately before its own `spawn()`
   * call — with no `await` in between the check and the spawn+`track()`
   * pair — to refuse starting a new child at all once the tracker is
   * closing, rather than relying solely on `track()`'s immediate-kill
   * backstop. That avoids the user-visible "born and killed" case: a
   * process that exists just long enough to be handed a signal. See
   * `defaultSpawnEditor` in launcher-server.ts.
   */
  isClosing(): boolean
}

export function createChildTracker(opts: ChildTrackerOptions = {}): ChildTracker {
  const killer = opts.killer ?? defaultKiller
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS
  const children = new Set<ChildProcess>()
  let closing = false

  function track(child: ChildProcess): void {
    if (closing) {
      // See the doc comment above: shutdown()'s snapshot is already taken
      // (or, for zero-tracked-children shutdowns, already resolved) and
      // nothing will ever revisit `children` again. Fire-and-forget is
      // correct here, not a shortcut — `terminate()` never rejects (its
      // `killer` catches its own failures), so there is no unhandled
      // rejection, and `track()`'s own signature is synchronous `void`.
      void terminate(child, killer, graceMs)
      return
    }
    children.add(child)
    child.once("exit", () => {
      children.delete(child)
    })
  }

  async function shutdown(): Promise<void> {
    // First statement, no `await` above it — see `isClosing`'s doc comment
    // for why that ordering is what makes the closing state race-free.
    closing = true
    // Snapshot-and-clear rather than iterate-in-place: a second `shutdown()`
    // call (concurrent, or a caller that awaits it twice) must see an empty
    // set and do nothing, not re-signal whatever the first call already
    // handed a SIGTERM.
    const targets = Array.from(children)
    children.clear()
    await Promise.all(targets.map((child) => terminate(child, killer, graceMs)))
  }

  function isClosing(): boolean {
    return closing
  }

  return { track, shutdown, isClosing }
}

/** Waits for one child to exit, escalating SIGTERM to SIGKILL after `graceMs`. */
function terminate(child: ChildProcess, killer: Killer, graceMs: number): Promise<void> {
  // Exited in the gap between the snapshot in shutdown() and here — its own
  // `exit` listener already untracked it, and nothing needs signaling.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    child.once("exit", () => {
      if (settled) return
      settled = true
      clearTimeout(escalate)
      resolve()
    })

    const escalate = setTimeout(() => {
      if (settled) return
      killer(child, "SIGKILL")
    }, graceMs)
    // A shutdown sweep waiting on a hung child must never be the reason the
    // launcher process itself stays alive — this timer alone must not hold
    // the event loop open.
    escalate.unref()

    killer(child, "SIGTERM")
  })
}

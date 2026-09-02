/**
 * The decision half of the browser open. `openUrl` itself is not covered
 * here on purpose: it spawns a platform binary, and a test that stubbed
 * `child_process` would assert the stub was called, not that a browser
 * opens. The rules below are the part that can be wrong.
 */
import { describe, expect, it } from "vitest"
import { decideBrowserOpen, openUrl, type BrowserOpenInputs } from "./open-browser"

const DASHBOARD = "http://localhost:3100"
const SIGN_IN = "http://localhost:3100/api/v1/auth/local?token=abc"

/** A fresh `npm run dev` on a laptop: the case that opens. */
function freshRun(overrides: Partial<BrowserOpenInputs> = {}): BrowserOpenInputs {
  return {
    dashboardUrl: DASHBOARD,
    signInUrl: SIGN_IN,
    lastOpenedForPpid: undefined,
    currentPpid: 4242,
    isInteractive: true,
    envValue: undefined,
    ...overrides,
  }
}

describe("decideBrowserOpen", () => {
  it("opens the signed-in URL when a local sign-in link exists, so the tab lands past the wall", () => {
    expect(decideBrowserOpen(freshRun())).toEqual({ open: true, url: SIGN_IN, ppid: 4242 })
  })

  it("still opens a tab when GitHub is configured, falling back to the dashboard", () => {
    // Mo, 2026-09-01: the expectation is that `npm run dev` opens a tab, not
    // that it opens one only on deployments that print a token.
    expect(decideBrowserOpen(freshRun({ signInUrl: null }))).toEqual({
      open: true,
      url: DASHBOARD,
      ppid: 4242,
    })
  })

  it("does not open again for the same supervisor, so `tsx watch` restarts do not spawn a tab per keystroke", () => {
    expect(decideBrowserOpen(freshRun({ lastOpenedForPpid: 4242 }))).toEqual({
      open: false,
      reason: "already-opened-this-run",
    })
  })

  it("opens again for a NEW supervisor, so tomorrow's `npm run dev` still gets its tab", () => {
    // The failure mode of a naive "open once ever" marker: this case would
    // silently stop opening after the first run in a data directory.
    const decision = decideBrowserOpen(freshRun({ lastOpenedForPpid: 4242, currentPpid: 9999 }))
    expect(decision).toEqual({ open: true, url: SIGN_IN, ppid: 9999 })
  })

  it("does not open without a terminal, so systemd and Docker do not spawn an opener onto no desktop", () => {
    expect(decideBrowserOpen(freshRun({ isInteractive: false }))).toEqual({
      open: false,
      reason: "not-interactive",
    })
  })

  it("declines on VIEWER_OPEN_BROWSER=off, matching VIEWER_DEMO_PROJECT=off", () => {
    expect(decideBrowserOpen(freshRun({ envValue: "off" }))).toEqual({
      open: false,
      reason: "disabled",
    })
  })

  it("reads the off switch case-insensitively and ignores surrounding whitespace", () => {
    for (const value of ["OFF", " off ", "Off"]) {
      expect(decideBrowserOpen(freshRun({ envValue: value })).open).toBe(false)
    }
  })

  it("treats any other value as unset rather than guessing, so a typo cannot silently disable it", () => {
    for (const value of ["on", "true", "1", "yes", ""]) {
      expect(decideBrowserOpen(freshRun({ envValue: value })).open).toBe(true)
    }
  })

  it("checks the off switch first, so the opt-out holds on a fresh run in a terminal", () => {
    expect(
      decideBrowserOpen(freshRun({ envValue: "off", isInteractive: true, lastOpenedForPpid: undefined })),
    ).toEqual({ open: false, reason: "disabled" })
  })

  it("returns the pid it opened for, so the caller records the right one", () => {
    const decision = decideBrowserOpen(freshRun({ currentPpid: 777 }))
    expect(decision.open && decision.ppid).toBe(777)
  })
})

/**
 * A missing opener must not take the process down with it.
 *
 * `spawn` does NOT throw for a nonexistent binary. It returns a child and
 * then emits `error` on it, and an `error` event with no listener is
 * re-thrown by EventEmitter as an uncaught exception. So the `try`/`catch`
 * in `openUrl` reads as if it covers this and does not: on a Linux host with
 * no `xdg-open` the viewer would exit moments after it began listening, for
 * a convenience feature. Found by a codex review.
 *
 * The fake below fails the way the real thing does, because on this machine
 * the real opener exists and cannot be made to fail.
 */
describe("openUrl when the platform opener is missing", () => {
  /** A child that reports ENOENT asynchronously, as `spawn` really does. */
  function spawnMissingBinary() {
    const listeners: ((err: Error) => void)[] = []
    let emitted = false
    const child = {
      on: (_event: "error", cb: (err: Error) => void) => {
        listeners.push(cb)
        return child
      },
      unref: () => child,
    }
    // Emit on the next tick, after openUrl has returned, exactly like spawn.
    queueMicrotask(() => {
      emitted = true
      const err = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })
      if (listeners.length === 0) {
        // What Node does with an unhandled 'error' event. Reproducing it here
        // is what makes this test fail against the unfixed code instead of
        // passing silently.
        throw err
      }
      for (const cb of listeners) cb(err)
    })
    return { child, hasListener: () => listeners.length > 0, didEmit: () => emitted }
  }

  it("attaches an error listener, so the async ENOENT is handled rather than thrown", async () => {
    const fake = spawnMissingBinary()
    const result = openUrl("http://localhost:3100", () => fake.child)

    // It still reports success: the spawn itself was accepted, and the URL is
    // printed on screen regardless.
    expect(result).toBe(true)
    // The listener must be attached BEFORE the event fires, which is the fix.
    expect(fake.hasListener()).toBe(true)

    // Let the microtask run. Against the unfixed code this throws.
    await Promise.resolve()
    expect(fake.didEmit()).toBe(true)
  })
})

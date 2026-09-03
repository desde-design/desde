/**
 * `createUpdater` — the wiring around the pure reducer (`updater-reducer.ts`,
 * tested separately and thoroughly there): "checking is always on" (initial
 * check + the 4h timer), `autoDownload`/`autoInstallOnAppQuit` are set on the
 * real event source, `download()`/`restartAndInstall()` are phase-guarded
 * no-ops outside their required state, and `onState` subscribe/unsubscribe
 * works. Uses a small hand-rolled fake for `UpdaterEventSource` (not a real
 * `electron-updater` instance — that needs a real Electron `app`) and an
 * injected `scheduleCheck` so the 4h interval is provoked synchronously
 * instead of waiting on a real timer.
 */
import { describe, expect, it, vi } from "vitest"
import { CHECK_INTERVAL_MS, createUpdater, type UpdaterEventSource } from "../updater.js"

type Listener = (...args: never[]) => void

/** A minimal fake satisfying `UpdaterEventSource`, with `.emit()` for tests to drive events. */
function fakeSource(): UpdaterEventSource & {
  emit: (event: string, ...args: unknown[]) => void
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Listener[]>()
  const on = (event: string, listener: Listener) => {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return source
  }
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
  const source = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    forceDevUpdateConfig: false,
    on: on as UpdaterEventSource["on"],
    emit,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  }
  return source
}

/** Captures the interval callback instead of scheduling a real timer. */
function fakeScheduler() {
  const calls: Array<{ fn: () => void; ms: number }> = []
  let stopped = false
  return {
    schedule: (fn: () => void, ms: number) => {
      calls.push({ fn, ms })
      return { stop: () => { stopped = true } }
    },
    calls,
    isStopped: () => stopped,
    /** Simulates the 4h timer firing. */
    fire: () => calls[0]?.fn(),
  }
}

describe("createUpdater — construction", () => {
  it("sets autoDownload from the option, and forces autoInstallOnAppQuit true", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.autoDownload).toBe(false)
    expect(source.autoInstallOnAppQuit).toBe(true)
  })

  it("does not set forceDevUpdateConfig unless asked", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.forceDevUpdateConfig).toBe(false)
  })

  it("sets forceDevUpdateConfig when the option is passed (the local-feed smoke harness)", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: true, forceDevUpdateConfig: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.forceDevUpdateConfig).toBe(true)
  })
})

describe("createUpdater — checking is always on", () => {
  it("checks once immediately at construction", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("schedules the recheck at the 4h interval, and firing it checks again", () => {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    createUpdater({ autoDownload: true, source, scheduleCheck: scheduler.schedule })
    expect(scheduler.calls).toEqual([{ fn: expect.any(Function), ms: CHECK_INTERVAL_MS }])

    scheduler.fire()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it("dispose() stops the scheduled timer", () => {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: scheduler.schedule })
    updater.dispose()
    expect(scheduler.isStopped()).toBe(true)
  })

  it("a rejected checkForUpdates() surfaces as phase 'error', not an unhandled rejection", async () => {
    const source = fakeSource()
    source.checkForUpdates.mockRejectedValueOnce(new Error("feed unreachable"))
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    // The rejection is handled asynchronously inside createUpdater — give the
    // microtask queue a turn before asserting.
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({ phase: "error", version: undefined, error: "feed unreachable" })
  })

  /**
   * F2 (adversarial review of Phase 4): on-demand "Check for updates" — the
   * third trigger alongside boot and the 4h timer, funneled through the SAME
   * `runCheck()` so it can't drift from either.
   */
  it("checkForUpdates() triggers an on-demand check through the SAME path as boot and the 4h timer", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1) // the construction-time check

    updater.checkForUpdates()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(2)

    updater.checkForUpdates()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(3)
  })

  it("a rejected on-demand checkForUpdates() surfaces as phase 'error' too, not an unhandled rejection", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    source.checkForUpdates.mockRejectedValueOnce(new Error("feed unreachable"))
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()

    expect(updater.getState()).toEqual({ phase: "error", version: undefined, error: "feed unreachable" })
  })

  /**
   * F12 (second adversarial review pass): `electron-updater`'s REAL
   * `AppUpdater.checkForUpdates()` both emits "error" on itself AND rejects
   * the promise it returns, for the SAME underlying failure (confirmed
   * against its own source, not assumed — unlike the fake source's default
   * behavior above, which only does ONE of the two). Without recognizing the
   * two halves as one failure, a single real feed failure would count as two
   * separate errors — the first correctly recognized as the in-flight
   * check's own, the second, "duplicate" arrival then landing as a fresh
   * unrelated failure and wrongly flipping a still-good "available" to
   * "error". (Post-restructure, the emit half is PARKED while the check is
   * unsettled and CLAIMED by the identical rejection — see updater.ts's
   * attribution ladder; the asserted behavior is unchanged.)
   */
  it("a checkForUpdates() failure that BOTH emits 'error' on itself AND rejects (the real electron-updater behavior) does not double-count as two separate errors", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    source.emit("update-available", { version: "1.0.0" })
    // A later recheck starts — updater.ts mints a check operation for it.
    source.emit("checking-for-update")
    // ...and that SAME recheck fails, exactly like the real library: the
    // "error" event fires SYNCHRONOUSLY, and the promise checkForUpdates()
    // returns ALSO rejects, with the EXACT SAME Error object (confirmed
    // against AppUpdater.checkForUpdates()'s own source: it emits, then
    // `throw`s the identical `e` it just emitted — not a separately
    // constructed one, even with the same message, which is what
    // updater.ts's parked-error claim keys on — see the F15 test below for
    // what happens when the objects genuinely differ).
    const feedError = new Error("feed unreachable")
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("error", feedError)
      return Promise.reject(feedError)
    })
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()

    // The check failed, but the "available" update it's unrelated to must
    // still be there — not flipped to "error" by a duplicate dispatch of
    // the exact same underlying failure.
    expect(updater.getState()).toEqual({ phase: "available", version: "1.0.0" })
  })

  /**
   * F15 (third adversarial review pass). The dedup above must key on the
   * exact `Error` OBJECT, not a process-wide "was any error emitted"
   * boolean — otherwise an operation completely UNRELATED to the current
   * check (e.g. a manual `download()` failing while a recheck happens to
   * be in flight) sets the same flag a boolean would have used, and the
   * check's own later, genuinely DISTINCT rejection gets wrongly
   * suppressed too. Simulated at the electron-updater boundary: two
   * DIFFERENT Error instances, one from an unrelated emit, one that the
   * check's own promise actually rejects with — a test that only checked
   * the wrapper's own structure (e.g. call counts) would not catch a
   * regression here, since the bug is specifically about which OBJECT two
   * failures share.
   */
  it("an unrelated error emitted while a check is pending does not suppress the check's OWN later, genuinely distinct failure (F15 — dedup by Error object identity, not a shared flag)", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    let rejectCheck: ((err: Error) => void) | undefined
    source.checkForUpdates.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectCheck = reject }),
    )
    updater.checkForUpdates() // the check is now pending

    // WHILE it's pending, an unrelated operation (e.g. a manual download())
    // emits its own, different error — this is what would have set a
    // process-wide dedup flag under the pre-F15 implementation.
    source.emit("error", new Error("download failed: disk full"))

    // The check's OWN promise later rejects — WITHOUT its own "error" emit
    // (a malformed feed config, runCheck()'s own documented reason for
    // having this catch handler at all). Nothing else will ever surface
    // this failure if the dedup wrongly treats it as already-reported.
    const checkError = new Error("feed unreachable")
    rejectCheck?.(checkError)
    await Promise.resolve()
    await Promise.resolve()

    // Must reflect the CHECK's own failure — not silently dropped because
    // an unrelated, DIFFERENT error object happened to fire while it was
    // pending.
    expect(updater.getState()).toEqual({ phase: "error", version: undefined, error: "feed unreachable" })
  })
})

/**
 * F1 (whole-branch review, merge blocker; P1 fix on second pass): a
 * packaged app with no `app-update.yml` yet must never run a real check —
 * the real `electron-updater` does a plain `readFile` of that path and
 * ENOENTs, which (correctly) surfaces as a permanent, recurring
 * `phase: "error"`. `main.ts`'s `boot()` passes `shouldSkipCheck` as a
 * CALLBACK (re-invoking `update-feed-guard.ts`'s `shouldSkipUpdateChecks`,
 * tested separately by injection in `update-feed-guard.test.ts`) rather than
 * a one-time boolean — this block is the other half: `runCheck()` consults
 * that callback on EVERY trigger, so it can skip on one call and stop
 * skipping on the next with no special-casing.
 */
describe("createUpdater — shouldSkipCheck (F1, whole-branch review, merge blocker; P1 fix)", () => {
  it("direction 1 (the original bug): never calls the real checkForUpdates() at construction, and stays at idle — the exact case that used to ENOENT into a permanent error", () => {
    const source = fakeSource()
    // Reproduces the real failure this guard exists for: even if the
    // underlying source WOULD reject with the feed-file ENOENT,
    // shouldSkipCheck() returning true must prevent it from ever being
    // asked.
    source.checkForUpdates.mockRejectedValue(
      new Error("ENOENT: no such file or directory, open 'Resources/app-update.yml'"),
    )
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => true,
    })

    expect(source.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getState()).toEqual({ phase: "idle" })
  })

  it("direction 2 (the P1 gap): when shouldSkipCheck() returns false, a real ENOENT/corrupt-feed rejection still surfaces as phase 'error' — a configured-but-broken feed must not be silenced by this guard's mere presence", async () => {
    const source = fakeSource()
    source.checkForUpdates.mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory, open 'Resources/app-update.yml'"),
    )
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => false,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.getState()).toEqual({
      phase: "error",
      version: undefined,
      error: "ENOENT: no such file or directory, open 'Resources/app-update.yml'",
    })
  })

  it("STILL schedules the 4h recheck timer even while shouldSkipCheck() currently returns true — P1 fix: the timer must not go unscheduled just because the first answer was 'skip'", () => {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: scheduler.schedule,
      shouldSkipCheck: () => true,
    })
    expect(scheduler.calls).toEqual([{ fn: expect.any(Function), ms: CHECK_INTERVAL_MS }])
  })

  it("P1 fix: the 4h timer RECONSIDERS on every fire — a later firing after shouldSkipCheck() flips to false runs the real check", () => {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    let skip = true
    createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: scheduler.schedule,
      shouldSkipCheck: () => skip,
    })
    expect(source.checkForUpdates).not.toHaveBeenCalled() // construction skipped

    scheduler.fire() // still skipping
    expect(source.checkForUpdates).not.toHaveBeenCalled()

    skip = false // the stamp now confirms a publish provider is configured
    scheduler.fire()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1) // this firing did NOT skip
  })

  it("P1 fix: the on-demand path RECONSIDERS on every call — a click after shouldSkipCheck() flips to false runs the real check", async () => {
    const source = fakeSource()
    let skip = true
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => skip,
    })

    await updater.checkForUpdates()
    expect(source.checkForUpdates).not.toHaveBeenCalled()

    skip = false
    await updater.checkForUpdates()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("dispose() is still safe to call — the timer is real (not a no-op stub) even while skipping", () => {
    const source = fakeSource()
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => true,
    })
    expect(() => updater.dispose()).not.toThrow()
  })

  it("download()/restartAndInstall() stay the same harmless no-ops as any other idle state (nothing ever leaves idle to make them do otherwise)", async () => {
    const source = fakeSource()
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => true,
    })
    await updater.download()
    expect(source.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.restartAndInstall()).toBe(false)
    expect(source.quitAndInstall).not.toHaveBeenCalled()
  })

  it("omitting shouldSkipCheck defaults to never skipping — the option is additive, not required", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

/**
 * F3 (whole-branch review, Important; P2 fix on second pass):
 * `checkForUpdates()` now returns a promise resolving once THAT call's own
 * check has settled, so a caller (the IPC handler) can know precisely when
 * to read `getState()` instead of guessing a timeout window — see
 * `Updater`'s doc comment on the method.
 */
/**
 * F3 (P2 fix): `checkForUpdates()` resolves precisely when its own check
 * settles. F8 (whole-branch review, third pass, P2 fix) added the resolved
 * `{ performed }` field: `getState()` reading "idle" cannot tell "checked,
 * nothing new" apart from "nothing was actually checked" (a packaged build
 * with no publish provider configured, or electron-updater's own
 * unpackaged-dev no-op) — `performed` is the caller's only reliable signal.
 */
describe("createUpdater — checkForUpdates() return value (F3, P2 fix; F8, third pass, P2 fix)", () => {
  it("resolves {performed:true} once the check concludes via an emit (update-not-available)", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    await Promise.resolve()
    await Promise.resolve()

    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return Promise.resolve(null)
    })

    let resolved: { performed: boolean } | null = null
    const promise = updater.checkForUpdates().then((result) => {
      resolved = result
    })
    expect(resolved).toBeNull() // still checking

    source.emit("update-not-available")
    await promise
    expect(resolved).toEqual({ performed: true })
    expect(updater.getState()).toEqual({ phase: "idle" })
  })

  it("resolves even after an arbitrarily long-pending response — no timeout window at all (P2: electron-updater's own HTTP layer allows up to ~60s, the old fix's 30s arm window could race and lose)", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    // Let construction's own (fast, default-mocked) check settle first, so
    // the slow mock armed below governs OUR call, not the construction one.
    await Promise.resolve()
    await Promise.resolve()

    let resolveCheck: ((result: unknown) => void) | undefined
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise((resolve) => { resolveCheck = resolve })
    })

    let resolved: { performed: boolean } | null = null
    const promise = updater.checkForUpdates().then((result) => {
      resolved = result
    })

    // Flush many microtask turns with the underlying request still
    // unsettled. There is no wall-clock timer on our side at all anymore —
    // that's the point: nothing here COULD time this out, no matter how
    // many turns pass.
    for (let i = 0; i < 100; i++) await Promise.resolve()
    expect(resolved).toBeNull() // still genuinely pending, not falsely resolved

    source.emit("update-not-available")
    resolveCheck?.(null)
    await promise
    expect(resolved).toEqual({ performed: true })
    expect(updater.getState()).toEqual({ phase: "idle" })
  })

  it("resolves {performed:true} (never rejects) on a check failure — the failure is reported through getState(), not by throwing", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    await Promise.resolve()
    await Promise.resolve()

    // Reproduces the real library: checking-for-update is emitted
    // synchronously at the top of doCheckForUpdates(), UNCONDITIONALLY,
    // before any await — so a real check attempt can never fail without
    // one, even an immediate failure (verified against the installed
    // electron-updater 6.8.9 source).
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return Promise.reject(new Error("feed unreachable"))
    })

    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: true })
    expect(updater.getState()).toEqual({ phase: "error", version: undefined, error: "feed unreachable" })
  })

  it("resolves {performed:false} immediately when shouldSkipCheck() says skip, without calling the real source", async () => {
    const source = fakeSource()
    const updater = createUpdater({
      autoDownload: true,
      source,
      scheduleCheck: fakeScheduler().schedule,
      shouldSkipCheck: () => true,
    })
    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: false })
    expect(source.checkForUpdates).not.toHaveBeenCalled()
  })

  /**
   * F8's core case: `AppUpdater.checkForUpdates()`'s REAL unpackaged-dev
   * no-op (`isUpdaterActive()` false) returns `Promise.resolve(null)` from
   * inside `checkForUpdates()` itself, BEFORE ever calling
   * `doCheckForUpdates()` — the method that emits `checking-for-update` —
   * verified against the installed 6.8.9 source. So the promise resolves
   * successfully with no emit at all: the exact shape this test reproduces
   * at the fake-source boundary. `shouldSkipCheck()` is NOT involved here
   * (it defaults to false / not configured) — this is electron-updater's
   * OWN no-op, a second, independent way to reach "resolved, nothing
   * checked".
   */
  it("F8: resolves {performed:false} when the source resolves WITHOUT ever emitting checking-for-update — the real electron-updater unpackaged-dev no-op shape", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    await Promise.resolve()
    await Promise.resolve()

    source.checkForUpdates.mockImplementationOnce(() => Promise.resolve(null))

    const result = await updater.checkForUpdates()
    expect(result).toEqual({ performed: false })
    expect(updater.getState()).toEqual({ phase: "idle" })
  })

  it("F8: a shared in-flight check (electron-updater reuses the promise) still reports {performed:true} for the SECOND caller", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    await Promise.resolve()
    await Promise.resolve()

    let resolveShared: ((result: unknown) => void) | undefined
    const shared = new Promise((resolve) => { resolveShared = resolve })
    source.checkForUpdates.mockImplementation(() => {
      // Real 6.8.9 emits checking-for-update once and returns the SAME
      // promise to every caller while one is in flight.
      source.emit("checking-for-update")
      return shared
    })

    const first = updater.checkForUpdates()
    const second = updater.checkForUpdates()
    resolveShared?.(null)
    source.emit("update-not-available")

    await expect(first).resolves.toEqual({ performed: true })
    await expect(second).resolves.toEqual({ performed: true })
  })
})

describe("createUpdater — event wiring drives getState/onState", () => {
  it("relays checking -> available -> downloading -> ready through to getState", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    source.emit("checking-for-update")
    expect(updater.getState()).toEqual({ phase: "checking" })

    source.emit("update-available", { version: "1.4.0" })
    expect(updater.getState()).toEqual({ phase: "available", version: "1.4.0" })

    source.emit("download-progress", { percent: 50 })
    expect(updater.getState()).toEqual({ phase: "downloading", version: "1.4.0", progressPercent: 50 })

    source.emit("update-downloaded", { version: "1.4.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.4.0" })
  })

  it("onState notifies subscribers on each real transition, and the returned unsubscribe stops further notifications", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    const states: unknown[] = []
    const unsubscribe = updater.onState((s) => states.push(s))

    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.0.0" })
    expect(states).toEqual([{ phase: "checking" }, { phase: "available", version: "1.0.0" }])

    unsubscribe()
    source.emit("download-progress", { percent: 10 })
    expect(states).toHaveLength(2) // no third entry — unsubscribed before this event
  })

  it("does not notify subscribers for a guarded no-op transition (duplicate/out-of-order event)", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    const states: unknown[] = []
    updater.onState((s) => states.push(s))

    source.emit("update-downloaded", { version: "1.0.0" })
    expect(states).toEqual([{ phase: "ready", version: "1.0.0" }])

    // Late progress after "ready" is a reducer no-op (see updater-reducer.test.ts) —
    // must not fire a redundant notification.
    source.emit("download-progress", { percent: 99 })
    expect(states).toHaveLength(1)
  })

  it("relays a real error event to phase 'error'", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("error", new Error("disk full"))
    expect(updater.getState()).toEqual({ phase: "error", version: undefined, error: "disk full" })
  })
})

describe("createUpdater — download()", () => {
  it("calls downloadUpdate() when phase is 'available'", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("update-available", { version: "1.0.0" })

    await updater.download()
    expect(source.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it("is a no-op outside phase 'available' — never calls downloadUpdate()", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })

    // Straight from idle.
    await updater.download()
    expect(source.downloadUpdate).not.toHaveBeenCalled()

    // Already downloading.
    source.emit("update-available", { version: "1.0.0" })
    source.emit("download-progress", { percent: 20 })
    await updater.download()
    expect(source.downloadUpdate).not.toHaveBeenCalled()

    // Already ready.
    source.emit("update-downloaded", { version: "1.0.0" })
    await updater.download()
    expect(source.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe("createUpdater — restartAndInstall()", () => {
  it("calls quitAndInstall() only when phase is 'ready', and its return value reports whether it did (F10 — restart-and-install.ts depends on this)", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    expect(updater.restartAndInstall()).toBe(false)
    expect(source.quitAndInstall).not.toHaveBeenCalled()

    source.emit("update-available", { version: "1.0.0" })
    expect(updater.restartAndInstall()).toBe(false)
    expect(source.quitAndInstall).not.toHaveBeenCalled()

    source.emit("update-downloaded", { version: "1.0.0" })
    expect(updater.restartAndInstall()).toBe(true)
    expect(source.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  /**
   * F14 (third adversarial review pass). `BaseUpdater.quitAndInstall()`
   * (electron-updater's real implementation) can decline SYNCHRONOUSLY —
   * confirmed against its own source: `install()` returns `false` when e.g.
   * the downloaded installer has disappeared from disk, and when it does,
   * `quitAndInstall()` never reaches the `setImmediate` that would fire
   * `before-quit-for-update` and quit. It instead calls `dispatchError()`,
   * which `emit`s "error" on the SAME `source` — SYNCHRONOUSLY, before
   * `quitAndInstall()` returns. The fake source's `quitAndInstall` mock
   * below reproduces EXACTLY that: emitting "error" itself, the way the
   * real library's failure path does, rather than just asserting on the
   * wrapper's own structure.
   */
  it("returns false when quitAndInstall() declines SYNCHRONOUSLY (simulated at the electron-updater boundary: it emits its own 'error' instead of initiating anything) — not true merely because the method was called (F14)", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("update-available", { version: "1.0.0" })
    source.emit("update-downloaded", { version: "1.0.0" })
    expect(updater.getState().phase).toBe("ready")

    // Reproduces BaseUpdater.install()'s real synchronous-decline path: it
    // emits "error" on `source` via dispatchError(), and does NOT proceed
    // to quit or install anything.
    source.quitAndInstall.mockImplementationOnce(() => {
      source.emit("error", new Error("No update filepath provided, can't quit and install"))
    })

    expect(updater.restartAndInstall()).toBe(false)
    expect(updater.getState().phase).toBe("error")
  })

  it("still returns true when quitAndInstall() does NOT synchronously decline (the normal path — nothing emits 'error')", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("update-available", { version: "1.0.0" })
    source.emit("update-downloaded", { version: "1.0.0" })

    // The default fake quitAndInstall() (a plain vi.fn()) does nothing —
    // matching the real library's success path, where the actual quit/
    // install work happens later via setImmediate or a native call, not
    // synchronously inside this call.
    expect(updater.restartAndInstall()).toBe(true)
    expect(updater.getState().phase).toBe("ready")
  })
})

describe("createUpdater — setAutoDownload", () => {
  it("flips the live source.autoDownload flag immediately, no restart needed", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    expect(source.autoDownload).toBe(true)

    updater.setAutoDownload(false)
    expect(source.autoDownload).toBe(false)

    updater.setAutoDownload(true)
    expect(source.autoDownload).toBe(true)
  })

  /**
   * electron-updater reads `autoDownload` when a check CONCLUDES. A check
   * that starts mid-download and concludes after the zip was handed to
   * Squirrel.Mac would otherwise start a second download from cache — the
   * second native run that deletes the first one's unzip directory (the
   * 2026-09-02 field failure's other ordering). So the live flag is forced
   * off while an update is downloading or ready, and restored after.
   */
  it("forces the live flag off while an update is downloading or ready, and restores it when the update leaves those phases", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    expect(source.autoDownload).toBe(true) // the first download must still start
    source.emit("download-progress", { percent: 40 })
    expect(source.autoDownload).toBe(false)
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(source.autoDownload).toBe(false)
    // A late-concluding recheck finds the same version: nothing new to download.
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    expect(source.autoDownload).toBe(false)
    // The ready update fails its native prep: the flag comes back for the retry.
    source.emit("error", new Error("ditto: Could not lstat …: No such file or directory"))
    expect(updater.getState().phase).toBe("error")
    expect(source.autoDownload).toBe(true)
  })

  it("remembers a toggle made while the flag is forced off, and applies it once the update is gone", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 40 })
    expect(source.autoDownload).toBe(false)
    updater.setAutoDownload(true)
    expect(source.autoDownload).toBe(false) // still in hand
    updater.setAutoDownload(false)
    source.emit("error", new Error("ECONNRESET"))
    expect(source.autoDownload).toBe(false) // the user's latest setting, not the boot value
    updater.setAutoDownload(true)
    expect(source.autoDownload).toBe(true)
  })

  it("leaves the flag off while ready even when the download was manual, so its native prep is protected too", () => {
    const source = fakeSource()
    createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(source.autoDownload).toBe(false)
  })
})

/**
 * The five doors — one bug class ("an outcome belonging to one operation
 * invalidates, or is attributed to, a different operation"), five orderings,
 * each historically fixed as its own patch (F3, F11, F12, F16) until the
 * fifth prompted the structural restructure (operation-attributed events —
 * see updater-reducer.ts's invariant doc comment). All five are asserted here
 * at the library-event boundary, with the fake reproducing 6.8.9's real
 * failure shape (the "error" emit and the promise rejection carry the SAME
 * object for one underlying failure), so this block compiles and runs against
 * the pre-restructure implementation too — which is how each was verified RED
 * against the code that had its door open (doors 1-4 against the commits
 * preceding their original patches, door five and the F14 variant against the
 * last pre-restructure commit).
 */
/**
 * 2026-09-02 field failure: "Update failed: ditto: Could not lstat
 * …/com.desde.editor.ShipIt/update.XXXXXXX/…: No such file or directory".
 * On macOS "ready" is reported when the zip is handed to Squirrel.Mac, which
 * unzips and verifies it afterwards. A check while ready (autoDownload on)
 * re-runs electron-updater's download step from cache, which replaces the
 * native updater, and the replacement's housekeeping deletes every
 * `update.*` directory — the one still being extracted included. Measured
 * end to end by `tasks/scripts/desktop-update-smoke.mts` scenario 4; these
 * pin the wrapper-level rule that closes it: no trigger re-checks while ready.
 */
describe("createUpdater — no re-check while an update is ready", () => {
  function readyUpdater(autoDownload = true) {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    const updater = createUpdater({ autoDownload, source, scheduleCheck: scheduler.schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
    source.checkForUpdates.mockClear()
    return { source, scheduler, updater }
  }

  it("the on-demand check never reaches the source, resolves {performed:false}, and ready stays", async () => {
    const { source, updater } = readyUpdater()
    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: false })
    expect(source.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
  })

  it("the 4h timer never reaches the source either — the periodic path is the same hazard", () => {
    const { source, scheduler, updater } = readyUpdater()
    scheduler.fire()
    expect(source.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
  })

  it("holds with autoDownload off too — a manually downloaded update is just as ready", async () => {
    const { source, updater } = readyUpdater(false)
    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: false })
    expect(source.checkForUpdates).not.toHaveBeenCalled()
  })

  it("a re-check while still DOWNLOADING runs — electron-updater shares the pending download there, which is safe", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 40 })
    source.checkForUpdates.mockClear()
    // The real library concludes only after its HTTP round trip — never
    // synchronously inside the call.
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return Promise.resolve().then(() => {
        source.emit("update-available", { version: "1.2.0" })
        return null
      })
    })
    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: true })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("once the ready update fails (a native-prep error), checking is open again — that is the recovery path", async () => {
    const { source, updater } = readyUpdater()
    source.emit("error", new Error("ditto: Could not lstat …/update.8BFC7tX/…: No such file or directory"))
    expect(updater.getState().phase).toBe("error")
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return Promise.resolve().then(() => {
        source.emit("update-not-available", { version: "1.2.0" })
        return null
      })
    })
    await expect(updater.checkForUpdates()).resolves.toEqual({ performed: true })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe("createUpdater — the five doors (one bug class, five orderings)", () => {
  /** A recheck that fails the way 6.8.9 really fails: `checking-for-update`
   *  emitted at the check's start, then the "error" emit and the rejection
   *  sharing one Error object. */
  function failingRecheck(source: ReturnType<typeof fakeSource>, message: string): Error {
    const failure = new Error(message)
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      source.emit("error", failure)
      return Promise.reject(failure)
    })
    return failure
  }

  it("door one (F3): a later unrelated check's failure does not clobber a ready update", async () => {
    const source = fakeSource()
    const scheduler = fakeScheduler()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: scheduler.schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })

    // Hours later the 4h timer fires — driven through the scheduler rather
    // than the on-demand `updater.checkForUpdates()` on purpose: this door's
    // original scenario IS the periodic recheck, and the timer path predates
    // the on-demand API (which lets this test run, and fail honestly,
    // against the pre-F3 implementation).
    //
    // Since 2026-09-02 the timer never reaches the source while an update
    // is ready (see "no re-check while an update is ready" below), so the
    // failing recheck armed here is never consumed — the door is closed one
    // step earlier. The invariant this door states still holds and is still
    // asserted: ready survives.
    failingRecheck(source, "net::ERR_NETWORK_CHANGED")
    source.checkForUpdates.mockClear()
    scheduler.fire()
    await Promise.resolve()
    await Promise.resolve()

    expect(source.checkForUpdates).not.toHaveBeenCalled()
    // restartAndInstall() must remain live.
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
  })

  it("door two (F11): a mid-download recheck whose failure lands only AFTER the download reached ready does not invalidate that ready", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 40 })

    // The recheck starts while the download is running, but doesn't settle
    // until after the download completes.
    let rejectCheck: ((err: Error) => void) | undefined
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise((_resolve, reject) => {
        rejectCheck = reject
      })
    })
    updater.checkForUpdates()

    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })

    // Only now does the overlapping check fail — emit half then rejection
    // half, same object, like the real library.
    const failure = new Error("net::ERR_NETWORK_CHANGED")
    source.emit("error", failure)
    rejectCheck?.(failure)
    await Promise.resolve()
    await Promise.resolve()

    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
  })

  it("door three (F12): suppressing an unrelated check failure does not also swallow the NEXT genuinely new failure", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })

    failingRecheck(source, "net::ERR_NETWORK_CHANGED")
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()
    // The unrelated check failure was correctly suppressed… (phase-scoped on
    // purpose: this step is scaffolding, and phase-scoping lets the test run
    // against the pre-restructure implementations far enough to fail on THIS
    // door's own claim below, not on their wire-shape leak)
    expect(updater.getState().phase).toBe("available")

    // …and a manual download failing immediately afterward (the library
    // dispatches its failure through the same "error" emit) must still land.
    source.emit("error", new Error("ENOTFOUND: download host unreachable"))
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })
  })

  it("door four (F16): a successfully-concluded mid-download recheck does not leave a later REAL install error swallowed", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 40 })

    // The recheck concludes cleanly — nothing new — while the download runs.
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      source.emit("update-not-available", { version: "1.2.0" })
      return Promise.resolve(null)
    })
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()

    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.2.0" })
    // Phase-scoped scaffolding, same reasoning as door three's intermediate
    // assertion.
    expect(updater.getState().phase).toBe("ready")

    // A REAL install-preparation failure right after ready (the measured
    // unsigned-build case) must invalidate ready — the recheck concluded
    // long ago and has nothing to do with this.
    source.emit("error", new Error("SQRLCodeSignatureErrorDomain: code signature did not pass validation"))
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
  })

  it("door five: a recheck failing mid-download (before update-downloaded) leaves the running download untouched", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })
    source.emit("download-progress", { percent: 40 })
    expect(updater.getState()).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })

    // The recheck starts AND fails while the download is still downloading —
    // the ordering none of the four prior patches covered: the old error
    // guard protected "ready" and "available" but not "downloading".
    failingRecheck(source, "net::ERR_NETWORK_CHANGED")
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()

    // The download is still running fine and must still be shown.
    expect(updater.getState()).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })

    // Subsequent progress keeps applying (the old code discarded it against
    // its terminal "error" state)…
    source.emit("download-progress", { percent: 85 })
    expect(updater.getState()).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 85 })

    // …and the download completes normally.
    source.emit("update-downloaded", { version: "1.2.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.2.0" })
  })

  /**
   * F14, the ordering the phase-read version still got wrong: a restart
   * requested WHILE a check is in flight. The old implementation judged
   * success by re-reading global phase after `quitAndInstall()`; the
   * check-in-flight bookkeeping absorbed the synchronous decline's "error"
   * emit (it looked exactly like an unrelated check failure hitting a ready
   * state), the phase stayed "ready", the wrapper returned `true`, and
   * `performRestartAndInstall` skipped its plain-quit fallback — dead window.
   * The call-scoped probe attributes anything emitted during the synchronous
   * call window to THIS install attempt, no matter what else is in flight.
   */
  it("F14 with a check in flight: a synchronous quitAndInstall() decline still reports false and surfaces the failure", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.0.0" })
    source.emit("update-downloaded", { version: "1.0.0" })
    // A recheck is in flight when the user clicks "Restart to update".
    source.emit("checking-for-update")
    expect(updater.getState().phase).toBe("ready")

    source.quitAndInstall.mockImplementationOnce(() => {
      source.emit("error", new Error("No update filepath provided, can't quit and install"))
    })

    expect(updater.restartAndInstall()).toBe(false)
    expect(updater.getState().phase).toBe("error")
  })

  /**
   * G1 (review of the first restructure): checks had identity, updates
   * didn't. On macOS, `MacUpdater.updateDownloaded()` reports ready and
   * THEN runs asynchronous native preparation (the C5 signature check this
   * repo's smoke harness measures) — so v1's prep error can arrive AFTER a
   * recheck already superseded the artifact with v2, and an unstamped
   * `update-failed` then invalidated v2 with v1's outcome. The fix mints an
   * update-operation identity in the reducer and stamps outcomes with the
   * operation they were observed against (`nativePrepOp` for delayed prep
   * errors), gated exactly like check conclusions.
   */
  /**
   * Since 2026-09-03 a READY update is frozen: a check that concludes with a
   * newer version while one is ready is dropped by the reducer (see
   * applyCheckOutcome), because on macOS the ready one already belongs to
   * the native installer and starting another download destroys its prep
   * (codex's second-round finding on the re-check fix). The G1 tests that
   * used to model "v2 supersedes ready(v1) while v1's prep runs" now model
   * what actually happens there: v1 stays ready, autoDownload stays off at
   * the moment the library reads it, nothing downloads, and v1's own
   * delayed outcome still lands on v1.
   */
  it("G1 (frozen ready): a late check finding v2 while v1 is ready leaves v1 ready, keeps autoDownload off, and starts no download", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.0.0" })
    source.emit("download-progress", { percent: 40 })

    // The recheck starts mid-download and concludes after v1 reached ready.
    // The fake mirrors 6.8.9: the emit, THEN the read of `autoDownload`
    // (which must be false by then), then `downloadUpdate()` only if true.
    let autoDownloadAtConclusion: boolean | undefined
    let concludeCheck: (() => void) | undefined
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise((resolve) => {
        concludeCheck = () => {
          source.emit("update-available", { version: "2.0.0" })
          autoDownloadAtConclusion = source.autoDownload
          resolve({ downloadPromise: source.autoDownload ? source.downloadUpdate() : null })
        }
      })
    })
    updater.checkForUpdates()
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.0.0" })
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.0.0" })
    source.downloadUpdate.mockClear()
    concludeCheck?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.0.0" })
    expect(autoDownloadAtConclusion).toBe(false)
    expect(source.downloadUpdate).not.toHaveBeenCalled()

    // v1's delayed native-prep error lands on v1 — the artifact it belongs to.
    source.emit("error", new Error("SQRLCodeSignatureErrorDomain: code signature did not pass validation"))
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.0.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
    // …and only then is auto-download open again.
    expect(source.autoDownload).toBe(true)
  })

  it("G1 (frozen ready): a prep error parked behind an unsettled recheck still lands on the ready update once the recheck concludes with v2", () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.0.0" })
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.0.0" })

    // The recheck is UNSETTLED when v1's prep error arrives, so it is parked.
    source.emit("checking-for-update")
    source.emit("error", new Error("SQRLCodeSignatureErrorDomain: code signature did not pass validation"))
    expect(updater.getState().phase).toBe("ready")

    // The recheck concludes with v2: dropped (v1 stays ready), the parked
    // error flushes onto v1.
    source.emit("update-available", { version: "2.0.0" })
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.0.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
  })

  it("G1-P1 (frozen ready): v1's reused downloadPromise rejecting after a v2 conclusion is v1's outcome, on v1", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: true, source, scheduleCheck: fakeScheduler().schedule })

    let rejectV1Download: ((err: Error) => void) | undefined
    const v1DownloadPromise = new Promise((_resolve, reject) => {
      rejectV1Download = reject
    })
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      source.emit("update-available", { version: "1.0.0" })
      return Promise.resolve({ downloadPromise: v1DownloadPromise })
    })
    updater.checkForUpdates()
    await Promise.resolve()
    await Promise.resolve()
    source.emit("download-progress", { percent: 40 })

    // A recheck starts mid-download and reports v2 after v1 reached ready,
    // handing v1's EXISTING promise back inside its result (6.8.9 reuses a
    // pending downloadPromise).
    let concludeCheck: (() => void) | undefined
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise((resolve) => {
        concludeCheck = () => {
          source.emit("update-available", { version: "2.0.0" })
          resolve({ downloadPromise: v1DownloadPromise })
        }
      })
    })
    updater.checkForUpdates()
    source.emit("download-progress", { percent: 100 })
    source.emit("update-downloaded", { version: "1.0.0" })
    concludeCheck?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({ phase: "ready", version: "1.0.0" })

    const prepError = new Error("SQRLCodeSignatureErrorDomain: code signature did not pass validation")
    source.emit("error", prepError)
    rejectV1Download?.(prepError)
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.0.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
  })

  /**
   * G2 (review of the first restructure): the reducer's check-failure branch
   * could overwrite a FAILED update artifact — so when a manual download
   * failed mid-recheck, the recheck's later rejection replaced the update's
   * actionable error ("download host unreachable") with its own unrelated
   * one ("network changed"), on the same version. A check failure may now
   * only write the display where no update operation's state exists.
   */
  it("G2: a check rejection does not overwrite an update operation's failure that landed mid-recheck", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })

    // A recheck starts and stays pending.
    let rejectCheck: ((err: Error) => void) | undefined
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise((_resolve, reject) => {
        rejectCheck = reject
      })
    })
    updater.checkForUpdates()

    // While it is pending, a manual download fails (emit + rejection, same
    // object — the real 6.8.9 shape).
    const downloadError = new Error("ENOTFOUND: download host unreachable")
    source.downloadUpdate.mockImplementationOnce(() => {
      source.emit("error", downloadError)
      return Promise.reject(downloadError)
    })
    await expect(updater.download()).rejects.toBe(downloadError)
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })

    // The recheck then rejects with its own, unrelated failure. Its
    // bookkeeping settles, but the update's actionable error stays.
    rejectCheck?.(new Error("net::ERR_NETWORK_CHANGED"))
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })
  })

  /**
   * P2 (review of the G1-P1 refactor): routing `download()` through the
   * ownership registry dropped the try/catch that used to surround the
   * whole call — so a SYNCHRONOUS throw from `downloadUpdate()` (reachable
   * in the installed Windows/Linux updaters: `provider.resolveFiles` /
   * `findFile` throw on malformed release metadata before any promise
   * exists) rejected the IPC promise but never reached the registry, and
   * state stayed "available" — the UI kept presenting a download that had
   * just failed. The IPC rejection alone is exactly what masks this, so
   * this test asserts the resulting STATE, not merely the rejection.
   */
  it("P2: a SYNCHRONOUS throw from downloadUpdate() is attributed like the async rejection — state records the failure, not just the IPC promise", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.2.0" })

    const metadataError = new Error("Cannot find suitable file in release metadata")
    source.downloadUpdate.mockImplementationOnce(() => {
      throw metadataError
    })

    // The IPC caller still observes the failure, as before…
    await expect(updater.download()).rejects.toBe(metadataError)
    // …and the state records it too, indistinguishable from an async
    // download rejection for the same operation.
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "Cannot find suitable file in release metadata",
    })
  })

  it("a manual download() rejection surfaces immediately as the update's own failure, even while a recheck is in flight", async () => {
    const source = fakeSource()
    const updater = createUpdater({ autoDownload: false, source, scheduleCheck: fakeScheduler().schedule })
    source.emit("checking-for-update")
    source.emit("update-available", { version: "1.0.0" })

    // A recheck is pending (and stays pending) when the download fails.
    source.checkForUpdates.mockImplementationOnce(() => {
      source.emit("checking-for-update")
      return new Promise(() => {})
    })
    updater.checkForUpdates()

    // The download fails the way 6.8.9 really fails: "error" emitted, then
    // the downloadUpdate() promise rejects with the same object.
    const downloadError = new Error("ECONNRESET: download stream reset")
    source.downloadUpdate.mockImplementationOnce(() => {
      source.emit("error", downloadError)
      return Promise.reject(downloadError)
    })

    await expect(updater.download()).rejects.toBe(downloadError)
    // Attributed to the download (its own rejection), surfaced NOW — neither
    // deferred behind the still-pending check nor misattributed to it.
    expect(updater.getState()).toEqual({
      phase: "error",
      version: "1.0.0",
      error: "ECONNRESET: download stream reset",
    })
  })
})

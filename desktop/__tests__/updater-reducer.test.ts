/**
 * `reduceUpdateState` + `projectUpdateState` — the pure attributed-event →
 * state mapping the real updater (`updater.ts`) folds `electron-updater`'s
 * events through, after attributing them to operations.
 *
 * HISTORY NOTE (for anyone diffing against the pre-restructure file): this
 * suite is the 1:1 port of the old raw-event reducer tests onto the
 * operation-attributed vocabulary that replaced `checkInFlight` (see
 * updater-reducer.ts's invariant doc comment). Every old scenario is
 * preserved — same library-event sequence, same asserted outcome — with the
 * raw events translated the way `updater.ts` now attributes them:
 *
 *   "checking"                → check-started(id)          (id minted upstream)
 *   "update-available"        → check-concluded(id, available)   — the active
 *                               check's conclusion; a stale duplicate racing
 *                               behind an already-concluded check carries that
 *                               check's no-longer-active id; a conclusion from
 *                               a source that never announced a check is
 *                               anonymous (id null)
 *   "update-not-available"    → check-concluded(id, not-available)  (same rules)
 *   "error" (check's own)     → check-concluded(id, failed)
 *   "error" (update's own)    → update-failed               (download/install/
 *                               spontaneous install-prep — scoped upstream)
 *   "download-progress"       → download-progress
 *   "update-downloaded"       → download-completed
 *
 * On top of the ports, the "invariant" blocks at the bottom cover the CLASS
 * the five historical doors (F3, F11, F12, F16, and the fifth: a mid-download
 * recheck failure clobbering the download) were instances of — orderings
 * derived from the invariant itself rather than from the bug list.
 */
import { describe, expect, it } from "vitest"
import {
  INITIAL_REDUCER_STATE,
  projectUpdateState,
  reduceUpdateState,
  type CheckOutcome,
  type ReducerState,
  type UpdateArtifact,
  type UpdaterEvent,
} from "../updater-reducer.js"
import type { DesktopUpdateState } from "../../src/types/desktop-bridge.js"

// ── event constructors ──────────────────────────────────────────────────────
const started = (checkId: number): UpdaterEvent => ({ type: "check-started", checkId })
const concluded = (checkId: number | null, outcome: CheckOutcome): UpdaterEvent => ({
  type: "check-concluded",
  checkId,
  outcome,
})
const available = (version: string): CheckOutcome => ({ kind: "available", version })
const notAvailable: CheckOutcome = { kind: "not-available" }
const failed = (message: string): CheckOutcome => ({ kind: "failed", message })
const progress = (percent: number): UpdaterEvent => ({ type: "download-progress", percent })
const downloaded = (version: string): UpdaterEvent => ({ type: "download-completed", version })
/** `updateOpId: null` (the default) is an ANONYMOUS stamp — "no operation
 *  identity was observable upstream" — which applies to whatever operation
 *  is current. A concrete stamp gates: it applies only while that operation
 *  IS the current artifact. */
const updateFailed = (message: string, updateOpId: number | null = null): UpdaterEvent => ({
  type: "update-failed",
  message,
  updateOpId,
})

/** Folds a sequence of attributed events through the reducer, starting fresh. */
function run(events: UpdaterEvent[]): ReducerState {
  return events.reduce(reduceUpdateState, INITIAL_REDUCER_STATE)
}

/** Folds, then projects onto the wire contract — what the UI actually sees. */
function wire(events: UpdaterEvent[]): DesktopUpdateState {
  return projectUpdateState(run(events))
}

/** Hand-built state for standalone single-transition assertions. A non-"none"
 *  artifact gets update-operation id 1 unless the test says otherwise. */
function state(
  update: UpdateArtifact,
  activeCheckId: number | null = null,
  updateOpId: number | null = update.stage === "none" ? null : 1,
): ReducerState {
  return { update, updateOpId, nextUpdateOpId: 100, activeCheckId }
}

describe("reduceUpdateState — happy path (autoDownload on)", () => {
  it("idle -> checking -> available -> downloading (progress) -> ready", () => {
    let s = INITIAL_REDUCER_STATE
    expect(projectUpdateState(s)).toEqual({ phase: "idle" })

    s = reduceUpdateState(s, started(1))
    expect(projectUpdateState(s)).toEqual({ phase: "checking" })

    s = reduceUpdateState(s, concluded(1, available("1.2.0")))
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.2.0" })

    s = reduceUpdateState(s, progress(12.5))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 12.5 })

    s = reduceUpdateState(s, progress(67))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 67 })

    s = reduceUpdateState(s, downloaded("1.2.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
  })

  it("a check that finds nothing new lands back at idle", () => {
    expect(wire([started(1), concluded(1, notAvailable)])).toEqual({ phase: "idle" })
  })
})

describe("reduceUpdateState — autoDownload off: available, then a manual download", () => {
  it("available sits until progress starts arriving (the manual download() call itself emits no reducer event)", () => {
    let s = run([started(1), concluded(1, available("2.0.0"))])
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "2.0.0" })

    // The manual download() call is a side effect on the real updater
    // (source.downloadUpdate()) with no state event of its own — the
    // reducer only ever sees the SAME download-progress/download-completed
    // events a silent autoDownload=true download would have produced.
    s = reduceUpdateState(s, progress(5))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "2.0.0", progressPercent: 5 })

    s = reduceUpdateState(s, downloaded("2.0.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "2.0.0" })
  })
})

describe("reduceUpdateState — errors", () => {
  it("an update-scoped error mid-download moves to phase error, carrying the version forward", () => {
    // The download's own failure: with no check in flight at emit time,
    // updater.ts scopes the raw "error" to the update.
    const s = wire([
      started(1),
      concluded(1, available("1.5.0")),
      progress(30),
      updateFailed("net::ERR_CONNECTION_RESET"),
    ])
    expect(s).toEqual({ phase: "error", version: "1.5.0", error: "net::ERR_CONNECTION_RESET" })
  })

  it("a check that fails before any update was found carries no version", () => {
    const s = wire([started(1), concluded(1, failed("ENOTFOUND"))])
    expect(s).toEqual({ phase: "error", version: undefined, error: "ENOTFOUND" })
  })

  it("recovers on the next check: error -> a new check starting clears the error, then a normal cycle continues", () => {
    let s = run([started(1), concluded(1, available("1.5.0")), updateFailed("disk full")])
    expect(projectUpdateState(s).phase).toBe("error")

    // The 4h timer (or a manual recheck) fires unconditionally.
    s = reduceUpdateState(s, started(2))
    expect(projectUpdateState(s)).toEqual({ phase: "checking" })

    s = reduceUpdateState(s, concluded(2, available("1.5.0")))
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.5.0" })
  })
})

describe("reduceUpdateState — out-of-order and duplicate events", () => {
  it("a check starting while downloading/ready/available does not regress the visible state, but is recorded", () => {
    const downloading = state({ stage: "downloading", version: "1.0.0", progressPercent: 40 })
    const afterDownloadingRecheck = reduceUpdateState(downloading, started(7))
    expect(projectUpdateState(afterDownloadingRecheck)).toEqual({
      phase: "downloading",
      version: "1.0.0",
      progressPercent: 40,
    })
    expect(afterDownloadingRecheck.activeCheckId).toBe(7)
    expect(afterDownloadingRecheck.update).toBe(downloading.update) // the artifact itself untouched
    // The same check re-announcing itself is a true no-op.
    expect(reduceUpdateState(afterDownloadingRecheck, started(7))).toBe(afterDownloadingRecheck)

    const availableState = state({ stage: "available", version: "1.0.0" })
    const afterFirstRecheck = reduceUpdateState(availableState, started(8))
    expect(projectUpdateState(afterFirstRecheck)).toEqual({ phase: "available", version: "1.0.0" })
    expect(afterFirstRecheck.activeCheckId).toBe(8)
    expect(reduceUpdateState(afterFirstRecheck, started(8))).toBe(afterFirstRecheck)

    const ready = state({ stage: "ready", version: "1.0.0" })
    const readyAfterRecheck = reduceUpdateState(ready, started(9))
    expect(projectUpdateState(readyAfterRecheck)).toEqual({ phase: "ready", version: "1.0.0" })
    expect(readyAfterRecheck.activeCheckId).toBe(9)
  })

  it("a duplicate 'available' for the SAME version mid-download does not reset progress", () => {
    const downloading = state({ stage: "downloading", version: "1.0.0", progressPercent: 40 })
    // Anonymous (a conclusion from a check the reducer never saw start) and
    // stale (the tail of an already-concluded check) are both dropped here.
    expect(reduceUpdateState(downloading, concluded(null, available("1.0.0")))).toBe(downloading)
    expect(reduceUpdateState(downloading, concluded(3, available("1.0.0")))).toBe(downloading)
  })

  it("a duplicate 'available' for the SAME version once ready does not un-ready it", () => {
    const ready = state({ stage: "ready", version: "1.0.0" })
    expect(reduceUpdateState(ready, concluded(null, available("1.0.0")))).toBe(ready)
  })

  it("'available' for a DIFFERENT version while downloading does NOT override — the active download's version stays authoritative (F5)", () => {
    const downloading = state({ stage: "downloading", version: "1.0.0", progressPercent: 40 }, 2)
    const result = reduceUpdateState(downloading, concluded(2, available("1.1.0")))
    // Knowledge dropped (active download authoritative), but the check's own
    // bookkeeping is still consumed — it's the check's conclusion (F16).
    expect(result.update).toBe(downloading.update)
    expect(result.activeCheckId).toBeNull()
  })

  it("'available' for a DIFFERENT version while ready DOES still override — no in-flight download to mislabel", () => {
    const ready = state({ stage: "ready", version: "1.0.0" })
    const result = reduceUpdateState(ready, concluded(null, available("1.1.0")))
    expect(projectUpdateState(result)).toEqual({ phase: "available", version: "1.1.0" })
  })

  it("a stale 'not-available' racing behind a successful check does not clobber it", () => {
    // The tail of the SAME check that just reported available: its id is no
    // longer the active one (the "available" conclusion consumed it), so the
    // straggler is dropped whole.
    const availableState = state({ stage: "available", version: "1.0.0" })
    expect(reduceUpdateState(availableState, concluded(1, notAvailable))).toBe(availableState)

    // Downloading/ready aren't invalidated by "nothing new" from ANY check —
    // that's a statement about the feed, not the thing in hand.
    const downloading = state({ stage: "downloading", version: "1.0.0", progressPercent: 10 }, 2)
    expect(reduceUpdateState(downloading, concluded(2, notAvailable)).update).toBe(downloading.update)
    expect(reduceUpdateState(downloading, concluded(null, notAvailable)).update).toBe(downloading.update)

    const ready = state({ stage: "ready", version: "1.0.0" })
    expect(reduceUpdateState(ready, concluded(null, notAvailable))).toBe(ready)
  })

  it("progress never regresses visually — a lower percent arriving after a higher one is clamped", () => {
    const s = state({ stage: "downloading", version: "1.0.0", progressPercent: 80 })
    expect(reduceUpdateState(s, progress(40))).toBe(s)
    expect(projectUpdateState(reduceUpdateState(s, progress(40)))).toEqual({
      phase: "downloading",
      version: "1.0.0",
      progressPercent: 80,
    })
  })

  it("late progress after the download already finished ('ready') is discarded", () => {
    const ready = state({ stage: "ready", version: "1.0.0" })
    expect(reduceUpdateState(ready, progress(99))).toBe(ready)
  })

  it("late progress after a failure is discarded", () => {
    const errored = state({ stage: "failed", version: "1.0.0", error: "boom" })
    expect(reduceUpdateState(errored, progress(50))).toBe(errored)
  })

  it("a duplicate 'download-completed' for the same version is idempotent", () => {
    const ready = state({ stage: "ready", version: "1.0.0" })
    expect(reduceUpdateState(ready, downloaded("1.0.0"))).toBe(ready)
    expect(projectUpdateState(reduceUpdateState(ready, downloaded("1.0.0")))).toEqual({
      phase: "ready",
      version: "1.0.0",
    })
  })
})

/**
 * F3 (adversarial review of Phase 4; door one of five): a later, UNRELATED
 * check's error must not clobber a "ready" state — before the original fix,
 * `restartAndInstall()` silently became a no-op even though a verified
 * download was still on disk. Structural home in the new design: a
 * check-scoped failure never touches a live update (invariant rule 4).
 */
describe("reduceUpdateState — F3: which operation produced the error", () => {
  it("an install-prep error immediately following download-completed DOES invalidate ready — the measured unsigned-build (C5) case", () => {
    // No check in flight when the signature failure fires, so updater.ts
    // scopes it to the update (see its attribution ladder) — and an
    // update-scoped failure always lands.
    const s = wire([
      started(1),
      concluded(1, available("1.2.0")),
      progress(100),
      downloaded("1.2.0"),
      updateFailed("SQRLCodeSignatureErrorDomain: code signature did not pass validation"),
    ])
    expect(s).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
  })

  it("a later UNRELATED check's error does NOT invalidate a still-good ready state", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(100), downloaded("1.2.0")])
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })

    // Hours later, the 4h timer fires again — a genuinely NEW check, wholly
    // unrelated to the download that's already sitting ready on disk. The
    // network happens to be down for THIS check.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))

    // Still ready: restartAndInstall() must remain live.
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
    // And the failed check's own bookkeeping was consumed by its own outcome.
    expect(s.activeCheckId).toBeNull()
  })

  it("a later UNRELATED check's error does NOT invalidate a still-good 'available' (undownloaded) state either", () => {
    let s = run([started(1), concluded(1, available("1.2.0"))])
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.2.0" })

    // A later periodic check — or the on-demand "Check for updates" button
    // — hits a transient network failure. The 1.2 update presumably still
    // exists on the feed; this failure says nothing about it.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))

    // Still available: the "Download" action must remain live.
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.2.0" })
  })
})

/**
 * F4 (adversarial review of Phase 4): with auto-download off, an undownloaded
 * "available" state must be clearable by a LATER check that finds nothing —
 * otherwise a withdrawn or corrected release stays offered forever.
 */
describe("reduceUpdateState — F4: a withdrawn release stops being offered", () => {
  it("a later check finding nothing supersedes an undownloaded 'available'", () => {
    let s = run([started(1), concluded(1, available("1.2.0"))])
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.2.0" })

    // A later periodic check — 1.2 was pulled or corrected on the feed.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, notAvailable))
    expect(projectUpdateState(s)).toEqual({ phase: "idle" })
  })

  it("a stale 'not-available' racing behind the SAME check that just found 'available' is still ignored (unchanged)", () => {
    // The check concluded with "available" — its id is consumed. Its own
    // straggling duplicate carries that stale id and is dropped whole.
    const s = run([started(1), concluded(1, available("1.2.0"))])
    expect(reduceUpdateState(s, concluded(1, notAvailable))).toBe(s)
  })
})

/**
 * F5 (adversarial review of Phase 4): an in-flight download must not be
 * relabeled by a DIFFERENT version reported mid-download — electron-updater
 * keeps resolving the SAME downloadPromise it already started.
 */
describe("reduceUpdateState — F5: the active download's version stays authoritative", () => {
  it("a different version reported mid-download does not relabel it, and the download resolves under its OWN version", () => {
    let s = run([started(1), concluded(1, available("1.1.0")), progress(40)])
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.1.0", progressPercent: 40 })

    // A later check finds 1.2 while 1.1 is still downloading.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, available("1.2.0")))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.1.0", progressPercent: 40 })

    // Progress keeps reporting against the version actually in flight.
    s = reduceUpdateState(s, progress(75))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.1.0", progressPercent: 75 })

    // The download that's actually running (1.1) is what completes —
    // matching what electron-updater's own downloadPromise does.
    s = reduceUpdateState(s, downloaded("1.1.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.1.0" })
  })
})

/**
 * F11 (second adversarial review pass; door two): a check that starts WHILE
 * an update is downloading, whose failure arrives only after the download
 * reached "ready", must not have that failure misattributed to the download.
 * Structural home: `activeCheckId` is its own field — there is no marker to
 * hand-carry through "download-progress" and "download-completed", so there
 * is nothing to forget.
 */
describe("reduceUpdateState — F11: check bookkeeping survives downloading and download-completed", () => {
  it("a check that starts mid-download and fails AFTER the download reaches 'ready' does not invalidate that ready state", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(40)])
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })

    // A periodic recheck (or an on-demand "Check for updates" click) fires
    // WHILE the download is still in progress.
    s = reduceUpdateState(s, started(2))
    // The download keeps progressing — the recorded check survives without
    // any explicit carrying.
    s = reduceUpdateState(s, progress(90))
    expect(s.activeCheckId).toBe(2)
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 90 })

    // The download finishes successfully; the check is STILL in flight.
    s = reduceUpdateState(s, downloaded("1.2.0"))
    expect(s.activeCheckId).toBe(2)
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })

    // Only NOW does the overlapping check's own failure arrive. It concludes
    // check 2 — and check 2 only.
    s = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
    expect(s.activeCheckId).toBeNull()
  })
})

/**
 * F16 (third adversarial review pass; door four): a mid-download recheck that
 * concludes SUCCESSFULLY must release its bookkeeping just like a failed one,
 * or a later REAL install error is wrongly protected. Structural home: every
 * conclusion kind consumes its own check's bookkeeping through the same
 * id-gate — there is no per-outcome clearing to forget.
 */
describe("reduceUpdateState — F16: a successfully-concluded mid-download recheck releases its bookkeeping too", () => {
  it("a recheck that finds nothing new mid-download does not leave 'ready' falsely protected from a REAL install-prep error afterward", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(40)])

    // An overlapping recheck starts mid-download...
    s = reduceUpdateState(s, started(2))
    // ...and concludes SUCCESSFULLY — nothing new, still downloading 1.2.
    s = reduceUpdateState(s, concluded(2, notAvailable))
    expect(s.activeCheckId).toBeNull() // consumed by its own conclusion
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })

    s = reduceUpdateState(s, progress(100))
    s = reduceUpdateState(s, downloaded("1.2.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })

    // A REAL install-preparation error fires immediately after "ready" —
    // the measured C5 case. Update-scoped (no check in flight), so it lands.
    s = reduceUpdateState(s, updateFailed("SQRLCodeSignatureErrorDomain: code signature did not pass validation"))
    expect(projectUpdateState(s)).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
    })
  })

  it("a recheck that reconfirms the SAME version mid-download also releases its bookkeeping", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(40)])
    s = reduceUpdateState(s, started(2))
    // The recheck reconfirms 1.2 is still what's on the feed.
    s = reduceUpdateState(s, concluded(2, available("1.2.0")))
    expect(s.activeCheckId).toBeNull()
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })

    s = reduceUpdateState(s, downloaded("1.2.0"))
    s = reduceUpdateState(s, updateFailed("install failed"))
    expect(projectUpdateState(s)).toEqual({ phase: "error", version: "1.2.0", error: "install failed" })
  })

  it("a recheck that reconfirms the SAME version while already ready also releases its bookkeeping", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(100), downloaded("1.2.0")])
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })

    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, available("1.2.0")))
    expect(s.activeCheckId).toBeNull()
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })

    s = reduceUpdateState(s, updateFailed("install failed"))
    expect(projectUpdateState(s)).toEqual({ phase: "error", version: "1.2.0", error: "install failed" })
  })
})

/**
 * F12 (second adversarial review pass; door three): suppressing one check's
 * stale failure must not ALSO swallow the next genuinely new failure.
 * Structural home: suppression is per-conclusion (id-gated), not a lingering
 * marker — there is no leftover state for the next error to hit.
 */
describe("reduceUpdateState — F12: a suppressed check failure does not swallow the next real failure", () => {
  it("a genuinely NEW error (e.g. a manual download failing before any progress) is not swallowed after an unrelated check failure was suppressed", () => {
    let s = run([started(1), concluded(1, available("1.2.0"))])

    // A later, unrelated check fails — correctly suppressed (F3's guard).
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))
    expect(projectUpdateState(s).phase).toBe("available")

    // The user clicks "Download" — download() fails immediately, before any
    // progress event. Update-scoped (the download's own rejection), lands.
    s = reduceUpdateState(s, updateFailed("ENOTFOUND: download host unreachable"))
    expect(projectUpdateState(s)).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })
  })
})

/**
 * Door five (found in the review that prompted this restructure): a recheck
 * that starts during an active download and FAILS before the download
 * completes. The old design's error guard protected "ready" and "available"
 * but not "downloading", so the check's failure flipped the state to "error"
 * and every subsequent progress event was discarded — while the download was
 * still running fine. Structural home: same as F3/F11 — a check-scoped
 * failure cannot write the update field at all.
 */
describe("reduceUpdateState — door five: a mid-download recheck FAILING before the download completes", () => {
  it("the check's failure leaves the download untouched, progress keeps applying, and the download still completes", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(40)])

    // Recheck starts mid-download and fails while the download is STILL
    // downloading (before download-completed — the ordering none of the four
    // prior fixes covered).
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 40 })
    expect(s.activeCheckId).toBeNull() // ...while still consuming its own bookkeeping

    // The original download is unaffected: progress keeps applying...
    s = reduceUpdateState(s, progress(85))
    expect(projectUpdateState(s)).toEqual({ phase: "downloading", version: "1.2.0", progressPercent: 85 })

    // ...and it completes normally.
    s = reduceUpdateState(s, downloaded("1.2.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
  })
})

/**
 * The class, not the instances: orderings derived from the invariant itself
 * ("an outcome may only be applied to the operation it belongs to, and only
 * an operation's own terminal outcome may consume its bookkeeping") rather
 * than from the five reported doors.
 */
describe("reduceUpdateState — invariant: conclusions are gated on operation identity", () => {
  it("overlapping checks: a superseded check's late conclusion is dropped whole; the newer check's applies", () => {
    let s = run([started(1)])
    // A second check starts before the first's conclusion arrives (can't
    // happen under 6.8.9's serialization, but the reducer must not depend
    // on that being true forever).
    s = reduceUpdateState(s, started(2))
    expect(s.activeCheckId).toBe(2)

    // Check 1's late "available" belongs to a superseded operation: dropped,
    // consuming nothing.
    const afterStale = reduceUpdateState(s, concluded(1, available("9.9.9")))
    expect(afterStale).toBe(s)

    // Check 2's own conclusion applies normally.
    s = reduceUpdateState(s, concluded(2, notAvailable))
    expect(projectUpdateState(s)).toEqual({ phase: "idle" })
  })

  it("a check's SECOND conclusion is stale: its id was consumed by its first", () => {
    const s = run([started(1), concluded(1, available("1.2.0"))])
    // The same check "concluding" again — as a failure this time — must not
    // touch anything: its story ended at "available".
    expect(reduceUpdateState(s, concluded(1, failed("late duplicate")))).toBe(s)
    expect(reduceUpdateState(s, concluded(1, available("2.0.0")))).toBe(s)
  })

  it("a conclusion for a check that is not the active one never consumes the active one's bookkeeping", () => {
    const s = state({ stage: "available", version: "1.0.0" }, 5)
    const result = reduceUpdateState(s, concluded(9, notAvailable))
    expect(result).toBe(s) // dropped whole: knowledge AND bookkeeping
  })

  it("an anonymous conclusion (a check the reducer never saw start) applies knowledge but consumes nobody's bookkeeping", () => {
    const s = state({ stage: "available", version: "1.0.0" }, 5)
    const result = reduceUpdateState(s, concluded(null, notAvailable))
    expect(projectUpdateState(result).phase).toBe("checking") // withdrawn, but check 5 still in flight
    expect(result.activeCheckId).toBe(5)
  })

  it("update-scoped outcomes never touch check bookkeeping: a failure mid-download leaves the in-flight check intact, and its later conclusion still applies", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(40)])
    s = reduceUpdateState(s, started(2))

    // The download's own failure lands — but check 2 is still running.
    s = reduceUpdateState(s, updateFailed("net::ERR_CONNECTION_RESET"))
    expect(projectUpdateState(s)).toEqual({ phase: "error", version: "1.2.0", error: "net::ERR_CONNECTION_RESET" })
    expect(s.activeCheckId).toBe(2)

    // Check 2 concludes with a fresh find: recovery, and ITS bookkeeping consumed.
    s = reduceUpdateState(s, concluded(2, available("1.2.1")))
    expect(projectUpdateState(s)).toEqual({ phase: "available", version: "1.2.1" })
    expect(s.activeCheckId).toBeNull()
  })

  it("a download completing while a check is in flight: both operations keep their own state", () => {
    let s = run([started(1), concluded(1, available("1.2.0")), progress(90), started(2)])
    s = reduceUpdateState(s, downloaded("1.2.0"))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
    expect(s.activeCheckId).toBe(2)

    // Whatever check 2 later says obeys the same rules as always.
    s = reduceUpdateState(s, concluded(2, notAvailable))
    expect(projectUpdateState(s)).toEqual({ phase: "ready", version: "1.2.0" })
    expect(s.activeCheckId).toBeNull()
  })

  it("errors after a terminal state: an ANONYMOUS failure display yields to fresher news, and a stale conclusion is dropped", () => {
    // F15's shape at the reducer level: an unattributed error surfaced with
    // no operation behind it (updateOpId null), while a check is pending.
    // The check's own later failure is fresher anonymous news of the same
    // kind — it replaces the display rather than being swallowed behind it.
    let s = run([started(2), updateFailed("disk full")])
    expect(s.updateOpId).toBeNull() // no operation ever existed
    expect(projectUpdateState(s).error).toBe("disk full")
    s = reduceUpdateState(s, concluded(2, failed("feed unreachable")))
    expect(projectUpdateState(s).error).toBe("feed unreachable")

    // A STALE failure (that same, now-consumed check) after a terminal
    // state: dropped.
    const staleAfterTerminal = reduceUpdateState(s, concluded(2, failed("even later straggler")))
    expect(staleAfterTerminal).toBe(s)
  })

  it("a check failure cannot overwrite an update OPERATION's failure display (G2)", () => {
    // A real update's failure lands while a recheck is active — e.g. a
    // manual download failing mid-recheck. Its message is the actionable
    // outcome of an update operation.
    let s = run([started(1), concluded(1, available("1.2.0")), started(2)])
    s = reduceUpdateState(s, updateFailed("ENOTFOUND: download host unreachable"))
    expect(s.updateOpId).not.toBeNull()
    expect(projectUpdateState(s)).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })

    // The recheck then rejects. Its bookkeeping is consumed (its own
    // outcome), but the update operation's failure display is NOT
    // overwritten — "the recheck's network blipped" says nothing about why
    // v1.2 failed.
    const after = reduceUpdateState(s, concluded(2, failed("net::ERR_NETWORK_CHANGED")))
    expect(after.activeCheckId).toBeNull()
    expect(projectUpdateState(after)).toEqual({
      phase: "error",
      version: "1.2.0",
      error: "ENOTFOUND: download host unreachable",
    })
  })

  it("a 'settled-without-report' conclusion consumes bookkeeping and asserts nothing", () => {
    // From checking with nothing found yet: back to idle, not error.
    let s = run([started(1)])
    s = reduceUpdateState(s, concluded(1, { kind: "settled-without-report" }))
    expect(projectUpdateState(s)).toEqual({ phase: "idle" })

    // With a live update: the update is untouched.
    let s2 = run([started(1), concluded(1, available("1.2.0")), started(2)])
    s2 = reduceUpdateState(s2, concluded(2, { kind: "settled-without-report" }))
    expect(projectUpdateState(s2)).toEqual({ phase: "available", version: "1.2.0" })
    expect(s2.activeCheckId).toBeNull()
  })

  it("duplicate events are no-ops at every stage: same check-started, same conclusion, same completion, same failure", () => {
    const checking = run([started(1)])
    expect(reduceUpdateState(checking, started(1))).toBe(checking)

    const ready = state({ stage: "ready", version: "1.0.0" })
    expect(reduceUpdateState(ready, downloaded("1.0.0"))).toBe(ready)

    const failedState = state({ stage: "failed", version: "1.0.0", error: "boom" })
    expect(reduceUpdateState(failedState, updateFailed("boom"))).toBe(failedState)
  })
})

/**
 * The update side of invariant rule 3 (added when review of the first
 * restructure found the class one level up — G1: checks had identity,
 * updates didn't, so a superseded update's delayed outcome landed on its
 * successor).
 */
describe("reduceUpdateState — update outcomes are gated on update-operation identity (G1)", () => {
  it("a superseded update's stamped failure is dropped whole — it cannot invalidate its successor", () => {
    // v1 downloads and reaches ready; on macOS its native install prep now
    // runs asynchronously.
    let s = run([started(1), concluded(1, available("1.0.0")), progress(100), downloaded("1.0.0")])
    const v1Op = s.updateOpId
    expect(v1Op).not.toBeNull()

    // A recheck supersedes ready(v1) with available(v2) — a NEW operation.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, available("2.0.0")))
    expect(s.updateOpId).not.toBe(v1Op)

    // v1's delayed native-prep error finally arrives, stamped with v1's
    // operation (updater.ts's `nativePrepOp` tracking). v1's artifact is
    // gone — the outcome has nothing left to invalidate, and must not
    // invalidate v2.
    const after = reduceUpdateState(
      s,
      updateFailed("SQRLCodeSignatureErrorDomain: code signature did not pass validation", v1Op),
    )
    expect(after).toBe(s)
    expect(projectUpdateState(after)).toEqual({ phase: "available", version: "2.0.0" })
  })

  it("a stamped failure matching the CURRENT operation applies — its own terminal, keeping its identity", () => {
    let s = run([started(1), concluded(1, available("1.0.0")), progress(100), downloaded("1.0.0")])
    const op = s.updateOpId
    s = reduceUpdateState(s, updateFailed("install failed", op))
    expect(projectUpdateState(s)).toEqual({ phase: "error", version: "1.0.0", error: "install failed" })
    expect(s.updateOpId).toBe(op)
  })

  it("an anonymous failure (no operation observable upstream) still applies to the current artifact", () => {
    const s = reduceUpdateState(state({ stage: "ready", version: "1.0.0" }, null, 7), updateFailed("boom"))
    expect(projectUpdateState(s)).toEqual({ phase: "error", version: "1.0.0", error: "boom" })
    expect(s.updateOpId).toBe(7)
  })

  it("identity persists through the operation's lifecycle and is re-minted only on replacement", () => {
    let s = run([started(1), concluded(1, available("1.0.0"))])
    const op = s.updateOpId
    expect(op).not.toBeNull()

    s = reduceUpdateState(s, progress(50))
    expect(s.updateOpId).toBe(op) // downloading: same operation

    s = reduceUpdateState(s, downloaded("1.0.0"))
    expect(s.updateOpId).toBe(op) // ready: same operation

    // A same-version reconfirmation is the SAME operation continuing.
    s = reduceUpdateState(s, started(2))
    s = reduceUpdateState(s, concluded(2, available("1.0.0")))
    expect(s.updateOpId).toBe(op)

    // A different version replaces the artifact: a NEW operation begins.
    s = reduceUpdateState(s, started(3))
    s = reduceUpdateState(s, concluded(3, available("2.0.0")))
    expect(s.updateOpId).not.toBe(op)
  })
})

describe("projectUpdateState — the wire contract is a pure projection", () => {
  it("check activity shows as 'checking' only when there is nothing else to say", () => {
    expect(projectUpdateState(state({ stage: "none" }, 1))).toEqual({ phase: "checking" })
    expect(projectUpdateState(state({ stage: "none" }, null))).toEqual({ phase: "idle" })
    // A live or failed update always outranks check activity.
    expect(projectUpdateState(state({ stage: "available", version: "1.0.0" }, 1)).phase).toBe("available")
    expect(projectUpdateState(state({ stage: "ready", version: "1.0.0" }, 1)).phase).toBe("ready")
    expect(projectUpdateState(state({ stage: "failed", version: undefined, error: "x" }, 1)).phase).toBe("error")
  })
})

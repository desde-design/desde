import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPrototypeProcesses,
  pickLoopbackPort,
  PrototypeProcessError,
  substitutePort,
  type PrototypeProcesses,
} from "./prototype-processes"

/**
 * The child this manager spawns. Under `__fixtures__/`, not `fixtures/`,
 * because it is reached by PATH and spawned — no module imports it, so knip
 * reads it as an unused file unless it sits in the directory name
 * `knip.json` already ignores for exactly this case.
 */
const FAKE = resolve(__dirname, "__tests__/__fixtures__/fake-server.mjs")
const roots: string[] = []
async function checkoutsRoot(ids: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "procs-"))
  roots.push(root)
  for (const id of ids) await mkdir(join(root, id), { recursive: true })
  return root
}
const managers: { shutdown(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.shutdown()))
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
/** `node` from PATH; fixture knobs (FAKE_DELAY_MS, FAKE_EXIT_CODE) ride the manager's `spawnEnv`, not the argv. */
function start(): string[] {
  return ["node", FAKE]
}
/**
 * Whether a pid names a live process. Signal 0 performs the permission and
 * existence checks and delivers nothing, so this asks the kernel rather than
 * inferring anything from a handle this test does not own.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function get(port: number, path = "/"): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

/** A promise this file settles by hand, to hold a scope open for as long as a test needs. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * One open request lease, held until `release()` is called and awaited.
 *
 * The lease is a SCOPE (`withLease`), not a begin/end pair, so a test that
 * needs one held across other calls expresses it as a scope whose body it
 * settles itself. `release()` resolves once the scope has actually finished,
 * which is when the lease is released.
 */
function holdLease(procs: PrototypeProcesses, id: string): () => Promise<void> {
  const done = deferred()
  const leased = procs.withLease(id, () => done.promise)
  return async () => {
    done.resolve()
    await leased
  }
}

/**
 * One whole request, the shape `serve-router.ts` makes it: the lease is taken
 * FIRST, the cold start happens inside it, and the lease stays open until the
 * test releases it — a response still being written.
 *
 * `started` settles when the `ensure` does, so a test can assert on the four
 * that got in and the two that were refused while all six requests are still
 * in flight. `release()` ends the request and resolves once the lease is
 * actually gone.
 */
function leasedEnsure(
  procs: PrototypeProcesses,
  id: string,
): { started: Promise<{ port: number }>; release: () => Promise<void> } {
  const done = deferred()
  let settle!: (result: { port: number }) => void
  let fail!: (error: unknown) => void
  const started = new Promise<{ port: number }>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const held = procs.withLease(id, async () => {
    try {
      settle(await procs.ensure({ id, serverStart: start() }))
    } catch (error) {
      fail(error)
      return
    }
    await done.promise
  })
  return {
    started,
    release: async () => {
      done.resolve()
      await held
    },
  }
}

/**
 * Codex round 4, Fix 3. A standalone Next build's recorded `start` is
 * `["node", "<distDir>/standalone/server.js"]` — a BARE `node`, never an
 * absolute path, because the checkout has no `node` of its own and an
 * absolute path baked in at build time would go stale the moment the
 * Viewer's own image ships a Node binary in a different location (see
 * `frameworks/next.ts`'s own note). This is where that bare `node` gets
 * resolved — to `process.execPath`, the Node binary CURRENTLY running this
 * manager — at spawn time, every time, so an image upgrade is picked up for
 * every existing deployment automatically.
 */
describe("substitutePort", () => {
  it("substitutes $PORT in every argv entry", () => {
    expect(substitutePort(["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"], 4321)).toEqual({
      file: "node_modules/.bin/next",
      args: ["start", "-p", "4321", "-H", "127.0.0.1"],
    })
  })

  it("resolves a bare 'node' first argv entry to the currently running Node binary", () => {
    expect(substitutePort(["node", ".next/standalone/server.js"], 4321)).toEqual({
      file: process.execPath,
      args: [".next/standalone/server.js"],
    })
  })

  it("does NOT resolve a first entry that merely starts with 'node' (e.g. the checkout's own next binary)", () => {
    expect(substitutePort(["node_modules/.bin/next", "start"], 4321)).toEqual({
      file: "node_modules/.bin/next",
      args: ["start"],
    })
  })

  it("throws on an empty serverStart", () => {
    expect(() => substitutePort([], 4321)).toThrow("serverStart is empty")
  })
})

describe("createPrototypeProcesses", () => {
  it("starts a deployment's server, resolves once it answers, and reuses it", async () => {
    const root = await checkoutsRoot(["d1"])
    const procs = createPrototypeProcesses({ checkoutsRoot: root })
    managers.push(procs)
    const a = await procs.ensure({ id: "d1", serverStart: start() })
    expect((await get(a.port)).body).toContain("hello from")
    expect(procs.status("d1").state).toBe("running")
    const b = await procs.ensure({ id: "d1", serverStart: start() })
    expect(b.port).toBe(a.port)
    expect(procs.serverLog("d1")).toContain("fake server: listening")
  })

  it("rejects a static deployment", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: null })).rejects.toBeInstanceOf(PrototypeProcessError)
  })

  it("marks a server that exits before answering as crashed, with its log", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      readyTimeoutMs: 5000,
      spawnEnv: { FAKE_EXIT_CODE: "3" },
    })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") expect(status.exitCode).toBe(3)
    expect(procs.serverLog("d1")).toContain("refusing to start")
  })

  it("marks a missing checkout as crashed with a reason, without spawning", async () => {
    let now = 1_000_000
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([]), now: () => now })
    managers.push(procs)
    await expect(procs.ensure({ id: "gone", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("gone")
    expect(status.state === "crashed" && /checkout/i.test(status.reason)).toBe(true)
    // Nothing a retry could fix: the files are not there.
    expect(status.state === "crashed" && status.retryable).toBe(false)
    // And time does not fix it either. `retryable` is computed from the
    // CURRENT restart window, so a crash that ages out of that window becomes
    // retryable again — but this is not a budget failure, and it must stay
    // non-retryable however long ago it happened.
    now += 60 * 60_000
    const later = procs.status("gone")
    expect(later.state === "crashed" && later.retryable).toBe(false)
  })

  it("marks a malformed id as crashed without echoing the id in the reason", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([]) })
    managers.push(procs)
    const badId = "../evil"
    await expect(procs.ensure({ id: badId, serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status(badId)
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.reason).not.toContain(badId)
      expect(status.reason).not.toContain("evil")
    }
  })

  it("restarts a crashed server on the next ensure, up to three times in five minutes", async () => {
    let now = 1_000_000
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), now: () => now })
    managers.push(procs)
    // The initial start is not itself a restart; four crash cycles here means
    // the 3rd restart (the 4th attempt total) still succeeded, and the 5th
    // attempt (a would-be 4th restart) is the one that should be refused.
    for (let i = 0; i < 4; i++) {
      const { port } = await procs.ensure({ id: "d1", serverStart: start() })
      await get(port, "/exit")
      await new Promise((r) => setTimeout(r, 200))
      expect(procs.status("d1").state).toBe("crashed")
    }
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    now += 6 * 60_000
    await expect(procs.ensure({ id: "d1", serverStart: start() })).resolves.toBeTruthy()
  })

  it("stops the least recently used server when the cap is reached", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["a", "b", "c"]), maxRunning: 2 })
    managers.push(procs)
    await procs.ensure({ id: "a", serverStart: start() })
    await procs.ensure({ id: "b", serverStart: start() })
    procs.touch("a")
    await procs.ensure({ id: "c", serverStart: start() })
    expect(procs.status("b").state).toBe("stopped")
    expect(procs.status("a").state).toBe("running")
  })

  /**
   * Codex round 8, Fix 2. Eviction used to sort every `running` entry by
   * recency and stop the oldest one, regardless of whether it was actively
   * answering a request (an open lease, held by `withLease`). A fifth
   * prototype opening while the least-recently-used one was mid-SSE or
   * mid-download would kill that response out from under its reader —
   * exactly what the lease exists to prevent from the idle reaper, but
   * eviction never consulted it.
   *
   * These three tests share one shape: fill the cap, hold a lease open on
   * every running entry, and prove eviction refuses to touch any of them
   * until one goes idle again.
   */
  it("fails fast with a fixed sentence when the cap is full and every running entry is busy", async () => {
    const ids = ["a", "b", "c", "d"]
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([...ids, "e"]), maxRunning: 4 })
    managers.push(procs)
    for (const id of ids) await procs.ensure({ id, serverStart: start() })
    const releases = ids.map((id) => holdLease(procs, id))

    await expect(procs.ensure({ id: "e", serverStart: start() })).rejects.toMatchObject({
      message: "Every prototype server is busy. Try again in a moment.",
    })

    for (const id of ids) expect(procs.status(id).state).toBe("running")
    // The failed attempt released its own reserved slot rather than sitting
    // there as a permanent `crashed` status — nothing is wrong with this
    // deployment, and it must not spend the restart budget.
    const e = procs.status("e")
    expect(e.state).toBe("stopped")

    for (const release of releases) await release()
  })

  it("evicts the one idle entry among busy ones, even though it is the most recently used", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["a", "b", "c"]), maxRunning: 2 })
    managers.push(procs)
    await procs.ensure({ id: "a", serverStart: start() })
    const releaseA = holdLease(procs, "a")
    // b is ensured (and so touched) AFTER a, and stays idle — the plain LRU
    // rule that used to run would pick a, the older entry, as the victim.
    await procs.ensure({ id: "b", serverStart: start() })

    await procs.ensure({ id: "c", serverStart: start() })

    expect(procs.status("a").state).toBe("running")
    expect(procs.status("b").state).toBe("stopped")
    expect(procs.status("c").state).toBe("running")
    await releaseA()
  })

  it("evicts the busy entry once its in-flight count drops back to zero", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["a", "b"]), maxRunning: 1 })
    managers.push(procs)
    await procs.ensure({ id: "a", serverStart: start() })
    const releaseA = holdLease(procs, "a")

    await expect(procs.ensure({ id: "b", serverStart: start() })).rejects.toMatchObject({
      message: "Every prototype server is busy. Try again in a moment.",
    })
    expect(procs.status("a").state).toBe("running")

    await releaseA()
    const b = await procs.ensure({ id: "b", serverStart: start() })
    expect(b.port).toBeGreaterThan(0)
    expect(procs.status("a").state).toBe("stopped")
    expect(procs.status("b").state).toBe("running")
  })

  /**
   * The lease is a scope, so the release is a `finally`, not a call the
   * caller has to remember on every path. A `fn` that throws is the path
   * the begin/end pair kept losing: a request that failed mid-flight left
   * the entry marked in use for ever, exempt from both the idle reaper and
   * eviction.
   */
  it("withLease releases the lease even when its body rejects", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["a", "b"]), maxRunning: 1 })
    managers.push(procs)
    await procs.ensure({ id: "a", serverStart: start() })

    await expect(
      procs.withLease("a", () => Promise.reject(new Error("the request blew up"))),
    ).rejects.toThrow("the request blew up")

    // Proof the lease is gone rather than merely believed gone: at a cap of
    // one, `b` can only start if `a` is evictable, and a leaked lease would
    // have made `a` permanently un-evictable.
    await expect(procs.ensure({ id: "b", serverStart: start() })).resolves.toBeTruthy()
    expect(procs.status("a").state).toBe("stopped")
    expect(procs.status("b").state).toBe("running")
  })

  /**
   * What the prototype-origin SSE stream reads (section 3 of the rework
   * spec): the page follows the process rather than polling for it. A
   * transition that leaves the exposed status the same (the `spawned`
   * acknowledgement, a touch) must not wake it.
   */
  it("subscribe reports starting, running and crashed across a start and an exit, and stops on unsubscribe", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    const seen: string[] = []
    const unsubscribe = procs.subscribe("d1", (status) => seen.push(status.state))

    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    await get(port, "/exit")
    await new Promise((r) => setTimeout(r, 200))
    expect(seen).toEqual(["starting", "running", "crashed"])

    unsubscribe()
    await procs.ensure({ id: "d1", serverStart: start() })
    expect(seen).toEqual(["starting", "running", "crashed"])
  })

  it("stops a server that has been idle past the bound", async () => {
    let now = 0
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), now: () => now, idleMs: 1000, reapIntervalMs: 20 })
    managers.push(procs)
    await procs.ensure({ id: "d1", serverStart: start() })
    const stop = procs.startReaper()
    now = 5000
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(procs.status("d1").state).toBe("stopped")
  })

  /**
   * Codex round 2, item 3: the reaper used to touch `lastUsedAt` only when a
   * request BEGINS, so a long-lived response (SSE, a streamed download) was
   * cut once the idle bound passed even though it was actively being
   * answered. `withLease` marks an entry in-flight for the duration of one
   * request; the reaper must skip any entry with an open lease.
   */
  it("does not reap an entry with a request held open via withLease, and reaps it once released", async () => {
    let now = 0
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      now: () => now,
      idleMs: 200,
      reapIntervalMs: 20,
    })
    managers.push(procs)
    await procs.ensure({ id: "d1", serverStart: start() })
    const release = holdLease(procs, "d1")
    const stop = procs.startReaper()

    now = 5000
    await new Promise((r) => setTimeout(r, 200))
    // Still in-flight: the reaper must have skipped it, however far past the
    // idle bound the clock has moved.
    expect(procs.status("d1").state).toBe("running")

    await release()
    now = 5300
    await new Promise((r) => setTimeout(r, 200))
    stop()
    expect(procs.status("d1").state).toBe("stopped")
  })

  it("shutdown kills every server", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["a", "b"]) })
    managers.push(procs)
    const a = await procs.ensure({ id: "a", serverStart: start() })
    await procs.ensure({ id: "b", serverStart: start() })
    await procs.shutdown()
    await expect(get(a.port)).rejects.toThrow()
    expect(procs.status("a").state).toBe("stopped")
  })

  it("a stop that lands mid-poll never resurrects a dead child as running", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      spawnEnv: { FAKE_DELAY_MS: "1500" },
    })
    managers.push(procs)
    const ensuring = procs.ensure({ id: "d1", serverStart: start() })
    await new Promise((r) => setTimeout(r, 200))
    await procs.stop("d1")
    await expect(ensuring).rejects.toBeInstanceOf(PrototypeProcessError)
    expect(procs.status("d1").state).toBe("stopped")
  })

  /**
   * Codex round 7, Fix 4. This is the `child.once("error", …)` spawn-failure
   * path (ENOENT, here) — the SAME class of bug as the `mkdir` failure
   * below: before the fix, `reason` echoed the raw Node error message, which
   * for a spawn failure carries the absolute binary path. The public reason
   * is now the fixed sentence, whatever the raw error said.
   */
  it("a spawn failure (bad binary) fails fast with a crashed status, and never echoes the binary path", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), readyTimeoutMs: 5000 })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: ["/nonexistent/binary"] })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.reason).toContain("could not be started")
      expect(status.reason).toBe("The server could not be started. See the viewer's log.")
      expect(status.reason).not.toContain("/nonexistent/binary")
    }
  })

  /**
   * Codex round 7, Fix 4. A failure BEFORE spawn (here, the `.desde-home`
   * `mkdir`) used to put the raw Node error's message into `reason` — and
   * that message carries the full path, absolute and including the
   * deployment id, which is exactly what a public status must not leak (the
   * crashed panel and the 503 body reach every reader, public-link readers
   * included). The marker id below stands in for anything sensitive that
   * message could carry.
   *
   * `.desde-home` is pre-created as a FILE (not a directory) so the
   * manager's own `mkdir(home, { recursive: true })` fails with an error
   * whose message embeds the full path — the same shape a permissions or
   * disk-full error would take, just deterministic.
   */
  it("a setup failure before spawn (mkdir for .desde-home fails) exposes a fixed sentence, never the raw error", async () => {
    const id = "homeblockedmarker"
    const root = await checkoutsRoot([id])
    await writeFile(join(root, id, ".desde-home"), "x")
    const procs = createPrototypeProcesses({ checkoutsRoot: root })
    managers.push(procs)
    await expect(procs.ensure({ id, serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status(id)
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.reason).toBe("The server could not be started. See the viewer's log.")
      expect(status.reason).not.toContain(id)
      expect(status.reason).not.toContain(root)
    }
  })

  it("charges a setup failure before spawn to the restart budget", async () => {
    // Codex round 9. A failure that happens on every attempt (a home dir
    // that cannot be made, say) used to record a crash with no restart
    // counted, so it stayed retryable for ever: the review page's embedded
    // poll remounted the frame every five seconds, each remount called
    // ensure, and nothing ever reached the non-retryable panel.
    const id = "homeblockedforever"
    const root = await checkoutsRoot([id])
    await writeFile(join(root, id, ".desde-home"), "x")
    let now = 1_000_000
    const procs = createPrototypeProcesses({ checkoutsRoot: root, now: () => now })
    managers.push(procs)
    for (let i = 0; i < 4; i++) {
      await expect(procs.ensure({ id, serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    }
    const spent = procs.status(id)
    expect(spent.state === "crashed" && spent.retryable).toBe(false)
    // Same window rule as a real crash: once the attempts age out, it is
    // worth trying again.
    now += 6 * 60_000
    const aged = procs.status(id)
    expect(aged.state === "crashed" && aged.retryable).toBe(true)
  })

  it("never hands the child the viewer's own environment, only the allowlist plus spawnEnv", async () => {
    process.env.VIEWER_TEST_SECRET = "must-not-leak"
    try {
      const procs = createPrototypeProcesses({
        checkoutsRoot: await checkoutsRoot(["d1"]),
        spawnEnv: { FAKE_DELAY_MS: "0" },
      })
      managers.push(procs)
      const { port } = await procs.ensure({ id: "d1", serverStart: start() })
      const body = JSON.parse((await get(port, "/env")).body) as Record<string, string>
      expect(body.VIEWER_TEST_SECRET).toBeUndefined()
      expect(body.PATH).toBeTruthy()
      expect(body.PORT).toBe(String(port))
      expect(body.HOSTNAME).toBe("127.0.0.1")
      expect(body.HOST).toBe("127.0.0.1")
      expect(body.NODE_ENV).toBe("production")
    } finally {
      delete process.env.VIEWER_TEST_SECRET
    }
  })

  it("marks a server that never answers as crashed once the ready timeout elapses", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      readyTimeoutMs: 500,
      spawnEnv: { FAKE_DELAY_MS: "3000" },
    })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") expect(status.reason).toContain("did not answer")
  })

  it("two concurrent ensure calls for the same id share one spawn", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    const [a, b] = await Promise.all([
      procs.ensure({ id: "d1", serverStart: start() }),
      procs.ensure({ id: "d1", serverStart: start() }),
    ])
    expect(a.port).toBe(b.port)
    const startingLines = procs.serverLog("d1").split("\n").filter((l) => l.includes("fake server: starting"))
    expect(startingLines).toHaveLength(1)
  })

  /**
   * The crashed status says whether the next `ensure` would try again, so the
   * review page can embed the frame (and let that request restart the
   * process) instead of showing a dead end that only a full rebuild clears.
   * The rule is the manager's own restart budget, not a second copy of it.
   */
  it("marks a transient crash retryable and an over-budget one not", async () => {
    // A driven clock, held still while the crashes happen so all four fall
    // inside one restart window (the budget verdict is the thing under test,
    // not wall-clock luck), then moved forward at the end to show the verdict
    // is read from the window rather than frozen at crash time.
    let now = 1_000_000
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), now: () => now })
    managers.push(procs)
    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    await get(port, "/exit")
    await new Promise((r) => setTimeout(r, 200))
    const first = procs.status("d1")
    expect(first.state === "crashed" && first.retryable).toBe(true)

    for (let i = 0; i < 3; i++) {
      const next = await procs.ensure({ id: "d1", serverStart: start() })
      await get(next.port, "/exit")
      await new Promise((r) => setTimeout(r, 200))
    }
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const spent = procs.status("d1")
    expect(spent.state === "crashed" && spent.retryable).toBe(false)
    // The reader is told the server kept exiting while the budget is spent.
    expect(spent.state === "crashed" && spent.reason).toBe("The server kept exiting. See the server log.")

    // The budget is a five-minute window, and `status()` answers "would the
    // next ensure try again?" as of NOW. Once the four crashes are outside
    // the window the next ensure WOULD try again, so the same crash reports
    // retryable again — the page stops offering a rebuild as the only way
    // out of a prototype that has been sitting there for an hour.
    now += 6 * 60_000
    const aged = procs.status("d1")
    expect(aged.state === "crashed" && aged.retryable).toBe(true)
    // And once a retry is worth it, the last crash's own reason returns.
    expect(aged.state === "crashed" && aged.reason).toBe("The server exited.")
  })

  it("refuses to ensure after shutdown, and spawns nothing", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    await procs.shutdown()
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    // The fixture's first act is to log "fake server: starting", so an empty
    // log is proof no child was spawned — not merely that none answered.
    expect(procs.serverLog("d1")).toBe("")
    expect(procs.status("d1").state).toBe("stopped")
  })

  /**
   * The window `stopEntry` cannot see: it nulls `e.child`, but a `start()`
   * parked before `spawn` has no child yet, so the stop is a no-op and the
   * spawn then proceeds into a process nobody is holding. `pickPort` is
   * parked on a promise here so the stop lands inside exactly that window,
   * rather than by timing luck.
   */
  it("a stop that lands between pickPort and spawn leaves no child behind", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      pickPort: async () => {
        await gate
        return await pickLoopbackPort()
      },
    })
    managers.push(procs)
    const ensuring = procs.ensure({ id: "d1", serverStart: start() })
    await procs.stop("d1")
    release()
    await expect(ensuring).rejects.toBeInstanceOf(PrototypeProcessError)
    expect(procs.status("d1").state).toBe("stopped")
    expect(procs.serverLog("d1")).toBe("")
  })

  it("forget stops the server and drops everything it knew about the deployment", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    expect(procs.serverLog("d1")).toContain("fake server: listening")
    await procs.forget("d1")
    await expect(get(port)).rejects.toThrow()
    expect(procs.status("d1").state).toBe("stopped")
    expect(procs.serverLog("d1")).toBe("")
  })

  it("stop on a running server stops it and it no longer answers", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    expect(procs.status("d1").state).toBe("running")
    await procs.stop("d1")
    expect(procs.status("d1").state).toBe("stopped")
    await expect(get(port)).rejects.toThrow()
  })

  /**
   * Codex round 14, Fix 1. The whole process GROUP has to be gone, not just
   * its leader.
   *
   * SIGTERM goes to the group, and the five second SIGKILL used to be
   * cancelled the moment the LEADER exited. A prototype that forked a worker
   * of its own — a Next server with `experimental.cpus`, a Nitro worker,
   * anything the app spawns — whose worker ignores SIGTERM therefore left
   * that worker alive in the detached group, holding its port, past retire,
   * project delete and viewer shutdown.
   *
   * The fixture's worker exits by itself after five seconds regardless, so a
   * failure here cannot leak a process; the poll below is far shorter than
   * that, so the self-exit can never make a broken manager look fixed.
   */
  it("kills a worker the server forked, even one that ignores SIGTERM", async () => {
    const root = await checkoutsRoot(["d1"])
    const pidFile = join(root, "worker.pid")
    const procs = createPrototypeProcesses({
      checkoutsRoot: root,
      spawnEnv: { FAKE_FORK_WORKER: "1", FAKE_WORKER_PID_FILE: pidFile },
    })
    managers.push(procs)
    await procs.ensure({ id: "d1", serverStart: start() })
    const workerPid = Number(await readFile(pidFile, "utf8"))
    expect(workerPid).toBeGreaterThan(0)
    expect(alive(workerPid), "the fixture never forked a worker to kill").toBe(true)

    await procs.stop("d1")

    await vi.waitFor(() => expect(alive(workerPid)).toBe(false), { timeout: 2000, interval: 25 })
  })

  /**
   * Codex round 5, Fix 2. `serve-router.ts`'s `onUnreachable` used to call
   * `stop()`, which overwrote the manager's status with `stopped` even when
   * the child was genuinely down — and `stopped` says the viewer put the
   * child away on purpose, carrying neither a reason nor a `retryable`
   * verdict for the review page to show. `markUnreachable` records a
   * RETRYABLE `crashed` instead, so the next `ensure` restarts it under the
   * normal budget — same as any other exit.
   */
  describe("markUnreachable", () => {
    it("on a running server, stops it and records a retryable crash", async () => {
      const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
      managers.push(procs)
      const { port } = await procs.ensure({ id: "d1", serverStart: start() })
      expect(procs.status("d1").state).toBe("running")

      await procs.markUnreachable("d1")

      const status = procs.status("d1")
      expect(status.state).toBe("crashed")
      if (status.state === "crashed") {
        expect(status.reason).toBe("The server stopped answering.")
        expect(status.retryable).toBe(true)
      }
      await expect(get(port)).rejects.toThrow()
    })

    it("on an already-crashed entry, leaves the status and its reason alone", async () => {
      const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
      managers.push(procs)
      const { port } = await procs.ensure({ id: "d1", serverStart: start() })
      // Crash it for real first, so there is a specific reason on record —
      // the exit handler's own, not this call's generic one.
      await get(port, "/exit")
      await new Promise((r) => setTimeout(r, 200))
      const before = procs.status("d1")
      expect(before.state).toBe("crashed")

      await procs.markUnreachable("d1")

      const after = procs.status("d1")
      expect(after).toEqual(before)
    })

    it("does nothing to a starting or stopped entry", async () => {
      const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1", "d2"]) })
      managers.push(procs)

      // Never `ensure`d at all: `stopped`.
      await procs.markUnreachable("d2")
      expect(procs.status("d2").state).toBe("stopped")

      // Stopped explicitly, then marked unreachable — still `stopped`, not a
      // manufactured crash for a process that was never claimed to be up.
      await procs.ensure({ id: "d1", serverStart: start() })
      await procs.stop("d1")
      expect(procs.status("d1").state).toBe("stopped")
      await procs.markUnreachable("d1")
      expect(procs.status("d1").state).toBe("stopped")
    })

    it("is a no-op for an id the manager has never seen", async () => {
      const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([]) })
      managers.push(procs)
      await expect(procs.markUnreachable("never-heard-of-it")).resolves.toBeUndefined()
      expect(procs.status("never-heard-of-it").state).toBe("stopped")
    })

    it("a later ensure restarts the server under the normal budget", async () => {
      const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
      managers.push(procs)
      await procs.ensure({ id: "d1", serverStart: start() })
      await procs.markUnreachable("d1")
      expect(procs.status("d1").state).toBe("crashed")

      const restarted = await procs.ensure({ id: "d1", serverStart: start() })
      expect(procs.status("d1").state).toBe("running")
      expect(typeof restarted.port).toBe("number")
    })
  })

  /**
   * The cap only ever counted `running` entries, so several `ensure()`s for
   * DIFFERENT stopped deployments, fired without awaiting between them,
   * could all pass the "is there room" check before any of them had
   * actually finished starting — spawning more children than `maxRunning`
   * allows. `FAKE_DELAY_MS` widens the starting window so a bug here would
   * reliably show more than two `running` entries at once, not just on a
   * lucky fast machine.
   */
  it("caps concurrent COLD starts, not just already-running servers", async () => {
    const ids = ["a", "b", "c", "d"]
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(ids),
      maxRunning: 2,
      spawnEnv: { FAKE_DELAY_MS: "80" },
    })
    managers.push(procs)
    let peak = 0
    let polling = true
    const poll = (async () => {
      while (polling) {
        const runningCount = ids.filter((id) => procs.status(id).state === "running").length
        peak = Math.max(peak, runningCount)
        await new Promise((r) => setTimeout(r, 5))
      }
    })()
    const results = await Promise.allSettled(ids.map((id) => procs.ensure({ id, serverStart: start() })))
    polling = false
    await poll
    // Never more than the cap alive at once, at any point this test looked.
    expect(peak).toBeLessThanOrEqual(2)
    // Every caller gets an answer — none of the four is left hanging just
    // because it lost the race for a slot.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    // Exactly two end up running, and it's the later two: they reserved
    // their slot after a and b, so a and b are the ones that get evicted to
    // make room as the manager converges on the cap.
    const runningIds = ids.filter((id) => procs.status(id).state === "running")
    expect(runningIds).toEqual(["c", "d"])
    expect(procs.status("a").state).toBe("stopped")
    expect(procs.status("b").state).toBe("stopped")
  })

  /**
   * Codex round 14, Fix 2. A slot a cold start is merely WAITING for is not
   * an occupied slot.
   *
   * The room-making loop counted every `starting` record against the cap, so
   * with more concurrent cold starts than the cap every waiter saw the cap
   * exceeded. One leader went through, became running, and was leased by its
   * own request — and every other waiter then found nothing evictable and
   * fell into the busy refusal with three of the four slots still free.
   * MEASURED before the fix: one of six running, five refused.
   *
   * The rule now counts a start only once it has been ADMITTED (passed the
   * room-making loop), so the cap admits exactly `maxRunning` of them and the
   * rest wait on a start that is actually going somewhere.
   */
  it("admits cold starts up to the cap, and refuses the rest only once every slot is running and busy", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"]
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(ids),
      maxRunning: 4,
      spawnEnv: { FAKE_DELAY_MS: "80" },
    })
    managers.push(procs)
    const runningIds = (): string[] => ids.filter((id) => procs.status(id).state === "running")

    const attempts = ids.map((id) => leasedEnsure(procs, id))
    const outcomes = await Promise.all(
      attempts.map((attempt) =>
        attempt.started.then(
          () => ({ refused: null, runningThen: 0 }),
          (error: unknown) => ({ refused: error, runningThen: runningIds().length }),
        ),
      ),
    )

    expect(runningIds()).toHaveLength(4)
    const refusals = outcomes.filter((outcome) => outcome.refused !== null)
    expect(refusals).toHaveLength(2)
    for (const refusal of refusals) {
      expect(refusal.refused).toMatchObject({
        message: "Every prototype server is busy. Try again in a moment.",
      })
      // Not refused while a slot was still free: every one of the four was up
      // and holding its request's lease before either of these gave up.
      expect(refusal.runningThen).toBe(4)
    }

    for (const attempt of attempts) await attempt.release()
  })

  /** The plain case the admission rule must not change: one over the cap, one eviction. */
  it("evicts one idle entry when a fifth deployment starts at a cap of four", async () => {
    const ids = ["a", "b", "c", "d"]
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot([...ids, "e"]),
      maxRunning: 4,
    })
    managers.push(procs)
    for (const id of ids) await procs.ensure({ id, serverStart: start() })

    await expect(procs.ensure({ id: "e", serverStart: start() })).resolves.toBeTruthy()

    expect(procs.status("e").state).toBe("running")
    // The least recently used of the four, and only that one.
    expect(procs.status("a").state).toBe("stopped")
    expect(ids.filter((id) => procs.status(id).state === "running")).toEqual(["b", "c", "d"])
  })

  /** Under the cap there is nothing to make room for, so nobody waits and nobody is refused. */
  it("admits three concurrent cold starts under a cap of four, refusing none", async () => {
    const ids = ["a", "b", "c"]
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(ids),
      maxRunning: 4,
      spawnEnv: { FAKE_DELAY_MS: "80" },
    })
    managers.push(procs)

    const results = await Promise.allSettled(ids.map((id) => procs.ensure({ id, serverStart: start() })))

    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(ids.filter((id) => procs.status(id).state === "running")).toEqual(ids)
  })

  /**
   * Closes the prune race in `checkouts.ts`: `pruneSupersededCheckouts`
   * stops the process (`beforeRemove`) and THEN deletes the checkout
   * directory, but a request can still land in between and call `ensure`,
   * spawning a fresh child into a directory that is about to vanish.
   * `retire` is what `beforeRemove` calls instead of `stop` — it leaves a
   * permanent, non-retryable crash behind so that window is refused rather
   * than raced.
   */
  it("retire stops the server and permanently refuses ensure until forget", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    await procs.retire("d1")
    await expect(get(port)).rejects.toThrow()
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.retryable).toBe(false)
      expect(status.reason).toMatch(/removed/i)
    }
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    // Still crashed and non-retryable — an `ensure` must not have been
    // allowed to try again and overwrite the retired status.
    const after = procs.status("d1")
    expect(after.state).toBe("crashed")
    if (after.state === "crashed") expect(after.retryable).toBe(false)
  })

  it("retire on a deployment with no entry yet still leaves it permanently refused", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([]) })
    managers.push(procs)
    await procs.retire("never-started")
    const status = procs.status("never-started")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") expect(status.retryable).toBe(false)
  })

  it("forget clears a retired entry, so the id (or a fresh one) can start again", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    await procs.retire("d1")
    await procs.forget("d1")
    expect(procs.status("d1").state).toBe("stopped")
    // Nothing left behind either — this is the half of codex round 3, item 4
    // (`checkouts.ts`) that lives here: once a checkout is actually gone,
    // `pruneSupersededCheckouts` calls `forget`, not just `retire`, so the
    // permanent map entry `retire` left is dropped too.
    expect(procs.serverLog("d1")).toBe("")
  })

  /**
   * Codex round 3, item 1. `retire()` used to await `stopEntry` (which waits
   * for the old child to exit, up to 5s on a SIGTERM it ignores) BEFORE
   * setting `e.retired`. A request landing on the still-open pinned listener
   * in that window could call `ensure`, find the entry not retired yet (its
   * status had already been reset to "stopped" by `stopEntry`'s own
   * synchronous top-of-function reset), and start a replacement — which
   * `retire`'s caller (`pruneSupersededCheckouts`) then deletes the checkout
   * directory out from under, once `retire` itself finishes.
   *
   * `FAKE_SIGTERM_DELAY_MS` makes the fixture hold off exiting so the window
   * `stopEntry` is awaiting in is wide enough to land a concurrent `ensure`
   * inside it deterministically, not by timing luck.
   */
  it("retire refuses a concurrent ensure immediately, before its slow stop finishes", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      spawnEnv: { FAKE_SIGTERM_DELAY_MS: "300" },
    })
    managers.push(procs)
    await procs.ensure({ id: "d1", serverStart: start() })
    // Deliberately not awaited: `retire`'s synchronous prefix must run and
    // mark the entry retired before this call returns control here.
    const retiring = procs.retire("d1")
    // The refusal is immediate: `ensure` rejects well before `retiring`
    // settles (the fixture is still 300ms from exiting).
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    // No replacement child was spawned in the window: the fixture logs
    // "fake server: starting" once per spawn, and there must be exactly one.
    const startingLines = procs.serverLog("d1").split("\n").filter((l) => l.includes("fake server: starting"))
    expect(startingLines).toHaveLength(1)
    await retiring
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.retryable).toBe(false)
      expect(status.reason).toMatch(/removed/i)
    }
  })

  /**
   * The round-12 critical, runtime half. `retire` used to land on a record
   * that was still `starting` and leave the cold start free to continue: the
   * machine ABSORBED the `spawned` and `ready` that start was carrying, so
   * `apply` never threw, a child was spawned into a checkout
   * `pruneSupersededCheckouts` was about to delete, and `ensure` resolved
   * with its port. `forget` then dropped the record without killing, and the
   * child outlived the viewer.
   *
   * `pickPort` is parked on a gate here so the `retire` lands inside exactly
   * the window that start is in — before the spawn — rather than by timing
   * luck. The fixture's first act is to log "fake server: starting", so an
   * empty log is proof no child was ever spawned, not merely that none
   * answered.
   */
  it("a retire that lands between pickPort and spawn never spawns a child at all", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      pickPort: async () => {
        await gate
        return await pickLoopbackPort()
      },
    })
    managers.push(procs)
    const ensuring = procs.ensure({ id: "d1", serverStart: start() })
    await procs.retire("d1")
    release()

    await expect(ensuring).rejects.toBeInstanceOf(PrototypeProcessError)
    expect(procs.serverLog("d1")).toBe("")
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.retryable).toBe(false)
      expect(status.reason).toMatch(/removed/i)
    }
  })

  /**
   * The same critical's second variant: the `retire` lands while the
   * readiness probe is already in flight against a child that HAS spawned.
   * The kill effect stops that child, the probe still comes back with an
   * answer, and the `ready` it produces used to be absorbed — so `ensure`
   * resolved with the port of a process that was being torn down, and the
   * reader got the proxy's 502 instead of the retired 503.
   *
   * Deterministic rather than timed: the fixture logs when the probe arrives
   * and holds the response open for 200ms, and `FAKE_SIGTERM_DELAY_MS` keeps
   * the child alive long enough to answer it. The lock does the rest — the
   * `ready` transition queues behind `retire`'s own slow stop, so it is
   * always applied to a record that is already `retired`.
   */
  it("a retire that lands while the readiness probe is in flight refuses the ready and leaves nothing listening", async () => {
    let chosen = 0
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      spawnEnv: { FAKE_RESPONSE_DELAY_MS: "200", FAKE_SIGTERM_DELAY_MS: "500" },
      pickPort: async () => {
        chosen = await pickLoopbackPort()
        return chosen
      },
    })
    managers.push(procs)
    const ensuring = procs.ensure({ id: "d1", serverStart: start() })
    await vi.waitFor(
      () => {
        expect(procs.serverLog("d1")).toContain("fake server: probe received")
      },
      { timeout: 5000 },
    )
    await procs.retire("d1")

    await expect(ensuring).rejects.toBeInstanceOf(PrototypeProcessError)
    await expect(get(chosen)).rejects.toThrow()
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.retryable).toBe(false)
      expect(status.reason).toMatch(/removed/i)
    }
  })

  /**
   * A lease is released against the record it was taken on, never against
   * whatever record happens to be under that id later. `forget` drops the
   * record while a request is still in flight; the next request creates a
   * fresh one and starts a new child under its own lease. Releasing the old
   * lease onto the new record left that child unprotected mid-response, so
   * the very next cold start elsewhere could evict it.
   */
  it("a lease released after a forget is not charged to the record that replaced it", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1", "d2"]),
      maxRunning: 1,
    })
    managers.push(procs)
    const releaseFirst = holdLease(procs, "d1")
    await procs.ensure({ id: "d1", serverStart: start() })
    await procs.forget("d1")

    // A pinned listener is still open for d1, so a second request lands and
    // starts it again under its own lease.
    const releaseSecond = holdLease(procs, "d1")
    await procs.ensure({ id: "d1", serverStart: start() })
    // The first request's response finally closes.
    await releaseFirst()

    // d1 is still answering a request, so it is not a victim: the cold start
    // that wanted its slot is refused instead.
    await expect(procs.ensure({ id: "d2", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    expect(procs.status("d1").state).toBe("running")
    await releaseSecond()
  })

  /**
   * `forget` during a cold start. The child is killed rather than left
   * running (the machine's `forget` row), the cold start rejects, and the id
   * is left clean enough to start again from scratch — no record of the
   * abandoned attempt, no leftover log.
   */
  it("a forget during a cold start kills the child and leaves the id startable again", async () => {
    let chosen = 0
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      spawnEnv: { FAKE_DELAY_MS: "400" },
      pickPort: async () => {
        chosen = await pickLoopbackPort()
        return chosen
      },
    })
    managers.push(procs)
    const ensuring = procs.ensure({ id: "d1", serverStart: start() })
    await vi.waitFor(() => {
      expect(procs.serverLog("d1")).toContain("fake server: starting")
    })
    await procs.forget("d1")

    await expect(ensuring).rejects.toBeInstanceOf(PrototypeProcessError)
    await expect(get(chosen)).rejects.toThrow()
    expect(procs.status("d1").state).toBe("stopped")

    const again = await procs.ensure({ id: "d1", serverStart: start() })
    expect((await get(again.port)).body).toContain("hello from")
  })

  it("stop on a deployment the manager has never seen does nothing, and the id still starts", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    await procs.stop("d1")
    expect(procs.status("d1").state).toBe("stopped")
    const { port } = await procs.ensure({ id: "d1", serverStart: start() })
    expect((await get(port)).body).toContain("hello from")
  })

  /**
   * Codex round 3, item 3. A throw from `pickPort`, `substitutePort` (empty
   * `serverStart`) or the `.desde-home` `mkdir` — all AFTER `start()` marks
   * the entry "starting" to reserve its cap slot, but BEFORE `spawn` — used
   * to reject `ensure` while leaving the entry stuck `starting` forever,
   * permanently occupying a slot against `maxRunning`.
   */
  it("a setup failure before spawn (empty serverStart) is crashed, not stuck starting", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]) })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: [] })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") {
      expect(status.reason).toContain("could not be started")
      expect(status.retryable).toBe(true)
    }
  })

  it("a setup failure before spawn (pickPort rejects) is crashed, not stuck starting", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["d1"]),
      pickPort: async () => {
        throw new Error("no ports available")
      },
    })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") expect(status.reason).toContain("could not be started")
  })

  it("a setup failure releases its cap slot, so a healthy deployment can still start under a tight cap", async () => {
    const procs = createPrototypeProcesses({
      checkoutsRoot: await checkoutsRoot(["bad", "good"]),
      maxRunning: 1,
    })
    managers.push(procs)
    await expect(procs.ensure({ id: "bad", serverStart: [] })).rejects.toBeInstanceOf(PrototypeProcessError)
    expect(procs.status("bad").state).not.toBe("starting")
    await expect(procs.ensure({ id: "good", serverStart: start() })).resolves.toBeTruthy()
    expect(procs.status("good").state).toBe("running")
  })
})

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createPrototypeProcesses, pickLoopbackPort, PrototypeProcessError } from "./prototype-processes"

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
async function get(port: number, path = "/"): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.text() }
}

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
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot([]) })
    managers.push(procs)
    await expect(procs.ensure({ id: "gone", serverStart: start() })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("gone")
    expect(status.state === "crashed" && /checkout/i.test(status.reason)).toBe(true)
    // Nothing a retry could fix: the files are not there.
    expect(status.state === "crashed" && status.retryable).toBe(false)
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

  it("a spawn failure (bad binary) fails fast with a crashed status naming the cause", async () => {
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), readyTimeoutMs: 5000 })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: ["/nonexistent/binary"] })).rejects.toBeInstanceOf(PrototypeProcessError)
    const status = procs.status("d1")
    expect(status.state).toBe("crashed")
    if (status.state === "crashed") expect(status.reason).toContain("could not be started")
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
    // A frozen clock, so all four crashes fall inside one restart window and
    // the budget verdict is the thing under test rather than wall-clock luck.
    const now = 1_000_000
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
})

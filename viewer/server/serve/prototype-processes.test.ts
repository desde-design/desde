import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createPrototypeProcesses, PrototypeProcessError } from "./prototype-processes"

const FAKE = resolve(__dirname, "__tests__/fixtures/fake-server.mjs")
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
function start(extraEnv: Record<string, string> = {}): string[] {
  // `node` from PATH; env pairs ride as `KEY=VALUE` argv entries the manager
  // turns into env (see `startArgvEnv`), because the argv is the only thing
  // a deployment records.
  return ["node", FAKE, ...Object.entries(extraEnv).map(([k, v]) => `--env=${k}=${v}`)]
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
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), readyTimeoutMs: 5000 })
    managers.push(procs)
    await expect(procs.ensure({ id: "d1", serverStart: start({ FAKE_EXIT_CODE: "3" }) })).rejects.toBeInstanceOf(
      PrototypeProcessError,
    )
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
  })

  it("restarts a crashed server on the next ensure, up to three times in five minutes", async () => {
    let now = 1_000_000
    const procs = createPrototypeProcesses({ checkoutsRoot: await checkoutsRoot(["d1"]), now: () => now })
    managers.push(procs)
    for (let i = 0; i < 3; i++) {
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
    const a = await procs.ensure({ id: "a", serverStart: start() })
    await procs.ensure({ id: "b", serverStart: start() })
    await procs.shutdown()
    await expect(get(a.port)).rejects.toThrow()
    expect(procs.status("a").state).toBe("stopped")
  })
})

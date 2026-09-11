import { spawn, type ChildProcess } from "node:child_process"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { buildEnv } from "../build/exec"
import { checkoutDirFor } from "../build/checkouts"
import type { Deployment } from "../storage/types"

/**
 * Runs a server prototype's own server as a child process, on demand.
 *
 * One process per deployment, started by the first request that needs it
 * and stopped when idle, at the cap, on prune, or at shutdown. The spawn
 * discipline is `build/exec.ts`'s: an env ALLOWLIST (the Viewer's secrets
 * never reach the child), `detached` so the whole tree dies together, and
 * a loopback bind only. See the server-prototypes spec, "Process manager".
 */
export type ProcessStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; since: string }
  | { state: "crashed"; exitCode: number | null; restarts: number; reason: string }

export class PrototypeProcessError extends Error {
  readonly name = "PrototypeProcessError"
  constructor(
    public readonly status: ProcessStatus,
    message: string,
  ) {
    super(message)
  }
}

export interface PrototypeProcesses {
  ensure(deployment: Pick<Deployment, "id" | "serverStart">): Promise<{ port: number }>
  touch(deploymentId: string): void
  stop(deploymentId: string): Promise<void>
  status(deploymentId: string): ProcessStatus
  serverLog(deploymentId: string): string
  startReaper(): () => void
  shutdown(): Promise<void>
}

export const MAX_RUNNING_SERVER_PROTOTYPES = 4
const LOG_BYTES = 64 * 1024
const RESTART_BUDGET = 3
const RESTART_WINDOW_MS = 5 * 60_000

export interface PrototypeProcessesDeps {
  checkoutsRoot: string
  now?: () => number
  readyTimeoutMs?: number
  idleMs?: number
  reapIntervalMs?: number
  maxRunning?: number
  pickPort?: () => Promise<number>
}

/** Binds an ephemeral loopback port and releases it, so the child can take it. */
export async function pickLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const address = s.address()
      const port = typeof address === "object" && address ? address.port : 0
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))))
    })
  })
}

/**
 * The recorded argv may carry `--env=KEY=VALUE` entries, which become env
 * for the child rather than arguments. Nothing an adapter ships uses this
 * today; the test fixture does, and it keeps "one argv" as the whole record.
 */
export function startArgvEnv(argv: string[], port: number): { file: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  const args: string[] = []
  for (const a of argv) {
    const m = /^--env=([A-Z0-9_]+)=(.*)$/.exec(a)
    if (m) env[m[1]!] = m[2]!
    else args.push(a.replaceAll("$PORT", String(port)))
  }
  const [file, ...rest] = args
  if (!file) throw new Error("serverStart is empty")
  return { file, args: rest, env }
}

interface Entry {
  status: ProcessStatus
  child: ChildProcess | null
  port: number | null
  lastUsedAt: number
  /**
   * A monotonic counter, bumped alongside `lastUsedAt` on every touch.
   *
   * `lastUsedAt` alone is `now()`, which under the real clock has 1ms
   * resolution: two entries touched within the same millisecond tie, and
   * `Array.prototype.sort`'s stability then falls back to Map insertion
   * order, evicting whichever entry was CREATED first rather than used
   * least recently. `recency` can never tie, so LRU eviction stays correct
   * even when `touch()` and a sibling's start race inside one millisecond
   * (MEASURED: this happened in the LRU test on this machine).
   */
  recency: number
  log: string
  restartsAt: number[]
  opening: Promise<{ port: number }> | null
}

export function createPrototypeProcesses(deps: PrototypeProcessesDeps): PrototypeProcesses {
  const now = deps.now ?? (() => Date.now())
  const readyTimeoutMs = deps.readyTimeoutMs ?? 60_000
  const idleMs = deps.idleMs ?? 30 * 60_000
  const reapIntervalMs = deps.reapIntervalMs ?? 5 * 60_000
  const maxRunning = deps.maxRunning ?? MAX_RUNNING_SERVER_PROTOTYPES
  const pickPort = deps.pickPort ?? pickLoopbackPort
  const entries = new Map<string, Entry>()
  let recencyCounter = 0
  /** Bumps both the human-readable `lastUsedAt` and the tie-proof `recency`. */
  const touchEntry = (e: Entry): void => {
    e.lastUsedAt = now()
    e.recency = recencyCounter++
  }

  const entryFor = (id: string): Entry => {
    let e = entries.get(id)
    if (!e) {
      e = { status: { state: "stopped" }, child: null, port: null, lastUsedAt: now(), recency: recencyCounter++, log: "", restartsAt: [], opening: null }
      entries.set(id, e)
    }
    return e
  }
  const append = (e: Entry, text: string): void => {
    e.log = (e.log + text).slice(-LOG_BYTES)
  }
  const killTree = (child: ChildProcess, sig: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, sig)
    } catch {
      /* already gone */
    }
  }
  const running = (): [string, Entry][] => [...entries].filter(([, e]) => e.status.state === "running")

  async function stopEntry(e: Entry): Promise<void> {
    const child = e.child
    e.child = null
    e.port = null
    e.status = { state: "stopped" }
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child, "SIGKILL")
      }, 5000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      killTree(child, "SIGTERM")
    })
  }

  async function answers(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 }, (res) => {
        res.resume()
        resolve(true)
      })
      req.on("error", () => resolve(false))
      req.on("timeout", () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  async function start(id: string, serverStart: string[], e: Entry): Promise<{ port: number }> {
    const cwd = checkoutDirFor(deps.checkoutsRoot, id)
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")
    } catch {
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: "The checkout for this deployment is missing. Rebuild it." }
      throw new PrototypeProcessError(e.status, e.status.reason)
    }
    const recent = e.restartsAt.filter((t) => now() - t < RESTART_WINDOW_MS)
    e.restartsAt = recent
    if (recent.length >= RESTART_BUDGET) {
      e.status = { state: "crashed", exitCode: e.status.state === "crashed" ? e.status.exitCode : null, restarts: recent.length, reason: "The server kept exiting. See the server log." }
      throw new PrototypeProcessError(e.status, e.status.reason)
    }
    // Make room. Never evict one that is starting.
    while (running().length >= maxRunning) {
      const [victimId] = running().sort((a, b) => a[1].recency - b[1].recency)[0]!
      await stopEntry(entryFor(victimId))
    }

    const port = await pickPort()
    const { file, args, env } = startArgvEnv(serverStart, port)
    const home = join(cwd, "..", `${id}.home`)
    await mkdir(home, { recursive: true })
    e.status = { state: "starting" }
    e.log = ""
    const child = spawn(file, args, {
      cwd,
      env: buildEnv(home, { NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", ...env }) as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    e.child = child
    child.stdout?.on("data", (b: Buffer) => append(e, b.toString("utf8")))
    child.stderr?.on("data", (b: Buffer) => append(e, b.toString("utf8")))
    let exited = false
    child.once("exit", (code) => {
      exited = true
      if (e.child !== child) return
      e.child = null
      e.port = null
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: code, restarts: e.restartsAt.length, reason: "The server exited." }
    })
    child.once("error", (error) => append(e, `\n${error.message}\n`))

    const deadline = now() + readyTimeoutMs
    while (!exited && now() < deadline) {
      if (await answers(port)) {
        e.port = port
        e.status = { state: "running", port, since: new Date(now()).toISOString() }
        touchEntry(e)
        return { port }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!exited) {
      await stopEntry(e)
      e.restartsAt.push(now())
      e.status = { state: "crashed", exitCode: null, restarts: e.restartsAt.length, reason: "The server did not answer within a minute." }
    }
    throw new PrototypeProcessError(e.status, e.status.state === "crashed" ? e.status.reason : "The server did not start.")
  }

  return {
    async ensure(deployment) {
      if (!deployment.serverStart) {
        throw new PrototypeProcessError({ state: "stopped" }, "This deployment is served as files, not as a server.")
      }
      const e = entryFor(deployment.id)
      if (e.status.state === "running" && e.port !== null) {
        touchEntry(e)
        return { port: e.port }
      }
      if (e.opening) return await e.opening
      e.opening = start(deployment.id, deployment.serverStart, e).finally(() => {
        e.opening = null
      })
      return await e.opening
    },
    touch(id) {
      const e = entries.get(id)
      if (e) touchEntry(e)
    },
    async stop(id) {
      const e = entries.get(id)
      if (e) await stopEntry(e)
    },
    status(id) {
      return entries.get(id)?.status ?? { state: "stopped" }
    },
    serverLog(id) {
      return entries.get(id)?.log ?? ""
    },
    startReaper() {
      const timer = setInterval(() => {
        for (const [, e] of running()) {
          if (now() - e.lastUsedAt >= idleMs) void stopEntry(e)
        }
      }, reapIntervalMs)
      timer.unref()
      return () => clearInterval(timer)
    },
    async shutdown() {
      await Promise.all([...entries.values()].map((e) => stopEntry(e)))
    },
  }
}

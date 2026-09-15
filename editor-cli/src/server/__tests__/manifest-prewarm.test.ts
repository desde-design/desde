/**
 * Tests for manifest-prewarm.ts: the parent side is driven with a fake
 * `spawn` (a real child would run the checker over the test's own
 * node_modules), the child side once for real against an empty root.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PREWARM_CHILD_FLAG,
  formatPrewarmResultLine,
  parsePrewarmResult,
  prewarmManifestsAtBoot,
  runManifestPrewarmWork,
} from "../manifest-prewarm.js"
import { getGroundingService, resetGroundingCache, type GroundingLoaders } from "../grounding-context.js"
import type { GroundingService } from "../../../../src/editor/core"

afterEach(() => resetGroundingCache())

/** A stand-in for a spawned child: streams we write to, an exit we trigger. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  child.unref = vi.fn()
  return child
}

function serviceWithSource(): GroundingService {
  const getManifestSource = vi.fn(async () => ({
    id: "fake",
    framework: "react" as const,
    designSystem: "acme",
    listComponents: async () => [],
    getComponent: async () => null,
  }))
  return {
    getManifestSource,
    tokens: { id: "t", designSystem: "acme", listTokens: async () => [], getToken: async () => null },
    getProjectKnowledge: () => ({ rules: "", rulesFiles: [], docIndex: [], truncated: false }),
    getGroundingHealth: async () => null,
  }
}

function loaders(
  service: GroundingService,
  logs: string[],
  createGroundingService = vi.fn(() => service),
): GroundingLoaders {
  return {
    loadCreateGroundingService: async () =>
      ({ createGroundingService }) as unknown as Awaited<
        ReturnType<GroundingLoaders["loadCreateGroundingService"]>
      >,
    logger: (msg) => logs.push(msg),
  }
}

describe("result line", () => {
  it("round-trips through the stdout line the parent reads", () => {
    const line = formatPrewarmResultLine({ ok: true, components: 12, ms: 340 })
    expect(parsePrewarmResult(`noise\n${line}\nmore noise\n`)).toEqual({
      ok: true,
      components: 12,
      ms: 340,
    })
  })

  it("treats a mangled or absent line as no result", () => {
    expect(parsePrewarmResult("")).toBeNull()
    expect(parsePrewarmResult("__desde_prewarm__ {not json")).toBeNull()
    expect(parsePrewarmResult('__desde_prewarm__ {"ok":true}')).toBeNull()
  })
})

describe("prewarmManifestsAtBoot", () => {
  it("re-invokes this CLI in the hidden mode and reports what the child found", async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child as unknown as ChildProcess)
    const logs: string[] = []
    const service = serviceWithSource()

    const outcome = prewarmManifestsAtBoot({
      root: "/proto",
      execPath: "/usr/bin/node",
      execArgv: ["--import", "tsx"],
      cliEntry: "/cli/src/cli.ts",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      logger: (m) => logs.push(m),
      groundingLoaders: loaders(service, logs),
    })
    child.stdout.write(`${formatPrewarmResultLine({ ok: true, components: 6295, ms: 14000 })}\n`)
    child.emit("exit", 0, null)

    expect(await outcome).toEqual({
      child: { ok: true, components: 6295, ms: 14000 },
      memo: "warm",
    })
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["--import", "tsx", "/cli/src/cli.ts", PREWARM_CHILD_FLAG, "/proto"],
      expect.objectContaining({ cwd: "/proto" }),
    )
    expect(child.unref).toHaveBeenCalled()
    expect(logs.some((l) => /manifests ready: 6295 components in 14\.0s/.test(l))).toBe(true)
  })

  it("warms the parent's memo AFTER the child, through the same service the routes use", async () => {
    // Order matters: the composite built in the parent reads the cache files
    // the child wrote. Building it first would miss them.
    const child = fakeChild()
    const service = serviceWithSource()
    const logs: string[] = []
    const createGroundingService = vi.fn(() => service)
    const groundingLoaders = loaders(service, logs, createGroundingService)

    const outcome = prewarmManifestsAtBoot({
      root: "/proto",
      cliEntry: "/cli",
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      logger: () => {},
      groundingLoaders,
    })
    await Promise.resolve()
    expect(service.getManifestSource).not.toHaveBeenCalled()

    child.stdout.write(`${formatPrewarmResultLine({ ok: true, components: 1, ms: 5 })}\n`)
    child.emit("exit", 0, null)
    await outcome

    expect(service.getManifestSource).toHaveBeenCalledTimes(1)
    // The routes resolve the same service instance (constructed once), so
    // the composite the warm built is the one they read. The manifest
    // promise itself is memoized inside the real service, not this fake.
    await getGroundingService("/proto", groundingLoaders)
    expect(createGroundingService).toHaveBeenCalledTimes(1)
  })

  it("logs a child that died without a result, naming its last stderr line, and still warms the memo", async () => {
    const child = fakeChild()
    const logs: string[] = []
    const service = serviceWithSource()

    const outcome = prewarmManifestsAtBoot({
      root: "/proto",
      cliEntry: "/cli",
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      logger: (m) => logs.push(m),
      groundingLoaders: loaders(service, logs),
    })
    child.stderr.write("some warning\nTypeError: checker exploded\n")
    child.emit("exit", 1, null)

    const result = await outcome
    expect(result.child).toMatchObject({
      ok: false,
      reason: "child ended with exit code 1 and no result: TypeError: checker exploded",
    })
    expect(result.memo).toBe("warm")
    expect(logs.some((l) => /manifest prewarm failed .*checker exploded/.test(l))).toBe(true)
  })

  it("kills a child that exceeds the timeout and reports it", async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const logs: string[] = []
      const outcome = prewarmManifestsAtBoot({
        root: "/proto",
        cliEntry: "/cli",
        spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
        timeoutMs: 1000,
        logger: (m) => logs.push(m),
        groundingLoaders: loaders(serviceWithSource(), logs),
      })
      await vi.advanceTimersByTimeAsync(1001)
      const result = await outcome
      expect(child.kill).toHaveBeenCalledWith("SIGTERM")
      expect(result.child).toMatchObject({ ok: false, reason: "child exceeded 1.0s" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a spawn error without throwing", async () => {
    const child = fakeChild()
    const logs: string[] = []
    const outcome = prewarmManifestsAtBoot({
      root: "/proto",
      cliEntry: "/cli",
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      logger: (m) => logs.push(m),
      groundingLoaders: loaders(serviceWithSource(), logs),
    })
    child.emit("error", new Error("ENOENT"))
    expect((await outcome).child).toMatchObject({ ok: false, reason: "spawn failed: ENOENT" })
  })
})

describe("runManifestPrewarmWork", () => {
  it("lists a root with nothing in it as zero components rather than failing", async () => {
    // Real adapters, real build, against an empty directory: proves the
    // child mode can run end to end, not only that its output parses.
    const root = await mkdtemp(join(tmpdir(), "desde-prewarm-"))
    try {
      const result = await runManifestPrewarmWork(root)
      expect(result).toMatchObject({ ok: true, components: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it("reports an unreadable root as no manifest source", async () => {
    const result = await runManifestPrewarmWork("/definitely/not/a/dir")
    expect(result).toMatchObject({ ok: false, reason: "no manifest source" })
  }, 30_000)
})

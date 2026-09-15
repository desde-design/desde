/**
 * Boot-time manifest prewarm, run OUT OF PROCESS.
 *
 * The problem. On a cold on-disk manifest cache the first selection after
 * boot waited ~10s for the inspector's prop definitions. MEASURED per source
 * against a shadcn repo (2026-09-15, `lucide-react@1.46.0`): the composite
 * build is ~1.4s of async file I/O, every first-party and Vue source is
 * under 50ms, and the lucide declaration extraction is the ENTIRE rest:
 * 6295 icon components through the TypeScript checker, 14s on a quiet
 * machine and 37s under load. That extraction is synchronous checker work
 * (`ReactDtsMetaManifestSource.populate` has no await in it). Whatever
 * thread runs it is frozen for the duration.
 *
 * Why not just warm it in-process at boot. The first version of this did
 * exactly that. A 50ms interval inside the CLI process recorded a maximum
 * event-loop lag of 35.7s across one cold warm, which is the HTTP server
 * not answering for 35.7s while the browser is loading the Editor page.
 * That moves the wait from "after the first click" to "before the page
 * appears", which is worse. (An HTTP probe of the bootstrap script during
 * the same window read as unaffected, twice; it was wrong, and the in-
 * process counter is the measurement to trust.)
 *
 * What this does instead.
 *   1. Spawn THIS CLI again as a child, in a hidden mode
 *      (`--prewarm-manifests <root>`), the same re-invocation the launcher
 *      uses to boot an editor: `process.execPath` + `process.execArgv` (so a
 *      tsx-loaded dev run passes its loader down) + `process.argv[1]`. The
 *      child builds the composite and lists every component. Each
 *      `CachedManifestSource` in it persists its extraction to
 *      `<root>/.desde/manifests/` on the way, which is the only output that
 *      matters: the files.
 *   2. When the child exits, warm the parent's memoized grounding service
 *      (`warmGroundingMemo`): build the composite here too, which is the
 *      async I/O part only. Nothing in the parent calls `listComponents()`,
 *      so the parent never runs the checker at boot; the first click's
 *      per-source `ensure()` reads the child's cache files instead of
 *      extracting.
 *
 * A source with no on-disk cache (no resolvable package version, or a
 * `.desde` that is a symbolic link) still extracts on the first click, in
 * the parent, exactly as before this existed. The child's work for it is
 * wasted, and that is the whole cost of the edge.
 *
 * A click that lands before the child finishes also behaves exactly as
 * before: the parent's source misses the cache and extracts in-process.
 * Both then write the same file through an atomic rename. No worse than
 * today, and the inspector's "Still reading" copy covers the wait.
 *
 * Never fails boot: every path here resolves, and a failed child only logs
 * one line.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import {
  defaultGroundingLoaders,
  warmGroundingMemo,
  type GroundingLoaders,
} from "./grounding-context.js"

/**
 * The hidden CLI mode. `cli.ts` checks for it before ordinary argument
 * parsing and runs {@link runManifestPrewarmWork} instead of booting. Not in
 * `--help`: nothing a user would run by hand.
 */
export const PREWARM_CHILD_FLAG = "--prewarm-manifests"

/**
 * Prefix of the ONE stdout line the parent reads from the child. Everything
 * else the child prints (adapter warnings, mostly) is stderr and stays with
 * the child.
 */
export const PREWARM_RESULT_PREFIX = "__desde_prewarm__ "

export type PrewarmChildResult =
  | { ok: true; components: number; ms: number }
  | { ok: false; reason: string; ms: number }

/**
 * Child side. Builds the composite manifest source for `root` and lists every
 * component, which persists each cached source's extraction to disk. Pure in
 * the sense that matters for tests: no `process.exit`, no printing.
 */
export async function runManifestPrewarmWork(root: string): Promise<PrewarmChildResult> {
  const startedAt = Date.now()
  try {
    const { buildManifestSource } = await import(
      "../../../src/editor/edit-service/build-manifest-source.js"
    )
    const built = await buildManifestSource(root)
    if (!built) {
      return { ok: false, reason: "no manifest source", ms: Date.now() - startedAt }
    }
    const manifests = await built.source.listComponents()
    return { ok: true, components: manifests.length, ms: Date.now() - startedAt }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      ms: Date.now() - startedAt,
    }
  }
}

/** Encode a child result as the stdout line the parent parses. */
export function formatPrewarmResultLine(result: PrewarmChildResult): string {
  return `${PREWARM_RESULT_PREFIX}${JSON.stringify(result)}`
}

/** Find and decode the result line in a child's stdout. `null` when absent. */
export function parsePrewarmResult(stdout: string): PrewarmChildResult | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(PREWARM_RESULT_PREFIX)) continue
    try {
      const parsed = JSON.parse(line.slice(PREWARM_RESULT_PREFIX.length)) as unknown
      if (isChildResult(parsed)) return parsed
    } catch {
      // Fall through: a mangled line is the same as no line.
    }
  }
  return null
}

function isChildResult(value: unknown): value is PrewarmChildResult {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.ms !== "number") return false
  if (v.ok === true) return typeof v.components === "number"
  if (v.ok === false) return typeof v.reason === "string"
  return false
}

export interface PrewarmManifestsOptions {
  /** Canonical prototype root, the same one the grounding service is keyed by. */
  root: string
  /**
   * How to re-invoke this CLI. Defaults mirror the launcher's
   * `defaultSpawnEditor`: the running node, its flags, and this entry file.
   */
  execPath?: string
  execArgv?: readonly string[]
  cliEntry?: string
  /** Injected for tests, which must never spawn a real extraction. */
  spawn?: typeof nodeSpawn
  /** Hard cap on the child. Past it the child is killed and the warm is logged as failed. */
  timeoutMs?: number
  logger?: (msg: string) => void
  groundingLoaders?: GroundingLoaders
}

export interface PrewarmManifestsOutcome {
  /** What the child reported, or why there is no report. */
  child: PrewarmChildResult
  /** Whether the parent's composite memo was warmed afterwards. */
  memo: "warm" | "failed"
}

/** Five minutes: an order of magnitude over the slowest extraction measured. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Parent side. Spawn the child, wait for it, then warm the in-process memo.
 * Resolves on every path; the return value is diagnostic.
 */
export async function prewarmManifestsAtBoot(
  opts: PrewarmManifestsOptions,
): Promise<PrewarmManifestsOutcome> {
  const logger = opts.logger ?? console.log
  const child = await runPrewarmChild(opts)
  if (child.ok) {
    logger(
      `[grounding] manifests ready: ${child.components} components in ${formatMs(child.ms)} (${opts.root})`,
    )
  } else {
    logger(
      `[grounding] manifest prewarm failed after ${formatMs(child.ms)} (non-fatal, the first selection extracts instead): ${child.reason}`,
    )
  }
  // The composite build is the async I/O part; the cache files the child
  // just wrote are what make the first click's per-source reads cheap. Run
  // it even after a failed child: it is exactly what the first request
  // would do, minus the request.
  const memo = await warmGroundingMemo(
    opts.root,
    opts.groundingLoaders ?? defaultGroundingLoaders,
  )
  return { child, memo: memo.ok ? "warm" : "failed" }
}

function runPrewarmChild(opts: PrewarmManifestsOptions): Promise<PrewarmChildResult> {
  const startedAt = Date.now()
  const spawn = opts.spawn ?? nodeSpawn
  const execPath = opts.execPath ?? process.execPath
  const execArgv = opts.execArgv ?? process.execArgv
  const cliEntry = opts.cliEntry ?? process.argv[1]
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!cliEntry) {
    return Promise.resolve({ ok: false, reason: "no CLI entry to re-invoke", ms: 0 })
  }

  return new Promise<PrewarmChildResult>((resolve) => {
    let child: ChildProcess
    let timer: NodeJS.Timeout | null = null
    let settled = false
    // The parent going away takes the child with it: an orphaned extraction
    // burning a core for a quarter of a minute after Ctrl-C is not a boot
    // side effect anyone asked for. `unref` below is the other half: an
    // in-flight child never holds the parent's event loop open.
    const killChild = () => {
      try {
        child.kill("SIGTERM")
      } catch {
        // Already gone.
      }
    }
    const settle = (result: PrewarmChildResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      process.off("exit", killChild)
      resolve(result)
    }

    try {
      child = spawn(execPath, [...execArgv, cliEntry, PREWARM_CHILD_FLAG, opts.root], {
        // Explicit cwd, as the launcher does: the parent may have chdir'd
        // into the prototype's Vite root.
        cwd: opts.root,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      settle({
        ok: false,
        reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        ms: Date.now() - startedAt,
      })
      return
    }

    process.once("exit", killChild)
    child.unref()

    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
      // Keep only a tail: adapter warnings can be chatty, and the failure
      // line only needs the last thing the child said.
      if (stderr.length > 4096) stderr = stderr.slice(-4096)
    })

    timer = setTimeout(() => {
      killChild()
      settle({
        ok: false,
        reason: `child exceeded ${formatMs(timeoutMs)}`,
        ms: Date.now() - startedAt,
      })
    }, timeoutMs)
    // A pending timer must not keep the process alive either.
    timer.unref()

    child.on("error", (err) => {
      settle({ ok: false, reason: `spawn failed: ${err.message}`, ms: Date.now() - startedAt })
    })
    child.on("exit", (code, signal) => {
      const result = parsePrewarmResult(stdout)
      if (result) {
        settle(result)
        return
      }
      const lastStderr = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1)
      const how = signal ? `signal ${signal}` : `exit code ${code}`
      settle({
        ok: false,
        reason: `child ended with ${how} and no result${lastStderr ? `: ${lastStderr}` : ""}`,
        ms: Date.now() - startedAt,
      })
    })
  })
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

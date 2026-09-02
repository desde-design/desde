/**
 * Process execution for the build runner.
 *
 * THIS MODULE RUNS UNTRUSTED CODE. The viewer's build runner executes a
 * repository's own install and build commands, as the viewer process, on the
 * viewer host. That is the design (spec §6: "deploy repos you trust", the
 * same trust model as self-hosted CI) and nothing here is a sandbox.
 *
 * What it IS responsible for is not *widening* that blast radius:
 *
 *  - the child never inherits the viewer's environment (see `buildEnv`)
 *  - the child runs in its own process GROUP so a timeout kills the whole
 *    tree, not just the direct child
 *  - output is captured with a hard byte cap
 *  - a caller-supplied secret is scrubbed from everything captured
 */
import { spawn } from "node:child_process"

/** Captured output plus how the process ended. */
export interface ExecResult {
  code: number | null
  signal: NodeJS.Signals | null
  output: string
  timedOut: boolean
  truncated: boolean
}

export interface ExecOptions {
  cwd: string
  /** When true, run through `sh -c`. ONLY for the repo's own commands. */
  shell?: boolean
  timeoutMs: number
  maxOutputBytes: number
  /** Extra env on top of the minimal set. Never merged with `process.env`. */
  env?: Record<string, string>
  /** Redacted from captured output wherever it appears. */
  secrets?: string[]
  onLog?: (stream: "stdout" | "stderr", text: string) => void
  signal?: AbortSignal
}

/**
 * The ONLY environment a build child sees.
 *
 * The viewer process holds `VIEWER_GITHUB_APP_PRIVATE_KEY`,
 * `VIEWER_SESSION_SECRET`, `VIEWER_ADMIN_TOKEN` and SMTP credentials in its
 * env. `spawn`'s default is to hand all of that to `npm run build` from an
 * arbitrary repository — so the default is the bug, and an allowlist is the
 * only safe shape. A denylist would silently pass anything added later.
 *
 * `PATH` is required to find `git`/`node`/`npm`. `HOME` is required because
 * npm and git both write there and fail in confusing ways without it — it is
 * pointed at the build's own scratch dir, not the real one.
 */
export function buildEnv(homeDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homeDir,
    TMPDIR: homeDir,
    CI: "true",
    ...extra,
  }
}

/**
 * `NODE_ENV=production` for the BUILD step only — never for install.
 *
 * This is not a style preference. **npm** (`npm ci` and `npm install`) treats
 * `NODE_ENV=production` as `--omit=dev` and skips devDependencies entirely.
 * MEASURED, because an earlier version of this comment got it wrong: pnpm
 * (>=10) and Yarn Berry do NOT — they install devDependencies regardless, so
 * an npm-installed repo is the affected population, not literally every repo.
 * That still means every repo whose `installCommand` is the default `npm ci`.
 * In practically every Vite/React/Vue project the build toolchain —
 * `vite`, `@vitejs/plugin-react`, `typescript` — IS a devDependency. So
 * setting it for the install step installs the runtime deps, skips the
 * compiler, and the build then dies with
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite'
 *
 * which reads like the repo's problem and is actually ours. This was live: it
 * made the build pipeline fail on 100% of standard Vite repos, and was only
 * caught by an end-to-end run against a real repository (2026-08-08) — the
 * unit suite stubs the exec layer, so nothing exercised real `npm ci`
 * behavior.
 *
 * The build step still gets it, which is where it belongs: bundlers read
 * NODE_ENV to pick production optimizations and drop dev-only branches.
 */
export function buildStepEnv(
  homeDir: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return buildEnv(homeDir, { NODE_ENV: "production", ...extra })
}

/**
 * Exported (S7) so the runner-authored `say()` log lines in
 * `in-process-build-runner.ts` can be scrubbed too — this was previously
 * applied only to bytes captured from the CHILD's stdout/stderr, leaving the
 * runner's OWN log lines (which is where the operator's free-text
 * install/build command shows up) unscrubbed by construction.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***")
  }
  return out
}

/**
 * Runs one build step.
 *
 * `shell: false` (the default) uses an argv array — no shell, so nothing in
 * `args` can be interpreted as a metacharacter. Everything the runner builds
 * from `branch`/`outputDir` goes through that path. `shell: true` exists
 * solely for the repo's own `installCommand`/`buildCommand`, which are
 * arbitrary shell BY CONTRACT — they are the only strings that may take it.
 */
export function execStep(command: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const secrets = opts.secrets ?? []
    let output = ""
    let bytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    // Resolved up front rather than inline: a ternary in the argument
    // position defeats `spawn`'s overload resolution and collapses the
    // child's type to `never`.
    const file = opts.shell ? "/bin/sh" : command
    const argv = opts.shell ? ["-c", command] : args
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      // Cast because this repo's `ProcessEnv` is augmented to require
      // `NODE_ENV`. The value genuinely is a plain string map, and being an
      // ALLOWLIST is the security property — see `buildEnv`.
      env: (opts.env ?? buildEnv(opts.cwd)) as NodeJS.ProcessEnv,
      // Its own process group. `npm run build` spawns children; killing only
      // the direct child on timeout orphans them and they keep running (and
      // keep holding the workdir we are about to delete).
      detached: true,
      stdio: ["ignore", "pipe", "pipe"] as const,
    })

    const capture = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      const text = redact(buf.toString("utf8"), secrets)
      opts.onLog?.(stream, text)
      if (bytes >= opts.maxOutputBytes) {
        truncated = true
        return
      }
      const room = opts.maxOutputBytes - bytes
      const slice = text.length > room ? text.slice(0, room) : text
      if (slice.length < text.length) truncated = true
      output += slice
      bytes += slice.length
    }
    child.stdout.on("data", capture("stdout"))
    child.stderr.on("data", capture("stderr"))

    /**
     * Negative pid signals the whole process GROUP. Wrapped because the group
     * may already be gone (normal exit racing the timer), and an ESRCH here
     * would otherwise reject a build that actually succeeded.
     */
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        /* already gone */
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree("SIGTERM")
      // A build stuck in an uninterruptible state ignores SIGTERM; escalate
      // rather than hanging the runner forever.
      setTimeout(() => killTree("SIGKILL"), 5_000).unref()
    }, opts.timeoutMs)

    const onAbort = () => {
      timedOut = true
      killTree("SIGTERM")
      setTimeout(() => killTree("SIGKILL"), 5_000).unref()
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolvePromise({ code, signal, output, timedOut, truncated })
    }

    child.on("error", (err) => {
      // Spawn failure (command not found, cwd gone). Reported as a normal
      // failed step rather than a rejection so one code path handles every
      // way a step can fail.
      output += redact(`\n[runner] failed to start: ${err.message}\n`, secrets)
      settle(null, null)
    })
    child.on("close", settle)
  })
}

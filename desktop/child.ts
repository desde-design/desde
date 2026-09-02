/**
 * Spawns the Phase 1 CLI payload as a child process, waits for it to report
 * readiness, and owns its shutdown.
 *
 * **Architecture, not a detail:** Electron main spawns the payload's
 * `dist/cli.js` on ELECTRON'S OWN binary with `ELECTRON_RUN_AS_NODE=1` (a
 * plain-Node child, no window, no Chromium) — in LAUNCHER mode (no repo
 * path). It never calls `startCore()` in-process; the launcher's own HTTP
 * API spawns per-project editor children exactly as it does for a terminal
 * user, and — since Phase 1 (`e674e154`) — already tracks and kills them on
 * its own SIGTERM via `child-tracker.ts`. So Electron only ever needs to
 * supervise ONE child: the launcher process. See `tasks/electron-app.md` §3.
 *
 * **Reuses three editor-cli primitives from source, rather than
 * reimplementing them:**
 *  - `createReadyLineReader` (`ready-line.ts`) — the same chunk-boundary-safe
 *    sentinel reader `defaultSpawnEditor` uses to wait on a per-project
 *    editor child, broadened (as of this same change) to also recognise the
 *    launcher-mode sentinel this module actually waits on.
 *  - `createStderrTail` (`editor-boot-failure.ts`) — the same bounded
 *    tail-biased stderr buffer the launcher uses to explain a boot failure
 *    instead of surfacing a bare exit code.
 *  - `createChildTracker` (`child-tracker.ts`) — the SIGTERM→SIGKILL
 *    escalation with a race-free closing state, exactly as the launcher uses
 *    it for the children IT spawns. Reused rather than re-implemented so
 *    this module has exactly one grace period, one escalation path, one
 *    tested implementation to reason about — not a second hand-rolled
 *    version of the same thing living a few files away.
 *
 * All three are pure, side-effect-free modules — no route handlers, no
 * security context, nothing that would pull unrelated machinery into the
 * desktop bundle. This is deliberately NOT importing `launcher-server.ts`
 * itself (which owns route dispatch, port picking, and a much larger surface
 * this shell has no business depending on) — see its own module doc comment
 * for why "the shell spawns the CLI; it does not absorb it."
 */

import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { createChildTracker, type ChildTracker } from "../editor-cli/src/server/child-tracker.js"
import { createReadyLineReader } from "../editor-cli/src/server/ready-line.js"
import { createStderrTail } from "../editor-cli/src/server/editor-boot-failure.js"
import { PRODUCT_NAME } from "./product-name.js"

/**
 * Grace period between SIGTERM and SIGKILL for the launcher child. Longer
 * than `child-tracker.ts`'s own 4s default (§3 of the phase brief calls for
 * 10s specifically here) — a wedged in-process Vite dev server one layer
 * further down (a per-project editor, itself a grandchild of this process)
 * needs its own moment to close inside the launcher's SIGTERM handler before
 * the launcher itself can exit, so the top-level grace period has to cover
 * both hops, not just one.
 */
export const SHUTDOWN_GRACE_MS = 10_000

/**
 * The launcher child exited (or failed to spawn at all) before it ever
 * printed its ready line. `detail` is the child's own stderr tail, when it
 * said anything — usually a real, actionable message (a typed refusal from
 * `cli.ts`, e.g. a bad `--shell-port`), not a generic crash.
 */
export class PayloadBootFailure extends Error {
  readonly exitCode: number | null
  readonly detail: string

  constructor(exitCode: number | null, detail: string) {
    super(`${PRODUCT_NAME} launcher exited before it was ready (code ${exitCode})`)
    this.name = "PayloadBootFailure"
    this.exitCode = exitCode
    this.detail = detail
  }
}

export interface PayloadChildOptions {
  /** `process.execPath` — Electron's own binary, spawned with `ELECTRON_RUN_AS_NODE`. */
  execPath: string
  /** Absolute path to the assembled payload directory (holds `dist/cli.js`). */
  payloadRoot: string
  /**
   * The launcher's working directory. NOT optional, and deliberately not
   * defaulted to `process.cwd()` here: `editor-cli/src/launch-cwd.ts`
   * captures this ONCE at the launcher's own boot and uses it as the base
   * for GitHub clone destinations and (for the launcher's own spawned
   * per-project editor children) relative-path resolution
   * (`launcher-server.ts`'s `defaultSpawnEditor`). Electron main's OWN
   * `process.cwd()` is not a safe default for it — it can be `desktop/`
   * (when launched via `npm --prefix desktop run …`) or the repo root, and
   * EITHER would silently land a "Clone from GitHub" inside this checkout.
   * The caller must pick something meaningful (e.g. the user's home
   * directory) and pass it explicitly.
   */
  cwd: string
  /** `--shell-port`, when the caller wants a specific port rather than the CLI's own default/free-port choice. */
  shellPort?: number
  /** Base environment to spawn with. Defaults to `process.env`; tests override to keep the check hermetic. */
  env?: NodeJS.ProcessEnv
  /**
   * The desktop-managed `claude` runtime's app-support root (see
   * `claude-runtime-installer.ts` / `../src/editor/llm-providers/
   * resolve-claude-executable.ts`) — set as `EDITOR_CLAUDE_RUNTIME_DIR` on
   * the launcher child. A plain path string, known SYNCHRONOUSLY at spawn
   * time (no need to wait for the install itself, which may still be
   * running in the background) — the CLI-side resolver does its own live
   * filesystem check against it on every `query()` call, so it doesn't
   * matter whether the actual binary lands before or after this spawn.
   * Env inherits to the launcher's own per-project grandchildren the same
   * way `ELECTRON_RUN_AS_NODE` already does (see this file's own module
   * doc comment, C2). Omitted in a plain terminal-CLI run — this option
   * only ever gets set by `main.ts`.
   */
  claudeRuntimeAppSupportDir?: string
  /**
   * Injected for tests — a fake tracker (fake killer, short grace period) in
   * place of a real one. Production callers never pass this.
   */
  tracker?: ChildTracker
}

export interface PayloadChildHandle {
  /** The EXACT url the child printed on its ready line — never reconstructed. */
  readonly url: string
  readonly child: ChildProcess
  /** SIGTERM, escalating to SIGKILL after {@link SHUTDOWN_GRACE_MS}. Resolves once the child has exited. Idempotent. */
  shutdown(): Promise<void>
}

export async function spawnPayloadChild(opts: PayloadChildOptions): Promise<PayloadChildHandle> {
  const tracker = opts.tracker ?? createChildTracker({ graceMs: SHUTDOWN_GRACE_MS })
  const cliEntry = join(opts.payloadRoot, "dist", "cli.js")
  const args = [
    cliEntry,
    "--no-open", // Electron owns window creation — the CLI must never shell out to a system browser.
    ...(opts.shellPort !== undefined ? ["--shell-port", String(opts.shellPort)] : []),
  ]

  // Never let an inherited EDITOR_CLAUDE_EXECUTABLE_PATH reach the child:
  // Electron inherits its launch environment (a Terminal-started app gets
  // the shell's exports), and the resolver's escape-hatch branch would
  // otherwise hand that path — ANY executable, content-unverified — to the
  // SDK's spawn. The resolver itself already ignores the override whenever
  // EDITOR_CLAUDE_RUNTIME_DIR is set (the class fix, covering grandchildren
  // too); this scrub is defense in depth at the one spawn seam desktop/
  // owns. Delete-after-spread, not `undefined`-assignment: spawn() passes
  // an `undefined` value through as the STRING "undefined" on some
  // platforms, and either way the key must simply not exist.
  const childEnv: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
    EDITOR_PAYLOAD_ROOT: opts.payloadRoot,
    ...(opts.claudeRuntimeAppSupportDir
      ? { EDITOR_CLAUDE_RUNTIME_DIR: opts.claudeRuntimeAppSupportDir }
      : {}),
  }
  delete childEnv.EDITOR_CLAUDE_EXECUTABLE_PATH

  const child = spawn(opts.execPath, args, {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  })
  // Tracked immediately at spawn time, independent of whether boot ever
  // reaches "ready" below — a child that fails to boot still needs to be (and
  // via its own `exit`, already will be) accounted for by the tracker.
  tracker.track(child)

  const readReady = createReadyLineReader()
  const stderrTail = createStderrTail()

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return
      const found = readReady(chunk.toString("utf8"))
      if (found) {
        settled = true
        resolve(found)
      }
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.append(chunk.toString("utf8"))
      // Tee — visible in the terminal that launched `npm run desktop`, the
      // same courtesy the CLI's own launcher gives its spawned editor
      // children (`launcher-server.ts`'s `defaultSpawnEditor`).
      process.stderr.write(chunk)
    })
    child.once("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    child.once("exit", (code) => {
      if (settled) return
      settled = true
      reject(new PayloadBootFailure(code, stderrTail.text()))
    })
  })

  return {
    url,
    child,
    shutdown: () => tracker.shutdown(),
  }
}

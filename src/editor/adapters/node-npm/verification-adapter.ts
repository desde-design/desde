/**
 * Node/npm impl of {@link VerificationAdapter}. Auto-detects the user's
 * package manager from lockfile presence:
 *   - `pnpm-lock.yaml` → pnpm
 *   - `yarn.lock`      → yarn
 *   - default          → npm  (also matches `package-lock.json`)
 *
 * Check-name → command mapping (using the resolved package manager):
 *   - typecheck → `<pm> run typecheck`  fallback `<pm> exec tsc --noEmit` if the script is missing AND a tsconfig.json exists AND `tsc` is installed (see `hasLocalBin`)
 *   - lint      → `<pm> run lint`
 *   - test      → `<pm> test`           (test is special — every PM has a top-level alias; we use that rather than `run test` so npm's `--silent` semantics line up)
 *   - build     → `<pm> run build`
 *
 * For non-`test` checks: if the script is missing AND there's no
 * builtin fallback, the result is `ok=false, noScript=true` with the
 * list of `availableScripts`. The agent typically retries with a
 * suggested alternative or surfaces "no script defined" to the user.
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  VerificationAdapter,
  VerificationCheck,
  VerificationRunResult,
} from '../../core/verification-adapter'
import {
  VERIFICATION_OUTPUT_MAX_BYTES,
  VERIFICATION_TIMEOUT_MS,
} from '../../core/verification-adapter'

export type NodePackageManager = 'npm' | 'pnpm' | 'yarn'

/**
 * Lockfile-based package-manager detection. Order matters: pnpm/yarn
 * are explicit signals; npm is the fallback for any other case
 * (including a missing lockfile, which happens on fresh clones).
 */
export function detectNodePackageManager(repoRoot: string): NodePackageManager {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * Read `package.json` scripts. Returns an empty object when the file
 * is missing or unreadable — `noScript` semantics handle the rest.
 */
function readPackageScripts(repoRoot: string): Record<string, string> {
  const path = join(repoRoot, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  } catch {
    return {}
  }
}

/**
 * Names of `package.json` scripts whose bodies differ from the committed
 * (HEAD) version, or `null` when no baseline is available.
 *
 * The `null` case — no git, no commits yet, or `package.json` not tracked —
 * deliberately FAILS OPEN. A hard refusal there would make verification
 * unusable in an ordinary situation (a freshly scaffolded prototype before its
 * first commit), and the two lanes that matter most are already closed
 * elsewhere: `--ignore-scripts` on the agent's install, and `protected-paths`
 * on `vite.config.*` and friends. This check is the third layer, not the only
 * one — it is worth having and not worth breaking the product for.
 *
 * Compares only bodies of scripts that exist on disk: an ADDED script is
 * reported (it has no committed body), a REMOVED one is not (it cannot be
 * executed).
 */
function changedScripts(
  repoRoot: string,
  current: Record<string, string>,
): string[] | null {
  let committedRaw: string
  try {
    committedRaw = execFileSync('git', ['show', 'HEAD:package.json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  let committed: Record<string, string>
  try {
    const parsed = JSON.parse(committedRaw) as { scripts?: Record<string, string> }
    committed = parsed.scripts ?? {}
  } catch {
    return null
  }
  return Object.keys(current).filter((name) => current[name] !== committed[name])
}

/**
 * Parent environment with credentials stripped, for the repo's own
 * build/test scripts. Same rationale and same carve-out for npm's registry
 * credentials as `package-manager-adapter.ts`'s `installEnv`.
 */
function verificationEnv(): NodeJS.ProcessEnv {
  const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
  const KEEP_RE = /^(npm_|NPM_)/
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(out)) {
    if (SECRET_RE.test(k) && !KEEP_RE.test(k)) delete out[k]
  }
  return out
}

/**
 * Per-check script-name lookup. Most are direct; `typecheck` admits a
 * `test:types` alias because some toolchains (Vitest projects) ship
 * with that name and not `typecheck`.
 */
const SCRIPT_LOOKUP: Record<VerificationCheck, ReadonlyArray<string>> = {
  typecheck: ['typecheck', 'test:types', 'tsc', 'type-check'],
  lint: ['lint'],
  test: ['test'],
  build: ['build'],
}

interface ResolvedCommand {
  /** Argv array passed to execFile. */
  argv: string[]
  /** Single-line display label for `result.command`. */
  display: string
  /**
   * True when this is a builtin fallback (e.g. tsc-direct for
   * typecheck). False when it maps to a user-defined script. Used so
   * the noScript path reports `noScript=false` only when an actual
   * script ran.
   */
  isFallback: boolean
}

/**
 * Is `name` an installed binary this repo can run?
 *
 * Walks up from `repoRoot` looking for `node_modules/.bin/<name>`, the same
 * upward walk node resolution does, so a workspace package that relies on a
 * hoisted root install still resolves.
 *
 * This gate exists because `npm exec <name>` is NOT "run the local binary". It
 * is "run the local binary, or else DOWNLOAD AND EXECUTE whatever package
 * currently owns that name on the public registry". For `tsc` those are
 * different programs: TypeScript publishes its compiler as `typescript` and
 * merely provides a `tsc` bin, while the npm package literally named `tsc` is
 * an unrelated `2.0.4` describing itself as "A deprecated release of the
 * TypeScript compiler". It exits non-zero without typechecking anything.
 *
 * So on a repo with a tsconfig.json and no TypeScript installed, the fallback
 * used to fetch a stranger's program, run it, and report its exit code as the
 * user's typecheck result. Reporting `noScript` is both honest and quiet:
 * there is genuinely nothing here to typecheck with.
 *
 * MEASURED: `verification-adapter.test.ts`'s fallback test seeds exactly that
 * fixture, so every run of the default `npm test` reached the network and
 * executed that package, for a test whose only assertion is a string
 * comparison. It cost seconds rather than milliseconds, which is the tell —
 * the exact figures first recorded here (1,754ms idle / 8,501ms loaded) were
 * taken while a runaway process held a core, so treat them as the right order
 * of magnitude and nothing finer. Post-fix, on an idle machine, the same test
 * is 691ms and its no-TypeScript sibling is 29ms, both offline.
 */
function hasLocalBin(repoRoot: string, name: string): boolean {
  let dir = repoRoot
  for (;;) {
    if (existsSync(join(dir, 'node_modules', '.bin', name))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function resolveCommand(
  pm: NodePackageManager,
  check: VerificationCheck,
  scripts: Record<string, string>,
  repoRoot: string,
): ResolvedCommand | { noScript: true } {
  const candidates = SCRIPT_LOOKUP[check]
  const matched = candidates.find((name) => typeof scripts[name] === 'string')
  if (matched) {
    // `test` is special: every PM has a top-level `test` alias that
    // forwards to the user's script. Using it avoids npm's silent
    // wrapping shenanigans for `run test`.
    if (matched === 'test' && check === 'test') {
      return {
        argv: [pm, 'test', '--', '--run'],
        display: `${pm} test -- --run`,
        isFallback: false,
      }
    }
    return {
      argv: [pm, 'run', matched],
      display: `${pm} run ${matched}`,
      isFallback: false,
    }
  }
  // Builtin fallback only for typecheck when a tsconfig.json exists AND the
  // repo actually has a `tsc` binary installed. See `hasLocalBin` for why the
  // second half is not optional.
  if (
    check === 'typecheck' &&
    existsSync(join(repoRoot, 'tsconfig.json')) &&
    hasLocalBin(repoRoot, 'tsc')
  ) {
    return {
      argv: [pm, 'exec', 'tsc', '--', '--noEmit'],
      display: `${pm} exec tsc -- --noEmit`,
      isFallback: true,
    }
  }
  return { noScript: true }
}

function clipOutput(buf: string): string {
  if (buf.length <= VERIFICATION_OUTPUT_MAX_BYTES) return buf
  // Keep the tail — the interesting part of a failed run is at the
  // bottom (the error / failure summary). Prepend a marker so the
  // agent knows truncation happened.
  return `…[truncated ${buf.length - VERIFICATION_OUTPUT_MAX_BYTES} leading bytes]\n` +
    buf.slice(buf.length - VERIFICATION_OUTPUT_MAX_BYTES)
}

interface BuildOpts {
  repoRoot: string
  /** Override the auto-detected package manager (tests use this). */
  packageManager?: NodePackageManager
}

export function createNodePackageVerificationAdapter(
  opts: BuildOpts,
): VerificationAdapter {
  const pm = opts.packageManager ?? detectNodePackageManager(opts.repoRoot)
  return {
    substrateLabel: pm,
    async run(check, runOpts): Promise<VerificationRunResult> {
      const scripts = readPackageScripts(opts.repoRoot)

      // B8: this tool's whole job is to EXECUTE a package.json script, so an
      // agent that can edit the `scripts` block and then call it has arbitrary
      // command execution in one turn. `package.json` is deliberately NOT on
      // the protected-path list (manage_package must be able to rewrite the
      // dependency blocks), so the guard belongs here, at the execution end:
      // refuse to run a script block that differs from the committed one.
      //
      // Only `scripts` is compared. Dependency edits are the legitimate,
      // expected change and must not trip this.
      const drift = changedScripts(opts.repoRoot, scripts)
      if (drift && drift.length > 0) {
        return {
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr:
            `Refusing to run verification: the package.json "scripts" block differs from the ` +
            `committed version (${drift.join(', ')}). Running it would execute a command that ` +
            `has not been reviewed. Commit the script change deliberately, or revert it, then ` +
            `re-run. Do NOT work around this by invoking the command another way.`,
          durationMs: 0,
          command: `<refused:${check}>`,
        }
      }

      const resolved = resolveCommand(pm, check, scripts, opts.repoRoot)
      if ('noScript' in resolved) {
        return {
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: `No script defined for '${check}' in package.json. Available scripts: ${Object.keys(scripts).join(', ') || '(none)'}.`,
          durationMs: 0,
          command: `<no-script:${check}>`,
          noScript: true,
          availableScripts: Object.keys(scripts),
        }
      }

      const [bin, ...args] = resolved.argv
      const start = Date.now()
      return await new Promise<VerificationRunResult>((resolve) => {
        const child = execFile(
          bin,
          args,
          {
            cwd: opts.repoRoot,
            maxBuffer: VERIFICATION_OUTPUT_MAX_BYTES * 4,
            timeout: VERIFICATION_TIMEOUT_MS,
            signal: runOpts?.signal,
            // Disable color so the agent's text reasoning isn't full of
            // ANSI escapes. `verificationEnv()` strips credentials — this
            // runs the repo's own build/test scripts, which are arbitrary
            // code, and they have no need for ANTHROPIC_API_KEY or the
            // developer's other exported secrets.
            env: { ...verificationEnv(), FORCE_COLOR: '0', NO_COLOR: '1' },
          },
          (err, stdout, stderr) => {
            const stdoutStr = clipOutput(stdout?.toString() ?? '')
            const stderrStr = clipOutput(stderr?.toString() ?? '')
            const durationMs = Date.now() - start
            if (err) {
              const e = err as NodeJS.ErrnoException & {
                code?: number | string
                signal?: NodeJS.Signals
                killed?: boolean
              }
              const aborted = e.name === 'AbortError'
              const timedOut =
                e.killed === true && (e.signal === 'SIGTERM' || e.code === null)
              resolve({
                ok: false,
                exitCode: typeof e.code === 'number' ? e.code : -1,
                stdout: stdoutStr,
                stderr: stderrStr.length > 0 ? stderrStr : e.message,
                durationMs,
                command: resolved.display,
                aborted: aborted || undefined,
                timedOut: timedOut || undefined,
              })
              return
            }
            resolve({
              ok: true,
              exitCode: 0,
              stdout: stdoutStr,
              stderr: stderrStr,
              durationMs,
              command: resolved.display,
            })
          },
        )
        // execFile's promise-style won't resolve again; ignore close
        // events. Node garbage-collects the child once the callback
        // fires.
        void child
      })
    },
  }
}

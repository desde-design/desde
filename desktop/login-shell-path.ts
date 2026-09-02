/**
 * The PATH the user's own terminal would have — asked of their login shell.
 *
 * An app launched from Finder or the Dock inherits launchd's environment,
 * whose PATH is just `/usr/bin:/bin:/usr/sbin:/sbin`. It is not the PATH
 * the user's terminal has: Homebrew, nvm, asdf and friends all install
 * themselves by editing a shell rc file, and none of that runs for a
 * Finder launch. The child CLI inherits that bare PATH (child.ts spreads
 * `process.env` into the child), and every `git` / `gh` / `npm` it spawns
 * resolves to whatever Apple ships, or to nothing at all.
 *
 * The concrete way this bit: on a Mac with Homebrew git, the editor's
 * background `git fetch` ran `/usr/bin/git`, whose credential helper is a
 * DIFFERENT `git-credential-osxkeychain` binary from Homebrew's. The
 * keychain item for github.com only trusted Homebrew's, so macOS raised
 * its "wants to use your confidential information" dialog on every fetch,
 * once a minute, for as long as the app was open.
 *
 * Same idea as `shell-env` / `fix-path` (which Electron apps have used for
 * years): start the user's shell as a login shell so its profile and rc
 * files run, then have it run a command that prints PATH. The command is
 * three binaries by absolute path joined by `;` (see
 * {@link PRINT_PATH_COMMAND}); nothing in it depends on how a given shell
 * expands variables, so it is the same under zsh, bash, sh, fish and tcsh.
 * Only HOW it is handed to the shell differs, see {@link loginShellInvocation}.
 *
 * Hand-rolled rather than depended on because it is a hundred lines, and
 * the desktop bundle is CJS (see scripts/build.mjs) while those packages
 * are ESM-only.
 *
 * Failure is never fatal: a shell that errors, hangs past the timeout, or
 * prints nothing usable yields `null`, and the caller keeps the PATH it
 * had. The alternative — an app that will not boot because `.zshrc` has a
 * bug — is worse than the prompt this exists to prevent.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { basename } from "node:path"

const SENTINEL = "__DESDE_PATH__"

/**
 * What the shell is asked to run. PATH comes out framed by a sentinel
 * line on each side, so rc-file output before it and logout-hook output
 * after it are both ignored. macOS's `printenv` takes ONE name, so the
 * sentinels are separate `printf` calls rather than extra printenv
 * arguments. Absolute paths because the PATH we are inside of is the
 * broken one. Exported for the tests that run it through real shells.
 */
export const PRINT_PATH_COMMAND = [
  `/usr/bin/printf '%s\\n' ${SENTINEL}`,
  "/usr/bin/printenv PATH",
  `/usr/bin/printf '%s\\n' ${SENTINEL}`,
].join("; ")

/** A rc file that hangs (waiting on a tty, say) must not hold boot hostage. */
const DEFAULT_TIMEOUT_MS = 5_000

/** Some rc files print generously; keep what fits and drop the rest. */
const MAX_STDOUT_CHARS = 1024 * 1024

/** The one process seam, injectable so the unit tests run no shell. */
export type LoginShellExec = (
  file: string,
  args: readonly string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal },
) => Promise<{ stdout: string }>

export interface ResolveLoginShellPathOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exec?: LoginShellExec
  timeoutMs?: number
  /**
   * Aborting kills the shell (and its process group) and yields `null` at
   * once. The caller wires this to app quit: the shell is detached, so a
   * parent that simply exits would leave a slow rc file's processes
   * running with nothing left to time them out.
   */
  signal?: AbortSignal
}

/**
 * Everything the shell's own process group can be sent. `detached` below
 * made the shell a group leader, so `-pid` reaches its children too (a
 * `sleep` in a rc file, say) — those hold our stdout pipe open otherwise.
 */
function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

/**
 * The real spawn. Written out rather than `execFile` with `timeout`
 * because that timeout sends SIGTERM, which an interactive zsh or bash
 * ignores, and then waits for stdio to close, which a grandchild can hold
 * open forever. Here the timer is the authority: when it fires the whole
 * group gets SIGKILL and the promise rejects, whatever the pipes are
 * doing. No stderr: `zsh -i` without a tty warns about job control.
 */
const defaultExec: LoginShellExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("aborted before the shell was started"))
      return
    }
    const child = spawn(file, [...args], {
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      detached: true,
    })
    let stdout = ""
    let settled = false
    const settle = (outcome: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      outcome()
    }
    const giveUp = (why: string) => {
      killProcessGroup(child)
      settle(() => reject(new Error(`${file} ${why}`)))
    }
    const timer = setTimeout(() => giveUp(`did not answer within ${opts.timeout}ms`), opts.timeout)
    const onAbort = () => giveUp("was aborted")
    opts.signal?.addEventListener("abort", onAbort)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk.toString("utf8")
    })
    child.on("error", (err) => settle(() => reject(err)))
    child.on("close", () => settle(() => resolve({ stdout })))
    if (opts.input !== undefined) {
      // A tcsh whose ~/.login says `exit` is gone before it reads stdin,
      // and the write then fails with EPIPE on the stdin stream. Without a
      // listener that is an unhandled 'error' event, which would take the
      // whole Electron main process down. Swallowed: `close` still fires,
      // and whatever stdout holds decides the result.
      child.stdin?.on("error", () => {})
      child.stdin?.end(opts.input)
    }
  })

/**
 * Which shell to ask. `$SHELL` is the user's, and is what their terminal
 * runs. It is only trusted when absolute — a bare name would resolve
 * against the very PATH we are trying to repair.
 */
export function loginShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL
  if (shell && shell.startsWith("/")) return shell
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash"
}

export interface LoginShellInvocation {
  args: string[]
  /** The command on stdin, for shells that take `-l` only on its own. */
  input?: string
}

/**
 * How to hand the command to one shell. The POSIX family and fish take it
 * as `-i -l -c`: interactive AND login, so `~/.zprofile` + `~/.zshrc`,
 * `~/.bash_profile`, `config.fish` all run. Separate flags, not `-ilc`:
 * every one of these shells takes them separately, not all combined.
 *
 * csh and tcsh accept `-l` only when it is the ONLY flag, so `-c` is out;
 * they get a bare `-l` and read the command from stdin instead. That is a
 * non-interactive login shell: `/etc/csh.login`, `~/.tcshrc` and
 * `~/.login` all run, and `~/.login` is where those users set PATH.
 */
export function loginShellInvocation(shell: string): LoginShellInvocation {
  const name = basename(shell)
  if (name === "csh" || name === "tcsh") {
    return { args: ["-l"], input: `${PRINT_PATH_COMMAND}\n` }
  }
  return { args: ["-i", "-l", "-c", PRINT_PATH_COMMAND] }
}

/**
 * The PATH out of what the shell printed: the one line between the first
 * pair of sentinel lines. Anything an rc file printed before, or a logout
 * hook printed after, is outside the frame and ignored. An empty PATH, or
 * a frame that never closed (the shell died mid-command), is `null`.
 */
export function parsePrintedPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/)
  const open = lines.indexOf(SENTINEL)
  if (open < 0 || lines[open + 2] !== SENTINEL) return null
  const path = lines[open + 1]
  return path.length > 0 ? path : null
}

/**
 * The login shell's PATH, or `null` when it could not be determined (or
 * on Windows, where there is no equivalent and no need).
 */
export async function resolveLoginShellPath(
  opts: ResolveLoginShellPathOptions,
): Promise<string | null> {
  if (opts.platform === "win32") return null
  const shell = loginShellFor(opts.platform, opts.env)
  const { args, input } = loginShellInvocation(shell)
  const exec = opts.exec ?? defaultExec
  let stdout: string
  try {
    ;({ stdout } = await exec(shell, args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: opts.env,
      ...(input === undefined ? {} : { input }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    }))
  } catch {
    return null
  }
  return parsePrintedPath(stdout)
}

/**
 * The login shell's entries first, in its order, then anything the launch
 * PATH had that the shell did not — an entry Electron or launchd added is
 * kept, it just stops winning. Duplicates and empty segments dropped.
 */
export function mergePathEntries(loginPath: string, launchPath: string | undefined): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...loginPath.split(":"), ...(launchPath ?? "").split(":")]) {
    if (entry.length === 0 || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out.join(":")
}

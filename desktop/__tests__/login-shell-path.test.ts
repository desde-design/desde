import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  loginShellInvocation,
  mergePathEntries,
  parsePrintedPath,
  PRINT_PATH_COMMAND,
  resolveLoginShellPath,
  type LoginShellExec,
} from "../login-shell-path.js"

const LOGIN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
const SENTINEL = "__DESDE_PATH__"

/** What the command prints for a given PATH: the framed value. */
function framed(path: string): string {
  return `${SENTINEL}\n${path}\n${SENTINEL}\n`
}

/** An exec fake that answers like a login shell whose rc files are quiet. */
function quietShell(path = LOGIN_PATH) {
  return vi.fn<LoginShellExec>(async () => ({ stdout: framed(path) }))
}

describe("resolveLoginShellPath", () => {
  it("asks the user's login shell to print PATH, interactively, as a login shell", async () => {
    const exec = quietShell()
    const env = { SHELL: "/bin/zsh", HOME: "/Users/someone" }
    const path = await resolveLoginShellPath({ platform: "darwin", env, exec })
    expect(path).toBe(LOGIN_PATH)
    expect(exec).toHaveBeenCalledTimes(1)
    const [file, args, opts] = exec.mock.calls[0]
    expect(file).toBe("/bin/zsh")
    // Interactive login shell, so ~/.zprofile and ~/.zshrc both run — that
    // is where Homebrew's `shellenv` and version managers put their PATH.
    expect(args).toEqual(["-i", "-l", "-c", PRINT_PATH_COMMAND])
    expect(opts.input).toBeUndefined()
    // The shell starts from the launch environment (its rc files add to it).
    expect(opts.env).toBe(env)
  })

  it("hands tcsh the command on stdin, under a bare -l", async () => {
    const exec = quietShell()
    await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/tcsh" }, exec })
    const [file, args, opts] = exec.mock.calls[0]
    expect(file).toBe("/bin/tcsh")
    expect(args).toEqual(["-l"])
    expect(opts.input).toBe(`${PRINT_PATH_COMMAND}\n`)
  })

  it("ignores what rc files print before the answer and what logout hooks print after it", async () => {
    const exec: LoginShellExec = async () => ({
      stdout: `Welcome back!\nnvm: loaded\n${framed(LOGIN_PATH)}log: /tmp/session.log\n`,
    })
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
    expect(path).toBe(LOGIN_PATH)
  })

  it("falls back to /bin/zsh on macOS when SHELL is missing or not an absolute path", async () => {
    for (const env of [{}, { SHELL: "zsh" }]) {
      const exec = quietShell()
      await resolveLoginShellPath({ platform: "darwin", env, exec })
      expect(exec.mock.calls[0][0]).toBe("/bin/zsh")
    }
  })

  it("falls back to /bin/bash on Linux when SHELL is missing", async () => {
    const exec = quietShell()
    await resolveLoginShellPath({ platform: "linux", env: {}, exec })
    expect(exec.mock.calls[0][0]).toBe("/bin/bash")
  })

  it("does nothing on Windows", async () => {
    const exec = quietShell()
    const path = await resolveLoginShellPath({ platform: "win32", env: { SHELL: "/bin/zsh" }, exec })
    expect(path).toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })

  it("returns null when the shell fails or times out", async () => {
    const exec: LoginShellExec = async () => {
      throw new Error("killed")
    }
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
    expect(path).toBeNull()
  })

  it("returns null when the frame is missing, unclosed, or empty", async () => {
    for (const stdout of ["", "rc file exited early\n", `${SENTINEL}\n/a:/b\n`, framed("")]) {
      const exec: LoginShellExec = async () => ({ stdout })
      const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
      expect(path).toBeNull()
    }
  })
})

describe("loginShellInvocation", () => {
  it("uses a bare -l with the command on stdin for csh and tcsh, which reject -l next to any other flag", () => {
    for (const shell of ["/bin/tcsh", "/bin/csh"]) {
      expect(loginShellInvocation(shell)).toEqual({ args: ["-l"], input: `${PRINT_PATH_COMMAND}\n` })
    }
  })

  it("uses -i -l -c for the POSIX family and fish", () => {
    for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish"]) {
      expect(loginShellInvocation(shell)).toEqual({ args: ["-i", "-l", "-c", PRINT_PATH_COMMAND] })
    }
  })
})

describe("parsePrintedPath", () => {
  it("takes the line between the first pair of sentinels", () => {
    expect(parsePrintedPath(`noise\n${framed("/a:/b")}bye /now\n`)).toBe("/a:/b")
  })

  it("does not trim: a PATH entry may end in a space", () => {
    expect(parsePrintedPath(framed("/a b /:/c"))).toBe("/a b /:/c")
  })

  it("refuses an unframed line even when it looks like a path", () => {
    expect(parsePrintedPath("/a:/b\n")).toBeNull()
  })
})

/**
 * The real thing, against the shells this machine has. HOME points at a
 * scratch directory holding ONE planted rc file — the file where that
 * shell's users set PATH — which prepends a marker entry. The assertion
 * is that the marker comes back: that proves the flags are accepted, the
 * command runs, the frame parses, AND the right startup file was read.
 * Containment rather than equality because system profiles rewrite PATH
 * around it (`path_helper` on macOS prepends; Debian's `/etc/profile`
 * resets it outright, which is why the launch PATH is not asserted on).
 * The first version of this module passed every fake-exec test and
 * returned null against a real zsh, because `$PATH__SENTINEL__` is one
 * variable name; this is the test that would have caught it.
 */
describe("resolveLoginShellPath against real shells", () => {
  const scratchDirs: string[] = []
  const scratchHome = () => {
    const dir = mkdtempSync(join(tmpdir(), "desde-login-shell-"))
    scratchDirs.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  })
  const onPosix = process.platform !== "win32"
  const posixExport = 'export PATH="/from/rc:$PATH"\n'
  const cshSetenv = "setenv PATH /from/rc:$PATH\n"
  const cases: Array<{ shell: string; rcFile: string; line: string }> = [
    { shell: "/bin/zsh", rcFile: ".zshrc", line: posixExport },
    { shell: "/bin/bash", rcFile: ".bash_profile", line: posixExport },
    { shell: "/bin/sh", rcFile: ".profile", line: posixExport },
    { shell: "/bin/tcsh", rcFile: ".login", line: cshSetenv },
    { shell: "/bin/csh", rcFile: ".login", line: cshSetenv },
  ]

  for (const { shell, rcFile, line } of cases) {
    it.skipIf(!onPosix || !existsSync(shell))(`reads ~/${rcFile} under ${shell}`, async () => {
      const home = scratchHome()
      writeFileSync(join(home, rcFile), line)
      const path = await resolveLoginShellPath({
        platform: process.platform,
        env: { SHELL: shell, HOME: home, ZDOTDIR: home, PATH: "/first/bin" },
      })
      expect(path).toContain("/from/rc")
    })
  }

  it.skipIf(!onPosix)(
    "survives a csh-family shell that exits without ever reading the command on stdin",
    async () => {
      // A stand-in `tcsh` (named so it takes the stdin route) that quits at
      // once. The write to its stdin can then fail with EPIPE; without a
      // stdin error listener that is an unhandled stream error, which in
      // Electron main means the whole app.
      const home = scratchHome()
      const fakeTcsh = join(home, "tcsh")
      writeFileSync(fakeTcsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      const path = await resolveLoginShellPath({
        platform: process.platform,
        env: { SHELL: fakeTcsh, HOME: home, PATH: "/first/bin" },
      })
      expect(path).toBeNull()
    },
  )

  it.skipIf(!onPosix || !existsSync("/bin/zsh"))(
    "gives up on time when a rc file hangs, even though interactive zsh ignores SIGTERM",
    async () => {
      const home = scratchHome()
      // `.zshenv` runs for every zsh, and this one never returns.
      writeFileSync(join(home, ".zshenv"), "/bin/sleep 30\n")
      const started = Date.now()
      const path = await resolveLoginShellPath({
        platform: process.platform,
        env: { SHELL: "/bin/zsh", HOME: home, ZDOTDIR: home, PATH: "/first/bin" },
        timeoutMs: 500,
      })
      expect(path).toBeNull()
      expect(Date.now() - started).toBeLessThan(5_000)
    },
  )
})

describe("resolveLoginShellPath abort", () => {
  it("passes the signal to the exec seam", async () => {
    const exec = quietShell()
    const controller = new AbortController()
    await resolveLoginShellPath({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
      exec,
      signal: controller.signal,
    })
    expect(exec.mock.calls[0][2].signal).toBe(controller.signal)
  })

  it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
    "aborting (app quit) kills a hung shell at once instead of waiting out the timeout",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "desde-login-shell-abort-"))
      try {
        writeFileSync(join(home, ".zshenv"), "/bin/sleep 30\n")
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)
        const started = Date.now()
        const path = await resolveLoginShellPath({
          platform: process.platform,
          env: { SHELL: "/bin/zsh", HOME: home, ZDOTDIR: home, PATH: "/first/bin" },
          timeoutMs: 20_000,
          signal: controller.signal,
        })
        expect(path).toBeNull()
        expect(Date.now() - started).toBeLessThan(5_000)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  )
})

describe("mergePathEntries", () => {
  it("puts the login shell's entries first and keeps the launch PATH's extras after them", () => {
    expect(mergePathEntries(LOGIN_PATH, "/usr/bin:/bin:/usr/sbin:/sbin")).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    )
  })

  it("drops duplicate and empty entries", () => {
    expect(mergePathEntries("/a::/b:/a", "/b:/c:")).toBe("/a:/b:/c")
  })

  it("works when the launch PATH is unset", () => {
    expect(mergePathEntries(LOGIN_PATH, undefined)).toBe(LOGIN_PATH)
  })
})

/**
 * 2026-09-02: the packaged app, relaunched by the updater right after
 * installing itself, booted with the bare launchd PATH although the same
 * shell answered fine inside that process minutes later. The cause was not
 * reproduced; what changed is that one failed attempt is no longer the
 * whole answer, and each attempt now leaves a line of evidence.
 */
describe("resolveLoginShellPath second attempt", () => {
  it("falls back to a login-only shell (-l -c, no -i) when the interactive attempt prints no PATH", async () => {
    const exec = vi.fn<LoginShellExec>(async (_file, args) => {
      if (args.includes("-i")) return { stdout: "" }
      return { stdout: framed(LOGIN_PATH) }
    })
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
    expect(path).toBe(LOGIN_PATH)
    expect(exec.mock.calls.map(([, args]) => [...args])).toEqual([
      ["-i", "-l", "-c", PRINT_PATH_COMMAND],
      ["-l", "-c", PRINT_PATH_COMMAND],
    ])
  })

  it("falls back when the interactive attempt throws (timed out, killed), too", async () => {
    const exec = vi.fn<LoginShellExec>(async (_file, args) => {
      if (args.includes("-i")) throw new Error("/bin/zsh did not answer within 5000ms")
      return { stdout: framed(LOGIN_PATH) }
    })
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
    expect(path).toBe(LOGIN_PATH)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it("does not run the second attempt when the first one answers", async () => {
    const exec = quietShell()
    await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("has no second shape for csh and tcsh, which already ran without -i", async () => {
    const exec = vi.fn<LoginShellExec>(async () => ({ stdout: "" }))
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/tcsh" }, exec })
    expect(path).toBeNull()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it("logs one line per attempt: the failure's reason, or the PATH and how long it took", async () => {
    const lines: string[] = []
    const exec = vi.fn<LoginShellExec>(async (_file, args) => {
      if (args.includes("-i")) throw new Error("/bin/zsh did not answer within 5000ms")
      return { stdout: framed(LOGIN_PATH) }
    })
    await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec, log: (l) => lines.push(l) })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^login shell \/bin\/zsh -i -l -c: failed after \d+ms: \/bin\/zsh did not answer within 5000ms$/)
    expect(lines[1]).toMatch(new RegExp(`^login shell /bin/zsh -l -c: PATH in \\d+ms: ${LOGIN_PATH}$`))
  })

  it("says when the shell answered but printed nothing usable", async () => {
    const lines: string[] = []
    const exec = vi.fn<LoginShellExec>(async () => ({ stdout: "rc file noise\n" }))
    await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec, log: (l) => lines.push(l) })
    expect(lines[0]).toMatch(/printed no PATH \(14 chars of output\)$/)
  })
})

describe("resolveLoginShellPath shared budget", () => {
  it("gives the second attempt only what is left of 1.6 times the per-attempt timeout", async () => {
    const timeouts: number[] = []
    let now = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const exec = vi.fn<LoginShellExec>(async (_file, args, o) => {
      timeouts.push(o.timeout)
      if (args.includes("-i")) {
        now += o.timeout // the interactive attempt used its whole timeout
        throw new Error("did not answer")
      }
      return { stdout: framed(LOGIN_PATH) }
    })
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec, timeoutMs: 5000 })
    vi.restoreAllMocks()
    expect(path).toBe(LOGIN_PATH)
    expect(timeouts).toEqual([5000, 3000])
  })

  it("skips the second attempt, and says so, when the first one left less than half a second", async () => {
    const lines: string[] = []
    let now = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const exec = vi.fn<LoginShellExec>(async (_file, _args, o) => {
      now += Math.round(o.timeout * 1.6) // slower than its own timeout: the kill and close took a while too
      throw new Error("did not answer")
    })
    const path = await resolveLoginShellPath({ platform: "darwin", env: { SHELL: "/bin/zsh" }, exec, timeoutMs: 5000, log: (l) => lines.push(l) })
    vi.restoreAllMocks()
    expect(path).toBeNull()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(lines[1]).toMatch(/^login shell \/bin\/zsh -l -c: skipped, -?\d+ms of the budget left$/)
  })
})

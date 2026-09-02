#!/usr/bin/env node
// FIRST: snapshot the launch directory before any module can chdir. `core.ts`
// chdirs into the prototype's Vite root at startup, and the launcher's
// clone/spawn paths are launch-directory relative — see launch-cwd.ts.
import "./launch-cwd.js"
import {
  startCore,
  AttachRequiredError,
  FrameworkUnsupportedError,
  HostAmbiguousError,
  StampingRequiredError,
} from "./core.js"
import { runDoctor } from "./hosts/doctor.js"
import { HostLadderError, type HostMode } from "./hosts/ladder.js"
import { registeredHostIds } from "./hosts/registry.js"
import { formatStampNoticeLines } from "./hosts/stamp-notices.js"
import { normalizeEqualsFlags } from "./cli-args.js"
import type { HostId } from "./hosts/types.js"
import { cloneRepo } from "./server/clone-repo.js"
import { readHomeUrl } from "./server/home-url.js"
import { startLauncher } from "./server/launcher-server.js"
import { captureInheritedLlmEnv } from "./server/inherited-llm-env.js"

interface ParsedArgs {
  /** Subcommand. `boot` is the default (compatibility with D-0 invocations). */
  command: "boot" | "clone"
  repoPath: string
  /** `clone` subcommand: the repo URL to clone. */
  cloneUrl?: string
  /** `clone` subcommand: optional destination dir (defaults to repo name). */
  cloneDest?: string
  /** `clone` subcommand: optional branch to check out. */
  cloneBranch?: string
  bridgeBundlePath?: string
  uiBundleRoot?: string
  shellPort?: number
  vitePort?: number
  /**
   * `--attach <url>`: proxy a dev server the user already started instead of
   * booting one. Vite, Next.js, Nuxt and React Router boot in-process by
   * default, so this is required only for Astro (a default-off host) and for
   * dev servers the Editor cannot supervise.
   */
  attachUrl?: string
  /**
   * `--host-mode auto|in-process|attach`. What happens when in-process boot
   * cannot be trusted. `auto` (the default, today's behaviour) routes to attach
   * mode with exit 4; `in-process` refuses loudly with exit 6 instead of
   * degrading silently.
   */
  hostMode?: HostMode
  /**
   * `--host <id>`. Names the dev-server host, overriding detection. The one
   * thing that clears an ambiguous-repo refusal (exit 7).
   */
  host?: HostId
  /** `--skip-stamp-verify`: serve anyway when stamping verification concludes it failed. */
  skipStampVerify: boolean
  /** `--doctor`: print what Editor believes about this project, then exit. */
  doctor: boolean
  noOpen: boolean
  help: boolean
}

const HOST_MODES: readonly HostMode[] = ["auto", "in-process", "attach"]

function isHostMode(value: string): value is HostMode {
  return (HOST_MODES as readonly string[]).includes(value)
}

/**
 * Validated against the REGISTRY, not a hand-written list.
 *
 * `registeredHostIds()` includes `attach`, deliberately: `--host attach` is a
 * recognised id whose refusal should say "pass --attach <url>" rather than
 * "unknown host", and `resolveHost` is where that distinction is made. A second
 * list here would be one more place to forget a host.
 */
function isHostId(value: string): value is HostId {
  return (registeredHostIds() as readonly string[]).includes(value)
}

function printHelp(): void {
  console.log(`desde: Editor CLI

Usage:
  desde <repo-path> [options]      Boot the editor
  desde clone <url> [dest] [opts]  Clone a repo, then boot

Boot options:
  --shell-port <n>         HTTP port for the editor UI (default 4321)
  --vite-port <n>          Port for the prototype (default 5173): the Vite dev
                           server Editor boots, or the attach-mode proxy
  --attach <url>           Attach to a dev server YOU started (its origin, e.g.
                           http://localhost:3000) instead of booting one.
                           Vite, Next.js, Nuxt and React Router boot
                           in-process by default, so this is only required
                           for Astro or a server the Editor cannot boot.
                           Attach mode checks that your own config wires the
                           Desde source stamper, and refuses to boot with
                           the exact block to paste if it does not (exit 5).
  --host-mode <mode>       auto (default) | in-process | attach. When Editor
                           boots your dev server but the source stamper turns
                           out not to be running, 'auto' shuts it down and
                           points you at attach mode (exit 4); 'in-process'
                           fails loudly instead (exit 6). 'attach' requires
                           --attach <url>.
  --host <id>              Name the dev-server host instead of detecting it:
                           ${registeredHostIds().join(" | ")}.
                           Needed when a project looks like two frameworks at
                           once (exit 7 says so and lists them). It does NOT
                           skip the host's own seam checks.
  --doctor                 Print what Editor detected, which host would run, the
                           seams that host stands on and what it could stamp.
                           Then exit without booting anything.
  --skip-stamp-verify      Serve anyway when stamping verification concludes
                           the stamper is not running. Edits will be refused.
                           This is a diagnostic override, not a fix.
  --bridge-bundle <path>   Override path to bridge-bundle.js
  --ui-bundle-root <path>  Override path to the built editor UI
  --no-open                Don't try to open the browser automatically

Clone options:
  --branch <name>          Branch to check out after cloning
  Clone uses your local git credentials (SSH agent / https helper).

Common:
  -h, --help               Show this message

Examples:
  desde ./ai-gateway-prototype
  desde ./my-next-app --attach http://localhost:3000
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "boot",
    repoPath: "",
    skipStampVerify: false,
    doctor: false,
    noOpen: false,
    help: false,
  }
  // Detect the subcommand by sniffing argv[0]. `clone` is a reserved
  // token; everything else is the boot command's repo-path positional.
  // This keeps the CLI back-compat with D-0.5 `desde <repo>`.
  let positional = 0
  let consumedCommand = false
  // Accept `--flag=value` as well as `--flag value`. The switch below matches
  // whole tokens, so without this every `=` form hits "Unknown option" —
  // including the `--host-mode=in-process` that Editor's own boot-failure
  // guidance tells users to type. See cli-args.ts for the measurement.
  argv = normalizeEqualsFlags(argv)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (i === 0 && a === "clone") {
      args.command = a
      consumedCommand = true
      continue
    }
    switch (a) {
      case "-h":
      case "--help":
        args.help = true
        break
      case "--no-open":
        args.noOpen = true
        break
      case "--shell-port":
        args.shellPort = parseInt(argv[++i] ?? "", 10)
        break
      case "--vite-port":
        args.vitePort = parseInt(argv[++i] ?? "", 10)
        break
      case "--attach":
        // `?? ""` so a trailing `--attach` with no value is an EMPTY string,
        // not `undefined` — the latter is indistinguishable from "flag never
        // passed" and would silently fall back to booting the supervisor.
        args.attachUrl = argv[++i] ?? ""
        break
      case "--host-mode": {
        const mode = argv[++i] ?? ""
        if (!isHostMode(mode)) {
          throw new Error(`--host-mode must be one of: ${HOST_MODES.join(", ")} (got "${mode}")`)
        }
        args.hostMode = mode
        break
      }
      case "--host": {
        const id = argv[++i] ?? ""
        if (!isHostId(id)) {
          throw new Error(`--host must be one of: ${registeredHostIds().join(", ")} (got "${id}")`)
        }
        args.host = id
        break
      }
      case "--doctor":
        args.doctor = true
        break
      case "--skip-stamp-verify":
        args.skipStampVerify = true
        break
      case "--branch":
        args.cloneBranch = argv[++i]
        break
      case "--bridge-bundle":
        args.bridgeBundlePath = argv[++i]
        break
      case "--ui-bundle-root":
        args.uiBundleRoot = argv[++i]
        break
      default:
        if (a.startsWith("--")) {
          throw new Error(`Unknown option: ${a}`)
        }
        if (args.command === "clone") {
          // `clone <repoUrl> [dest]`
          if (args.cloneUrl === undefined) args.cloneUrl = a
          else if (args.cloneDest === undefined) args.cloneDest = a
          else throw new Error(`Unexpected positional argument: ${a}`)
        } else if (positional === 0 && !consumedCommand) {
          args.repoPath = a
          positional++
        } else {
          throw new Error(`Unexpected positional argument: ${a}`)
        }
    }
  }
  return args
}

async function main(): Promise<void> {
  // FIRST statement of the process, before any branch. Records the LLM
  // credential variables the shell gave us, so nothing downstream can mistake
  // our own injection for the user's configuration.
  //
  // It must be here rather than in `startCore`: `runLauncher` never calls
  // `startCore`, so a launcher-only boot left the baseline empty, and the
  // rollback applied to spawned children then DELETED a genuinely exported
  // `ANTHROPIC_API_KEY` instead of preserving it. Idempotent, so
  // `applyLlmCredentialsAtBoot`'s own call remains a no-op safety net.
  captureInheritedLlmEnv()

  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error((err as Error).message)
    printHelp()
    process.exit(2)
  }

  if (args.help) {
    printHelp()
    return
  }

  if (args.command === "clone") {
    // Clone with the user's own git creds, then fall through to boot on
    // the fresh checkout. A GitHub-OAuth "browse + pick a repo" flow
    // (brokered token) could layer on top, but no such flow is
    // currently wired up.
    if (!args.cloneUrl) {
      console.error("Usage: desde clone <repo-url> [dest] [--branch <b>]")
      process.exit(2)
    }
    console.log(`▸ Cloning ${args.cloneUrl}…`)
    try {
      const { dest } = await cloneRepo({
        repoUrl: args.cloneUrl,
        dest: args.cloneDest,
        branch: args.cloneBranch,
      })
      console.log(`▸ Cloned to ${dest}`)
      // Boot on the freshly cloned repo.
      args.repoPath = dest
    } catch (err) {
      console.error((err as Error).message)
      process.exit(1)
    }
  }

  // No repo path → launcher: a pre-project picker (recents, open a
  // local folder, clone from GitHub) that spawns an editor per choice.
  if (!args.repoPath) {
    await runLauncher(args)
    return
  }

  if (
    (args.shellPort !== undefined && Number.isNaN(args.shellPort)) ||
    (args.vitePort !== undefined && Number.isNaN(args.vitePort))
  ) {
    console.error("--shell-port and --vite-port must be numbers")
    process.exit(2)
  }

  // `--attach` with nothing after it swallows nothing and arrives undefined;
  // catching it here keeps the "no --attach at all" and "empty --attach" paths
  // from converging on the attach-required message, which would be confusing
  // advice for someone who did pass the flag.
  if (args.attachUrl !== undefined && args.attachUrl.trim() === "") {
    console.error("--attach needs a URL, e.g. --attach http://localhost:3000")
    process.exit(2)
  }

  // The two contradictions, refused as usage errors rather than silently
  // resolved. Both would otherwise produce a session that does the OPPOSITE of
  // what the flags asked for, and the user would have no way to tell.
  if (args.hostMode === "attach" && args.attachUrl === undefined) {
    console.error(
      "--host-mode attach needs --attach <url>: Editor does not start your dev server for you.",
    )
    process.exit(2)
  }
  if (args.hostMode === "in-process" && args.attachUrl !== undefined) {
    console.error("--host-mode in-process contradicts --attach <url>. Pass one or the other.")
    process.exit(2)
  }
  // `--host attach` is a recognised id with nothing to boot. Caught here as a
  // usage error rather than left to `resolveHost`'s refusal, so the user gets
  // the corrected flag before any filesystem work happens.
  if (args.host === "attach" && args.attachUrl === undefined) {
    console.error(
      "--host attach needs --attach <url>: Editor does not start your dev server for you. " +
        "Passing --attach alone is enough; --host attach is implied by it.",
    )
    process.exit(2)
  }

  // `--doctor` is a REPORT, and it comes before every gate below: the project
  // most likely to need it is the one that cannot boot, so it must not be
  // reachable only through a successful boot. It resolves the same host the next
  // boot would and prints that host's seams; it starts nothing and probes
  // nothing.
  if (args.doctor) {
    try {
      console.log(
        await runDoctor({
          repoPath: args.repoPath,
          hostId: args.host,
          attachUrl: args.attachUrl,
        }),
      )
    } catch (err) {
      console.error(`Could not produce a host report: ${(err as Error).message}`)
      process.exit(1)
    }
    // Exit 0 even when the report says the project is unsupported or ambiguous.
    // The exit code answers "was a report produced", not "can this project
    // boot" — a support tool that exits non-zero on the diagnosis it was asked
    // for is one a wrapper has to special-case.
    return
  }

  let core
  try {
    core = await startCore({
      repoPath: args.repoPath,
      bridgeBundlePath: args.bridgeBundlePath,
      uiBundleRoot: args.uiBundleRoot,
      shellPort: args.shellPort,
      vitePort: args.vitePort,
      attachUrl: args.attachUrl,
      host: args.host,
      hostMode: args.hostMode,
      skipStampVerify: args.skipStampVerify,
      // Forwarded to editors spawned from the breadcrumb "home"
      // launcher, so they run the same assets this process was started
      // with (mirrors runLauncher's forwarding).
      launcherForwardArgs: buildForwardArgs(args),
        // Set by the launcher that spawned this editor, if any: Home goes
        // back there rather than starting a second launcher.
        homeUrl: readHomeUrl(process.env),
    })
  } catch (err) {
    if (err instanceof FrameworkUnsupportedError) {
      console.error("Repo not supported by Editor:")
      console.error(`  ${err.detection.message}`)
      // Distinct exit code so wrapping CLIs / IDE extensions can
      // distinguish "framework mismatch" from generic boot failure
      // and react accordingly (offer a docs link, switch UX, etc.).
      process.exit(3)
    }
    if (err instanceof AttachRequiredError) {
      // NOT exit 3: this repo IS supported. A wrapping tool that treats 3 as
      // "unsupported, offer the docs" would give exactly the wrong advice, so
      // attach-required gets its own code and its own instructions.
      console.error(err.message)
      process.exit(4)
    }
    if (err instanceof HostAmbiguousError) {
      console.error(err.message)
      // 7, and not one of the four above, because the remedy matches none of
      // them: 3 = use a different tool, 4 = start your dev server, 5 = paste
      // this block into your config, 6 = you asked not to be routed around a
      // failure. This one is "tell us which framework owns your dev server",
      // and it is the same one flag in both the in-process and the attach lane
      // — attach mode cannot guess which config to wire either.
      process.exit(7)
    }
    if (err instanceof StampingRequiredError) {
      // Its own code again, for the same reason 4 is not 3: the remedy differs.
      // 3 = use a different tool, 4 = start your dev server and pass --attach,
      // 5 = paste this block into your config, restart your dev server, re-run
      // this exact command. A wrapper that collapsed 5 into 4 would tell a user
      // whose dev server is already running to start it.
      console.error(err.message)
      process.exit(5)
    }
    if (err instanceof HostLadderError) {
      // The dev server this refers to has ALREADY been shut down by the stamp
      // gate — the message says so, and nothing is left listening.
      console.error(err.decision.message)
      // 4 = "this repo is fine, start your own dev server and pass --attach",
      // the same advice AttachRequiredError gives, so a wrapper that already
      // handles 4 needs no change. 6 is new and means the opposite: the user
      // passed --host-mode=in-process and asked NOT to be routed around the
      // failure. Collapsing them would make that flag unobservable.
      process.exit(err.decision.action === "fail" ? 6 : 4)
    }
    console.error("Failed to start editor:", (err as Error).message)
    process.exit(1)
  }

  if (core.attach) {
    console.log(`▸ Prototype proxied at ${core.viteUrl} → ${core.attach.upstreamUrl}`)
  } else {
    console.log(`▸ Vite running at ${core.viteUrl}`)
  }
  console.log(`▸ Editor UI ready at ${core.shellUrl}`)
  console.log(`▸ Bridge version ${core.bridgeVersion}`)
  console.log("▸ Orchestrator: SDK (CLAUDE.md loaded natively)")

  if (core.projectAssociation.projectSlug) {
    console.log(`▸ Project: ${core.projectAssociation.projectSlug}`)
  }
  for (const w of core.projectAssociation.warnings) {
    console.warn(`▸ ${w}`)
  }
  for (const w of core.frameworkWarnings) {
    console.warn(`▸ ${w}`)
  }

  const externalRoots = core.readRoots.roots.filter((r) => !r.isWorktree)
  if (externalRoots.length > 0) {
    console.log(`▸ Read roots: ${externalRoots.map((r) => r.name).join(", ")}`)
  }
  for (const w of core.readRootsWarnings) {
    console.warn(`▸ ${w}`)
  }

  if (core.smokeReport.problem) {
    console.warn(`▸ Smoke check warning: ${core.smokeReport.problem}`)
    console.warn("  The editor UI is up but edits may fail until this is resolved.")
  } else {
    console.log("▸ Smoke check passed (bridge tag + data-desde-src present in served output)")
    console.log(
      "  Note: this only checks the served markup, not whether the bridge is actually " +
        "running. A strict CSP that blocks inline scripts could still pass this check even " +
        "though the bridge never starts. Confirming that would need a real browser check, " +
        "which this does not run.",
    )
  }

  // The per-MODULE half, printed AFTER the line above and never instead of it —
  // the two answer different questions and both are true. `formatStampNoticeLines`
  // returns nothing when every compiled file stamped cleanly, which is what keeps
  // a healthy boot byte-identical to what it printed before this existed.
  for (const line of formatStampNoticeLines(core.smokeReport.stampNotices)) {
    console.warn(line)
  }

  // Local `claude` CLI integration hint. The `mcp add` command is a
  // one-time setup; after that, every editor-cli boot is
  // auto-discovered via ~/.desde/editor-session.json.
  console.log("")
  console.log("▸ Claude CLI integration (optional, one-time setup):")
  console.log("    claude mcp add editor desde-mcp")
  console.log("  Then run `claude` in any directory to use Editor's tools.")

  if (!args.noOpen) {
    const opened = await tryOpenBrowser(core.shellUrl)
    if (!opened) {
      console.log("  (could not auto-open browser; visit the URL above)")
    }
  }

  // Keep the process alive until the user kills it. `process.once`
  // (not `.on`) so a second Ctrl-C while close() is still running
  // doesn't double-fire the async cleanup; the second signal exits
  // via Node's default behavior. try/finally guarantees the process
  // exits even if close() throws — without it the listener would
  // log-and-hang (Codex Phase B review #4).
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => async () => {
    if (signal === "SIGINT") console.log("\nShutting down…")
    try {
      await core.close()
    } catch (err) {
      console.error(
        `[editor-cli] shutdown cleanup error: ${(err as Error).message}`,
      )
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 143)
    }
  }
  process.once("SIGINT", handleSignal("SIGINT"))
  process.once("SIGTERM", handleSignal("SIGTERM"))

  await new Promise<void>(() => {
    // never resolves
  })
}

/**
 * Serve the launcher (no repo path given). Picking a project spawns a
 * `desde <path>` process on a free port; the picker page
 * redirects the browser to it. The launcher process stays alive so you
 * can open more projects from the same tab.
 */
/**
 * Asset/port overrides to forward to a spawned editor, so it runs the
 * same assets this process was started with (not silent defaults). Shared
 * by the launcher (`runLauncher`) and the breadcrumb "home" launcher
 * (threaded to `startCore` → the http server). `--vite-port` is only
 * forwarded when it's a valid number.
 *
 * `--attach` is deliberately NOT forwarded: it names a dev server running for
 * THIS repo, and the editors spawned from the launcher open a different one.
 * An inherited attach URL would point them at the wrong app.
 *
 * `--host-mode` and `--skip-stamp-verify` are NOT forwarded for the same class
 * of reason: both are judgements about THIS project's boot. Inheriting
 * `--skip-stamp-verify` would silently disable the stamping gate on an
 * unrelated repo, which is the one flag whose whole value is that it is never
 * applied without someone asking for it.
 */
function buildForwardArgs(args: ParsedArgs): string[] {
  const forwardArgs: string[] = []
  if (args.uiBundleRoot) forwardArgs.push("--ui-bundle-root", args.uiBundleRoot)
  if (args.bridgeBundlePath) forwardArgs.push("--bridge-bundle", args.bridgeBundlePath)
  if (args.vitePort !== undefined && !Number.isNaN(args.vitePort)) {
    forwardArgs.push("--vite-port", String(args.vitePort))
  }
  return forwardArgs
}

async function runLauncher(args: ParsedArgs): Promise<void> {
  const port =
    args.shellPort !== undefined && !Number.isNaN(args.shellPort)
      ? args.shellPort
      : undefined
  const launcher = await startLauncher({
    port,
    uiBundleRoot: args.uiBundleRoot,
    forwardArgs: buildForwardArgs(args),
  })
  console.log(`▸ Launcher ready at ${launcher.url}`)
  console.log("  Pick a project, open a local folder, or clone from GitHub.")
  if (!args.noOpen) await tryOpenBrowser(launcher.url)

  const shutdown = (signal: "SIGINT" | "SIGTERM") => async () => {
    if (signal === "SIGINT") console.log("\nShutting down launcher…")
    try {
      await launcher.close()
    } finally {
      process.exit(signal === "SIGINT" ? 130 : 143)
    }
  }
  process.once("SIGINT", shutdown("SIGINT"))
  process.once("SIGTERM", shutdown("SIGTERM"))
  await new Promise<void>(() => {
    // Keep the launcher alive until killed.
  })
}

async function tryOpenBrowser(url: string): Promise<boolean> {
  // Don't add an `open` package dep for one feature. Use platform shell.
  const { spawn } = await import("node:child_process")
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    // REQUIRED, not defensive. A missing binary does not throw here: `spawn`
    // reports `ENOENT` by emitting an `error` event on the child, later, and
    // an `error` event with no listener is re-thrown by EventEmitter as an
    // uncaught exception. So the `catch` below never sees it and the CLI
    // DIES. On a Linux host with no `xdg-open` (a minimal install, a
    // container, an SSH session) that is the editor exiting at boot, for a
    // convenience feature.
    //
    // Found by a codex review of the viewer's copy of this same shape
    // (`viewer/server/open-browser.ts`), which was written from this one.
    // The regression test lives there, since this file has no unit suite.
    child.on("error", () => {
      // A machine with no opener is not a boot failure. The URL is on screen.
    })
    child.unref()
    return true
  } catch {
    // Kept for the synchronous failures that DO throw here.
    return false
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

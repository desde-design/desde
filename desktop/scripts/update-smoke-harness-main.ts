/**
 * Minimal Electron main-process entry used ONLY by the local-feed update
 * smoke harness (`tasks/scripts/desktop-update-smoke.mts`, Phase 4 task 5 —
 * `tasks/electron-app.md` §4/§5). It is NEVER built by `scripts/build.mjs`
 * and NEVER shipped in the packaged app — the smoke driver bundles this file
 * on its own (a separate, one-off esbuild call) and launches the bundle
 * directly via `electron <bundle-path>`.
 *
 * What makes this a REAL integration test and not another unit test: it
 * constructs `createUpdater()` (`../updater.ts`) with NO `source` override,
 * so it wires the ACTUAL `electron-updater` `autoUpdater` singleton — the
 * same object `main.ts` uses in production — against a REAL HTTP feed the
 * driver serves on 127.0.0.1. The reducer and the IPC/UI layers already have
 * their own unit tests with fakes (`__tests__/updater-reducer.test.ts`,
 * `__tests__/updater.test.ts`, `__tests__/preload.test.ts`); this harness
 * exists to prove the ACTUAL library, wired the way production wires it,
 * produces the state sequence those fakes assume.
 *
 * Why a bare script, not `desktop/dist/main.js`: `main.ts` boots the full
 * product (spawns the CLI payload, opens a BrowserWindow, needs a repo to
 * point at). None of that is what this harness is testing — only the
 * updater's event -> state wiring against a real feed. A dedicated, minimal
 * entry keeps the smoke run fast and keeps "what failed" unambiguous (a
 * failure here is the updater, not the payload boot).
 *
 * Protocol with the driver, over stdio (this process has no window, no UI —
 * headless is deliberate, matching what the driver actually needs to
 * observe):
 *   - Driver writes ONE line of JSON to stdin, exactly once, as soon as the
 *     child is spawned: `{ "autoDownload": boolean, "version": "1.0.0" }`.
 *     `version` becomes this process's OWN `app.setVersion(...)` — a bare
 *     `electron <script.js>` launch has no package.json, so `app.getVersion()`
 *     would otherwise report ELECTRON'S OWN version (verified empirically:
 *     "35.7.5" against the pinned devDependency) — not a realistic "current
 *     app version" to diff the feed's declared version against.
 *   - This process replies "READY" on stdout once the updater is
 *     constructed and subscribed — the driver must not send further commands
 *     before seeing this line.
 *   - Every state change is written as one line: `STATE {"phase":"ready",…}`
 *     — the driver parses these to assert on the transition sequence.
*   - Further stdin lines are commands: "download" -> `updater.download()`,
 *     "restart" -> `updater.restartAndInstall()`, "check" ->
 *     `updater.checkForUpdates()` (its result echoed as `CHECK {...}`). All are the SAME
 *     phase-guarded no-ops the real preload/IPC path uses (see updater.ts) —
 *     this harness never bypasses that guard.
 *   - The driver owns lifecycle: it SIGTERMs this process once it has seen
 *     what it needs (or hit its own timeout). There is no self-exit timer
 *     here on purpose — a fixed timer baked into checked-in harness code is
 *     exactly the kind of flaky-by-construction timing the driver's own
 *     explicit `waitForState` timeouts are supposed to replace.
 */
import { app } from "electron"
import { autoUpdater } from "electron-updater"
import * as readline from "node:readline"
import { createUpdater } from "../updater.js"

interface StartConfig {
  autoDownload: boolean
  version: string
}

async function main(): Promise<void> {
  await app.whenReady()

  const rl = readline.createInterface({ input: process.stdin })
  let updater: ReturnType<typeof createUpdater> | undefined

  rl.on("line", (raw) => {
    const line = raw.trim()
    if (!line) return

    if (!updater) {
      const config = JSON.parse(line) as StartConfig
      app.setVersion(config.version)
      updater = createUpdater({ autoDownload: config.autoDownload, forceDevUpdateConfig: true })
      updater.onState((state) => {
        process.stdout.write(`STATE ${JSON.stringify(state)}\n`)
      })
      // The RAW library-level error stream, before updater.ts's attribution
      // ladder decides which operation (if any) it belongs to. A driver that
      // only watches STATE cannot see an error the ladder parks behind an
      // in-flight check and then drops as a superseded operation's.
      autoUpdater.on("error", (err: unknown) => {
        process.stdout.write(`RAWERR ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n`)
      })
      process.stdout.write("READY\n")
      return
    }

    if (line === "download") void updater.download()
    else if (line === "restart") updater.restartAndInstall()
    else if (line === "check") {
      // The on-demand "Check for updates" trigger — the SAME `runCheck()`
      // path the menu item and the 4h timer use. Its settled result is
      // echoed as one `CHECK {...}` line so the driver can assert on
      // `performed` (see updater.ts's `checkForUpdates()` doc comment).
      void updater.checkForUpdates().then((result) => {
        process.stdout.write(`CHECK ${JSON.stringify(result)}\n`)
      })
    }
    else process.stderr.write(`update-smoke-harness-main: unrecognized command ${JSON.stringify(line)}\n`)
  })
}

void main()

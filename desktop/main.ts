/**
 * Electron main — app lifecycle, window creation, child supervision.
 *
 * The whole job, per `tasks/electron-app.md` §3: spawn ONE launcher child
 * (the Phase 1 CLI payload, `ELECTRON_RUN_AS_NODE=1`, no repo path), point a
 * BrowserWindow at the exact URL it prints, and own quit-time cleanup. Every
 * per-project editor child is spawned by the CLI's OWN launcher — this
 * process never calls `startCore()` and never tracks a second child.
 */

import { existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  type MenuItemConstructorOptions,
} from "electron"
import { buildAppMenuItem } from "./app-menu.js"
import { createBootLog } from "./boot-log.js"
import { spawnPayloadChild, PayloadBootFailure, SHUTDOWN_GRACE_MS, type PayloadChildHandle } from "./child.js"
import { createAutoDownloadMutationQueue } from "./auto-download-mutation-queue.js"
import { createChildShutdownCoordinator } from "./child-shutdown-coordinator.js"
import { createClaudeRuntimeController, type ClaudeRuntimeController } from "./claude-runtime-controller.js"
import { ClaudeRuntimeInstallError } from "./claude-runtime-installer.js"
import { COPYRIGHT_LINE } from "./copyright.js"
import { openExternalIfSafe } from "./external-url-guard.js"
import { shouldPromptMoveToApplications } from "./first-launch.js"
import { pickLicensesMenuTarget, resolveLegalResourcePaths } from "./legal-resources.js"
import { mergePathEntries, resolveLoginShellPath } from "./login-shell-path.js"
import { isTrustedNavigationTarget, loopbackHttpOrigin } from "./navigation-guard.js"
import { assertOutsidePackagedAsar, resolvePayloadRoot } from "./payload-resolve.js"
import { PRODUCT_NAME } from "./product-name.js"
import { performRestartAndInstall } from "./restart-and-install.js"
import { getAutoDownload, setAutoDownload } from "./settings.js"
import { broadcastUpdateState } from "./update-broadcast.js"
import { shouldSkipUpdateChecks } from "./update-feed-guard.js"
import { createUpdater, type Updater } from "./updater.js"
import {
  claudeAgentSdkPackageName,
  claudeAgentSdkPlatformCandidates,
  readInstalledClaudeAgentSdkVersion,
  resolveAppSupportDir,
} from "../src/editor/llm-providers/claude-runtime-location.js"
import { readClaudeRuntimeExpectedIntegrity, resolveAnchorPayloadDir } from "./claude-runtime-expectation.js"

// __dirname here is `desktop/dist/` (this file's bundled location, CJS
// output — see scripts/build.mjs) in DEV. Two `..` reach the desktop package
// root, a third reaches the repo root — only meaningful for Phase 2's "runs
// from the checkout" scope (`buildPayload`/`DEFAULT_PAYLOAD_CACHE` below).
// A PACKAGED app never touches this walk-up for the payload: `boot()` passes
// `process.resourcesPath` to `resolvePayloadRoot` whenever `app.isPackaged`,
// which resolves the payload under `Resources/server` instead (see
// `payload-resolve.ts`'s doc comment, source 2, and
// `electron-builder.config.mjs`'s `extraResources` mapping). `__dirname`
// itself is still meaningful when packaged — it's `Contents/Resources/
// app.asar/dist` (this file's `files` entry in the builder config) — but only
// for `createWindow`'s `preload.js` lookup, which stays inside the asar on
// purpose (it's our own small shell code, not the payload).
const DESKTOP_ROOT = resolvePath(__dirname, "..")
const REPO_ROOT = resolvePath(DESKTOP_ROOT, "..")
const DEFAULT_PAYLOAD_CACHE = join(DESKTOP_ROOT, ".payload-cache")

let mainWindow: BrowserWindow | null = null
let childHandle: PayloadChildHandle | null = null
// Tracked separately from `childHandle`: this is the `npm run build:payload`
// process on a cold cache (see `buildPayload`), which can run for MINUTES
// before `childHandle` exists at all. Quitting mid-build must not orphan it —
// `before-quit` below kills it if it's still running.
let buildChild: ChildProcess | null = null
// Module-level (not block-scoped to the `else` branch below) so `boot()`'s
// post-ready exit watcher can read it too: a launcher exit while `quitting`
// is true is OUR OWN shutdown completing as expected; while false, it's the
// launcher dying unexpectedly and needs its own reaction (see boot()).
//
// Narrower job than it looks: this flag only guards against RE-ENTERING a
// quit-triggering ACTION a second time (a duplicate "Restart to update"
// click, a duplicate `before-quit-for-update`) — it does NOT mean "it's now
// safe to let a quit proceed un-prevented." That question is
// `childShutdown.isSettled()`'s job (below) — see its module doc comment
// (child-shutdown-coordinator.ts) for the bug that split these two apart.
let quitting = false
// F9 (second adversarial review pass): bounds the shared shutdown so it can
// never hang forever — see child-shutdown-coordinator.ts's own doc comment.
// Comfortably above SHUTDOWN_GRACE_MS (child.ts's SIGTERM→SIGKILL grace
// period): the deadline exists to catch the case where SIGKILL itself
// somehow never reaps the child, not to race the ordinary grace period —
// this gives that a real moment to actually take effect before giving up.
const CHILD_SHUTDOWN_DEADLINE_MS = SHUTDOWN_GRACE_MS + 5_000
// The ONE child-shutdown operation shared by every quit-triggering path —
// ordinary quit, "Restart to update", and the before-quit-for-update
// backstop. `killChildrenBestEffort` is a hoisted function declaration
// (defined further down this file), so referencing it here at module-init
// time is safe.
const childShutdown = createChildShutdownCoordinator(() => killChildrenBestEffort(), {
  deadlineMs: CHILD_SHUTDOWN_DEADLINE_MS,
})
// Must match preload.ts's own `UPDATE_STATE_CHANNEL` constant — the two
// files are bundled as SEPARATE esbuild entry points (see scripts/build.mjs)
// with no shared runtime module between them, so this is a plain duplicated
// string, the same pattern every other `desktop:*` channel name in this file
// already follows (each one is also independently re-typed in preload.ts).
const UPDATE_STATE_CHANNEL = "desktop:updates:state"
// Same duplication reasoning as UPDATE_STATE_CHANNEL above, for the claude
// runtime installer's state — see preload.ts.
const CLAUDE_RUNTIME_STATE_CHANNEL = "desktop:claude-runtime:state"
// The navigation allowlist — see navigation-guard.ts's doc comment. Seeded
// with the launcher's own origin once it's known (in `boot()`); extended
// only via the `desktop:trust-origin` IPC channel, which the UI calls right
// before it navigates to a newly-opened project's origin.
const trustedOrigins = new Set<string>()

/**
 * Builds a payload at `payloadRoot` by shelling out to the SAME script the
 * terminal workflow uses (`npm run build:payload -- --out <dir>`) — not a
 * second packaging implementation. `stdio: "inherit"` so progress is visible
 * in the terminal that ran `npm run desktop` (this can take a few minutes on
 * a cold cache — see `tasks/electron-app.md` Phase 1's "337MB / 8,473
 * files").
 */
function buildPayload(payloadRoot: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const build = spawn("npm", ["run", "build:payload", "--", "--out", payloadRoot], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      // Windows' `npm` is a `.cmd` shim — `spawn` cannot exec it directly
      // without going through a shell (the bare POSIX exec path this uses on
      // mac/linux, left alone there). No untrusted input reaches the shell
      // string: `payloadRoot` is either an operator-supplied CLI flag/env var
      // or this file's own hardcoded default cache path, never page content.
      shell: process.platform === "win32",
    })
    buildChild = build
    build.once("error", (err) => {
      buildChild = null
      reject(err)
    })
    build.once("exit", (code) => {
      buildChild = null
      if (code === 0) resolve()
      else reject(new Error(`build:payload exited with code ${code}`))
    })
  })
}

/**
 * `build-server-package.mts`'s own success marker (its `MANIFEST_FILENAME`
 * constant — duplicated here as a literal rather than importing that script,
 * which lives under `tasks/scripts/` with tooling this bundle has no
 * business depending on). Written LAST, after `npm install` completes and
 * every artifact is copied and verified — its presence is what that script's
 * OWN `cleanDestination()` uses to tell "a previous successful run" from
 * anything else. `dist/cli.js` alone is NOT sufficient: `copyArtifacts()`
 * writes it early, well before `npm install` — a payload interrupted (or
 * failed) between those two steps would have `dist/cli.js` but no
 * `node_modules`, and checking only the former would treat that half-built
 * cache as done forever, boot-failing on every subsequent launch with no way
 * to recover short of deleting `.payload-cache` by hand.
 */
const PAYLOAD_MANIFEST_FILENAME = "payload-manifest.json"

/** `ms` rendered as the coarsest whole unit that reads naturally — "3 minutes", "2 hours", "5 days" — not a precise duration. Good enough for a diagnostic log line, not meant for anything that parses it back. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
}

/**
 * F2 (whole-branch review, Important): `.payload-cache` is reused forever
 * once it's complete (see `ensurePayload`'s completeness check below) — a
 * payload built weeks ago, before a dozen `editor-cli/src` edits, is
 * otherwise invisible. This runs on EVERY dev boot that reuses the cache
 * (not just the first), and only LOGS — it deliberately never rebuilds on
 * its own, matching `payload-resolve.ts`'s "never auto-rebuild a path the
 * caller didn't ask to rebuild" reasoning for an explicit path. Best-effort:
 * a manifest that fails to read/parse just skips the log line rather than
 * failing boot over a diagnostic.
 */
function logCachedPayloadAge(payloadRoot: string): void {
  try {
    const raw = readFileSync(join(payloadRoot, PAYLOAD_MANIFEST_FILENAME), "utf8")
    const manifest = JSON.parse(raw) as { gitCommit?: unknown; builtAt?: unknown }
    const commit = typeof manifest.gitCommit === "string" ? manifest.gitCommit : "unknown commit"
    const builtAt = typeof manifest.builtAt === "string" ? new Date(manifest.builtAt) : null
    const age =
      builtAt && !Number.isNaN(builtAt.getTime()) ? formatAge(Date.now() - builtAt.getTime()) : "unknown age"
    console.log(`[desktop] Reusing cached payload at ${payloadRoot} — commit ${commit}, built ${age} ago.`)
  } catch (err) {
    console.error(`[desktop] Could not read ${payloadRoot}'s payload manifest for staleness reporting:`, err)
  }
}

/**
 * Ensures a bootable payload exists at `payloadRoot`. An EXPLICIT path
 * (`--payload` / `DESDE_DESKTOP_PAYLOAD`) that turns out incomplete is a
 * hard error — see `payload-resolve.ts`'s doc comment for why a typo should
 * not trigger a silent multi-minute rebuild. The default cache directory
 * builds on first run and is reused (untouched) on every run after — reused
 * only once it's actually COMPLETE, not merely started.
 *
 * `packaged` (`app.isPackaged`) picks which of the two "it's missing" error
 * messages to show — a dev checkout has `npm run build:payload` to point at;
 * a packaged app's user has no repo, no `npm`, no `tsx`, so telling them to
 * run a build command would be actively unhelpful. Both cases still route
 * through the SAME `explicit: true` branch (a packaged path is always
 * `explicit`, per `resolvePayloadRoot`) — this only changes what gets said,
 * never the "never auto-build" behavior itself.
 */
async function ensurePayload(payloadRoot: string, explicit: boolean, packaged: boolean): Promise<void> {
  if (
    existsSync(join(payloadRoot, "dist", "cli.js")) &&
    existsSync(join(payloadRoot, PAYLOAD_MANIFEST_FILENAME))
  ) {
    // F2: only for dev (`npm run desktop`) — a packaged app's payload is
    // fixed at install time and reporting its "age" would just restate the
    // app's own version, which the update badge already covers.
    if (!packaged) logCachedPayloadAge(payloadRoot)
    return
  }
  if (packaged) {
    throw new Error(
      `This copy of ${PRODUCT_NAME} is missing its bundled server (expected at ${payloadRoot}, ` +
        `dist/cli.js and/or ${PAYLOAD_MANIFEST_FILENAME} not found). This is a packaging defect, not ` +
        `something fixable from here — please reinstall the app, or if you built it yourself, re-run ` +
        `the packaging script from a checkout: npm run package:desktop.`,
    )
  }
  if (explicit) {
    throw new Error(
      `No complete payload found at ${payloadRoot} (dist/cli.js and/or ${PAYLOAD_MANIFEST_FILENAME} ` +
        `is missing — an interrupted or --skip-install build looks like this too). Build one with:\n` +
        `  npm run build:payload -- --out ${payloadRoot}`,
    )
  }
  // The default cache directory can exist but be INCOMPLETE (a previous
  // build was interrupted or failed partway — the exact case this
  // function's completeness check above exists to catch). Left in place,
  // build-server-package.mts's OWN `cleanDestination()` refuses to write
  // into a non-empty directory that lacks payload-manifest.json — so
  // handing it a stale incomplete cache would make EVERY subsequent launch
  // fail the exact same way forever, which defeats the entire point of
  // auto-recovering here. Remove it first; this is safe specifically
  // because it's OUR OWN default cache directory, never a path the user
  // named — an explicit --payload/env value is never touched, by design
  // (see the branch above).
  if (existsSync(payloadRoot)) {
    console.log(`[desktop] Removing incomplete cached payload at ${payloadRoot}…`)
    await rm(payloadRoot, { recursive: true, force: true })
  }
  console.log(`[desktop] No complete cached payload at ${payloadRoot} — building one now (first run only)…`)
  await buildPayload(payloadRoot)
}

/**
 * First-launch hygiene (`tasks/electron-app.md` §5 Phase 3 task 3): offers to
 * move the app into `/Applications` on macOS, ONCE, before the payload spawns
 * — see `first-launch.ts`'s module doc comment for why this matters
 * (Squirrel.Mac silently fails to update apps outside `/Applications`, Phase
 * 4/5). A prompt, not a silent move — `moveToApplicationsFolder()` itself has
 * no confirmation of its own.
 *
 * Declining (or a move that throws) must never block boot: this function
 * only ever returns normally in those cases, and `boot()` proceeds to spawn
 * the payload right after — there is no error state here that stops the app
 * from starting. The one case that DOESN'T return is a successful move:
 * `app.moveToApplicationsFolder()` quits this process and relaunches from
 * `/Applications` on its own, so nothing after that call runs.
 */
async function maybePromptMoveToApplications(): Promise<void> {
  if (!shouldPromptMoveToApplications(process.platform, app.isPackaged, app.isInApplicationsFolder())) {
    return
  }
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: `Move ${PRODUCT_NAME} to the Applications folder?`,
    detail:
      `${PRODUCT_NAME} works best from the Applications folder. Running it from ` +
      "somewhere else (like Downloads) will silently block automatic updates once " +
      "those ship.",
  })
  if (response !== 0) return
  try {
    app.moveToApplicationsFolder()
    // Success: the call above already quit this process and relaunched from
    // /Applications. Nothing below this line runs in that case.
  } catch (err) {
    console.error("[desktop] moveToApplicationsFolder failed — continuing from the current location:", err)
  }
}

function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: PRODUCT_NAME,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  })
  mainWindow = win
  // The loaded page (`editor-cli/ui-src/index.html`) carries its own
  // `<title>Desde Editor</title>` — that file is shared with the
  // plain-browser CLI flow and stays out of scope for this rename (see
  // `product-name.ts`'s doc comment and `tasks/electron-app.md`'s Part 1
  // brief). Electron otherwise syncs the native window title to whatever
  // the loaded document's title is, on every load AND on any later
  // `document.title` change — `preventDefault()` here is what keeps the
  // title bar / Dock tooltip / Cmd+Tab switcher on our own `PRODUCT_NAME`
  // regardless, without editing that shared file.
  win.on("page-title-updated", (event) => {
    event.preventDefault()
  })
  // The EXACT string the child printed — never reconstructed. The launcher
  // API's Origin guard is an exact match against `http://<shellHost>:<port>`
  // (shellHost defaults to 127.0.0.1); `http://localhost:<port>` would be
  // refused by design. See `tasks/electron-app.md` §3 "C4".
  void win.loadURL(url)
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    // `targetUrl` is NOT trusted input: this handler fires for
    // `window.open()`/`target="_blank"` from ANY frame in this window,
    // including the unsandboxed prototype iframe
    // (`src/components/editor/live-prototype-pane.tsx`) that renders the
    // user's own untrusted-by-design prototype code — unlike `will-navigate`
    // below, Electron does not scope this to the main frame.
    // `openExternalIfSafe` (external-url-guard.ts) is the one shared gate all
    // three `shell.openExternal` call sites in this file route through — see
    // its doc comment for why an unfiltered `shell.openExternal(targetUrl)`
    // here would have handed the OS a `file:`/`javascript:`/custom-scheme URL
    // with no restriction of its own.
    openExternalIfSafe(targetUrl, shell.openExternal)
    return { action: "deny" }
  })
  // `setWindowOpenHandler` only covers NEW window/tab requests
  // (`window.open()`, `target="_blank"`). It does NOT cover a same-window
  // top-level navigation (a plain link, or `window.location = …`) — Electron
  // would load that page in THIS window and rerun the preload script, handing
  // an untrusted origin the same `window.desdeDesktop` bridge
  // (`pickFolder`, settings writes) our own launcher/editor pages get. The
  // launcher's own client code triggers exactly this kind of navigation on
  // purpose (`window.location.href = res.url` when opening a project) — so
  // this can't be a blanket "never navigate" guard, only an allowlist
  // (`trustedOrigins`, see navigation-guard.ts).
  //
  // Two events, deliberately NOT handled identically:
  //  - `will-navigate` only ever fires for the MAIN frame (Electron's own doc
  //    comment on the event: "start navigation ON THE MAIN FRAME") — this
  //    window's iframe (the prototype under review) never triggers it, so
  //    there is nothing to exclude here.
  //  - `will-redirect` fires for a server-side redirect ANYWHERE, including
  //    inside the prototype iframe — a completely ordinary thing for a real
  //    app to do (e.g. `/` -> `/login`). Guarding it unconditionally would
  //    have blocked the PROTOTYPE's own navigation, not just this window's —
  //    `details.isMainFrame` is what tells the two cases apart, so only a
  //    main-frame redirect goes through the allowlist; a subframe one is left
  //    alone (correct either way, since only the MAIN frame ever gets the
  //    preload script — `webPreferences.preload` is not propagated into
  //    subframes without `nodeIntegrationInSubFrames`, which this app does
  //    not set).
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isTrustedNavigationTarget(targetUrl, trustedOrigins)) return
    event.preventDefault()
    // Same gate as setWindowOpenHandler above — see external-url-guard.ts's
    // doc comment. `targetUrl` reaching here already failed the trust check,
    // but "not one of our own origins" is not the same thing as "safe to
    // hand to the OS": it could just as easily be `file:` or a custom scheme.
    openExternalIfSafe(targetUrl, shell.openExternal)
  })
  win.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame) return
    if (isTrustedNavigationTarget(event.url, trustedOrigins)) return
    event.preventDefault()
    // Same gate — see the will-navigate handler above and
    // external-url-guard.ts's doc comment.
    openExternalIfSafe(event.url, shell.openExternal)
  })
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null
  })
}

/**
 * Opens the best available licensing/attribution document for the "Licenses…"
 * app-menu item (AGPL-3.0 relicensing) — the aggregated third-party notices
 * document when one has been generated (packaged builds always have one; a
 * dev checkout only does after its first `npm run package`), falling back to
 * Desde's own root LICENSE otherwise. See `legal-resources.ts`'s doc comment
 * for the full path-resolution design; this function is the thin, untested
 * Electron glue around it (same split `openExternalIfSafe` callers use
 * elsewhere in this file — the decision logic is pure and tested, the actual
 * `shell` call is not).
 */
function openLicenses(): void {
  const paths = resolveLegalResourcePaths(DESKTOP_ROOT, REPO_ROOT, app.isPackaged ? process.resourcesPath : null)
  const target = pickLicensesMenuTarget(paths, existsSync)
  shell.openPath(target).then((errorMessage) => {
    if (errorMessage) {
      dialog.showErrorBox(`Couldn't open ${target}`, errorMessage)
    }
  })
}

function buildMenu(): Menu {
  const isMac = process.platform === "darwin"
  // F4 (tasks/electron-app.md §5 Phase 5b review): NOT `{ role: "appMenu" }`
  // — that auto-labels "About …"/"Hide …"/"Quit …" from `app.getName()`,
  // which is the packaged app's internal package name, not PRODUCT_NAME. See
  // app-menu.ts's own doc comment for the full reasoning.
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [buildAppMenuItem(openLicenses)] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  return Menu.buildFromTemplate(template)
}

function registerIpcHandlers(updater: Updater, claudeRuntime: ClaudeRuntimeController): void {
  ipcMain.handle("desktop:pick-folder", async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // `handle`, not `on` — the renderer (useLauncherApi's openPath) awaits
  // this before navigating, so the trust IPC is guaranteed processed
  // before the navigation reaches will-navigate. An `on`/`send` pair is
  // fire-and-forget with no such ordering guarantee, which was a real,
  // intermittent race: the navigation could reach the guard before this
  // handler had run, blocking a just-opened editor's own origin.
  //
  // Validated with the SAME loopback-http shape check the guard itself
  // applies to a navigation target — see loopbackHttpOrigin's doc comment
  // for why an unchecked add here would matter.
  ipcMain.handle("desktop:trust-origin", (_event, url: unknown) => {
    if (typeof url !== "string") return
    const origin = loopbackHttpOrigin(url)
    if (origin) trustedOrigins.add(origin)
  })

  ipcMain.handle("desktop:updates:get-state", () => updater.getState())
  ipcMain.handle("desktop:updates:download", () => updater.download())
  // `handle`, not `on` (F3, whole-branch review, P2 fix): the renderer
  // awaits this to know PRECISELY when its own click's check has settled,
  // instead of guessing a timeout window against electron-updater's HTTP
  // layer — see updater.ts's `checkForUpdates()` doc comment.
  ipcMain.handle("desktop:updates:check", () => updater.checkForUpdates())
  ipcMain.on("desktop:updates:restart-and-install", () => {
    void performRestartAndInstall({
      getPhase: () => updater.getState().phase,
      isQuitting: () => quitting,
      markQuitting: () => {
        quitting = true
      },
      // Routes through the SAME shared coordinator `before-quit` below
      // waits on — see child-shutdown-coordinator.ts's doc comment for why
      // an ordinary quit racing this flow needs to observe the SAME
      // in-flight shutdown rather than trusting `quitting` alone.
      shutdownChildren: () => childShutdown.ensure(),
      restartAndInstall: () => updater.restartAndInstall(),
      // F9 (second review pass): the deadline-bounded shutdown gave up
      // waiting for confirmation. The install must never proceed on an
      // unconfirmed shutdown, so this is the only place it's safe to tell
      // the user something actually went wrong, rather than the app just
      // sitting there.
      onShutdownFailed: (err) => {
        console.error("[desktop] restart-and-install: child shutdown did not complete:", err)
        dialog.showErrorBox(
          "Couldn't restart to install the update",
          `${PRODUCT_NAME} couldn't confirm the running server had shut down, so the ` +
            "update was not installed to avoid corrupting it. Please quit and reopen the " +
            "app manually; if this keeps happening, restart your computer.",
        )
      },
      // F10 (second review pass): shutdown succeeded, but the updater's own
      // phase moved on during the wait (e.g. a newer update became
      // available), so restartAndInstall() silently no-op'd. The payload
      // child is ALREADY dead at this point — falling through to a plain
      // quit is the only way to avoid leaving the window open with no
      // server behind it. autoInstallOnAppQuit (updater.ts) still applies
      // whatever is legitimately ready, if anything, on the way out.
      onInstallNoLongerAuthorized: () => {
        console.error(
          "[desktop] restart-and-install: the update was no longer ready once shutdown finished — quitting instead of leaving a dead window open",
        )
        app.quit()
      },
    })
  })
  ipcMain.handle("desktop:settings:get-auto-download", () => getAutoDownload())
  // Persistence + the live `autoUpdater.autoDownload` flag are updated as
  // ONE ordered step per toggle, serialized in the order the renderer
  // invoked them — see auto-download-mutation-queue.ts's doc comment for
  // why `ipcMain.handle` alone doesn't guarantee that (two rapid toggles
  // dispatch two independent, concurrently-running handler calls). Flipping
  // the live flag matters on its own too: without it the toggle would only
  // take effect after the app is relaunched (the next time `boot()` reads
  // the persisted setting), which is not what "Download updates
  // automatically" reads as when you just clicked it.
  const autoDownloadMutations = createAutoDownloadMutationQueue({
    persist: setAutoDownload,
    applyLive: (value) => updater.setAutoDownload(value),
  })
  ipcMain.handle("desktop:settings:set-auto-download", (_event, value: boolean) =>
    autoDownloadMutations.mutate(value),
  )

  ipcMain.handle("desktop:claude-runtime:get-state", () => claudeRuntime.getState())
  // `on`, not `handle` — fire-and-forget, matching restart-and-install's own
  // one-way channel. The result reaches the caller via the SAME `onState`
  // push every other trigger (boot, a prior failed attempt) already uses;
  // there's nothing meaningful to return synchronously from a "kick off a
  // background install" call.
  ipcMain.on("desktop:claude-runtime:retry", () => {
    claudeRuntime.ensure()
  })
}

/**
 * A boot failure gets a real, readable error — the CLI's own `stderr` tail
 * when it said anything (`PayloadBootFailure`), not a blank window. Matches
 * the reasoning `editor-boot-failure.ts` documents for the analogous
 * "launcher spawns an editor" case: a typed refusal that never reaches the
 * user is worse than useless, because the printed remediation steps are
 * exactly what a GUI user needed and never saw.
 */
function fatalBoot(err: unknown): void {
  const message =
    err instanceof PayloadBootFailure
      ? `${err.message}\n\n${err.detail || "(the launcher exited with no output)"}`
      : err instanceof Error
        ? err.message
        : String(err)
  console.error("[desktop] fatal boot error:", message)
  dialog.showErrorBox(`${PRODUCT_NAME} failed to start`, message)
  app.exit(1)
}

async function boot(): Promise<void> {
  await maybePromptMoveToApplications()

  // A Finder/Dock launch inherits launchd's bare PATH, not the user's
  // terminal PATH — so the child CLI, and every `git`/`gh`/`npm` it spawns,
  // would resolve to Apple's copies or to nothing (see login-shell-path.ts
  // for the keychain-prompt-every-minute failure this produced). Fix
  // `process.env` itself, once, before anything below spawns: child.ts
  // spreads `process.env` into the payload child, and the dev-mode payload
  // build and the claude-runtime installer spawn from this process too.
  // The shell is detached (so a hung rc file's whole process group can be
  // killed on timeout), which also means a quit during these few seconds
  // would otherwise leave it running with nothing to time it out.
  // `boot.log` in the user data directory: a Finder launch has no stdout,
  // and the one time this resolver failed (2026-09-02, the updater's
  // relaunch of 0.1.1) nothing recorded why. See boot-log.ts.
  const bootLog = createBootLog(join(app.getPath("userData"), "boot.log"))
  bootLog(`boot: version ${app.getVersion()}, packaged ${app.isPackaged}, launch PATH ${process.env.PATH ?? "(unset)"}`)
  const loginShellAbort = new AbortController()
  const abortLoginShell = () => loginShellAbort.abort()
  app.once("before-quit", abortLoginShell)
  const loginShellPath = await resolveLoginShellPath({
    platform: process.platform,
    env: process.env,
    signal: loginShellAbort.signal,
    log: bootLog,
  })
  app.removeListener("before-quit", abortLoginShell)
  if (loginShellPath) {
    process.env.PATH = mergePathEntries(loginShellPath, process.env.PATH)
    bootLog(`PATH for children: ${process.env.PATH}`)
  } else {
    bootLog("PATH for children: the launch PATH, unchanged (no login shell answered)")
  }

  // AGPL-3.0 relicensing: sets the native About panel's copyright line
  // explicitly (macOS/Windows both read `copyright` here) rather than
  // relying solely on the packaged app's Info.plist `NSHumanReadableCopyright`
  // key — electron-builder.config.mjs's `copyright` field writes that key
  // too (kept in sync BY HAND with COPYRIGHT_LINE, same tradeoff as
  // PRODUCT_NAME/`productName` — see copyright.ts's doc comment), but a dev
  // run (`npm run desktop`) has no meaningfully-populated Info.plist at all,
  // so this call is what makes the About panel correct there too. `credits`
  // points at the same "Licenses…" app-menu item rather than repeating the
  // full third-party notices document inline — `setAboutPanelOptions`'s
  // `credits` field is plain text, not a file reference, and this document
  // runs to hundreds of KB.
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT_LINE,
    credits: "For open-source licenses and third-party notices, see the app menu's Licenses… item.",
  })

  // Constructed here (post-ready, before anything else) so "checking is
  // always on" — tasks/electron-app.md §4 — starts as early as possible,
  // independent of how long the payload takes to boot (which can be minutes
  // on a cold `.payload-cache`, see buildPayload above). `autoDownload`
  // starts from the persisted setting; DESDE_DESKTOP_FORCE_DEV_UPDATE_CONFIG
  // is the local-feed smoke harness's opt-in (see updater.ts's doc comment) —
  // unset in every normal run, packaged or dev.
  // F1 (whole-branch review, merge blocker; P1 fix on second pass): a
  // packaged app whose package-time stamp (`update-feed-status.json`,
  // written by `electron-builder.config.mjs`'s `afterPack` hook) confirms no
  // `publish` provider was configured skips the real check loop — see
  // `update-feed-guard.ts`'s doc comment for the full failure mode and why
  // the stamp (not "does app-update.yml happen to be missing") is the right
  // question. Passed as a CALLBACK, not a one-time boolean: `updater.ts`
  // re-invokes it on every trigger (construction, each 4h fire, each
  // on-demand click), so it re-reads the stamp fresh each time rather than
  // freezing an answer at boot. TEMPORARY: delete this guard (and the
  // `shouldSkipCheck` option it drives in updater.ts) once Phase 5 lands a
  // real publish config and every packaged app's stamp says so.
  const updater = createUpdater({
    autoDownload: await getAutoDownload(),
    forceDevUpdateConfig: process.env.DESDE_DESKTOP_FORCE_DEV_UPDATE_CONFIG === "1",
    shouldSkipCheck: () =>
      shouldSkipUpdateChecks({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        readFileSync: (path) => readFileSync(path, "utf8"),
      }),
  })
  updater.onState((state) => {
    broadcastUpdateState(UPDATE_STATE_CHANNEL, state, BrowserWindow.getAllWindows())
  })

  const { path: payloadRoot, explicit } = resolvePayloadRoot(
    process.argv,
    process.env,
    DEFAULT_PAYLOAD_CACHE,
    process.cwd(),
    app.isPackaged ? process.resourcesPath : null,
  )
  // The one assertion point for the one spawn seam (`spawnPayloadChild`
  // below, via `child.ts`) — see payload-resolve.ts's doc comment. Thrown
  // BEFORE ensurePayload's existsSync checks, which would otherwise just
  // report "missing" for a path that is actually present but structurally
  // wrong (inside the asar), a much more confusing failure to debug.
  assertOutsidePackagedAsar(payloadRoot)
  await ensurePayload(payloadRoot, explicit, app.isPackaged)

  // ── claude runtime (tasks/electron-app.md "fetch the claude binary on
  // first run") ──────────────────────────────────────────────────────────
  // The app-support dir is a pure path computation (no I/O) — safe to
  // compute NOW and pass to spawnPayloadChild below regardless of whether
  // the install itself has finished. `claudeRuntime.ensure()` is fired
  // WITHOUT awaiting: boot must never block on a ~200MB network download
  // (the brief's explicit constraint), and the CLI-side resolver
  // (`resolve-claude-executable.ts`) does a live filesystem check on every
  // `query()` call rather than trusting a value cached at spawn time — see
  // that module's doc comment for why the two never need to be
  // synchronized more tightly than this.
  const claudeRuntimeAppSupportDir = resolveAppSupportDir({
    home: homedir(),
    platform: process.platform,
    appName: PRODUCT_NAME,
    env: process.env,
  })
  const claudeRuntimeConfig = (() => {
    try {
      const sdkVersion = readInstalledClaudeAgentSdkVersion(join(payloadRoot, "package.json"))
      // The signed-anchor integrity expectation (F1): the payload lockfile
      // inside the code-signed bundle records the sha512 SRI for the exact
      // platform-package tarball the installer will fetch. Read here — same
      // fail-closed IIFE as the version read — so a payload whose lockfile
      // is missing/mismatched yields a controller that REFUSES to install
      // rather than installing unverified. IMPORTANT (F4): in a packaged
      // build the anchor is read from `<resourcesPath>/server`, NEVER from
      // a `--payload`/env override — an override is an unsigned copy whose
      // lockfile anyone able to influence startup can rewrite; the
      // sdkVersion still comes from the payload actually being run, so an
      // override with a different SDK version fails the reader's version
      // check and installs are refused. See resolveAnchorPayloadDir's doc
      // comment in claude-runtime-expectation.ts.
      const [platformSuffix] = claudeAgentSdkPlatformCandidates(process.platform, process.arch)
      const expectedIntegrity = readClaudeRuntimeExpectedIntegrity({
        payloadDir: resolveAnchorPayloadDir({
          payloadRoot,
          packagedResourcesPath: app.isPackaged ? process.resourcesPath : null,
        }),
        packageName: claudeAgentSdkPackageName(platformSuffix),
        sdkVersion,
      })
      return { sdkVersion, expectedIntegrity }
    } catch (err) {
      // Should be unreachable for a valid payload (build-server-package.mts
      // always generates a package.json declaring this dependency, and its
      // staging `npm install` writes the lockfile) — logged for diagnosis,
      // but must never fail boot. The controller below still gets
      // constructed so the IPC/UI surface behaves predictably; its ensureFn
      // is swapped for one that fails fast with a clear cause instead of
      // guessing at a version or downloading something it couldn't verify.
      console.error(
        "[desktop] could not determine the installed @anthropic-ai/claude-agent-sdk version/integrity — the AI chat runtime install will report an error:",
        err,
      )
      return null
    }
  })()
  const claudeRuntime = createClaudeRuntimeController({
    appSupportDir: claudeRuntimeAppSupportDir,
    sdkVersion: claudeRuntimeConfig?.sdkVersion ?? "unknown",
    expectedIntegrity: claudeRuntimeConfig?.expectedIntegrity ?? "",
    ...(claudeRuntimeConfig === null
      ? {
          ensureFn: () =>
            Promise.reject(
              new ClaudeRuntimeInstallError(
                "unknown",
                `Could not determine the installed Claude Agent SDK version or its download checksum — ` +
                  `this copy of ${PRODUCT_NAME}'s server payload may be corrupted. Try reinstalling ${PRODUCT_NAME}.`,
              ),
            ),
        }
      : {}),
  })
  claudeRuntime.onState((state) => {
    broadcastUpdateState(CLAUDE_RUNTIME_STATE_CHANNEL, state, BrowserWindow.getAllWindows())
  })
  claudeRuntime.ensure()

  childHandle = await spawnPayloadChild({
    execPath: process.execPath,
    payloadRoot,
    claudeRuntimeAppSupportDir,
    // NOT process.cwd() — Electron main's own cwd depends on how it was
    // launched (`desktop/` under `npm --prefix desktop run …`, the repo
    // root, or whatever a packaged app's OS-level launch happens to set)
    // and the launcher inherits it as the base for GitHub clone
    // destinations. The user's home directory is the one answer that's
    // right regardless of how this process itself got started — the same
    // default a native git client or file-picker "New folder here" would
    // land on. See child.ts's `cwd` doc comment.
    cwd: homedir(),
  })
  // spawnPayloadChild's own promise only covers BOOT — it settles once the
  // ready line is seen (or the child dies before that) and then stops
  // watching. Nothing else observes a LATER exit: if the launcher crashes
  // or is killed after successfully starting, the window would otherwise
  // sit there pointed at a dead launcher API forever, and macOS `activate`
  // (see below) could even recreate that same stale window if the user
  // closed it and clicked the dock icon. `quitting` tells this apart from
  // our OWN shutdown completing (before-quit already sets it before it
  // terminates the child) — only an exit while it's still false is
  // unexpected. Deliberately does NOT try to reap any per-project editor
  // children the launcher had spawned: those are the launcher's OWN
  // childTracker's job, and an abnormal launcher exit (uncaught exception,
  // an external kill) bypasses that cleanup the same way it would for a
  // terminal user — a pre-existing property of the CLI process itself, not
  // something new this wrapper introduces or is positioned to fix.
  childHandle.child.once("exit", (code, signal) => {
    if (quitting) return
    console.error(`[desktop] launcher exited unexpectedly (code=${code}, signal=${signal})`)
    dialog.showErrorBox(
      `${PRODUCT_NAME} stopped unexpectedly`,
      `The launcher process exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). ` +
        "The app will now quit.",
    )
    app.exit(1)
  })
  // The launcher's own origin is trusted unconditionally — main chose it
  // itself (it's the exact url the child printed on its ready line, see
  // child.ts), not something learned from a page. Every OTHER trusted
  // origin (a per-project editor) is added later, only via the
  // desktop:trust-origin IPC channel.
  const launcherOrigin = loopbackHttpOrigin(childHandle.url)
  if (launcherOrigin) trustedOrigins.add(launcherOrigin)

  registerIpcHandlers(updater, claudeRuntime)
  createWindow(childHandle.url)
  Menu.setApplicationMenu(buildMenu())

  app.on("activate", () => {
    // macOS: clicking the dock icon with no window open re-opens the SAME
    // running launcher's URL rather than spawning a second launcher child.
    if (BrowserWindow.getAllWindows().length === 0 && childHandle) {
      createWindow(childHandle.url)
    }
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(boot).catch(fatalBoot)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", (event) => {
    // Nothing was ever spawned — nothing to wait for.
    if (!childHandle && !buildChild) return
    // The shared shutdown (child-shutdown-coordinator.ts) has already
    // finished — whether started by an EARLIER firing of this same handler,
    // or by an in-flight "Restart to update" (performRestartAndInstall,
    // restart-and-install.ts) — so it's safe to let this quit (or
    // Electron's own subsequent `before-quit`, once windows are closing)
    // proceed without holding it open again.
    //
    // Deliberately NOT gated on `quitting` alone (that was the bug this
    // closes, follow-up to F1 of the adversarial review of Phase 4): an
    // ordinary quit racing an in-flight update-restart must not step aside
    // just because that OTHER path already flipped `quitting` — the
    // restart path ends in quitAndInstall(), not a plain app.quit(), so
    // nothing else was going to hold this quit back. `isSettled()` is the
    // one signal that actually means "safe now" — see
    // child-shutdown-coordinator.ts's module doc comment.
    if (childShutdown.isSettled()) return
    event.preventDefault()
    quitting = true
    void childShutdown.ensure().finally(() => app.quit())
  })

  // `autoUpdater.quitAndInstall()` (Phase 4's "Restart to update" —
  // updater.ts's `restartAndInstall`) — tasks/electron-app.md §4: "careful
  // with the event order: quitAndInstall() closes all windows FIRST and only
  // THEN quits — cleanup hooked solely on before-quit runs at the wrong
  // point." electron-updater emits this event on Electron's OWN native
  // `autoUpdater` singleton for exactly this (on mac it's Electron's built-in
  // Squirrel.Mac behavior; on win/linux electron-updater emits it itself to
  // match — see node_modules/electron-updater/out/BaseUpdater.js).
  //
  // This is NOT the primary defense anymore (F1 of the adversarial review of
  // Phase 4). The event is not cancelable — by the time it fires,
  // quitAndInstall() is already proceeding to close every window and call
  // app.quit() on its own, so a fire-and-forget shutdown STARTED from here
  // cannot delay anything: Electron proceeds the instant this handler
  // returns, whether or not the child has actually exited. The real fix is
  // in the `desktop:updates:restart-and-install` IPC handler above
  // (`performRestartAndInstall`, restart-and-install.ts): it shuts the child
  // down FIRST and only calls `updater.restartAndInstall()` — which is what
  // triggers quitAndInstall() and this event — once that shutdown has
  // resolved. By the time this handler runs in that flow, `quitting` is
  // already `true` and `childShutdown` has already settled, so the body
  // below is a no-op.
  //
  // Left wired as a defense-in-depth backstop for any OTHER path that might
  // call quitAndInstall() without going through that ordered routine (e.g. a
  // future auto-install-on-quit trigger this file doesn't originate) — best
  // effort only, same as before: join the SAME shared shutdown
  // (child-shutdown-coordinator.ts) so a child at least gets its SIGTERM as
  // early as possible, even though this handler has no way to hold the quit
  // open for it. Setting `quitting = true` here also suppresses a
  // duplicate re-entry into this handler if it somehow fired twice; the
  // ordinary `before-quit` handler above no longer needs this flag to decide
  // whether it's safe to let a quit through — it checks
  // `childShutdown.isSettled()` instead (see that handler's own doc
  // comment for why a plain "someone else already flipped `quitting`" check
  // was the actual bug here).
  nativeAutoUpdater.on("before-quit-for-update", () => {
    if (quitting) return
    quitting = true
    void childShutdown.ensure()
  })
}

/**
 * Best-effort kill of the launcher child (`childHandle`) plus any in-flight
 * first-run payload build (`buildChild`) — shared by both quit paths above.
 * Both cases being set can only happen in the impossible window between a
 * build finishing and `spawnPayloadChild` resolving; harmless either way,
 * since killing an already-exited `buildChild` is a caught no-op.
 *
 * `buildChild` gets a plain SIGTERM with no SIGKILL escalation — unlike the
 * payload child, it's a dev-only, first-run-only convenience path with no
 * packaged-app equivalent (Phase 3 always ships a pre-built payload); `npm
 * run build:payload` finishing its own `npm install` a few seconds late
 * after a quit is a cosmetic nuisance, not a leaked server holding a port
 * open — not worth a second child-tracker instance for.
 */
function killChildrenBestEffort(): Promise<void> {
  const handle = childHandle
  const build = buildChild
  if (build) {
    try {
      build.kill("SIGTERM")
    } catch {
      // already gone
    }
  }
  return (handle ? handle.shutdown() : Promise.resolve()).catch((err: unknown) => {
    console.error("[desktop] error shutting down the launcher child:", err)
  })
}

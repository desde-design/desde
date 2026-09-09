/**
 * Launcher server — what `desde` serves when invoked
 * with no repo path. A pre-project home page: recent projects, "open a
 * local folder" (native OS picker), and "clone from GitHub". Selecting
 * one spawns a normal `desde <path>` process on a free
 * port and redirects the browser to it.
 *
 * The page is the SAME built React bundle the editor serves
 * (`ui-src/dist`) — `main.tsx` branches on the
 * `window.__DESDE_LAUNCHER__` bootstrap global this server
 * injects (vs the editor's `__DESDE_CLI__`), so the launcher
 * automatically stays on the shared design system instead of shipping
 * a bespoke standalone HTML page. All mutating endpoints (`open`,
 * `clone`, `pick-folder`) inherit the same per-session bearer +
 * strict-Origin guard the editor's `/api/*` uses.
 *
 * The GitHub-OAuth "browse + pick a repo" flow layers on top of the
 * clone-by-URL path here and is out of scope.
 */

import {
  configPathFor,
  ensureProjectIdentity,
  renameProjectIdentity,
} from "./project-config.js"
import { readIdentityFromConfig } from "../../../src/core/project-identity.js"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { createChildTracker, type ChildTracker } from "./child-tracker.js"
import { launchCwd } from "../launch-cwd.js"
import { spawnEnvWithInheritedLlmCredentials } from "./inherited-llm-env.js"
import { homeUrlEnv } from "./home-url.js"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { basename, resolve as resolvePath } from "node:path"
import {
  withRunningEditorReuse,
  type SpawnEditor,
  type SpawnedEditor,
  type SpawnedEditorSeed,
} from "./running-editors.js"
import { newSecurityContext, checkAuth, type SecurityContext } from "./auth.js"
import { checkHost, isCrossSiteFetch, listenOriginFor } from "./host-guard.js"
import { readJsonBody, sendJson, runHandler } from "./artifact-http.js"
import {
  LLM_CREDENTIALS_ROUTE,
  handleLlmCredentialsRoute,
} from "./llm-credentials-handler.js"
import { isClaudeRuntimeResolvable } from "./claude-runtime-available.js"

/**
 * The one refusal for "there is no directory at that path".
 *
 * It read `Not a directory: ${abs}` until 2026-08-17, which was wrong twice
 * over on the common case. `isDirectory()` is false both when the path does
 * not exist and when it exists as a file, and the first is what a designer
 * hits by typing a path with a typo in it — "not a directory" then describes a
 * thing that is not there at all. The echoed absolute path added nothing
 * either: they typed it, and the field is still showing it.
 *
 * `read-roots-handler.ts` keeps its own "Not a directory", correctly — it
 * stats first, so by the time it says that, the path provably exists and
 * provably is a file.
 */
const DIRECTORY_NOT_FOUND = "Directory not found"
import {
  patchProjectRegistryEntry,
  readProjectsRegistry,
  removeProjectRegistryEntry,
} from "./projects-registry.js"

/**
 * The project's display name, read from the identity block ALONE.
 *
 * Not through `readProjectConfig`: that validates the whole file, so a bad
 * unrelated field (a malformed `chat` setting, say) would report "no name"
 * for a perfectly good identity block, the list would clear the cached
 * name, and a rename would never show while the unrelated error stood.
 *
 * Two answers, kept apart because the callers do different things with
 * them. `readable: true, name: null` is a repo with no identity (no config,
 * or a config without a block): the folder name is the honest title, and a
 * cached name may be cleared. `readable: false` is a file that exists but
 * cannot be read or parsed: nothing is known, so a cached name is kept, and
 * the settings page still opens so the user can fix the file there.
 */
type IdentityNameRead = { readable: true; name: string | null } | { readable: false }

async function readProjectIdentityName(repoRoot: string): Promise<IdentityNameRead> {
  let text: string
  try {
    text = await readFile(configPathFor(repoRoot), "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { readable: true, name: null }
    return { readable: false }
  }
  if (text.trim() === "") return { readable: true, name: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { readable: false }
  }
  return { readable: true, name: readIdentityFromConfig(parsed)?.name ?? null }
}
import { seedDemoProject } from "./demo/seed.js"
import { checkLauncherOpen, supportedHostsFor } from "./launcher-open-check.js"
import { createReadyLineReader } from "./ready-line.js"
import {
  EditorBootFailure,
  bootFailureBlock,
  createStderrTail,
} from "./editor-boot-failure.js"
import { cloneRepo } from "./clone-repo.js"
import { listGitHubRepos } from "./github-repos.js"
import {
  pickFolder as defaultPickFolder,
  folderPickerSupported,
  type FolderPickPurpose,
  type PickFolder,
} from "./folder-picker.js"
import {
  BOOTSTRAP_PATH,
  resolveUiBundleRoot,
  serveBootstrapJs,
  serveStatic,
} from "./static-assets.js"
import { suggestDesignSystems } from "../../../src/editor/onboarding/index.js"
import {
  validateDeclaration,
  appendDesignSystemDeclaration,
  declarationIdentity,
  loadDesignSystemDeclarations,
  removeDesignSystemDeclaration,
  type DesignSystemDeclaration,
} from "../../../src/editor/core/design-system-declarations.js"
import {
  appendReadRoot,
  checkReadRootPath,
  loadReadRootDeclarations,
  removeReadRoot,
  suggestReadRootName,
  validateReadRootDeclaration,
  type ReadRootDeclaration,
} from "../../../src/editor/core/read-root-declarations.js"
import { isGitRepository } from "../../../src/editor/core/read-roots.js"
import { materializeDemo } from "./demo/materialize.js"
import { demoRepoPath, readDemoState } from "./demo/paths.js"
import { classifyDemoChanges, removeDemo } from "./demo/remove.js"

export interface LauncherHandle {
  url: string
  close: () => Promise<void>
}

/**
 * Spawn an editor on `repoPath` and resolve once it's serving.
 * Injectable so tests don't boot a real Vite child.
 */
/**
 * Re-exported so existing callers keep their import; the type now lives with
 * the one-editor-per-repo memory that wraps it (`running-editors.ts`).
 */
export type { SpawnEditor } from "./running-editors.js"

export interface StartLauncherOptions {
  host?: string
  port?: number
  /** Override the spawn (tests). Default re-invokes this CLI on a free port. */
  spawnEditor?: SpawnEditor
  /**
   * Editors already running when this launcher starts, so an open for their
   * repo answers with them instead of spawning. The editor that starts a
   * launcher lazily from its own Home breadcrumb passes itself here.
   */
  runningEditors?: readonly SpawnedEditorSeed[]
  /** Override the native folder picker (tests). */
  pickFolder?: PickFolder
  /**
   * Seed the bundled demo as a project on the first projects request
   * (default true). Tests that boot many launchers switch it off, since
   * seeding copies the demo fixture into HOME; see `demo/seed.ts`.
   */
  seedDemo?: boolean
  /** Override the demo fixture the seed copies (tests). */
  demoFixtureDir?: string
  /**
   * Where the built editor UI bundle lives. Defaults to
   * `editor-cli/ui-src/dist`; the `--ui-bundle-root` CLI flag both
   * overrides this and is forwarded to spawned editors.
   */
  uiBundleRoot?: string
  /**
   * Extra CLI args forwarded verbatim to each spawned editor — the
   * asset/port overrides the launcher itself was started with
   * (`--ui-bundle-root`, `--bridge-bundle`, `--vite-port`), so a
   * launcher-opened project runs the same assets the user requested.
   */
  forwardArgs?: string[]
}

interface LauncherContext {
  security: SecurityContext
  spawnEditor: SpawnEditor
  pickFolder: PickFolder
  uiBundleRoot: string
  /**
   * `http://<host>:<port>` for the socket this launcher is actually bound to
   * — the DNS-rebinding `Host` guard's yardstick, not `security.shellOrigin`.
   * See `host-guard.ts`.
   */
  listenOrigin: string
  /**
   * The one-time demo seed, shared across requests. Resolves to the same
   * promise for every caller, so two concurrent projects requests (React's
   * dev double-effect, a second tab) cannot both copy the fixture.
   */
  seedDemo: () => Promise<void>
  /**
   * Why the last seed attempt failed, or null. Reported on the projects
   * list so a launcher whose demo could not be created says so instead of
   * showing an empty list with no explanation.
   */
  demoSeedError: () => string | null
}

/**
 * A seed failure in words the launcher can show. A permission error on macOS
 * gets the one hint that fixes it, because the raw `EPERM … mkdir` text does
 * not say where the switch is.
 */
function describeSeedFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  if (process.platform === "darwin" && (code === "EPERM" || code === "EACCES")) {
    return (
      `${message}. The demo is created in the Documents folder. Allow Desde to access ` +
      "Documents in System Settings > Privacy & Security > Files and Folders, then try again."
    )
  }
  return message
}

export async function startLauncher(
  opts: StartLauncherOptions = {},
): Promise<LauncherHandle> {
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 4321
  const shellOrigin = `http://${host}:${port}`
  const security = newSecurityContext(shellOrigin)
  const forwardArgs = opts.forwardArgs ?? []
  // Only the DEFAULT spawn path (real child processes) feeds this — an
  // injected `spawnEditor` (tests) never produces anything that needs
  // tracking, since it returns just `{ url }` with no process behind it.
  const childTracker = createChildTracker()
  // Where a spawned editor's breadcrumb Home comes back to: THIS launcher.
  // Read at spawn time, not closure-creation time, because with `port: 0`
  // the real origin is only known once the socket is bound (below).
  let launcherOrigin = shellOrigin
  // ONE editor per repository, whichever spawn is behind it. Going Home and
  // clicking the same project again must come back to the editor already
  // running, not boot a second dev server in the same directory — on Next
  // that second boot is refused outright by the per-project lock, and the
  // refusal named our own first child. See `running-editors.ts`.
  const spawnEditor = withRunningEditorReuse(
    opts.spawnEditor ??
      ((repoPath: string) =>
        defaultSpawnEditor(repoPath, forwardArgs, childTracker, () => launcherOrigin)),
    { seed: opts.runningEditors },
  )

  const uiBundleRoot = resolvePath(opts.uiBundleRoot ?? resolveUiBundleRoot())
  if (!existsSync(uiBundleRoot)) {
    throw new Error(
      `Editor UI bundle not found at ${uiBundleRoot}. Build it with \`npm run build:ui\` in editor-cli/ first.`,
    )
  }

  let seedInFlight: Promise<void> | null = null
  let seedError: string | null = null
  const seedDemo = (): Promise<void> => {
    if (opts.seedDemo === false) return Promise.resolve()
    if (seedInFlight === null) {
      seedInFlight = seedDemoProject({ fixtureDir: opts.demoFixtureDir }).then(
        () => {
          seedError = null
        },
        (err: unknown) => {
          // Best-effort: a machine that cannot take the demo still gets its
          // project list. But the failure is REPORTED (on the list) and
          // RETRIED (the next request seeds again), because the likeliest
          // cause is one the user can fix without relaunching: on macOS the
          // demo lives in Documents, and the first write there asks for
          // permission. A cached failure would have meant that granting it
          // did nothing until the app was reopened.
          seedError = describeSeedFailure(err)
          seedInFlight = null
          console.error(`[launcher] could not seed the demo project: ${seedError}`)
        },
      )
    }
    return seedInFlight
  }

  const ctx: LauncherContext = {
    security,
    spawnEditor,
    pickFolder: opts.pickFolder ?? defaultPickFolder,
    uiBundleRoot,
    seedDemo,
    demoSeedError: () => seedError,
    // Corrected below from what `listen` actually bound (`port: 0` picks its
    // own), before the server can answer anything.
    listenOrigin: listenOriginFor(host, port),
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, ctx)
    } catch (err) {
      console.error("[launcher] request error:", err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end("internal error")
      }
    }
  })

  /*
    The port actually bound. `port: 0` means "any free one", so this is not
    always the port that was asked for.

    Correcting `listenOrigin` alone is not enough, and used to be all that
    happened here. Two other things are derived from the REQUESTED port above:
    the returned `url`, and `security.shellOrigin` — which is what every
    `originPolicy: "required"` route compares the request's `Origin` header
    against (see `route`, below). Left stale, `startLauncher({ port: 0 })`
    returns `http://127.0.0.1:0` AND 403s every legitimate POST forever,
    because the expected origin can never match the port it really bound.

    That was unreachable while every caller pre-picked a concrete port, but the
    comment on `listenOrigin` already advertised `port: 0` support, and its
    sibling `startHttpServer` now recommends it. A half-applied fix under an
    encouraging comment is worse than no fix.
  */
  let boundPort = port

  const listenOn = (p: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server.once("error", onError)
      server.listen(p, host, () => {
        server.off("error", onError)
        const addr = server.address()
        if (addr && typeof addr === "object") {
          boundPort = addr.port
          ctx.listenOrigin = listenOriginFor(host, addr.port)
        }
        resolve()
      })
    })

  // A busy requested port falls back to an OS-picked free one, the same
  // trade a per-project editor makes in `core.ts` (`pickTwoPorts`). Until
  // now the launcher was the one boot path without it: a terminal `desde`
  // holding 4321 made the desktop app die with EADDRINUSE before its window
  // had a URL to show. The requested port is still tried first so a bookmark
  // survives when only one instance is running; the ready line carries the
  // port that was really bound, which is what every caller reads.
  try {
    await listenOn(port)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "EADDRINUSE" || port === 0) throw err
    console.warn(`[launcher] port ${port} is in use; picking a free one instead`)
    await listenOn(0)
  }

  // Safe to assign after `listen`: nothing reads `security` until a request
  // arrives, and no request can arrive before this point.
  const boundOrigin = `http://${host}:${boundPort}`
  ctx.security.shellOrigin = boundOrigin
  launcherOrigin = boundOrigin

  return {
    url: boundOrigin,
    close: async () => {
      // Concurrent, not sequential — closing the HTTP server and terminating
      // spawned editors are independent teardowns, same as core.ts's own
      // `close()`. `allSettled` (not `all`): neither promise here can
      // reject today, but a future change to either must not turn "one
      // teardown step failed" into "shutdown never finishes."
      await Promise.allSettled([
        new Promise<void>((resolve) => server.close(() => resolve())),
        childTracker.shutdown(),
      ])
    },
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LauncherContext,
): Promise<void> {
  // DNS-rebinding guard — see `host-guard.ts`. Same placement rule as the
  // editor's `routeRequest`: before any dispatch, so it also covers the
  // ungated bootstrap (which carries this launcher's bearer) and the static
  // bundle. The launcher is the higher-value target of the two — its
  // `/api/launcher/projects` lists every repo path the user has ever opened.
  const hostCheck = checkHost(req, ctx.listenOrigin)
  if (!hostCheck.ok) {
    sendJson(res, hostCheck.status, { ok: false, reason: hostCheck.reason })
    return
  }
  const url = new URL(req.url ?? "/", ctx.security.shellOrigin)

  // The Anthropic API key surface, shared with the editor: the launcher's
  // settings gear opens the same dialog, and the hook behind it polls this
  // route on mount. Same auth split as the editor's table (`http-server.ts`):
  // the GET returns a masked hint and takes the lenient origin policy, every
  // write is a secret and stays strict.
  //
  // Missing until 2026-09-02. The request fell through to the static bundle's
  // SPA fallback below, a 200 carrying `index.html`, and the hook's
  // `res.json()` threw "Unexpected token '<'" into the dialog before anything
  // was typed. The credential file is machine-wide, so a key saved here is the
  // key every editor this launcher spawns inherits (`spawnEnvWithInheritedLlmCredentials`).
  if (
    url.pathname === LLM_CREDENTIALS_ROUTE ||
    url.pathname.startsWith(`${LLM_CREDENTIALS_ROUTE}/`)
  ) {
    const auth = checkAuth(req, ctx.security, {
      originPolicy: req.method === "GET" ? "if-present" : "required",
    })
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, reason: auth.reason, error: auth.reason })
      return
    }
    await handleLlmCredentialsRoute(req, res, url, {
      claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
    })
    return
  }

  if (url.pathname.startsWith("/api/launcher/")) {
    const isGet = req.method === "GET"
    const auth = checkAuth(req, ctx.security, {
      originPolicy: isGet ? "if-present" : "required",
    })
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, reason: auth.reason })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/launcher/projects") {
      // First-run seeding of the demo, before the read, so the first list
      // this machine ever sees already has the demo in it. A no-op forever
      // after; see `demo/seed.ts`.
      await ctx.seedDemo()
      const registry = await readProjectsRegistry()
      // The cached name is reconciled with the repo's identity block on
      // every list, because the block changes outside this process: a pull
      // renames the project, a checkout of an older branch removes the
      // block, an entry predates the registry carrying a name at all. The
      // list is the one place every entry passes through, and a handful of
      // small JSON reads is cheaper than a name that is wrong forever. A
      // folder that is gone is left alone: there is nothing to reconcile
      // against, and its stale row is the delete action's job. Best-effort
      // per entry: a patch that cannot be written still shows the right
      // name this time. A config that cannot be read keeps the cached name:
      // nothing is known, and clearing would be a claim.
      for (const entry of registry.projects) {
        if (!(await isDirectory(entry.path))) continue
        const read = await readProjectIdentityName(entry.path)
        if (!read.readable) continue
        const name = read.name ?? undefined
        if (name === entry.name) continue
        entry.name = name
        try {
          await patchProjectRegistryEntry(entry.path, { name })
        } catch {
          // Shown right this time; the next list retries the write.
        }
      }
      const demoSeedError = ctx.demoSeedError()
      sendJson(res, 200, {
        ok: true,
        projects: registry.projects,
        ...(demoSeedError ? { demoSeedError } : {}),
      })
      return
    }

    // Forget a project: drop it from the recents list.
    //
    // It removes NOTHING the user owns. The registry is a cache, the repo's
    // own `.desde/config.json` is the source of truth, and opening the
    // folder again re-creates the entry. The confirm dialog in the launcher
    // says so; this comment is here so a future endpoint that really does
    // delete files is written as a NEW route rather than by widening this one.
    //
    // The path is NOT required to exist on disk. A folder that has been moved
    // or deleted outside the app leaves a dead row, and that row is exactly
    // the one a user most wants to clear — an `isDirectory` guard here (which
    // the sibling routes do have, because they write INTO the directory) would
    // refuse the case this exists for.
    if (req.method === "POST" && url.pathname === "/api/launcher/projects/remove") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        const removed = await removeProjectRegistryEntry(abs)
        const registry = await readProjectsRegistry()
        // The refreshed list rides back on the response so the client does not
        // have to follow up with a GET it would then have to reconcile.
        sendJson(res, 200, { ok: true, removed, projects: registry.projects })
      })
      return
    }

    // ── The bundled demo ──────────────────────────────────────────────────
    //
    // GET reports whether it is on disk and what would be lost by deleting it,
    // so the confirmation can name real numbers rather than warn generically.
    // POST materializes on demand and is idempotent, so a second click opens
    // what is there. DELETE reads NO body: the path is resolved server-side and
    // is the only one this can ever remove (see demo/remove.ts).
    //
    // Materializing is lazy on purpose. Someone who arrives with their own repo
    // should never pay for a demo they will not open.
    if (req.method === "GET" && url.pathname === "/api/launcher/demo") {
      await runHandler(res, async () => {
        const [changes, state] = await Promise.all([classifyDemoChanges(), readDemoState()])
        // `path` rides along so the launcher can tell the demo's row apart from
        // an ordinary recents entry and route its delete to the real removal
        // rather than to remove-from-recents.
        sendJson(res, 200, {
          ok: true,
          ...changes,
          path: demoRepoPath(),
          triedAt: state.triedAt ?? null,
        })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/demo") {
      await runHandler(res, async () => {
        const result = await materializeDemo()
        sendJson(res, 200, { ok: true, path: result.path, created: result.created })
      })
      return
    }

    if (req.method === "DELETE" && url.pathname === "/api/launcher/demo") {
      await runHandler(res, async () => {
        const result = await removeDemo()
        sendJson(res, 200, { ok: true, ...result })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/pick-folder") {
      await runHandler(res, async () => {
        // Pops the OS-native folder chooser on the machine running the
        // CLI and returns the picked absolute path — the browser can't
        // provide real paths, the local Node process can.
        //
        // `purpose` only selects between two fixed prompt strings; an
        // unrecognized value falls back to "project" rather than erroring,
        // because the wording of a dialog is not worth failing a request over.
        const body = await readJsonBody<{ purpose?: unknown }>(req).catch(() => ({}))
        const purpose: FolderPickPurpose =
          (body as { purpose?: unknown }).purpose === "reference" ? "reference" : "project"
        const result = await ctx.pickFolder(purpose)
        sendJson(res, 200, { ok: true, ...result })
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/launcher/github/repos") {
      await runHandler(res, async () => {
        // Reads the developer's own `gh` login. The Editor holds no GitHub
        // credential of its own, and this route does not create one.
        const result = await listGitHubRepos()
        sendJson(res, 200, { ok: true, ...result })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/open") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        if (await sendOpenBlockIfAny(res, abs)) return
        const spawned = await spawnOrExplain(res, ctx, abs)
        if (!spawned) return
        sendJson(res, 200, { ok: true, url: spawned.url })
      })
      return
    }

    // The same question the Open route asks, asked EARLY: the New Project
    // dialog resolves a path (pick / clone / type), then walks the user through
    // naming and design systems — both of which WRITE to the repo — before it
    // ever calls `open`. Refusing at the end of that would mean minting
    // `.desde/config.json` and `designSystems` declarations for a project
    // we then decline to open. Read-only and idempotent; `open` keeps its own
    // check, since the recents grid never comes through here.
    if (req.method === "POST" && url.pathname === "/api/launcher/inspect") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        // 200 either way: "this project cannot be opened" is a successful
        // answer to "can this project be opened", and a caller that has to
        // distinguish a refusal from a transport failure needs the two shapes
        // separated.
        sendJson(res, 200, { ok: true, blocked: (await checkLauncherOpen(abs)) ?? null })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/project-name") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown; name?: unknown; rename?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "name is required" })
          return
        }
        const renameIntent = body.rename === true
        if (body.name.length > 200) {
          sendJson(res, 400, { ok: false, reason: "name must be 200 characters or fewer" })
          return
        }
        // Same canonicalisation the open/clone routes use -- deliberately not
        // a second path-validation rule, so there is one answer to "is this a
        // real directory" across the whole launcher API.
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        // Writes `.desde/config.json` -- the ONLY place identity is
        // minted, and only ever from this explicit user action.
        //
        // Two callers share this route, and they differ in INTENT, which is
        // why `rename` is an explicit flag rather than inferred from a name
        // mismatch. The create flow names a repo, with the folder name
        // prefilled; on a clone that already carries a committed identity
        // the minter is idempotent BY DESIGN and hands that identity back
        // untouched, so a teammate's name is never overwritten by a wizard
        // default. The Settings page sends `rename: true`, and only then
        // does the explicit rename run: that case used to fall through to
        // the minter and was a silent no-op (Save reported success and the
        // name never changed).
        try {
          const requested = body.name.trim()
          // The rename writer is reached DIRECTLY on intent, not after the
          // minter: the minter would first mint (and persist) a fresh id
          // over a malformed block or an unsupported schema, and then the
          // rename, seeing its own name come back, would have nothing to do.
          const identity = renameIntent
            ? await renameProjectIdentity(abs, requested)
            : await ensureProjectIdentity(abs, { name: requested })
          // Keep the recents card in step without waiting for the next boot.
          // Patched in place: a rename is not an open, so the card keeps its
          // position and its "Opened …" time. Only an EXISTING entry is
          // touched: the create flow names the project before opening it,
          // and the card should appear when the editor boots, not when the
          // name is typed. Best-effort: the config is the truth and has
          // already changed, so a cache that cannot be written must not turn
          // a completed rename into a reported failure.
          try {
            await patchProjectRegistryEntry(abs, { name: identity.name, slug: identity.slug })
          } catch (err) {
            console.error(
              `[launcher] project renamed, but the recents list could not be updated: ${(err as Error).message}`,
            )
          }
          sendJson(res, 200, { ok: true, identity })
        } catch (err) {
          sendJson(res, 400, { ok: false, reason: (err as Error).message })
        }
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/clone") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ repoUrl?: unknown; dest?: unknown; open?: unknown }>(req)
        if (typeof body.repoUrl !== "string" || body.repoUrl.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "repoUrl is required" })
          return
        }
        const dest =
          typeof body.dest === "string" && body.dest.trim().length > 0
            ? body.dest.trim()
            : undefined
        const repoUrl = body.repoUrl.trim()
        let cloned: { dest: string }
        try {
          // The launcher clones with the user's OWN git credentials only —
          // there is no brokered-GitHub-token flow to fall back to today.
          // The CLI-side Firebase auth chain (which used to capture a
          // browser ID token for this) was deleted 2026-08-08 as dead
          // code end to end — see tasks/todo.md. A brokered flow for
          // private-repo cloning that the user's local creds can't reach
          // is proposed in tasks/github-service-token-endpoint.md, not built.
          cloned = await cloneRepo({ repoUrl, dest })
        } catch (err) {
          sendJson(res, 400, { ok: false, reason: (err as Error).message })
          return
        }
        // `open: false` — the New Project dialog's design-system step wants
        // the cloned path WITHOUT an editor spawned on it yet, so it can
        // write `designSystems` declarations the boot reconciliation will
        // pick up; spawning first would boot before the declarations exist.
        // Defaults to true (spawn immediately) — unchanged prior behavior.
        if (body.open === false) {
          sendJson(res, 200, { ok: true, dest: cloned.dest })
          return
        }
        // Same gate as `open`. A clone that lands an unbootable repo is the
        // same refusal one step later, and it must not arrive as an exit code.
        // `dest` is reported alongside, because the checkout DID happen and
        // the user needs to know where it is.
        const blocked = await checkLauncherOpen(cloned.dest)
        if (blocked) {
          sendJson(res, 400, { ok: false, reason: blocked.summary, blocked, dest: cloned.dest })
          return
        }
        // Same boot-failure relay as `open`. `dest` rides along either way —
        // the checkout DID happen and the user needs to know where it is.
        const spawned = await spawnOrExplain(res, ctx, cloned.dest, { dest: cloned.dest })
        if (!spawned) return
        sendJson(res, 200, { ok: true, url: spawned.url, dest: cloned.dest })
      })
      return
    }

    /*
     * ─── Project settings ────────────────────────────────────────────
     *
     * The read half of the settings page. Everything else the launcher
     * exposes is a mutation or a one-shot inspect; a page that EDITS a
     * project has to be able to show what is there first, for a project the
     * CLI has not booted and whose `repoRoot`-scoped routes therefore do not
     * apply.
     *
     * One route rather than three, because the page opens all of it at once
     * and three round-trips would render the sections at three different
     * moments.
     *
     * Config problems are reported, never thrown. A malformed `designSystems`
     * block must not blank the reference folders beside it — the page's whole
     * job in that state is to let someone fix the broken half.
     */
    if (req.method === "POST" && url.pathname === "/api/launcher/project-settings") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }

        const [ds, roots] = await Promise.all([
          loadDesignSystemDeclarations(abs),
          loadReadRootDeclarations(abs),
        ])
        const warnings: string[] = []
        if (!ds.ok) warnings.push(...ds.errors)
        if (!roots.ok) warnings.push(...roots.errors)

        // The repo's own identity block is where a project's chosen name
        // lives (the recents registry is only a cache of it); the folder
        // basename is the fallback the launcher list shows for a repo that
        // has no identity yet, and for one whose config cannot be read.
        const identityName = await readProjectIdentityName(abs)
        sendJson(res, 200, {
          ok: true,
          path: abs,
          name: identityName.readable ? (identityName.name ?? basename(abs)) : basename(abs),
          designSystems: ds.ok
            ? ds.declarations.map((d) => ({
                identity: declarationIdentity(d.source),
                declaration: d,
              }))
            : [],
          readRoots: roots.ok ? roots.declarations : [],
          warnings,
        })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/design-systems/remove") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown; identity?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        if (typeof body.identity !== "string" || body.identity.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "identity is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        const result = await removeDesignSystemDeclaration(abs, body.identity.trim())
        if (!result.ok) {
          sendJson(res, 400, { ok: false, reason: result.reason })
          return
        }
        sendJson(res, 200, { ok: true, removed: body.identity.trim() })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/read-roots/remove") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown; name?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "name is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        const result = await removeReadRoot(abs, body.name.trim())
        if (!result.ok) {
          sendJson(res, 400, { ok: false, reason: result.reason })
          return
        }
        sendJson(res, 200, { ok: true, removed: body.name.trim() })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/design-systems/suggest") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        // Read-only filesystem scan (package.json + node_modules/*.vue.d.ts)
        // — no git/npm/network, safe to run before a project is ever opened.
        const suggestions = await suggestDesignSystems(abs)
        sendJson(res, 200, { ok: true, suggestions })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/design-systems/declare") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown; declarations?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        if (!Array.isArray(body.declarations)) {
          sendJson(res, 400, { ok: false, reason: "declarations must be an array" })
          return
        }
        // Validate every entry BEFORE writing anything — the caller treats
        // the pending list as one unit (a chip list the user built up in
        // the dialog), so either the whole batch lands in the config or
        // none of it does; a partial write on entry 3 of 5 would silently
        // strand the user mid-batch with no way to tell which stuck.
        const validated: DesignSystemDeclaration[] = []
        for (const entry of body.declarations) {
          const result = validateDeclaration(entry)
          if (!result.ok) {
            sendJson(res, 400, { ok: false, reason: result.error })
            return
          }
          validated.push(result.declaration)
        }
        const appended: DesignSystemDeclaration[] = []
        const skipped: Array<{ declaration: DesignSystemDeclaration; reason: string }> = []
        for (const decl of validated) {
          const result = await appendDesignSystemDeclaration(abs, decl)
          if (result.ok) {
            appended.push(decl)
          } else {
            skipped.push({ declaration: decl, reason: result.reason })
          }
        }
        sendJson(res, 200, { ok: true, appended, skipped })
      })
      return
    }

    // ─── Reference directories (readRoots) ──────────────────────────
    //
    // Two routes, mirroring the design-systems pair above: a read-only
    // inspect that tells the wizard whether a picked folder is usable, and a
    // batch declare that writes the config.
    //
    // Inspect exists because the alternative is finding out at the NEXT boot.
    // A malformed readRoots block aborts CLI start, so a wizard that wrote
    // whatever it was given could hand the user a project that no longer
    // opens — the exact failure the design-systems route was careful to avoid.
    if (req.method === "POST" && url.pathname === "/api/launcher/read-roots/inspect") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{
          path?: unknown
          taken?: unknown
          projectPath?: unknown
        }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        // Relative input resolves against the SELECTED PROJECT, not the
        // launcher process's working directory. `../production` typed into the
        // wizard means "beside my project", and resolving it against wherever
        // the launcher happened to be started either rejects a valid folder or
        // silently normalizes a different one.
        const inspectBase =
          typeof body.projectPath === "string" && body.projectPath.trim().length > 0
            ? resolvePath(body.projectPath.trim())
            : process.cwd()
        const abs = resolvePath(inspectBase, body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        // Refuse a folder the LOADER would treat as a fatal config error, so
        // the user learns now rather than at the next boot. The commonest is
        // picking the project's own folder, which passes every shape rule,
        // writes cleanly, and then makes the project refuse to open.
        if (typeof body.projectPath === "string" && body.projectPath.trim().length > 0) {
          const usable = await checkReadRootPath(resolvePath(body.projectPath.trim()), abs)
          if (!usable.ok) {
            sendJson(res, 400, { ok: false, reason: usable.reason })
            return
          }
        }
        const taken = Array.isArray(body.taken)
          ? body.taken.filter((n): n is string => typeof n === "string")
          : []
        sendJson(res, 200, {
          ok: true,
          path: abs,
          suggestedName: suggestReadRootName(basename(abs), taken),
          // Not a gate — the wizard shows it so the user knows the history
          // tools will not apply to this one.
          isGit: await isGitRepository(abs),
        })
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/launcher/read-roots/declare") {
      await runHandler(res, async () => {
        const body = await readJsonBody<{ path?: unknown; declarations?: unknown }>(req)
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          sendJson(res, 400, { ok: false, reason: "path is required" })
          return
        }
        const abs = resolvePath(body.path.trim())
        if (!(await isDirectory(abs))) {
          sendJson(res, 400, { ok: false, reason: DIRECTORY_NOT_FOUND })
          return
        }
        if (!Array.isArray(body.declarations)) {
          sendJson(res, 400, { ok: false, reason: "declarations must be an array" })
          return
        }
        // Same two-tier contract as design-systems/declare: a malformed entry
        // anywhere 400s the whole batch before any write, while a well-formed
        // entry that collides on name is reported as skipped, not as failure.
        const validated: ReadRootDeclaration[] = []
        for (const entry of body.declarations) {
          const result = validateReadRootDeclaration(entry)
          if (!result.ok) {
            sendJson(res, 400, { ok: false, reason: result.error })
            return
          }
          validated.push(result.declaration)
        }
        // A batch that names the same root twice would land the first and
        // "skip" the second as a duplicate, which reads as a mysterious
        // partial success. Catch it here, before anything is written.
        const seen = new Set<string>()
        for (const decl of validated) {
          if (seen.has(decl.name)) {
            sendJson(res, 400, {
              ok: false,
              reason: `duplicate name "${decl.name}" in this batch`,
            })
            return
          }
          seen.add(decl.name)
        }

        // Filesystem validation, batch-atomic like the shape check above.
        // `validateReadRootDeclaration` cannot do this (it is pure), and the
        // loader's verdict on these cases is FATAL, so a write that skipped it
        // could leave the project unopenable.
        for (const decl of validated) {
          const usable = await checkReadRootPath(abs, decl.path)
          if (!usable.ok) {
            sendJson(res, 400, { ok: false, reason: `"${decl.name}": ${usable.reason}` })
            return
          }
        }

        // Name collisions are checked against the file BEFORE anything is
        // written, so this batch is all-or-nothing like its validation.
        //
        // Reporting a collision as `skipped` alongside a partial write (what
        // the design-systems route does) is wrong here: the client treats a
        // skip as a failure and keeps every chip, so the obvious
        // rename-and-retry then collided with the entry the first attempt had
        // already persisted. The user had to hand-remove chips to make
        // progress.
        const existing = await loadReadRootDeclarations(abs)
        // A malformed existing block is fatal, not "assume empty". `appendReadRoot`
        // preserves entries it cannot parse, so writing on top of one would report
        // success and then have the next boot rejected by `loadReadRoots`.
        if (!existing.ok) {
          sendJson(res, 400, {
            ok: false,
            reason: `the project's existing readRoots block is invalid, fix it first: ${existing.errors.join("; ")}`,
          })
          return
        }
        const takenNames = new Set(existing.declarations.map((d) => d.name))
        const collisions = validated.filter((d) => takenNames.has(d.name))
        if (collisions.length > 0) {
          sendJson(res, 400, {
            ok: false,
            reason: `this project already has a reference folder named ${collisions
              .map((d) => `"${d.name}"`)
              .join(", ")}`,
            collisions: collisions.map((d) => d.name),
          })
          return
        }

        const appended: ReadRootDeclaration[] = []
        const skipped: Array<{ declaration: ReadRootDeclaration; reason: string }> = []
        for (const decl of validated) {
          const result = await appendReadRoot(abs, decl)
          if (result.ok) {
            appended.push(decl)
          } else {
            skipped.push({ declaration: decl, reason: result.reason })
          }
        }
        sendJson(res, 200, { ok: true, appended, skipped })
      })
      return
    }

    sendJson(res, 404, { ok: false, reason: "Unknown launcher endpoint" })
    return
  }

  // Any other `/api/*` path is a JSON 404, never the SPA fallback. A JSON
  // client that gets `index.html` with a 200 fails one step later with a
  // parse error that names no route, which is how the credentials route above
  // stayed missing unnoticed. A 404 names the problem at the request.
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { ok: false, reason: "Unknown endpoint", error: "Not found." })
    return
  }

  // Launcher bootstrap — NOT auth-gated (it's what delivers the token to
  // the page). CORP + nosniff + no-store headers protect against
  // cross-origin disclosure, same model as the editor's bootstrap, plus the
  // `Sec-Fetch-Site` refusal below (rebinding is covered by `checkHost`
  // above, which is a different attack — see `host-guard.ts`).
  if (req.method === "GET" && url.pathname === BOOTSTRAP_PATH) {
    if (isCrossSiteFetch(req)) {
      sendJson(res, 403, { ok: false, reason: "Cross-site request refused" })
      return
    }
    const payload = JSON.stringify({
      token: ctx.security.token,
      shellOrigin: ctx.security.shellOrigin,
      folderPicker: { supported: folderPickerSupported() },
    })
    serveBootstrapJs(res, `window.__DESDE_LAUNCHER__=${payload};\n`)
    return
  }

  // Static UI bundle serving (the launcher page) — not auth-gated.
  if (req.method === "GET") {
    await serveStatic(req, res, {
      uiBundleRoot: ctx.uiBundleRoot,
      shellOrigin: ctx.security.shellOrigin,
    })
    return
  }

  res.statusCode = 405
  res.end("method not allowed")
}

/** Default: re-invoke this CLI on a free port and wait for the ready line. */
async function defaultSpawnEditor(
  repoPath: string,
  forwardArgs: string[] = [],
  childTracker?: ChildTracker,
  homeUrl?: () => string,
): Promise<SpawnedEditor> {
  const port = await pickFreePort()
  // Checked here — immediately before `spawn()`, with no `await` between
  // this check and the `spawn()` + `childTracker.track()` pair below — not
  // earlier in this function. `pickFreePort()` above is exactly the kind of
  // in-flight await the launcher can close during: if `shutdown()` were
  // checked for BEFORE it, a shutdown that starts during `pickFreePort()`
  // would sail past this guard and still spawn. Placed here, and combined
  // with `shutdown()` setting its closing state as its own first
  // (synchronous) statement, Node's run-to-completion semantics make this
  // check race-free: either `shutdown()` has not been called yet (and
  // cannot start until this synchronous stretch yields), or it has, and we
  // refuse before ever spawning. `track()`'s own immediate-kill behavior
  // once closing (see child-tracker.ts) remains the backstop for spawn
  // paths that skip this check (e.g. a future caller with no tracker
  // reference) — this check exists to avoid the user-visible "born and
  // killed" case, not to be the only thing preventing a leak.
  if (childTracker?.isClosing()) {
    throw new Error("Editor launcher is shutting down; refusing to start a new project.")
  }
  // Re-run this same entrypoint in boot mode. Preserve the parent's node
  // flags (`process.execArgv`) so a tsx-loaded dev run (`--import tsx …`)
  // passes the loader to the child — otherwise `node src/cli.ts` can't
  // resolve the TS imports and every Open/Clone fails before boot. In the
  // packaged bin-shim path execArgv already carries the loader too.
  const cliEntry = process.argv[1]
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      cliEntry,
      repoPath,
      "--shell-port",
      String(port),
      "--no-open",
      ...forwardArgs,
    ],
    // Explicit cwd: this process may have chdir'd into a prototype's Vite
    // root (core.ts), and a child inheriting that would resolve a relative
    // repoPath against the wrong repo.
    //
    // stderr is PIPED, not inherited. Inheriting sent the child's failure
    // straight to a terminal a launcher user never looks at, leaving the
    // parent with nothing but an exit code to report — see
    // `editor-boot-failure.ts`. It is tee'd below so the terminal keeps
    // showing exactly what it always did.
    // `env`: roll the LLM credential variables back to what THIS process
    // inherited. Without it the child treats our own injection as a
    // shell-exported key and disables the controls that manage it. The child
    // reads the credential store and re-injects for itself.
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      cwd: launchCwd(),
      // `DESDE_HOME_URL`: the spawned editor answers its breadcrumb Home
      // with this launcher instead of starting a second one (home-url.ts).
      env: { ...spawnEnvWithInheritedLlmCredentials(), ...homeUrlEnv(homeUrl?.()) },
    },
  )
  // Track immediately at spawn time, independent of whether boot ever
  // reaches "ready" below — a child that fails to boot still needs to be
  // (and via its own `exit`, already will be) accounted for, and a child
  // that DOES boot keeps running long after this function's promise settles.
  childTracker?.track(child)
  // The liveness signal the one-editor-per-repo memory keys off. Registered
  // before the ready wait so an exit at any point — pre-ready or hours later —
  // is seen; `exit` fires exactly once per child, so `once` is enough.
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done())
  })
  return new Promise<SpawnedEditor>((resolve, reject) => {
    let settled = false
    const readReady = createReadyLineReader()
    const stderrTail = createStderrTail()
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      stderrTail.append(text)
      // Tee: `inherit` used to do this, and a launcher run in a terminal should
      // not go quiet just because the parent now reads the stream.
      process.stderr.write(text)
    })
    const onData = (chunk: Buffer) => {
      const url = readReady(chunk.toString())
      if (url && !settled) {
        settled = true
        child.stdout?.off("data", onData)
        // Keep DRAINING after we stop reading. A piped stdout with no reader
        // fills its buffer and then blocks the child on its next `write` —
        // a healthy editor that logs enough would freeze mid-session, which
        // looks nothing like a logging problem from the outside.
        child.stdout?.resume()
        resolve({ url, exited })
      }
    }
    child.stdout?.on("data", onData)
    child.once("error", (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.once("exit", (code) => {
      if (!settled) {
        settled = true
        // Carries the child's own words when it had any. `EditorBootFailure`'s
        // message is byte-identical to what this used to reject with, so the
        // silent-death path is unchanged.
        reject(new EditorBootFailure(code, stderrTail.text()))
      }
    })
  })
}

/**
 * Answer the request with the structured refusal if this repo has one, and say
 * whether it did.
 *
 * Sends `reason` as well as `blocked`: `reason` is the one-line summary every
 * existing caller already reads, so an older client degrades to the sentence it
 * would have shown anyway instead of to an empty string.
 */
/**
 * Spawn an editor, or answer the request with why it could not start.
 *
 * Returns `null` once the response has been sent, so the caller stops.
 *
 * The split is the whole point and it is decided by ONE thing — did the child
 * say anything on the way out:
 *
 *  - It did → 400 with the structured block, `cause` being the child's words
 *    verbatim. This is the reachable case (dependencies declared, never
 *    installed) and it was reaching the user as `code 4`.
 *  - It did not, or the failure is not a boot failure at all (spawn `error`,
 *    a bad `cliEntry`) → rethrow, and `runHandler`'s 500 keeps the bare
 *    `editor exited before it was ready (code N)`. Genuinely unexplained, so
 *    it says so rather than inventing a diagnosis.
 */
async function spawnOrExplain(
  res: ServerResponse,
  ctx: LauncherContext,
  repoPath: string,
  extra: Record<string, unknown> = {},
): Promise<{ url: string } | null> {
  try {
    return await ctx.spawnEditor(repoPath)
  } catch (err) {
    if (!(err instanceof EditorBootFailure) || err.detail.length === 0) throw err
    const blocked = bootFailureBlock(err, repoPath, await supportedHostsFor(repoPath))
    sendJson(res, 400, { ok: false, reason: blocked.summary, blocked, ...extra })
    return null
  }
}

async function sendOpenBlockIfAny(res: ServerResponse, repoPath: string): Promise<boolean> {
  const blocked = await checkLauncherOpen(repoPath)
  if (!blocked) return false
  sendJson(res, 400, { ok: false, reason: blocked.summary, blocked })
  return true
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      probe.close(() => resolve(p))
    })
  })
}

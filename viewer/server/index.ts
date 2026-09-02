import next from "next"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { DiskAssetStore } from "./assets/disk-asset-store"
import { seedDomainRulesFromEnv } from "./auth/gate"
import { createLocalOperatorToken, ensureLocalOperatorUser, shouldMintLocalOperatorToken } from "./auth/local-operator"
import { startSessionSweep } from "./auth/session-sweep"
import { loadConfig } from "./config"
import { decideBrowserOpen, openUrl } from "./open-browser"
import { loadRuntimeConfig, updateRuntimeConfig } from "./runtime-config"
import { createApp, type AppDeps } from "./create-app"
import { DEMO_SLUG, seedDemoProject } from "./demo/seed-demo-project"
import { createReloadableEmailProvider } from "./notify/reloadable-email-provider"
import { emailStatusLine } from "./notify/email-status-line"
import { startOutboxDrain } from "./notify/outbox-drain"
import { readBridgeBundle } from "./serve/html-inject"
import { assertNoTestHostRelaxation } from "./serve/host-allowlist"
import { createLoopbackListenerApp } from "./serve/loopback-listener-app"
import { createLoopbackListenerRegistry } from "./serve/loopback-listeners"
import { originModeBannerLines } from "./serve/origin-mode-banner"
import { assertOriginConfig, assertPrototypeOriginConfig } from "./serve/prototype-origin-resolve"
import { SqliteStorage } from "./storage/sqlite-storage"
import { createBuildChangeBus } from "./build/build-change-bus"
import { createGithubRuntime } from "./github-runtime"
import type { StorageAdapter } from "./storage/types"
import type { AssetStore } from "./assets/types"

const viewerRoot = fileURLToPath(new URL("..", import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  // Refuses a config that would put a prototype on the shell's own host,
  // before this process opens a port. See `prototype-origin-resolve.ts`
  // for what it checks and why.
  assertOriginConfig(config)
  // Refuses a VIEWER_PROTOTYPE_ORIGIN that is the shell's own origin, a
  // different scheme, or same-site with the shell — see
  // `prototype-origin-resolve.ts` for why each is unsafe. No-op when unset.
  assertPrototypeOriginConfig(config)
  const dev = process.env.NODE_ENV !== "production"

  // SQLite + disk are the only implementations. The StorageAdapter and
  // AssetStore SEAMS remain — they are what let the suites run against an
  // in-memory impl, and what a future backend would plug into — but there
  // is deliberately no second production impl to keep in sync.
  const storage: StorageAdapter = new SqliteStorage(join(config.dataDir, "viewer.db"))
  const assets: AssetStore = new DiskAssetStore(join(config.dataDir, "assets"))
  const { script: bridgeScript, version: bridgeVersion } = readBridgeBundle()

  // Fix wave 9, item 2: reconcile any deployment a crash or `SIGKILL` left
  // stuck at `"building"`. The graceful-shutdown path (`buildQueue.shutdown()`
  // below) only runs on SIGINT/SIGTERM — a harder kill skips it entirely,
  // and nothing else ever moves a `"building"` row out of that status. Run
  // BEFORE the app serves, so no request can observe a stale `"building"`
  // deployment this boot is about to correct.
  const interrupted = await storage.markInterruptedBuildsFailed()
  if (interrupted > 0) {
    console.log(
      `[viewer] marked ${interrupted} build${interrupted === 1 ? "" : "s"} left "building" by a previous crash/restart as failed`,
    )
  }

  // One-way conversion of `VIEWER_ALLOWED_EMAIL_DOMAINS` into stored domain
  // rules, on the first boot after the upgrade. Awaited before anything is
  // served, so no sign-in can race a half-written rule set.
  //
  // Never fatal, and the failure direction is why. A missing domain rule
  // admits NOBODY, so a viewer that boots without its rules is closed, not
  // open — whereas a viewer that refuses to boot over a rule write is simply
  // down. An admin can add the rule in the product either way. See
  // `seedDomainRulesFromEnv` for the partial-failure caveat.
  try {
    await seedDomainRulesFromEnv(storage, config)
  } catch (error) {
    console.error(
      "[viewer] failed to convert VIEWER_ALLOWED_EMAIL_DOMAINS into domain rules. " +
        "Add them from Settings › Domain rules instead:",
      error,
    )
  }

  // The auth provider, the App client and the build queue, in one holder
  // that can be refilled without restarting the process — see
  // `github-runtime.ts`. Builds require the GitHub App (the runner clones
  // with an installation token), so an unconfigured deployment simply has no
  // queue and the trigger route 503s rather than the process failing to boot.
  const buildChangeBus = createBuildChangeBus()
  const github = createGithubRuntime({
    config,
    storage,
    assets,
    // Every log flush and every status transition emits here, which is what
    // makes the SSE stream live rather than polled.
    onBuildChange: (deploymentId) => buildChangeBus.emit(deploymentId),
  })

  // No GitHub sign-in configured means nobody could otherwise obtain a
  // session, and without a session every write from the dashboard 401s.
  // See `auth/local-operator.ts` for why a printed token is the right trade
  // here and not a security hole, and `shouldMintLocalOperatorToken` for why
  // the allowlist is the second half of the condition.
  const localOperatorToken = shouldMintLocalOperatorToken(config)
    ? createLocalOperatorToken()
    : undefined

  if (config.seedDemoProject) {
    // Never fatal. A demo that fails to seed is a cosmetic loss; a viewer
    // that refuses to boot over one is not.
    try {
      // In local mode the operator is a known user BEFORE they ever sign in —
      // `ensureLocalOperatorUser` is the same upsert the sign-in route
      // performs, keyed on the same identity — so the demo's access list names
      // a real account from the first boot rather than being empty.
      const demoMember = localOperatorToken !== undefined ? await ensureLocalOperatorUser(storage) : null
      const outcome = await seedDemoProject({
        storage,
        assets,
        dataDir: config.dataDir,
        fixtureDir: join(viewerRoot, "fixtures", "demo-react", "dist"),
        ...(demoMember ? { seedMemberUserId: demoMember.id } : {}),
      })
      if (outcome === "seeded") {
        console.log(`[viewer] seeded the demo project → ${config.publicUrl}/p/${DEMO_SLUG}/`)
      }
    } catch (error) {
      console.error("[viewer] failed to seed the demo project:", error)
    }
  }

  // ONE provider for the whole process, built BEFORE the app because both
  // consumers take the same instance: the API routes that send invite and
  // sign-in mail (`AppDeps.email`) and the mention outbox drain below. A
  // second `createSmtpEmailProvider` call would open a second nodemailer
  // transport — a second connection pool against one SMTP server — for no
  // reason at all.
  // Always present, sometimes unconfigured. It answers `isConfigured()`
  // rather than being null, because SMTP can now be set from the settings
  // page while the process runs — a null captured here would stay null for
  // the life of the process. See `reloadable-email-provider.ts`.
  const email = createReloadableEmailProvider(config.email)

  // Per-deployment loopback listeners: each one an `http.Server` on an
  // ephemeral loopback port serving ONE deployment at `/`, so a prototype
  // gets an origin of its own on a laptop without DNS. Nothing opens one at
  // boot — the prototype-origin API opens one on first review and the reaper
  // below closes it again once nobody is looking. See
  // `serve/loopback-listeners.ts`.
  const prototypeListeners = createLoopbackListenerRegistry({
    makeApp: (context) =>
      createLoopbackListenerApp({
        ...context,
        storage,
        assets,
        config,
        bridgeScript,
        bridgeVersion,
        prototypeCsp: config.prototypeCsp,
      }),
  })

  const appDeps: AppDeps = {
    storage,
    assets,
    config,
    bridgeScript,
    bridgeVersion,
    github,
    // The process's ONE listener registry, built above. `AppDeps` requires it
    // so this wiring cannot be forgotten — see its doc comment.
    prototypeListeners,
    buildChangeBus,
    localOperatorToken,
    email,
  }
  // The Host allowlist's test-only relaxation must never reach a real boot.
  // Asserted rather than merely left unset, so that an edit which one day
  // threads a config value into these deps fails here instead of silently
  // widening the allowlist to every loopback name on every port.
  assertNoTestHostRelaxation(appDeps)
  const app = createApp(appDeps)

  const stopOutboxDrain = startOutboxDrain({ storage, email, config })
  // Runs regardless of whether `config.githubAuth` is configured — sessions
  // are a capability of the viewer itself now, not of GitHub sign-in, and
  // the sweep itself is agnostic to how a session started (see
  // session-sweep.ts). Sweeps once at boot, then every 6h.
  const stopSessionSweep = startSessionSweep({ storage })

  // Its own timer rather than a second job on the session sweep's tick: that
  // one runs every 6 hours, which cannot implement a 30-minute idle bound.
  // The timer is unref'd, so it never keeps the process alive on its own.
  const stopListenerReaper = prototypeListeners.startReaper()

  // Next 16's default dev bundler (Turbopack) refuses to start when
  // node_modules resolves through a symlink that points outside its
  // detected project root (e.g. a git worktree sharing another checkout's
  // node_modules): "Symlink [project]/node_modules is invalid, it points
  // out of the filesystem root". A normal `git clone && npm install` never
  // produces that layout, so Turbopack stays the default — VIEWER_DEV_BUNDLER
  // (see server/config.ts) is the escape hatch: set it to "webpack" if you
  // hit that crash (symlinked node_modules is the tell) to force the stable
  // webpack dev bundler instead. Bundler choice only, not a behavior change,
  // and only meaningful in dev — production serves the prebuilt `.next`.
  const nextApp = next(
    dev && config.devBundler === "webpack"
      ? { dev, dir: viewerRoot, webpack: true }
      : { dev, dir: viewerRoot },
  )
  await nextApp.prepare()
  const handle = nextApp.getRequestHandler()
  // Mounted last: the API and /p/* routers claim their paths first.
  app.use((req, res) => {
    void handle(req, res)
  })

  const server = app.listen(config.port, () => {
    console.log(
      `[viewer] profile=${config.profile} bridge=${bridgeVersion} → ${config.publicUrl}`,
    )
    // Which origin mode a prototype gets served from, decided from config
    // alone (no request has happened yet). See `origin-mode-banner.ts` for
    // the exact wording of each mode and why it's a separate, unit-tested
    // function rather than inline console calls here. Fallback is a warning
    // (something is degraded); the other two modes are informational.
    const originBanner = originModeBannerLines(config)
    for (const line of originBanner.lines) {
      if (originBanner.mode === "fallback") console.warn(line)
      else console.log(line)
    }
    console.log(`[viewer] ${emailStatusLine(email)}`)
    if (!config.adminToken) {
      // NOT "write endpoints are disabled" — that stopped being true in
      // Phase 3b-2. `requireWrite` (api/api-router.ts) accepts EITHER the
      // admin bearer OR a `write`-scoped personal access token, so with no
      // admin token configured a signed-in user can still mint a PAT at
      // /settings and use it to create/patch projects and upload
      // deployments. What's actually unavailable is the admin bearer
      // itself: the unscoped, non-revocable escape hatch that reaches
      // every project regardless of membership.
      console.warn(
        "[viewer] VIEWER_ADMIN_TOKEN is unset. The admin bearer is unavailable; " +
          "write endpoints still accept write-scoped personal access tokens (see /settings)",
      )
    }
    const signInUrl = localOperatorToken
      ? `${config.publicUrl}/api/v1/auth/local?token=${localOperatorToken}`
      : null
    if (signInUrl) {
      console.log("")
      console.log("[viewer] No GitHub sign-in configured. Open this URL to sign in:")
      console.log(`[viewer]   ${signInUrl}`)
      console.log("[viewer] This token is regenerated on every restart. Your session survives restarts.")
      console.log("")
    }

    // Open a tab, the way the Editor CLI already does on boot. The URL is
    // still printed above either way: this is a convenience, and every
    // reason it declines leaves the reader exactly where they were.
    const browser = decideBrowserOpen({
      dashboardUrl: config.publicUrl,
      signInUrl,
      lastOpenedForPpid: loadRuntimeConfig(config.dataDir).browserOpenedForPpid,
      currentPpid: process.ppid,
      isInteractive: process.stdout.isTTY === true,
      envValue: process.env.VIEWER_OPEN_BROWSER,
    })
    if (browser.open) {
      // Recorded BEFORE the spawn, and not conditional on it succeeding. The
      // record answers "has this run already tried", so a machine with no
      // opener must not retry on every watch restart for the rest of the run.
      updateRuntimeConfig(config.dataDir, { browserOpenedForPpid: browser.ppid })
      openUrl(browser.url)
    }
    // The "nobody can sign in" warning that used to live here is gone with
    // `shouldMintLocalOperatorToken`'s second conjunct (viewer-membership
    // Task 4): with no GitHub sign-in configured a token is now ALWAYS minted,
    // so the state it warned about — no provider and no printed token — can no
    // longer occur.
  })

  const shutdown = async (): Promise<void> => {
    stopOutboxDrain()
    stopSessionSweep()
    stopListenerReaper()
    // Before the main server: each prototype listener is a separate
    // `http.Server` holding its own port, and nothing else will ever close
    // them. `closeAll` destroys open connections rather than waiting on
    // keep-alive, so this cannot stall the shutdown.
    await prototypeListeners.closeAll()
    // Before closing storage: an in-flight build must be marked `failed`,
    // or it stays `building` forever — a spinner in the UI that can never
    // resolve, since the in-memory lock guarding it died with the process.
    const buildQueue = github.buildQueue
    if (buildQueue) await buildQueue.shutdown()
    server.close()
    await storage.close()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
}

main().catch((error: unknown) => {
  console.error("[viewer] failed to start:", error)
  process.exit(1)
})

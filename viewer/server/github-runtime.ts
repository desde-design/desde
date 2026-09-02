/**
 * The three GitHub-derived singletons, in a box that can be refilled.
 *
 * They were constructed once in `server/index.ts` from the config read at
 * boot, which is correct as long as GitHub credentials only ever arrive
 * through the environment. The App Manifest flow (`api/setup-routes.ts`)
 * breaks that assumption: it receives an App id, private key and client
 * secret from GitHub mid-process. Without this holder, an operator would
 * finish a two-click setup and then be told to restart the server, which
 * defeats the point of the two clicks.
 *
 * Injected overrides survive `reload`. Tests pass fakes in, and a reload
 * triggered by unrelated production code must not silently swap a fake for
 * a real network client mid-suite.
 */

import { createGitHubAuthProvider } from "./auth/github-auth-provider"
import { createBuildQueue, type BuildQueue } from "./build/build-queue"
import { createInProcessBuildRunner } from "./build/in-process-build-runner"
import { createGitHubAppClient } from "./github/github-app-client"
import type { AuthProvider } from "./auth/types"
import type { GitHubAppClient } from "./github/types"
import type { AssetStore } from "./assets/types"
import type { StorageAdapter } from "./storage/types"
import type { ViewerConfig } from "./config"

export interface GithubRuntime {
  /**
   * The config the LAST reload ran with. `deps.config` on `AppDeps` is a
   * boot-time snapshot and goes stale the moment the manifest callback
   * (Task 10) writes new credentials mid-process — so anything gating on
   * GitHub state at request time must read THIS. Boot-stable values (port,
   * publicUrl, dataDir, sessionSecret) stay on `deps.config`; the split is
   * what keeps "which values can change under you" answerable from the type.
   */
  config: ViewerConfig
  authProvider?: AuthProvider
  appClient?: GitHubAppClient
  buildQueue?: BuildQueue
  /**
   * Rebuild every non-overridden client from `config`.
   *
   * The auth provider and the App client are cheap and stateless, so they are
   * simply replaced every time. **The build queue is not**, and the contract
   * for it is specific: a repeat reload whose App credentials are UNCHANGED
   * keeps the existing queue object and every build in flight on it; a reload
   * that changes the App — or drops it — replaces the queue and drains the
   * outgoing one, which FAILS its in-flight builds.
   *
   * That distinction is the whole reason the short-circuit exists.
   * `createBuildQueue` returns a fresh object per call, so without it any
   * reload at all (Task 10 will call one whenever the manifest callback
   * writes credentials) would abort every running build and mark its
   * deployment `failed`. "Rebuild the clients" must not mean "kill the
   * builds" when nothing about the builds changed.
   */
  reload(config: ViewerConfig): void
}

export interface CreateGithubRuntimeArgs {
  config: ViewerConfig
  storage: StorageAdapter
  assets: AssetStore
  onBuildChange: (deploymentId: string) => void
  /** Injected fakes. Each one pins its field permanently, including across `reload`. */
  overrides?: Partial<Pick<GithubRuntime, "authProvider" | "appClient" | "buildQueue">>
}

/**
 * The inputs a build queue is actually built from: `createGitHubAppClient`'s
 * three arguments, which are also `createInProcessBuildRunner`'s. Two configs
 * with the same fingerprint would produce two functionally identical queues,
 * so replacing one with the other buys nothing and costs every in-flight
 * build.
 *
 * Deliberately NOT the whole `githubApp` block: `slug` and `webhookSecret`
 * are in it and neither reaches a build. A reload that only rotates the
 * webhook secret must not kill a running build.
 *
 * `null` means "no App", which never matches itself — going from unconfigured
 * to unconfigured leaves `runtime.buildQueue` undefined either way, and going
 * from configured to unconfigured must drop and drain the queue.
 */
function fingerprintBuildConfig(config: ViewerConfig): string | null {
  const app = config.githubApp
  if (!app) return null
  return JSON.stringify([app.appId, app.privateKeyPem, app.apiBaseUrl ?? null])
}

export function createGithubRuntime(args: CreateGithubRuntimeArgs): GithubRuntime {
  const overrides = args.overrides ?? {}
  /**
   * The fingerprint the CURRENT `runtime.buildQueue` was built from. Starts
   * null so the constructor's own `reload` call always builds rather than
   * short-circuiting against a queue that does not exist yet.
   */
  let buildFingerprint: string | null = null

  const runtime: GithubRuntime = {
    config: args.config,
    reload(config: ViewerConfig): void {
      runtime.config = config

      // --- auth provider -------------------------------------------------
      runtime.authProvider =
        overrides.authProvider ??
        (config.githubAuth
          ? createGitHubAuthProvider({
              clientId: config.githubAuth.clientId,
              clientSecret: config.githubAuth.clientSecret,
              ...(config.githubAuth.authorizeUrl !== undefined
                ? { authorizeBaseUrl: config.githubAuth.authorizeUrl }
                : {}),
              ...(config.githubAuth.tokenUrl !== undefined
                ? { tokenUrl: config.githubAuth.tokenUrl }
                : {}),
              ...(config.githubAuth.apiBaseUrl !== undefined
                ? { apiBaseUrl: config.githubAuth.apiBaseUrl }
                : {}),
            })
          : undefined)

      // --- App client ----------------------------------------------------
      runtime.appClient =
        overrides.appClient ??
        (config.githubApp
          ? createGitHubAppClient({
              appId: config.githubApp.appId,
              privateKeyPem: config.githubApp.privateKeyPem,
              ...(config.githubApp.apiBaseUrl !== undefined
                ? { apiBaseUrl: config.githubApp.apiBaseUrl }
                : {}),
            })
          : undefined)

      // --- build queue ---------------------------------------------------
      // Capture the outgoing queue, swap in the incoming one, THEN drain the
      // outgoing one. That order matters: draining first would leave a window
      // where `runtime.buildQueue` still points at a queue that is already
      // aborting its builds, so a request arriving in that window would start
      // a build on a dying queue. Swapping first means every arriving request
      // reaches the new queue immediately and the drain happens behind them.
      //
      // Draining is not free — `shutdown()` aborts in-flight builds and marks
      // their deployments `failed` — which is why it only happens when the
      // queue is genuinely being REPLACED. See the fingerprint below.
      const previousQueue = runtime.buildQueue
      const previousFingerprint = buildFingerprint
      const appClient = runtime.appClient
      buildFingerprint = fingerprintBuildConfig(config)
      runtime.buildQueue =
        overrides.buildQueue ??
        // Same App as last reload, and a queue already exists for it: keep
        // it. The queue holds the App CLIENT it was built with, which is a
        // different object from `runtime.appClient` after this reload but is
        // credential-identical by construction — the fingerprint is exactly
        // the inputs `createGitHubAppClient` takes — so the kept queue clones
        // and mints tokens the same way the new client would. It differs only
        // in holding its own token/list caches, which is a warm cache, not a
        // divergence.
        (previousQueue !== undefined &&
        buildFingerprint !== null &&
        buildFingerprint === previousFingerprint
          ? previousQueue
          : config.githubApp && appClient
            ? createBuildQueue({
                storage: args.storage,
                assets: args.assets,
                onChange: args.onBuildChange,
                runner: createInProcessBuildRunner({
                  assets: args.assets,
                  githubApp: appClient,
                  ...(config.githubApp.apiBaseUrl !== undefined
                    ? { apiBaseUrl: config.githubApp.apiBaseUrl }
                    : {}),
                }),
              })
            : undefined)
      if (previousQueue && previousQueue !== runtime.buildQueue) {
        // `.catch`, not bare `void`: `BuildQueue` is an interface, so a
        // rejecting `shutdown()` is an impl's prerogative — and an unhandled
        // rejection here would take the whole viewer process down over a
        // queue that is being discarded anyway.
        void previousQueue.shutdown().catch((error: unknown) => {
          console.error("[viewer] error draining the outgoing build queue:", error)
        })
      }
    },
  }

  runtime.reload(args.config)
  return runtime
}

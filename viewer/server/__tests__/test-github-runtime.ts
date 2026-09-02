import type { AssetStore } from "../assets/types"
import { loadConfig, type ViewerConfig } from "../config"
import { createGithubRuntime, type GithubRuntime } from "../github-runtime"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { StorageAdapter } from "../storage/types"
import { tmpViewerDataDir } from "./test-config"

/**
 * Builds the `github` field every `createApp(...)` call now requires.
 *
 * `AppDeps.github` is REQUIRED (see `create-app.ts`), so every app a test
 * constructs has to supply one — including the many that have nothing to do
 * with GitHub. This exists so that is one call rather than a five-line
 * `createGithubRuntime({...})` repeated across ~20 files, and so the default
 * is the state most of those tests actually want: nothing configured, all
 * three clients undefined, which is what `createApiRouter` used to produce
 * for them implicitly.
 *
 * ## Passing `config`
 *
 * Optional, and it matters in exactly two cases:
 *
 * 1. **The route under test reads `deps.github.config`** — today that is
 *    `webhook-routes.ts` and its webhook secret. Pass the SAME config object
 *    the test hands `createApp`, or the runtime and the app will disagree.
 * 2. **The test wants a real client built from config**, e.g. proving that
 *    `VIEWER_GITHUB_APP_*` reaches a real `GitHubAppClient`.
 *
 * Everywhere else the default is deliberate: an unconfigured config, built
 * once for the whole process, so no test pays for `loadConfig`'s disk write
 * per app. Note that this default makes `runtime.config` DIFFER from the
 * `config` such a test passes to `createApp` — harmless while no route the
 * test exercises reads `github.config`, and the reason case 1 above is spelled
 * out rather than left to be discovered.
 *
 * ## Passing `overrides`
 *
 * A fake pinned into the runtime, exactly as production would inject one. A
 * fake `authProvider` is what makes the GitHub sign-in routes answer; a fake
 * `appClient` is what makes the connect-repo routes answer; both now decide
 * per request, so injecting one is the ONLY way a test can turn those routes
 * on — the config no longer registers or unregisters anything.
 */
export interface TestGithubRuntimeArgs {
  config?: ViewerConfig
  storage?: StorageAdapter
  assets?: AssetStore
  onBuildChange?: (deploymentId: string) => void
  overrides?: Parameters<typeof createGithubRuntime>[0]["overrides"]
}

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

/**
 * ONE unconfigured config for the whole process. `loadConfig` creates and
 * writes `$VIEWER_DATA_DIR/config.json`, so a per-call `loadConfig` would put
 * a temp-directory write on the path of every app every test builds. Lazily
 * built so importing this module costs nothing.
 */
let cachedUnconfigured: ViewerConfig | undefined
function unconfiguredConfig(): ViewerConfig {
  cachedUnconfigured ??= loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
  return cachedUnconfigured
}

export function testGithubRuntime(args: TestGithubRuntimeArgs = {}): GithubRuntime {
  return createGithubRuntime({
    config: args.config ?? unconfiguredConfig(),
    storage: args.storage ?? new InMemoryStorage(),
    assets: args.assets ?? nullAssets,
    onBuildChange: args.onBuildChange ?? (() => {}),
    ...(args.overrides ? { overrides: args.overrides } : {}),
  })
}

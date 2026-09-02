/**
 * `github-runtime.ts` — the reloadable holder for the three GitHub-derived
 * singletons (auth provider, App client, build queue).
 *
 * The property under test is not "does it construct clients" — the factories
 * have their own suites. It is that the SET of live clients tracks the config
 * it was last reloaded with, and that an injected fake is never silently
 * replaced by a real network client.
 */
import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { AssetStore } from "./assets/types"
import type { BuildQueue } from "./build/build-queue"
import { loadConfig, type ViewerConfig } from "./config"
import { createGithubRuntime, type CreateGithubRuntimeArgs } from "./github-runtime"
import type { GitHubAppClient } from "./github/types"
import { InMemoryStorage } from "./storage/in-memory-storage"
import { tmpViewerDataDir } from "./__tests__/test-config"

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

/**
 * ONE throwaway key for the whole file. `generateKeyPairSync` at 2048 bits
 * costs tens to hundreds of milliseconds; per-test generation turned a
 * millisecond suite into a slow one for no extra coverage.
 */
const TEST_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey as string

/** A valid App trio plus the client id/secret that make `githubAuth` non-null. */
function configuredGithubEnv(): Partial<NodeJS.ProcessEnv> {
  return {
    VIEWER_GITHUB_CLIENT_ID: "client-id",
    VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    VIEWER_GITHUB_APP_ID: "123",
    VIEWER_GITHUB_APP_SLUG: "test-app",
    VIEWER_GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
  }
}

function baseArgs(config: ViewerConfig): CreateGithubRuntimeArgs {
  return {
    config,
    storage: new InMemoryStorage(),
    assets: nullAssets,
    onBuildChange: () => {},
  }
}

function unconfigured(): ViewerConfig {
  return loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
}

function configured(over: Partial<NodeJS.ProcessEnv> = {}): ViewerConfig {
  return loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), ...configuredGithubEnv(), ...over })
}

/** A `BuildQueue` that records what happens to it, in order. */
function recordingQueue(events: string[], label: string): BuildQueue {
  return {
    async start() {
      return `${label}-dep`
    },
    activeDeploymentFor: () => undefined,
    async shutdown() {
      events.push(`${label}:shutdown`)
    },
  }
}

describe("createGithubRuntime", () => {
  it("has no clients when GitHub is unconfigured", () => {
    const runtime = createGithubRuntime(baseArgs(unconfigured()))
    expect(runtime.appClient).toBeUndefined()
    expect(runtime.authProvider).toBeUndefined()
    expect(runtime.buildQueue).toBeUndefined()
  })

  it("builds all three after reload with a configured config", () => {
    const runtime = createGithubRuntime(baseArgs(unconfigured()))
    runtime.reload(configured())
    expect(runtime.appClient).toBeDefined()
    expect(runtime.authProvider).toBeDefined()
    expect(runtime.buildQueue).toBeDefined()
  })

  it("keeps injected overrides across a reload", () => {
    const fake = {} as GitHubAppClient
    const runtime = createGithubRuntime({
      ...baseArgs(unconfigured()),
      overrides: { appClient: fake },
    })
    runtime.reload(configured())
    expect(runtime.appClient).toBe(fake)
  })

  it("exposes the config the last reload ran with, not the boot one", () => {
    const boot = unconfigured()
    const runtime = createGithubRuntime(baseArgs(boot))
    expect(runtime.config).toBe(boot)
    const next = configured()
    runtime.reload(next)
    expect(runtime.config).toBe(next)
    expect(runtime.config.githubApp?.slug).toBe("test-app")
  })

  it("drops every client again when reloaded back to an unconfigured config", () => {
    const runtime = createGithubRuntime(baseArgs(configured()))
    expect(runtime.appClient).toBeDefined()
    runtime.reload(unconfigured())
    expect(runtime.appClient).toBeUndefined()
    expect(runtime.authProvider).toBeUndefined()
    expect(runtime.buildQueue).toBeUndefined()
  })

  /**
   * THE contract Task 10 depends on. `createBuildQueue` returns a fresh
   * object per call, so a reload that rebuilds unconditionally would abort
   * every in-flight build and mark its deployment `failed` — every time the
   * manifest callback fires, for a config change that has nothing to do with
   * builds.
   */
  it("keeps the same queue across a reload whose App credentials are unchanged", () => {
    const runtime = createGithubRuntime(baseArgs(configured()))
    const first = runtime.buildQueue
    expect(first).toBeDefined()
    // A DIFFERENT config object carrying the SAME App — which is what a
    // reload after any unrelated config write looks like.
    runtime.reload(configured())
    expect(runtime.buildQueue).toBe(first)
  })

  it("keeps the queue when only a build-irrelevant field changes", () => {
    const runtime = createGithubRuntime(baseArgs(configured()))
    const first = runtime.buildQueue
    // The webhook secret reaches `webhook-routes.ts`, never a build. Rotating
    // it must not kill a running build.
    runtime.reload(configured({ VIEWER_GITHUB_APP_WEBHOOK_SECRET: "rotated" }))
    expect(runtime.buildQueue).toBe(first)
    expect(runtime.config.githubApp?.webhookSecret).toBe("rotated")
  })

  it("replaces AND drains the queue when the App id changes", async () => {
    const events: string[] = []
    const runtime = createGithubRuntime(baseArgs(configured()))
    const first = runtime.buildQueue!
    // Stand in for the real queue so the drain is observable — the object
    // identity is what the runtime tracks, and this one occupies the same
    // slot the config-built queue did.
    runtime.buildQueue = recordingQueue(events, "first")
    const planted = runtime.buildQueue
    expect(planted).not.toBe(first)

    runtime.reload(configured({ VIEWER_GITHUB_APP_ID: "456" }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(runtime.buildQueue).not.toBe(planted)
    expect(runtime.buildQueue).toBeDefined()
    expect(events).toEqual(["first:shutdown"])
  })

  it("swaps the new queue in BEFORE draining the old one", async () => {
    const events: string[] = []
    const runtime = createGithubRuntime(baseArgs(unconfigured()))
    // Planted rather than passed as an override: an override would pin the
    // field forever, and this test is about what happens when it is replaced.
    const first: BuildQueue = {
      async start() {
        return "dep-1"
      },
      activeDeploymentFor: () => undefined,
      async shutdown() {
        // Recorded at the moment of the drain: a request arriving now must
        // already reach the NEW queue, or it would start a build on a queue
        // that is aborting.
        events.push(runtime.buildQueue === first ? "drained-before-swap" : "drained-after-swap")
      },
    }
    runtime.buildQueue = first

    runtime.reload(configured())
    // `reload` is synchronous by contract (routes are built from it), so it
    // fires the drain without awaiting — hence the macrotask hop here.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(["drained-after-swap"])
    expect(runtime.buildQueue).not.toBe(first)
  })

  it("survives a rejecting shutdown on the outgoing queue", async () => {
    const runtime = createGithubRuntime(baseArgs(unconfigured()))
    runtime.buildQueue = {
      async start() {
        return "dep-1"
      },
      activeDeploymentFor: () => undefined,
      async shutdown() {
        // `BuildQueue` is an interface — an impl may reject, and an unhandled
        // rejection here would take the process down over a queue that is
        // being discarded anyway.
        throw new Error("simulated shutdown failure")
      },
    }
    expect(() => runtime.reload(configured())).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.buildQueue).toBeDefined()
  })

  it("never drains an overridden queue, and the same object survives a reload", async () => {
    const events: string[] = []
    const fake = recordingQueue(events, "fake")
    const runtime = createGithubRuntime({
      ...baseArgs(unconfigured()),
      overrides: { buildQueue: fake },
    })
    runtime.reload(configured())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.buildQueue).toBe(fake)
    expect(events).toEqual([])
  })
})

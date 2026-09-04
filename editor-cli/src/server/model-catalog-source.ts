/**
 * Which model lists the chat picker gets, and where each comes from.
 *
 * One entry per SERVABLE provider descriptor (`chatRuntimeServable` below),
 * each resolved independently and merged into the response together. Per
 * provider, three answers are tried in this order (Mo, 2026-09-02, said of
 * Anthropic originally: "add the live functionality and have the hard coded
 * as a back up ... the live list should also work in dev mode, using the
 * CLI" — the same order now applies to every provider that has a live
 * source):
 *
 *  - `api`: the provider's API key is active (in the process env, which is
 *    where `apply-llm-credentials.ts` puts a stored key too). The
 *    descriptor's `listLiveModels` lists what that key can use.
 *  - `cli`: Anthropic only, and only when no key is active but dev mode /
 *    `EDITOR_USE_CLAUDE_SUBSCRIPTION` is on. The bundled `claude` binary is
 *    asked, through the Agent SDK's `supportedModels()` control request,
 *    what it offers on the account it is signed into. That is the only
 *    source that can see a subscription, and only Anthropic has one.
 *  - `static`: neither, the descriptor has no live source, or a live source
 *    failed or timed out. The provider's own hand-kept static catalog.
 *
 * A live list is merged over the static one (`live-model-catalog.ts`), so a
 * model a vendor ships appears here without a code change, and a model the
 * static file still names but the account cannot use does not.
 *
 * A provider whose chat runtime cannot dispatch today is filtered out
 * entirely before any of this runs (`chatRuntimeServable`). It reads the
 * environment only, same as the dispatch half in `chat-runtime-dispatch.ts`
 * (see the comment there for why) — see `chatRuntimeServable`'s own doc
 * comment for why that is the client half of a both-ends gate.
 *
 * Cached in-process, keyed on every served provider's credential state, for
 * ten minutes on success and one minute after a fall-back, so a transient
 * failure does not pin the static list for the rest of the session. One
 * fetch at a time: the picker mounts and the chat handler validates against
 * the same list, and both may ask before the first answer lands. Both
 * consumers read through `modelCatalogResolver`, which is what keeps a
 * live-only model that the picker offered from being refused by the chat
 * handler a second later.
 */

import { tmpdir } from "node:os"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderModelCatalog } from "../../../src/editor/core/model-catalog.js"
import { EFFORT_LEVELS } from "../../../src/editor/core/model-catalog.js"
import { ANTHROPIC_MODEL_CATALOG } from "../../../src/editor/llm-providers/anthropic-model-catalog.js"
import { listAnthropicLiveModels, fromAgentSdk } from "../../../src/editor/llm-providers/anthropic-live-models.js"
import { mergeLiveModels, type LiveModel } from "../../../src/editor/llm-providers/live-model-catalog.js"
import { isClaudeSubscriptionOptIn } from "../../../src/editor/llm-providers/claude-subscription.js"
import {
  assertClaudeRuntimeReady,
  resolveClaudeExecutablePath,
} from "../../../src/editor/llm-providers/resolve-claude-executable.js"
import { supportsAnthropicAdaptiveThinking } from "../../../src/editor/agent-chat-sdk/run-chat-turn-sdk.js"
import { PROVIDER_DESCRIPTORS } from "../../../src/editor/llm-providers/provider-registry.js"
import type { ProviderDescriptor } from "../../../src/editor/llm-providers/provider-descriptor.js"
import { isNeutralChatEnabled } from "./dormant-surfaces.js"

/**
 * `source` describes the STRONGEST live source that answered for any provider
 * this resolution served, or "static" when none did. It is informational (the
 * catalog response carries it for diagnostics); it is not how any consumer
 * decides which provider to use — `resolveDefaultProviderId` is.
 */
export type ModelCatalogSource = "api" | "cli" | "static"

export interface ResolvedModelCatalogs {
  catalogs: ProviderModelCatalog[]
  source: ModelCatalogSource
}

/**
 * The pre-resolution fallback: Anthropic's static catalog alone. Used as
 * `buildModelCatalogResponse`'s default parameter, for a caller that has not
 * awaited the resolver yet.
 */
export const STATIC_MODEL_CATALOGS: ResolvedModelCatalogs = {
  catalogs: [ANTHROPIC_MODEL_CATALOG],
  source: "static",
}

export interface ModelCatalogResolverDeps {
  /** Read at call time, so a key saved mid-session is seen. Default `process.env`. */
  env?: () => NodeJS.ProcessEnv
  /**
   * Anthropic's live source, kept as its own dep slot for the existing test
   * suite: it is called with the same `(apiKey, signal)` shape the resolver
   * has always used for Anthropic, and defaults to the Anthropic descriptor's
   * own `listLiveModels`. Every other provider is resolved through its own
   * descriptor's `listLiveModels` instead — see `catalogFor`.
   */
  listViaApi?: (apiKey: string, signal: AbortSignal) => Promise<LiveModel[]>
  listViaCli?: (signal: AbortSignal) => Promise<LiveModel[]>
  now?: () => number
  /** How long a live answer is trusted. */
  ttlMs?: number
  /** How long a fall-back to static is held before trying live again. */
  failureTtlMs?: number
  /** Ceiling on one live attempt. Covers a process spawn on the `cli` path. */
  timeoutMs?: number
  log?: (message: string) => void
  /**
   * Which descriptors this resolution may serve at all. Defaults to
   * `chatRuntimeServable`. Tests override this to reach a second provider
   * without needing the neutral-chat flag on.
   */
  includeDescriptor?: (d: ProviderDescriptor) => boolean
}

export interface ModelCatalogResolver {
  get(): Promise<ResolvedModelCatalogs>
  /** Forget the cached answer (tests, and a credentials change if ever needed). */
  invalidate(): void
}

/** The Anthropic-only effort fallback, matched by provider id. */
function effortFallbackFor(descriptor: ProviderDescriptor) {
  if (descriptor.id === ANTHROPIC_MODEL_CATALOG.providerId) {
    return (id: string) => (supportsAnthropicAdaptiveThinking(id) ? [...EFFORT_LEVELS] : null)
  }
  return () => descriptor.effort.levels
}

/**
 * Which providers this resolution may serve at all.
 *
 * A provider whose chat runtime cannot dispatch yet must not appear in the
 * picker, or the picker offers a model the chat handler refuses a second
 * later. That is the client half of a both-ends gate whose server half is
 * `resolveChatRuntime`. Env-only: the resolver is a process-wide singleton
 * with no project config in scope, so `EDITOR_NEUTRAL_CHAT=1` reaches it and
 * `.desde/config.json`'s `editor.neutralChat` does not. The dispatch half is
 * ALSO env-only, on purpose (see the comment on `resolveChatRuntime` in
 * `chat-runtime-dispatch.ts` for why): a project that enables the flag only
 * in its config sees neither half serve the group, which is the intended
 * residual, not a gap between the two halves.
 */
export function chatRuntimeServable(descriptor: ProviderDescriptor): boolean {
  if (descriptor.chatRuntime === "claude-agent-sdk") return true
  return isNeutralChatEnabled({})
}

/**
 * Live list from the `claude` binary. A query is opened on a prompt stream
 * that never yields, the models control request is answered, and the process
 * is closed: no turn runs, no tokens are spent. The spawn is the cost, which
 * is why this is cached and bounded by the resolver's timeout.
 */
export async function listViaClaudeCli(signal: AbortSignal): Promise<LiveModel[]> {
  const claudeExecutablePath = resolveClaudeExecutablePath()
  assertClaudeRuntimeReady(claudeExecutablePath)
  const idle = (async function* (): AsyncGenerator<SDKUserMessage, void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
  })()
  const q = query({
    prompt: idle,
    options: {
      cwd: tmpdir(),
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
      maxTurns: 1,
      tools: [],
    },
  })
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Timed out listing models.")), {
          once: true,
        })
      }),
    ])
    return fromAgentSdk(models)
  } finally {
    q.close()
  }
}

function defaultListViaApi(apiKey: string, signal: AbortSignal): Promise<LiveModel[]> {
  return listAnthropicLiveModels({ apiKey, signal })
}

export function createModelCatalogResolver(deps: ModelCatalogResolverDeps = {}): ModelCatalogResolver {
  const env = deps.env ?? (() => process.env)
  const listViaApi = deps.listViaApi ?? defaultListViaApi
  const listViaCli = deps.listViaCli ?? listViaClaudeCli
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 10 * 60_000
  const failureTtlMs = deps.failureTtlMs ?? 60_000
  const timeoutMs = deps.timeoutMs ?? 8_000
  const log = deps.log ?? ((message: string) => console.error(`[model-catalog] ${message}`))
  const includeDescriptor = deps.includeDescriptor ?? chatRuntimeServable

  let cached: { key: string; value: ResolvedModelCatalogs; at: number } | null = null
  let inFlight: { key: string; promise: Promise<ResolvedModelCatalogs> } | null = null

  function servableDescriptors(): ProviderDescriptor[] {
    return PROVIDER_DESCRIPTORS.filter(includeDescriptor)
  }

  /** Cache key over EVERY served provider's credential state, not Anthropic's alone. */
  function cacheKeyFor(currentEnv: NodeJS.ProcessEnv, descriptors: ProviderDescriptor[]): string {
    return descriptors
      .map((d) => {
        const key = currentEnv[d.credentials.apiKeyEnvVar]?.trim() ?? ""
        const sub =
          d.credentials.hasSubscriptionRuntime === true && isClaudeSubscriptionOptIn(currentEnv)
            ? "sub"
            : ""
        return `${d.id}:${key}:${sub}`
      })
      .join("|")
  }

  async function catalogFor(
    descriptor: ProviderDescriptor,
    currentEnv: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<{ catalog: ProviderModelCatalog; source: ModelCatalogSource }> {
    const apiKey = currentEnv[descriptor.credentials.apiKeyEnvVar]?.trim()
    const useCli =
      descriptor.credentials.hasSubscriptionRuntime === true &&
      !apiKey &&
      isClaudeSubscriptionOptIn(currentEnv)
    if (!apiKey && !useCli) return { catalog: descriptor.staticCatalog, source: "static" }
    try {
      const live = useCli
        ? await listViaCli(signal)
        : descriptor.id === ANTHROPIC_MODEL_CATALOG.providerId
          ? await listViaApi(apiKey!, signal)
          : descriptor.listLiveModels
            ? await descriptor.listLiveModels({ apiKey: apiKey!, signal })
            : []
      const merged = mergeLiveModels(descriptor.staticCatalog, live, {
        effortFallback: effortFallbackFor(descriptor),
      })
      if (!merged) {
        log(`the ${descriptor.id} source listed no models; using the built-in list`)
        return { catalog: descriptor.staticCatalog, source: "static" }
      }
      return { catalog: merged, source: useCli ? "cli" : "api" }
    } catch (err) {
      log(
        `could not list ${descriptor.id} models: ${(err as Error).message}; using the built-in list`,
      )
      return { catalog: descriptor.staticCatalog, source: "static" }
    }
  }

  async function resolveAll(currentEnv: NodeJS.ProcessEnv): Promise<ResolvedModelCatalogs> {
    const descriptors = servableDescriptors()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const results = await Promise.all(
        descriptors.map((d) => catalogFor(d, currentEnv, controller.signal)),
      )
      const catalogs = results.map((r) => r.catalog)
      const source: ModelCatalogSource = results.some((r) => r.source === "api")
        ? "api"
        : results.some((r) => r.source === "cli")
          ? "cli"
          : "static"
      return { catalogs, source }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get() {
      const currentEnv = env()
      const descriptors = servableDescriptors()
      const key = cacheKeyFor(currentEnv, descriptors)
      const at = now()
      if (cached && cached.key === key) {
        const ttl = cached.value.source === "static" ? failureTtlMs : ttlMs
        if (at - cached.at < ttl) return cached.value
      }
      if (inFlight && inFlight.key === key) return inFlight.promise
      const promise = resolveAll(currentEnv).then((value) => {
        cached = { key, value, at: now() }
        return value
      })
      inFlight = { key, promise }
      void promise.finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
      return promise
    },
    invalidate() {
      cached = null
    },
  }
}

let inner: ModelCatalogResolver = createModelCatalogResolver()

/** The process-wide resolver every consumer reads through. */
export const modelCatalogResolver: ModelCatalogResolver = {
  get: () => inner.get(),
  invalidate: () => inner.invalidate(),
}

/**
 * Test-only: swap the live sources behind the process-wide resolver so a
 * suite that boots the real HTTP server never reaches a vendor's Models API.
 * `null` restores the defaults. Always invalidates the cache (a fresh
 * resolver has none, but this also drops any answer cached under the old
 * sources).
 */
export function setModelCatalogLiveSourcesForTests(
  deps: {
    listViaApi?: ModelCatalogResolverDeps["listViaApi"]
    listViaCli?: ModelCatalogResolverDeps["listViaCli"]
  } | null,
): void {
  inner = createModelCatalogResolver(deps ?? {})
}

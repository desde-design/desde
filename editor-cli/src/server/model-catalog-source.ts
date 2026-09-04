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
 * **Only a credentialed provider is served** (codex fix, 2026-09-04). A
 * provider whose chat runtime CAN dispatch but has no key and no
 * subscription opt-in used to still get a static-catalog entry, so the
 * picker offered a provider the chat gate then refused every turn. Now a
 * provider with no credential is left out of `catalogs[]` entirely. When
 * NOTHING is credentialed, the picker still needs a default to show on
 * first run, so the precedence default's own static catalog is served
 * alone — the chat gate still refuses the turn, same as it always has.
 *
 * Cached in-process, keyed on every served provider's credential state
 * (INCLUDING its base URL — an OpenAI-compatible gateway swap is a
 * different provider identity even with the same key), for ten minutes on
 * success and one minute after a fall-back, so a transient failure does not
 * pin the static list for the rest of the session. A partial fall-back
 * (one provider live, another static) is cached at the shorter, failure TTL
 * too — `source` reports the WEAKEST source among served providers, so one
 * struggling vendor does not buy the whole response the long TTL. One fetch
 * at a time: the picker mounts and the chat handler validates against the
 * same list, and both may ask before the first answer lands. Both
 * consumers read through `modelCatalogResolver`, which is what keeps a
 * live-only model that the picker offered from being refused by the chat
 * handler a second later.
 */

import { createHash } from "node:crypto"
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
import {
  DEFAULT_PROVIDER_PRECEDENCE,
  PROVIDER_DESCRIPTORS,
  credentialsFromEnv,
  getDescriptor,
  isCredentialedFromEnv,
} from "../../../src/editor/llm-providers/provider-registry.js"
import type { ProviderDescriptor } from "../../../src/editor/llm-providers/provider-descriptor.js"
import { getRateCard, UNKNOWN_MODEL_RATE } from "../../../src/editor/llm-providers/rate-cards.js"
import { isNeutralChatEnabled } from "./dormant-surfaces.js"

/**
 * `source` describes the WEAKEST live source among the providers this
 * resolution served, or "static" when any of them fell back to it. It is
 * informational (the catalog response carries it for diagnostics); it is
 * not how any consumer decides which provider to use —
 * `resolveDefaultProviderId` is. The weakest-not-strongest choice is what
 * routes a partial fallback (one provider live, another static) into the
 * shorter failure TTL below, rather than the longer success one.
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

/** One provider's live-source call, keyed form: the shape every descriptor's `listLiveModels` already takes. */
export type ListLive = (input: {
  apiKey: string
  baseUrl?: string
  signal: AbortSignal
}) => Promise<LiveModel[]>

export interface ModelCatalogResolverDeps {
  /** Read at call time, so a key saved mid-session is seen. Default `process.env`. */
  env?: () => NodeJS.ProcessEnv
  /**
   * Either shape works.
   *
   * A bare function is the legacy shape: it applies to Anthropic ONLY,
   * called with the `(apiKey, signal)` two-arg form the existing test suite
   * pins, and defaults to the Anthropic descriptor's own `listLiveModels`.
   *
   * A record keyed by provider id lets a test (or a future caller) inject
   * EVERY provider's live source, so no unit test has to fall through to a
   * descriptor's real `listLiveModels` and reach the network. A descriptor
   * with no entry in the record, and no legacy bare-function override
   * naming it, falls through to its own `listLiveModels` — production's
   * behaviour, unchanged.
   */
  listViaApi?: ((apiKey: string, signal: AbortSignal) => Promise<LiveModel[]>) | Record<string, ListLive>
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
 * created once at import time, with no project config in scope, so there is
 * no `.desde/config.json` key for this gate at all — see
 * `isNeutralChatEnabled`'s own doc comment in `dormant-surfaces.ts` for why.
 * The dispatch half reads the identical environment variable independently,
 * which is what keeps the two halves from drifting.
 */
export function chatRuntimeServable(descriptor: ProviderDescriptor): boolean {
  if (descriptor.chatRuntime === "claude-agent-sdk") return true
  return isNeutralChatEnabled()
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
  /** (provider, model) pairs already warned about — logged once per resolver, not once per `get()`. */
  const loggedUnknownRateCards = new Set<string>()

  function servableDescriptors(): ProviderDescriptor[] {
    return PROVIDER_DESCRIPTORS.filter(includeDescriptor)
  }

  /**
   * Cache key over EVERY served provider's credential state, not Anthropic's
   * alone — and over the BASE URL too, since an OpenAI-compatible gateway
   * swap is a different provider identity even under the same key. The key
   * itself is hashed rather than stored raw, so nothing that logs or
   * inspects this cache's key can recover a credential from it.
   */
  function cacheKeyFor(currentEnv: NodeJS.ProcessEnv, descriptors: ProviderDescriptor[]): string {
    return descriptors
      .map((d) => {
        const creds = credentialsFromEnv(d, currentEnv)
        const keyHash = creds.apiKey ? createHash("sha256").update(creds.apiKey).digest("hex") : ""
        const sub =
          d.credentials.hasSubscriptionRuntime === true && isClaudeSubscriptionOptIn(currentEnv)
            ? "sub"
            : ""
        return `${d.id}:${keyHash}:${creds.baseUrl ?? ""}:${sub}`
      })
      .join("|")
  }

  /** Resolve one descriptor's live source, honouring either `listViaApi` shape (see its doc comment). */
  function liveSourceFor(descriptor: ProviderDescriptor): ListLive | undefined {
    if (typeof listViaApi === "function") {
      if (descriptor.id !== ANTHROPIC_MODEL_CATALOG.providerId) return descriptor.listLiveModels
      return ({ apiKey, signal }) => listViaApi(apiKey, signal)
    }
    return listViaApi[descriptor.id] ?? descriptor.listLiveModels
  }

  function logUnknownRateCardsOnce(descriptor: ProviderDescriptor, catalog: ProviderModelCatalog): void {
    for (const model of catalog.models) {
      if (getRateCard(model.id) !== UNKNOWN_MODEL_RATE) continue
      const key = `${descriptor.id}/${model.id}`
      if (loggedUnknownRateCards.has(key)) continue
      loggedUnknownRateCards.add(key)
      log(`no rate card for ${descriptor.id}/${model.id}; pricing at the conservative fallback`)
    }
  }

  async function catalogFor(
    descriptor: ProviderDescriptor,
    currentEnv: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<{ catalog: ProviderModelCatalog; source: ModelCatalogSource }> {
    const creds = credentialsFromEnv(descriptor, currentEnv)
    const apiKey = creds.apiKey
    const useCli =
      descriptor.credentials.hasSubscriptionRuntime === true &&
      !apiKey &&
      isClaudeSubscriptionOptIn(currentEnv)
    if (!apiKey && !useCli) return { catalog: descriptor.staticCatalog, source: "static" }
    try {
      const source = liveSourceFor(descriptor)
      const live = useCli
        ? await listViaCli(signal)
        : source
          ? await source({ apiKey: apiKey!, baseUrl: creds.baseUrl, signal })
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
    const credentialed = descriptors.filter((d) => isCredentialedFromEnv(d, currentEnv))
    if (credentialed.length === 0) {
      // Nobody is credentialed: the picker still needs a default model name
      // to show on first run, so the precedence default's own static
      // catalog is served alone. The chat gate refuses the turn exactly as
      // it always has — this is display-only.
      //
      // The precedence id itself may not be SERVABLE (`descriptors` is
      // already filtered by `chatRuntimeServable`, e.g. a neutral-chat-only
      // provider with the flag off) — pick the first precedence id that IS
      // in `descriptors`, falling back to whichever descriptor is servable
      // at all, rather than unconditionally trusting
      // `DEFAULT_PROVIDER_PRECEDENCE[0]`.
      const precedenceId = DEFAULT_PROVIDER_PRECEDENCE.find((id) =>
        descriptors.some((d) => d.id === id),
      )
      const fallback = precedenceId ? getDescriptor(precedenceId) : descriptors[0]
      if (fallback) logUnknownRateCardsOnce(fallback, fallback.staticCatalog)
      return { catalogs: fallback ? [fallback.staticCatalog] : [], source: "static" }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const results = await Promise.all(
        credentialed.map((d) => catalogFor(d, currentEnv, controller.signal)),
      )
      const catalogs = results.map((r) => r.catalog)
      // Checked over the FINAL served catalogs, not just a live-source
      // success inside `catalogFor` — a provider that fell back to its
      // static catalog (no key, live source failed, or nothing credentialed
      // at all) still serves models, and those deserve the same rate-card
      // check a live-sourced model gets.
      for (let i = 0; i < credentialed.length; i++) {
        logUnknownRateCardsOnce(credentialed[i], catalogs[i])
      }
      // The WEAKEST source among served providers, not the strongest: a
      // partial fall-back (one provider live, another static) has to read as
      // "static" so the cache below holds it for the shorter failure TTL,
      // not the full success one.
      const source: ModelCatalogSource = results.some((r) => r.source === "static")
        ? "static"
        : results.some((r) => r.source === "cli")
          ? "cli"
          : "api"
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

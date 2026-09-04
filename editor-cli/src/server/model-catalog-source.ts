/**
 * Which model list the chat picker gets, and where it comes from.
 *
 * Three answers, tried in this order (Mo, 2026-09-02: "add the live
 * functionality and have the hard coded as a back up ... the live list should
 * also work in dev mode, using the CLI"):
 *
 *  - `api`: an API key is active (`ANTHROPIC_API_KEY` in the process env,
 *    which is where `apply-llm-credentials.ts` puts a stored key too). The
 *    Anthropic Models API lists what that key can use.
 *  - `cli`: no key, but dev mode / `EDITOR_USE_CLAUDE_SUBSCRIPTION` is on.
 *    The bundled `claude` binary is asked, through the Agent SDK's
 *    `supportedModels()` control request, what it offers on the account it
 *    is signed into. That is the only source that can see a subscription.
 *  - `static`: neither, or a live source failed or timed out. The hand-kept
 *    `ANTHROPIC_MODEL_CATALOG`, unchanged from before this existed.
 *
 * A live list is merged over the static one (`live-model-catalog.ts`), so a
 * model Anthropic ships appears here without a code change, and a model the
 * static file still names but the account cannot use does not.
 *
 * Cached in-process, keyed on the mode and the key, for ten minutes on
 * success and one minute after a fall-back, so a transient failure does not
 * pin the static list for the rest of the session. One fetch at a time: the
 * picker mounts and the chat handler validates against the same list, and
 * both may ask before the first answer lands. Both consumers read through
 * `modelCatalogResolver`, which is what keeps a live-only model that the
 * picker offered from being refused by the chat handler a second later.
 */

import { tmpdir } from "node:os"
import Anthropic from "@anthropic-ai/sdk"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { EFFORT_LEVELS, type ProviderModelCatalog } from "../../../src/editor/core/model-catalog.js"
import { ANTHROPIC_MODEL_CATALOG } from "../../../src/editor/llm-providers/anthropic-model-catalog.js"
import {
  fromAgentSdk,
  fromModelsApi,
  mergeLiveModels,
  type LiveModel,
} from "../../../src/editor/llm-providers/live-model-catalog.js"
import { isClaudeSubscriptionOptIn } from "../../../src/editor/llm-providers/claude-subscription.js"
import {
  assertClaudeRuntimeReady,
  resolveClaudeExecutablePath,
} from "../../../src/editor/llm-providers/resolve-claude-executable.js"
import { supportsAdaptiveThinking } from "../../../src/editor/agent-chat-sdk/run-chat-turn-sdk.js"

export type ModelCatalogSource = "api" | "cli" | "static"

export interface ResolvedModelCatalogs {
  catalogs: ProviderModelCatalog[]
  source: ModelCatalogSource
}

export const STATIC_MODEL_CATALOGS: ResolvedModelCatalogs = {
  catalogs: [ANTHROPIC_MODEL_CATALOG],
  source: "static",
}

export interface ModelCatalogResolverDeps {
  /** Read at call time, so a key saved mid-session is seen. Default `process.env`. */
  env?: () => NodeJS.ProcessEnv
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
}

export interface ModelCatalogResolver {
  get(): Promise<ResolvedModelCatalogs>
  /** Forget the cached answer (tests, and a credentials change if ever needed). */
  invalidate(): void
}

/** A brand-new model nobody has described yet: effort if its family thinks adaptively. */
function effortFallback(id: string) {
  return supportsAdaptiveThinking(id) ? [...EFFORT_LEVELS] : null
}

type Mode = { kind: "api"; key: string; apiKey: string } | { kind: "cli"; key: string } | { kind: "none" }

function modeFor(env: NodeJS.ProcessEnv): Mode {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (apiKey) return { kind: "api", key: `api:${apiKey}`, apiKey }
  if (isClaudeSubscriptionOptIn(env)) return { kind: "cli", key: "cli" }
  return { kind: "none" }
}

/** Live list from the Models API, on the key the editor is using. */
export async function listViaModelsApi(apiKey: string, signal: AbortSignal): Promise<LiveModel[]> {
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  const models = []
  for await (const m of client.models.list({ limit: 100 }, { signal })) models.push(m)
  return fromModelsApi(models)
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

export function createModelCatalogResolver(deps: ModelCatalogResolverDeps = {}): ModelCatalogResolver {
  const env = deps.env ?? (() => process.env)
  const listViaApi = deps.listViaApi ?? listViaModelsApi
  const listViaCli = deps.listViaCli ?? listViaClaudeCli
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? 10 * 60_000
  const failureTtlMs = deps.failureTtlMs ?? 60_000
  const timeoutMs = deps.timeoutMs ?? 8_000
  const log = deps.log ?? ((message: string) => console.error(`[model-catalog] ${message}`))

  let cached: { key: string; value: ResolvedModelCatalogs; at: number } | null = null
  let inFlight: { key: string; promise: Promise<ResolvedModelCatalogs> } | null = null

  async function fetchLive(mode: Exclude<Mode, { kind: "none" }>): Promise<ResolvedModelCatalogs> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const live =
        mode.kind === "api"
          ? await listViaApi(mode.apiKey, controller.signal)
          : await listViaCli(controller.signal)
      const merged = mergeLiveModels(ANTHROPIC_MODEL_CATALOG, live, { effortFallback })
      if (!merged) {
        log(`the ${mode.kind} source listed no models; using the built-in list`)
        return STATIC_MODEL_CATALOGS
      }
      return { catalogs: [merged], source: mode.kind }
    } catch (err) {
      log(`could not list models via ${mode.kind}: ${(err as Error).message}; using the built-in list`)
      return STATIC_MODEL_CATALOGS
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get() {
      const mode = modeFor(env())
      if (mode.kind === "none") return STATIC_MODEL_CATALOGS
      const at = now()
      if (cached && cached.key === mode.key) {
        const ttl = cached.value.source === "static" ? failureTtlMs : ttlMs
        if (at - cached.at < ttl) return cached.value
      }
      if (inFlight && inFlight.key === mode.key) return inFlight.promise
      const promise = fetchLive(mode).then((value) => {
        cached = { key: mode.key, value, at: now() }
        return value
      })
      inFlight = { key: mode.key, promise }
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

/** The process-wide resolver every consumer reads through. */
export const modelCatalogResolver: ModelCatalogResolver = createModelCatalogResolver()

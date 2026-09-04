/**
 * GET /api/editor/chat/model-catalog — static provider model/effort
 * catalogs for the chat model picker chip, plus the model the user last
 * chose in this project. Read-only, no side effects; registered in
 * http-server.ts under the same auth story as the other read-only GETs
 * (manifest/catalog/sessions).
 *
 * `lastChosenModel` exists because a NEW chat has no persisted choice of
 * its own, and a new chat is what opening a project lands in. Without a
 * project-wide answer the chip would render the runtime catalog default
 * on every open and the user's model choice would evaporate overnight.
 *
 * WHERE THE VALUE COMES FROM, and why it is that.
 *
 * It is the most recently updated chat session that carries a persisted
 * `modelConfig`. Every turn the client sends carries the chip's current
 * choice, and the chat handler writes that onto the session it ran on
 * (`chat-handler.ts`, "Precedence: request modelConfig > ..."). So the
 * newest session with a choice IS the last chat the user ran, and the
 * model it ran on IS the last model they chose.
 *
 * This field used to read the PROJECT-DEFAULT session instead (the one
 * `sessionId = projectId` resolves to when a request omits `sessionId`).
 * That stopped being current the moment opening a project started
 * minting a fresh session: the project-default session no longer
 * receives turns, so its persisted choice froze at whatever it held on
 * the day minting shipped. Deriving from the newest session instead
 * means the same change that broke the old source keeps this one fresh —
 * the session the user actually chats in is always the newest one.
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  defaultModelConfig,
  reconcileSessionModelConfig,
  type ProviderModelCatalog,
  type SessionModelConfig,
} from "../../../src/editor/core/model-catalog.js"
import {
  resolveDefaultProviderId,
  isCredentialedFromEnv,
  getDescriptor,
} from "../../../src/editor/llm-providers/provider-registry.js"
import type { ProviderCapabilities } from "../../../src/editor/llm-providers/provider-descriptor.js"
import {
  STATIC_MODEL_CATALOGS,
  modelCatalogResolver,
  type ModelCatalogSource,
  type ResolvedModelCatalogs,
} from "./model-catalog-source.js"

/**
 * A catalog whose provider has no descriptor cannot happen through the
 * resolver, which builds catalogs FROM descriptors. This exists so a
 * hand-built `ResolvedModelCatalogs` in a test or a future source cannot make
 * the response claim capabilities the runtime does not have: every optimistic
 * flag is off.
 */
const FALLBACK_CAPABILITIES: ProviderCapabilities = {
  midTurnSteering: false,
  vendorReportedCostUsd: false,
  inTurnBudgetStop: "step-boundary",
  reasoningVisibility: false,
  vendorRateLimitEvents: false,
  imagesInPrompt: false,
  webTools: false,
}

/** A served catalog plus the asymmetries the client has to gate on. */
export interface ModelCatalogEntry extends ProviderModelCatalog {
  capabilities: ProviderCapabilities
}

export interface ModelCatalogResponse {
  catalogs: ModelCatalogEntry[]
  /**
   * Which provider is THE default. `catalogs[0]` used to answer this by array
   * position, which is not a rule — it is whichever provider happened to be
   * registered first. `resolveDefaultProviderId` is the rule, and it is the
   * same one the picker, a new session and the non-chat lanes use.
   */
  defaultProviderId: string
  default: SessionModelConfig
  /**
   * The model the user last chose in this project, reconciled against
   * the catalogs above. `null` when no session has ever carried a
   * choice, or when every saved choice has since left the catalog —
   * both mean "the runtime default applies", which is exactly what the
   * chip renders for a `null` value.
   */
  lastChosenModel: SessionModelConfig | null
  /**
   * Where the catalogs came from: the Models API on the active key, the
   * `claude` binary in dev mode, or the built-in list when neither could be
   * reached. See `model-catalog-source.ts`.
   */
  source: ModelCatalogSource
}

export function buildModelCatalogResponse(
  lastChosenModel: SessionModelConfig | null = null,
  resolved: ResolvedModelCatalogs = STATIC_MODEL_CATALOGS,
  opts: { configuredDefaultProvider?: string; env?: NodeJS.ProcessEnv } = {},
): ModelCatalogResponse {
  const env = opts.env ?? process.env
  const wanted = resolveDefaultProviderId({
    env,
    ...(opts.configuredDefaultProvider
      ? { configuredDefault: opts.configuredDefaultProvider }
      : {}),
    isCredentialed: (d) => isCredentialedFromEnv(d, env),
  })
  // The resolved default may serve no catalog (its runtime is not dispatchable
  // yet, or its live and static lists were both empty). Fall back to a catalog
  // that IS served rather than answering with a model the client cannot pick.
  const primary =
    resolved.catalogs.find((c) => c.providerId === wanted) ?? resolved.catalogs[0]
  if (!primary) throw new Error("Model catalog resolver returned no catalogs.")
  return {
    catalogs: resolved.catalogs.map((catalog) => ({
      ...catalog,
      capabilities:
        getDescriptor(catalog.providerId)?.capabilities ?? FALLBACK_CAPABILITIES,
    })),
    defaultProviderId: primary.providerId,
    default: defaultModelConfig(primary),
    lastChosenModel,
    source: resolved.source,
  }
}

/**
 * Walk the project's chat sessions newest-first and return the first
 * persisted `modelConfig` that still reconciles against the catalog.
 * Read-only: `listSessionsForProject` never writes, and unreadable or
 * malformed session files are skipped by the lister itself.
 *
 * Scanning PAST a session whose model has left the catalog is
 * deliberate. A retired model reconciles to null, which is
 * indistinguishable from "no choice" to the client; falling through to
 * the next-newest choice keeps a real preference alive instead of
 * dropping the user back to the runtime default because of one stale
 * record.
 *
 * Best-effort — any failure resolves to `null` (runtime default) rather
 * than failing the catalog GET, because the picker must never block
 * chatting.
 */
async function resolveLastChosenModel(
  repoRoot: string,
  catalogs: ProviderModelCatalog[],
): Promise<SessionModelConfig | null> {
  try {
    const { listSessionsForProject } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    // Already sorted most-recently-touched first.
    const sessions = await listSessionsForProject(repoRoot)
    for (const summary of sessions) {
      if (!summary.modelConfig) continue
      const reconciled = reconcileSessionModelConfig(summary.modelConfig, catalogs)
      if (reconciled) return reconciled
    }
    return null
  } catch {
    return null
  }
}

export async function handleModelCatalogRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  repoRoot: string,
  opts: { configuredDefaultProvider?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  try {
    const resolved = await modelCatalogResolver.get()
    const lastChosenModel = await resolveLastChosenModel(repoRoot, resolved.catalogs)
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(buildModelCatalogResponse(lastChosenModel, resolved, opts)))
  } catch (err) {
    // `defaultModelConfig` throws on an empty catalog (a broken build).
    // Answer with a diagnosable 500 rather than letting an opaque
    // TypeError escape into the request pipeline.
    res.statusCode = 500
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
}

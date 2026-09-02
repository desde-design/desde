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
import { ANTHROPIC_MODEL_CATALOG } from "../../../src/editor/llm-providers/anthropic-model-catalog.js"

export interface ModelCatalogResponse {
  catalogs: ProviderModelCatalog[]
  default: SessionModelConfig
  /**
   * The model the user last chose in this project, reconciled against
   * the catalogs above. `null` when no session has ever carried a
   * choice, or when every saved choice has since left the catalog —
   * both mean "the runtime default applies", which is exactly what the
   * chip renders for a `null` value.
   */
  lastChosenModel: SessionModelConfig | null
}

export function buildModelCatalogResponse(
  lastChosenModel: SessionModelConfig | null = null,
): ModelCatalogResponse {
  return {
    catalogs: [ANTHROPIC_MODEL_CATALOG],
    default: defaultModelConfig(ANTHROPIC_MODEL_CATALOG),
    lastChosenModel,
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
): Promise<SessionModelConfig | null> {
  try {
    const { listSessionsForProject } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    // Already sorted most-recently-touched first.
    const sessions = await listSessionsForProject(repoRoot)
    for (const summary of sessions) {
      if (!summary.modelConfig) continue
      const reconciled = reconcileSessionModelConfig(summary.modelConfig, [
        ANTHROPIC_MODEL_CATALOG,
      ])
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
): Promise<void> {
  try {
    const lastChosenModel = await resolveLastChosenModel(repoRoot)
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(buildModelCatalogResponse(lastChosenModel)))
  } catch (err) {
    // `defaultModelConfig` throws on an empty catalog (a broken build).
    // Answer with a diagnosable 500 rather than letting an opaque
    // TypeError escape into the request pipeline.
    res.statusCode = 500
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
}

/**
 * Chat endpoint for editor-cli. Streams chat events over SSE while
 * running the orchestrator's tool-use loop.
 *
 * Three routes:
 *   - `POST /api/editor/chat` — body `{ userMessage, selection?, page? }`.
 *     Opens an SSE stream and runs one turn.
 *   - `POST /api/editor/chat/bridge-reply` — body `{ bridgeReqId, ok, output?, error? }`.
 *     Resolves an in-flight `bridge_request` initiated by the orchestrator.
 *   - `POST /api/editor/chat/steer` — body `{ sessionId, userMessage, images? }`.
 *     Pushes another user message into a turn that is still running, so the
 *     agent sees it at its next model boundary instead of after the turn.
 *
 * The handler wires a `BridgeClient` that:
 *   1. Generates a `bridgeReqId`.
 *   2. Emits a `bridge_request` SSE event.
 *   3. Returns a Promise that resolves when the matching `bridge-reply`
 *      arrives (or rejects on timeout / abort).
 *
 * Session persistence: loads on each turn (cheap, single small JSON
 * file), saves after the turn completes.
 */

import { randomUUID } from "node:crypto"
import { assertChatCredentials } from "../../../src/editor/llm-providers/assert-chat-credentials.js"
import type { IncomingMessage, ServerResponse } from "node:http"

import { projectIdForRepoRoot, withSessionStatus } from "../../../src/editor/agent-chat/session-store.js"
import { classifyTurnError } from "../../../src/editor/agent-chat/classify-turn-error.js"
import type { ChatStreamEvent } from "../../../src/editor/agent-chat/chat-stream-events.js"
import type { ChatSteeredMessage } from "../../../src/editor/agent-chat/types.js"
// Value import, not the usual lazy loader. `turn-input-channel.js` imports
// NOTHING at runtime (its three imports are all `import type`), so pulling it in
// eagerly costs no module graph — and the whole point of the registration order
// below is that creating the channel must not sit behind an await.
import {
  createTurnInputChannel,
  type TurnInputChannel,
} from "../../../src/editor/agent-chat-sdk/turn-input-channel.js"
import {
  imageFromDataUrl,
  type ModelImageContent,
} from "../../../src/editor/agent-chat-sdk/media-content.js"
import { getSharedConcurrencyCap } from "../../../src/editor/agent-chat/concurrency-cap.js"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge.js"
import type { GroundingService } from "../../../src/editor/core"
import {
  validateSessionModelConfig,
  type SessionModelConfig,
} from "../../../src/editor/core/model-catalog.js"
import { modelCatalogResolver } from "./model-catalog-source.js"
import { resolveCostCeilingUsd } from "../../../src/editor/core/chat-cost-ceiling.js"
import { acquireFileEditLock, acquireTreeGateShared } from "./session-lock.js"
import { openSseStream } from "./sse.js"
import { readRawBody } from "./http-body.js"

const BRIDGE_REQUEST_TIMEOUT_MS = 30_000

export interface ChatHandlerLoaders {
  loadSessionStore: () => Promise<
    typeof import("../../../src/editor/agent-chat/session-store")
  >
  /**
   * Loads the project-knowledge digest (the prototype repo's documented
   * conventions). Optional — when unconfigured the chat agent runs without
   * the conventions block folded into its system prompt.
   */
  loadProjectKnowledge?: () => Promise<
    typeof import("../../../src/editor/edit-service/load-project-knowledge")
  >
  /**
   * Loads the Claude Agent SDK runtime — the CLI's only chat runtime. New
   * sessions bill the user's Claude subscription via the bundled `claude`
   * binary instead of an `ANTHROPIC_API_KEY`.
   */
  loadRunChatTurnSdk: () => Promise<
    typeof import("../../../src/editor/agent-chat-sdk/run-chat-turn-sdk")
  >
  /**
   * Loads the Node/npm verification adapter factory. Called once per
   * turn (cheap — just reads package.json + checks lockfile presence)
   * so a `package.json` edit mid-session picks up the new scripts on
   * the next turn without restarting editor. Optional: when
   * undefined the `run_verification` tool reports "not configured",
   * which keeps existing test loaders working without modification.
   */
  loadVerificationAdapter?: () => Promise<
    typeof import("../../../src/editor/adapters/node-npm/verification-adapter")
  >
  /**
   * Loads the Node/npm package-manager adapter factory. Same lazy
   * pattern as `loadVerificationAdapter` — optional; absence means
   * `manage_package` is "not configured" for the session.
   */
  loadPackageManagerAdapter?: () => Promise<
    typeof import("../../../src/editor/adapters/node-npm/package-manager-adapter")
  >
  /**
   * Loads the web-policy loader. Same lazy/optional pattern. Absence
   * makes `WebFetch` / `WebSearch` deny by default with the standard
   * "configure desde.config.json" message.
   */
  loadWebPolicy?: () => Promise<
    typeof import("../../../src/editor/core/web-policy")
  >
  /**
   * Loads the Figma config loader. Same lazy/optional pattern.
   * Absence ⇒ no Figma MCP server is registered with the SDK runtime,
   * regardless of what's in the prototype's config file.
   */
  loadExtensions?: () => Promise<
    typeof import("../../../src/editor/core/extensions-config")
  >
  loadFigmaConfig?: () => Promise<
    typeof import("../../../src/editor/core/figma-config")
  >
  /**
   * Loads the review-surface factory (the agent's isolated Playwright
   * sidecar). Lazy so tests / non-CLI callers that omit it (or run with
   * no prototype URL) never pull in Playwright. Absence → the agent's
   * view+drive ops fall back to the bridge → user's live iframe.
   */
  loadReviewSurface?: () => Promise<typeof import("../review-surface")>
}

export const defaultChatLoaders: ChatHandlerLoaders = {
  loadSessionStore: () => import("../../../src/editor/agent-chat/session-store"),
  loadProjectKnowledge: () =>
    import("../../../src/editor/edit-service/load-project-knowledge"),
  loadRunChatTurnSdk: () =>
    import("../../../src/editor/agent-chat-sdk/run-chat-turn-sdk"),
  loadVerificationAdapter: () =>
    import("../../../src/editor/adapters/node-npm/verification-adapter"),
  loadPackageManagerAdapter: () =>
    import("../../../src/editor/adapters/node-npm/package-manager-adapter"),
  loadWebPolicy: () => import("../../../src/editor/core/web-policy"),
  loadFigmaConfig: () => import("../../../src/editor/core/figma-config"),
  loadExtensions: () => import("../../../src/editor/core/extensions-config"),
  loadReviewSurface: () => import("../review-surface"),
}

/**
 * Per-session turn lock — Phase 5. Prevents two `/api/editor/chat`
 * requests on the same session from interleaving turns. Keyed by
 * `projectId` (the session id). The second request returns 409 so
 * the shell can decide whether to wait or display an error.
 *
 * Scoped to the editor-cli process. Two concurrent CLI instances
 * would each have their own lock — fine because they serve different
 * projects (different ports).
 */
const activeTurns = new Set<string>()

/**
 * The input channel of every turn currently running, keyed by the SAME
 * `${projectId}:${sessionId}` the turn lock above uses. `POST
 * /api/editor/chat/steer` looks a channel up here and pushes into it, which is
 * how a message typed mid-turn reaches the running agent.
 *
 * Modelled on `pendingBridgeRequests` below — the established way this file
 * reaches into a live turn from a second request — with one difference that
 * matters: bridge requests key on a per-request id and are removed by whoever
 * settles them, whereas a turn channel keys on the turn itself. So it shares
 * `activeTurns`' exact lifetime: registered with no await between it and
 * `activeTurns.add`, deleted in the same `finally` that releases the lock.
 *
 * **The two must be added together, and this is the defect that was here.** The
 * channel used to be registered from inside the turn runtime, many awaits past
 * the lock — session load, project knowledge, web policy, Figma config, the
 * concurrency-cap queue, which can park for as long as the project is at cap.
 * For all of that time the lock said "a turn is running" and the registry said
 * "nothing to steer", so `/steer` answered 409 and `POST /api/editor/chat`
 * answered 409 as well: a message typed in the opening moments of a turn had
 * nowhere to go. The fix is not a smaller window, it is no window — the channel
 * is created here, before the first await, and the turn runtime is handed it
 * (`inputChannel`) rather than handing it back.
 *
 * The other direction still matters for the opposite reason: an entry that
 * outlived the lock would hand `/steer` a channel whose turn has ended, and a
 * push into it is a message the model never sees.
 *
 * Owning the channel this early means owning its END too. The handler's
 * `finally` closes it and reports every steer that cannot be shown to have
 * reached the model, because the turn runtime is not reached at all on several
 * paths that can now hold an accepted steer: a cancelled session, a
 * concurrency-cap failure, a failed in-flight persist, the cost-ceiling
 * refusal. Closing is idempotent and the steer drain is one-shot, so doing this
 * at both levels reports nothing twice.
 *
 * `emit` is the owning turn's SSE `send`, so an accepted steer can be
 * announced on the stream the answer will arrive on — see the `steered` event
 * in `chat-stream-events.ts` for why that is not the steering response's job.
 */
interface LiveTurn {
  channel: TurnInputChannel
  emit: (event: ChatStreamEvent) => void
  /**
   * Every steer this turn accepted, appended by the `/steer` route right after
   * a successful push, in accept order.
   *
   * A second record of what the turn runtime's `onAccepted` hook already
   * collects, and it exists for the one path where that hook's output never
   * reaches disk: the outer catch's recovery turn. That arm runs when the
   * runtime threw or was never reached, so it builds a `ChatTurn` from the
   * REQUEST body — which holds the opening prompt and nothing typed after it.
   * Without this list, an accepted steer vanishes from the transcript on
   * exactly the failures where the user most needs to see what they sent.
   *
   * `afterAssistantBlocks` is 0 for all of them, which is honest rather than
   * lossy: a recovery turn has an empty `assistantContent`, so 0 is the only
   * position there is.
   */
  steers: ChatSteeredMessage[]
}
const liveTurns = new Map<string, LiveTurn>()

/**
 * Test hook: clear the active-turn set between tests. Clears the live-channel
 * registry too — the two share a lifetime in the handler, so a reset that left
 * one of them populated would be a state the running code cannot produce.
 */
export function __resetActiveTurnsForTest(): void {
  activeTurns.clear()
  liveTurns.clear()
}

export interface ChatRequestBody {
  userMessage: string
  selection?: unknown
  page?: unknown
  /**
   * Detached chat sessions (Phase 1 of tasks/editor-detached-sessions.md).
   * Caller-supplied identifier scoping the turn to a specific session within
   * the project. Omitted → `sessionId = projectId` so legacy clients keep
   * "one session per project" semantics.
   */
  sessionId?: string
  /**
   * User-supplied images for this turn (paste / drag-drop / attach in the
   * chat input), as base64 data URLs (`data:image/png;base64,…`). Each is
   * validated + decoded-byte-capped server-side via the shared
   * media-content service before being handed to the SDK runtime as a
   * vision content block — this route is the trust boundary, not the
   * client. Omitted/empty → a text-only turn.
   */
  images?: string[]
  /**
   * Per-session model + effort choice from the model picker chip.
   * Validated against the provider catalogs; persisted on the session
   * so subsequent turns (and other clients) inherit it.
   */
  modelConfig?: SessionModelConfig
}

/** Max images per turn — a coarse DoS guard above the per-image byte cap. */
const MAX_IMAGES_PER_TURN = 8

interface ImageValidation {
  images: ModelImageContent[]
  /** Per-image rejection reasons (index-tagged), for the error response. */
  errors: string[]
}

/**
 * Validate the raw `images` field off the request body into decoded,
 * byte-capped {@link ModelImageContent} blocks via the shared media-content
 * service. Invalid entries are dropped and their reason collected; the
 * caller decides whether an all-invalid batch is a hard error. Returns no
 * images (and no errors) when `raw` is absent — a text-only turn.
 */
function validateRequestImages(raw: unknown): ImageValidation {
  if (raw === undefined) return { images: [], errors: [] }
  if (!Array.isArray(raw)) {
    return { images: [], errors: ["`images` must be an array of base64 data URLs."] }
  }
  const capped = raw.slice(0, MAX_IMAGES_PER_TURN)
  const images: ModelImageContent[] = []
  const errors: string[] = []
  capped.forEach((entry, i) => {
    if (typeof entry !== "string") {
      errors.push(`image[${i}]: expected a base64 data URL string.`)
      return
    }
    const result = imageFromDataUrl(entry)
    if (result.ok) images.push(result.image)
    else errors.push(`image[${i}]: ${result.reason}`)
  })
  if (raw.length > MAX_IMAGES_PER_TURN) {
    errors.push(`Too many images (${raw.length}); only the first ${MAX_IMAGES_PER_TURN} are considered.`)
  }
  return { images, errors }
}

/**
 * Accept only ASCII alphanumerics + `-` and `_`, length 1-64. Defends the
 * disk path (`<sessionId>.json`) against path traversal. UUIDs and
 * projectId hashes both match this shape.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value)
}

export interface ChatHandlerContext {
  repoRoot: string
  loaders?: ChatHandlerLoaders
  bridgeRequestTimeoutMs?: number
  /**
   * Lazily resolves the shared design-system GroundingService (bound to the
   * canonical root by the http-server). Threaded into the SDK runtime so the
   * agent's grounding query tools read the SAME memoized manifest/token sources
   * the inspector uses. Absent → no design-system grounding for the agent.
   */
  getGrounding?: () => Promise<GroundingService>
  /**
   * Per-turn quotas + cost ceiling. Phase 5. Passed through to the
   * orchestrator. CLI bootstrap typically reads these from
   * `.desde/config.json`.
   */
  quotas?: {
    maxModelCallsPerTurn?: number
    maxToolCallsPerTurn?: number
    /**
     * Raw project-config value, resolved by `resolveCostCeilingUsd`.
     * `undefined` (key omitted) means unlimited, as do explicit `null`
     * and `0`. Only a positive number is a ceiling.
     */
    costCeilingUsd?: number | null
  }
  /**
   * Audit Task 15 — retention tunables read from `.desde/config.json`'s
   * `retention` block. Only `chatSessionTurns.maxTurns` is consumed here
   * (threaded into `saveSession` so the turns-archive cap is
   * configurable); the backups/bases sweeps are triggered elsewhere
   * (CLI boot + the Commit route).
   */
  retention?: {
    chatSessionTurns?: {
      maxTurns?: number
    }
  }
  /**
   * Phase 3 — "Use repo conventions". When `useRepoConventions` is false
   * the chat agent's system prompt is not grounded in the repo's
   * documented conventions; `excludeFiles` drops specific files from
   * discovery. Omitted → conventions on, nothing excluded.
   */
  conventions?: ProjectKnowledgeConfig
  /**
   * Resolved read-roots registry for git/external-source tools.
   * Loaded once at CLI startup from `desde.config.json`.
   * Omitted when no config exists — the git tools then return a
   * "not configured" error to the model so it knows to fall back to
   * other tools.
   */
  readRoots?: import("../../../src/editor/core/read-roots").ReadRootRegistry
  /**
   * Deterministically replays editor writes into the Vite dev
   * pipeline (http-server wires `invalidateViteModules`). Passed
   * through to the SDK runtime's structural write tools so an edited
   * file re-serves immediately instead of waiting on the OS watcher.
   */
  invalidateFiles?: (files: string[]) => void
  /**
   * URL the user's Vite server is reachable at (origin-only, e.g.
   * `http://127.0.0.1:5173`). The agent's isolated review surface points a
   * headless Chromium at this SAME URL (so it sees auto-committed edits via
   * HMR) in a separate browsing context the user never sees. Omitted (tests /
   * non-CLI) → no surface is created and the agent uses the bridge.
   */
  prototypeUrl?: string
  /** Resolved Vite base (slash-wrapped, e.g. `/` or `/app/`). Defaults to `/`. */
  prototypeBase?: string
  /** Framework of the supervised prototype, reported by the surface's getPageInfo. */
  framework?: "vue3" | "react"
  /**
   * Gate for the canvas + screenshot-plan surface's two plan-authoring
   * agent tools (`save_screenshot_plan`, `heal_plan_step`) and their
   * system-prompt discipline block. DORMANT by product decision
   * 2026-08-04 — undertested, default OFF (see CLAUDE.md § "Screenshot
   * Capture"). http-server.ts computes this from `editor.canvas` in
   * `.desde/config.json` OR `EDITOR_CANVAS=1` (either enables).
   * Omitted (tests) → tools stay off, matching the default.
   */
  canvasEnabled?: boolean
}

/** Best-effort pathname+hash from the request's page snapshot (mirror the user's route). */
function routeFromPageSnapshot(page: unknown): string | undefined {
  if (!page || typeof page !== "object") return undefined
  const o = page as Record<string, unknown>
  // Prefer the LITERAL `url` (real pathname + hash) over `route` — the snapshot's
  // `route` is the display route, which normalizes dynamic segments (e.g.
  // /orders/123 → /orders/:id) and would open an unroutable path (codex).
  if (typeof o.url === "string") {
    try {
      const u = new URL(o.url)
      return `${u.pathname}${u.search}${u.hash}`
    } catch {
      // fall through to the display route
    }
  }
  const direct = o.route ?? o.pathname ?? o.path
  if (typeof direct === "string" && direct) return direct
  return undefined
}

/**
 * In-process registry of pending bridge requests, keyed by `bridgeReqId`.
 * Shared between the chat handler (which adds pending requests when the
 * orchestrator's BridgeClient calls `send()`) and the bridge-reply
 * handler (which resolves them).
 *
 * Scoped to one process — concurrent CLI processes don't share. That's
 * fine; each runs its own server on its own port.
 */
type PendingResolver = {
  resolve: (output: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingBridgeRequests = new Map<string, PendingResolver>()

/**
 * Edit-ack pending entries — parallel to `pendingBridgeRequests` but
 * keyed by `editId` instead of `bridgeReqId`. Used by `awaitEditAck`
 * so the orchestrator only persists proposal refs the shell accepted.
 */
type EditAckResolver = {
  resolve: (result: { ok: true } | { ok: false; reason: string }) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingEditAcks = new Map<string, EditAckResolver>()

/** Test hook: clear pending requests between tests. */
export function __resetPendingBridgeRequestsForTest(): void {
  for (const r of pendingBridgeRequests.values()) {
    clearTimeout(r.timer)
    r.reject(new Error("reset"))
  }
  pendingBridgeRequests.clear()
  for (const r of pendingEditAcks.values()) {
    clearTimeout(r.timer)
    r.resolve({ ok: false, reason: "reset" })
  }
  pendingEditAcks.clear()
}

export async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatHandlerContext,
): Promise<void> {
  let body: ChatRequestBody
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as ChatRequestBody
  } catch (err) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: `Invalid JSON body: ${(err as Error).message}` }))
    return
  }

  if (typeof body.userMessage !== "string") {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "userMessage is required" }))
    return
  }
  // Validate + cap user-supplied images server-side (the trust boundary).
  const { images: validatedImages, errors: imageErrors } = validateRequestImages(body.images)
  // Images were provided but none survived validation — hard error so the
  // user learns their attachment was rejected rather than silently dropped.
  if (body.images !== undefined && validatedImages.length === 0 && imageErrors.length > 0) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: imageErrors.join(" ") }))
    return
  }
  // A turn needs SOME content — text or at least one valid image.
  if (body.userMessage.trim() === "" && validatedImages.length === 0) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "userMessage is required (or attach an image)" }))
    return
  }
  if (body.sessionId !== undefined && !isValidSessionId(body.sessionId)) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        ok: false,
        reason:
          "sessionId must match /^[A-Za-z0-9_-]{1,64}$/ (UUID-shaped). Provided value rejected.",
      }),
    )
    return
  }

  // Validate an incoming `modelConfig` against the known provider
  // catalogs. Invalid ON THE REQUEST is a hard 400 — the client sent a
  // model the picker shouldn't have offered. Non-fatal validator
  // warnings (e.g. effort stripped from a model that doesn't support
  // it) are collected and surfaced on the SSE stream once it's open,
  // not thrown here.
  let requestModelConfig: SessionModelConfig | undefined
  const modelNotes: string[] = []
  if (body.modelConfig !== undefined) {
    // The SAME list the picker was served (live when reachable, static
    // otherwise), so a model the picker offered is never refused here.
    const v = validateSessionModelConfig(
      body.modelConfig,
      (await modelCatalogResolver.get()).catalogs,
    )
    if (!v.ok) {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: v.error }))
      return
    }
    requestModelConfig = v.config
    modelNotes.push(...v.warnings)
  }

  const loaders = ctx.loaders ?? defaultChatLoaders

  // Per-session turn lock — refuse a second in-flight turn on the same
  // session. Two distinct sessionIds on the same project are allowed to
  // run in parallel (detached chat sessions Phase 1). Legacy clients
  // that don't send sessionId fall back to `sessionId = projectId`, so
  // singleton-per-project behavior is preserved.
  //
  // Lock key includes projectId so two prototypes that happen to use the
  // same explicit sessionId can't collide on the process-shared
  // `activeTurns` set.
  //
  // `projectIdForRepoRoot` is a pure function imported directly so
  // tests can stub the session-store's `loadSession`/`saveSession`
  // without losing this primitive.
  const projectId = projectIdForRepoRoot(ctx.repoRoot)
  const sessionId = body.sessionId ?? projectId
  const lockKey = `${projectId}:${sessionId}`
  if (activeTurns.has(lockKey)) {
    res.statusCode = 409
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        ok: false,
        reason: "Another chat turn is already in flight on this session. Wait for it to finish or abort it first.",
      }),
    )
    return
  }
  activeTurns.add(lockKey)

  // Open the SSE stream INSIDE the try so a thrown openSseStream
  // (header-set/flush failures) still releases the mutex via finally.
  let stream: ReturnType<typeof openSseStream> | null = null
  let slotRelease: (() => void) | null = null
  let reviewSurface:
    | import("../../../src/editor/core/review-surface").ReviewSurface
    | null = null
  // This turn's input channel. Created and registered below with no await
  // between it and `activeTurns.add`, and closed + reconciled in the finally —
  // see the `liveTurns` docblock for why both ends belong to this function.
  let turnChannel: TurnInputChannel | null = null
  // Shared by reference with this turn's `liveTurns` entry, so the `/steer`
  // route appends into the same array the outer catch reads. See `LiveTurn`.
  const acceptedSteers: ChatSteeredMessage[] = []
  // Both are for the outer catch's turn-recovery write below. The
  // timestamp is taken here so a recovered turn reports when the user
  // actually submitted, not when the failure was noticed; the id lets
  // the recovery tell "the turn was never written" from "the turn was
  // written and something after that threw", so it can't double-append.
  const turnStartedAt = new Date().toISOString()
  let completedTurnId: string | undefined
  try {
    stream = openSseStream(req, res)
    // Surface the resolved sessionId as the very first SSE event so the
    // client can correlate the response stream with its in-memory session
    // record (or, for legacy clients that didn't send one, learn the
    // server-derived default).
    stream.send({ kind: "session", sessionId, projectId })

    // Register this turn as steerable NOW. `openSseStream` and the `session`
    // send above are synchronous, so nothing has been awaited since the lock
    // was taken and there is no moment where one of the two says a turn is
    // running and the other does not. The channel has no opening message yet —
    // the turn runtime seeds it via `begin()` — and a steer accepted before
    // then simply waits behind it. See `turn-input-channel.ts`.
    turnChannel = createTurnInputChannel()
    liveTurns.set(lockKey, {
      channel: turnChannel,
      emit: (ev) => {
        stream!.send(ev)
      },
      steers: acceptedSteers,
    })

    const abort = new AbortController()
    // Pipe `stream.aborted` into our AbortController so the orchestrator
    // can wind down when the client disconnects.
    void stream.aborted.then(() => abort.abort())

    // Phase 5 — acquire a slot from the per-project concurrency cap
    // BEFORE running the orchestrator. If the project is at cap, await
    // FIFO drain; the client sees a `queued` SSE event in the meantime.
    // The slot is released in the finally block alongside activeTurns.
    // Mirrors the web route's wiring.
    try {
      const slot = await getSharedConcurrencyCap().acquireSlot({
        projectId,
        sessionId,
        signal: abort.signal,
        onQueued: (queuePosition) => {
          stream!.send({ kind: "queued", sessionId, queuePosition })
        },
      })
      slotRelease = slot.release
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        stream.send({
          kind: "error",
          reason: `Concurrency cap acquire failed: ${(err as Error).message}`,
        })
      }
      return
    }

    const { loadSession, saveSession } = await loaders.loadSessionStore()
    const loadResult = await loadSession(ctx.repoRoot, { sessionId })
    let session = loadResult.session

    // Phase 5 codex round-1 #2: cancelled is terminal. Reject any
    // attempt to submit against a cancelled session — the agent
    // transcript is gone (the worktree state was abandoned at
    // restart) and resurrecting status would mask the cancellation.
    if (session.status === "cancelled") {
      stream.send({
        kind: "error",
        reason:
          "This chat session was cancelled (restart-clear). Start a new chat to continue.",
      })
      return
    }

    // Precedence: request modelConfig > session-persisted modelConfig >
    // absent (runtime default). A request carrying modelConfig also
    // overwrites the session's persisted value — this must happen
    // BEFORE the in-flight save below so the merge is what gets
    // persisted.
    if (requestModelConfig) {
      session = { ...session, modelConfig: requestModelConfig }
    }
    // Resolve the effective config for THIS turn. A persisted model that
    // has since left the catalog falls back to the runtime default —
    // never block the chat on stale persisted state — but say so once
    // on the stream so the fallback isn't silent.
    let effectiveModelConfig = requestModelConfig
    if (!effectiveModelConfig && session.modelConfig) {
      const pv = validateSessionModelConfig(
        session.modelConfig,
        (await modelCatalogResolver.get()).catalogs,
      )
      if (pv.ok) {
        // Forward the validator's SANITIZED config, not the raw
        // persisted object: a hand-edited session file carrying an
        // effort value on a model that has no effort parameter would
        // otherwise forward that effort into the SDK query.
        effectiveModelConfig = pv.config
        modelNotes.push(...pv.warnings)
      } else {
        modelNotes.push(
          `Saved model for this chat is no longer available. ${pv.error} Using the default model for this turn.`,
        )
        // Drop the dead choice so the notice is ONE-TIME (design spec)
        // rather than an every-turn nag. These notes ride the `error`
        // event kind (the SSE union has no note channel), so leaving
        // the stale value in place would raise a fresh error banner on
        // every subsequent turn of the session. Discarding it is the
        // same reconciliation the client performs on a seeded value,
        // and the turn still falls back to the runtime default exactly
        // as it did while the stale value sat there.
        session = { ...session, modelConfig: undefined }
      }
    }
    // Non-fatal notes (effort stripped from a model that doesn't
    // support it; stale persisted model fell back to the default).
    // These are informational, not failures — but the SSE event union
    // has no non-error note channel today, so they ride `error` and
    // render as an error banner. See the ChatStreamEvent union in
    // src/editor/agent-chat/chat-stream-events.ts.
    for (const w of modelNotes) {
      stream!.send({ kind: "error", reason: w })
    }

    // Phase 5 — mark the session in-flight BEFORE the orchestrator
    // runs. Persisted now so a CLI crash mid-turn leaves an
    // `in-flight` marker that the next restart-clear pass rewrites
    // to `cancelled`. Codex round-1 #3 fix: this write is FATAL —
    // swallowing would let the orchestrator run while the on-disk
    // status said `idle`, and a crash mid-turn would silently leave
    // a half-formed transcript with no in-flight marker.
    session = withSessionStatus(session, "in-flight")
    try {
      // Codex round 2 (Task 15 Batch 5 gate, P2): reassign `session` to
      // the ACTUALLY-PERSISTED (trimmed) session `saveSession` returns.
      // If this save archived overflow turns (a pre-existing session
      // already over the turns cap), the stale untrimmed `session`
      // object must not keep flowing into `runChatTurnSdk` below —
      // that would (a) re-derive the same archive split against the
      // final save and duplicate the just-appended JSONL lines, and
      // (b) feed `computeSessionCost` the stale, still-oversized
      // `turns` array, which can inflate the ceiling check mid-turn.
      session = await saveSession(ctx.repoRoot, session, {
        maxTurns: ctx.retention?.chatSessionTurns?.maxTurns,
      })
    } catch (err) {
      stream.send({
        kind: "error",
        reason: `Could not persist in-flight marker: ${(err as Error).message}`,
      })
      return
    }

    // Project-knowledge digest — folded into the chat agent's system
    // prompt (the adapter realpath-contains `repoRoot` internally).
    // Skipped when the project config turns conventions off; `excludeFiles`
    // drops specific files. Optional loader: unconfigured → runs ungrounded.
    //
    // CLAUDE.md is INCLUDED here again as of the 2026-08-09 security fix. It
    // used to be excluded because `settingSources: ['project']` made the SDK
    // load it from disk directly, and injecting it twice was waste. That
    // setting is now `[]` (audit B6 — it also loaded `.claude/settings.json`,
    // whose `hooks` the SDK executes as shell commands), so the digest is once
    // again the only path by which the file reaches the model.
    //
    // That is the better path anyway: the digest wraps repo-authored text in
    // the untrusted-content fence, whereas the SDK's own loader presented it
    // as trusted project instructions. A rules file is repo content, and repo
    // content is data.
    let projectKnowledge:
      | import("../../../src/editor/core/project-knowledge").ProjectKnowledge
      | undefined
    if (
      loaders.loadProjectKnowledge &&
      ctx.conventions?.useRepoConventions !== false
    ) {
      const { loadCachedProjectKnowledge } = await loaders.loadProjectKnowledge()
      const excludeFiles = [...(ctx.conventions?.excludeFiles ?? [])]
      projectKnowledge = loadCachedProjectKnowledge({
        prototypeRoot: ctx.repoRoot,
        excludeFiles,
      })
    }

    const bridge = makeHandlerBridge(stream, abort.signal, ctx.bridgeRequestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS)
    const awaitEditAck = makeAwaitEditAck(
      abort.signal,
      ctx.bridgeRequestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS,
    )

    // Per-turn verification adapter, scoped to the active worktree
    // (so a session pointed at a different path doesn't accidentally
    // run npm scripts in the canonical root). Created lazily here
    // rather than at handler startup because the session resolves the
    // exact worktree path. Loader is optional: tests that omit it
    // get a `run_verification` tool that returns "not configured".
    const verificationRoot = ctx.repoRoot
    const verificationAdapter = loaders.loadVerificationAdapter
      ? (await loaders.loadVerificationAdapter()).createNodePackageVerificationAdapter({
          repoRoot: verificationRoot,
        })
      : undefined
    const packageManagerAdapter = loaders.loadPackageManagerAdapter
      ? (await loaders.loadPackageManagerAdapter()).createNodePackageManagerAdapter({
          repoRoot: verificationRoot,
        })
      : undefined

    // Web policy is loaded per turn so config edits take effect on
    // the next user message. Errors are surfaced to the SSE stream
    // (not fatal) — same UX as readRoots loading.
    let webPolicy: import("../../../src/editor/core/web-policy").WebPolicy | undefined
    if (loaders.loadWebPolicy) {
      const { loadWebPolicy } = await loaders.loadWebPolicy()
      const wp = await loadWebPolicy({ worktreeRoot: verificationRoot })
      if (wp.ok) {
        webPolicy = wp.policy
      } else {
        stream!.send({
          kind: "error",
          reason: `desde.config.json invalid (web policy disabled): ${wp.errors.join("; ")}`,
        })
      }
    }

    // Figma config is loaded per turn (same lazy pattern as webPolicy).
    // Load errors emit to the SSE stream but don't block the turn —
    // the agent just won't see the Figma MCP server registered. Load
    // warnings (e.g. literal secret in env) also surface so the user
    // notices the foot-gun.
    // Customer-declared MCP extensions (.mcp.json). Loaded per turn like the
    // Figma config, and for the same reason: a user who edits the file should
    // see it take effect on the next message, not the next CLI restart. A
    // broken file surfaces on the stream and disables extensions for the
    // turn -- it never blocks the turn, because chat has to keep working when
    // an optional capability is misconfigured.
    let extensions:
      | ReadonlyArray<
          import("../../../src/editor/core/extensions-config").EditorExtension
        >
      | undefined
    if (loaders.loadExtensions) {
      const { loadExtensions } = await loaders.loadExtensions()
      const ext = await loadExtensions({ worktreeRoot: verificationRoot })
      if (ext.ok) {
        extensions = ext.extensions
        for (const w of ext.warnings) console.warn(`[editor-cli] ${w}`)
      } else {
        stream!.send({
          kind: "error",
          reason: `.mcp.json invalid (extensions disabled): ${ext.errors.join("; ")}`,
        })
      }
    }

    // Which curated capabilities are OFF for this prototype. The model is
    // told, because an unregistered MCP server is invisible to it -- never
    // spawned, absent from the tool list and from tool-search -- so without
    // this it would fail an ask with no idea a capability could exist.
    const { computeEnabledCapabilityIds, describeDisabledCapabilities } = await import(
      "../../../src/editor/core/capability-catalog.js"
    )
    const enabledCapabilityIds = computeEnabledCapabilityIds({
      enabledExtensionIds: (extensions ?? []).map((e) => e.id),
      webFetchAllowedHosts: webPolicy?.webFetchAllowedHosts ?? [],
      webSearchEnabled: webPolicy?.webSearchEnabled ?? false,
    })
    const disabledCapabilities = describeDisabledCapabilities(enabledCapabilityIds)

    // Offer the fix in the flow. Detection reads the USER's message and
    // NOTHING else — assistant prose, tool output and MCP results are excluded
    // by construction, because this drives an affordance that writes the file
    // deciding which subprocesses run. Informational: the turn proceeds either
    // way, and the model has been told about the gap via the prompt block.
    if (stream) {
      const { detectCapabilityGaps, findCapability } = await import(
        "../../../src/editor/core/capability-catalog.js"
      )
      // Detect against LIVE ids first — the overwhelmingly common case is no
      // gap at all, and that path must add no I/O to a turn.
      const candidates = detectCapabilityGaps(body.userMessage, enabledCapabilityIds)
      // Only now consult what is DECLARED. An entry whose ${VAR} is unset is
      // written to .mcp.json but skipped by the loader, so offering to enable
      // it would post to a route that answers 409. (The prompt block above
      // deliberately stays on LIVE ids: there the question is what the model
      // can actually call.)
      let declared: string[] = []
      if (candidates.length > 0) {
        const { declaredExtensionIds } = await import(
          "../../../src/editor/core/enable-capability.js"
        )
        declared = await declaredExtensionIds(verificationRoot)
      }
      for (const gap of candidates.filter((g) => !declared.includes(g.capabilityId))) {
        const descriptor = findCapability(gap.capabilityId)
        if (!descriptor) continue
        stream.send({
          kind: "capability_gap",
          capabilityId: descriptor.id,
          label: descriptor.label,
          detail: gap.detail,
          requiresEnv: descriptor.requiresEnv ?? null,
          envReady: descriptor.requiresEnv
            ? process.env[descriptor.requiresEnv] !== undefined
            : true,
          activation: descriptor.activation,
        })
      }
    }

    let figmaConfig:
      | import("../../../src/editor/core/figma-config").FigmaConfig
      | undefined
    if (loaders.loadFigmaConfig) {
      const { loadFigmaConfig } = await loaders.loadFigmaConfig()
      const fc = await loadFigmaConfig({ worktreeRoot: verificationRoot })
      if (fc.ok) {
        figmaConfig = fc.config ?? undefined
        // Warnings (e.g. literal secret in env value) go to stderr,
        // not the SSE stream. Matches how loadWebPolicy warnings are
        // handled — they're foot-guns worth knowing about but not
        // worth interrupting the chat UI for.
        for (const w of fc.warnings) {
          console.warn(`[editor-cli] ${w}`)
        }
      } else {
        stream!.send({
          kind: "error",
          reason: `desde.config.json invalid (Figma MCP disabled): ${fc.errors.join("; ")}`,
        })
      }
    }

    // The agent's isolated review surface — a headless Playwright sidecar the
    // agent drives for navigate / interact / capture / verify reads, so it
    // never disrupts the page the user is watching. Created per turn, booted
    // lazily (zero cost if the turn never screenshots), disposed in `finally`.
    // SDK-only; falls back to the bridge when disabled or no URL is known.
    if (loaders.loadReviewSurface && ctx.prototypeUrl) {
      try {
        const { createReviewSurface, canLaunchReviewSurface } = await loaders.loadReviewSurface()
        // Only create the surface when a headless browser can actually launch
        // (one-time memoized probe). Otherwise leave reviewSurface null so the
        // agent transparently keeps the bridge path — environments with no
        // Chromium must not lose navigate/capture/get_page_info to a boot error.
        if (await canLaunchReviewSurface()) {
          reviewSurface = createReviewSurface({
            viteUrl: ctx.prototypeUrl,
            viteBase: ctx.prototypeBase,
            framework: ctx.framework,
            // Mirror the page the user is currently on, so flows that assume
            // "the page the user is viewing" work without an extra navigate.
            initialRoute: routeFromPageSnapshot(body.page),
            // Cancelling the turn closes the surface → in-flight Playwright ops
            // reject promptly instead of hanging until their timeout.
            signal: abort.signal,
          })
        }
      } catch (err) {
        // Surface construction should never block the turn — log and fall
        // back to the bridge path.
        console.warn(`[editor-cli] review surface unavailable: ${(err as Error).message}`)
      }
    }

    // Both-ends gating for the BYO-key cutover. The client already declines to
    // present chat as configured (the credential probe reports `none`), and
    // this is the server half: with no key the SDK would spawn the bundled
    // `claude` binary, which authenticates with whatever subscription it is
    // signed in with. Anthropic's Agent SDK terms do not permit a distributed
    // product to offer claude.ai login, so the dispatch refuses rather than
    // trusting a client that could be stale or hand-built. See
    // src/editor/llm-providers/assert-chat-credentials.ts.
    assertChatCredentials(process.env)

    // The SDK runtime is the only chat runtime (the legacy in-house
    // orchestrator was removed 2026-07-21 — see CLAUDE.md § Editor —
    // Agent Orchestrator).
    const { runChatTurnSdk } = await loaders.loadRunChatTurnSdk()
    const result = await runChatTurnSdk({
      bridge,
      reviewSurface: reviewSurface ?? undefined,
      worktreeRoot: ctx.repoRoot,
      // Deterministic Vite invalidation for the structural write
      // tools (branch mode — see vite-invalidate.ts).
      invalidateFiles: ctx.invalidateFiles,
      // Audit Task 13 — the SDK's BUILT-IN Write/Edit run inside the SDK
      // runtime, so the only way they can serialize against a concurrent
      // `/api/editor/edit` write is a lock held across the tool call by
      // the runtime's PreToolUse/PostToolUse hooks. Injecting the acquirer
      // here (rather than importing session-lock inside agent-chat-sdk)
      // keeps the lock namespace owned by the CLI while putting chat writes
      // in the SAME namespace as route edits.
      //
      // Foreground chat holds NO tree gate, so the guard takes tree-SHARED +
      // the per-file mutex around each individual write (milliseconds), never
      // for the whole turn — a chat turn can run for minutes and holding the
      // gate that long would block Commit/Publish for its duration.
      acquireWriteLock: (repoRelPath: string) =>
        acquireFileEditLock(ctx.repoRoot, repoRelPath),
      // A2 (round-2 whole-branch review finding, 2026-08-19) — same
      // reasoning as `acquireWriteLock` just above, for the SDK's
      // *structural* write tools (insert_component, delete_file, …):
      // without this their `brokeredWrite` calls had no ordering against
      // a concurrent Commit/Publish/branch mutation at all. Foreground
      // chat only, for the same reason `acquireWriteLock` is foreground
      // only — the edit-fix mini-turn already runs under the EXCLUSIVE
      // tree gate, and acquiring the SHARED gate from inside that would
      // self-deadlock (see `RunChatTurnSdkOpts.acquireTreeGate`'s doc
      // comment).
      acquireTreeGate: () => acquireTreeGateShared(ctx.repoRoot),
      session,
      userMessage: body.userMessage,
      // Validated, byte-capped user images ride into the turn as vision
      // blocks. Empty array ⇒ a text-only turn (string prompt).
      ...(validatedImages.length > 0 ? { images: validatedImages } : {}),
      selection: body.selection as never,
      page: body.page as never,
      projectKnowledge,
      getGrounding: ctx.getGrounding,
      readRoots: ctx.readRoots,
      verificationAdapter,
      packageManagerAdapter,
      webPolicy,
      figmaConfig,
      extensions,
      disabledCapabilities,
      canvasEnabled: ctx.canvasEnabled,
      awaitEditAck,
      emit: (ev) => {
        stream!.send(ev)
      },
      // Already registered as steerable (above, at lock time). The runtime
      // seeds its opening message and takes over closing it; anything steered
      // during the setup awaits is sitting in it already and will be delivered
      // right after that opening message.
      inputChannel: turnChannel,
      signal: abort.signal,
      costCeilingUsd: resolveCostCeilingUsd(ctx.quotas?.costCeilingUsd),
      ...(effectiveModelConfig
        ? {
            model: effectiveModelConfig.model,
            ...(effectiveModelConfig.effort ? { effort: effectiveModelConfig.effort } : {}),
            // The picker's catalog knows whether this model (or alias) thinks
            // adaptively; the turn cannot always tell from the id alone.
            ...(await adaptiveThinkingFor(effectiveModelConfig.model)),
          }
        : {}),
    })

    // The runner appended this turn to the session it returned. If the
    // save below throws, the outer catch checks this id against what is
    // on disk so it doesn't append the same turn a second time.
    completedTurnId = result.turn.id

    // Phase 5 — flip the in-flight marker to the appropriate terminal
    // status based on the turn outcome. `idle` on success, `failed`
    // (with the turn's error message as the tooltip reason) on error.
    // The classifier detects rate-limit failures so the picker can
    // render a distinct "Rate limited" badge.
    const turnError =
      typeof (result.turn as { error?: string }).error === "string" &&
      (result.turn as { error?: string }).error!.length > 0
        ? (result.turn as { error?: string }).error
        : undefined
    let finalized: import("../../../src/editor/agent-chat/types").ChatSession
    if (turnError) {
      const classified = classifyTurnError(turnError)
      finalized = withSessionStatus(
        result.session,
        "failed",
        classified.message,
        {
          failureKind: classified.kind,
          ...(classified.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: classified.retryAfterSeconds }
            : {}),
        },
      )
    } else {
      finalized = withSessionStatus(result.session, "idle")
    }
    try {
      // Not reassigned (unlike the pre-turn save above): `finalized`
      // isn't read again after this call — the turn ends here in the
      // success path, so there's no LATER save in this request that
      // could re-derive the archive split against a stale reference.
      // (Reassigning anyway would be dead-store lint noise, not extra
      // safety — see the pre-turn save's comment for where the
      // discipline actually matters.)
      await saveSession(ctx.repoRoot, finalized, {
        maxTurns: ctx.retention?.chatSessionTurns?.maxTurns,
      })
    } catch (err) {
      // Phase 5 codex round-1 #4: throw so the outer catch arm runs
      // the best-effort `failed` recovery write. Swallowing here
      // would release activeTurns with status still `in-flight` on
      // disk — the user would see a "Running" badge forever (until
      // the next restart-clear sweep).
      stream.send({
        kind: "error",
        turnId: result.turn.id,
        reason: `Failed to persist session: ${(err as Error).message}`,
      })
      throw err
    }
  } catch (err) {
    // If openSseStream itself threw, `stream` is null and we can't
    // send a structured error — fall back to a plain HTTP error so the
    // client sees SOMETHING.
    if (stream) {
      stream.send({
        kind: "error",
        reason: `Chat handler failed: ${(err as Error).message}`,
      })
      // Phase 5 — mark the session failed so the drawer surfaces it.
      // Best-effort: in-flight is the on-disk backstop if this write
      // also fails (restart-clear will downgrade to cancelled). The
      // classifier detects rate-limit failures so the picker can
      // render a distinct "Rate limited" badge instead of generic
      // "Failed".
      try {
        // Not subject to the stale-in-memory-session bug (codex round
        // 2, P2): `latest` is a FRESH `loadSession` read taken right
        // above, not a snapshot carried across an earlier `saveSession`
        // call in this request — there's no stale reference to keep in
        // sync, and nothing reads the return value after this.
        const { loadSession, saveSession } = await loaders.loadSessionStore()
        const { session: latest } = await loadSession(ctx.repoRoot, { sessionId })
        const classified = classifyTurnError(err)
        const reason = `Chat handler failed: ${classified.message}`
        // Record the submission that died here.
        //
        // Every other failure — including the cost-ceiling refusal —
        // comes back through `runChatTurnSdk`, which appends the turn
        // before returning. This arm is the one path that reaches
        // `failed` without one: the throw skipped that append, and
        // `latest` is a fresh read of the pre-turn save. Without this,
        // the user's prompt vanishes from the transcript entirely, and
        // every surface that names "the last turn" — the toast, the
        // switcher's fallback — names the PREVIOUS one instead. That
        // is the shape of the bug this whole change is about, so
        // leaving one path that still produces it would be pointless.
        const alreadyRecorded =
          completedTurnId !== undefined &&
          latest.turns[latest.turns.length - 1]?.id === completedTurnId
        const recovered = alreadyRecorded
          ? latest
          : {
              ...latest,
              turns: [
                ...latest.turns,
                {
                  id: randomUUID(),
                  startedAt: turnStartedAt,
                  completedAt: new Date().toISOString(),
                  userMessage: body.userMessage,
                  // Anything steered into this turn before it died. `userMessage`
                  // is the OPENING prompt only, so without this a message the
                  // user typed mid-turn — and was told was accepted — would be
                  // absent from the transcript on every failure that lands
                  // here. Same non-negotiable as delivery loss, in the
                  // persistence dimension. Absent, not empty, when nothing was
                  // steered, so a turn that took none serializes exactly as it
                  // did before the field existed.
                  ...(acceptedSteers.length > 0 ? { steers: acceptedSteers } : {}),
                  ...(body.selection ? { selection: body.selection as never } : {}),
                  ...(body.page ? { page: body.page as never } : {}),
                  assistantContent: [],
                  toolResults: {},
                  editProposals: [],
                  error: reason,
                },
              ],
            }
        await saveSession(
          ctx.repoRoot,
          withSessionStatus(
            recovered,
            "failed",
            reason,
            {
              failureKind: classified.kind,
              ...(classified.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: classified.retryAfterSeconds }
                : {}),
            },
          ),
          { maxTurns: ctx.retention?.chatSessionTurns?.maxTurns },
        )
      } catch {
        // Swallow — see above.
      }
    } else if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({ ok: false, reason: `Chat handler failed: ${(err as Error).message}` }),
      )
    }
  } finally {
    // Close the channel and hand back every steer that cannot be shown to have
    // reached the model, BEFORE releasing the registry — so a steer can never
    // be accepted into a channel that is about to be closed away unreported.
    //
    // Usually a no-op: the turn runtime already reconciled on `result`, at
    // abort, or in its own finally, and the drain is one-shot. It is not a
    // no-op on the paths that never reach the runtime — a cancelled session, a
    // concurrency-cap failure, a failed in-flight persist, the cost-ceiling
    // refusal — and every one of those can now be holding a message the user
    // typed, because the channel has been steerable since the lock was taken.
    //
    // If the client has already disconnected these sends drop. That is not a
    // loss we can fix from here; the client's own steer fallback resubmits.
    if (turnChannel) {
      turnChannel.close()
      for (const steer of turnChannel.takeUndeliveredSteers()) {
        // Typed on the way out: `SseStream.send` takes `unknown`, so this is
        // the only thing holding the payload to the SSE union.
        const event: ChatStreamEvent = {
          kind: "resubmit_required",
          sessionId,
          userMessage: steer.text,
          ...(steer.images ? { images: steer.images } : {}),
        }
        stream?.send(event)
      }
    }
    activeTurns.delete(lockKey)
    // Released in the same breath as the lock, deliberately — see `liveTurns`.
    // A no-op when the turn never got as far as opening its stream.
    liveTurns.delete(lockKey)
    slotRelease?.()
    stream?.close()
    // Tear down the per-turn review surface (closes the headless browser if it
    // booted). Best-effort — never let a dispose error mask the turn outcome.
    if (reviewSurface) {
      await reviewSurface.dispose().catch(() => {})
    }
  }
}

/**
 * BridgeClient impl that turns each `send()` into a `bridge_request`
 * SSE event and awaits the corresponding `bridge-reply` POST.
 *
 * The event payload mirrors the wire shape the shell consumes; payload
 * is opaque from this layer's perspective.
 */
function makeHandlerBridge(
  stream: ReturnType<typeof openSseStream>,
  signal: AbortSignal,
  timeoutMs: number,
): import("../../../src/editor/agent-tools/types").BridgeClient {
  return {
    send(messageType, payload, options) {
      const t = options?.timeoutMs ?? timeoutMs
      return new Promise((resolve, reject) => {
        const bridgeReqId = randomUUID()

        // Single cleanup closure ensures the timer, the abort listener,
        // and the pendingBridgeRequests entry are all released together
        // regardless of which path settles the promise (resolve, reject,
        // timeout, abort). Without this, the abort listener leaks on
        // resolved/timed-out requests.
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const cleanup = (): void => {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          pendingBridgeRequests.delete(bridgeReqId)
        }

        const onAbort = (): void => {
          if (settled) return
          cleanup()
          reject(new Error("bridge request aborted"))
        }

        timer = setTimeout(() => {
          if (settled) return
          cleanup()
          reject(new Error(`bridge_request '${messageType}' timed out after ${t}ms`))
        }, t)

        pendingBridgeRequests.set(bridgeReqId, {
          resolve: (output) => {
            if (settled) return
            cleanup()
            resolve(output)
          },
          reject: (err) => {
            if (settled) return
            cleanup()
            reject(err)
          },
          timer,
        })

        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort)

        const ok = stream.send({
          kind: "bridge_request",
          // turnId is appended on the orchestrator emit path; bridge
          // requests originate INSIDE a turn but we don't have direct
          // access to the turnId here. The shell doesn't need it for
          // routing — `bridgeReqId` is the unique key. Emit a stable
          // placeholder so the consumer can render the request.
          turnId: "bridge",
          bridgeReqId,
          messageType,
          payload,
        })
        if (!ok && !settled) {
          // Stream closed before we could even send the request. The
          // abort listener above will already have rejected, but cover
          // the rare race where the stream closed without firing abort.
          cleanup()
          reject(new Error("stream closed before bridge_request was sent"))
        }
      })
    },
  }
}

/**
 * Builds a closure that turns each editId into a promise resolved by
 * the shell's `POST /api/editor/chat/edit-ack`. Same lifecycle
 * machinery as `makeHandlerBridge` — single cleanup closure releases
 * the timer, abort listener, and pending map entry on any settle path.
 */
function makeAwaitEditAck(
  signal: AbortSignal,
  timeoutMs: number,
): (editId: string) => Promise<{ ok: true } | { ok: false; reason: string }> {
  return (editId) =>
    new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        pendingEditAcks.delete(editId)
      }
      const onAbort = (): void => {
        if (settled) return
        cleanup()
        resolve({ ok: false, reason: "turn aborted before shell ack" })
      }
      timer = setTimeout(() => {
        if (settled) return
        cleanup()
        resolve({
          ok: false,
          reason: `edit-ack '${editId}' timed out after ${timeoutMs}ms`,
        })
      }, timeoutMs)
      pendingEditAcks.set(editId, {
        resolve: (r) => {
          if (settled) return
          cleanup()
          resolve(r)
        },
        timer,
      })
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort)
    })
}

export interface EditAckBody {
  editId: string
  ok: boolean
  reason?: string
}

/**
 * Resolves an in-flight edit-ack posted by the orchestrator's
 * `awaitEditAck`. The shell calls this after `useEditorChat`'s
 * `onEditProposed` callback returns, signaling whether the edit
 * actually landed in the pending buffer.
 *
 * Same security model as `handleBridgeReply` (single-tenant local
 * CLI; token-gated; any valid token holder can resolve any editId).
 */
export async function handleEditAck(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: EditAckBody
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as EditAckBody
  } catch (err) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: `Invalid JSON: ${(err as Error).message}` }))
    return
  }
  if (!body.editId) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "editId is required" }))
    return
  }
  const entry = pendingEditAcks.get(body.editId)
  if (!entry) {
    res.statusCode = 404
    res.setHeader("Content-Type", "application/json")
    res.end(
      JSON.stringify({
        ok: false,
        reason: "Unknown editId (already resolved or timed out)",
      }),
    )
    return
  }
  pendingEditAcks.delete(body.editId)
  if (body.ok) {
    entry.resolve({ ok: true })
  } else {
    entry.resolve({ ok: false, reason: body.reason ?? "rejected by shell" })
  }
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ ok: true }))
}

export interface BridgeReplyBody {
  bridgeReqId: string
  ok: boolean
  output?: unknown
  error?: string
}

/**
 * Resolves an in-flight `bridge_request` posted by the orchestrator.
 *
 * **Security model:** the endpoint is bearer-token gated by the
 * existing `/api/*` `checkAuth` policy. With a valid token, ANY client
 * can resolve ANY pending `bridgeReqId`. This is acceptable for
 * editor-cli's single-tenant local-CLI model — the token is scoped
 * to one user-session and the only client meant to hold it is the
 * shell. If we ever expose this in a multi-tenant context (web app
 * production), tighten by associating each `bridgeReqId` with the
 * issuing chat session and rejecting replies from other sessions.
 */
export async function handleBridgeReply(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: BridgeReplyBody
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as BridgeReplyBody
  } catch (err) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: `Invalid JSON: ${(err as Error).message}` }))
    return
  }
  if (!body.bridgeReqId) {
    res.statusCode = 400
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "bridgeReqId is required" }))
    return
  }
  const entry = pendingBridgeRequests.get(body.bridgeReqId)
  if (!entry) {
    // No matching request — either it timed out, the turn aborted, or
    // the shell sent a duplicate. Return 404 so the shell can log it.
    res.statusCode = 404
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: false, reason: "Unknown bridgeReqId (already resolved or timed out)" }))
    return
  }
  pendingBridgeRequests.delete(body.bridgeReqId)
  if (body.ok) {
    entry.resolve(body.output)
  } else {
    entry.reject(new Error(body.error ?? "bridge reply: not ok"))
  }
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ ok: true }))
}

export interface SteerRequestBody {
  /**
   * Which running turn to steer. REQUIRED, unlike `POST /api/editor/chat`,
   * where an omitted `sessionId` falls back to `projectId` for clients written
   * before detached sessions existed. This route has no such client — it is
   * new — and defaulting here would silently deliver the message into the
   * project-default session's turn instead of refusing. That is a wrong-thread
   * delivery, which is precisely what the `steered` SSE event exists to
   * prevent, so the route must not manufacture one.
   */
  sessionId: string
  userMessage: string
  /** Same base64 data-URL form, same validation and same cap as the chat route. */
  images?: string[]
}

/**
 * What this route can honestly answer: was the message TAKEN ON by a running
 * turn? There is no separate `ok` field — `accepted` IS this route's ok, and
 * two booleans meaning one thing drift apart eventually.
 *
 * **`accepted` is not `delivered`, and the field used to say `delivered`.** That
 * was a claim the route cannot make. Acceptance is an enqueue into the turn's
 * input channel; delivery happens later, at the turn's next model boundary, and
 * is not observable from here — nothing acknowledges that a message written to
 * the child's stdin was folded into the model's context. Between the two an
 * abort, a crash, or a model that simply decides it is finished can discard the
 * message. Answering `delivered: true` at enqueue time told the client its
 * message had landed when it might not have, which disarms the client's
 * no-loss fallback: a client that believes a message was delivered has no
 * reason to send it again.
 *
 * **Where the real confirmation comes from: the owning turn's SSE stream.** The
 * turn reconciles every accepted steer against what it can observe (did the SDK
 * pull it out of the channel; did any model output follow) and emits
 * `resubmit_required` for each one it cannot account for — see
 * `takeUndeliveredSteers` in `src/editor/agent-chat-sdk/turn-input-channel.ts`
 * and the event's docblock in `src/editor/agent-chat/chat-stream-events.ts`.
 *
 * So the client contract is: on `accepted: true`, show the message and keep it
 * resubmittable until the turn ends. On `resubmit_required`, send it again. On
 * `accepted: false`, send it as an ordinary next turn. The reconciliation is
 * deliberately biased towards over-reporting, so a client that follows this may
 * send a message twice and will never lose one. Repeat over drop, always.
 */
export type SteerResult =
  | { accepted: true }
  | { accepted: false; reason: string }

function sendSteerResult(
  res: ServerResponse,
  status: number,
  result: SteerResult,
): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(result))
}

export interface SteerHandlerContext {
  repoRoot: string
}

/**
 * Push another user message into a chat turn that is still running.
 *
 * The SDK delivers it at the turn's next model boundary, right after the
 * in-flight tool result returns, and the agent decides what to do with it —
 * we do not hold it back and we do not decide on the user's behalf whether it
 * is an interruption (see `tasks/chat-input-steering.md`).
 *
 * **A 200 here means ACCEPTED, not delivered.** See {@link SteerResult}: this
 * route enqueues, and the owning turn's SSE stream is what later confirms — by
 * staying silent — or asks for a resubmit.
 *
 * **A 409 here is a normal race, not an error.** The turn can end between the
 * client deciding to steer and this request landing, and there is no way to
 * close that window from either side. So `no-live-turn` is not logged, not
 * counted, and not surfaced as a failure: the client falls back to submitting
 * the message as an ordinary next turn, which is the no-loss guarantee this
 * feature rests on. Treating it as an error would produce a scary banner on
 * the single most ordinary thing that can happen.
 *
 * The *other* 409 this route used to answer is gone: a turn whose lock was held
 * but whose channel had not been published yet. That is why `no-live-turn` can
 * stay a single undifferentiated reason — a live turn is steerable from the
 * instant it takes the lock, so the only way to see a 409 now is a turn that
 * has genuinely ended (or never existed), and the client's answer to both of
 * those is the same: submit it as a new turn.
 *
 * **Security model** matches `handleBridgeReply`: the route is bearer-token +
 * strict-Origin gated by the `bearer-origin-required` policy declared on its
 * entry in the CLI's route table, exactly as `POST /api/editor/chat` is. Given
 * a valid token, any client may steer any session of this project — acceptable
 * for a single-tenant local CLI whose token is scoped to one boot.
 */
export async function handleSteerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SteerHandlerContext,
): Promise<void> {
  let body: SteerRequestBody
  try {
    const raw = await readBody(req)
    const parsed: unknown = JSON.parse(raw)
    // `JSON.parse` succeeds on `null`, `3` and `"x"`, and reading a field off
    // those throws — which the listener turns into a 500, indistinguishable to
    // the client from a real server fault when the honest answer is "your body
    // is malformed". Deliberately stricter than the chat route above, which
    // predates this route and would need its own change; it accepts nothing
    // extra, it just answers correctly.
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("body must be a JSON object")
    }
    body = parsed as SteerRequestBody
  } catch (err) {
    sendSteerResult(res, 400, {
      accepted: false,
      reason: `Invalid JSON body: ${(err as Error).message}`,
    })
    return
  }

  if (typeof body.userMessage !== "string") {
    sendSteerResult(res, 400, { accepted: false, reason: "userMessage is required" })
    return
  }
  // Same trust boundary as the chat route: images are validated and byte-capped
  // HERE, not by the client. A steer is an unprivileged POST like any other.
  const { images: validatedImages, errors: imageErrors } = validateRequestImages(body.images)
  if (body.images !== undefined && validatedImages.length === 0 && imageErrors.length > 0) {
    sendSteerResult(res, 400, { accepted: false, reason: imageErrors.join(" ") })
    return
  }
  if (body.userMessage.trim() === "" && validatedImages.length === 0) {
    sendSteerResult(res, 400, {
      accepted: false,
      reason: "userMessage is required (or attach an image)",
    })
    return
  }
  if (!isValidSessionId(body.sessionId)) {
    sendSteerResult(res, 400, {
      accepted: false,
      reason:
        "sessionId must match /^[A-Za-z0-9_-]{1,64}$/ (UUID-shaped). Provided value rejected.",
    })
    return
  }

  const lockKey = `${projectIdForRepoRoot(ctx.repoRoot)}:${body.sessionId}`
  const live = liveTurns.get(lockKey)
  // `closed` is checked as well as presence because the registry outlives the
  // channel by a tick: `runChatTurnSdk` closes on `result`, at abort, and in
  // its own finally, while the entry survives until the chat handler's outer
  // finally closes again and releases the turn lock. Pushing into a closed
  // channel THROWS by design (a quiet no-op would be the silent drop the
  // channel exists to design out), so this check is what keeps a lost race a
  // 409 instead of a 500. It is atomic with the push below — nothing is awaited
  // between them, and `close()` can only run from another task.
  if (!live || live.channel.closed) {
    sendSteerResult(res, 409, { accepted: false, reason: "no-live-turn" })
    return
  }

  live.channel.push(
    body.userMessage,
    validatedImages.length > 0 ? validatedImages : undefined,
  )
  // Recorded only AFTER the push succeeded, so the list can never name a
  // message the channel refused. Only the transcript-shaped fields — image
  // BYTES are deliberately dropped here, matching `ChatSteeredMessage`.
  live.steers.push({
    text: body.userMessage,
    ...(validatedImages.length > 0 ? { hadImages: true } : {}),
    // A recovery turn has no assistant blocks, so 0 is the only position
    // available. The normal path does not read this list at all — the runtime's
    // `onAccepted` stamps the real position there.
    afterAssistantBlocks: 0,
  })
  // Announced only AFTER the push, so the stream can never claim an acceptance
  // that did not happen. Like the HTTP answer, this event says the turn took
  // the message on — the same turn will emit `resubmit_required` if it later
  // cannot show the model saw it.
  live.emit({
    kind: "steered",
    sessionId: body.sessionId,
    userMessage: body.userMessage,
    imageCount: validatedImages.length,
  })
  sendSteerResult(res, 200, { accepted: true })
}

/**
 * Hard cap on a request body. Sized for the chat path's worst case: up to
 * MAX_IMAGES_PER_TURN images at the media-content ~4.5MB decoded cap ≈ 6MB of
 * base64 each (~48MB), plus headroom for text/selection/page. A request over
 * this is rejected before it can OOM the (localhost, single-user) CLI process.
 * readBody throws on exceed; every call site wraps it in a try → 400.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

// Thin wrapper over the shared capped reader (`http-body.ts`, promoted
// from `artifact-http.ts`'s `readJsonBody` in Task 7 of the editor
// audit-fixes plan) — same cap, same throw-on-exceed contract every
// call site below already handles via its own try/catch → 400.
async function readBody(req: IncomingMessage): Promise<string> {
  return readRawBody(req, { maxBytes: MAX_BODY_BYTES })
}

/**
 * `{ adaptiveThinking }` from the served catalog's entry for `model`, or
 * `{}` when the catalog does not say, so the turn falls back to the family
 * rule. Read through the resolver, which is cached, so this costs nothing
 * after the picker's own request.
 */
async function adaptiveThinkingFor(model: string): Promise<{ adaptiveThinking?: boolean }> {
  const { catalogs } = await modelCatalogResolver.get()
  for (const catalog of catalogs) {
    const option = catalog.models.find((m) => m.id === model)
    if (option && typeof option.adaptiveThinking === "boolean") {
      return { adaptiveThinking: option.adaptiveThinking }
    }
  }
  return {}
}

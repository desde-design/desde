import type { ProjectIdentity } from "../../../src/core/project-identity.js"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { constants as fsConstants, readFileSync } from "node:fs"
import {
  lstat as lstatAsync,
  open as openAsync,
  readFile as readFileAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises"
import { join as joinPath, resolve as resolvePath, sep as pathSep } from "node:path"
import { hostname as osHostname, userInfo as osUserInfo } from "node:os"
import { applyEdit, defaultApplicatorLoaders, type EditRequestBody, type ApplicatorLoaders } from "./edit-handler.js"
import { readJsonBody } from "./http-body.js"
import { isWithinRoot, type ResolvedRoot } from "./resolve-editable-path.js"
import { handleCapabilitiesRoute } from "./capabilities-handler.js"
import {
  LLM_CREDENTIALS_DEV_MODE_ROUTE,
  LLM_CREDENTIALS_DISMISS_ROUTE,
  LLM_CREDENTIALS_PROVIDER_ROUTE,
  LLM_CREDENTIALS_ROUTE,
  handleLlmCredentialsRoute,
  providerIdFromPath,
} from "./llm-credentials-handler.js"
import { isClaudeRuntimeResolvable } from "./claude-runtime-available.js"
import { VIEWER_PROBE_ROUTE, handleViewerProbe } from "./viewer-probe.js"
import { VIEWER_PROXY_PREFIX, handleViewerProxy } from "./viewer-proxy.js"
import {
  effectiveViewerConfig,
  getViewerLink,
  invalidateViewerLink,
} from "./viewer-link-state.js"
import {
  clearViewerToken,
  readDefaultViewerOrigin,
  readViewerToken,
  writeDefaultViewerOrigin,
  writeViewerToken,
} from "./viewer-token-store.js"
import {
  handleLLMFallback,
  defaultLLMFallbackLoaders,
  type LLMFallbackRequestBody,
  type LLMFallbackLoaders,
} from "./llm-fallback-handler.js"
import { DORMANT_LANE_IDS, type DormantLaneId } from "./enabled-lanes.js"
import { checkAuth, type SecurityContext } from "./auth.js"
import { checkHost, isCrossSiteFetch, listenOriginFor } from "./host-guard.js"
import {
  readRawBody,
  BodyTooLargeError,
  DEFAULT_BODY_MAX_BYTES,
  EDIT_BODY_MAX_BYTES,
} from "./http-body.js"
import { invalidateGitStatusCache } from "./git-ops.js"
import { getSharedEditHistory } from "../../../src/editor/edit-service/edit-history.js"
import {
  brokeredWrite,
  rollbackWarning,
  type BrokerOp,
} from "../../../src/editor/agent-chat-sdk/write-broker.js"
import { handleStatusQuery, type McpHandlerContext } from "./mcp-handler.js"
import {
  handleChatRequest,
  handleBridgeReply,
  handleEditAck,
  handleSteerRequest,
  defaultChatLoaders,
  type ChatHandlerLoaders,
} from "./chat-handler.js"
import {
  handleShellBridgePoll,
  applyShellBridgeReply,
  type ShellBridgeReplyBody,
} from "./shell-bridge.js"
import { dispatchMcpToolHttp } from "./mcp-tool-handler.js"
import {
  handleProjectKnowledgeQuery,
  defaultProjectKnowledgeLoaders,
  type ProjectKnowledgeLoaders,
} from "./project-knowledge-handler.js"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge.js"
import {
  getTextBranches,
  defaultTextBranchesLoaders,
  type TextBranchesLoaders,
  type TextBranchesRequestBody,
} from "./text-branches-handler.js"
import { getIconSets } from "./icon-sets-handler.js"
import {
  handleManifestRequest,
  handleCatalogRequest,
} from "./manifest-handler.js"
import { handleModelCatalogRequest } from "./model-catalog-handler.js"
import { getDesignTokens } from "./design-tokens-handler.js"
import {
  handleDesignSystemsRequest,
  matchesDesignSystemsRoute,
  type StalenessCacheHolder,
} from "./design-systems-handler.js"
import {
  handleReadRootsRoute,
  matchesReadRootsRoute,
  type ReadRootsHandlerContext,
  type ReadRootsHolder,
} from "./read-roots-handler.js"
import { pickFolder as defaultPickFolder, type PickFolder } from "./folder-picker.js"
import {
  checkDesignSystemStaleness,
  type ReconciliationStatusHolder,
} from "../../../src/editor/onboarding/index.js"
import {
  getGroundingService,
  defaultGroundingLoaders,
  resetGroundingCache,
  type GroundingLoaders,
} from "./grounding-context.js"
import { handleEditIterationRequest } from "./edit-iteration-handler.js"
import { readPrototypeFile } from "./file-read-handler.js"
import type {
  DriftLog,
  IconSetRegistry,
  SubstrateStyleCapabilities,
} from "../../../src/editor/core"
import { createDriftLog, NO_SUBSTRATE_STYLE_CAPABILITIES } from "../../../src/editor/core"
import type { OverrideStylesheetFacts } from "../../../src/editor/edit-service/detect-override-stylesheet.js"
import type { RepairDeps } from "../../../src/editor/drift/repair-component.js"
import { createDefaultRepairDeps } from "../../../src/editor/drift/repair-component.js"
import type { RepairQueue } from "./repair-queue.js"
import { createRepairQueue } from "./repair-queue.js"
import type { PendingInvalidationQueue } from "./pending-invalidation-queue.js"
import { createPendingInvalidationQueue } from "./pending-invalidation-queue.js"
import { handleDriftRequest, matchesDriftRoute, DRIFT_ROUTE } from "./drift-handler.js"
import { recordManifestValueMismatchDrift } from "./manifest-value-mismatch-drift.js"
import type { PropEditBody } from "../../../src/editor/edit-service/validate-edit-request.js"
import {
  acquireTreeGateShared,
  withFileEditLocks,
  withGitIndexLock,
  withTreeLock,
} from "./session-lock.js"
import { editLockTargets } from "./edit-lock-targets.js"
import {
  listBranches,
  tryListLocalBranchNames,
  switchBranch,
  createBranch,
  renameBranch,
  publishBranch,
  commitWorkingTree,
  listWorkingTreeChanges,
  listDirtyRepoRelativePaths,
  isIgnoredPath,
  readHeadBlobs,
  countCommitsAhead,
  countCommitsBehind,
  branchUpstream,
  fetchOrigin,
  pushToOrigin,
  hasUnpushedCommits,
  currentBranch,
  discardFile,
  headSha,
  updateFromDefault,
  updateFromRemote,
  type BranchBase,
  type BranchOpResult,
  type CommitResult,
  type PublishResult,
  type UpdateBranchResult,
  type WorkingTreeChangeStatus,
} from "../../../src/editor/worktree/git-branches.js"
import {
  appendLedgerEntry,
  describeLedgerEntry,
  editBelongsToBranch,
  editEntries,
  hashContent,
  invalidateBranchCache,
  ledgerHorizonStart,
  planLedgerUndo,
  readGitHeadRaw,
  readLedger,
  reconcileLedger,
  resolveBranchCachedWithHead,
  resolveCommitState,
  resolveEditBranches,
  type UndoDeps,
  type UndoPlan,
} from "../../../src/editor/ledger/index.js"
import type { LedgerEditEntry } from "../../../src/editor/ledger/entry.js"
import { normalizeLedgerPath } from "../../../src/editor/ledger/normalize-path.js"
import { isOrphanedBranch } from "../../../src/editor/ledger/rename-aliases.js"
import {
  resolvePullRequestTarget,
  createPullRequest,
} from "./github-pull-request.js"
import { readOriginRemoteUrl } from "./git-remote.js"
import { createLocalStores, type LocalStores } from "./stores/index.js"
import {
  handleCommentsRequest,
  matchesCommentsRoute,
} from "./comments-handler.js"
import { handleNotesRequest, matchesNotesRoute } from "./notes-handler.js"
import {
  dormantSurfaceRefusal,
  isCanvasEnabled,
  isCodeViewEnabled,
  isNotesEnabled,
  isVscodeLinkEnabled,
} from "./dormant-surfaces.js"
import {
  handleScreenshotPlansRequest,
  matchesScreenshotPlansRoute,
} from "./screenshot-plans-handler.js"
import {
  handleCanvasesRequest,
  matchesCanvasesRoute,
} from "./canvases-handler.js"
import {
  handleProjectLinkRequest,
  PROJECT_LINK_ROUTE,
} from "./project-link-handler.js"
import {
  handleSmokeTestRequest,
  handleSmokeRunsRequest,
} from "./smoke-test-handler.js"
import {
  BOOTSTRAP_PATH,
  serveBootstrapJs,
  serveStatic,
} from "./static-assets.js"
import { runRetentionGc } from "../../../src/editor/agent-chat-sdk/retention-gc.js"
import { gcAllProposalBlobs } from "../../../src/editor/agent-chat-sdk/proposal-blob-gc.js"
import { resolveLlmConfig } from "./llm-config.js"
import { getProvider } from "../../../src/editor/llm-providers/registry.js"

export interface HttpServerOptions {
  /** Bind host. Defaults to 127.0.0.1. */
  host?: string
  /** Bind port. Defaults to 4321. */
  port?: number
  /**
   * Deterministically invalidate the written files in whatever dev server the
   * host booted, so it reflects the write without waiting on the OS watcher
   * (macOS fsevents can coalesce or drop ours).
   *
   * **A callback, not a `ViteDevServer`, because "the dev server" is not always
   * one server.** Nuxt runs a CLIENT Vite and an SSR Vite with distinct module
   * graphs. This used to be a single `viteServer` handle set to the first
   * captured server, which on Nuxt is the client lane — so an edit hot-updated
   * the client while the SSR lane kept serving stale HTML with stale stamps,
   * presenting as "the stamp moved but the edit did nothing". Each host now
   * owns the plurality in its own `HostBoot.hmr.invalidate`, and this is how
   * that reaches the edit routes.
   *
   * Optional: attach mode omits it (we cannot replay an event into a watcher we
   * do not own, and the upstream's own HMR is what makes it unnecessary —
   * MEASURED end to end on Next in `tasks/next-attach-mode-spike.md`), and
   * tests omit it. The OS watcher is the backstop either way.
   */
  invalidateFiles?: (files: ReadonlyArray<string>) => void
  /** Absolute path to the user's repo root (passed to edit-handler). */
  repoRoot: string
  /**
   * `repoRoot` with symlinks resolved, when it differs. Forwarded verbatim into
   * the UI bootstrap: the shell prefix-matches a stylesheet's bundler source hint
   * against the root to find a token's source file, and Vite's module ids can be
   * anchored at the real path (it defaults to `preserveSymlinks: false`) while
   * `repoRoot` is the path the user typed. Omitted when the two are identical or
   * the realpath failed — the shell then tries `repoRoot` alone, the prior
   * behavior. Nothing server-side reads this; `resolve-editable-path.ts` does its
   * own realpath for write containment.
   */
  repoRootReal?: string
  /**
   * Absolute path to the CANONICAL repo root (the user's checked-out
   * repo), as opposed to `repoRoot` which is the per-session worktree.
   * The manifest/catalog endpoints build their component source against
   * this because `node_modules` (the installed design system) and the
   * prototype tsconfig live in the canonical checkout, not the worktree
   * branch. Defaults to `repoRoot` when omitted (tests / non-worktree
   * callers); the CLI bootstrap always passes the real canonical root.
   */
  canonicalRoot?: string
  /**
   * Dormant edit lanes this prototype opted back in to, loaded once at boot by
   * `loadEnabledLanes` from `desde.config.json`'s `lanes` block.
   *
   * Threaded to BOTH edit dispatch surfaces (`applyEdit` and the repair lane)
   * and forwarded to the client bootstrap as
   * `window.__DESDE_CLI__.lanes`, so the offering and the dispatch cannot
   * disagree about which lanes exist. Omitted (tests, older callers) means
   * nothing is opted in — the shipped default.
   */
  enabledLanes?: ReadonlySet<DormantLaneId>
  /** Absolute path to the built editor UI bundle (`<dist>/index.html` etc.). */
  uiBundleRoot: string
  /**
   * Absolute path to `html2canvas.min.js`. Served (unauthenticated) at
   * `/vendor/html2canvas.min.js` so the prototype iframe's bridge can load it
   * for `CAPTURE_ELEMENT_SCREENSHOT` — the bridge resolves that URL against its
   * `document.referrer`, which is THIS shell's origin. Without it the agent's
   * `capture_screenshot` tool 404s. Optional: unset/unreadable → not served.
   */
  html2canvasPath?: string
  /** URL where the user's Vite is reachable. Embedded in the UI bootstrap so the iframe can load it. */
  viteUrl: string
  /**
   * Framework detected for the supervised prototype (`detectFramework`).
   * Embedded in the UI bootstrap so the shell's `get_page_info` reports the
   * real framework to the agent. Optional → defaults to `vue3`.
   */
  framework?: "vue3" | "react"
  /**
   * Styling system detected for the supervised prototype
   * (`detectStylingSystem`). Embedded in the UI bootstrap so the shell builds
   * the matching React inline-style edit (`tailwind` → className splice; else →
   * inline style object). Optional → defaults to `inline`.
   */
  stylingSystem?: "tailwind" | "css-modules" | "inline"
  /**
   * Substrate style capabilities detected for the supervised prototype
   * (`detectSubstrateStyleCapabilities`). Embedded in the UI bootstrap so the
   * inspector's scope dialog can deprioritise the element scope where it
   * architecturally cannot win. Optional → every capability false (today's
   * behavior).
   */
  styleCapabilities?: SubstrateStyleCapabilities
  /**
   * Boot-resolved facts about where a scoped style override is written on a
   * substrate with no `<style scoped>` block (React) — the configured
   * destination and the file that already holds the managed block. Embedded in
   * the UI bootstrap because both are filesystem questions and the shell has no
   * filesystem; the shell still checks each against the page's LOADED
   * stylesheets before using it. Optional → the shell falls back to document
   * order, which is the ladder's last rung.
   */
  overrideStylesheet?: OverrideStylesheetFacts
  /**
   * Resolved Vite `base` (always slash-wrapped, e.g. `/` or `/app/`). Embedded
   * in the UI bootstrap so the shell can strip the served-path prefix off a
   * stylesheet href when resolving a token's source file (token-scope edits).
   * Optional: defaults to `/` when the supervisor didn't supply it.
   */
  viteBase?: string
  /** Security context (token + shell origin). */
  security: SecurityContext
  /** Applicator loaders (defaults to in-tree edit-service). */
  applicatorLoaders?: ApplicatorLoaders
  /** Tier 2 LLM-fallback loaders (defaults to in-tree repair-edit service). */
  llmFallbackLoaders?: LLMFallbackLoaders
  /** Phase 1 chat orchestrator loaders. */
  chatLoaders?: ChatHandlerLoaders
  /** Project-knowledge read-endpoint loaders (defaults to in-tree loader). */
  projectKnowledgeLoaders?: ProjectKnowledgeLoaders
  /** Text-branches detector loaders (defaults to in-tree detector). */
  textBranchesLoaders?: TextBranchesLoaders
  /**
   * Phase 5 — chat quotas + cost ceiling. CLI bootstrap reads these
   * from `.desde/config.json` (project-config `chat` section)
   * and threads them through; tests pass directly. Omitted →
   * orchestrator's defaults (10 model calls / 20 tool calls / no
   * cost ceiling).
   */
  chatQuotas?: {
    maxModelCallsPerTurn?: number
    maxToolCallsPerTurn?: number
    /**
     * Raw project-config value. `undefined` (key omitted) means
     * unlimited, as do explicit `null` and `0`. Only a positive number
     * is a ceiling. Resolved by `resolveCostCeilingUsd`.
     */
    costCeilingUsd?: number | null
    /**
     * Phase 5 of tasks/editor-detached-sessions.md — gate the
     * detached chat sessions UI. Surfaced to the client via the
     * bootstrap script's `window.__DESDE_CLI__.detachedSessions`
     * field. Server-side per-sessionId handling is always on —
     * this is a UI-level opt-out for stabilization.
     */
    detachedSessions?: boolean
  }
  /**
   * Audit Task 15 — on-disk retention tunables from `.desde/config.json`'s
   * `retention` block. `backups`/read-snapshot-bases sweeps run at CLI
   * boot (`core.ts`) and after every successful top-bar Commit
   * (`handleBranchCommitRequest` below); `chatSessionTurns.maxTurns` is
   * forwarded to the chat handler for `saveSession`'s turns cap.
   */
  retention?: {
    backups?: { keepNewest?: number; maxAgeDays?: number }
    chatSessionTurns?: { maxTurns?: number }
  }
  /** `llm` block from the project config. See `llm-config.ts`. */
  llm?: import("./project-config.js").ProjectConfig["llm"]
  /**
   * Phase 3 — "Use repo conventions". CLI bootstrap reads this from
   * `.desde/config.json` (project-config `conventions` section).
   * When `useRepoConventions` is false the edit/chat tiers skip grounding
   * the LLM in the repo's documented conventions; `excludeFiles` drops
   * specific files from discovery. Omitted → conventions on, nothing
   * excluded.
   */
  conventions?: ProjectKnowledgeConfig
  /**
   * Editor runtime tunables from project config. Surfaced to the
   * client via the bootstrap script as
   * `window.__DESDE_CLI__.editor.*`. Currently just
   * `reloadBackstop` (HMR reload toggle) — see project-config.ts.
   */
  editor?: {
    reloadBackstop?: boolean
    /**
     * Canvas + screenshot-plan surface gate. DORMANT by product decision
     * 2026-08-04 (undertested; see CLAUDE.md § "Screenshot Capture").
     * Default false (opt-IN) — the inverse of `chatQuotas.detachedSessions`'
     * opt-out default. `EDITOR_CANVAS=1` also enables (either wins).
     * Surfaced to the client bootstrap as `window.__DESDE_CLI__.canvas`.
     */
    canvas?: boolean
    /**
     * In-app code view gate. DORMANT by product decision 2026-08-14.
     * Read through `isCodeViewEnabled` — never compared here — so the
     * bootstrap's `codeView` field and `GET /api/editor/file`'s refusal
     * cannot disagree. See `dormant-surfaces.ts`.
     */
    codeView?: boolean
    /**
     * Notes surface gate. DORMANT by product decision 2026-08-14. Read
     * through `isNotesEnabled`, on the same one-function-two-callers rule
     * as `codeView` above.
     */
    notes?: boolean
    /**
     * "Open in VS Code" gate. DORMANT by product decision 2026-08-18.
     * Read through `isVscodeLinkEnabled`. Unlike the two above it has no
     * route to refuse from — see that function for why the client gate is
     * the whole gate here.
     */
    vscodeLink?: boolean
    // No `neutralChat` field here. That gate is opt-OUT and env-only
    // (`EDITOR_NEUTRAL_CHAT=0` disables it) with no project-config
    // equivalent, so there is nothing for the bootstrap to surface: the
    // model catalog response is what tells the client whether the OpenAI
    // group exists at all. See `isNeutralChatEnabled` in
    // `dormant-surfaces.ts`.
  }
  /**
   * Resolved read-roots registry for the chat handler's git tools.
   * CLI bootstrap loads it from `desde.config.json`.
   * Omitted → git tools return a "not configured" error to the model.
   */
  readRoots?: import("../../../src/editor/core/read-roots").ReadRootRegistry
  /**
   * Live registry box for reference directories, so an edit made from the
   * settings dialog reaches the next chat turn without a restart. The CLI
   * bootstrap creates it from the same load that produces `readRoots`.
   */
  readRootsHolder?: ReadRootsHolder
  /**
   * Native folder chooser. Injectable so tests never pop a real OS dialog;
   * defaults to the platform picker.
   */
  pickFolder?: PickFolder
  /**
   * MCP handler context. `platformBaseUrl` is reserved for a future
   * platform integration (see `McpHandlerContext`'s docstring in
   * mcp-handler.ts) — no deployment-lookup integration exists today, so
   * `/mcp/status` always reports `ahead_of_deployment: "unknown"`.
   */
  mcp?: Pick<McpHandlerContext, "platformBaseUrl">
  /**
   * Cloud-project association forwarded to the client bootstrap as
   * `window.__DESDE_CLI__.project`. The shell reads `projectId`
   * to decide whether to resolve the shared cloud project (comments
   * sync + membership) once the user is signed in; `null` projectId =
   * unlinked repo → the shell stays on the local annotation store.
   * Distinct from `mcp` (which drives platform deployment lookup).
   */
  project?: {
    projectId: string | null
    slug: string | null
    /**
     * Embedded project identity from `.desde/config.json`. Null on an
     * un-migrated repo. Forwarded to the UI bootstrap as
     * `window.__DESDE_CLI__.project.identity` — the source the
     * breadcrumb renders, since it needs no sign-in, network or cloud link.
     */
    identity: ProjectIdentity | null
    platformBaseUrl: string | null
  }
  /**
   * Always true now — branch mode is the only edit substrate: edits
   * land on the user's current working tree in place, with no worktree
   * session and no promote step. Forwarded to the client bootstrap as
   * `editMode: 'branch'`. See tasks/branches-vs-worktree.md.
   */
  branchMode?: boolean
  /**
   * Asset/port overrides to forward to editors spawned from the
   * breadcrumb "home" launcher (`GET /api/editor/home` lazily starts a
   * launcher). Mirrors what `runLauncher` forwards (`--ui-bundle-root`,
   * `--bridge-bundle`, `--vite-port`) so a project opened from home runs
   * the same assets THIS process was started with. Defaults to `[]`.
   */
  launcherForwardArgs?: string[]
  /**
   * The launcher this editor was spawned from, when there is one. The
   * breadcrumb's Home (`GET /api/editor/home`) answers with it instead of
   * lazily starting a second launcher. Absent for an editor started by hand
   * (`desde <repo>`), which keeps the lazy start. Sourced from the
   * `DESDE_HOME_URL` env var a launcher sets on its children (`home-url.ts`).
   */
  homeUrl?: string
  /**
   * Icon-set registry populated by the CLI bootstrap (auto-detected
   * from the prototype's `package.json`). Exposed read-only via
   * `GET /api/editor/icon-sets`. Omitted → endpoint returns 503.
   */
  iconSetRegistry?: IconSetRegistry | null
  /**
   * Grounding-service loader (defaults to the in-tree create-grounding-service).
   * Tests inject a stub; production uses `defaultGroundingLoaders`. Backs the
   * manifest, catalog, and design-tokens endpoints (one source of truth).
   */
  groundingLoaders?: GroundingLoaders
  /**
   * Phase 3 attach/refresh — mutable box the CLI bootstrap creates BEFORE
   * calling `startHttpServer` and writes into AFTER the server is up (the
   * boot-time `reconcileDesignSystems` pass is kicked off post-boot, non-
   * blocking). The design-systems GET route reads `.current` per request.
   * Omitted (tests, or callers that don't run reconciliation) → the route
   * reports `reconciliation: null`.
   */
  reconciliationStatusHolder?: ReconciliationStatusHolder
  /**
   * Phase 3 refresh — mutable box the CLI bootstrap creates BEFORE calling
   * `startHttpServer` and writes into AFTER boot-time reconciliation
   * completes (the boot-time staleness warm-up chains after it, same
   * void-wrapped block). `GET …/updates` reads/writes `.current` as its
   * per-process TTL cache. Omitted (tests, or callers that don't warm the
   * cache) → the route computes staleness fresh on every uncached GET, same
   * as a cold cache.
   */
  stalenessCacheHolder?: StalenessCacheHolder
}

export interface HttpServerHandle {
  url: string
  close: () => Promise<void>
}

/**
 * Reads a request body capped at `maxBytes`. On overflow, sends a 413
 * in the caller's own `{ ok: false, reason }` shape (matching how
 * every route below already reports body errors) and returns `null` —
 * callers check for `null` and return immediately, same short-circuit
 * shape as the existing "invalid JSON" branches.
 */
async function readCappedBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await readRawBody(req, { maxBytes })
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, reason: err.message })
      return null
    }
    throw err
  }
}

/**
 * The CLI's localhost HTTP server. Two responsibilities:
 *
 * 1. **Serve the editor UI bundle.** Static file serving from
 *    `uiBundleRoot`. The served HTML embeds the per-session token + the
 *    Vite URL via inline script so the React app can read them
 *    pre-bootstrap (window globals, no env var trickery).
 *
 * 2. **Handle JSON API requests.** Every route — its method, path, auth
 *    posture, and handler — is declared in {@link ROUTE_TABLE}; the
 *    dispatcher (`routeRequest`) is a first-match walk over it, and it is
 *    the ONLY place `checkAuth` is called. `/api/*` and `/mcp/*` routes are
 *    all bearer-gated; a per-route `authPolicy` picks the strict or the
 *    Origin-`if-present` variant.
 *
 * GET / and GET /assets/* are NOT auth-gated — the UI must load before
 * it can present credentials. State-change endpoints all are.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const host = opts.host ?? "127.0.0.1"
  const port = opts.port ?? 4321
  const applicatorLoaders = opts.applicatorLoaders ?? defaultApplicatorLoaders
  const llmFallbackLoaders = opts.llmFallbackLoaders ?? defaultLLMFallbackLoaders
  const chatLoaders = opts.chatLoaders ?? defaultChatLoaders
  const projectKnowledgeLoaders =
    opts.projectKnowledgeLoaders ?? defaultProjectKnowledgeLoaders
  const textBranchesLoaders =
    opts.textBranchesLoaders ?? defaultTextBranchesLoaders
  const groundingLoaders = opts.groundingLoaders ?? defaultGroundingLoaders
  const uiBundleRoot = resolvePath(opts.uiBundleRoot)
  // Artifact stores (Phase 1 of tasks/cli-viewer-architecture.md).
  // Constructed once per server lifetime; reads/writes are serialized
  // per-file inside the store impls.
  const stores = createLocalStores(opts.repoRoot)
  // Phase 5 Task 1 (grounding drift) — one process-lifetime `DriftLog`
  // per canonical root, same posture as `stores` above: created once here,
  // never rebuilt on a manifest/registry change (unlike the memoized
  // grounding service, which DOES get invalidated — the drift log's whole
  // point is to accumulate across those rebuilds, not reset with them).
  const driftLog: DriftLog = createDriftLog()
  // Phase 5 Task 4 (granular repair) — production `RepairDeps`, built once
  // per process. Cheap to construct (plain closures; the heavy `typescript`-
  // dependent adapters it wraps are lazy-imported only when a repair
  // actually runs), so there's no reason to defer this to request time.
  const repairDeps: RepairDeps = createDefaultRepairDeps()
  // Final review fix wave — ONE single-flight queue per process, shared by
  // every request (see `repair-queue.ts`'s doc comment): serializes
  // `repairComponent` calls so a batch of repairable signals can't fan out
  // into N concurrent synchronous TS-program builds and stall the CLI.
  const repairQueue: RepairQueue = createRepairQueue()
  // Phase 5 Task 2 root-cause fix — one process-lifetime, `DriftLog`-
  // independent queue for repair-settle invalidation delivery. See
  // `pending-invalidation-queue.ts`'s doc comment: must be the SAME
  // instance across requests (like `driftLog`/`repairQueue` above), or a
  // fresh queue per request would drain nothing but what that one request
  // itself enqueued.
  const pendingInvalidations: PendingInvalidationQueue = createPendingInvalidationQueue()

  // Lazily-started launcher backing the breadcrumb "home" affordance
  // (`GET /api/editor/home`). Held here (not per-request ctx) so one
  // launcher is shared across the process lifetime; closed with the server.
  const homeLauncherHolder: HomeLauncherHolder = { current: null }

  // What the DNS-rebinding `Host` guard compares against (see `host-guard.ts`).
  // Seeded with the requested address and corrected below from what `listen`
  // actually bound, because `port: 0` picks a different one. Read per request
  // from inside the handler closure, so the correction lands before any
  // request can arrive.
  let listenOrigin = listenOriginFor(host, port)

  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, {
        ...opts,
        listenOrigin,
        canonicalRoot: opts.canonicalRoot ?? opts.repoRoot,
        applicatorLoaders,
        llmFallbackLoaders,
        chatLoaders,
        projectKnowledgeLoaders,
        textBranchesLoaders,
        groundingLoaders,
        uiBundleRoot,
        stores,
        driftLog,
        repairDeps,
        repairQueue,
        pendingInvalidations,
        homeLauncherHolder,
      })
    } catch (err) {
      console.error("[editor-cli] request handler error:", err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end("internal error")
      }
    }
  })

  /*
    The port actually bound, which is NOT always the one asked for: `port: 0`
    means "any free one", and the OS picks during `listen`.

    `listenOrigin` already read this correctly; `url` did not, and returned
    `http://127.0.0.1:0` for an ephemeral bind. That one inconsistency is why
    48 test files hand-roll a `pickFreePort` helper: bind 0, read the number,
    close, and let this function bind it again. Closing the socket to learn
    its number leaves a window in which another process can take that port,
    which `port: 0` does not have.

    Honest scope: that window is a hazard, not a diagnosed failure. It was
    hypothesised as the cause of a suite flake and MEASURED NOT to be (the
    real cause was a 26s headless-browser launch; see `vitest.config.ts`).
    This fixes the reported-vs-bound inconsistency and makes `port: 0`
    usable, nothing more.
  */
  let boundPort = port

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const addr = server.address()
      if (addr && typeof addr === "object") {
        boundPort = addr.port
        listenOrigin = listenOriginFor(host, addr.port)
      }
      resolve()
    })
  })

  return {
    url: `http://${host}:${boundPort}`,
    close: async () => {
      // Tear down the lazily-started home launcher first so it doesn't
      // outlive the editor that spawned it (leaked port + child procs).
      if (homeLauncherHolder.current) {
        await homeLauncherHolder.current
          .then((h) => h.close())
          .catch(() => {})
        homeLauncherHolder.current = null
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

/** Lazily-started "home" launcher, shared across a server's lifetime. */
type HomeLauncherHolder = {
  current: Promise<{ url: string; close: () => Promise<void> }> | null
}

/**
 * The provider this project's non-chat lanes run on, resolved per request so a
 * key saved in the settings dialog takes effect on the next save rather than
 * at the next restart.
 */
function llmConfigFor(ctx: RouteContext) {
  return resolveLlmConfig({ llm: ctx.llm }, process.env)
}

/**
 * Narrow the route context down to what the read-roots handler needs.
 *
 * `pickFolder` is passed through so the settings dialog can pop the native
 * chooser. That capability previously lived only on the launcher server, which
 * is why an in-editor picker was not possible before.
 */
function readRootsCtx(ctx: RouteContext): ReadRootsHandlerContext {
  return {
    // `canonicalRoot`, NOT `repoRoot`. They differ when Editor opens a package
    // inside a larger repo: `repoRoot` is the GIT root (core.ts sets it from
    // `resolvePrototypeLocation`), while read roots are loaded from
    // `canonicalRoot`, the opened directory. Writing to `repoRoot` therefore
    // edited a different file than the loader reads, so the dialog reported
    // success, the registry never changed, and an unrelated config at the git
    // root was modified.
    configRoot: ctx.canonicalRoot,
    holder: ctx.readRootsHolder,
    pickFolder: ctx.pickFolder ?? defaultPickFolder,
  }
}

interface RouteContext extends Required<Pick<HttpServerOptions, "applicatorLoaders" | "llmFallbackLoaders" | "chatLoaders" | "projectKnowledgeLoaders" | "repoRoot" | "canonicalRoot" | "viteUrl" | "security">> {
  /**
   * `http://<host>:<port>` for the socket this server is actually bound to.
   * The DNS-rebinding `Host` guard's yardstick — deliberately NOT
   * `security.shellOrigin`, which answers a different question. See
   * `host-guard.ts`.
   */
  listenOrigin: string
  /** `repoRoot` with symlinks resolved, when it differs (spread from opts). */
  repoRootReal?: string
  textBranchesLoaders: TextBranchesLoaders
  groundingLoaders: GroundingLoaders
  uiBundleRoot: string
  viteBase?: string
  html2canvasPath?: string
  mcp?: Pick<McpHandlerContext, "platformBaseUrl">
  project?: HttpServerOptions["project"]
  launcherForwardArgs?: string[]
  homeUrl?: string
  homeLauncherHolder?: HomeLauncherHolder
  chatQuotas?: HttpServerOptions["chatQuotas"]
  conventions?: HttpServerOptions["conventions"]
  editor?: HttpServerOptions["editor"]
  /** Dormant lanes opted back in (spread from opts). See `enabled-lanes.ts`. */
  enabledLanes?: ReadonlySet<DormantLaneId>
  /** Audit Task 15 — retention tunables (spread from opts). */
  retention?: HttpServerOptions["retention"]
  llm?: HttpServerOptions["llm"]
  readRoots?: HttpServerOptions["readRoots"]
  /**
   * Live registry box. The settings dialog swaps `.current` after a write so a
   * newly added reference directory reaches the NEXT chat turn without a
   * restart — `readRoots` above is the boot-time snapshot and cannot change.
   */
  readRootsHolder?: ReadRootsHolder
  /** Native folder chooser, injectable for tests (spread from opts). */
  pickFolder?: PickFolder
  /** True when the CLI booted in branch mode (spread from opts). */
  branchMode?: boolean
  iconSetRegistry?: IconSetRegistry | null
  /** Detected framework of the supervised prototype (spread from opts). */
  framework?: "vue3" | "react"
  /** Detected styling system of the supervised prototype (spread from opts). */
  stylingSystem?: "tailwind" | "css-modules" | "inline"
  /** Detected substrate style capabilities (spread from opts). */
  styleCapabilities?: SubstrateStyleCapabilities
  /** Boot-resolved override-destination facts (spread from opts). */
  overrideStylesheet?: OverrideStylesheetFacts
  /** Phase 3 attach/refresh — see `HttpServerOptions.reconciliationStatusHolder`. */
  reconciliationStatusHolder?: ReconciliationStatusHolder
  /** Phase 3 refresh — see `HttpServerOptions.stalenessCacheHolder`. */
  stalenessCacheHolder?: StalenessCacheHolder
  /** Local-file artifact stores (comments, notes, canvases). */
  stores: LocalStores
  /** Phase 5 Task 1 — process-lifetime live drift log (see `http-server.ts`'s `startHttpServer`). */
  driftLog: DriftLog
  /** Phase 5 Task 4 — production granular-repair deps, threaded into the drift route's `repair` wiring below. */
  repairDeps: RepairDeps
  /** Final review fix wave — process-lifetime single-flight queue serializing every repair this handler triggers. See `repair-queue.ts`. */
  repairQueue: RepairQueue
  /** Phase 5 Task 2 root-cause fix — process-lifetime, `DriftLog`-independent invalidation delivery queue. See `pending-invalidation-queue.ts`. */
  pendingInvalidations: PendingInvalidationQueue
  /** Post-write invalidation, into EVERY lane the host booted. See above. */
  invalidateFiles?: (files: ReadonlyArray<string>) => void
}

/**
 * Auth posture for a route. Mirrors `checkAuth`'s two-mode Origin policy
 * (`auth.ts`), plus an explicit "no gate at all" for the handful of routes
 * that must be reachable before the UI holds a token.
 *
 * - `"none"` — no bearer, no Origin. Only for assets the browser or the
 *   prototype iframe loads *before* it can present credentials: the UI
 *   bundle, the bootstrap script, and the html2canvas vendor file the
 *   bridge pulls cross-origin.
 * - `"bearer-origin-if-present"` — bearer required; `Origin` validated only
 *   when the request carries one. Two consumer classes need this: MCP
 *   clients (CLI agents / IDE-proxied integrations send no browser-style
 *   `Origin`), and same-origin browser GETs (browsers omit `Origin` on
 *   simple same-origin GETs). The bearer token is the load-bearing CSRF
 *   defense in both cases.
 * - `"bearer-origin-required"` — bearer + exact `Origin` match. The posture
 *   for every state-changing endpoint.
 *
 * There is deliberately no implicit default: `RouteEntry.authPolicy` is a
 * required field, and `http-server-route-table.test.ts` fails the build if
 * an `/api/` or `/mcp/` route is ever added without a bearer posture.
 */
export type AuthPolicy =
  | "none"
  | "bearer-origin-if-present"
  | "bearer-origin-required"

/** `"ANY"` = the handler does its own method narrowing (artifact CRUD routes). */
type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "ANY"

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
) => void | Promise<void>

export interface RouteEntry {
  method: RouteMethod
  /**
   * Canonical path descriptor. When `match` is absent this is compared for
   * exact equality; when `match` is present this is documentation only (the
   * prefix/pattern the matcher covers) and also the duplicate-detection key.
   */
  path: string
  /** Prefix / parameterized matching. Takes precedence over `path` equality. */
  match?: (pathname: string) => boolean
  authPolicy: AuthPolicy
  handler: RouteHandler
}

/**
 * Viewer auth + proxy handlers. The token is read and written ONLY here and
 * in the proxy — it is deliberately never returned to the browser, so the
 * status route reports presence, not value.
 */
async function handleViewerAuthStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const baseUrl = ctx.project?.platformBaseUrl ?? null
  const projectId = ctx.project?.projectId ?? null
  const hasToken = baseUrl ? (await readViewerToken(baseUrl)) !== null : false
  // The machine's default viewer, and what it made of THIS repo. Both are
  // reported alongside the committed link rather than folded into it: the UI
  // has to be able to say "linked, because your viewer recognised this repo"
  // differently from "linked, because this repo says so", and it must be able
  // to show a conflict, which is neither.
  const defaultOrigin = await readDefaultViewerOrigin()
  const link = await getViewerLink(ctx.repoRoot)
  const effective = effectiveViewerConfig({ baseUrl, projectId }, link)
  sendJson(res, 200, {
    configured: Boolean(effective.baseUrl && effective.projectId),
    baseUrl: effective.baseUrl,
    projectId: effective.projectId,
    // Presence of a token for the viewer actually in use, which is not
    // necessarily the one the repo committed.
    hasToken: effective.baseUrl ? (await readViewerToken(effective.baseUrl)) !== null : hasToken,
    source: effective.source,
    defaultOrigin,
    link,
  })
}

async function handleViewerAuthSet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readJsonBody<{ token?: unknown; baseUrl?: unknown; makeDefault?: unknown }>(req)
  // An explicit baseUrl wins: on FIRST connect the config has none yet, so
  // reading it only from config would make the very first store impossible.
  const baseUrl =
    typeof body?.baseUrl === "string" && body.baseUrl.trim().length > 0
      ? body.baseUrl.trim()
      : (ctx.project?.platformBaseUrl ?? null)
  if (!baseUrl) {
    sendJson(res, 400, { ok: false, reason: "No viewer URL given, and none in .desde/config.json" })
    return
  }
  const token = typeof body?.token === "string" ? body.token.trim() : ""
  // Shape-check before storing: a pasted-wrong value should fail HERE with a
  // clear message rather than as a 401 on the next comment fetch, which
  // reads as "the viewer is broken".
  if (!/^dsv_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(token)) {
    sendJson(res, 400, {
      ok: false,
      reason: "That does not look like a viewer access token (expected `dsv_…`). Create one in the viewer under Settings.",
    })
    return
  }
  await writeViewerToken(baseUrl, token)
  // `makeDefault` is what turns "a token for this repo's viewer" into "this
  // is my viewer" — the machine-level setting every other repo resolves
  // against. Opt-in, so the per-repo connect flow cannot silently re-point
  // the machine at whatever viewer the last repo happened to use.
  if (body?.makeDefault === true) {
    await writeDefaultViewerOrigin(baseUrl)
  }
  // Either write can change what this repo resolves to, so the cached
  // resolution is no longer trustworthy.
  invalidateViewerLink()
  sendJson(res, 200, { ok: true })
}

async function handleViewerAuthClear(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const baseUrl = ctx.project?.platformBaseUrl ?? null
  if (baseUrl) await clearViewerToken(baseUrl)
  sendJson(res, 200, { ok: true })
}

/** Trailing-`/lock-events` GET under the chat-sessions prefix. */
const CHAT_SESSIONS_PREFIX = "/api/editor/chat/sessions/"
const MCP_TOOL_PREFIX = "/api/editor/mcp/tool/"

function chatSessionSubroute(suffix: string): (pathname: string) => boolean {
  return (pathname) =>
    pathname.startsWith(CHAT_SESSIONS_PREFIX) && pathname.endsWith(suffix)
}

/** `POST /api/editor/ledger/:id/undo` — Plan B, Task 1. */
const LEDGER_PREFIX = "/api/editor/ledger/"
const LEDGER_UNDO_SUFFIX = "/undo"
/** Same shape as `SESSION_ID_PATTERN` above — loose enough for a UUID
 * (`randomUUID()`, the ledger's own id format) or a test fixture's id. */
const LEDGER_ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function matchesLedgerUndoRoute(pathname: string): boolean {
  return pathname.startsWith(LEDGER_PREFIX) && pathname.endsWith(LEDGER_UNDO_SUFFIX)
}

/**
 * Extract + validate the `:id` segment of `/api/editor/ledger/:id/undo`.
 * Returns `null` AFTER having sent the 400 — the caller just `return`s.
 * Mirrors `parseSessionIdFromPath` below: reject embedded slashes both
 * before and after decoding, and malformed percent-encoding, rather than
 * letting either fall through as a confusing 404 or 500.
 */
function parseLedgerEntryIdFromPath(
  res: ServerResponse,
  pathname: string,
): string | null {
  const restRaw = pathname.slice(
    LEDGER_PREFIX.length,
    pathname.length - LEDGER_UNDO_SUFFIX.length,
  )
  if (restRaw.length === 0 || restRaw.includes("/")) {
    sendJson(res, 400, { ok: false, reason: "An edit id is required." })
    return null
  }
  let rest: string
  try {
    rest = decodeURIComponent(restRaw)
  } catch {
    sendJson(res, 400, { ok: false, reason: "The edit id is malformed (invalid URL encoding)." })
    return null
  }
  if (rest.length === 0 || rest.includes("/") || !LEDGER_ENTRY_ID_PATTERN.test(rest)) {
    sendJson(res, 400, { ok: false, reason: "The edit id is malformed." })
    return null
  }
  return rest
}

/**
 * Realpath-resolve `<canonicalRoot>/.desde/backups` once and cache
 * it, for the containment check every backup access in
 * `createRealUndoDeps` needs. Returns `null` when the directory doesn't
 * exist (or isn't readable) — every caller treats `null` as "no valid
 * backup location," the same safe default an ordinary missing backup
 * already produces.
 */
/**
 * Realpath `canonicalRoot` ITSELF once and cache it — not
 * `.desde/backups` directly. Two reasons this matters, both found
 * by driving the actual exploit rather than reasoning about the guard in
 * isolation:
 *
 *  1. `.desde/backups` may not exist yet (a repo that has never had
 *     an edit journal a backup) even though a LEDGER entry can still
 *     legitimately carry no `backupDir` — realpathing that path directly
 *     would ENOENT and make every containment check fail closed for a
 *     reason that has nothing to do with the exploit.
 *  2. `canonicalRoot` itself can sit behind a symlinked ancestor outside
 *     the repo's own control — on macOS, `TMPDIR` resolves under `/var`,
 *     which is itself `/private/var`. Realpathing only the backups
 *     subdirectory, then lexically joining `.desde/backups/<dir>`
 *     onto the UNRESOLVED `canonicalRoot` for the candidate side, compares
 *     a `/var/...` string against a `/private/var/...` string — two
 *     spellings of the identical directory that a plain `startsWith`
 *     cannot see as equal. MEASURED: this exact mismatch turned every
 *     legitimate undo in the test suite into a false `backup-gone`
 *     refusal on this machine — caught by the pre-existing regression
 *     tests going red for the wrong reason, not by the new exploit tests.
 *
 * Realpathing `canonicalRoot` once and deriving `.desde/backups` as
 * a plain string join onto THAT resolved root keeps both sides of every
 * containment check on the same, already-canonical footing.
 */
function repoRootRealResolver(canonicalRoot: string): () => Promise<ResolvedRoot | null> {
  let cached: Promise<ResolvedRoot | null> | undefined
  return () => {
    cached ??= realpathAsync(canonicalRoot).then(
      (rootReal) => ({ rootReal, rootWithSep: rootReal.endsWith(pathSep) ? rootReal : rootReal + pathSep }),
      () => null,
    )
    return cached
  }
}

/**
 * Resolve `segments` (a `backupDir`, optionally followed by a repo-relative
 * file) onto the repo root and refuse unless the result sits under
 * `.desde/backups` — see `createRealUndoDeps`'s doc comment for the
 * exploit this closes.
 *
 * Two-phase, mirroring `resolve-editable-path.ts`'s pattern (the shared
 * guard for a client-request-supplied path; this is the same shape
 * applied to a ledger-file-supplied one, checked against a narrower
 * root):
 *
 *  1. A lexical containment check on `path.resolve(repoRootReal,
 *     ...segments)` — joined onto the ALREADY-REALPATH'D repo root, not
 *     the raw `canonicalRoot` (see {@link repoRootRealResolver}) — BEFORE
 *     touching the filesystem for the candidate itself. Refuses an
 *     obvious `../../../../etc/passwd`-style escape (or a `backupDir`
 *     given as a bare absolute path, which `path.resolve` would
 *     otherwise treat as its own anchor) without ever stat-ing or
 *     reading anything outside the repo.
 *  2. `fs.realpath` on the candidate, then the SAME containment check
 *     again on the resolved path — closes the case a lexical check
 *     alone cannot see: a symlink planted INSIDE `.desde/backups/`
 *     (or one of its ancestors) whose target lives outside it. Realpath
 *     resolves every symlink in the chain, not just the leaf.
 *
 * Returns `null` on any escape, or if the candidate doesn't exist —
 * every caller treats that identically to an ordinary missing backup.
 */
async function resolveContainedBackupPath(
  repoRootReal: () => Promise<ResolvedRoot | null>,
  segments: string[],
): Promise<string | null> {
  const root = await repoRootReal()
  if (!root) return null
  const backupsRoot = joinPath(root.rootReal, ".desde", "backups")
  const backupsRootWithSep = backupsRoot.endsWith(pathSep) ? backupsRoot : backupsRoot + pathSep
  const candidate = resolvePath(root.rootReal, ...segments)
  if (!isWithinRoot(candidate, backupsRoot, backupsRootWithSep)) return null
  let real: string
  try {
    real = await realpathAsync(candidate)
  } catch {
    return null
  }
  if (!isWithinRoot(real, backupsRoot, backupsRootWithSep)) return null
  return real
}

/**
 * {@link UndoDeps} over the real filesystem, for `handleLedgerUndoRequest`
 * below. `currentContent` caches each file's bytes the moment `hashFile`
 * reads them — `planLedgerUndo` calls `hashFile` once per file in
 * `entry.files` before it ever builds an op (see its doc comment: the
 * drift check runs before the ops are built), so by the time the handler
 * needs bytes to journal, every file it will touch is already cached.
 * That means the journal is built from the EXACT bytes the drift check
 * verified, not a second, separate read that could — in principle —
 * observe something different.
 *
 * **P1 (codex review round 5, 2026-08-20, SECURITY).** `entry.backupDir`
 * (and, jointly with it, each per-file backup path) comes straight from
 * the ledger file — `.desde/edit-log.jsonl` lives INSIDE the
 * repository, so every field in it is attacker-controlled for anyone who
 * can get a repo opened in the Editor, exactly like any other
 * repo-authored content. Before this fix, `backupDirExists` /
 * `backupHasFile` / `readBackup` joined `backupDir` (and `backupDir` +
 * `repoRel`) straight onto `canonicalRoot` with NO containment check at
 * all. A crafted entry with `backupDir: "../../../../home/user/.ssh"`,
 * `files: ["id_rsa"]` (naming something that also exists there), and an
 * `afterHashes` matching an in-repo placeholder the attacker also ships,
 * made clicking Undo READ the external file and WRITE its bytes into the
 * repo, at a path the attacker can read back — the "safe local undo"
 * button became exfiltration of anything readable on disk.
 *
 * `entry.files` itself (the WRITE-side destination) does NOT need the
 * same fix here: `handleLedgerUndoRequest` already re-verifies every
 * write target with a `precondition`, and `brokeredWrite`'s
 * `captureSnapshot` already realpaths + contains that precondition
 * against `canonicalRoot` (`write-broker.ts`'s P1-2, round 3). The gap
 * was specifically the READ side, which had no equivalent check —
 * closed here with `resolveContainedBackupPath`, scoped to the narrower
 * `.desde/backups` root the task specifies (not just `canonicalRoot`
 * generally, which would still have allowed reading elsewhere inside the
 * repo, e.g. `.git/config`).
 *
 * **P1 (codex review round 6, 2026-08-20, SECURITY): the round-5 fix
 * above closed the path, not the race.** `resolveContainedBackupPath`
 * validates a PATH STRING; the original `readBackup` then did a SEPARATE
 * `readFileAsync(real)` against that same string — two independent
 * filesystem operations with a gap between them. A process inside the
 * repo (anything that can run in the working tree the Editor opened) can
 * replace the regular file at `real` with a symlink to an arbitrary host
 * file in that gap; `readFileAsync` follows symlinks, so the read would
 * follow the swap. `readBackup` below now opens with `O_NOFOLLOW` and
 * does the `fstat`+read on that SAME handle, so what gets validated and
 * what gets read are provably the same file — see its own comment for
 * the mechanism and for why the realpath check here still has to stay
 * (it, not `O_NOFOLLOW`, is what catches a swapped INTERMEDIATE
 * directory component).
 */
function createRealUndoDeps(canonicalRoot: string): {
  deps: UndoDeps
  currentContent: Map<string, Buffer>
} {
  const currentContent = new Map<string, Buffer>()
  const repoRootReal = repoRootRealResolver(canonicalRoot)
  const deps: UndoDeps = {
    hashFile: async (repoRel) => {
      try {
        const content = await readFileAsync(joinPath(canonicalRoot, repoRel))
        currentContent.set(repoRel, content)
        return hashContent(content)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null
        throw err
      }
    },
    backupDirExists: async (backupDir) => {
      const real = await resolveContainedBackupPath(repoRootReal, [backupDir])
      if (real === null) return false
      try {
        const info = await statAsync(real)
        return info.isDirectory()
      } catch {
        return false
      }
    },
    backupHasFile: async (repoRel, backupDir) => {
      const real = await resolveContainedBackupPath(repoRootReal, [backupDir, repoRel])
      if (real === null) return false
      try {
        await statAsync(real)
        return true
      } catch {
        return false
      }
    },
    readBackup: async (repoRel, backupDir) => {
      // Re-validated independently rather than trusted from a prior
      // `backupHasFile` call — this function is part of the security
      // boundary itself (see the doc comment above), not just a
      // convenience wrapper that can lean on caller ordering.
      const real = await resolveContainedBackupPath(repoRootReal, [backupDir, repoRel])
      if (real === null) {
        throw new Error(
          `Backup path for '${repoRel}' escapes the backups directory. Refusing to read it.`,
        )
      }
      // P1 (codex review round 6, SECURITY): `resolveContainedBackupPath`
      // above and the read used to be two separate path operations — a
      // validate-then-open race (TOCTOU). A process inside the repo can
      // replace the regular file AT `real` with a symlink to an
      // arbitrary host file in the gap between the containment check
      // returning and a plain `readFileAsync(real)` running; the plain
      // read follows symlinks, so it would follow the swap and copy the
      // external file's bytes into the repo (Undo's "restore" write
      // reads whatever this function returns).
      //
      // The fix: open with `O_NOFOLLOW` and do every subsequent
      // operation — `fstat`, then the read itself — on the SAME open
      // handle, never on a second path lookup. `O_NOFOLLOW` makes the
      // `open` itself fail atomically (ELOOP) if the final path
      // component is a symlink AT THE MOMENT OF THE OPEN, and once open
      // succeeds the handle is bound to a specific inode — a directory
      // entry replaced afterward cannot change what that handle reads.
      // So the bytes returned here are provably the bytes of the file
      // `open` actually validated, not of whatever now sits at `real`'s
      // path string.
      //
      // `O_NOFOLLOW` only inspects the FINAL path component — an
      // intermediate directory in `real` being swapped for a symlink is
      // a separate hazard it does not cover. That is exactly what the
      // realpath containment check above (`resolveContainedBackupPath`)
      // exists for: the two are complementary, and neither replaces the
      // other.
      //
      // **P1-2 (codex review round 7, SECURITY): an INTERMEDIATE
      // directory swap defeats both of the above.** `resolveContainedBackupPath`
      // validates a PATH STRING (it realpaths the whole chain, including
      // `backupDir` itself); `O_NOFOLLOW` only refuses if `real`'s FINAL
      // component is a symlink at open time. Neither survives `backupDir`
      // (e.g. `.desde/backups/<uuid>`) being replaced with a symlink
      // in the gap between the containment check returning and this
      // `openAsync` call: `open()` re-walks the WHOLE path string, so it
      // follows a symlinked intermediate exactly like the shell would,
      // landing on whatever the attacker's directory points at — and
      // `O_NOFOLLOW` never sees it, because the leaf component itself
      // (whatever real file the attacker placed at that name) is not a
      // symlink.
      //
      // Node's `fs`/`fs/promises` expose no `openat`/dirfd primitive
      // (checked directly against this repo's installed Node and
      // `@types/node` — neither the runtime nor the type declarations
      // carry one), so there is no way to pin the open to an
      // already-validated DIRECTORY handle the way a true relative-open
      // would — that would be the only mechanism that removes this
      // window rather than narrowing it. Recovered instead with a
      // check-open-recheck sandwich: after the open (and its `fstat`)
      // succeed, `resolveContainedBackupPath` runs AGAIN, fresh, and the
      // freshly-resolved path's `lstat` identity (`dev`+`ino`) is
      // compared to the identity of the handle actually opened. A
      // mismatch — including the recheck finding nothing, or finding
      // something no longer contained — means the path resolved
      // differently between the two calls, so the read is discarded and
      // this refuses instead of trusting it.
      //
      // This does not eliminate the window the way a dirfd-relative open
      // would (there is still a gap between the recheck's own `lstat` and
      // the moment it runs) — it narrows it to the smallest span pure-JS
      // path operations can achieve, and it forces the attacker to make
      // BOTH resolutions agree: to defeat the recheck, a swap-back must
      // resolve to something that (a) passes containment under
      // `.desde/backups` AND (b) shares the exact same device+inode
      // as whatever the open actually read — which for content outside
      // the repo means a same-filesystem hard link the attacker can
      // place THROUGH `.desde/backups`, a materially stronger
      // requirement than "can run a process in the repo." See the
      // round-7 fix report for the full reasoning and the residual this
      // still leaves open.
      let handle
      try {
        handle = await openAsync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      } catch {
        throw new Error(
          `Backup path for '${repoRel}' was replaced with a symlink. Refusing to read it.`,
        )
      }
      try {
        const info = await handle.stat()
        if (!info.isFile()) {
          throw new Error(
            `Backup path for '${repoRel}' is not a regular file. Refusing to read it.`,
          )
        }
        const recheckedReal = await resolveContainedBackupPath(repoRootReal, [backupDir, repoRel])
        if (recheckedReal === null) {
          throw new Error(
            `Backup path for '${repoRel}' escapes the backups directory. Refusing to read it.`,
          )
        }
        // `lstat`, not `stat`: `recheckedReal` is realpath's own output, so
        // it should already name no symlink — using the non-following
        // stat means a symlink placed at that exact leaf in the instant
        // between the resolve above and this call is itself detected as
        // a mismatch (a symlink's own inode essentially never coincides
        // with the regular file `handle` already has open), rather than
        // silently followed into agreeing with the wrong thing.
        const recheckedInfo = await lstatAsync(recheckedReal)
        if (recheckedInfo.dev !== info.dev || recheckedInfo.ino !== info.ino) {
          throw new Error(
            `Backup path for '${repoRel}' changed while it was being read. Refusing to use it.`,
          )
        }
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },
  }
  return { deps, currentContent }
}

/**
 * `POST /api/editor/ledger/:id/undo` — Plan B's per-entry undo.
 *
 * Restores the file(s) one ledger `edit` entry touched to their pre-edit
 * bytes, ONLY when nothing has touched them since — see
 * `planLedgerUndo`'s doc comment (`src/editor/ledger/undo-entry.ts`) for
 * the safety rule and the backup cases it distinguishes. A refusal never
 * writes anything: both the branch check and `planLedgerUndo` run
 * entirely before the single `brokeredWrite` call below, and each
 * returns either a go-ahead or a typed refusal — there is no path from a
 * refusal to a write.
 *
 * Takes the SAME per-file + shared-tree-gate lock the toolbar undo/redo
 * route takes below (`withFileEditLocks`), around planning, the branch
 * check, AND the write — not just the write. Planning re-reads the
 * files' current hashes from disk, so if it ran outside the lock a
 * concurrent edit or a Commit could land between "we checked the hash"
 * and "we wrote the restore," reintroducing exactly the ordering hazard
 * Plan A spent four rounds fixing (see `handleLedgerRequest`'s doc
 * comment above for the shared-tree-gate rationale this route reuses).
 *
 * **P1-1 (codex review finding, 2026-08-20): the branch check.** The
 * Activity panel's own ledger poll is inherently stale between ticks
 * (`useEditorLedger`'s `POLL_INTERVAL_MS`). If a branch switch completes
 * in that window, the panel can still show a row from the branch the
 * user just left, and a click on it must not restore that OTHER
 * branch's backup onto the branch now checked out — even when the
 * bytes happen to match (e.g. a new branch created from the exact commit
 * the edit produced), which is precisely the case the hash-only drift
 * check can't catch on its own. The current branch is read HERE, inside
 * the shared-tree-gate window `withFileEditLocks` already holds, so a
 * concurrent branch switch (which takes that gate EXCLUSIVE) cannot land
 * between this read and the write below.
 *
 * **P1-1 round 2 (codex review finding, 2026-08-20): reusing
 * `isOrphanedBranch` here was wrong.** The first pass authorized the
 * write with the SAME predicate `handleLedgerRequest` uses to decide
 * what to DISPLAY — `editBelongsToBranch(...) || isOrphanedBranch(...)`.
 * `isOrphanedBranch` is documented (`rename-aliases.ts`) as a
 * DISPLAY-ONLY fail-open: it exists so a branch renamed outside the
 * product, or genuinely deleted, doesn't permanently hide its history
 * from the panel — showing an extra row is the smaller harm. Authorizing
 * a MUTATION is the opposite posture: if the entry's recorded branch no
 * longer exists (deleted after a merge, say) and the branch now checked
 * out happens to hold byte-identical content — exactly what a merge
 * produces — `isOrphanedBranch` fails open and the write proceeds,
 * restoring the deleted branch's backup onto whatever is checked out
 * now. `undoAuthorizedForBranch` below is the write-authorization rule:
 * it requires PROVEN ownership (`editBelongsToBranch` alone — an exact
 * match, or no branch recorded at all) and refuses on anything
 * unprovable, including an orphaned branch. This is a DIFFERENT
 * function from the GET route's display filter on purpose — see its own
 * doc comment. Do not fold them back into one predicate.
 *
 * One `brokeredWrite` call for the whole entry, never one per file — its
 * all-or-nothing rollback is what makes "never a partial restore" true
 * at the filesystem level; per-file calls would throw that away.
 *
 * **P1-2 (codex review finding, 2026-08-20): preconditions close a
 * second TOCTOU.** `withFileEditLocks` above and `brokeredWrite`'s own
 * `FileLockManager` are documented SEPARATE namespaces (Task 1's review
 * finding) — an SDK structural tool calls `brokeredWrite` directly,
 * taking only the latter, so it can land in the gap between
 * `planLedgerUndo`'s own (unlocked) reads and `brokeredWrite`'s lock
 * acquisition for the same file. `preconditions` closes that the same
 * way `EditorEditHistory.applyTop`'s undo/redo already does (see
 * `edit-history.ts`): the exact bytes the plan verified are re-checked
 * ATOMICALLY, under the broker's own lock, right before the write —
 * see `BrokeredWriteOptions.preconditions`'s doc comment.
 *
 * **P2-3 (codex review round 3, 2026-08-20): this write is ALSO recorded
 * as a toolbar undo/redo step.** Before this fix, an Activity-panel Undo
 * wrote through `brokeredWrite` with no `record` option, so
 * `EditorEditHistory` (the toolbar's own undo/redo stack,
 * `handleHistoryRequest` below) never learned the file changed. Its top
 * step kept expecting the ORIGINAL edit's after-bytes, which this write
 * had just replaced — so the toolbar reported `canUndo: true` for a step
 * that was already stranded, and clicking it asked the user to discard a
 * step that was, from the file's actual state, already undone. `record`
 * closes this the same way every other write lane already does. See the
 * `record` option's own inline comment below for why this doesn't
 * reopen the ABBA hazard `BrokeredWriteOptions['record']` documents.
 */

/**
 * Whether `handleLedgerUndoRequest` may authorize a write against
 * `resolvedBranch`, the entry's own resolved branch identity (from
 * `resolveEditBranches`), given `checkedOutBranch` right now.
 *
 * Deliberately narrower than `handleLedgerRequest`'s display filter,
 * which also accepts `isOrphanedBranch` (`rename-aliases.ts`) — that
 * helper's own doc comment states it is for a caller deciding what to
 * DISPLAY, never one deciding what to durably RECORD or, as here, what
 * to overwrite. A write needs PROVEN ownership: an exact match (carried
 * forward through the ledger's own `rename` lines, which ARE reliable —
 * see `resolveEditBranches`), or no branch recorded at all (pre-migration
 * entries; `editBelongsToBranch` treats that as always-eligible, the
 * same rule `resolveCommitState` uses). Anything else — including a
 * branch that no longer exists, whether deleted or renamed outside the
 * product — refuses. See the P1-1 round-2 doc comment above for the
 * concrete exploit this closes.
 */
function undoAuthorizedForBranch(
  resolvedBranch: string | undefined,
  checkedOutBranch: string | undefined,
): boolean {
  return editBelongsToBranch(resolvedBranch, checkedOutBranch)
}

async function handleLedgerUndoRequest(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const id = parseLedgerEntryIdFromPath(res, url.pathname)
  if (id === null) return

  const entries = await readLedger(ctx.repoRoot)
  const entry = editEntries(entries).find((e) => e.id === id)
  if (!entry) {
    sendJson(res, 404, { ok: false, reason: "No edit found with that id." })
    return
  }

  type UndoOutcome =
    | { status: "refused"; plan: Extract<UndoPlan, { ok: false }> }
    | { status: "written"; broker: Awaited<ReturnType<typeof brokeredWrite>> }

  try {
    const outcome: UndoOutcome = await withFileEditLocks(ctx.repoRoot, entry.files, async (): Promise<UndoOutcome> => {
      // P1-1 round 2: resolved HERE, under the lock — see the doc comment
      // above. `undoAuthorizedForBranch` deliberately does NOT accept
      // `isOrphanedBranch` — see that function's own doc comment for why
      // a write needs PROVEN ownership, not the GET route's display-only
      // fail-open guess.
      //
      // P1-3 (codex review round 7): `checkedOutBranch` and
      // `headAtBranchCheck` come from the SAME `.git/HEAD` read
      // (`resolveBranchCachedWithHead`), not two separate calls — see
      // `BranchResolution`'s doc comment (`edit-ledger.ts`) for the gap a
      // separate later read would leave open. `headAtBranchCheck` is the
      // "before" half of a bracket closed right before the mutation below.
      const resolvedBranch = resolveEditBranches(entries).get(entry.id)
      const branchResolution = await resolveBranchCachedWithHead(ctx.repoRoot)
      const checkedOutBranch = branchResolution.name
      const headAtBranchCheck = branchResolution.head
      if (!undoAuthorizedForBranch(resolvedBranch, checkedOutBranch)) {
        return {
          status: "refused",
          plan: {
            ok: false,
            code: "wrong-branch",
            reason:
              `This edit was made on branch '${resolvedBranch}'` +
              (checkedOutBranch ? `, not the checked-out branch ('${checkedOutBranch}')` : "") +
              ", so it can't be undone from here.",
          },
        }
      }

      const { deps, currentContent } = createRealUndoDeps(ctx.repoRoot)
      const plan = await planLedgerUndo(entry, deps)
      if (!plan.ok) return { status: "refused", plan }

      const journal: { file: string; content: Buffer }[] = []
      const ops: BrokerOp[] = []
      // P1-2: mirrors `entry.files`/`plan.ops` — one precondition per
      // file the plan verified, so `brokeredWrite` re-checks the SAME
      // bytes atomically under its own lock. See the doc comment above.
      const preconditions: { repoRel: string; absPath: string; expect: { exists: boolean; content: Buffer | null } }[] = []
      for (const op of plan.ops) {
        const absPath = joinPath(ctx.repoRoot, op.repoRel)
        // Every restored/deleted file needs a journal entry — a delete
        // with none is unrecoverable, and `brokeredWrite` refuses it as
        // a caller bug (see its doc comment). The cached bytes are
        // exactly what the drift check inside `planLedgerUndo` already
        // verified still matches `afterHashes`, so this is exactly the
        // "before" state this undo is about to overwrite.
        const before = currentContent.get(op.repoRel)
        if (before) {
          journal.push({ file: op.repoRel, content: before })
          preconditions.push({ repoRel: op.repoRel, absPath, expect: { exists: true, content: before } })
        }
        ops.push(
          op.kind === "restore"
            ? { kind: "write", repoRel: op.repoRel, absPath, content: op.content }
            : { kind: "delete", repoRel: op.repoRel, absPath },
        )
      }

      // P1-3 (codex review round 7): `withFileEditLocks` above is
      // IN-PROCESS ONLY — it cannot stop a `git checkout`/`git switch`
      // typed in the user's own terminal, or a second Editor process on
      // this repo, from moving HEAD between the branch-ownership check
      // above and the mutation below. `undoAuthorizedForBranch` already
      // proved ownership against `checkedOutBranch`, but if HEAD moved
      // since, that answer no longer describes what is actually checked
      // out — and `planLedgerUndo`'s hash-only drift check cannot see a
      // branch switch onto a tree that coincidentally holds the exact
      // post-edit bytes (a branch cut from the exact commit the edit
      // produced is exactly this case). Bracketing with a second raw
      // HEAD read, immediately before the write, and refusing on any
      // disagreement closes the same window `handleLedgerRequest`'s own
      // reconcile step closes for its dirty-status snapshot — see that
      // function's doc comment, point 7, for the identical reasoning
      // applied there first; this reuses the same helper and the same
      // discipline rather than inventing a second one.
      //
      // `readGitHeadRaw`'s RAW ref content is the deliberate choice here,
      // not `headSha`'s resolved commit sha: an ordinary commit on the
      // SAME branch leaves `ref: refs/heads/<name>` byte-identical (see
      // `LedgerEditEntry.headAtWrite`'s doc comment for that exact
      // correction), and this guard is specifically about a BRANCH
      // SWITCH, which DOES retarget the ref. A same-branch commit landing
      // in this window is a different case, already covered by the
      // byte-level precondition check `brokeredWrite` runs below.
      //
      // `undefined` (a read failure, not merely "unchanged") refuses the
      // same as a genuine mismatch — proceeding on a vacuous "both reads
      // failed the same way" would be exactly the wrong direction for a
      // guard whose entire job is refusing when it cannot prove HEAD held
      // still.
      const headAtWrite = await readGitHeadRaw(ctx.repoRoot)
      if (headAtWrite === undefined || headAtWrite !== headAtBranchCheck) {
        return {
          status: "refused",
          plan: {
            ok: false,
            code: "wrong-branch",
            reason: "The checked-out branch changed while preparing this undo, so it can't be undone from here.",
          },
        }
      }

      const broker = await brokeredWrite({
        canonicalRoot: ctx.repoRoot,
        journal,
        ops,
        preconditions,
        // `fields.step` feeds `describeLedgerEntry`'s `'undo'` case
        // ("Undid: <step>") — the human description of the ORIGINAL
        // entry, not the raw entry itself. `reverts: entry.id` is P1-2
        // (codex review round 3, 2026-08-20) — see
        // `LedgerEditEntry.reverts`'s doc comment for why
        // `reconcileLedger` needs this to avoid durably (and wrongly)
        // marking both this write and the entry it reverts committed.
        describe: {
          kind: "undo",
          lane: "undo",
          fields: { step: describeLedgerEntry(entry) },
          reverts: entry.id,
        },
        // P2-3 (codex review round 3, 2026-08-20): without this, the
        // toolbar's OWN undo/redo stack (`EditorEditHistory`,
        // `handleHistoryRequest` below) never learns this write
        // happened. Its top step keeps expecting the file to hold the
        // ORIGINAL edit's after-bytes — which this ledger undo just
        // replaced with the pre-edit bytes — so the toolbar's Undo
        // button still reports `canUndo: true` for a step that is now
        // stranded (byte-mismatch), and clicking it asks the user to
        // discard a step that is already effectively undone. Passing
        // `record` here records THIS restore as its own history step
        // (the same mechanism every other write lane uses —
        // `applyEdit`, `fs-structural-tools.ts`'s `delete_file`, …), so
        // the toolbar's next Undo correctly targets THIS write (i.e.
        // re-applies the original edit) instead of a stale one. Safe
        // under the ABBA hazard `BrokeredWriteOptions['record']`'s doc
        // comment documents: `brokeredWrite` always defers the actual
        // `history.record()` call to its OWN post-lock region — after
        // this call's `ops` have released the broker's file locks — so
        // this route's outer `withFileEditLocks` gate (a different,
        // per-file CLI-level lock, never itself acquired from inside
        // the history chain or the broker's locks) never overlaps with
        // a held broker lock while the history chain runs.
        record: {
          history: getSharedEditHistory(),
          label: `Undo: ${describeLedgerEntry(entry)}`,
        },
      })
      return { status: "written", broker }
    })

    if (outcome.status === "refused") {
      sendJson(res, 409, { ok: false, code: outcome.plan.code, reason: outcome.plan.reason })
      return
    }

    const { broker } = outcome
    if (!broker.ok) {
      // P1-2: a precondition loss means a concurrent writer changed the
      // file in the gap between `planLedgerUndo`'s read and this call's
      // own lock acquisition — from the user's perspective, the SAME
      // situation `planLedgerUndo`'s own `drifted` refusal reports, just
      // caught at the later, atomic checkpoint instead of the earlier,
      // racy one. Same code, same 409 shape, same wording — one
      // consistent story regardless of which checkpoint caught it.
      if (broker.stage === "precondition") {
        sendJson(res, 409, {
          ok: false,
          code: "drifted",
          reason: `'${broker.repoRel}' changed after this edit, so it can't be undone.`,
        })
        return
      }
      sendJson(res, broker.stage === "refused" ? 403 : 500, {
        ok: false,
        reason:
          broker.stage === "backup"
            ? `${broker.reason} Undo aborted; no source files modified.`
            : broker.stage === "refused"
              ? broker.reason
              : `Could not undo: ${broker.reason}${rollbackWarning(broker)}`,
      })
      return
    }

    ctx.invalidateFiles?.(entry.files)
    invalidateGitStatusCache(ctx.repoRoot)
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: `Could not undo: ${(err as Error).message}` })
  }
}

/**
 * The CLI's complete HTTP surface, in dispatch order.
 *
 * Dispatch is FIRST MATCH: `routeRequest` walks this table top-to-bottom,
 * takes the first entry whose method + path match, applies that entry's
 * `authPolicy`, then runs its handler. Nothing is gated implicitly — the
 * old hand-maintained "read-only GET" allowlist (a ~20-branch boolean
 * evaluated before dispatch) is now expressed as per-route `authPolicy`
 * declarations, so a route's posture is visible where the route is defined.
 *
 * Order-sensitive neighbours — moving these changes behavior:
 *  1. `GET /mcp/status` before the `/mcp/*` catch-all (which 404s, but only
 *     AFTER the shared bearer check — an unauthenticated caller must not be
 *     able to probe which MCP endpoints exist).
 *  2. `POST /api/editor/mcp/tool/*` and `GET …/shell-bridge/poll` before
 *     every other `/api/` entry: they run the `if-present` Origin policy
 *     that the rest of `/api/` deliberately does not.
 *  3. `GET …/chat/sessions` (exact) before the `…/chat/sessions/*` prefix
 *     entries; and `…/:id/lock-events` before the bare `…/:id` detail entry
 *     (the detail prefix would otherwise swallow it and 400 on the embedded
 *     slash).
 *  4. The `if-present` GET slices of the prefix-matched routes
 *     (comments / notes / screenshot-plans / canvases / design-systems /
 *     drift) before their `ANY`-method siblings — that split IS the old
 *     read-only-GET allowlist.
 *  5. The `/api/*` 404 fallback before the static catch-all, so an unknown
 *     `/api/` path 404s (after auth) instead of falling into static serving.
 *  6. The static `GET /*` catch-all last; anything it doesn't match 405s.
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // html2canvas for the bridge's screenshot capture — PUBLIC (no auth): the
  // prototype iframe loads it as a plain cross-origin <script>, resolving the
  // URL against its referrer (this shell's origin). Same role the Next shell's
  // `public/` plays in the viewer. GET/HEAD only (enforced in the handler).
  {
    method: "ANY",
    path: "/vendor/html2canvas.min.js",
    authPolicy: "none",
    handler: (req, res, ctx) => serveHtml2canvas(req, res, ctx.html2canvasPath),
  },

  // MCP routes — `if-present` Origin. MCP clients (CLI agents, IDE-proxied
  // integrations) often don't send browser-style `Origin` headers, so
  // requiring it would make the endpoint unreachable for legitimate
  // consumers. The bearer token is the load-bearing CSRF defense; the Origin
  // check still rejects mismatched browser-originated calls (defense in
  // depth).
  {
    method: "GET",
    path: "/mcp/status",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) =>
      handleStatusQuery(res, {
        repoRoot: ctx.repoRoot,
        platformBaseUrl: ctx.mcp?.platformBaseUrl,
      }),
  },
  {
    method: "ANY",
    path: "/mcp/*",
    match: (pathname) => pathname.startsWith("/mcp/"),
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res) =>
      sendJson(res, 404, { ok: false, reason: "Unknown MCP endpoint" }),
  },

  // MCP-proxy tool dispatch — same `if-present` Origin policy as `/mcp/*`.
  // The proxy is a Node subprocess; it sends a bearer token but no Origin
  // header. The companion shell-bridge REPLY endpoint below IS
  // browser-originated and stays on the strict policy.
  {
    method: "POST",
    path: `${MCP_TOOL_PREFIX}*`,
    match: (pathname) => pathname.startsWith(MCP_TOOL_PREFIX),
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, _ctx, url) =>
      dispatchMcpToolHttp(req, res, url.pathname.slice(MCP_TOOL_PREFIX.length)),
  },

  // Shell-bridge long-poll — `if-present` because browsers do NOT attach
  // `Origin` to same-origin GET requests (CSRF risk is negligible without a
  // side effect). The bearer token is still required and is the load-bearing
  // CSRF defense. The companion POST /shell-bridge/reply is strict — browsers
  // DO attach `Origin` to same-origin POSTs.
  {
    method: "GET",
    path: "/api/editor/shell-bridge/poll",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res) => handleShellBridgePoll(res),
  },

  // --- /api/* ---------------------------------------------------------
  // Path-aligned with the web app's /api/editor/edit route so the vue3
  // adapter doesn't need a per-mode endpoint. The CLI process has no Next
  // router, so there's no conflict with the web app's route file.
  {
    method: "POST",
    path: "/api/editor/edit",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleEditRequest(req, res, ctx),
  },
  // Branch operations. List is read-only and safe anywhere; the mutations
  // are gated on branch mode inside the handler.
  {
    method: "GET",
    path: "/api/editor/branches",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleListBranchesRequest(res, ctx),
  },
  // Edit ledger — read-only, same posture as the branches list above.
  {
    method: "GET",
    path: "/api/editor/ledger",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleLedgerRequest(res, ctx),
  },
  // Per-entry undo (Plan B, Task 1). Mutates the working tree, so it
  // takes the full CSRF posture — unlike the read-only GET above.
  {
    method: "POST",
    path: `${LEDGER_PREFIX}:id${LEDGER_UNDO_SUFFIX}`,
    match: matchesLedgerUndoRoute,
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx, url) => handleLedgerUndoRequest(res, ctx, url),
  },
  // Breadcrumb "home" → the launcher's project picker. Lazily starts a
  // launcher (shared per process) and returns its URL. The side effect is
  // starting a launcher, not mutating the repo — safe as a read-only GET
  // for the Origin policy.
  {
    method: "GET",
    path: "/api/editor/home",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleHomeRequest(res, ctx),
  },
  // Viewer comment sync. `bearer-origin-required` like every other mutating
  // editor route: the proxy carries a real viewer credential, so anything
  // that can call it can act on the linked project.
  {
    method: "POST",
    path: VIEWER_PROBE_ROUTE,
    authPolicy: "bearer-origin-required",
    handler: (req, res) => handleViewerProbe(req, res),
  },
  {
    method: "GET",
    path: "/api/editor/viewer-auth",
    // Read-only status probe. Must be `if-present` — with `required` the
    // UI's own GET 403s (no Origin on a same-origin GET), so
    // `useViewerAuthStatus` never sees the stored token and the Editor
    // silently stays in local-comment mode with the viewer configured.
    authPolicy: "bearer-origin-if-present",
    handler: handleViewerAuthStatus,
  },
  {
    method: "POST",
    path: "/api/editor/viewer-auth",
    authPolicy: "bearer-origin-required",
    handler: handleViewerAuthSet,
  },
  {
    method: "DELETE",
    path: "/api/editor/viewer-auth",
    authPolicy: "bearer-origin-required",
    handler: handleViewerAuthClear,
  },
  // Split by method, on purpose.
  //
  // The comment store issues GET/POST/PATCH/DELETE plus an SSE GET. A single
  // ANY route had to pick one Origin posture, and `required` made every READ
  // through the proxy 403 from the Editor's own UI: browsers do not send
  // `Origin` on a same-origin GET and page JS cannot add it. Writes were
  // fine (same-origin POST/PATCH/DELETE do carry Origin), so the seam looked
  // half-working — which is also why curl probes missed it, since curl sends
  // whatever Origin you tell it to.
  //
  // Reads therefore use `if-present` (a mismatched Origin is still rejected;
  // the bearer remains the load-bearing defense, and a cross-origin attacker
  // could not read the response anyway without CORS headers). Writes keep
  // `required` — full CSRF posture for anything state-changing.
  {
    method: "GET",
    path: `${VIEWER_PROXY_PREFIX}/`,
    match: (pathname) => pathname.startsWith(`${VIEWER_PROXY_PREFIX}/`),
    authPolicy: "bearer-origin-if-present",
    handler: async (req, res, ctx) => {
      // The repo's committed link if it has one, otherwise whatever the
      // machine's default viewer resolved this repo to. See
      // `effectiveViewerConfig` for why committed always wins.
      const handled = await handleViewerProxy(
        req,
        res,
        effectiveViewerConfig(
          {
            baseUrl: ctx.project?.platformBaseUrl ?? null,
            projectId: ctx.project?.projectId ?? null,
          },
          await getViewerLink(ctx.repoRoot),
        ),
      )
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Not a proxyable viewer API path" }))
      }
    },
  },
  {
    method: "ANY",
    path: `${VIEWER_PROXY_PREFIX}/`,
    match: (pathname) => pathname.startsWith(`${VIEWER_PROXY_PREFIX}/`),
    authPolicy: "bearer-origin-required",
    handler: async (req, res, ctx) => {
      // The repo's committed link if it has one, otherwise whatever the
      // machine's default viewer resolved this repo to. See
      // `effectiveViewerConfig` for why committed always wins.
      const handled = await handleViewerProxy(
        req,
        res,
        effectiveViewerConfig(
          {
            baseUrl: ctx.project?.platformBaseUrl ?? null,
            projectId: ctx.project?.projectId ?? null,
          },
          await getViewerLink(ctx.repoRoot),
        ),
      )
      // `handleViewerProxy` returns false — writing nothing — when
      // `proxyTargetPath` refuses the URL: anything under the proxy prefix
      // that is not `/api/v1/**`, including a `..` traversal.
      //
      // This route's `match` is prefix-only, so those requests still land
      // here. Until 2026-08-09 the return value was discarded, so no response
      // was ever written and the request HUNG until the client timed out —
      // the refusal the proxy carefully computed simply never arrived, and
      // the socket stayed open. Found by driving the live seam; the unit
      // tests cover `proxyTargetPath` in isolation and never exercised what
      // the server does with its answer.
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Not a proxyable viewer API path" }))
      }
    },
  },
  {
    method: "POST",
    path: "/api/editor/branches/switch",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchMutationRequest(req, res, ctx, "switch"),
  },
  {
    method: "POST",
    path: "/api/editor/branches/create",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchMutationRequest(req, res, ctx, "create"),
  },
  {
    method: "POST",
    path: "/api/editor/branches/rename",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchMutationRequest(req, res, ctx, "rename"),
  },
  {
    method: "POST",
    path: "/api/editor/branches/publish",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handlePublishRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/commit",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchCommitRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/discard",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchDiscardRequest(req, res, ctx),
  },
  // Toolbar undo/redo (Task 6 of the toolbar-undo-redo plan) — both
  // directions share one handler, `direction` selects which stack it pops.
  {
    method: "POST",
    path: "/api/editor/history/undo",
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx) => handleHistoryRequest(res, ctx, "undo"),
  },
  {
    method: "POST",
    path: "/api/editor/history/redo",
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx) => handleHistoryRequest(res, ctx, "redo"),
  },
  // Discard-stranded-step affordance (undo/redo follow-ups Task 3) — pops
  // the top of a stack WITHOUT applying it. No file locks: unlike undo/redo
  // this never touches disk.
  {
    method: "POST",
    path: "/api/editor/history/discard",
    authPolicy: "bearer-origin-required",
    handler: (req, res) => handleHistoryDiscardRequest(req, res),
  },
  {
    method: "POST",
    path: "/api/editor/branches/push",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchPushRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/merge-push",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleBranchMergePushRequest(req, res, ctx),
  },
  // Remote-freshness fetch. POST because it mutates the remote-tracking
  // refs; triggered by an explicit user action or the client's 60s+
  // interval, never the 2.5s branches poll.
  {
    method: "POST",
    path: "/api/editor/branches/fetch",
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx) => handleBranchFetchRequest(res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/update-from-default",
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx) => handleBranchUpdateFromDefaultRequest(res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/pull-remote",
    authPolicy: "bearer-origin-required",
    handler: (_req, res, ctx) => handleBranchPullRemoteRequest(res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/pull-request/preflight",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handlePullRequestPreflightRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/branches/pull-request",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handlePullRequestCreateRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/text-branches",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleTextBranchesRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/llm-fallback",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleLLMFallbackRequest(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/chat",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleChatRoute(req, res, ctx),
  },
  {
    method: "POST",
    path: "/api/editor/chat/bridge-reply",
    authPolicy: "bearer-origin-required",
    handler: (req, res) => handleBridgeReply(req, res),
  },
  // Mid-turn steering. Carries the SAME strict posture as `POST
  // /api/editor/chat` — it is the same act (the user sending the agent a
  // message), differing only in whether a turn happens to be running.
  {
    method: "POST",
    path: "/api/editor/chat/steer",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleSteerRequest(req, res, { repoRoot: ctx.repoRoot }),
  },
  // Phase 1 of tasks/editor-detached-sessions.md — the session list, its
  // per-session detail endpoint, and the lock-events timeline are read-only
  // browser GETs from `editorFetch`, which often omit `Origin`.
  {
    method: "GET",
    path: "/api/editor/chat/sessions",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleListChatSessionsRoute(res, ctx),
  },
  {
    method: "GET",
    path: `${CHAT_SESSIONS_PREFIX}:id/lock-events`,
    match: chatSessionSubroute("/lock-events"),
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx, url) =>
      handleChatSessionLockEventsRoute(res, ctx, url),
  },
  {
    method: "GET",
    path: `${CHAT_SESSIONS_PREFIX}:id`,
    match: (pathname) => pathname.startsWith(CHAT_SESSIONS_PREFIX),
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx, url) => handleChatSessionDetailRoute(res, ctx, url),
  },
  {
    method: "POST",
    path: "/api/editor/chat/edit-ack",
    authPolicy: "bearer-origin-required",
    handler: (req, res) => handleEditAck(req, res),
  },
  {
    method: "POST",
    path: `${CHAT_SESSIONS_PREFIX}:id/apply-merge-resolution`,
    match: chatSessionSubroute("/apply-merge-resolution"),
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) =>
      handleApplyMergeResolutionRoute(req, res, ctx, url),
  },
  {
    method: "POST",
    path: `${CHAT_SESSIONS_PREFIX}:id/resolve-conflict`,
    match: chatSessionSubroute("/resolve-conflict"),
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) => handleResolveConflictRoute(req, res, ctx, url),
  },
  {
    method: "POST",
    path: "/api/editor/shell-bridge/reply",
    authPolicy: "bearer-origin-required",
    handler: (req, res) => handleShellBridgeReplyRoute(req, res),
  },
  // Project-knowledge grounding badge — read-only GET polled by
  // useProjectKnowledge on shell mount.
  {
    method: "GET",
    path: "/api/editor/project-knowledge",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleProjectKnowledgeRoute(res, ctx),
  },
  // Design-system registry list + suggestions are read-only GETs the Design
  // Systems panel polls (same-origin, may omit Origin). Every other method
  // and sub-path under the prefix — the POST/DELETE mutations, `…/updates`,
  // generate-hints — stays strict.
  {
    method: "GET",
    path: "/api/editor/capabilities",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx, url) =>
      handleCapabilitiesRoute(req, res, { repoRoot: ctx.repoRoot }, url, sendJson),
  },
  {
    method: "POST",
    // Writes .mcp.json, which decides which subprocesses run — so it carries
    // the strict posture, not the lenient read one.
    path: "/api/editor/capabilities/enable",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) =>
      handleCapabilitiesRoute(req, res, { repoRoot: ctx.repoRoot }, url, sendJson),
  },
  {
    method: "POST",
    // Accepts a secret and writes it into `process.env`, which decides what
    // every subprocess inherits. Strict posture, without question.
    path: "/api/editor/capabilities/secret",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) =>
      handleCapabilitiesRoute(req, res, { repoRoot: ctx.repoRoot }, url, sendJson),
  },
  // Reference directories. The GET is a read-only list the settings dialog
  // polls (same-origin, may omit Origin); every mutation writes
  // desde.config.json — which decides what the agent can read —
  // so it carries the strict posture, same split as capabilities above.
  {
    method: "GET",
    path: "/api/editor/read-roots",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx, url) => handleReadRootsRoute(req, res, readRootsCtx(ctx), url),
  },
  {
    method: "ANY",
    path: "/api/editor/read-roots/*",
    match: matchesReadRootsRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) => handleReadRootsRoute(req, res, readRootsCtx(ctx), url),
  },
  {
    method: "GET",
    path: "/api/editor/design-systems",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx, url) => handleDesignSystemsRoute(req, res, ctx, url),
  },
  {
    method: "GET",
    path: "/api/editor/design-systems/suggestions",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx, url) => handleDesignSystemsRoute(req, res, ctx, url),
  },
  {
    method: "ANY",
    path: "/api/editor/design-systems/*",
    match: matchesDesignSystemsRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx, url) => handleDesignSystemsRoute(req, res, ctx, url),
  },
  // Read-only manifest/catalog lookups: the shell's RemoteManifestSource +
  // catalog fetch are same-origin browser GETs that often omit `Origin`.
  {
    method: "GET",
    path: "/api/editor/manifest",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx, url) => handleManifestRoute(res, ctx, url),
  },
  {
    method: "GET",
    path: "/api/editor/catalog",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleCatalogRoute(res, ctx),
  },
  // Chat model-picker catalog — static, read-only GET the chip fetches on
  // mount.
  {
    method: "GET",
    path: "/api/editor/chat/model-catalog",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) =>
      handleModelCatalogRequest(req, res, ctx.repoRoot, {
        configuredDefaultProvider: ctx.llm?.defaultProvider,
      }),
  },
  // LLM credentials. The GET is a same-origin browser poll that often omits
  // `Origin`, so it takes the lenient policy the other read-only GETs use — it
  // returns a masked hint and never the key. Every mutation writes a secret
  // and stays strict.
  {
    method: "GET",
    path: LLM_CREDENTIALS_ROUTE,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, _ctx, url) =>
      handleLlmCredentialsRoute(req, res, url, {
        claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
      }),
  },
  {
    method: "PUT",
    path: LLM_CREDENTIALS_DEV_MODE_ROUTE,
    authPolicy: "bearer-origin-required",
    handler: (req, res, _ctx, url) =>
      handleLlmCredentialsRoute(req, res, url, {
        claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
      }),
  },
  {
    method: "PUT",
    path: LLM_CREDENTIALS_DISMISS_ROUTE,
    authPolicy: "bearer-origin-required",
    handler: (req, res, _ctx, url) =>
      handleLlmCredentialsRoute(req, res, url, {
        claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
      }),
  },
  // Provider-scoped writes. These sit AFTER the two reserved sub-routes above:
  // both live under the same prefix, and first-match resolution would give
  // them to this matcher otherwise. `providerIdFromPath` refuses those two
  // names as well, so the ordering and the matcher agree.
  {
    method: "PUT",
    path: LLM_CREDENTIALS_PROVIDER_ROUTE,
    match: (pathname) => providerIdFromPath(pathname) !== null,
    authPolicy: "bearer-origin-required",
    handler: (req, res, _ctx, url) =>
      handleLlmCredentialsRoute(req, res, url, {
        claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
      }),
  },
  {
    method: "DELETE",
    path: LLM_CREDENTIALS_PROVIDER_ROUTE,
    match: (pathname) => providerIdFromPath(pathname) !== null,
    authPolicy: "bearer-origin-required",
    handler: (req, res, _ctx, url) =>
      handleLlmCredentialsRoute(req, res, url, {
        claudeRuntimeResolvable: isClaudeRuntimeResolvable(),
      }),
  },
  {
    method: "GET",
    path: "/api/editor/icon-sets",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleIconSetsRoute(res, ctx),
  },
  // Grounding drift log (Phase 5 Task 1). The base GET is a same-origin
  // browser poll; recording signals (POST), dismissal (DELETE …/:key) and
  // `…/:key/regenerate-hints` stay strict.
  {
    method: "GET",
    path: DRIFT_ROUTE,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) => handleDriftRoute(req, res, ctx),
  },
  {
    method: "ANY",
    path: `${DRIFT_ROUTE}/*`,
    match: matchesDriftRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleDriftRoute(req, res, ctx),
  },
  {
    method: "GET",
    path: "/api/health",
    // if-present, not required: browsers omit `Origin` on same-origin GETs
    // and page JS cannot add it (it is a forbidden header), so `required`
    // made this 403 for the UI that needs it. See the AuthPolicy docs above.
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => sendJson(res, 200, { ok: true, viteUrl: ctx.viteUrl }),
  },
  // Artifact-store CRUD routes — Phase 1 of tasks/cli-viewer-architecture.md.
  // Each handler does its own method validation and routes nested resources
  // (replies, frames, edges, annotations) internally. Browser fetches for the
  // list endpoints often omit Origin on same-origin GETs; POST/PATCH/DELETE
  // stay strict because they're not simple GETs.
  {
    method: "GET",
    path: "/api/editor/comments/*",
    match: matchesCommentsRoute,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) =>
      handleCommentsRequest(req, res, { store: ctx.stores.comments }),
  },
  {
    method: "ANY",
    path: "/api/editor/comments/*",
    match: matchesCommentsRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) =>
      handleCommentsRequest(req, res, { store: ctx.stores.comments }),
  },
  // Notes. DORMANT by product decision 2026-08-14 — both slices stay
  // REGISTERED and refuse inside `handleNotesRoute`, so a stale client gets a
  // reason naming `editor.notes` rather than a bare 404, and the route table
  // keeps describing the server's real shape.
  {
    method: "GET",
    path: "/api/editor/notes/*",
    match: matchesNotesRoute,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) => handleNotesRoute(req, res, ctx),
  },
  {
    method: "ANY",
    path: "/api/editor/notes/*",
    match: matchesNotesRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleNotesRoute(req, res, ctx),
  },
  {
    method: "GET",
    path: "/api/editor/screenshot-plans/*",
    match: matchesScreenshotPlansRoute,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) => {
      if (refuseIfCanvasDormant(res, ctx)) return
      return handleScreenshotPlansRequest(req, res, {
        store: ctx.stores.screenshotPlans,
        repoRoot: ctx.repoRoot,
        framework: ctx.framework,
      })
    },
  },
  {
    method: "ANY",
    path: "/api/editor/screenshot-plans/*",
    match: matchesScreenshotPlansRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => {
      if (refuseIfCanvasDormant(res, ctx)) return
      return handleScreenshotPlansRequest(req, res, {
        store: ctx.stores.screenshotPlans,
        repoRoot: ctx.repoRoot,
        framework: ctx.framework,
      })
    },
  },
  {
    method: "GET",
    path: "/api/editor/canvases/*",
    match: matchesCanvasesRoute,
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) => {
      if (refuseIfCanvasDormant(res, ctx)) return
      return handleCanvasesRequest(req, res, { store: ctx.stores.canvases })
    },
  },
  {
    method: "ANY",
    path: "/api/editor/canvases/*",
    match: matchesCanvasesRoute,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => {
      if (refuseIfCanvasDormant(res, ctx)) return
      return handleCanvasesRequest(req, res, { store: ctx.stores.canvases })
    },
  },
  // Writes the committed `.desde/config.json` on the canonical checkout
  // (not the worktree) — it's team-shared, not per-session. Passes the
  // mutable in-memory association so a fresh link survives a page reload
  // without a CLI restart (the bootstrap re-reads it).
  {
    method: "ANY",
    path: PROJECT_LINK_ROUTE,
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) =>
      handleProjectLinkRequest(req, res, {
        canonicalRoot: ctx.canonicalRoot,
        project: ctx.project,
      }),
  },
  // Smoke-test trigger (POST) + run history (GET).
  {
    method: "POST",
    path: "/api/editor/smoke-test",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) => handleSmokeTestRequest(req, res, ctx),
  },
  {
    method: "GET",
    path: "/api/editor/smoke-test",
    authPolicy: "bearer-origin-if-present",
    handler: (req, res, ctx) => handleSmokeRunsRequest(req, res, ctx),
  },
  // Design-tokens swatch list — drives the inspector's color/spacing token
  // picker. Read-only; uses canonicalRoot so it probes the prototype's real
  // node_modules, not the transient worktree branch.
  {
    method: "GET",
    path: "/api/editor/design-tokens",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx) => handleDesignTokensRoute(res, ctx),
  },
  // Iteration-data edit endpoint — deterministic v-for array mutation. Uses
  // repoRoot for file reads; path-traversal guards are relative to repoRoot.
  {
    method: "POST",
    path: "/api/editor/edit-iteration",
    authPolicy: "bearer-origin-required",
    handler: (req, res, ctx) =>
      handleEditIterationRequest(req, res, ctx.repoRoot, sendJson),
  },
  {
    method: "GET",
    path: "/api/editor/conditional-groups",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx, url) => handleConditionalGroupsRoute(res, ctx, url),
  },
  // File-read for the in-app code editor. Same-origin browser GET from the
  // FileEditorPane; may omit Origin. Read-only — never mutates.
  {
    method: "GET",
    path: "/api/editor/file",
    authPolicy: "bearer-origin-if-present",
    handler: (_req, res, ctx, url) => handleFileReadRoute(res, ctx, url),
  },
  // Terminal for the /api/ namespace: an unknown API path 404s (after the
  // strict auth gate) rather than falling through to static serving.
  {
    method: "ANY",
    path: "/api/*",
    match: (pathname) => pathname.startsWith("/api/"),
    authPolicy: "bearer-origin-required",
    handler: (_req, res) =>
      sendJson(res, 404, { ok: false, reason: "Unknown API endpoint" }),
  },

  // CLI bootstrap script — NOT auth-gated, same security model as the
  // index.html that references it (the token is in the body, not the URL;
  // browser SOP prevents cross-origin pages from reading the response body
  // via no-cors). Extracted to an external file so the served HTML stays
  // inline-script-free under strict CSP.
  {
    method: "GET",
    path: BOOTSTRAP_PATH,
    authPolicy: "none",
    handler: (req, res, ctx) => serveBootstrapScript(req, res, ctx),
  },
  // Static UI bundle serving — not auth-gated (the bundle must load before
  // it can present credentials). Catch-all; must stay last.
  {
    method: "GET",
    path: "/*",
    match: () => true,
    authPolicy: "none",
    handler: (req, res, ctx) =>
      serveStatic(req, res, {
        uiBundleRoot: ctx.uiBundleRoot,
        shellOrigin: ctx.security.shellOrigin,
      }),
  },
]

function matchesRouteEntry(
  entry: RouteEntry,
  method: string,
  pathname: string,
): boolean {
  if (entry.method !== "ANY" && entry.method !== method) return false
  return entry.match ? entry.match(pathname) : entry.path === pathname
}

/**
 * First-match resolution over {@link ROUTE_TABLE}. Exported so the route-table
 * test can assert the resolved auth posture for concrete paths (the property
 * the old inline read-only-GET allowlist encoded) rather than only inspecting
 * the table's shape.
 */
export function resolveRoute(
  method: string,
  pathname: string,
): RouteEntry | undefined {
  return ROUTE_TABLE.find((e) => matchesRouteEntry(e, method, pathname))
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // DNS-rebinding guard — see `host-guard.ts`. Deliberately BEFORE
  // `resolveRoute`, not inside `checkAuth`: the routes a rebinding attack
  // reads first are `authPolicy: "none"` (the bootstrap script, which carries
  // the per-boot bearer in its body, and the static bundle), and those never
  // reach `checkAuth`. Gating on the route's posture would leave the token
  // exactly where the attack picks it up.
  const hostCheck = checkHost(req, ctx.listenOrigin)
  if (!hostCheck.ok) {
    sendJson(res, hostCheck.status, { ok: false, reason: hostCheck.reason })
    return
  }
  const url = new URL(req.url ?? "/", ctx.security.shellOrigin)
  const entry = resolveRoute(req.method ?? "", url.pathname)
  if (!entry) {
    res.statusCode = 405
    res.end("method not allowed")
    return
  }
  if (entry.authPolicy !== "none") {
    const auth = checkAuth(req, ctx.security, {
      originPolicy:
        entry.authPolicy === "bearer-origin-if-present" ? "if-present" : "required",
    })
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, reason: auth.reason })
      return
    }
  }
  await entry.handler(req, res, ctx, url)
}

/** POST /api/editor/chat — the SDK chat turn. */
async function handleChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  await handleChatRequest(req, res, {
    repoRoot: ctx.repoRoot,
    loaders: ctx.chatLoaders,
    quotas: ctx.chatQuotas,
    retention: ctx.retention,
    llm: ctx.llm,
    conventions: ctx.conventions,
    // Holder first: it reflects edits made from the settings dialog since
    // boot. `ctx.readRoots` is the boot-time snapshot and is the fallback for
    // callers that never wired a holder.
    readRoots: ctx.readRootsHolder?.current ?? ctx.readRoots,
    // Deterministic Vite invalidation for the agent's structural write
    // tools — same rationale as the edit handler's call (fsevents can
    // drop/delay the change event under load).
    invalidateFiles: (files) =>
      ctx.invalidateFiles?.(files),
    // The agent's isolated review surface points a headless Chromium at the
    // same Vite URL the user's iframe loads — see chat-handler / review-surface.
    prototypeUrl: ctx.viteUrl,
    prototypeBase: ctx.viteBase,
    framework: ctx.framework,
    // Reuse the SAME memoized GroundingService the inspector endpoints use
    // (bound to the canonical root, where node_modules live) so the agent's
    // grounding tools and the inspector never diverge.
    getGrounding: () => getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
    // Canvas + screenshot-plan surface — DORMANT by product decision
    // 2026-08-04 (undertested; see CLAUDE.md § "Screenshot Capture").
    // Either `editor.canvas: true` in `.desde/config.json` OR
    // `EDITOR_CANVAS=1` restores it — same either-enables contract
    // as the client bootstrap's `canvas` field below.
    canvasEnabled: isCanvasEnabled(ctx),
  })
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Extract + validate the `:id` segment of a `…/chat/sessions/:id[/suffix]`
 * path. Returns `null` AFTER having sent the 400 — callers just `return`.
 *
 * Rejects embedded slashes / empty ids both before and after decoding: a
 * path-traversal attempt (`../`) or a missing id must not silently fall
 * through, and `/sessions/%2F` decodes to `/` which the pre-decode guard
 * misses. Decoding matches the web route, whose Next.js dynamic-segment
 * parser decodes the param before the handler sees it (so `%41` arrives
 * as `A`); a `URIError` on a malformed sequence surfaces as a 400 rather
 * than crashing the handler.
 */
function parseSessionIdFromPath(
  res: ServerResponse,
  pathname: string,
  suffix?: string,
): string | null {
  const restRaw = suffix
    ? pathname.slice(CHAT_SESSIONS_PREFIX.length, pathname.length - suffix.length)
    : pathname.slice(CHAT_SESSIONS_PREFIX.length)
  if (restRaw.length === 0 || restRaw.includes("/")) {
    sendJson(res, 400, { ok: false, reason: "sessionId is required" })
    return null
  }
  let rest: string
  try {
    rest = decodeURIComponent(restRaw)
  } catch {
    sendJson(res, 400, {
      ok: false,
      reason: "sessionId is malformed (invalid URL encoding).",
    })
    return null
  }
  if (rest.length === 0 || rest.includes("/")) {
    sendJson(res, 400, { ok: false, reason: "sessionId is required" })
    return null
  }
  if (!SESSION_ID_PATTERN.test(rest)) {
    sendJson(res, 400, {
      ok: false,
      reason:
        "sessionId must match /^[A-Za-z0-9_-]{1,64}$/ (UUID-shaped). Provided value rejected.",
    })
    return null
  }
  return rest
}

/**
 * Phase 1 of tasks/editor-detached-sessions.md — list the chat sessions
 * persisted for the current project so the shell can present a session picker.
 */
async function handleListChatSessionsRoute(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  try {
    const { listSessionsForProject, projectIdForRepoRoot } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    const projectId = projectIdForRepoRoot(ctx.repoRoot)
    const sessions = await listSessionsForProject(ctx.repoRoot)
    sendJson(res, 200, { ok: true, projectId, sessions })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to list chat sessions: ${(err as Error).message}`,
    })
  }
}

/**
 * Phase 3 follow-up of tasks/editor-detached-sessions.md — lock-events
 * endpoint feeding the detail panel's "Lock contention timeline" section.
 */
async function handleChatSessionLockEventsRoute(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const rest = parseSessionIdFromPath(res, url.pathname, "/lock-events")
  if (rest === null) return
  try {
    const { loadSession, projectIdForRepoRoot } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    const { readLockEvents } = await import(
      "../../../src/editor/edit-service/lock-event-persistence.js"
    )
    const projectId = projectIdForRepoRoot(ctx.repoRoot)
    const result = await loadSession(ctx.repoRoot, { sessionId: rest })
    if (result.fresh) {
      sendJson(res, 404, {
        ok: false,
        reason: `Chat session not found (${result.freshReason ?? "no-file"})`,
      })
      return
    }
    if (result.session.id.projectId !== projectId) {
      sendJson(res, 404, {
        ok: false,
        reason: "Chat session belongs to a different project",
      })
      return
    }
    const events = await readLockEvents(ctx.repoRoot, rest)
    sendJson(res, 200, { ok: true, events })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to load lock events: ${(err as Error).message}`,
    })
  }
}

/**
 * Phase 3 of tasks/editor-detached-sessions.md — detail endpoint returning
 * the full ChatSession (turns + transcripts + tool results + edit-proposal
 * refs + conflicts + fileReads).
 */
async function handleChatSessionDetailRoute(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const rest = parseSessionIdFromPath(res, url.pathname)
  if (rest === null) return
  try {
    const { loadSession, projectIdForRepoRoot } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    const projectId = projectIdForRepoRoot(ctx.repoRoot)
    const result = await loadSession(ctx.repoRoot, { sessionId: rest })
    if (result.fresh) {
      sendJson(res, 404, {
        ok: false,
        reason: `Chat session not found (${result.freshReason ?? "no-file"})`,
      })
      return
    }
    if (result.session.id.projectId !== projectId) {
      sendJson(res, 404, {
        ok: false,
        reason: "Chat session belongs to a different project",
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      session: result.session,
      // Codex round-1 #4 fix: include the worktree root so the panel can
      // normalize `fileReads` / `conflicts` (keyed by absolute path) against
      // `editProposals[].files` (repo-relative). Mirrors the web route's
      // response shape.
      worktreeRoot: ctx.repoRoot,
    })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to load chat session: ${(err as Error).message}`,
    })
  }
}

/**
 * Phase 4b of tasks/editor-detached-sessions.md — write the user's
 * hand-edited merge resolution to disk + clear the conflict. Refuses if the
 * content still contains conflict markers (user clicked Apply too early).
 */
async function handleApplyMergeResolutionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const rest = parseSessionIdFromPath(res, url.pathname, "/apply-merge-resolution")
  if (rest === null) return
  // resolvedContent carries a FULL hand-resolved source file (the user
  // resolves a merge conflict in the UI), same shape as /api/editor/edit
  // — use the source-sized cap, not the generic 256 KiB default.
  const raw = await readCappedBody(req, res, EDIT_BODY_MAX_BYTES)
  if (raw === null) return
  let parsed: { file?: unknown; resolvedContent?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Request body must be valid JSON." })
    return
  }
  if (typeof parsed.file !== "string" || parsed.file.length === 0) {
    sendJson(res, 400, { ok: false, reason: "`file` must be a non-empty string." })
    return
  }
  if (typeof parsed.resolvedContent !== "string") {
    sendJson(res, 400, {
      ok: false,
      reason: "`resolvedContent` must be a string (empty content is allowed).",
    })
    return
  }
  try {
    const { loadSession, projectIdForRepoRoot } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    const { applyMergeResolution } = await import(
      "../../../src/editor/agent-chat/resolve-conflict.js"
    )
    const projectId = projectIdForRepoRoot(ctx.repoRoot)
    const loaded = await loadSession(ctx.repoRoot, { sessionId: rest })
    if (loaded.fresh) {
      sendJson(res, 404, {
        ok: false,
        reason: `Chat session not found (${loaded.freshReason ?? "no-file"})`,
      })
      return
    }
    if (loaded.session.id.projectId !== projectId) {
      sendJson(res, 404, {
        ok: false,
        reason: "Chat session belongs to a different project",
      })
      return
    }
    const result = await applyMergeResolution({
      worktreeRoot: ctx.repoRoot,
      session: loaded.session,
      file: parsed.file,
      resolvedContent: parsed.resolvedContent,
    })
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, reason: result.reason })
      return
    }
    sendJson(res, 200, { ok: true, finalHash: result.finalHash })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to apply merge resolution: ${(err as Error).message}`,
    })
  }
}

/**
 * Phase 4 §4 of tasks/editor-detached-sessions.md — resolve a stale-base
 * conflict by writing the loser-session's blob to disk (mine) or no-op
 * confirming the winner stays (theirs).
 */
async function handleResolveConflictRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const rest = parseSessionIdFromPath(res, url.pathname, "/resolve-conflict")
  if (rest === null) return
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let parsed: { file?: unknown; resolution?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Request body must be valid JSON." })
    return
  }
  if (typeof parsed.file !== "string" || parsed.file.length === 0) {
    sendJson(res, 400, { ok: false, reason: "`file` must be a non-empty string." })
    return
  }
  if (
    parsed.resolution !== "mine" &&
    parsed.resolution !== "theirs" &&
    parsed.resolution !== "merge"
  ) {
    sendJson(res, 400, {
      ok: false,
      reason: '`resolution` must be "mine", "theirs", or "merge".',
    })
    return
  }
  try {
    const { loadSession, projectIdForRepoRoot } = await import(
      "../../../src/editor/agent-chat/session-store.js"
    )
    const { resolveSessionConflict } = await import(
      "../../../src/editor/agent-chat/resolve-conflict.js"
    )
    const projectId = projectIdForRepoRoot(ctx.repoRoot)
    const loaded = await loadSession(ctx.repoRoot, { sessionId: rest })
    if (loaded.fresh) {
      sendJson(res, 404, {
        ok: false,
        reason: `Chat session not found (${loaded.freshReason ?? "no-file"})`,
      })
      return
    }
    if (loaded.session.id.projectId !== projectId) {
      sendJson(res, 404, {
        ok: false,
        reason: "Chat session belongs to a different project",
      })
      return
    }
    const result = await resolveSessionConflict({
      worktreeRoot: ctx.repoRoot,
      session: loaded.session,
      file: parsed.file,
      resolution: parsed.resolution,
    })
    if (!result.ok) {
      sendJson(res, result.status, { ok: false, reason: result.reason })
      return
    }
    sendJson(res, 200, {
      ok: true,
      finalHash: result.finalHash,
      ...(result.mergeClean !== undefined ? { mergeClean: result.mergeClean } : {}),
      ...(result.mergeContent !== undefined
        ? { mergeContent: result.mergeContent }
        : {}),
    })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to resolve conflict: ${(err as Error).message}`,
    })
  }
}

/** POST /api/editor/shell-bridge/reply — deliver a bridge round-trip reply. */
async function handleShellBridgeReplyRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: ShellBridgeReplyBody
  try {
    body = JSON.parse(raw) as ShellBridgeReplyBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const r = applyShellBridgeReply(body)
  sendJson(res, r.status, r.body)
}

/** GET /api/editor/project-knowledge — grounding badge. */
async function handleProjectKnowledgeRoute(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const result = await handleProjectKnowledgeQuery(
    ctx.repoRoot,
    ctx.conventions,
    ctx.projectKnowledgeLoaders,
  )
  sendJson(res, result.status, result.body)
}

/** `/api/editor/design-systems*` — registry list, attach/detach, refresh, hints. */
async function handleDesignSystemsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  await handleDesignSystemsRequest(req, res, url.pathname, {
    canonicalRoot: ctx.canonicalRoot,
    // A new/removed registration changes which manifests serving emits —
    // drop the memoized grounding service so the next manifest/catalog
    // GET rebuilds against the updated registry.
    onRegistryChange: resetGroundingCache,
    // Reads the ALREADY-built bundle's health, if any — constructing the
    // GroundingService instance is cheap (memoized, no manifest build),
    // and its own getGroundingHealth() never triggers a build.
    getGroundingHealth: () =>
      getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders).then((g) =>
        g.getGroundingHealth(),
      ),
    // Boot-time reconciliation writes into the SAME holder object the
    // CLI bootstrap passed to `startHttpServer` — read its latest value,
    // never trigger reconciliation from a GET.
    getReconciliationStatus: () => ctx.reconciliationStatusHolder?.current ?? null,
    // Phase 3 refresh — the SAME holder the boot-time staleness warm-up
    // writes into (chained after reconciliation in `core.ts`), so the
    // panel's first `GET …/updates` is often already warm.
    getStalenessCache: () => ctx.stalenessCacheHolder?.current ?? null,
    setStalenessCache: (cache) => {
      if (ctx.stalenessCacheHolder) ctx.stalenessCacheHolder.current = cache
    },
    checkStaleness: checkDesignSystemStaleness,
    // Phase 4 Task 3 (probe-derived hints) — MAY trigger a manifest
    // build (unlike getGroundingHealth above): only reached from the
    // explicit "Generate hints" action, never a passive GET.
    getManifestSource: () =>
      getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders).then((g) =>
        g.getManifestSource(),
      ),
    // Lazy import: pulls in Playwright launch machinery only when a
    // generate-hints run actually happens, mirroring the review
    // surface's own lazy `createReviewSurface` wiring.
    createProbePage: async () => {
      try {
        const { createProbePage } = await import("./probe-page.js")
        return await createProbePage()
      } catch {
        return null
      }
    },
    viteBaseUrl: ctx.viteUrl,
    // Wired in production now, not only in tests: the LLM hint lane used to
    // fall through to the registry's argless default, which could not see the
    // project's `llm` block.
    getLlmProvider: () => getProvider({ config: llmConfigFor(ctx) }),
  })
}

/** GET /api/editor/manifest — single-component manifest lookup. */
async function handleManifestRoute(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const result = await handleManifestRequest(
    () => getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
    url.searchParams.get("name"),
  )
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
  }
  sendJson(res, result.status, result.body)
}

/** GET /api/editor/catalog — the full component catalog. */
async function handleCatalogRoute(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const result = await handleCatalogRequest(() =>
    getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
  )
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
  }
  sendJson(res, result.status, result.body)
}

/** GET /api/editor/icon-sets — auto-detected icon-set registry. */
async function handleIconSetsRoute(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const result = await getIconSets(ctx.iconSetRegistry ?? null)
  if (result.ok) {
    sendJson(res, result.status, { ok: true, sets: result.sets })
  } else {
    sendJson(res, result.status, { ok: false, reason: result.reason })
  }
}

/** `/api/editor/drift*` — the grounding drift log + repair/regenerate actions. */
async function handleDriftRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  await handleDriftRequest(req, res, {
    driftLog: ctx.driftLog,
    pendingInvalidations: ctx.pendingInvalidations,
    repair: {
      prototypeRoot: ctx.canonicalRoot,
      deps: ctx.repairDeps,
      queue: ctx.repairQueue,
      // Codex P2 fix (2026-07-30) — same seam the design-systems routes and
      // the regenerateHints wiring just below already use to drop the
      // memoized grounding service; see `DriftHandlerCtx.repair`'s doc
      // comment in drift-handler.ts for why auto-repair is otherwise
      // invisible for the rest of the process's life.
      onRegistryChange: resetGroundingCache,
    },
    // Phase 5 Task 5 — the "Regenerate hints" row action. Mirrors the
    // Phase 4 design-systems wiring (same `getManifestSource` /
    // `createProbePage` / `viteBaseUrl` / `onRegistryChange` seams) so a
    // single-component re-run behaves identically to the whole-package one.
    regenerateHints: {
      canonicalRoot: ctx.canonicalRoot,
      getManifestSource: () =>
        getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders).then((g) =>
          g.getManifestSource(),
        ),
      createProbePage: async () => {
        try {
          const { createProbePage } = await import("./probe-page.js")
          return await createProbePage()
        } catch {
          return null
        }
      },
      viteBaseUrl: ctx.viteUrl,
      onRegistryChange: resetGroundingCache,
    },
  })
}

/** GET /api/editor/design-tokens — swatch list for the inspector picker. */
async function handleDesignTokensRoute(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const result = await getDesignTokens(() =>
    getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
  )
  if (result.ok) {
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, result.status, result.tokens)
  } else {
    // Preserve the web route's two-shape contract:
    //   503 → { error }
    //   500 → { error, detail }
    sendJson(
      res,
      result.status,
      result.detail !== undefined
        ? { error: result.error, detail: result.detail }
        : { error: result.error },
    )
  }
}

/**
 * GET /api/editor/conditional-groups — source-derived
 * `<template v-if/v-for>` group listing (WS2 follow-up): the wrappers render
 * no DOM, so the layers panel synthesizes group rows from THIS instead of the
 * DOM walk. `readPrototypeFile` supplies the path guards + content + hash;
 * fileHash (12-hex prefix) matches the data-desde-v stamp convention so group
 * moves carry a valid stale-target baseHash.
 */
async function handleConditionalGroupsRoute(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  const fileResult = await readPrototypeFile(
    ctx.repoRoot,
    url.searchParams.get("file"),
  )
  if (!fileResult.ok) {
    sendJson(res, fileResult.status, { ok: false, reason: fileResult.reason })
    return
  }
  res.setHeader("Cache-Control", "no-store")
  // FileReadResult keeps success fields optional in the type; on ok they're
  // always set — narrow defensively.
  const relativePath = fileResult.relativePath ?? ""
  const content = fileResult.content ?? ""
  const fileHash = (fileResult.sha ?? "").slice(0, 12)
  if (!relativePath.endsWith(".vue")) {
    // JSX conditional groups are expression containers — different shape, not
    // listed here (group moves refuse for React anyway).
    sendJson(res, 200, { ok: true, file: relativePath, fileHash, groups: [] })
    return
  }
  const { listConditionalGroups } = await import(
    "../../../src/editor/edit-service/list-conditional-groups"
  )
  const listed = listConditionalGroups(content)
  if (!listed.ok) {
    sendJson(res, 422, { ok: false, reason: listed.reason })
    return
  }
  sendJson(res, 200, {
    ok: true,
    file: relativePath,
    fileHash,
    groups: listed.groups,
  })
}

/**
 * `/api/editor/notes/*` — the Notes artifact store, gated on the dormant
 * Notes surface.
 *
 * The refusal lives here rather than in `notes-handler.ts` because the gate
 * belongs to the ROUTE. The handler is the store's own read/write logic and
 * has no business knowing about a product decision; the route is where the
 * server decides whether this surface is reachable at all.
 */
async function handleNotesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  if (!isNotesEnabled(ctx)) {
    sendJson(res, 403, {
      ok: false,
      reason: dormantSurfaceRefusal("notes", "The Notes surface"),
    })
    return
  }
  await handleNotesRequest(req, res, { store: ctx.stores.notes })
}

/**
 * The dispatch half of the canvas gate, for both of that surface's route
 * families.
 *
 * These were ungated until 2026-09-01 while the surface itself had been
 * dormant since 2026-08-04. The client stopped OFFERING the Canvas tab and
 * the agent stopped being given the plan-authoring tools, but the routes
 * behind them kept answering every verb: 17 canvas endpoints and 8
 * screenshot-plan ones, create, patch and delete included, plus a
 * route-enumeration POST that does real work. A stale client or a
 * hand-built request could drive all of it.
 *
 * `GET` is refused alongside the writes deliberately. The refusal names the
 * key to flip, so it tells a caller the surface is off rather than implying
 * the data is empty, and a read that answers `[]` for a dormant surface is
 * its own kind of lie.
 */
function refuseIfCanvasDormant(res: ServerResponse, ctx: RouteContext): boolean {
  if (isCanvasEnabled(ctx)) return false
  sendJson(res, 403, {
    ok: false,
    reason: dormantSurfaceRefusal("canvas", "The canvas surface"),
  })
  return true
}

/**
 * GET /api/editor/file — file read for the in-app code editor. Returns
 * `{ ok, content, sha, relativePath }` for a single .vue / .ts file under the
 * worktree root. The `sha` is fed back as `baseHash` on save so the
 * overwrite-lane conflict guard catches concurrent writes. Path-traversal
 * guards mirror the edit handler.
 *
 * Gated on the dormant in-app code view (product decision 2026-08-14). The
 * gate is on the ROUTE, deliberately not on `readPrototypeFile`:
 * `handleConditionalGroupsRoute` calls that same function to serve the layers
 * panel, which has nothing to do with the code view and must keep working.
 */
async function handleFileReadRoute(
  res: ServerResponse,
  ctx: RouteContext,
  url: URL,
): Promise<void> {
  if (!isCodeViewEnabled(ctx)) {
    sendJson(res, 403, {
      ok: false,
      reason: dormantSurfaceRefusal("codeView", "The in-app code view"),
    })
    return
  }
  const result = await readPrototypeFile(ctx.repoRoot, url.searchParams.get("path"))
  if (result.ok) {
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, result.status, {
      ok: true,
      relativePath: result.relativePath,
      content: result.content,
      sha: result.sha,
    })
  } else {
    sendJson(res, result.status, { ok: false, reason: result.reason })
  }
}

/**
 * Branch panel — list local branches. Read-only, so it's exposed in any
 * mode; `editable` tells the client whether the switch/create/rename
 * mutations are available (branch mode only). Uses `ctx.repoRoot`, which in
 * branch mode IS the user's real checkout.
 */
async function handleListBranchesRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const list = await listBranches(ctx.repoRoot)
  // `changes` backs the Activity panel's file list and the Commit button's
  // count; `dirty` (derived) keeps the button's enabled state. Only
  // meaningful in branch mode; harmless — and cheap — to compute anywhere.
  const changes = await listWorkingTreeChanges(ctx.repoRoot)
  // `ahead` = commits on the current branch not yet in the default branch.
  // Together with `dirty` it tells the Merge button whether there's
  // anything to merge (committed-but-unmerged work OR uncommitted edits).
  const ahead =
    list.current && list.defaultBranch && list.current !== list.defaultBranch
      ? await countCommitsAhead(ctx.repoRoot, list.current, list.defaultBranch)
      : 0
  // `hasRemote` gates the Push / Merge-&-push actions; `unpushed` (commits
  // on the current branch not yet on origin/<branch>) tells Push whether
  // there's anything to send. Both no-network, cheap enough for the poll.
  const hasRemote = (await readOriginRemoteUrl(ctx.repoRoot)) !== null
  const unpushed =
    hasRemote && list.current
      ? await hasUnpushedCommits(ctx.repoRoot, list.current)
      : false
  // `behind` = commits on the branch's UPSTREAM not yet on the branch.
  // Keyed on the configured upstream (`@{upstream}`), not `origin/<branch>`:
  // a branch pushed under a different name would otherwise read 0 forever,
  // which is indistinguishable from up to date. Read from the LOCAL
  // remote-tracking ref — no network — so it is poll-cheap and reflects
  // the last fetch (the explicit /branches/fetch action, or the client's
  // long interval; never this poll). `hasUpstream` is what lets the UI
  // disable "Pull remote changes" instead of offering an action that
  // cannot work.
  const upstream =
    hasRemote && list.current ? await branchUpstream(ctx.repoRoot, list.current) : null
  const behind =
    upstream && list.current
      ? await countCommitsBehind(ctx.repoRoot, list.current, upstream)
      : 0
  sendJson(res, 200, {
    ok: true,
    ...list,
    changes,
    dirty: changes.length > 0,
    ahead,
    behind,
    hasRemote,
    hasUpstream: upstream !== null,
    unpushed,
    editable: !!ctx.branchMode,
    // Toolbar undo/redo (Task 6) — piggybacked on the poll the shell
    // already runs, so the toolbar buttons update without a dedicated
    // poll of their own.
    history: getSharedEditHistory().state(),
  })
}

/** One rendered row of `GET /api/editor/ledger`. */
interface LedgerRow {
  id: string
  at: string
  kind: string
  lane: string
  files: string[]
  description: string
  committed: boolean
  sha?: string
  backupDir?: string
  afterHashes: Record<string, string>
  /**
   * Repo-relative paths in `files` this edit created — see
   * `LedgerEditEntry.createdFiles`'s doc comment. Passed straight
   * through so the client can pre-disable a row guaranteed to refuse
   * Undo with `unbacked` (P1-1, codex review round 3, 2026-08-20) — see
   * `activity-row.tsx`'s `undoAvailability`.
   */
  createdFiles?: string[]
  /**
   * Opaque client join key (Task 4b) — see `LedgerEditEntry.correlationId`
   * (`src/editor/ledger/entry.ts`). Passed straight through; absent when
   * the writing client didn't send one.
   */
  correlationId?: string
}

/**
 * The edit ledger, ready to render.
 *
 * Derives `description` and `committed` SERVER-side rather than in the
 * client, so there is one deriver instead of one per consumer. Reconciles
 * first so a commit made in the user's own terminal (outside the product)
 * is reflected immediately rather than only on the next poll that happens
 * to notice.
 *
 * Reconcile is durable and one-directional — a false "committed" can
 * never be un-said — so two guards apply here that a display-only read
 * would not need (whole-branch review, 2026-08-18):
 *
 * 1. The dirty check uses `listDirtyRepoRelativePaths`, not
 *    `listWorkingTreeChanges`: it fully expands untracked directories
 *    (`--untracked-files=all`) so a file created inside a brand-new
 *    directory (`download_asset`, `scaffold_route`, `insert_component`,
 *    the allowCreate write path) is its own dirty path instead of
 *    collapsing into the directory's single `newdir/` entry — which
 *    would otherwise make that file look clean, and its ledger entry
 *    committed, on the very first poll.
 * 2. That listing THROWS on a git failure rather than returning `[]`, and
 *    the catch below skips reconcile for this poll entirely. Treating a
 *    failed listing as "nothing is dirty" would sweep every pending
 *    ledger entry into a false-committed state on one transient git
 *    error; skipping the cycle costs nothing but a retry on the next
 *    poll.
 * 3. A `.gitignore`d file is never "dirty" by git's own definition, but
 *    that is not evidence it reached git either (P2, round-4
 *    whole-branch review finding, 2026-08-19) — `listDirtyRepoRelativePaths`
 *    also returns `ignoredPrefixes` from the SAME status call
 *    (`--ignored=matching`, see that function's doc comment for the
 *    measured cost reasoning), and `reconcileLedger` refuses to mark an
 *    entry committed when any of its files matches one, via
 *    `isIgnoredPath`.
 * 4. The ledger is read BEFORE the dirty-status snapshot is taken, and
 *    NOT re-read inside `reconcileLedger` (P1, round-4 whole-branch
 *    review finding, 2026-08-19). This ordering is load-bearing and not
 *    obvious from the types, so it is written down here and again on
 *    `reconcileLedger` itself: the panel polls this route continuously,
 *    so an edit landing WHILE a poll is in flight is the ordinary case,
 *    not an edge case. Every producer writes its file(s) before
 *    appending its ledger entry, so an entry visible in a read taken
 *    before the status snapshot is guaranteed to already have its
 *    file's write reflected in that snapshot — an entry appended AFTER
 *    the read is simply not a candidate this round, and gets reconciled
 *    correctly on the NEXT poll instead. Reversing the order (status
 *    first, ledger read second — what a redundant-looking "just re-read
 *    it in there" refactor would reintroduce) reopens the race: a late
 *    entry would be checked against a dirty set captured before its
 *    file write existed, read as clean, and durably marked committed —
 *    the append-only log can never undo that on a later poll.
 * 5. The row filter below fails OPEN, not closed, for a resolved branch
 *    that no longer exists at all (F3, round-5 whole-branch review
 *    finding, 2026-08-19) — see `isOrphanedBranch`'s doc comment. This is
 *    a display decision, not a durable write, so it can afford to guess
 *    in the direction that costs less: `reconcileLedger` above stays
 *    conservative (excludes on any doubt) because a wrong guess there
 *    writes a permanent `reconcile` line, but a wrong guess HERE just
 *    shows a stale row for one more poll.
 * 6. The branch resolve → ledger read → status snapshot → reconcile
 *    sequence runs under the tree gate held SHARED (P1-2, round-6
 *    whole-branch review finding, 2026-08-19) — see the comment at the
 *    top of the function body. Without it, a branch switch (EXCLUSIVE)
 *    landing mid-sequence could scope a reconcile's dirty check to a
 *    DIFFERENT branch than the one it durably records against.
 * 7. That gate is IN-PROCESS ONLY (F1, round-8 whole-branch review
 *    finding, 2026-08-19) — it cannot stop a `git checkout` typed in the
 *    user's own terminal, or a second Editor process on the same repo,
 *    from moving HEAD mid-sequence. The status snapshot is bracketed by
 *    a raw HEAD read on each side (`readGitHeadRaw`, worktree-aware — it
 *    follows the `.git` `gitdir:` pointer when this repo is itself a
 *    linked git worktree); if they disagree, `branch` above may already
 *    name the checkout that just stopped being current, so reconcile is
 *    skipped for this poll rather than durably recording against the
 *    wrong branch. A fingerprint that comes back `undefined` (read
 *    failure) is ALSO treated as "skip" rather than as a vacuous match —
 *    see the comment at the `if` below. See the comment at the top of
 *    the function body.
 * 8. Point 7's "before" fingerprint is NOT a separate read anymore (F1,
 *    round-10 whole-branch review finding, 2026-08-19). It used to be:
 *    `branch` came from `resolveBranchCached`, then a ledger read ran,
 *    THEN a fresh `readGitHeadRaw` call produced "before". An external
 *    checkout landing in that gap — between resolving `branch` and
 *    taking that separate read — moved HEAD somewhere neither fingerprint
 *    read could see: both "before" and "after" ended up reading the NEW
 *    checkout, so they agreed with each other while `branch` still named
 *    the OLD one. `resolveBranchCachedWithHead` returns the name and the
 *    fingerprint from the SAME `.git/HEAD` read, so there is no gap
 *    between them for a checkout to land in — see `BranchResolution`'s
 *    doc comment in `edit-ledger.ts`.
 * 9. Quietness alone is NOT committed proof (LIVE SMOKE FINDING,
 *    2026-08-20). Every guard above protects the INFERENCE "the file is
 *    clean, therefore it was committed" from racing or scoping wrong —
 *    but that inference itself is false whenever something OTHER than a
 *    commit made the file clean, e.g. `git checkout -- <file>` discarding
 *    the edit and restoring HEAD's prior content. Driven live against a
 *    real repo, that exact sequence made this route mark a discarded edit
 *    "Committed" — permanently, since the ledger never un-says a durable
 *    claim. `reconcileLedger` now also requires POSITIVE evidence: HEAD's
 *    actual content for every one of an entry's files must hash-equal
 *    that entry's own recorded `afterHashes`, read via `readHeadBlobs`
 *    (one batched `git cat-file --batch` spawn for every still-pending
 *    file, not one spawn per file) and compared with the same `hashContent`
 *    the entry's hash was written with. See `reconcileLedger`'s own doc
 *    comment for the full reasoning, including why this subsumes the old
 *    `isIgnored` gate (removed) but not the undo-entry `headAtWrite`
 *    bracket (kept).
 */
async function handleLedgerRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // P1-2 (round-6 whole-branch review finding, 2026-08-19): resolving the
  // branch, reading the ledger, taking the dirty-status snapshot, and
  // reconciling used to run with no lock at all. A branch switch — which
  // runs under `withTreeLock`, EXCLUSIVE — landing anywhere in that
  // window could leave `branch` naming the OLD checkout while the dirty
  // status snapshot already reflects the NEW one. If a pending edit
  // recorded on the old branch happened to byte-match the new branch's
  // checked-in files, `reconcileLedger` would durably append a
  // committed marker for a reconcile that was never actually scoped to
  // the branch it claims — the log is append-only, so nothing later
  // corrects it.
  //
  // Fixed by holding the tree gate SHARED (`acquireTreeGateShared`, the
  // same primitive `withFileEditLocks` already uses for ordinary file
  // edits) across exactly this sequence, not by re-checking HEAD before
  // the append. A HEAD-recheck is a check, not a guarantee — it can still
  // race between the check and the append. A held gate can't: the branch
  // mutation that would move HEAD cannot even START until this poll
  // releases the gate (tree ops take it EXCLUSIVE, and an exclusive
  // acquisition waits for every existing shared holder to finish). SHARED
  // was chosen deliberately over EXCLUSIVE — this poll only needs to
  // keep a MUTATION out, not exclude other readers or in-flight file
  // edits, both of which already hold the gate SHARED too and run
  // alongside this one exactly as before. Given the ledger's append-only,
  // permanent-once-written nature, paying a shared-gate acquisition
  // (typically just a few git subprocess calls' worth of hold time) on
  // every poll is the conservative choice the round asked for.
  const releaseGate = await acquireTreeGateShared(ctx.repoRoot)
  let branch: string | undefined
  try {
    // F1 (round-10 whole-branch review finding, 2026-08-19): `branch` and
    // the "before" HEAD fingerprint below come from the SAME
    // `resolveBranchCachedWithHead` read, not two separate calls — see
    // point 8 above and `BranchResolution`'s doc comment (`edit-ledger.ts`)
    // for the gap a separate later read used to leave open.
    const branchResolution = await resolveBranchCachedWithHead(ctx.repoRoot)
    branch = branchResolution.name
    const headBeforeStatus = branchResolution.head
    // Read BEFORE the status snapshot below — see point 4 above and
    // `reconcileLedger`'s own doc comment. Do not swap this order.
    const preStatusEntries = await readLedger(ctx.repoRoot)
    try {
      // F1 (round-8 whole-branch review finding, 2026-08-19): the tree
      // gate above only excludes an IN-PROCESS branch mutation — it
      // can't stop a `git checkout` in the user's own terminal, or a
      // second Editor process on this repo, from moving HEAD while this
      // status snapshot is in flight. Bracketing it with a raw
      // `.git/HEAD` read on each side catches that: if HEAD moved,
      // `branch` above may already name the OLD checkout while `dirty`
      // reflects the NEW one, so skip reconciling this poll rather than
      // risk a wrong, permanent `reconcile` line — the next poll
      // re-resolves everything and simply tries again.
      // `ignoredPrefixes` (this function's second return value) is not
      // destructured here — `isIgnored` was removed as a `reconcileLedger`
      // gate in favor of `matchesHeadContent` below (see that function's
      // doc comment for why an ignored path is provably a subset of what
      // the new check already excludes on its own). `isIgnoredPath` still
      // has a live caller elsewhere in this file (`captureCommitCoverage`).
      const { dirty } = await listDirtyRepoRelativePaths(ctx.repoRoot)
      const headAfterStatus = await readGitHeadRaw(ctx.repoRoot)
      // `headBeforeStatus !== undefined` is required, not redundant with the
      // equality check (residual risk closed 2026-08-19): `readGitHeadRaw`
      // returns `undefined` on any read failure, and `undefined === undefined`
      // would otherwise read as "HEAD held still" when it actually means "we
      // could not tell." Skipping is the safe direction here — proceeding on
      // a vacuous match is exactly the wrong-branch corruption this guard
      // exists to prevent.
      if (headBeforeStatus !== undefined && headBeforeStatus === headAfterStatus) {
        // Scoped to the checked-out branch (same rule as the row filter
        // below) — otherwise a stash-and-switch would reconcile another
        // branch's pending edits against THIS tree's cleanliness.
        //
        // F1 (codex review round 4, 2026-08-20): `reconcileLedger` also
        // needs the CURRENT tip commit, to tell an undo entry's own
        // immediate cleanliness apart from a later real commit
        // (`LedgerEditEntry.headAtWrite`'s doc comment). This is
        // DELIBERATELY NOT `headAfterStatus` above — that is
        // `readGitHeadRaw`'s raw `.git/HEAD` bytes, a SYMBOLIC ref that
        // stays byte-identical across an ordinary commit (MEASURED; see
        // `headAtWrite`'s doc comment) — so it can't tell "a commit
        // landed" from "nothing happened." `headSha` resolves the actual
        // commit, at the cost of one small `git rev-parse` spawn per
        // poll, same order as the `git status` this block already pays
        // for above.
        //
        // LIVE SMOKE FINDING (2026-08-20): `dirty`/`ignoredPrefixes` above
        // only prove the working tree is QUIET — they say nothing about
        // whether HEAD holds any PARTICULAR entry's own bytes, and a
        // discarded edit (`git checkout -- <file>`) is quiet too, with no
        // commit anywhere. `reconcileLedger` now requires POSITIVE
        // evidence on top of quietness — see its own doc comment's "root
        // inference" section — which means reading what HEAD actually
        // holds for every still-pending file and comparing it to that
        // file's own recorded `afterHashes` entry.
        //
        // `candidatePaths` is every file touched by a STILL-PENDING edit
        // entry — `resolveCommitState` here is the exact same pure
        // reducer `reconcileLedger` runs internally over this SAME
        // `preStatusEntries` array, so this can never disagree with what
        // the loop below actually considers: an entry `reconcileLedger`
        // will skip anyway (already committed by an earlier poll) never
        // adds a path to this batch. That keeps the set bounded by "how
        // much is currently unreconciled," not by the ledger's whole
        // history, which matters because this runs on every poll.
        //
        // `readHeadBlobs` reads all of them in ONE `git cat-file --batch`
        // spawn regardless of how many paths are pending — see its own
        // doc comment (`git-branches.ts`) for why a per-file spawn would
        // not scale here. It throws on a genuine git failure rather than
        // returning a partial map, which the surrounding `catch` below
        // turns into "skip reconciling this poll" — the same "unknown
        // must never read as committed" contract `listDirtyRepoRelativePaths`
        // already has.
        const pendingState = resolveCommitState(preStatusEntries)
        const candidatePaths = new Set<string>()
        for (const e of preStatusEntries) {
          if (e.type !== "edit") continue
          if (pendingState.get(e.id)?.committed) continue
          for (const f of e.files) candidatePaths.add(normalizeLedgerPath(f))
        }
        const headBlobs = await readHeadBlobs(ctx.repoRoot, [...candidatePaths])
        const matchesHeadContent = (repoRel: string, expectedHash: string): boolean => {
          const content = headBlobs.get(repoRel)
          return content !== undefined && hashContent(content) === expectedHash
        }

        await reconcileLedger(
          ctx.repoRoot,
          preStatusEntries,
          (repoRel) => dirty.has(repoRel),
          matchesHeadContent,
          branch,
          (await headSha(ctx.repoRoot)) ?? undefined,
        )
      }
    } catch {
      // Could not determine what's dirty, or could not read HEAD's
      // content for the pending files — see the guard note above. Either
      // way, "we don't know" must skip reconciling this poll, never guess.
    }
  } finally {
    releaseGate()
  }

  const entries = await readLedger(ctx.repoRoot)
  const state = resolveCommitState(entries)
  // P2-3 (whole-branch review finding, 2026-08-18): a plain `e.branch ===
  // branch` check made every entry recorded under a branch's OLD name
  // vanish the instant that branch was renamed — the rename preserves the
  // branch's history and working tree, but not the NAME an earlier entry
  // pinned. `resolveEditBranches` folds in the ledger's own `rename`
  // lines so an old-name entry still resolves to the current branch.
  //
  // B1 (round-2 whole-branch review finding, 2026-08-19): this used to
  // call a global alias-SET helper (`resolveBranchAliases`) that matched
  // by name only, with no notion of when a rename happened relative to an
  // entry. `resolveEditBranches` fixes that: it resolves each edit's
  // identity forward from its OWN position, so a branch name reused AFTER
  // an earlier rename away from it does not fold that new branch's edits
  // into the old one's.
  const resolvedBranches = resolveEditBranches(entries)
  // F3 (round-5 whole-branch review finding, 2026-08-19): the exact-match
  // filter below only recognises a rename made through the product's own
  // Branch menu (which appends a `rename` line). A `git branch -m` typed
  // in the user's own terminal renames the SAME branch — same commits,
  // same working tree — but appends nothing, so every earlier entry still
  // carries the branch's old name and would otherwise vanish forever.
  // `isOrphanedBranch` (`rename-aliases.ts`) fails the filter open ONLY
  // for a resolved branch that no longer exists at all — a genuinely
  // different branch that's still around stays correctly hidden. See its
  // doc comment for the full harm-profile reasoning.
  //
  // P2 (round-6 whole-branch review finding, 2026-08-19): this used to
  // call `listLocalBranchNames`, which collapses "genuinely no local
  // branches" and "the `git for-each-ref` call failed" into the same `[]`.
  // Since `isOrphanedBranch` fails open on a name it can't find, a
  // transient git failure made every resolved branch read as "not in
  // the list" — bypassing the branch filter for the whole poll, not just
  // for a genuinely orphaned row. `tryListLocalBranchNames` keeps the
  // failure visible as `null`, which `isOrphanedBranch` treats as "don't
  // know" rather than "doesn't exist."
  const localBranchNames = await tryListLocalBranchNames(ctx.repoRoot)
  const existingBranches = localBranchNames === null ? null : new Set(localBranchNames)

  // F5 (codex review round 4, 2026-08-20): the design spec's horizon —
  // ledger entries since the second-most-recent commit line, plus every
  // dirty path — was never implemented; this route returned the newest
  // 200 entries with no commit-boundary cutoff, so a long-lived branch's
  // old, already-committed history filled the panel. `ledgerHorizonStart`
  // is the pure computation (see its own doc comment for why it lives
  // server-side, not in the client's `buildActivityRows`, and for the
  // "committed entries only" scoping the filter below relies on).
  const horizonStart = ledgerHorizonStart(entries, resolvedBranches, branch)

  const rows: LedgerRow[] = entries
    .map((e, i) => ({ e, i }))
    .filter((x): x is { e: LedgerEditEntry; i: number } => x.e.type === "edit")
    // Entries from another branch would be misleading, not merely extra —
    // their files may not even exist here. An entry with no recorded
    // branch is always shown, since we cannot prove it is foreign; nor is
    // one whose recorded branch no longer exists under any name (see the
    // note above).
    .filter(({ e, i }) => {
      const resolved = resolvedBranches.get(e.id)
      if (!(editBelongsToBranch(resolved, branch) || isOrphanedBranch(resolved, existingBranches))) {
        return false
      }
      // The horizon bounds COMMITTED history only — a still-pending edit
      // is "everything you have not committed" and is never trimmed by
      // it, no matter how old (see `ledgerHorizonStart`'s doc comment: a
      // dirty file silently dropped from this panel is the same class of
      // lie as one that hides it entirely). The 200-row cap below is the
      // only remaining backstop, unchanged from before this fix.
      return !(state.get(e.id)?.committed ?? false) || i >= horizonStart
    })
    .map(({ e }) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      lane: e.lane,
      files: e.files,
      backupDir: e.backupDir,
      afterHashes: e.afterHashes,
      createdFiles: e.createdFiles,
      description: describeLedgerEntry(e),
      committed: state.get(e.id)?.committed ?? false,
      sha: state.get(e.id)?.sha,
      correlationId: e.correlationId,
    }))
    .reverse()
    .slice(0, 200)

  sendJson(res, 200, { entries: rows })
}

/**
 * Breadcrumb "home" → the launcher's project picker. A editor process
 * is one-repo-per-process with no in-app project list, so "home" is the
 * launcher. We lazily start one on first request (shared for the process
 * lifetime via `ctx.homeLauncherHolder`) and return its URL; the shell
 * hard-navigates the tab to it. Asset/port overrides this process was
 * started with are forwarded (`ctx.launcherForwardArgs`) so a project
 * opened from home runs the same assets.
 *
 * A failed start clears the holder so a later click retries instead of
 * being wedged on the rejected promise.
 */
async function handleHomeRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // Spawned by a launcher that is still running: go back to it. Starting a
  // second launcher here leaked one process per project opened, and in the
  // desktop app sent the hop to the system browser, because the shell's
  // navigation guard had only ever been told about the launcher it booted.
  if (ctx.homeUrl) {
    sendJson(res, 200, { ok: true, url: ctx.homeUrl })
    return
  }
  const holder = ctx.homeLauncherHolder
  if (!holder) {
    sendJson(res, 500, { ok: false, reason: "home launcher unavailable" })
    return
  }
  if (!holder.current) {
    holder.current = (async () => {
      const { startLauncher, pickFreePort } = await import(
        "./launcher-server.js"
      )
      const port = await pickFreePort()
      return startLauncher({
        port,
        // Serve the same UI bundle THIS editor serves — the launcher
        // page ships inside it (main.tsx branches on the bootstrap global).
        uiBundleRoot: ctx.uiBundleRoot,
        forwardArgs: ctx.launcherForwardArgs ?? [],
      })
    })()
    holder.current.catch(() => {
      // Allow a retry on the next click rather than caching the rejection.
      holder.current = null
    })
  }
  try {
    const launcher = await holder.current
    sendJson(res, 200, { ok: true, url: launcher.url })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Couldn't start the projects launcher: ${(err as Error).message}`,
    })
  }
}

/**
 * Branch mutations: switch / create / rename. Gated on branch mode —
 * in worktree-session mode canonical must stay on its root branch (Save
 * squash-merges into it), so moving it would corrupt the session.
 *
 * Body: `{ name: string, base?: 'trunk' | 'current', to?: string }`.
 * `name` is the target (switch), the new name (create), or the source
 * (rename); `to` is the new name for rename; `base` picks the branch
 * point for create.
 */
async function handleBranchMutationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  op: "switch" | "create" | "rename",
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { name?: unknown; base?: unknown; to?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const name = typeof body.name === "string" ? body.name : ""
  if (!name) {
    sendJson(res, 400, { ok: false, reason: "Missing 'name'." })
    return
  }

  const to = op === "rename" ? (typeof body.to === "string" ? body.to : "") : ""
  if (op === "rename" && !to) {
    sendJson(res, 400, { ok: false, reason: "Missing 'to' (new name)." })
    return
  }

  // Tree-scoped: a switch rewrites every tracked file in the working tree, so
  // it must not interleave with an in-flight per-file edit (Task 11). Create/
  // rename move refs rather than files, but they're the same class of
  // operation and cost nothing to serialize.
  //
  // A3 (round-2 whole-branch review finding, 2026-08-19): every step below
  // that depends on the mutation having landed — the cache invalidations,
  // the rename ledger line, the edit-history clear — used to run AFTER
  // `withTreeLock` released. An edit queued behind the lock resumes the
  // INSTANT the callback returns, so it could read the stale caches (and,
  // for a rename, miss the ledger's own record of it) before this code got
  // a chance to run. Moved inside the same exclusive callback, gated on the
  // mutation having actually succeeded — mirrors the ordering fix P1-3
  // already applied to `handleBranchCommitRequest` above.
  const result = await withTreeLock(ctx.repoRoot, async () => {
    let mutation: BranchOpResult
    if (op === "switch") {
      mutation = await switchBranch(ctx.repoRoot, name)
    } else if (op === "create") {
      const base: BranchBase = body.base === "current" ? "current" : "default"
      mutation = await createBranch(ctx.repoRoot, name, base)
    } else {
      mutation = await renameBranch(ctx.repoRoot, name, to)
    }
    if (!mutation.ok) return mutation

    // A switch/create changes the working-tree files; bust the git-status
    // cache so the next poll reflects the new HEAD.
    invalidateGitStatusCache(ctx.repoRoot)
    // P2-1 (whole-branch review finding, 2026-08-18): the edit ledger's
    // OWN branch cache (`resolveBranchCached`, edit-ledger.ts) is a
    // SEPARATE 5s-TTL cache from the git-status one above — busting only
    // the git-status cache left it stale. All three ops change what
    // `resolveBranchCached` would resolve next (switch/create move the
    // checkout; rename changes the checked-out ref's NAME, which is
    // exactly what `git symbolic-ref --short HEAD` reads), so all three
    // invalidate it, unlike the edit-history clear below which only cares
    // about switch/create (rename doesn't touch tree content). Without
    // this, an edit inside the TTL window right after this mutation gets
    // stamped with the OLD branch name — and the ledger route's branch
    // filter then hides it forever, since the log is append-only.
    //
    // B3 (round-2 whole-branch review finding, 2026-08-19): a direct edit
    // reaches `brokeredWrite` with `ctx.repoRootReal` (the realpath) as its
    // `canonicalRoot`, so `resolveBranchCached` caches THAT write's branch
    // under the realpath key, not the possibly-symlinked `ctx.repoRoot` key
    // this handler was invalidating alone. When the repo is opened through
    // a symlink those are two different `Map` keys — invalidating only one
    // left the other's stale entry to outlive this mutation. Invalidate
    // both keys explicitly rather than relying on either path string to be
    // canonical.
    invalidateBranchCache(ctx.repoRoot)
    if (ctx.repoRootReal !== undefined) invalidateBranchCache(ctx.repoRootReal)
    // P2-3 (whole-branch review finding, 2026-08-18): record the rename
    // itself, so every EARLIER ledger line still carrying `from` as its
    // `branch` (they were written before this moment — the log is
    // append-only, nothing about them changes) stays visible under the
    // branch's new name. `resolveBranchAliases` is what reads this back.
    // Recorded regardless of whether `from` was the checked-out branch —
    // `git branch -m` can rename any local branch, not just the current
    // one, and the alias only needs the name pair, not checkout state.
    if (op === "rename") {
      await appendLedgerEntry(ctx.repoRoot, {
        type: "rename",
        at: new Date().toISOString(),
        from: name,
        to,
      })
    }
    if (op === "switch" || op === "create") {
      // codex P2: the shared edit history has no branch identity — a step
      // recorded on the old checkout can byte-match the new one's tree
      // (e.g. right after a commit, or a branch just created from that same
      // commit) and pass the undo byte-verify check, silently applying the
      // old branch's before-bytes onto the new checkout. Clear on any
      // checkout change; rename doesn't change the checked-out tree so it's
      // exempt.
      await getSharedEditHistory().clear()
    }
    return mutation
  })

  if (!result.ok) {
    sendJson(res, 400, result)
    return
  }
  sendJson(res, 200, result)
}

/**
 * Publish a branch into the default branch (Phase 3). Squash-merges the
 * branch's changes into the default branch via an isolated ephemeral
 * worktree, so the user's checkout is never touched and conflicts stay
 * isolated. Body: `{ branch: string, message?: string }`.
 */
async function handlePublishRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { branch?: unknown; message?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const branch = typeof body.branch === "string" ? body.branch : ""
  if (!branch) {
    sendJson(res, 400, { ok: false, reason: "Missing 'branch'." })
    return
  }
  const message = typeof body.message === "string" ? body.message : undefined
  // Tree-scoped (Task 11): publish squash-merges the whole branch through an
  // ephemeral worktree — it must see a settled working tree, not one being
  // written mid-edit.
  const result = await withTreeLock(ctx.repoRoot, () =>
    publishBranch(ctx.repoRoot, branch, message),
  )
  if (!result.ok) {
    // 409 for a conflict (the client offers to merge the default in); 400
    // for the plain refusals (nothing to publish / on default / no branch).
    sendJson(res, result.conflict ? 409 : 400, result)
    return
  }
  invalidateGitStatusCache(ctx.repoRoot)
  // codex P2: publish rebaselines the branch (squash-merges it into the
  // default branch through an ephemeral worktree) — the shared edit
  // history's before/after bytes were recorded against the pre-publish
  // tree and have no branch identity of their own, so they must not
  // survive to be replayed against the post-publish checkout.
  await getSharedEditHistory().clear()
  sendJson(res, 200, result)
}

/**
 * The pending edit ids an about-to-run commit will actually cover —
 * captured from a ledger read taken BEFORE `commitWorkingTree` runs (P1,
 * round-7 whole-branch review finding, 2026-08-19).
 *
 * ## Why the read has to happen before `git add -A`, not after
 *
 * Round 5/6's design read the ledger AFTER `commitWorkingTree` completed
 * and swept in every pending edit on the branch, minus an exclusion list
 * for `.gitignore`d files. The tree lock that makes "every pending edit
 * on the branch" a safe sweep is PROCESS-LOCAL (`session-lock.ts`) — but
 * the ledger is deliberately lock-free JSONL specifically so a SECOND
 * Editor process on the same repo can append concurrently (see
 * `edit-ledger.ts`'s module doc). A concurrent process B can append a new
 * pending edit after process A's `git add -A` already ran (so B's bytes
 * are NOT in A's commit) but before A gets around to reading the ledger
 * for its marker — a read taken that late cannot tell B's edit apart from
 * one that genuinely predates the commit, and a branch-wide sweep durably
 * (and wrongly) marks it committed under A's sha.
 *
 * Reading here, before `commitWorkingTree` even starts, closes that
 * window: this function's result is a value fixed at read time, and
 * nothing appended after this call — by this process or any other — can
 * be in it. See `LedgerCommitEntry`'s doc comment and `commit-state.ts`'s
 * module doc for the full reasoning, including why under-counting (a
 * genuinely-committed edit missing this list) is the safe direction and
 * self-heals via `reconcileLedger`, while over-counting cannot be undone.
 *
 * ## The `.gitignore` check is still needed
 *
 * "Observed pending before staging" is not the same fact as "about to be
 * staged." `git add -A` still silently skips a `.gitignore`d path
 * regardless of when it was observed, so this still runs the same `git
 * status --ignored` check F1 (round 5) introduced — just folded into
 * building ONE inclusion list, rather than a second field for the reducer
 * to subtract back out. `LedgerCommitEntry.excludedIds` is deleted, not
 * duplicated.
 *
 * ## An entry must be DIRTY here too, not merely un-ignored (F2, round 9)
 *
 * "Pending, as observed here" is not the same fact as "produced by the
 * commit about to run" — a pending entry can have been committed by
 * something this product never saw (the user's own terminal, most
 * commonly). At the moment this snapshot is taken, such an entry's
 * file(s) already match HEAD: nothing about them is `.gitignore`d, so the
 * check above alone would still let them through, and the commit that's
 * about to run would take credit — permanently, via this line's `sha` —
 * for a change it never made.
 *
 * The fix requires every one of an entry's files to appear in this same
 * snapshot's `dirty` set, not just "not ignored." A file already clean
 * for ANY reason — committed externally, or hand-reverted to match HEAD —
 * is treated the same way: this commit cannot be the one that covers it.
 *
 * For a multi-file entry with SOME files dirty and some already clean
 * (e.g. a terminal commit that only covered part of it), the whole entry
 * is left out of `committedIds` rather than partially credited — the
 * append-only log has no way to later say "committed, but only for two of
 * these three files," so a guess here is permanent either way. Once this
 * commit lands, the previously-dirty file is clean too, and the very next
 * `reconcileLedger` poll marks the entry committed on its own (with no
 * `sha`, same self-heal path an outright miss already relies on) — so the
 * conservative choice costs nothing but one poll.
 *
 * ## Non-fatal by contract
 *
 * This runs BEFORE the real `git commit`, so a failure here must never
 * block it (P1-1, round-6 whole-branch review finding — bookkeeping must
 * never fail the commit it's describing). `listDirtyRepoRelativePaths`
 * THROWS BY DESIGN on a git failure (round 3); caught here and swallowed.
 * On failure this returns `null`, distinct from a genuine empty list: the
 * caller (`recordCommitInLedger`) treats `null` as "could not determine
 * coverage" and skips writing a `commit` line at all — reintroducing an
 * empty `committedIds` here would be a confident-looking claim of zero
 * coverage the write site never actually verified. `reconcileLedger`'s
 * next poll recovers the pending edits' committed state regardless, just
 * without this line's `sha`.
 *
 * Called by all three `commitWorkingTree` call sites, inside the SAME
 * `withTreeLock` section that runs the actual commit — so nothing from
 * THIS process can land between this read and `git add -A` either.
 */
async function captureCommitCoverage(
  repoRoot: string,
  branch: string | undefined,
): Promise<string[] | null> {
  try {
    const entries = await readLedger(repoRoot)
    const state = resolveCommitState(entries)
    const resolvedBranches = resolveEditBranches(entries)
    const pendingOnBranch = editEntries(entries).filter(
      (e) =>
        !(state.get(e.id)?.committed ?? false) &&
        editBelongsToBranch(resolvedBranches.get(e.id), branch),
    )
    if (pendingOnBranch.length === 0) return []
    const { dirty, ignoredPrefixes } = await listDirtyRepoRelativePaths(repoRoot)
    return pendingOnBranch
      .filter(
        (e) =>
          e.files.every((f) => dirty.has(normalizeLedgerPath(f))) &&
          !e.files.some((f) => isIgnoredPath(normalizeLedgerPath(f), ignoredPrefixes)),
      )
      .map((e) => e.id)
  } catch (err) {
    console.warn(
      "edit-ledger: commit coverage snapshot failed (no commit marker will be written):",
      err,
    )
    return null
  }
}

/**
 * Append a `commit` line to the edit ledger after a successful
 * `commitWorkingTree` — the line that marks exactly `committedIds`
 * committed (`resolveCommitState`). Shared by all three call sites (the
 * Commit button, and the pre-push auto-commit the Push and Create-PR
 * handlers both run); each one calls `captureCommitCoverage` BEFORE
 * `commitWorkingTree` and passes the result straight through here.
 *
 * A no-op when `commit.ok` is false (a real failure, or the "nothing to
 * commit" refusal Push/Create-PR tolerate deliberately) — neither case
 * produced a new sha, so there is nothing true to record. Also a no-op
 * when `committedIds` is `null` — see `captureCommitCoverage`'s doc
 * comment for why that's a distinct "couldn't determine" signal, not an
 * empty-but-known list.
 *
 * `appendLedgerEntry` already swallows its own errors; the try/catch here
 * is defense in depth for the same non-fatal-by-contract reason
 * `captureCommitCoverage` documents — this must never fail the commit
 * it's describing (P1-1, round-6 whole-branch review finding).
 */
async function recordCommitInLedger(
  repoRoot: string,
  commit: CommitResult,
  committedIds: string[] | null,
): Promise<void> {
  if (!commit.ok || committedIds === null) return
  try {
    await appendLedgerEntry(repoRoot, {
      type: "commit",
      at: new Date().toISOString(),
      branch: commit.branch ?? undefined,
      sha: commit.sha,
      message: commit.message,
      committedIds,
    })
  } catch (err) {
    // Non-fatal by contract — see the doc comment above. The commit
    // already landed; only its ledger marker is missing, and reconcile
    // recovers that on the next poll.
    console.warn("edit-ledger: commit marker skipped (bookkeeping failed):", err)
  }
}

/**
 * Commit the working tree onto the checked-out branch — the branch-mode
 * "Commit" boundary (tasks/branches-vs-worktree.md §7). Body:
 * `{ message?: string }`.
 */
async function handleBranchCommitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { message?: unknown }
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const message = typeof body.message === "string" ? body.message : undefined
  // Tree-scoped (Task 11): `git add -A && git commit` snapshots the ENTIRE
  // working tree, so it waits for every in-flight file edit and blocks new
  // ones — otherwise a commit could capture a half-written file, or an edit
  // landing mid-`git add` could be split across two commits.
  //
  // P1-3 (whole-branch review finding, 2026-08-18): the ledger's `commit`
  // marker is appended INSIDE this same exclusive callback, not after
  // `withTreeLock` returns — matching the Push and Create-PR call sites
  // below, which already do this correctly. An edit queued behind the
  // lock runs the INSTANT it releases; appending the marker after that
  // point let that edit append its own `edit` line and then get swept up
  // by a commit marker for a commit it was never part of. Ledger order
  // must match the git boundary it's describing, and the only way to
  // guarantee that is to record it before the lock — the one thing
  // serializing against that next edit — is released.
  //
  // `captureCommitCoverage` runs BEFORE `commitWorkingTree` (P1, round-7
  // whole-branch review finding, 2026-08-19) — see its doc comment for
  // why the read has to happen before `git add -A`, not merely before the
  // lock releases.
  const result = await withTreeLock(ctx.repoRoot, async () => {
    const branch = (await currentBranch(ctx.repoRoot)) ?? undefined
    const committedIds = await captureCommitCoverage(ctx.repoRoot, branch)
    const commit = await commitWorkingTree(ctx.repoRoot, message)
    await recordCommitInLedger(ctx.repoRoot, commit, committedIds)
    return commit
  })
  if (!result.ok) {
    sendJson(res, 400, result)
    return
  }
  invalidateGitStatusCache(ctx.repoRoot)
  // Audit Task 15 — retention sweeps, best-effort and fire-and-forget
  // (codex round 1: awaiting these inline would put an unbounded
  // `rm -rf` fan-out — potentially tens of thousands of dirs on a
  // repo's FIRST Commit after adopting this feature — on the request's
  // critical path; boot already sweeps, so the response doesn't need
  // to block on a second sweep completing). `.catch()`-wrapped so a
  // failure can never surface as an unhandled rejection; the response
  // below always reflects `result`, never the sweep outcome.
  //
  // `ctx.repoRoot`, NOT `ctx.canonicalRoot` (codex round 1 fix, matches
  // the boot-time call in `core.ts`): `.desde/` (backups,
  // chat-sessions) lives under the git ROOT, which is `repoRoot` — in a
  // monorepo subdirectory or the editor-cli/self-host harness,
  // `canonicalRoot` is a different, deeper path and the sweep would
  // silently ENOENT against a directory nothing ever writes to.
  void runRetentionGc(ctx.repoRoot, ctx.retention).catch((err) => {
    console.warn(`[retention-gc] post-commit sweep failed: ${(err as Error).message}`)
  })
  // `gcAllProposalBlobs` predates audit Task 15 (Phase 4 §4 of
  // tasks/editor-detached-sessions.md) but was never actually wired
  // to a trigger — its own doc comment says "after a successful
  // worktree-wide save" (exactly this Commit). It now skips any
  // session whose persisted `conflicts` map is non-empty (see its
  // module header) so a routine Commit can't destroy a DIFFERENT
  // session's still-unresolved "Use mine"/merge recoverability.
  // Deliberately NOT run at CLI boot (unlike the two sweeps above): a
  // conflict-free session's blobs are safe to sweep any time, but this
  // keeps the "conflicts map" check colocated with the one trigger
  // that actually promotes edits to git.
  void gcAllProposalBlobs(ctx.repoRoot).catch((err) => {
    console.warn(`[retention-gc] post-commit proposal-blob sweep failed: ${(err as Error).message}`)
  })
  sendJson(res, 200, result)
}

const DISCARDABLE_STATUSES: readonly WorkingTreeChangeStatus[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
]

/**
 * Discard one file's uncommitted changes — the Activity panel's per-row
 * "Discard changes" action (undo v1, git-backed; distinct from the
 * edit-service backup journal). Body: `{ path: string, status:
 * WorkingTreeChange['status'], from?: string }` — the client sends the
 * same fields the Activity row already has from `listWorkingTreeChanges`,
 * so there's no server-side re-derivation to drift out of sync.
 */
async function handleBranchDiscardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { path?: unknown; status?: unknown; from?: unknown }
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const filePath = typeof body.path === "string" ? body.path : ""
  if (!filePath) {
    sendJson(res, 400, { ok: false, reason: "Missing 'path'." })
    return
  }
  const status = typeof body.status === "string" ? body.status : ""
  if (!DISCARDABLE_STATUSES.includes(status as WorkingTreeChangeStatus)) {
    sendJson(res, 400, { ok: false, reason: `Invalid 'status': '${status}'.` })
    return
  }
  const from = typeof body.from === "string" ? body.from : undefined
  // Serialize with the edit lane: a discard racing an in-flight edit on the
  // same file could interleave git checkout/clean with the edit's write and
  // leave a torn result (codex P2). Task 11 narrowed the shared key from
  // repo-wide to per-file — this route takes the SAME per-file key
  // `/api/editor/edit` derives for that path (`fileEditLockKey`), so the
  // discard-vs-edit serialization the P2 fix bought is preserved exactly,
  // while a discard of file A no longer waits on an LLM-lane edit to file B.
  //
  // A renamed discard touches BOTH paths (`git reset -- new old` then
  // `checkout old` + `clean new`), so both keys are taken — sorted, by the
  // helper. The inner `withGitIndexLock` covers what the per-file keys can't:
  // discard's git commands mutate the repo-global `.git/index.lock`, so two
  // discards of different files must still serialize with each other even
  // though their file keys differ.
  const result = await withFileEditLocks(
    ctx.repoRoot,
    from ? [filePath, from] : [filePath],
    () =>
      withGitIndexLock(ctx.repoRoot, () =>
        discardFile(
          ctx.repoRoot,
          filePath,
          status as WorkingTreeChangeStatus,
          from,
        ),
      ),
  )
  if (!result.ok) {
    sendJson(res, 400, result)
    return
  }
  // Discarding rewrites the file on disk (restores/removes it) — bust the
  // git-status cache so the next poll reflects the clean state, same as
  // the other mutations that touch the working tree.
  invalidateGitStatusCache(ctx.repoRoot)
  sendJson(res, 200, result)
}

/**
 * Toolbar undo/redo — pops the shared in-memory edit-history stack
 * (`EditorEditHistory`, Task 1 of the toolbar-undo-redo plan) and
 * restores the popped step's before/after bytes through the same
 * `brokeredWrite` journal → locked-write → invalidate path every other
 * Editor mutation goes through. No body.
 *
 * Serializes with the edit lane on the step's own files (same rationale
 * as discard above): an undo racing an in-flight edit on the same file
 * could otherwise interleave. `expectedTopId` closes the peek→lock race —
 * if another tab's request won the lock and mutated the stack first, the
 * id check inside `history[direction]` refuses (409, retryable) instead
 * of undoing/redoing a step this request didn't actually observe at the
 * top.
 */
async function handleHistoryRequest(
  res: ServerResponse,
  ctx: RouteContext,
  direction: "undo" | "redo",
): Promise<void> {
  const history = getSharedEditHistory()
  const top = history.peek(direction)
  if (!top) {
    sendJson(res, 409, { ok: false, reason: `Nothing to ${direction}.`, history: history.state() })
    return
  }
  // P2-2 (whole-branch review finding, 2026-08-18): `ctx.repoRoot`, NOT
  // `ctx.canonicalRoot`. `ApplyTopOptions.canonicalRoot` is passed straight
  // through to `brokeredWrite`, which uses it for BOTH the backup journal
  // AND the edit-ledger append — and `.desde/` (backups, chat-sessions,
  // edit-log.jsonl) lives under the git ROOT (`repoRoot`), not under
  // `canonicalRoot` (a different, deeper path when Editor opens a package
  // inside a larger repo — see the retention-GC comment on
  // `handleBranchCommitRequest` for the same distinction). Every OTHER
  // producer/consumer of the ledger already agrees on `repoRoot`: ordinary
  // edits journal to `realpath(ctx.repoRoot)` (`applyEdit`'s `rootReal`),
  // and `GET /api/editor/ledger` reads from `ctx.repoRoot` directly. Passing
  // `canonicalRoot` here was the one call site that disagreed — in a
  // monorepo subdirectory, undo/redo's own backup + ledger writes landed
  // under the PACKAGE's `.desde/`, so the ledger route (and every
  // other consumer) never saw them.
  const result = await withFileEditLocks(ctx.repoRoot, top.files, () =>
    history[direction]({ canonicalRoot: ctx.repoRoot, expectedTopId: top.id }),
  )
  if (!result.ok) {
    sendJson(res, 409, {
      ok: false,
      reason: result.reason,
      stranded: result.stranded,
      stepId: result.stepId,
      history: result.state,
    })
    return
  }
  ctx.invalidateFiles?.(result.files)
  invalidateGitStatusCache(ctx.repoRoot)
  sendJson(res, 200, { ok: true, history: result.state })
}

/**
 * Discard-stranded-step affordance (undo/redo follow-ups Task 3) — pops the
 * top of the undo or redo stack WITHOUT applying it. The companion to
 * `handleHistoryRequest` above: when an undo/redo refusal comes back
 * `stranded: true` (the step can never be applied again from the current
 * on-disk state), the toolbar offers "Discard step", which lands here.
 *
 * No file locks: unlike undo/redo, discard never reads or writes any file
 * on disk — it only mutates the in-memory stack — so there's nothing to
 * serialize against the edit lane.
 *
 * Body: `{ direction: 'undo' | 'redo', expectedTopId?: string }`.
 */
async function handleHistoryDiscardRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { direction?: unknown; expectedTopId?: unknown }
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const direction = body.direction
  if (direction !== "undo" && direction !== "redo") {
    sendJson(res, 400, { ok: false, reason: `Invalid 'direction': '${String(direction)}'.` })
    return
  }
  const expectedTopId = typeof body.expectedTopId === "string" ? body.expectedTopId : undefined

  const history = getSharedEditHistory()
  const result = await history.discardTop(direction, expectedTopId)
  if (!result.ok) {
    sendJson(res, 409, { ok: false, reason: result.reason, history: result.state })
    return
  }
  sendJson(res, 200, { ok: true, history: result.state })
}

/**
 * Push the current branch to `origin` — the "update this branch on GitHub"
 * action in the Merge/Push menu. Commits any uncommitted edits first
 * (mirroring publish), so a designer's pending changes go up with one
 * click rather than silently staying local. Relies on the user's own git
 * credentials. No body.
 */
async function handleBranchPushRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  // Commit pending edits so the push includes them (same boundary publish
  // uses). A clean tree just skips this. Tree-scoped (Task 11) — the branch
  // READ, the commit and the push all run inside ONE exclusive section:
  // reading the branch outside it would let a concurrent branch switch make
  // us push a stale branch name, and splitting commit from push would let an
  // edit land between them and get committed-but-not-pushed.
  const pushed = await withTreeLock(ctx.repoRoot, async () => {
    const branch = await currentBranch(ctx.repoRoot)
    if (!branch) {
      return { stage: "branch" as const, reason: "No branch checked out to push." }
    }
    // Captured BEFORE `commitWorkingTree` (P1, round-7 whole-branch review
    // finding, 2026-08-19) — see `captureCommitCoverage`'s doc comment.
    const committedIds = await captureCommitCoverage(ctx.repoRoot, branch)
    const commit = await commitWorkingTree(ctx.repoRoot)
    if (!commit.ok && !/clean/i.test(commit.reason)) {
      return { stage: "commit" as const, reason: commit.reason }
    }
    await recordCommitInLedger(ctx.repoRoot, commit, committedIds)
    return { stage: "push" as const, result: await pushToOrigin(ctx.repoRoot, branch) }
  })
  if (pushed.stage === "branch" || pushed.stage === "commit") {
    sendJson(res, 400, { ok: false, reason: pushed.reason })
    return
  }
  const result = pushed.result
  if (!result.ok) {
    sendJson(res, 400, result)
    return
  }
  invalidateGitStatusCache(ctx.repoRoot)
  sendJson(res, 200, result)
}

/**
 * Where would a pull request from the current branch actually go?
 *
 * Read-only, and deliberately a SEPARATE round trip from creating one. `gh`
 * picks the base repository from the git remotes, and a remote named `upstream`
 * outranks `origin` silently — the ordinary layout of every fork. Without this
 * step a designer could open a pull request on a stranger's repository from
 * inside their own prototype and only discover it from the URL afterwards.
 * See `github-pull-request.ts` for the measurement. No body.
 */
async function handlePullRequestPreflightRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const branch = await currentBranch(ctx.repoRoot)
  if (!branch) {
    sendJson(res, 400, { ok: false, kind: "no-branch", reason: "No branch is checked out." })
    return
  }
  const resolved = await resolvePullRequestTarget(ctx.repoRoot, branch)
  sendJson(res, resolved.ok ? 200 : 400, resolved)
}

/**
 * Create the pull request the user just confirmed.
 *
 * Commits pending edits and pushes the branch FIRST, because `createPullRequest`
 * passes `--head`, which is what stops `gh` prompting to push and offering to
 * fork the base repo. That flag means `gh` will not push for us, so the branch
 * has to be on the remote before it runs.
 *
 * Body: `{ repoRef, base, head, title, body?, draft? }`. `repoRef` comes from
 * the preflight the user was SHOWN, and is pinned with `-R` so nothing can
 * redirect the pull request between confirming and creating it.
 */
async function handlePullRequestCreateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const body = await readJsonBody<{
    repoRef?: unknown
    base?: unknown
    head?: unknown
    title?: unknown
    body?: unknown
    draft?: unknown
  }>(req)
  const repoRef = typeof body?.repoRef === "string" ? body.repoRef.trim() : ""
  const base = typeof body?.base === "string" ? body.base.trim() : ""
  const head = typeof body?.head === "string" ? body.head.trim() : ""
  const title = typeof body?.title === "string" ? body.title.trim() : ""
  if (!repoRef || !base || !head || !title) {
    sendJson(res, 400, {
      ok: false,
      kind: "bad-request",
      reason: "A repository, base branch, head branch and title are all required.",
    })
    return
  }

  // Same exclusive section the push handler uses, and for the same reason:
  // reading the branch outside it would let a concurrent switch make us commit
  // to one branch and push another.
  const prepared = await withTreeLock(ctx.repoRoot, async () => {
    const branch = await currentBranch(ctx.repoRoot)
    if (!branch) {
      return { stage: "branch" as const, reason: "No branch is checked out." }
    }
    // The preflight ran against whatever was checked out then. If the user has
    // switched since, committing here would put their edits on the wrong branch.
    if (branch !== head) {
      return {
        stage: "branch" as const,
        reason: `The checked out branch is now '${branch}', not '${head}'. Try again.`,
      }
    }
    // Captured BEFORE `commitWorkingTree` (P1, round-7 whole-branch review
    // finding, 2026-08-19) — see `captureCommitCoverage`'s doc comment.
    const committedIds = await captureCommitCoverage(ctx.repoRoot, branch)
    const commit = await commitWorkingTree(ctx.repoRoot)
    if (!commit.ok && !/clean/i.test(commit.reason)) {
      return { stage: "commit" as const, reason: commit.reason }
    }
    await recordCommitInLedger(ctx.repoRoot, commit, committedIds)
    return { stage: "push" as const, result: await pushToOrigin(ctx.repoRoot, branch) }
  })
  if (prepared.stage === "branch" || prepared.stage === "commit") {
    sendJson(res, 400, { ok: false, kind: prepared.stage, reason: prepared.reason })
    return
  }
  if (!prepared.result.ok) {
    sendJson(res, 400, { ok: false, kind: "push-failed", reason: prepared.result.reason })
    return
  }
  invalidateGitStatusCache(ctx.repoRoot)

  const created = await createPullRequest(ctx.repoRoot, {
    repoRef,
    base,
    head,
    title,
    body: typeof body?.body === "string" ? body.body : "",
    draft: body?.draft === true,
  })
  sendJson(res, created.ok ? 200 : 400, created)
}

/**
 * Merge the current branch into the default branch AND push the default to
 * `origin` — "make it the new main, live". Squash-merges locally (via
 * `publishBranch`'s ephemeral worktree), then pushes the advanced default.
 * A merge conflict 409s exactly like publish; a merge that lands but fails
 * to push reports the partial state honestly. Body: `{ message?: string }`.
 */
async function handleBranchMergePushRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: { message?: unknown }
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const message = typeof body.message === "string" ? body.message : undefined
  // Tree-scoped (Task 11): the branch READ, the merge and the push all run
  // inside one exclusive section, for the same reasons as push above (a
  // concurrent branch switch between the read and the merge would publish the
  // wrong branch).
  const merged = await withTreeLock(
    ctx.repoRoot,
    async (): Promise<
      | { merged: false; merge: Extract<PublishResult, { ok: false }> }
      | {
          merged: true
          defaultBranch: string
          push: Awaited<ReturnType<typeof pushToOrigin>>
        }
    > => {
      const branch = await currentBranch(ctx.repoRoot)
      if (!branch) {
        return {
          merged: false,
          merge: { ok: false, reason: "No branch checked out to merge." },
        }
      }
      const m = await publishBranch(ctx.repoRoot, branch, message)
      if (!m.ok) return { merged: false, merge: m }
      return {
        merged: true,
        defaultBranch: m.defaultBranch,
        push: await pushToOrigin(ctx.repoRoot, m.defaultBranch),
      }
    },
  )
  if (!merged.merged) {
    sendJson(res, merged.merge.conflict ? 409 : 400, merged.merge)
    return
  }
  invalidateGitStatusCache(ctx.repoRoot)
  // codex P2: merge-push rebaselines the branch (publishBranch's squash
  // merge into default) the same way plain publish does — clear
  // regardless of whether the follow-on push to origin succeeds, since
  // the local rebaseline already happened.
  await getSharedEditHistory().clear()
  const push = merged.push
  if (!push.ok) {
    // Merge landed locally; only the push failed. Report the partial state
    // so the user knows main is updated locally but not on GitHub.
    sendJson(res, 200, {
      ok: true,
      defaultBranch: merged.defaultBranch,
      pushed: false,
      pushReason: push.reason,
    })
    return
  }
  sendJson(res, 200, { ok: true, defaultBranch: merged.defaultBranch, pushed: true })
}

/**
 * Fetch origin so `behind` / `unpushed` reflect the actual remote.
 *
 * Deliberately NOT under the tree lock: `git fetch` writes only
 * remote-tracking refs under `.git/` and touches no working-tree file, and
 * holding the exclusive tree gate across a network round trip would freeze
 * editing for its duration. The fetch itself carries a hard timeout
 * (`fetchOrigin`), so a dead remote fails instead of hanging. No body.
 */
async function handleBranchFetchRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const fetched = await fetchOrigin(ctx.repoRoot)
  if (!fetched.ok) {
    sendJson(res, 502, { ok: false, reason: fetched.reason })
    return
  }
  const branch = await currentBranch(ctx.repoRoot)
  // Same upstream discipline as the branch list: `behind` counts against
  // the branch's configured upstream, and a branch with none reads 0.
  const upstream = branch ? await branchUpstream(ctx.repoRoot, branch) : null
  const behind =
    branch && upstream ? await countCommitsBehind(ctx.repoRoot, branch, upstream) : 0
  sendJson(res, 200, { ok: true, behind })
}

/**
 * Shared response tail for the two all-or-nothing update actions
 * ("Update from <default>" and "Pull remote changes"). A conflict 409s
 * with the conflicted file list; a clean merge invalidates the git-status
 * cache and clears the shared edit history (the merge rewrote the working
 * tree, so recorded before/after bytes no longer apply — same reasoning as
 * publish).
 *
 * The git-status cache keys on `committedBranch`, NOT on the outcome: the
 * auto-commit can land even when the merge conflicts or turns out to be a
 * no-op (`upToDate`), and a commit flips the tree from dirty to clean.
 * The edit history is different — it holds file BYTES, and a commit alone
 * rewrites none (same reasoning as the top-bar Commit handler, which also
 * invalidates the cache without clearing history), so it clears only when
 * the merge actually rewrote the tree.
 */
async function sendUpdateBranchResult(
  res: ServerResponse,
  ctx: RouteContext,
  result: UpdateBranchResult,
): Promise<void> {
  if (result.committedBranch) {
    invalidateGitStatusCache(ctx.repoRoot)
  }
  if (!result.ok) {
    sendJson(res, result.conflict ? 409 : 400, result)
    return
  }
  if (!result.upToDate) {
    invalidateGitStatusCache(ctx.repoRoot)
    await getSharedEditHistory().clear()
  }
  sendJson(res, 200, result)
}

/**
 * "Update from <default>" — merge the default branch into the checked-out
 * branch, all-or-nothing through an ephemeral worktree (the action the
 * publish-conflict message points at). Tree-scoped like publish: the merge
 * must see a settled working tree. No body.
 */
async function handleBranchUpdateFromDefaultRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const result = await withTreeLock(
    ctx.repoRoot,
    async (): Promise<UpdateBranchResult> => {
      const branch = await currentBranch(ctx.repoRoot)
      if (!branch) {
        return {
          ok: false,
          committedBranch: false,
          reason: "No branch is checked out to update.",
        }
      }
      return updateFromDefault(ctx.repoRoot, branch)
    },
  )
  await sendUpdateBranchResult(res, ctx, result)
}

/**
 * "Pull remote changes" — fetch origin, then merge `origin/<branch>` into
 * the checked-out branch, all-or-nothing through the same ephemeral
 * worktree. The fetch runs FIRST and OUTSIDE the tree lock (network I/O,
 * remote-tracking refs only); only the local merge takes the lock. No body.
 */
async function handleBranchPullRemoteRequest(
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const fetched = await fetchOrigin(ctx.repoRoot)
  if (!fetched.ok) {
    sendJson(res, 502, { ok: false, reason: fetched.reason })
    return
  }
  const result = await withTreeLock(
    ctx.repoRoot,
    async (): Promise<UpdateBranchResult> => {
      const branch = await currentBranch(ctx.repoRoot)
      if (!branch) {
        return {
          ok: false,
          committedBranch: false,
          reason: "No branch is checked out to pull into.",
        }
      }
      return updateFromRemote(ctx.repoRoot, branch)
    },
  )
  await sendUpdateBranchResult(res, ctx, result)
}

async function handleTextBranchesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, DEFAULT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: TextBranchesRequestBody
  try {
    body = JSON.parse(raw) as TextBranchesRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const result = await getTextBranches(body, ctx.repoRoot, ctx.textBranchesLoaders)
  if (result.ok) {
    sendJson(res, result.status, {
      ok: true,
      testExpression: result.testExpression,
      branches: result.branches,
    })
  } else {
    sendJson(res, result.status, { ok: false, reason: result.reason })
  }
}

/**
 * `autoCommit` result shape on the edit response. Editor has no
 * worktree to auto-commit into (branch mode edits the user's working
 * tree directly — the user's own git is the commit boundary), so this
 * is always the no-op shape. Kept as a typed field — rather than
 * dropped from the response — so client code that still reads
 * `json.autoCommit` (`src/components/editor/file-editor-pane.tsx`,
 * `src/editor/adapters/bridge/index.ts`) degrades gracefully instead
 * of hitting an undefined access.
 */
type AutoCommitResult = { ok: true; empty: true }
const NO_OP_AUTO_COMMIT: AutoCommitResult = { ok: true, empty: true }

/**
 * Derives the edited-file list from an `applyEdit` result, for
 * `invalidateViteModules` to target. Prefers `newHashes` (multi-file
 * llm-patch edits); falls back to the single `file` field.
 */
function extractEditedFiles(result: {
  file?: string
  newHashes?: Record<string, string>
}): string[] | undefined {
  if (result.newHashes && Object.keys(result.newHashes).length > 0) {
    return Object.keys(result.newHashes)
  }
  if (result.file && result.file.length > 0) {
    return [result.file]
  }
  return undefined
}

async function handleEditRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, EDIT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: EditRequestBody
  try {
    body = JSON.parse(raw) as EditRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }

  // Content negotiation: clients that include `text/event-stream` in
  // their Accept header opt into live token streaming for the llm-patch
  // path (`start` / `token` / `complete` / `error` SSE events). Non-
  // llm-patch edits stay JSON regardless — they have no LLM call to
  // stream.
  const accept = req.headers.accept ?? ""
  const wantStream =
    accept.includes("text/event-stream") &&
    body?.edit?.kind === "llm-patch" &&
    // `'chat'` fallback mode has no in-request LLM call to stream — it
    // short-circuits with `needsChat` before the LLM lane. The streaming
    // path doesn't carry `needsChat` in its terminal `error` frame, so a
    // chat-mode request that asked for SSE would lose the escalation
    // signal. Force it onto the non-streaming path (which honors the
    // escalate short-circuit and forwards `needsChat`) regardless of the
    // Accept header. Mirrors the vue3 adapter's own wantStream gate.
    (body.edit as { llmFallback?: string }).llmFallback !== "chat"

  if (wantStream) {
    await handleEditStreaming(res, body, ctx)
    return
  }

  // Codex round-4 fix for same-file race: wrap applyEdit under the
  // per-file edit locks. Without this, two concurrent edits to the
  // SAME file would race at the filesystem layer (last writer wins on
  // the file, A's "ok" result reflects B's bytes). Task 11 narrowed the
  // scope from repo-wide to per-file (+ a shared tree gate) so an edit
  // to an unrelated file no longer queues behind this one.
  type EditOutcome = {
    result: Awaited<ReturnType<typeof applyEdit>>
    autoCommit: AutoCommitResult
  }
  const editOutcome: EditOutcome = await runEditWithMiniTurnEscalation(
    ctx,
    body,
    (miniTurnPolicy) => runEditAndAutoCommit(body, ctx, miniTurnPolicy),
  )
  const { result, autoCommit } = editOutcome
  if (result.ok) {
    // Successful edits invalidate the git-status cache so the next
    // /mcp/status query returns fresh `dirty` / `head_commit` data
    // without waiting for the 1-second TTL.
    invalidateGitStatusCache(ctx.repoRoot)
  }
  // Phase E parity: surface newHashes (for next-save external-edit
  // guard), conflicts (for the conflict UI to present recovery
  // options), and backupDir (for the engineer to recover the
  // pre-overwrite state). The CLI previously dropped all three; the
  // vue3 adapter expects newHashes at edit response time and the
  // hook's conflict path needs `conflicts` to enter recovery mode.
  // Codex review caught this drift in the May 2026 audit.
  sendJson(res, result.status, {
    ok: result.ok,
    file: result.file,
    reason: result.reason,
    newHashes: result.newHashes,
    conflicts: result.conflicts,
    backupDir: result.backupDir,
    needsChat: result.needsChat,
    // WS0 surfaced fallbackUsed/notes in the shell (adapters/bridge parses
    // them on the prop success path), but this forwarding was missing — the
    // handler set them and sendJson dropped them, so the client always saw
    // a deterministic-looking success. (Found during WS4 research.)
    fallbackUsed: result.fallbackUsed,
    notes: result.notes,
    autoCommit,
  })

  // Phase 5 carry-forward (g), landed 2026-07-30 — advisory-only manifest-
  // value-mismatch drift check. Fired AFTER `sendJson` and, critically,
  // OUTSIDE `withEditLocks` above: the check does a file re-read plus
  // a possibly-cold `GroundingService` resolution (can be multi-second on
  // first touch), and running it under the edit locks would hold them —
  // blocking every other queued edit to this file (and any tree op) — for the
  // duration, on top of delaying THIS edit's own response. Neither is
  // acceptable for an advisory-only signal ("deterministic edits are
  // instant" + "never delay the edit"). `fireManifestValueMismatchDriftCheck`
  // is genuinely fire-and-forget (not awaited) and guarantees no unhandled
  // rejection. NOTE: because this runs after the lock is released, an SDK
  // agent-chat write to the SAME file racing in right after this edit could
  // theoretically re-read a newer version of the file than the one this edit
  // actually produced, mis-naming which edit an advisory entry is attributed
  // to. Corrected 2026-08-05 (final audit-fixes wave, item 5): "agent-chat
  // writes bypass the CLI edit locks entirely" is now only HALF true — since
  // Task 13's `sdk-write-guard.ts`, the SDK's built-in `Write`/`Edit` DO take
  // this same per-file lock (via an injected `acquireWriteLock`, budget-
  // bounded — see that module's "Bounded acquisition" residual for when it
  // still degrades journal-only). The six MCP *structural* tools
  // (`insert_component`, `scaffold_route`, `delete_file`, `rename_file`,
  // `insert_element`, `manage_package`) still bypass this lock entirely —
  // they go through `brokeredWrite` (write-broker.ts), which is
  // `FileLockManager`-only, not `withFileEditLocks`. Pre-existing gap,
  // harmless for a signal that's advisory-only and coalesced by component
  // identity anyway; recorded here rather than silently accepted.
  if (result.ok && body.edit.kind === "prop") {
    fireManifestValueMismatchDriftCheck(body.edit, ctx)
  }
}

/**
 * Run an edit under the FILE-scoped locks it needs (Task 11).
 *
 * Was: one repo-wide mutex (`branch:${repoRoot}`) around every edit, which
 * meant a single slow LLM-lane edit on file A (up to a 90s mini-turn) blocked
 * an instant deterministic edit on unrelated file B. Now the edit takes the
 * repo's tree gate SHARED plus the per-file mutex for each file it touches:
 * unrelated files run concurrently, the same file still serializes, and a
 * tree op (commit/publish/branch switch) still can't interleave with either.
 *
 * Fail-safe: when the target list can't be derived (unrecognized shape), fall
 * back to the EXCLUSIVE tree lock — the old coarse behavior — rather than
 * running unserialized.
 */
function withEditLocks<T>(
  ctx: RouteContext,
  body: EditRequestBody,
  op: () => Promise<T>,
): Promise<T> {
  const targets = editLockTargets(body)
  if (targets.length === 0) return withTreeLock(ctx.repoRoot, op)
  return withFileEditLocks(ctx.repoRoot, targets, op)
}

/**
 * Two-pass edit dispatch that keeps the agent mini-turn whole-tree exclusive
 * (Task 11 review, Critical).
 *
 * The mini-turn (`edit-fix-mini-turn.ts`, engaged when a prop applicator
 * refuses with a `PropEditFallbackHint`) verifies its own work by diffing
 * whole-repo `git status` snapshots taken around the turn, and on failure
 * rolls back everything that turned dirty inside that window. Under the old
 * repo-wide edit mutex nothing else could write during those (up to 90s), so
 * "dirty ⇒ the agent did it" held. Under per-file locks it does NOT: a
 * legitimate concurrent edit to another file would be reverted by
 * `git checkout -- <that file>` on agent failure, counted as agent output
 * (making a genuinely no-op turn report success), or reported as "the agent
 * also modified X".
 *
 * Fix shape: pass 1 runs under the per-file locks with `miniTurnPolicy:
 * 'defer'` — the deterministic lane still gets its fast, concurrent path, and
 * a refusal that would have engaged the turn comes back as a pure refusal
 * with nothing written. We then RELEASE (by returning from the locked
 * section) and re-enter under `withTreeLock` — EXCLUSIVE, so it drains every
 * in-flight file edit and blocks new ones, exactly reproducing the old
 * serialization for this rare lane. Pass 2 re-runs `applyEdit` end to end:
 * the deterministic re-attempt is cheap and re-reads the file, so it also
 * re-validates the target across the lock gap (and can legitimately succeed
 * outright if the gap changed the binding).
 *
 * Upgrading the shared holder to exclusive in place is NOT an option — the
 * exclusive acquisition would wait on a shared holder that is itself, i.e. a
 * guaranteed self-deadlock.
 */
async function runEditWithMiniTurnEscalation<
  T extends { result: { deferredMiniTurn?: boolean } },
>(
  ctx: RouteContext,
  body: EditRequestBody,
  run: (miniTurnPolicy: "run" | "defer") => Promise<T>,
): Promise<T> {
  const first = await withEditLocks(ctx, body, () => run("defer"))
  if (!first.result.deferredMiniTurn) return first
  return withTreeLock(ctx.repoRoot, () => run("run"))
}

/**
 * Runs `applyEdit` and derives the edited-file list `invalidateViteModules`
 * needs to tell Vite about the write immediately (rather than waiting on the
 * OS watcher, which under load can drop/delay the event and leave the dev
 * server serving a stale module). `autoCommit` is always the no-op shape —
 * Editor has no worktree to auto-commit into (branch mode edits the user's
 * working tree directly; the user's own git is the commit boundary) — kept
 * on the response for client-shape compatibility.
 */
async function runEditAndAutoCommit(
  body: EditRequestBody,
  ctx: RouteContext,
  miniTurnPolicy: "run" | "defer" = "run",
): Promise<{
  result: Awaited<ReturnType<typeof applyEdit>>
  autoCommit: AutoCommitResult
}> {
  const result = await applyEdit(
    body,
    ctx.repoRoot,
    ctx.applicatorLoaders,
    ctx.conventions,
    {
      // See `runEditWithMiniTurnEscalation`: pass 1 (per-file locks) defers
      // the mini-turn; pass 2 (exclusive tree lock) runs it.
      miniTurnPolicy,
      // Dormant lanes (detach / swap) this prototype opted back in to.
      enabledLanes: ctx.enabledLanes,
      // WS4: give the mini-turn fallback the same design-system grounding
      // the chat route gets.
      getGrounding: () => getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
      // …and the same genuine-verification surface (headless Playwright vs
      // the CLI's own prototype URL). Lazy: only constructed if the
      // deterministic lane refuses and the mini-turn actually runs.
      createReviewSurface: async () => {
        if (!ctx.viteUrl) return null
        try {
          const { createReviewSurface, canLaunchReviewSurface } = await import(
            "../review-surface/index.js"
          )
          if (!(await canLaunchReviewSurface())) return null
          return createReviewSurface({
            viteUrl: ctx.viteUrl,
            viteBase: ctx.viteBase ?? "/",
            framework: ctx.framework,
          })
        } catch {
          return null
        }
      },
      // The project's resolved provider. Lazy: constructing one throws on a
      // missing key, and most edits never reach an LLM lane at all.
      getLlmProvider: () => getProvider({ config: llmConfigFor(ctx) }),
      llmProviderId: llmConfigFor(ctx).provider,
      chatLoaders: ctx.chatLoaders,
    },
  )
  if (!result.ok) {
    return { result, autoCommit: NO_OP_AUTO_COMMIT }
  }
  const editedFiles = extractEditedFiles(result)
  // `extractEditedFiles` returns undefined when the applicator reported no file
  // list. The old helper swallowed that; the host contract takes a real list, so
  // the tolerance lives here where the uncertainty actually is.
  if (editedFiles) ctx.invalidateFiles?.(editedFiles)
  return { result, autoCommit: NO_OP_AUTO_COMMIT }
}

/**
 * Fire-and-forget the Phase 5 carry-forward (g) manifest-value-mismatch
 * drift check for a successful `prop` edit. Deliberately NOT awaited by
 * the caller and deliberately called OUTSIDE `withCliSessionLock` — see
 * `handleEditRequest`'s call site. Never rejects (the `.catch` below
 * guarantees it): `recordManifestValueMismatchDrift` itself already
 * swallows every failure, but this is a second, cheap belt-and-suspenders
 * guard against an unhandled-rejection crash if that guarantee is ever
 * weakened by a future edit.
 *
 * `repair`/`pendingInvalidations` are threaded through here (codex P2 fix,
 * 2026-07-30) using the exact same production singletons the
 * `/api/editor/drift` route wires (`ctx.repairDeps`, `ctx.repairQueue`,
 * `resetGroundingCache`, `ctx.pendingInvalidations`) — so a
 * `manifest-value-mismatch` signal this producer records triggers the same
 * auto-repair + invalidation delivery a client-POSTed signal would, rather
 * than only ever recording an inert entry.
 */
function fireManifestValueMismatchDriftCheck(edit: PropEditBody, ctx: RouteContext): void {
  void recordManifestValueMismatchDrift(edit, {
    repoRoot: ctx.repoRoot,
    canonicalRoot: ctx.canonicalRoot,
    groundingLoaders: ctx.groundingLoaders,
    driftLog: ctx.driftLog,
    repair: {
      prototypeRoot: ctx.canonicalRoot,
      deps: ctx.repairDeps,
      queue: ctx.repairQueue,
      onRegistryChange: resetGroundingCache,
    },
    pendingInvalidations: ctx.pendingInvalidations,
  }).catch(() => {
    // Advisory-only; never surface as an unhandled rejection.
  })
}

/**
 * SSE variant of `handleEditRequest` for llm-patch edits when the
 * client opts in via `Accept: text/event-stream`. Forwards each LLM
 * token delta as an `event: token` frame so the save dialog renders
 * the model's response live. Terminates with `event: complete` (on
 * success) or `event: error` (on failure) carrying the same JSON
 * shape the non-streaming path returns — the adapter's SSE consumer
 * builds an EditResult from either terminal event.
 */
async function handleEditStreaming(
  res: ServerResponse,
  body: EditRequestBody,
  ctx: RouteContext,
): Promise<void> {
  res.statusCode = 200
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")

  const send = (event: string, data: unknown): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      // Socket closed — swallow; the in-flight applyEdit will finish
      // its run and the result is dropped on the floor.
    }
  }

  // Emit `start` with minimal metadata. The shell's onLLMStreamStart
  // currently uses `model` and `mutationCount`; we don't know the
  // exact model the SDK will pick (it follows the user's claude
  // settings), so emit a generic identifier. Mutation count comes
  // from the parsed body.
  const mutations =
    body.edit.kind === "llm-patch" ? body.edit.mutations : []
  send("start", {
    // The provider the lane will actually run on. This used to read
    // `process.env.ANTHROPIC_API_KEY ? "anthropic-sdk" : "claude-code"`, which
    // would report an OpenAI-backed patch as claude-code in the save dialog.
    model: llmConfigFor(ctx).provider,
    mutationCount: mutations.length,
  })

  try {
    // Codex round-4 fix for same-file race: applyEdit + auto-commit
    // run inside the same edit locks so two concurrent edits to
    // the same file can't bleed bytes between commits. The LLM
    // call's onTextDelta SSE frames are emitted inside the lock —
    // acceptable because the user can't have two chat-driven edits
    // in flight simultaneously for one session (the shell drives
    // them sequentially), and even if they did, queuing them is
    // the correct semantics. Task 11: the locks are per-FILE (an
    // llm-patch batch takes one per file in the bundle, sorted), so
    // this multi-second stream no longer blocks edits elsewhere.
    const runStreamingEdit = async (
      miniTurnPolicy: "run" | "defer",
    ): Promise<{
      result: Awaited<ReturnType<typeof applyEdit>>
      autoCommit: AutoCommitResult
    }> => {
      const r = await applyEdit(
        body,
        ctx.repoRoot,
        ctx.applicatorLoaders,
        ctx.conventions,
        {
          onTextDelta: (delta) => send("token", { delta }),
          // Streaming is llm-patch-only, which has no mini-turn lane — so
          // this never actually defers. Threaded anyway so the two edit
          // entry points can't drift apart if that ever changes.
          miniTurnPolicy,
          // Same reason: `llm-patch` is not a dormant kind, but the two entry
          // points must not disagree about the gate they apply.
          enabledLanes: ctx.enabledLanes,
          // Same grounding provider `runEditAndAutoCommit` gets — resolves
          // the style-context block's tokens (see edit-handler.ts's
          // handleLLMPatch). Tokens must never block an edit; the handler
          // wraps this in try/catch and degrades to `[]`.
          getGrounding: () => getGroundingService(ctx.canonicalRoot, ctx.groundingLoaders),
          // The project's resolved provider. Lazy: constructing one throws on
          // a missing key, and most edits never reach an LLM lane at all.
          getLlmProvider: () => getProvider({ config: llmConfigFor(ctx) }),
          llmProviderId: llmConfigFor(ctx).provider,
          chatLoaders: ctx.chatLoaders,
        },
      )
      if (!r.ok) return { result: r, autoCommit: NO_OP_AUTO_COMMIT }
      const editedFiles = extractEditedFiles(r)
      // `extractEditedFiles` returns undefined when the applicator reported no file
      // list. The old helper swallowed that; the host contract takes a real list, so
      // the tolerance lives here where the uncertainty actually is.
      if (editedFiles) ctx.invalidateFiles?.(editedFiles)
      return { result: r, autoCommit: NO_OP_AUTO_COMMIT }
    }
    const { result, autoCommit } = await runEditWithMiniTurnEscalation(
      ctx,
      body,
      runStreamingEdit,
    )
    if (result.ok) {
      invalidateGitStatusCache(ctx.repoRoot)
      send("complete", {
        ok: true,
        file: result.file,
        newHashes: result.newHashes,
        autoCommit,
      })
    } else {
      send("error", {
        ok: false,
        reason: result.reason,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
      })
    }
  } catch (err) {
    send("error", {
      ok: false,
      reason: `Stream failed: ${(err as Error).message}`,
    })
  } finally {
    try {
      res.end()
    } catch {
      // Already closed.
    }
  }
}

async function handleLLMFallbackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const raw = await readCappedBody(req, res, EDIT_BODY_MAX_BYTES)
  if (raw === null) return
  let body: LLMFallbackRequestBody
  try {
    body = JSON.parse(raw) as LLMFallbackRequestBody
  } catch {
    sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
    return
  }
  const result = await handleLLMFallback(
    body,
    ctx.repoRoot,
    ctx.llmFallbackLoaders,
    ctx.conventions,
    ctx.enabledLanes,
    () => getProvider({ config: llmConfigFor(ctx) }),
  )
  sendJson(res, result.status, {
    ok: result.ok,
    reason: result.reason,
    proposal: result.proposal,
  })
}

/**
 * Serve `html2canvas.min.js` (read once, cached) for the bridge's screenshot
 * capture. Unauthenticated static vendor asset; GET/HEAD only. When no path is
 * configured or the file can't be read, 404 — same as any missing asset.
 */
// Keyed by resolved path (not a single module global) so multiple
// startHttpServer() instances in one process — integration tests, sequential
// CLI servers — don't bleed each other's path/contents. Same path → shared
// (same file); different/absent paths → independent entries.
const html2canvasCacheByPath = new Map<string, string | null>()
function serveHtml2canvas(
  req: IncomingMessage,
  res: ServerResponse,
  html2canvasPath: string | undefined,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405
    res.setHeader("Allow", "GET, HEAD")
    res.end()
    return
  }
  if (!html2canvasPath) {
    res.statusCode = 404
    res.end()
    return
  }
  let cached = html2canvasCacheByPath.get(html2canvasPath)
  if (cached === undefined) {
    try {
      cached = readFileSync(html2canvasPath, "utf-8")
    } catch {
      cached = null
    }
    html2canvasCacheByPath.set(html2canvasPath, cached)
  }
  if (cached === null) {
    res.statusCode = 404
    res.end()
    return
  }
  res.setHeader("Content-Type", "application/javascript; charset=utf-8")
  res.setHeader("Cache-Control", "public, max-age=86400")
  res.setHeader("X-Content-Type-Options", "nosniff")
  if (req.method === "HEAD") {
    res.end()
    return
  }
  res.end(cached)
}

/**
 * Phase 2 — author identity for CLI-authored annotations. Read via
 * `os.userInfo()` + `os.hostname()`. Wrapped in try/catch because
 * `userInfo()` can throw on edge cases (containerized envs without
 * a real passwd entry); we fall back to placeholders rather than
 * fail the bootstrap.
 */
function cliUsername(): string {
  try {
    return osUserInfo().username || ""
  } catch {
    return ""
  }
}
function cliHostname(): string {
  try {
    return osHostname() || ""
  } catch {
    return ""
  }
}

function serveBootstrapScript(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  // The bootstrap response carries the per-session bearer token in its
  // body. The earlier "this is fine because /api/* is Origin-gated"
  // reasoning protects the use of the token but NOT its disclosure —
  // any web page the user visits could `<script src="http://127.0.0.1:4321/__desde/bootstrap.js">`
  // and read window.__DESDE_CLI__.token from its own JS context.
  //
  // Three layers now stand between a hostile page and that token, in the
  // order they can be reached:
  //   1. `checkHost` in `routeRequest` — refuses the rebound name that would
  //      make the page same-origin with us in the first place.
  //   2. This `Sec-Fetch-Site: cross-site` refusal — an ordinary cross-site
  //      read, told no by us rather than only by the browser's CORP handling.
  //      It does NOT cover rebinding (the browser labels that `same-origin`);
  //      layer 1 is what does.
  //   3. Defense-in-depth headers (CORP same-origin, nosniff, no-store)
  //      applied by serveBootstrapJs at the end of this function.
  if (isCrossSiteFetch(req)) {
    sendJson(res, 403, { ok: false, reason: "Cross-site request refused" })
    return
  }

  // Phase 5 of tasks/editor-detached-sessions.md — surface the
  // detached-sessions UI gate to the client. Defaults to `true` when
  // the project config doesn't set it (or is absent). The flag only
  // gates the picker UI + toast-on-completion; server-side
  // per-sessionId keying is always on.
  const detachedSessions = ctx.chatQuotas?.detachedSessions !== false
  // Canvas + screenshot-plan surface gate — DORMANT by product decision
  // 2026-08-04 (undertested; see CLAUDE.md § "Screenshot Capture").
  // Either `editor.canvas: true` in `.desde/config.json` OR
  // `EDITOR_CANVAS=1` restores it. Read by the client at
  // `src/lib/editor-feature-flags.ts` (`EDITOR_CANVAS`).
  //
  // Through `isCanvasEnabled`, never compared here. This was the THIRD copy of
  // the same expression (the agent runtime had one, this bootstrap had one,
  // and the routes had none at all), which is the exact drift
  // `dormant-surfaces.ts` was written to prevent. One function, every caller.
  const canvas = isCanvasEnabled(ctx)
  // Dormant edit lanes (detach / swap) — product decision 2026-08-11, see
  // `enabled-lanes.ts`. Emitted as an EXHAUSTIVE map rather than only the
  // enabled ids: the shell reads `lanes.detach === true`, so an absent key and
  // an explicit `false` must be indistinguishable, and spelling every lane out
  // makes the bootstrap self-describing when a user inspects it. Source of
  // truth is the SAME `EnabledLanes` set the two dispatch surfaces read, so the
  // offering cannot drift from what the API will accept.
  const lanes = Object.fromEntries(
    DORMANT_LANE_IDS.map((id) => [id, ctx.enabledLanes?.has(id) === true]),
  )
  // Dormant SURFACES (in-app code view, Notes) — product decision 2026-08-14.
  // Read through the same helpers the routes read, so what the client is
  // allowed to offer and what the server is willing to do cannot drift.
  // See `dormant-surfaces.ts`.
  const codeView = isCodeViewEnabled(ctx)
  const notes = isNotesEnabled(ctx)
  const vscodeLink = isVscodeLinkEnabled(ctx)
  // Editor runtime tunables from `.desde/config.json`. Only
  // emit the subkey if the user set something — keeps the bootstrap
  // payload clean for the common case and lets the shell distinguish
  // "explicitly false" from "absent" (the default).
  const editorConfig =
    ctx.editor && Object.keys(ctx.editor).length > 0
      ? ctx.editor
      : undefined
  const payload = JSON.stringify({
    token: ctx.security.token,
    shellOrigin: ctx.security.shellOrigin,
    viteUrl: ctx.viteUrl,
    // Detected framework, so the shell's get_page_info reports the real
    // substrate to the agent (vue3 vs react). Defaults to vue3.
    framework: ctx.framework ?? "vue3",
    // Detected styling system — the shell builds the matching React inline-style
    // edit (tailwind → className splice; else → inline style object). Defaults
    // to inline (universal).
    stylingSystem: ctx.stylingSystem ?? "inline",
    // Detected substrate style capabilities. Drives the inspector's style-scope
    // steering (deprioritise the element scope where it can't win). Defaults to
    // every capability false — the pre-detection behavior, which is also what a
    // failed detection reports.
    styleCapabilities: ctx.styleCapabilities ?? NO_SUBSTRATE_STYLE_CAPABILITIES,
    // Boot-resolved override destination hints. Neither decides anything on
    // its own: the shell only honours one if the page actually loads that
    // stylesheet, because a rule in an unimported file is inert.
    overrideStylesheet: ctx.overrideStylesheet ?? {},
    // Resolved Vite base (slash-wrapped). The shell strips this prefix off a
    // served stylesheet href when resolving a token's source file. Defaults to
    // `/` (root base) so the shell never has to special-case "absent".
    viteBase: ctx.viteBase ?? "/",
    // Edit substrate the CLI booted in. Branch mode is the only substrate
    // now — Editor edits the user's working tree in place, no worktree
    // session.
    editMode: "branch",
    // Absolute repo root on the user's machine. Used for stylesheet source
    // resolution, and by "Open in VS Code" when that surface is turned back
    // on (`vscodeLink`, dormant by default).
    // Same disclosure class as the rest of this token-protected, CORP-
    // guarded bootstrap (local tool, loopback origin).
    repoRoot: ctx.repoRoot,
    // The same root with symlinks resolved, when it differs. The shell tries both
    // when prefix-matching a stylesheet's bundler source hint to a token file —
    // Vite's module ids may be anchored at the real path while `repoRoot` is the
    // path the user typed, and matching only one silently withheld the token
    // scope. Omitted when identical, so the shell's fallback is the prior path.
    ...(ctx.repoRootReal !== undefined ? { repoRootReal: ctx.repoRootReal } : {}),
    detachedSessions,
    // Canvas + screenshot-plan surface — default false (opt-IN), the
    // inverse of detachedSessions' opt-out default. See EDITOR_CANVAS
    // in src/lib/editor-feature-flags.ts.
    canvas,
    // Dormant surfaces — both default false (opt-IN). See EDITOR_CODE_VIEW
    // / EDITOR_NOTES in src/lib/editor-feature-flags.ts.
    codeView,
    notes,
    vscodeLink,
    // Dormant edit lanes — both default false (opt-IN). See EDITOR_LANE_DETACH
    // / EDITOR_LANE_SWAP in src/lib/editor-feature-flags.ts.
    lanes,
    ...(editorConfig !== undefined ? { editor: editorConfig } : {}),
    // Cloud-project association. Always emitted (even when unlinked) so
    // the shell can branch on `project.projectId === null` without
    // probing for the key's existence. A non-null projectId flips
    // comments from the local store to the shared viewer project,
    // synced over the viewer's HTTP API via `viewer-proxy.ts` (no
    // Firestore — see CLAUDE.md's Editor↔viewer sync note).
    project: {
      projectId: ctx.project?.projectId ?? null,
      slug: ctx.project?.slug ?? null,
      identity: ctx.project?.identity ?? null,
      platformBaseUrl: ctx.project?.platformBaseUrl ?? null,
    },
    // Phase 2 — author identity for CLI-authored comments / notes.
    // Architecture doc says: stamp annotations with `os.userInfo()
    // username + machine name` as a placeholder. Eventual viewer-
    // side sync reconciles identity at the cloud boundary.
    user: {
      username: cliUsername(),
      hostname: cliHostname(),
    },
  })
  serveBootstrapJs(res, `window.__DESDE_CLI__=${payload};\n`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

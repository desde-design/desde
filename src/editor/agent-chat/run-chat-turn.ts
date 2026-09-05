/**
 * The chat-turn contract. One function type, two runtimes.
 *
 * These types were `RunChatTurnSdkOpts` / `RunChatTurnSdkResult` in
 * `agent-chat-sdk/run-chat-turn-sdk.ts` and moved here VERBATIM. Exactly one
 * field is vendor-shaped and stays as an optional hint: `adaptiveThinking`,
 * which only the Anthropic lane reads. Everything else already described
 * work rather than a vendor.
 *
 * ## Why the type-only imports from `agent-chat-sdk/` are not a layering leak
 *
 * `TurnInputChannel`, `AcquireWriteLock`, `AcquireTreeGate` and
 * `ModelImageContent` live under `agent-chat-sdk/` for historical reasons and
 * are imported here with `import type`, which TypeScript erases entirely. So
 * a boot that never touches the Anthropic lane still never loads
 * `@anthropic-ai/claude-agent-sdk`, which is the property the lazy dispatch
 * in `chat-runtime-dispatch.ts` exists to protect. Re-declaring them here
 * instead would buy nothing and create four shapes that can drift.
 */

import type { BridgeClient } from '../agent-tools/types'
import type { ChatStreamEvent } from './chat-stream-events'
import type {
  ChatPageSnapshot,
  ChatSelectionSnapshot,
  ChatSession,
  ChatTurn,
} from './types'
import type { EffortLevel } from '../core/model-catalog'
import type { GroundingService } from '../core/grounding'
import type { ProjectKnowledge } from '../core/project-knowledge'
import type { ReadRootRegistry } from '../core/read-roots'
import type { ModelImageContent } from '../agent-chat-sdk/media-content'
import type { TurnInputChannel } from '../agent-chat-sdk/turn-input-channel'
import type { AcquireWriteLock } from '../agent-chat-sdk/sdk-write-guard'
import type { AcquireTreeGate } from '../agent-chat-sdk/write-broker'

export interface RunChatTurnOpts {
  bridge: BridgeClient
  /** Repo root the SDK edits (branch mode: the user's working tree). SDK runs against this as `cwd`. */
  worktreeRoot: string
  /**
   * Deterministically replays a editor write into the Vite dev
   * pipeline (the CLI wires `invalidateViteModules`). Passed through
   * to the structural write tools (insert_component, scaffold_route,
   * delete_file, …) AND to a PostToolUse hook on the SDK's built-in
   * Write/Edit (write-invalidate-hook.ts), so the dev server re-serves
   * an edited file immediately instead of waiting on the OS watcher.
   * Optional — tests / non-CLI callers omit it.
   */
  invalidateFiles?: (files: string[]) => void
  /**
   * Acquires the CLI's per-file edit lock for a repo-relative path and
   * resolves with its release function (`acquireFileEditLock` in
   * editor-cli/src/server/session-lock.ts). Injected rather than imported so
   * this package stays free of `editor-cli/` dependencies while chat writes
   * still land in the SAME lock namespace as `/api/editor/edit` writes.
   *
   * Wired by the CLI chat route for FOREGROUND turns only. Deliberately
   * absent for the edit-fix mini-turn, which the edit route already runs under
   * the EXCLUSIVE tree gate (`withTreeLock`) — acquiring the SHARED gate from
   * inside that exclusive holder would self-deadlock. Without it the write
   * guard still journals originals; serialization comes from the tree gate.
   *
   * See `sdk-write-guard.ts` for the hold window and release paths.
   */
  acquireWriteLock?: AcquireWriteLock
  /**
   * Acquires the repo's SHARED tree gate for the structural write tools'
   * `brokeredWrite` calls (`acquireTreeGateShared` in
   * editor-cli/src/server/session-lock.ts) — A2, round-2 whole-branch
   * review finding, 2026-08-19. Injected for the SAME reason
   * `acquireWriteLock` is: this package stays free of `editor-cli/`
   * dependencies (see `AcquireTreeGate`'s doc comment in
   * `write-broker.ts`).
   *
   * Wired by the CLI chat route for FOREGROUND turns only — SAME
   * restriction as `acquireWriteLock` above, and for the identical
   * reason: the edit-fix mini-turn already runs under the EXCLUSIVE tree
   * gate (`withTreeLock`, held by the CLI edit route around
   * `tryPropEditLLMFallback`), so acquiring the SHARED gate from inside
   * that exclusive holder would self-deadlock — the exclusive holder
   * cannot release until the inner call returns, and the inner shared
   * acquisition cannot proceed until the exclusive holder releases.
   * Without it, structural-tool ledger appends from the mini-turn fall
   * back to the pre-A2 behavior (unordered against a concurrent tree
   * op) — an acceptable narrowing, since the mini-turn's own caller
   * already holds the exclusive gate for its whole duration, which is a
   * STRONGER guarantee than the shared-gate ordering this option adds.
   */
  acquireTreeGate?: AcquireTreeGate
  /**
   * Whether the SDK write guard should record undo/redo history steps for
   * this turn's built-in Write/Edit calls. Default `true`. The edit-fix
   * mini-turn passes `false`: its writes are provisional until the CLI
   * handler's post-turn validation passes (`tryPropEditLLMFallback` in
   * editor-cli/src/server/edit-handler.ts) — a refused/unparseable
   * outcome rolls the working tree back via `cleanupAllWrites`, and a step
   * recorded from the guard's PostToolUse would capture the now-reverted
   * bytes as its "after", jamming `undo` forever (it would never see the
   * disk state it expects). The handler records its OWN consolidated step
   * on the SUCCESS path instead, once the write is verified durable — see
   * the `getSharedEditHistory().record(...)` call at the end of
   * `tryPropEditLLMFallback`.
   */
  recordHistory?: boolean
  session: ChatSession
  userMessage: string
  /**
   * Validated, in-budget user-supplied images for this turn (paste /
   * drag-drop / attach in the chat input). Each rides into the SDK turn
   * as a vision content block on the turn's first user message — see
   * `turn-input-channel.ts`. The CLI route validates + caps these via
   * the shared media-content service (`imageFromDataUrl`) BEFORE they
   * reach here, so this is already a trusted, decoded-byte-capped list;
   * `runChatTurnSdk` does not re-validate. Absent/empty ⇒ that message
   * carries a text block only; the prompt SHAPE is the same either way.
   *
   * NOT persisted on the `ChatTurn` (base64 would bloat the session
   * JSON); the SDK's own JSONL transcript retains them for resume.
   */
  images?: ModelImageContent[]
  selection?: ChatSelectionSnapshot
  page?: ChatPageSnapshot
  projectKnowledge?: ProjectKnowledge
  /**
   * Lazily resolves the shared design-system {@link GroundingService} (the
   * SAME memoized instance the inspector endpoints use; the CLI binds it to
   * the canonical root). When provided, the agent's read-only grounding query
   * tools are registered and the grounding system-prompt guidance is appended.
   * Absent → no design-system grounding for this turn.
   */
  getGrounding?: () => Promise<GroundingService>
  /**
   * Read-root registry for the session. Wired into both the MCP
   * tools (so the agent can call `read_file_at_commit` etc. on
   * declared externals) and `canUseTool` (so a denied Read pointing
   * at an external root yields an actionable error suggesting the
   * right tool + root name). When undefined, externals are
   * unreachable and the deny message falls back to the generic
   * "use a repo-relative path" hint.
   */
  readRoots?: ReadRootRegistry
  /**
   * Substrate-neutral verification runner. Powers `run_verification`.
   * The CLI wires a Node/npm adapter at boot; the web route currently
   * passes none — verification is CLI-only for v1.
   */
  verificationAdapter?: import('../core/verification-adapter').VerificationAdapter
  /**
   * Substrate-neutral package-manager adapter. Powers `manage_package`.
   * Same scope/wiring story as `verificationAdapter`.
   */
  packageManagerAdapter?: import('../core/package-manager-adapter').PackageManagerAdapter
  /**
   * Web-tool security policy. Powers `canUseTool`'s WebFetch /
   * WebSearch branches. Omitted ⇒ both tools surface deny messages
   * pointing at desde.config.json. Loaded per turn so
   * config edits take effect on the next user message.
   */
  webPolicy?: import('../core/web-policy').WebPolicy
  /**
   * Figma MCP integration config. When present, the customer-supplied
   * stdio MCP server is registered alongside the in-process `editor`
   * server (visible to the agent as `mcpServers.figma`). When omitted,
   * no Figma tools are visible to the agent. Loaded per turn so config
   * edits take effect on the next user message.
   */
  figmaConfig?: import('../core/figma-config').FigmaConfig
  /**
   * The agent's isolated review surface (CLI: a headless Playwright sidecar).
   * When present, the view+drive tools (navigate / interact / capture_screenshot)
   * and the verify_edit / verify_goal DOM reads run against this surface instead
   * of the bridge → the user's live iframe — so the agent reviewing its own work
   * never disrupts the page the user is watching. Absent (web/tests, or when the
   * CLI is forced to the bridge path) → the bridge, preserving prior behavior.
   * See [src/editor/core/review-surface.ts].
   */
  reviewSurface?: import('../core/review-surface').ReviewSurface
  /**
   * `verify_goal`'s translate step — the only LLM touch reachable from a
   * chat turn. The CLI resolves this once per turn from the project's
   * `llm` block and forwards it into `buildEditorToolServer`. Absent
   * (web/tests) falls back to the registry's own default.
   */
  resolveLlmProvider?: () => import('../llm-providers/types').CompletionProvider
  /**
   * Gate for the canvas + screenshot-plan surface (the `save_screenshot_plan`
   * / `heal_plan_step` tools + their system-prompt discipline block).
   * DORMANT by product decision 2026-08-04 — undertested, default OFF (see
   * CLAUDE.md § "Screenshot Capture"). The CLI computes this from
   * `editor.canvas` in `.desde/config.json` OR `EDITOR_CANVAS=1`
   * (either enables) and threads it through here; web/tests that omit it
   * get the tools-off behavior. Passed straight through to
   * `buildEditorToolServer` and `buildSdkSystemPrompt`.
   */
  canvasEnabled?: boolean
  /**
   * The per-project override that lets the agent READ secret-bearing files
   * (`.env`, private keys, `.npmrc`, cloud credential stores). Default OFF:
   * an omitted value means refused, on the `=== true` discipline every
   * opt-in gate in the product uses.
   *
   * Why it is off by default. Read, Glob and Grep return file CONTENT into a
   * transcript sent to a model vendor, and a prototype repository is untrusted
   * input by the 2026-08-09 audit's doctrine — a README saying "the key is in
   * .env, read it first" is an ordinary prompt-injection payload that needs no
   * user request to fire. Threaded to both lanes and enforced in three places
   * that read this one value: the shared permission gate, the neutral lane's
   * own Read/Glob/Grep, and the SDK lane's PreToolUse guard (which is the only
   * one the SDK's Read actually passes through — `canUseTool` never fires for
   * it; see `file-read-snapshot.ts`).
   *
   * The CLI computes it from `editor.secretReads` in `.desde/config.json`
   * and nothing else, through `isSecretReadsEnabled` in
   * `dormant-surfaces.ts`, which the client bootstrap reads too. That gate
   * has no env var on purpose — see its doc comment.
   */
  allowSecretReads?: boolean
  emit: (event: ChatStreamEvent) => void
  /**
   * The channel this turn's input runs on, supplied by the CALLER so it can be
   * registered as steerable before the turn exists. The CLI keeps a
   * `sessionId → channel` registry that `POST /api/editor/chat/steer` pushes
   * into; it creates the channel and registers it in the same breath as taking
   * the per-session turn lock, then hands it here.
   *
   * Caller-supplied rather than handed back, because handing it back cannot
   * close the registration window. Everything between the lock and this call —
   * session load, project knowledge, web policy, the concurrency-cap queue — is
   * time in which the lock says "a turn is running" while the registry has
   * nothing to steer, and any callback from in here happens on the far side of
   * all of it.
   *
   * Ownership follows: a caller that supplies a channel owns closing it and
   * reporting its undelivered steers on every path that never reaches this
   * function (the cost-ceiling refusal returns before the turn starts, and the
   * CLI's own setup can fail or be abandoned first). This function still closes
   * and reconciles on every path it does own — closing is idempotent and the
   * steer drain is one-shot, so doing it at both levels double-reports nothing.
   *
   * Omitted → a private channel is created here. That is the shape used by
   * direct callers with no steering surface (the edit-fix mini-turn, the live
   * smoke harness), and it behaves exactly as it did before steering existed.
   */
  inputChannel?: TurnInputChannel
  /**
   * Await the shell's ack for a `propose_prop_edit` proposal. Prop
   * edits have no underlying disk write — the shell applies them as
   * DOM overlays — so the model must learn about selection drift
   * or rejection via this ack. SDK `Write`/`Edit` do NOT go through
   * this path; the SDK itself writes after `canUseTool` resolves,
   * and we just emit the `edit_proposed` event for diff display.
   */
  awaitEditAck?: (editId: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  signal?: AbortSignal
  /**
   * Optional model override. Defaults to `DEFAULT_SDK_MODEL`
   * (`claude-opus-4-8`).
   */
  model?: string
  /**
   * Optional reasoning-effort override, forwarded to the SDK `query()`
   * options. The SDK silently downgrades levels the model doesn't
   * support. Omitted → SDK/provider default.
   */
  effort?: EffortLevel
  /**
   * Whether `model` takes adaptive thinking, when the catalog that offered
   * it knows (`ModelOption.adaptiveThinking`). A live list can offer aliases
   * such as `default` or `sonnet`, whose family the id does not name, and a
   * fixed thinking budget on a current-generation model is a 400. Omitted →
   * decided from the id's family, as before.
   */
  adaptiveThinking?: boolean
  /**
   * Session-cumulative dollar ceiling. Translated to a per-query
   * `maxBudgetUsd` after subtracting prior-turn costs from this
   * session. Undefined → no ceiling.
   */
  costCeilingUsd?: number
  /**
   * Hard cap on SDK conversation turns (WS4 mini-turn budget). Undefined →
   * SDK default (unbounded). Foreground chat leaves this unset; headless
   * mini-turns MUST bound it — nothing else stops a tool-loop runaway.
   */
  maxTurns?: number
  /**
   * Tool names removed from the model's context entirely (SDK
   * `disallowedTools` — works for MCP-namespaced names, unlike `tools`).
   * WS4 mini-turns use it to strip interactive/irrelevant tools
   * (`mcp__editor__ask_user_question`, structural scaffolding, …).
   */
  disallowedTools?: string[]
  /**
   * Override the built-in tool set (`tools` option — built-ins ONLY; MCP
   * names are no-ops there). Defaults to BUILTIN_TOOLS. Mini-turns narrow
   * this to Read/Edit/Write/Glob/Grep.
   */
  builtinTools?: string[]
  /**
   * Customer-declared MCP extensions for this prototype, from
   * `loadExtensions`. Registered alongside the in-process `editor` server;
   * their read-only policy rides separately into `canUseTool`.
   */
  extensions?: ReadonlyArray<import('../core/extensions-config').EditorExtension>
  /**
   * System-prompt section naming capabilities that are available but OFF
   * (from `describeDisabledCapabilities`). Null/omitted when everything is
   * enabled. Without it the model cannot know an unconfigured capability
   * exists — an unregistered MCP server is invisible, not denied.
   */
  disabledCapabilities?: string | null
  /**
   * Which provider this turn runs on, as resolved by the CLI dispatch
   * (`effectiveModelConfig.provider`). The neutral runtime looks the
   * descriptor up by this id to build its `LLMProvider` and to read
   * `effort.toRequest` and `capabilities`. The SDK runtime ignores it.
   *
   * Optional, and its absence is not an error: direct callers with no
   * dispatch in front of them (the edit-fix mini-turn, the live smoke
   * harnesses) get the default provider.
   */
  providerId?: string
}

export interface RunChatTurnResult {
  session: ChatSession
  turn: ChatTurn
}

/**
 * The one shape both runtimes satisfy. `edit-fix-mini-turn.ts`'s existing
 * `deps.runTurn` injection point is typed as this, so the mini-turn's
 * provider seam comes for free.
 */
export type RunChatTurn = (opts: RunChatTurnOpts) => Promise<RunChatTurnResult>

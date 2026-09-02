/**
 * Vendor-neutral tool surface for the editor agent.
 *
 * Read-only tools the chat orchestrator can call. Each tool is a pure
 * async function taking a `ToolContext`. The context provides:
 *   - `bridge`: a `BridgeClient` that round-trips through the shell to
 *     the iframe for tools that need DOM/selection state (`get_selection`,
 *     `get_structure`, `get_screenshot`, etc.).
 *   - `repoRoot`: absolute path used by tools that need filesystem
 *     access scoped to the project (`read_file`, `list_files`).
 *   - `signal`: aborted when the chat turn is aborted by the client.
 *
 * Phase 1 ships `get_selection`, `get_page_info`, and `read_file`.
 * Phase 4 will add `list_files`, `search_files`. The plan-deferred MCP
 * tools (get_structure, get_screenshot, get_design_tokens) get lifted
 * here when Phase 1's orchestrator needs them.
 */

/**
 * Transport-agnostic bridge interface. Modeled on the existing
 * `WSBridge.send(messageType, payload)` shape in `mcp-server/`, so we
 * can later lift the MCP tools onto this same interface.
 *
 * Implementations:
 *   - editor-cli: posts a `bridge_request` SSE event to the shell;
 *     awaits the shell's `bridge-reply` POST. The shell handles each
 *     `messageType` by querying its own state (Zustand) or the iframe
 *     (postMessage to the bridge).
 *   - mcp-server (future): forwards to its existing WebSocket.
 */
export interface BridgeClient {
  send(
    messageType: string,
    payload?: unknown,
    options?: {
      signal?: AbortSignal
      /**
       * Per-request timeout override in milliseconds. When provided,
       * overrides the bridge's default `BRIDGE_REQUEST_TIMEOUT_MS` for
       * this specific request. Use for long-lived human-interaction
       * requests (e.g. `ask_user_question`) that need a much larger
       * window than the default short tool-call timeout.
       */
      timeoutMs?: number
    },
  ): Promise<unknown>
}

/**
 * Carrier shape for proposals emitted by write tools. Mirrors the
 * `EditProposal` union in `chat-stream-events.ts` — kept here too so
 * tools (which are vendor-neutral) don't import from the
 * chat-event types directly.
 */
export type EditProposalPayload =
  | {
      type: 'prop_edit'
      selector: string
      /** Stable bridge target id; preferred over selector for drift detection. */
      targetId?: string
      propName: string
      value: unknown
    }
  | {
      type: 'overwrite'
      file: string
      newSource: string
      baseHash?: string
      explanation?: string
      /**
       * Phase 4 — true when this carrier represents a new-file
       * creation (`propose_new_file`). The shell passes it through to
       * the `OverwriteEdit.allowCreate` flag, which the save endpoint
       * checks before touching disk. Defaults to false so old code
       * paths (Tier 2 repair, Tier 3, Phase 2 overwrite) keep
       * "must-exist" semantics.
       */
      allowCreate?: boolean
      /**
       * True when the agent runtime has already written this file to
       * disk (SDK Write/Edit — branch mode writes the working tree in
       * place). The shell MUST NOT re-apply via `adapter.applyEdit`
       * when this is set — the SDK has already touched disk and a
       * shell write would race the first. Defaults to undefined.
       */
      appliedByAgent?: boolean
    }
  | {
      /**
       * File deletion carrier. The agent runtime has already
       * unlinked the file by the time this carrier is emitted —
       * `appliedByAgent: true` is the load-bearing contract for the
       * shell ("display only, do not re-apply"). `baseHash` is the
       * pre-delete content hash; the proposal-blob store keeps the
       * pre-delete bytes so "Use mine" can restore on conflict.
       */
      type: 'file_delete'
      file: string
      baseHash: string
      appliedByAgent?: boolean
    }
  | {
      /**
       * File rename / move carrier. Same `appliedByAgent: true`
       * discipline as `file_delete`. `baseHash` is the source-file
       * content hash at the time of rename so conflict detection
       * across concurrent sessions still has a baseline to compare.
       */
      type: 'file_rename'
      fromFile: string
      toFile: string
      baseHash: string
      appliedByAgent?: boolean
    }

export interface ToolContext {
  bridge: BridgeClient
  /** Absolute path to the user's repo root. */
  repoRoot: string
  /**
   * Readable roots (worktree + declared externals) the agent can query
   * via git/read-root tools. Optional so contexts that haven't loaded
   * a config (web-route legacy path, tests) work unchanged — git tools
   * surface a clear error to the model when readRoots is undefined.
   */
  readRoots?: import('../core/read-roots').ReadRootRegistry
  /**
   * Base commit `session_status`/`session_diff` diff against — "what has
   * this branch changed?". Branch mode (the only substrate) has no pinned
   * session-start commit, so the SDK runtime recomputes this fresh each
   * turn as the merge-base of HEAD with the default branch (see
   * `agent-chat-sdk/run-chat-turn-sdk.ts` and
   * `worktree/git-branches.ts#branchModeRootCommitSha`). Absent when that
   * can't be resolved (no default branch, detached HEAD, non-CLI/test
   * context) — those tools then surface a clear "not configured" error.
   */
  rootCommitSha?: string
  /**
   * Substrate-neutral verification runner. When set, the
   * `run_verification` tool delegates to it; when unset, the tool
   * surfaces a "not configured" error. The CLI boot wires a Node/npm
   * adapter; other substrates plug in behind the same interface.
   */
  verificationAdapter?: import('../core/verification-adapter').VerificationAdapter
  signal?: AbortSignal
  /**
   * Buffer a proposed edit. The orchestrator wires this to emit an
   * `edit_proposed` SSE event AND await the shell's ack via a separate
   * `edit-ack` POST. Returns `{ ok: true, editId }` only when the
   * shell confirms the edit landed in the pending-edits buffer;
   * returns `{ ok: false, reason }` if the shell rejected it (e.g.
   * selection drift) or if the ack timed out. Read-only tools never
   * invoke this; write tools await its result before returning to
   * the model so the tool_result reflects actual buffer state.
   */
  emitEdit?: (
    payload: EditProposalPayload,
  ) => Promise<{ ok: true; editId: string } | { ok: false; reason: string }>
}

/**
 * Result of a tool call. The orchestrator wraps these for the LLM as
 * a `tool_result` content block.
 */
export type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string }

/**
 * Pure tool function. Takes typed input + context, returns a result.
 * Errors are returned, not thrown — the orchestrator never needs a
 * try/catch around the dispatch.
 */
export type ToolFn<Input = unknown> = (
  input: Input,
  ctx: ToolContext,
) => Promise<ToolResult>

/**
 * Definition + implementation, registered in the tool registry. The
 * orchestrator hands `def` to the LLM and calls `run` on tool use.
 */
export interface ToolEntry<Input = unknown> {
  def: {
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }
  run: ToolFn<Input>
}

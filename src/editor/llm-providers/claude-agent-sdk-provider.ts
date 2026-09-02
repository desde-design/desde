/**
 * LLMProvider implementation backed by `@anthropic-ai/claude-agent-sdk`.
 *
 * The Agent SDK routes through the bundled `claude` binary which uses
 * whichever credentials are configured for `claude` itself: a logged-in
 * subscription via `claude /login`, or `ANTHROPIC_API_KEY` if that's
 * the auth the binary was configured with. The headline use case is
 * "no API key set in the env → fall through to the user's Claude
 * subscription," so Editor's chat / Tier 2 repair / Tier 3 agent
 * stop billing the API when the user runs `desde`
 * locally with no key exported.
 *
 * Scope:
 *   - `complete()` and `streamComplete()` are first-class. They cover
 *     every edit-pipeline call site (apply-iteration-data-edit,
 *     apply-source-aware-text-edit, repair-edit, agent-request,
 *     apply-llm-patch).
 *   - `streamConversation()` is intentionally NOT implemented — the
 *     legacy chat orchestrator that calls it is being superseded by
 *     the SDK runtime in `agent-chat-sdk/run-chat-turn-sdk.ts`. If
 *     someone routes a legacy chat through this provider it will throw
 *     with a clear "use runChatTurnSdk instead" message.
 *
 * Hardening:
 *   - `allowedTools: []` so single-shot completions can't accidentally
 *     trigger built-in tools (Read/Write/etc.) — they'd burn turns and
 *     destabilize the rate-card cost estimate.
 *   - `settingSources: []` so the SDK doesn't auto-load the prototype
 *     repo's `.claude/`, `CLAUDE.md`, or user settings. Editor's own
 *     project-knowledge digest covers that for the call sites that
 *     want grounding; everyone else expects a clean prompt context.
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'

import { assertClaudeRuntimeReady, resolveClaudeExecutablePath } from './resolve-claude-executable'
import type {
  CompleteOpts,
  CompleteResult,
  ContentBlock,
  LLMProvider,
  ProviderEvent,
  StopReason,
  StreamOpts,
  SystemContent,
  UserContent,
} from './types'

export const CLAUDE_AGENT_SDK_DEFAULT_MODEL = 'claude-sonnet-4-6'

export interface ClaudeAgentSdkProviderOptions {
  /** Default model. Defaults to `claude-sonnet-4-6` (matches AnthropicProvider). */
  defaultModel?: string
  /**
   * Working directory the SDK uses for tool resolution / settings. Not
   * meaningful for our use case (we disable tools and setting sources)
   * but pass-through for completeness.
   */
  cwd?: string
}

export class ClaudeAgentSdkProvider implements LLMProvider {
  readonly name = 'claude_code'
  readonly defaultModel: string
  private readonly cwd?: string

  constructor(opts: ClaudeAgentSdkProviderOptions = {}) {
    this.defaultModel = opts.defaultModel ?? CLAUDE_AGENT_SDK_DEFAULT_MODEL
    this.cwd = opts.cwd
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    return await this.runQuery(opts, undefined)
  }

  async streamComplete(
    opts: CompleteOpts,
    onTextDelta?: (delta: string) => void,
  ): Promise<CompleteResult> {
    return await this.runQuery(opts, onTextDelta)
  }

   
  async *streamConversation(_opts: StreamOpts): AsyncIterable<ProviderEvent> {
    throw new Error(
      'ClaudeAgentSdkProvider does not implement streamConversation(). ' +
        'The Agent SDK has its own multi-turn surface (runChatTurnSdk) — ' +
        'route the chat orchestrator through that instead of through ' +
        'this provider.',
    )
  }

  private async runQuery(
    opts: CompleteOpts,
    onTextDelta: ((delta: string) => void) | undefined,
  ): Promise<CompleteResult> {
    const model = opts.model ?? this.defaultModel
    const maxTokens = opts.maxTokens
    const systemText = stringifyContent(opts.system)
    const userText = stringifyContent(opts.user)

    // Desktop-app seam (tasks/electron-app.md "fetch the claude binary on
    // first run"): `undefined` on the terminal CLI, unchanged from before —
    // the SDK falls through to its own default resolution. See
    // resolve-claude-executable.ts's module doc comment.
    const claudeExecutablePath = resolveClaudeExecutablePath()
    assertClaudeRuntimeReady(claudeExecutablePath)

    const options: Options = {
      model,
      cwd: this.cwd,
      // Lock down tool use + settings inheritance so Tier 2/3 edit
      // calls don't trigger built-in tools or pick up the prototype
      // repo's CLAUDE.md (Editor's digest already covers grounding).
      allowedTools: [],
      settingSources: [],
      // Empty systemPrompt rejects the SDK default ("Claude Code"
      // preset) — we provide our own via the appended user prompt.
      systemPrompt: systemText.length > 0 ? systemText : '',
      includePartialMessages: onTextDelta !== undefined,
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    }

    if (opts.responseFormat?.kind === 'json_schema') {
      ;(options as unknown as { outputFormat: unknown }).outputFormat = {
        type: 'json_schema',
        schema: { ...opts.responseFormat.schema },
      }
    }

    if (typeof maxTokens === 'number') {
      // `maxTokens` isn't a top-level option on every SDK version; pass
      // through as a model parameter to keep the surface narrow.
      ;(options as unknown as { maxTokens: number }).maxTokens = maxTokens
    }

    const iter = query({ prompt: userText, options })

    let assistantText = ''
    let stopReason: StopReason = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0
    let parsed: unknown

    try {
      for await (const message of iter) {
        if (opts.signal?.aborted) break

        if (
          message.type === 'stream_event' &&
          onTextDelta &&
          message.event?.type === 'content_block_delta'
        ) {
          const delta = (
            message.event as unknown as {
              delta?: { type?: string; text?: string }
            }
          ).delta
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            try {
              onTextDelta(delta.text)
            } catch {
              // Caller callback errors are non-fatal — they shouldn't
              // tear down an in-flight stream we're already paying for.
            }
          }
        }

        if (message.type === 'assistant') {
          // For non-streaming complete(), we still need to assemble
          // the full text from assistant message content blocks. The
          // SDK emits one assistant message per model turn.
          if (!onTextDelta) {
            for (const block of message.message.content) {
              if (
                (block as { type?: string }).type === 'text' &&
                typeof (block as { text?: string }).text === 'string'
              ) {
                assistantText += (block as { text: string }).text
              }
            }
          } else {
            // Streaming path already accumulated via deltas — but the
            // SDK may not emit deltas for every model (e.g. when the
            // SDK falls back to non-streaming). Belt-and-suspenders:
            // if no deltas fired, fill from the assistant message.
            if (assistantText === '') {
              for (const block of message.message.content) {
                if (
                  (block as { type?: string }).type === 'text' &&
                  typeof (block as { text?: string }).text === 'string'
                ) {
                  assistantText += (block as { text: string }).text
                }
              }
            }
          }
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            // Prefer the SDK's authoritative final text when present
            // (`result` is the concatenated assistant string).
            if (typeof message.result === 'string' && message.result.length > 0) {
              assistantText = message.result
            }
            if (typeof message.stop_reason === 'string') {
              stopReason = mapSdkStopReason(message.stop_reason)
            }
            if (message.usage) {
              inputTokens =
                (message.usage as { input_tokens?: number }).input_tokens ?? 0
              outputTokens =
                (message.usage as { output_tokens?: number }).output_tokens ?? 0
            }
            if (
              opts.responseFormat?.kind === 'json_schema' &&
              message.structured_output !== undefined
            ) {
              parsed = message.structured_output
            }
          } else {
            // Error result. Surface a clear error rather than returning
            // a degraded result — call sites need to know the LLM
            // failed so they can fall back / show an error.
            const reason =
              (message as { terminal_reason?: string }).terminal_reason ??
              (message as { subtype?: string }).subtype ??
              'unknown'
            throw new Error(
              `Claude Agent SDK query failed: ${reason}` +
                (typeof (message as { result?: string }).result === 'string'
                  ? ` (${(message as { result?: string }).result})`
                  : ''),
            )
          }
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new Error('Claude Agent SDK query aborted')
      }
      throw err
    }

    if (
      opts.responseFormat?.kind === 'json_schema' &&
      parsed === undefined &&
      assistantText.length > 0
    ) {
      // Some SDK versions / models don't populate `structured_output`;
      // fall back to parsing the assistant text as JSON.
      try {
        parsed = JSON.parse(assistantText)
      } catch {
        // Leave undefined — call sites surface the raw text in their
        // diagnostics rather than throwing here.
      }
    }

    // Contract restoration (CompleteResult.text): for `json_schema`
    // responses `text` is documented to be "the JSON string the model
    // produced". When the SDK routes the answer to `structured_output`,
    // the assistant `result` text is empty — so synthesize the JSON
    // string from `parsed`. Without this, every consumer that gates on
    // `text` before consulting `parsed` (apply-llm-patch, repair-edit,
    // agent-request, apply-iteration-data-edit) rejects a perfectly
    // good structured response with "produced no text block" — which is
    // exactly the "edit didn't save" error on the Claude-subscription
    // path (no ANTHROPIC_API_KEY → this provider is the CLI default).
    if (
      opts.responseFormat?.kind === 'json_schema' &&
      parsed !== undefined &&
      assistantText.length === 0
    ) {
      try {
        assistantText = JSON.stringify(parsed)
      } catch {
        // Non-serializable structured_output shouldn't happen; if it
        // does, leave text empty and let the caller's `parsed` check
        // carry the response through.
      }
    }

    return {
      text: assistantText,
      parsed,
      usage: { inputTokens, outputTokens },
      stopReason,
    }
  }
}

function stringifyContent(content: SystemContent | UserContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is ContentBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

function mapSdkStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    case 'pause_turn':
      return 'pause_turn'
    default:
      return 'error'
  }
}

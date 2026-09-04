/**
 * Which Anthropic model families think ADAPTIVELY, split out of
 * `run-chat-turn-sdk.ts` (M1, final-review-report.md) so that file's own SDK
 * import does not leak onto callers that only need this pure predicate.
 *
 * `editor-cli/src/server/model-catalog-source.ts` is the reason this module
 * exists on its own: it sits on the boot graph (served on every process
 * start, not lazily like the chat lane) and only ever wanted this one
 * function, not the Agent SDK that `run-chat-turn-sdk.ts` imports at module
 * scope. Importing `supportsAnthropicAdaptiveThinking` from THAT file pulled
 * the SDK onto an OpenAI-only boot too — the exact thing `resolveChatRuntime`
 * takes loaders to avoid.
 *
 * `run-chat-turn-sdk.ts` still re-exports this function (existing importers,
 * including its own `resolveAnthropicThinkingConfig`, are unaffected), it is
 * simply no longer DEFINED there.
 */

/**
 * Model families that support ADAPTIVE thinking — the model decides when and
 * how much to think, with no fixed per-turn token budget. This is the current
 * generation's only supported mode: on these models a fixed `budgetTokens`
 * is deprecated (4.6) or rejected outright (4.7+), and adaptive is what the
 * `effort` parameter modulates. Anything NOT listed here is an older-
 * generation model that still takes a fixed budget.
 *
 * Data, not a pattern — an entry per family, matched exactly or as the stem
 * of a dated snapshot (`claude-opus-5-20260401`). Adding a model to
 * `ANTHROPIC_MODEL_CATALOG` without adding it here (or deliberately leaving
 * it out, as with Haiku 4.5) fails the colocated
 * `resolve-thinking-config.test.ts` coverage assertion.
 */
const ADAPTIVE_THINKING_MODELS: readonly string[] = [
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
]

/**
 * True when `model` is one of the adaptive-thinking Claude families above.
 * Tolerates a dated-snapshot suffix (`-20260401`) but never matches a
 * different family by prefix.
 *
 * Anthropic-scoped BY NAME as of the multi-provider work: adaptive versus
 * fixed-budget thinking is Anthropic's own two-mode system, and this function
 * is consulted for the SDK lane and for the Anthropic catalog's effort
 * fallback. Another provider's reasoning knob is its descriptor's
 * `effort.toRequest`, not this.
 */
export function supportsAnthropicAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_MODELS.some(
    (family) => model === family || model.startsWith(`${family}-`),
  )
}

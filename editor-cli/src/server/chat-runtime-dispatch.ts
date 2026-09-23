/**
 * Which runtime serves this turn.
 *
 * There are exactly two: the neutral loop
 * (`src/editor/agent-chat-neutral/run-chat-turn-neutral.ts`), which is the
 * product's chat runtime for every provider, and the Claude Agent SDK
 * sidecar (`src/editor/agent-chat-sidecar/run-chat-turn-sidecar.ts`), a
 * dev-only lane for the person running Desde for themselves who would
 * rather spend the Claude subscription the bundled `claude` binary is
 * signed into. `resolveChatRuntimeKind` decides which; both loaders stay
 * lazy dynamic imports so DISPATCHING a chat turn never imports
 * `@anthropic-ai/claude-agent-sdk` unless the turn actually routes to the
 * sidecar. That laziness is the reason this is a function taking loaders
 * rather than two top-level imports.
 *
 * This is narrower than "an OpenAI-only boot never imports the SDK" — that
 * broader claim is FALSE at HEAD (M1, final-review-report.md, 2026-09-04):
 * `editor-cli/src/server/http-server.ts` statically imports `getProvider`
 * from `../../../src/editor/llm-providers/registry.js`, which itself
 * statically imports `claude-agent-sdk-provider.ts`, for the non-chat
 * LLM-fallback lane (`apply-llm-patch.ts` / `iteration-data-llm.ts` /
 * `translate-goal.ts` / `llm-generate-hints.ts`). That import runs on every
 * boot regardless of provider or chat runtime. Two OTHER confirmed leaks on
 * this same claim — `model-catalog-source.ts`'s top-level `query` import,
 * and `inherited-llm-env.ts` / `apply-llm-credentials.ts` importing
 * `CLAUDE_SUBSCRIPTION_ENV` from `registry.js` instead of
 * `claude-subscription.js` — were fixed alongside this comment; the
 * `http-server.ts` one was not, because closing it means threading an async
 * `getLlmProvider` through `edit-handler.ts` / `llm-fallback-handler.ts` /
 * `design-systems-handler.ts` and every non-chat LLM-fallback caller, which
 * is bigger and riskier than this task's scope.
 *
 * `RunChatTurn` imports the shared contract type from
 * `src/editor/agent-chat/run-chat-turn.ts` (`RunChatTurnOpts` /
 * `RunChatTurnResult`, Phase 3 Task 18) and re-exports it, so this file's
 * existing consumers see the same name they always did. The shape does not
 * change, which is what lets both runtimes satisfy one function type.
 *
 * **Dispatch no longer reads `descriptor.chatRuntime`** (Task 26). That
 * field still exists on `ProviderDescriptor` — Task 27 removes it — but it
 * described a world with a `neutral` lane and a `claude-agent-sdk` lane
 * assigned per PROVIDER. Now there is one product runtime for every
 * provider, and the second lane is a per-ENVIRONMENT opt-in available to
 * exactly one provider (Anthropic), so the decision reads the environment
 * instead: `resolveChatRuntimeKind` below.
 */
import type { RunChatTurn } from "../../../src/editor/agent-chat/run-chat-turn.js"
import { getDescriptor } from "../../../src/editor/llm-providers/provider-registry.js"
import { isClaudeSubscriptionOptIn } from "../../../src/editor/llm-providers/claude-subscription.js"
import { sidecarRefusal } from "./dormant-surfaces.js"
import type { ChatHandlerLoaders } from "./chat-handler.js"

export type { RunChatTurn }

/**
 * Which lane will serve this turn, decided the same way {@link resolveChatRuntime}
 * decides it and exported so a caller can know the lane WITHOUT loading either
 * runtime.
 *
 * `'sidecar'` iff the provider is Anthropic, the Claude-subscription opt-in
 * (`EDITOR_USE_CLAUDE_SUBSCRIPTION`, `isClaudeSubscriptionOptIn`) is set, AND
 * no `ANTHROPIC_API_KEY` is configured. A key present always wins: a user who
 * has both an opt-in flag left over from dev mode AND a real key gets the
 * product runtime, not the sidecar. Every other case — any other provider,
 * or Anthropic with neither the opt-in nor a key (where chat is refused
 * before dispatch even runs, by `assertChatCredentials`) — is `'neutral'`.
 *
 * Exported so `chat-handler.ts` can know the lane before loading it: the
 * capability catalog reads it to decide which tools the model is told about
 * (`capabilityRuntime` there), and both runtimes now emit their own
 * `steered` frame at the moment they know where a mid-turn steer landed, so
 * neither the route nor this function needs to arbitrate who announces one.
 */
export function resolveChatRuntimeKind(
  providerId: string,
  env: NodeJS.ProcessEnv,
): "neutral" | "sidecar" {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    throw new Error(`resolveChatRuntimeKind: no provider named '${providerId}'`)
  }
  if (providerId === "anthropic" && isClaudeSubscriptionOptIn(env) && !env.ANTHROPIC_API_KEY?.trim()) {
    return "sidecar"
  }
  return "neutral"
}

/**
 * Resolve and load the runtime for this turn.
 *
 * `requestedRuntime` is an optional hint a caller can pass when it already
 * knows which lane it wants confirmed — the one case today is a stale
 * client that saw the sidecar available a moment ago (its opt-in flag or its
 * key changed since) and asks for it by name. When that hint says
 * `'sidecar'` but the computed kind disagrees, this refuses with
 * {@link sidecarRefusal} rather than silently downgrading the turn onto the
 * neutral runtime the caller did not ask for. Most callers pass nothing, and
 * the computed kind alone decides.
 */
export async function resolveChatRuntime(
  providerId: string,
  loaders: ChatHandlerLoaders,
  requestedRuntime?: "neutral" | "sidecar",
): Promise<RunChatTurn> {
  const kind = resolveChatRuntimeKind(providerId, process.env)
  if (requestedRuntime === "sidecar" && kind !== "sidecar") {
    // Refused BEFORE any loader runs, so a refusal never pays for a module
    // import.
    throw new Error(sidecarRefusal())
  }
  if (kind === "sidecar") {
    // Lazy on purpose: only the sidecar loader ever imports
    // @anthropic-ai/claude-agent-sdk, and only Anthropic, opted into the
    // subscription runtime, with no key, ever reaches it.
    const { runChatTurnSdk } = await loaders.loadRunChatTurnSidecar()
    return runChatTurnSdk
  }
  const { runChatTurnNeutral } = await loaders.loadRunChatTurnNeutral()
  return runChatTurnNeutral
}

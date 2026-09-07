/**
 * Which runtime serves this turn.
 *
 * The descriptor's `chatRuntime` decides, and both loaders stay lazy dynamic
 * imports so DISPATCHING a chat turn never imports
 * `@anthropic-ai/claude-agent-sdk` unless the turn actually routes to the
 * SDK lane. That laziness is the reason this is a function taking loaders
 * rather than two top-level imports.
 *
 * This is narrower than "an OpenAI-only boot never imports the SDK" — that
 * broader claim is FALSE at HEAD (M1, final-review-report.md, 2026-09-04):
 * `editor-cli/src/server/http-server.ts` statically imports `getProvider`
 * from `../../../src/editor/llm-providers/registry.js`, which itself
 * statically imports `claude-agent-sdk-provider.ts`, for the non-chat
 * LLM-fallback lane (`apply-llm-patch.ts` / `repair-edit.ts` /
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
 * The `isNeutralChatEnabled()` call reads env only, and takes no project
 * config — there is nothing to pass even though `chat-handler.ts` has `ctx`
 * in scope. See that function's own doc comment in `dormant-surfaces.ts` for
 * why: `chatRuntimeServable` (the client-side half, in
 * `model-catalog-source.ts`) is a process-wide singleton with no project
 * config in scope either, so a config-only override could only ever reach
 * this half, leaving the catalog still offering a group this dispatch would
 * refuse.
 */
import type { RunChatTurn } from "../../../src/editor/agent-chat/run-chat-turn.js"
import { getDescriptor } from "../../../src/editor/llm-providers/provider-registry.js"
import { chatRuntimeOverride, isNeutralChatEnabled, neutralChatRefusal } from "./dormant-surfaces.js"
import type { ChatHandlerLoaders } from "./chat-handler.js"

export type { RunChatTurn }

/**
 * Which lane will serve this turn, decided the same way {@link resolveChatRuntime}
 * decides it and exported so a caller can know the lane WITHOUT loading either
 * runtime.
 *
 * The steer route needs this: `steered` must be emitted exactly once per steer,
 * by whichever side knows where the steer actually landed in the transcript.
 * On the SDK lane that is the route, at accept time (the SDK runtime emits
 * none). On the neutral lane it is the runtime, at the step boundary where it
 * drains the channel and stamps `afterAssistantBlocks` — the route would cut
 * the live transcript at accept time, which is a different moment from the
 * position hydration replays, and the two then disagree.
 */
export function resolveChatRuntimeKind(
  providerId: string,
  env: NodeJS.ProcessEnv,
): "neutral" | "claude-agent-sdk" {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    throw new Error(`resolveChatRuntimeKind: no provider named '${providerId}'`)
  }
  // The dev override forces the neutral loop onto a provider whose descriptor
  // says otherwise. It is how phase 3 proves the loop against Anthropic before
  // any OpenAI code exists, and how the parity matrix runs both lanes over the
  // same prompts. It is subject to the same gate as any other neutral
  // dispatch: an override is not an exemption.
  return chatRuntimeOverride(env) === "neutral" ? "neutral" : descriptor.chatRuntime
}

export async function resolveChatRuntime(
  providerId: string,
  loaders: ChatHandlerLoaders,
): Promise<RunChatTurn> {
  const kind = resolveChatRuntimeKind(providerId, process.env)
  if (kind === "neutral") {
    // The dispatch half of the gate. Refused BEFORE any loader runs, so a
    // refusal never pays for a module import.
    if (!isNeutralChatEnabled()) throw new Error(neutralChatRefusal())
    // Lazy on purpose: an OpenAI-only boot must never import
    // @anthropic-ai/claude-agent-sdk, and the SDK loader is the only thing
    // that would.
    const { runChatTurnNeutral } = await loaders.loadRunChatTurnNeutral()
    return runChatTurnNeutral
  }
  const { runChatTurnSdk } = await loaders.loadRunChatTurnSdk()
  return runChatTurnSdk
}

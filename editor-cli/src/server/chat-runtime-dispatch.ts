/**
 * Which runtime serves this turn.
 *
 * The descriptor's `chatRuntime` decides, and both loaders stay lazy dynamic
 * imports so an OpenAI-only boot never imports
 * `@anthropic-ai/claude-agent-sdk`. That laziness is the reason this is a
 * function taking loaders rather than two top-level imports.
 *
 * `RunChatTurn` imports the shared contract type from
 * `src/editor/agent-chat/run-chat-turn.ts` (`RunChatTurnOpts` /
 * `RunChatTurnResult`, Phase 3 Task 18) and re-exports it, so this file's
 * existing consumers see the same name they always did. The shape does not
 * change, which is what lets both runtimes satisfy one function type.
 *
 * The `isNeutralChatEnabled({})` call reads env only, never the caller's
 * project config, even though `chat-handler.ts` has `ctx` in scope. That is
 * a deliberate asymmetry with the rest of `dormant-surfaces.ts`, not an
 * oversight: `chatRuntimeServable` (the client-side half, in
 * `model-catalog-source.ts`) is a process-wide singleton with no project
 * config in scope either, so it is also env-only. Reading `ctx` here would
 * let a project turn the flag on in `.desde/config.json` and have the
 * dispatch agree while the catalog still refuses to serve the group, which
 * is a stricter drift than the one this file exists to prevent. The
 * residual cost: a project that sets `editor.neutralChat` in its config has
 * to also export `EDITOR_NEUTRAL_CHAT=1` to see the group at all, until
 * phase 4 flips the default.
 */
import type { RunChatTurn } from "../../../src/editor/agent-chat/run-chat-turn.js"
import { getDescriptor } from "../../../src/editor/llm-providers/provider-registry.js"
import { chatRuntimeOverride, isNeutralChatEnabled, neutralChatRefusal } from "./dormant-surfaces.js"
import type { ChatHandlerLoaders } from "./chat-handler.js"

export type { RunChatTurn }

export async function resolveChatRuntime(
  providerId: string,
  loaders: ChatHandlerLoaders,
): Promise<RunChatTurn> {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    throw new Error(
      `resolveChatRuntime: no provider named '${providerId}'`,
    )
  }
  // The dev override forces the neutral loop onto a provider whose descriptor
  // says otherwise. It is how phase 3 proves the loop against Anthropic before
  // any OpenAI code exists, and how the parity matrix runs both lanes over the
  // same prompts. It is subject to the same gate as any other neutral
  // dispatch: an override is not an exemption.
  const kind =
    chatRuntimeOverride(process.env) === "neutral" ? "neutral" : descriptor.chatRuntime
  if (kind === "neutral") {
    // The dispatch half of the gate. Refused BEFORE any loader runs, so a
    // refusal never pays for a module import.
    if (!isNeutralChatEnabled({})) throw new Error(neutralChatRefusal())
    // Lazy on purpose: an OpenAI-only boot must never import
    // @anthropic-ai/claude-agent-sdk, and the SDK loader is the only thing
    // that would.
    const { runChatTurnNeutral } = await loaders.loadRunChatTurnNeutral()
    return runChatTurnNeutral
  }
  const { runChatTurnSdk } = await loaders.loadRunChatTurnSdk()
  return runChatTurnSdk
}

/**
 * Which runtime serves this turn.
 *
 * The descriptor's `chatRuntime` decides, and both loaders stay lazy dynamic
 * imports so an OpenAI-only boot never imports
 * `@anthropic-ai/claude-agent-sdk`. That laziness is the reason this is a
 * function taking loaders rather than two top-level imports.
 *
 * `RunChatTurn` is declared locally against the SDK runtime's own option and
 * result types. Phase 3 moves those verbatim into
 * `src/editor/agent-chat/run-chat-turn.ts` as `RunChatTurnOpts` /
 * `RunChatTurnResult` and re-points this alias; the shape does not change,
 * which is what lets both runtimes satisfy one function type.
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
import type {
  RunChatTurnSdkOpts,
  RunChatTurnSdkResult,
} from "../../../src/editor/agent-chat-sdk/run-chat-turn-sdk.js"
import { getDescriptor } from "../../../src/editor/llm-providers/provider-registry.js"
import { chatRuntimeOverride, isNeutralChatEnabled } from "./dormant-surfaces.js"
import type { ChatHandlerLoaders } from "./chat-handler.js"

export type RunChatTurn = (opts: RunChatTurnSdkOpts) => Promise<RunChatTurnSdkResult>

export async function resolveChatRuntime(
  providerId: string,
  loaders: ChatHandlerLoaders,
): Promise<RunChatTurn> {
  const descriptor = getDescriptor(providerId)
  if (!descriptor) {
    throw new Error(
      `Chat cannot run on provider '${providerId}': no such provider is configured.`,
    )
  }
  const kind = chatRuntimeOverride(process.env) ?? descriptor.chatRuntime
  if (kind === "claude-agent-sdk") {
    return (await loaders.loadRunChatTurnSdk()).runChatTurnSdk
  }
  // The dispatch half of the gate. Refused BEFORE any loader runs, so a
  // refusal never pays for a module import.
  if (!isNeutralChatEnabled({})) {
    throw new Error(
      `Chat on ${descriptor.label} needs the neutral runtime, which is off. ` +
        `Set "editor": { "neutralChat": true } in .desde/config.json at the repo root, ` +
        `or EDITOR_NEUTRAL_CHAT=1, to turn it on.`,
    )
  }
  if (!loaders.loadRunChatTurnNeutral) {
    throw new Error(
      `Chat on ${descriptor.label} is not available yet: the neutral runtime has not shipped.`,
    )
  }
  return (await loaders.loadRunChatTurnNeutral()).runChatTurnNeutral
}

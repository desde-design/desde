/**
 * Pins the property M1 (final-review-report.md) named: three modules that
 * sit on the boot graph — served on EVERY process start, before any provider
 * is even known — must not statically import `@anthropic-ai/claude-agent-sdk`.
 *
 * Before this test existed, all three did:
 *   - `model-catalog-source.ts` imported `query` from the Agent SDK at
 *     module scope, for `listViaClaudeCli` (Anthropic's `cli` live-model
 *     source). Fixed: `query` is now a dynamic import inside that function.
 *     `supportsAnthropicAdaptiveThinking` was imported from
 *     `run-chat-turn-sdk.ts` (which itself imports the SDK at module scope);
 *     it now lives in the SDK-free `anthropic-adaptive-thinking.ts`.
 *   - `inherited-llm-env.ts` and `apply-llm-credentials.ts` imported
 *     `CLAUDE_SUBSCRIPTION_ENV` from `registry.js`, which statically imports
 *     `claude-agent-sdk-provider.ts` (the SDK). Fixed: both now import it
 *     from `claude-subscription.js`, where the flag is actually defined.
 *
 * How this catches a regression: `@anthropic-ai/claude-agent-sdk` is mocked
 * to THROW the moment anything imports it. If a future edit reintroduces a
 * static (not dynamic) import chain from any of the three modules below to
 * that package, the dynamic `import()` of that module rejects and the test
 * fails — a plain `vi.mock` factory has no other way to run except when the
 * real loader resolves that specifier.
 *
 * NOT claimed here, and known to still be false (see the corrected doc
 * comment in `chat-runtime-dispatch.ts`): `editor-cli/src/server/http-server.ts`
 * separately imports `getProvider` from `registry.js` at module scope, for
 * the non-chat LLM-fallback lane, which pulls the SDK in on every boot
 * regardless of provider. That is a distinct, larger, NOT-fixed leak —
 * closing it means an async `getLlmProvider` threaded through
 * `edit-handler.ts` / `llm-fallback-handler.ts` / `design-systems-handler.ts`
 * and every non-chat LLM-fallback caller, out of scope for this fix.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error(
    "@anthropic-ai/claude-agent-sdk must not be statically imported from a boot-graph module",
  )
})

describe("boot-graph modules do not statically import the Agent SDK (M1)", () => {
  it("model-catalog-source.ts", async () => {
    await expect(import("../model-catalog-source.js")).resolves.toBeDefined()
  })

  it("inherited-llm-env.ts", async () => {
    await expect(import("../inherited-llm-env.js")).resolves.toBeDefined()
  })

  it("apply-llm-credentials.ts", async () => {
    await expect(import("../apply-llm-credentials.js")).resolves.toBeDefined()
  })
})

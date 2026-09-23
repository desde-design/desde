/**
 * Shared Vitest mock of the Claude Agent SDK's `query()`, for tests outside
 * this directory that need to drive `runChatTurnSdk` (or anything else that
 * calls the real SDK) from a scripted async generator instead of a live
 * model.
 *
 * `@anthropic-ai/claude-agent-sdk` may be imported only from
 * `src/editor/agent-chat-sidecar/**` (plus one dynamic import in
 * `editor-cli/src/server/model-catalog-source.ts`) — see
 * `agent-sdk-import-boundary.test.ts`. That fence covers a `vi.mock()` call
 * naming the package too: a mock factory has to reproduce the package's
 * export shape (`query`, `createSdkMcpServer`, `tool`), and a major SDK bump
 * can change it, so every test that needs one shares this module instead of
 * re-declaring its own.
 *
 * `vi.mock` calls are hoisted above the rest of THIS file by Vitest's
 * transform, which is why `queryMock` is declared through `vi.hoisted` (the
 * mock factory below runs before a plain `const` would exist). That
 * hoisting is per-file; what makes this module's mock apply to a caller's
 * *own* later imports is plain ES module evaluation order — importing this
 * module runs its top-level code (including the `vi.mock` call) before
 * anything the caller imports afterwards is loaded. Every current caller
 * imports this module first, ahead of `runChatTurnSdk`.
 */
import { vi } from 'vitest'

export type SdkQueryArgs = { prompt: unknown; options?: Record<string, unknown> }

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<(args: SdkQueryArgs) => AsyncGenerator<unknown, void, void>>(),
}))
export { queryMock }

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: 'editor', instance: {} })),
  tool: vi.fn((name: string) => ({ name })),
}))

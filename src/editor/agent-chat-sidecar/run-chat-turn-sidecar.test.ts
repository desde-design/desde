/**
 * Integration tests for the SDK chat orchestrator. Mocks the SDK's
 * `query()` to inject a scripted message stream so we can verify
 * end-to-end behaviors without burning API credits.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import { makeEmptySession } from '../agent-chat/types'

// vi.mock is hoisted to the top of the file. The factory captures
// `queryMock` from a `vi.hoisted` block so it's initialized before
// the mock runs. Tests push into `scriptedMessages` to drive the
// generator queryMock returns.
type QueryArgs = { prompt: unknown; options?: Record<string, unknown> }

const { queryMock, scriptedMessages, createSdkMcpServerMock } = vi.hoisted(() => {
  const scriptedMessages: unknown[] = []
  const queryMock = vi.fn<(args: QueryArgs) => AsyncGenerator<unknown, void, void>>(
    () => {
      return (async function* () {
        for (const m of scriptedMessages) yield m
      })()
    },
  )
  // Captures the `tools` the runner registers on each MCP server, so tests
  // can list their names and call their handlers the way the SDK would.
  const createSdkMcpServerMock = vi.fn(
    (cfg: { name: string; tools?: Array<{ name: string; handler: RegisteredHandler }> }) => ({
      type: 'sdk',
      name: cfg.name,
      instance: {},
    }),
  )
  return { queryMock, scriptedMessages, createSdkMcpServerMock }
})

type RegisteredHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  // `tool(name, description, shape, handler)`: keep the name and the handler.
  tool: vi.fn((name: string, _description: string, _shape: unknown, handler: RegisteredHandler) => ({
    name,
    handler,
  })),
}))

/** The tools registered on the `editor` MCP server by the most recent turn. */
function registeredEditorTools(): Map<string, RegisteredHandler> {
  const calls = createSdkMcpServerMock.mock.calls
  const cfg = [...calls].reverse().find((c) => c[0].name === 'editor')?.[0]
  return new Map((cfg?.tools ?? []).map((t) => [t.name, t.handler]))
}

// Now import. The mock has been registered, so the orchestrator's
// `import {query}` will resolve to `queryMock`.
import { runChatTurnSdk } from './run-chat-turn-sidecar'
import { createTurnInputChannel } from '../agent-chat/turn-input-channel'

function makeBridge(): BridgeClient {
  return { send: vi.fn(async () => null) }
}

let root: string

beforeEach(() => {
  // realpathSync canonicalizes /var/... → /private/var/... on macOS so
  // resolveRepoPath's containment check matches paths the tests build
  // by joining onto `root`.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-sdk-test-')))
  scriptedMessages.length = 0
  queryMock.mockClear()
  createSdkMcpServerMock.mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runChatTurnSdk', () => {
  it('emits turn_start and forwards SDK messages as SSE events', async () => {
    scriptedMessages.push(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
        total_cost_usd: 0.001,
      },
    )

    const events: ChatStreamEvent[] = []
    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'hi there',
      emit: (e) => events.push(e),
    })

    expect(events[0]).toEqual({ kind: 'turn_start', turnId: result.turn.id })
    expect(events.some((e) => e.kind === 'usage')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', stopReason: 'end_turn' })
  })

  it('captures assistant text + tool_use into the persisted turn', async () => {
    scriptedMessages.push(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'X.vue' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents', is_error: false },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: 'end_turn',
        total_cost_usd: 0.005,
      },
    )

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'read X.vue',
      emit: () => {},
    })

    expect(result.turn.assistantContent).toEqual([
      { type: 'text', text: 'reading' },
      { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { file_path: 'X.vue' } },
    ])
    expect(result.turn.toolResults).toEqual({
      tu_1: { ok: true, output: 'file contents' },
    })
    expect(result.turn.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    expect(result.turn.costUsd).toBe(0.005)
  })

  it('refuses when prior cost already exceeds the ceiling', async () => {
    const session = makeEmptySession('proj-1')
    session.turns.push({
      id: 't1',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      userMessage: 'prior',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-opus-4-8',
      costUsd: 10,
    })

    const events: ChatStreamEvent[] = []
    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'more',
      costCeilingUsd: 5,
      emit: (e) => events.push(e),
    })

    expect(result.turn.error).toMatch(/cost ceiling/)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('folds archivedCostUsd (audit Task 15 turns-retention) into the ceiling check', async () => {
    // Session had earlier turns archived off the head file by
    // saveSession's turns-retention cap (session-turns-archive.ts) —
    // their cost must still count toward the ceiling, or a long
    // session could silently reset its spend tracking every time the
    // head file trims.
    const session = makeEmptySession('proj-1')
    session.archivedCostUsd = 10

    const events: ChatStreamEvent[] = []
    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'more',
      costCeilingUsd: 5,
      emit: (e) => events.push(e),
    })

    expect(result.turn.error).toMatch(/cost ceiling/)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('computeSessionCost is not inflated by a re-derived archive split (codex round 2, Task 15 Batch 5 gate P2)', async () => {
    // Same fixture as
    // editor-cli/src/server/__tests__/chat-handler-turns-retention.test.ts:
    // an 8-turn, $1-each session gets trimmed to maxTurns=5 by the FIXED
    // pre-turn `saveSession` call before ever reaching runChatTurnSdk —
    // head = the newest 5 turns ($5), archivedCostUsd = the 3 oldest
    // ($3). True prior cost = $8. Before the fix, chat-handler kept
    // passing the STALE untrimmed session into runChatTurnSdk AND that
    // same stale reference into the request's FINAL saveSession call,
    // which re-derived (and re-appended) the archive split — the
    // reviewer flagged this as inflating the cost-ceiling math. This
    // pins the POST-FIX session shape (what chat-handler now actually
    // hands runChatTurnSdk) computing the CORRECT $8, not $11
    // (archivedCostUsd $3 double-added on top of turns that still
    // included the archived ones) or any other double-counted total.
    const session = makeEmptySession('proj-1')
    session.archivedCostUsd = 3
    for (let i = 4; i <= 8; i++) {
      session.turns.push({
        id: `t${i}`,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        userMessage: `turn ${i}`,
        assistantContent: [],
        toolResults: {},
        editProposals: [],
        costUsd: 1,
      })
    }

    // Ceiling set just ABOVE the TRUE total ($8) — must NOT refuse (the
    // pre-check is `priorCost >= ceiling`, so the boundary itself would
    // refuse regardless of correctness; $8.01 isolates the
    // double-count question). A regressed double-count (e.g. $11)
    // would still trip this.
    const okEvents: ChatStreamEvent[] = []
    const okResult = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'more',
      costCeilingUsd: 8.01,
      emit: (e) => okEvents.push(e),
    })
    expect(okResult.turn.error).toBeUndefined()
    expect(okEvents.some((e) => e.kind === 'error')).toBe(false)

    // Ceiling set just BELOW the true total — must refuse. Confirms the
    // fixture's $8 isn't accidentally UNDER-counted either (e.g. if
    // archivedCostUsd were dropped entirely).
    const refuseEvents: ChatStreamEvent[] = []
    const refuseResult = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'more',
      costCeilingUsd: 7.99,
      emit: (e) => refuseEvents.push(e),
    })
    expect(refuseResult.turn.error).toMatch(/cost ceiling/)
    expect(refuseEvents.some((e) => e.kind === 'error')).toBe(true)
  })

  it('prices a usage-only turn identically whether it is still in the head or has already archived (codex round 4, Task 15 Batch 5 gate P2)', async () => {
    // Before the fix, `computeSessionCost` used a rate-card estimate
    // for a usage-only turn (no vendor `costUsd`) via `estimateUsageCost`,
    // but `sumTurnCostUsd` (what folds a turn's cost into
    // `archivedCostUsd` once it rolls off the head) only looked at
    // `costUsd` and silently treated the SAME turn as $0. So a
    // usage-only turn's true cost would vanish the moment it archived
    // out — the ceiling check would undercount prior spend for a long
    // session, exactly the "blow past the ceiling" the review named.
    //
    // This fixture prices the identical turn TWO ways — still in
    // `session.turns` ("before" archiving) vs. already folded into
    // `archivedCostUsd` ("after" archiving) — through the REAL
    // `computeSessionCost` (via the public ceiling check), and asserts
    // EQUALITY between the two, not just that each is independently
    // "correct".
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const model = 'claude-sonnet-5'
    const { estimateUsageCost } = await import('../llm-providers/rate-cards')
    const trueCost = estimateUsageCost(model, usage)
    expect(trueCost).toBeGreaterThan(0) // sanity: this model has a real rate card

    const before = makeEmptySession('proj-1')
    before.turns.push({
      id: 'usage-turn',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      userMessage: 'usage-only turn, still in the head',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      usage,
      model,
      // deliberately NO costUsd — this is the case the bug missed.
    })

    const after = makeEmptySession('proj-1')
    after.archivedCostUsd = trueCost // as if session-turns-archive.ts had already archived it

    for (const [label, session] of [
      ['before', before],
      ['after', after],
    ] as const) {
      // Ceiling just below the true cost -> must refuse for BOTH.
      const refuseEvents: ChatStreamEvent[] = []
      const refuseResult = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session,
        userMessage: 'more',
        costCeilingUsd: trueCost - 0.01,
        emit: (e) => refuseEvents.push(e),
      })
      expect(refuseResult.turn.error, `${label}: expected a ceiling refusal`).toMatch(
        /cost ceiling/,
      )

      // Ceiling just above the true cost -> must NOT refuse for BOTH.
      const okEvents: ChatStreamEvent[] = []
      const okResult = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session,
        userMessage: 'more',
        costCeilingUsd: trueCost + 0.01,
        emit: (e) => okEvents.push(e),
      })
      expect(okResult.turn.error, `${label}: expected no refusal`).toBeUndefined()
      expect(okEvents.some((e) => e.kind === 'error')).toBe(false)
    }
  })

  it('passes maxBudgetUsd to the SDK as ceiling minus prior cost', async () => {
    const session = makeEmptySession('proj-1')
    session.turns.push({
      id: 't1',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      userMessage: 'prior',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'claude-opus-4-8',
      costUsd: 2.5,
    })
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      total_cost_usd: 0,
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'next',
      costCeilingUsd: 10,
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.maxBudgetUsd).toBeCloseTo(7.5, 5)
  })

  it('emits error event when SDK iteration throws', async () => {
    queryMock.mockReturnValueOnce(
      (async function* () {
        throw new Error('boom')
      })(),
    )

    const events: ChatStreamEvent[] = []
    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'crash',
      emit: (e) => events.push(e),
    })

    expect(result.turn.error).toMatch(/boom/)
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', stopReason: 'error' })
  })

  it('forwards effort into the SDK query options and records it on the turn', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'check effort',
      effort: 'low',
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.effort).toBe('low')
    expect(result.turn.effort).toBe('low')
  })

  it('omits effort from query options when not provided', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'check no effort',
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts && 'effort' in opts).toBe(false)
    expect(result.turn.effort).toBeUndefined()
  })

  it('configures the SDK options surface correctly', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'check options',
      emit: () => {},
    })

    const args = queryMock.mock.calls[0]?.[0]
    const opts = args?.options
    expect(opts?.cwd).toBe(root)
    expect(opts?.permissionMode).toBe('default')
    // NO settings sources. This assertion was `['project']` until the
    // 2026-08-09 security fix; it is inverted deliberately, not relaxed.
    //
    // `['project']` made the SDK load the PROTOTYPE's `.claude/settings.json`,
    // which can declare `hooks` — shell commands the SDK executes. A malicious
    // prototype repo that merely ships that file got arbitrary command
    // execution as the developer, in a runtime that withholds `Bash` for
    // exactly that reason (audit B6). No write guard can cover it, because the
    // file is already on disk when the repo is opened.
    //
    // If this ever goes back to a non-empty array, B6 is reopened.
    expect(opts?.settingSources).toEqual([])
    expect(opts?.includePartialMessages).toBe(true)
    // Only the two SDK built-ins that never touch the repository. Every tool
    // that does is Desde's own, on the `editor` MCP server. Was the SDK's
    // Read/Edit/Write/Glob/Grep/TodoWrite + web pair until the slim sidecar.
    expect(opts?.tools).toEqual(['WebFetch', 'WebSearch'])
    expect(opts?.tools).not.toContain('Bash')
    const toolsArr = opts?.tools as string[]
    expect(toolsArr.some((t) => t.startsWith('mcp__'))).toBe(false)
    expect(typeof opts?.canUseTool).toBe('function')
    const mcpServers = opts?.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.editor).toBeDefined()
    // Only the MCP servers passed here, and none from the developer's account.
    expect(opts?.strictMcpConfig).toBe(true)
    expect(opts?.settings).toEqual({ disableClaudeAiConnectors: true })
    // The neutral lane's prompt, as a plain string. Was the `claude_code`
    // preset plus an append until the slim sidecar.
    const sp = opts?.systemPrompt
    expect(typeof sp).toBe('string')
    expect(sp).toContain('# Who you are')
    expect(sp).toContain('mcp__editor__get_selection')
    expect(sp).not.toContain('claude_code')
    // The binary wraps a mid-turn message in <system-reminder>; the prompt
    // must name that channel as the user, not call it untrusted.
    expect(sp).toContain('The user sent a new message while you were working')
    expect(sp).not.toContain('Nothing is wrapped around it')
    // No web section while the web policy turns nothing on.
    expect(sp).not.toContain('# Web tools')
    // A model-emitted bare `Read` routes to Desde's tool.
    expect(opts?.toolAliases).toEqual({
      Read: 'mcp__editor__Read',
      Edit: 'mcp__editor__Edit',
      Write: 'mcp__editor__Write',
      Glob: 'mcp__editor__Glob',
      Grep: 'mcp__editor__Grep',
      TodoWrite: 'mcp__editor__TodoWrite',
    })
  })

  it('describes exactly the web built-ins the web policy turns on, by their SDK names', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'web',
      emit: () => {},
      webPolicy: { webFetchAllowedHosts: ['example.com'], webSearchEnabled: false },
    })

    const sp = queryMock.mock.calls[0]?.[0]?.options?.systemPrompt as string
    expect(sp).toContain('# Web tools')
    expect(sp).toContain('- `WebFetch`: fetch a page.')
    expect(sp).not.toContain('- `WebSearch`')
    expect(sp).toMatch(/UNTRUSTED third-party content/)
    expect(sp).not.toContain('`web_fetch`')
  })

  it('registers no hooks around Read, Write or Edit (the tools do that work themselves)', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'hooks',
      emit: () => {},
      invalidateFiles: () => {},
      acquireWriteLock: async () => () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options as
      | { hooks?: Record<string, Array<{ matcher?: string }> | undefined> }
      | undefined
    const hooks = opts?.hooks ?? {}
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      const matchers = hooks[event] ?? []
      expect(matchers.some((m) => m.matcher === 'Write|Edit')).toBe(false)
      expect(matchers.some((m) => m.matcher === 'Read')).toBe(false)
      // An unmatched hook fires for every tool, Read and Write included.
      expect(matchers.some((m) => m.matcher === undefined)).toBe(false)
    }
  })

  it('registers the whole neutral catalog on the editor MCP server, built-ins included', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'catalog',
      emit: () => {},
    })

    const names = [...registeredEditorTools().keys()]
    // Bare here; the SDK adds `mcp__editor__`, so the model sees
    // `mcp__editor__Read` and so on.
    for (const name of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite']) {
      expect(names).toContain(name)
    }
    for (const name of ['get_selection', 'propose_prop_edit', 'read_file_at_commit']) {
      expect(names).toContain(name)
    }
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false)
  })

  it('narrows both the MCP built-ins and the SDK built-ins to a caller-supplied builtinTools list', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'mini-turn shape',
      emit: () => {},
      // The edit-fix mini-turn's list.
      builtinTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      disallowedTools: ['mcp__editor__ask_user_question'],
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.tools).toEqual([])
    const names = [...registeredEditorTools().keys()]
    expect(names).toContain('Write')
    expect(names).not.toContain('TodoWrite')
    expect(names).not.toContain('ask_user_question')
  })

  it('does NOT register mcpServers.figma when figmaConfig is omitted', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'no figma',
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    const mcpServers = opts?.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.editor).toBeDefined()
    expect(mcpServers?.figma).toBeUndefined()
    expect(opts?.systemPrompt).not.toContain('# Figma (configured)')
  })

  it('registers mcpServers.figma and appends the Figma block when figmaConfig is set', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'figma turn',
      emit: () => {},
      figmaConfig: {
        mcpServer: { type: 'stdio', command: 'npx', args: ['-y', 'figma-mcp'] },
        allowedToolPrefixes: ['get_', 'list_'],
      },
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    const mcpServers = opts?.mcpServers as Record<string, unknown> | undefined
    expect(mcpServers?.editor).toBeDefined()
    expect(mcpServers?.figma).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-mcp'],
    })
    expect(opts?.systemPrompt).toContain('# Figma (configured)')
    expect(opts?.systemPrompt).toContain('mcpServers.figma')
  })

  it('does NOT append the screenshot-plan block when canvasEnabled is omitted (dormant by default, 2026-08-04)', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'no canvas',
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.systemPrompt).not.toContain('# Building a screenshot flow')
    expect(opts?.systemPrompt).not.toContain('save_screenshot_plan')
  })

  it('appends the screenshot-plan block when canvasEnabled is true', async () => {
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    })

    await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'canvas on',
      emit: () => {},
      canvasEnabled: true,
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.systemPrompt).toContain('# Building a screenshot flow')
    expect(opts?.systemPrompt).toContain('mcp__editor__save_screenshot_plan')
  })

  it('captures SDK session_id from init and persists it on the session (Phase 3)', async () => {
    scriptedMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sdk-abc' },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      },
    )

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'hello',
      emit: () => {},
    })

    expect(result.session.sdkSessionId).toBe('sdk-abc')
    // First turn — no `resume` option should be passed.
    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.resume).toBeUndefined()
  })

  it('passes resume on subsequent turns (Phase 3)', async () => {
    const session = makeEmptySession('proj-1')
    session.sdkSessionId = 'sdk-abc'
    session.turns.push({
      id: 'prior',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      userMessage: 'first',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    scriptedMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sdk-abc' },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      },
    )

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session,
      userMessage: 'second turn',
      emit: () => {},
    })

    const opts = queryMock.mock.calls[0]?.[0]?.options
    expect(opts?.resume).toBe('sdk-abc')
    // The session_id round-trips unchanged.
    expect(result.session.sdkSessionId).toBe('sdk-abc')
  })

  it('captures top-level tool_use_result into persisted toolResults (SF3)', async () => {
    scriptedMessages.push(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_X', name: 'Read', input: { file_path: 'X.vue' } },
          ],
        },
      },
      // user echo with NO content tool_result blocks, only top-level
      {
        type: 'user',
        message: { content: [] },
        tool_use_result: { result: 'hello' },
        parent_tool_use_id: 'tu_X',
      },
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      },
    )

    const result = await runChatTurnSdk({
      bridge: makeBridge(),
      worktreeRoot: root,
      session: makeEmptySession('proj-1'),
      userMessage: 'noop',
      emit: () => {},
    })

    expect(result.turn.toolResults).toEqual({
      tu_X: { ok: true, output: { result: 'hello' } },
    })
  })

  describe('multimodal image input (user vision)', () => {
    function pushResult(): void {
      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })
    }

    type DrainedMsg = {
      type: string
      parent_tool_use_id: unknown
      message: { role: string; content: Array<Record<string, unknown>> }
    }
    async function drain(prompt: unknown): Promise<DrainedMsg[]> {
      const out: DrainedMsg[] = []
      for await (const m of prompt as AsyncIterable<DrainedMsg>) out.push(m)
      return out
    }

    it('uses the SAME channel shape with no images (never a plain string)', async () => {
      // Measured finding 2: the SDK silently drops a mid-turn pushed message
      // when the prompt is a string-or-yields-once shape. Branching on images
      // would make steering work on text turns and lose messages on image
      // turns, so the shape is uniform — a text turn is a channel too.
      pushResult()
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'plain text turn',
        emit: () => {},
      })
      const prompt = queryMock.mock.calls[0]?.[0]?.prompt
      expect(typeof prompt).not.toBe('string')
      const msgs = await drain(prompt)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('user')
      expect(msgs[0].parent_tool_use_id).toBeNull()
      expect(msgs[0].message.content).toEqual([{ type: 'text', text: 'plain text turn' }])
    })

    it('builds a multimodal first message when images are supplied', async () => {
      pushResult()
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'match this',
        images: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
        ],
        emit: () => {},
      })
      const prompt = queryMock.mock.calls[0]?.[0]?.prompt
      expect(typeof prompt).not.toBe('string')
      const msgs = await drain(prompt)
      // One message, then the generator returns — because the turn ended and
      // closed the channel, not because the generator was built to yield once.
      expect(msgs).toHaveLength(1)
      const msg = msgs[0]
      expect(msg.type).toBe('user')
      expect(msg.parent_tool_use_id).toBeNull()
      expect(msg.message.role).toBe('user')
      expect(msg.message.content).toEqual([
        { type: 'text', text: 'match this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
      ])
    })

    it('folds the context envelope into the text block (selection/page preserved alongside images)', async () => {
      pushResult()
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'build this here',
        images: [{ type: 'image', data: 'CCCC', mimeType: 'image/webp' }],
        page: { url: 'http://localhost/', route: '/checkout', framework: 'vue3' },
        emit: () => {},
      })
      const prompt = queryMock.mock.calls[0]?.[0]?.prompt
      const msgs = await drain(prompt)
      const content = msgs[0].message.content
      // Text block carries the envelope + the user message; image rides after.
      expect(content[0].type).toBe('text')
      expect(content[0].text).toContain('build this here')
      expect(content[0].text).toContain('/checkout')
      expect(content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' },
      })
    })

    it('omits an empty text block for an image-only turn', async () => {
      pushResult()
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: '',
        images: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }],
        emit: () => {},
      })
      const prompt = queryMock.mock.calls[0]?.[0]?.prompt
      const msgs = await drain(prompt)
      // Only the image block — no `{type:'text', text:''}` (API rejects it).
      expect(msgs[0].message.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'DDDD' } },
      ])
    })

    it('does NOT persist image bytes onto the turn (userMessage stays the text string)', async () => {
      pushResult()
      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'match this',
        images: [{ type: 'image', data: 'EEEE', mimeType: 'image/png' }],
        emit: () => {},
      })
      expect(result.turn.userMessage).toBe('match this')
      expect(JSON.stringify(result.turn)).not.toContain('EEEE')
    })
  })

  describe('turn input channel (mid-turn steering)', () => {
    const RESULT = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    } as const

    /**
     * A completed assistant message. The `id` is what makes it evidence: a NEW
     * message id is a NEW inference request, and only a request assembled after
     * a steer was handed over can contain it (see
     * `turn-input-channel.ts` § takeUndeliveredSteers). `parent_tool_use_id`
     * must be present and null — a non-null one marks SUBAGENT output, which is
     * evidence about a different conversation and is deliberately not counted.
     */
    function assistantMessage(id: string): Record<string, unknown> {
      return {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id, content: [{ type: 'text', text: 'on it' }] },
      }
    }

    /**
     * One streamed token of an assistant message, as the SDK delivers it when
     * `includePartialMessages: true` — which the runtime always sets.
     *
     * These are the messages that used to be miscounted. A token of a message
     * whose request was assembled BEFORE the steer existed cannot be evidence
     * the model read the steer, and treating it as such made the whole
     * evidential check inert.
     */
    function assistantTokenPartial(id: string): Record<string, unknown> {
      return {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'tok' },
        },
        // Carried so a reader can see which message these belong to; the
        // boundary reader ignores it, because only `message_start` names a new
        // request.
        __ofMessage: id,
      }
    }

    /** The start of a NEW assistant message — the new-request signal. */
    function assistantMessageStart(id: string): Record<string, unknown> {
      return {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id } },
      }
    }

    type PromptMsg = { message: { content: Array<Record<string, unknown>> } }

    /**
     * Consumes the prompt the way the SDK actually does: an EAGER
     * `for await (const m of stream) { await transport.write(m) }`
     * (`Query.streamInput` in
     * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`) that never stops
     * pulling.
     *
     * The eagerness is the point. These tests used to pull one `next()` at a
     * time, on demand, which left pushed messages sitting in the channel's
     * queue exactly when the runtime looked at it — and that is what made a
     * `pendingCount === 0` close guard look alive. Against the real consumer
     * the queue is empty within a microtask of every push, so the guard was
     * dead by construction and covered none of the interleavings below.
     */
    function consumeEagerly(prompt: unknown, delivered: string[]): Promise<void> {
      return (async () => {
        for await (const m of prompt as AsyncIterable<PromptMsg>) {
          delivered.push(String(m.message.content[0].text))
        }
      })()
    }

    /** Yields to the event loop so the eager consumer's pending pull runs. */
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    function resubmitsFrom(events: ChatStreamEvent[]): ChatStreamEvent[] {
      return events.filter((e) => e.kind === 'resubmit_required')
    }

    it('runs the turn on the CALLER-supplied channel, seeding it before query()', async () => {
      // The channel comes in already registered as steerable — that is what
      // closes the window between the CLI taking the turn lock and the turn
      // becoming reachable. A steer accepted before this function was even
      // called must therefore still be delivered, right after the opening
      // message.
      const delivered: string[] = []
      const channel = createTurnInputChannel()
      channel.push('typed while the turn was starting up')

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield RESULT
          await consumed
        })(),
      )

      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'do the thing',
        inputChannel: channel,
        emit: () => {},
      })

      expect(delivered).toEqual(['do the thing', 'typed while the turn was starting up'])
    })

    it('creates its own channel when the caller supplies none', async () => {
      // Direct callers with no steering surface — the edit-fix mini-turn, the
      // live smoke harness — must behave exactly as they did before steering.
      const delivered: string[] = []
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'do the thing',
        emit: (e) => events.push(e),
      })

      expect(delivered).toEqual(['do the thing'])
      expect(resubmitsFrom(events)).toEqual([])
    })

    it('closes the channel on the turn result', async () => {
      const delivered: string[] = []
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield RESULT
          await consumed
        })(),
      )

      const channel = createTurnInputChannel()
      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'do the thing',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      // We own termination — a held-open generator never self-closes.
      expect(channel.closed).toBe(true)
      expect(delivered).toEqual(['do the thing'])
      // No steer was sent, so nothing to resubmit.
      expect(resubmitsFrom(events)).toEqual([])
    })

    it('treats a steer the model answered as delivered — no resubmit asked for', async () => {
      const delivered: string[] = []
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield assistantMessage('msg_1')
          channel.push('also fix the header')
          // The eager reader takes it off our hands immediately...
          await settle()
          // ...and the model then starts a NEW message, which is a new
          // inference request and the only thing that can have carried the
          // steer into its context.
          yield assistantMessage('msg_2')
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'fix the footer',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(delivered).toEqual(['fix the footer', 'also fix the header'])
      expect(resubmitsFrom(events)).toEqual([])
    })

    it('asks for a resubmit when the turn ends with no new message after the steer', async () => {
      // THE uncovered interleaving. The steer was written to the child's stdin
      // — `delivered` proves it left this process — and the model then went
      // straight to `result` without starting another request, so nothing says
      // it was ever folded into the model's context. The old `pendingCount ===
      // 0` guard saw an empty queue here and closed with the message gone and
      // the client told `delivered: true`.
      const delivered: string[] = []
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield assistantMessage('msg_1')
          channel.push('also fix the header')
          await settle()
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1', 'sess-9'),
        userMessage: 'fix the footer',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(delivered).toEqual(['fix the footer', 'also fix the header'])
      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'sess-9',
          userMessage: 'also fix the header',
        },
      ])
    })

    it('asks for a resubmit when only PARTIALS of the in-flight message follow the steer', async () => {
      // Reviewer repro, at the level where the defect lived. The runtime sets
      // `includePartialMessages: true`, so each streamed token arrives as its
      // own `stream_event` — and the old check counted every one of them as
      // evidence the model had read the steer. It cannot be: these tokens
      // belong to a message whose request was assembled before the steer
      // existed. The message finishes answering the ORIGINAL task and the turn
      // ends, so this steer reached nobody.
      const delivered: string[] = []
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          yield assistantMessageStart('msg_1')
          yield assistantTokenPartial('msg_1')
          channel.push('stop, check the lockfile instead')
          await settle()
          // msg_1 keeps streaming and finishes the ORIGINAL task. Same message,
          // same request — no evidence at all.
          yield assistantTokenPartial('msg_1')
          yield assistantTokenPartial('msg_1')
          yield assistantMessage('msg_1')
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1', 'sess-9'),
        userMessage: 'run the build and summarise the failures',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      // It DID leave this process — which is exactly why the definitive half
      // alone cannot catch this one.
      expect(delivered).toEqual([
        'run the build and summarise the failures',
        'stop, check the lockfile instead',
      ])
      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'sess-9',
          userMessage: 'stop, check the lockfile instead',
        },
      ])
    })

    it('treats a message_start after the steer as delivery', async () => {
      // The other side of the same rule: a NEW message id is a new inference
      // request, and that is the signal we accept. Without this the fix would
      // be "resubmit everything", which is a different bug.
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          yield assistantMessageStart('msg_1')
          yield assistantTokenPartial('msg_1')
          channel.push('also fix the header')
          await settle()
          yield assistantMessageStart('msg_2')
          yield assistantTokenPartial('msg_2')
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'fix the footer',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(resubmitsFrom(events)).toEqual([])
    })

    it('does not count SUBAGENT output as evidence the main loop read the steer', async () => {
      // A subagent's request is assembled from the subagent's own context,
      // which never contains a steer sent to the main loop. Counting it would
      // report a lost message as delivered.
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          yield assistantMessage('msg_1')
          channel.push('also fix the header')
          await settle()
          yield {
            type: 'assistant',
            parent_tool_use_id: 'toolu_task_01',
            message: { id: 'msg_subagent', content: [{ type: 'text', text: 'sub' }] },
          }
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'fix the footer',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'proj-1',
          userMessage: 'also fix the header',
        },
      ])
    })

    it('carries the images on the resubmit request', async () => {
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          channel.push('match this', [
            { type: 'image', data: 'DDDD', mimeType: 'image/png' },
          ])
          await settle()
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'first',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      // Without the bytes the resubmit silently drops the user's screenshot,
      // which is the same loss one level down.
      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'proj-1',
          userMessage: 'match this',
          images: [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }],
        },
      ])
    })

    it('classifies multiple steers independently within one turn', async () => {
      // Measured finding 4: repeated `streamInput()` calls silently discard
      // everything after the first, so one long-lived channel has to deliver
      // every push — and account for each one separately.
      const delivered: string[] = []
      const channel = createTurnInputChannel()

      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, delivered)
          channel.push('alpha')
          await settle()
          yield assistantMessage('msg_1') // a new request — answers alpha
          channel.push('bravo')
          await settle()
          yield RESULT // ...and never answers bravo
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'first',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(delivered).toEqual(['first', 'alpha', 'bravo'])
      expect(resubmitsFrom(events)).toEqual([
        { kind: 'resubmit_required', sessionId: 'proj-1', userMessage: 'bravo' },
      ])
    })

    it('reports a steer the SDK never pulled out of the channel', async () => {
      // The generator closes at `result` with the message still queued: it
      // never reached the child process at all. Definitive, not evidential.
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce(() =>
        (async function* () {
          channel.push('never read')
          yield RESULT
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'first',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(resubmitsFrom(events)).toEqual([
        { kind: 'resubmit_required', sessionId: 'proj-1', userMessage: 'never read' },
      ])
    })

    it('reports each steer exactly once, even though result AND finally reconcile', async () => {
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          channel.push('alpha')
          await settle()
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'first',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      // Two reconciliation points, one report: the drain is one-shot. Asking
      // the client to resubmit twice would be a duplicate we authored.
      expect(resubmitsFrom(events)).toHaveLength(1)
    })

    it('closes the channel when the query throws, and still reports a pending steer', async () => {
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce(() =>
        (async function* () {
          channel.push('typed just before the crash')
          yield* []
          throw new Error('boom')
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'do the thing',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      // The finally-block backstop: no result ever arrived, and the message the
      // user typed must not go down with the turn.
      expect(channel.closed).toBe(true)
      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'proj-1',
          userMessage: 'typed just before the crash',
        },
      ])
    })

    it('closes the channel when the turn is aborted, and still reports a pending steer', async () => {
      const controller = new AbortController()
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce(() =>
        (async function* () {
          channel.push('typed just before Stop')
          controller.abort()
          yield* []
          throw new Error('aborted')
        })(),
      )

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'do the thing',
        signal: controller.signal,
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(channel.closed).toBe(true)
      // The user stopped the agent; they did not un-type the message.
      expect(resubmitsFrom(events)).toEqual([
        {
          kind: 'resubmit_required',
          sessionId: 'proj-1',
          userMessage: 'typed just before Stop',
        },
      ])
    })

    it('persists every accepted steer on the turn, positioned in the reply', async () => {
      // Delivery is only half the guarantee. `turn.userMessage` is the OPENING
      // prompt, so without this the transcript keeps the model's answer to a
      // steered message and loses the message — the user's own words missing
      // from their own history on the next re-hydrate.
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          yield assistantMessage('msg_1') // assistantContent[0]
          channel.push('also fix the header')
          await settle()
          yield assistantMessage('msg_2') // assistantContent[1]
          channel.push('match this', [
            { type: 'image', data: 'DDDD', mimeType: 'image/png' },
          ])
          await settle()
          yield assistantMessage('msg_3') // assistantContent[2]
          yield RESULT
          await consumed
        })(),
      )

      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'fix the footer',
        inputChannel: channel,
        emit: () => {},
      })

      expect(result.turn.userMessage).toBe('fix the footer')
      expect(result.turn.steers).toEqual([
        { text: 'also fix the header', afterAssistantBlocks: 1 },
        { text: 'match this', hadImages: true, afterAssistantBlocks: 2 },
      ])
      // Only the FACT of images, never the bytes — same rule as the turn's own
      // opening images, for the same reason (session JSON stays small).
      expect(JSON.stringify(result.turn)).not.toContain('DDDD')
    })

    it('persists a steer the reconciliation asked the client to resubmit', async () => {
      // Repeat over drop, in the persistence dimension: a resubmit re-sends it
      // as a fresh turn, so the message can show up twice. Leaving it out here
      // instead would lose it outright whenever the resubmit never happens (a
      // disconnected client, a closed tab).
      const channel = createTurnInputChannel()
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          channel.push('never answered')
          await settle()
          yield RESULT
          await consumed
        })(),
      )

      const events: ChatStreamEvent[] = []
      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'first',
        inputChannel: channel,
        emit: (e) => events.push(e),
      })

      expect(resubmitsFrom(events)).toHaveLength(1)
      expect(result.turn.steers).toEqual([
        { text: 'never answered', afterAssistantBlocks: 0 },
      ])
    })

    it('omits `steers` entirely from a turn that received none', async () => {
      queryMock.mockImplementationOnce((args) =>
        (async function* () {
          const consumed = consumeEagerly(args.prompt, [])
          yield assistantMessage('msg_1')
          yield RESULT
          await consumed
        })(),
      )

      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'fix the footer',
        emit: () => {},
      })

      // Not `[]` — an unsteered turn must serialize exactly as it did before
      // the field existed, so old and new files stay indistinguishable.
      expect(result.turn.steers).toBeUndefined()
      expect(JSON.stringify(result.turn)).not.toContain('steers')
    })
  })

  describe('Phase 4a — fileReads + conflict wiring', () => {
    it('records a read through the registered Read tool on the persisted session', async () => {
      // Was: "wires a PreToolUse hook on Read". The SDK's Read is off; Desde's
      // own Read records the snapshot itself, through `onFileRead`.
      const fs = await import('node:fs')
      fs.mkdirSync(join(root, 'src'), { recursive: true })
      fs.writeFileSync(join(root, 'src/Seen.vue'), '<template>seen</template>')

      queryMock.mockImplementationOnce(() =>
        (async function* () {
          const out = await registeredEditorTools().get('Read')!({ file_path: 'src/Seen.vue' })
          expect(out.isError).toBeFalsy()
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: 'end_turn',
          }
        })(),
      )

      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'read it',
        emit: () => {},
      })

      const record = result.session.fileReads?.[join(root, 'src/Seen.vue')]
      expect(record).toBeDefined()
      expect(record!.baseContentPath).not.toBe('')
    })

    it('persists pre-existing session.fileReads forward when the turn ends', async () => {
      // A prior turn captured a read for X.vue. The current turn does
      // nothing — runChatTurnSdk should still round-trip the existing
      // fileReads onto the returned session.
      const session = makeEmptySession('proj-1')
      session.fileReads = {
        '/abs/X.vue': {
          hashAtRead: 'abc123',
          baseContentPath: '/sidecar/abc123.txt',
          readAt: '2026-05-23T00:00:00.000Z',
        },
      }
      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session,
        userMessage: 'noop',
        emit: () => {},
      })

      expect(result.session.fileReads).toEqual(session.fileReads)
    })

    it('leaves fileReads + conflicts undefined when the turn captured neither', async () => {
      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const result = await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'noop',
        emit: () => {},
      })

      expect(result.session.fileReads).toBeUndefined()
      expect(result.session.conflicts).toBeUndefined()
    })

    it('end-to-end: Read, a concurrent change, then Write raises the overwrite warning (codex #7)', async () => {
      // Was driven through the Read hook and `canUseTool`. Both jobs moved
      // into Desde's own tools: Read records the base, and Write detects the
      // stale base against the bytes it replaces.
      const fs = await import('node:fs')
      const file = 'src/Stale.vue'
      const target = join(root, file)
      fs.mkdirSync(join(root, 'src'), { recursive: true })
      fs.writeFileSync(target, 'session-saw-this')

      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'noop',
        emit: (e) => events.push(e),
      })

      const tools = registeredEditorTools()
      // 1. The model reads the file.
      await tools.get('Read')!({ file_path: file })
      // 2. Someone else changes it.
      fs.writeFileSync(target, 'changed by someone else')
      // 3. The model writes it.
      const eventsBeforeWrite = events.length
      const out = await tools.get('Write')!({ file_path: file, content: "this session's patch" })
      expect(out.isError).toBeFalsy()

      const newEvents = events.slice(eventsBeforeWrite)
      const warningIdx = newEvents.findIndex((e) => e.kind === 'edit_overwrite_warning')
      const proposalIdx = newEvents.findIndex((e) => e.kind === 'edit_proposed')
      expect(warningIdx).toBeGreaterThanOrEqual(0)
      expect(proposalIdx).toBeGreaterThanOrEqual(0)
      // The order is now proposal THEN warning, as on the neutral lane: the
      // tool reports the conflict against the bytes it replaced, which it only
      // knows once `brokeredWrite` (which emits the proposal) has run. It used
      // to be the reverse, because the gate detected it before the SDK wrote.
      // The client keys the banner by file, not by position.
      expect(proposalIdx).toBeLessThan(warningIdx)
      expect(newEvents[warningIdx]).toMatchObject({ kind: 'edit_overwrite_warning', file })
      expect(fs.readFileSync(target, 'utf8')).toBe("this session's patch")
    })

    it('persists proposed newSource to .desde/.../proposals/<editId>.txt on Write (Phase 4 §4)', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { proposalBlobPath } = await import('../agent-chat/proposal-blob-store')
      const target = path.join(root, 'src', 'Target.vue')
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(target, '<template>before</template>')

      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const events: ChatStreamEvent[] = []
      const session = makeEmptySession('proj-1', 'sess-blob')
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session,
        userMessage: 'overwrite the file',
        emit: (e) => events.push(e),
      })

      const out = await registeredEditorTools().get('Write')!({
        file_path: 'src/Target.vue',
        content: '<template>after</template>',
      })
      expect(out.isError).toBeFalsy()

      const proposals = events.filter((e) => e.kind === 'edit_proposed') as Array<
        ChatStreamEvent & { editId: string }
      >
      // Exactly one diff card per write: the gate no longer emits its own.
      expect(proposals).toHaveLength(1)
      const blobPath = proposalBlobPath(root, 'sess-blob', proposals[0]!.editId)
      expect(fs.existsSync(blobPath)).toBe(true)
      expect(fs.readFileSync(blobPath, 'utf8')).toBe('<template>after</template>')
    })

    it('canUseTool decides mcp__editor__Write but never emits a proposal itself', async () => {
      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'gate',
        emit: (e) => events.push(e),
      })

      const opts = queryMock.mock.calls[0]?.[0]?.options as {
        canUseTool?: (
          name: string,
          input: Record<string, unknown>,
          ctx: { signal: AbortSignal; toolUseID: string },
        ) => Promise<{ behavior: string }>
      }
      const ctx = { signal: new AbortController().signal, toolUseID: 'tu-gate' }
      const allowed = await opts.canUseTool!(
        'mcp__editor__Write',
        { file_path: 'src/New.vue', content: '<template/>' },
        ctx,
      )
      expect(allowed.behavior).toBe('allow')
      const protectedWrite = await opts.canUseTool!(
        'mcp__editor__Write',
        { file_path: '.mcp.json', content: '{}' },
        ctx,
      )
      expect(protectedWrite.behavior).toBe('deny')
      expect(events.some((e) => e.kind === 'edit_proposed')).toBe(false)
    })

    it('does NOT persist a blob on edits that get denied (no edit_proposed event fired)', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const target = path.join(root, '/etc/passwd')

      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1', 'sess-deny'),
        userMessage: 'try a denied path',
        emit: (e) => events.push(e),
      })

      const opts = queryMock.mock.calls[0]?.[0]?.options as {
        canUseTool?: (
          name: string,
          input: Record<string, unknown>,
          ctx: { signal: AbortSignal; toolUseID: string },
        ) => Promise<{ behavior: string }>
      }
      // Path-traversal — resolveRepoPath will deny. The namespaced name is
      // the one the SDK sends now that its own Write is off.
      const r = await opts.canUseTool!(
        'mcp__editor__Write',
        { file_path: target, content: 'forbidden' },
        { signal: new AbortController().signal, toolUseID: 'tu-deny' },
      )
      expect(r.behavior).toBe('deny')
      // No proposal fired → no blob to write.
      const proposalsDir = path.join(
        root,
        '.desde',
        'chat-sessions',
        'sess-deny',
        'proposals',
      )
      expect(fs.existsSync(proposalsDir)).toBe(false)
      expect(events.some((e) => e.kind === 'edit_proposed')).toBe(false)
    })

    it("counts a PRIOR turn's read as the base for this turn's write", async () => {
      // Was: "passes a getFileReads accessor to canUseTool". The accessor now
      // goes to the write tools, which do the conflict check themselves.
      const fs = await import('node:fs')
      fs.mkdirSync(join(root, 'src'), { recursive: true })
      const target = join(root, 'src/X.vue')
      fs.writeFileSync(target, 'changed since that read')

      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const session = makeEmptySession('proj-1')
      session.fileReads = {
        [target]: {
          hashAtRead: 'seedhash',
          baseContentPath: '',
          readAt: '2026-05-23T00:00:00.000Z',
        },
      }
      const events: ChatStreamEvent[] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session,
        userMessage: 'noop',
        emit: (e) => events.push(e),
      })

      await registeredEditorTools().get('Write')!({ file_path: 'src/X.vue', content: 'mine' })
      expect(events.some((e) => e.kind === 'edit_overwrite_warning')).toBe(true)
    })
  })

  describe('Write safety on the sidecar (was: Task 13 write-guard wiring)', () => {
    // The Task 13 guard bracketed the SDK's OWN Write/Edit with a PreToolUse
    // journal + file lock and a PostToolUse release. Those built-ins are off.
    // Desde's own Write goes through `brokeredWrite`, which journals and
    // locks inside the tool, so there is no hold to leak across a crash.
    it('journals the original before a Write through the registered tool', async () => {
      const fs = await import('node:fs')
      const target = join(root, 'App.vue')
      fs.writeFileSync(target, 'ORIGINAL')

      scriptedMessages.push({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
      })

      const invalidated: string[][] = []
      await runChatTurnSdk({
        bridge: makeBridge(),
        worktreeRoot: root,
        session: makeEmptySession('proj-1'),
        userMessage: 'noop',
        emit: () => {},
        invalidateFiles: (files) => invalidated.push(files),
      })

      const out = await registeredEditorTools().get('Write')!({ file_path: 'App.vue', content: 'NEXT' })
      expect(out.isError).toBeFalsy()
      expect(fs.readFileSync(target, 'utf8')).toBe('NEXT')
      const backupsRoot = join(root, '.desde', 'backups')
      const dirs = fs.readdirSync(backupsRoot)
      expect(dirs).toHaveLength(1)
      expect(fs.readFileSync(join(backupsRoot, dirs[0]!, 'App.vue'), 'utf8')).toBe('ORIGINAL')
      // The dev server is told, which the write-invalidate hook used to do.
      expect(invalidated.flat()).toContain('App.vue')
    })
  })
})

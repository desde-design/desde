import { describe, expect, it } from 'vitest'

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

import type { RunChatTurn, RunChatTurnOpts, RunChatTurnResult } from './run-chat-turn'
import { makeEmptySession } from './types'
import type {
  RunChatTurnSdkOpts,
  RunChatTurnSdkResult,
} from '../agent-chat-sdk/run-chat-turn-sdk'
import { runChatTurnSdk } from '../agent-chat-sdk/run-chat-turn-sdk'

/**
 * The contract is a TYPE, so the assertions are type-level. They compile or
 * they do not; the runtime body is a formality that keeps vitest happy.
 *
 * The point of the aliases is that no call site in the repo had to change.
 * If someone re-types `RunChatTurnSdkOpts` as its own interface later, these
 * two `Exact` checks go red rather than the two shapes drifting silently.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

let repoRoot: string
beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'run-chat-turn-')))
})
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

describe('RunChatTurn contract', () => {
  it('the SDK runtime satisfies the shared function type', () => {
    const asContract: RunChatTurn = runChatTurnSdk
    expect(typeof asContract).toBe('function')
  })

  it('the SDK aliases are the shared types, not copies', () => {
    const optsAlias: Exact<RunChatTurnSdkOpts, RunChatTurnOpts> = true
    const resultAlias: Exact<RunChatTurnSdkResult, RunChatTurnResult> = true
    expect(optsAlias && resultAlias).toBe(true)
  })

  it('accepts the provider id the dispatch resolved, and ignores it on the SDK lane', async () => {
    // Behavioural, not a shape assertion: the SDK runtime must TOLERATE the
    // field rather than merely typecheck against it, because the route passes
    // it on every turn once Task 114 lands and an unexpected key reaching
    // `query()` would be a runtime failure on the lane this part must not
    // change. The turn is refused before any model call by the cost ceiling,
    // which is the cheapest path through the runtime that still exercises
    // opts handling end to end.
    const session = makeEmptySession('p1')
    const result = await runChatTurnSdk({
      bridge: { send: async () => null },
      worktreeRoot: repoRoot,
      session: {
        ...session,
        turns: [
          {
            id: 't0',
            startedAt: '2026-09-03T00:00:00.000Z',
            userMessage: 'x',
            assistantContent: [],
            toolResults: {},
            editProposals: [],
            costUsd: 5,
          },
        ],
      },
      userMessage: 'hi',
      providerId: 'anthropic',
      costCeilingUsd: 1,
      emit: () => {},
    } as never)
    expect(result.turn.error).toMatch(/cost ceiling reached/)
  })
})

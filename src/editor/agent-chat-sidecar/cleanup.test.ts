import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deleteSessionMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: deleteSessionMock,
}))

import { cleanupSdkSession } from './cleanup'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'editor-cleanup-test-'))
  deleteSessionMock.mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeChatSessionFile(opts: {
  projectId: string
  sdkSessionId?: string
}): void {
  const dir = join(root, '.desde', 'chat-sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${opts.projectId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      id: { projectId: opts.projectId },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      turns: [],
      orchestrator: 'sdk',
      ...(opts.sdkSessionId ? { sdkSessionId: opts.sdkSessionId } : {}),
    }),
  )
}

import { projectIdForRepoRoot } from '../agent-chat/session-store'

describe('cleanupSdkSession', () => {
  it('calls deleteSession with the recorded sdkSessionId', async () => {
    const projectId = projectIdForRepoRoot(root)
    writeChatSessionFile({ projectId, sdkSessionId: 'sdk-123' })

    await cleanupSdkSession(root)

    expect(deleteSessionMock).toHaveBeenCalledOnce()
    expect(deleteSessionMock).toHaveBeenCalledWith('sdk-123', { dir: root })
  })

  it('no-ops when the session has no sdkSessionId (legacy session)', async () => {
    const projectId = projectIdForRepoRoot(root)
    writeChatSessionFile({ projectId })

    await cleanupSdkSession(root)

    expect(deleteSessionMock).not.toHaveBeenCalled()
  })

  it('no-ops when no chat-session file exists at all', async () => {
    await cleanupSdkSession(root)
    expect(deleteSessionMock).not.toHaveBeenCalled()
  })

  it('swallows deleteSession failures (best-effort cleanup)', async () => {
    deleteSessionMock.mockRejectedValueOnce(new Error('SDK JSONL missing'))
    const projectId = projectIdForRepoRoot(root)
    writeChatSessionFile({ projectId, sdkSessionId: 'sdk-456' })

    // Must not throw — discard must succeed even if cleanup fails.
    await expect(cleanupSdkSession(root)).resolves.toBeUndefined()
  })
})

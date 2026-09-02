import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeProposalBlob } from '../agent-chat-sdk/proposal-blob-store'
import { resolveSessionConflict } from './resolve-conflict'
import { loadSession, projectIdForRepoRoot, saveSession } from './session-store'
import { makeEmptySession, type ChatSession } from './types'

let root: string

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function makeSessionWithConflict(args: {
  sessionId: string
  fileAbs: string
  fileRel: string
  hashAtRead: string
  hashAtWrite: string
  proposalEditId: string
}): ChatSession {
  const projectId = projectIdForRepoRoot(root)
  const session = makeEmptySession(projectId, args.sessionId)
  session.turns.push({
    id: 't-1',
    startedAt: '2026-05-25T00:00:00Z',
    completedAt: '2026-05-25T00:00:01Z',
    userMessage: 'change the file',
    assistantContent: [],
    toolResults: {},
    editProposals: [
      {
        editId: args.proposalEditId,
        kind: 'overwrite',
        files: [args.fileRel],
        proposedAt: '2026-05-25T00:00:00Z',
      },
    ],
  })
  session.conflicts = {
    [args.fileAbs]: {
      detectedAt: '2026-05-25T00:00:02Z',
      hashAtRead: args.hashAtRead,
      hashAtWrite: args.hashAtWrite,
    },
  }
  return session
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolve-conflict-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSessionConflict — use mine', () => {
  it('writes the loser-session blob to disk and clears the conflict', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    const myContent = '<template>mine</template>'
    await writeProposalBlob(root, 'sess-1', 'edit-1', myContent)
    const session = makeSessionWithConflict({
      sessionId: 'sess-1',
      fileAbs: targetAbs,
      fileRel: 'src/Button.vue',
      hashAtRead: sha256('original'),
      hashAtWrite: sha256('<template>winner</template>'),
      proposalEditId: 'edit-1',
    })
    await saveSession(root, session)

    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(true)
    expect(readFileSync(targetAbs, 'utf8')).toBe(myContent)
    if (res.ok) {
      expect(res.finalHash).toBe(sha256(myContent))
    }
    // Conflict cleared on the persisted record.
    const reloaded = await loadSession(root, { sessionId: 'sess-1' })
    expect(reloaded.session.conflicts).toBeUndefined()
  })

  it('accepts an absolute file path argument', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    await writeProposalBlob(root, 'sess-1', 'edit-1', 'mine')
    const session = makeSessionWithConflict({
      sessionId: 'sess-1',
      fileAbs: targetAbs,
      fileRel: 'src/Button.vue',
      hashAtRead: 'h1',
      hashAtWrite: 'h2',
      proposalEditId: 'edit-1',
    })
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: targetAbs,
      resolution: 'mine',
    })
    expect(res.ok).toBe(true)
    expect(readFileSync(targetAbs, 'utf8')).toBe('mine')
  })

  it('fails 409 when no proposal blob is recorded for the file', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    // No writeProposalBlob — the blob is missing.
    const session = makeSessionWithConflict({
      sessionId: 'sess-1',
      fileAbs: targetAbs,
      fileRel: 'src/Button.vue',
      hashAtRead: 'h1',
      hashAtWrite: 'h2',
      proposalEditId: 'edit-1',
    })
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(409)
      expect(res.reason).toMatch(/proposal blob.*missing/i)
    }
    // Disk + session unchanged.
    expect(readFileSync(targetAbs, 'utf8')).toBe('<template>winner</template>')
  })

  it('fails 409 when the session has no editProposal touching the file', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    // Plant a conflict but NO editProposal referencing the file.
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-1')
    session.conflicts = {
      [targetAbs]: { detectedAt: 'x', hashAtRead: 'h1', hashAtWrite: 'h2' },
    }
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(409)
      expect(res.reason).toMatch(/no proposal blob is recorded/i)
    }
  })

  it('picks the LATEST proposal blob when the session wrote the file multiple times', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    await writeProposalBlob(root, 'sess-1', 'edit-old', 'first attempt')
    await writeProposalBlob(root, 'sess-1', 'edit-new', 'final attempt')
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-1')
    session.turns.push(
      {
        id: 't-1',
        startedAt: 'x',
        userMessage: 'first attempt',
        assistantContent: [],
        toolResults: {},
        editProposals: [
          { editId: 'edit-old', kind: 'overwrite', files: ['src/Button.vue'], proposedAt: 'x' },
        ],
      },
      {
        id: 't-2',
        startedAt: 'y',
        userMessage: 'second attempt',
        assistantContent: [],
        toolResults: {},
        editProposals: [
          { editId: 'edit-new', kind: 'overwrite', files: ['src/Button.vue'], proposedAt: 'y' },
        ],
      },
    )
    session.conflicts = {
      [targetAbs]: { detectedAt: 'z', hashAtRead: 'h1', hashAtWrite: 'h2' },
    }
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(true)
    // LATEST proposal wins.
    expect(readFileSync(targetAbs, 'utf8')).toBe('final attempt')
  })
})

describe('resolveSessionConflict — use theirs', () => {
  it('does NOT touch disk and just clears the conflict from the session', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    await writeProposalBlob(root, 'sess-1', 'edit-1', 'mine — should not land')
    const session = makeSessionWithConflict({
      sessionId: 'sess-1',
      fileAbs: targetAbs,
      fileRel: 'src/Button.vue',
      hashAtRead: 'h1',
      hashAtWrite: sha256('<template>winner</template>'),
      proposalEditId: 'edit-1',
    })
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'theirs',
    })
    expect(res.ok).toBe(true)
    expect(readFileSync(targetAbs, 'utf8')).toBe('<template>winner</template>')
    if (res.ok) {
      expect(res.finalHash).toBe(sha256('<template>winner</template>'))
    }
    const reloaded = await loadSession(root, { sessionId: 'sess-1' })
    expect(reloaded.session.conflicts).toBeUndefined()
  })

  it('clears the conflict even when no blob exists (theirs is the safe default)', async () => {
    const targetAbs = join(root, 'src', 'Button.vue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(targetAbs, '<template>winner</template>')
    // No blob written this time.
    const session = makeSessionWithConflict({
      sessionId: 'sess-1',
      fileAbs: targetAbs,
      fileRel: 'src/Button.vue',
      hashAtRead: 'h1',
      hashAtWrite: 'h2',
      proposalEditId: 'edit-1',
    })
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Button.vue',
      resolution: 'theirs',
    })
    expect(res.ok).toBe(true)
  })
})

describe('resolveSessionConflict — merge', () => {
  async function plantBase(
    sessionId: string,
    hashAtRead: string,
    content: string,
  ): Promise<void> {
    const path = join(
      root,
      '.desde',
      'chat-sessions',
      sessionId,
      'bases',
      `${hashAtRead}.txt`,
    )
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }

  it('cleanly merges non-overlapping edits and writes the combined content to disk', async () => {
    const targetAbs = join(root, 'Button.vue')
    const baseContent = 'line1\nline2\nline3\nline4\nline5\n'
    const theirsContent = 'line1\nline2\nline3\nline4-THEIRS\nline5\n'
    const mineContent = 'line1\nline2-MINE\nline3\nline4\nline5\n'
    writeFileSync(targetAbs, theirsContent)
    const baseHash = sha256(baseContent)
    await plantBase('sess-merge-1', baseHash, baseContent)
    await writeProposalBlob(root, 'sess-merge-1', 'edit-mine', mineContent)
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-merge-1')
    session.turns.push({
      id: 't-1',
      startedAt: 'x',
      userMessage: 'tweak line 2',
      assistantContent: [],
      toolResults: {},
      editProposals: [
        {
          editId: 'edit-mine',
          kind: 'overwrite',
          files: ['Button.vue'],
          proposedAt: 'x',
        },
      ],
    })
    session.conflicts = {
      [targetAbs]: {
        detectedAt: 'x',
        hashAtRead: baseHash,
        hashAtWrite: sha256(theirsContent),
      },
    }
    await saveSession(root, session)

    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'Button.vue',
      resolution: 'merge',
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mergeClean).toBe(true)
    const disk = readFileSync(targetAbs, 'utf8')
    expect(disk).toBe('line1\nline2-MINE\nline3\nline4-THEIRS\nline5\n')
    // Conflict cleared.
    const reloaded = await loadSession(root, { sessionId: 'sess-merge-1' })
    expect(reloaded.session.conflicts).toBeUndefined()
  })

  it('returns conflict-marker content WITHOUT writing to disk when merge can\'t auto-resolve', async () => {
    const targetAbs = join(root, 'Button.vue')
    const baseContent = 'line1\nSHARED\nline3\n'
    const theirsContent = 'line1\nTHEIRS-VERSION\nline3\n'
    const mineContent = 'line1\nMINE-VERSION\nline3\n'
    writeFileSync(targetAbs, theirsContent)
    const baseHash = sha256(baseContent)
    await plantBase('sess-merge-conflict', baseHash, baseContent)
    await writeProposalBlob(root, 'sess-merge-conflict', 'edit-mine', mineContent)
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-merge-conflict')
    session.turns.push({
      id: 't-1',
      startedAt: 'x',
      userMessage: 'x',
      assistantContent: [],
      toolResults: {},
      editProposals: [
        { editId: 'edit-mine', kind: 'overwrite', files: ['Button.vue'], proposedAt: 'x' },
      ],
    })
    session.conflicts = {
      [targetAbs]: {
        detectedAt: 'x',
        hashAtRead: baseHash,
        hashAtWrite: sha256(theirsContent),
      },
    }
    await saveSession(root, session)

    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'Button.vue',
      resolution: 'merge',
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.mergeClean).toBe(false)
      expect(res.mergeContent).toBeDefined()
      expect(res.mergeContent).toMatch(/<{7} sess-merge-conflict/)
      expect(res.mergeContent).toMatch(/>{7} on disk/)
    }
    // Disk content untouched — the resolver pane will write the
    // user's final picked content via apply-merge-resolution.
    expect(readFileSync(targetAbs, 'utf8')).toBe(theirsContent)
    // Conflict NOT cleared — still pending user resolution.
    const reloaded = await loadSession(root, { sessionId: 'sess-merge-conflict' })
    expect(reloaded.session.conflicts).toBeDefined()
  })

  it('fails 409 when the base snapshot for hashAtRead is missing on disk', async () => {
    const targetAbs = join(root, 'Button.vue')
    writeFileSync(targetAbs, 'theirs-content')
    await writeProposalBlob(root, 'sess-no-base', 'edit-mine', 'mine')
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-no-base')
    session.turns.push({
      id: 't-1',
      startedAt: 'x',
      userMessage: 'x',
      assistantContent: [],
      toolResults: {},
      editProposals: [
        { editId: 'edit-mine', kind: 'overwrite', files: ['Button.vue'], proposedAt: 'x' },
      ],
    })
    session.conflicts = {
      [targetAbs]: {
        detectedAt: 'x',
        hashAtRead: 'nonexistent-base-hash',
        hashAtWrite: 'h-theirs',
      },
    }
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'Button.vue',
      resolution: 'merge',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(409)
      expect(res.reason).toMatch(/base snapshot/i)
    }
  })

  it('fails 409 when no proposal blob is recorded for the file', async () => {
    const targetAbs = join(root, 'Button.vue')
    writeFileSync(targetAbs, 'theirs')
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-no-blob')
    session.conflicts = {
      [targetAbs]: { detectedAt: 'x', hashAtRead: 'h1', hashAtWrite: 'h2' },
    }
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'Button.vue',
      resolution: 'merge',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
  })
})

describe('resolveSessionConflict — error paths', () => {
  it('returns 404 when no conflict is recorded for the file', async () => {
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-1')
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/Untouched.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it('preserves remaining conflicts when one is resolved', async () => {
    const fileA = join(root, 'A.vue')
    const fileB = join(root, 'B.vue')
    writeFileSync(fileA, 'a-content')
    writeFileSync(fileB, 'b-content')
    await writeProposalBlob(root, 'sess-1', 'e-a', 'mine-a')
    const projectId = projectIdForRepoRoot(root)
    const session = makeEmptySession(projectId, 'sess-1')
    session.turns.push({
      id: 't-1',
      startedAt: 'x',
      userMessage: 'tweak A',
      assistantContent: [],
      toolResults: {},
      editProposals: [
        { editId: 'e-a', kind: 'overwrite', files: ['A.vue'], proposedAt: 'x' },
      ],
    })
    session.conflicts = {
      [fileA]: { detectedAt: 'x', hashAtRead: 'h1', hashAtWrite: 'h2' },
      [fileB]: { detectedAt: 'x', hashAtRead: 'h3', hashAtWrite: 'h4' },
    }
    await saveSession(root, session)
    const res = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'A.vue',
      resolution: 'mine',
    })
    expect(res.ok).toBe(true)
    const reloaded = await loadSession(root, { sessionId: 'sess-1' })
    expect(reloaded.session.conflicts).toBeDefined()
    expect(Object.keys(reloaded.session.conflicts ?? {})).toEqual([fileB])
  })
})

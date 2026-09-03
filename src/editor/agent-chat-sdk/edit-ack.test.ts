import { createHash } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditProposalPayload } from '../agent-tools/types'
import type { ReadRoot, ReadRootRegistry } from '../core/read-roots'
import {
  ALLOWED_COMPONENT_EXTENSIONS,
  ALLOWED_NEW_FILE_EXTENSIONS,
  buildCanUseTool,
  toRel,
  type OverwriteConflictDetected,
} from './edit-ack'

function makeRegistry(roots: ReadRoot[]): ReadRootRegistry {
  return {
    roots,
    resolve: (name) => roots.find((r) => r.name === name),
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

interface Harness {
  root: string
  emitted: EditProposalPayload[]
  emit: (p: EditProposalPayload) => Promise<{ ok: true; editId: string }>
  cleanup: () => void
}

function makeHarness(): Harness {
  // realpathSync canonicalizes /var/... → /private/var/... on macOS so
  // the SDK-supplied absolute paths the tests construct stay
  // containment-equivalent to the worktree root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-')))
  const emitted: EditProposalPayload[] = []
  const emit = vi.fn(async (p: EditProposalPayload) => {
    emitted.push(p)
    return { ok: true as const, editId: 'edit-id' }
  })
  return {
    root,
    emitted,
    emit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('canUseTool — non-Write/Edit tools', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  it('allows Read for an in-root path', async () => {
    writeFileSync(join(h.root, 'app.vue'), 'x')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Read', { file_path: join(h.root, 'app.vue') }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(h.emitted).toHaveLength(0)
  })

  it('denies Read for a path that escapes the worktree', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Read', { file_path: '/etc/passwd' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/Read denied/)
  })

  it('hints at the worktree-relative form when Read escapes without matching an external root', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Read', { file_path: '/etc/passwd' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    const msg = (r as { message: string }).message
    expect(msg).toMatch(/worktree-relative path/)
    expect(msg).toMatch(/list_read_roots/)
  })

  it('points the model at read_file_at_commit when the denied path lives under an external read root', async () => {
    // Stage an external root with a real file the test can resolve.
    // Use realpathSync so the canonicalization in the deny logic
    // matches what we declared.
    const externalDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-external-')))
    try {
      const externalFile = join(externalDir, 'src/views/Foo.vue')
      mkdirSync(dirname(externalFile), { recursive: true })
      writeFileSync(externalFile, '<template/>')
      const registry = makeRegistry([
        { name: 'worktree', path: h.root, isWorktree: true, isGit: true, gitPrefix: '' },
        {
          name: 'production',
          path: externalDir,
          description: 'Production source mirror',
          isWorktree: false, isGit: true, gitPrefix: '',
        },
      ])
      const cut = buildCanUseTool({
        worktreeRoot: h.root,
        emitEditProposal: h.emit,
        readRoots: registry,
      })
      const r = await call(cut, 'Read', { file_path: externalFile }, fakeOpts())
      expect(r.behavior).toBe('deny')
      const msg = (r as { message: string }).message
      // The hint must name the matching root AND the right MCP tool
      // so the agent can self-correct in the same turn.
      expect(msg).toContain('mcp__editor__read_file_at_commit')
      expect(msg).toContain('root="production"')
      expect(msg).toContain('path="src/views/Foo.vue"')
      expect(msg).toContain('sha="HEAD"')
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  it('falls back to the generic hint when readRoots is undefined', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Read', { file_path: '/some/external/path' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    const msg = (r as { message: string }).message
    // Without a registry, every escape gets the worktree-relative
    // recommendation — no MCP-tool hint to give.
    expect(msg).not.toContain('mcp__editor__read_file_at_commit')
    expect(msg).toMatch(/worktree-relative path/)
  })

  it('emits the MCP hint when a worktree-local symlink escapes into an external root', async () => {
    // The likely model behavior is `Read("prod-link/src/Foo.vue")`
    // where `prod-link` is a symlink the user created inside the
    // worktree pointing at the production checkout. Before the fix,
    // the relative-path early return in findMatchingExternalRoot
    // missed this and dumped the generic message.
    const externalDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-symext-')))
    try {
      const externalFile = join(externalDir, 'src/views/Bar.vue')
      mkdirSync(dirname(externalFile), { recursive: true })
      writeFileSync(externalFile, '<template/>')
      symlinkSync(externalDir, join(h.root, 'prod-link'))
      const registry = makeRegistry([
        { name: 'worktree', path: h.root, isWorktree: true, isGit: true, gitPrefix: '' },
        {
          name: 'production',
          path: externalDir,
          description: 'Production source mirror',
          isWorktree: false, isGit: true, gitPrefix: '',
        },
      ])
      const cut = buildCanUseTool({
        worktreeRoot: h.root,
        emitEditProposal: h.emit,
        readRoots: registry,
      })
      const r = await call(cut, 
        'Read',
        { file_path: 'prod-link/src/views/Bar.vue' },
        fakeOpts(),
      )
      expect(r.behavior).toBe('deny')
      const msg = (r as { message: string }).message
      expect(msg).toContain('mcp__editor__read_file_at_commit')
      expect(msg).toContain('root="production"')
      expect(msg).toContain('path="src/views/Bar.vue"')
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  it('picks the deepest external root when one nests inside another', async () => {
    // Nested roots: /prod and /prod/packages/ui. A file under
    // /prod/packages/ui should be suggested under the inner root with
    // the SHORT path, not the outer root with the long one — that
    // gets the agent to the right repo for nested submodule layouts.
    const outerDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-nested-')))
    try {
      const innerDir = join(outerDir, 'packages/ui')
      const targetFile = join(innerDir, 'src/Button.vue')
      mkdirSync(dirname(targetFile), { recursive: true })
      writeFileSync(targetFile, '<template/>')
      const registry = makeRegistry([
        { name: 'worktree', path: h.root, isWorktree: true, isGit: true, gitPrefix: '' },
        { name: 'prod', path: outerDir, isWorktree: false, isGit: true, gitPrefix: '' },
        { name: 'ui', path: innerDir, isWorktree: false, isGit: true, gitPrefix: '' },
      ])
      const cut = buildCanUseTool({
        worktreeRoot: h.root,
        emitEditProposal: h.emit,
        readRoots: registry,
      })
      const r = await call(cut, 'Read', { file_path: targetFile }, fakeOpts())
      expect(r.behavior).toBe('deny')
      const msg = (r as { message: string }).message
      expect(msg).toContain('root="ui"')
      expect(msg).toContain('path="src/Button.vue"')
      expect(msg).not.toContain('root="prod"')
    } finally {
      rmSync(outerDir, { recursive: true, force: true })
    }
  })

  it('steers the agent at list_commits when the denied path is the root directory itself', async () => {
    // Before the fix this produced `path="(root itself)"` which is
    // not a valid read_file_at_commit input — the agent would retry
    // with garbage and get another error.
    const externalDir = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-rootdir-')))
    try {
      const registry = makeRegistry([
        { name: 'worktree', path: h.root, isWorktree: true, isGit: true, gitPrefix: '' },
        { name: 'production', path: externalDir, isWorktree: false, isGit: true, gitPrefix: '' },
      ])
      const cut = buildCanUseTool({
        worktreeRoot: h.root,
        emitEditProposal: h.emit,
        readRoots: registry,
      })
      const r = await call(cut, 'Read', { file_path: externalDir }, fakeOpts())
      expect(r.behavior).toBe('deny')
      const msg = (r as { message: string }).message
      // The hint must NOT include a bogus retry path. It should point
      // the agent at a tool that actually accepts a directory-level
      // operation (list_commits) instead.
      expect(msg).not.toContain('(root itself)')
      expect(msg).toContain('mcp__editor__list_commits')
      expect(msg).toContain('root="production"')
    } finally {
      rmSync(externalDir, { recursive: true, force: true })
    }
  })

  it('allows Read with no file_path (Read shape variant)', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Read', {}, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  it('allows MCP tools without emitting', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'mcp__editor__get_selection', {}, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(h.emitted).toHaveLength(0)
  })

  it('denies when SDK passes blockedPath (B2)', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Read',
      { file_path: '/some/path' },
      { ...fakeOpts(), blockedPath: '/some/path' },
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/out of bounds/)
  })
})

describe('canUseTool — Write', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  it('allows write to existing file and emits with baseHash + appliedByAgent', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: 'new contents' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(h.emitted).toHaveLength(1)
    const payload = asOverwrite(h.emitted[0])
    expect(payload).toMatchObject({
      type: 'overwrite',
      file,
      newSource: 'new contents',
      baseHash: sha256('old contents'),
      appliedByAgent: true,
    })
    expect(payload.allowCreate).toBeUndefined()
  })

  it('denies no-op Write (NIT2)', async () => {
    const target = join(h.root, 'X.vue')
    writeFileSync(target, 'same')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: 'same' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/no change/)
    expect(h.emitted).toHaveLength(0)
  })

  it('allows new-file write with .vue extension and marks allowCreate + appliedByAgent', async () => {
    const target = join(h.root, 'NewComponent.vue')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: '<template/>' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    const payload = asOverwrite(h.emitted[0])
    expect(payload).toMatchObject({
      type: 'overwrite',
      file: 'NewComponent.vue',
      newSource: '<template/>',
      allowCreate: true,
      appliedByAgent: true,
    })
    expect(payload.baseHash).toBeUndefined()
  })

  it('allows new-file write with .ts extension', async () => {
    const target = join(h.root, 'useThing.ts')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: 'export {}' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(asOverwrite(h.emitted[0]).allowCreate).toBe(true)
  })

  it('allows new-file write with .tsx / .jsx (React) extensions', async () => {
    for (const name of ['Card.tsx', 'Legacy.jsx']) {
      const local = makeHarness()
      const target = join(local.root, name)
      const cut = buildCanUseTool({ worktreeRoot: local.root, emitEditProposal: local.emit })
      const r = await call(cut, 
        'Write',
        { file_path: target, content: 'export const C = () => <div/>' },
        fakeOpts(),
      )
      expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
      const payload = asOverwrite(local.emitted[0])
      expect(payload).toMatchObject({ file: name, allowCreate: true, appliedByAgent: true })
    }
  })

  it('allows new-file write with .md extension (plans / docs)', async () => {
    const target = join(h.root, 'docs/plan.md')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: '# Plan\n' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(asOverwrite(h.emitted[0])).toMatchObject({
      file: 'docs/plan.md',
      allowCreate: true,
      appliedByAgent: true,
    })
  })

  it('denies new-file write with a disallowed extension (binary/script/secret)', async () => {
    const target = join(h.root, 'malware.exe')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: 'x' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/extension '\.exe'/)
    expect(h.emitted).toHaveLength(0)
  })

  it('denies write with missing content', async () => {
    const target = join(h.root, 'X.vue')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target }, fakeOpts())
    expect(r.behavior).toBe('deny')
  })

  it('denies path that escapes worktree root', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: '../escape.vue', content: 'x' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/escapes|denied/)
  })

  it('denies new-file write via a symlinked ancestor (B3)', async () => {
    // Create a symlink dir inside the worktree pointing outside.
    // resolveSafeCreatePath should refuse creation via the link.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-outside-')))
    try {
      symlinkSync(outside, join(h.root, 'sneaky'))
      const target = join(h.root, 'sneaky', 'X.vue')
      const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
      const r = await call(cut, 'Write', { file_path: target, content: '<template/>' }, fakeOpts())
      expect(r.behavior).toBe('deny')
      expect((r as { message: string }).message).toMatch(/symlink|denied/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('canUseTool — Edit', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  it('reconstructs newSource with single replacement and emits baseHash + appliedByAgent', async () => {
    const file = 'X.vue'
    const target = join(h.root, file)
    writeFileSync(target, 'before X after')

    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: target, old_string: 'X', new_string: 'Y' },
      fakeOpts(),
    )
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    const payload = asOverwrite(h.emitted[0])
    expect(payload).toMatchObject({
      type: 'overwrite',
      file,
      newSource: 'before Y after',
      baseHash: sha256('before X after'),
      appliedByAgent: true,
    })
  })

  it('honors replace_all', async () => {
    const file = 'X.vue'
    writeFileSync(join(h.root, file), 'X X X')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, file), old_string: 'X', new_string: 'Y', replace_all: true },
      fakeOpts(),
    )
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(asOverwrite(h.emitted[0]).newSource).toBe('Y Y Y')
  })

  it('denies when old_string not found', async () => {
    const file = 'X.vue'
    writeFileSync(join(h.root, file), 'abc')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, file), old_string: 'XYZ', new_string: 'Y' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/not found/)
  })

  it('denies when old_string is not unique without replace_all', async () => {
    const file = 'X.vue'
    writeFileSync(join(h.root, file), 'X X')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, file), old_string: 'X', new_string: 'Y' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/not unique/)
  })

  it('denies empty old_string', async () => {
    const file = 'X.vue'
    writeFileSync(join(h.root, file), 'abc')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, file), old_string: '', new_string: 'Y' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/non-empty/)
  })

  it('denies edit producing no change', async () => {
    const file = 'X.vue'
    writeFileSync(join(h.root, file), 'abc')
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, file), old_string: 'abc', new_string: 'abc' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/no change/)
  })

  it('denies edit to nonexistent file', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Edit',
      { file_path: join(h.root, 'ghost.vue'), old_string: 'x', new_string: 'y' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/denied|not found/i)
  })

  it('denies edit via symlink escape (B3)', async () => {
    // Symlink a file inside the worktree to point outside; Edit on it
    // would write to the link target without realpath protection.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'editor-edit-ack-outside-')))
    const outsideFile = join(outside, 'target.txt')
    writeFileSync(outsideFile, 'outside content')
    try {
      symlinkSync(outsideFile, join(h.root, 'evil.vue'))
      const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
      const r = await call(cut, 
        'Edit',
        { file_path: join(h.root, 'evil.vue'), old_string: 'outside', new_string: 'x' },
        fakeOpts(),
      )
      expect(r.behavior).toBe('deny')
      expect((r as { message: string }).message).toMatch(/denied|escapes|symlink/i)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('canUseTool — emitEditProposal rejection', () => {
  it('denies when emitEditProposal rejects', async () => {
    const h = makeHarness()
    try {
      const target = join(h.root, 'X.vue')
      writeFileSync(target, 'old')
      const cut = buildCanUseTool({
        worktreeRoot: h.root,
        emitEditProposal: async () => ({ ok: false, reason: 'shell offline' }),
      })
      const r = await call(cut, 'Write', { file_path: target, content: 'new' }, fakeOpts())
      expect(r.behavior).toBe('deny')
      expect((r as { message: string }).message).toMatch(/shell offline/)
    } finally {
      h.cleanup()
    }
  })
})

describe('canUseTool — Phase 4a conflict detection', () => {
  let h: Harness
  let conflicts: OverwriteConflictDetected[]
  beforeEach(() => {
    h = makeHarness()
    conflicts = []
  })
  afterEach(() => h.cleanup())

  function buildCutWithReads(reads: Record<string, { hashAtRead: string }>) {
    return buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => reads,
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
    })
  }

  it('does not flag a Write whose on-disk hash matches the session\'s read hash', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    const cut = buildCutWithReads({
      [target]: { hashAtRead: sha256('old contents') },
    })
    const r = await call(cut, 'Write', { file_path: target, content: 'new contents' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(0)
    expect(h.emitted).toHaveLength(1)
  })

  it('flags a Write whose on-disk hash diverges from the session read hash', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'on-disk after sibling write')

    const cut = buildCutWithReads({
      // The session read the file when it had the old contents.
      [target]: { hashAtRead: sha256('old contents') },
    })
    const r = await call(cut, 'Write', { file_path: target, content: 'this session\'s patch' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      file,
      absolutePath: target,
      hashAtRead: sha256('old contents'),
      hashAtWrite: sha256('on-disk after sibling write'),
    })
    // Write still proceeds — auto-apply contract.
    expect(h.emitted).toHaveLength(1)
  })

  it('flags an Edit whose on-disk hash diverges from the session read hash', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'foo bar baz')

    const cut = buildCutWithReads({
      [target]: { hashAtRead: sha256('original content with foo bar baz inside') },
    })
    const r = await call(cut, 
      'Edit',
      { file_path: target, old_string: 'bar', new_string: 'BAR' },
      fakeOpts(),
    )
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].hashAtWrite).toBe(sha256('foo bar baz'))
    expect(conflicts[0].hashAtRead).toBe(sha256('original content with foo bar baz inside'))
  })

  it('no-ops when the session has no read record for the file (Write without prior Read)', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    const cut = buildCutWithReads({
      // Some other file was read, not this one.
      [join(h.root, 'other.vue')]: { hashAtRead: sha256('whatever') },
    })
    const r = await call(cut, 'Write', { file_path: target, content: 'new contents' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(0)
  })

  it('no-ops when no conflict-detection callbacks are wired (non-detached path)', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: 'new contents' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    // No conflicts surfaced because no callback registered.
    expect(conflicts).toHaveLength(0)
  })

  it('advances the fileReads baseline after a successful Write so a same-session re-Write does not false-positive (codex #2)', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    // Live, mutable map — the orchestrator wires getFileReads to
    // return the same map by reference and uses recordOwnWrite to
    // mutate it.
    const reads: Record<string, { hashAtRead: string }> = {
      [target]: { hashAtRead: sha256('old contents') },
    }
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => reads,
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
      recordOwnWrite: (abs, nextHash) => {
        reads[abs] = { hashAtRead: nextHash }
      },
    })

    // First Write — baseline matches, no conflict.
    const first = await call(cut, 'Write', { file_path: target, content: 'first new contents' }, fakeOpts())
    expect(first).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(0)
    // Baseline advanced.
    expect(reads[target].hashAtRead).toBe(sha256('first new contents'))

    // Simulate the SDK actually performing the first write so the
    // file's on-disk content matches the advanced baseline. (canUseTool
    // doesn't write itself; in production the SDK does so after
    // canUseTool returns allow.)
    writeFileSync(target, 'first new contents')

    // Second Write of the same file — without the codex #2 fix this
    // would trip a conflict because the seeded fileReads still
    // pointed at the original baseline.
    const second = await call(cut, 
      'Write',
      { file_path: target, content: 'second new contents' },
      fakeOpts(),
    )
    expect(second).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(0)
    expect(reads[target].hashAtRead).toBe(sha256('second new contents'))
  })

  it('does NOT advance the baseline when the edit is denied via emitEditProposal rejection', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old contents')

    const reads: Record<string, { hashAtRead: string }> = {
      [target]: { hashAtRead: sha256('old contents') },
    }
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      // emit rejects — write doesn't land — baseline must stay put.
      emitEditProposal: async () => ({ ok: false, reason: 'shell offline' }),
      getFileReads: () => reads,
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
      recordOwnWrite: (abs, nextHash) => {
        reads[abs] = { hashAtRead: nextHash }
      },
    })
    const r = await call(cut, 'Write', { file_path: target, content: 'new' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    // Baseline unchanged.
    expect(reads[target].hashAtRead).toBe(sha256('old contents'))
  })

  it('flags write-after-delete: prior Read recorded but file no longer exists (codex #3)', async () => {
    const file = 'src/Created.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    // The session previously read the file at some baseline …
    const reads: Record<string, { hashAtRead: string }> = {
      [target]: { hashAtRead: sha256('content the session previously saw') },
    }
    // … but another writer deleted it; the file is now absent.
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => reads,
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
    })
    const r = await call(cut, 'Write', { file_path: target, content: '<template/>' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      file,
      absolutePath: target,
      hashAtRead: sha256('content the session previously saw'),
      hashAtWrite: sha256(''),
    })
    // Write still proceeds — auto-apply contract.
    expect(h.emitted).toHaveLength(1)
    expect((h.emitted[0] as { allowCreate?: boolean }).allowCreate).toBe(true)
  })

  it('does not flag a clean new-file create (no prior Read record for the path)', async () => {
    const target = join(h.root, 'GenuinelyNew.vue')
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => ({}),
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
    })
    const r = await call(cut, 'Write', { file_path: target, content: '<template/>' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(0)
  })

  it('detects conflict when Read goes through a symlink and Write goes through the real path (codex #8)', async () => {
    const realDir = join(h.root, 'real')
    const linkDir = join(h.root, 'link')
    mkdirSync(realDir, { recursive: true })
    const realFile = join(realDir, 'App.vue')
    writeFileSync(realFile, 'real contents')
    // realDir → linkDir
    symlinkSync(realDir, linkDir)

    // The session read the file via the symlinked alias.
    // `resolveRepoPath` realpaths the leaf, so both Read and Write
    // resolve to the same canonical path — the fileReads key must
    // match for detection to fire.
    const linkedRead = join(linkDir, 'App.vue')
    const writeSafe = await import('../agent-tools/read-tools').then((m) =>
      m.resolveRepoPath(h.root, realFile),
    )
    const readSafe = await import('../agent-tools/read-tools').then((m) =>
      m.resolveRepoPath(h.root, linkedRead),
    )
    if (!writeSafe.ok || !readSafe.ok) throw new Error('path resolution failed in test setup')
    expect(writeSafe.absolute).toBe(readSafe.absolute)

    const reads: Record<string, { hashAtRead: string }> = {
      // Keyed by the resolved (real) absolute path — what
      // file-read-snapshot.ts records.
      [readSafe.absolute]: { hashAtRead: sha256('original different content') },
    }
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => reads,
      onConflictDetected: (c) => {
        conflicts.push(c)
      },
    })
    const r = await call(cut, 
      'Write',
      { file_path: realFile, content: 'patched contents' },
      fakeOpts(),
    )
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].absolutePath).toBe(writeSafe.absolute)
  })

  it('swallows callback throws so detection telemetry can\'t break the edit-ack lane', async () => {
    const file = 'src/App.vue'
    const target = join(h.root, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'on-disk')

    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      getFileReads: () => ({
        [target]: { hashAtRead: sha256('different') },
      }),
      onConflictDetected: () => {
        throw new Error('boom')
      },
    })
    const r = await call(cut, 'Write', { file_path: target, content: 'patched' }, fakeOpts())
    // Detection threw but the edit still proceeded.
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
    expect(h.emitted).toHaveLength(1)
  })
})

describe('ALLOWED_NEW_FILE_EXTENSIONS', () => {
  it('covers Vue (.vue) + React (.tsx/.jsx) components and .ts modules', () => {
    for (const ext of ['.vue', '.ts', '.tsx', '.jsx']) {
      expect(ALLOWED_NEW_FILE_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  it('covers planning/docs, data/config, styles, and assets so the agent can draft plans', () => {
    for (const ext of ['.md', '.txt', '.json', '.yaml', '.css', '.svg', '.html']) {
      expect(ALLOWED_NEW_FILE_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  it('still excludes binaries / secrets / shell scripts', () => {
    for (const ext of ['.exe', '.env', '.sh', '.bin', '.so', '.dylib']) {
      expect(ALLOWED_NEW_FILE_EXTENSIONS.has(ext)).toBe(false)
    }
  })

  it('keeps the component set narrow for route scaffolding', () => {
    expect([...ALLOWED_COMPONENT_EXTENSIONS].sort()).toEqual([
      '.jsx',
      '.ts',
      '.tsx',
      '.vue',
    ])
    // every component extension is also a valid new-file extension
    for (const ext of ALLOWED_COMPONENT_EXTENSIONS) {
      expect(ALLOWED_NEW_FILE_EXTENSIONS.has(ext)).toBe(true)
    }
  })
})

function fakeOpts(): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    // Required since SDK 0.3.259: the control_request envelope id a host
    // echoes when answering out-of-band. Unused by `buildCanUseTool`.
    requestId: 'req-1',
  }
}

/**
 * `CanUseTool` may resolve `null` since SDK 0.3.259 (the host declining to
 * decide). `buildCanUseTool` always decides, so a `null` here is a failure
 * the assertions below should see as one, not silently narrow around.
 */
async function call(
  cut: CanUseTool,
  ...args: Parameters<CanUseTool>
): Promise<PermissionResult> {
  const r = await cut(...args)
  if (r === null) throw new Error('canUseTool resolved null')
  return r
}

function asOverwrite(p: EditProposalPayload): Extract<EditProposalPayload, { type: 'overwrite' }> {
  if (p.type !== 'overwrite') throw new Error(`expected overwrite payload, got ${p.type}`)
  return p
}

describe('canUseTool — WebFetch / WebSearch', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  it('denies WebFetch when no policy is wired (default off)', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'WebFetch', { url: 'https://vuejs.org/' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/no web policy configured/)
  })

  it('denies WebFetch when the host is not in the allowlist', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      webPolicy: { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false },
    })
    const r = await call(cut, 'WebFetch', { url: 'https://evil.example/' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/not in the allowlist/)
  })

  it('allows WebFetch for an allowlisted host', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      webPolicy: { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false },
    })
    const r = await call(cut, 'WebFetch', { url: 'https://vuejs.org/guide/' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  it('denies WebFetch for non-http(s) URLs even when the host appears allowlisted', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      webPolicy: { webFetchAllowedHosts: ['vuejs.org'], webSearchEnabled: false },
    })
    const r = await call(cut, 'WebFetch', { url: 'file://vuejs.org/etc/passwd' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/invalid or non-http/)
  })

  it('denies WebSearch when no policy is wired', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'WebSearch', { query: 'how to vue' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/WebSearch is disabled/)
  })

  it('denies WebSearch when explicitly disabled', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      webPolicy: { webFetchAllowedHosts: [], webSearchEnabled: false },
    })
    const r = await call(cut, 'WebSearch', { query: 'how to vue' }, fakeOpts())
    expect(r.behavior).toBe('deny')
  })

  it('allows WebSearch when enabled', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      webPolicy: { webFetchAllowedHosts: [], webSearchEnabled: true },
    })
    const r = await call(cut, 'WebSearch', { query: 'how to vue' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  it('denies any mcp__figma__* tool when no Figma prefixes are configured', async () => {
    // Defense in depth: even if a figma MCP server were somehow
    // registered without us having loaded figmaConfig, every tool
    // call should deny. (Shouldn't happen in production — we register
    // mcpServers.figma only when figmaConfig is set — but belt+
    // suspenders.)
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'mcp__figma__get_file', { fileId: 'x' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/no extension named 'figma' is configured/)
  })

  it('allows a figma tool whose bare name starts with an allowed prefix', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      figmaAllowedToolPrefixes: ['get_', 'list_'],
    })
    const r = await call(cut, 'mcp__figma__get_file', { fileId: 'x' }, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  it('denies a figma tool whose bare name does not match any allowed prefix', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      figmaAllowedToolPrefixes: ['get_', 'list_'],
    })
    const r = await call(cut, 'mcp__figma__update_node', { nodeId: 'x' }, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/read-only by contract/)
    expect((r as { message: string }).message).toMatch(/update_node/)
  })

  it('does not let a write tool slip through via a prefix-collision (e.g. "get_or_create_")', async () => {
    // The prefix check is startsWith on the bare name, so a tool
    // named `get_or_create_foo` WOULD pass `get_`. That's by design —
    // we trust the customer's prefix list — but the safety hatch is
    // that the default list is conservative (verbs that are
    // unambiguously read-only in Figma MCP convention).
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      figmaAllowedToolPrefixes: ['list_'],
    })
    // `create_*` is not in the configured prefixes, so it denies.
    const r = await call(cut, 'mcp__figma__create_frame', { name: 'x' }, fakeOpts())
    expect(r.behavior).toBe('deny')
  })

  it('does not affect non-figma MCP tool calls (editor namespace still flows through)', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      // Even with figma denied, editor tools must be untouched.
    })
    const r = await call(cut, 'mcp__editor__get_selection', {}, fakeOpts())
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })
})

describe('toRel (Task 14 review round-2 P2)', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-toRel-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('treats a `..`-PREFIXED FILENAME as a normal repo-relative path, not an escape', () => {
    // Before the fix, `rel.startsWith('..')` (blunt) matched this
    // legally-named file too — `toRel` fell through both branches and
    // returned the ABSOLUTE path instead of the relative one, which then
    // fed `writeBackupJournal`'s (correct) containment check a key that
    // genuinely WAS outside the backup directory, throwing
    // `BackupJournalPathEscapeError` for a perfectly ordinary file.
    expect(toRel(root, join(root, '..fixture.vue'))).toBe('..fixture.vue')
    expect(toRel(root, join(root, 'src', '..cache', 'App.vue'))).toBe('src/..cache/App.vue')
  })

  it('still returns the absolute path for a genuine escape', () => {
    const outside = dirname(root)
    const escaped = join(outside, 'secret.vue')
    // Not inside `root` at all — `toRel` correctly falls through to the
    // absolute-path return, same as before the fix.
    expect(toRel(root, escaped)).toBe(escaped.split('\\').join('/'))
  })

  it('still returns "" for the root itself', () => {
    expect(toRel(root, root)).toBe('')
  })
})

describe('canUseTool — MCP extensions (generalised)', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  const policy = (entries: [string, ReadonlyArray<string> | null][]) =>
    new Map<string, ReadonlyArray<string> | null>(entries)

  it('allows a read-verb tool on a configured extension', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      extensionToolPolicy: policy([['tracker', ['get_', 'list_']]]),
    })
    expect((await call(cut, 'mcp__tracker__list_issues', {}, fakeOpts())).behavior).toBe('allow')
  })

  it('denies a write-verb tool on a read-only extension', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      extensionToolPolicy: policy([['tracker', ['get_', 'list_']]]),
    })
    const r = await call(cut, 'mcp__tracker__create_issue', {}, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/read-only by contract/)
  })

  it('allows writes on an extension explicitly opted OUT of read-only', async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      extensionToolPolicy: policy([['tracker', null]]),
    })
    expect((await call(cut, 'mcp__tracker__create_issue', {}, fakeOpts())).behavior).toBe('allow')
  })

  it('denies an extension that is not configured at all', async () => {
    // Reaching a server we hold no policy for means a stale registration or
    // something we never configured; neither should get tool access.
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      extensionToolPolicy: policy([['tracker', ['get_']]]),
    })
    const r = await call(cut, 'mcp__other__get_thing', {}, fakeOpts())
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/no extension named 'other'/)
  })

  it("never gates the Editor's own in-process tools", async () => {
    const cut = buildCanUseTool({
      worktreeRoot: h.root,
      emitEditProposal: h.emit,
      extensionToolPolicy: policy([]),
    })
    expect(
      (await call(cut, 'mcp__editor__get_design_tokens', {}, fakeOpts())).behavior,
    ).toBe('allow')
  })
})

describe('canUseTool — protected config files', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  // `.mcp.json` decides which SUBPROCESSES the next turn spawns, and
  // `readOnly` in that same file decides whether an extension may write. An
  // agent that can edit it can grant itself capabilities the user never
  // approved — and prompt-injected output from an already-enabled MCP server
  // is exactly the untrusted input that would drive such a write. The
  // read-only-by-default doctrine is worthless if the agent can edit the file
  // that expresses it.
  // Widened by the 2026-08-09 security fix. The four originals were the whole
  // list, which is what made B6 possible: `.claude/settings.json` declares
  // `hooks` — shell commands the SDK executes — and was not among them, so the
  // strongest execution sink in the repo was the one file the guard ignored.
  //
  // The full policy now lives in `protected-paths.ts`; these cases pin that the
  // canUseTool lanes (SDK built-in Write/Edit) actually consult it. The
  // structural-tool lanes are pinned separately at the broker, in
  // `write-broker.test.ts` — the two together are the whole write surface.
  const PROTECTED = [
    '.mcp.json',
    'desde.config.json',
    'desde-composer.config.json',
    '.desde/config.json',
    // B6: hooks the SDK runs as shell commands.
    '.claude/settings.json',
    '.claude/hooks/pre-tool-use.js',
    // B8: executed by Vite/the bundler on every dev-server start.
    'vite.config.ts',
    // S12: loaded as instructions, giving injection cross-session persistence.
    'CLAUDE.md',
    // Inside the repo root, so the root-containment guard never fires.
    '.git/hooks/pre-commit',
    'node_modules/.bin/vite',
  ]

  for (const rel of PROTECTED) {
    it(`denies Write that CREATES ${rel}`, async () => {
      const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
      const r = await call(cut, 
        'Write',
        { file_path: join(h.root, rel), content: '{"mcpServers":{"x":{"command":"sh"}}}' },
        fakeOpts(),
      )
      expect(r.behavior).toBe('deny')
      expect((r as { message: string }).message).toMatch(/Extensions panel|not editable/i)
      expect(h.emitted).toHaveLength(0)
    })

    it(`denies Write that OVERWRITES an existing ${rel}`, async () => {
      const target = join(h.root, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '{}')
      const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
      const r = await call(cut, 
        'Write',
        { file_path: target, content: '{"mcpServers":{"x":{"command":"sh"}}}' },
        fakeOpts(),
      )
      expect(r.behavior).toBe('deny')
      expect(h.emitted).toHaveLength(0)
    })

    it(`denies Edit of ${rel}`, async () => {
      const target = join(h.root, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, '{"a":1}')
      const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
      const r = await call(cut, 
        'Edit',
        { file_path: target, old_string: '{"a":1}', new_string: '{"a":2}' },
        fakeOpts(),
      )
      expect(r.behavior).toBe('deny')
      expect(h.emitted).toHaveLength(0)
    })
  }

  it('still allows an ordinary .json file', async () => {
    const target = join(h.root, 'src/data.json')
    mkdirSync(dirname(target), { recursive: true })
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 'Write', { file_path: target, content: '{"ok":true}' }, fakeOpts())
    expect(r.behavior).toBe('allow')
  })

  it('is not fooled by a path that reaches the same file indirectly', async () => {
    const cut = buildCanUseTool({ worktreeRoot: h.root, emitEditProposal: h.emit })
    const r = await call(cut, 
      'Write',
      { file_path: join(h.root, 'src', '..', '.mcp.json'), content: '{}' },
      fakeOpts(),
    )
    expect(r.behavior).toBe('deny')
  })
})

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __clearProjectKnowledgeCache,
  loadCachedProjectKnowledge,
  loadProjectKnowledge,
} from './load-project-knowledge'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-loader-'))
  __clearProjectKnowledgeCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  __clearProjectKnowledgeCache()
})

describe('loadProjectKnowledge', () => {
  it('runs discovery against the prototype tree', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\nBe consistent.', 'utf-8')
    const k = loadProjectKnowledge({ prototypeRoot: root })
    expect(k.rules).toContain('Be consistent.')
  })

  it('returns an empty digest for an empty prototype root', () => {
    const k = loadProjectKnowledge({ prototypeRoot: root })
    expect(k.rules).toBe('')
    expect(k.docIndex).toEqual([])
  })

  it('does not throw on a non-existent root', () => {
    const k = loadProjectKnowledge({
      prototypeRoot: path.join(root, 'does-not-exist'),
    })
    expect(k.rules).toBe('')
  })
})

describe('loadCachedProjectKnowledge', () => {
  it('memoizes per prototypeRoot — re-discovery does not see later writes', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'first', 'utf-8')
    const a = loadCachedProjectKnowledge({ prototypeRoot: root })
    // Mutate the tree after the first (cached) load.
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'second', 'utf-8')
    const b = loadCachedProjectKnowledge({ prototypeRoot: root })
    expect(b).toBe(a) // same cached reference
    expect(b.rules).toContain('first')
  })

  it('re-discovers after the cache is cleared', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'first', 'utf-8')
    loadCachedProjectKnowledge({ prototypeRoot: root })
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'second', 'utf-8')
    __clearProjectKnowledgeCache()
    const fresh = loadCachedProjectKnowledge({ prototypeRoot: root })
    expect(fresh.rules).toContain('second')
  })

  it('keys the cache on prototypeRoot', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-loader-2-'))
    try {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'root-one', 'utf-8')
      fs.writeFileSync(path.join(otherRoot, 'CLAUDE.md'), 'root-two', 'utf-8')
      const a = loadCachedProjectKnowledge({ prototypeRoot: root })
      const b = loadCachedProjectKnowledge({ prototypeRoot: otherRoot })
      expect(a.rules).toContain('root-one')
      expect(b.rules).toContain('root-two')
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  it('keys the cache on the excludeFiles set — a changed exclusion is not stale', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude body', 'utf-8')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agents body', 'utf-8')
    // Identical args twice → single-slot cache hit (same reference).
    const all1 = loadCachedProjectKnowledge({ prototypeRoot: root })
    const all2 = loadCachedProjectKnowledge({ prototypeRoot: root })
    expect(all2).toBe(all1)
    expect(all1.rulesFiles.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
    ])
    // A changed excludeFiles set is part of the key → cache miss → a
    // correctly-filtered digest, never the previously-cached one.
    const excluded = loadCachedProjectKnowledge({
      prototypeRoot: root,
      excludeFiles: ['CLAUDE.md'],
    })
    expect(excluded).not.toBe(all1)
    expect(excluded.rulesFiles.map((f) => f.path)).toEqual(['AGENTS.md'])
  })
})

describe('loadProjectKnowledge — excludeFiles', () => {
  it('drops excluded files from discovery', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude body', 'utf-8')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agents body', 'utf-8')
    const k = loadProjectKnowledge({
      prototypeRoot: root,
      excludeFiles: ['AGENTS.md'],
    })
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md'])
    expect(k.rules).not.toContain('agents body')
  })
})

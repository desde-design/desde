import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConventionalRulesSource } from './index'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-adapter-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Write a file at a repo-relative POSIX path, creating parent dirs. */
function write(rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

function discover() {
  return new ConventionalRulesSource().discover({ prototypeRoot: root })
}

describe('ConventionalRulesSource', () => {
  it('returns an empty digest for a repo with no recognized files', () => {
    const k = discover()
    expect(k.rules).toBe('')
    expect(k.rulesFiles).toEqual([])
    expect(k.docIndex).toEqual([])
    expect(k.truncated).toBe(false)
  })

  it('discovers CLAUDE.md and inlines it into the rules digest', () => {
    write('CLAUDE.md', '# House rules\nAlways use <script setup>.')
    const k = discover()
    expect(k.rules).toContain('Always use <script setup>.')
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md'])
  })

  it('orders rules files by convention priority (CLAUDE.md before AGENTS.md before .cursorrules)', () => {
    write('.cursorrules', 'cursor content')
    write('AGENTS.md', 'agents content')
    write('CLAUDE.md', 'claude content')
    const k = discover()
    expect(k.rulesFiles.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      '.cursorrules',
    ])
    expect(k.rules.indexOf('claude content')).toBeLessThan(
      k.rules.indexOf('agents content'),
    )
    expect(k.rules.indexOf('agents content')).toBeLessThan(
      k.rules.indexOf('cursor content'),
    )
  })

  it('picks up .cursor/rules/*.{md,mdc} sorted by filename, lowest priority', () => {
    write('CLAUDE.md', 'claude')
    write('.cursor/rules/02-second.md', 'second rule')
    write('.cursor/rules/01-first.mdc', 'first rule')
    write('.cursor/rules/ignore.txt', 'not a rule file')
    const k = discover()
    expect(k.rulesFiles.map((f) => f.path)).toEqual([
      'CLAUDE.md',
      '.cursor/rules/01-first.mdc',
      '.cursor/rules/02-second.md',
    ])
    expect(k.rules).not.toContain('not a rule file')
  })

  it('skips empty / whitespace-only rules files', () => {
    write('CLAUDE.md', '   \n  \n')
    write('AGENTS.md', 'real content')
    const k = discover()
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['AGENTS.md'])
  })

  it('caps inlined .cursor/rules files at 50 and marks the digest truncated', () => {
    for (let i = 0; i < 55; i++) {
      write(`.cursor/rules/${String(i).padStart(3, '0')}.md`, `rule ${i}`)
    }
    const k = discover()
    expect(k.rulesFiles).toHaveLength(50)
    expect(k.truncated).toBe(true)
    // The first 50 by sorted filename are the ones inlined.
    expect(k.rulesFiles[0].path).toBe('.cursor/rules/000.md')
    expect(k.rulesFiles[49].path).toBe('.cursor/rules/049.md')
  })

  it('empty .cursor/rules files do not consume the inline cap', () => {
    // 30 empty files interleaved with 3 real ones — all 3 real files must
    // still be inlined (empties are read but never count against the cap).
    for (let i = 0; i < 30; i++) {
      write(`.cursor/rules/empty-${String(i).padStart(3, '0')}.md`, '   \n')
    }
    write('.cursor/rules/real-a.md', 'rule a')
    write('.cursor/rules/real-b.md', 'rule b')
    write('.cursor/rules/real-c.md', 'rule c')
    const k = discover()
    const cursorPaths = k.rulesFiles.map((f) => f.path)
    expect(cursorPaths).toContain('.cursor/rules/real-a.md')
    expect(cursorPaths).toContain('.cursor/rules/real-b.md')
    expect(cursorPaths).toContain('.cursor/rules/real-c.md')
    expect(k.truncated).toBe(false)
  })

  it('indexes README.md and docs/** as retrieval-only (not inlined)', () => {
    write('README.md', '# My Prototype\nIntro text.')
    write('docs/architecture.md', '# Architecture\nDetails.')
    write('docs/guides/testing.md', '# Testing Guide\nHow to test.')
    const k = discover()
    // Docs are indexed, never inlined.
    expect(k.rules).toBe('')
    const paths = k.docIndex.map((d) => d.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('docs/architecture.md')
    expect(paths).toContain('docs/guides/testing.md')
    const readme = k.docIndex.find((d) => d.path === 'README.md')
    expect(readme?.title).toBe('My Prototype')
    const arch = k.docIndex.find((d) => d.path === 'docs/architecture.md')
    expect(arch?.title).toBe('Architecture')
  })

  it('falls back to the basename when a doc has no markdown heading', () => {
    write('docs/no-heading.md', 'just prose, no heading')
    const k = discover()
    const entry = k.docIndex.find((d) => d.path === 'docs/no-heading.md')
    expect(entry?.title).toBe('no-heading.md')
  })

  it('sets truncated when the rules digest overruns the budget', () => {
    // A CLAUDE.md far larger than the 16k digest budget.
    write('CLAUDE.md', 'A'.repeat(50_000))
    const k = discover()
    expect(k.truncated).toBe(true)
    expect(k.rulesFiles[0].truncated).toBe(true)
  })

  it('produces .cursor/rules paths with POSIX separators', () => {
    write('.cursor/rules/style.md', 'style rule')
    const k = discover()
    expect(k.rulesFiles[0].path).toBe('.cursor/rules/style.md')
  })

  it('refuses a rules file that is a symlink escaping the prototype root', () => {
    // An adversarial repo symlinks CLAUDE.md at a file outside the root —
    // discovery must NOT inline it into an LLM prompt.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-outside-'))
    try {
      const secret = path.join(outside, 'secret.txt')
      fs.writeFileSync(secret, 'SECRET CONTENTS', 'utf-8')
      fs.symlinkSync(secret, path.join(root, 'CLAUDE.md'))
      const k = discover()
      expect(k.rules).toBe('')
      expect(k.rules).not.toContain('SECRET CONTENTS')
      expect(k.rulesFiles).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not index a symlinked file entry inside docs/ (symlink entries are skipped)', () => {
    // `Dirent.isFile()` is false for a symlink, so a symlinked `.md` entry
    // is skipped before it is ever read — it never reaches the doc index.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-outside-'))
    try {
      const secret = path.join(outside, 'secret.md')
      fs.writeFileSync(secret, '# Secret\nleak', 'utf-8')
      fs.mkdirSync(path.join(root, 'docs'))
      fs.symlinkSync(secret, path.join(root, 'docs', 'leaked.md'))
      // A legitimate doc alongside it is still indexed.
      write('docs/real.md', '# Real Doc\nok')
      const k = discover()
      const paths = k.docIndex.map((d) => d.path)
      expect(paths).toContain('docs/real.md')
      expect(paths).not.toContain('docs/leaked.md')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a docs/ directory that is a symlink escaping the prototype root', () => {
    // The whole `docs/` directory is a symlink pointing outside the root —
    // `collectDocs` realpath-contains the directory before enumerating it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'leak.md'), '# Leak\nsecret docs', 'utf-8')
      fs.symlinkSync(outside, path.join(root, 'docs'))
      const k = discover()
      expect(k.docIndex.map((d) => d.path)).not.toContain('docs/leak.md')
      expect(k.docIndex).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a .cursor/rules directory that is a symlink escaping the prototype root', () => {
    // `.cursor/rules` is a symlink pointing outside — `listFiles`
    // realpath-contains the directory before enumerating it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'evil.md'), 'evil rule body', 'utf-8')
      fs.mkdirSync(path.join(root, '.cursor'))
      fs.symlinkSync(outside, path.join(root, '.cursor', 'rules'))
      const k = discover()
      expect(k.rules).toBe('')
      expect(k.rules).not.toContain('evil rule body')
      expect(k.rulesFiles).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still discovers rules through an in-root symlink (escape check, not symlink ban)', () => {
    // A symlink that stays inside the root resolves and is read — the
    // containment check rejects escapes, not symlinks per se.
    write('rules-source.md', 'in-root rule body')
    fs.symlinkSync(
      path.join(root, 'rules-source.md'),
      path.join(root, 'CLAUDE.md'),
    )
    const k = discover()
    expect(k.rules).toContain('in-root rule body')
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md'])
  })
})

describe('ConventionalRulesSource — excludeFiles', () => {
  function discoverExcluding(excludeFiles: string[]) {
    return new ConventionalRulesSource().discover({
      prototypeRoot: root,
      excludeFiles,
    })
  }

  it('drops an excluded root rules file from the digest', () => {
    write('CLAUDE.md', 'claude body')
    write('AGENTS.md', 'agents body')
    const k = discoverExcluding(['CLAUDE.md'])
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['AGENTS.md'])
    expect(k.rules).not.toContain('claude body')
    expect(k.rules).toContain('agents body')
  })

  it('drops an excluded .cursor/rules file', () => {
    write('.cursor/rules/keep.md', 'keep me')
    write('.cursor/rules/drop.md', 'drop me')
    const k = discoverExcluding(['.cursor/rules/drop.md'])
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['.cursor/rules/keep.md'])
    expect(k.rules).not.toContain('drop me')
  })

  it('drops an excluded docs file and README from the doc index', () => {
    write('README.md', '# Readme')
    write('docs/keep.md', '# Keep')
    write('docs/drop.md', '# Drop')
    const k = discoverExcluding(['README.md', 'docs/drop.md'])
    const paths = k.docIndex.map((d) => d.path)
    expect(paths).toContain('docs/keep.md')
    expect(paths).not.toContain('README.md')
    expect(paths).not.toContain('docs/drop.md')
  })

  it('normalizes leading ./ and / in exclusion paths', () => {
    write('CLAUDE.md', 'claude body')
    write('AGENTS.md', 'agents body')
    const k = discoverExcluding(['./CLAUDE.md', '/AGENTS.md'])
    expect(k.rulesFiles).toEqual([])
  })

  it('normalizes Windows separators, duplicate + trailing slashes, repeated ./', () => {
    write('CLAUDE.md', 'claude body')
    write('docs/a.md', '# A')
    write('docs/b.md', '# B')
    write('docs/c.md', '# C')
    const k = discoverExcluding([
      '././CLAUDE.md', // repeated ./
      'docs\\a.md', // Windows separator
      'docs//b.md', // duplicate slash
      'docs/c.md/', // trailing slash
    ])
    expect(k.rulesFiles).toEqual([])
    expect(k.docIndex.map((d) => d.path)).toEqual([])
  })

  it('treats a non-matching exclusion entry (e.g. traversal) as a harmless no-op', () => {
    write('CLAUDE.md', 'claude body')
    const k = discoverExcluding(['../escape.md', 'nonexistent.md'])
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md'])
  })

  it('leaves non-excluded files untouched', () => {
    write('CLAUDE.md', 'claude body')
    const k = discoverExcluding(['AGENTS.md', 'docs/whatever.md'])
    expect(k.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md'])
  })
})

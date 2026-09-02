/**
 * Unit tests for the shared `isRootEscape` classifier (Task 14 review
 * round-3 P2). Pure-string tests — no filesystem, no host-OS dependency —
 * so the win32-style case is asserted directly rather than requiring a
 * Windows runner: `path.relative` returns native separators, and on a
 * real Windows host an escaping result looks like `'..\\outside.txt'`,
 * which this test constructs as a literal string regardless of the host
 * this suite actually runs on.
 */

import { describe, expect, it } from 'vitest'
import { isRootEscape } from './root-escape'

describe('isRootEscape', () => {
  it('flags the exact parent (no trailing segment)', () => {
    expect(isRootEscape('..')).toBe(true)
  })

  it('flags a POSIX-style escape', () => {
    expect(isRootEscape('../outside.txt')).toBe(true)
    expect(isRootEscape('../../etc/passwd')).toBe(true)
  })

  it('flags a win32-style escape (Task 14 review round-3 P2 — the bug)', () => {
    // The exact shape `path.relative` produces on a real Windows host
    // when the target is outside the base. Before the fix,
    // `toRepoRelative` (sdk-write-guard.ts) and `resolveRepoRelative`
    // (write-invalidate-hook.ts) checked only the POSIX `'../'` literal,
    // so this string sailed through as "in-root".
    expect(isRootEscape('..\\outside.txt')).toBe(true)
    expect(isRootEscape('..\\..\\secrets\\config.json')).toBe(true)
  })

  it('does NOT flag a legally `..`-prefixed FILENAME (round-2 P2 — the adjacent bug)', () => {
    expect(isRootEscape('..fixture.vue')).toBe(false)
    expect(isRootEscape('src/..cache/App.vue')).toBe(false)
    // The win32 sibling of the same case.
    expect(isRootEscape('src\\..cache\\App.vue')).toBe(false)
  })

  it('does not flag an ordinary nested path', () => {
    expect(isRootEscape('src/App.vue')).toBe(false)
    expect(isRootEscape('App.vue')).toBe(false)
    expect(isRootEscape('src\\App.vue')).toBe(false)
  })

  it('does not flag the empty string (callers special-case "is the root itself" separately)', () => {
    expect(isRootEscape('')).toBe(false)
  })
})

import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { normalizeLedgerPath } from './normalize-path'

describe('normalizeLedgerPath (P1-2, round 3; platform-scoped fix, round 10)', () => {
  it('leaves an already-forward-slash path untouched', () => {
    expect(normalizeLedgerPath('src/App.vue')).toBe('src/App.vue')
  })

  it('leaves a bare filename (no separators) untouched', () => {
    expect(normalizeLedgerPath('App.vue')).toBe('App.vue')
  })

  it('leaves an empty string untouched', () => {
    expect(normalizeLedgerPath('')).toBe('')
  })

  it('defaults to this process\'s own path separator when none is injected', () => {
    // Whatever OS actually runs this suite, calling with no second
    // argument must behave identically to passing `node:path`'s `sep`
    // explicitly — proves the default parameter is really wired to the
    // real separator, not silently ignored.
    expect(normalizeLedgerPath('a\\b')).toBe(normalizeLedgerPath('a\\b', sep))
  })

  // The separator is INJECTED in every case below rather than read from
  // `process.platform`, so both branches run deterministically on any
  // host OS — including this suite's own CI, which is POSIX.
  describe('on a platform whose separator is backslash (Windows)', () => {
    const WIN_SEP = '\\'

    it('converts a fully backslash-separated path to forward slashes', () => {
      expect(normalizeLedgerPath('src\\components\\App.vue', WIN_SEP)).toBe(
        'src/components/App.vue',
      )
    })

    it('converts a mixed-separator path', () => {
      expect(normalizeLedgerPath('src\\components/App.vue', WIN_SEP)).toBe(
        'src/components/App.vue',
      )
    })
  })

  describe('on a platform whose separator is forward-slash (POSIX)', () => {
    const POSIX_SEP = '/'

    // F2 (P2, round-10 whole-branch review finding, 2026-08-19 —
    // REGRESSION from round 3). Round 3's fix replaced every backslash
    // unconditionally. On POSIX a backslash is a legal filename
    // character, so a file genuinely named `foo\bar.vue` has a real path
    // that must survive this function untouched — rewriting it to
    // `foo/bar.vue` names a file that does not exist, and git's own
    // porcelain output for the real file keeps the literal backslash, so
    // the rewritten path silently stops string-matching it.
    it('does NOT touch a literal backslash in a legal POSIX filename', () => {
      expect(normalizeLedgerPath('foo\\bar.vue', POSIX_SEP)).toBe('foo\\bar.vue')
    })

    it('does not touch a literal backslash inside a directory segment either', () => {
      expect(normalizeLedgerPath('src/weird\\name/App.vue', POSIX_SEP)).toBe(
        'src/weird\\name/App.vue',
      )
    })
  })
})

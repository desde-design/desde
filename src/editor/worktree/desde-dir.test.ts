import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DesdeDirSymlinkError,
  desdeDir,
  desdeDirOrNull,
  desdePath,
  desdePathOrNull,
  desdeRemovalPath,
} from './desde-dir'

let root: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desde-dir-'))
  outside = mkdtempSync(join(tmpdir(), 'desde-dir-outside-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('desdePath', () => {
  it('returns the joined path when nothing on the way is a symlink', () => {
    mkdirSync(join(root, '.desde', 'backups'), { recursive: true })
    expect(desdePath(root, 'backups', 'one')).toBe(join(root, '.desde', 'backups', 'one'))
  })

  it('returns the path when nothing exists yet — the caller creates it', () => {
    expect(desdePath(root, 'chat-sessions', 'sess-a')).toBe(
      join(root, '.desde', 'chat-sessions', 'sess-a'),
    )
  })

  it('refuses when .desde itself is a symlink', () => {
    symlinkSync(outside, join(root, '.desde'))
    expect(() => desdePath(root, 'backups')).toThrow(DesdeDirSymlinkError)
    expect(() => desdePath(root, 'backups')).toThrow(/\.desde is a symbolic link/)
  })

  it('refuses when a directory BENEATH a real .desde is a symlink', () => {
    // The measured escape: `.desde` real, `.desde/backups` linked away, and
    // the old one-level guard passed it straight through — which turned a
    // backups sweep into a recursive delete outside the repository.
    mkdirSync(join(root, '.desde'), { recursive: true })
    symlinkSync(outside, join(root, '.desde', 'backups'))
    expect(() => desdePath(root, 'backups')).toThrow(DesdeDirSymlinkError)
    expect(() => desdePath(root, 'backups')).toThrow(/\.desde\/backups is a symbolic link/)
  })

  it('names the offending segment however deep it is', () => {
    mkdirSync(join(root, '.desde', 'chat-sessions'), { recursive: true })
    symlinkSync(outside, join(root, '.desde', 'chat-sessions', 'sess-a'))
    expect(() => desdePath(root, 'chat-sessions', 'sess-a', 'bases')).toThrow(
      /\.desde\/chat-sessions\/sess-a is a symbolic link/,
    )
  })

  it('refuses a symlinked LEAF file, not only a directory', () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    writeFileSync(join(outside, 'target.jsonl'), 'x\n')
    symlinkSync(join(outside, 'target.jsonl'), join(root, '.desde', 'edit-log.jsonl'))
    expect(() => desdePath(root, 'edit-log.jsonl')).toThrow(DesdeDirSymlinkError)
  })

  it('checks the whole subpath even when the caller passes it as one string', () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    symlinkSync(outside, join(root, '.desde', 'manifests'))
    expect(() => desdePath(root, 'manifests/pkg.json')).toThrow(DesdeDirSymlinkError)
  })
})

describe('desdePathOrNull', () => {
  it('returns the path when the walk is clean', () => {
    expect(desdePathOrNull(root, 'manifests')).toBe(join(root, '.desde', 'manifests'))
  })

  it('returns null instead of throwing, for boot and serving paths', () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    symlinkSync(outside, join(root, '.desde', 'manifests'))
    expect(desdePathOrNull(root, 'manifests')).toBeNull()
  })

  it('returns null when .desde itself is a symlink', () => {
    symlinkSync(outside, join(root, '.desde'))
    expect(desdePathOrNull(root, 'manifests')).toBeNull()
    expect(desdeDirOrNull(root)).toBeNull()
  })
})

describe('desdeRemovalPath', () => {
  it('accepts a real directory inside the repository', () => {
    mkdirSync(join(root, '.desde', 'backups', 'one'), { recursive: true })
    expect(desdeRemovalPath(root, 'backups', 'one')).toBe(
      join(root, '.desde', 'backups', 'one'),
    )
  })

  it('accepts a target that does not exist — there is nothing to delete', () => {
    expect(desdeRemovalPath(root, 'backups', 'gone')).toBe(
      join(root, '.desde', 'backups', 'gone'),
    )
  })

  it('refuses a target that resolves outside the repository', () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    symlinkSync(outside, join(root, '.desde', 'backups'))
    expect(() => desdeRemovalPath(root, 'backups', 'one')).toThrow(DesdeDirSymlinkError)
  })
})

describe('desdeDir', () => {
  it('still guards the top level on its own', () => {
    symlinkSync(outside, join(root, '.desde'))
    expect(() => desdeDir(root)).toThrow(/\.desde is a symbolic link/)
  })

  it('returns the .desde path when it is a real directory', () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    expect(desdeDir(root)).toBe(join(root, '.desde'))
  })
})

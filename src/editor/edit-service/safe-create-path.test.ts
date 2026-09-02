/**
 * Tests for `resolveSafeCreatePath` — the symlink-safe path validator
 * for new-file creation (allowCreate). Covers the attack surface
 * Codex flagged in the Phase 4 review:
 *   - lexical `..` traversal
 *   - ancestor symlink pointing outside the repo
 *   - dangling leaf symlink whose target lives outside the repo
 *   - pre-existing leaf (rejected as "not a new-file target")
 *   - happy path: ancestors exist as real dirs, leaf doesn't exist
 *   - happy path: parent dir doesn't exist yet (mkdir recursive case)
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSafeCreatePath } from './safe-create-path'

describe('resolveSafeCreatePath', () => {
  let repoRoot: string
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-safecreate-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('accepts a leaf in an existing directory when nothing on the path exists yet', async () => {
    await mkdir(join(repoRoot, 'src/components'), { recursive: true })
    const r = await resolveSafeCreatePath(repoRoot, 'src/components/New.vue')
    expect(r.ok).toBe(true)
  })

  it('accepts a leaf whose parent dirs do not exist yet (mkdir-recursive case)', async () => {
    const r = await resolveSafeCreatePath(repoRoot, 'a/b/c/Deep.vue')
    expect(r.ok).toBe(true)
  })

  it('rejects lexical `..` traversal', async () => {
    const r = await resolveSafeCreatePath(repoRoot, '../escape.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/escapes repo root/)
  })

  it('rejects when an ancestor is a symlink (points outside the repo)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'desde-outside-'))
    try {
      await symlink(outside, join(repoRoot, 'link-dir'))
      const r = await resolveSafeCreatePath(repoRoot, 'link-dir/sneaky.vue')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/symlink at 'link-dir'/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects when an ancestor is a symlink even pointing inside the repo', async () => {
    // The /point-of-policy is "never follow ancestor symlinks during
    // create" so an inside-repo symlink shouldn't get a pass — it
    // would otherwise allow an unintended write target.
    await mkdir(join(repoRoot, 'real-dir'), { recursive: true })
    await symlink(join(repoRoot, 'real-dir'), join(repoRoot, 'alias-dir'))
    const r = await resolveSafeCreatePath(repoRoot, 'alias-dir/x.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/symlink/)
  })

  it('rejects when the leaf itself is a (dangling) symlink', async () => {
    // fs.writeFile follows symlinks on write, so a pre-staged leaf
    // symlink would land the write at the target. lstat catches it.
    await symlink('/tmp/some-target-that-does-not-matter', join(repoRoot, 'foo.vue'))
    const r = await resolveSafeCreatePath(repoRoot, 'foo.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/symlink at 'foo\.vue'/)
  })

  it('rejects a pre-existing leaf (not a new file)', async () => {
    await writeFile(join(repoRoot, 'taken.vue'), '<template/>', 'utf8')
    const r = await resolveSafeCreatePath(repoRoot, 'taken.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already exists/)
  })

  it('rejects when an ancestor exists but is a regular file (not a dir)', async () => {
    await writeFile(join(repoRoot, 'src'), 'not a dir', 'utf8')
    const r = await resolveSafeCreatePath(repoRoot, 'src/inside.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a directory/)
  })

  it('rejects empty / non-string paths', async () => {
    const r1 = await resolveSafeCreatePath(repoRoot, '')
    expect(r1.ok).toBe(false)
    // @ts-expect-error — runtime check
    const r2 = await resolveSafeCreatePath(repoRoot, undefined)
    expect(r2.ok).toBe(false)
  })

  it('rejects when the repo root itself is inaccessible', async () => {
    const r = await resolveSafeCreatePath('/no-such-root-12345', 'x.vue')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not accessible/)
  })
})

/**
 * Tests for plain-filesystem read-root access — resolveInsideRoot,
 * readFileFromRoot.
 *
 * These build real file trees under a temp directory and exercise the real
 * `fs` implementation end-to-end: no mocking. The containment checks
 * (path-segment boundary, symlink escape) are the load-bearing behavior
 * here, since a plain directory has none of git's built-in ref-resolution
 * protection that the git-backed read roots get for free.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readFileFromRoot, resolveInsideRoot } from './read-root-fs'

describe('read-root-fs', () => {
  let base: string

  beforeEach(async () => {
    // realpath() the temp dir immediately: on macOS os.tmpdir() sits behind
    // a symlink (/var -> /private/var), and `resolveInsideRoot` compares its
    // root argument (taken as-is, not realpath'd) against a realpath'd
    // candidate. In production every `ReadRoot.path` is pre-resolved via
    // realpath by `loadReadRoots` (src/editor/core/read-roots.ts), so this
    // mirrors that invariant instead of tripping the mismatch. See the
    // "escapes vs. symlinked root" note in the final report.
    base = await realpath(await mkdtemp(join(tmpdir(), 'pt-rrfs-')))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  describe('resolveInsideRoot', () => {
    it('resolves a normal relative path inside the root', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'a.txt'), 'hi\n', 'utf8')

      const r = await resolveInsideRoot(root, 'a.txt')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.absolute).toBe(join(root, 'a.txt'))
    })

    it('refuses "../escape"', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      await writeFile(join(base, 'outside.txt'), 'secret\n', 'utf8')

      const r = await resolveInsideRoot(root, '../outside.txt')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/escapes the read root/)
    })

    it('refuses an absolute path outside the root', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      const outsideFile = join(base, 'outside.txt')
      await writeFile(outsideFile, 'secret\n', 'utf8')

      const r = await resolveInsideRoot(root, outsideFile)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/escapes the read root/)
    })

    it('refuses a sibling directory that merely shares a name prefix (path-segment boundary)', async () => {
      // A plain `startsWith` on the root path would wrongly accept
      // "<base>/repo-secrets" for a root of "<base>/repo" — this is the
      // regression test for the `+ sep` boundary check.
      const root = join(base, 'repo')
      const sibling = join(base, 'repo-secrets')
      await mkdir(root, { recursive: true })
      await mkdir(sibling, { recursive: true })
      await writeFile(join(sibling, 'f.txt'), 'top secret\n', 'utf8')

      const r = await resolveInsideRoot(root, '../repo-secrets/f.txt')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/escapes the read root/)
    })

    it('refuses a symlink inside the root that points outside it', async () => {
      const root = join(base, 'root')
      const outside = join(base, 'outside')
      await mkdir(root, { recursive: true })
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, 'secret.txt'), 'top secret\n', 'utf8')
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))

      const r = await resolveInsideRoot(root, 'link.txt')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/resolves outside the read root/)
    })

    it('returns ok for a path that does not exist yet, so the caller\'s own read produces the real error', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })

      const r = await resolveInsideRoot(root, 'not-yet-created.txt')
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.absolute).toBe(join(root, 'not-yet-created.txt'))
    })
  })

  describe('readFileFromRoot', () => {
    it('reads a real file\'s content and reports the right byte count', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      // Multi-byte characters make byte-count vs char-length assertions
      // meaningfully different.
      const content = 'héllo 🎉\n'
      await writeFile(join(root, 'a.txt'), content, 'utf8')

      const r = await readFileFromRoot(root, 'a.txt', 1024)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.content).toBe(content)
      expect(r.bytes).toBe(Buffer.byteLength(content, 'utf8'))
      expect(r.bytes).not.toBe(content.length)
    })

    it('refuses a file larger than maxBytes, and the error mentions the size', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      const content = 'x'.repeat(20)
      await writeFile(join(root, 'big.txt'), content, 'utf8')

      const r = await readFileFromRoot(root, 'big.txt', 5)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toContain('20')
        expect(r.error).toContain('5')
      }
    })

    it('refuses a directory', async () => {
      const root = join(base, 'root')
      await mkdir(join(root, 'subdir'), { recursive: true })

      const r = await readFileFromRoot(root, 'subdir', 1024)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/directory/)
    })

    it('returns a clear error for a missing file', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })

      const r = await readFileFromRoot(root, 'nope.txt', 1024)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/no such file/)
    })

    it('refuses an escaping path', async () => {
      const root = join(base, 'root')
      await mkdir(root, { recursive: true })
      await writeFile(join(base, 'outside.txt'), 'secret\n', 'utf8')

      const r = await readFileFromRoot(root, '../outside.txt', 1024)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/escapes the read root/)
    })
  })
})

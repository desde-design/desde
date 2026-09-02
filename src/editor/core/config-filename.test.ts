import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  readEditorConfigFile,
} from './config-filename'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pt-cfgname-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readEditorConfigFile', () => {
  it('returns null when neither file exists', async () => {
    expect(await readEditorConfigFile(root)).toBeNull()
  })

  it('reads the current filename', async () => {
    await fs.writeFile(join(root, CONFIG_FILENAME), '{"a":1}')
    const read = await readEditorConfigFile(root)
    expect(read).toMatchObject({ text: '{"a":1}', filename: CONFIG_FILENAME, legacy: false })
  })

  it('still reads a repo written before the rename', async () => {
    // The file is committed to the user's repo. Dropping support would
    // silently lose their read-roots / web policy / Figma setup on upgrade,
    // with no error to explain it.
    await fs.writeFile(join(root, LEGACY_CONFIG_FILENAME), '{"b":2}')
    const read = await readEditorConfigFile(root)
    expect(read).toMatchObject({ text: '{"b":2}', filename: LEGACY_CONFIG_FILENAME, legacy: true })
  })

  it('prefers the current filename outright when both exist', async () => {
    // Merging would make the effective config depend on two places at once.
    await fs.writeFile(join(root, CONFIG_FILENAME), '{"new":true}')
    await fs.writeFile(join(root, LEGACY_CONFIG_FILENAME), '{"old":true}')
    const read = await readEditorConfigFile(root)
    expect(read?.text).toBe('{"new":true}')
    expect(read?.legacy).toBe(false)
  })

  it('propagates a non-ENOENT read error rather than reporting "absent"', async () => {
    // A file that exists but can't be read is a real problem; treating it as
    // "no config" would silently run with defaults.
    await fs.mkdir(join(root, CONFIG_FILENAME))
    await expect(readEditorConfigFile(root)).rejects.toThrow()
  })
})

/**
 * The desktop gate duplicates a slice of the descriptor table, and it has to.
 *
 * `desktop/` is a self-contained TypeScript package: its tsconfig includes
 * `*.ts` and `__tests__/**` and nothing else, and Electron main imports no
 * repo source. So the gate cannot import `PROVIDER_DESCRIPTORS`, and the names
 * of the api-key environment variables live in two places.
 *
 * This test is the join. It reads the gate's SOURCE TEXT and asserts every
 * descriptor's `apiKeyEnvVar` appears in it, so registering a vendor without
 * teaching the desktop gate about it fails here rather than shipping a user a
 * 200MB download they will never run.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PROVIDER_DESCRIPTORS } from './provider-registry'

describe('desktop claude-runtime gate', () => {
  it('names every descriptor api-key environment variable', async () => {
    const source = await readFile('desktop/claude-runtime-gate.ts', 'utf8')
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      expect(
        source.includes(descriptor.credentials.apiKeyEnvVar),
        `desktop/claude-runtime-gate.ts does not know about ${descriptor.id}'s ${descriptor.credentials.apiKeyEnvVar}`,
      ).toBe(true)
    }
  })

  it('names every descriptor id', async () => {
    const source = await readFile('desktop/claude-runtime-gate.ts', 'utf8')
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      expect(source.includes(`'${descriptor.id}'`) || source.includes(`"${descriptor.id}"`), descriptor.id).toBe(true)
    }
  })
})

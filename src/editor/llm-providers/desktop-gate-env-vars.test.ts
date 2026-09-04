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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROVIDER_DESCRIPTORS } from './provider-registry'

// Resolved from this file's own location, not the process cwd — the suite
// that imports this file (root `npm run test`, or `vitest run --root
// editor-cli ...` from a different cwd) must find the same file either way.
// `path.resolve` on the plain file path rather than a relative `new URL(...,
// import.meta.url)` — under the `jsdom` test environment, `URL`'s own
// relative resolution falls back to `http://localhost:3000/...` once the
// `..` segments exceed the base path's depth, silently losing the file:
// scheme.
const GATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../desktop/claude-runtime-gate.ts',
)

async function gateSource(): Promise<string> {
  return readFile(GATE_PATH, 'utf8')
}

describe('desktop claude-runtime gate', () => {
  it('names every descriptor api-key environment variable', async () => {
    const source = await gateSource()
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      expect(
        source.includes(descriptor.credentials.apiKeyEnvVar),
        `desktop/claude-runtime-gate.ts does not know about ${descriptor.id}'s ${descriptor.credentials.apiKeyEnvVar}`,
      ).toBe(true)
    }
  })

  it('names every descriptor id', async () => {
    const source = await gateSource()
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      expect(source.includes(`'${descriptor.id}'`) || source.includes(`"${descriptor.id}"`), descriptor.id).toBe(true)
    }
  })

  it('accepts the same opt-in values as isClaudeSubscriptionOptIn, trimmed', async () => {
    const source = await gateSource()
    expect(source).toMatch(/\["1",\s*"true",\s*"yes",\s*"on"\]/)
    expect(source).toContain('.trim().toLowerCase()')
  })

  it('trims a stored or env credential before checking its length, like isCredentialedFromEnv', async () => {
    const source = await gateSource()
    expect(source).toContain('storedKey = stored[id]?.apiKey?.trim()')
    expect(source).toContain('envKey = env[apiKeyEnvVar]?.trim()')
  })
})

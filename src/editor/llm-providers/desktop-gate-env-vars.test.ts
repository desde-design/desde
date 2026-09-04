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
import { shouldDownloadClaudeRuntime } from '../../../desktop/claude-runtime-gate.js'

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

  it('every NON-Anthropic descriptor api-key var actually decides the download, not just appears in the file', () => {
    // The text-grep test above only proves the STRING is somewhere in the
    // file — a mention in a comment satisfies it too. This proves the var
    // is wired into `NON_ANTHROPIC_PROVIDERS`, the array
    // `shouldDownloadClaudeRuntime` actually consults: setting ONLY that
    // one provider's key must skip the download, the same way setting
    // ONLY `OPENAI_API_KEY` already does.
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      if (descriptor.id === 'anthropic') continue
      const env = { [descriptor.credentials.apiKeyEnvVar]: 'sk-test' }
      expect(
        shouldDownloadClaudeRuntime({ stored: {}, devMode: false, env }),
        `setting only ${descriptor.credentials.apiKeyEnvVar} (${descriptor.id}) did not skip the download — ` +
          `it is not wired into desktop/claude-runtime-gate.ts's NON_ANTHROPIC_PROVIDERS`,
      ).toBe(false)
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

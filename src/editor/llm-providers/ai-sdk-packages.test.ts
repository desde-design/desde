/**
 * Two things this test guards:
 *
 * 1. The AI SDK packages are actually importable and export what
 *    `ai-sdk-*.ts` needs.
 * 2. The installed version of each package still matches the exact pin in
 *    root `package.json`. `ai` and `@ai-sdk/*` shipped two breaking majors in
 *    a year; a version drifting out from under the pin (a stray `npm install
 *    ai@latest`, a lockfile regenerated against a looser range) should fail
 *    a test, not surface as a silent runtime behavior change.
 *
 * `@ai-sdk/openai-compatible` used to be pinned and covered here, with this
 * test as its ONLY importer — a dependency shipped for
 * `ai-sdk-openai-compatible.ts`, a file that does not exist. It was removed
 * 2026-09-04 rather than left behind a knip-silencing import. The branch that
 * lands the Chat Completions transport for other vendors adds it back.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText } from 'ai'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')

async function installedVersion(packageDir: string): Promise<string> {
  const raw = await readFile(join(REPO_ROOT, 'node_modules', packageDir, 'package.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof (parsed as { version: unknown }).version !== 'string'
  ) {
    throw new Error(`node_modules/${packageDir}/package.json has no string "version"`)
  }
  return (parsed as { version: string }).version
}

async function pinnedVersion(dependencyName: string): Promise<string> {
  const raw = await readFile(join(REPO_ROOT, 'package.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || !('dependencies' in parsed)) {
    throw new Error('package.json has no "dependencies" block')
  }
  const dependencies = (parsed as { dependencies: unknown }).dependencies
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new Error('package.json "dependencies" is not an object')
  }
  const pin = (dependencies as Record<string, unknown>)[dependencyName]
  if (typeof pin !== 'string') {
    throw new Error(`package.json dependencies has no string entry for "${dependencyName}"`)
  }
  return pin
}

describe('AI SDK package pins', () => {
  it('exports the functions the ai-sdk-* files will need', () => {
    expect(typeof streamText).toBe('function')
    expect(typeof generateText).toBe('function')
    expect(typeof createOpenAI).toBe('function')
  })

  it.each([
    ['ai', 'ai'],
    ['@ai-sdk/openai', join('@ai-sdk', 'openai')],
  ])('%s is installed at the exact version pinned in package.json', async (dependencyName, packageDir) => {
    const [installed, pinned] = await Promise.all([
      installedVersion(packageDir),
      pinnedVersion(dependencyName),
    ])
    expect(pinned).not.toMatch(/^[\^~]/)
    expect(installed).toBe(pinned)
  })
})

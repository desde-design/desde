/**
 * The AI SDK is allowed in exactly one place.
 *
 * `ai` and `@ai-sdk/*` shipped two breaking majors inside a year. The whole
 * mitigation is that a major bump is a ONE-FILE migration, and the only thing
 * that keeps it one file is this fence. ESLint enforces it at lint time; this
 * test enforces it at test time, because a lint rule that nobody runs on a
 * branch is not a fence.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const AI_SDK_SPECIFIER = String.raw`(ai|ai\/[a-z]+|@ai-sdk\/[^'"]+)`
/**
 * Static `from '…'`, dynamic `import('…')` and `require('…')`.
 *
 * The dynamic forms are here because `no-restricted-imports` does not flag an
 * `import()` expression and this regex used to miss it too — so
 * `const { streamText } = await import('ai')` passed BOTH fences. That is the
 * one shape most likely to be reached for, since the rest of the codebase
 * already loads runtimes lazily (`chat-runtime-dispatch.ts`).
 */
const AI_SDK_IMPORT = new RegExp(
  String.raw`(?:from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]${AI_SDK_SPECIFIER}['"]`,
)

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('AI SDK import boundary', () => {
  it('only src/editor/llm-providers/ai-sdk-*.ts may import `ai` or `@ai-sdk/*`', async () => {
    const roots = ['src', 'editor-cli/src', 'desktop', 'viewer/server']
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of await walk(root)) {
        const base = file.split('/').pop() ?? ''
        const allowed =
          file.includes('src/editor/llm-providers/') &&
          (base.startsWith('ai-sdk-') || base === 'ai-sdk-import-boundary.test.ts')
        if (allowed) continue
        const text = await readFile(file, 'utf8')
        if (AI_SDK_IMPORT.test(text)) offenders.push(file)
      }
    }
    expect(
      offenders,
      'Move the AI SDK usage into src/editor/llm-providers/ai-sdk-*.ts. A major bump must stay a one-file migration.',
    ).toEqual([])
  })

  it('recognises the dynamic forms, not only a static `from`', () => {
    // The regex IS the fence, so its own reach is worth asserting. Every
    // string below passed the original `from '…'`-only version.
    for (const line of [
      "import { streamText } from 'ai'",
      "const { streamText } = await import('ai')",
      'const x = await import("@ai-sdk/openai")',
      "const { generateText } = require('ai')",
      "await import( 'ai/test' )",
    ]) {
      expect(AI_SDK_IMPORT.test(line), line).toBe(true)
    }
    for (const line of [
      "import { thing } from './ai-helpers'",
      "import { plaid } from 'plaid'",
      "const label = 'ai'",
    ]) {
      expect(AI_SDK_IMPORT.test(line), line).toBe(false)
    }
  })
})

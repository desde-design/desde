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

const AI_SDK_IMPORT = /from\s+['"](ai|ai\/[a-z]+|@ai-sdk\/[^'"]+)['"]/

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
})

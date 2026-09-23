/**
 * The Claude Agent SDK is allowed in exactly one place.
 *
 * `@anthropic-ai/claude-agent-sdk` supervises the local `claude` binary for
 * the sidecar chat lane (`src/editor/agent-chat-sidecar/`). Everywhere else
 * that needs an LLM goes through the vendor-neutral `LLMProvider` seam
 * instead (`src/editor/llm-providers/types.ts`), same reasoning as the AI
 * SDK fence in `ai-sdk-import-boundary.test.ts`, which this file is modeled
 * on. ESLint enforces the fence at lint time (`eslint.config.mjs`); this
 * test enforces it at test time, because a lint rule that nobody runs on a
 * branch is not a fence.
 *
 * A `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` counts as an import for
 * this fence too, not just a `from` / `import()` / `require()`: a mock
 * factory has to reproduce the package's export shape (`query`,
 * `createSdkMcpServer`, `tool`), and a major SDK bump can change it exactly
 * like a real import would break. A test outside the sidecar that needs a
 * scripted SDK run imports `queryMock` from
 * `src/editor/agent-chat-sidecar/mock-sdk-query.ts` instead of mocking the
 * package itself.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk'
const ESCAPED_SPECIFIER = SDK_SPECIFIER.replace(/[/]/g, '\\/')

/**
 * Static `from '…'`, dynamic `import('…')`, `require('…')`, and
 * `vi.mock('…', …)` — the last one is not an import in the ES-module sense,
 * but it references the package's exports just as tightly (see the file
 * header), so it is a boundary violation the same way.
 */
const SDK_REFERENCE = new RegExp(
  String.raw`(?:from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]${ESCAPED_SPECIFIER}['"]`,
)

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Root doesn't exist in this checkout (shouldn't happen for the roots
    // below, but fail closed rather than throw a confusing ENOENT).
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full)
  }
  return out
}

function isAllowed(file: string): boolean {
  return (
    file.includes('src/editor/agent-chat-sidecar/') ||
    file === 'editor-cli/src/server/model-catalog-source.ts' ||
    // `llm-boot-graph-sdk-laziness.test.ts` (M1, final-review-report.md) is a
    // second, narrower boundary test in its own right: it proves that
    // model-catalog-source.ts, inherited-llm-env.ts and
    // apply-llm-credentials.ts (served on every process boot, before any
    // provider is chosen) never pull the SDK in through a STATIC import
    // anywhere in their transitive dependency graph — including model-
    // catalog-source.ts itself, where this file's own blanket allowance
    // above would otherwise hide a regression from static back to
    // dynamic-only. It has to `vi.mock` the real specifier to observe that:
    // a source-text grep only sees one file at a time and cannot follow an
    // import chain. Reported as a judgment call in task-30-report.md rather
    // than moved, since relocating a boot-graph regression test for
    // editor-cli files out of editor-cli's own suite would also cut against
    // the "such a check belongs in editor-cli's own suite" convention in
    // CLAUDE.md.
    file === 'editor-cli/src/server/__tests__/llm-boot-graph-sdk-laziness.test.ts'
  )
}

describe('Claude Agent SDK import boundary', () => {
  it('only src/editor/agent-chat-sidecar/** (plus the one dynamic import in model-catalog-source.ts) may reference the SDK', async () => {
    const roots = ['src', 'editor-cli/src', 'desktop']
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of await walk(root)) {
        if (isAllowed(file)) continue
        const text = await readFile(file, 'utf8')
        if (SDK_REFERENCE.test(text)) offenders.push(file)
      }
    }
    expect(
      offenders,
      'Move the Agent SDK usage into src/editor/agent-chat-sidecar/**. A major bump must stay a one-directory migration, and a test that needs a scripted SDK run should import queryMock from mock-sdk-query.ts instead of mocking the package itself.',
    ).toEqual([])
  })

  it('recognises require(), a dynamic import(), and vi.mock(), not only a static `from`', () => {
    for (const line of [
      "import { query } from '@anthropic-ai/claude-agent-sdk'",
      "const { query } = await import('@anthropic-ai/claude-agent-sdk')",
      "const { query } = require('@anthropic-ai/claude-agent-sdk')",
      "vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}))",
      'vi.mock("@anthropic-ai/claude-agent-sdk", () => ({}))',
    ]) {
      expect(SDK_REFERENCE.test(line), line).toBe(true)
    }
    for (const line of [
      "import { thing } from './claude-agent-sdk-provider'",
      "const label = '@anthropic-ai/claude-agent-sdk'",
      "vi.mock('@/lib/editor-fetch', () => ({}))",
    ]) {
      expect(SDK_REFERENCE.test(line), line).toBe(false)
    }
  })
})

/**
 * Verifies that the Editor AI tiers fold the project-knowledge digest into
 * their prompts: the deterministic patch engine (`buildPatchPrompt`) must
 * (a) carry the shared precedence guidance in its system prompt always, and
 * (b) surface the conventions block only when a digest is provided.
 *
 * The chat agent's own project-knowledge folding is covered by
 * `agent-chat-sdk/system-prompt.test.ts` (`buildSdkSystemPrompt`) — the
 * legacy in-house chat orchestrator's `buildChatSystemPrompt` was removed
 * 2026-07-21 along with the rest of the legacy runtime. The former Tier 3
 * free-form-prompt agent (`buildAgentPrompt` / `POST /api/editor/agent`)
 * was decommissioned as a dead route (zero callers) — see
 * `.superpowers/sdd/editor-audit-fixes-plan/task-2-report.md`. The single-shot
 * repair builder this file used to also cover here (`buildRepairPrompt`) was
 * removed with the rest of the repair lane 2026-09-08.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectKnowledge } from '@/editor/core/project-knowledge'
import { buildPatchPrompt } from './llm-patch-prompt'
import { PROJECT_KNOWLEDGE_GUIDANCE } from './render-project-knowledge'

const KNOWLEDGE: ProjectKnowledge = {
  rules: '----- CLAUDE.md -----\nNever use class components.',
  rulesFiles: [{ path: 'CLAUDE.md', chars: 50, truncated: false }],
  docIndex: [{ path: 'docs/arch.md', title: 'Architecture' }],
  truncated: false,
}

const STYLE_CONTEXT = {
  tokens: [],
  classTaxonomy: [] as string[],
  preprocessor: 'css' as const,
}
const SAMPLE_SFC = '<template><div>hi</div></template>\n'

describe('buildPatchPrompt — project knowledge', () => {
  it('always carries the precedence guidance in the cached system block', () => {
    const out = buildPatchPrompt({
      file: 'x.vue',
      originalSource: SAMPLE_SFC,
      mutations: [],
      projectStyleContext: STYLE_CONTEXT,
    })
    expect(out.systemBlocks[0].text).toContain(PROJECT_KNOWLEDGE_GUIDANCE)
  })

  it('inserts a cached conventions block when a digest is provided', () => {
    const out = buildPatchPrompt({
      file: 'x.vue',
      originalSource: SAMPLE_SFC,
      mutations: [],
      projectStyleContext: STYLE_CONTEXT,
      projectKnowledge: KNOWLEDGE,
    })
    const conventionsBlock = out.userContent.find((b) =>
      b.text.includes('# Project conventions'),
    )
    expect(conventionsBlock).toBeDefined()
    expect(conventionsBlock!.text).toContain('Never use class components.')
    expect(conventionsBlock!.cache_control).toEqual({ type: 'ephemeral' })
    // It sits before the source block.
    const convIdx = out.userContent.indexOf(conventionsBlock!)
    const srcIdx = out.userContent.findIndex((b) => b.text.includes('Original source'))
    expect(convIdx).toBeLessThan(srcIdx)
  })

  it('adds no conventions block when no digest is provided', () => {
    const out = buildPatchPrompt({
      file: 'x.vue',
      originalSource: SAMPLE_SFC,
      mutations: [],
      projectStyleContext: STYLE_CONTEXT,
    })
    expect(
      out.userContent.some((b) => b.text.includes('# Project conventions')),
    ).toBe(false)
  })
})

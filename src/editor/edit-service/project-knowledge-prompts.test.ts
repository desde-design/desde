/**
 * Verifies that the Editor AI tiers fold the project-knowledge digest
 * into their prompts: the deterministic patch engine (`buildPatchPrompt`)
 * and the Tier 2 repair builder. Each must (a) carry the shared precedence
 * guidance in its system prompt always, and (b) surface the conventions
 * block only when a digest is provided.
 *
 * The chat agent's own project-knowledge folding is covered by
 * `agent-chat-sdk/system-prompt.test.ts` (`buildSdkSystemPrompt`) — the
 * legacy in-house chat orchestrator's `buildChatSystemPrompt` was removed
 * 2026-07-21 along with the rest of the legacy runtime. The former Tier 3
 * free-form-prompt agent (`buildAgentPrompt` / `POST /api/editor/agent`)
 * was decommissioned as a dead route (zero callers) — see
 * `.superpowers/sdd/editor-audit-fixes-plan/task-2-report.md`.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectKnowledge } from '@/editor/core/project-knowledge'
import { buildPatchPrompt } from './llm-patch-prompt'
import { PROJECT_KNOWLEDGE_GUIDANCE } from './render-project-knowledge'
import { buildRepairPrompt } from './repair-edit-prompt'

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

describe('buildRepairPrompt — project knowledge', () => {
  it('always appends the precedence guidance to the system prompt', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'compile failed',
    })
    expect(out.system).toContain(PROJECT_KNOWLEDGE_GUIDANCE)
  })

  it('inlines the conventions block in the user message when a digest is provided', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'compile failed',
      projectKnowledge: KNOWLEDGE,
    })
    expect(out.user).toContain('# Project conventions')
    expect(out.user).toContain('Never use class components.')
  })

  it('omits the conventions block when no digest is provided', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'compile failed',
    })
    expect(out.user).not.toContain('# Project conventions')
  })
})

describe('buildRepairPrompt — destination clause', () => {
  it('omits the Destination: line when destParent coords are absent', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: { kind: 'move', description: 'Move <KInputSwitch>', sourceLine: 5, sourceColumn: 3 },
      errorReason: 'compile failed',
    })
    expect(out.user).not.toMatch(/^Destination:/m)
  })

  it('emits the parent anchor + 0-based index when destParent + non-negative destIndex are provided', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: {
        kind: 'move',
        description: 'Move <KInputSwitch>',
        sourceLine: 5,
        sourceColumn: 3,
        destParentLine: 20,
        destParentColumn: 9,
        destIndex: 0,
      },
      errorReason: 'compile failed',
    })
    expect(out.user).toMatch(/Destination: place the element as a child of the parent whose start tag is at line 20, column 9, at child index 0/)
    expect(out.user).toContain('MUST end up as a descendant of that parent')
  })

  it('renders negative destIndex as "appended at the end" instead of a literal -1', () => {
    const out = buildRepairPrompt({
      file: 'x.vue',
      source: SAMPLE_SFC,
      intent: {
        kind: 'move',
        description: 'Move <KInputSwitch>',
        destParentLine: 20,
        destParentColumn: 9,
        destIndex: -1,
      },
      errorReason: 'compile failed',
    })
    expect(out.user).toContain('appended at the end')
    expect(out.user).not.toContain('child index -1')
  })
})

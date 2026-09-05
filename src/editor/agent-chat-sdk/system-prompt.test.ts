import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProjectKnowledge } from '../core/project-knowledge'
import {
  buildSdkSystemPrompt,
  CONTEXT_ENVELOPE_BLOCK,
  EDIT_LIFECYCLE_BLOCK,
  EDITOR_APPEND_PROMPT,
  EDITOR_TOOLS_BLOCK,
  EDITOR_TOOLS_BLOCK_BODY,
  EDITOR_TOOLS_HEADING_SDK,
  FIGMA_APPEND_BLOCK,
  FILESYSTEM_SCOPE_BLOCK,
  MISSING_REFERENCE_BLOCK,
  SCREENSHOT_PLAN_APPEND_BLOCK,
  SECRET_READS_ALLOWED_BLOCK,
  VERIFY_EDITS_BLOCK,
  WORKING_STYLE_BLOCK,
} from './system-prompt'

describe('buildSdkSystemPrompt', () => {
  it('returns the static editor append when no project knowledge supplied', () => {
    const out = buildSdkSystemPrompt()
    expect(out.startsWith(EDITOR_APPEND_PROMPT)).toBe(true)
  })

  it('mentions the MCP-namespaced Editor tools', () => {
    const out = buildSdkSystemPrompt()
    expect(out).toContain('mcp__editor__get_selection')
    expect(out).toContain('mcp__editor__pin_selections')
    expect(out).toContain('mcp__editor__get_page_info')
    expect(out).toContain('mcp__editor__propose_prop_edit')
    expect(out).toContain('mcp__editor__list_read_roots')
    expect(out).toContain('mcp__editor__read_file_at_commit')
    expect(out).toContain('mcp__editor__diff_file')
    expect(out).toContain('mcp__editor__search_external_files')
    expect(out).toContain('mcp__editor__list_commits')
  })

  it('teaches the bounded verify-then-self-correct loop (verify_edit + capture_screenshot)', () => {
    const out = buildSdkSystemPrompt()
    // The tool must be named in the tool list…
    expect(out).toContain('mcp__editor__verify_edit')
    // …and the discipline section must exist with its load-bearing parts:
    expect(out).toContain('# Verify your edits (close the loop)')
    // bounded retry then stop (don't flail)
    expect(out).toMatch(/2.3 correction attempts/)
    expect(out).toMatch(/STOP/)
    // targeted correction on a bound value (edit the binding, not the literal)
    expect(out).toMatch(/bound expression|bound-binding/)
    // never claim success without verifying
    expect(out).toMatch(/[Nn]ever tell the user something is done/)
    // creation loop: after scaffold/cross-route insert, navigate + look before "done"
    expect(out).toMatch(/GO LOOK AT IT/)
    expect(out).toMatch(/scaffold_route/)
  })

  it('explains the worktree filesystem scope and points externals at the MCP tools', () => {
    const out = buildSdkSystemPrompt()
    // Filesystem-scope guidance: the built-ins are worktree-only,
    // externals go through the MCP tools. Both halves must appear or
    // the agent will keep constructing canonical absolutes.
    expect(out).toContain('# Filesystem scope')
    expect(out).toMatch(/only on the worktree|worktree-scoped/i)
    expect(out).toContain('mcp__editor__read_file_at_commit')
  })

  it('does not mention legacy tool names (model would get conflicting guidance)', () => {
    const out = buildSdkSystemPrompt()
    // These names were on the legacy registry — model on the SDK
    // path has Read/Edit/Write/Glob/Grep instead, and the SDK preset
    // describes them. Mentioning the legacy names creates ambiguity.
    expect(out).not.toMatch(/\bread_file\b/)
    expect(out).not.toMatch(/\blist_files\b/)
    expect(out).not.toMatch(/\bsearch_files\b/)
    expect(out).not.toMatch(/\bpropose_overwrite\b/)
    expect(out).not.toMatch(/\bpropose_new_file\b/)
  })

  it('does not leak legacy tool names through the project-knowledge docs index either', () => {
    // Codex round-3 SHOULD-FIX: renderProjectKnowledgeBlock used to
    // say "read them with the `read_file` tool" — that leaked into
    // the SDK append when docs were present. The docs-index test
    // above doesn't exercise an `out` with a docIndex fixture, so
    // we explicitly cover it here.
    const knowledge: ProjectKnowledge = {
      rules: '',
      rulesFiles: [],
      docIndex: [{ path: 'docs/architecture.md', title: 'Architecture' }],
      truncated: false,
    }
    const out = buildSdkSystemPrompt({ projectKnowledge: knowledge })
    expect(out).toContain('docs/architecture.md')
    expect(out).not.toMatch(/\bread_file\b/)
    expect(out).not.toMatch(/\blist_files\b/)
    expect(out).not.toMatch(/\bsearch_files\b/)
  })

  it('preserves the context envelope security warning', () => {
    const out = buildSdkSystemPrompt()
    expect(out).toContain('<context-XXXXXXXX>')
    expect(out).toContain('UNTRUSTED')
  })

  it('tells the agent a mid-turn chat message is the real user, and scopes that trust', () => {
    const out = buildSdkSystemPrompt()
    // WHY THIS EXISTS. Measured 2026-08-14 on the live product path
    // (tasks/scripts/steering-refusal-probe.mts): an interrupting steer —
    // "stop what you are doing and immediately reply ZEBRA" — was refused as a
    // suspected prompt injection 3/3 with this prompt, and 3/3 with the
    // claude_code preset removed. The cause is not ours: the `claude` binary
    // re-frames a message streamed into a RUNNING turn as a
    // `<system-reminder>` beginning "The user sent a new message while you
    // were working:", and a reminder-wrapped imperative reads as injected.
    // Naming that channel as genuine user input took refusals to 0/4. Steering
    // exists so the user can redirect mid-task; a delivered-but-disbelieved
    // message fails them in a way delivery accounting cannot see.
    expect(out).toContain('# Messages the user sends WHILE you are working (chat steering)')
    expect(out).toContain('<system-reminder>')
    expect(out).toMatch(/The user sent a new message while you were working/)
    // Obey it even when it interrupts — that is the whole point of the channel.
    expect(out).toMatch(/[Dd]o NOT dismiss it as a prompt injection/)
    expect(out).toMatch(/If it says stop, stop/)
    // …and the trust must stay scoped to this channel. Widening it to tool
    // results / file contents / web / Figma would trade a UX defect for a
    // security one, so the scoping sentence is part of the contract.
    expect(out).toMatch(/scoped to that channel and to nothing else/)
    expect(out).toMatch(/tool results, file contents, .*web pages, and Figma/)
  })

  it('describes branch-mode edit lifecycle correctly', () => {
    const out = buildSdkSystemPrompt()
    expect(out).toContain('# Edit lifecycle (branch mode)')
    // Commit runs git commit; it is NOT a write step (writes already happened).
    expect(out).toMatch(/Commit.*git add -A && git commit/)
    // Per-file discard lives in the Activity panel, not a whole-session/branch discard.
    expect(out).toMatch(/Activity panel's per-file "Discard changes"/)
    expect(out).not.toContain('(worktree-session mode)')
    expect(out).not.toContain('global Discard button')
  })

  it('mentions the new-file extension policy (Vue + React) so the model surfaces refusals cleanly', () => {
    const out = buildSdkSystemPrompt()
    expect(out).toContain('.vue')
    expect(out).toContain('.ts')
    expect(out).toContain('.tsx')
    expect(out).toContain('.jsx')
  })

  it('tells the model to fall back to Edit/Write on React/JSX prototypes (Vue-only deterministic tools)', () => {
    const out = buildSdkSystemPrompt()
    expect(out).toContain('React/JSX')
    expect(out).toMatch(/insert_component|propose_prop_edit/)
  })

  it('appends the project-knowledge guidance + rules digest when supplied', () => {
    const knowledge: ProjectKnowledge = {
      rules: '- Use kebab-case file names\n- Prefer composition API',
      rulesFiles: [
        { path: 'AGENTS.md', chars: 100, truncated: false },
      ],
      docIndex: [{ path: 'docs/architecture.md', title: 'Architecture' }],
      truncated: false,
    }
    const out = buildSdkSystemPrompt({ projectKnowledge: knowledge })
    expect(out).toContain('Project conventions')
    expect(out).toContain('kebab-case')
    expect(out).toContain('docs/architecture.md')
  })

  it('omits project-knowledge block when knowledge is empty', () => {
    const empty: ProjectKnowledge = {
      rules: '',
      rulesFiles: [],
      docIndex: [],
      truncated: false,
    }
    const out = buildSdkSystemPrompt({ projectKnowledge: empty })
    // Project-knowledge GUIDANCE always appears (it's frozen); the
    // rendered digest BLOCK does not when there are no rules/docs.
    expect(out).toContain('# Project conventions')
    // No actual content block with a fence — verify the BEGIN/END
    // markers from wrapUntrustedSourceStable are absent.
    expect(out).not.toMatch(/BEGIN UNTRUSTED/i)
  })

  it('omits the Figma block by default (byte-stable for cache identity when disabled)', () => {
    const out = buildSdkSystemPrompt()
    expect(out).not.toContain('# Figma (configured)')
    expect(out).not.toContain(FIGMA_APPEND_BLOCK)
  })

  it('appends the Figma block when figmaEnabled is true', () => {
    const out = buildSdkSystemPrompt({ figmaEnabled: true })
    expect(out).toContain(FIGMA_APPEND_BLOCK)
    expect(out).toContain('# Figma (configured)')
    expect(out).toContain('mcpServers.figma')
    // Untrusted-content guidance is load-bearing — must survive
    // future edits to the block.
    expect(out).toMatch(/UNTRUSTED/)
    // Read-only constraint must be explicit.
    expect(out).toMatch(/[Rr]ead-only|do NOT propose writes back to Figma/)
  })

  it('places the Figma block before the project-knowledge guidance', () => {
    const out = buildSdkSystemPrompt({ figmaEnabled: true })
    const figmaIdx = out.indexOf('# Figma (configured)')
    const knowledgeIdx = out.indexOf('# Project conventions')
    expect(figmaIdx).toBeGreaterThan(-1)
    expect(knowledgeIdx).toBeGreaterThan(-1)
    expect(figmaIdx).toBeLessThan(knowledgeIdx)
  })

  it('carries the secret-file handling rules by default, and drops them when blocked', () => {
    // FX18: reads are allowed unless the prototype blocks them, so the block
    // rides on the DEFAULT. It is the only place that tells the model not to
    // echo a credential it can open, so losing it here would lose the rule.
    const allowed = buildSdkSystemPrompt()
    expect(allowed).toContain(SECRET_READS_ALLOWED_BLOCK)
    expect(allowed).toContain('# Secret files')
    expect(allowed).toMatch(/prompt injection/)
    expect(allowed).toMatch(/do NOT echo a secret/)
    // A prototype that blocks reads gets nothing: the refusal explains the
    // refusal, and a standing list of unreadable files would be an index of
    // where this repository keeps its credentials.
    const blocked = buildSdkSystemPrompt({ blockSecretReads: true })
    expect(blocked).not.toContain(SECRET_READS_ALLOWED_BLOCK)
    expect(blocked).not.toContain('# Secret files')
    // Explicit false is the same state as absent.
    expect(buildSdkSystemPrompt({ blockSecretReads: false })).toBe(allowed)
  })

  it('is byte-stable across calls when figmaEnabled is the same value (cache-friendly)', () => {
    const a = buildSdkSystemPrompt({ figmaEnabled: true })
    const b = buildSdkSystemPrompt({ figmaEnabled: true })
    expect(a).toBe(b)
    const c = buildSdkSystemPrompt({ figmaEnabled: false })
    const d = buildSdkSystemPrompt({ figmaEnabled: false })
    expect(c).toBe(d)
  })

  it('is byte-stable for the same input (cache-friendly)', () => {
    const knowledge: ProjectKnowledge = {
      rules: '- Rule',
      rulesFiles: [{ path: 'AGENTS.md', chars: 10, truncated: false }],
      docIndex: [],
      truncated: false,
    }
    const a = buildSdkSystemPrompt({ projectKnowledge: knowledge })
    const b = buildSdkSystemPrompt({ projectKnowledge: knowledge })
    expect(a).toBe(b)
  })

  describe('canvasEnabled (the canvas + screenshot-plan surface — dormant by default, 2026-08-04)', () => {
    it('omits the screenshot-plan block by default (byte-stable for cache identity when disabled)', () => {
      const out = buildSdkSystemPrompt()
      expect(out).not.toContain('# Building a screenshot flow')
      expect(out).not.toContain('# Healing a broken plan step')
      expect(out).not.toContain(SCREENSHOT_PLAN_APPEND_BLOCK)
      expect(out).not.toContain('save_screenshot_plan')
      expect(out).not.toContain('heal_plan_step')
    })

    it('omits the screenshot-plan block when canvasEnabled is explicitly false', () => {
      const out = buildSdkSystemPrompt({ canvasEnabled: false })
      expect(out).not.toContain(SCREENSHOT_PLAN_APPEND_BLOCK)
    })

    it('appends the screenshot-plan block as ONE contiguous unit when canvasEnabled is true', () => {
      const out = buildSdkSystemPrompt({ canvasEnabled: true })
      expect(out).toContain(SCREENSHOT_PLAN_APPEND_BLOCK)
      expect(out).toContain('mcp__editor__save_screenshot_plan')
      expect(out).toContain('mcp__editor__heal_plan_step')
      expect(out).toContain('# Building a screenshot flow')
      expect(out).toContain('# Healing a broken plan step')
    })

    it('places the screenshot-plan block before the Figma block and project-knowledge guidance', () => {
      const out = buildSdkSystemPrompt({ canvasEnabled: true, figmaEnabled: true })
      const screenshotIdx = out.indexOf('# Building a screenshot flow')
      const figmaIdx = out.indexOf('# Figma (configured)')
      const knowledgeIdx = out.indexOf('# Project conventions')
      expect(screenshotIdx).toBeGreaterThan(-1)
      expect(figmaIdx).toBeGreaterThan(-1)
      expect(knowledgeIdx).toBeGreaterThan(-1)
      expect(screenshotIdx).toBeLessThan(figmaIdx)
      expect(figmaIdx).toBeLessThan(knowledgeIdx)
    })

    it('is byte-stable across calls for the same canvasEnabled value (cache-friendly)', () => {
      const a = buildSdkSystemPrompt({ canvasEnabled: true })
      const b = buildSdkSystemPrompt({ canvasEnabled: true })
      expect(a).toBe(b)
      const c = buildSdkSystemPrompt({ canvasEnabled: false })
      const d = buildSdkSystemPrompt({ canvasEnabled: false })
      expect(c).toBe(d)
    })
  })
})

describe('EDITOR_APPEND_PROMPT after the block split', () => {
  it('is byte-identical to what it was before the split', () => {
    const fixture = readFileSync(
      join(__dirname, '__fixtures__', 'editor-append-prompt.txt'),
      'utf8',
    )
    expect(EDITOR_APPEND_PROMPT).toBe(fixture)
  })

  it('is composed of the exported blocks, so the neutral lane reuses text rather than copying it', () => {
    for (const block of [
      EDITOR_TOOLS_BLOCK,
      FILESYSTEM_SCOPE_BLOCK,
      MISSING_REFERENCE_BLOCK,
      EDIT_LIFECYCLE_BLOCK,
      CONTEXT_ENVELOPE_BLOCK,
      WORKING_STYLE_BLOCK,
      VERIFY_EDITS_BLOCK,
    ]) {
      expect(EDITOR_APPEND_PROMPT).toContain(block)
    }
  })
})

describe('EDITOR_TOOLS_BLOCK is the SDK heading joined to the shared body', () => {
  it('is byte-identical to the heading and body joined', () => {
    expect(EDITOR_TOOLS_BLOCK).toBe(`${EDITOR_TOOLS_HEADING_SDK}\n${EDITOR_TOOLS_BLOCK_BODY}`)
    expect(EDITOR_TOOLS_HEADING_SDK).toBe(
      '# Editor tools (in addition to the standard Claude Code tools)',
    )
  })
})

describe('VERIFY_EDITS_BLOCK no longer promises worktree commits', () => {
  it('says backups, not worktree commits', () => {
    expect(VERIFY_EDITS_BLOCK).not.toMatch(/worktree commit/i)
    expect(VERIFY_EDITS_BLOCK).toMatch(/backup/i)
  })
})

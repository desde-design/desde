import { describe, expect, it } from 'vitest'

import { ALLOWED_NEW_FILE_EXTENSIONS } from '../agent-chat-sdk/edit-ack'
import {
  CONTEXT_ENVELOPE_BLOCK,
  EDITOR_TOOLS_BLOCK_BODY,
  GROUNDING_QUERY_TOOLS_BLOCK,
  SCREENSHOT_PLAN_APPEND_BLOCK,
  VERIFY_EDITS_BLOCK,
} from '../agent-chat-sdk/system-prompt'
import {
  buildNeutralSystemPrompt,
  NEUTRAL_IDENTITY_BLOCK,
  NEUTRAL_INVESTIGATE_BLOCK,
  NEUTRAL_STEERING_BLOCK,
  neutralBuiltinToolsBlock,
} from './system-prompt-neutral'

describe('buildNeutralSystemPrompt', () => {
  it('states an identity, which the SDK preset used to supply for free', () => {
    expect(buildNeutralSystemPrompt({})).toContain('You are the Desde editing agent')
  })

  it('describes the read-only built-ins by name', () => {
    const p = buildNeutralSystemPrompt({})
    for (const name of ['Read', 'Glob', 'Grep', 'TodoWrite']) {
      expect(p).toMatch(new RegExp(`^- \`${name}\``, 'm'))
    }
  })

  it('does not describe Write or Edit when the write tools are off', () => {
    const p = buildNeutralSystemPrompt({})
    expect(p).not.toMatch(/^- `Write`/m)
    expect(p).not.toMatch(/^- `Edit`/m)
  })

  it('describes Write and Edit when they are on, with the uniqueness rule spelled out', () => {
    const p = buildNeutralSystemPrompt({ writeToolsEnabled: true })
    expect(p).toMatch(/^- `Edit`/m)
    expect(p).toContain('must appear EXACTLY ONCE')
  })

  it('interpolates the SAME extension set the gate enforces', () => {
    const p = buildNeutralSystemPrompt({ writeToolsEnabled: true })
    for (const ext of ALLOWED_NEW_FILE_EXTENSIONS) {
      expect(p).toContain(`\`${ext}\``)
    }
  })

  it('reuses the editor-tool catalogue body and the envelope and verification blocks verbatim', () => {
    const p = buildNeutralSystemPrompt({})
    // The BODY is shared verbatim; the heading is this lane's own (it must
    // not name Claude Code — see the heading test below).
    expect(p).toContain(EDITOR_TOOLS_BLOCK_BODY)
    expect(p).toContain(CONTEXT_ENVELOPE_BLOCK)
    expect(p).toContain(VERIFY_EDITS_BLOCK)
  })

  it('never names another vendor\'s product in a heading', () => {
    const p = buildNeutralSystemPrompt({})
    for (const line of p.split('\n').filter((l) => l.startsWith('#'))) {
      expect(line).not.toMatch(/Claude Code/)
    }
  })

  it('does not claim that attempts are worktree commits', () => {
    expect(buildNeutralSystemPrompt({})).not.toMatch(/worktree commit/i)
  })

  it('tells the model to investigate the repo before asking for a selection', () => {
    const p = buildNeutralSystemPrompt({})
    expect(p).toMatch(/no selection|nothing is selected/i)
    expect(p).toMatch(/Glob|Grep|Read/)
    // The instruction has to be an imperative about what to do FIRST, not a caveat.
    expect(p).toMatch(/before asking/i)
  })

  it('never offers WebFetch or WebSearch, which this lane does not serve', () => {
    const p = buildNeutralSystemPrompt({ writeToolsEnabled: true })
    expect(p).not.toContain('Web tools')
    expect(p).not.toContain('WebSearch')
    // The single surviving WebFetch mention is inside the reused editor-tool
    // catalogue, where `download_asset` names the host allowlist it shares.
    // That is a rule about which hosts an image may come from, not an offer of
    // a tool. The block is byte-frozen, so it cannot be reworded here.
    expect(p.match(/WebFetch/g) ?? []).toHaveLength(1)
    expect(p).toContain('only from a host already allowlisted for WebFetch')
  })

  it('describes steering as boundary delivery, not as a system reminder', () => {
    const p = buildNeutralSystemPrompt({})
    expect(p).toContain('Delivery lands between steps')
    expect(p).not.toContain('system-reminder')
  })

  it('appends the grounding and canvas blocks only when those surfaces are on', () => {
    expect(buildNeutralSystemPrompt({})).not.toContain(GROUNDING_QUERY_TOOLS_BLOCK)
    expect(buildNeutralSystemPrompt({ groundingEnabled: true })).toContain(
      GROUNDING_QUERY_TOOLS_BLOCK,
    )
    expect(buildNeutralSystemPrompt({})).not.toContain(SCREENSHOT_PLAN_APPEND_BLOCK)
    expect(buildNeutralSystemPrompt({ canvasEnabled: true })).toContain(
      SCREENSHOT_PLAN_APPEND_BLOCK,
    )
  })

  it('puts disabled capabilities last, where they cannot invalidate the stable prefix', () => {
    const p = buildNeutralSystemPrompt({ disabledCapabilities: '# Off right now\nNothing.' })
    expect(p.endsWith('# Off right now\nNothing.')).toBe(true)
  })

  it('is byte-stable for the same options', () => {
    expect(buildNeutralSystemPrompt({ writeToolsEnabled: true })).toBe(
      buildNeutralSystemPrompt({ writeToolsEnabled: true }),
    )
  })

  it('uses no em dash and no first person in the blocks this lane authors', () => {
    const authored = [
      NEUTRAL_IDENTITY_BLOCK,
      neutralBuiltinToolsBlock({ writeToolsEnabled: true }),
      NEUTRAL_STEERING_BLOCK,
      NEUTRAL_INVESTIGATE_BLOCK,
    ].join('\n\n')
    expect(authored).not.toContain('—')
    expect(authored).not.toMatch(/\b(I|I'm|I've|my|mine)\b/)
  })
})

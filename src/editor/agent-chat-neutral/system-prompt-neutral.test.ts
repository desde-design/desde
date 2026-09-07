import { describe, expect, it } from 'vitest'

import { ALLOWED_NEW_FILE_EXTENSIONS } from '../agent-chat-sdk/edit-ack'
import {
  CONTEXT_ENVELOPE_BLOCK,
  EDITOR_TOOLS_BLOCK_BODY,
  GROUNDING_QUERY_TOOLS_BLOCK,
  SCREENSHOT_PLAN_APPEND_BLOCK,
  SECRET_READS_ALLOWED_BLOCK,
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

  it('tells the model a stale write is REFUSED, which is what this lane does', () => {
    // 2026-09-04 adversarial review, P3-3. The sentence used to say the write
    // "still lands", which is the SDK lane's auto-apply contract. On this lane
    // `builtin-edit.ts`'s precondition refuses it, so the model was being told
    // the opposite of what happens and had no reason to re-read the file.
    const p = buildNeutralSystemPrompt({ writeToolsEnabled: true })
    expect(p).not.toContain('your write still lands')
    expect(p).toContain('the write is REFUSED and nothing is modified')
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

  it('carries the secret-file handling rules by default, and drops them when blocked', () => {
    // Same condition as the SDK lane, and the same imported block, so one
    // policy cannot be described two ways.
    expect(buildNeutralSystemPrompt({})).toContain(SECRET_READS_ALLOWED_BLOCK)
    expect(buildNeutralSystemPrompt({ blockSecretReads: false })).toContain(
      SECRET_READS_ALLOWED_BLOCK,
    )
    expect(buildNeutralSystemPrompt({ blockSecretReads: true })).not.toContain(
      SECRET_READS_ALLOWED_BLOCK,
    )
  })

  it('puts disabled capabilities last, where they cannot invalidate the stable prefix', () => {
    const p = buildNeutralSystemPrompt({ disabledCapabilities: '# Off right now\nNothing.' })
    expect(p.endsWith('# Off right now\nNothing.')).toBe(true)
  })

  it('is byte-stable for the same options', () => {
    // A pure builder called twice with identical input is deterministic by
    // construction — this guards only against something sneaking in that
    // ISN'T pure (a timestamp, `Math.random()`, iteration over a `Set`/`Map`
    // in an order that isn't guaranteed). It says nothing about the prefix
    // staying stable across DIFFERENT options — see the next test for that.
    expect(buildNeutralSystemPrompt({ writeToolsEnabled: true })).toBe(
      buildNeutralSystemPrompt({ writeToolsEnabled: true }),
    )
  })

  it('the stable prefix is unaffected by a change in disabledCapabilities', () => {
    // The regression this guards: `disabledCapabilities` sits LAST (pinned
    // above, "puts disabled capabilities last") specifically so that a
    // volatile, per-turn block cannot invalidate anything earlier — a
    // vendor prompt cache keyed on a stable prefix survives a turn where
    // only which capabilities are disabled has changed. Comparing the
    // builder with itself (the previous test) cannot catch a regression
    // where some OTHER option's formatting accidentally depends on
    // `disabledCapabilities` too; only a comparison across two DIFFERENT
    // values can.
    const shortSuffix = '# Off right now\nNothing.'
    const longerSuffix =
      '# Off right now\nSomething else entirely, deliberately a different length.'
    const a = buildNeutralSystemPrompt({
      writeToolsEnabled: true,
      disabledCapabilities: shortSuffix,
    })
    const b = buildNeutralSystemPrompt({
      writeToolsEnabled: true,
      disabledCapabilities: longerSuffix,
    })
    expect(a.endsWith(shortSuffix)).toBe(true)
    expect(b.endsWith(longerSuffix)).toBe(true)
    const prefixA = a.slice(0, a.length - shortSuffix.length)
    const prefixB = b.slice(0, b.length - longerSuffix.length)
    expect(prefixA).toBe(prefixB)
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

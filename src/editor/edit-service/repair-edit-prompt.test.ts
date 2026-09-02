/**
 * Tests for `buildRepairPrompt` — verifies the system prompt and user-message
 * labels are selected by framework (file extension), and that the security
 * wrapper + anchor/destination framing are present regardless of framework.
 */

import { describe, expect, it } from 'vitest'
import { buildRepairPrompt } from './repair-edit-prompt'

describe('buildRepairPrompt — framework selection', () => {
  const base = {
    source: 'const x = 1\n',
    intent: { kind: 'delete' as const, description: 'Delete <li>', sourceLine: 10, sourceColumn: 8 },
    errorReason: 'No JSX element found at 10:8',
  }

  it('uses the Vue SFC system prompt for .vue files', () => {
    const { system, user } = buildRepairPrompt({ ...base, file: 'src/App.vue' })
    expect(system).toMatch(/Vue 3 SFC repair assistant/)
    expect(system).toMatch(/@vue\/compiler-dom/)
    expect(user).toMatch(/Original SFC source/)
    expect(user).toMatch(/Compiler refusal:/)
  })

  it('uses the React TSX system prompt for .tsx files (TypeScript allowed)', () => {
    const { system, user } = buildRepairPrompt({ ...base, file: 'src/App.tsx' })
    expect(system).toMatch(/React \(TSX\) repair assistant/)
    expect(system).toMatch(/jsx \+ typescript plugins/)
    expect(system).not.toMatch(/Vue 3 SFC repair assistant/)
    // .tsx must NOT carry the "do not use TypeScript syntax" rule.
    expect(system).not.toMatch(/do NOT use TypeScript syntax/)
    expect(user).toMatch(/Original source/)
    expect(user).toMatch(/Parser refusal:/)
  })

  it('uses the React JSX system prompt for .jsx files and forbids TypeScript syntax', () => {
    const { system } = buildRepairPrompt({ ...base, file: 'src/components/Card.jsx' })
    expect(system).toMatch(/React \(JSX\) repair assistant/)
    // jsx plugin only — no typescript plugin promised, and TS syntax forbidden.
    expect(system).toMatch(/jsx plugin/)
    expect(system).not.toMatch(/jsx \+ typescript plugins/)
    expect(system).toMatch(/do NOT use TypeScript syntax/)
  })

  it('forwards the anchor and refusal reason into the user message', () => {
    const { user } = buildRepairPrompt({ ...base, file: 'src/App.tsx' })
    expect(user).toMatch(/Anchor: line 10, column 8\./)
    expect(user).toMatch(/No JSX element found at 10:8/)
    // The untrusted source is wrapped in randomized BEGIN/END markers.
    expect(user).toMatch(/BEGIN/)
  })
})

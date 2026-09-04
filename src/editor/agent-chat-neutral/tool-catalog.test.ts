import { describe, expect, it } from 'vitest'

import { buildNeutralToolCatalog } from './tool-catalog'

const base = {
  worktreeRoot: '/tmp/whatever',
  editorToolOpts: {
    bridge: { send: async () => null },
    emitEdit: async () => ({ ok: true as const, editId: 'e1' }),
    worktreeRoot: '/tmp/whatever',
  },
}

describe('buildNeutralToolCatalog', () => {
  it('namespaces the editor tools exactly as the SDK lane does', () => {
    const names = buildNeutralToolCatalog(base as never).map((s) => s.name)
    expect(names).toContain('mcp__editor__get_selection')
    expect(names).toContain('mcp__editor__propose_prop_edit')
  })

  it('leaves the built-ins bare', () => {
    const names = buildNeutralToolCatalog(base as never).map((s) => s.name)
    expect(names).toContain('Read')
    expect(names).toContain('Glob')
    expect(names).toContain('Grep')
    expect(names).toContain('TodoWrite')
  })

  it('offers no WebFetch and no WebSearch, which this lane cannot serve', () => {
    const names = buildNeutralToolCatalog(base as never).map((s) => s.name)
    expect(names).not.toContain('WebFetch')
    expect(names).not.toContain('WebSearch')
  })

  it('offers no Write and no Edit until write tools are enabled', () => {
    const names = buildNeutralToolCatalog(base as never).map((s) => s.name)
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Edit')
  })

  it('narrows the built-ins to the caller s list when one is given', () => {
    const names = buildNeutralToolCatalog({ ...base, builtinTools: ['Read', 'Grep'] } as never).map(
      (s) => s.name,
    )
    expect(names).toContain('Read')
    expect(names).toContain('Grep')
    expect(names).not.toContain('Glob')
    // `builtinTools` is the built-in filter only. Editor tools are unaffected,
    // exactly as the SDK's `tools` option behaves.
    expect(names).toContain('mcp__editor__get_selection')
  })

  it('removes a disallowed tool by its FULL namespaced name', () => {
    const names = buildNeutralToolCatalog({
      ...base,
      disallowedTools: ['mcp__editor__ask_user_question', 'Grep'],
    } as never).map((s) => s.name)
    expect(names).not.toContain('mcp__editor__ask_user_question')
    expect(names).not.toContain('Grep')
  })

  it('produces no duplicate names, so toToolDefs cannot throw on it', () => {
    const names = buildNeutralToolCatalog(base as never).map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

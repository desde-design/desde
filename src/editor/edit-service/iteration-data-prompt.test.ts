import { describe, expect, it } from 'vitest'
import {
  buildIterationDataPrompt,
  type IterationDataIntent,
} from './iteration-data-prompt'

const intent: IterationDataIntent = {
  kind: 'iteration-data',
  description: 'Patch row "a": set label',
  templateLocation: { file: 'src/List.vue', line: 4, column: 3 },
  iterationContext: {
    source: 'v-for',
    key: 'a',
    index: 0,
    siblingCount: 3,
    expression: 'r in rows',
  },
  pageSourceFile: 'src/Page.vue',
  payload: { operation: 'patch', updates: { label: 'B' } },
}

const files = [{ path: 'src/List.vue', source: '<template><li v-for="r in rows" /></template>' }]

/** Line indices of every envelope in the user message, in order. */
function envelopes(user: string): { begin: number; end: number }[] {
  const lines = user.split('\n')
  const out: { begin: number; end: number }[] = []
  let open: number | null = null
  lines.forEach((line, i) => {
    if (line.startsWith('<<<BEGIN:')) open = i
    else if (line.startsWith('<<<END:') && open !== null) {
      out.push({ begin: open, end: i })
      open = null
    }
  })
  return out
}

describe('buildIterationDataPrompt', () => {
  it('carries the metadata the model needs', () => {
    const { user } = buildIterationDataPrompt({ files, intent })
    expect(user).toContain('Intent: Patch row "a": set label')
    expect(user).toContain('Template location (the list rendering): src/List.vue:4:3')
    expect(user).toContain('key="a", index=0, siblingCount=3, iteratee="r in rows"')
    expect(user).toContain('Page source file')
    expect(user).toContain('Operation: patch. Set these fields: {"label":"B"}')
    expect(user).toContain('src/List.vue')
  })

  /**
   * J6. The description is built around a key the PAGE supplied, and `key`,
   * `expression` and the paths come straight off the wire or off the source
   * tree. They used to sit above the fenced sources, in the half of the
   * request the model is told to obey.
   */
  it('fences the request metadata, and states that in the system prompt', () => {
    const { system, user } = buildIterationDataPrompt({ files, intent })
    const blocks = envelopes(user)
    // One for the metadata, one per bundled file.
    expect(blocks).toHaveLength(2)
    const lines = user.split('\n')
    const inMetadata = lines.slice(blocks[0]!.begin + 1, blocks[0]!.end).join('\n')
    expect(inMetadata).toContain('Intent: Patch row "a": set label')
    expect(inMetadata).toContain('Operation: patch')
    expect(inMetadata).toContain('Template location')
    // Nothing page-derived is left above the first envelope.
    const above = lines.slice(0, blocks[0]!.begin).join('\n')
    expect(above).not.toContain('Patch row')
    expect(above).not.toContain('r in rows')
    // And the model is told the metadata block is data too.
    expect(system).toContain('REQUEST METADATA block')
    expect(system).toContain('never part of it')
  })

  it('uses a different envelope tag per block and per call', () => {
    const first = buildIterationDataPrompt({ files, intent }).user
    const second = buildIterationDataPrompt({ files, intent }).user
    const tagOf = (u: string, n: number) => u.split('\n')[envelopes(u)[n]!.begin]!
    expect(tagOf(first, 0)).not.toBe(tagOf(first, 1))
    expect(tagOf(first, 0)).not.toBe(tagOf(second, 0))
  })
})

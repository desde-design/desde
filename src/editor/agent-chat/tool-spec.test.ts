import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { toToolDefs, type ToolSpec } from './tool-spec'

const spec: ToolSpec = {
  name: 'read_thing',
  description: 'Read a thing.',
  kind: 'builtin',
  inputShape: {
    path: z.string().describe('Repo-relative path.'),
    limit: z.number().optional().describe('Max lines.'),
  },
  handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
}

describe('toToolDefs', () => {
  it('produces a JSON Schema object with the shape s properties and required list', () => {
    const [def] = toToolDefs([spec])
    expect(def.name).toBe('read_thing')
    expect(def.description).toBe('Read a thing.')
    expect(def.inputSchema.type).toBe('object')
    expect(Object.keys(def.inputSchema.properties as object)).toEqual(['path', 'limit'])
    expect(def.inputSchema.required).toEqual(['path'])
  })

  it('carries each field s description through, because that is what the model reads', () => {
    const [def] = toToolDefs([spec])
    const props = def.inputSchema.properties as Record<string, { description?: string }>
    expect(props.path.description).toBe('Repo-relative path.')
  })

  it('strips $schema, which no vendor tool-definition field accepts', () => {
    const [def] = toToolDefs([spec])
    expect('$schema' in def.inputSchema).toBe(false)
  })

  it('gives a no-input tool an empty object schema rather than omitting it', () => {
    const [def] = toToolDefs([
      { ...spec, name: 'ping', inputShape: {} },
    ])
    expect(def.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('refuses a duplicate name, which both wire formats reject at request time', () => {
    expect(() => toToolDefs([spec, spec])).toThrow(/duplicate tool name 'read_thing'/)
  })
})

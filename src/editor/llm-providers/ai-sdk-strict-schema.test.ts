/**
 * The structured-output schema this lane puts on the wire has to be one
 * OpenAI's strict Structured Outputs mode accepts.
 *
 * `Output.object` makes `@ai-sdk/openai` send `strict: true` alongside the
 * caller's schema, and strict mode requires EVERY key in `properties` to be
 * listed in `required` (and `additionalProperties: false` on every object).
 * All five `json_schema` call sites in this repo declare optional properties,
 * so before `toStrictJsonSchema` existed every LLM-fallback lane answered 400
 * on OpenAI: apply-llm-patch, repair-edit, iteration-data, translate-goal and
 * generate-hints.
 *
 * Two levels of coverage here:
 *  - end to end, against a stubbed `fetch` driving the REAL `@ai-sdk/openai`
 *    Responses model, asserting the exact request body;
 *  - one case per call site, asserting its own schema satisfies the strict
 *    rule after normalisation, so a sixth call site added later is covered by
 *    the same rule rather than by a new hand-written expectation.
 *
 * No network and no key: the stub `fetch` never leaves the process.
 */
import { describe, expect, it } from 'vitest'
import { buildOpenAiProvider } from './ai-sdk-openai'
import { toStrictJsonSchema } from './ai-sdk-provider'
import { buildPatchPrompt } from '../edit-service/llm-patch-prompt'
import { REPAIR_RESPONSE_SCHEMA } from '../edit-service/repair-edit'
import { ITERATION_DATA_RESPONSE_SCHEMA } from '../edit-service/iteration-data-llm'
import { TRANSLATE_RESPONSE_SCHEMA } from '../verification/translate-goal'
import { HINTS_SCHEMA } from '../hints/llm-generate-hints'

type JsonObject = Record<string, unknown>

/** A Responses API answer carrying one output text item. */
function responsesBody(text: string): JsonObject {
  return {
    id: 'resp_1',
    model: 'gpt-5.6',
    created_at: 0,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
    incomplete_details: null,
  }
}

/**
 * A `fetch` that answers every request from memory and records the body it
 * was handed. This is the whole transport for these tests.
 */
function recordingFetch(text: string): {
  fetchImpl: typeof fetch
  bodies: JsonObject[]
} {
  const bodies: JsonObject[] = []
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as JsonObject)
    return new Response(JSON.stringify(responsesBody(text)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

/**
 * Walk every object node and report the ones strict mode would reject:
 * a property missing from `required`, or a missing `additionalProperties:
 * false`. Returns the JSON pointers of the offenders, so a failure names
 * the exact node.
 */
function strictModeViolations(node: unknown, path = '#'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => strictModeViolations(child, `${path}/${i}`))
  }
  if (node === null || typeof node !== 'object') return []
  const record = node as JsonObject
  const out: string[] = []
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const keys = Object.keys(properties as JsonObject)
    const required = Array.isArray(record.required) ? (record.required as unknown[]) : []
    for (const key of keys) {
      if (!required.includes(key)) out.push(`${path}: '${key}' is not in required`)
    }
    if (record.additionalProperties !== false) {
      out.push(`${path}: additionalProperties is not false`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'enum' || key === 'const') continue
    out.push(...strictModeViolations(value, `${path}/${key}`))
  }
  return out
}

const PATCH_SCHEMA = buildPatchPrompt({
  file: 'src/App.vue',
  originalSource: '<template><div /></template>',
  mutations: [],
  projectStyleContext: { tokens: [], classTaxonomy: [], preprocessor: 'css' },
}).schema

describe('the request body a json_schema lane puts on the wire', () => {
  it('sends a strict-compatible schema for the apply-llm-patch call site', async () => {
    const { fetchImpl, bodies } = recordingFetch(
      JSON.stringify({ newSource: 'x', perMutationOutcome: [] }),
    )
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    await provider.complete({
      system: 'sys',
      user: 'usr',
      responseFormat: { kind: 'json_schema', schema: { ...PATCH_SCHEMA } },
    })

    const format = (bodies[0]!.text as JsonObject).format as JsonObject
    expect(format.type).toBe('json_schema')
    expect(format.strict).toBe(true)
    const schema = format.schema as JsonObject
    // The exact top level: every property required, `notes` nullable because
    // the caller declared it optional.
    expect(schema.required).toEqual(['newSource', 'perMutationOutcome', 'notes'])
    expect((schema.properties as JsonObject).notes).toEqual({
      type: ['string', 'null'],
    })
    // And the nested array item, which is where the second optional lives.
    const item = ((schema.properties as JsonObject).perMutationOutcome as JsonObject)
      .items as JsonObject
    expect(item.required).toEqual(['mutationId', 'outcome', 'reason'])
    expect((item.properties as JsonObject).reason).toEqual({ type: ['string', 'null'] })
    expect(strictModeViolations(schema)).toEqual([])
  })

  it('drops the nulls it asked for, so an optional property reads as absent', async () => {
    const { fetchImpl } = recordingFetch(
      JSON.stringify({
        newSource: 'x',
        perMutationOutcome: [{ mutationId: 'm1', outcome: 'applied', reason: null }],
        notes: null,
      }),
    )
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    const result = await provider.complete({
      system: 'sys',
      user: 'usr',
      responseFormat: { kind: 'json_schema', schema: { ...PATCH_SCHEMA } },
    })
    expect(result.parsed).toEqual({
      newSource: 'x',
      perMutationOutcome: [{ mutationId: 'm1', outcome: 'applied' }],
    })
  })

  it('leaves a plain prompt with no responseFormat alone', async () => {
    const { fetchImpl, bodies } = recordingFetch('hello')
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    await provider.complete({ system: 'sys', user: 'usr' })
    expect(bodies[0]!.text).toBeUndefined()
  })
})

describe('prompt retention (the reason this lane runs on the Responses API)', () => {
  it('sends store: false on a completion, so the vendor keeps no copy of the prompt', async () => {
    const { fetchImpl, bodies } = recordingFetch('hello')
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    await provider.complete({ system: 'sys', user: 'usr' })
    expect(bodies[0]!.store).toBe(false)
  })

  it('sends store: false on a conversation step too, where the repo file contents ride', async () => {
    const { fetchImpl, bodies } = recordingFetch('hello')
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    for await (const _ of provider.streamConversation({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })) {
      // drain
    }
    expect(bodies[0]!.store).toBe(false)
  })

  it('keeps store: false when a turn also carries the descriptor effort options', async () => {
    const { fetchImpl, bodies } = recordingFetch('hello')
    const provider = buildOpenAiProvider({ apiKey: 'sk-not-a-real-key', fetchImpl })
    for await (const _ of provider.streamConversation({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      providerOptions: { reasoningEffort: 'high' },
    })) {
      // drain
    }
    expect(bodies[0]!.store).toBe(false)
    expect(bodies[0]!.reasoning).toMatchObject({ effort: 'high' })
  })
})

describe('every json_schema call site in the repo', () => {
  it.each([
    ['apply-llm-patch', PATCH_SCHEMA as unknown as JsonObject],
    ['repair-edit', REPAIR_RESPONSE_SCHEMA as unknown as JsonObject],
    ['iteration-data', ITERATION_DATA_RESPONSE_SCHEMA as unknown as JsonObject],
    ['translate-goal', TRANSLATE_RESPONSE_SCHEMA as unknown as JsonObject],
    ['generate-hints', HINTS_SCHEMA as unknown as JsonObject],
  ])('%s normalises to a schema strict mode accepts', (_name, schema) => {
    expect(strictModeViolations(toStrictJsonSchema(schema))).toEqual([])
  })
})

describe('toStrictJsonSchema', () => {
  it('expresses an optional enum as a nullable one, null included in the values', () => {
    const out = toStrictJsonSchema({
      type: 'object',
      properties: { axis: { type: 'string', enum: ['x', 'y'] } },
      required: [],
      additionalProperties: false,
    }) as JsonObject
    expect((out.properties as JsonObject).axis).toEqual({
      type: ['string', 'null'],
      enum: ['x', 'y', null],
    })
  })

  it('leaves a property that was already required untouched', () => {
    const out = toStrictJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    }) as JsonObject
    expect((out.properties as JsonObject).a).toEqual({ type: 'string' })
  })

  it('does not mutate the caller\'s schema', () => {
    const original = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: [],
      additionalProperties: false,
    }
    const snapshot = JSON.parse(JSON.stringify(original)) as unknown
    toStrictJsonSchema(original)
    expect(original).toEqual(snapshot)
  })
})

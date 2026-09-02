/**
 * LLM lane for iteration-data edits (the fallback behind the static
 * resolver in `apply-iteration-data-edit-static.ts`).
 *
 * When the deterministic resolver can't locate exactly one array literal
 * feeding the v-for (computed expression, store-derived value, chained
 * access), the client posts an `IterationDataIntent` to
 * `/api/editor/llm-fallback`. Until 2026-09-01 that request always 400d:
 * the handler only knew the structural-repair lane, so
 * `buildIterationDataPrompt` had no caller and the user saw a bare
 * "Iteration edit refused" with no repair (stress-test finding F-11).
 *
 * Same contract discipline as `repair-edit.ts`, deliberately: pure (no
 * filesystem I/O), provider injected for tests, full-file JSON response
 * validated, no-op result refused so the diff view never shows an
 * empty change.
 */

import { createHash } from 'node:crypto'
import type { ProjectKnowledge } from '../core/project-knowledge'
import { getProvider } from '../llm-providers/registry'
import type { CompletionProvider } from '../llm-providers/types'
import {
  buildIterationDataPrompt,
  type IterationDataIntent,
} from './iteration-data-prompt'

export type { IterationDataIntent } from './iteration-data-prompt'

export interface ApplyIterationDataLlmInput {
  /** Full source of the file being rewritten. */
  source: string
  /** Repo-relative path of that file — the page file for cross-component data. */
  file: string
  intent: IterationDataIntent
  projectKnowledge?: ProjectKnowledge
  /** Optional LLM provider injection (tests pass a fake). */
  provider?: CompletionProvider
  /** Model id. Same default tier as the repair lane. */
  model?: string
  maxTokens?: number
}

export type ApplyIterationDataLlmResult =
  | {
      ok: true
      /** New full-file source. */
      newSource: string
      /** SHA-256 hex of the original source — the OverwriteEdit.baseHash. */
      originalSourceHash: string
      explanation?: string
    }
  | { ok: false; reason: string }

interface IterationResponseShape {
  newSource: string
  explanation?: string
}

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  required: ['newSource'] as const,
  additionalProperties: false,
  properties: {
    newSource: {
      type: 'string' as const,
      description: 'Full corrected file source. Must compile.',
    },
    explanation: {
      type: 'string' as const,
      description:
        'One- or two-sentence note explaining what changed (or why nothing could). Shown to the user.',
    },
  },
}

export async function applyIterationDataLlm(
  input: ApplyIterationDataLlmInput,
): Promise<ApplyIterationDataLlmResult> {
  const {
    source,
    file,
    intent,
    projectKnowledge,
    model = 'claude-sonnet-4-6',
    maxTokens = 8000,
  } = input

  // Resolved inside the function, not as a parameter default: `getProvider()`
  // THROWS on missing credentials, and a default-parameter throw escapes the
  // caller's error mapping as a raw 500 with a stack in the response body
  // (measured; the repair lane shares this wart via its own parameter
  // default). Here it becomes an honest refusal the client can display.
  let provider = input.provider
  if (!provider) {
    try {
      provider = getProvider()
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  if (!source || source.length === 0) {
    return { ok: false, reason: 'Original source is empty: nothing to edit' }
  }

  const prompt = buildIterationDataPrompt({ file, source, intent, projectKnowledge })

  let result
  try {
    result = await provider.complete({
      model,
      maxTokens,
      system: prompt.system,
      user: prompt.user,
      responseFormat: { kind: 'json_schema', schema: { ...RESPONSE_SCHEMA } },
    })
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${(err as Error).message}` }
  }

  if (!result.text) {
    return { ok: false, reason: 'LLM produced no text block' }
  }
  if (result.parsed === undefined) {
    return {
      ok: false,
      reason: `LLM response was not valid JSON: ${result.text.slice(0, 120)}`,
    }
  }
  const parsed = result.parsed as IterationResponseShape
  if (typeof parsed.newSource !== 'string' || parsed.newSource.length === 0) {
    return { ok: false, reason: 'LLM response missing newSource (or it was empty)' }
  }
  // The prompt's own procedure tells the model to return the source
  // unchanged with an explanation when the data lives in a file it was not
  // given. That is a REFUSAL for this lane, not a proposal: an unchanged
  // overwrite would no-op at save and read as a silent success.
  if (parsed.newSource === source) {
    return {
      ok: false,
      reason:
        parsed.explanation ??
        'LLM returned the original source unchanged: no edit proposed',
    }
  }

  return {
    ok: true,
    newSource: parsed.newSource,
    originalSourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
    explanation: parsed.explanation,
  }
}

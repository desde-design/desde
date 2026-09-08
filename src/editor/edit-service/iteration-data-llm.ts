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
  type IterationDataPromptFile,
} from './iteration-data-prompt'

export type { IterationDataIntent, IterationDataPromptFile } from './iteration-data-prompt'

export interface ApplyIterationDataLlmInput {
  /**
   * The bundle the model may rewrite ONE of: the file containing the list
   * first, then the page (when different), then the import chain the data
   * was traced through. Assembled by the CLI handler, which owns the
   * filesystem; this function never reads a file. The response must name
   * one of these paths, or it is refused.
   */
  files: ReadonlyArray<IterationDataPromptFile>
  intent: IterationDataIntent
  projectKnowledge?: ProjectKnowledge
  /** Optional LLM provider injection (tests pass a fake). */
  provider?: CompletionProvider
  /**
   * Lazily resolves the LLM provider when `provider` is not supplied. The
   * CLI injects the project's per-request resolved provider here so this
   * lane never falls back to the process-wide registry default on its own.
   * Absent → `getProvider()`.
   */
  resolveProvider?: () => CompletionProvider
  /**
   * Model id. No hardcoded default — `undefined` lets each provider's
   * complete() fall back to its OWN defaultModel, so an OpenAI-configured
   * project does not get a Claude model id its API rejects outright.
   */
  model?: string
  maxTokens?: number
}

export type ApplyIterationDataLlmResult =
  | {
      ok: true
      /** Bundle path of the ONE file the model rewrote. */
      file: string
      /** New full source of that file. */
      newSource: string
      /** SHA-256 hex of that file's original source — the OverwriteEdit.baseHash. */
      originalSourceHash: string
      explanation?: string
    }
  | {
      ok: false
      reason: string
      /**
       * `unavailable` when the lane never ran (no provider credentials, or
       * the call itself failed) — the client shows the deterministic reason
       * in that case, because a lane that never ran cannot supply one.
       * `refused` when the model ran and declined or answered badly.
       */
      kind: 'unavailable' | 'refused'
    }

interface IterationResponseShape {
  file?: string
  newSource: string
  explanation?: string
}

export const ITERATION_DATA_RESPONSE_SCHEMA = {
  type: 'object' as const,
  required: ['file', 'newSource'] as const,
  additionalProperties: false,
  properties: {
    file: {
      type: 'string' as const,
      description: 'Bundle path of the one file being rewritten, exactly as labeled.',
    },
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
  const { files, intent, projectKnowledge, model, maxTokens = 8000 } = input

  // Resolved inside the function, not as a parameter default: `getProvider()`
  // THROWS on missing credentials, and a default-parameter throw escapes the
  // caller's error mapping as a raw 500 with a stack in the response body
  // (measured; the repair lane shares this wart via its own parameter
  // default). Here it becomes an honest refusal the client can display.
  let provider = input.provider
  if (!provider) {
    try {
      provider = (input.resolveProvider ?? getProvider)()
    } catch (err) {
      return { ok: false, reason: (err as Error).message, kind: 'unavailable' }
    }
  }

  if (files.length === 0) {
    return { ok: false, reason: 'No source files to edit', kind: 'refused' }
  }
  const empty = files.find((f) => !f.source || f.source.length === 0)
  if (empty) {
    return { ok: false, reason: `${empty.path} is empty: nothing to edit`, kind: 'refused' }
  }

  const prompt = buildIterationDataPrompt({ files, intent, projectKnowledge })

  let result
  try {
    result = await provider.complete({
      model,
      maxTokens,
      system: prompt.system,
      user: prompt.user,
      responseFormat: { kind: 'json_schema', schema: { ...ITERATION_DATA_RESPONSE_SCHEMA } },
    })
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${(err as Error).message}`, kind: 'unavailable' }
  }

  if (!result.text) {
    return { ok: false, reason: 'LLM produced no text block', kind: 'refused' }
  }
  if (result.parsed === undefined) {
    return {
      ok: false,
      reason: `LLM response was not valid JSON: ${result.text.slice(0, 120)}`,
      kind: 'refused',
    }
  }
  const parsed = result.parsed as IterationResponseShape
  if (typeof parsed.newSource !== 'string' || parsed.newSource.length === 0) {
    return { ok: false, reason: 'LLM response missing newSource (or it was empty)', kind: 'refused' }
  }
  // The model must name the file it rewrote, and it must be one it was shown.
  // A path outside the bundle is refused outright: this lane's output becomes
  // a full-file overwrite, and the bundle is the only set of files the
  // handler vetted against the prototype root.
  const target = files.find((f) => f.path === parsed.file)
  if (!target) {
    return {
      ok: false,
      reason:
        typeof parsed.file === 'string' && parsed.file.length > 0
          ? `LLM named a file it was not given (${parsed.file}): refusing the rewrite`
          : 'LLM response did not name the file it rewrote',
      kind: 'refused',
    }
  }
  // The prompt's own procedure tells the model to return the source
  // unchanged with an explanation when the data lives in a file it was not
  // given. That is a REFUSAL for this lane, not a proposal: an unchanged
  // overwrite would no-op at save and read as a silent success.
  if (parsed.newSource === target.source) {
    return {
      ok: false,
      reason:
        parsed.explanation ??
        'LLM returned the original source unchanged: no edit proposed',
      kind: 'refused',
    }
  }

  return {
    ok: true,
    file: target.path,
    newSource: parsed.newSource,
    originalSourceHash: createHash('sha256').update(target.source, 'utf8').digest('hex'),
    explanation: parsed.explanation,
  }
}

/**
 * Tier 2: primitive-edit failure → LLM-assisted repair.
 *
 * When a deterministic primitive applicator refuses an edit (compile
 * failure, structural orphan, etc.), the user's intent was clear from
 * the gesture but a single primitive couldn't produce a clean rewrite.
 * This service asks an LLM to look at the original SFC source, the
 * intent description ("Unwrap <KCard>"), and the applicator's refusal
 * reason, and propose a corrected rewrite as a full file replacement.
 *
 * Output is shaped as an `LLMPatchEdit`-equivalent — a Map<file, source>
 * — so it can flow through the existing `llm-patch` save lane without
 * a new applicator.
 *
 * Pure (no filesystem I/O). The caller reads the file, calls this
 * service, surfaces the proposed source to the user for review, and
 * writes only after approval through the Save-gated buffer.
 *
 * Tests inject a fake provider through `provider?:`.
 */

import { createHash } from 'node:crypto'
import type { ProjectKnowledge } from '../core/project-knowledge'
import { getProvider } from '../llm-providers/registry'
import type { CompletionProvider } from '../llm-providers/types'
import { buildRepairPrompt, type RepairIntent } from './repair-edit-prompt'

export type { RepairIntent } from './repair-edit-prompt'

export interface ApplyRepairEditInput {
  /** Original SFC source (full file). */
  source: string
  /** Absolute or repo-relative file path — purely for the prompt's framing. */
  file: string
  /** Designer's intent — what they were trying to do. */
  intent: RepairIntent
  /** The applicator's refusal reason. */
  errorReason: string
  /**
   * The prototype repo's documented conventions, if discovered. Inlined
   * into the repair prompt so the rewrite respects the project's rules.
   */
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
  /** Max output tokens. Default 8000 (SFCs are typically <2k lines). */
  maxTokens?: number
}

export type ApplyRepairEditResult =
  | {
      ok: true
      /** New full-file source. */
      newSource: string
      /**
       * SHA-256 hex of the original source the LLM saw. The caller
       * routes this through to the `OverwriteEdit.baseHash` so the
       * save endpoint can detect external edits between propose and
       * approve and refuse with 409.
       */
      originalSourceHash: string
      /** Optional LLM-supplied explanation, surfaced in the diff panel. */
      explanation?: string
    }
  | { ok: false; reason: string }

interface RepairResponseShape {
  newSource: string
  explanation?: string
}

export const REPAIR_RESPONSE_SCHEMA = {
  type: 'object' as const,
  required: ['newSource'] as const,
  additionalProperties: false,
  properties: {
    newSource: {
      type: 'string' as const,
      description: 'Full corrected SFC source. Must compile.',
    },
    explanation: {
      type: 'string' as const,
      description:
        'One- or two-sentence note explaining what the LLM changed and why. Shown to the user.',
    },
  },
}

export async function applyRepairEdit(
  input: ApplyRepairEditInput,
): Promise<ApplyRepairEditResult> {
  const {
    source,
    file,
    intent,
    errorReason,
    projectKnowledge,
    model,
    maxTokens = 8000,
  } = input

  // Resolved inside the function, not as a parameter default: `getProvider()`
  // THROWS on missing credentials, and a default-parameter throw is evaluated
  // during destructuring, so it escapes every `try` below and reaches the
  // caller as a raw 500 with a stack in the response body. Here it becomes an
  // honest refusal the client can display. Matches `iteration-data-llm.ts`,
  // which was fixed first and named this lane as sharing the wart.
  let provider = input.provider
  if (!provider) {
    try {
      provider = (input.resolveProvider ?? getProvider)()
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  if (!source || source.length === 0) {
    return { ok: false, reason: 'Original source is empty: nothing to repair' }
  }

  const prompt = buildRepairPrompt({
    file,
    source,
    intent,
    errorReason,
    projectKnowledge,
  })

  let result
  try {
    result = await provider.complete({
      model,
      maxTokens,
      system: prompt.system,
      user: prompt.user,
      responseFormat: {
        kind: 'json_schema',
        schema: { ...REPAIR_RESPONSE_SCHEMA },
      },
    })
  } catch (err) {
    return {
      ok: false,
      reason: `LLM call failed: ${(err as Error).message}`,
    }
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
  const parsed = result.parsed as RepairResponseShape

  if (typeof parsed.newSource !== 'string' || parsed.newSource.length === 0) {
    return {
      ok: false,
      reason: 'LLM response missing newSource (or it was empty)',
    }
  }

  // Sanity check: refuse if the model handed us back the unchanged source.
  // That's a "no-op" repair and would be confusing in the diff view.
  if (parsed.newSource === source) {
    return {
      ok: false,
      reason: 'LLM returned the original source unchanged: no repair proposed',
    }
  }

  return {
    ok: true,
    newSource: parsed.newSource,
    originalSourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
    explanation: parsed.explanation,
  }
}

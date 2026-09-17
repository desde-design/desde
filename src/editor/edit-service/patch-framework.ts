/**
 * Which framework dialect the LLM patch lane should speak for a given source
 * file. One tiny module rather than an `endsWith('.vue')` at each site, because
 * three places have to agree: the refusal gate in
 * [apply-llm-patch.ts](./apply-llm-patch.ts), the system prompt in
 * [llm-patch-prompt.ts](./llm-patch-prompt.ts), and the pre-write parse
 * validation in `editor-cli/src/server/edit-handler.ts`. When they disagreed,
 * the lane accepted a file it then validated with the wrong parser.
 *
 * Mirrors `Framework` in `editor-cli/src/hosts/types.ts` — the extensions here
 * are the ones the deterministic applicators already cover, so the LLM lane
 * refuses exactly the files the deterministic lane refuses and nothing more.
 */

/** The dialects this lane can patch. */
export type PatchFramework = 'vue' | 'react'

/** Extensions {@link resolvePatchFramework} admits, for refusal messages. */
export const SUPPORTED_PATCH_EXTENSIONS = ['.vue', '.tsx', '.jsx'] as const

/**
 * Classify a source path. `null` means the lane must refuse the file — it is
 * neither a Vue SFC nor a React module, so neither dialect's rules apply and
 * neither parser could validate the result.
 */
export function resolvePatchFramework(file: string): PatchFramework | null {
  if (file.endsWith('.vue')) return 'vue'
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return 'react'
  return null
}

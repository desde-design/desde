/**
 * Verification orchestration (React-free).
 *
 * Glues capture → settle → verify → surface without importing React or the
 * store: the caller supplies store-bound callbacks and an adapter-bound DOM
 * reader. This keeps the whole flow unit-testable with fakes (see
 * verification.test.ts) and lets the hook stay a thin wrapper.
 */

import type { VerificationResult } from './types'
import { deriveExpectation, type ExpectationInput } from './derive-expectation'
import { verifyRender, type VerifyDeps } from './verify-render'

export interface OrchestrateCallbacks {
  /** A verification has started (or restarted for the same edit). */
  begin: (
    editId: string,
    label: string,
    startedAt: number,
    commitSha?: string,
  ) => void
  /** A verification resolved. */
  complete: (editId: string, result: VerificationResult) => void
}

export interface OrchestrateDeps extends VerifyDeps {
  /** Delay before the first DOM read, to let HMR settle (default 150 ms). */
  settleMs?: number
}

/**
 * Run a full verification for a just-dispatched deterministic edit. Returns
 * the result, or `null` when no oracle could be derived (we don't record or
 * surface anything we can't actually check).
 *
 * Never throws — verification is best-effort and must not break the edit flow.
 */
export async function orchestrateVerification(
  input: ExpectationInput,
  callbacks: OrchestrateCallbacks,
  deps: OrchestrateDeps,
): Promise<VerificationResult | null> {
  const expectation = deriveExpectation(input)
  if (!expectation) return null

  const now = deps.now ?? Date.now
  callbacks.begin(
    expectation.editId,
    expectation.label,
    now(),
    expectation.commitSha,
  )

  try {
    const settle = deps.settleMs ?? 150
    if (settle > 0) {
      await (deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
        settle,
      )
    }
    const result = await verifyRender(expectation, deps)
    callbacks.complete(expectation.editId, result)
    return result
  } catch (err) {
    // Best-effort: surface a benign "skipped" rather than throwing into the
    // edit flow. (A timeout inside readRenderedValue already resolves to a
    // fail; this catches only unexpected reader errors.)
    const fallback: VerificationResult = {
      editId: expectation.editId,
      status: 'skipped',
      expectedValue: expectation.expectedValue,
      escalatable: false,
      detail: `Verification skipped: ${(err as Error)?.message ?? 'reader error'}`,
      durationMs: 0,
    }
    callbacks.complete(expectation.editId, fallback)
    return fallback
  }
}

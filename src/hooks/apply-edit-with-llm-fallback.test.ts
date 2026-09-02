/**
 * Tests for the auto-LLM-fallback wrapper. The helper is a pure async
 * function with two collaborators we inject — a fake adapter that
 * records `applyEdit` calls and returns scripted results, and a fake
 * `fetchImpl` that responds with the shape the real
 * `/api/editor/llm-fallback` route returns.
 *
 * Each test asserts both the final {@link EditResult} the caller sees
 * AND the `fallback` outcome shape, since the worktree-mode handlers
 * and the Save-loop both branch off `fallback.applied` /
 * `fallback.fallbackError` to emit status messages.
 */

import { describe, expect, it, vi } from 'vitest'
import type { EditResult, StructuralEdit } from '@/editor/core'
import { applyEditWithLLMFallback } from './apply-edit-with-llm-fallback'

// A `MoveEdit` shape that satisfies `describeIntentForRepair` — has an
// `editTarget` so the helper will know which file to ask the LLM to
// repair. Coordinates match what `data-desde-src` would emit.
function makeMoveEdit(): StructuralEdit {
  return {
    kind: 'move',
    id: 'edit-1',
    target: {
      targetId: 'a.button',
      selector: 'a.button',
      componentName: 'KButton',
      editTarget: { file: 'src/App.vue', line: 5, column: 3 },
    },
    destination: {
      parentId: 'div.step-1',
      index: 0,
      parentEditTarget: { file: 'src/App.vue', line: 2, column: 1 },
    },
  } as StructuralEdit
}

// Minimal `adapter.applyEdit` mock. The helper invokes `applyEdit`
// once for the deterministic attempt and (when the LLM lane fires) a
// second time for the overwrite. The mock returns scripted results in
// order so we can model "deterministic refuses, overwrite applies."
function mockAdapter(results: EditResult[]): {
  applyEdit: (edit: StructuralEdit) => Promise<EditResult>
  calls: { kind: string; id: string }[]
} {
  const calls: { kind: string; id: string }[] = []
  let idx = 0
  const applyEdit = async (edit: StructuralEdit): Promise<EditResult> => {
    calls.push({ kind: edit.kind, id: edit.id })
    const r = results[idx]
    idx += 1
    if (!r) throw new Error(`adapter.applyEdit called ${idx} times but only ${results.length} scripted results`)
    return r
  }
  return { applyEdit, calls }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('applyEditWithLLMFallback', () => {
  it('returns the deterministic success unchanged when applyEdit succeeds', async () => {
    const adapter = mockAdapter([
      { kind: 'applied', appliedEditId: 'edit-1', affectedTargetIds: ['a.button'] },
    ])
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      makeMoveEdit(),
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('applied')
    expect(fallback).toEqual({ attempted: false, applied: false })
    // No second adapter call, no fetch call.
    expect(adapter.calls).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does NOT call the LLM fallback for non-repairable edit kinds', async () => {
    // An overwrite is itself an LLM result — repairing it makes no sense.
    const overwriteEdit: StructuralEdit = {
      kind: 'overwrite',
      id: 'edit-2',
      target: { targetId: 'src/App.vue', selector: 'src/App.vue' },
      file: 'src/App.vue',
      newSource: '<template>...</template>',
    } as StructuralEdit
    const adapter = mockAdapter([
      { kind: 'failed', reason: 'baseHash mismatch' },
    ])
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      overwriteEdit,
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('failed')
    expect(fallback.attempted).toBe(false)
    expect(fallback.originalReason).toBe('baseHash mismatch')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('auto-repairs a cycle refusal by dispatching the LLM-proposed overwrite', async () => {
    // Deterministic refuses with the cycle error, overwrite succeeds.
    const adapter = mockAdapter([
      {
        kind: 'failed',
        reason: 'Cannot move an element into one of its descendants (would create a cycle)',
      },
      { kind: 'applied', appliedEditId: 'edit-1', affectedTargetIds: ['src/App.vue'] },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        proposal: {
          newSource: '<template><div class="step-1"><button /></div></template>',
          explanation: 'Moved <button> up to step 1.',
          baseHash: 'deadbeef',
        },
      }),
    ) as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      makeMoveEdit(),
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('applied')
    expect(fallback.attempted).toBe(true)
    expect(fallback.applied).toBe(true)
    expect(fallback.explanation).toBe('Moved <button> up to step 1.')
    expect(fallback.originalReason).toMatch(/cycle/)
    // Two adapter calls: original move, then the synthesized overwrite.
    // The overwrite reuses the original edit id so labels carry over.
    expect(adapter.calls).toEqual([
      { kind: 'move', id: 'edit-1' },
      { kind: 'overwrite', id: 'edit-1' },
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // Body forwarded the move's editTarget file + the deterministic reason.
    const fetchArgs = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse((fetchArgs[1] as RequestInit).body as string)
    expect(body.file).toBe('src/App.vue')
    expect(body.intent.kind).toBe('move')
    expect(body.errorReason).toMatch(/cycle/)
  })

  it("drops the destination anchor when the parent lives in a different file from the source", async () => {
    // Cross-file moves would otherwise ship parent coords that
    // reference a file the LLM never sees in the prompt — the
    // "Destination MUST be …" clause would then point at nothing
    // and mislead the model.
    const crossFileMove: StructuralEdit = {
      kind: "move",
      id: "edit-1",
      target: {
        targetId: "a.button",
        selector: "a.button",
        componentName: "KButton",
        editTarget: { file: "src/App.vue", line: 5, column: 3 },
      },
      destination: {
        parentId: "div.step-1",
        index: 0,
        parentEditTarget: { file: "src/OtherFile.vue", line: 2, column: 1 },
      },
    } as StructuralEdit
    const adapter = mockAdapter([
      { kind: "failed", reason: "cross-file moves unsupported" },
      { kind: "applied", appliedEditId: "edit-1", affectedTargetIds: ["src/App.vue"] },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, proposal: { newSource: "<template>ok</template>" } }),
    ) as unknown as typeof fetch
    await applyEditWithLLMFallback(crossFileMove, adapter, fetchImpl)
    const fetchArgs = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse((fetchArgs[1] as RequestInit).body as string)
    expect(body.intent.destParentLine).toBeUndefined()
    expect(body.intent.destParentColumn).toBeUndefined()
    // Index alone is still forwarded — it's meaningful for the
    // implicit same-parent case (e.g., index = "append at tail").
    expect(body.intent.destIndex).toBe(0)
  })

  it("forwards InsertEdit destination from target + top-level destIndex (InsertEdit has no `destination` field)", async () => {
    const insertEdit: StructuralEdit = {
      kind: "insert",
      id: "edit-1",
      target: {
        targetId: "div.parent",
        selector: "div.parent",
        componentName: "div",
        editTarget: { file: "src/App.vue", line: 7, column: 4 },
      },
      destIndex: -1,
      snippet: "<KButton />",
    } as StructuralEdit
    const adapter = mockAdapter([
      { kind: "failed", reason: "insert refused" },
      { kind: "applied", appliedEditId: "edit-1", affectedTargetIds: ["src/App.vue"] },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, proposal: { newSource: "<template>ok</template>" } }),
    ) as unknown as typeof fetch
    await applyEditWithLLMFallback(insertEdit, adapter, fetchImpl)
    const fetchArgs = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse((fetchArgs[1] as RequestInit).body as string)
    expect(body.intent.destParentLine).toBe(7)
    expect(body.intent.destParentColumn).toBe(4)
    expect(body.intent.destIndex).toBe(-1)
  })

  it("forwards MoveEdit destination (parent line/col + index) into the LLM intent", async () => {
    // Without this, the repair LLM has no idea where the user wanted
    // the element placed. It then invents a destination — typically
    // hoisting up out of nested blocks to "safer" ancestors. The
    // makeMoveEdit() fixture's destination is parentEditTarget line=2
    // col=1, index=0; assert all three land in the fetch body.
    const adapter = mockAdapter([
      { kind: "failed", reason: "refused: destination inside nested block" },
      { kind: "applied", appliedEditId: "edit-1", affectedTargetIds: ["src/App.vue"] },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        proposal: { newSource: "<template>ok</template>", explanation: "moved" },
      }),
    ) as unknown as typeof fetch

    await applyEditWithLLMFallback(makeMoveEdit(), adapter, fetchImpl)

    const fetchArgs = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse((fetchArgs[1] as RequestInit).body as string)
    expect(body.intent.destParentLine).toBe(2)
    expect(body.intent.destParentColumn).toBe(1)
    expect(body.intent.destIndex).toBe(0)
  })

  it('surfaces the ORIGINAL deterministic refusal when the LLM endpoint returns ok:false', async () => {
    // The repair service returns ok:false (e.g., "LLM returned the original
    // source unchanged" — see repair-edit.ts). The caller should see the
    // original reason for `failedEdits` stashing, and the fallback error
    // for the status message tail.
    const adapter = mockAdapter([
      { kind: 'failed', reason: 'Cannot move an element into one of its descendants (would create a cycle)' },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, reason: 'LLM returned the original source unchanged' }),
    ) as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      makeMoveEdit(),
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/cycle/)
    }
    expect(fallback.attempted).toBe(true)
    expect(fallback.applied).toBe(false)
    expect(fallback.fallbackError).toBe('LLM returned the original source unchanged')
    // Only one adapter call — no overwrite was attempted.
    expect(adapter.calls).toHaveLength(1)
  })

  it('captures a thrown fetch error in fallbackError without crashing', async () => {
    const adapter = mockAdapter([
      { kind: 'failed', reason: 'Cannot move an element into one of its descendants (would create a cycle)' },
    ])
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      makeMoveEdit(),
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('failed')
    expect(fallback.attempted).toBe(true)
    expect(fallback.applied).toBe(false)
    expect(fallback.fallbackError).toContain('ECONNREFUSED')
  })

  it('surfaces the original failure when the LLM proposal compiles broken & overwrite refuses', async () => {
    // Edge case: LLM produced output, but the overwrite applicator's
    // compile check rejected it. We want failedEdits.errorReason to be
    // the ORIGINAL deterministic reason (so manual retry resubmits the
    // same context), with the overwrite refusal in fallbackError.
    const adapter = mockAdapter([
      { kind: 'failed', reason: 'Cannot move an element into one of its descendants (would create a cycle)' },
      { kind: 'failed', reason: 'Post-write compile check failed' },
    ])
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        proposal: { newSource: '<template>oops</template>' },
      }),
    ) as unknown as typeof fetch

    const { result, fallback } = await applyEditWithLLMFallback(
      makeMoveEdit(),
      adapter,
      fetchImpl,
    )

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      // Original deterministic reason, NOT the post-write compile reason.
      expect(result.reason).toMatch(/cycle/)
    }
    expect(fallback.attempted).toBe(true)
    expect(fallback.applied).toBe(false)
    expect(fallback.fallbackError).toContain('AI rewrite refused at apply')
    expect(fallback.fallbackError).toContain('Post-write compile check failed')
    expect(adapter.calls).toHaveLength(2)
  })
})

/**
 * Bounded-concurrency map — run at most `limit` `fn` calls concurrently over
 * `items`, returning results in INPUT order (like `Promise.all`, but capped).
 *
 * Extracted (Phase 4 Task 5) from `apply-llm-patch.ts`'s private helper of
 * the same name so `src/editor/hints/llm-generate-hints.ts` (the LLM
 * rendering-hints lane's per-component fan-out) can share the exact same
 * fan-out/fail-fast policy instead of re-implementing it. Framework- and
 * design-system-neutral — this is a plain async utility, not editor- or
 * even LLM-specific; it happens to live in `core/` because that's the
 * shared, dependency-free layer both call sites already import from.
 *
 * When `stopWhen` is supplied and a completed result satisfies it, workers
 * stop pulling NEW items (in-flight calls still resolve). Since `next`
 * advances monotonically, the unscheduled items are a contiguous suffix, so
 * those indices stay `undefined` (holes) in the returned array — callers
 * reading in order hit the stop-triggering result before any hole. `fn` is
 * expected not to throw (callers should capture per-item errors into their
 * own result shape); a throw still rejects the returned promise.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stopWhen?: (result: R) => boolean,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length).fill(undefined)
  let next = 0
  let stop = false
  const poolSize = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    while (true) {
      if (stop) return
      const i = next++
      if (i >= items.length) return
      const r = await fn(items[i], i)
      results[i] = r
      if (stopWhen?.(r)) stop = true
    }
  }
  await Promise.all(Array.from({ length: poolSize }, () => worker()))
  return results
}

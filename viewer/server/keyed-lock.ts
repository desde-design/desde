/**
 * A key-per-lock mutex, one promise-chain per unique key. Same-tick callers on
 * one key run in call order; a rejecting `fn` does not block the next; different
 * keys do not wait on each other.
 *
 * Callers must not nest a `run` call for the SAME key inside another one's `fn`.
 * The lock is not reentrant: an inner call queues behind the outer call's own
 * tail, which cannot settle until the inner call resolves — a deadlock. Nothing
 * here detects or prevents that; it is a contract on callers, not a runtime check.
 */
export interface KeyedLock {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

/**
 * Creates a new keyed lock. Each lock holds one promise per key: the "everyone
 * queued on this key so far has finished" signal. Deliberately never rejects —
 * settling with a reason to move on is all the NEXT contender on the same key needs,
 * and the rejection-handler below is what makes a failed holder still hand off the
 * lock instead of poisoning the chain for every future contender on that key.
 */
export function createKeyedLock(): KeyedLock {
  const chains = new Map<string, Promise<void>>()
  return {
    run(key, fn) {
      // Read (and immediately overwrite) the chain SYNCHRONOUSLY, before any
      // `await` in this function — that is what makes several same-tick callers
      // queue in the order they called `run`, rather than in whatever order their
      // `fn`s happen to get scheduled.
      const previous = chains.get(key) ?? Promise.resolve()
      // `.then(fn, fn)` runs `fn` once `previous` SETTLES, regardless of which
      // way — a rejected `previous` still calls `fn` (the extra rejection-reason
      // argument is simply unused, since `fn` takes none).
      const run = previous.then(fn, fn)
      const tail = run.then(() => undefined, () => undefined)
      chains.set(key, tail)

      // Only remove the map entry if nobody queued behind us — if a later
      // contender already overwrote it, that entry is theirs to clean up when
      // THEY finish. Leaving it in that case is what keeps a same-tick queue
      // (five contenders on one key, say) from tearing down the chain out from
      // under whoever is still waiting.
      void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
      return run
    },
  }
}

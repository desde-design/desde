/**
 * Runs a model-supplied regular expression over lines of text on a thread that
 * is NOT the Editor's, so a pattern that backtracks forever cannot take the
 * process with it.
 *
 * Why a thread, when a deadline looks like it would do
 * --------------------------------------------------
 * The obvious fix is a wall-clock check every N lines of the scan loop. It
 * does not work, and it looks like it does, which is worse.
 *
 * V8's RegExp is a backtracking engine, so a nested quantifier is exponential
 * in the length of the run it is matched against. The whole cost lands inside
 * ONE `re.test` call on ONE line. MEASURED by an adversarial verifier on
 * 2026-09-05: `^( +)+X` against a single 43-character line with 32 leading
 * spaces ran for 272,769 ms; a 200 ms interval ticked zero times, and an
 * `AbortController` scheduled to fire at 500 ms never fired at all, because
 * its timer could not run either. A between-lines deadline is never reached,
 * so it changes nothing about any of that.
 *
 * There is no step budget to set on a V8 RegExp and no way to interrupt one in
 * place. Moving the scan to a worker is what makes it interruptible:
 * `worker.terminate()` DOES interrupt a running regex (MEASURED here on the
 * same fixture: it resolved in 3 ms while the parent's 200 ms interval kept
 * ticking normally). The Editor's own event loop is then free the whole time,
 * so timers fire, the HTTP API answers, and Stop is registered.
 *
 * Cost, measured on the same machine: ~17 ms to spawn the worker, and ~17 ms
 * for 500 file round trips. Against a Grep that already reads up to 500 files
 * from disk inside a chat turn, that is not a trade worth avoiding.
 *
 * The worker source is an inline string rather than a sibling module on
 * purpose. This package is loaded from three places with three different
 * module resolutions (root CommonJS, `editor-cli` ESM under `tsx`, and Vitest's
 * own transform), and a `new Worker(new URL('./x.ts', ...))` would have to
 * resolve and transpile TypeScript in all three. A string has no resolution
 * step at all.
 */

import { Worker } from 'node:worker_threads'

/**
 * Total wall-clock budget for one search, covering the file reads as well as
 * the scanning.
 *
 * Generous on purpose. The verifier's literal baseline over a whole repository
 * was 24 ms, and 500 small files round-tripped through the worker in 17 ms, so
 * this is roughly two orders of magnitude of headroom for any search that is
 * not pathological. It is a backstop, not a performance target.
 */
export const GREP_DEADLINE_MS = 3000

/**
 * CommonJS and ESM both reach `worker_threads`, because which one this string
 * is evaluated as depends on the host that spawned it.
 */
const WORKER_SOURCE = `
;(async () => {
  const wt = typeof require === 'function'
    ? require('node:worker_threads')
    : await import('node:worker_threads')
  const port = wt.parentPort
  let re = null
  port.on('message', (msg) => {
    if (msg.kind === 'pattern') {
      re = new RegExp(msg.source, msg.flags)
      return
    }
    const lines = msg.lines
    const out = []
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(i)
        if (out.length >= msg.cap) break
      }
    }
    port.postMessage({ kind: 'hits', out: out })
  })
})()
`

export type ScanOutcome =
  /** The scan finished. Indexes are zero-based, capped, in ascending order. */
  | { status: 'ok'; lineIndexes: number[] }
  /** The whole search ran out of time. Nothing further will be scanned. */
  | { status: 'deadline' }
  /** The caller's `AbortSignal` fired. Nothing further will be scanned. */
  | { status: 'aborted' }
  /** The worker could not be started or died. Nothing further will be scanned. */
  | { status: 'failed'; message: string }

export interface RegexLineScanner {
  /**
   * Scan one file's lines. Returns at most `cap` line indexes. Once any call
   * has ended in `deadline`, `aborted` or `failed`, every later call returns
   * that same outcome without doing any work.
   */
  scan(lines: string[], cap: number): Promise<ScanOutcome>
  /** Always call this, on every exit path. Idempotent. */
  dispose(): void
}

export interface RegexLineScannerOpts {
  /** RegExp source. Already validated by the caller, so it cannot throw here. */
  source: string
  /** RegExp flags. */
  flags: string
  /** `Date.now()` value past which no more scanning happens. */
  deadlineAt: number
  /** The turn's signal, threaded through the tool call's context. */
  signal?: AbortSignal | undefined
}

export function createRegexLineScanner(opts: RegexLineScannerOpts): RegexLineScanner {
  let worker: Worker | null = null
  let stopped: Exclude<ScanOutcome, { status: 'ok' }> | null = null

  const stop = (outcome: Exclude<ScanOutcome, { status: 'ok' }>): void => {
    if (stopped === null) stopped = outcome
    if (worker !== null) {
      const w = worker
      worker = null
      // Fire and forget: `terminate` resolves once the thread is gone, and
      // nothing here needs to wait for that. A rejection would mean the worker
      // was already dead, which is the state we want anyway.
      void w.terminate().catch(() => {})
    }
  }

  return {
    async scan(lines: string[], cap: number): Promise<ScanOutcome> {
      if (stopped !== null) return stopped
      if (opts.signal?.aborted === true) {
        stop({ status: 'aborted' })
        return stopped!
      }
      const remainingMs = opts.deadlineAt - Date.now()
      if (remainingMs <= 0) {
        stop({ status: 'deadline' })
        return stopped!
      }
      if (worker === null) {
        try {
          worker = new Worker(WORKER_SOURCE, { eval: true })
          // Nothing about this thread should keep the CLI alive at shutdown.
          worker.unref()
          worker.postMessage({ kind: 'pattern', source: opts.source, flags: opts.flags })
        } catch (e) {
          worker = null
          stop({ status: 'failed', message: (e as Error).message })
          return stopped!
        }
      }
      const active = worker
      return await new Promise<ScanOutcome>((resolve) => {
        let settled = false
        const finish = (outcome: ScanOutcome): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          active.off('message', onMessage)
          active.off('error', onError)
          active.off('exit', onExit)
          resolve(outcome)
        }
        const onMessage = (msg: { kind?: string; out?: number[] }): void => {
          if (msg?.kind !== 'hits') return
          finish({ status: 'ok', lineIndexes: msg.out ?? [] })
        }
        const onError = (e: Error): void => {
          stop({ status: 'failed', message: e.message })
          finish(stopped!)
        }
        const onExit = (): void => {
          stop({ status: 'failed', message: 'the search thread exited unexpectedly' })
          finish(stopped!)
        }
        const onAbort = (): void => {
          stop({ status: 'aborted' })
          finish(stopped!)
        }
        const timer = setTimeout(() => {
          stop({ status: 'deadline' })
          finish(stopped!)
        }, remainingMs)
        active.on('message', onMessage)
        active.on('error', onError)
        active.on('exit', onExit)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        active.postMessage({ lines, cap })
      })
    },
    dispose(): void {
      // Not a `stop` with an outcome: disposing after a clean run must not
      // rewrite the result, and after a stop there is nothing left to do.
      if (worker !== null) {
        const w = worker
        worker = null
        void w.terminate().catch(() => {})
      }
    },
  }
}

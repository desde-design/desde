/**
 * Client half of `POST /api/editor/iteration/verify` (see
 * `editor-cli/src/server/iteration-verify-handler.ts`). Called before the
 * iteration-scope dialog opens; a `no-loop` answer sends the edit to chat.
 */
import { editorFetch } from "@/lib/editor-fetch"

export type IterationVerifyOutcome =
  | { kind: "loop"; expression: string }
  | { kind: "no-loop"; reason: string }
  | { kind: "error"; reason: string }

/**
 * How long the round trip may take before it is treated as failed.
 *
 * The caller is holding a bridge draft while this is in flight, and a held
 * draft blocks Save. A hung CLI (a huge SFC, a wedged process) would hold it
 * for as long as the tab lived. Timing out yields an ordinary `error`
 * outcome, which the caller already handles by releasing the draft and
 * showing a status.
 */
const VERIFY_TIMEOUT_MS = 15_000

/**
 * The caller's dispose signal and the timeout, as one signal.
 *
 * `AbortSignal.any` is the whole implementation where it exists. The manual
 * path is for runtimes without it (and for a fake-timer test that overrides
 * the timeout): one controller, aborted by whichever fires first.
 */
function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const anyOf = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!caller) return timeout
  if (anyOf) return anyOf([caller, timeout])
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (caller.aborted || timeout.aborted) controller.abort()
  caller.addEventListener("abort", abort, { once: true })
  timeout.addEventListener("abort", abort, { once: true })
  return controller.signal
}

/** Reads as a cause, not as a DOMException name. */
function describeAbort(signal: AbortSignal, timeoutMs: number): string {
  const reason = signal.reason as { name?: string } | undefined
  if (reason?.name === "TimeoutError") {
    const shown = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
    return `the check did not answer within ${shown}`
  }
  return "the check was cancelled"
}

/**
 * Reject as soon as `signal` aborts.
 *
 * Passing the signal to `fetch` is not enough on its own. It covers a real
 * fetch, but the point of the timeout is a transport that has stopped
 * answering, and a promise that never settles never settles whatever the
 * signal does. Racing is what makes "the caller always gets an outcome" true.
 * `Promise.race` attaches a handler to this promise, so a normal response
 * leaves no unhandled rejection behind.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"))
      return
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

export async function verifyIterationLoop(
  args: {
    file: string
    line: number
    column: number
    /**
     * Aborted when the editing hook is disposed or disabled. Without it a
     * verify outlives the surface that authorized it, and its `no-loop`
     * answer starts an agent turn after the UI is gone.
     */
    signal?: AbortSignal
    /** Test seam only. Production callers take {@link VERIFY_TIMEOUT_MS}. */
    timeoutMs?: number
  },
  fetchImpl: typeof editorFetch = editorFetch,
): Promise<IterationVerifyOutcome> {
  let response: Response
  const timeoutMs = args.timeoutMs ?? VERIFY_TIMEOUT_MS
  const signal = combineSignals(args.signal, timeoutMs)
  try {
    response = await Promise.race([
      fetchImpl("/api/editor/iteration/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: args.file,
          templateLocation: { line: args.line, column: args.column },
        }),
        signal,
      }),
      rejectOnAbort(signal),
    ])
  } catch (err) {
    // Whichever way the abort surfaced (fetch honoured the signal, or the
    // race fired against a transport that ignored it), the caller gets an
    // `error` and releases its bridge draft instead of holding it, and Save
    // with it, for the life of the tab.
    if (signal.aborted) {
      return { kind: "error", reason: describeAbort(signal, timeoutMs) }
    }
    return { kind: "error", reason: (err as Error).message }
  }
  let body: { ok: boolean; loop?: { expression: string } | null; reason?: string }
  try {
    body = (await response.json()) as typeof body
  } catch {
    return { kind: "error", reason: `HTTP ${response.status}` }
  }
  if (!response.ok || !body.ok) {
    return { kind: "error", reason: body.reason ?? `HTTP ${response.status}` }
  }
  if (body.loop) return { kind: "loop", expression: body.loop.expression }
  return { kind: "no-loop", reason: body.reason ?? "No loop at that position" }
}

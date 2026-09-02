/**
 * SSE consumer for the `/api/editor/edit` streaming response. Extracted
 * from `index.ts` (share-readiness Phase 2) — no behavior change, just a
 * module boundary; `BridgeFrameworkAdapter.applyEdit` imports
 * `consumeSSEEditResponse` back in for the `llm-patch` streaming path.
 *
 * NOT migrated onto the shared `parseSseStream` (`src/lib/sse.ts`, added
 * for the chat/design-systems/drift streaming routes — audit Task 20/16).
 * That parser deliberately drops the SSE `event:` field and yields only the
 * parsed `data:` JSON payload, because its three original call sites never
 * needed to distinguish frame types. This consumer does: the edit route
 * multiplexes `start` / `token` / `complete` / `error` over one stream (see
 * the `parsed.event === '…'` dispatch below), so it needs its own
 * `{ event, data }` frame parser (`parseSSEFrame`) rather than the shared
 * one. Left as two implementations on purpose — see this module's own
 * docs for the CRLF/chunk-boundary handling `src/lib/sse.ts` also does
 * independently.
 */

import type { ApplyEditOpts, EditResult, SaveLLMTrace, StructuralEdit } from '../../core'

// ─────────────────────────── SSE consumer ─────────────────────────────────

/**
 * Read the `/api/editor/edit` SSE stream (one frame per LLM token + a
 * terminal `complete` / `error` event) and translate it into the same
 * `EditResult` shape the JSON path returns. Fires `opts.onLLMStreamStart`
 * once on the `start` event and `opts.onLLMStreamDelta` per token so the
 * save dialog can render the response live.
 *
 * The terminal `complete` event carries the same JSON the non-streaming
 * path returns (the route forwards `writePatchedBundle`'s response body
 * verbatim), so this consumer can build the `applied` EditResult from
 * exactly the same fields the JSON consumer does.
 */
export async function consumeSSEEditResponse(
  response: Response,
  edit: StructuralEdit,
  opts: ApplyEditOpts,
): Promise<EditResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final:
    | { kind: 'complete'; data: Record<string, unknown> }
    | { kind: 'error'; data: Record<string, unknown> }
    | null = null

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line. The spec allows
      // "\n\n", "\r\n\r\n", or "\r\r". Up-front replace of \r→\n
      // isn't chunk-safe (a "\r" at the end of one chunk + "\n" at
      // the start of the next would create a spurious "\n\n" and split
      // a frame mid-line), so scan for the actual separator forms
      // instead and leave the raw buffer intact across chunks. Per-line
      // CRLF normalization happens inside `parseSSEFrame` on complete
      // frames (Codex review round-2 P1).
      let sep = findNextSSESeparator(buffer)
      while (sep) {
        const frame = buffer.slice(0, sep.end)
        buffer = buffer.slice(sep.end + sep.sepLen)
        sep = findNextSSESeparator(buffer)
        const parsed = parseSSEFrame(frame)
        if (!parsed) continue
        if (parsed.event === 'token') {
          const delta = (parsed.data as { delta?: string }).delta
          if (typeof delta === 'string' && opts.onLLMStreamDelta) {
            opts.onLLMStreamDelta(delta)
          }
        } else if (parsed.event === 'start') {
          if (opts.onLLMStreamStart) {
            const info = parsed.data as { model?: string; mutationCount?: number }
            opts.onLLMStreamStart({
              model: info.model ?? '<unknown>',
              mutationCount: info.mutationCount ?? 0,
            })
          }
        } else if (parsed.event === 'complete') {
          final = { kind: 'complete', data: parsed.data }
        } else if (parsed.event === 'error') {
          final = { kind: 'error', data: parsed.data }
        }
      }
    }
  } catch (err) {
    return {
      kind: 'failed',
      reason: `Stream read failed: ${(err as Error).message}`,
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader may already be released by an aborted stream.
    }
  }

  if (!final) {
    return { kind: 'failed', reason: 'Stream ended without a final event' }
  }
  if (final.kind === 'error') {
    const data = final.data as {
      reason?: string
      conflicts?: ReadonlyArray<{ file: string; expected: string; actual: string }>
    }
    return {
      kind: 'failed',
      reason: data.reason ?? 'Unknown stream error',
      ...(Array.isArray(data.conflicts) ? { conflicts: data.conflicts } : {}),
    }
  }
  const data = final.data as {
    newHashes?: Record<string, string>
    llmTrace?: SaveLLMTrace
  }
  return {
    kind: 'applied',
    appliedEditId: edit.id,
    affectedTargetIds: [edit.target.targetId],
    ...(data.newHashes ? { newHashes: data.newHashes } : {}),
    ...(data.llmTrace ? { llmTrace: data.llmTrace } : {}),
  }
}

/**
 * Find the next SSE frame separator in the buffer. The spec allows
 * `\n\n`, `\r\n\r\n`, or `\r\r`. Returns the offset of the start of
 * the separator and its length (2 or 4), or null if no complete
 * separator is present in the buffer yet (caller should wait for more
 * bytes). Choosing the EARLIEST separator handles servers that mix
 * line endings within a single response.
 */
function findNextSSESeparator(
  buf: string,
): { end: number; sepLen: number } | null {
  const candidates: Array<{ end: number; sepLen: number }> = []
  const lf2 = buf.indexOf('\n\n')
  if (lf2 !== -1) candidates.push({ end: lf2, sepLen: 2 })
  const crlf2 = buf.indexOf('\r\n\r\n')
  if (crlf2 !== -1) candidates.push({ end: crlf2, sepLen: 4 })
  const cr2 = buf.indexOf('\r\r')
  if (cr2 !== -1) candidates.push({ end: cr2, sepLen: 2 })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.end - b.end)
  return candidates[0]
}

/**
 * Parse a single SSE frame (e.g. `"event: token\ndata: {...}"`) into
 * `{ event, data }`. Returns null for malformed/incomplete frames so
 * the caller can skip them rather than reject the whole stream.
 *
 * Normalizes CRLF and bare CR line endings inside the frame (safe to
 * do here because the frame is bounded; chunk-boundary risk only
 * exists on the buffer-level separator detection, which is handled
 * by `findNextSSESeparator`).
 */
function parseSSEFrame(
  frame: string,
): { event: string; data: Record<string, unknown> } | null {
  let event = 'message'
  const dataLines: string[] = []
  const normalized = frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const line of normalized.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
    // Other prefixes (`id:`, `retry:`, comment lines starting with `:`)
    // are valid SSE but the route doesn't emit them today; ignore.
  }
  if (dataLines.length === 0) return null
  try {
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
    return { event, data }
  } catch {
    return null
  }
}

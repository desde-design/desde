/**
 * Shared Server-Sent-Events (SSE) frame parser for editor streaming
 * routes (chat, design-systems onboarding/refresh/generate-hints, drift
 * regenerate-hints).
 *
 * Extracted 2026-08 from three independently-maintained, near-identical
 * copies (`useDriftEntries.ts`, `useDesignSystems.ts`, `useEditorChat.ts`
 * — see `.superpowers/sdd/editor-audit-fixes-plan/task-16-report.md` for
 * the byte-diff). All three servers write frames as
 * `data: ${JSON.stringify(payload)}\n\n` (`editor-cli/src/server/sse.ts`)
 * — LF-only, single-line `data:` payloads — so real traffic never exercises
 * CRLF or multi-line `data:` fields. This parser still supports both
 * (`\n\n` or `\r\n\r\n` frame separators; each line's trailing `\r`
 * stripped) as a superset, so behavior for existing LF-only producers is
 * unchanged while the parser degrades gracefully for other Node HTTP
 * layers that do write CRLF.
 *
 * No node imports — this runs in the browser inside 'use client' hooks.
 */

/** Matches a blank-line frame separator: `\n\n` or `\r\n\r\n`. */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n/

/**
 * Read an SSE body, yielding parsed `data:` JSON frames.
 *
 * - Comment lines (starting with `:`, e.g. `: heartbeat`) are skipped.
 * - Multi-line `data:` fields within one frame are joined with `\n` before
 *   `JSON.parse`, per the SSE spec's field-concatenation rule.
 * - A frame with no `data:` line, or whose joined payload fails to parse,
 *   is silently dropped (yields nothing for that frame) — matches all
 *   three original copies.
 * - A trailing partial frame at stream end (no closing blank line) is
 *   discarded, not parsed — matches all three original copies.
 * - `signal` is optional. When provided, the read loop's condition is
 *   `!signal.aborted` (checked before each `reader.read()`), matching
 *   `useEditorChat`'s original abort handling. When omitted, the loop
 *   runs until the stream reports `done`, matching `useDriftEntries` /
 *   `useDesignSystems`'s original unconditional-loop behavior.
 */
export async function* parseSseStream<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let match = FRAME_SEPARATOR.exec(buffer)
      while (match !== null) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const parsed = parseSseFrame<T>(frame)
        if (parsed) yield parsed
        match = FRAME_SEPARATOR.exec(buffer)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

function parseSseFrame<T>(frame: string): T | null {
  const data: string[] = []
  for (const rawLine of frame.split("\n")) {
    // Strip a trailing \r left by a \r\n line ending; comment/data-prefix
    // checks below are unaffected since \r only ever trails the content.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(":")) continue
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trim())
  }
  if (data.length === 0) return null
  try {
    return JSON.parse(data.join("\n")) as T
  } catch {
    return null
  }
}

/**
 * Direct tests for the shared SSE parser (`parseSseStream`), extracted from
 * three near-identical hook-local copies (useDriftEntries, useDesignSystems,
 * useEditorChat). Covers behavior all three consumers relied on: frame
 * splitting on LF and CRLF blank-line separators, multi-line `data:`
 * fields, partial-frame buffering across chunk boundaries, abort mid-stream
 * (the useEditorChat call shape), and stream end with an unterminated
 * trailing frame.
 */

import { describe, expect, it } from "vitest"
import { parseSseStream } from "./sse"

/** Build a ReadableStream<Uint8Array> that emits `chunks` one read() at a time. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]))
        i += 1
      } else {
        controller.close()
      }
    },
  })
}

async function collect<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = []
  for await (const ev of parseSseStream<T>(body, signal)) {
    out.push(ev)
  }
  return out
}

describe("parseSseStream", () => {
  it("splits LF-separated frames", async () => {
    const body = streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("splits CRLF-separated frames", async () => {
    const body = streamOf(['data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'])
    expect(await collect(body)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("joins multi-line data: fields with \\n before parsing", async () => {
    // Two data: lines in one frame concatenate into a JSON string with an
    // embedded newline, per the SSE spec's field-concatenation rule.
    const body = streamOf(['data: {"a":\ndata: 1}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }])
  })

  it("skips comment lines (':' prefix)", async () => {
    const body = streamOf([': heartbeat\ndata: {"a":1}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }])
  })

  it("buffers a partial frame split across chunk boundaries", async () => {
    const body = streamOf(['data: {"a":', '1}\n', "\n", 'data: {"b":2}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("buffers a frame separator split across chunk boundaries", async () => {
    // The \n\n separator itself is split across two reads.
    const body = streamOf(['data: {"a":1}\n', '\ndata: {"b":2}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it("discards an unterminated trailing frame at stream end", async () => {
    const body = streamOf(['data: {"a":1}\n\ndata: {"b":2}'])
    expect(await collect(body)).toEqual([{ a: 1 }])
  })

  it("drops a frame with no data: line", async () => {
    const body = streamOf([": just a comment\n\ndata: {\"a\":1}\n\n"])
    expect(await collect(body)).toEqual([{ a: 1 }])
  })

  it("drops a frame whose data: payload fails to parse", async () => {
    const body = streamOf(["data: not json\n\n" + 'data: {"a":1}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }])
  })

  it("stops iteration when the signal is already aborted before the first read", async () => {
    const controller = new AbortController()
    controller.abort()
    const body = streamOf(['data: {"a":1}\n\n'])
    expect(await collect(body, controller.signal)).toEqual([])
  })

  it("stops yielding further frames once aborted mid-stream", async () => {
    // Drive the async iterator by hand so abort() can be interleaved
    // deterministically between two frames, independent of when the
    // underlying ReadableStream's `pull` happens to fire.
    const controller = new AbortController()
    const encoder = new TextEncoder()
    let releaseSecondChunk: (() => void) | undefined
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve
    })
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        pulls += 1
        if (pulls === 1) {
          ctrl.enqueue(encoder.encode('data: {"a":1}\n\n'))
          return
        }
        await secondChunkGate
        ctrl.enqueue(encoder.encode('data: {"a":2}\n\n'))
      },
    })

    const iterator = parseSseStream<{ a: number }>(body, controller.signal)[
      Symbol.asyncIterator
    ]()
    expect(await iterator.next()).toEqual({ value: { a: 1 }, done: false })

    // Abort strictly between the two frames — the loop condition
    // (`!signal.aborted`) is only checked before each `reader.read()`, so
    // this must stop the second frame from ever being requested.
    controller.abort()
    releaseSecondChunk?.()

    const second = await iterator.next()
    expect(second.done).toBe(true)
  })

  it("runs to stream end when no signal is passed (useDriftEntries/useDesignSystems shape)", async () => {
    const body = streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\n'])
    expect(await collect(body)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("releases the reader lock when the stream ends", async () => {
    const body = streamOf(['data: {"a":1}\n\n'])
    await collect(body)
    // No throw on a fresh getReader() proves the generator's `finally`
    // released the lock rather than leaving it held.
    expect(() => body.getReader().releaseLock()).not.toThrow()
  })
})

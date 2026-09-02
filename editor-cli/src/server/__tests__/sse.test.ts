/**
 * Tests for the SSE response helper. Validates the wire format
 * (`data: <json>\n\n` framing, heartbeat comments), header setup,
 * client-disconnect signaling, and idempotent close.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { openSseStream } from '../sse'

function makeMockReqRes(opts: { withSocket?: boolean } = {}): {
  req: IncomingMessage
  res: ServerResponse
  socket: EventEmitter | null
  writes: string[]
  headers: Record<string, string | number | readonly string[]>
  statusCode: () => number | undefined
  ended: () => boolean
  flushed: () => boolean
  setNextWriteResult: (v: boolean) => void
  emitDrain: () => void
} {
  const writes: string[] = []
  const headers: Record<string, string | number | readonly string[]> = {}
  let status: number | undefined
  let ended = false
  let flushed = false

  const reqBase = new EventEmitter()
  let socket: EventEmitter | null = null
  if (opts.withSocket) {
    socket = new EventEmitter()
    Object.assign(reqBase, { socket })
  }
  const req = reqBase as unknown as IncomingMessage
  const resBase = new EventEmitter()
  Object.defineProperty(resBase, 'statusCode', {
    get() {
      return status
    },
    set(v: number) {
      status = v
    },
  })
  let nextWriteResult = true
  Object.assign(resBase, {
    setHeader: (k: string, v: string | number | readonly string[]) => {
      headers[k] = v
      return resBase
    },
    write: (chunk: string) => {
      writes.push(chunk)
      return nextWriteResult
    },
    end: () => {
      ended = true
      ;(resBase as EventEmitter).emit('close')
      return resBase
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      ;(resBase as EventEmitter).removeListener(event, listener)
      return resBase
    },
    flushHeaders: () => {
      flushed = true
    },
  })
  const res = resBase as unknown as ServerResponse

  return {
    req,
    res,
    socket,
    writes,
    headers,
    statusCode: () => status,
    ended: () => ended,
    flushed: () => flushed,
    setNextWriteResult: (v: boolean) => {
      nextWriteResult = v
    },
    emitDrain: () => {
      ;(resBase as EventEmitter).emit('drain')
    },
  }
}

describe('openSseStream', () => {
  it('sets standard SSE headers and flushes', () => {
    const { req, res, headers, statusCode, flushed } = makeMockReqRes()
    openSseStream(req, res)
    expect(statusCode()).toBe(200)
    expect(headers['Content-Type']).toMatch(/text\/event-stream/)
    expect(headers['Cache-Control']).toBe('no-cache, no-transform')
    expect(headers['Connection']).toBe('keep-alive')
    expect(headers['X-Accel-Buffering']).toBe('no')
    expect(flushed()).toBe(true)
  })

  it('skips header setup when setHeaders=false', () => {
    const { req, res, headers, statusCode } = makeMockReqRes()
    openSseStream(req, res, { setHeaders: false })
    expect(statusCode()).toBeUndefined()
    expect(Object.keys(headers)).toHaveLength(0)
  })

  it('serializes events as data: <json>\\n\\n frames', () => {
    const { req, res, writes } = makeMockReqRes()
    const stream = openSseStream(req, res)
    stream.send({ kind: 'text_delta', delta: 'hi' })
    stream.send({ kind: 'turn_complete' })
    expect(writes).toEqual([
      `data: ${JSON.stringify({ kind: 'text_delta', delta: 'hi' })}\n\n`,
      `data: ${JSON.stringify({ kind: 'turn_complete' })}\n\n`,
    ])
  })

  it('emits SSE comment frames for heartbeats', () => {
    const { req, res, writes } = makeMockReqRes()
    const stream = openSseStream(req, res)
    stream.heartbeat()
    expect(writes).toEqual([': heartbeat\n\n'])
  })

  it("resolves `aborted` when the request emits 'close' (client disconnect)", async () => {
    const { req, res } = makeMockReqRes()
    const stream = openSseStream(req, res)
    let resolved = false
    const watcher = stream.aborted.then(() => {
      resolved = true
    })
    ;(req as unknown as EventEmitter).emit('close')
    await watcher
    expect(resolved).toBe(true)
  })

  it('refuses send/heartbeat after close', () => {
    const { req, res, writes } = makeMockReqRes()
    const stream = openSseStream(req, res)
    stream.close()
    expect(stream.send({ kind: 'after_close' })).toBe(false)
    expect(stream.heartbeat()).toBe(false)
    // Only the `end()` happened — no data writes.
    expect(writes).toHaveLength(0)
  })

  it('close() is idempotent', () => {
    const { req, res, ended } = makeMockReqRes()
    const stream = openSseStream(req, res)
    stream.close()
    stream.close()
    // Second close must not throw and must not double-end.
    expect(ended()).toBe(true)
  })

  it('marks the stream closed and resolves aborted if write throws', async () => {
    const { req, res } = makeMockReqRes()
    const stream = openSseStream(req, res)
    // Simulate the underlying socket being torn down between events.
    ;(res as unknown as { write: () => never }).write = () => {
      throw new Error('EPIPE')
    }
    let resolved = false
    const watcher = stream.aborted.then(() => {
      resolved = true
    })
    const sent = stream.send({ kind: 'x' })
    expect(sent).toBe(false)
    await watcher
    expect(resolved).toBe(true)
    // Subsequent sends also return false.
    expect(stream.send({ kind: 'x' })).toBe(false)
  })

  it('honors AbortController-like semantics: producer can await aborted to cancel work', async () => {
    const { req, res } = makeMockReqRes()
    const stream = openSseStream(req, res)

    // Simulate a producer loop: send 3 chunks, then client closes.
    const events: string[] = []
    const producer = (async () => {
      for (let i = 0; i < 10; i++) {
        if (!stream.send({ tick: i })) break
        events.push(`tick-${i}`)
        if (i === 2) {
          // Simulate client disconnect after 3rd tick.
          ;(req as unknown as EventEmitter).emit('close')
          // Yield once so the close handler runs.
          await new Promise<void>((r) => setImmediate(r))
        }
      }
    })()

    await producer
    // The producer saw stream.send return false after the disconnect
    // and exited its loop early.
    expect(events.length).toBeLessThanOrEqual(4)
  })

  it('also resolves aborted when res emits close', async () => {
    const { req, res } = makeMockReqRes()
    void req
    const stream = openSseStream(req, res)
    let resolved = false
    const watcher = stream.aborted.then(() => {
      resolved = true
    })
    ;(res as unknown as EventEmitter).emit('close')
    await watcher
    expect(resolved).toBe(true)
  })

  it('resolves aborted when the socket closes (preferred client-disconnect signal)', async () => {
    const { req, res, socket } = makeMockReqRes({ withSocket: true })
    expect(socket).not.toBeNull()
    const stream = openSseStream(req, res)
    let resolved = false
    const watcher = stream.aborted.then(() => {
      resolved = true
    })
    socket!.emit('close')
    await watcher
    expect(resolved).toBe(true)
  })

  it('does NOT abort when req stream closes but the socket is still alive', async () => {
    // On Node, req.close can fire when the request body ends while the
    // SSE response (and the underlying socket) is still streaming. We
    // must not interpret that as a client disconnect.
    const { req, res, socket } = makeMockReqRes({ withSocket: true })
    const stream = openSseStream(req, res)
    let resolved = false
    const watcher = stream.aborted.then(() => {
      resolved = true
    })
    ;(req as unknown as EventEmitter).emit('close')
    // Yield once so any erroneous resolution would have a chance to land.
    await new Promise<void>((r) => setImmediate(r))
    expect(resolved).toBe(false)

    // Sanity: socket-close still aborts.
    socket!.emit('close')
    await watcher
    expect(resolved).toBe(true)
  })

  it('does not double-resolve aborted across multiple close signals', async () => {
    const { req, res, socket } = makeMockReqRes({ withSocket: true })
    const stream = openSseStream(req, res)
    const resolveSpy = vi.fn()
    stream.aborted.then(resolveSpy)
    socket!.emit('close')
    ;(res as unknown as EventEmitter).emit('close')
    stream.close()
    // Allow the microtask queue to drain.
    await new Promise<void>((r) => setImmediate(r))
    expect(resolveSpy).toHaveBeenCalledTimes(1)
  })

  it('returns false from send() when the socket reports backpressure', () => {
    const { req, res, setNextWriteResult } = makeMockReqRes()
    const stream = openSseStream(req, res)
    setNextWriteResult(false)
    expect(stream.send({ kind: 'x' })).toBe(false)
    // Stream is NOT closed — caller can still send (just should drain
    // first to avoid runaway memory).
    setNextWriteResult(true)
    expect(stream.send({ kind: 'y' })).toBe(true)
  })

  it('drain() resolves on the next drain event', async () => {
    const { req, res, emitDrain } = makeMockReqRes()
    const stream = openSseStream(req, res)
    let resolved = false
    const p = stream.drain().then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)
    emitDrain()
    await p
    expect(resolved).toBe(true)
  })

  it('drain() resolves immediately if the stream is already closed', async () => {
    const { req, res } = makeMockReqRes()
    const stream = openSseStream(req, res)
    stream.close()
    await stream.drain() // must not hang
  })

  it('drain() resolves if the stream closes while awaiting', async () => {
    const { req, res } = makeMockReqRes()
    const stream = openSseStream(req, res)
    const p = stream.drain()
    // Simulate the underlying response closing without a drain event.
    ;(res as unknown as EventEmitter).emit('close')
    await p
  })

  it('send() returns false (and writes nothing) when JSON.stringify throws', () => {
    const { req, res, writes } = makeMockReqRes()
    const stream = openSseStream(req, res)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stream.send(cyclic)).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('send() returns false for top-level undefined / function payloads', () => {
    const { req, res, writes } = makeMockReqRes()
    const stream = openSseStream(req, res)
    expect(stream.send(undefined)).toBe(false)
    expect(stream.send(() => 'nope')).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

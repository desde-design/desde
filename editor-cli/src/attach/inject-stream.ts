import { Transform } from "node:stream"

/**
 * Streaming HTML injection for attach mode.
 *
 * ## Why this is a `Transform` and not `body = await text(); body.replace(...)`
 *
 * MEASURED (see `tasks/next-attach-mode-spike.md` §4): buffering the whole
 * response before injecting took TTFB on a two-Suspense-boundary Next page from
 * **23ms to 613ms** — TTFB equal to total, i.e. the App Router's headline
 * feature deleted by the proxy. The streaming injector measured 49ms against an
 * 82ms direct baseline.
 *
 * Buffering is *forced* by the `</body>` seam the Vite plugin uses: on that same
 * fixture `</head>` arrived in chunk 1 at 53ms while `</body></html>` arrived as
 * a 14-byte final chunk 2983ms later. So this injector takes the **first** of
 * `</head>` / `</body>`, which lands the tags in chunk 1 of a streamed document.
 *
 * ## Why the carry-over buffer is load-bearing
 *
 * A landmark can straddle a chunk boundary — `…</he` | `ad>…`. Searching each
 * chunk in isolation misses it permanently and silently falls through to the
 * EOF append, which for a streamed page means the bridge tags arrive seconds
 * late (or, on a never-ending response, never). MEASURED: without the carry,
 * **6 of 65 split offsets fail** — exactly the interior positions of `</head>`.
 *
 * So each chunk is searched joined to the previous chunk's last
 * `MAX_NEEDLE - 1` bytes, and those bytes are held back rather than emitted.
 * Holding back 6 bytes costs nothing observable (headers, not body bytes, are
 * what TTFB measures) and is released by `flush()`.
 */

/**
 * Landmarks, in no particular order — the EARLIEST match in the stream wins,
 * not the first entry here. Both are 7 bytes, which is what sets the carry.
 */
const LANDMARKS = ["</head>", "</body>"] as const

/** Longest landmark in bytes. All landmarks are ASCII, so bytes === chars. */
const MAX_NEEDLE = Math.max(...LANDMARKS.map((l) => l.length))

/** Bytes carried across a chunk boundary: the most a landmark can straddle. */
export const CARRY_BYTES = MAX_NEEDLE - 1

const EMPTY = Buffer.alloc(0)

/**
 * ASCII-lowercase copy of `buf`, for case-insensitive landmark search.
 *
 * Only bytes 0x41-0x5A are touched, so this is safe on UTF-8: every byte of a
 * multi-byte sequence is >= 0x80 and passes through untouched, and the copy is
 * the same length as the input so indices map back 1:1. (`toString().toLowerCase()`
 * would break both properties — it can change length, and it decodes bytes we
 * may have split mid-character.)
 */
function asciiLowerCopy(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i] as number
    out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b
  }
  return out
}

/**
 * Byte offset of the earliest injection landmark in `buf`, or -1.
 *
 * Case-insensitive: `</BODY>` is valid HTML and appears in the wild.
 */
export function findInjectionPoint(buf: Buffer): number {
  const hay = asciiLowerCopy(buf)
  let best = -1
  for (const needle of LANDMARKS) {
    const at = hay.indexOf(needle)
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  return best
}

/**
 * A `Transform` that inserts `injection` immediately before the first
 * `</head>` or `</body>` in the stream, once, and passes everything else
 * through byte-for-byte.
 *
 * If the stream ends without either landmark (a fragment, a malformed
 * document, a framework that closes neither tag) the injection is appended at
 * EOF — the same fallback `bridgePlugin.transformIndexHtml` uses.
 */
export function createHtmlInjector(injection: string): Transform {
  const payload = Buffer.from(injection, "utf-8")
  let carry: Buffer = EMPTY
  let injected = false

  return new Transform({
    transform(chunk: unknown, _encoding, done) {
      const input = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string | Uint8Array)

      if (injected) {
        done(null, input)
        return
      }

      const buf = carry.length > 0 ? Buffer.concat([carry, input]) : input
      const at = findInjectionPoint(buf)
      if (at !== -1) {
        injected = true
        carry = EMPTY
        done(null, Buffer.concat([buf.subarray(0, at), payload, buf.subarray(at)]))
        return
      }

      if (buf.length <= CARRY_BYTES) {
        // Whole (tiny) chunk could still be the front of a landmark. Hold it.
        // `Buffer.from` copies: `buf` may alias a chunk the source reuses.
        carry = Buffer.from(buf)
        done()
        return
      }

      const cut = buf.length - CARRY_BYTES
      carry = Buffer.from(buf.subarray(cut))
      done(null, buf.subarray(0, cut))
    },

    flush(done) {
      if (injected) {
        done()
        return
      }
      injected = true
      const tail = Buffer.concat([carry, payload])
      carry = EMPTY
      done(null, tail)
    },
  })
}

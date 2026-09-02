import { describe, expect, it } from "vitest"

import { CARRY_BYTES, createHtmlInjector, findInjectionPoint } from "./inject-stream"

const TAGS = "<!--PT-->"

/** Push `chunks` through an injector and collect the whole output. */
async function run(chunks: Buffer[], injection = TAGS): Promise<string> {
  const stream = createHtmlInjector(injection)
  const out: Buffer[] = []
  stream.on("data", (c: Buffer) => out.push(c))
  const finished = new Promise<void>((resolve, reject) => {
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await finished
  return Buffer.concat(out).toString("utf-8")
}

/** Split a buffer at one offset. Offset 0 and offset len are legal (empty side). */
function splitAt(buf: Buffer, at: number): Buffer[] {
  return [buf.subarray(0, at), buf.subarray(at)]
}

const DOC =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head>" +
  "<body><div id=\"app\">hello</div></body></html>"

const EXPECTED = DOC.replace("</head>", `${TAGS}</head>`)

describe("findInjectionPoint", () => {
  it("finds the earliest landmark, case-insensitively", () => {
    expect(findInjectionPoint(Buffer.from("<p>x</p></head></body>"))).toBe(8)
    expect(findInjectionPoint(Buffer.from("<p>x</p></BODY>"))).toBe(8)
    expect(findInjectionPoint(Buffer.from("<p>x</p></HeAd>"))).toBe(8)
    expect(findInjectionPoint(Buffer.from("<p>x</p>"))).toBe(-1)
  })

  it("does not mistake a non-ASCII byte for part of a landmark", () => {
    // é is 0xC3 0xA9; neither byte may be ASCII-lowercased into a match, and
    // the returned offset must still be a byte offset.
    const buf = Buffer.from("é</head>", "utf-8")
    expect(findInjectionPoint(buf)).toBe(2)
  })
})

describe("createHtmlInjector", () => {
  it("injects immediately before </head>", async () => {
    expect(await run([Buffer.from(DOC)])).toBe(EXPECTED)
  })

  it("injects before </body> when there is no </head>", async () => {
    const doc = "<html><body>x</body></html>"
    expect(await run([Buffer.from(doc)])).toBe(
      doc.replace("</body>", `${TAGS}</body>`),
    )
  })

  it("injects once, at the first landmark only", async () => {
    const out = await run([Buffer.from(DOC)])
    expect(out.split(TAGS)).toHaveLength(2)
  })

  it("appends at EOF when neither landmark appears", async () => {
    const doc = "<div>a fragment</div>"
    expect(await run([Buffer.from(doc)])).toBe(doc + TAGS)
  })

  it("appends at EOF for an empty body", async () => {
    expect(await run([])).toBe(TAGS)
  })

  // THE regression this module exists for. MEASURED in the spike: without the
  // carry-over, 6 of 65 split offsets miss the landmark and silently fall
  // through to the EOF append -- which on a streamed document arrives seconds
  // late. Every offset, not a sample.
  it("injects at the same place for every possible two-chunk split", async () => {
    const buf = Buffer.from(DOC)
    const failures: number[] = []
    for (let at = 0; at <= buf.length; at += 1) {
      const got = await run(splitAt(buf, at))
      if (got !== EXPECTED) failures.push(at)
    }
    expect(failures).toEqual([])
  })

  // The failing offsets above are specifically the interior of `</head>`, so
  // pin those directly: a split inside the landmark must still inject BEFORE
  // it, never at EOF.
  it("survives a split through the middle of the landmark", async () => {
    const head = DOC.indexOf("</head>")
    for (let k = 1; k < "</head>".length; k += 1) {
      const got = await run(splitAt(Buffer.from(DOC), head + k))
      expect(got, `split at </head>+${k}`).toBe(EXPECTED)
    }
  })

  it("survives the worst case: one byte per chunk", async () => {
    const buf = Buffer.from(DOC)
    const chunks = Array.from({ length: buf.length }, (_, i) =>
      buf.subarray(i, i + 1),
    )
    expect(await run(chunks)).toBe(EXPECTED)
  })

  it("survives every three-chunk split of the landmark's neighbourhood", async () => {
    const buf = Buffer.from(DOC)
    const head = DOC.indexOf("</head>")
    for (let a = head - 3; a <= head + 7; a += 1) {
      for (let b = a; b <= head + 9; b += 1) {
        const chunks = [buf.subarray(0, a), buf.subarray(a, b), buf.subarray(b)]
        expect(await run(chunks), `split ${a}/${b}`).toBe(EXPECTED)
      }
    }
  })

  it("passes multi-byte characters through intact when split mid-character", async () => {
    const doc = "<html><head><title>café — 日本</title></head><body>x</body></html>"
    const buf = Buffer.from(doc, "utf-8")
    const expected = doc.replace("</head>", `${TAGS}</head>`)
    for (let at = 0; at <= buf.length; at += 1) {
      expect(await run(splitAt(buf, at)), `split ${at}`).toBe(expected)
    }
  })

  it("holds back no more than the carry, so a landmark cannot straddle unseen", () => {
    // Guards the constant itself: both landmarks are 7 bytes, so 6 is the most
    // of one that can sit in a previous chunk.
    expect(CARRY_BYTES).toBe(6)
  })

  it("emits everything but the carry before the landmark is seen", async () => {
    // Streaming property: a chunk with no landmark must not be held whole.
    const stream = createHtmlInjector(TAGS)
    const seen: Buffer[] = []
    stream.on("data", (c: Buffer) => seen.push(c))
    stream.write(Buffer.from("0123456789"))
    await new Promise((r) => setImmediate(r))
    expect(Buffer.concat(seen).toString()).toBe("0123")
    stream.destroy()
  })
})

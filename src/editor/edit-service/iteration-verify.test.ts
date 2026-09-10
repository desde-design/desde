import { describe, expect, it, vi } from "vitest"
import { verifyIterationLoop } from "./iteration-verify"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("verifyIterationLoop", () => {
  const args = { file: "src/components/ui/card.tsx", line: 60, column: 4 }

  it("posts file + templateLocation and reports a loop", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, loop: { kind: "map", expression: "items.map", location: { line: 60, column: 4 } } }),
    )
    const r = await verifyIterationLoop(args, fetchImpl as never)
    expect(r).toEqual({ kind: "loop", expression: "items.map", location: { line: 60, column: 4 } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/editor/iteration/verify")
    expect(JSON.parse(init.body as string)).toEqual({ file: args.file, templateLocation: { line: 60, column: 4 } })
  })

  it("carries the loop's own position when the server reports one", async () => {
    // The server walks up from the clicked element, so this is the `<li>`,
    // not the `<span>` that was asked about.
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, loop: { kind: "map", expression: "items.map", location: { line: 51, column: 8 } } }),
    )
    expect(await verifyIterationLoop(args, fetchImpl as never)).toEqual({
      kind: "loop",
      expression: "items.map",
      location: { line: 51, column: 8 },
    })
  })

  /**
   * The position is what decides whether the click landed ON the loop element
   * or INSIDE a row, and that decides whether a remove takes the clicked
   * element or the whole item. Dropping a bad one left the caller reading the
   * click's own position, which is exactly the "the click IS the loop" answer.
   * There is no safe fallback, so this fails the verify instead.
   */
  it.each([
    ["a non-integer line", { line: "51", column: 8 }],
    ["a fractional column", { line: 51, column: 8.5 }],
    ["a line below 1", { line: 0, column: 8 }],
    ["a negative column", { line: 51, column: -1 }],
    ["a null location", null],
    ["no location at all", undefined],
  ])("errors on a loop verdict with %s", async (_label, location) => {
    const fetchImpl = vi.fn(async () =>
      json({
        ok: true,
        loop: {
          kind: "map",
          expression: "items.map",
          ...(location === undefined ? {} : { location }),
        },
      }),
    )
    expect(await verifyIterationLoop(args, fetchImpl as never)).toEqual({
      kind: "error",
      reason: "The loop check returned no position",
    })
  })

  it("reports no-loop with the server's reason", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, loop: null, reason: "not a .map()" }))
    expect(await verifyIterationLoop(args, fetchImpl as never)).toEqual({ kind: "no-loop", reason: "not a .map()" })
  })

  it("reports an error for a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, reason: "outside root" }, 400))
    expect(await verifyIterationLoop(args, fetchImpl as never)).toEqual({ kind: "error", reason: "outside root" })
  })

  it("reports an error when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline") })
    expect(await verifyIterationLoop(args, fetchImpl as never)).toEqual({ kind: "error", reason: "offline" })
  })

  it("times out a transport that never answers, so the bridge draft is released", async () => {
    // A fetch that never resolves AND ignores the signal: the shape a wedged
    // CLI has. Passing the signal alone would leave this pending forever.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    const r = await verifyIterationLoop({ ...args, timeoutMs: 10 }, fetchImpl as never)
    expect(r.kind).toBe("error")
    if (r.kind !== "error") return
    expect(r.reason).toBe("the check did not answer within 10ms")
  })

  it("says cancelled, not timed out, when the caller's own signal fires", async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    const pending = verifyIterationLoop({ ...args, signal: controller.signal }, fetchImpl as never)
    controller.abort()
    const r = await pending
    expect(r).toEqual({ kind: "error", reason: "the check was cancelled" })
  })

  it("forwards the caller's abort signal to fetch, so a disposed surface stops the request", async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => json({ ok: true, loop: null, reason: "x" }))
    await verifyIterationLoop({ ...args, signal: controller.signal }, fetchImpl as never)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeDefined()
    controller.abort()
    expect((init.signal as AbortSignal).aborted).toBe(true)
  })
})

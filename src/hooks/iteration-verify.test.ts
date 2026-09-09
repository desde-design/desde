import { describe, expect, it, vi } from "vitest"
import { verifyIterationLoop } from "./iteration-verify"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

describe("verifyIterationLoop", () => {
  const args = { file: "src/components/ui/card.tsx", line: 60, column: 4 }

  it("posts file + templateLocation and reports a loop", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, loop: { kind: "map", expression: "items.map" } }))
    const r = await verifyIterationLoop(args, fetchImpl as never)
    expect(r).toEqual({ kind: "loop", expression: "items.map" })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/editor/iteration/verify")
    expect(JSON.parse(init.body as string)).toEqual({ file: args.file, templateLocation: { line: 60, column: 4 } })
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

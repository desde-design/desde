import { describe, expect, it } from "vitest"
import { withProjectLock } from "./project-locks"

/** A promise plus its own resolver, for controlling exactly when `fn` finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("withProjectLock", () => {
  it("runs a single contender and returns its value", async () => {
    const result = await withProjectLock("p1", async () => 42)
    expect(result).toBe(42)
  })

  it("serializes two contenders on the SAME project — the second does not start until the first finishes", async () => {
    const order: string[] = []
    const first = deferred<void>()

    const a = withProjectLock("p1", async () => {
      order.push("a-start")
      await first.promise
      order.push("a-end")
    })

    // Give `a` a chance to actually start running before queuing `b`.
    await Promise.resolve()
    await Promise.resolve()

    const b = withProjectLock("p1", async () => {
      order.push("b-start")
    })

    expect(order).toEqual(["a-start"])
    first.resolve()
    await a
    await b
    expect(order).toEqual(["a-start", "a-end", "b-start"])
  })

  it("does NOT serialize contenders on DIFFERENT projects", async () => {
    const order: string[] = []
    const first = deferred<void>()

    const a = withProjectLock("p1", async () => {
      order.push("a-start")
      await first.promise
      order.push("a-end")
    })
    await Promise.resolve()
    await Promise.resolve()

    // A different project id must not wait behind p1's still-running holder.
    const b = withProjectLock("p2", async () => {
      order.push("b-start")
    })
    await b
    expect(order).toEqual(["a-start", "b-start"])

    first.resolve()
    await a
    expect(order).toEqual(["a-start", "b-start", "a-end"])
  })

  it("releases the lock when the holder throws, so the next contender still runs", async () => {
    const order: string[] = []

    const a = withProjectLock("p1", async () => {
      order.push("a")
      throw new Error("boom")
    })

    await expect(a).rejects.toThrow("boom")

    const b = await withProjectLock("p1", async () => {
      order.push("b")
      return "ok"
    })

    expect(order).toEqual(["a", "b"])
    expect(b).toBe("ok")
  })

  it("a queued contender still runs even when the one ahead of it throws", async () => {
    const order: string[] = []
    const first = deferred<void>()

    const a = withProjectLock("p1", async () => {
      order.push("a-start")
      await first.promise
      throw new Error("boom")
    })
    await Promise.resolve()
    await Promise.resolve()

    const b = withProjectLock("p1", async () => {
      order.push("b")
      return "ok"
    })

    first.resolve()
    await expect(a).rejects.toThrow("boom")
    expect(await b).toBe("ok")
    expect(order).toEqual(["a-start", "b"])
  })

  it("runs several queued contenders in the order they called withProjectLock", async () => {
    const order: number[] = []
    const calls = [1, 2, 3, 4, 5].map((n) =>
      withProjectLock("p1", async () => {
        order.push(n)
      }),
    )
    await Promise.all(calls)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })
})

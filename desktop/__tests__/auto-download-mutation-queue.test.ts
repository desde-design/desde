/**
 * `createAutoDownloadMutationQueue` (F6 of the adversarial review of Phase
 * 4) — proves mutations land in INVOCATION order, not completion order. See
 * the module's own doc comment for the race this closes: two rapid toggles
 * dispatched as independent `ipcMain.handle` calls, where the earlier one
 * happening to finish its disk write LAST would silently overwrite the
 * user's actual final choice.
 */
import { describe, expect, it, vi } from "vitest"
import { createAutoDownloadMutationQueue } from "../auto-download-mutation-queue.js"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("createAutoDownloadMutationQueue — invocation order (F6)", () => {
  it("a SLOW first mutation does not let a FAST second one race ahead — the second's persist() only starts once the first has fully landed", async () => {
    const order: string[] = []
    const firstWrite = deferred<void>()

    const persist = vi.fn((value: boolean): Promise<void> => {
      order.push(`persist-start:${value}`)
      if (value === true) {
        return firstWrite.promise.then(() => {
          order.push(`persist-done:${value}`)
        })
      }
      order.push(`persist-done:${value}`)
      return Promise.resolve()
    })
    const applyLive = vi.fn((value: boolean) => order.push(`live:${value}`))

    const queue = createAutoDownloadMutationQueue({ persist, applyLive })

    const p1 = queue.mutate(true) // issued first, slow
    const p2 = queue.mutate(false) // issued second, would resolve instantly on its own

    // Give the microtask queue several turns. The second mutation's persist()
    // must NOT have started yet — it's queued strictly behind the first,
    // not racing it on the underlying I/O.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(order).toEqual(["persist-start:true"])

    // The slow first write finally lands.
    firstWrite.resolve()
    await p1
    await p2

    // Final persisted + live value is the LAST invocation (false), and both
    // steps ran in strict invocation order — never "false" landing before
    // "true" despite "false" being individually faster.
    expect(order).toEqual([
      "persist-start:true",
      "persist-done:true",
      "live:true",
      "persist-start:false",
      "persist-done:false",
      "live:false",
    ])
  })

  it("persistence and the live flag update as ONE ordered step per mutation, never interleaved across two mutations", async () => {
    const order: string[] = []
    const persist = vi.fn(async (value: boolean) => {
      order.push(`persist:${value}`)
    })
    const applyLive = vi.fn((value: boolean) => order.push(`live:${value}`))
    const queue = createAutoDownloadMutationQueue({ persist, applyLive })

    await Promise.all([queue.mutate(true), queue.mutate(false)])

    expect(order).toEqual(["persist:true", "live:true", "persist:false", "live:false"])
  })

  it("a failed mutation rejects its OWN caller but does not wedge the queue for a later, unrelated one", async () => {
    const applyLive = vi.fn()
    const persist = vi.fn(async (value: boolean) => {
      if (value === true) throw new Error("disk full")
    })
    const queue = createAutoDownloadMutationQueue({ persist, applyLive })

    const p1 = queue.mutate(true)
    const p2 = queue.mutate(false)

    await expect(p1).rejects.toThrow("disk full")
    await expect(p2).resolves.toBeUndefined()
    expect(applyLive).toHaveBeenCalledTimes(1)
    expect(applyLive).toHaveBeenCalledWith(false)
  })
})

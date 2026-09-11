import { describe, expect, it } from "vitest"
import { createKeyedLock } from "../keyed-lock"

describe("createKeyedLock", () => {
  it("serialises same-key callers in call order and lets other keys run at once", async () => {
    const lock = createKeyedLock()
    const order: string[] = []
    const gate = (name: string, ms: number) => async () => {
      order.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, ms))
      order.push(`${name}:end`)
    }
    await Promise.all([lock.run("a", gate("a1", 20)), lock.run("a", gate("a2", 1)), lock.run("b", gate("b1", 1))])
    expect(order.indexOf("a2:start")).toBeGreaterThan(order.indexOf("a1:end"))
    expect(order.indexOf("b1:start")).toBeLessThan(order.indexOf("a1:end"))
  })
  it("keeps going after a rejection", async () => {
    const lock = createKeyedLock()
    await expect(lock.run("a", async () => { throw new Error("x") })).rejects.toThrow("x")
    await expect(lock.run("a", async () => 1)).resolves.toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { navigateTopLevel } from "./top-level-navigate"

/**
 * jsdom's `location` is not configurable, and assigning a cross-origin href
 * to it logs "not implemented" without navigating. Replace the whole object
 * for the test so the assignment is observable.
 */
describe("navigateTopLevel vouches for the destination before leaving", () => {
  const realLocation = window.location
  let assigned: { href: string }

  beforeEach(() => {
    assigned = { href: realLocation.href }
    Object.defineProperty(window, "location", { value: assigned, writable: true, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, "location", { value: realLocation, writable: true, configurable: true })
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  })

  it("awaits __trustOrigin with the url BEFORE assigning location, when the desktop bridge is present", async () => {
    const order: string[] = []
    const trustOrigin = vi.fn(async (url: string) => {
      await Promise.resolve()
      order.push(`trusted ${url}`)
    })
    ;(window as unknown as { desdeDesktop: unknown }).desdeDesktop = { __trustOrigin: trustOrigin }
    const hrefWatcher = { href: assigned.href }
    Object.defineProperty(assigned, "href", {
      get: () => hrefWatcher.href,
      set: (v: string) => {
        hrefWatcher.href = v
        order.push(`navigated ${v}`)
      },
    })

    await navigateTopLevel("http://127.0.0.1:50001")

    expect(order).toEqual(["trusted http://127.0.0.1:50001", "navigated http://127.0.0.1:50001"])
  })

  it("navigates anyway when there is no desktop bridge (a plain browser tab)", async () => {
    await navigateTopLevel("http://127.0.0.1:50002")
    expect(assigned.href).toBe("http://127.0.0.1:50002")
  })

  it("swallows a rejected vouch and still navigates", async () => {
    ;(window as unknown as { desdeDesktop: unknown }).desdeDesktop = {
      __trustOrigin: vi.fn().mockRejectedValue(new Error("IPC channel closed")),
    }
    await expect(navigateTopLevel("http://127.0.0.1:50003")).resolves.toBeUndefined()
    expect(assigned.href).toBe("http://127.0.0.1:50003")
  })
})

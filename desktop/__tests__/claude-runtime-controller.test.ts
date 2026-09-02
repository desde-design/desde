import { describe, expect, it, vi } from "vitest"
import { ClaudeRuntimeInstallError } from "../claude-runtime-installer.js"
import { createClaudeRuntimeController } from "../claude-runtime-controller.js"

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createClaudeRuntimeController", () => {
  it("starts in phase 'checking' before ensure() is called", () => {
    const controller = createClaudeRuntimeController({
      appSupportDir: "/fake",
      sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==",
      ensureFn: vi.fn(),
    })
    expect(controller.getState()).toEqual({ phase: "checking" })
  })

  it("relays onProgress phases from ensureFn to subscribers, ending in 'ready'", async () => {
    const { promise, resolve } = deferred<string>()
    const ensureFn = vi.fn((opts: { onProgress?: (p: "checking" | "downloading" | "ready") => void }) => {
      opts.onProgress?.("checking")
      opts.onProgress?.("downloading")
      opts.onProgress?.("ready")
      return promise
    })
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    const seen: string[] = []
    controller.onState((s) => seen.push(s.phase))
    controller.ensure()
    resolve("/fake/claude")
    await promise

    expect(seen).toEqual(["checking", "downloading", "ready"])
    expect(controller.getState()).toEqual({ phase: "ready" })
  })

  it("surfaces a ClaudeRuntimeInstallError's reason on failure", async () => {
    const { promise, reject } = deferred<string>()
    const ensureFn = vi.fn(() => promise)
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    controller.ensure()
    reject(new ClaudeRuntimeInstallError("offline", "Couldn't reach the npm registry"))
    await promise.catch(() => {})
    // Let the controller's own .catch() microtask run.
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getState()).toEqual({
      phase: "error",
      error: "Couldn't reach the npm registry",
      errorReason: "offline",
    })
  })

  it("classifies a non-ClaudeRuntimeInstallError as errorReason 'unknown'", async () => {
    const { promise, reject } = deferred<string>()
    const ensureFn = vi.fn(() => promise)
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    controller.ensure()
    reject(new Error("some other failure"))
    await promise.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.getState().phase).toBe("error")
    expect(controller.getState().errorReason).toBe("unknown")
  })

  it("a second ensure() call while one is in flight is a no-op (only one ensureFn call)", async () => {
    const { promise, resolve } = deferred<string>()
    const ensureFn = vi.fn(() => promise)
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    controller.ensure()
    controller.ensure()
    controller.ensure()
    expect(ensureFn).toHaveBeenCalledTimes(1)

    resolve("/fake/claude")
    await promise
  })

  it("ensure() after a completed failure starts a genuinely new attempt (retry)", async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const ensureFn = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    controller.ensure()
    first.reject(new ClaudeRuntimeInstallError("offline", "no network"))
    await first.promise.catch(() => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getState().phase).toBe("error")

    controller.ensure() // the retry
    expect(ensureFn).toHaveBeenCalledTimes(2)
    second.resolve("/fake/claude")
    await second.promise
  })

  it("onState's returned unsubscribe stops further notifications", async () => {
    const { promise, resolve } = deferred<string>()
    const ensureFn = vi.fn((opts: { onProgress?: (p: "checking" | "downloading" | "ready") => void }) => {
      opts.onProgress?.("checking")
      return promise
    })
    const controller = createClaudeRuntimeController({ appSupportDir: "/fake", sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==", ensureFn })

    const seen: string[] = []
    const unsubscribe = controller.onState((s) => seen.push(s.phase))
    unsubscribe()
    controller.ensure()
    resolve("/fake/claude")
    await promise

    expect(seen).toEqual([]) // unsubscribed before ensure() ever fired
  })

  it("passes the signed-anchor expectedIntegrity through to every ensureFn call (F1 plumbing)", async () => {
    const ensureFn = vi.fn((_opts: { expectedIntegrity: string }) => Promise.resolve("/fake/claude"))
    const controller = createClaudeRuntimeController({
      appSupportDir: "/fake",
      sdkVersion: "0.3.143",
      expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==",
      ensureFn,
    })
    controller.ensure()
    await Promise.resolve()
    expect(ensureFn).toHaveBeenCalledWith(
      expect.objectContaining({ expectedIntegrity: "sha512-dGVzdC1leHBlY3RhdGlvbg==" }),
    )
  })
})

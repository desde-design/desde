import { describe, expect, it, vi } from "vitest"
import { pruneSupersededDeploymentAssets } from "../publish-output"

describe("pruneSupersededDeploymentAssets", () => {
  /**
   * Codex round 32. A loopback listener pinned to a superseded deployment
   * outlived its assets until the idle reap, holding one of a container's
   * twenty fixed ports each; the hook is how the registry closes it first.
   */
  it("awaits beforeRemove for each stale deployment before deleting its assets", async () => {
    const ids = ["d-active", "d2", "d3", "d4", "d5", "d-stale-a", "d-stale-b"]
    const storage = { listDeployments: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) }
    const calls: string[] = []
    const assets = {
      deleteDeployment: vi.fn(async (id: string) => {
        calls.push(`delete:${id}`)
      }),
    }
    await pruneSupersededDeploymentAssets(storage, assets, "p1", "d-active", async (id) => {
      calls.push(`before:${id}`)
    })
    expect(calls).toEqual(["before:d-stale-a", "delete:d-stale-a", "before:d-stale-b", "delete:d-stale-b"])
  })

  it("a rejecting beforeRemove skips that deployment's delete and continues the sweep", async () => {
    const ids = ["d-active", "d2", "d3", "d4", "d5", "d-stale-a", "d-stale-b"]
    const storage = { listDeployments: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) }
    const assets = { deleteDeployment: vi.fn().mockResolvedValue(undefined) }
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await pruneSupersededDeploymentAssets(storage, assets, "p1", "d-active", async (id) => {
        if (id === "d-stale-a") throw new Error("listener would not close")
      })
      expect(assets.deleteDeployment.mock.calls.map(([id]) => id)).toEqual(["d-stale-b"])
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it("resolves, and deletes nothing, when the deployment listing rejects", async () => {
    // Codex round 11. Both callers run this after the deployment is marked
    // active; a rejection here used to fail the activation they had just
    // recorded.
    const storage = { listDeployments: vi.fn().mockRejectedValue(new Error("db locked")) }
    const assets = { deleteDeployment: vi.fn().mockResolvedValue(undefined) }
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(pruneSupersededDeploymentAssets(storage, assets, "p1", "d-active")).resolves.toBeUndefined()
      expect(assets.deleteDeployment).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })
})

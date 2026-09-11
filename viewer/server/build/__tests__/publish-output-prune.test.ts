import { describe, expect, it, vi } from "vitest"
import { pruneSupersededDeploymentAssets } from "../publish-output"

describe("pruneSupersededDeploymentAssets", () => {
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

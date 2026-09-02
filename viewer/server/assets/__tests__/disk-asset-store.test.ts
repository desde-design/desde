import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DiskAssetStore } from "../disk-asset-store"
import { assetStoreContract } from "./asset-store-contract"

const dirs: string[] = []

assetStoreContract("disk", {
  makeStore: () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-assets-"))
    dirs.push(dir)
    return new DiskAssetStore(dir)
  },
  cleanup: () => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  },
})

/**
 * Audit K10. A private project's built prototype is its source compiled —
 * the HTTP layer enforces member-only access to exactly that content, while
 * the filesystem was handing it to every local account (MEASURED before the
 * fix: assets root 0755, asset files 0644).
 *
 * POSIX-only: Windows does not model these bits.
 */
describe.skipIf(process.platform === "win32")("DiskAssetStore — on-disk permissions", () => {
  const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8).padStart(4, "0")

  function withDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "viewer-assets-perm-"))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("creates the assets root 0700 at construction, before any put", () => {
    withDir((dir) => {
      const root = join(dir, "assets")
      new DiskAssetStore(root)
      expect(mode(root)).toBe("0700")
    })
  })

  it("writes asset dirs 0700 and asset files 0600, including on redeploy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-assets-perm-"))
    const root = join(dir, "assets")
    const store = new DiskAssetStore(root)

    await store.put("dep1", "nested/app.js", Buffer.from("x"))
    expect(mode(join(root, "dep1"))).toBe("0700")
    expect(mode(join(root, "dep1", "nested"))).toBe("0700")
    expect(mode(join(root, "dep1", "nested", "app.js"))).toBe("0600")

    // writeFile's `mode` applies only on creation — a redeploy overwriting
    // an existing asset must not inherit the old mode.
    await store.put("dep1", "nested/app.js", Buffer.from("y"))
    expect(mode(join(root, "dep1", "nested", "app.js"))).toBe("0600")

    rmSync(dir, { recursive: true, force: true })
  })

  it("tightens an assets root that already existed world-readable", () => {
    withDir((dir) => {
      const root = join(dir, "assets")
      mkdirSync(root, { recursive: true, mode: 0o755 })
      chmodSync(root, 0o755)
      new DiskAssetStore(root)
      expect(mode(root)).toBe("0700")
    })
  })
})
